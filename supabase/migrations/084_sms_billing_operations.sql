BEGIN;

-- Durable provider identities survive abandoned Checkouts and subscription replacement.
CREATE TABLE public.sms_billing_accounts (
  business_id uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  stripe_customer_id text UNIQUE,
  setup_fee_paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.sms_billing_accounts(business_id,stripe_customer_id,setup_fee_paid_at)
SELECT business_id,stripe_customer_id,setup_fee_paid_at FROM public.subscriptions WHERE plan<>'chat_only';

CREATE TABLE public.sms_billing_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('checkout','upgrade','downgrade')),
  state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','confirming','pending','scheduled','applied','expired')),
  target_plan text NOT NULL CHECK(target_plan IN ('sms_only','sms_and_chat','full')),
  target_price_id text NOT NULL,
  expected_subscription_id text,
  expected_customer_id text,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_item_id text,
  checkout_session_id text UNIQUE,
  invoice_id text UNIQUE,
  schedule_id text UNIQUE,
  source_fingerprint text NOT NULL,
  source_plan text,
  source_period_start timestamptz,
  source_period_end timestamptz,
  previous_source_terminal_status text CHECK(previous_source_terminal_status IN ('canceled','incomplete_expired')),
  previous_source_terminal_verified_at timestamptz,
  previous_deletion_action jsonb,
  proration_at timestamptz,
  payment_effective_at timestamptz,
  payment_verified_at timestamptz,
  setup_fee_price_id text,
  quote jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  applied_at timestamptz,
  CHECK((payment_effective_at IS NULL)=(payment_verified_at IS NULL))
);
CREATE UNIQUE INDEX sms_billing_one_open_operation ON public.sms_billing_operations(business_id)
  WHERE state IN ('prepared','confirming','pending','scheduled');
CREATE INDEX sms_billing_operations_subscription ON public.sms_billing_operations(stripe_subscription_id);
ALTER TABLE public.sms_billing_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_billing_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sms_billing_accounts,public.sms_billing_operations FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.sms_billing_accounts,public.sms_billing_operations TO service_role;

