BEGIN;

-- Billing authority and delivered service are deliberately separate during a
-- paid carrier review. The old acquisition and checkout ledgers remain intact.
CREATE TABLE public.chat_texting_upgrades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  source_subscription_id text NOT NULL,
  source_customer_id text NOT NULL,
  target_plan text NOT NULL CHECK(target_plan IN ('sms_only','sms_and_chat','full')),
  state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','payment_pending','carrier_pending','support_required','activated','abandoned')),
  billing_operation_id uuid UNIQUE REFERENCES public.sms_billing_operations(id) ON DELETE CASCADE,
  starter_acknowledged_at timestamptz,
  business_confirmed_at timestamptz,
  phone_confirmed_at timestamptz,
  reconcile_after timestamptz NOT NULL DEFAULT now(),
  reconcile_claimed_at timestamptz,
  provider_copy_write_token uuid,
  paid_at timestamptz,
  activated_at timestamptz,
  support_reason text,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((activated_at IS NULL)=(state<>'activated')),
  CHECK (state NOT IN ('carrier_pending','support_required','activated') OR paid_at IS NOT NULL)
);
CREATE UNIQUE INDEX chat_texting_one_live_upgrade ON public.chat_texting_upgrades(business_id) WHERE state<>'abandoned';
ALTER TABLE public.chat_texting_upgrades ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chat_texting_upgrades FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.chat_texting_upgrades TO service_role;

