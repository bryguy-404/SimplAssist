BEGIN;
-- A candidate lives beside the working campaign until its number assignment is
-- verified. Billing keeps its separate paid-conversion ledger in migration112.
CREATE TABLE public.review_texting_provider_upgrades (
 upgrade_id uuid PRIMARY KEY REFERENCES public.chat_texting_upgrades(id) ON DELETE CASCADE,
 business_id uuid NOT NULL REFERENCES public.businesses(id),owner_id uuid NOT NULL REFERENCES auth.users(id),
 review_account_id uuid NOT NULL REFERENCES public.review_sms_accounts(id) ON DELETE CASCADE,
 stage text NOT NULL DEFAULT 'prepared' CHECK(stage IN ('prepared','submitting','carrier_pending','approved','moving','review_ready','support_required')),
 source_campaign_id text NOT NULL,candidate_campaign_id text UNIQUE,brand_id text NOT NULL,messaging_profile_id text NOT NULL,
 voice_application_id text,phone_number_id uuid NOT NULL REFERENCES public.phone_numbers(id),phone_number text NOT NULL,
 filing jsonb NOT NULL,filing_hash text NOT NULL,owner_accepted_at timestamptz NOT NULL DEFAULT now(),
 claim_token uuid,lease_until timestamptz,submission_attempted_at timestamptz,assignment_attempted_at timestamptz,
 handoff_token uuid,handoff_requested_at timestamptz,handoff_completed_at timestamptz,approval_evidence jsonb,
 retirement_state text NOT NULL DEFAULT 'pending' CHECK(retirement_state IN ('pending','submitting','unknown','done')),
 retirement_target text,last_error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(candidate_campaign_id IS NULL OR candidate_campaign_id<>source_campaign_id),
 CHECK(filing_hash ~ '^[a-f0-9]{64}$'),CHECK(phone_number ~ '^\+1[2-9][0-9]{9}$')
);
ALTER TABLE public.review_texting_provider_upgrades ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.review_texting_provider_upgrades FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.review_texting_provider_upgrades TO service_role;

CREATE FUNCTION public.review_texting_upgrade_sms_paused(p_business uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM review_texting_provider_upgrades WHERE business_id=p_business
  AND handoff_requested_at IS NOT NULL AND handoff_completed_at IS NULL
  AND (stage='moving' OR assignment_attempted_at IS NOT NULL))
$$;
CREATE FUNCTION public.review_texting_upgrade_release_held(p_business uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM review_texting_provider_upgrades WHERE business_id=p_business
  AND (retirement_state<>'done' OR stage='moving'))
$$;

-- Normal account scrub removes the completed proposal and its contact copy.
-- It cannot erase the only authority for an unresolved provider operation.
CREATE FUNCTION public.guard_review_texting_provider_cleanup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF review_texting_upgrade_release_held(OLD.business_id) THEN RAISE EXCEPTION 'review_upgrade_cleanup_pending' USING ERRCODE='55000'; END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER guard_review_texting_provider_cleanup BEFORE DELETE ON public.review_sms_accounts
FOR EACH ROW EXECUTE FUNCTION public.guard_review_texting_provider_cleanup();

-- This proof intentionally does not depend on current payment status. A paid
-- conversion must still be recorded when cancellation races its webhook.
CREATE OR REPLACE FUNCTION public.review_texting_upgrade_provider_ready(p_upgrade_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM review_texting_provider_upgrades p
 JOIN chat_texting_upgrades u ON u.id=p.upgrade_id AND u.source_mode='review_sms' AND u.source_review_account_id=p.review_account_id
 JOIN businesses b ON b.id=p.business_id AND b.owner_id=p.owner_id
 JOIN review_sms_accounts a ON a.id=p.review_account_id AND a.business_id=b.id AND a.owner_id=b.owner_id
 JOIN phone_numbers pn ON pn.id=p.phone_number_id AND pn.business_id=b.id
 WHERE p.upgrade_id=p_upgrade_id AND p.stage='review_ready' AND p.handoff_completed_at IS NOT NULL
 AND p.candidate_campaign_id=b.telnyx_campaign_id AND a.campaign_id=b.telnyx_campaign_id
 AND p.brand_id=b.telnyx_brand_id AND p.messaging_profile_id=b.telnyx_messaging_profile_id
 AND a.messaging_profile_id=p.messaging_profile_id AND a.phone_number_id=pn.id
 AND pn.phone_number=p.phone_number AND pn.is_active AND pn.telnyx_campaign_assignment_status='assigned'
 AND pn.telnyx_campaign_assignment_campaign_id=p.candidate_campaign_id
 AND p.approval_evidence->>'campaignId'=p.candidate_campaign_id
 AND p.approval_evidence->>'filingHash'=p.filing_hash)
$$;

CREATE FUNCTION public.review_texting_provider_owned(p_upgrade uuid,p_forbidden_profiles text[],p_require_paid boolean DEFAULT true)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT
  b.owner_id=u.owner_id AND b.deleted_at IS NULL AND b.operations_suspended_at IS NULL
  AND b.billing_mode='stripe' AND b.partner_id IS NULL AND b.partner_plan IS NULL
  AND NOT b.billing_pilot AND NOT b.billing_comped AND NOT b.billing_exempt
  AND b.onboarding_completed_at IS NOT NULL
  AND NOT b.telnyx_submission_disabled AND b.active_telnyx_release_run_id IS NULL
  AND u.source_mode='review_sms' AND u.target_plan='sms_and_chat'
  AND a.owner_id=u.owner_id AND a.business_id=u.business_id AND a.id=u.source_review_account_id
  AND a.messaging_profile_id=b.telnyx_messaging_profile_id AND a.campaign_id=b.telnyx_campaign_id
  AND a.brand_id=b.telnyx_brand_id AND pn.id=a.phone_number_id AND pn.business_id=b.id AND pn.is_active
  AND coalesce(cardinality(p_forbidden_profiles),0)>0 AND NOT b.telnyx_messaging_profile_id=ANY(p_forbidden_profiles)
  AND NOT EXISTS(SELECT 1 FROM telnyx_release_protections r WHERE (r.scope='business_all' AND r.business_id=b.id)
   OR (r.scope='resource' AND (r.provider_id IN (b.telnyx_brand_id,b.telnyx_campaign_id,b.telnyx_messaging_profile_id,pn.telnyx_phone_number_id) OR r.canonical_e164=pn.phone_number)))
  AND review_sms_resource_scope_safe(b.id,b.telnyx_messaging_profile_id,pn.phone_number,b.telnyx_campaign_id,p_forbidden_profiles)
  AND (NOT p_require_paid OR (b.deletion_scheduled_for IS NULL AND review_sms_owns_plan_family_resources(b.id)
   AND u.state='draft' AND u.paid_at IS NULL AND a.billing_source='direct' AND a.state='active'
   AND a.cancel_at IS NULL AND a.stripe_item_id=u.source_review_item_id AND a.paid_period_end>now()
   AND s.plan='chat_only' AND s.status='active' AND NOT s.cancel_at_period_end AND s.pending_plan IS NULL
   AND s.current_period_end>now() AND s.stripe_subscription_id=u.source_subscription_id AND s.stripe_customer_id=u.source_customer_id))
 FROM chat_texting_upgrades u JOIN businesses b ON b.id=u.business_id
 JOIN review_sms_accounts a ON a.id=u.source_review_account_id JOIN phone_numbers pn ON pn.id=a.phone_number_id
 JOIN subscriptions s ON s.business_id=b.id WHERE u.id=p_upgrade),false)
