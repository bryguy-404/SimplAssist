BEGIN;

-- Keep the first ambiguous provider outcome intact. A separately authorized
-- pilot attempt has its own identity, capacity reservation and diagnostics.
ALTER TABLE public.review_sms_accounts DROP CONSTRAINT review_sms_accounts_provider_attempt_count_check;
ALTER TABLE public.review_sms_accounts ADD CONSTRAINT review_sms_accounts_provider_attempt_count_check CHECK(provider_attempt_count BETWEEN 0 AND 2);
CREATE TABLE public.review_sms_campaign_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 account_id uuid NOT NULL REFERENCES public.review_sms_accounts(id) ON DELETE CASCADE,
 owner_id uuid NOT NULL,
 attempt_number integer NOT NULL CHECK(attempt_number IN (1,2)),
 reference_id text NOT NULL UNIQUE,payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 filing jsonb NOT NULL CHECK(jsonb_typeof(filing)='object' AND octet_length(filing::text)<=32768),
 state text NOT NULL CHECK(state IN ('prepared','submitting','accepted','unknown','rejected')),
 reservation_id uuid REFERENCES public.shared_brand_campaign_reservations(id),
 original_reservation_id uuid REFERENCES public.shared_brand_campaign_reservations(id),
 activation_operation_id uuid REFERENCES public.review_sms_billing_operations(id),
 registration_id uuid REFERENCES public.shared_business_registrations(id),membership_revision bigint,
 brand_id text NOT NULL,messaging_profile_id text NOT NULL,voice_application_id text,phone_number_id uuid NOT NULL,
 authorized_by uuid,authorization_expires_at timestamptz,authorization_token_hash text,
 authorization_consumed_at timestamptz,claim_token uuid,
 started_at timestamptz,finished_at timestamptz,provider_campaign_id text,response_campaign_id text,
 diagnostics jsonb CHECK(diagnostics IS NULL OR (jsonb_typeof(diagnostics)='object' AND octet_length(diagnostics::text)<=16384)),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(account_id,attempt_number),
 CHECK((attempt_number=1 AND authorized_by IS NULL AND original_reservation_id IS NULL)
 OR (attempt_number=2 AND authorized_by IS NOT NULL AND original_reservation_id IS NOT NULL
 AND activation_operation_id IS NOT NULL AND registration_id IS NOT NULL AND membership_revision IS NOT NULL
 AND authorization_expires_at IS NOT NULL AND authorization_token_hash IS NOT NULL))
);
ALTER TABLE public.review_sms_campaign_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.review_sms_campaign_attempts FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.review_sms_campaign_attempts TO service_role;

CREATE FUNCTION public.guard_review_sms_campaign_attempt_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$ BEGIN
 IF ROW(NEW.id,NEW.business_id,NEW.account_id,NEW.owner_id,NEW.attempt_number,NEW.reference_id,NEW.payload_hash,NEW.filing,
 NEW.original_reservation_id,NEW.activation_operation_id,NEW.registration_id,NEW.membership_revision,NEW.brand_id,
 NEW.messaging_profile_id,NEW.voice_application_id,NEW.phone_number_id,NEW.authorized_by,NEW.authorization_token_hash)
 IS DISTINCT FROM ROW(OLD.id,OLD.business_id,OLD.account_id,OLD.owner_id,OLD.attempt_number,OLD.reference_id,OLD.payload_hash,OLD.filing,
 OLD.original_reservation_id,OLD.activation_operation_id,OLD.registration_id,OLD.membership_revision,OLD.brand_id,
 OLD.messaging_profile_id,OLD.voice_application_id,OLD.phone_number_id,OLD.authorized_by,OLD.authorization_token_hash)
 THEN RAISE EXCEPTION 'review_sms_campaign_attempt_snapshot_immutable'; END IF;
 IF OLD.authorization_consumed_at IS NOT NULL AND (NEW.authorization_consumed_at IS DISTINCT FROM OLD.authorization_consumed_at
 OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id OR NEW.claim_token IS DISTINCT FROM OLD.claim_token) THEN
  RAISE EXCEPTION 'review_sms_campaign_attempt_authority_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_review_sms_campaign_attempt_snapshot BEFORE UPDATE ON public.review_sms_campaign_attempts
 FOR EACH ROW EXECUTE FUNCTION public.guard_review_sms_campaign_attempt_snapshot();

