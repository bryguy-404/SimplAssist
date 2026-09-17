-- Paid commercial accounts enroll automatically. Neither account membership nor
-- an owner-controlled plan string is proof of payment. Sales/voice remain closed
-- until the independent release checks enable the existing global control.
BEGIN;
ALTER TABLE public.voice_rollout_control DROP CONSTRAINT voice_rollout_control_max_concurrent_calls_check;
ALTER TABLE public.voice_rollout_control ADD CONSTRAINT voice_rollout_control_max_concurrent_calls_check CHECK(max_concurrent_calls BETWEEN 1 AND 4);
COMMENT ON TABLE public.voice_rollout_businesses IS 'Optional emergency overrides. An absent row permits public eligibility; enabled is retained for historical compatibility and is no longer an allowlist.';
ALTER TABLE public.voice_pilot_settings ADD COLUMN retired_at timestamptz;
ALTER TABLE public.voice_pilot_settings ADD COLUMN retirement_operation_id uuid REFERENCES public.sms_billing_operations(id) ON DELETE SET NULL;
ALTER TABLE public.voice_billing_projection ADD COLUMN entitlement_operation_id uuid REFERENCES public.sms_billing_operations(id) ON DELETE SET NULL;
CREATE TABLE public.voice_billing_payments (
  invoice_id text PRIMARY KEY,
  business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  subscription_id text NOT NULL,
  customer_id text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL CHECK(period_end>period_start),
  paid_at timestamptz NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(business_id,subscription_id,invoice_id)
);
ALTER TABLE public.voice_billing_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_billing_payments FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.voice_billing_payments TO service_role;
CREATE FUNCTION public.guard_voice_payment_history() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'voice payment evidence cannot be deleted' USING ERRCODE='55000'; END IF;
  IF (to_jsonb(NEW)-'business_id') IS DISTINCT FROM (to_jsonb(OLD)-'business_id')
    OR (NEW.business_id IS DISTINCT FROM OLD.business_id AND NEW.business_id IS NOT NULL) THEN
    RAISE EXCEPTION 'voice payment evidence is immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_voice_payment_history BEFORE UPDATE OR DELETE ON public.voice_billing_payments FOR EACH ROW EXECUTE FUNCTION public.guard_voice_payment_history();