$$;

CREATE FUNCTION public.review_texting_provider_prepare(p_business uuid,p_owner uuid,p_filing jsonb,p_hash text,p_forbidden_profiles text[])
RETURNS public.review_texting_provider_upgrades LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE u chat_texting_upgrades;b businesses;a review_sms_accounts;pn phone_numbers;p review_texting_provider_upgrades;
BEGIN
 PERFORM review_assert_owner(p_business,p_owner);
 SELECT * INTO u FROM chat_texting_upgrades WHERE business_id=p_business AND source_mode='review_sms' AND state<>'abandoned' FOR UPDATE;
 IF u.id IS NULL OR NOT review_texting_provider_owned(u.id,p_forbidden_profiles) THEN RAISE EXCEPTION 'review_upgrade_source_changed'; END IF;
 SELECT * INTO p FROM review_texting_provider_upgrades WHERE upgrade_id=u.id;
 IF FOUND THEN RETURN p; END IF;
 IF EXISTS(SELECT 1 FROM review_texting_provider_upgrades WHERE business_id=p_business AND upgrade_id<>u.id AND retirement_state<>'done') THEN RAISE EXCEPTION 'review_upgrade_support_required'; END IF;
 SELECT * INTO b FROM businesses WHERE id=p_business;
 SELECT * INTO a FROM review_sms_accounts WHERE id=u.source_review_account_id;
 SELECT * INTO pn FROM phone_numbers WHERE id=a.phone_number_id;
 IF a.draft->>'consentMode' IS DISTINCT FROM 'hosted_keyword' OR pn.telnyx_campaign_assignment_status IS DISTINCT FROM 'assigned'
  OR pn.telnyx_campaign_assignment_campaign_id IS DISTINCT FROM b.telnyx_campaign_id
  OR p_filing->>'usecase' IS DISTINCT FROM 'MIXED' OR p_filing->'subUsecases' IS DISTINCT FROM '["CUSTOMER_CARE","MARKETING"]'::jsonb
  OR p_filing->>'referenceId' IS DISTINCT FROM 'upgrade:'||u.id::text OR p_filing->>'brandId' IS DISTINCT FROM b.telnyx_brand_id
  OR p_filing->>'optinKeywords' IS DISTINCT FROM 'REVIEWS' OR p_filing->>'embeddedLink' IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'review_upgrade_filing_invalid'; END IF;
 INSERT INTO review_texting_provider_upgrades(upgrade_id,business_id,owner_id,review_account_id,source_campaign_id,brand_id,messaging_profile_id,voice_application_id,phone_number_id,phone_number,filing,filing_hash)
 VALUES(u.id,p_business,p_owner,a.id,b.telnyx_campaign_id,b.telnyx_brand_id,b.telnyx_messaging_profile_id,b.telnyx_voice_application_id,pn.id,pn.phone_number,p_filing,p_hash) RETURNING * INTO p;
 RETURN p;
END $$;

