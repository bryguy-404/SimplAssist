BEGIN;

-- One explicitly authorized correction for the private Bryan pilot after the
-- captured Telnyx keyword validation error. Earlier attempts and reservations
-- retain their uncertain outcomes; neither payment nor provider history resets.
ALTER TABLE public.review_sms_accounts DROP CONSTRAINT review_sms_accounts_provider_attempt_count_check;
ALTER TABLE public.review_sms_accounts ADD CONSTRAINT review_sms_accounts_provider_attempt_count_check CHECK(provider_attempt_count BETWEEN 0 AND 3);
ALTER TABLE public.review_sms_campaign_attempts
 ADD COLUMN predecessor_attempt_id uuid REFERENCES public.review_sms_campaign_attempts(id),
 DROP CONSTRAINT review_sms_campaign_attempts_attempt_number_check,
 DROP CONSTRAINT review_sms_campaign_attempts_check;
ALTER TABLE public.review_sms_campaign_attempts
 ADD CONSTRAINT review_sms_campaign_attempts_attempt_number_check CHECK(attempt_number IN (1,2,3)),
 ADD CONSTRAINT review_sms_campaign_attempts_authorization_check CHECK(
 (attempt_number=1 AND authorized_by IS NULL AND original_reservation_id IS NULL AND predecessor_attempt_id IS NULL)
 OR (attempt_number IN (2,3) AND authorized_by IS NOT NULL AND original_reservation_id IS NOT NULL
  AND activation_operation_id IS NOT NULL AND registration_id IS NOT NULL AND membership_revision IS NOT NULL
  AND authorization_expires_at IS NOT NULL AND authorization_token_hash IS NOT NULL
  AND ((attempt_number=2 AND predecessor_attempt_id IS NULL) OR (attempt_number=3 AND predecessor_attempt_id IS NOT NULL
   AND business_id='0e2bf188-ab53-4d3b-8e1a-7aac49125811'::uuid))));

-- Only the known malformed keyword declaration may change. This is NOT a
-- generic retry eligibility rule and never treats an unknown response as proof.
CREATE FUNCTION public.review_sms_campaign_keyword_correction_valid(p_prior_attempt uuid,p_corrected_filing jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT prior.business_id='0e2bf188-ab53-4d3b-8e1a-7aac49125811'::uuid
 AND prior.attempt_number=2 AND prior.state='unknown' AND prior.authorization_consumed_at IS NOT NULL
 AND prior.started_at IS NOT NULL AND prior.finished_at IS NOT NULL AND prior.claim_token IS NOT NULL
 AND prior.provider_campaign_id IS NULL AND prior.response_campaign_id IS NULL
 AND prior.diagnostics @> '{"phase":"submit","status":400,"providerErrors":[{"code":"10015","title":"Bad Request","detail":"Keywords must be alphanumeric comma(,) separated without space."}]}'::jsonb
 AND CASE WHEN jsonb_typeof(prior.diagnostics->'providerErrors')='array'
  THEN jsonb_array_length(prior.diagnostics->'providerErrors')=1 ELSE false END
 AND nullif(btrim(prior.diagnostics->>'requestId'),'') IS NOT NULL
 AND r.id=prior.reservation_id AND r.business_id=prior.business_id AND r.owner_id=prior.owner_id
 AND r.operation_id=prior.id AND r.registration_id=prior.registration_id AND r.membership_revision=prior.membership_revision
 AND r.reference_id=prior.reference_id AND r.payload_hash=prior.payload_hash AND r.state='unknown' AND r.provider_campaign_id IS NULL
 AND first_attempt.business_id=prior.business_id AND first_attempt.owner_id=prior.owner_id AND first_attempt.state='unknown'
 AND first_attempt.reservation_id=prior.original_reservation_id AND first_attempt.provider_campaign_id IS NULL AND first_attempt.response_campaign_id IS NULL
 AND first_attempt.reference_id='reviews:'||prior.account_id::text
 AND prior.reference_id='reviews:'||prior.account_id::text||':r1'
 AND (first_attempt.filing-'referenceId')=(prior.filing-'referenceId')
 AND prior.filing->>'optoutKeywords'='STOP,STOPALL,STOP ALL,UNSUBSCRIBE,CANCEL,END,QUIT,REVOKE,OPT OUT'
 AND p_corrected_filing->>'referenceId'='reviews:'||prior.account_id::text||':r2'
 AND p_corrected_filing->>'optoutKeywords'='STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT,REVOKE'
 AND (p_corrected_filing-'referenceId'-'optoutKeywords')=(prior.filing-'referenceId'-'optoutKeywords')
 FROM review_sms_campaign_attempts prior JOIN shared_brand_campaign_reservations r ON r.id=prior.reservation_id
 JOIN review_sms_campaign_attempts first_attempt ON first_attempt.account_id=prior.account_id AND first_attempt.attempt_number=1
 WHERE prior.id=p_prior_attempt),false)