CREATE FUNCTION public.acquire_sms_billing_operation(p_business_id uuid,p_owner_id uuid,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE b public.businesses; s public.subscriptions; a public.sms_billing_accounts; o public.sms_billing_operations;
  k text:=p_request->>'kind'; target text:=p_request->>'target_plan';
BEGIN
  SELECT * INTO b FROM public.businesses WHERE id=p_business_id FOR UPDATE;
  IF b.id IS NULL OR b.owner_id IS DISTINCT FROM p_owner_id OR b.deleted_at IS NOT NULL
    OR b.billing_mode<>'stripe' OR b.partner_id IS NOT NULL OR b.partner_plan IS NOT NULL
    OR b.operations_suspended_at IS NOT NULL THEN RAISE EXCEPTION 'sms_billing_forbidden' USING ERRCODE='42501'; END IF;
  IF k NOT IN ('checkout','upgrade','downgrade') OR target NOT IN ('sms_only','sms_and_chat','full')
    OR COALESCE(p_request->>'target_price_id','') !~ '^price_[A-Za-z0-9]+$'
    OR COALESCE(p_request->>'source_fingerprint','') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'sms_billing_invalid_request'; END IF;
  SELECT * INTO s FROM public.subscriptions WHERE business_id=p_business_id;
  IF s.plan='chat_only' OR s.stripe_subscription_id IS DISTINCT FROM (p_request->>'expected_subscription_id')
    OR s.stripe_customer_id IS DISTINCT FROM (p_request->>'expected_customer_id') THEN RAISE EXCEPTION 'sms_billing_source_changed'; END IF;
  IF (k='checkout' AND s.business_id IS NOT NULL AND s.status NOT IN ('canceled','incomplete_expired'))
    OR (k<>'checkout' AND (s.business_id IS NULL OR s.status<>'active' OR s.cancel_at_period_end
      OR s.current_period_end<=now() OR s.plan=target)) THEN RAISE EXCEPTION 'sms_billing_existing_subscription'; END IF;
  IF (k='upgrade' AND NOT ((target='full' AND s.plan IN ('sms_only','sms_and_chat')) OR (target='sms_and_chat' AND s.plan='sms_only')))
    OR (k='downgrade' AND NOT ((s.plan='full' AND target IN ('sms_only','sms_and_chat')) OR (s.plan='sms_and_chat' AND target='sms_only')))
    THEN RAISE EXCEPTION 'sms_billing_invalid_transition'; END IF;
  IF NOT public.claim_business_plan_family(p_business_id,'sms','sms_billing_operation') THEN RAISE EXCEPTION 'sms_billing_forbidden'; END IF;
  -- Only an unconfirmed quote can expire without a fresh provider observation.
  UPDATE public.sms_billing_operations SET state='expired' WHERE business_id=p_business_id
    AND state='prepared' AND kind<>'checkout' AND expires_at<=now();
  SELECT * INTO o FROM public.sms_billing_operations WHERE business_id=p_business_id AND state IN ('prepared','confirming','pending','scheduled');
  IF o.id IS NOT NULL THEN
    IF o.kind<>k OR o.target_plan<>target OR o.target_price_id<>p_request->>'target_price_id'
      OR o.source_fingerprint<>p_request->>'source_fingerprint' THEN RAISE EXCEPTION 'sms_billing_operation_in_progress'; END IF;
    RETURN to_jsonb(o);
  END IF;
  INSERT INTO public.sms_billing_accounts(business_id,stripe_customer_id,setup_fee_paid_at)
    VALUES(p_business_id,s.stripe_customer_id,s.setup_fee_paid_at) ON CONFLICT(business_id)
    DO UPDATE SET setup_fee_paid_at=COALESCE(sms_billing_accounts.setup_fee_paid_at,EXCLUDED.setup_fee_paid_at);
  SELECT * INTO a FROM public.sms_billing_accounts WHERE business_id=p_business_id FOR UPDATE;
  IF s.stripe_customer_id IS NOT NULL AND a.stripe_customer_id IS DISTINCT FROM s.stripe_customer_id THEN RAISE EXCEPTION 'sms_billing_customer_changed'; END IF;
  INSERT INTO public.sms_billing_operations(business_id,owner_id,kind,target_plan,target_price_id,expected_subscription_id,expected_customer_id,
    stripe_customer_id,stripe_item_id,source_fingerprint,source_plan,source_period_start,source_period_end,previous_source_terminal_status,previous_source_terminal_verified_at,
    proration_at,setup_fee_price_id,quote,expires_at)
  VALUES(p_business_id,p_owner_id,k,target,p_request->>'target_price_id',s.stripe_subscription_id,s.stripe_customer_id,a.stripe_customer_id,
    p_request->>'stripe_item_id',p_request->>'source_fingerprint',s.plan,s.current_period_start,s.current_period_end,
    CASE WHEN k='checkout' THEN p_request->>'previous_source_terminal_status' END,
    CASE WHEN k='checkout' THEN (p_request->>'previous_source_terminal_verified_at')::timestamptz END,
    (p_request->>'proration_at')::timestamptz,CASE WHEN k='checkout' AND a.setup_fee_paid_at IS NULL THEN p_request->>'setup_fee_price_id' END,
    COALESCE(p_request->'quote','{}'::jsonb),date_trunc('second',now())+CASE WHEN k='checkout' THEN interval '23 hours' ELSE interval '10 minutes' END)
  RETURNING * INTO o;
  RETURN to_jsonb(o);
END $$;

CREATE FUNCTION public.confirm_sms_billing_operation(p_operation_id uuid,p_owner_id uuid,p_source_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.sms_billing_operations; s public.subscriptions; bid uuid;
BEGIN
  SELECT business_id INTO bid FROM public.sms_billing_operations WHERE id=p_operation_id;
  PERFORM 1 FROM public.businesses WHERE id=bid AND owner_id=p_owner_id AND deleted_at IS NULL AND billing_mode='stripe'
    AND partner_id IS NULL AND partner_plan IS NULL AND operations_suspended_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'sms_billing_forbidden' USING ERRCODE='42501'; END IF;
  SELECT * INTO o FROM public.sms_billing_operations WHERE id=p_operation_id FOR UPDATE;
  IF o.owner_id<>p_owner_id OR o.source_fingerprint<>p_source_fingerprint THEN RAISE EXCEPTION 'sms_billing_source_changed'; END IF;
  IF o.state<>'prepared' THEN RETURN to_jsonb(o); END IF;
  IF o.expires_at<=now() THEN RAISE EXCEPTION 'sms_billing_quote_expired'; END IF;
  SELECT * INTO s FROM public.subscriptions WHERE business_id=bid;
  IF s.stripe_subscription_id IS DISTINCT FROM o.expected_subscription_id OR s.stripe_customer_id IS DISTINCT FROM o.expected_customer_id
    OR s.plan IS DISTINCT FROM o.source_plan OR s.current_period_start IS DISTINCT FROM o.source_period_start
    OR s.current_period_end IS DISTINCT FROM o.source_period_end
    OR (o.kind='checkout' AND s.business_id IS NOT NULL AND s.status NOT IN ('canceled','incomplete_expired'))
    OR (o.kind<>'checkout' AND (s.status IS DISTINCT FROM 'active' OR s.cancel_at_period_end)) THEN RAISE EXCEPTION 'sms_billing_source_changed'; END IF;
  UPDATE public.sms_billing_operations SET state='confirming',confirmed_at=clock_timestamp() WHERE id=o.id RETURNING * INTO o;
  RETURN to_jsonb(o);
END $$;

-- This service-only recorder never changes the authorized plan or source. A timeout
-- keeps the operation live; only verified provider expiration releases it.
CREATE FUNCTION public.record_sms_billing_operation(p_operation_id uuid,p_details jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.sms_billing_operations; bid uuid; cid text:=p_details->>'stripe_customer_id'; nextstate text:=p_details->>'state';
BEGIN
  SELECT business_id INTO bid FROM public.sms_billing_operations WHERE id=p_operation_id;
  PERFORM 1 FROM public.businesses WHERE id=bid AND deleted_at IS NULL AND owner_id IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'sms_billing_forbidden' USING ERRCODE='42501'; END IF;
  SELECT * INTO o FROM public.sms_billing_operations WHERE id=p_operation_id FOR UPDATE;
  IF o.state IN ('applied','expired') THEN RETURN to_jsonb(o); END IF;
  IF (cid IS NOT NULL AND (cid !~ '^cus_[A-Za-z0-9]+$' OR (o.stripe_customer_id IS NOT NULL AND cid<>o.stripe_customer_id)))
    OR (o.checkout_session_id IS NOT NULL AND p_details ? 'checkout_session_id' AND o.checkout_session_id IS DISTINCT FROM p_details->>'checkout_session_id')
    OR (o.stripe_subscription_id IS NOT NULL AND p_details ? 'stripe_subscription_id' AND o.stripe_subscription_id IS DISTINCT FROM p_details->>'stripe_subscription_id')
    OR (o.invoice_id IS NOT NULL AND p_details ? 'invoice_id' AND o.invoice_id IS DISTINCT FROM p_details->>'invoice_id')
    OR (o.schedule_id IS NOT NULL AND p_details ? 'schedule_id' AND o.schedule_id IS DISTINCT FROM p_details->>'schedule_id')
    THEN RAISE EXCEPTION 'sms_billing_provider_identity_changed'; END IF;
  IF nextstate IS NOT NULL AND nextstate NOT IN ('pending','scheduled','expired') THEN RAISE EXCEPTION 'sms_billing_invalid_state'; END IF;
  IF cid IS NOT NULL THEN
    UPDATE public.sms_billing_accounts SET stripe_customer_id=cid WHERE business_id=bid AND (stripe_customer_id IS NULL OR stripe_customer_id=cid);
    IF NOT FOUND THEN RAISE EXCEPTION 'sms_billing_customer_changed'; END IF;
  END IF;
  UPDATE public.sms_billing_operations SET stripe_customer_id=COALESCE(cid,stripe_customer_id),
    checkout_session_id=COALESCE(p_details->>'checkout_session_id',checkout_session_id),
    stripe_subscription_id=COALESCE(p_details->>'stripe_subscription_id',stripe_subscription_id),
    invoice_id=COALESCE(p_details->>'invoice_id',invoice_id),schedule_id=COALESCE(p_details->>'schedule_id',schedule_id),
    state=COALESCE(nextstate,state) WHERE id=o.id RETURNING * INTO o;
  RETURN to_jsonb(o);
END $$;

-- Migration 085 replaces this transactional extension point. Fail closed until
-- commercial enrollment is installed; unrelated lower tiers remain deployable.
CREATE FUNCTION public.apply_paid_sms_voice_entitlement(p_business_id uuid,p_operation_id uuid,p_prior_plan text,
  p_prior_subscription_id text,p_prior_period_start timestamptz,p_prior_period_end timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.sms_billing_operations WHERE id=p_operation_id AND target_plan='full') THEN
    RAISE EXCEPTION 'voice_enrollment_migration_required';
  END IF;
END $$;

CREATE FUNCTION public.finalize_paid_sms_billing_operation(p_operation_id uuid,p_snapshot jsonb,p_payment jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.sms_billing_operations; s public.subscriptions; bid uuid; sid text:=p_snapshot->>'subscription_id';
  cid text:=p_snapshot->>'customer_id'; paid_at timestamptz:=(p_payment->>'paid_at')::timestamptz; changed boolean;
BEGIN
  SELECT business_id INTO bid FROM public.sms_billing_operations WHERE id=p_operation_id;
  PERFORM 1 FROM public.businesses WHERE id=bid AND deleted_at IS NULL AND owner_id IS NOT NULL AND billing_mode='stripe'
    AND partner_id IS NULL AND partner_plan IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO o FROM public.sms_billing_operations WHERE id=p_operation_id FOR UPDATE;
  SELECT * INTO s FROM public.subscriptions WHERE business_id=bid;
  IF o.state='applied' THEN
    IF sid IS DISTINCT FROM o.stripe_subscription_id OR cid IS DISTINCT FROM o.stripe_customer_id
      OR p_payment->>'invoice_id' IS DISTINCT FROM o.invoice_id OR paid_at IS DISTINCT FROM o.payment_effective_at THEN
      RAISE EXCEPTION 'sms_billing_provider_identity_changed'; END IF;
    RETURN s.stripe_subscription_id=sid AND s.stripe_customer_id=cid;
  END IF;
  IF o.state NOT IN ('confirming','pending') OR o.kind NOT IN ('checkout','upgrade') OR o.confirmed_at IS NULL
    OR sid IS NULL OR cid IS DISTINCT FROM o.stripe_customer_id OR p_snapshot->>'plan' IS DISTINCT FROM o.target_plan
    OR p_snapshot->>'price_id' IS DISTINCT FROM o.target_price_id OR p_snapshot->>'status' IS DISTINCT FROM 'active'
    OR (o.stripe_subscription_id IS NOT NULL AND sid<>o.stripe_subscription_id)
    OR (o.kind='upgrade' AND sid IS DISTINCT FROM o.expected_subscription_id)
    OR s.stripe_subscription_id IS DISTINCT FROM o.expected_subscription_id OR s.stripe_customer_id IS DISTINCT FROM o.expected_customer_id
    OR s.plan IS DISTINCT FROM o.source_plan OR s.current_period_start IS DISTINCT FROM o.source_period_start
    OR s.current_period_end IS DISTINCT FROM o.source_period_end
    OR (o.kind='checkout' AND s.business_id IS NOT NULL AND s.status NOT IN ('canceled','incomplete_expired'))
    THEN RAISE EXCEPTION 'sms_billing_source_changed'; END IF;
  IF p_payment->>'status' IS DISTINCT FROM 'paid' OR COALESCE(p_payment->>'invoice_id','') !~ '^in_[A-Za-z0-9]+$'
    OR p_payment->>'subscription_id' IS DISTINCT FROM sid OR p_payment->>'customer_id' IS DISTINCT FROM cid
    OR (o.invoice_id IS NOT NULL AND o.invoice_id IS DISTINCT FROM p_payment->>'invoice_id')
    OR paid_at IS NULL OR paid_at<o.confirmed_at-interval '1 minute' OR paid_at>clock_timestamp()+interval '1 minute'
    OR (p_snapshot->>'period_start')::timestamptz IS NULL OR (p_snapshot->>'period_end')::timestamptz<=paid_at
    THEN RAISE EXCEPTION 'sms_billing_payment_unverified'; END IF;
  IF o.kind='upgrade' AND ((p_snapshot->>'period_start')::timestamptz IS DISTINCT FROM o.source_period_start
    OR (p_snapshot->>'period_end')::timestamptz IS DISTINCT FROM o.source_period_end) THEN RAISE EXCEPTION 'sms_billing_period_changed'; END IF;
  IF o.kind='checkout' AND o.expected_subscription_id IS NOT NULL AND (sid=o.expected_subscription_id
    OR o.previous_source_terminal_status IS NULL OR o.previous_source_terminal_verified_at IS NULL
    OR o.previous_source_terminal_verified_at<o.created_at-interval '5 minutes'
    OR o.previous_source_terminal_verified_at>o.created_at+interval '1 minute') THEN RAISE EXCEPTION 'sms_billing_previous_source_unverified'; END IF;
  UPDATE public.sms_billing_operations SET stripe_subscription_id=sid,invoice_id=p_payment->>'invoice_id',
    payment_effective_at=paid_at,payment_verified_at=clock_timestamp() WHERE id=o.id;
  changed:=public.sync_stripe_subscription_if_business_active(bid,cid,sid,o.target_plan,'active',
    (p_snapshot->>'period_start')::timestamptz,(p_snapshot->>'period_end')::timestamptz,o.target_price_id,o.setup_fee_price_id,
    o.checkout_session_id,CASE WHEN o.setup_fee_price_id IS NOT NULL THEN paid_at END,
    COALESCE((p_snapshot->>'cancel_at_period_end')::boolean,false),clock_timestamp());
  IF NOT changed THEN RAISE EXCEPTION 'sms_billing_source_changed'; END IF;
  UPDATE public.sms_billing_accounts SET setup_fee_paid_at=COALESCE(setup_fee_paid_at,CASE WHEN o.setup_fee_price_id IS NOT NULL THEN paid_at END)
    WHERE business_id=bid;
  IF o.kind='checkout' AND o.expected_subscription_id IS NOT NULL THEN
    UPDATE public.sms_billing_operations SET previous_deletion_action=(SELECT jsonb_build_object('subscription_id',a.stripe_subscription_id,
      'desired_action',a.desired_action,'applied_action',a.applied_action,'status',a.status,'generation',a.generation,'applied_at',a.applied_at)
      FROM public.account_deletion_stripe_actions a WHERE a.business_id=bid AND a.stripe_subscription_id=o.expected_subscription_id) WHERE id=o.id;
    -- The old source is irreversibly terminal, proven before this paid rejoin.
    -- Preserve its non-PII authority above so the single-row outbox can later
    -- target the new source; a stale old worker cannot target the replacement.
    DELETE FROM public.account_deletion_stripe_actions WHERE business_id=bid AND stripe_subscription_id=o.expected_subscription_id;
  END IF;
  UPDATE public.sms_billing_operations SET state='applied',stripe_subscription_id=sid,invoice_id=p_payment->>'invoice_id',
    payment_effective_at=paid_at,payment_verified_at=clock_timestamp(),applied_at=clock_timestamp() WHERE id=o.id;
  PERFORM public.apply_paid_sms_voice_entitlement(bid,o.id,s.plan,s.stripe_subscription_id,s.current_period_start,s.current_period_end);
  IF o.kind='upgrade' THEN
    UPDATE public.billing_usage_periods SET plan=o.target_plan,
      included_sms_parts=GREATEST(included_sms_parts,CASE o.target_plan WHEN 'full' THEN 2500 WHEN 'sms_and_chat' THEN 1500 ELSE 500 END),updated_at=clock_timestamp()
      WHERE business_id=bid AND period_start=s.current_period_start;
  END IF;
  RETURN true;
END $$;

ALTER FUNCTION public.sync_stripe_subscription_if_business_active(uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,timestamptz,boolean,timestamptz)
 RENAME TO sync_stripe_subscription_before_sms_operations;
REVOKE ALL ON FUNCTION public.sync_stripe_subscription_before_sms_operations(uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,timestamptz,boolean,timestamptz)
 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.sync_stripe_subscription_if_business_active(p_business_id uuid,p_stripe_customer_id text,p_stripe_subscription_id text,
 p_plan text,p_status text,p_current_period_start timestamptz,p_current_period_end timestamptz,p_stripe_price_id text,p_stripe_setup_fee_price_id text,
 p_stripe_checkout_session_id text,p_setup_fee_paid_at timestamptz,p_cancel_at_period_end boolean,p_updated_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.subscriptions;
BEGIN
 PERFORM 1 FROM public.businesses WHERE id=p_business_id AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE business_id=p_business_id;
 IF EXISTS(SELECT 1 FROM public.sms_billing_accounts WHERE business_id=p_business_id)
   AND (s.stripe_subscription_id IS DISTINCT FROM p_stripe_subscription_id OR s.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id)
   AND NOT EXISTS(SELECT 1 FROM public.sms_billing_operations o WHERE o.business_id=p_business_id AND o.state IN ('confirming','pending')
      AND o.kind='checkout' AND o.payment_verified_at IS NOT NULL AND o.stripe_subscription_id=p_stripe_subscription_id
      AND o.stripe_customer_id=p_stripe_customer_id AND o.target_plan=p_plan AND o.target_price_id=p_stripe_price_id
      AND o.expected_subscription_id IS NOT DISTINCT FROM s.stripe_subscription_id
      AND o.expected_customer_id IS NOT DISTINCT FROM s.stripe_customer_id) THEN RETURN false; END IF;
 RETURN public.sync_stripe_subscription_before_sms_operations(p_business_id,p_stripe_customer_id,p_stripe_subscription_id,p_plan,p_status,
   p_current_period_start,p_current_period_end,p_stripe_price_id,p_stripe_setup_fee_price_id,p_stripe_checkout_session_id,p_setup_fee_paid_at,p_cancel_at_period_end,p_updated_at);
END $$;
REVOKE ALL ON FUNCTION public.sync_stripe_subscription_if_business_active(uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,timestamptz,boolean,timestamptz)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sync_stripe_subscription_if_business_active(uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,timestamptz,boolean,timestamptz) TO service_role;

CREATE FUNCTION public.freeze_applied_sms_billing_operation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF OLD.state='applied' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'sms_billing_applied_operation_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER freeze_applied_sms_billing_operation BEFORE UPDATE ON public.sms_billing_operations
 FOR EACH ROW EXECUTE FUNCTION public.freeze_applied_sms_billing_operation();
REVOKE ALL ON FUNCTION public.freeze_applied_sms_billing_operation() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.complete_sms_billing_downgrade(p_operation_id uuid,p_subscription_id text,p_period_start timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.sms_billing_operations; bid uuid;
BEGIN
  SELECT business_id INTO bid FROM public.sms_billing_operations WHERE id=p_operation_id;
  PERFORM 1 FROM public.businesses WHERE id=bid AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO o FROM public.sms_billing_operations WHERE id=p_operation_id FOR UPDATE;
  IF o.kind<>'downgrade' OR o.state NOT IN ('scheduled','applied') OR p_subscription_id IS DISTINCT FROM o.expected_subscription_id
    OR p_period_start<o.source_period_end OR NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE business_id=bid
      AND stripe_subscription_id=p_subscription_id AND plan=o.target_plan AND current_period_start=p_period_start) THEN RETURN false; END IF;
  UPDATE public.sms_billing_operations SET state='applied',applied_at=COALESCE(applied_at,clock_timestamp()) WHERE id=o.id;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.acquire_sms_billing_operation(uuid,uuid,jsonb),public.confirm_sms_billing_operation(uuid,uuid,text),
 public.record_sms_billing_operation(uuid,jsonb),public.finalize_paid_sms_billing_operation(uuid,jsonb,jsonb),
 public.apply_paid_sms_voice_entitlement(uuid,uuid,text,text,timestamptz,timestamptz),public.complete_sms_billing_downgrade(uuid,text,timestamptz)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_sms_billing_operation(uuid,uuid,jsonb),public.confirm_sms_billing_operation(uuid,uuid,text),
 public.record_sms_billing_operation(uuid,jsonb),public.finalize_paid_sms_billing_operation(uuid,jsonb,jsonb),
 public.apply_paid_sms_voice_entitlement(uuid,uuid,text,text,timestamptz,timestamptz),public.complete_sms_billing_downgrade(uuid,text,timestamptz)
 TO service_role;

-- A payable/unknown provider operation must be resolved before ownership or
-- deletion can discard its authority, matching the existing Chat Checkout rule.
CREATE FUNCTION public.guard_sms_billing_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF (NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    OR NEW.billing_mode IS DISTINCT FROM OLD.billing_mode OR NEW.partner_id IS DISTINCT FROM OLD.partner_id
    OR NEW.partner_plan IS DISTINCT FROM OLD.partner_plan)
    AND EXISTS(SELECT 1 FROM public.sms_billing_operations WHERE business_id=OLD.id AND state IN ('confirming','pending','scheduled')) THEN
    RAISE EXCEPTION 'sms_billing_authority_locked' USING ERRCODE='55000'; END IF;
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    OR NEW.billing_mode IS DISTINCT FROM OLD.billing_mode OR NEW.partner_id IS DISTINCT FROM OLD.partner_id
    OR NEW.partner_plan IS DISTINCT FROM OLD.partner_plan THEN
    UPDATE public.sms_billing_operations SET state='expired' WHERE business_id=OLD.id AND state='prepared';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_sms_billing_authority BEFORE UPDATE OF owner_id,deleted_at,billing_mode,partner_id,partner_plan ON public.businesses
 FOR EACH ROW EXECUTE FUNCTION public.guard_sms_billing_authority();
CREATE FUNCTION public.sms_billing_cleanup_ready(p_business_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.sms_billing_operations WHERE business_id=p_business_id) OR (
  EXISTS(SELECT 1 FROM public.businesses b WHERE b.id=p_business_id AND b.deleted_at IS NOT NULL
   AND b.deletion_scheduled_for<now() AND b.owner_id IS NULL AND b.cleanup_pii_scrubbed_at IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM public.sms_billing_operations WHERE business_id=p_business_id AND state IN ('confirming','pending','scheduled'))
  AND NOT EXISTS(SELECT 1 FROM public.sms_billing_operations o WHERE o.business_id=p_business_id AND o.stripe_subscription_id IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM public.account_deletion_stripe_actions a WHERE a.business_id=p_business_id
    AND a.stripe_subscription_id=o.stripe_subscription_id AND a.desired_action='cancel'
    AND a.status='applied' AND a.applied_action='cancel' AND a.applied_at IS NOT NULL)
   AND NOT EXISTS(SELECT 1 FROM public.sms_billing_operations replacement WHERE replacement.business_id=p_business_id AND replacement.kind='checkout'
    AND replacement.state='applied' AND replacement.expected_subscription_id=o.stripe_subscription_id
    AND replacement.expected_customer_id=o.stripe_customer_id AND replacement.previous_source_terminal_verified_at IS NOT NULL
    AND replacement.previous_source_terminal_status IN ('canceled','incomplete_expired'))))
$$;
CREATE FUNCTION public.purge_sms_billing_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.sms_billing_operations WHERE business_id=OLD.id) THEN RETURN OLD; END IF;
 -- cleanup_expired_business first queues cancel and scrubs PII atomically.
 -- Retain authority through that stage; only final, proven cleanup may purge it.
 IF NOT public.sms_billing_cleanup_ready(OLD.id) THEN
   RAISE EXCEPTION 'sms_billing_retention_unresolved' USING ERRCODE='55000'; END IF;
 DELETE FROM public.sms_billing_operations WHERE business_id=OLD.id;
 DELETE FROM public.sms_billing_accounts WHERE business_id=OLD.id;
 RETURN OLD;
END $$;
CREATE TRIGGER guard_sms_billing_delete BEFORE DELETE ON public.businesses FOR EACH ROW EXECUTE FUNCTION public.purge_sms_billing_authority();
REVOKE ALL ON FUNCTION public.guard_sms_billing_authority(),public.purge_sms_billing_authority() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.sms_billing_cleanup_ready(uuid) FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION public.complete_expired_business_cleanup(uuid,bigint) RENAME TO complete_expired_business_cleanup_before_sms_operations;
REVOKE ALL ON FUNCTION public.complete_expired_business_cleanup_before_sms_operations(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.complete_expired_business_cleanup(p_business_id uuid,p_generation bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE completed boolean;
BEGIN
 PERFORM 1 FROM public.businesses WHERE id=p_business_id FOR UPDATE;
 IF NOT public.sms_billing_cleanup_ready(p_business_id) THEN RAISE EXCEPTION 'sms_billing_retention_unresolved' USING ERRCODE='55000'; END IF;
 -- Keep the existing Telnyx, reactivation, cancellation generation and cleanup
 -- checks. A failure rolls back; a false result never discards retained billing.
 completed:=public.complete_expired_business_cleanup_before_sms_operations(p_business_id,p_generation);
 IF completed THEN
   DELETE FROM public.sms_billing_operations WHERE business_id=p_business_id;
   DELETE FROM public.sms_billing_accounts WHERE business_id=p_business_id;
 END IF;
 RETURN completed;
END $$;
REVOKE ALL ON FUNCTION public.complete_expired_business_cleanup(uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_expired_business_cleanup(uuid,bigint) TO service_role;
COMMIT;
