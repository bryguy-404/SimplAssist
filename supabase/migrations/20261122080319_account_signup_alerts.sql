-- Internal notification outbox. No provider calls execute in customer transactions.
CREATE SCHEMA IF NOT EXISTS account_alerts_private;
REVOKE ALL ON SCHEMA account_alerts_private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA account_alerts_private TO service_role;

CREATE TABLE public.account_signup_alert_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  starts_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.account_signup_alert_control DEFAULT VALUES;

CREATE TABLE public.account_signup_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  milestone text NOT NULL CHECK (milestone IN ('verified_signup', 'setup')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'needs_review', 'canceled')),
  message jsonb CHECK (message IS NULL OR jsonb_typeof(message) = 'object'),
  claim_token uuid,
  claimed_until timestamptz,
  first_attempt_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  provider_message_id text,
  error_code text,
  UNIQUE (owner_id, milestone)
);
CREATE INDEX account_signup_alert_business_idx ON public.account_signup_alerts(business_id);
CREATE INDEX account_signup_alert_pending_idx ON public.account_signup_alerts(next_attempt_at, created_at)
  WHERE status = 'pending';
CREATE INDEX account_signup_alert_sending_idx ON public.account_signup_alerts(claimed_until)
  WHERE status = 'sending';
ALTER TABLE public.account_signup_alert_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_signup_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_signup_alert_control, public.account_signup_alerts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.account_signup_alert_control TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_signup_alerts TO service_role;

-- Auth data is deliberately read only in this unexposed, narrowly granted helper.
CREATE FUNCTION account_alerts_private.capture(p_business_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  b public.businesses; u auth.users; s public.subscriptions;
  v_payload jsonb; v_plan text; v_count integer := 0; v_added integer;
BEGIN
  SELECT * INTO b FROM public.businesses WHERE id = p_business_id;
  IF NOT FOUND OR b.deleted_at IS NOT NULL OR b.partner_id IS NOT NULL
    OR b.billing_mode IS DISTINCT FROM 'stripe' THEN RETURN 0; END IF;
  SELECT * INTO u FROM auth.users WHERE id = b.owner_id;
  IF NOT FOUND OR u.deleted_at IS NOT NULL OR u.is_anonymous IS TRUE
    OR coalesce(u.raw_app_meta_data ? 'concierge_provisioning_id', false)
    OR u.email_confirmed_at IS NULL OR nullif(u.email, '') IS NULL
    OR u.created_at IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.account_signup_alert_control WHERE singleton AND u.created_at >= starts_at
    ) THEN RETURN 0; END IF;
  SELECT * INTO s FROM public.subscriptions WHERE business_id = b.id;
  v_plan := coalesce(s.plan, b.onboarding_selected_plan);
  v_payload := jsonb_build_object(
    'version', 1, 'businessId', b.id, 'name', left(coalesce(u.raw_user_meta_data->>'full_name', ''), 200),
    'email', u.email, 'businessName', nullif(b.name, 'My Business'),
    'plan', v_plan, 'signedUpAt', u.created_at, 'occurredAt', u.email_confirmed_at,
    'kind', 'verified_signup', 'brandStatus', b.brand_status, 'campaignStatus', b.campaign_status
  );
  INSERT INTO public.account_signup_alerts(business_id, owner_id, milestone, payload)
    VALUES (b.id, u.id, 'verified_signup', v_payload)
    ON CONFLICT (owner_id, milestone) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- A selected plan or a checkout request is not evidence of paid setup.
  IF s.status NOT IN ('active', 'trialing') OR s.status IS NULL THEN RETURN v_count; END IF;
  IF s.plan = 'chat_only' AND b.onboarding_completed_at IS NOT NULL THEN
    v_payload := v_payload || jsonb_build_object('kind', 'chat_ready', 'occurredAt', b.onboarding_completed_at);
  ELSIF s.plan IN ('sms_only', 'sms_and_chat', 'full')
    AND b.onboarding_registration_submitted_at IS NOT NULL
    AND b.telnyx_brand_id IS NOT NULL
    AND b.onboarding_registration_status = 'submitted' THEN
    v_payload := v_payload || jsonb_build_object('kind', 'texting_submitted', 'occurredAt', b.onboarding_registration_submitted_at);
  ELSE RETURN v_count;
  END IF;
  INSERT INTO public.account_signup_alerts(business_id, owner_id, milestone, payload)
    VALUES (b.id, u.id, 'setup', v_payload)
    ON CONFLICT (owner_id, milestone) DO NOTHING;
  GET DIAGNOSTICS v_added = ROW_COUNT;
  RETURN v_count + v_added;