CREATE FUNCTION public.get_business_effective_service_plan(p_business_id uuid,p_billed_plan text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT CASE WHEN EXISTS(
  SELECT 1 FROM public.chat_texting_upgrades u JOIN public.subscriptions s ON s.business_id=u.business_id
  JOIN public.businesses b ON b.id=u.business_id JOIN public.sms_billing_operations o ON o.id=u.billing_operation_id
  WHERE u.business_id=p_business_id AND u.state IN ('carrier_pending','support_required') AND u.paid_at IS NOT NULL
   AND u.activated_at IS NULL AND s.stripe_subscription_id=u.source_subscription_id AND s.stripe_customer_id=u.source_customer_id
   AND s.plan=u.target_plan AND s.plan=p_billed_plan AND s.status IN ('active','trialing','past_due')
   AND o.business_id=u.business_id AND o.state='applied' AND o.kind='upgrade' AND o.source_plan='chat_only'
   AND o.stripe_subscription_id=s.stripe_subscription_id AND o.stripe_customer_id=s.stripe_customer_id
   AND o.target_plan=u.target_plan AND o.payment_effective_at=u.paid_at AND o.payment_verified_at IS NOT NULL
   AND b.deleted_at IS NULL AND b.billing_mode='stripe'
   AND b.partner_id IS NULL AND b.partner_plan IS NULL
 ) THEN 'chat_only' ELSE p_billed_plan END
$$;

CREATE FUNCTION public.chat_texting_upgrade_source(p_upgrade_id uuid,p_owner_id uuid) RETURNS public.chat_texting_upgrades
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u public.chat_texting_upgrades; b public.businesses; s public.subscriptions; bid uuid;
BEGIN
 SELECT business_id INTO bid FROM public.chat_texting_upgrades WHERE id=p_upgrade_id;
 SELECT * INTO b FROM public.businesses WHERE id=bid FOR UPDATE;
 SELECT * INTO u FROM public.chat_texting_upgrades WHERE id=p_upgrade_id FOR UPDATE;
 SELECT * INTO s FROM public.subscriptions WHERE business_id=bid;
 IF u.id IS NULL OR b.owner_id IS DISTINCT FROM p_owner_id OR u.owner_id IS DISTINCT FROM p_owner_id
  OR b.deleted_at IS NOT NULL OR b.operations_suspended_at IS NOT NULL OR b.billing_mode<>'stripe'
  OR b.partner_id IS NOT NULL OR b.partner_plan IS NOT NULL OR b.billing_pilot OR b.billing_comped OR b.billing_exempt
  OR b.onboarding_completed_at IS NULL THEN RAISE EXCEPTION 'texting_upgrade_forbidden' USING ERRCODE='42501'; END IF;
 IF s.stripe_subscription_id IS DISTINCT FROM u.source_subscription_id OR s.stripe_customer_id IS DISTINCT FROM u.source_customer_id
  OR (u.paid_at IS NULL AND s.plan IS DISTINCT FROM 'chat_only') THEN RAISE EXCEPTION 'texting_upgrade_source_changed'; END IF;
 RETURN u;
END $$;

CREATE FUNCTION public.save_chat_texting_upgrade(p_business_id uuid,p_owner_id uuid,p_target_plan text,p_starter_acknowledged boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE b public.businesses; s public.subscriptions; u public.chat_texting_upgrades;
BEGIN
 SELECT * INTO b FROM public.businesses WHERE id=p_business_id FOR UPDATE;
 SELECT * INTO s FROM public.subscriptions WHERE business_id=p_business_id;
 IF b.id IS NULL OR b.owner_id IS DISTINCT FROM p_owner_id OR b.deleted_at IS NOT NULL OR b.operations_suspended_at IS NOT NULL
  OR b.billing_mode<>'stripe' OR b.partner_id IS NOT NULL OR b.partner_plan IS NOT NULL OR b.billing_pilot OR b.billing_comped OR b.billing_exempt
  OR b.onboarding_completed_at IS NULL THEN RAISE EXCEPTION 'texting_upgrade_forbidden' USING ERRCODE='42501'; END IF;
 IF p_target_plan IS NULL OR p_target_plan NOT IN ('sms_only','sms_and_chat','full') THEN RAISE EXCEPTION 'texting_upgrade_invalid_plan'; END IF;
 SELECT * INTO u FROM public.chat_texting_upgrades WHERE business_id=p_business_id AND state<>'abandoned' FOR UPDATE;
 IF u.id IS NOT NULL AND u.state<>'draft' THEN
  IF u.target_plan=p_target_plan THEN RETURN to_jsonb(u); END IF;
  RAISE EXCEPTION 'texting_upgrade_locked';
 END IF;
 IF s.plan IS DISTINCT FROM 'chat_only' OR s.status IS DISTINCT FROM 'active' OR s.cancel_at_period_end
  OR s.current_period_end<=now() OR s.stripe_subscription_id IS NULL OR s.stripe_customer_id IS NULL
  OR s.pending_plan IS NOT NULL THEN RAISE EXCEPTION 'texting_upgrade_source_changed'; END IF;
 IF EXISTS(SELECT 1 FROM public.chat_only_checkout_attempts WHERE business_id=p_business_id AND state IN ('creating','open'))
  OR EXISTS(SELECT 1 FROM public.sms_billing_operations WHERE business_id=p_business_id AND state IN ('confirming','pending','scheduled'))
  OR b.telnyx_brand_id IS NOT NULL OR b.telnyx_campaign_id IS NOT NULL OR b.telnyx_messaging_profile_id IS NOT NULL
  OR b.telnyx_voice_application_id IS NOT NULL OR b.active_telnyx_release_run_id IS NOT NULL
  OR b.telnyx_resource_state NOT IN ('provisioning','released')
  OR EXISTS(SELECT 1 FROM public.phone_numbers WHERE business_id=p_business_id AND resource_status<>'released')
  OR EXISTS(SELECT 1 FROM public.telnyx_managed_resources WHERE business_id=p_business_id AND local_claim_active AND ownership_state<>'released')
  THEN RAISE EXCEPTION 'texting_upgrade_provider_history'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.business_plan_family_locks WHERE business_id=p_business_id AND family='chat_only')
  OR NOT EXISTS(SELECT 1 FROM public.chat_only_checkout_attempts WHERE business_id=p_business_id AND state='completed'
    AND stripe_subscription_id=s.stripe_subscription_id AND stripe_customer_id=s.stripe_customer_id)
  OR EXISTS(SELECT 1 FROM public.billing_usage_periods WHERE business_id=p_business_id AND plan<>'chat_only')
  THEN RAISE EXCEPTION 'texting_upgrade_source_changed'; END IF;
 IF u.id IS NOT NULL THEN
  IF u.source_subscription_id<>s.stripe_subscription_id OR u.source_customer_id<>s.stripe_customer_id THEN RAISE EXCEPTION 'texting_upgrade_source_changed'; END IF;
  IF u.target_plan<>p_target_plan THEN
   UPDATE public.sms_billing_operations SET state='expired' WHERE id=u.billing_operation_id AND state='prepared';
  END IF;
  UPDATE public.chat_texting_upgrades SET target_plan=p_target_plan,
   starter_acknowledged_at=CASE WHEN p_target_plan='sms_only' AND p_starter_acknowledged THEN clock_timestamp() WHEN p_target_plan='sms_only' AND u.target_plan=p_target_plan THEN starter_acknowledged_at END,
   billing_operation_id=CASE WHEN u.target_plan<>p_target_plan THEN NULL ELSE billing_operation_id END,
   revision=revision+1,updated_at=clock_timestamp() WHERE id=u.id RETURNING * INTO u;
 ELSE
  INSERT INTO public.chat_texting_upgrades(business_id,owner_id,source_subscription_id,source_customer_id,target_plan,starter_acknowledged_at)
   VALUES(p_business_id,p_owner_id,s.stripe_subscription_id,s.stripe_customer_id,p_target_plan,
    CASE WHEN p_target_plan='sms_only' AND p_starter_acknowledged THEN clock_timestamp() END) RETURNING * INTO u;
 END IF;
 RETURN to_jsonb(u);
END $$;

CREATE FUNCTION public.save_chat_texting_upgrade_details(p_upgrade_id uuid,p_owner_id uuid,p_step text,p_values jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u public.chat_texting_upgrades; b public.businesses; allowed text[]; columns_sql text; values_sql text; phone_recovery boolean;
BEGIN
 u:=public.chat_texting_upgrade_source(p_upgrade_id,p_owner_id);
 SELECT * INTO b FROM public.businesses WHERE id=u.business_id;
 phone_recovery:=p_step='phone' AND u.paid_at IS NOT NULL AND u.activated_at IS NULL AND u.state IN ('carrier_pending','support_required')
  AND b.pending_phone_number_failure_reason IS NOT NULL AND b.brand_status IS DISTINCT FROM 'rejected' AND b.campaign_status IS DISTINCT FROM 'rejected'
  AND NOT EXISTS(SELECT 1 FROM public.phone_numbers WHERE business_id=u.business_id AND resource_status<>'released' AND (is_active OR telnyx_phone_number_id IS NOT NULL))
  AND NOT EXISTS(SELECT 1 FROM public.telnyx_managed_resources WHERE business_id=u.business_id AND resource_type='phone_number' AND local_claim_active AND ownership_state<>'released');
 IF u.state<>'draft' AND NOT phone_recovery THEN RAISE EXCEPTION 'texting_upgrade_locked'; END IF;
 IF NOT phone_recovery AND (b.telnyx_brand_id IS NOT NULL OR b.telnyx_campaign_id IS NOT NULL OR b.onboarding_registration_status IN ('submitting','submitted')
  OR b.onboarding_registration_started_at IS NOT NULL OR EXISTS(SELECT 1 FROM public.sms_billing_operations WHERE id=u.billing_operation_id AND state IN ('confirming','pending','scheduled')))
  THEN RAISE EXCEPTION 'texting_upgrade_locked'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.subscriptions WHERE business_id=u.business_id AND status='active' AND NOT cancel_at_period_end AND current_period_end>now())
  THEN RAISE EXCEPTION 'texting_upgrade_source_changed'; END IF;
 allowed:=CASE p_step
 WHEN 'business' THEN ARRAY['name','business_type','business_type_other','website_url','phone_number','email','address','city','state','zip','timezone']
 WHEN 'verification' THEN ARRAY['has_ein','a2p_brand_tier','no_ein_hold_status','no_ein_waitlist_requested_at','legal_business_name','business_entity_type','business_registration_state','tax_id_type','ein','authorized_rep_name','authorized_rep_title','authorized_rep_email','authorized_rep_phone']
 WHEN 'use_case' THEN ARRAY['use_case_description','estimated_monthly_volume','sample_messages','opt_in_description','slug','compliance_info_completed_at','a2p_risk_review_status','a2p_risk_review_input_hash','a2p_risk_review_message','a2p_risk_review_reason','a2p_risk_review_findings','a2p_risk_review_customer_answer','a2p_risk_review_customer_selections','a2p_risk_review_scanned_at','a2p_risk_review_notified_at','a2p_risk_review_reviewed_at','a2p_risk_review_reviewed_by','a2p_risk_review_override_note','a2p_risk_review_updated_at']
 WHEN 'phone' THEN ARRAY['pending_phone_number','pending_phone_number_area_code','pending_phone_number_selected_at','pending_phone_number_failure_reason'] END;
 IF allowed IS NULL OR jsonb_typeof(p_values) IS DISTINCT FROM 'object' OR p_values='{}'::jsonb
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_values) k WHERE NOT k=ANY(allowed)) THEN RAISE EXCEPTION 'texting_upgrade_invalid_details'; END IF;
 SELECT string_agg(format('%I',k),',' ORDER BY k),string_agg(format('v.%I',k),',' ORDER BY k)
 INTO columns_sql,values_sql FROM jsonb_object_keys(p_values) k;
 EXECUTE format('UPDATE public.businesses SET (%s)=(SELECT %s FROM jsonb_populate_record(NULL::public.businesses,$1) v) WHERE id=$2',columns_sql,values_sql) USING p_values,u.business_id;
 IF p_step='phone' THEN
  UPDATE public.businesses SET sms_consent_agreed=true,sms_consent_agreed_at=clock_timestamp() WHERE id=u.business_id;
 END IF;
 UPDATE public.sms_billing_operations SET state='expired' WHERE id=u.billing_operation_id AND state='prepared';
 UPDATE public.chat_texting_upgrades SET phone_confirmed_at=CASE WHEN p_step='phone' THEN clock_timestamp() ELSE phone_confirmed_at END,
  state=CASE WHEN phone_recovery THEN 'carrier_pending' ELSE state END,
  business_confirmed_at=CASE WHEN p_step='business' THEN clock_timestamp() ELSE business_confirmed_at END,
  billing_operation_id=CASE WHEN phone_recovery THEN billing_operation_id ELSE NULL END,revision=revision+1,updated_at=clock_timestamp() WHERE id=u.id RETURNING * INTO u;
 RETURN to_jsonb(u);
END $$;

CREATE FUNCTION public.chat_texting_upgrade_setup_fingerprint(p_business_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT md5(jsonb_build_array(to_jsonb(b),
  (SELECT jsonb_agg(to_jsonb(h) ORDER BY h.day_of_week) FROM public.business_hours h WHERE h.business_id=b.id),
  (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.ai_settings a WHERE a.business_id=b.id),
  (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM public.services v WHERE v.business_id=b.id AND v.is_active),
  (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id) FROM public.faqs f WHERE f.business_id=b.id AND f.is_active))::text)
 FROM public.businesses b WHERE b.id=p_business_id
