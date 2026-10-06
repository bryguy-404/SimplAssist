BEGIN;

-- A browser may lose an unconsumed capability before any provider submission.
-- Replace that capability on the SAME attempt; never create a third attempt or
-- reinterpret an uncertain provider outcome as permission to submit again.
ALTER TABLE public.review_sms_campaign_attempts
 ADD COLUMN authorization_revision bigint NOT NULL DEFAULT 1 CHECK(authorization_revision>0),
 ADD COLUMN authorization_refreshed_at timestamptz;

CREATE OR REPLACE FUNCTION public.guard_review_sms_campaign_attempt_snapshot() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE rotating boolean;
BEGIN
 IF ROW(NEW.id,NEW.business_id,NEW.account_id,NEW.owner_id,NEW.attempt_number,NEW.reference_id,NEW.payload_hash,NEW.filing,
 NEW.original_reservation_id,NEW.activation_operation_id,NEW.registration_id,NEW.membership_revision,NEW.brand_id,
 NEW.messaging_profile_id,NEW.voice_application_id,NEW.phone_number_id,NEW.authorized_by)
 IS DISTINCT FROM ROW(OLD.id,OLD.business_id,OLD.account_id,OLD.owner_id,OLD.attempt_number,OLD.reference_id,OLD.payload_hash,OLD.filing,
 OLD.original_reservation_id,OLD.activation_operation_id,OLD.registration_id,OLD.membership_revision,OLD.brand_id,
 OLD.messaging_profile_id,OLD.voice_application_id,OLD.phone_number_id,OLD.authorized_by)
 THEN RAISE EXCEPTION 'review_sms_campaign_attempt_snapshot_immutable'; END IF;
 rotating:=ROW(NEW.authorization_token_hash,NEW.authorization_revision,NEW.authorization_refreshed_at)
 IS DISTINCT FROM ROW(OLD.authorization_token_hash,OLD.authorization_revision,OLD.authorization_refreshed_at);
 IF rotating THEN
  IF OLD.business_id IS DISTINCT FROM '0e2bf188-ab53-4d3b-8e1a-7aac49125811'::uuid OR OLD.attempt_number<>2
  OR OLD.state<>'prepared' OR NEW.state<>'prepared' OR OLD.authorization_consumed_at IS NOT NULL OR NEW.authorization_consumed_at IS NOT NULL
  OR OLD.reservation_id IS NOT NULL OR NEW.reservation_id IS NOT NULL OR OLD.claim_token IS NOT NULL OR NEW.claim_token IS NOT NULL
  OR OLD.started_at IS NOT NULL OR NEW.started_at IS NOT NULL OR OLD.finished_at IS NOT NULL OR NEW.finished_at IS NOT NULL
  OR OLD.provider_campaign_id IS NOT NULL OR NEW.provider_campaign_id IS NOT NULL OR OLD.response_campaign_id IS NOT NULL OR NEW.response_campaign_id IS NOT NULL
  OR OLD.diagnostics IS NOT NULL OR NEW.diagnostics IS NOT NULL
  OR NEW.authorization_revision IS DISTINCT FROM OLD.authorization_revision+1
  OR NEW.authorization_token_hash IS NULL OR NEW.authorization_token_hash !~ '^[a-f0-9]{64}$' OR NEW.authorization_token_hash=OLD.authorization_token_hash
  OR NEW.authorization_refreshed_at IS DISTINCT FROM now() OR NEW.authorization_expires_at IS DISTINCT FROM now()+interval '15 minutes'
  OR NOT review_sms_campaign_retry_current(OLD.id)
  OR NOT EXISTS(SELECT 1 FROM review_sms_accounts a WHERE a.id=OLD.account_id AND a.provider_attempt_count=1
   AND NOT coalesce(a.provisioning_lease_until>now(),false)) THEN
   RAISE EXCEPTION 'review_sms_campaign_attempt_authority_immutable'; END IF;
 END IF;
 IF OLD.authorization_consumed_at IS NOT NULL AND (NEW.authorization_consumed_at IS DISTINCT FROM OLD.authorization_consumed_at
 OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id OR NEW.claim_token IS DISTINCT FROM OLD.claim_token) THEN
  RAISE EXCEPTION 'review_sms_campaign_attempt_authority_immutable'; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION public.review_sms_refresh_campaign_retry_authorization(p_business uuid,p_attempt uuid,p_actor uuid,p_expected_revision bigint)
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
 IF t.id IS NULL OR t.attempt_number<>2 OR t.authorized_by IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'review_sms_campaign_retry_not_authorized'; END IF;
 IF t.authorization_revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'review_sms_campaign_retry_revision_changed'; END IF;
 PERFORM 1 FROM shared_brand_campaign_reservations WHERE id=t.original_reservation_id FOR UPDATE;
 PERFORM 1 FROM phone_numbers WHERE id=t.phone_number_id FOR UPDATE;
 IF t.state<>'prepared' OR t.authorization_consumed_at IS NOT NULL OR t.reservation_id IS NOT NULL OR t.claim_token IS NOT NULL
 OR t.started_at IS NOT NULL OR t.finished_at IS NOT NULL OR t.provider_campaign_id IS NOT NULL OR t.response_campaign_id IS NOT NULL
 OR t.diagnostics IS NOT NULL OR a.provider_attempt_count<>1 OR coalesce(a.provisioning_lease_until>now(),false)
 OR NOT review_sms_campaign_retry_current(t.id) THEN RAISE EXCEPTION 'review_sms_campaign_retry_changed'; END IF;
 UPDATE review_sms_campaign_attempts SET authorization_token_hash=encode(sha256(convert_to(token::text,'UTF8')),'hex'),
 authorization_expires_at=now()+interval '15 minutes',authorization_revision=authorization_revision+1,
 authorization_refreshed_at=now(),updated_at=now() WHERE id=t.id RETURNING * INTO t;
 RETURN jsonb_build_object('attempt_id',t.id,'token',token,'reference_id',t.reference_id,
  'expires_at',t.authorization_expires_at,'authorization_revision',t.authorization_revision);
END $$;
REVOKE ALL ON FUNCTION public.review_sms_refresh_campaign_retry_authorization(uuid,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.review_sms_refresh_campaign_retry_authorization(uuid,uuid,uuid,bigint) TO service_role;
COMMIT;