CREATE FUNCTION public.review_texting_provider_claim(p_upgrade uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE token uuid:=gen_random_uuid();bid uuid;
BEGIN
 SELECT business_id INTO bid FROM review_texting_provider_upgrades WHERE upgrade_id=p_upgrade;
 PERFORM 1 FROM businesses WHERE id=bid FOR UPDATE;
 UPDATE review_texting_provider_upgrades SET claim_token=token,lease_until=now()+interval '2 minutes',updated_at=now()
 WHERE upgrade_id=p_upgrade AND (lease_until IS NULL OR lease_until<=now());
 RETURN CASE WHEN FOUND THEN token ELSE NULL END;
END $$;

CREATE FUNCTION public.review_texting_provider_request_move(p_upgrade uuid,p_owner uuid,p_forbidden_profiles text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p review_texting_provider_upgrades;b businesses;
BEGIN
 SELECT business_id INTO b.id FROM review_texting_provider_upgrades WHERE upgrade_id=p_upgrade;
 PERFORM review_assert_owner(b.id,p_owner);
 SELECT * INTO b FROM businesses WHERE id=b.id FOR UPDATE;
 SELECT * INTO p FROM review_texting_provider_upgrades WHERE upgrade_id=p_upgrade FOR UPDATE;
 IF p.stage='moving' THEN RETURN; END IF;
 IF p.upgrade_id IS NULL OR p.stage IS DISTINCT FROM 'approved' OR p.owner_id IS DISTINCT FROM p_owner OR NOT review_texting_provider_owned(p_upgrade,p_forbidden_profiles)
  OR b.telnyx_campaign_id<>p.source_campaign_id OR p.candidate_campaign_id IS NULL THEN RAISE EXCEPTION 'review_upgrade_not_ready'; END IF;
 IF (b.telnyx_campaign_assignment_claim_token IS NOT NULL AND (b.telnyx_campaign_assignment_claimed_at IS NULL OR b.telnyx_campaign_assignment_claimed_at>now()-interval '2 minutes'))
  OR EXISTS(SELECT 1 FROM tenant_sms_sends WHERE business_id=b.id AND status='submitting')
  OR EXISTS(SELECT 1 FROM review_sms_outbox WHERE business_id=b.id AND status='submitting')
 THEN RAISE EXCEPTION 'review_upgrade_sender_busy'; END IF;
 UPDATE review_texting_provider_upgrades SET stage='moving',handoff_token=gen_random_uuid(),handoff_requested_at=now(),assignment_attempted_at=NULL,last_error=NULL,updated_at=now()
 WHERE upgrade_id=p_upgrade RETURNING * INTO p;
 UPDATE businesses SET telnyx_campaign_assignment_claim_token=p.handoff_token,telnyx_campaign_assignment_claimed_at=now(),
  telnyx_campaign_assignment_claim_campaign_id=p.candidate_campaign_id,telnyx_campaign_assignment_claim_profile_id=p.messaging_profile_id WHERE id=b.id;
END $$;

CREATE FUNCTION public.review_texting_provider_authorize(p_upgrade uuid,p_claim uuid,p_operation text,p_forbidden_profiles text[]) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p review_texting_provider_upgrades;b businesses;
BEGIN
 SELECT business_id INTO b.id FROM review_texting_provider_upgrades WHERE upgrade_id=p_upgrade;
 SELECT * INTO b FROM businesses WHERE id=b.id FOR UPDATE;
 SELECT * INTO p FROM review_texting_provider_upgrades WHERE upgrade_id=p_upgrade FOR UPDATE;
 IF p.upgrade_id IS NULL OR p.claim_token IS DISTINCT FROM p_claim OR p_claim IS NULL OR p.lease_until IS NULL OR p.lease_until<=now()
  OR NOT review_texting_provider_owned(p_upgrade,p_forbidden_profiles,p_operation IN ('submit','move'))
  OR p.messaging_profile_id<>b.telnyx_messaging_profile_id OR p.brand_id<>b.telnyx_brand_id
 THEN RETURN false; END IF;
 IF p_operation='submit' AND p.stage='prepared' AND p.submission_attempted_at IS NULL AND p.candidate_campaign_id IS NULL THEN
  UPDATE review_texting_provider_upgrades SET stage='submitting',submission_attempted_at=now() WHERE upgrade_id=p_upgrade;RETURN true;
 ELSIF p_operation='move' AND p.stage='moving' AND p.assignment_attempted_at IS NULL AND p.handoff_requested_at IS NOT NULL
  AND p.candidate_campaign_id IS NOT NULL AND b.telnyx_campaign_id=p.source_campaign_id THEN
  UPDATE review_texting_provider_upgrades SET assignment_attempted_at=now() WHERE upgrade_id=p_upgrade;RETURN true;
 ELSIF p_operation='retire' AND p.stage='review_ready' AND p.retirement_state='pending' AND review_texting_upgrade_provider_ready(p_upgrade)
  AND NOT EXISTS(SELECT 1 FROM businesses other WHERE other.id<>b.id AND other.telnyx_campaign_id=p.source_campaign_id)
  AND NOT EXISTS(SELECT 1 FROM telnyx_managed_resources r WHERE r.business_id<>b.id AND r.local_claim_active AND r.provider_id=p.source_campaign_id)
  AND NOT EXISTS(SELECT 1 FROM telnyx_release_protections r WHERE r.provider_id=p.source_campaign_id) THEN
  UPDATE review_texting_provider_upgrades SET retirement_state='submitting',retirement_target=p.source_campaign_id WHERE upgrade_id=p_upgrade;RETURN true;
 END IF;
 RETURN false;
END $$;

CREATE FUNCTION public.review_texting_provider_record(p_upgrade uuid,p_claim uuid,p_event text,p_evidence jsonb DEFAULT '{}') RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p review_texting_provider_upgrades;b businesses;candidate text;
BEGIN
 SELECT business_id INTO b.id FROM review_texting_provider_upgrades WHERE upgrade_id=p_upgrade;
 SELECT * INTO b FROM businesses WHERE id=b.id FOR UPDATE;
 SELECT * INTO p FROM review_texting_provider_upgrades WHERE upgrade_id=p_upgrade FOR UPDATE;
 IF p.upgrade_id IS NULL OR p_claim IS NULL OR p.claim_token IS DISTINCT FROM p_claim OR p.lease_until IS NULL OR p.lease_until<=now() OR p.owner_id IS DISTINCT FROM b.owner_id THEN RAISE EXCEPTION 'review_upgrade_lease_lost'; END IF;
 IF p_event='submitted' AND p.stage IN ('prepared','submitting','carrier_pending') THEN
  candidate:=p_evidence->>'campaignId';
  IF candidate IS NULL OR candidate=p.source_campaign_id OR (p.candidate_campaign_id IS NOT NULL AND p.candidate_campaign_id<>candidate)
   OR EXISTS(SELECT 1 FROM businesses other WHERE other.id<>b.id AND other.telnyx_campaign_id=candidate)
   OR EXISTS(SELECT 1 FROM telnyx_managed_resources r WHERE r.business_id<>b.id AND r.local_claim_active AND r.provider_id=candidate)
   THEN RAISE EXCEPTION 'review_upgrade_candidate_conflict'; END IF;
  UPDATE review_texting_provider_upgrades SET stage='carrier_pending',candidate_campaign_id=candidate,last_error=NULL WHERE upgrade_id=p_upgrade;
  INSERT INTO telnyx_managed_resources(business_id,resource_type,provider_id,provider_origin)
   SELECT b.id,'campaign',candidate,'created_by_simplassist'
   WHERE NOT EXISTS(SELECT 1 FROM telnyx_managed_resources WHERE business_id=b.id AND resource_type='campaign' AND provider_id=candidate AND local_claim_active);
 ELSIF p_event='approved' AND p.stage IN ('carrier_pending','approved') THEN
  IF p_evidence->>'campaignId' IS DISTINCT FROM p.candidate_campaign_id OR p_evidence->>'filingHash' IS DISTINCT FROM p.filing_hash
   OR p_evidence->>'brandId' IS DISTINCT FROM p.brand_id OR p_evidence->>'status' IS DISTINCT FROM 'approved' THEN RAISE EXCEPTION 'review_upgrade_approval_invalid'; END IF;
  UPDATE review_texting_provider_upgrades SET stage='approved',approval_evidence=p_evidence,last_error=NULL WHERE upgrade_id=p_upgrade;
 ELSIF p_event='bound' AND p.stage='moving' THEN
  IF p_evidence->>'campaignId' IS DISTINCT FROM p.candidate_campaign_id OR p_evidence->>'phoneNumber' IS DISTINCT FROM p.phone_number
   OR p_evidence->>'assignmentStatus' IS DISTINCT FROM 'ASSIGNED' OR b.telnyx_campaign_id IS DISTINCT FROM p.source_campaign_id
   OR b.telnyx_messaging_profile_id IS DISTINCT FROM p.messaging_profile_id OR b.telnyx_brand_id IS DISTINCT FROM p.brand_id
   OR NOT EXISTS(SELECT 1 FROM review_sms_accounts a WHERE a.id=p.review_account_id AND a.owner_id=b.owner_id AND a.campaign_id=p.source_campaign_id AND a.phone_number_id=p.phone_number_id)
   OR NOT EXISTS(SELECT 1 FROM phone_numbers pn WHERE pn.id=p.phone_number_id AND pn.business_id=b.id AND pn.phone_number=p.phone_number AND pn.is_active)
   THEN RAISE EXCEPTION 'review_upgrade_handoff_changed'; END IF;
  UPDATE review_texting_provider_upgrades SET stage='review_ready',handoff_completed_at=now(),last_error=NULL WHERE upgrade_id=p_upgrade;
  -- The existing lifecycle trigger requires the claim to be cleared before
  -- changing its campaign. Both writes remain under this transaction's lock.
  UPDATE businesses SET telnyx_campaign_assignment_claim_token=NULL,telnyx_campaign_assignment_claimed_at=NULL,telnyx_campaign_assignment_claim_campaign_id=NULL,telnyx_campaign_assignment_claim_profile_id=NULL WHERE id=b.id;
  UPDATE businesses SET telnyx_campaign_id=p.candidate_campaign_id,campaign_status='approved' WHERE id=b.id;
  UPDATE phone_numbers SET telnyx_campaign_assignment_campaign_id=p.candidate_campaign_id,telnyx_campaign_assignment_status='assigned',telnyx_campaign_assignment_task_id=NULL,
   telnyx_campaign_assignment_failure_reason=NULL,telnyx_campaign_assignment_updated_at=now(),telnyx_campaign_assigned_at=now() WHERE id=p.phone_number_id;
  UPDATE review_sms_accounts SET campaign_id=p.candidate_campaign_id,review_usecase_approved_at=now(),approval_evidence='verified upgrade '||p.upgrade_id||' filing '||p.filing_hash,last_error=NULL,updated_at=now() WHERE id=p.review_account_id;
  UPDATE telnyx_managed_resources SET ownership_state='managed_releaseable',verified_at=now(),verified_by='review-upgrade:'||p.upgrade_id,updated_at=now()
   WHERE business_id=b.id AND resource_type='campaign' AND provider_id=p.candidate_campaign_id AND provider_origin='created_by_simplassist' AND ownership_state='unverified_hold';
 ELSIF p_event='retired' AND p.retirement_state='submitting' THEN
  UPDATE review_texting_provider_upgrades SET retirement_state='done',last_error=NULL WHERE upgrade_id=p_upgrade;
  UPDATE telnyx_managed_resources SET ownership_state='released',local_claim_active=false,released_at=now(),updated_at=now() WHERE business_id=b.id AND resource_type='campaign' AND provider_id=p.source_campaign_id;
 ELSIF p_event='retirement_unknown' AND p.retirement_state='submitting' THEN
  UPDATE review_texting_provider_upgrades SET retirement_state='unknown',last_error='review_upgrade_retirement_unknown' WHERE upgrade_id=p_upgrade;
 ELSIF p_event='support' THEN
  UPDATE review_texting_provider_upgrades SET stage=CASE WHEN stage='moving' THEN stage ELSE 'support_required' END,last_error=coalesce(p_evidence->>'reason','review_upgrade_support_required') WHERE upgrade_id=p_upgrade;
 ELSIF p_event='release_claim' THEN NULL;
 ELSE RAISE EXCEPTION 'review_upgrade_transition_invalid'; END IF;
 UPDATE review_texting_provider_upgrades SET updated_at=now() WHERE upgrade_id=p_upgrade;
 IF p_event='release_claim' THEN UPDATE review_texting_provider_upgrades SET claim_token=NULL,lease_until=NULL WHERE upgrade_id=p_upgrade; END IF;
END $$;

CREATE FUNCTION public.review_texting_retire_permit(p_upgrade uuid,p_claim uuid,p_campaign text,p_forbidden_profiles text[]) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM review_texting_provider_upgrades WHERE upgrade_id=p_upgrade AND source_campaign_id=p_campaign) THEN RETURN false; END IF;
 RETURN review_texting_provider_authorize(p_upgrade,p_claim,'retire',p_forbidden_profiles);
END $$;

-- Protect the transition against ordinary assignment/recovery workers.
CREATE FUNCTION public.guard_review_texting_handoff() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p review_texting_provider_upgrades;
BEGIN
 SELECT * INTO p FROM review_texting_provider_upgrades WHERE business_id=OLD.id AND stage='moving' LIMIT 1;
 IF FOUND AND (NEW.telnyx_campaign_id IS DISTINCT FROM OLD.telnyx_campaign_id OR NEW.telnyx_messaging_profile_id IS DISTINCT FROM OLD.telnyx_messaging_profile_id
  OR NEW.telnyx_brand_id IS DISTINCT FROM OLD.telnyx_brand_id OR NEW.telnyx_voice_application_id IS DISTINCT FROM OLD.telnyx_voice_application_id
  OR NEW.telnyx_campaign_assignment_claim_token IS DISTINCT FROM p.handoff_token) THEN RAISE EXCEPTION 'review_upgrade_handoff_in_progress'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_review_texting_handoff BEFORE UPDATE OF telnyx_campaign_id,telnyx_messaging_profile_id,telnyx_brand_id,telnyx_voice_application_id,telnyx_campaign_assignment_claim_token ON public.businesses FOR EACH ROW EXECUTE FUNCTION public.guard_review_texting_handoff();

ALTER FUNCTION public.reserve_tenant_sms(uuid,uuid,text,text,text,text,text,text,integer,uuid,uuid) RENAME TO reserve_tenant_sms_before_review_handoff;
CREATE FUNCTION public.reserve_tenant_sms(p_business uuid,p_period uuid,p_key text,p_fingerprint text,p_purpose text,p_profile text,p_from text,p_to text,p_parts integer,p_conversation uuid DEFAULT NULL,p_enrollment uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM businesses WHERE id=p_business FOR UPDATE;
 IF review_texting_upgrade_sms_paused(p_business) AND NOT EXISTS(SELECT 1 FROM tenant_sms_sends WHERE business_id=p_business AND idempotency_key=p_key) THEN RAISE EXCEPTION 'sms_upgrade_handoff_pending'; END IF;
 RETURN reserve_tenant_sms_before_review_handoff(p_business,p_period,p_key,p_fingerprint,p_purpose,p_profile,p_from,p_to,p_parts,p_conversation,p_enrollment);
END $$;
ALTER FUNCTION public.review_begin_sms(uuid,uuid) RENAME TO review_begin_sms_before_handoff;
CREATE FUNCTION public.review_begin_sms(p_id uuid,p_claim uuid) RETURNS public.review_sms_outbox LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE bid uuid;
BEGIN
 SELECT business_id INTO bid FROM review_sms_outbox WHERE id=p_id;
 PERFORM 1 FROM businesses WHERE id=bid FOR UPDATE;
 IF review_texting_upgrade_sms_paused(bid) THEN
  UPDATE review_sms_outbox SET status='pending',next_attempt_at=now()+interval '5 minutes',claim_token=NULL,lease_until=NULL WHERE id=p_id AND status='claimed' AND claim_token=p_claim;
  RETURN NULL;
 END IF;
 RETURN review_begin_sms_before_handoff(p_id,p_claim);
END $$;

ALTER FUNCTION public.review_sms_prepare_release(uuid) RENAME TO review_sms_prepare_release_before_upgrade;
CREATE FUNCTION public.review_sms_prepare_release(p_business uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM businesses WHERE id=p_business FOR UPDATE;
 IF review_texting_upgrade_release_held(p_business) THEN RETURN false; END IF;
 RETURN review_sms_prepare_release_before_upgrade(p_business);
END $$;
ALTER FUNCTION public.authorize_review_sms_remote_mutation(uuid,text,text,text,uuid,uuid,text,text) RENAME TO authorize_review_sms_remote_mutation_before_upgrade;
CREATE FUNCTION public.authorize_review_sms_remote_mutation(p_business_id uuid,p_context text,p_operation text,p_provider_id text,p_action_id uuid,p_lease_token uuid,p_expected_shared_messaging_profile_id text,p_expected_shared_voice_application_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM businesses WHERE id=p_business_id FOR UPDATE;
 IF review_texting_upgrade_release_held(p_business_id) THEN RAISE EXCEPTION 'review_upgrade_release_held'; END IF;
 RETURN authorize_review_sms_remote_mutation_before_upgrade(p_business_id,p_context,p_operation,p_provider_id,p_action_id,p_lease_token,p_expected_shared_messaging_profile_id,p_expected_shared_voice_application_id);
END $$;
ALTER FUNCTION public.authorize_telnyx_remote_mutation(uuid,text,text,text,uuid,uuid,text,text) RENAME TO authorize_telnyx_remote_mutation_before_review_upgrade;
CREATE FUNCTION public.authorize_telnyx_remote_mutation(p_business_id uuid,p_context text,p_operation text,p_provider_id text,p_action_id uuid,p_lease_token uuid,p_expected_shared_messaging_profile_id text,p_expected_shared_voice_application_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM businesses WHERE id=p_business_id FOR UPDATE;
 IF review_texting_upgrade_release_held(p_business_id) THEN RAISE EXCEPTION 'review_upgrade_release_held'; END IF;
 RETURN authorize_telnyx_remote_mutation_before_review_upgrade(p_business_id,p_context,p_operation,p_provider_id,p_action_id,p_lease_token,p_expected_shared_messaging_profile_id,p_expected_shared_voice_application_id);
END $$;

-- The retired campaign remains claimed until deletion is confirmed, but cannot
-- turn a still-paid Chat review account into the broader SMS plan family.
ALTER FUNCTION public.review_sms_owns_plan_family_resources(uuid) RENAME TO review_sms_owns_plan_family_resources_before_upgrade;
CREATE FUNCTION public.review_sms_owns_plan_family_resources(p_business uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT review_sms_owns_plan_family_resources_before_upgrade(p_business) OR EXISTS(
 SELECT 1 FROM review_texting_provider_upgrades p JOIN businesses b ON b.id=p.business_id
 JOIN review_sms_accounts a ON a.id=p.review_account_id AND a.owner_id=b.owner_id
 JOIN subscriptions s ON s.business_id=b.id JOIN business_plan_family_locks f ON f.business_id=b.id
 WHERE b.id=p_business AND a.billing_source='direct' AND a.exclusive_resources AND a.activation_paid_at IS NOT NULL AND a.activation_refunded_at IS NULL
 AND s.plan='chat_only' AND f.family='chat_only' AND s.stripe_subscription_id=a.source_subscription_id AND s.stripe_customer_id=a.source_customer_id
 AND p.owner_id=b.owner_id AND p.brand_id=b.telnyx_brand_id AND a.brand_id=p.brand_id AND a.campaign_id=b.telnyx_campaign_id
 AND b.telnyx_campaign_id IN (p.source_campaign_id,p.candidate_campaign_id)
 AND p.messaging_profile_id=b.telnyx_messaging_profile_id AND a.messaging_profile_id=p.messaging_profile_id
 AND p.voice_application_id IS NOT DISTINCT FROM b.telnyx_voice_application_id AND a.voice_application_id IS NOT DISTINCT FROM p.voice_application_id
 AND a.phone_number_id=p.phone_number_id
 AND NOT EXISTS(SELECT 1 FROM phone_numbers pn WHERE pn.business_id=b.id AND pn.resource_status<>'released' AND pn.id<>p.phone_number_id)
 AND NOT EXISTS(SELECT 1 FROM telnyx_managed_resources r WHERE r.business_id=b.id AND r.local_claim_active AND r.ownership_state<>'released'
  AND NOT coalesce(CASE r.resource_type WHEN 'campaign' THEN r.provider_id IN (p.source_campaign_id,p.candidate_campaign_id)
   WHEN 'brand' THEN r.provider_id=p.brand_id WHEN 'messaging_profile' THEN r.provider_id=p.messaging_profile_id WHEN 'voice_application' THEN r.provider_id=p.voice_application_id
   WHEN 'phone_number' THEN r.phone_number_id=p.phone_number_id AND EXISTS(SELECT 1 FROM phone_numbers pn WHERE pn.id=p.phone_number_id AND pn.telnyx_phone_number_id=r.provider_id AND pn.phone_number=r.canonical_e164) ELSE false END,false))
 AND NOT EXISTS(SELECT 1 FROM businesses other WHERE other.id<>b.id AND other.telnyx_unique_claims_released_at IS NULL AND (other.telnyx_campaign_id IN (p.source_campaign_id,p.candidate_campaign_id)
  OR other.telnyx_messaging_profile_id=p.messaging_profile_id OR other.telnyx_brand_id=p.brand_id OR other.telnyx_voice_application_id=p.voice_application_id))
 AND NOT EXISTS(SELECT 1 FROM telnyx_managed_resources r WHERE r.business_id<>b.id AND r.local_claim_active AND r.ownership_state<>'released'
  AND (r.provider_id IN (p.source_campaign_id,p.candidate_campaign_id,p.brand_id,p.messaging_profile_id,p.voice_application_id) OR r.canonical_e164=p.phone_number)))
$$;

-- Cancellation cannot race an unresolved assignment. Abandoning a paid or
-- uncertain candidate retains its scoped support hold; this workflow is not
-- authorized to delete that candidate or any shared provider resource.
ALTER FUNCTION public.cancel_chat_texting_upgrade(uuid,uuid) RENAME TO cancel_chat_texting_upgrade_before_review_provider;
CREATE FUNCTION public.cancel_chat_texting_upgrade(p_upgrade_id uuid,p_owner_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE u chat_texting_upgrades;p review_texting_provider_upgrades;result jsonb;
BEGIN
 u:=chat_texting_upgrade_source(p_upgrade_id,p_owner_id);
 IF u.source_mode='review_sms' AND review_texting_upgrade_sms_paused(u.business_id) THEN RAISE EXCEPTION 'texting_upgrade_handoff_in_progress'; END IF;
 result:=cancel_chat_texting_upgrade_before_review_provider(p_upgrade_id,p_owner_id);
 SELECT * INTO p FROM review_texting_provider_upgrades WHERE upgrade_id=u.id FOR UPDATE;
 IF FOUND AND p.handoff_completed_at IS NULL THEN
  UPDATE review_texting_provider_upgrades SET stage='support_required',
   retirement_state=CASE WHEN submission_attempted_at IS NULL AND candidate_campaign_id IS NULL THEN 'done' ELSE retirement_state END,
   last_error=CASE WHEN submission_attempted_at IS NULL AND candidate_campaign_id IS NULL THEN 'review_upgrade_abandoned_before_submission' ELSE 'review_upgrade_unused_candidate_support' END,
   updated_at=now() WHERE upgrade_id=u.id;
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.cancel_chat_texting_upgrade_before_review_provider(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.cancel_chat_texting_upgrade(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_chat_texting_upgrade(uuid,uuid) TO service_role;

-- A handoff may take days. Persist recovery progress and allow only the exact
-- signed consent observed during that completed handoff to be confirmed late.
CREATE TABLE public.review_texting_deferred_confirmations (
 consent_event_id uuid PRIMARY KEY REFERENCES public.review_sms_consent_events(id) ON DELETE CASCADE,
 next_attempt_at timestamptz NOT NULL,attempts integer NOT NULL DEFAULT 1
);
ALTER TABLE public.review_texting_deferred_confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.review_texting_deferred_confirmations FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.review_texting_deferred_confirmations TO service_role;
CREATE FUNCTION public.review_texting_confirmation_is_deferred(p_event uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM review_sms_consent_events e JOIN review_texting_provider_upgrades p ON p.business_id=e.business_id
 WHERE e.id=p_event AND e.outcome='granted' AND p.handoff_completed_at IS NOT NULL
 AND e.received_at BETWEEN p.handoff_requested_at AND p.handoff_completed_at
 AND p.handoff_completed_at>now()-interval '7 days' AND e.messaging_profile_id=p.messaging_profile_id AND e.sender=p.phone_number
 AND review_texting_upgrade_provider_ready(p.upgrade_id)
 AND EXISTS(SELECT 1 FROM review_permissions rp WHERE rp.sms_consent_event_id=e.id AND rp.destination=e.destination AND rp.revoked_at IS NULL))
$$;
CREATE FUNCTION public.review_texting_claim_confirmations(p_limit integer DEFAULT 20) RETURNS SETOF public.review_sms_consent_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 RETURN QUERY WITH due AS (
  SELECT e.id FROM review_sms_consent_events e
  LEFT JOIN review_texting_deferred_confirmations q ON q.consent_event_id=e.id
  WHERE review_texting_confirmation_is_deferred(e.id) AND (q.next_attempt_at IS NULL OR q.next_attempt_at<=now())
   AND has_review_sms_access(e.business_id) AND NOT review_texting_upgrade_sms_paused(e.business_id)
   AND NOT EXISTS(SELECT 1 FROM tenant_sms_sends s WHERE s.business_id=e.business_id AND s.idempotency_key='review-consent/v1/'||e.provider_message_id)
   AND NOT EXISTS(SELECT 1 FROM tenant_sms_suppressions s WHERE s.business_id=e.business_id AND s.messaging_profile_id=e.messaging_profile_id AND s.destination=e.destination)
   AND NOT EXISTS(SELECT 1 FROM review_suppressions s WHERE s.business_id=e.business_id AND s.identity='phone:'||e.destination)
  ORDER BY coalesce(q.next_attempt_at,e.received_at),e.id LIMIT least(greatest(p_limit,1),20)
 ), claimed AS (
  INSERT INTO review_texting_deferred_confirmations(consent_event_id,next_attempt_at)
  SELECT id,now()+interval '15 minutes' FROM due
  ON CONFLICT(consent_event_id) DO UPDATE SET next_attempt_at=excluded.next_attempt_at,attempts=review_texting_deferred_confirmations.attempts+1
  WHERE review_texting_deferred_confirmations.next_attempt_at<=now() RETURNING consent_event_id
 ) SELECT e.* FROM review_sms_consent_events e JOIN claimed q ON q.consent_event_id=e.id;
END $$;

-- Preserve the shared final reservation checks while allowing only proven
-- handoff-deferred confirmations beyond the ordinary one-day window.
CREATE OR REPLACE FUNCTION public.reserve_tenant_sms_before_keyword_consent(p_business uuid,p_period uuid,p_key text,p_fingerprint text,p_purpose text,
 p_profile text,p_from text,p_to text,p_parts integer,p_conversation uuid DEFAULT NULL,p_enrollment uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b businesses; u billing_usage_periods; r tenant_sms_sends; e review_enrollments;
 v_plan text; v_review boolean; v_access boolean:=false; v_extra integer:=0; v_reserved bigint; v_overage boolean;
 v_contact uuid; v_conversation uuid:=p_conversation;
BEGIN
 SELECT * INTO b FROM businesses WHERE id=p_business FOR UPDATE;
 IF NOT FOUND OR b.owner_id IS NULL OR b.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'sms_business_unavailable'; END IF;
 SELECT * INTO r FROM tenant_sms_sends WHERE business_id=p_business AND idempotency_key=p_key;
 IF FOUND THEN
  IF r.fingerprint<>p_fingerprint THEN RAISE EXCEPTION 'sms_idempotency_conflict'; END IF;
  RETURN jsonb_build_object('send',false,'reservation',to_jsonb(r));
 END IF;
 IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR p_fingerprint IS NULL OR p_parts NOT BETWEEN 1 AND 100
  OR p_from !~ '^\+[1-9][0-9]{7,14}$' OR p_to !~ '^\+[1-9][0-9]{7,14}$'
  OR p_purpose NOT IN ('manual_dashboard_send','ai_reply','mms_fallback','missed_call','voice_followup','review_invitation','review_reminder','review_reply','review_consent_confirmation') THEN RAISE EXCEPTION 'sms_payload_invalid'; END IF;
 IF b.operations_suspended_at IS NOT NULL OR b.texting_paused_at IS NOT NULL OR b.telnyx_submission_disabled THEN RAISE EXCEPTION 'sms_operations_paused'; END IF;
 IF b.telnyx_messaging_profile_id IS DISTINCT FROM p_profile OR b.campaign_status IS DISTINCT FROM 'approved'
  OR NOT EXISTS(SELECT 1 FROM phone_numbers WHERE business_id=p_business AND phone_number=p_from AND is_active
    AND telnyx_campaign_assignment_status='assigned' AND telnyx_campaign_assignment_campaign_id=b.telnyx_campaign_id)
 THEN RAISE EXCEPTION 'sms_sender_unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM tenant_sms_suppressions WHERE business_id=p_business AND messaging_profile_id=p_profile AND destination=p_to) THEN RAISE EXCEPTION 'sms_recipient_opted_out'; END IF;
 v_plan:=tenant_sms_service_plan(p_business);
 v_review:=p_purpose IN ('review_invitation','review_reminder','review_reply','review_consent_confirmation');
 IF v_review THEN
  IF to_regprocedure('public.has_review_sms_access(uuid)') IS NOT NULL THEN
   EXECUTE 'SELECT public.has_review_sms_access($1),public.review_sms_allowance($1)' INTO v_access,v_extra USING p_business;
  END IF;
  IF NOT coalesce(v_access,false) THEN RAISE EXCEPTION 'sms_reviews_not_entitled'; END IF;
  IF EXISTS(SELECT 1 FROM review_suppressions WHERE business_id=p_business AND identity='phone:'||p_to) THEN RAISE EXCEPTION 'sms_recipient_opted_out'; END IF;
 ELSE
  IF v_plan IS NULL OR v_plan='chat_only' OR (p_purpose IN ('ai_reply','mms_fallback','voice_followup') AND v_plan NOT IN ('sms_and_chat','full')) THEN RAISE EXCEPTION 'sms_plan_not_entitled'; END IF;
  IF p_purpose IN ('ai_reply','mms_fallback','voice_followup') AND b.ai_replies_paused_at IS NOT NULL THEN RAISE EXCEPTION 'sms_ai_paused'; END IF;
 END IF;
 IF p_conversation IS NOT NULL AND NOT EXISTS(SELECT 1 FROM conversations c JOIN contacts t ON t.id=c.contact_id AND t.business_id=c.business_id WHERE c.id=p_conversation AND c.business_id=p_business AND c.channel='sms' AND (lead_normalize_phone(t.phone_number)=p_to OR lead_normalize_phone(t.provided_phone_number)=p_to)) THEN RAISE EXCEPTION 'sms_conversation_mismatch'; END IF;
 IF p_purpose IN ('ai_reply','mms_fallback','missed_call') AND EXISTS(SELECT 1 FROM tenant_sms_human_holds WHERE business_id=p_business AND messaging_profile_id=p_profile AND destination=p_to AND released_at IS NULL) THEN RAISE EXCEPTION 'sms_review_human_hold'; END IF;
 IF p_purpose IN ('ai_reply','mms_fallback') AND (p_conversation IS NULL OR NOT EXISTS(SELECT 1 FROM conversations WHERE id=p_conversation AND is_ai_handling AND status='active')) THEN RAISE EXCEPTION 'sms_human_handling'; END IF;
 IF p_purpose='review_consent_confirmation' THEN
  IF NOT review_program_enabled(p_business) OR NOT EXISTS(SELECT 1 FROM review_email_control WHERE singleton AND sms_sending_enabled) THEN RAISE EXCEPTION 'sms_reviews_paused'; END IF;
  IF p_enrollment IS NOT NULL OR p_conversation IS NULL OR NOT EXISTS(
   SELECT 1 FROM review_sms_consent_events ce
   WHERE ce.business_id=p_business AND ce.destination=p_to AND ce.sender=p_from
    AND ce.messaging_profile_id=p_profile AND ce.conversation_id=p_conversation
    AND ce.outcome='granted' AND p_key='review-consent/v1/'||ce.provider_message_id
    AND (ce.occurred_at>now()-interval '24 hours' OR review_texting_confirmation_is_deferred(ce.id))
    AND EXISTS(SELECT 1 FROM review_permissions rp WHERE rp.business_id=ce.business_id AND rp.destination=ce.destination AND rp.revoked_at IS NULL)
  ) THEN RAISE EXCEPTION 'sms_review_consent_unavailable'; END IF;
 ELSIF p_purpose='review_reply' THEN
  IF p_conversation IS NULL OR NOT EXISTS(SELECT 1 FROM tenant_sms_human_holds WHERE business_id=p_business AND messaging_profile_id=p_profile AND destination=p_to AND conversation_id=p_conversation AND released_at IS NULL) THEN RAISE EXCEPTION 'sms_review_reply_unavailable'; END IF;
 ELSIF v_review THEN
  SELECT * INTO e FROM review_enrollments WHERE id=p_enrollment AND business_id=p_business AND channel='sms' AND destination=p_to AND status='active' AND stopped_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'sms_review_enrollment_unavailable'; END IF;
  IF NOT review_program_enabled(p_business) OR NOT EXISTS(SELECT 1 FROM review_settings WHERE business_id=p_business AND NOT paused) OR NOT EXISTS(SELECT 1 FROM review_email_control ctl WHERE singleton AND coalesce((to_jsonb(ctl)->>'sms_sending_enabled')::boolean,false)) THEN RAISE EXCEPTION 'sms_reviews_paused'; END IF;
  IF NOT EXISTS(SELECT 1 FROM review_permissions WHERE business_id=p_business AND contact_id=e.original_contact_id AND destination=p_to AND revoked_at IS NULL) THEN RAISE EXCEPTION 'sms_review_permission_missing'; END IF;
  IF EXISTS(SELECT 1 FROM review_suppressions WHERE business_id=p_business AND (identity='phone:'||p_to OR (identity LIKE 'phone:%' AND identity=ANY(e.identities)))) THEN RAISE EXCEPTION 'sms_recipient_opted_out'; END IF;
  SELECT id INTO v_contact FROM contacts WHERE business_id=p_business AND phone_number=p_to;
  IF v_contact IS NULL THEN SELECT id INTO v_contact FROM contacts WHERE id=e.contact_id AND business_id=p_business AND (lead_normalize_phone(phone_number)=p_to OR lead_normalize_phone(provided_phone_number)=p_to); END IF;
  IF v_contact IS NULL THEN RAISE EXCEPTION 'sms_review_identity_changed'; END IF;
  INSERT INTO conversations(business_id,contact_id,channel,status,is_ai_handling) VALUES(p_business,v_contact,'sms','handed_off',false)
   ON CONFLICT(business_id,contact_id,channel) WHERE status<>'closed' AND channel<>'voice' DO UPDATE SET is_ai_handling=false,status='handed_off' RETURNING id INTO v_conversation;
  INSERT INTO tenant_sms_human_holds(business_id,messaging_profile_id,destination,conversation_id)
   VALUES(p_business,p_profile,p_to,v_conversation) ON CONFLICT(business_id,messaging_profile_id,destination)
   DO UPDATE SET conversation_id=excluded.conversation_id,released_at=NULL;
 END IF;
 SELECT * INTO u FROM billing_usage_periods WHERE id=p_period AND business_id=p_business FOR UPDATE;
 -- Legacy active/trialing/past_due SMS keeps its existing recorded period;
 -- review sends require a current paid window and never borrow future usage.
 IF NOT FOUND OR (v_review AND u.period_end<=now()) OR u.period_start>now() THEN RAISE EXCEPTION 'sms_usage_period_unavailable'; END IF;
 SELECT coalesce(sum(sms_parts),0) INTO v_reserved FROM tenant_sms_sends WHERE usage_period_id=p_period AND status IN ('submitting','uncertain');
 v_overage:=NOT v_review AND (EXISTS(SELECT 1 FROM subscriptions WHERE business_id=p_business) OR b.billing_mode='stripe') AND (b.sms_overage_opt_in OR (NOT EXISTS(SELECT 1 FROM subscriptions WHERE business_id=p_business) AND (b.billing_comped OR b.billing_exempt OR b.billing_pilot)));
 IF u.inbound_sms_parts+u.outbound_sms_parts+v_reserved+p_parts>u.included_sms_parts+v_extra AND NOT v_overage THEN RAISE EXCEPTION 'sms_usage_limit_reached'; END IF;
 INSERT INTO tenant_sms_sends(business_id,usage_period_id,idempotency_key,fingerprint,purpose,messaging_profile_id,sender,destination,sms_parts,conversation_id,review_enrollment_id)
  VALUES(p_business,p_period,p_key,p_fingerprint,p_purpose,p_profile,p_from,p_to,p_parts,v_conversation,p_enrollment) RETURNING * INTO r;
 RETURN jsonb_build_object('send',true,'reservation',to_jsonb(r));
END $$;

DO $$ DECLARE f record;BEGIN FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND (p.proname LIKE 'review_texting_%' OR p.proname IN ('guard_review_texting_handoff','guard_review_texting_provider_cleanup','reserve_tenant_sms','review_begin_sms','review_sms_prepare_release','authorize_review_sms_remote_mutation','authorize_telnyx_remote_mutation','review_sms_owns_plan_family_resources')) LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);END LOOP;END $$;
COMMIT;
