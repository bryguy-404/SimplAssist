-- Review texting is a separate grant. It never changes the base plan or the
-- Chat plan-family lock, and owners cannot write payment/provider authority.
CREATE TABLE public.review_sms_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL UNIQUE REFERENCES public.businesses(id) ON DELETE CASCADE,
 owner_id uuid NOT NULL REFERENCES auth.users(id),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','activation_pending','carrier_pending','ready_unpaid','active','cancel_pending','support_required','release_pending','released')),
 billing_source text NOT NULL CHECK(billing_source IN ('direct','included','grant')),
 source_subscription_id text, source_customer_id text,
 draft jsonb NOT NULL DEFAULT '{}'::jsonb,
 activation_paid_at timestamptz, activation_payment_intent_id text UNIQUE,
 activation_refunded_at timestamptz,
 provider_started_at timestamptz, provider_submitted_at timestamptz,
 provider_attempt_count integer NOT NULL DEFAULT 0 CHECK(provider_attempt_count BETWEEN 0 AND 1),
 provisioning_claim uuid, provisioning_lease_until timestamptz,
 review_usecase_approved_at timestamptz, approval_evidence text,
 campaign_id text, messaging_profile_id text, phone_number_id uuid REFERENCES public.phone_numbers(id),
 exclusive_resources boolean NOT NULL DEFAULT false,
 ready_at timestamptz, ready_expires_at timestamptz,
 stripe_item_id text, stripe_price_id text, stripe_schedule_id text,
 paid_period_start timestamptz, paid_period_end timestamptz, paid_invoice_id text,
 period_allowance integer NOT NULL DEFAULT 0 CHECK(period_allowance BETWEEN 0 AND 250),
 grant_expires_at timestamptz, grant_actor uuid REFERENCES auth.users(id),
 cancel_at timestamptz, release_at timestamptz, released_at timestamptz,
 billing_revision bigint NOT NULL DEFAULT 0, applied_revision bigint NOT NULL DEFAULT 0,
 last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(paid_period_end IS NULL OR paid_period_end>paid_period_start),
 CHECK(billing_source<>'grant' OR (grant_expires_at IS NOT NULL AND grant_actor IS NOT NULL))
);
CREATE TABLE public.review_sms_billing_operations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES public.review_sms_accounts(id) ON DELETE CASCADE,
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 owner_id uuid NOT NULL REFERENCES auth.users(id),
 kind text NOT NULL CHECK(kind IN ('activation','recurring','cancel','refund')),
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','confirmed','completed','expired','unknown')),
 fingerprint text NOT NULL, payload jsonb NOT NULL,
 checkout_session_id text UNIQUE, invoice_id text, schedule_id text,
 created_at timestamptz NOT NULL DEFAULT now(), confirmed_at timestamptz, completed_at timestamptz,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes'
);
CREATE UNIQUE INDEX review_sms_one_pending_operation ON public.review_sms_billing_operations(account_id,kind)
 WHERE state IN ('prepared','confirmed','unknown');
ALTER TABLE public.review_sms_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_sms_billing_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.review_sms_accounts,public.review_sms_billing_operations FROM anon,authenticated;
GRANT ALL ON public.review_sms_accounts,public.review_sms_billing_operations TO service_role;