CREATE FUNCTION public.review_sms_begin_campaign_attempt(p_business uuid,p_claim uuid,p_reference text,p_payload_hash text,p_filing jsonb,p_reservation uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b businesses;a review_sms_accounts;t review_sms_campaign_attempts;r shared_brand_campaign_reservations;
BEGIN
 SELECT * INTO b FROM businesses WHERE id=p_business FOR UPDATE;
 SELECT * INTO a FROM review_sms_accounts WHERE business_id=b.id FOR UPDATE;
 IF a.id IS NULL OR NOT review_sms_provisioning_claim_valid(b.id,p_claim) OR a.provider_attempt_count<>1
 OR b.telnyx_campaign_id IS NOT NULL OR a.campaign_id IS NOT NULL
 OR p_reference IS DISTINCT FROM 'reviews:'||a.id::text OR p_filing->>'referenceId' IS DISTINCT FROM p_reference
 OR p_filing->>'brandId' IS DISTINCT FROM b.telnyx_brand_id OR p_filing->>'usecase' IS DISTINCT FROM 'MARKETING'
 OR p_payload_hash IS NULL OR p_payload_hash !~ '^[a-f0-9]{64}$'
 OR a.messaging_profile_id IS DISTINCT FROM b.telnyx_messaging_profile_id OR a.phone_number_id IS NULL THEN
  RAISE EXCEPTION 'review_sms_campaign_attempt_changed'; END IF;
 IF b.shared_registration_id IS NOT NULL THEN
  PERFORM 1 FROM shared_business_registrations WHERE id=b.shared_registration_id FOR UPDATE;
  PERFORM 1 FROM shared_business_registration_members WHERE business_id=b.id FOR UPDATE;
  SELECT * INTO r FROM shared_brand_campaign_reservations WHERE id=p_reservation AND business_id=b.id FOR UPDATE;
  IF r.id IS NULL OR r.operation_id<>a.id OR r.purpose<>'review_initial' OR r.state<>'submitting'
  OR r.reference_id<>p_reference OR r.payload_hash<>p_payload_hash OR r.owner_id<>b.owner_id THEN
   RAISE EXCEPTION 'review_sms_campaign_attempt_changed'; END IF;
 ELSIF p_reservation IS NOT NULL THEN RAISE EXCEPTION 'review_sms_campaign_attempt_changed'; END IF;
 SELECT * INTO t FROM review_sms_campaign_attempts WHERE account_id=a.id AND attempt_number=1 FOR UPDATE;
 IF t.id IS NOT NULL THEN
  IF t.reference_id<>p_reference OR t.payload_hash<>p_payload_hash OR t.filing IS DISTINCT FROM p_filing
  OR t.reservation_id IS DISTINCT FROM p_reservation OR t.owner_id<>b.owner_id THEN RAISE EXCEPTION 'review_sms_campaign_attempt_changed'; END IF;
  RETURN jsonb_build_object('attempt_id',t.id,'submit',false);
 END IF;
 INSERT INTO review_sms_campaign_attempts(business_id,account_id,owner_id,attempt_number,reference_id,payload_hash,filing,state,reservation_id,
 registration_id,membership_revision,brand_id,messaging_profile_id,voice_application_id,phone_number_id,claim_token,started_at)
 VALUES(b.id,a.id,b.owner_id,1,p_reference,p_payload_hash,p_filing,'submitting',p_reservation,b.shared_registration_id,r.membership_revision,
 b.telnyx_brand_id,b.telnyx_messaging_profile_id,b.telnyx_voice_application_id,a.phone_number_id,p_claim,now()) RETURNING * INTO t;
 RETURN jsonb_build_object('attempt_id',t.id,'submit',true);
END $$;

-- The caller authenticates an administrator and enforces the private feature
-- flag. SQL independently limits the paid exception to this one pilot account.
CREATE FUNCTION public.review_sms_authorize_campaign_retry(p_business uuid,p_account uuid,p_owner uuid,p_actor uuid,
 p_original_reservation uuid,p_expected_membership_revision bigint,p_original_filing jsonb,p_retry_filing jsonb,p_retry_payload_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b businesses;a review_sms_accounts;m shared_business_registration_members;r shared_brand_campaign_reservations;
 o review_sms_billing_operations;t review_sms_campaign_attempts;token uuid:=gen_random_uuid();ref text;
BEGIN
 IF p_business IS DISTINCT FROM '0e2bf188-ab53-4d3b-8e1a-7aac49125811'::uuid OR p_actor IS NULL OR p_owner IS NULL THEN
  RAISE EXCEPTION 'review_sms_campaign_retry_not_authorized'; END IF;
 SELECT * INTO b FROM businesses WHERE id=p_business FOR UPDATE;
 SELECT * INTO a FROM review_sms_accounts WHERE id=p_account AND business_id=b.id FOR UPDATE;
 PERFORM 1 FROM subscriptions WHERE business_id=b.id FOR UPDATE;
 SELECT * INTO o FROM review_sms_billing_operations WHERE account_id=a.id AND business_id=b.id AND owner_id=p_owner
 AND kind='activation' AND state='completed' AND shared_review_activation_proof(b.id,payload) FOR UPDATE;
 PERFORM 1 FROM shared_business_registrations WHERE id=b.shared_registration_id FOR UPDATE;
 SELECT * INTO m FROM shared_business_registration_members WHERE business_id=b.id FOR UPDATE;
 SELECT * INTO r FROM shared_brand_campaign_reservations WHERE id=p_original_reservation AND business_id=b.id FOR UPDATE;
 IF a.id IS NULL OR b.owner_id IS DISTINCT FROM p_owner OR a.owner_id IS DISTINCT FROM p_owner
 OR a.state<>'carrier_pending' OR a.billing_source<>'direct' OR NOT a.exclusive_resources OR a.provider_attempt_count<>1
 OR a.campaign_id IS NOT NULL OR b.telnyx_campaign_id IS NOT NULL OR a.provider_submitted_at IS NOT NULL
 OR a.activation_paid_at IS NULL OR a.activation_payment_intent_id IS NULL OR a.activation_refunded_at IS NOT NULL OR o.id IS NULL
 OR a.cancel_at IS NOT NULL OR a.release_at IS NOT NULL OR a.provisioning_lease_until>now()
 OR NOT shared_review_billing_current(b.id) OR NOT shared_registration_member_valid(b.id,true)
 OR b.telnyx_submission_disabled OR b.active_telnyx_release_run_id IS NOT NULL OR m.revision IS DISTINCT FROM p_expected_membership_revision
 OR r.id IS NULL OR r.state<>'unknown' OR r.provider_campaign_id IS NOT NULL OR r.operation_id<>a.id OR r.owner_id<>p_owner
 OR r.registration_id<>b.shared_registration_id OR r.membership_revision<>m.revision OR r.reference_id<>'reviews:'||a.id::text
 OR a.brand_id IS DISTINCT FROM b.telnyx_brand_id OR a.messaging_profile_id IS DISTINCT FROM b.telnyx_messaging_profile_id
 OR a.voice_application_id IS DISTINCT FROM b.telnyx_voice_application_id OR a.phone_number_id IS NULL
 OR EXISTS(SELECT 1 FROM review_sms_billing_operations WHERE account_id=a.id AND state IN ('prepared','confirmed','unknown')) THEN
  RAISE EXCEPTION 'review_sms_campaign_retry_changed'; END IF;
 PERFORM 1 FROM phone_numbers WHERE id=a.phone_number_id AND business_id=b.id AND is_active FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'review_sms_campaign_retry_changed'; END IF;
 ref:='reviews:'||a.id::text||':r1';
 IF p_original_filing->>'referenceId' IS DISTINCT FROM r.reference_id OR p_original_filing->>'brandId' IS DISTINCT FROM b.telnyx_brand_id
 OR p_original_filing->>'usecase' IS DISTINCT FROM 'MARKETING' OR p_retry_filing->>'referenceId' IS DISTINCT FROM ref
 OR (p_original_filing-'referenceId') IS DISTINCT FROM (p_retry_filing-'referenceId')
 OR p_retry_payload_hash IS NULL OR p_retry_payload_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'review_sms_campaign_retry_filing_changed'; END IF;
 IF EXISTS(SELECT 1 FROM review_sms_campaign_attempts WHERE account_id=a.id AND attempt_number=2) THEN
  RAISE EXCEPTION 'review_sms_campaign_retry_already_authorized'; END IF;
 SELECT * INTO t FROM review_sms_campaign_attempts WHERE account_id=a.id AND attempt_number=1 FOR UPDATE;
 IF t.id IS NOT NULL AND (t.payload_hash<>r.payload_hash OR t.filing IS DISTINCT FROM p_original_filing OR t.reference_id<>r.reference_id
 OR t.reservation_id IS DISTINCT FROM r.id OR t.state NOT IN ('unknown','rejected')) THEN RAISE EXCEPTION 'review_sms_campaign_retry_filing_changed'; END IF;
 IF t.id IS NULL THEN
  INSERT INTO review_sms_campaign_attempts(business_id,account_id,owner_id,attempt_number,reference_id,payload_hash,filing,state,reservation_id,
  registration_id,membership_revision,brand_id,messaging_profile_id,voice_application_id,phone_number_id,started_at,finished_at,diagnostics)
  VALUES(b.id,a.id,p_owner,1,r.reference_id,r.payload_hash,p_original_filing,'unknown',r.id,b.shared_registration_id,m.revision,
  b.telnyx_brand_id,b.telnyx_messaging_profile_id,b.telnyx_voice_application_id,a.phone_number_id,r.created_at,r.updated_at,
  '{"historical":true,"message":"Original response diagnostics were not retained."}'::jsonb);
 END IF;
 INSERT INTO review_sms_campaign_attempts(business_id,account_id,owner_id,attempt_number,reference_id,payload_hash,filing,state,original_reservation_id,
 activation_operation_id,registration_id,membership_revision,brand_id,messaging_profile_id,voice_application_id,phone_number_id,
 authorized_by,authorization_expires_at,authorization_token_hash)
 VALUES(b.id,a.id,p_owner,2,ref,p_retry_payload_hash,p_retry_filing,'prepared',r.id,o.id,b.shared_registration_id,m.revision,b.telnyx_brand_id,
 b.telnyx_messaging_profile_id,b.telnyx_voice_application_id,a.phone_number_id,p_actor,now()+interval '15 minutes',encode(sha256(convert_to(token::text,'UTF8')),'hex')) RETURNING * INTO t;
 RETURN jsonb_build_object('attempt_id',t.id,'token',token,'reference_id',ref,'expires_at',t.authorization_expires_at);
END $$;

CREATE FUNCTION public.review_sms_campaign_retry_current(p_attempt uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT t.attempt_number=2 AND b.owner_id=t.owner_id AND a.owner_id=t.owner_id
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
 AND NOT EXISTS(SELECT 1 FROM review_sms_billing_operations x WHERE x.account_id=a.id AND x.state IN ('prepared','confirmed','unknown'))
 AND NOT EXISTS(SELECT 1 FROM businesses x WHERE x.id<>b.id AND (x.telnyx_messaging_profile_id=t.messaging_profile_id OR x.telnyx_voice_application_id=t.voice_application_id))
 AND NOT EXISTS(SELECT 1 FROM phone_numbers x WHERE x.business_id<>b.id AND x.phone_number=n.phone_number AND x.is_active)
 FROM review_sms_campaign_attempts t JOIN businesses b ON b.id=t.business_id JOIN review_sms_accounts a ON a.id=t.account_id
 JOIN shared_business_registration_members m ON m.business_id=b.id JOIN review_sms_billing_operations o ON o.id=t.activation_operation_id
 JOIN shared_brand_campaign_reservations r ON r.id=t.original_reservation_id JOIN phone_numbers n ON n.id=t.phone_number_id WHERE t.id=p_attempt),false)
$$;

CREATE FUNCTION public.review_sms_begin_campaign_retry(p_business uuid,p_attempt uuid,p_token uuid,p_claim uuid,p_observed_campaign_ids text[],p_provider_verified_at timestamptz)
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
 IF t.id IS NULL OR t.attempt_number<>2 OR p_token IS NULL OR t.authorization_token_hash IS DISTINCT FROM encode(sha256(convert_to(p_token::text,'UTF8')),'hex') THEN
  RAISE EXCEPTION 'review_sms_campaign_retry_not_authorized'; END IF;
 IF t.authorization_consumed_at IS NOT NULL THEN RETURN jsonb_build_object('attempt_id',t.id,'reservation_id',t.reservation_id,'submit',false); END IF;
 PERFORM 1 FROM shared_brand_campaign_reservations WHERE id=t.original_reservation_id FOR UPDATE;
 PERFORM 1 FROM phone_numbers WHERE id=t.phone_number_id FOR UPDATE;
 IF t.state<>'prepared' OR t.authorization_expires_at<=now() OR a.provider_attempt_count<>1
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

CREATE FUNCTION public.review_sms_finish_campaign_attempt(p_attempt uuid,p_claim uuid,p_outcome text,p_provider_campaign_id text,p_diagnostics jsonb,p_provider_filing jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t review_sms_campaign_attempts;b businesses;a review_sms_accounts;attached boolean:=false;
BEGIN
 SELECT * INTO t FROM review_sms_campaign_attempts WHERE id=p_attempt;
 IF t.id IS NULL THEN RAISE EXCEPTION 'review_sms_campaign_attempt_not_found'; END IF;
 SELECT * INTO b FROM businesses WHERE id=t.business_id FOR UPDATE;
 SELECT * INTO a FROM review_sms_accounts WHERE id=t.account_id FOR UPDATE;
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
  AND NOT EXISTS(SELECT 1 FROM review_sms_campaign_attempts chosen WHERE chosen.account_id=a.id AND chosen.attempt_number=2
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
 WHERE n.nspname='public' AND p.proname IN ('guard_review_sms_campaign_attempt_snapshot','review_sms_begin_campaign_attempt','review_sms_authorize_campaign_retry','review_sms_campaign_retry_current','review_sms_begin_campaign_retry','review_sms_finish_campaign_attempt') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature); END LOOP;
END $$;
COMMIT;