$$;

CREATE OR REPLACE FUNCTION public.review_sms_campaign_retry_current(p_attempt uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT t.attempt_number IN (2,3) AND b.owner_id=t.owner_id AND a.owner_id=t.owner_id
 AND b.id='0e2bf188-ab53-4d3b-8e1a-7aac49125811'::uuid AND a.state='carrier_pending'
 AND a.billing_source='direct' AND a.exclusive_resources AND a.activation_paid_at IS NOT NULL AND a.activation_payment_intent_id IS NOT NULL
 AND a.activation_refunded_at IS NULL AND a.cancel_at IS NULL AND a.release_at IS NULL AND a.campaign_id IS NULL AND b.telnyx_campaign_id IS NULL
 AND NOT b.telnyx_submission_disabled AND b.active_telnyx_release_run_id IS NULL
 AND shared_review_billing_current(b.id) AND shared_registration_member_valid(b.id,true)
 AND m.registration_id=t.registration_id AND m.revision=t.membership_revision AND b.shared_registration_id=t.registration_id
 AND b.telnyx_brand_id=t.brand_id AND a.brand_id=t.brand_id AND b.telnyx_messaging_profile_id=t.messaging_profile_id AND a.messaging_profile_id=t.messaging_profile_id
 AND b.telnyx_voice_application_id IS NOT DISTINCT FROM t.voice_application_id AND a.voice_application_id IS NOT DISTINCT FROM t.voice_application_id
 AND a.phone_number_id=t.phone_number_id AND n.business_id=b.id AND n.is_active
 AND o.account_id=a.id AND o.business_id=b.id AND o.owner_id=t.owner_id AND o.kind='activation' AND o.state='completed' AND shared_review_activation_proof(b.id,o.payload)
 AND r.business_id=b.id AND r.owner_id=t.owner_id AND r.registration_id=t.registration_id AND r.operation_id=a.id AND r.state='unknown'
 AND r.provider_campaign_id IS NULL AND r.membership_revision=t.membership_revision
 AND (t.attempt_number=2 OR (review_sms_campaign_keyword_correction_valid(t.predecessor_attempt_id,t.filing)
  AND EXISTS(SELECT 1 FROM review_sms_campaign_attempts prior WHERE prior.id=t.predecessor_attempt_id
  AND ROW(prior.business_id,prior.account_id,prior.owner_id,prior.original_reservation_id,prior.activation_operation_id,prior.registration_id,prior.membership_revision,
   prior.brand_id,prior.messaging_profile_id,prior.voice_application_id,prior.phone_number_id,prior.authorized_by)
  IS NOT DISTINCT FROM ROW(t.business_id,t.account_id,t.owner_id,t.original_reservation_id,t.activation_operation_id,t.registration_id,t.membership_revision,
   t.brand_id,t.messaging_profile_id,t.voice_application_id,t.phone_number_id,t.authorized_by))))
 AND NOT EXISTS(SELECT 1 FROM review_sms_billing_operations x WHERE x.account_id=a.id AND x.state IN ('prepared','confirmed','unknown'))
 AND NOT EXISTS(SELECT 1 FROM businesses x WHERE x.id<>b.id AND (x.telnyx_messaging_profile_id=t.messaging_profile_id OR x.telnyx_voice_application_id=t.voice_application_id))
 AND NOT EXISTS(SELECT 1 FROM phone_numbers x WHERE x.business_id<>b.id AND x.phone_number=n.phone_number AND x.is_active)
 FROM review_sms_campaign_attempts t JOIN businesses b ON b.id=t.business_id JOIN review_sms_accounts a ON a.id=t.account_id
 JOIN shared_business_registration_members m ON m.business_id=b.id JOIN review_sms_billing_operations o ON o.id=t.activation_operation_id
 JOIN shared_brand_campaign_reservations r ON r.id=t.original_reservation_id JOIN phone_numbers n ON n.id=t.phone_number_id WHERE t.id=p_attempt),false)