CREATE FUNCTION public.has_review_sms_access(p_business_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT
  a.state IN ('active','cancel_pending') AND a.review_usecase_approved_at IS NOT NULL
  AND nullif(a.approval_evidence,'') IS NOT NULL
  AND b.owner_id=a.owner_id AND b.deleted_at IS NULL AND b.operations_suspended_at IS NULL
  AND b.texting_paused_at IS NULL AND NOT b.telnyx_submission_disabled AND b.active_telnyx_release_run_id IS NULL AND b.campaign_status='approved'
  AND b.telnyx_campaign_id=a.campaign_id AND b.telnyx_messaging_profile_id=a.messaging_profile_id
  AND pn.business_id=b.id AND pn.is_active=true
  AND pn.telnyx_campaign_assignment_status='assigned'
  AND pn.telnyx_campaign_assignment_campaign_id=a.campaign_id
  AND (a.cancel_at IS NULL OR a.cancel_at>now())
  AND (SELECT allowed FROM review_business_billing(b.id))
  AND CASE a.billing_source
   WHEN 'direct' THEN s.plan='chat_only' AND s.status='active'
    AND s.stripe_subscription_id=a.source_subscription_id AND s.stripe_customer_id=a.source_customer_id
    AND a.stripe_item_id IS NOT NULL AND a.paid_invoice_id IS NOT NULL
    AND a.paid_period_start<=now() AND a.paid_period_end>now()
   WHEN 'included' THEN (SELECT plan FROM review_business_billing(b.id)) IN ('sms_only','sms_and_chat','full')
   WHEN 'grant' THEN a.grant_expires_at>now() AND a.grant_actor IS NOT NULL
   ELSE false END
 FROM review_sms_accounts a JOIN businesses b ON b.id=a.business_id
 LEFT JOIN subscriptions s ON s.business_id=b.id
 JOIN phone_numbers pn ON pn.id=a.phone_number_id WHERE a.business_id=p_business_id),false)