$$;
CREATE FUNCTION public.read_chat_texting_upgrade_setup(p_upgrade_id uuid,p_owner_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('setupFingerprint',public.chat_texting_upgrade_setup_fingerprint(b.id),'revision',u.revision)
 FROM public.chat_texting_upgrades u JOIN public.businesses b ON b.id=u.business_id JOIN public.subscriptions s ON s.business_id=b.id
 WHERE u.id=p_upgrade_id AND u.owner_id=p_owner_id AND b.owner_id=p_owner_id AND b.deleted_at IS NULL
  AND b.operations_suspended_at IS NULL AND b.billing_mode='stripe' AND b.partner_id IS NULL AND b.partner_plan IS NULL
  AND u.state='draft' AND s.plan='chat_only' AND s.status='active' AND NOT s.cancel_at_period_end
  AND s.stripe_subscription_id=u.source_subscription_id AND s.stripe_customer_id=u.source_customer_id
$$;
REVOKE ALL ON FUNCTION public.read_chat_texting_upgrade_setup(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_chat_texting_upgrade_setup(uuid,uuid) TO service_role;
CREATE FUNCTION public.chat_texting_upgrade_setup_ready(p_upgrade_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.chat_texting_upgrades u JOIN public.businesses b ON b.id=u.business_id WHERE u.id=p_upgrade_id
  AND u.business_confirmed_at IS NOT NULL AND (u.target_plan<>'sms_only' OR u.starter_acknowledged_at IS NOT NULL)
  AND NULLIF(b.name,'') IS NOT NULL AND b.name<>'My Business' AND b.business_type IS NOT NULL
  AND NULLIF(b.phone_number,'') IS NOT NULL AND NULLIF(b.email,'') IS NOT NULL AND NULLIF(b.address,'') IS NOT NULL
  AND NULLIF(b.city,'') IS NOT NULL AND NULLIF(b.state,'') IS NOT NULL AND NULLIF(b.zip,'') IS NOT NULL
  AND b.primary_goal IS NOT NULL AND (SELECT count(*) FROM public.business_hours h WHERE h.business_id=b.id)=7
  AND EXISTS(SELECT 1 FROM public.ai_settings a WHERE a.business_id=b.id)
  AND (SELECT count(DISTINCT public.normalize_ai_knowledge_key(v.name)) FROM public.services v WHERE v.business_id=b.id AND v.is_active AND public.normalize_ai_knowledge_key(v.name)<>'')>=3
  AND (SELECT count(DISTINCT public.normalize_ai_knowledge_key(f.question)) FROM public.faqs f WHERE f.business_id=b.id AND f.is_active
    AND public.normalize_ai_knowledge_key(f.question)<>'' AND public.normalize_ai_knowledge_key(f.answer)<>'' AND char_length(f.answer)<=2000)>=3
  AND b.has_ein IS TRUE AND NULLIF(b.legal_business_name,'') IS NOT NULL AND b.business_entity_type IS NOT NULL
  AND NULLIF(b.business_registration_state,'') IS NOT NULL AND b.ein ~ '^[0-9]{2}-?[0-9]{7}$'
  AND NULLIF(b.authorized_rep_name,'') IS NOT NULL AND NULLIF(b.authorized_rep_title,'') IS NOT NULL
  AND NULLIF(b.authorized_rep_email,'') IS NOT NULL AND NULLIF(b.authorized_rep_phone,'') IS NOT NULL
  AND b.compliance_info_completed_at IS NOT NULL AND b.a2p_risk_review_status IN ('passed','admin_approved')
  AND NULLIF(b.a2p_risk_review_input_hash,'') IS NOT NULL AND NULLIF(b.use_case_description,'') IS NOT NULL
  AND NULLIF(b.estimated_monthly_volume,'') IS NOT NULL AND NULLIF(b.opt_in_description,'') IS NOT NULL
  AND u.phone_confirmed_at IS NOT NULL AND b.sms_consent_agreed IS TRUE AND b.sms_consent_agreed_at IS NOT NULL
  AND cardinality(b.sample_messages)>=3 AND b.pending_phone_number ~ '^\+1[2-9][0-9]{9}$'
  AND substring(b.pending_phone_number FROM 3 FOR 3) NOT IN ('800','888','877','866','855','844','833','822')
  AND b.pending_phone_number_failure_reason IS NULL
  AND b.telnyx_brand_id IS NULL AND b.telnyx_campaign_id IS NULL AND b.onboarding_registration_status NOT IN ('submitting','submitted'))
$$;

CREATE FUNCTION public.acquire_chat_texting_upgrade_quote(p_upgrade_id uuid,p_owner_id uuid,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u public.chat_texting_upgrades; s public.subscriptions; o public.sms_billing_operations;
BEGIN
 u:=public.chat_texting_upgrade_source(p_upgrade_id,p_owner_id);
 IF u.state<>'draft' THEN RAISE EXCEPTION 'texting_upgrade_locked'; END IF;
 IF NOT public.chat_texting_upgrade_setup_ready(u.id) THEN RAISE EXCEPTION 'texting_upgrade_incomplete'; END IF;
 IF p_request->>'expected_setup_fingerprint' IS DISTINCT FROM public.chat_texting_upgrade_setup_fingerprint(u.business_id)
  THEN RAISE EXCEPTION 'texting_upgrade_source_changed'; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE business_id=u.business_id;
 IF s.status<>'active' OR s.cancel_at_period_end OR s.pending_plan IS NOT NULL OR s.current_period_end<=now()
  OR s.stripe_subscription_id IS DISTINCT FROM p_request->>'expected_subscription_id'
  OR s.stripe_customer_id IS DISTINCT FROM p_request->>'expected_customer_id'
  OR p_request->>'target_plan' IS DISTINCT FROM u.target_plan THEN RAISE EXCEPTION 'texting_upgrade_source_changed'; END IF;
 IF COALESCE(p_request->>'target_price_id','') !~ '^price_[A-Za-z0-9]+$' OR COALESCE(p_request->>'setup_fee_price_id','') !~ '^price_[A-Za-z0-9]+$'
  OR COALESCE(p_request->>'stripe_item_id','') !~ '^si_[A-Za-z0-9]+$' OR COALESCE(p_request->>'source_fingerprint','') !~ '^[a-f0-9]{64}$'
  OR COALESCE(p_request->'quote'->>'amountDueCents','') !~ '^[0-9]+$' OR p_request->'quote'->>'currency' IS DISTINCT FROM 'usd'
  OR (p_request->>'proration_at') IS NULL
  OR (p_request->>'proration_at')::timestamptz NOT BETWEEN s.current_period_start AND s.current_period_end
  THEN RAISE EXCEPTION 'texting_upgrade_invalid_quote'; END IF;
 UPDATE public.sms_billing_operations SET state='expired' WHERE business_id=u.business_id AND state='prepared' AND expires_at<=now();
 SELECT * INTO o FROM public.sms_billing_operations WHERE business_id=u.business_id AND state IN ('prepared','confirming','pending','scheduled');
 IF o.id IS NOT NULL THEN
  IF o.id IS DISTINCT FROM u.billing_operation_id OR o.state<>'prepared'
   THEN RAISE EXCEPTION 'texting_upgrade_locked'; END IF;
  UPDATE public.sms_billing_operations SET state='expired' WHERE id=o.id;
 END IF;
 INSERT INTO public.sms_billing_accounts(business_id,stripe_customer_id) VALUES(u.business_id,u.source_customer_id)
  ON CONFLICT(business_id) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM public.sms_billing_accounts WHERE business_id=u.business_id AND stripe_customer_id=u.source_customer_id AND setup_fee_paid_at IS NULL)
  THEN RAISE EXCEPTION 'texting_upgrade_source_changed'; END IF;
 INSERT INTO public.sms_billing_operations(business_id,owner_id,kind,target_plan,target_price_id,expected_subscription_id,expected_customer_id,
  stripe_customer_id,stripe_item_id,source_fingerprint,source_plan,source_period_start,source_period_end,proration_at,setup_fee_price_id,quote,expires_at)
 VALUES(u.business_id,u.owner_id,'upgrade',u.target_plan,p_request->>'target_price_id',u.source_subscription_id,u.source_customer_id,
  u.source_customer_id,p_request->>'stripe_item_id',p_request->>'source_fingerprint','chat_only',s.current_period_start,s.current_period_end,
  (p_request->>'proration_at')::timestamptz,p_request->>'setup_fee_price_id',COALESCE(p_request->'quote','{}'::jsonb)||jsonb_build_object('setupFingerprint',public.chat_texting_upgrade_setup_fingerprint(u.business_id)),
  LEAST(date_trunc('second',now())+interval '10 minutes',s.current_period_end)) RETURNING * INTO o;
 UPDATE public.chat_texting_upgrades SET billing_operation_id=o.id,revision=revision+1,updated_at=clock_timestamp() WHERE id=u.id;
 RETURN to_jsonb(o);
END $$;

-- The generic SMS paths must never be an alternate entry point into this flow.
ALTER FUNCTION public.confirm_sms_billing_operation(uuid,uuid,text) RENAME TO confirm_sms_billing_operation_before_chat_upgrade;
CREATE FUNCTION public.confirm_sms_billing_operation(p_operation_id uuid,p_owner_id uuid,p_source_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.chat_texting_upgrades WHERE billing_operation_id=p_operation_id) THEN RAISE EXCEPTION 'texting_upgrade_required'; END IF;
 RETURN public.confirm_sms_billing_operation_before_chat_upgrade(p_operation_id,p_owner_id,p_source_fingerprint);
END $$;
CREATE FUNCTION public.confirm_chat_texting_upgrade(p_upgrade_id uuid,p_owner_id uuid,p_operation_id uuid,p_source_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u public.chat_texting_upgrades; o public.sms_billing_operations; result jsonb;
BEGIN
 u:=public.chat_texting_upgrade_source(p_upgrade_id,p_owner_id);
 IF u.billing_operation_id IS DISTINCT FROM p_operation_id OR u.state NOT IN ('draft','payment_pending') THEN RAISE EXCEPTION 'texting_upgrade_locked'; END IF;
 SELECT * INTO o FROM public.sms_billing_operations WHERE id=p_operation_id;
 IF o.state='prepared' AND (NOT public.chat_texting_upgrade_setup_ready(u.id)
  OR o.quote->>'setupFingerprint' IS DISTINCT FROM public.chat_texting_upgrade_setup_fingerprint(u.business_id)) THEN RAISE EXCEPTION 'texting_upgrade_incomplete'; END IF;
 result:=public.confirm_sms_billing_operation_before_chat_upgrade(p_operation_id,p_owner_id,p_source_fingerprint);
 UPDATE public.chat_texting_upgrades SET state='payment_pending',revision=revision+1,updated_at=clock_timestamp() WHERE id=u.id;
 RETURN result;
END $$;

-- Historical Chat usage remains truthful. Only an immutable, exact paid
-- transition is authority to consider that historical evidence superseded.
ALTER FUNCTION public.infer_business_plan_family(uuid) RENAME TO infer_business_plan_family_before_chat_upgrade;
CREATE FUNCTION public.infer_business_plan_family(p_business_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.chat_texting_upgrades u JOIN public.sms_billing_operations o ON o.id=u.billing_operation_id
  WHERE u.business_id=p_business_id AND u.paid_at IS NOT NULL AND o.business_id=u.business_id AND o.state='applied'
   AND o.source_plan='chat_only' AND o.kind='upgrade' AND o.expected_subscription_id=u.source_subscription_id
   AND o.expected_customer_id=u.source_customer_id AND o.stripe_subscription_id=u.source_subscription_id
   AND o.stripe_customer_id=u.source_customer_id AND o.target_plan=u.target_plan AND o.payment_verified_at IS NOT NULL
   AND o.payment_effective_at=u.paid_at) THEN RETURN 'sms'; END IF;
 RETURN public.infer_business_plan_family_before_chat_upgrade(p_business_id);
END $$;

-- Preserve the complete 084 writer, and reject historical Chat writes before
-- they can collide with the new immutable SMS family or its setup-fee proof.
DO $projection_guards$
DECLARE definition text; needle text:=' SELECT * INTO s FROM public.subscriptions WHERE business_id=p_business_id;';
BEGIN
 definition:=pg_get_functiondef('public.sync_stripe_subscription_if_business_active(uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,timestamptz,boolean,timestamptz)'::regprocedure);
 IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'migration_091_sync_definition_drift'; END IF;
 definition:=replace(definition,needle,needle||$guard$
 IF p_plan='chat_only' AND EXISTS(SELECT 1 FROM public.chat_texting_upgrades WHERE business_id=p_business_id AND paid_at IS NOT NULL) THEN RETURN false; END IF;
 IF p_plan<>'chat_only' AND s.plan='chat_only' AND EXISTS(SELECT 1 FROM public.chat_texting_upgrades WHERE business_id=p_business_id AND paid_at IS NULL AND state<>'abandoned') THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.chat_texting_upgrades WHERE business_id=p_business_id AND state IN ('carrier_pending','support_required')
  AND paid_at IS NOT NULL AND (p_plan<>target_plan OR p_stripe_subscription_id<>source_subscription_id OR p_stripe_customer_id<>source_customer_id)) THEN RETURN false; END IF;
$guard$);
 EXECUTE definition;
END $projection_guards$;
ALTER FUNCTION public.finalize_paid_sms_billing_operation(uuid,jsonb,jsonb) RENAME TO finalize_paid_sms_billing_operation_before_chat_upgrade;
CREATE FUNCTION public.finalize_paid_sms_billing_operation(p_operation_id uuid,p_snapshot jsonb,p_payment jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.chat_texting_upgrades WHERE billing_operation_id=p_operation_id) THEN RAISE EXCEPTION 'texting_upgrade_required'; END IF;
 RETURN public.finalize_paid_sms_billing_operation_before_chat_upgrade(p_operation_id,p_snapshot,p_payment);
END $$;

CREATE FUNCTION public.finalize_chat_texting_upgrade_payment(p_operation_id uuid,p_details jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u public.chat_texting_upgrades; o public.sms_billing_operations; s public.subscriptions; b public.businesses; bid uuid;
 paid timestamptz:=(p_details->>'invoice_paid_at')::timestamptz; ps timestamptz:=(p_details->>'payment_period_start')::timestamptz;
 pe timestamptz:=(p_details->>'payment_period_end')::timestamptz; changed boolean;
BEGIN
 SELECT business_id INTO bid FROM public.chat_texting_upgrades WHERE billing_operation_id=p_operation_id;
 SELECT * INTO b FROM public.businesses WHERE id=bid FOR UPDATE;
 SELECT * INTO u FROM public.chat_texting_upgrades WHERE billing_operation_id=p_operation_id FOR UPDATE;
 SELECT * INTO o FROM public.sms_billing_operations WHERE id=p_operation_id FOR UPDATE;
 SELECT * INTO s FROM public.subscriptions WHERE business_id=bid;
 IF u.id IS NULL OR b.deleted_at IS NOT NULL OR b.owner_id IS DISTINCT FROM u.owner_id OR b.billing_mode<>'stripe'
  OR b.partner_id IS NOT NULL OR b.partner_plan IS NOT NULL THEN RETURN false; END IF;
 IF p_details->>'subscription_id' IS DISTINCT FROM u.source_subscription_id OR p_details->>'customer_id' IS DISTINCT FROM u.source_customer_id
  OR p_details->>'plan' IS DISTINCT FROM u.target_plan OR p_details->>'price_id' IS DISTINCT FROM o.target_price_id
  OR s.stripe_subscription_id IS DISTINCT FROM u.source_subscription_id OR s.stripe_customer_id IS DISTINCT FROM u.source_customer_id
  THEN RAISE EXCEPTION 'texting_upgrade_source_changed'; END IF;
 IF o.state='applied' THEN
  IF u.paid_at IS DISTINCT FROM paid OR o.invoice_id IS DISTINCT FROM p_details->>'invoice_id' THEN RAISE EXCEPTION 'texting_upgrade_payment_changed'; END IF;
  RETURN true;
 END IF;
 IF u.state<>'payment_pending' OR o.state NOT IN ('confirming','pending') OR o.source_plan<>'chat_only' OR o.kind<>'upgrade'
  OR s.plan<>'chat_only' OR o.confirmed_at IS NULL OR o.expected_subscription_id<>u.source_subscription_id
  OR o.expected_customer_id<>u.source_customer_id OR o.target_plan<>u.target_plan
  THEN RAISE EXCEPTION 'texting_upgrade_source_changed'; END IF;
 IF p_details->>'invoice_status' IS DISTINCT FROM 'paid' OR COALESCE(p_details->>'invoice_id','') !~ '^in_[A-Za-z0-9]+$'
  OR (o.invoice_id IS NOT NULL AND o.invoice_id<>p_details->>'invoice_id') OR paid IS NULL OR paid<o.confirmed_at-interval '1 minute'
  OR paid>clock_timestamp()+interval '1 minute' OR paid>=pe OR ps IS DISTINCT FROM o.source_period_start OR pe IS DISTINCT FROM o.source_period_end
  OR p_details->>'invoice_currency' IS DISTINCT FROM 'usd' OR (p_details->>'invoice_amount_due')::bigint IS DISTINCT FROM (o.quote->>'amountDueCents')::bigint
  OR p_details->>'setup_fee_price_id' IS DISTINCT FROM o.setup_fee_price_id OR (p_details->>'setup_fee_verified')::boolean IS DISTINCT FROM true
  OR (p_details->>'invoice_created_at') IS NULL
  OR (p_details->>'invoice_created_at')::timestamptz<o.confirmed_at-interval '1 minute'
  OR COALESCE(p_details->>'status','') NOT IN ('active','past_due','trialing','canceled')
  OR (p_details->>'current_period_start')::timestamptz IS NULL OR (p_details->>'current_period_end')::timestamptz IS NULL
  OR (p_details->>'current_period_end')::timestamptz<=(p_details->>'current_period_start')::timestamptz
  THEN RAISE EXCEPTION 'texting_upgrade_payment_unverified'; END IF;
 UPDATE public.sms_billing_operations SET state='applied',stripe_subscription_id=u.source_subscription_id,invoice_id=p_details->>'invoice_id',
  payment_effective_at=paid,payment_verified_at=clock_timestamp(),applied_at=clock_timestamp() WHERE id=o.id;
 UPDATE public.chat_texting_upgrades SET paid_at=paid,state='carrier_pending',revision=revision+1,updated_at=clock_timestamp() WHERE id=u.id;
 UPDATE public.business_plan_family_locks SET family='sms',claimed_by='chat_texting_upgrade',updated_at=clock_timestamp()
  WHERE business_id=bid AND family='chat_only';
 IF NOT FOUND THEN RAISE EXCEPTION 'texting_upgrade_source_changed'; END IF;
 changed:=public.sync_stripe_subscription_if_business_active(bid,u.source_customer_id,u.source_subscription_id,u.target_plan,'active',ps,pe,o.target_price_id,o.setup_fee_price_id,NULL,paid,false,clock_timestamp());
 IF NOT changed THEN RAISE EXCEPTION 'texting_upgrade_source_changed'; END IF;
 UPDATE public.businesses SET onboarding_selected_plan=u.target_plan WHERE id=bid;
 UPDATE public.sms_billing_accounts SET setup_fee_paid_at=COALESCE(setup_fee_paid_at,paid) WHERE business_id=bid AND stripe_customer_id=u.source_customer_id;
 PERFORM public.apply_paid_sms_voice_entitlement(bid,o.id,'chat_only',u.source_subscription_id,ps,pe);
 UPDATE public.billing_usage_periods SET plan=u.target_plan,included_sms_parts=GREATEST(included_sms_parts,CASE u.target_plan WHEN 'full' THEN 2500 WHEN 'sms_and_chat' THEN 1500 ELSE 500 END),updated_at=clock_timestamp()
  WHERE business_id=bid AND period_start=ps;
 -- Preserve current provider status/period even if reconciliation crosses a
 -- renewal or cancellation. The paid-operation grant above uses its own period.
 changed:=public.sync_stripe_subscription_if_business_active(bid,u.source_customer_id,u.source_subscription_id,u.target_plan,p_details->>'status',
  (p_details->>'current_period_start')::timestamptz,(p_details->>'current_period_end')::timestamptz,o.target_price_id,o.setup_fee_price_id,NULL,paid,
  COALESCE((p_details->>'cancel_at_period_end')::boolean,false),clock_timestamp());
 IF NOT changed THEN RAISE EXCEPTION 'texting_upgrade_source_changed'; END IF;
 RETURN true;
END $$;

CREATE FUNCTION public.activate_chat_texting_upgrade(p_upgrade_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u public.chat_texting_upgrades; b public.businesses; s public.subscriptions; bid uuid;
BEGIN
 SELECT business_id INTO bid FROM public.chat_texting_upgrades WHERE id=p_upgrade_id;
 SELECT * INTO b FROM public.businesses WHERE id=bid FOR UPDATE;
 SELECT * INTO u FROM public.chat_texting_upgrades WHERE id=p_upgrade_id FOR UPDATE;
 IF u.id IS NULL THEN RETURN false; END IF;
 IF u.state='activated' THEN RETURN true; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE business_id=bid;
 IF u.state<>'carrier_pending' OR u.paid_at IS NULL OR b.deleted_at IS NOT NULL OR b.deletion_scheduled_for IS NOT NULL OR b.owner_id IS DISTINCT FROM u.owner_id
  OR b.operations_suspended_at IS NOT NULL OR b.telnyx_submission_disabled OR b.billing_mode<>'stripe' OR b.partner_id IS NOT NULL OR b.partner_plan IS NOT NULL
  OR b.billing_pilot OR b.billing_comped OR b.billing_exempt
  OR b.telnyx_resource_state NOT IN ('provisioning','active') OR b.active_telnyx_release_run_id IS NOT NULL OR b.telnyx_unique_claims_released_at IS NOT NULL
  OR s.stripe_subscription_id IS DISTINCT FROM u.source_subscription_id OR s.stripe_customer_id IS DISTINCT FROM u.source_customer_id
  OR s.plan IS DISTINCT FROM u.target_plan OR s.status IS DISTINCT FROM 'active' OR s.cancel_at_period_end
  OR s.current_period_start>now() OR s.current_period_end<=now()
  OR public.get_business_effective_service_plan(bid,s.plan)<>'chat_only' THEN RETURN false; END IF;
 IF b.brand_status='rejected' OR b.campaign_status='rejected' THEN
  UPDATE public.chat_texting_upgrades SET state='support_required',support_reason='carrier_rejected',revision=revision+1,updated_at=clock_timestamp() WHERE id=u.id;
  RETURN false;
 END IF;
 IF b.brand_status IS DISTINCT FROM 'approved' OR b.campaign_status IS DISTINCT FROM 'approved'
  OR NULLIF(b.telnyx_brand_id,'') IS NULL OR NULLIF(b.telnyx_campaign_id,'') IS NULL OR NULLIF(b.telnyx_messaging_profile_id,'') IS NULL
  OR (SELECT count(*) FROM public.phone_numbers WHERE business_id=bid AND is_active)<>1
  OR NOT EXISTS(SELECT 1 FROM public.phone_numbers n WHERE n.business_id=bid AND n.is_active AND n.resource_status='active'
   AND n.telnyx_phone_number_id IS NOT NULL AND n.telnyx_campaign_assignment_status='assigned' AND n.telnyx_campaign_assignment_campaign_id=b.telnyx_campaign_id)
  THEN RETURN false; END IF;
 UPDATE public.chat_texting_upgrades SET state='activated',activated_at=clock_timestamp(),support_reason=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE id=u.id;
 RETURN true;
END $$;

CREATE FUNCTION public.cancel_chat_texting_upgrade(p_upgrade_id uuid,p_owner_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u public.chat_texting_upgrades; o public.sms_billing_operations;
BEGIN
 u:=public.chat_texting_upgrade_source(p_upgrade_id,p_owner_id);
 IF u.paid_at IS NOT NULL THEN RAISE EXCEPTION 'texting_upgrade_support_required'; END IF;
 SELECT * INTO o FROM public.sms_billing_operations WHERE id=u.billing_operation_id;
 IF o.id IS NOT NULL AND o.state NOT IN ('prepared','expired') THEN RAISE EXCEPTION 'texting_upgrade_payment_unresolved'; END IF;
 UPDATE public.sms_billing_operations SET state='expired' WHERE id=o.id AND state='prepared';
 UPDATE public.chat_texting_upgrades SET state='abandoned',revision=revision+1,updated_at=clock_timestamp() WHERE id=u.id RETURNING * INTO u;
 RETURN to_jsonb(u);
END $$;

-- Completed payment is still a pending service transition: freeze target and
-- billing ownership, but allow normal account cancellation/deletion lifecycle.
CREATE FUNCTION public.guard_chat_texting_upgrade_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF ROW(NEW.name,NEW.business_type,NEW.business_type_other,NEW.website_url,NEW.phone_number,NEW.email,NEW.address,NEW.city,NEW.state,NEW.zip,
   NEW.has_ein,NEW.legal_business_name,NEW.business_entity_type,NEW.business_registration_state,NEW.ein,NEW.authorized_rep_name,NEW.authorized_rep_title,NEW.authorized_rep_email,NEW.authorized_rep_phone,
   NEW.use_case_description,NEW.estimated_monthly_volume,NEW.sample_messages,NEW.opt_in_description)
  IS DISTINCT FROM ROW(OLD.name,OLD.business_type,OLD.business_type_other,OLD.website_url,OLD.phone_number,OLD.email,OLD.address,OLD.city,OLD.state,OLD.zip,
   OLD.has_ein,OLD.legal_business_name,OLD.business_entity_type,OLD.business_registration_state,OLD.ein,OLD.authorized_rep_name,OLD.authorized_rep_title,OLD.authorized_rep_email,OLD.authorized_rep_phone,
   OLD.use_case_description,OLD.estimated_monthly_volume,OLD.sample_messages,OLD.opt_in_description)
  AND NEW.deleted_at IS NULL AND EXISTS(SELECT 1 FROM public.chat_texting_upgrades WHERE business_id=OLD.id AND state IN ('payment_pending','carrier_pending','support_required'))
  AND NOT EXISTS(SELECT 1 FROM public.chat_texting_upgrades WHERE business_id=OLD.id AND provider_copy_write_token IS NOT NULL)
  THEN RAISE EXCEPTION 'texting_upgrade_details_locked' USING ERRCODE='55000'; END IF;
 IF (NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.billing_mode IS DISTINCT FROM OLD.billing_mode
  OR NEW.partner_id IS DISTINCT FROM OLD.partner_id OR NEW.partner_plan IS DISTINCT FROM OLD.partner_plan
  OR NEW.billing_pilot IS DISTINCT FROM OLD.billing_pilot OR NEW.billing_comped IS DISTINCT FROM OLD.billing_comped OR NEW.billing_exempt IS DISTINCT FROM OLD.billing_exempt)
  AND EXISTS(SELECT 1 FROM public.chat_texting_upgrades WHERE business_id=OLD.id AND state IN ('payment_pending','carrier_pending','support_required'))
  AND NOT (NEW.owner_id IS NULL AND NEW.deleted_at IS NOT NULL AND NEW.cleanup_pii_scrubbed_at IS NOT NULL)
  THEN RAISE EXCEPTION 'texting_upgrade_authority_locked' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_chat_texting_upgrade_authority BEFORE UPDATE ON public.businesses FOR EACH ROW EXECUTE FUNCTION public.guard_chat_texting_upgrade_authority();

-- Campaign preparation derives the exact carrier-facing copy from validated
-- inputs. A private, transaction-local ledger marker permits only this RPC's
-- two-column write; neither API roles nor other transactions can forge it.
CREATE FUNCTION public.persist_chat_texting_upgrade_campaign_copy(p_business_id uuid,p_sample_messages text[],p_opt_in_description text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u public.chat_texting_upgrades; b public.businesses; s public.subscriptions;
BEGIN
 SELECT * INTO b FROM public.businesses WHERE id=p_business_id FOR UPDATE;
 SELECT * INTO u FROM public.chat_texting_upgrades WHERE business_id=p_business_id AND state<>'abandoned';
 IF u.id IS NULL OR u.state='activated' THEN RETURN false; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE business_id=p_business_id;
 IF u.paid_at IS NULL OR u.state<>'carrier_pending' OR b.deleted_at IS NOT NULL
  OR b.operations_suspended_at IS NOT NULL OR b.telnyx_submission_disabled OR b.onboarding_registration_status IS DISTINCT FROM 'submitting'
  OR s.status IS DISTINCT FROM 'active' OR s.cancel_at_period_end OR s.current_period_end<=now()
  OR s.stripe_subscription_id IS DISTINCT FROM u.source_subscription_id OR s.stripe_customer_id IS DISTINCT FROM u.source_customer_id
  OR s.plan IS DISTINCT FROM u.target_plan THEN RAISE EXCEPTION 'texting_upgrade_provider_write_forbidden'; END IF;
 IF (p_sample_messages IS NOT NULL AND cardinality(p_sample_messages) NOT BETWEEN 1 AND 5) OR NULLIF(btrim(p_opt_in_description),'') IS NULL
  OR EXISTS(SELECT 1 FROM unnest(p_sample_messages) v WHERE NULLIF(btrim(v),'') IS NULL)
  THEN RAISE EXCEPTION 'texting_upgrade_invalid_campaign_copy'; END IF;
 UPDATE public.chat_texting_upgrades SET provider_copy_write_token=gen_random_uuid() WHERE id=u.id;
 UPDATE public.businesses SET sample_messages=COALESCE(p_sample_messages,sample_messages),opt_in_description=p_opt_in_description WHERE id=p_business_id;
 UPDATE public.chat_texting_upgrades SET provider_copy_write_token=NULL WHERE id=u.id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.persist_chat_texting_upgrade_campaign_copy(uuid,text[],text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.persist_chat_texting_upgrade_campaign_copy(uuid,text[],text) TO service_role;

-- The existing actor-audited admin recheck can resume only assignment of an
-- already-owned number after staff has corrected carrier approval. It cannot
-- create resources, change the paid target, or authorize a new registration.
CREATE FUNCTION public.resume_chat_texting_upgrade_after_admin_recheck(p_business_id uuid,p_admin_event_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u public.chat_texting_upgrades; b public.businesses; s public.subscriptions;
BEGIN
 SELECT * INTO b FROM public.businesses WHERE id=p_business_id FOR UPDATE;
 SELECT * INTO u FROM public.chat_texting_upgrades WHERE business_id=p_business_id AND state<>'abandoned' FOR UPDATE;
 IF u.id IS NULL OR u.state='activated' THEN RETURN false; END IF;
 SELECT * INTO s FROM public.subscriptions WHERE business_id=p_business_id;
 IF u.state NOT IN ('carrier_pending','support_required') OR u.paid_at IS NULL
  OR NOT EXISTS(SELECT 1 FROM public.admin_action_events e WHERE e.id=p_admin_event_id AND e.business_id=p_business_id
   AND e.action='phone_assignment_recheck_requested' AND e.actor_admin_user_id IS NOT NULL
   -- MVCC can expose an uncommitted audit only to its own transaction. This
   -- includes subtransactions used by callers without accepting old events.
   AND e.created_at>=transaction_timestamp() AND pg_xact_status(e.xmin::text::xid8)='in progress')
  OR b.owner_id IS DISTINCT FROM u.owner_id OR b.deleted_at IS NOT NULL OR b.deletion_scheduled_for IS NOT NULL
  OR b.operations_suspended_at IS NOT NULL OR b.telnyx_submission_disabled OR b.billing_mode<>'stripe'
  OR b.partner_id IS NOT NULL OR b.partner_plan IS NOT NULL OR b.billing_pilot OR b.billing_comped OR b.billing_exempt
  OR b.active_telnyx_release_run_id IS NOT NULL OR b.telnyx_unique_claims_released_at IS NOT NULL
  OR b.telnyx_resource_state NOT IN ('provisioning','active')
  OR s.status IS DISTINCT FROM 'active' OR s.cancel_at_period_end OR s.current_period_start>now() OR s.current_period_end<=now()
  OR s.stripe_subscription_id IS DISTINCT FROM u.source_subscription_id OR s.stripe_customer_id IS DISTINCT FROM u.source_customer_id
  OR s.plan IS DISTINCT FROM u.target_plan OR public.get_business_effective_service_plan(p_business_id,s.plan)<>'chat_only'
  OR b.brand_status IS DISTINCT FROM 'approved' OR b.campaign_status IS DISTINCT FROM 'approved'
  OR NULLIF(btrim(b.telnyx_brand_id),'') IS NULL OR NULLIF(btrim(b.telnyx_campaign_id),'') IS NULL OR NULLIF(btrim(b.telnyx_messaging_profile_id),'') IS NULL
  OR (SELECT count(*) FROM public.phone_numbers WHERE business_id=p_business_id AND is_active)<>1
  OR NOT EXISTS(SELECT 1 FROM public.phone_numbers n WHERE n.business_id=p_business_id AND n.is_active AND n.resource_status='active'
   AND NULLIF(btrim(n.telnyx_phone_number_id),'') IS NOT NULL
   AND (n.telnyx_campaign_assignment_status IN ('failed','unassigned')
    OR (n.telnyx_campaign_assignment_status='pending' AND (n.telnyx_campaign_assignment_updated_at IS NULL OR n.telnyx_campaign_assignment_updated_at<=clock_timestamp()-interval '60 seconds'))
    OR (n.telnyx_campaign_assignment_status='assigned' AND n.telnyx_campaign_assignment_campaign_id=b.telnyx_campaign_id)))
  THEN RAISE EXCEPTION 'phone_assignment_recheck_unavailable' USING ERRCODE='55000'; END IF;
 UPDATE public.chat_texting_upgrades SET state='carrier_pending',support_reason=NULL,reconcile_after=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp()
  WHERE id=u.id AND state='support_required';
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.resume_chat_texting_upgrade_after_admin_recheck(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.resume_chat_texting_upgrade_after_admin_recheck(uuid,uuid) TO service_role;

DO $audited_support_recheck$
DECLARE definition text;
 eligibility text:='  IF v_active_phone_count <> 1 OR v_eligible_phone_count <> 1 THEN';
 audit_insert text:='  RETURNING id INTO v_event_id;';
BEGIN
 definition:=pg_get_functiondef('public.request_admin_phone_assignment_recheck(uuid,uuid)'::regprocedure);
 IF position(eligibility IN definition)=0 OR position(audit_insert IN definition)=0 THEN RAISE EXCEPTION 'migration_091_admin_recheck_definition_drift'; END IF;
 definition:=replace(definition,eligibility,$guard$
  IF v_active_phone_count <> 1 OR (v_eligible_phone_count <> 1 AND NOT EXISTS(
    SELECT 1 FROM public.chat_texting_upgrades u JOIN public.phone_numbers n ON n.business_id=u.business_id
    WHERE u.business_id=p_business_id AND u.state IN ('carrier_pending','support_required') AND u.paid_at IS NOT NULL
      AND n.is_active AND n.resource_status='active' AND NULLIF(btrim(n.telnyx_phone_number_id),'') IS NOT NULL
      AND (n.telnyx_campaign_assignment_status='unassigned'
        OR (n.telnyx_campaign_assignment_status='assigned' AND n.telnyx_campaign_assignment_campaign_id=v_business.telnyx_campaign_id))
  )) THEN
$guard$);
 definition:=replace(definition,audit_insert,audit_insert||E'\n  PERFORM public.resume_chat_texting_upgrade_after_admin_recheck(p_business_id,v_event_id);');
 EXECUTE definition;
END $audited_support_recheck$;

-- Ordinary paid SMS tier changes must wait until this service transition ends.
DO $ordinary_operations$
DECLARE definition text; needle text:='  SELECT * INTO s FROM public.subscriptions WHERE business_id=p_business_id;';
BEGIN
 definition:=pg_get_functiondef('public.acquire_sms_billing_operation(uuid,uuid,jsonb)'::regprocedure);
 IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'migration_091_operation_definition_drift'; END IF;
 EXECUTE replace(definition,needle,$guard$
  IF EXISTS(SELECT 1 FROM public.chat_texting_upgrades WHERE business_id=p_business_id AND state IN ('payment_pending','carrier_pending','support_required')) THEN RAISE EXCEPTION 'texting_upgrade_in_progress'; END IF;
$guard$||needle);
END $ordinary_operations$;

-- Resolve delivered service at existing SQL enforcement boundaries. Keep their
-- locks, status checks, hard limits, idempotency and existing function grants.
DO $effective_service$
DECLARE signature text; definition text; old text; replacement text; expected integer; actual integer;
BEGIN
 FOR signature,old,replacement,expected IN SELECT * FROM (VALUES
  ('public.get_current_ai_reply_usage(uuid)','v_plan := v_subscription.plan;','v_plan := public.get_business_effective_service_plan(p_business_id,v_subscription.plan);',1),
  ('public.reserve_ai_reply(uuid,text,text,text,uuid)','v_plan := v_subscription.plan;','v_plan := public.get_business_effective_service_plan(p_business_id,v_subscription.plan);',1),
  ('public.record_widget_offline_lead(uuid,text,text,text,text,text,text)','v_plan := v_subscription.plan;','v_plan := public.get_business_effective_service_plan(p_business_id,v_subscription.plan);',1),
  ('public.acquire_widget_request_capacity(uuid,text,text,text,text,integer,integer,integer,integer)','v_effective_plan := v_subscription.plan;','v_effective_plan := public.get_business_effective_service_plan(p_business_id,v_subscription.plan);',1),
  ('public.website_scan_has_ai_customization_entitlement(uuid)','subscription.plan IN (''chat_only'',''sms_and_chat'',''full'')','public.get_business_effective_service_plan(p_business_id,subscription.plan) IN (''chat_only'',''sms_and_chat'',''full'')',1),
  ('public.voice_action_allowed(uuid,text)','sub.plan','public.get_business_effective_service_plan(b.id,sub.plan)',4)
 ) AS changes(signature,old,replacement,expected)
 LOOP
  -- Resolve by name below when a stable entry point has a longer signature;
  -- ambiguity is an error rather than silently skipping enforcement.
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname=split_part(split_part(signature,'.',2),'(',1);
  actual:=(length(definition)-length(replace(definition,old,'')))/length(old);
  IF actual<>expected THEN RAISE EXCEPTION 'migration_091_effective_service_drift % expected % found %',signature,expected,actual; END IF;
  EXECUTE replace(definition,old,replacement);
 END LOOP;
 -- Voice projection/allowance records remain billing truth. Admission adds the
 -- delivered-service check without corrupting their paid-plan identity.
 SELECT pg_get_functiondef('public.voice_commercial_access_reason(uuid)'::regprocedure) INTO definition;
 old:='  IF p.plan IS DISTINCT FROM ''full'' THEN RETURN ''plan_required''; END IF;';
 IF position(old IN definition)=0 THEN RAISE EXCEPTION 'migration_091_voice_access_drift'; END IF;
 EXECUTE replace(definition,old,old||E'\n  IF public.get_business_effective_service_plan(p_business_id,p.plan)<>''full'' THEN RETURN ''billing_pending''; END IF;');
END $effective_service$;

-- Calendar provider recovery remains available after a later feature change;
-- only new booking side effects are stopped when Starter takes effect.
CREATE FUNCTION public.chat_texting_new_booking_allowed(p_business_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.chat_texting_upgrades WHERE business_id=p_business_id AND paid_at IS NOT NULL)
  OR public.website_scan_has_ai_customization_entitlement(p_business_id)
$$;
DO $calendar_service$
DECLARE name text; old text; replacement text; expected integer; actual integer; definition text;
BEGIN
 FOR name,old,replacement,expected IN SELECT * FROM (VALUES
  ('reserve_calendar_booking','    AND business.bookings_paused_at IS NULL',
    E'    AND business.bookings_paused_at IS NULL\n    AND public.chat_texting_new_booking_allowed(p_business_id)',1),
  ('mark_calendar_booking_submission_started','     OR v_business.bookings_paused_at IS NOT NULL THEN',
    E'     OR v_business.bookings_paused_at IS NOT NULL\n     OR NOT public.chat_texting_new_booking_allowed(p_business_id) THEN',1),
  ('acquire_calendar_provider_operation','AND business.operations_suspended_at IS NULL',
    E'AND business.operations_suspended_at IS NULL\n      AND (p_operation_kind<>''create'' OR public.chat_texting_new_booking_allowed(p_business_id))',2),
  ('mark_calendar_provider_submission_started','    OR v_business.operations_suspended_at IS NOT NULL',
    E'    OR v_business.operations_suspended_at IS NOT NULL\n    OR (v_operation.operation_kind=''create'' AND NOT public.chat_texting_new_booking_allowed(p_business_id))',1),
  ('claim_booking_draft',E'  IF EXISTS(SELECT 1 FROM public.booking_drafts WHERE conversation_id=d.conversation_id AND revision>d.revision)',
    E'  IF NOT public.chat_texting_new_booking_allowed(p_business_id) THEN RAISE EXCEPTION ''booking feature unavailable''; END IF;\n  IF EXISTS(SELECT 1 FROM public.booking_drafts WHERE conversation_id=d.conversation_id AND revision>d.revision)',1)
 ) AS changes(name,old,replacement,expected)
 LOOP
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=name;
  actual:=(length(definition)-length(replace(definition,old,'')))/length(old);
  IF actual<>expected THEN RAISE EXCEPTION 'migration_091_calendar_drift % expected % found %',name,expected,actual; END IF;
  EXECUTE replace(definition,old,replacement);
 END LOOP;
END $calendar_service$;
REVOKE ALL ON FUNCTION public.chat_texting_new_booking_allowed(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.track_chat_texting_operation_expiry() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.state='expired' AND OLD.state<>'expired' THEN
  UPDATE public.chat_texting_upgrades SET state='draft',revision=revision+1,updated_at=clock_timestamp()
   WHERE billing_operation_id=NEW.id AND paid_at IS NULL AND state='payment_pending';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER track_chat_texting_operation_expiry AFTER UPDATE OF state ON public.sms_billing_operations
 FOR EACH ROW EXECUTE FUNCTION public.track_chat_texting_operation_expiry();

CREATE FUNCTION public.claim_chat_texting_upgrade_reconciliation(p_limit integer DEFAULT 5,p_lease_seconds integer DEFAULT 120)
RETURNS SETOF public.chat_texting_upgrades LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_limit NOT BETWEEN 1 AND 25 OR p_lease_seconds NOT BETWEEN 30 AND 600 THEN RAISE EXCEPTION 'texting_upgrade_invalid_claim'; END IF;
 RETURN QUERY WITH due AS (
  SELECT u.id FROM public.chat_texting_upgrades u JOIN public.businesses b ON b.id=u.business_id
  WHERE u.state IN ('payment_pending','carrier_pending','support_required') AND u.reconcile_after<=clock_timestamp()
   AND (u.reconcile_claimed_at IS NULL OR u.reconcile_claimed_at<clock_timestamp()-make_interval(secs=>p_lease_seconds))
   AND b.deleted_at IS NULL ORDER BY u.reconcile_after,u.id LIMIT p_limit FOR UPDATE OF u SKIP LOCKED
 ) UPDATE public.chat_texting_upgrades u SET reconcile_after=clock_timestamp()+interval '5 minutes',reconcile_claimed_at=clock_timestamp()
  FROM due WHERE u.id=due.id RETURNING u.*;
END $$;
REVOKE ALL ON FUNCTION public.track_chat_texting_operation_expiry() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.claim_chat_texting_upgrade_reconciliation(integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_chat_texting_upgrade_reconciliation(integer,integer) TO service_role;

-- Keep the ledger until existing cancellation/retention guards have completed;
-- paid rows cascade only when their immutable billing operation is purged.
CREATE FUNCTION public.purge_chat_texting_upgrade_drafts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.cleanup_pii_scrubbed_at IS NOT NULL AND OLD.cleanup_pii_scrubbed_at IS NULL THEN
  DELETE FROM public.chat_texting_upgrades WHERE business_id=NEW.id AND paid_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM public.sms_billing_operations o WHERE o.id=billing_operation_id AND o.state IN ('confirming','pending','scheduled'));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER purge_chat_texting_upgrade_drafts AFTER UPDATE OF cleanup_pii_scrubbed_at ON public.businesses FOR EACH ROW EXECUTE FUNCTION public.purge_chat_texting_upgrade_drafts();

REVOKE ALL ON FUNCTION public.chat_texting_upgrade_source(uuid,uuid),public.chat_texting_upgrade_setup_fingerprint(uuid),public.chat_texting_upgrade_setup_ready(uuid),
 public.confirm_sms_billing_operation_before_chat_upgrade(uuid,uuid,text),public.finalize_paid_sms_billing_operation_before_chat_upgrade(uuid,jsonb,jsonb),
 public.infer_business_plan_family_before_chat_upgrade(uuid),public.guard_chat_texting_upgrade_authority(),public.purge_chat_texting_upgrade_drafts()
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.get_business_effective_service_plan(uuid,text),public.save_chat_texting_upgrade(uuid,uuid,text,boolean),
 public.save_chat_texting_upgrade_details(uuid,uuid,text,jsonb),public.acquire_chat_texting_upgrade_quote(uuid,uuid,jsonb),
 public.confirm_chat_texting_upgrade(uuid,uuid,uuid,text),public.finalize_chat_texting_upgrade_payment(uuid,jsonb),public.activate_chat_texting_upgrade(uuid),public.cancel_chat_texting_upgrade(uuid,uuid),
 public.confirm_sms_billing_operation(uuid,uuid,text),public.finalize_paid_sms_billing_operation(uuid,jsonb,jsonb),public.infer_business_plan_family(uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_business_effective_service_plan(uuid,text),public.save_chat_texting_upgrade(uuid,uuid,text,boolean),
 public.save_chat_texting_upgrade_details(uuid,uuid,text,jsonb),public.acquire_chat_texting_upgrade_quote(uuid,uuid,jsonb),
 public.confirm_chat_texting_upgrade(uuid,uuid,uuid,text),public.finalize_chat_texting_upgrade_payment(uuid,jsonb),public.activate_chat_texting_upgrade(uuid),public.cancel_chat_texting_upgrade(uuid,uuid),
 public.confirm_sms_billing_operation(uuid,uuid,text),public.finalize_paid_sms_billing_operation(uuid,jsonb,jsonb),public.infer_business_plan_family(uuid)
 TO service_role;
COMMIT;