END;
$$;
REVOKE ALL ON FUNCTION account_alerts_private.capture(uuid) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION account_alerts_private.capture_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_business_id uuid;
BEGIN
  IF TG_TABLE_SCHEMA = 'auth' THEN
    FOR v_business_id IN SELECT id FROM public.businesses WHERE owner_id = NEW.id LOOP
      PERFORM account_alerts_private.capture(v_business_id);
    END LOOP;
  ELSIF TG_TABLE_NAME = 'subscriptions' THEN
    PERFORM account_alerts_private.capture(NEW.business_id);
  ELSE
    PERFORM account_alerts_private.capture(NEW.id);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Alerts must never break signup/payment. The sweep repairs missed captures.
  RAISE WARNING 'account_signup_alert_capture_failed';
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION account_alerts_private.capture_transition() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER account_signup_alert_auth AFTER INSERT OR UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW EXECUTE FUNCTION account_alerts_private.capture_transition();
CREATE TRIGGER account_signup_alert_business AFTER INSERT OR UPDATE OF onboarding_completed_at, onboarding_registration_submitted_at, onboarding_registration_status ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION account_alerts_private.capture_transition();
CREATE TRIGGER account_signup_alert_subscription AFTER INSERT OR UPDATE OF plan, status ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION account_alerts_private.capture_transition();

CREATE FUNCTION account_alerts_private.reconcile() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_count integer := 0;
BEGIN
  FOR v_id IN
    SELECT b.id FROM public.businesses b
    JOIN auth.users u ON u.id = b.owner_id
    LEFT JOIN public.subscriptions s ON s.business_id = b.id
    WHERE u.created_at >= (SELECT starts_at FROM public.account_signup_alert_control WHERE singleton)
      AND u.email_confirmed_at IS NOT NULL AND u.deleted_at IS NULL AND u.is_anonymous IS NOT TRUE
      AND NOT coalesce(u.raw_app_meta_data ? 'concierge_provisioning_id', false)
      AND b.deleted_at IS NULL AND b.partner_id IS NULL AND b.billing_mode = 'stripe'
      AND (NOT EXISTS (SELECT 1 FROM public.account_signup_alerts q WHERE q.owner_id = u.id AND q.milestone = 'verified_signup')
        OR (s.status IN ('active', 'trialing')
          AND ((s.plan = 'chat_only' AND b.onboarding_completed_at IS NOT NULL)
            OR (s.plan IN ('sms_only', 'sms_and_chat', 'full') AND b.onboarding_registration_status = 'submitted'
              AND b.onboarding_registration_submitted_at IS NOT NULL AND b.telnyx_brand_id IS NOT NULL))
          AND NOT EXISTS (SELECT 1 FROM public.account_signup_alerts q WHERE q.owner_id = u.id AND q.milestone = 'setup')))
    ORDER BY u.created_at, b.id LIMIT 100
  LOOP v_count := v_count + account_alerts_private.capture(v_id); END LOOP;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION account_alerts_private.reconcile() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION account_alerts_private.reconcile() TO service_role;
CREATE FUNCTION public.reconcile_account_signup_alerts() RETURNS integer
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$ SELECT account_alerts_private.reconcile(); $$;
REVOKE ALL ON FUNCTION public.reconcile_account_signup_alerts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_account_signup_alerts() TO service_role;

CREATE FUNCTION public.claim_account_signup_alert(p_claim_token uuid)
RETURNS SETOF public.account_signup_alerts LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_claim_token IS NULL THEN RAISE EXCEPTION 'claim token required'; END IF;
  UPDATE public.account_signup_alerts q SET status = 'canceled', message = NULL, payload = '{}', claim_token = NULL, claimed_until = NULL
    WHERE q.status IN ('pending', 'sending', 'needs_review') AND NOT EXISTS (
      SELECT 1 FROM public.businesses b WHERE b.id = q.business_id AND b.owner_id = q.owner_id
        AND b.deleted_at IS NULL AND b.partner_id IS NULL AND b.billing_mode = 'stripe'
    );
  -- Resend's deduplication lasts 24h. Stop at 23h, including worker-crash recovery.
  UPDATE public.account_signup_alerts SET status = 'needs_review', error_code = 'retry_window_expired', claim_token = NULL, claimed_until = NULL
    WHERE status IN ('pending', 'sending') AND first_attempt_at <= now() - interval '23 hours'
      AND (claimed_until IS NULL OR claimed_until < now());
  UPDATE public.account_signup_alerts SET status = 'pending', claim_token = NULL, claimed_until = NULL
    WHERE status = 'sending' AND claimed_until < now();
  RETURN QUERY
    UPDATE public.account_signup_alerts q SET status = 'sending', claim_token = p_claim_token,
      claimed_until = now() + interval '2 minutes', first_attempt_at = coalesce(q.first_attempt_at, now()),
      attempt_count = q.attempt_count + 1
    WHERE q.id = (
      SELECT pending.id FROM public.account_signup_alerts pending
      WHERE pending.status = 'pending' AND pending.next_attempt_at <= now()
        AND (pending.milestone = 'verified_signup' OR EXISTS (
          SELECT 1 FROM public.account_signup_alerts signup WHERE signup.owner_id = pending.owner_id
            AND signup.milestone = 'verified_signup' AND signup.status IN ('sent', 'needs_review')
        ))
      ORDER BY pending.created_at, pending.id LIMIT 1 FOR UPDATE SKIP LOCKED
    ) RETURNING q.*;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_account_signup_alert(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_account_signup_alert(uuid) TO service_role;

COMMENT ON TABLE public.account_signup_alerts IS 'Internal new-account email outbox. Server-only; one email per owner and milestone. Sent means provider accepted, not confirmed inbox delivery.';