$$;
CREATE FUNCTION public.review_sms_allowance(p_business_id uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN has_review_sms_access(p_business_id)
  AND (SELECT plan FROM review_business_billing(p_business_id))='chat_only'
  THEN coalesce((SELECT CASE WHEN billing_source='grant' THEN 250 ELSE period_allowance END
   FROM review_sms_accounts WHERE business_id=p_business_id),0) ELSE 0 END
$$;

CREATE FUNCTION public.review_sms_acquire_account(p_business uuid,p_owner uuid,p_draft jsonb)
RETURNS public.review_sms_accounts LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b businesses; s subscriptions; a review_sms_accounts; v_plan text;
BEGIN
 PERFORM review_assert_owner(p_business,p_owner);
 SELECT * INTO b FROM businesses WHERE id=p_business;
 SELECT * INTO s FROM subscriptions WHERE business_id=p_business;
 SELECT plan INTO v_plan FROM review_business_billing(p_business) WHERE allowed;
 IF v_plan IS NULL OR b.texting_paused_at IS NOT NULL THEN RAISE EXCEPTION 'review_sms_billing_required'; END IF;
 SELECT * INTO a FROM review_sms_accounts WHERE business_id=p_business FOR UPDATE;
 IF NOT FOUND THEN
  IF v_plan='chat_only' AND (b.partner_id IS NOT NULL OR b.billing_mode<>'stripe' OR s.stripe_subscription_id IS NULL) THEN
   RAISE EXCEPTION 'review_sms_partner_grant_required';
  END IF;
  INSERT INTO review_sms_accounts(business_id,owner_id,billing_source,source_subscription_id,source_customer_id,exclusive_resources,draft)
   VALUES(p_business,p_owner,CASE WHEN v_plan='chat_only' THEN 'direct' ELSE 'included' END,
    s.stripe_subscription_id,s.stripe_customer_id,v_plan='chat_only' AND b.telnyx_campaign_id IS NULL AND NOT EXISTS(SELECT 1 FROM phone_numbers WHERE business_id=p_business AND is_active=true),p_draft)
   RETURNING * INTO a;
 ELSIF a.owner_id<>p_owner THEN RAISE EXCEPTION 'review_sms_owner_changed';
 ELSIF a.state='draft' AND a.provider_started_at IS NULL THEN
  UPDATE review_sms_accounts SET draft=p_draft,updated_at=now() WHERE id=a.id RETURNING * INTO a;
 ELSE RAISE EXCEPTION 'review_sms_setup_already_started';
 END IF;
 RETURN a;
END $$;

CREATE FUNCTION public.review_sms_acquire_operation(p_business uuid,p_owner uuid,p_kind text,p_fingerprint text,p_payload jsonb)
RETURNS public.review_sms_billing_operations LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a review_sms_accounts; o review_sms_billing_operations;
BEGIN
 PERFORM review_assert_owner(p_business,p_owner);
 SELECT * INTO a FROM review_sms_accounts WHERE business_id=p_business AND owner_id=p_owner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'review_sms_setup_required'; END IF;
 SELECT * INTO o FROM review_sms_billing_operations WHERE account_id=a.id AND kind=p_kind AND state IN ('prepared','confirmed','unknown') FOR UPDATE;
 IF FOUND THEN
  IF o.fingerprint IS DISTINCT FROM p_fingerprint THEN RAISE EXCEPTION 'review_sms_operation_in_progress'; END IF;
  RETURN o;
 END IF;
 IF EXISTS(SELECT 1 FROM review_sms_billing_operations WHERE account_id=a.id AND kind<>p_kind AND state IN ('confirmed','unknown')) THEN RAISE EXCEPTION 'review_sms_operation_in_progress'; END IF;
 IF p_kind='activation' AND (a.state NOT IN ('draft','activation_pending') OR a.billing_source<>'direct' OR a.activation_paid_at IS NOT NULL) THEN RAISE EXCEPTION 'review_sms_activation_unavailable'; END IF;
 IF p_kind='recurring' AND (a.state<>'ready_unpaid' OR a.ready_expires_at IS NULL OR a.ready_expires_at<=now() OR a.review_usecase_approved_at IS NULL OR a.billing_source<>'direct') THEN RAISE EXCEPTION 'review_sms_not_ready'; END IF;
 IF p_kind='cancel' AND a.state NOT IN ('active','cancel_pending') THEN RAISE EXCEPTION 'review_sms_cancel_unavailable'; END IF;
 IF p_kind='refund' AND (a.activation_paid_at IS NULL OR a.activation_refunded_at IS NOT NULL OR a.provider_started_at IS NOT NULL) THEN RAISE EXCEPTION 'review_sms_refund_unavailable'; END IF;
 INSERT INTO review_sms_billing_operations(account_id,business_id,owner_id,kind,fingerprint,payload)
  VALUES(a.id,p_business,p_owner,p_kind,p_fingerprint,p_payload) RETURNING * INTO o;
 RETURN o;
END $$;

CREATE FUNCTION public.review_sms_confirm_operation(p_operation uuid,p_owner uuid,p_fingerprint text)
RETURNS public.review_sms_billing_operations LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o review_sms_billing_operations; a review_sms_accounts;
BEGIN
 SELECT * INTO o FROM review_sms_billing_operations WHERE id=p_operation;
 IF NOT FOUND THEN RAISE EXCEPTION 'review_sms_operation_not_found'; END IF;
 PERFORM review_assert_owner(o.business_id,p_owner);
 SELECT * INTO a FROM review_sms_accounts WHERE id=o.account_id FOR UPDATE;
 IF NOT FOUND OR a.owner_id IS DISTINCT FROM p_owner THEN RAISE EXCEPTION 'review_sms_setup_required'; END IF;
 SELECT * INTO o FROM review_sms_billing_operations WHERE id=p_operation FOR UPDATE;
 IF o.owner_id IS DISTINCT FROM p_owner OR o.fingerprint IS DISTINCT FROM p_fingerprint THEN RAISE EXCEPTION 'review_sms_quote_changed'; END IF;
 IF o.state='prepared' AND o.expires_at<=now() THEN RAISE EXCEPTION 'review_sms_quote_expired'; END IF;
 IF o.state NOT IN ('prepared','confirmed') THEN RAISE EXCEPTION 'review_sms_operation_unresolved'; END IF;
 IF EXISTS(SELECT 1 FROM review_sms_billing_operations WHERE account_id=a.id AND id<>o.id AND state IN ('confirmed','unknown')) THEN RAISE EXCEPTION 'review_sms_operation_in_progress'; END IF;
 IF o.kind='activation' AND (a.state NOT IN ('draft','activation_pending') OR a.activation_paid_at IS NOT NULL OR a.activation_refunded_at IS NOT NULL) THEN RAISE EXCEPTION 'review_sms_activation_unavailable'; END IF;
 IF o.kind='recurring' AND (a.state<>'ready_unpaid' OR a.activation_refunded_at IS NOT NULL OR a.cancel_at IS NOT NULL OR a.review_usecase_approved_at IS NULL OR a.ready_expires_at IS NULL OR (o.state='prepared' AND a.ready_expires_at<=now())) THEN RAISE EXCEPTION 'review_sms_not_ready'; END IF;
 IF o.kind='cancel' AND a.state NOT IN ('active','cancel_pending') THEN RAISE EXCEPTION 'review_sms_cancel_unavailable'; END IF;
 IF o.kind='refund' AND (a.activation_paid_at IS NULL OR a.activation_refunded_at IS NOT NULL OR a.provider_started_at IS NOT NULL OR a.stripe_item_id IS NOT NULL) THEN RAISE EXCEPTION 'review_sms_refund_unavailable'; END IF;
 UPDATE review_sms_billing_operations SET state='confirmed',confirmed_at=coalesce(confirmed_at,now()) WHERE id=o.id RETURNING * INTO o;
 IF o.kind='activation' THEN UPDATE review_sms_accounts SET state='activation_pending',updated_at=now() WHERE id=o.account_id AND state='draft'; END IF;
 RETURN o;
END $$;

CREATE FUNCTION public.review_sms_begin_reconcile(p_business uuid,p_subscription text,p_customer text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r bigint;
BEGIN
 UPDATE review_sms_accounts SET billing_revision=billing_revision+1 WHERE business_id=p_business
  AND billing_source='direct' AND source_subscription_id=p_subscription AND source_customer_id=p_customer
  RETURNING billing_revision INTO r;
 RETURN r;
END $$;
CREATE FUNCTION public.review_sms_record_paid_period(p_business uuid,p_revision bigint,p_item text,p_price text,p_invoice text,p_start timestamptz,p_end timestamptz,p_allowance integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a review_sms_accounts;
BEGIN
 SELECT * INTO a FROM review_sms_accounts WHERE business_id=p_business FOR UPDATE;
 IF NOT FOUND OR a.billing_revision<>p_revision OR p_revision<=a.applied_revision THEN RETURN false; END IF;
 IF p_revision IS NULL OR p_allowance IS NULL OR p_start IS NULL OR p_end IS NULL OR p_start>now() OR p_item IS NULL OR p_invoice IS NULL OR p_price IS NULL OR p_start>=p_end OR p_end<=now() OR p_allowance NOT BETWEEN 0 AND 250
  OR a.state NOT IN ('ready_unpaid','active','cancel_pending') OR a.review_usecase_approved_at IS NULL THEN RAISE EXCEPTION 'review_sms_paid_period_invalid'; END IF;
 UPDATE review_sms_accounts SET state=CASE WHEN cancel_at IS NULL THEN 'active' ELSE 'cancel_pending' END,
  stripe_item_id=p_item,stripe_price_id=p_price,paid_invoice_id=p_invoice,paid_period_start=p_start,paid_period_end=p_end,
  period_allowance=p_allowance,applied_revision=p_revision,updated_at=now() WHERE id=a.id;
 UPDATE review_sms_billing_operations SET state='completed',invoice_id=p_invoice,completed_at=now()
  WHERE account_id=a.id AND kind='recurring' AND state='confirmed';
 RETURN true;
END $$;

-- A paid request authorizes provisioning only; it does not grant sending.
CREATE FUNCTION public.review_sms_claim_provisioning(p_business uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a review_sms_accounts; b businesses; token uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO b FROM businesses WHERE id=p_business FOR UPDATE;
 SELECT * INTO a FROM review_sms_accounts WHERE business_id=p_business FOR UPDATE;
 IF NOT FOUND OR a.state<>'carrier_pending' OR a.activation_paid_at IS NULL OR a.activation_refunded_at IS NOT NULL
  OR b.id IS NULL OR b.owner_id IS NULL OR b.owner_id IS DISTINCT FROM a.owner_id OR b.deleted_at IS NOT NULL OR b.operations_suspended_at IS NOT NULL
  OR b.telnyx_submission_disabled IS DISTINCT FROM false OR b.active_telnyx_release_run_id IS NOT NULL OR a.cancel_at IS NOT NULL OR coalesce(a.provisioning_lease_until>now(),false)
  OR coalesce((SELECT allowed FROM review_business_billing(p_business)),false) IS NOT TRUE THEN RETURN NULL; END IF;
 UPDATE review_sms_accounts SET provisioning_claim=token,provisioning_lease_until=now()+interval '10 minutes',
  updated_at=now() WHERE id=a.id;
 RETURN token;
END $$;

CREATE FUNCTION public.scrub_review_sms_after_owner_cleanup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.owner_id IS NOT NULL AND NEW.owner_id IS NULL THEN
  DELETE FROM review_sms_accounts WHERE business_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER scrub_review_sms_after_owner_cleanup AFTER UPDATE OF owner_id ON public.businesses
 FOR EACH ROW EXECUTE FUNCTION public.scrub_review_sms_after_owner_cleanup();

DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('has_review_sms_access','review_sms_allowance','review_sms_acquire_account','review_sms_acquire_operation','review_sms_confirm_operation','review_sms_begin_reconcile','review_sms_record_paid_period','review_sms_claim_provisioning','scrub_review_sms_after_owner_cleanup')
 LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature); END LOOP;
END $$;

-- Freeze the exact cancellation schedule update before contacting Stripe.
-- A lost create response reuses the same provider key; a lost update response
-- reuses these persisted parameters instead of rebuilding changed phases.
CREATE FUNCTION public.review_sms_freeze_cancel(p_operation uuid,p_owner uuid,p_schedule text,p_parameters jsonb)
RETURNS public.review_sms_billing_operations LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o review_sms_billing_operations;
BEGIN
 SELECT * INTO o FROM review_sms_billing_operations WHERE id=p_operation;
 IF NOT FOUND THEN RAISE EXCEPTION 'review_sms_operation_not_found'; END IF;
 PERFORM review_assert_owner(o.business_id,p_owner);
 PERFORM 1 FROM review_sms_accounts WHERE id=o.account_id AND owner_id=p_owner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'review_sms_setup_required'; END IF;
 SELECT * INTO o FROM review_sms_billing_operations WHERE id=p_operation FOR UPDATE;
 IF o.owner_id IS DISTINCT FROM p_owner OR o.kind<>'cancel' OR o.state<>'confirmed' OR nullif(p_schedule,'') IS NULL
  OR jsonb_typeof(p_parameters) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'review_sms_cancel_recovery_required'; END IF;
 IF o.schedule_id IS NOT NULL AND o.schedule_id<>p_schedule THEN RAISE EXCEPTION 'review_sms_cancel_recovery_required'; END IF;
 IF o.payload?'scheduleUpdate' THEN RETURN o; END IF;
 UPDATE review_sms_billing_operations SET schedule_id=p_schedule,payload=payload||jsonb_build_object('scheduleUpdate',p_parameters)
  WHERE id=o.id RETURNING * INTO o;
 RETURN o;
END $$;
REVOKE ALL ON FUNCTION public.review_sms_freeze_cancel(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.review_sms_freeze_cancel(uuid,uuid,text,jsonb) TO service_role;