$$;

CREATE FUNCTION public.review_sms_authorize_corrected_campaign_retry(p_business uuid,p_account uuid,p_owner uuid,p_actor uuid,
 p_prior_attempt uuid,p_expected_membership_revision bigint,p_corrected_filing jsonb,p_corrected_payload_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b businesses;a review_sms_accounts;prior review_sms_campaign_attempts;t review_sms_campaign_attempts;token uuid:=gen_random_uuid();
BEGIN
 IF p_business IS DISTINCT FROM '0e2bf188-ab53-4d3b-8e1a-7aac49125811'::uuid OR p_actor IS NULL OR p_owner IS NULL THEN
  RAISE EXCEPTION 'review_sms_campaign_retry_not_authorized'; END IF;
 SELECT * INTO b FROM businesses WHERE id=p_business FOR UPDATE;
 SELECT * INTO a FROM review_sms_accounts WHERE id=p_account AND business_id=b.id FOR UPDATE;
 PERFORM 1 FROM subscriptions WHERE business_id=b.id FOR UPDATE;
 PERFORM 1 FROM review_sms_billing_operations WHERE account_id=a.id FOR UPDATE;
 PERFORM 1 FROM shared_business_registrations WHERE id=b.shared_registration_id FOR UPDATE;
 PERFORM 1 FROM shared_business_registration_members WHERE business_id=b.id FOR UPDATE;
 PERFORM 1 FROM review_sms_campaign_attempts WHERE account_id=a.id ORDER BY attempt_number FOR UPDATE;
 SELECT * INTO prior FROM review_sms_campaign_attempts WHERE id=p_prior_attempt AND account_id=a.id AND business_id=b.id;
 IF prior.id IS NULL OR prior.attempt_number<>2 OR prior.authorized_by IS DISTINCT FROM p_actor THEN
  RAISE EXCEPTION 'review_sms_campaign_retry_not_authorized'; END IF;
 PERFORM 1 FROM shared_brand_campaign_reservations WHERE id IN(prior.original_reservation_id,prior.reservation_id) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM phone_numbers WHERE id=prior.phone_number_id FOR UPDATE;
 IF a.id IS NULL OR b.owner_id IS DISTINCT FROM p_owner OR a.owner_id IS DISTINCT FROM p_owner OR prior.owner_id IS DISTINCT FROM p_owner
 OR prior.membership_revision IS DISTINCT FROM p_expected_membership_revision OR a.provider_attempt_count<>2
 OR a.provider_submitted_at IS NOT NULL OR coalesce(a.provisioning_lease_until>now(),false)
 OR NOT review_sms_campaign_retry_current(prior.id) THEN RAISE EXCEPTION 'review_sms_campaign_retry_changed'; END IF;
 IF NOT review_sms_campaign_keyword_correction_valid(prior.id,p_corrected_filing)
 OR p_corrected_payload_hash IS NULL OR p_corrected_payload_hash !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'review_sms_campaign_retry_filing_changed'; END IF;
 IF EXISTS(SELECT 1 FROM review_sms_campaign_attempts WHERE account_id=a.id AND attempt_number=3) THEN
  RAISE EXCEPTION 'review_sms_campaign_retry_already_authorized'; END IF;
 INSERT INTO review_sms_campaign_attempts(business_id,account_id,owner_id,attempt_number,reference_id,payload_hash,filing,state,original_reservation_id,
 activation_operation_id,registration_id,membership_revision,brand_id,messaging_profile_id,voice_application_id,phone_number_id,
 authorized_by,authorization_expires_at,authorization_token_hash,predecessor_attempt_id)
 VALUES(b.id,a.id,p_owner,3,'reviews:'||a.id::text||':r2',p_corrected_payload_hash,p_corrected_filing,'prepared',prior.original_reservation_id,
 prior.activation_operation_id,prior.registration_id,prior.membership_revision,prior.brand_id,prior.messaging_profile_id,prior.voice_application_id,prior.phone_number_id,
 p_actor,now()+interval '15 minutes',encode(sha256(convert_to(token::text,'UTF8')),'hex'),prior.id) RETURNING * INTO t;
 RETURN jsonb_build_object('attempt_id',t.id,'token',token,'reference_id',t.reference_id,'expires_at',t.authorization_expires_at,'authorization_revision',t.authorization_revision);
END $$;

CREATE OR REPLACE FUNCTION public.guard_review_sms_campaign_attempt_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE rotating boolean;
BEGIN
 IF ROW(NEW.id,NEW.business_id,NEW.account_id,NEW.owner_id,NEW.attempt_number,NEW.reference_id,NEW.payload_hash,NEW.filing,
 NEW.original_reservation_id,NEW.activation_operation_id,NEW.registration_id,NEW.membership_revision,NEW.brand_id,
 NEW.messaging_profile_id,NEW.voice_application_id,NEW.phone_number_id,NEW.authorized_by,NEW.predecessor_attempt_id)
 IS DISTINCT FROM ROW(OLD.id,OLD.business_id,OLD.account_id,OLD.owner_id,OLD.attempt_number,OLD.reference_id,OLD.payload_hash,OLD.filing,
 OLD.original_reservation_id,OLD.activation_operation_id,OLD.registration_id,OLD.membership_revision,OLD.brand_id,
 OLD.messaging_profile_id,OLD.voice_application_id,OLD.phone_number_id,OLD.authorized_by,OLD.predecessor_attempt_id)
 THEN RAISE EXCEPTION 'review_sms_campaign_attempt_snapshot_immutable'; END IF;
 rotating:=ROW(NEW.authorization_token_hash,NEW.authorization_revision,NEW.authorization_refreshed_at)
 IS DISTINCT FROM ROW(OLD.authorization_token_hash,OLD.authorization_revision,OLD.authorization_refreshed_at);
 IF rotating THEN
  IF OLD.business_id IS DISTINCT FROM '0e2bf188-ab53-4d3b-8e1a-7aac49125811'::uuid OR OLD.attempt_number NOT IN (2,3)
  OR OLD.state<>'prepared' OR NEW.state<>'prepared' OR OLD.authorization_consumed_at IS NOT NULL OR NEW.authorization_consumed_at IS NOT NULL
  OR OLD.reservation_id IS NOT NULL OR NEW.reservation_id IS NOT NULL OR OLD.claim_token IS NOT NULL OR NEW.claim_token IS NOT NULL
  OR OLD.started_at IS NOT NULL OR NEW.started_at IS NOT NULL OR OLD.finished_at IS NOT NULL OR NEW.finished_at IS NOT NULL
  OR OLD.provider_campaign_id IS NOT NULL OR NEW.provider_campaign_id IS NOT NULL OR OLD.response_campaign_id IS NOT NULL OR NEW.response_campaign_id IS NOT NULL
  OR OLD.diagnostics IS NOT NULL OR NEW.diagnostics IS NOT NULL
  OR NEW.authorization_revision IS DISTINCT FROM OLD.authorization_revision+1
  OR NEW.authorization_token_hash IS NULL OR NEW.authorization_token_hash !~ '^[a-f0-9]{64}$' OR NEW.authorization_token_hash=OLD.authorization_token_hash
  OR NEW.authorization_refreshed_at IS DISTINCT FROM now() OR NEW.authorization_expires_at IS DISTINCT FROM now()+interval '15 minutes'
  OR NOT review_sms_campaign_retry_current(OLD.id)
  OR NOT EXISTS(SELECT 1 FROM review_sms_accounts a WHERE a.id=OLD.account_id AND a.provider_attempt_count=OLD.attempt_number-1
   AND NOT coalesce(a.provisioning_lease_until>now(),false)) THEN
   RAISE EXCEPTION 'review_sms_campaign_attempt_authority_immutable'; END IF;
 END IF;
 IF OLD.authorization_consumed_at IS NOT NULL AND (NEW.authorization_consumed_at IS DISTINCT FROM OLD.authorization_consumed_at
 OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id OR NEW.claim_token IS DISTINCT FROM OLD.claim_token) THEN
  RAISE EXCEPTION 'review_sms_campaign_attempt_authority_immutable'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.review_sms_begin_campaign_retry(p_business uuid,p_attempt uuid,p_token uuid,p_claim uuid,p_observed_campaign_ids text[],p_provider_verified_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b businesses;a review_sms_accounts;t review_sms_campaign_attempts;r shared_brand_campaign_reservations;used integer;
BEGIN
 SELECT * INTO b FROM businesses WHERE id=p_business FOR UPDATE;
 SELECT * INTO a FROM review_sms_accounts WHERE business_id=b.id FOR UPDATE;
 PERFORM 1 FROM subscriptions WHERE business_id=b.id FOR UPDATE;
 PERFORM 1 FROM review_sms_billing_operations WHERE account_id=a.id FOR UPDATE;
 PERFORM 1 FROM shared_business_registrations WHERE id=b.shared_registration_id FOR UPDATE;
 PERFORM 1 FROM shared_business_registration_members WHERE business_id=b.id FOR UPDATE;
 SELECT * INTO t FROM review_sms_campaign_attempts WHERE id=p_attempt AND business_id=b.id AND account_id=a.id FOR UPDATE;
 IF t.id IS NULL OR t.attempt_number NOT IN (2,3) OR p_token IS NULL OR t.authorization_token_hash IS DISTINCT FROM encode(sha256(convert_to(p_token::text,'UTF8')),'hex') THEN
  RAISE EXCEPTION 'review_sms_campaign_retry_not_authorized'; END IF;
 IF t.authorization_consumed_at IS NOT NULL THEN RETURN jsonb_build_object('attempt_id',t.id,'reservation_id',t.reservation_id,'submit',false); END IF;
 PERFORM 1 FROM shared_brand_campaign_reservations WHERE id=t.original_reservation_id FOR UPDATE;
 PERFORM 1 FROM phone_numbers WHERE id=t.phone_number_id FOR UPDATE;
 IF t.state<>'prepared' OR t.authorization_expires_at<=now() OR a.provider_attempt_count<>t.attempt_number-1
 OR NOT review_sms_provisioning_claim_valid(b.id,p_claim) OR NOT review_sms_campaign_retry_current(t.id) THEN
  RAISE EXCEPTION 'review_sms_campaign_retry_changed'; END IF;
 IF p_provider_verified_at IS NULL OR p_provider_verified_at<now()-interval '5 minutes' OR p_provider_verified_at>now()+interval '30 seconds'
 OR p_observed_campaign_ids IS NULL OR EXISTS(SELECT 1 FROM unnest(p_observed_campaign_ids) v WHERE v IS NULL OR btrim(v)='' OR length(v)>128) THEN
  RAISE EXCEPTION 'shared_campaign_inventory_required'; END IF;
 SELECT count(*) INTO used FROM (SELECT lower(v) FROM unnest(p_observed_campaign_ids) v UNION
 SELECT lower(provider_campaign_id) FROM shared_brand_campaign_reservations WHERE registration_id=t.registration_id AND provider_campaign_id IS NOT NULL) known;
 used:=used+(SELECT count(*) FROM shared_brand_campaign_reservations WHERE registration_id=t.registration_id AND provider_campaign_id IS NULL);
 IF used>=5 THEN RAISE EXCEPTION 'shared_brand_campaign_capacity'; END IF;
 INSERT INTO shared_brand_campaign_reservations(registration_id,business_id,owner_id,purpose,operation_id,reference_id,payload_hash,membership_revision,state)
 VALUES(t.registration_id,b.id,t.owner_id,'review_initial',t.id,t.reference_id,t.payload_hash,t.membership_revision,'submitting') RETURNING * INTO r;
 UPDATE review_sms_campaign_attempts SET state='submitting',reservation_id=r.id,authorization_consumed_at=now(),claim_token=p_claim,started_at=now(),updated_at=now() WHERE id=t.id;
 UPDATE review_sms_accounts SET provider_attempt_count=provider_attempt_count+1,updated_at=now() WHERE id=a.id;
 RETURN jsonb_build_object('attempt_id',t.id,'reservation_id',r.id,'submit',true);
END $$;

CREATE OR REPLACE FUNCTION public.review_sms_refresh_campaign_retry_authorization(p_business uuid,p_attempt uuid,p_actor uuid,p_expected_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b businesses;a review_sms_accounts;t review_sms_campaign_attempts;account_id uuid;token uuid:=gen_random_uuid();
BEGIN
 IF p_business IS DISTINCT FROM '0e2bf188-ab53-4d3b-8e1a-7aac49125811'::uuid OR p_actor IS NULL
 OR p_expected_revision IS NULL OR p_expected_revision<1 THEN RAISE EXCEPTION 'review_sms_campaign_retry_not_authorized'; END IF;
 SELECT * INTO b FROM businesses WHERE id=p_business FOR UPDATE;
 SELECT x.account_id INTO account_id FROM review_sms_campaign_attempts x WHERE x.id=p_attempt AND x.business_id=b.id;
 SELECT * INTO a FROM review_sms_accounts WHERE id=account_id AND business_id=b.id FOR UPDATE;
 PERFORM 1 FROM subscriptions WHERE business_id=b.id FOR UPDATE;
 PERFORM 1 FROM review_sms_billing_operations WHERE review_sms_billing_operations.account_id=a.id FOR UPDATE;
 PERFORM 1 FROM shared_business_registrations WHERE id=b.shared_registration_id FOR UPDATE;
 PERFORM 1 FROM shared_business_registration_members WHERE business_id=b.id FOR UPDATE;
 SELECT * INTO t FROM review_sms_campaign_attempts WHERE id=p_attempt AND business_id=b.id AND review_sms_campaign_attempts.account_id=a.id FOR UPDATE;
 IF t.id IS NULL OR t.attempt_number NOT IN (2,3) OR t.authorized_by IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'review_sms_campaign_retry_not_authorized'; END IF;
 IF t.authorization_revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'review_sms_campaign_retry_revision_changed'; END IF;
 PERFORM 1 FROM shared_brand_campaign_reservations WHERE id=t.original_reservation_id FOR UPDATE;
 PERFORM 1 FROM phone_numbers WHERE id=t.phone_number_id FOR UPDATE;
 IF t.state<>'prepared' OR t.authorization_consumed_at IS NOT NULL OR t.reservation_id IS NOT NULL OR t.claim_token IS NOT NULL
 OR t.started_at IS NOT NULL OR t.finished_at IS NOT NULL OR t.provider_campaign_id IS NOT NULL OR t.response_campaign_id IS NOT NULL
 OR t.diagnostics IS NOT NULL OR a.provider_attempt_count<>t.attempt_number-1 OR coalesce(a.provisioning_lease_until>now(),false)
 OR NOT review_sms_campaign_retry_current(t.id) THEN RAISE EXCEPTION 'review_sms_campaign_retry_changed'; END IF;
 UPDATE review_sms_campaign_attempts SET authorization_token_hash=encode(sha256(convert_to(token::text,'UTF8')),'hex'),
 authorization_expires_at=now()+interval '15 minutes',authorization_revision=authorization_revision+1,
 authorization_refreshed_at=now(),updated_at=now() WHERE id=t.id RETURNING * INTO t;
 RETURN jsonb_build_object('attempt_id',t.id,'token',token,'reference_id',t.reference_id,
  'expires_at',t.authorization_expires_at,'authorization_revision',t.authorization_revision);
END $$;

CREATE OR REPLACE FUNCTION public.review_sms_finish_campaign_attempt(p_attempt uuid,p_claim uuid,p_outcome text,p_provider_campaign_id text,p_diagnostics jsonb,p_provider_filing jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t review_sms_campaign_attempts;b businesses;a review_sms_accounts;attached boolean:=false;
BEGIN
 SELECT * INTO t FROM review_sms_campaign_attempts WHERE id=p_attempt;
 IF t.id IS NULL THEN RAISE EXCEPTION 'review_sms_campaign_attempt_not_found'; END IF;
 SELECT * INTO b FROM businesses WHERE id=t.business_id FOR UPDATE;
 SELECT * INTO a FROM review_sms_accounts WHERE id=t.account_id FOR UPDATE;
 PERFORM 1 FROM subscriptions WHERE business_id=b.id FOR UPDATE;
 PERFORM 1 FROM review_sms_billing_operations WHERE account_id=a.id FOR UPDATE;
 PERFORM 1 FROM shared_business_registrations WHERE id=t.registration_id FOR UPDATE;
 PERFORM 1 FROM shared_business_registration_members WHERE business_id=b.id FOR UPDATE;
 SELECT * INTO t FROM review_sms_campaign_attempts WHERE id=p_attempt FOR UPDATE;
 PERFORM 1 FROM shared_brand_campaign_reservations WHERE id=t.reservation_id FOR UPDATE;
 PERFORM 1 FROM phone_numbers WHERE id=t.phone_number_id FOR UPDATE;
 IF t.state='prepared' OR p_outcome IS NULL OR p_outcome NOT IN ('accepted','unknown','rejected')
 OR p_diagnostics IS NOT NULL AND (jsonb_typeof(p_diagnostics)<>'object' OR octet_length(p_diagnostics::text)>16384)
 OR b.owner_id IS DISTINCT FROM t.owner_id OR a.owner_id IS DISTINCT FROM t.owner_id
 OR NOT coalesce((p_claim IS NOT NULL AND t.claim_token=p_claim) OR review_sms_provisioning_claim_valid(b.id,p_claim),false) THEN RAISE EXCEPTION 'review_sms_campaign_attempt_changed'; END IF;
 IF p_provider_campaign_id IS NOT NULL AND (btrim(p_provider_campaign_id)='' OR length(p_provider_campaign_id)>128
 OR t.response_campaign_id IS NOT NULL AND t.response_campaign_id<>p_provider_campaign_id) THEN RAISE EXCEPTION 'review_sms_campaign_evidence_mismatch'; END IF;
 IF t.state='accepted' AND p_outcome<>'accepted' THEN RETURN jsonb_build_object('state',t.state,'attached',a.campaign_id=t.provider_campaign_id AND b.telnyx_campaign_id=t.provider_campaign_id); END IF;
 IF p_outcome='accepted' THEN
  IF nullif(btrim(p_provider_campaign_id),'') IS NULL OR p_provider_filing IS NULL
  OR NOT (p_provider_filing @> (t.filing-'webhookURL'-'webhookFailoverURL'))
  OR p_provider_filing->>'campaignId' IS DISTINCT FROM p_provider_campaign_id
  OR t.provider_campaign_id IS NOT NULL AND t.provider_campaign_id<>p_provider_campaign_id
  OR EXISTS(SELECT 1 FROM businesses x WHERE x.id<>b.id AND x.telnyx_campaign_id=p_provider_campaign_id) THEN
   RAISE EXCEPTION 'review_sms_campaign_evidence_mismatch'; END IF;
  IF t.reservation_id IS NOT NULL THEN PERFORM record_shared_brand_campaign(b.id,t.reservation_id,t.payload_hash,p_provider_campaign_id,'bound'); END IF;
  -- Late provider evidence is retained even if cancellation/suspension won.
  -- It must never restore access or overwrite another campaign binding.
  IF review_sms_provisioning_claim_valid(b.id,p_claim) AND a.state='carrier_pending'
  AND (a.campaign_id IS NULL OR a.campaign_id=p_provider_campaign_id) AND (b.telnyx_campaign_id IS NULL OR b.telnyx_campaign_id=p_provider_campaign_id)
  AND b.telnyx_brand_id=t.brand_id AND a.brand_id=t.brand_id AND b.telnyx_messaging_profile_id=t.messaging_profile_id
  AND a.messaging_profile_id=t.messaging_profile_id AND a.phone_number_id=t.phone_number_id
  AND NOT EXISTS(SELECT 1 FROM review_sms_campaign_attempts chosen WHERE chosen.account_id=a.id AND chosen.attempt_number>t.attempt_number
   AND chosen.authorization_consumed_at IS NOT NULL AND chosen.id<>t.id)
  AND b.telnyx_voice_application_id IS NOT DISTINCT FROM t.voice_application_id AND a.voice_application_id IS NOT DISTINCT FROM t.voice_application_id
  AND EXISTS(SELECT 1 FROM phone_numbers n WHERE n.id=t.phone_number_id AND n.business_id=b.id AND n.is_active
   AND NOT EXISTS(SELECT 1 FROM phone_numbers other WHERE other.business_id<>b.id AND other.phone_number=n.phone_number AND other.is_active))
  AND NOT EXISTS(SELECT 1 FROM businesses other WHERE other.id<>b.id AND (other.telnyx_messaging_profile_id=t.messaging_profile_id OR other.telnyx_voice_application_id=t.voice_application_id))
  AND (t.registration_id IS NULL OR shared_registration_member_valid(b.id,true)) THEN
   UPDATE businesses SET campaign_status=CASE WHEN telnyx_campaign_id IS NULL THEN 'pending' ELSE campaign_status END,
    telnyx_campaign_id=p_provider_campaign_id WHERE id=b.id;
   UPDATE review_sms_accounts SET last_error=CASE WHEN campaign_id IS NULL THEN NULL ELSE last_error END,
    campaign_id=p_provider_campaign_id,provider_submitted_at=coalesce(provider_submitted_at,now()),updated_at=now() WHERE id=a.id;
   attached:=true;
  END IF;
 ELSE
  IF t.reservation_id IS NOT NULL THEN PERFORM record_shared_brand_campaign(b.id,t.reservation_id,t.payload_hash,NULL,'unknown'); END IF;
 END IF;
 UPDATE review_sms_campaign_attempts SET state=p_outcome,provider_campaign_id=CASE WHEN p_outcome='accepted' THEN p_provider_campaign_id ELSE provider_campaign_id END,
 response_campaign_id=coalesce(p_provider_campaign_id,response_campaign_id),
 diagnostics=coalesce(p_diagnostics,diagnostics),finished_at=coalesce(finished_at,now()),updated_at=now() WHERE id=t.id;
 RETURN jsonb_build_object('state',p_outcome,'attached',attached);
END $$;

DO $$ DECLARE f record;BEGIN
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN ('review_sms_campaign_keyword_correction_valid','review_sms_authorize_corrected_campaign_retry',
 'guard_review_sms_campaign_attempt_snapshot','review_sms_campaign_retry_current','review_sms_begin_campaign_retry',
 'review_sms_refresh_campaign_retry_authorization','review_sms_finish_campaign_attempt') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature); END LOOP;
END $$;
COMMIT;
