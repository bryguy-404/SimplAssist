BEGIN;
CREATE TABLE public.shared_brand_campaign_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),registration_id uuid NOT NULL REFERENCES public.shared_business_registrations(id),
 business_id uuid NOT NULL REFERENCES public.businesses(id),owner_id uuid NOT NULL,purpose text NOT NULL CHECK(purpose IN ('review_initial','review_upgrade')),
 operation_id uuid NOT NULL,reference_id text NOT NULL UNIQUE,payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 membership_revision bigint NOT NULL,provider_campaign_id text UNIQUE,state text NOT NULL CHECK(state IN ('submitting','bound','unknown')),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(registration_id,purpose,operation_id),CHECK((state='bound')=(provider_campaign_id IS NOT NULL))
);
ALTER TABLE public.shared_brand_campaign_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shared_brand_campaign_reservations FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.shared_brand_campaign_reservations TO service_role;
CREATE TABLE public.shared_brand_provider_events (
 event_id text PRIMARY KEY,registration_id uuid NOT NULL REFERENCES public.shared_business_registrations(id),
 occurred_at timestamptz NOT NULL,brand_status text NOT NULL,applied boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.shared_brand_provider_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shared_brand_provider_events FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.shared_brand_provider_events TO service_role;

CREATE FUNCTION public.reserve_shared_brand_campaign(p_business uuid,p_purpose text,p_operation_id uuid,p_reference_id text,p_payload_hash text,
 p_observed_campaign_ids text[],p_provider_verified_at timestamptz,p_claim uuid,p_expected_membership_revision bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b businesses;g shared_business_registrations;m shared_business_registration_members;r shared_brand_campaign_reservations;a review_sms_accounts;p review_texting_provider_upgrades;used integer;
BEGIN
 SELECT * INTO b FROM businesses WHERE id=p_business FOR UPDATE;
 IF b.id IS NULL OR b.shared_registration_id IS NULL THEN RAISE EXCEPTION 'shared_registration_required'; END IF;
 IF p_purpose='review_initial' THEN
  SELECT * INTO a FROM review_sms_accounts WHERE id=p_operation_id AND business_id=b.id FOR UPDATE;
  IF a.id IS NULL OR NOT review_sms_provisioning_claim_valid(b.id,p_claim) OR a.billing_source<>'direct'
   OR p_reference_id IS DISTINCT FROM 'reviews:'||a.id::text OR a.brand_id IS DISTINCT FROM b.telnyx_brand_id THEN RAISE EXCEPTION 'shared_campaign_operation_changed'; END IF;
 ELSIF p_purpose='review_upgrade' THEN
  SELECT * INTO p FROM review_texting_provider_upgrades WHERE upgrade_id=p_operation_id AND business_id=b.id FOR UPDATE;
  IF p.upgrade_id IS NULL OR p.claim_token IS DISTINCT FROM p_claim OR p_claim IS NULL OR p.lease_until IS NULL OR p.lease_until<=now()
   OR p.stage NOT IN ('prepared','submitting','carrier_pending') OR p.brand_id IS DISTINCT FROM b.telnyx_brand_id
   OR p.filing_hash IS DISTINCT FROM p_payload_hash OR p_reference_id IS DISTINCT FROM 'upgrade:'||p.upgrade_id::text THEN RAISE EXCEPTION 'shared_campaign_operation_changed'; END IF;
 ELSE RAISE EXCEPTION 'shared_campaign_operation_changed'; END IF;
 SELECT * INTO g FROM shared_business_registrations WHERE id=b.shared_registration_id FOR UPDATE;
 SELECT * INTO m FROM shared_business_registration_members WHERE business_id=b.id FOR UPDATE;
 IF NOT shared_registration_member_valid(b.id,true) OR m.revision IS DISTINCT FROM p_expected_membership_revision
 OR b.deletion_scheduled_for IS NOT NULL OR b.operations_suspended_at IS NOT NULL OR b.telnyx_submission_disabled OR b.active_telnyx_release_run_id IS NOT NULL
 THEN RAISE EXCEPTION 'shared_registration_unavailable'; END IF;
 SELECT * INTO r FROM shared_brand_campaign_reservations WHERE registration_id=g.id AND purpose=p_purpose AND operation_id=p_operation_id FOR UPDATE;
 IF FOUND THEN
  IF r.business_id<>b.id OR r.owner_id<>b.owner_id OR r.reference_id<>p_reference_id OR r.payload_hash<>p_payload_hash OR r.membership_revision<>m.revision THEN RAISE EXCEPTION 'shared_campaign_reservation_changed'; END IF;
  RETURN jsonb_build_object('id',r.id,'submit',false,'provider_campaign_id',r.provider_campaign_id);
 END IF;
 IF p_payload_hash IS NULL OR p_payload_hash !~ '^[a-f0-9]{64}$' OR p_provider_verified_at IS NULL OR p_provider_verified_at<now()-interval '5 minutes'
 OR p_provider_verified_at>now()+interval '30 seconds' OR p_observed_campaign_ids IS NULL
 OR EXISTS(SELECT 1 FROM unnest(p_observed_campaign_ids) v WHERE v IS NULL OR btrim(v)='' OR length(v)>128) THEN RAISE EXCEPTION 'shared_campaign_inventory_required'; END IF;
 SELECT count(*) INTO used FROM (SELECT lower(v) FROM unnest(p_observed_campaign_ids) v
 UNION SELECT lower(provider_campaign_id) FROM shared_brand_campaign_reservations WHERE registration_id=g.id AND provider_campaign_id IS NOT NULL) known;
 used:=used+(SELECT count(*) FROM shared_brand_campaign_reservations WHERE registration_id=g.id AND provider_campaign_id IS NULL);
 IF used>=5 THEN RAISE EXCEPTION 'shared_brand_campaign_capacity'; END IF;
 INSERT INTO shared_brand_campaign_reservations(registration_id,business_id,owner_id,purpose,operation_id,reference_id,payload_hash,membership_revision,state)
 VALUES(g.id,b.id,b.owner_id,p_purpose,p_operation_id,p_reference_id,p_payload_hash,m.revision,'submitting') RETURNING * INTO r;
 RETURN jsonb_build_object('id',r.id,'submit',true,'provider_campaign_id',NULL);
END $$;
CREATE FUNCTION public.record_shared_brand_campaign(p_business uuid,p_reservation uuid,p_payload_hash text,p_provider_campaign_id text,p_outcome text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b businesses;r shared_brand_campaign_reservations;
BEGIN
 SELECT * INTO b FROM businesses WHERE id=p_business FOR UPDATE;
 PERFORM 1 FROM shared_business_registrations WHERE id=b.shared_registration_id FOR UPDATE;
 SELECT * INTO r FROM shared_brand_campaign_reservations WHERE id=p_reservation AND business_id=b.id FOR UPDATE;
 IF r.id IS NULL OR r.owner_id IS DISTINCT FROM b.owner_id OR r.registration_id IS DISTINCT FROM b.shared_registration_id
 OR r.payload_hash IS DISTINCT FROM p_payload_hash OR p_outcome NOT IN ('bound','unknown') OR p_outcome IS NULL THEN RAISE EXCEPTION 'shared_campaign_reservation_changed'; END IF;
 IF p_outcome='bound' THEN
  IF nullif(btrim(p_provider_campaign_id),'') IS NULL OR (r.provider_campaign_id IS NOT NULL AND lower(r.provider_campaign_id)<>lower(p_provider_campaign_id))
  OR EXISTS(SELECT 1 FROM businesses other WHERE other.id<>b.id AND lower(other.telnyx_campaign_id)=lower(p_provider_campaign_id))
  OR EXISTS(SELECT 1 FROM telnyx_managed_resources other WHERE other.business_id<>b.id AND other.resource_type='campaign' AND other.local_claim_active AND lower(other.provider_id)=lower(p_provider_campaign_id))
  THEN RAISE EXCEPTION 'shared_campaign_owner_conflict'; END IF;
  UPDATE shared_brand_campaign_reservations SET state='bound',provider_campaign_id=p_provider_campaign_id,updated_at=now() WHERE id=r.id;
 ELSIF r.state<>'bound' THEN UPDATE shared_brand_campaign_reservations SET state='unknown',updated_at=now() WHERE id=r.id;
 END IF;
END $$;

CREATE FUNCTION public.apply_shared_brand_event(p_brand_id text,p_event_id text,p_occurred_at timestamptz,p_status text,p_rejection_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE g shared_business_registrations;members uuid[];current_members uuid[];apply boolean;
BEGIN
 SELECT * INTO g FROM shared_business_registrations WHERE lower(telnyx_brand_id)=lower(p_brand_id);
 IF g.id IS NULL THEN RETURN jsonb_build_object('applied',false,'business_ids','[]'::jsonb); END IF;
 IF p_event_id IS NULL OR btrim(p_event_id)='' OR p_occurred_at IS NULL OR p_occurred_at>now()+interval '5 minutes' OR p_status IS NULL OR p_status NOT IN ('approved','pending','rejected') THEN RAISE EXCEPTION 'shared_brand_event_invalid'; END IF;
 SELECT coalesce(array_agg(business_id ORDER BY business_id),'{}'::uuid[]) INTO members FROM shared_business_registration_members WHERE registration_id=g.id;
 PERFORM 1 FROM businesses WHERE id=ANY(members) ORDER BY id FOR UPDATE;
 SELECT * INTO g FROM shared_business_registrations WHERE id=g.id FOR UPDATE;
 SELECT coalesce(array_agg(business_id ORDER BY business_id),'{}'::uuid[]) INTO current_members FROM shared_business_registration_members WHERE registration_id=g.id;
 IF members IS DISTINCT FROM current_members THEN RAISE EXCEPTION 'shared_brand_members_changed_retry' USING ERRCODE='40001'; END IF;
 IF EXISTS(SELECT 1 FROM shared_brand_provider_events WHERE event_id=p_event_id) THEN RETURN jsonb_build_object('applied',false,'business_ids','[]'::jsonb); END IF;
 apply:=g.brand_event_at IS NULL OR p_occurred_at>g.brand_event_at OR (p_occurred_at=g.brand_event_at AND (CASE p_status WHEN 'rejected' THEN 2 WHEN 'pending' THEN 1 ELSE 0 END)>(CASE g.brand_status WHEN 'rejected' THEN 2 WHEN 'pending' THEN 1 ELSE 0 END));
 INSERT INTO shared_brand_provider_events(event_id,registration_id,occurred_at,brand_status,applied) VALUES(p_event_id,g.id,p_occurred_at,p_status,apply);
 IF apply THEN
  UPDATE shared_business_registrations SET brand_status=p_status,brand_event_at=p_occurred_at WHERE id=g.id;
  UPDATE businesses b SET brand_status=p_status,brand_rejection_reason=CASE WHEN p_status='rejected' THEN left(p_rejection_reason,2000) ELSE NULL END
  FROM shared_business_registration_members m WHERE b.id=m.business_id AND m.registration_id=g.id AND b.owner_id=m.owner_id AND b.deleted_at IS NULL AND m.state='active' AND b.telnyx_brand_id=g.telnyx_brand_id;
  INSERT INTO shared_business_registration_events(registration_id,business_id,event,revision,details)
  SELECT g.id,b.id,'brand_status_updated',m.revision,jsonb_build_object('provider_event_id',p_event_id,'brand_status',p_status)
  FROM shared_business_registration_members m JOIN businesses b ON b.id=m.business_id
  WHERE m.registration_id=g.id AND m.state='active' AND b.owner_id=m.owner_id AND b.deleted_at IS NULL AND b.telnyx_brand_id=g.telnyx_brand_id;
 END IF;
 SELECT coalesce(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO members FROM shared_business_registration_members m JOIN businesses b ON b.id=m.business_id
 WHERE apply AND m.registration_id=g.id AND m.state='active' AND b.owner_id=m.owner_id AND b.deleted_at IS NULL AND b.telnyx_brand_id=g.telnyx_brand_id;
 RETURN jsonb_build_object('applied',apply,'business_ids',members);
END $$;

-- A retained group brand is never released by a member's account cleanup.
CREATE FUNCTION public.hold_shared_brand_identity(p_brand_id text,p_observed_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE g shared_business_registrations;members uuid[];current_members uuid[];
BEGIN
 SELECT * INTO g FROM shared_business_registrations WHERE lower(telnyx_brand_id)=lower(p_brand_id);
 IF g.id IS NULL THEN RETURN false; END IF;
 IF p_observed_at IS NULL OR p_observed_at>now()+interval '5 minutes' THEN RAISE EXCEPTION 'shared_brand_observation_invalid'; END IF;
 SELECT coalesce(array_agg(business_id ORDER BY business_id),'{}'::uuid[]) INTO members FROM shared_business_registration_members WHERE registration_id=g.id;
 PERFORM 1 FROM businesses WHERE id=ANY(members) ORDER BY id FOR UPDATE;
 SELECT * INTO g FROM shared_business_registrations WHERE id=g.id FOR UPDATE;
 SELECT coalesce(array_agg(business_id ORDER BY business_id),'{}'::uuid[]) INTO current_members FROM shared_business_registration_members WHERE registration_id=g.id;
 IF members IS DISTINCT FROM current_members THEN RAISE EXCEPTION 'shared_brand_members_changed_retry' USING ERRCODE='40001'; END IF;
 IF g.status='support_required' OR p_observed_at<coalesce(g.brand_event_at,g.provider_verified_at) THEN RETURN false; END IF;
 UPDATE shared_business_registrations SET status='support_required' WHERE id=g.id;
 INSERT INTO shared_business_registration_events(registration_id,business_id,event,revision,details)
 SELECT g.id,b.id,'provider_identity_changed',m.revision,jsonb_build_object('observed_at',p_observed_at)
 FROM shared_business_registration_members m JOIN businesses b ON b.id=m.business_id
 WHERE m.registration_id=g.id AND m.state='active' AND b.owner_id=m.owner_id AND b.deleted_at IS NULL;
 RETURN true;
END $$;

CREATE FUNCTION public.guard_retained_shared_brand() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.retained_shared_registration_id IS NOT NULL AND (TG_OP='DELETE' OR NEW.retained_shared_registration_id IS DISTINCT FROM OLD.retained_shared_registration_id
  OR NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.resource_type IS DISTINCT FROM OLD.resource_type OR NEW.provider_id IS DISTINCT FROM OLD.provider_id OR NEW.provider_origin IS DISTINCT FROM OLD.provider_origin OR NEW.public_tcr_id IS DISTINCT FROM OLD.public_tcr_id
  OR NOT NEW.local_claim_active OR NEW.ownership_state='released' OR NEW.released_at IS NOT NULL) THEN RAISE EXCEPTION 'shared_brand_retained' USING ERRCODE='55000'; END IF;
 IF TG_OP='UPDATE' AND NEW.retained_shared_registration_id IS NOT NULL AND (NEW.resource_type<>'brand'
 OR NOT EXISTS(SELECT 1 FROM shared_business_registrations g WHERE g.id=NEW.retained_shared_registration_id AND g.brand_resource_id=NEW.id AND lower(g.telnyx_brand_id)=lower(NEW.provider_id))) THEN RAISE EXCEPTION 'shared_brand_retention_invalid'; END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER guard_retained_shared_brand BEFORE UPDATE OR DELETE ON public.telnyx_managed_resources FOR EACH ROW EXECUTE FUNCTION public.guard_retained_shared_brand();

ALTER FUNCTION public.review_sms_confirm_operation(uuid,uuid,text) RENAME TO review_sms_confirm_operation_before_shared_registration;
CREATE FUNCTION public.review_sms_confirm_operation(p_operation uuid,p_owner uuid,p_fingerprint text) RETURNS public.review_sms_billing_operations
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o review_sms_billing_operations;b businesses;
BEGIN
 SELECT * INTO o FROM review_sms_billing_operations WHERE id=p_operation;
 SELECT * INTO b FROM businesses WHERE id=o.business_id FOR UPDATE;
 SELECT * INTO o FROM review_sms_billing_operations WHERE id=p_operation FOR UPDATE;
 IF b.shared_registration_id IS NOT NULL AND o.state='prepared' AND o.kind IN ('activation','recurring') THEN
  IF NOT shared_review_billing_current(b.id) OR (o.kind='activation' AND NOT shared_review_activation_proof(b.id,o.payload)) OR (o.kind='recurring' AND NOT EXISTS(
   SELECT 1 FROM review_sms_billing_operations activation WHERE activation.account_id=o.account_id AND activation.kind='activation' AND activation.state='completed'
   AND shared_review_activation_proof(b.id,activation.payload))) THEN RAISE EXCEPTION 'shared_registration_approval_changed'; END IF;
 END IF;
 RETURN review_sms_confirm_operation_before_shared_registration(p_operation,p_owner,p_fingerprint);
END $$;
ALTER FUNCTION public.has_review_sms_access(uuid) RENAME TO has_review_sms_access_before_shared_registration;
CREATE FUNCTION public.has_review_sms_access(p_business_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT shared_brand_sms_allowed(p_business_id) AND has_review_sms_access_before_shared_registration(p_business_id)
$$;
ALTER FUNCTION public.reserve_tenant_sms(uuid,uuid,text,text,text,text,text,text,integer,uuid,uuid) RENAME TO reserve_tenant_sms_before_shared_registration;
CREATE FUNCTION public.reserve_tenant_sms(p_business uuid,p_period uuid,p_key text,p_fingerprint text,p_purpose text,p_profile text,p_from text,p_to text,p_parts integer,p_conversation uuid DEFAULT NULL,p_enrollment uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM businesses WHERE id=p_business FOR UPDATE;
 IF NOT shared_brand_sms_allowed(p_business) THEN RAISE EXCEPTION 'shared_brand_sms_unavailable'; END IF;
 RETURN reserve_tenant_sms_before_shared_registration(p_business,p_period,p_key,p_fingerprint,p_purpose,p_profile,p_from,p_to,p_parts,p_conversation,p_enrollment);
END $$;
ALTER FUNCTION public.review_begin_sms(uuid,uuid) RENAME TO review_begin_sms_before_shared_registration;
CREATE FUNCTION public.review_begin_sms(p_id uuid,p_claim uuid) RETURNS public.review_sms_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE bid uuid;
BEGIN
 SELECT business_id INTO bid FROM review_sms_outbox WHERE id=p_id;
 PERFORM 1 FROM businesses WHERE id=bid FOR UPDATE;
 IF NOT shared_brand_sms_allowed(bid) THEN
  UPDATE review_sms_outbox SET status='pending',next_attempt_at=now()+interval '5 minutes',claim_token=NULL,lease_until=NULL WHERE id=p_id AND status='claimed' AND claim_token=p_claim;
  RETURN NULL;
 END IF;
 RETURN review_begin_sms_before_shared_registration(p_id,p_claim);
END $$;
ALTER FUNCTION public.authorize_telnyx_remote_mutation(uuid,text,text,text,uuid,uuid,text,text) RENAME TO authorize_telnyx_remote_mutation_before_shared_registration;
CREATE FUNCTION public.authorize_telnyx_remote_mutation(p_business_id uuid,p_context text,p_operation text,p_provider_id text,p_action_id uuid,p_lease_token uuid,p_expected_shared_messaging_profile_id text,p_expected_shared_voice_application_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM businesses WHERE id=p_business_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM shared_business_registrations WHERE lower(telnyx_brand_id)=lower(p_provider_id)) THEN RAISE EXCEPTION 'shared_brand_retained'; END IF;
 RETURN authorize_telnyx_remote_mutation_before_shared_registration(p_business_id,p_context,p_operation,p_provider_id,p_action_id,p_lease_token,p_expected_shared_messaging_profile_id,p_expected_shared_voice_application_id);
END $$;
ALTER FUNCTION public.review_sms_provisioning_claim_valid(uuid,uuid) RENAME TO review_sms_provisioning_claim_valid_before_shared_registration;
CREATE FUNCTION public.review_sms_provisioning_claim_valid(p_business uuid,p_claim uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT review_sms_provisioning_claim_valid_before_shared_registration(p_business,p_claim) AND coalesce((SELECT b.shared_registration_id IS NULL OR
  (shared_registration_member_valid(b.id,false) AND shared_review_billing_current(b.id) AND EXISTS(SELECT 1 FROM review_sms_billing_operations o WHERE o.business_id=b.id AND o.kind='activation' AND o.state='completed'
   AND shared_review_activation_proof(b.id,o.payload))) FROM businesses b WHERE b.id=p_business),false)
$$;
ALTER FUNCTION public.review_sms_begin_paid_provider_step(uuid,uuid,text) RENAME TO review_sms_begin_paid_provider_step_before_shared_registration;
CREATE FUNCTION public.review_sms_begin_paid_provider_step(p_business uuid,p_claim uuid,p_step text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM businesses WHERE id=p_business FOR UPDATE;
 IF p_step='brand' AND EXISTS(SELECT 1 FROM businesses WHERE id=p_business AND shared_registration_id IS NOT NULL) THEN RETURN false; END IF;
 RETURN review_sms_begin_paid_provider_step_before_shared_registration(p_business,p_claim,p_step);
END $$;
ALTER FUNCTION public.review_sms_reserve_campaign_submission(uuid,uuid) RENAME TO reserve_review_campaign_before_shared_registration;
CREATE FUNCTION public.review_sms_reserve_campaign_submission(p_business uuid,p_claim uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM businesses WHERE id=p_business FOR UPDATE;
 IF EXISTS(SELECT 1 FROM businesses WHERE id=p_business AND shared_registration_id IS NOT NULL) AND NOT EXISTS(
 SELECT 1 FROM shared_brand_campaign_reservations r JOIN review_sms_accounts a ON a.id=r.operation_id AND a.business_id=r.business_id
 JOIN shared_business_registration_members m ON m.business_id=r.business_id
 WHERE r.business_id=p_business AND r.purpose='review_initial' AND r.state='submitting' AND r.owner_id=a.owner_id AND r.membership_revision=m.revision
 AND a.provisioning_claim=p_claim) THEN RETURN false; END IF;
 RETURN reserve_review_campaign_before_shared_registration(p_business,p_claim);
END $$;
ALTER FUNCTION public.review_texting_provider_authorize(uuid,uuid,text,text[]) RENAME TO review_texting_provider_authorize_before_shared_registration;
CREATE FUNCTION public.review_texting_provider_authorize(p_upgrade uuid,p_claim uuid,p_operation text,p_forbidden_profiles text[]) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b businesses;
BEGIN
 SELECT business_id INTO b.id FROM review_texting_provider_upgrades WHERE upgrade_id=p_upgrade;
 SELECT * INTO b FROM businesses WHERE id=b.id FOR UPDATE;
 IF b.shared_registration_id IS NOT NULL AND p_operation IN ('submit','move') THEN
  IF NOT shared_brand_sms_allowed(b.id) OR NOT EXISTS(SELECT 1 FROM review_sms_billing_operations o WHERE o.business_id=b.id AND o.kind='activation' AND o.state='completed' AND shared_review_activation_proof(b.id,o.payload)) THEN RETURN false; END IF;
  IF p_operation='submit' AND NOT EXISTS(SELECT 1 FROM shared_brand_campaign_reservations r JOIN shared_business_registration_members m ON m.business_id=r.business_id
   WHERE r.business_id=b.id AND r.operation_id=p_upgrade AND r.purpose='review_upgrade' AND r.state='submitting' AND r.owner_id=b.owner_id AND r.membership_revision=m.revision) THEN RETURN false; END IF;
 END IF;
 RETURN review_texting_provider_authorize_before_shared_registration(p_upgrade,p_claim,p_operation,p_forbidden_profiles);
END $$;

CREATE FUNCTION public.guard_shared_registration_record() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['status','brand_status','provider_verified_at','brand_event_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','brand_status','provider_verified_at','brand_event_at']) THEN
 RAISE EXCEPTION 'shared_registration_identity_immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_shared_registration_record BEFORE UPDATE OR DELETE ON public.shared_business_registrations FOR EACH ROW EXECUTE FUNCTION public.guard_shared_registration_record();

-- Narrow brand-only family evidence; all sender/profile/campaign checks remain.
CREATE OR REPLACE FUNCTION public.review_sms_owns_plan_family_resources_before_upgrade(p_business uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT
  a.billing_source='direct' AND a.exclusive_resources
  AND a.activation_paid_at IS NOT NULL AND (a.provider_started_at IS NOT NULL OR (b.shared_registration_id IS NOT NULL
   AND a.brand_id=b.telnyx_brand_id AND EXISTS(SELECT 1 FROM shared_business_registration_members sm WHERE sm.business_id=b.id AND sm.registration_id=b.shared_registration_id AND sm.owner_id=b.owner_id AND sm.consumed_at IS NOT NULL)
   AND EXISTS(SELECT 1 FROM review_sms_billing_operations activation WHERE activation.account_id=a.id AND activation.kind='activation' AND activation.state='completed'
    AND activation.payload->'sharedRegistration'->>'brandId'=a.brand_id)))
  AND (a.activation_refunded_at IS NULL OR (b.shared_registration_id IS NOT NULL AND a.provider_started_at IS NULL
   AND a.phone_number_id IS NULL AND a.campaign_id IS NULL AND b.telnyx_campaign_id IS NULL))
  AND a.owner_id=b.owner_id
  AND s.plan='chat_only' AND s.stripe_subscription_id=a.source_subscription_id
  AND s.stripe_customer_id=a.source_customer_id
  AND f.family='chat_only'
  AND (b.telnyx_brand_id IS NULL OR b.telnyx_brand_id=a.brand_id)
  AND (b.telnyx_campaign_id IS NULL OR b.telnyx_campaign_id=a.campaign_id)
  AND (b.telnyx_messaging_profile_id IS NULL OR b.telnyx_messaging_profile_id=a.messaging_profile_id)
  AND (b.telnyx_voice_application_id IS NULL OR b.telnyx_voice_application_id=a.voice_application_id)
  AND (a.phone_number_id IS NULL OR EXISTS (
   SELECT 1 FROM phone_numbers pn WHERE pn.id=a.phone_number_id AND pn.business_id=b.id
  ))
  AND NOT EXISTS (
   SELECT 1 FROM phone_numbers pn WHERE pn.business_id=b.id
    AND pn.resource_status<>'released' AND (pn.is_active OR pn.telnyx_phone_number_id IS NOT NULL)
    AND pn.id IS DISTINCT FROM a.phone_number_id
  )
  AND NOT EXISTS (
   SELECT 1 FROM telnyx_managed_resources r WHERE r.business_id=b.id
    AND r.local_claim_active AND r.ownership_state<>'released'
    AND NOT coalesce(CASE r.resource_type
     WHEN 'brand' THEN r.provider_id=a.brand_id
     WHEN 'campaign' THEN r.provider_id=a.campaign_id
     WHEN 'messaging_profile' THEN r.provider_id=a.messaging_profile_id
     WHEN 'voice_application' THEN r.provider_id=a.voice_application_id
     WHEN 'phone_number' THEN r.phone_number_id=a.phone_number_id AND EXISTS (
      SELECT 1 FROM phone_numbers pn WHERE pn.id=a.phone_number_id AND pn.business_id=b.id
       AND pn.telnyx_phone_number_id=r.provider_id AND pn.phone_number=r.canonical_e164)
     ELSE false END,false)
  )
  AND NOT EXISTS (
   SELECT 1 FROM businesses other WHERE other.id<>b.id AND other.telnyx_unique_claims_released_at IS NULL AND (
    (a.brand_id IS NOT NULL AND other.telnyx_brand_id=a.brand_id AND NOT shared_brand_reference_allowed(b.id,other.id,a.brand_id))
    OR (a.campaign_id IS NOT NULL AND other.telnyx_campaign_id=a.campaign_id)
    OR (a.messaging_profile_id IS NOT NULL AND other.telnyx_messaging_profile_id=a.messaging_profile_id)
    OR (a.voice_application_id IS NOT NULL AND other.telnyx_voice_application_id=a.voice_application_id))
  )
  AND NOT EXISTS (
   SELECT 1 FROM telnyx_managed_resources r WHERE r.business_id<>b.id
    AND r.local_claim_active AND r.ownership_state<>'released' AND coalesce(CASE r.resource_type
     WHEN 'brand' THEN r.provider_id=a.brand_id AND NOT shared_brand_reference_allowed(b.id,r.business_id,a.brand_id)
     WHEN 'campaign' THEN r.provider_id=a.campaign_id
     WHEN 'messaging_profile' THEN r.provider_id=a.messaging_profile_id
     WHEN 'voice_application' THEN r.provider_id=a.voice_application_id
     WHEN 'phone_number' THEN EXISTS(SELECT 1 FROM phone_numbers pn WHERE pn.id=a.phone_number_id
      AND (pn.telnyx_phone_number_id=r.provider_id OR pn.phone_number=r.canonical_e164))
     ELSE false END,false)
  )
 FROM review_sms_accounts a JOIN businesses b ON b.id=a.business_id
 JOIN subscriptions s ON s.business_id=b.id
 JOIN business_plan_family_locks f ON f.business_id=b.id
 WHERE b.id=p_business),false)
$$;

CREATE OR REPLACE FUNCTION public.review_sms_owns_plan_family_resources(p_business uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
  OR other.telnyx_messaging_profile_id=p.messaging_profile_id OR (other.telnyx_brand_id=p.brand_id AND NOT shared_brand_reference_allowed(b.id,other.id,p.brand_id)) OR other.telnyx_voice_application_id=p.voice_application_id))
 AND NOT EXISTS(SELECT 1 FROM telnyx_managed_resources r WHERE r.business_id<>b.id AND r.local_claim_active AND r.ownership_state<>'released'
  AND ((r.provider_id IN (p.source_campaign_id,p.candidate_campaign_id,p.messaging_profile_id,p.voice_application_id) OR (r.resource_type='brand' AND r.provider_id=p.brand_id AND NOT shared_brand_reference_allowed(b.id,r.business_id,p.brand_id))) OR r.canonical_e164=p.phone_number)))
$$;

CREATE OR REPLACE FUNCTION public.review_texting_provider_owned(p_upgrade uuid,p_forbidden_profiles text[],p_require_paid boolean DEFAULT true)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT
  b.owner_id=u.owner_id AND b.deleted_at IS NULL AND b.operations_suspended_at IS NULL
  AND b.billing_mode='stripe' AND b.partner_id IS NULL AND b.partner_plan IS NULL
  AND NOT b.billing_pilot AND NOT b.billing_comped AND NOT b.billing_exempt
  AND b.onboarding_completed_at IS NOT NULL
  AND NOT b.telnyx_submission_disabled AND b.active_telnyx_release_run_id IS NULL
  AND shared_brand_sms_allowed(b.id) AND u.source_mode='review_sms' AND u.target_plan='sms_and_chat'
  AND a.owner_id=u.owner_id AND a.business_id=u.business_id AND a.id=u.source_review_account_id
  AND a.messaging_profile_id=b.telnyx_messaging_profile_id AND a.campaign_id=b.telnyx_campaign_id
  AND a.brand_id=b.telnyx_brand_id AND pn.id=a.phone_number_id AND pn.business_id=b.id AND pn.is_active
  AND coalesce(cardinality(p_forbidden_profiles),0)>0 AND NOT b.telnyx_messaging_profile_id=ANY(p_forbidden_profiles)
  AND NOT EXISTS(SELECT 1 FROM telnyx_release_protections r WHERE (r.scope='business_all' AND r.business_id=b.id)
   OR (r.scope='resource' AND ((r.provider_id IN (b.telnyx_campaign_id,b.telnyx_messaging_profile_id,pn.telnyx_phone_number_id) OR (r.provider_id=b.telnyx_brand_id AND b.shared_registration_id IS NULL)) OR r.canonical_e164=pn.phone_number)))
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

-- Shared members never manufacture another brand ownership row during cleanup.
CREATE OR REPLACE FUNCTION public.snapshot_telnyx_release_actions(
  p_run_id uuid,
  p_business_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_candidate record;
  v_protection_id uuid;
  v_hard_protected boolean;
  v_classification text;
  v_desired_action text;
  v_state text;
BEGIN
  PERFORM 1
  FROM public.businesses AS business
  WHERE business.id = p_business_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'telnyx_release_business_not_found'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1
  FROM public.telnyx_resource_release_runs
  WHERE id = p_run_id
    AND business_id = p_business_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'telnyx_release_run_business_mismatch'
      USING ERRCODE = '23514';
  END IF;

  -- Migration-first capture: resources created before later application
  -- chunks deploy are still snapshotted as unverified_hold.
  INSERT INTO public.telnyx_managed_resources (
    business_id,
    resource_type,
    provider_id,
    public_tcr_id,
    provider_origin,
    ownership_state
  )
  SELECT
    b.id,
    'brand',
    lower(btrim(b.telnyx_brand_id)),
    (
      SELECT request.tcr_brand_id
      FROM public.telnyx_brand_link_requests AS request
      WHERE request.business_id = b.id
        AND lower(request.telnyx_brand_id)
          = lower(b.telnyx_brand_id)
      ORDER BY request.consumed_at DESC NULLS LAST, request.id::text
      LIMIT 1
    ),
    b.telnyx_brand_source,
    'unverified_hold'
  FROM public.businesses AS b
  WHERE b.id = p_business_id
    AND b.telnyx_brand_id IS NOT NULL
    AND b.shared_registration_id IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.telnyx_managed_resources AS resource
      WHERE resource.business_id = b.id
        AND resource.resource_type = 'brand'
        AND lower(resource.provider_id)
          = lower(b.telnyx_brand_id)
    );

  INSERT INTO public.telnyx_managed_resources (
    business_id,
    resource_type,
    provider_id,
    public_tcr_id,
    ownership_state
  )
  SELECT
    b.id,
    'campaign',
    upper(btrim(b.telnyx_campaign_id)),
    upper(btrim(b.telnyx_campaign_id)),
    'unverified_hold'
  FROM public.businesses AS b
  WHERE b.id = p_business_id
    AND b.telnyx_campaign_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.telnyx_managed_resources AS resource
      WHERE resource.business_id = b.id
        AND resource.resource_type = 'campaign'
        AND lower(resource.provider_id)
          = lower(b.telnyx_campaign_id)
    );

  INSERT INTO public.telnyx_managed_resources (
    business_id,
    resource_type,
    provider_id,
    ownership_state
  )
  SELECT
    b.id,
    'messaging_profile',
    lower(btrim(b.telnyx_messaging_profile_id)),
    'unverified_hold'
  FROM public.businesses AS b
  WHERE b.id = p_business_id
    AND b.telnyx_messaging_profile_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.telnyx_managed_resources AS resource
      WHERE resource.business_id = b.id
        AND resource.resource_type = 'messaging_profile'
        AND lower(resource.provider_id)
          = lower(b.telnyx_messaging_profile_id)
    );

  INSERT INTO public.telnyx_managed_resources (
    business_id,
    resource_type,
    provider_id,
    ownership_state
  )
  SELECT
    b.id,
    'voice_application',
    btrim(b.telnyx_voice_application_id),
    'unverified_hold'
  FROM public.businesses AS b
  WHERE b.id = p_business_id
    AND b.telnyx_voice_application_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.telnyx_managed_resources AS resource
      WHERE resource.business_id = b.id
        AND resource.resource_type = 'voice_application'
        AND resource.provider_id = b.telnyx_voice_application_id
    );

  INSERT INTO public.telnyx_managed_resources (
    business_id,
    phone_number_id,
    resource_type,
    provider_id,
    canonical_e164,
    ownership_state
  )
  SELECT
    pn.business_id,
    pn.id,
    'phone_number',
    CASE
      WHEN pn.business_id =
             'aa30a10e-13c1-4c9b-b9d5-6804cf01e6cb'
       AND regexp_replace(pn.phone_number, '[^0-9]', '', 'g')
             = '15742133931'
        THEN NULL
      WHEN pn.telnyx_phone_number_id ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN lower(btrim(pn.telnyx_phone_number_id))
      ELSE NULL
    END,
    pn.phone_number,
    'unverified_hold'
  FROM public.phone_numbers AS pn
  WHERE pn.business_id = p_business_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.telnyx_managed_resources AS resource
      WHERE resource.resource_type = 'phone_number'
        AND resource.business_id = pn.business_id
        AND resource.phone_number_id = pn.id
    );

  FOR v_candidate IN
    WITH candidates AS (
      SELECT
        resource.id AS managed_resource_id,
        pn.id AS phone_number_id,
        'phone_number_assignment'::text AS resource_type,
        resource.provider_id,
        resource.canonical_e164,
        pn.telnyx_campaign_assignment_campaign_id AS public_tcr_id,
        NULL::text AS expected_parent_brand_id,
        pn.telnyx_campaign_assignment_campaign_id
          AS expected_parent_campaign_id,
        pn.resource_status AS previous_resource_status,
        resource.ownership_state,
        10::smallint AS action_order,
        'unassign'::text AS ordinary_action
      FROM public.phone_numbers AS pn
      JOIN public.telnyx_managed_resources AS resource
        ON resource.phone_number_id = pn.id
       AND resource.business_id = pn.business_id
       AND resource.resource_type = 'phone_number'
      WHERE pn.business_id = p_business_id
        AND pn.telnyx_campaign_assignment_campaign_id IS NOT NULL
        AND pn.telnyx_campaign_assignment_status <> 'unassigned'

      UNION ALL

      SELECT
        resource.id,
        resource.phone_number_id,
        'phone_number',
        resource.provider_id,
        resource.canonical_e164,
        NULL,
        NULL,
        NULL,
        pn.resource_status,
        resource.ownership_state,
        20::smallint,
        'release'
      FROM public.telnyx_managed_resources AS resource
      JOIN public.phone_numbers AS pn
        ON pn.id = resource.phone_number_id
       AND pn.business_id = resource.business_id
      WHERE resource.business_id = p_business_id
        AND resource.resource_type = 'phone_number'
        AND resource.ownership_state <> 'released'

      UNION ALL

      SELECT
        resource.id,
        NULL,
        'campaign',
        resource.provider_id,
        NULL,
        resource.public_tcr_id,
        (
          SELECT b.telnyx_brand_id
          FROM public.businesses AS b
          WHERE b.id = p_business_id
        ),
        NULL,
        NULL::text,
        resource.ownership_state,
        30::smallint,
        'deactivate'
      FROM public.telnyx_managed_resources AS resource
      WHERE resource.business_id = p_business_id
        AND resource.resource_type = 'campaign'
        AND resource.ownership_state <> 'released'

      UNION ALL

      SELECT
        resource.id,
        NULL,
        'messaging_profile',
        resource.provider_id,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL::text,
        resource.ownership_state,
        40::smallint,
        'delete'
      FROM public.telnyx_managed_resources AS resource
      WHERE resource.business_id = p_business_id
        AND resource.resource_type = 'messaging_profile'
        AND resource.ownership_state <> 'released'

      UNION ALL

      SELECT
        resource.id,
        NULL,
        'voice_application',
        resource.provider_id,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL::text,
        resource.ownership_state,
        50::smallint,
        'delete'
      FROM public.telnyx_managed_resources AS resource
      WHERE resource.business_id = p_business_id
        AND resource.resource_type = 'voice_application'
        AND resource.ownership_state <> 'released'

      UNION ALL

      SELECT
        resource.id,
        NULL,
        'brand',
        resource.provider_id,
        NULL,
        resource.public_tcr_id,
        NULL,
        NULL,
        NULL::text,
        resource.ownership_state,
        60::smallint,
        'retain'
      FROM public.telnyx_managed_resources AS resource
      WHERE resource.business_id = p_business_id
        AND resource.resource_type = 'brand'
        AND resource.ownership_state <> 'released'
    )
    SELECT *
    FROM candidates
    ORDER BY action_order, resource_type, managed_resource_id::text
  LOOP
    v_protection_id := public.telnyx_release_protection_id(
      p_business_id,
      v_candidate.resource_type,
      v_candidate.provider_id,
      v_candidate.canonical_e164,
      v_candidate.public_tcr_id,
      v_candidate.expected_parent_campaign_id
    );

    v_hard_protected :=
      p_business_id =
        'aa30a10e-13c1-4c9b-b9d5-6804cf01e6cb'
      OR v_candidate.canonical_e164 = '+15742133931'
      OR upper(COALESCE(v_candidate.provider_id, ''))
           IN ('CYLIGTZ', 'BL69PDP')
      OR upper(COALESCE(v_candidate.public_tcr_id, ''))
           IN ('CYLIGTZ', 'BL69PDP')
      OR upper(COALESCE(
           v_candidate.expected_parent_campaign_id,
           ''
         )) = 'CYLIGTZ';

    IF v_hard_protected OR v_protection_id IS NOT NULL THEN
      v_classification := 'protected_retain';
      v_desired_action := 'retain';
      v_state := 'retained';
    ELSIF v_candidate.resource_type = 'brand' THEN
      -- Brands are retained in v1, including created_by_simplassist brands.
      v_classification := 'policy_retain';
      v_desired_action := 'retain';
      v_state := 'retained';
    ELSIF v_candidate.ownership_state = 'managed_releaseable' THEN
      v_classification := 'managed_releaseable';
      v_desired_action := v_candidate.ordinary_action;
      v_state := 'pending';
    ELSE
      v_classification := 'unverified_hold';
      v_desired_action := 'hold';
      v_state := 'held';
    END IF;

    INSERT INTO public.telnyx_resource_release_actions (
      run_id,
      business_id,
      managed_resource_id,
      phone_number_id,
      protection_id,
      resource_type,
      provider_id,
      canonical_e164,
      public_tcr_id,
      expected_parent_brand_id,
      expected_parent_campaign_id,
      previous_resource_status,
      classification,
      desired_action,
      state,
      action_order,
      support_required_at,
      last_error_code
    )
    SELECT
      p_run_id,
      p_business_id,
      v_candidate.managed_resource_id,
      v_candidate.phone_number_id,
      v_protection_id,
      v_candidate.resource_type,
      v_candidate.provider_id,
      v_candidate.canonical_e164,
      v_candidate.public_tcr_id,
      v_candidate.expected_parent_brand_id,
      v_candidate.expected_parent_campaign_id,
      v_candidate.previous_resource_status,
      v_classification,
      v_desired_action,
      v_state,
      v_candidate.action_order,
      CASE
        WHEN v_state = 'held' THEN now()
        ELSE NULL
      END,
      CASE
        WHEN v_state = 'held' THEN 'ownership_unverified'
        ELSE NULL
      END
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.telnyx_resource_release_actions AS existing
      WHERE existing.run_id = p_run_id
        AND existing.resource_type = v_candidate.resource_type
        AND existing.managed_resource_id
          IS NOT DISTINCT FROM v_candidate.managed_resource_id
        AND existing.phone_number_id
          IS NOT DISTINCT FROM v_candidate.phone_number_id
        AND existing.canonical_e164
          IS NOT DISTINCT FROM v_candidate.canonical_e164
        AND existing.public_tcr_id
          IS NOT DISTINCT FROM v_candidate.public_tcr_id
    );
  END LOOP;

  PERFORM public.refresh_telnyx_release_run(p_run_id);
END;
$$;

-- Account deletion retains the canonical physical brand claim.
CREATE OR REPLACE FUNCTION public.complete_expired_business_cleanup_before_sms_operations(
  p_business_id uuid,
  p_generation bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_business public.businesses%ROWTYPE;
  v_action public.account_deletion_stripe_actions%ROWTYPE;
  v_release_run_id uuid;
  v_release_run_status text;
  v_checkout_reservation_token uuid;
  v_checkout_reservation_expires_at timestamptz;
  v_consumed_reason_count integer;
BEGIN
  SELECT business.*
  INTO v_business
  FROM public.businesses AS business
  WHERE business.id = p_business_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'business % does not exist',
      p_business_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_business.deleted_at IS NOT NULL
     AND v_business.deletion_scheduled_for IS NULL
     AND v_business.owner_id IS NULL THEN
    RETURN true;
  END IF;

  IF v_business.deleted_at IS NULL
     OR v_business.deletion_scheduled_for IS NULL
     OR v_business.deletion_scheduled_for >= now()
     OR v_business.owner_id IS NOT NULL
     OR v_business.cleanup_pii_scrubbed_at IS NULL THEN
    RAISE EXCEPTION
      'business % is not ready to complete cleanup',
      p_business_id
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.subscriptions
    WHERE business_id = p_business_id
  ) THEN
    RAISE EXCEPTION
      'business % still has a local subscription row',
      p_business_id
      USING ERRCODE = '55000';
  END IF;

  IF public.account_reactivation_stripe_in_progress(
    p_business_id
  ) THEN
    RAISE EXCEPTION
      'business % has a reactivation awaiting completion',
      p_business_id
      USING ERRCODE = '55000';
  END IF;

  v_release_run_id := v_business.active_telnyx_release_run_id;

  IF v_release_run_id IS NULL THEN
    RAISE EXCEPTION
      'business % has no durable Telnyx release run',
      p_business_id
      USING ERRCODE = '55000';
  END IF;

  SELECT
    run.status,
    run.checkout_reservation_token,
    run.checkout_reservation_expires_at
  INTO
    v_release_run_status,
    v_checkout_reservation_token,
    v_checkout_reservation_expires_at
  FROM public.telnyx_resource_release_runs AS run
  WHERE run.id = v_release_run_id
    AND run.business_id = p_business_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_release_run_status NOT IN (
       'released',
       'protected_hold',
       'blocked'
     ) THEN
    RAISE EXCEPTION
      'business % Telnyx release run is not terminal',
      p_business_id
      USING ERRCODE = '55000';
  END IF;

  IF v_checkout_reservation_token IS NOT NULL
     AND v_checkout_reservation_expires_at > now() THEN
    RAISE EXCEPTION
      'business % has an active reactivation reservation',
      p_business_id
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.telnyx_resource_release_actions AS release_action
    WHERE release_action.run_id = v_release_run_id
      AND release_action.business_id = p_business_id
      AND release_action.state NOT IN (
        'succeeded',
        'retained',
        'held',
        'blocked'
      )
  ) THEN
    RAISE EXCEPTION
      'business % still has nonterminal Telnyx release actions',
      p_business_id
      USING ERRCODE = '55000';
  END IF;

  SELECT action.*
  INTO v_action
  FROM public.account_deletion_stripe_actions AS action
  WHERE action.business_id = p_business_id
  FOR UPDATE;

  IF FOUND THEN
    IF p_generation IS NULL
       OR v_action.generation <> p_generation
       OR v_action.desired_action <> 'cancel'
       OR v_action.status <> 'applied'
       OR v_action.applied_action <> 'cancel' THEN
      RAISE EXCEPTION
        'business % Stripe cancellation generation % is not applied',
        p_business_id,
        COALESCE(p_generation, -1)
        USING ERRCODE = '55000';
    END IF;

    DELETE FROM public.account_deletion_stripe_actions
    WHERE business_id = p_business_id;
  END IF;

  UPDATE public.telnyx_resource_release_reasons AS reason
  SET status = 'consumed',
      consumed_at = COALESCE(reason.consumed_at, now()),
      updated_at = now()
  WHERE reason.run_id = v_release_run_id
    AND reason.reason_type = 'account_deletion'
    AND reason.status = 'active';

  GET DIAGNOSTICS v_consumed_reason_count = ROW_COUNT;

  IF v_consumed_reason_count <> 1 THEN
    RAISE EXCEPTION
      'business % does not have exactly one active account-deletion release reason',
      p_business_id
      USING ERRCODE = '55000';
  END IF;

  PERFORM public.refresh_telnyx_release_run(v_release_run_id);

  IF v_release_run_status IN ('released', 'protected_hold')
     AND p_business_id <>
          'aa30a10e-13c1-4c9b-b9d5-6804cf01e6cb' THEN
    IF EXISTS (
      SELECT 1
      FROM public.telnyx_managed_resources AS resource
      WHERE resource.business_id = p_business_id
        AND resource.local_claim_active IS TRUE
        AND NOT EXISTS (
          SELECT 1
          FROM public.telnyx_resource_release_actions AS release_action
          WHERE release_action.run_id = v_release_run_id
            AND release_action.business_id = p_business_id
            AND release_action.managed_resource_id = resource.id
            AND release_action.state IN ('succeeded', 'retained')
        )
    ) THEN
      RAISE EXCEPTION
        'business % has managed resources without a terminal release disposition',
        p_business_id
        USING ERRCODE = '55000';
    END IF;

    UPDATE public.telnyx_managed_resources AS resource
    SET local_claim_active = false,
        updated_at = now()
    WHERE resource.business_id = p_business_id
      AND resource.local_claim_active IS TRUE
      AND resource.retained_shared_registration_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM public.telnyx_resource_release_actions AS release_action
        WHERE release_action.run_id = v_release_run_id
          AND release_action.business_id = p_business_id
          AND release_action.managed_resource_id = resource.id
          AND release_action.state IN ('succeeded', 'retained')
      );

    UPDATE public.phone_numbers AS pn
    SET is_active = false
    WHERE pn.business_id = p_business_id
      AND pn.is_active IS TRUE
      AND pn.phone_number <> '+15742133931'
      AND EXISTS (
        SELECT 1
        FROM public.telnyx_resource_release_actions AS release_action
        WHERE release_action.run_id = v_release_run_id
          AND release_action.business_id = p_business_id
          AND release_action.phone_number_id = pn.id
          AND release_action.resource_type = 'phone_number'
          AND release_action.state IN ('succeeded', 'retained')
      );
  END IF;

  UPDATE public.businesses
  SET deletion_scheduled_for = NULL,
      cleanup_auth_user_id = NULL,
      cleanup_attempted_at = NULL,
      telnyx_unique_claims_released_at = CASE
        WHEN v_release_run_status IN ('released', 'protected_hold')
         AND p_business_id <>
              'aa30a10e-13c1-4c9b-b9d5-6804cf01e6cb'
          THEN COALESCE(telnyx_unique_claims_released_at, now())
        ELSE telnyx_unique_claims_released_at
      END,
      updated_at = now()
  WHERE id = p_business_id;

  RETURN true;
END;
$$;
DO $$ DECLARE f record;BEGIN
 FOR f IN SELECT p.oid::regprocedure signature,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
 AND (p.proname IN ('reserve_shared_brand_campaign','record_shared_brand_campaign','apply_shared_brand_event','hold_shared_brand_identity','guard_retained_shared_brand','guard_shared_registration_record',
 'review_sms_confirm_operation','has_review_sms_access','reserve_tenant_sms','review_begin_sms','authorize_telnyx_remote_mutation','review_sms_provisioning_claim_valid',
 'review_sms_begin_paid_provider_step','review_sms_reserve_campaign_submission','review_texting_provider_authorize') OR p.proname LIKE '%_before_shared_registration') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
 IF f.proname LIKE '%_before_shared_registration' THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM service_role',f.signature);
 ELSE EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature); END IF;
 END LOOP;
END $$;
COMMIT;