CREATE FUNCTION public.guard_voice_pilot_retirement() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.retired_at IS NOT NULL AND EXISTS(SELECT 1 FROM public.businesses WHERE id=OLD.business_id) THEN
      RAISE EXCEPTION 'voice pilot retirement is permanent' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.retired_at IS NOT NULL AND (NEW.retired_at IS DISTINCT FROM OLD.retired_at
    OR (NEW.retirement_operation_id IS DISTINCT FROM OLD.retirement_operation_id AND NEW.retirement_operation_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'voice pilot retirement is permanent' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_voice_pilot_retirement BEFORE UPDATE OR DELETE ON public.voice_pilot_settings FOR EACH ROW EXECUTE FUNCTION public.guard_voice_pilot_retirement();

CREATE FUNCTION public.voice_paid_authority_current(p_business_id uuid,p_subscription_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT EXISTS(SELECT 1 FROM public.voice_billing_projection p JOIN public.sms_billing_operations o ON o.id=p.entitlement_operation_id
    JOIN public.subscriptions s ON s.business_id=p.business_id
    WHERE p.business_id=p_business_id AND p.subscription_id=p_subscription_id AND s.stripe_subscription_id=p_subscription_id
      AND o.business_id=p_business_id AND o.state='applied' AND o.target_plan='full'
      AND o.confirmed_at IS NOT NULL AND o.payment_verified_at IS NOT NULL AND o.payment_effective_at IS NOT NULL
      AND o.stripe_subscription_id=p_subscription_id AND o.stripe_customer_id=s.stripe_customer_id);
$$;
CREATE FUNCTION public.record_voice_billing_payment(p_business_id uuid,p_revision bigint,p_subscription_id text,p_customer_id text,
 p_invoice_id text,p_period_start timestamptz,p_period_end timestamptz,p_paid_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE prior public.voice_billing_payments; p public.voice_billing_projection;
BEGIN
  PERFORM 1 FROM public.businesses WHERE id=p_business_id AND owner_id IS NOT NULL AND deleted_at IS NULL AND billing_mode='stripe' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO p FROM public.voice_billing_projection WHERE business_id=p_business_id FOR UPDATE;
  IF p.business_id IS NULL OR p.requested_revision IS DISTINCT FROM p_revision OR p_revision<=p.applied_revision
    OR p.subscription_id IS DISTINCT FROM p_subscription_id
    OR NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE business_id=p_business_id AND stripe_subscription_id=p_subscription_id AND stripe_customer_id=p_customer_id)
    THEN RETURN false; END IF;
  IF NULLIF(p_invoice_id,'') IS NULL OR NULLIF(p_customer_id,'') IS NULL OR p_period_start IS NULL OR p_period_end IS NULL OR p_period_end<=p_period_start
    OR p_paid_at IS NULL OR p_paid_at>clock_timestamp()+interval '1 minute'
    OR (p.period_start IS NOT NULL AND p_period_start<p.period_start) THEN RAISE EXCEPTION 'voice payment evidence invalid' USING ERRCODE='23514'; END IF;
  SELECT * INTO prior FROM public.voice_billing_payments WHERE invoice_id=p_invoice_id;
  IF prior.invoice_id IS NOT NULL THEN
    IF ROW(prior.business_id,prior.subscription_id,prior.customer_id,prior.period_start,prior.period_end,prior.paid_at)
      IS DISTINCT FROM ROW(p_business_id,p_subscription_id,p_customer_id,p_period_start,p_period_end,p_paid_at) THEN
      RAISE EXCEPTION 'voice payment identity mismatch' USING ERRCODE='23514'; END IF;
    RETURN true;
  END IF;
  INSERT INTO public.voice_billing_payments(invoice_id,business_id,subscription_id,customer_id,period_start,period_end,paid_at)
    VALUES(p_invoice_id,p_business_id,p_subscription_id,p_customer_id,p_period_start,p_period_end,p_paid_at);
  RETURN true;
END $$;


CREATE OR REPLACE FUNCTION public.begin_voice_billing_reconciliation(p_business_id uuid,p_subscription_id text,p_customer_id text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE rev bigint; sub public.subscriptions; projection public.voice_billing_projection;
BEGIN
  PERFORM 1 FROM public.businesses b WHERE b.id=p_business_id AND b.owner_id IS NOT NULL AND b.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT (
    EXISTS(SELECT 1 FROM public.voice_commercial_settings WHERE business_id=p_business_id)
    OR EXISTS(SELECT 1 FROM public.voice_rollout_businesses WHERE business_id=p_business_id)
    OR EXISTS(SELECT 1 FROM public.voice_billing_projection WHERE business_id=p_business_id)) THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM public.voice_pilot_settings WHERE business_id=p_business_id AND retired_at IS NULL) THEN RETURN NULL; END IF;
  SELECT * INTO sub FROM public.subscriptions WHERE business_id=p_business_id;
  SELECT * INTO projection FROM public.voice_billing_projection WHERE business_id=p_business_id;
  IF NULLIF(p_subscription_id,'') IS NULL OR NULLIF(p_customer_id,'') IS NULL
    OR (sub.business_id IS NOT NULL AND (sub.stripe_subscription_id IS DISTINCT FROM p_subscription_id OR sub.stripe_customer_id IS DISTINCT FROM p_customer_id))
    OR (projection.subscription_id IS NOT NULL AND projection.subscription_id<>p_subscription_id) THEN RETURN -1; END IF;
  INSERT INTO public.voice_billing_projection(business_id,requested_revision,subscription_id,plan,status,period_start,period_end)
    VALUES(p_business_id,1,sub.stripe_subscription_id,sub.plan,sub.status,sub.current_period_start,sub.current_period_end)
    ON CONFLICT(business_id) DO UPDATE SET requested_revision=voice_billing_projection.requested_revision+1,requested_at=clock_timestamp()
    RETURNING requested_revision INTO rev;
  RETURN rev;
END $$;

CREATE OR REPLACE FUNCTION public.apply_voice_billing_projection(p_business_id uuid,p_revision bigint,p_subscription_id text,p_plan text,p_status text,
  p_period_start timestamptz,p_period_end timestamptz,p_cancel_at_period_end boolean,p_effective_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE old public.voice_billing_projection; effective timestamptz; amount integer;
BEGIN
  PERFORM 1 FROM public.businesses b WHERE b.id=p_business_id AND b.owner_id IS NOT NULL AND b.deleted_at IS NULL AND b.billing_mode='stripe' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO old FROM public.voice_billing_projection WHERE business_id=p_business_id FOR UPDATE;
  IF old.business_id IS NULL OR p_revision IS DISTINCT FROM old.requested_revision OR p_revision<=old.applied_revision THEN RETURN false; END IF;
  IF old.subscription_id IS NOT NULL AND old.subscription_id IS DISTINCT FROM p_subscription_id THEN RETURN false; END IF;
  IF p_effective_at IS NULL OR p_effective_at>clock_timestamp()+interval '1 minute'
    OR (p_period_start IS NOT NULL AND p_period_end IS NOT NULL AND p_period_end<=p_period_start)
    OR NOT EXISTS(SELECT 1 FROM public.subscriptions s WHERE s.business_id=p_business_id AND s.stripe_subscription_id=p_subscription_id
      AND s.plan=p_plan AND s.status=p_status AND s.current_period_start IS NOT DISTINCT FROM p_period_start
      AND s.current_period_end IS NOT DISTINCT FROM p_period_end AND s.cancel_at_period_end=COALESCE(p_cancel_at_period_end,false)) THEN
    RAISE EXCEPTION 'voice billing source mismatch' USING ERRCODE='23514';
  END IF;
  -- An authoritative retrieval may revoke access, but a period may never rewind.
  IF old.period_start IS NOT NULL AND p_period_start<old.period_start THEN RETURN false; END IF;
  IF old.period_start<p_period_start AND old.period_end>p_period_start THEN
    RAISE EXCEPTION 'voice billing periods overlap' USING ERRCODE='23514'; END IF;
  IF old.subscription_id=p_subscription_id AND old.period_start=p_period_start AND old.period_end IS DISTINCT FROM p_period_end THEN
    RAISE EXCEPTION 'voice billing period changed in place' USING ERRCODE='23514';
  END IF;
  IF p_plan='full' AND old.plan IS DISTINCT FROM 'full' AND old.verified_at IS NOT NULL THEN
    RAISE EXCEPTION 'voice upgrade requires paid operation' USING ERRCODE='23514'; END IF;
  UPDATE public.voice_billing_projection SET applied_revision=p_revision,subscription_id=p_subscription_id,plan=p_plan,status=p_status,
    -- Missing source dates revoke admission through the source comparison, but
    -- cannot erase the last verified boundary and permit an overlapping grant.
    period_start=CASE WHEN p_period_start IS NULL OR p_period_end IS NULL THEN old.period_start ELSE p_period_start END,
    period_end=CASE WHEN p_period_start IS NULL OR p_period_end IS NULL THEN old.period_end ELSE p_period_end END,
    cancel_at_period_end=COALESCE(p_cancel_at_period_end,false),
    effective_at=GREATEST(old.effective_at,p_effective_at),verified_at=clock_timestamp() WHERE business_id=p_business_id;
  IF p_plan='full' AND p_status='active' AND p_period_start<=now() AND p_period_end>now()
    AND public.voice_paid_authority_current(p_business_id,p_subscription_id)
    AND (old.plan='full' OR old.verified_at IS NULL)
    AND EXISTS(SELECT 1 FROM public.voice_billing_payments pay JOIN public.subscriptions s ON s.business_id=pay.business_id
      WHERE pay.business_id=p_business_id AND pay.subscription_id=p_subscription_id AND pay.customer_id=s.stripe_customer_id
        AND pay.period_start=p_period_start AND pay.period_end=p_period_end) THEN
    effective:=CASE WHEN old.plan='full' OR old.subscription_id IS NULL THEN p_period_start
      ELSE GREATEST(p_period_start,old.effective_at,p_effective_at) END;
    amount:=GREATEST(0,LEAST(6000,floor(6000*extract(epoch FROM (p_period_end-effective))/extract(epoch FROM (p_period_end-p_period_start)))::integer));
    INSERT INTO public.voice_allowance_periods(business_id,subscription_id,period_start,period_end,included_seconds,grant_effective_at)
      VALUES(p_business_id,p_subscription_id,p_period_start,p_period_end,amount,effective)
      ON CONFLICT(business_id,subscription_id,period_start) DO NOTHING;
  END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.sync_voice_stripe_subscription(
  p_business_id uuid,p_stripe_customer_id text,p_stripe_subscription_id text,p_plan text,p_status text,
  p_current_period_start timestamptz,p_current_period_end timestamptz,p_stripe_price_id text,p_stripe_setup_fee_price_id text,
  p_stripe_checkout_session_id text,p_setup_fee_paid_at timestamptz,p_cancel_at_period_end boolean,p_updated_at timestamptz,
  p_revision bigint,p_effective_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.voice_billing_projection; changed boolean;
BEGIN
  PERFORM 1 FROM public.businesses b WHERE b.id=p_business_id AND b.deleted_at IS NULL AND b.owner_id IS NOT NULL AND b.billing_mode='stripe' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO p FROM public.voice_billing_projection WHERE business_id=p_business_id FOR UPDATE;
  IF p.business_id IS NULL OR p.requested_revision IS DISTINCT FROM p_revision OR p_revision<=p.applied_revision THEN RETURN false; END IF;
  IF (p.subscription_id IS NOT NULL AND p.subscription_id<>p_stripe_subscription_id)
    OR EXISTS(SELECT 1 FROM public.subscriptions s WHERE s.business_id=p_business_id
      AND (s.stripe_subscription_id IS DISTINCT FROM p_stripe_subscription_id OR s.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id)) THEN RETURN false; END IF;
  IF p.period_start IS NOT NULL AND p_current_period_start<p.period_start THEN RETURN false; END IF;
  changed:=public.sync_stripe_subscription_if_business_active(p_business_id,p_stripe_customer_id,p_stripe_subscription_id,p_plan,p_status,
    p_current_period_start,p_current_period_end,p_stripe_price_id,p_stripe_setup_fee_price_id,p_stripe_checkout_session_id,p_setup_fee_paid_at,
    p_cancel_at_period_end,p_updated_at);
  IF NOT changed THEN RETURN false; END IF;
  IF NOT public.apply_voice_billing_projection(p_business_id,p_revision,p_stripe_subscription_id,p_plan,p_status,p_current_period_start,
    p_current_period_end,p_cancel_at_period_end,p_effective_at) THEN RAISE EXCEPTION 'voice billing projection rejected'; END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.voice_commercial_access_reason(p_business_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE p public.voice_billing_projection;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.businesses b WHERE b.id=p_business_id AND b.owner_id IS NOT NULL AND b.deleted_at IS NULL
    AND b.operations_suspended_at IS NULL AND b.ai_replies_paused_at IS NULL) THEN RETURN 'temporarily_unavailable'; END IF;
  IF EXISTS(SELECT 1 FROM public.voice_pilot_settings WHERE business_id=p_business_id AND retired_at IS NULL) OR NOT EXISTS(SELECT 1 FROM public.voice_rollout_control g
    LEFT JOIN public.voice_rollout_businesses r ON r.business_id=p_business_id WHERE g.singleton AND g.enabled AND NOT g.emergency_stop AND NOT COALESCE(r.emergency_stop,false)) THEN RETURN 'rollout_closed'; END IF;
  SELECT * INTO p FROM public.voice_billing_projection WHERE business_id=p_business_id;
  IF p.business_id IS NULL OR p.applied_revision<>p.requested_revision OR p.verified_at IS NULL THEN RETURN 'billing_pending'; END IF;
  IF p.plan IS DISTINCT FROM 'full' THEN RETURN 'plan_required'; END IF;
  IF NOT public.voice_paid_authority_current(p_business_id,p.subscription_id) THEN RETURN 'billing_pending'; END IF;
  IF p.status IS DISTINCT FROM 'active' THEN RETURN 'payment_required'; END IF;
  IF p.period_start IS NULL OR p.period_end IS NULL OR p.period_start>now() OR p.period_end<=now()
    OR NOT EXISTS(SELECT 1 FROM public.businesses b JOIN public.subscriptions s ON s.business_id=b.id WHERE b.id=p_business_id AND b.billing_mode='stripe'
      AND s.stripe_subscription_id=p.subscription_id AND s.plan=p.plan AND s.status=p.status
      AND s.current_period_start=p.period_start AND s.current_period_end=p.period_end)
    OR NOT EXISTS(SELECT 1 FROM public.voice_billing_payments pay WHERE pay.business_id=p_business_id AND pay.subscription_id=p.subscription_id
      AND pay.period_start=p.period_start AND pay.period_end=p.period_end)
    OR NOT EXISTS(SELECT 1 FROM public.voice_allowance_periods a WHERE a.business_id=p_business_id AND a.subscription_id=p.subscription_id
      AND a.period_start=p.period_start AND a.period_end=p.period_end) THEN RETURN 'billing_pending'; END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.configure_voice_commercial(p_business_id uuid,p_primary_response text,p_text_fallback_enabled boolean,p_expected_revision integer,p_owner_id uuid)
RETURNS public.voice_commercial_settings LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE cfg public.voice_commercial_settings; reason text;
BEGIN
  IF p_primary_response IS NULL OR p_primary_response NOT IN ('text','voice') OR p_text_fallback_enabled IS NULL OR p_expected_revision IS NULL THEN
    RAISE EXCEPTION 'invalid voice settings' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.businesses b WHERE b.id=p_business_id AND b.owner_id=p_owner_id AND b.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR p_owner_id IS NULL THEN RAISE EXCEPTION 'voice owner access denied' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM public.voice_pilot_settings WHERE business_id=p_business_id AND retired_at IS NULL) THEN RAISE EXCEPTION 'private pilot uses pilot controls' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.voice_commercial_settings WHERE business_id=p_business_id) THEN
    RAISE EXCEPTION 'voice rollout unavailable' USING ERRCODE='42501'; END IF;
  INSERT INTO public.voice_commercial_settings(business_id) VALUES(p_business_id) ON CONFLICT DO NOTHING;
  SELECT * INTO cfg FROM public.voice_commercial_settings WHERE business_id=p_business_id FOR UPDATE;
  IF cfg.revision<>p_expected_revision THEN RAISE EXCEPTION 'voice settings changed; reload' USING ERRCODE='40001'; END IF;
  reason:=public.voice_commercial_access_reason(p_business_id);
  IF p_primary_response='voice' AND cfg.primary_response<>'voice' AND reason IS NOT NULL THEN
    RAISE EXCEPTION 'voice access unavailable: %',reason USING ERRCODE='42501'; END IF;
  UPDATE public.voice_commercial_settings SET primary_response=p_primary_response,text_fallback_enabled=p_text_fallback_enabled,
    revision=revision+1,updated_at=clock_timestamp() WHERE business_id=p_business_id RETURNING * INTO cfg;
  INSERT INTO public.voice_commercial_audit(business_id,kind,details) VALUES(p_business_id,'owner_settings',
    jsonb_build_object('revision',cfg.revision,'primary_response',cfg.primary_response,'text_fallback_enabled',cfg.text_fallback_enabled));
  RETURN cfg;
END $$;

CREATE OR REPLACE FUNCTION public.get_voice_commercial_summary(p_business_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE cfg public.voice_commercial_settings; p public.voice_allowance_periods; pilot public.voice_pilot_settings;
  used numeric:=0; held numeric:=0; reason text; reconciling boolean:=false; visible boolean;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.businesses WHERE id=p_business_id AND owner_id IS NOT NULL AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'voice business unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO pilot FROM public.voice_pilot_settings WHERE business_id=p_business_id;
  IF pilot.business_id IS NOT NULL AND pilot.retired_at IS NULL THEN
    SELECT COALESCE(sum(used_seconds),0),COALESCE(sum(GREATEST(used_seconds,reserved_seconds)-used_seconds),0),COALESCE(bool_or(NOT usage_confirmed AND status='closed'),false)
      INTO used,held,reconciling FROM public.voice_sessions WHERE business_id=p_business_id AND access_source='pilot';
    RETURN jsonb_build_object('visible',true,'access_source','pilot','eligible',pilot.enabled,'reason',CASE WHEN pilot.enabled THEN NULL ELSE 'rollout_closed' END,
      'primary_response',CASE WHEN pilot.enabled THEN 'voice' ELSE 'text' END,'text_fallback_enabled',true,'revision',pilot.revision,
      'period_id',NULL,'period_start',NULL,'period_end',NULL,'included_seconds',pilot.budget_seconds,'used_seconds',used,'held_seconds',held,
      'available_seconds',GREATEST(0,pilot.budget_seconds-used-held),'reconciling',reconciling,'policy_revision',1);
  END IF;
  SELECT * INTO cfg FROM public.voice_commercial_settings WHERE business_id=p_business_id;
  visible:=cfg.business_id IS NOT NULL OR EXISTS(SELECT 1 FROM public.voice_rollout_businesses WHERE business_id=p_business_id)
    OR EXISTS(SELECT 1 FROM public.voice_allowance_periods WHERE business_id=p_business_id);
  SELECT a.* INTO p FROM public.voice_allowance_periods a JOIN public.voice_billing_projection b ON b.business_id=a.business_id
    AND b.subscription_id=a.subscription_id AND b.period_start=a.period_start WHERE a.business_id=p_business_id;
  IF p.id IS NOT NULL THEN
    SELECT COALESCE(sum(COALESCE(settled_seconds,0)),0),COALESCE(sum(CASE WHEN settled_at IS NULL THEN reserved_seconds ELSE 0 END),0),
      COALESCE(bool_or(state='reconciling'),false) INTO used,held,reconciling FROM public.voice_customer_usage WHERE period_id=p.id;
  END IF;
  reason:=public.voice_commercial_access_reason(p_business_id);
  IF reason IS NULL AND COALESCE(p.included_seconds,0)-used-held<60 THEN reason:='exhausted'; END IF;
  RETURN jsonb_build_object('visible',visible,'access_source','commercial','eligible',reason IS NULL,'reason',reason,
    'primary_response',COALESCE(cfg.primary_response,'text'),'text_fallback_enabled',COALESCE(cfg.text_fallback_enabled,true),'revision',COALESCE(cfg.revision,1),
    'period_id',p.id,'period_start',p.period_start,'period_end',p.period_end,'included_seconds',COALESCE(p.included_seconds,0),
    'used_seconds',used,'held_seconds',held,'available_seconds',GREATEST(0,COALESCE(p.included_seconds,0)-used-held),
    'reconciling',reconciling,'policy_revision',1);
END $$;

CREATE OR REPLACE FUNCTION public.admit_voice_commercial(p_business_id uuid,p_call_control_id text,p_call_session_id text,p_caller text,p_called text,p_worker_ready boolean)
RETURNS public.voice_sessions LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE cfg public.voice_commercial_settings; result public.voice_sessions; a public.voice_allowance_periods;
  global_cfg public.voice_rollout_control; reason text; committed numeric; reserved integer:=0; contact uuid; conversation uuid; identity_hash text;
BEGIN
  SELECT * INTO global_cfg FROM public.voice_rollout_control WHERE singleton FOR UPDATE;
  PERFORM 1 FROM public.businesses WHERE id=p_business_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO result FROM public.voice_sessions WHERE call_control_id=p_call_control_id;
  IF FOUND THEN
    IF ROW(result.business_id,result.call_session_id,result.caller_phone,result.called_phone) IS DISTINCT FROM ROW(p_business_id,p_call_session_id,p_caller,p_called) THEN
      RAISE EXCEPTION 'Call identity mismatch'; END IF;
    RETURN result;
  END IF;
  IF p_call_control_id IS NULL OR length(p_call_control_id) NOT BETWEEN 1 AND 1000 OR p_call_session_id IS NULL OR length(p_call_session_id) NOT BETWEEN 1 AND 1000
    OR p_caller IS NULL OR p_caller!~'^\+[1-9][0-9]{7,14}$' OR p_called IS NULL OR p_called!~'^\+[1-9][0-9]{7,14}$' THEN
    RAISE EXCEPTION 'Invalid call identity'; END IF;
  identity_hash:=encode(extensions.digest(p_call_control_id,'sha256'),'hex');
  IF EXISTS(SELECT 1 FROM public.voice_customer_usage WHERE call_identity_hash=identity_hash) THEN
    RAISE EXCEPTION 'voice call history was deleted; replay denied' USING ERRCODE='55000'; END IF;
  SELECT * INTO cfg FROM public.voice_commercial_settings WHERE business_id=p_business_id FOR UPDATE;
  IF cfg.business_id IS NULL OR cfg.primary_response<>'voice'
    OR EXISTS(SELECT 1 FROM public.voice_pilot_settings WHERE business_id=p_business_id AND retired_at IS NULL)
    OR NOT EXISTS(SELECT 1 FROM public.phone_numbers WHERE business_id=p_business_id AND phone_number=p_called AND is_active) THEN RETURN NULL; END IF;
  IF EXISTS(SELECT 1 FROM public.call_forwarding_attempts WHERE inbound_call_control_id=p_call_control_id AND status='connected') THEN RETURN NULL; END IF;
  reason:=public.voice_commercial_access_reason(p_business_id);
  IF reason IS NULL AND NOT COALESCE(p_worker_ready,false) THEN reason:='worker_unavailable'; END IF;
  IF reason IS NULL AND ((SELECT count(*) FROM public.voice_sessions v WHERE v.response_mode='voice' AND (v.status<>'closed'
    OR (v.access_source='pilot' AND v.phone_ended_at IS NULL AND v.provider_hangup_confirmed_at IS NULL)
    OR (v.access_source='commercial' AND EXISTS(SELECT 1 FROM public.voice_customer_usage u WHERE u.session_id=v.id AND u.termination_at IS NULL))))>=global_cfg.max_concurrent_calls
    OR (SELECT count(*) FROM public.voice_sessions v WHERE v.business_id=p_business_id AND v.response_mode='voice' AND (v.status<>'closed'
      OR (v.access_source='pilot' AND v.phone_ended_at IS NULL AND v.provider_hangup_confirmed_at IS NULL)
      OR (v.access_source='commercial' AND EXISTS(SELECT 1 FROM public.voice_customer_usage u WHERE u.session_id=v.id AND u.termination_at IS NULL))))>=2) THEN reason:='capacity_unavailable'; END IF;
  IF reason IS NULL THEN
    SELECT x.* INTO a FROM public.voice_allowance_periods x JOIN public.voice_billing_projection p ON p.business_id=x.business_id
      AND p.subscription_id=x.subscription_id AND p.period_start=x.period_start WHERE x.business_id=p_business_id FOR UPDATE OF x;
    SELECT COALESCE(sum(COALESCE(settled_seconds,reserved_seconds)),0) INTO committed FROM public.voice_customer_usage WHERE period_id=a.id;
    IF a.included_seconds-committed<60 THEN reason:='minutes_unavailable';
    ELSE reserved:=LEAST(600,floor(a.included_seconds-committed)::integer); END IF;
  END IF;
  IF reserved>0 THEN
    INSERT INTO public.contacts(business_id,phone_number,source_channel) VALUES(p_business_id,p_caller,'voice')
      ON CONFLICT(business_id,phone_number) WHERE phone_number IS NOT NULL DO UPDATE SET last_contacted_at=now() RETURNING id INTO contact;
    INSERT INTO public.conversations(business_id,contact_id,channel,is_ai_handling) VALUES(p_business_id,contact,'voice',false) RETURNING id INTO conversation;
  END IF;
  INSERT INTO public.voice_sessions(business_id,conversation_id,call_control_id,call_session_id,caller_phone,called_phone,response_mode,reserved_seconds,outcome,
    access_source,allowance_period_id,commercial_deadline_at,text_fallback_enabled,settings_revision)
    VALUES(p_business_id,conversation,p_call_control_id,p_call_session_id,p_caller,p_called,CASE WHEN reserved>0 THEN 'voice' ELSE 'text' END,reserved,reason,
      'commercial',CASE WHEN reserved>0 THEN a.id END,CASE WHEN reserved>0 THEN clock_timestamp()+make_interval(secs=>reserved+120) END,cfg.text_fallback_enabled,cfg.revision)
    RETURNING * INTO result;
  IF reserved>0 THEN
    INSERT INTO public.voice_customer_usage(call_key,call_identity_hash,business_id,session_id,period_id,reserved_seconds)
      VALUES(result.id,identity_hash,p_business_id,result.id,a.id,reserved);
  END IF;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.voice_session_continuation_allowed(p_session_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT EXISTS(SELECT 1 FROM public.voice_sessions s JOIN public.businesses b ON b.id=s.business_id
    JOIN public.voice_customer_usage u ON u.session_id=s.id JOIN public.voice_rollout_control g ON g.singleton
    LEFT JOIN public.voice_rollout_businesses r ON r.business_id=s.business_id
    WHERE s.id=p_session_id AND s.access_source='commercial' AND s.response_mode='voice' AND s.status<>'closed' AND s.phone_ended_at IS NULL
      AND s.commercial_deadline_at>clock_timestamp() AND u.termination_at IS NULL AND u.settled_at IS NULL
      AND (u.started_at IS NOT NULL OR s.created_at+interval '120 seconds'>clock_timestamp())
      AND b.owner_id IS NOT NULL AND b.deleted_at IS NULL AND b.operations_suspended_at IS NULL AND b.ai_replies_paused_at IS NULL
      AND NOT g.emergency_stop AND NOT COALESCE(r.emergency_stop,false)
      AND EXISTS(SELECT 1 FROM public.phone_numbers n WHERE n.business_id=s.business_id AND n.phone_number=s.called_phone AND n.is_active));
$$;

-- Called by the payment finalizer in the same transaction as its canonical
-- subscription write. A verified payment never needs a manual voice membership.
CREATE OR REPLACE FUNCTION public.apply_paid_sms_voice_entitlement(p_business_id uuid,p_operation_id uuid,p_prior_plan text,
  p_prior_subscription_id text,p_prior_period_start timestamptz,p_prior_period_end timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.sms_billing_operations; s public.subscriptions; previous public.voice_billing_projection;
  pilot public.voice_pilot_settings; ticket bigint; initial boolean; changed boolean;
BEGIN
  PERFORM 1 FROM public.businesses WHERE id=p_business_id AND owner_id IS NOT NULL AND deleted_at IS NULL AND billing_mode='stripe' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'voice enrollment business unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO o FROM public.sms_billing_operations WHERE id=p_operation_id;
  SELECT * INTO s FROM public.subscriptions WHERE business_id=p_business_id;
  IF o.business_id IS DISTINCT FROM p_business_id OR o.state IS DISTINCT FROM 'applied' OR o.kind NOT IN ('checkout','upgrade')
    OR o.confirmed_at IS NULL OR o.applied_at IS NULL OR o.payment_verified_at IS NULL OR o.payment_effective_at IS NULL OR o.invoice_id IS NULL
    OR s.stripe_subscription_id IS DISTINCT FROM o.stripe_subscription_id OR s.stripe_customer_id IS DISTINCT FROM o.stripe_customer_id
    OR s.plan IS DISTINCT FROM o.target_plan OR s.status IS DISTINCT FROM 'active'
    OR s.current_period_start IS NULL OR s.current_period_end IS NULL OR s.current_period_end<=o.payment_effective_at
    OR NOT EXISTS(SELECT 1 FROM public.businesses WHERE id=p_business_id AND owner_id=o.owner_id) THEN
    RAISE EXCEPTION 'voice enrollment payment unverified' USING ERRCODE='23514'; END IF;
  IF ROW(p_prior_plan,p_prior_subscription_id,p_prior_period_start,p_prior_period_end)
    IS DISTINCT FROM ROW(o.source_plan,o.expected_subscription_id,o.source_period_start,o.source_period_end) THEN
    RAISE EXCEPTION 'voice enrollment prior source mismatch' USING ERRCODE='23514'; END IF;
  SELECT * INTO previous FROM public.voice_billing_projection WHERE business_id=p_business_id FOR UPDATE;
  IF previous.entitlement_operation_id=o.id THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM public.sms_billing_operations newer WHERE newer.id=previous.entitlement_operation_id AND newer.applied_at>o.applied_at) THEN
    RAISE EXCEPTION 'voice enrollment superseded' USING ERRCODE='23514'; END IF;
  IF o.target_plan<>'full' AND previous.business_id IS NULL THEN RETURN; END IF;
  initial:=p_prior_subscription_id IS DISTINCT FROM s.stripe_subscription_id;
  -- Replacing the canonical source is authorized only here, from the exact paid
  -- operation. Incrementing the ticket invalidates every old in-flight snapshot.
  INSERT INTO public.voice_billing_projection(business_id,requested_revision,subscription_id,plan,status,period_start,period_end,entitlement_operation_id)
    VALUES(p_business_id,1,s.stripe_subscription_id,CASE WHEN initial THEN NULL ELSE p_prior_plan END,'active',
      CASE WHEN initial THEN NULL ELSE p_prior_period_start END,CASE WHEN initial THEN NULL ELSE p_prior_period_end END,
      CASE WHEN o.target_plan='full' THEN o.id END)
    ON CONFLICT(business_id) DO UPDATE SET requested_revision=voice_billing_projection.requested_revision+1,
      subscription_id=s.stripe_subscription_id,plan=CASE WHEN initial THEN NULL ELSE p_prior_plan END,
      period_start=CASE WHEN initial THEN NULL ELSE p_prior_period_start END,
      period_end=CASE WHEN initial THEN NULL ELSE p_prior_period_end END,
      entitlement_operation_id=CASE WHEN o.target_plan='full' THEN o.id END,
      effective_at=NULL,verified_at=NULL,requested_at=clock_timestamp()
    RETURNING requested_revision INTO ticket;
  IF NOT public.record_voice_billing_payment(p_business_id,ticket,s.stripe_subscription_id,s.stripe_customer_id,o.invoice_id,
      s.current_period_start,s.current_period_end,o.payment_effective_at) THEN
    RAISE EXCEPTION 'voice enrollment payment evidence rejected'; END IF;
  -- A new paid subscription gets its complete month. A same-source upgrade gets
  -- only the remainder measured at the original paid invoice time, even on retry.
  IF initial THEN
    UPDATE public.voice_billing_projection SET plan='full' WHERE business_id=p_business_id AND o.target_plan='full';
  END IF;
  changed:=public.apply_voice_billing_projection(p_business_id,ticket,s.stripe_subscription_id,s.plan,s.status,
    s.current_period_start,s.current_period_end,s.cancel_at_period_end,o.payment_effective_at);
  IF NOT changed THEN RAISE EXCEPTION 'voice enrollment projection rejected'; END IF;
  IF o.target_plan='full' THEN
    SELECT * INTO pilot FROM public.voice_pilot_settings WHERE business_id=p_business_id FOR UPDATE;
    INSERT INTO public.voice_commercial_settings(business_id,primary_response)
      VALUES(p_business_id,CASE WHEN pilot.retired_at IS NULL AND COALESCE(pilot.enabled,false) THEN 'voice' ELSE 'text' END)
      ON CONFLICT(business_id) DO NOTHING;
    IF pilot.business_id IS NOT NULL AND pilot.retired_at IS NULL THEN
      UPDATE public.voice_pilot_settings SET retired_at=clock_timestamp(),retirement_operation_id=o.id,revision=voice_pilot_settings.revision+1
        WHERE business_id=p_business_id;
      INSERT INTO public.voice_commercial_audit(business_id,kind,details)
        VALUES(p_business_id,'pilot_retired',jsonb_build_object('operation_id',o.id));
    END IF;
  END IF;
  INSERT INTO public.voice_commercial_audit(business_id,kind,details)
    VALUES(p_business_id,'paid_enrollment',jsonb_build_object('operation_id',o.id,'subscription_replaced',initial));
END $$;

-- Pilot control/usage paths share the business-first ordering used by paid
-- transition and account cleanup. Otherwise a final provider usage insert can
-- hold pilot settings while waiting for the upgrade's business FK lock.
DO $$ DECLARE d text; name text; needle text; BEGIN
  FOREACH name IN ARRAY ARRAY['configure_voice_pilot(integer,boolean,integer,jsonb,uuid)',
    'configure_voice_actions(integer,boolean,boolean,boolean,boolean,uuid,text,jsonb,uuid)'] LOOP
    d:=pg_get_functiondef(('public.'||name)::regprocedure);
    needle:='SELECT * INTO cfg FROM public.voice_pilot_settings WHERE business_id=''ea848911-ef72-44a6-8cf3-c47b3959be26'' FOR UPDATE;';
    IF position(needle IN d)=0 THEN RAISE EXCEPTION 'pilot settings definition drift'; END IF;
    EXECUTE replace(d,needle,'PERFORM 1 FROM public.businesses WHERE id=''ea848911-ef72-44a6-8cf3-c47b3959be26'' FOR UPDATE; '||needle||
      ' IF cfg.retired_at IS NOT NULL THEN RAISE EXCEPTION ''private pilot has been retired'' USING ERRCODE=''42501''; END IF;');
  END LOOP;
  FOREACH name IN ARRAY ARRAY['update_voice_pilot_usage_legacy(uuid,numeric,boolean)','finalize_voice_pilot_session_legacy(uuid,text,text,boolean,boolean)'] LOOP
    d:=pg_get_functiondef(('public.'||name)::regprocedure);
    needle:='PERFORM 1 FROM public.voice_pilot_settings WHERE business_id=(SELECT business_id FROM public.voice_sessions WHERE id=p_session_id) FOR UPDATE;';
    IF position(needle IN d)=0 THEN RAISE EXCEPTION 'pilot settlement definition drift'; END IF;
    EXECUTE replace(d,needle,'PERFORM 1 FROM public.businesses WHERE id=(SELECT business_id FROM public.voice_sessions WHERE id=p_session_id) FOR UPDATE; '||needle);
  END LOOP;
END $$;

-- Pilot retirement blocks new private admissions forever, while already admitted
-- pilot calls retain their original behavior, records and lifetime accounting.
CREATE OR REPLACE FUNCTION public.admit_voice_pilot(p_business_id uuid,p_call_control_id text,p_call_session_id text,p_caller text,p_called text,p_worker_ready boolean)
RETURNS public.voice_sessions LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE cap integer; ready boolean; prior boolean; result public.voice_sessions;
BEGIN
  SELECT max_concurrent_calls INTO cap FROM public.voice_rollout_control WHERE singleton FOR UPDATE;
  PERFORM 1 FROM public.businesses WHERE id=p_business_id FOR UPDATE;
  -- A frozen pre-retirement decision stays authoritative on webhook replay.
  SELECT * INTO result FROM public.voice_sessions WHERE call_control_id=p_call_control_id;
  IF result.id IS NOT NULL THEN
    IF ROW(result.business_id,result.call_session_id,result.caller_phone,result.called_phone) IS DISTINCT FROM ROW(p_business_id,p_call_session_id,p_caller,p_called) THEN
      RAISE EXCEPTION 'Call identity mismatch'; END IF;
    RETURN result;
  END IF;
  IF EXISTS(SELECT 1 FROM public.voice_pilot_settings WHERE business_id=p_business_id AND retired_at IS NOT NULL) THEN RETURN NULL; END IF;
  ready:=COALESCE(p_worker_ready,false) AND (SELECT count(*) FROM public.voice_sessions v WHERE v.response_mode='voice' AND (v.status<>'closed'
    OR (v.access_source='pilot' AND v.phone_ended_at IS NULL AND v.provider_hangup_confirmed_at IS NULL)
    OR (v.access_source='commercial' AND EXISTS(SELECT 1 FROM public.voice_customer_usage u WHERE u.session_id=v.id AND u.termination_at IS NULL))))<cap
    AND (SELECT count(*) FROM public.voice_sessions v WHERE v.business_id=p_business_id AND v.response_mode='voice' AND (v.status<>'closed'
    OR (v.access_source='pilot' AND v.phone_ended_at IS NULL AND v.provider_hangup_confirmed_at IS NULL)
    OR (v.access_source='commercial' AND EXISTS(SELECT 1 FROM public.voice_customer_usage u WHERE u.session_id=v.id AND u.termination_at IS NULL))))<2;
  result:=public.admit_voice_pilot_legacy(p_business_id,p_call_control_id,p_call_session_id,p_caller,p_called,ready);
  IF p_worker_ready AND NOT ready AND result.outcome='worker_unavailable' THEN
    UPDATE public.voice_sessions SET outcome='capacity_unavailable' WHERE id=result.id RETURNING * INTO result;
  END IF;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.prepare_preinformed_voice_session(p_session_id uuid)
RETURNS public.voice_sessions LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.voice_sessions; acknowledged timestamptz;
BEGIN
  SELECT * INTO s FROM public.voice_sessions WHERE id=p_session_id FOR UPDATE;
  IF s.id IS NULL OR s.access_source<>'pilot' OR s.business_id<>'ea848911-ef72-44a6-8cf3-c47b3959be26'
    OR s.called_phone<>'+15742638634' OR s.response_mode<>'voice'
    OR NOT (s.status='ringing' OR (s.status='starting' AND s.prior_disclosure_acknowledged_at IS NOT NULL)) THEN RETURN NULL; END IF;
  SELECT t.prior_disclosure_acknowledged_at INTO acknowledged FROM public.voice_pilot_testers t
    WHERE t.business_id=s.business_id AND t.phone_number=s.caller_phone AND t.prior_disclosure_acknowledged_at<=s.created_at FOR SHARE;
  IF acknowledged IS NULL OR NOT EXISTS(SELECT 1 FROM public.voice_pilot_settings p JOIN public.businesses b ON b.id=p.business_id
      WHERE p.business_id=s.business_id AND p.enabled AND (p.retired_at IS NULL OR s.created_at<p.retired_at)
        AND b.owner_id IS NOT NULL AND b.deleted_at IS NULL AND b.operations_suspended_at IS NULL AND b.ai_replies_paused_at IS NULL)
    OR NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE business_id=s.business_id AND status IN ('active','trialing')) THEN RETURN NULL; END IF;
  UPDATE public.voice_sessions SET status='starting',prior_disclosure_acknowledged_at=COALESCE(prior_disclosure_acknowledged_at,acknowledged),
    media_start_requested_at=COALESCE(media_start_requested_at,now()),heartbeat_at=now() WHERE id=s.id RETURNING * INTO s;
  RETURN s;
END $$;
CREATE OR REPLACE FUNCTION public.claim_voice_preparation(p_session_id uuid) RETURNS public.voice_sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.voice_sessions s JOIN public.voice_pilot_settings p ON p.business_id=s.business_id
    WHERE s.id=p_session_id AND s.access_source='pilot' AND (p.retired_at IS NULL OR s.created_at<p.retired_at)) THEN
    RETURN public.claim_voice_pilot_preparation_legacy(p_session_id); END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.voice_action_allowed(p_session_id uuid,p_kind text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.voice_sessions WHERE id=p_session_id AND access_source='pilot') THEN
    RETURN public.voice_pilot_action_allowed_legacy(p_session_id,p_kind); END IF;
  RETURN EXISTS(SELECT 1 FROM public.voice_sessions s JOIN public.businesses b ON b.id=s.business_id
    WHERE s.id=p_session_id AND s.status='active' AND s.action_business_id=s.business_id AND NOT s.demo_mode
      AND public.voice_session_continuation_allowed(s.id)
      AND CASE p_kind WHEN 'contact' THEN true
        WHEN 'signup' THEN b.primary_goal='signup' AND b.texting_paused_at IS NULL AND EXISTS(
          SELECT 1 FROM public.subscriptions sub WHERE sub.business_id=b.id AND sub.status IN ('active','trialing','past_due') AND sub.plan IN ('sms_only','sms_and_chat','full'))
        WHEN 'booking' THEN b.primary_goal='book' AND b.bookings_paused_at IS NULL
          AND EXISTS(SELECT 1 FROM public.ai_settings ai WHERE ai.business_id=b.id AND ai.booking_enabled AND ai.booking_mode='schedule_direct')
          AND EXISTS(SELECT 1 FROM public.google_calendar_tokens c WHERE c.business_id=b.id AND NULLIF(c.calendar_id,'') IS NOT NULL)
          AND EXISTS(SELECT 1 FROM public.subscriptions sub WHERE sub.business_id=b.id AND sub.status='active' AND sub.plan IN ('chat_only','sms_and_chat','full'))
        WHEN 'booking_request' THEN b.primary_goal='book' AND b.bookings_paused_at IS NULL
          AND EXISTS(SELECT 1 FROM public.ai_settings ai WHERE ai.business_id=b.id AND ai.booking_enabled AND ai.booking_mode='collect_info')
          AND EXISTS(SELECT 1 FROM public.subscriptions sub WHERE sub.business_id=b.id AND sub.status='active' AND sub.plan IN ('chat_only','sms_and_chat','full'))
        ELSE false END);
END $$;

DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY(ARRAY[
    'guard_voice_payment_history','guard_voice_pilot_retirement','voice_paid_authority_current','record_voice_billing_payment',
    'begin_voice_billing_reconciliation','apply_voice_billing_projection','sync_voice_stripe_subscription',
    'voice_commercial_access_reason','configure_voice_commercial','get_voice_commercial_summary','admit_voice_commercial',
    'voice_session_continuation_allowed','apply_paid_sms_voice_entitlement','admit_voice_pilot','prepare_preinformed_voice_session',
    'claim_voice_preparation','voice_action_allowed']) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
  END LOOP;
END $$;
COMMIT;
