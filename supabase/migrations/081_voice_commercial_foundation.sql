-- Commercial voice is closed by default. The private pilot remains independent.
BEGIN;

CREATE TABLE public.voice_rollout_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  emergency_stop boolean NOT NULL DEFAULT false,
  max_concurrent_calls integer NOT NULL DEFAULT 2 CHECK (max_concurrent_calls BETWEEN 1 AND 2),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.voice_rollout_control DEFAULT VALUES;
CREATE TABLE public.voice_rollout_businesses (
  business_id uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  emergency_stop boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.voice_commercial_settings (
  business_id uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  primary_response text NOT NULL DEFAULT 'text' CHECK (primary_response IN ('text','voice')),
  text_fallback_enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.voice_commercial_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  kind text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A reconciliation ticket is obtained BEFORE retrieving Stripe's current object.
-- While a ticket is pending, admission fails closed. Older tickets cannot apply.
CREATE TABLE public.voice_billing_projection (
  business_id uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  requested_revision bigint NOT NULL DEFAULT 0,
  applied_revision bigint NOT NULL DEFAULT 0,
  subscription_id text,
  plan text,
  status text,
  period_start timestamptz,
  period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  effective_at timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  CHECK (applied_revision<=requested_revision),
  CHECK (period_end IS NULL OR period_start IS NULL OR period_end>period_start)
);

-- Accounting survives deletion of call history. Hard account deletion removes
-- the owner linkage but retains only these non-content deduplication facts.
CREATE TABLE public.voice_allowance_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  subscription_id text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL CHECK (period_end>period_start),
  included_seconds integer NOT NULL CHECK (included_seconds BETWEEN 0 AND 6000),
  policy_revision integer NOT NULL DEFAULT 1 CHECK (policy_revision=1),
  grant_effective_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id,subscription_id,period_start)
);
ALTER TABLE public.voice_sessions
  ADD COLUMN access_source text NOT NULL DEFAULT 'pilot' CHECK (access_source IN ('pilot','commercial')),
  ADD COLUMN allowance_period_id uuid REFERENCES public.voice_allowance_periods(id),
  ADD COLUMN commercial_deadline_at timestamptz,
  ADD COLUMN text_fallback_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN access_policy_revision integer NOT NULL DEFAULT 1,
  ADD COLUMN settings_revision integer;

CREATE TABLE public.voice_customer_usage (
  call_key uuid PRIMARY KEY,
  call_identity_hash text NOT NULL UNIQUE CHECK (length(call_identity_hash)=64),
  business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  session_id uuid UNIQUE REFERENCES public.voice_sessions(id) ON DELETE SET NULL,
  period_id uuid NOT NULL REFERENCES public.voice_allowance_periods(id),
  reserved_seconds integer NOT NULL CHECK (reserved_seconds BETWEEN 60 AND 600),
  settled_seconds numeric CHECK (settled_seconds BETWEEN 0 AND reserved_seconds),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','reconciling','settled','adjusted')),
  start_event_id text,
  started_at timestamptz,
  start_acknowledged_at timestamptz,
  end_event_id text,
  ended_at timestamptz,
  termination_event_id text,
  termination_at timestamptz,
  reconcile_after timestamptz,
  evidence_conflict boolean NOT NULL DEFAULT false,
  adjustment_reason text,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((settled_seconds IS NULL) = (settled_at IS NULL)),
  CHECK ((state IN ('settled','adjusted')) = (settled_at IS NOT NULL)),
  CHECK (start_acknowledged_at IS NULL OR (started_at IS NOT NULL AND start_event_id IS NOT NULL))
);
CREATE INDEX voice_customer_usage_period ON public.voice_customer_usage(period_id);
CREATE INDEX voice_customer_usage_recovery ON public.voice_customer_usage(reconcile_after) WHERE settled_at IS NULL;

