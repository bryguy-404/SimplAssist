BEGIN;

-- These are immutable historical receipt references, not ownership cascades.
-- Existing privacy cleanup removes review accounts before the paid SMS ledger
-- may be purged. Every active authorization below still requires exact joins.
ALTER TABLE public.chat_texting_upgrades
 DROP CONSTRAINT chat_texting_upgrades_source_review_account_id_fkey,
 DROP CONSTRAINT chat_texting_upgrades_original_activation_operation_id_fkey;

-- Read-only discovery and the locked writer share the same source authority.
CREATE FUNCTION public.read_review_texting_upgrade_source(p_business_id uuid,p_owner_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('accountId',a.id,'itemId',a.stripe_item_id,'activationOperationId',activation.id,
  'eligible',coalesce(
   b.owner_id=p_owner_id AND a.owner_id=p_owner_id AND b.deleted_at IS NULL AND b.deletion_scheduled_for IS NULL
   AND b.operations_suspended_at IS NULL AND b.billing_mode='stripe' AND b.partner_id IS NULL AND b.partner_plan IS NULL
   AND NOT b.billing_pilot AND NOT b.billing_comped AND NOT b.billing_exempt AND b.onboarding_completed_at IS NOT NULL
   AND a.state='active' AND a.exclusive_resources AND a.activation_paid_at IS NOT NULL AND a.activation_refunded_at IS NULL
   AND a.activation_payment_intent_id IS NOT NULL AND activation.id IS NOT NULL AND a.cancel_at IS NULL AND a.release_at IS NULL
   AND a.stripe_schedule_id IS NULL AND a.stripe_item_id IS NOT NULL AND a.paid_invoice_id IS NOT NULL
   AND a.paid_period_start<=now() AND a.paid_period_end>now() AND a.review_usecase_approved_at IS NOT NULL
   AND s.plan='chat_only' AND s.status='active' AND NOT s.cancel_at_period_end AND s.pending_plan IS NULL
   AND s.current_period_start<=now() AND s.current_period_end>now()
   AND s.stripe_subscription_id=a.source_subscription_id AND s.stripe_customer_id=a.source_customer_id
   AND b.active_telnyx_release_run_id IS NULL AND NOT b.telnyx_submission_disabled
   AND b.telnyx_unique_claims_released_at IS NULL AND b.telnyx_resource_state='active'
   AND public.review_sms_owns_plan_family_resources(b.id)
   AND EXISTS(SELECT 1 FROM public.chat_only_checkout_attempts c WHERE c.business_id=b.id AND c.state='completed'
    AND c.stripe_subscription_id=s.stripe_subscription_id AND c.stripe_customer_id=s.stripe_customer_id)
   AND NOT EXISTS(SELECT 1 FROM public.chat_only_checkout_attempts c WHERE c.business_id=b.id AND c.state IN ('creating','open'))
   AND NOT EXISTS(SELECT 1 FROM public.billing_usage_periods p WHERE p.business_id=b.id AND p.plan<>'chat_only')
   AND NOT EXISTS(SELECT 1 FROM public.review_sms_billing_operations r WHERE r.account_id=a.id AND r.state IN ('prepared','confirmed','unknown'))
   AND NOT EXISTS(SELECT 1 FROM public.review_sms_release_actions r WHERE r.account_id=a.id AND r.state<>'completed')
   AND NOT EXISTS(SELECT 1 FROM public.sms_billing_operations o WHERE o.business_id=b.id AND o.state IN ('prepared','confirming','pending','scheduled')
    AND NOT EXISTS(SELECT 1 FROM public.chat_texting_upgrades u WHERE u.business_id=b.id AND u.source_mode='review_sms'
     AND u.source_review_account_id=a.id AND u.state IN ('draft','payment_pending') AND u.billing_operation_id=o.id)),false))
 FROM public.review_sms_accounts a JOIN public.businesses b ON b.id=a.business_id
 JOIN public.subscriptions s ON s.business_id=b.id
 LEFT JOIN LATERAL (SELECT o.id FROM public.review_sms_billing_operations o WHERE o.account_id=a.id AND o.business_id=b.id
  AND o.owner_id=a.owner_id AND o.kind='activation' AND o.state='completed' AND o.checkout_session_id IS NOT NULL AND o.completed_at IS NOT NULL
  AND o.payload->>'customerId'=a.source_customer_id AND o.payload->>'subscriptionId'=a.source_subscription_id
  AND o.payload->>'amountCents' IN ('2500','4900') AND o.payload->>'feeId' ~ '^price_[A-Za-z0-9]+$'
  ORDER BY o.created_at LIMIT 1) activation ON true
 WHERE b.id=p_business_id AND b.owner_id=p_owner_id AND a.billing_source='direct' AND a.stripe_item_id IS NOT NULL
$$;

CREATE FUNCTION public.review_texting_upgrade_source_valid(p_upgrade_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce((SELECT (v->>'eligible')::boolean
  AND v->>'accountId'=u.source_review_account_id::text AND v->>'itemId'=u.source_review_item_id
  AND v->>'activationOperationId'=u.original_activation_operation_id::text
  FROM public.chat_texting_upgrades u
  CROSS JOIN LATERAL public.read_review_texting_upgrade_source(u.business_id,u.owner_id) v
  WHERE u.id=p_upgrade_id AND u.source_mode='review_sms' AND u.target_plan='sms_and_chat'),false)
$$;

ALTER FUNCTION public.save_chat_texting_upgrade(uuid,uuid,text,boolean) RENAME TO save_chat_texting_upgrade_before_review_sms;
CREATE FUNCTION public.save_chat_texting_upgrade(p_business_id uuid,p_owner_id uuid,p_target_plan text,p_starter_acknowledged boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u public.chat_texting_upgrades; s public.subscriptions; source jsonb;
BEGIN
 PERFORM 1 FROM public.businesses WHERE id=p_business_id AND owner_id=p_owner_id AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'texting_upgrade_forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO u FROM public.chat_texting_upgrades WHERE business_id=p_business_id AND state<>'abandoned' FOR UPDATE;
 IF u.id IS NOT NULL AND u.source_mode='review_sms' AND u.state<>'draft' THEN
  IF p_target_plan=u.target_plan THEN RETURN to_jsonb(u); END IF;
  RAISE EXCEPTION 'texting_upgrade_locked';
 END IF;
 source:=public.read_review_texting_upgrade_source(p_business_id,p_owner_id);
 IF source IS NULL AND coalesce(u.source_mode,'new_sms')='new_sms' THEN
  RETURN public.save_chat_texting_upgrade_before_review_sms(p_business_id,p_owner_id,p_target_plan,p_starter_acknowledged);
 END IF;
 IF p_target_plan IS DISTINCT FROM 'sms_and_chat' THEN RAISE EXCEPTION 'texting_upgrade_invalid_plan'; END IF;
 IF coalesce((source->>'eligible')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'texting_upgrade_source_changed'; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE business_id=p_business_id;
 IF u.id IS NOT NULL THEN
  IF u.source_mode<>'review_sms' OR NOT public.review_texting_upgrade_source_valid(u.id) THEN RAISE EXCEPTION 'texting_upgrade_source_changed'; END IF;
 ELSE
  -- An abandoned unpaid conversion may already have completed the carrier
  -- handoff. Reuse that exact proof; do not buy another campaign or move again.
  SELECT * INTO u FROM public.chat_texting_upgrades old WHERE old.business_id=p_business_id AND old.state='abandoned'
   AND old.source_mode='review_sms' AND old.paid_at IS NULL AND public.review_texting_upgrade_provider_ready(old.id)
   AND public.review_texting_upgrade_source_valid(old.id)
   AND (old.billing_operation_id IS NULL OR EXISTS(SELECT 1 FROM public.sms_billing_operations op WHERE op.id=old.billing_operation_id AND op.state='expired'))
   ORDER BY old.created_at DESC LIMIT 1 FOR UPDATE;
  IF u.id IS NOT NULL THEN
   UPDATE public.chat_texting_upgrades SET state='draft',support_reason=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE id=u.id RETURNING * INTO u;
   RETURN to_jsonb(u);
  END IF;
  INSERT INTO public.chat_texting_upgrades(business_id,owner_id,source_subscription_id,source_customer_id,target_plan,
   source_mode,source_review_account_id,source_review_item_id,original_activation_operation_id)
  VALUES(p_business_id,p_owner_id,s.stripe_subscription_id,s.stripe_customer_id,'sms_and_chat','review_sms',
   (source->>'accountId')::uuid,source->>'itemId',(source->>'activationOperationId')::uuid) RETURNING * INTO u;
 END IF;
 RETURN to_jsonb(u);
END $$;

-- Frozen facts exclude mutable reconciliation counters but include paid source,
-- exact provider bindings and the immutable original setup payment reference.
CREATE FUNCTION public.review_texting_upgrade_billing_fingerprint(p_upgrade_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT md5(jsonb_build_array(u.id,u.source_subscription_id,u.source_customer_id,u.source_review_account_id,u.source_review_item_id,
  u.original_activation_operation_id,a.billing_source,a.state,a.stripe_price_id,a.stripe_schedule_id,a.cancel_at,a.release_at,
  a.paid_invoice_id,a.paid_period_start,a.paid_period_end,a.period_allowance,a.activation_paid_at,a.activation_refunded_at,
  a.brand_id,a.campaign_id,a.messaging_profile_id,a.phone_number_id,a.review_usecase_approved_at,a.approval_evidence,
  public.review_texting_upgrade_provider_ready(u.id),
  (SELECT jsonb_build_array(p.filing_hash,p.handoff_token,p.handoff_completed_at,p.approval_evidence)
    FROM public.review_texting_provider_upgrades p WHERE p.upgrade_id=u.id))::text)
 FROM public.chat_texting_upgrades u JOIN public.review_sms_accounts a ON a.id=u.source_review_account_id WHERE u.id=p_upgrade_id
$$;

ALTER FUNCTION public.read_chat_texting_upgrade_setup(uuid,uuid) RENAME TO read_chat_texting_upgrade_setup_before_review_sms;
CREATE FUNCTION public.read_chat_texting_upgrade_setup(p_upgrade_id uuid,p_owner_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT CASE WHEN u.source_mode='review_sms' THEN CASE WHEN u.owner_id=p_owner_id AND u.state='draft'
  AND public.review_texting_upgrade_source_valid(u.id) AND public.review_texting_upgrade_provider_ready(u.id)
  THEN jsonb_build_object('setupFingerprint',public.review_texting_upgrade_billing_fingerprint(u.id),'revision',u.revision) END
  ELSE public.read_chat_texting_upgrade_setup_before_review_sms(p_upgrade_id,p_owner_id) END
 FROM public.chat_texting_upgrades u WHERE u.id=p_upgrade_id
$$;

ALTER FUNCTION public.acquire_chat_texting_upgrade_quote(uuid,uuid,jsonb) RENAME TO acquire_chat_texting_upgrade_quote_before_review_sms;
CREATE FUNCTION public.acquire_chat_texting_upgrade_quote(p_upgrade_id uuid,p_owner_id uuid,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u public.chat_texting_upgrades; s public.subscriptions; a public.review_sms_accounts; o public.sms_billing_operations;
BEGIN
 u:=public.chat_texting_upgrade_source(p_upgrade_id,p_owner_id);
 IF u.source_mode<>'review_sms' THEN RETURN public.acquire_chat_texting_upgrade_quote_before_review_sms(p_upgrade_id,p_owner_id,p_request); END IF;
 IF u.state<>'draft' OR NOT public.review_texting_upgrade_source_valid(u.id) OR NOT public.review_texting_upgrade_provider_ready(u.id)
  THEN RAISE EXCEPTION 'texting_upgrade_incomplete'; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE business_id=u.business_id;
 SELECT * INTO a FROM public.review_sms_accounts WHERE id=u.source_review_account_id FOR UPDATE;
 IF p_request->>'expected_setup_fingerprint' IS DISTINCT FROM public.review_texting_upgrade_billing_fingerprint(u.id)
  OR p_request->>'expected_subscription_id' IS DISTINCT FROM u.source_subscription_id
  OR p_request->>'expected_customer_id' IS DISTINCT FROM u.source_customer_id
  OR p_request->>'target_plan' IS DISTINCT FROM 'sms_and_chat' OR p_request->>'setup_fee_price_id' IS NOT NULL
  OR p_request->'quote'->>'sourceReviewItemId' IS DISTINCT FROM u.source_review_item_id
  OR p_request->'quote'->>'sourceReviewPriceId' IS DISTINCT FROM a.stripe_price_id
  OR p_request->'quote'->>'sourceBasePriceId' IS DISTINCT FROM s.stripe_price_id
  OR p_request->'quote'->>'setupFeeCents' IS DISTINCT FROM '0'
  OR p_request->'quote'->>'sourceMode' IS DISTINCT FROM 'review_sms'
  THEN RAISE EXCEPTION 'texting_upgrade_source_changed'; END IF;
 IF coalesce(p_request->>'target_price_id','') !~ '^price_[A-Za-z0-9]+$'
  OR coalesce(p_request->>'stripe_item_id','') !~ '^si_[A-Za-z0-9]+$' OR p_request->>'stripe_item_id'=u.source_review_item_id
  OR coalesce(p_request->>'source_fingerprint','') !~ '^[a-f0-9]{64}$'
  OR coalesce(p_request->'quote'->>'amountDueCents','') !~ '^[0-9]+$' OR p_request->'quote'->>'currency' IS DISTINCT FROM 'usd'
  OR p_request->>'proration_at' IS NULL OR (p_request->>'proration_at')::timestamptz NOT BETWEEN s.current_period_start AND s.current_period_end
  THEN RAISE EXCEPTION 'texting_upgrade_invalid_quote'; END IF;
 UPDATE public.sms_billing_operations SET state='expired' WHERE business_id=u.business_id AND state='prepared' AND expires_at<=now();
 SELECT * INTO o FROM public.sms_billing_operations WHERE business_id=u.business_id AND state IN ('prepared','confirming','pending','scheduled');
 IF o.id IS NOT NULL THEN
  IF o.id IS DISTINCT FROM u.billing_operation_id OR o.state<>'prepared' THEN RAISE EXCEPTION 'texting_upgrade_locked'; END IF;
  UPDATE public.sms_billing_operations SET state='expired' WHERE id=o.id;
 END IF;
 INSERT INTO public.sms_billing_accounts(business_id,stripe_customer_id) VALUES(u.business_id,u.source_customer_id) ON CONFLICT(business_id) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM public.sms_billing_accounts WHERE business_id=u.business_id AND stripe_customer_id=u.source_customer_id)
  THEN RAISE EXCEPTION 'texting_upgrade_source_changed'; END IF;
 INSERT INTO public.sms_billing_operations(business_id,owner_id,kind,target_plan,target_price_id,expected_subscription_id,expected_customer_id,
  stripe_customer_id,stripe_item_id,source_fingerprint,source_plan,source_period_start,source_period_end,proration_at,quote,expires_at)
 VALUES(u.business_id,u.owner_id,'upgrade','sms_and_chat',p_request->>'target_price_id',u.source_subscription_id,u.source_customer_id,
  u.source_customer_id,p_request->>'stripe_item_id',p_request->>'source_fingerprint','chat_only',s.current_period_start,s.current_period_end,
  (p_request->>'proration_at')::timestamptz,p_request->'quote'||jsonb_build_object('setupFingerprint',public.review_texting_upgrade_billing_fingerprint(u.id)),
  LEAST(date_trunc('second',now())+interval '10 minutes',s.current_period_end)) RETURNING * INTO o;
 UPDATE public.chat_texting_upgrades SET billing_operation_id=o.id,revision=revision+1,updated_at=clock_timestamp() WHERE id=u.id;
 RETURN to_jsonb(o);
END $$;

ALTER FUNCTION public.confirm_chat_texting_upgrade(uuid,uuid,uuid,text) RENAME TO confirm_chat_texting_upgrade_before_review_sms;
CREATE FUNCTION public.confirm_chat_texting_upgrade(p_upgrade_id uuid,p_owner_id uuid,p_operation_id uuid,p_source_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u public.chat_texting_upgrades; o public.sms_billing_operations; result jsonb;
BEGIN
 u:=public.chat_texting_upgrade_source(p_upgrade_id,p_owner_id);
 IF u.source_mode<>'review_sms' THEN RETURN public.confirm_chat_texting_upgrade_before_review_sms(p_upgrade_id,p_owner_id,p_operation_id,p_source_fingerprint); END IF;
 IF u.billing_operation_id IS DISTINCT FROM p_operation_id OR u.state NOT IN ('draft','payment_pending') THEN RAISE EXCEPTION 'texting_upgrade_locked'; END IF;
 SELECT * INTO o FROM public.sms_billing_operations WHERE id=p_operation_id;
 IF o.state='prepared' AND (NOT public.review_texting_upgrade_source_valid(u.id) OR NOT public.review_texting_upgrade_provider_ready(u.id)
  OR o.quote->>'setupFingerprint' IS DISTINCT FROM public.review_texting_upgrade_billing_fingerprint(u.id))
  THEN RAISE EXCEPTION 'texting_upgrade_source_changed'; END IF;
 result:=public.confirm_sms_billing_operation_before_chat_upgrade(p_operation_id,p_owner_id,p_source_fingerprint);
 -- Invalidate a direct-addon reconciler that started before payment was claimed.
 UPDATE public.review_sms_accounts SET billing_revision=billing_revision+1,applied_revision=billing_revision+1 WHERE id=u.source_review_account_id;
 UPDATE public.chat_texting_upgrades SET state='payment_pending',revision=revision+1,updated_at=clock_timestamp() WHERE id=u.id;
 RETURN result;
END $$;

CREATE FUNCTION public.expire_review_texting_upgrade_payment(p_upgrade_id uuid,p_operation_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u public.chat_texting_upgrades;
BEGIN
 PERFORM 1 FROM public.businesses WHERE id=(SELECT business_id FROM public.chat_texting_upgrades WHERE id=p_upgrade_id) FOR UPDATE;
 SELECT * INTO u FROM public.chat_texting_upgrades WHERE id=p_upgrade_id FOR UPDATE;
 IF u.source_mode='review_sms' AND u.state='payment_pending' AND u.paid_at IS NULL AND u.billing_operation_id=p_operation_id
  AND EXISTS(SELECT 1 FROM public.sms_billing_operations WHERE id=p_operation_id AND state='expired') THEN
  UPDATE public.chat_texting_upgrades SET state='draft',revision=revision+1,updated_at=clock_timestamp() WHERE id=u.id;
 END IF;
END $$;

ALTER FUNCTION public.finalize_chat_texting_upgrade_payment(uuid,jsonb) RENAME TO finalize_chat_texting_upgrade_payment_before_review_sms;
CREATE FUNCTION public.finalize_chat_texting_upgrade_payment(p_operation_id uuid,p_details jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u public.chat_texting_upgrades; o public.sms_billing_operations; a public.review_sms_accounts;
 b public.businesses; s public.subscriptions; activation public.review_sms_billing_operations; bid uuid; changed boolean;
 paid timestamptz:=(p_details->>'invoice_paid_at')::timestamptz; ps timestamptz:=(p_details->>'payment_period_start')::timestamptz;
 pe timestamptz:=(p_details->>'payment_period_end')::timestamptz;
BEGIN
 SELECT business_id INTO bid FROM public.chat_texting_upgrades WHERE billing_operation_id=p_operation_id;
 SELECT * INTO b FROM public.businesses WHERE id=bid FOR UPDATE;
 SELECT * INTO u FROM public.chat_texting_upgrades WHERE billing_operation_id=p_operation_id FOR UPDATE;
 IF u.id IS NULL THEN RETURN false; END IF;
 IF u.source_mode<>'review_sms' THEN RETURN public.finalize_chat_texting_upgrade_payment_before_review_sms(p_operation_id,p_details); END IF;
 SELECT * INTO o FROM public.sms_billing_operations WHERE id=p_operation_id FOR UPDATE;
 SELECT * INTO a FROM public.review_sms_accounts WHERE id=u.source_review_account_id FOR UPDATE;
 SELECT * INTO s FROM public.subscriptions WHERE business_id=bid;
 SELECT * INTO activation FROM public.review_sms_billing_operations WHERE id=u.original_activation_operation_id;
 IF b.deleted_at IS NOT NULL OR b.owner_id IS DISTINCT FROM u.owner_id OR b.billing_mode<>'stripe'
  OR b.partner_id IS NOT NULL OR b.partner_plan IS NOT NULL THEN RETURN false; END IF;
 IF p_details->>'subscription_id' IS DISTINCT FROM u.source_subscription_id OR p_details->>'customer_id' IS DISTINCT FROM u.source_customer_id
  OR p_details->>'plan' IS DISTINCT FROM 'sms_and_chat' OR p_details->>'price_id' IS DISTINCT FROM o.target_price_id
  OR s.stripe_subscription_id IS DISTINCT FROM u.source_subscription_id OR s.stripe_customer_id IS DISTINCT FROM u.source_customer_id
  THEN RAISE EXCEPTION 'texting_upgrade_source_changed'; END IF;
 IF o.state='applied' THEN
  IF u.paid_at IS DISTINCT FROM paid OR o.invoice_id IS DISTINCT FROM p_details->>'invoice_id' THEN RAISE EXCEPTION 'texting_upgrade_payment_changed'; END IF;
  RETURN true;
 END IF;
 IF u.state<>'payment_pending' OR u.target_plan<>'sms_and_chat' OR o.state NOT IN ('confirming','pending')
  OR o.source_plan<>'chat_only' OR o.kind<>'upgrade' OR s.plan<>'chat_only' OR o.confirmed_at IS NULL
  OR o.expected_subscription_id<>u.source_subscription_id OR o.expected_customer_id<>u.source_customer_id OR o.target_plan<>u.target_plan
  OR a.business_id IS DISTINCT FROM bid OR a.owner_id IS DISTINCT FROM u.owner_id OR a.billing_source IS DISTINCT FROM 'direct'
  OR a.stripe_item_id IS DISTINCT FROM u.source_review_item_id OR a.activation_refunded_at IS NOT NULL
  OR NOT public.review_texting_upgrade_provider_ready(u.id) THEN RAISE EXCEPTION 'texting_upgrade_source_changed'; END IF;
 IF activation.account_id IS DISTINCT FROM a.id OR activation.business_id IS DISTINCT FROM bid OR activation.owner_id IS DISTINCT FROM u.owner_id
  OR activation.kind IS DISTINCT FROM 'activation' OR activation.state IS DISTINCT FROM 'completed' OR activation.completed_at IS NULL
  OR activation.payload->>'customerId' IS DISTINCT FROM u.source_customer_id OR activation.payload->>'subscriptionId' IS DISTINCT FROM u.source_subscription_id
  OR coalesce(activation.payload->>'amountCents','') NOT IN ('2500','4900') OR coalesce(activation.payload->>'feeId','') !~ '^price_[A-Za-z0-9]+$'
  OR a.activation_paid_at IS NULL OR a.activation_payment_intent_id IS NULL THEN RAISE EXCEPTION 'texting_upgrade_setup_credit_unverified'; END IF;
 IF p_details->>'invoice_status' IS DISTINCT FROM 'paid' OR coalesce(p_details->>'invoice_id','') !~ '^in_[A-Za-z0-9]+$'
  OR (o.invoice_id IS NOT NULL AND o.invoice_id<>p_details->>'invoice_id') OR paid IS NULL OR paid<o.confirmed_at-interval '1 minute'
  OR paid>clock_timestamp()+interval '1 minute' OR paid>=pe OR ps IS DISTINCT FROM o.source_period_start OR pe IS DISTINCT FROM o.source_period_end
  OR p_details->>'invoice_currency' IS DISTINCT FROM 'usd' OR (p_details->>'invoice_amount_due')::bigint IS DISTINCT FROM (o.quote->>'amountDueCents')::bigint
  OR o.setup_fee_price_id IS NOT NULL OR o.quote->>'setupFeeCents' IS DISTINCT FROM '0'
  OR (p_details->>'review_conversion_invoice_verified')::boolean IS DISTINCT FROM true
  OR p_details->>'source_review_item_id' IS DISTINCT FROM u.source_review_item_id
  OR (p_details->>'invoice_created_at') IS NULL OR (p_details->>'invoice_created_at')::timestamptz<o.confirmed_at-interval '1 minute'
  OR coalesce(p_details->>'status','') NOT IN ('active','past_due','trialing','canceled')
  OR (p_details->>'current_period_start')::timestamptz IS NULL OR (p_details->>'current_period_end')::timestamptz IS NULL
  OR (p_details->>'current_period_end')::timestamptz<=(p_details->>'current_period_start')::timestamptz
  THEN RAISE EXCEPTION 'texting_upgrade_payment_unverified'; END IF;
 UPDATE public.sms_billing_operations SET state='applied',stripe_subscription_id=u.source_subscription_id,invoice_id=p_details->>'invoice_id',
  payment_effective_at=paid,payment_verified_at=clock_timestamp(),applied_at=clock_timestamp() WHERE id=o.id;
 -- Provider handoff preceded payment, so no second registration step is needed.
 UPDATE public.chat_texting_upgrades SET paid_at=paid,state='activated',activated_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() WHERE id=u.id;
 UPDATE public.business_plan_family_locks SET family='sms',claimed_by='chat_texting_upgrade',updated_at=clock_timestamp() WHERE business_id=bid AND family='chat_only';
 IF NOT FOUND THEN RAISE EXCEPTION 'texting_upgrade_source_changed'; END IF;
 UPDATE public.review_sms_accounts SET billing_source='included',exclusive_resources=false,stripe_item_id=NULL,stripe_price_id=NULL,stripe_schedule_id=NULL,
  paid_invoice_id=NULL,paid_period_start=NULL,paid_period_end=NULL,period_allowance=0,
  billing_revision=billing_revision+1,applied_revision=billing_revision+1,updated_at=clock_timestamp() WHERE id=a.id;
 -- A cancellation may land after the provider read but before this lock. A
 -- paid upgrade proves its plan change, not permission to undo that cancellation.
 changed:=public.sync_stripe_subscription_if_business_active(bid,u.source_customer_id,u.source_subscription_id,'sms_and_chat',
  CASE WHEN s.status='canceled' THEN 'canceled' ELSE p_details->>'status' END,
  GREATEST(s.current_period_start,(p_details->>'current_period_start')::timestamptz),
  GREATEST(s.current_period_end,(p_details->>'current_period_end')::timestamptz),o.target_price_id,
  activation.payload->>'feeId',NULL,a.activation_paid_at,s.cancel_at_period_end OR coalesce((p_details->>'cancel_at_period_end')::boolean,false),clock_timestamp());
 IF NOT changed THEN RAISE EXCEPTION 'texting_upgrade_source_changed'; END IF;
 UPDATE public.businesses SET onboarding_selected_plan='sms_and_chat' WHERE id=bid;
 UPDATE public.sms_billing_accounts SET setup_fee_paid_at=coalesce(setup_fee_paid_at,a.activation_paid_at) WHERE business_id=bid AND stripe_customer_id=u.source_customer_id;
 UPDATE public.billing_usage_periods SET plan='sms_and_chat',included_sms_parts=GREATEST(included_sms_parts,1500),updated_at=clock_timestamp()
  WHERE business_id=bid AND period_start=ps;
 RETURN true;
END $$;

-- The direct addon must not react to its intentional deletion before the
-- conversion transaction commits. Do not suppress ordinary source renewals
-- while a carrier filing is merely in progress.
CREATE OR REPLACE FUNCTION public.review_sms_begin_reconcile(p_business uuid,p_subscription text,p_customer text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r bigint;
BEGIN
 PERFORM 1 FROM businesses WHERE id=p_business FOR UPDATE;
 IF EXISTS(SELECT 1 FROM chat_texting_upgrades WHERE business_id=p_business AND source_mode='review_sms' AND state='payment_pending' AND paid_at IS NULL) THEN RETURN NULL; END IF;
 UPDATE review_sms_accounts SET billing_revision=billing_revision+1 WHERE business_id=p_business
  AND billing_source='direct' AND source_subscription_id=p_subscription AND source_customer_id=p_customer RETURNING billing_revision INTO r;
 RETURN r;
END $$;
ALTER FUNCTION public.review_sms_record_paid_period(uuid,bigint,text,text,text,timestamptz,timestamptz,integer) RENAME TO review_sms_record_paid_period_before_conversion;
CREATE FUNCTION public.review_sms_record_paid_period(p_business uuid,p_revision bigint,p_item text,p_price text,p_invoice text,p_start timestamptz,p_end timestamptz,p_allowance integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM businesses WHERE id=p_business FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM review_sms_accounts WHERE business_id=p_business AND billing_source='direct')
  OR EXISTS(SELECT 1 FROM chat_texting_upgrades WHERE business_id=p_business AND source_mode='review_sms' AND state='payment_pending' AND paid_at IS NULL) THEN RETURN false; END IF;
 RETURN review_sms_record_paid_period_before_conversion(p_business,p_revision,p_item,p_price,p_invoice,p_start,p_end,p_allowance);
END $$;

-- A second owner action cannot schedule removal or refund while conversion owns
-- the source. Historical cancellation recovery is allowed after it is abandoned.
ALTER FUNCTION public.review_sms_acquire_operation(uuid,uuid,text,text,jsonb) RENAME TO review_sms_acquire_operation_before_conversion;
CREATE FUNCTION public.review_sms_acquire_operation(p_business uuid,p_owner uuid,p_kind text,p_fingerprint text,p_payload jsonb)
RETURNS public.review_sms_billing_operations LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM review_assert_owner(p_business,p_owner);
 IF EXISTS(SELECT 1 FROM chat_texting_upgrades WHERE business_id=p_business AND source_mode='review_sms' AND state<>'abandoned' AND paid_at IS NULL)
  THEN RAISE EXCEPTION 'review_sms_upgrade_in_progress'; END IF;
 RETURN review_sms_acquire_operation_before_conversion(p_business,p_owner,p_kind,p_fingerprint,p_payload);
END $$;
ALTER FUNCTION public.review_sms_confirm_operation(uuid,uuid,text) RENAME TO review_sms_confirm_operation_before_conversion;
CREATE FUNCTION public.review_sms_confirm_operation(p_operation uuid,p_owner uuid,p_fingerprint text)
RETURNS public.review_sms_billing_operations LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE bid uuid;
BEGIN
 SELECT business_id INTO bid FROM review_sms_billing_operations WHERE id=p_operation;
 PERFORM review_assert_owner(bid,p_owner);
 IF EXISTS(SELECT 1 FROM chat_texting_upgrades WHERE business_id=bid AND source_mode='review_sms' AND state<>'abandoned' AND paid_at IS NULL)
  THEN RAISE EXCEPTION 'review_sms_upgrade_in_progress'; END IF;
 RETURN review_sms_confirm_operation_before_conversion(p_operation,p_owner,p_fingerprint);
END $$;

REVOKE ALL ON FUNCTION public.save_chat_texting_upgrade_before_review_sms(uuid,uuid,text,boolean),
 public.read_chat_texting_upgrade_setup_before_review_sms(uuid,uuid),public.acquire_chat_texting_upgrade_quote_before_review_sms(uuid,uuid,jsonb),
 public.confirm_chat_texting_upgrade_before_review_sms(uuid,uuid,uuid,text),public.finalize_chat_texting_upgrade_payment_before_review_sms(uuid,jsonb),
 public.review_sms_record_paid_period_before_conversion(uuid,bigint,text,text,text,timestamptz,timestamptz,integer),
 public.review_sms_acquire_operation_before_conversion(uuid,uuid,text,text,jsonb),public.review_sms_confirm_operation_before_conversion(uuid,uuid,text)
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.read_review_texting_upgrade_source(uuid,uuid),public.review_texting_upgrade_source_valid(uuid),
 public.save_chat_texting_upgrade(uuid,uuid,text,boolean),public.read_chat_texting_upgrade_setup(uuid,uuid),public.review_texting_upgrade_billing_fingerprint(uuid),
 public.acquire_chat_texting_upgrade_quote(uuid,uuid,jsonb),public.confirm_chat_texting_upgrade(uuid,uuid,uuid,text),
 public.expire_review_texting_upgrade_payment(uuid,uuid),public.finalize_chat_texting_upgrade_payment(uuid,jsonb),
 public.review_sms_record_paid_period(uuid,bigint,text,text,text,timestamptz,timestamptz,integer),
 public.review_sms_acquire_operation(uuid,uuid,text,text,jsonb),public.review_sms_confirm_operation(uuid,uuid,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_review_texting_upgrade_source(uuid,uuid),public.review_texting_upgrade_source_valid(uuid),
 public.save_chat_texting_upgrade(uuid,uuid,text,boolean),public.read_chat_texting_upgrade_setup(uuid,uuid),public.review_texting_upgrade_billing_fingerprint(uuid),
 public.acquire_chat_texting_upgrade_quote(uuid,uuid,jsonb),public.confirm_chat_texting_upgrade(uuid,uuid,uuid,text),
 public.expire_review_texting_upgrade_payment(uuid,uuid),public.finalize_chat_texting_upgrade_payment(uuid,jsonb),
 public.review_sms_record_paid_period(uuid,bigint,text,text,text,timestamptz,timestamptz,integer),
 public.review_sms_acquire_operation(uuid,uuid,text,text,jsonb),public.review_sms_confirm_operation(uuid,uuid,text)
 TO service_role;
COMMIT;