CREATE FUNCTION public.guard_voice_customer_accounting() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'voice accounting cannot be deleted' USING ERRCODE='55000'; END IF;
  IF TG_TABLE_NAME='voice_allowance_periods' THEN
    IF (to_jsonb(NEW)-'business_id') IS DISTINCT FROM (to_jsonb(OLD)-'business_id') OR
      (NEW.business_id IS DISTINCT FROM OLD.business_id AND NEW.business_id IS NOT NULL) THEN
      RAISE EXCEPTION 'voice allowance grant is immutable' USING ERRCODE='55000';
    END IF;
  ELSE
    IF ROW(NEW.call_key,NEW.call_identity_hash,NEW.period_id,NEW.reserved_seconds,NEW.created_at) IS DISTINCT FROM
       ROW(OLD.call_key,OLD.call_identity_hash,OLD.period_id,OLD.reserved_seconds,OLD.created_at)
       OR (NEW.business_id IS DISTINCT FROM OLD.business_id AND NEW.business_id IS NOT NULL)
       OR (NEW.session_id IS DISTINCT FROM OLD.session_id AND NEW.session_id IS NOT NULL)
       OR (OLD.started_at IS NOT NULL AND ROW(NEW.started_at,NEW.start_event_id) IS DISTINCT FROM ROW(OLD.started_at,OLD.start_event_id))
       OR (OLD.ended_at IS NOT NULL AND ROW(NEW.ended_at,NEW.end_event_id) IS DISTINCT FROM ROW(OLD.ended_at,OLD.end_event_id))
       OR (OLD.termination_at IS NOT NULL AND ROW(NEW.termination_at,NEW.termination_event_id) IS DISTINCT FROM ROW(OLD.termination_at,OLD.termination_event_id))
       OR (OLD.settled_at IS NOT NULL AND (to_jsonb(NEW)-'business_id'-'session_id') IS DISTINCT FROM (to_jsonb(OLD)-'business_id'-'session_id')) THEN
      RAISE EXCEPTION 'voice customer accounting is immutable' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_voice_allowance_period BEFORE UPDATE OR DELETE ON public.voice_allowance_periods
  FOR EACH ROW EXECUTE FUNCTION public.guard_voice_customer_accounting();
CREATE TRIGGER guard_voice_customer_usage BEFORE UPDATE OR DELETE ON public.voice_customer_usage
  FOR EACH ROW EXECUTE FUNCTION public.guard_voice_customer_accounting();

CREATE FUNCTION public.guard_voice_access_grant() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF ROW(NEW.access_source,NEW.allowance_period_id,NEW.text_fallback_enabled,NEW.access_policy_revision,NEW.settings_revision)
    IS DISTINCT FROM ROW(OLD.access_source,OLD.allowance_period_id,OLD.text_fallback_enabled,OLD.access_policy_revision,OLD.settings_revision)
    OR (OLD.commercial_deadline_at IS NOT NULL AND (NEW.commercial_deadline_at IS NULL OR NEW.commercial_deadline_at>OLD.commercial_deadline_at)) THEN
    RAISE EXCEPTION 'voice access grant is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_voice_access_grant BEFORE UPDATE ON public.voice_sessions FOR EACH ROW EXECUTE FUNCTION public.guard_voice_access_grant();

CREATE FUNCTION public.audit_voice_rollout_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE b uuid;
BEGIN
  IF TG_TABLE_NAME='voice_rollout_businesses' THEN b:=COALESCE(NEW.business_id,OLD.business_id); END IF;
  -- Cleanup may remove the parent first; do not recreate its linkage.
  IF b IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.businesses WHERE id=b) THEN b:=NULL; END IF;
  INSERT INTO public.voice_commercial_audit(business_id,kind,details) VALUES(b,'rollout_change',
    jsonb_build_object('table',TG_TABLE_NAME,'operation',TG_OP,'before',to_jsonb(OLD)-'business_id','after',to_jsonb(NEW)-'business_id'));
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER audit_voice_rollout_control AFTER INSERT OR UPDATE OR DELETE ON public.voice_rollout_control FOR EACH ROW EXECUTE FUNCTION public.audit_voice_rollout_change();
CREATE TRIGGER audit_voice_rollout_business AFTER INSERT OR UPDATE OR DELETE ON public.voice_rollout_businesses FOR EACH ROW EXECUTE FUNCTION public.audit_voice_rollout_change();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['voice_rollout_control','voice_rollout_businesses','voice_commercial_settings','voice_commercial_audit','voice_billing_projection','voice_allowance_periods','voice_customer_usage'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['voice_commercial_settings','voice_allowance_periods','voice_customer_usage'] LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated',t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (business_id IN (SELECT id FROM public.businesses))',t||'_read',t);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.guard_voice_customer_accounting(),public.guard_voice_access_grant(),public.audit_voice_rollout_change() FROM PUBLIC,anon,authenticated;
COMMIT;
