BEGIN;

-- A verified legal registration may be reused only through an explicit,
-- owner-bound service approval. The physical brand has one retained ledger row.
CREATE TABLE public.shared_business_registrations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 normalized_ein text NOT NULL UNIQUE CHECK(normalized_ein ~ '^[0-9]{9}$'),
 legal_identity jsonb NOT NULL CHECK(jsonb_typeof(legal_identity)='object'),
 identity_fingerprint text NOT NULL,identity_version bigint NOT NULL DEFAULT 1 CHECK(identity_version>0),
 telnyx_brand_id text NOT NULL UNIQUE,tcr_brand_id text NOT NULL UNIQUE,
 brand_resource_id uuid NOT NULL UNIQUE REFERENCES public.telnyx_managed_resources(id) ON DELETE RESTRICT,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','support_required')),
 brand_status text NOT NULL CHECK(brand_status IN ('approved','pending','rejected')),
 provider_verified_at timestamptz NOT NULL,brand_event_at timestamptz,
 created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.shared_business_registration_members (
 business_id uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE RESTRICT,
 registration_id uuid NOT NULL REFERENCES public.shared_business_registrations(id) ON DELETE RESTRICT,
 owner_id uuid NOT NULL,identity_version bigint NOT NULL,revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 purpose text NOT NULL CHECK(purpose IN ('existing_account','chat_review_sms')),
 state text NOT NULL CHECK(state IN ('approved','active','revoked')),
 approved_by uuid NOT NULL,approved_at timestamptz NOT NULL DEFAULT now(),consumed_at timestamptz,
 revoked_at timestamptz,revoke_reason text
);
CREATE INDEX shared_registration_member_group ON public.shared_business_registration_members(registration_id,business_id);
CREATE TABLE public.shared_business_registration_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),registration_id uuid NOT NULL REFERENCES public.shared_business_registrations(id),
 business_id uuid,actor_id uuid,event text NOT NULL,revision bigint,created_at timestamptz NOT NULL DEFAULT now(),details jsonb NOT NULL DEFAULT '{}'
);
ALTER TABLE public.businesses ADD COLUMN shared_registration_id uuid REFERENCES public.shared_business_registrations(id) ON DELETE RESTRICT,
 ADD COLUMN public_address_visibility text NOT NULL DEFAULT 'full' CHECK(public_address_visibility IN ('full','city_state'));
ALTER TABLE public.telnyx_managed_resources ADD COLUMN retained_shared_registration_id uuid REFERENCES public.shared_business_registrations(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX retained_shared_registration_brand ON public.telnyx_managed_resources(retained_shared_registration_id) WHERE retained_shared_registration_id IS NOT NULL;

CREATE FUNCTION public.shared_registration_identity(p_identity jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object(
 'ein',regexp_replace(coalesce(p_identity->>'ein',''),'[^0-9]','','g'),
 'legal_business_name',upper(regexp_replace(btrim(coalesce(p_identity->>'legal_business_name','')),'\s+',' ','g')),
 'business_entity_type',lower(btrim(coalesce(p_identity->>'business_entity_type',''))),
 'business_registration_state',upper(btrim(coalesce(p_identity->>'business_registration_state',''))),
 'address',upper(regexp_replace(btrim(coalesce(p_identity->>'address','')),'\s+',' ','g')),
 'city',upper(regexp_replace(btrim(coalesce(p_identity->>'city','')),'\s+',' ','g')),
 'state',upper(btrim(coalesce(p_identity->>'state',''))),'zip',left(btrim(coalesce(p_identity->>'zip','')),5))
$$;
CREATE FUNCTION public.shared_registration_member_valid(p_business uuid,p_active boolean DEFAULT true) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM businesses b JOIN shared_business_registration_members m ON m.business_id=b.id
 JOIN shared_business_registrations g ON g.id=m.registration_id JOIN telnyx_managed_resources r ON r.id=g.brand_resource_id
 WHERE b.id=p_business AND b.shared_registration_id=g.id AND b.owner_id=m.owner_id AND b.deleted_at IS NULL
 AND m.state=ANY(CASE WHEN p_active THEN ARRAY['active'] ELSE ARRAY['approved','active'] END)
 AND m.identity_version=g.identity_version AND shared_registration_identity(to_jsonb(b))=shared_registration_identity(g.legal_identity)
 AND g.status='active' AND g.brand_status='approved' AND r.retained_shared_registration_id=g.id
 AND r.resource_type='brand' AND lower(r.provider_id)=lower(g.telnyx_brand_id) AND r.local_claim_active AND r.ownership_state<>'released'
 AND (b.telnyx_brand_id IS NULL OR lower(b.telnyx_brand_id)=lower(g.telnyx_brand_id)))
$$;
CREATE FUNCTION public.shared_brand_sms_allowed(p_business uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT shared_registration_id IS NULL OR shared_registration_member_valid(id,true) FROM businesses WHERE id=p_business),false)
$$;
CREATE FUNCTION public.shared_brand_reference_allowed(p_business uuid,p_other_business uuid,p_brand text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM businesses b JOIN shared_business_registration_members m ON m.business_id=b.id
 JOIN shared_business_registrations g ON g.id=m.registration_id JOIN telnyx_managed_resources r ON r.id=g.brand_resource_id
 WHERE b.id=p_business AND b.shared_registration_id=g.id AND m.owner_id=b.owner_id AND m.consumed_at IS NOT NULL
 AND m.identity_version=g.identity_version AND shared_registration_identity(to_jsonb(b))=shared_registration_identity(g.legal_identity)
 AND lower(p_brand)=lower(g.telnyx_brand_id) AND r.retained_shared_registration_id=g.id AND r.local_claim_active
 AND (r.business_id=p_other_business OR EXISTS(SELECT 1 FROM shared_business_registration_members other
 WHERE other.business_id=p_other_business AND other.registration_id=g.id)))
$$;

-- Preserve ordinary uniqueness, and serialize both ordinary claims and shared
-- admission on the same identity keys. No unrelated account gains an exception.
DROP INDEX public.businesses_normalized_ein_unique;
CREATE UNIQUE INDEX businesses_normalized_ein_unique ON public.businesses((replace(ein,'-',''))) WHERE ein IS NOT NULL AND shared_registration_id IS NULL;
DROP INDEX public.businesses_live_telnyx_brand_id_lower_unique;
CREATE UNIQUE INDEX businesses_live_telnyx_brand_id_lower_unique ON public.businesses(lower(btrim(telnyx_brand_id)))
 WHERE telnyx_brand_id IS NOT NULL AND telnyx_unique_claims_released_at IS NULL AND shared_registration_id IS NULL;
CREATE FUNCTION public.guard_shared_registration_business() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE g shared_business_registrations;m shared_business_registration_members;k text;
BEGIN
 FOR k IN SELECT DISTINCT value FROM unnest(ARRAY[
  'ein:'||regexp_replace(coalesce(NEW.ein,''),'[^0-9]','','g'),'brand:'||lower(coalesce(NEW.telnyx_brand_id,'')),
  CASE WHEN TG_OP='UPDATE' THEN 'ein:'||regexp_replace(coalesce(OLD.ein,''),'[^0-9]','','g') END,
  CASE WHEN TG_OP='UPDATE' THEN 'brand:'||lower(coalesce(OLD.telnyx_brand_id,'')) END]) value
  WHERE value IS NOT NULL AND value NOT IN ('ein:','brand:') ORDER BY value LOOP PERFORM pg_advisory_xact_lock(hashtextextended(k,116)); END LOOP;
 IF NEW.shared_registration_id IS NULL THEN
  IF TG_OP='UPDATE' AND OLD.shared_registration_id IS NOT NULL THEN RAISE EXCEPTION 'shared_registration_cannot_detach'; END IF;
  IF EXISTS(SELECT 1 FROM shared_business_registrations r WHERE r.normalized_ein=replace(NEW.ein,'-','') OR lower(r.telnyx_brand_id)=lower(NEW.telnyx_brand_id)) THEN
   RAISE EXCEPTION 'shared_registration_approval_required' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
 END IF;
 IF auth.role() IN ('anon','authenticated') AND (TG_OP='INSERT' OR NEW.shared_registration_id IS DISTINCT FROM OLD.shared_registration_id
  OR shared_registration_identity(to_jsonb(NEW)) IS DISTINCT FROM shared_registration_identity(to_jsonb(OLD)) OR NEW.owner_id IS DISTINCT FROM OLD.owner_id) THEN
  RAISE EXCEPTION 'shared_registration_identity_locked' USING ERRCODE='42501';
 END IF;
 SELECT * INTO g FROM shared_business_registrations WHERE id=NEW.shared_registration_id;
 SELECT * INTO m FROM shared_business_registration_members WHERE business_id=NEW.id AND registration_id=g.id;
 IF m.business_id IS NULL THEN RAISE EXCEPTION 'shared_registration_approval_required'; END IF;
 -- The ordinary account-cleanup transaction may scrub its business tombstone.
 -- Its canonical identity and physical brand remain retained independently.
 IF NEW.owner_id IS NULL AND NEW.deleted_at IS NOT NULL THEN
  UPDATE shared_business_registration_members SET state='revoked',revision=revision+1,revoked_at=now(),revoke_reason='account_cleanup'
   WHERE business_id=NEW.id AND state<>'revoked';
  RETURN NEW;
 END IF;
 IF NEW.owner_id IS DISTINCT FROM m.owner_id OR m.identity_version<>g.identity_version
  OR NEW.has_ein IS DISTINCT FROM true OR shared_registration_identity(to_jsonb(NEW)) IS DISTINCT FROM shared_registration_identity(g.legal_identity)
  OR (NEW.telnyx_brand_id IS NOT NULL AND (m.state<>'active' OR m.consumed_at IS NULL OR lower(NEW.telnyx_brand_id)<>lower(g.telnyx_brand_id) OR NEW.telnyx_brand_source IS DISTINCT FROM 'linked_existing')) THEN
  RAISE EXCEPTION 'shared_registration_identity_locked';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_shared_registration_business BEFORE INSERT OR UPDATE OF shared_registration_id,has_ein,ein,legal_business_name,business_entity_type,business_registration_state,address,city,state,zip,owner_id,telnyx_brand_id,telnyx_brand_source
 ON public.businesses FOR EACH ROW EXECUTE FUNCTION public.guard_shared_registration_business();

CREATE FUNCTION public.approve_shared_review_brand_member(p_source_business uuid,p_target_business uuid,p_actor uuid,
 p_expected_source_owner uuid,p_expected_target_owner uuid,p_expected_revision bigint,p_expected_brand_id text,p_expected_tcr_brand_id text,
 p_provider_identity jsonb,p_provider_verified_at timestamptz) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE source businesses;target businesses;g shared_business_registrations;m shared_business_registration_members;r telnyx_managed_resources;identity jsonb;k text;
BEGIN
 IF p_actor IS NULL OR p_source_business=p_target_business OR p_expected_source_owner IS NULL OR p_expected_target_owner IS NULL
 OR p_provider_verified_at IS NULL OR p_provider_verified_at<now()-interval '5 minutes' OR p_provider_verified_at>now()+interval '30 seconds' THEN RAISE EXCEPTION 'shared_registration_inspection_required'; END IF;
 PERFORM 1 FROM businesses WHERE id IN(p_source_business,p_target_business) ORDER BY id FOR UPDATE;
 SELECT * INTO source FROM businesses WHERE id=p_source_business;SELECT * INTO target FROM businesses WHERE id=p_target_business;
 IF source.owner_id IS DISTINCT FROM p_expected_source_owner OR target.owner_id IS DISTINCT FROM p_expected_target_owner
 OR source.owner_id IS NULL OR target.owner_id IS NULL OR source.deleted_at IS NOT NULL OR target.deleted_at IS NOT NULL
 OR source.deletion_scheduled_for IS NOT NULL OR target.deletion_scheduled_for IS NOT NULL
 OR source.operations_suspended_at IS NOT NULL OR target.operations_suspended_at IS NOT NULL
 OR source.telnyx_submission_disabled OR target.telnyx_submission_disabled
 OR source.active_telnyx_release_run_id IS NOT NULL OR target.active_telnyx_release_run_id IS NOT NULL
 OR source.telnyx_brand_source IS DISTINCT FROM 'linked_existing' OR lower(source.telnyx_brand_id) IS DISTINCT FROM lower(p_expected_brand_id)
 OR source.brand_status IS DISTINCT FROM 'approved' THEN RAISE EXCEPTION 'shared_registration_source_changed'; END IF;
 IF target.billing_mode IS DISTINCT FROM 'stripe' OR target.partner_id IS NOT NULL OR target.partner_plan IS NOT NULL OR target.billing_pilot OR target.billing_comped OR target.billing_exempt
 OR target.onboarding_completed_at IS NULL OR target.telnyx_brand_id IS NOT NULL OR target.telnyx_campaign_id IS NOT NULL
 OR target.telnyx_messaging_profile_id IS NOT NULL OR target.telnyx_voice_application_id IS NOT NULL
 OR EXISTS(SELECT 1 FROM phone_numbers WHERE business_id=target.id AND resource_status<>'released')
 OR EXISTS(SELECT 1 FROM telnyx_managed_resources WHERE business_id=target.id AND local_claim_active)
 OR EXISTS(SELECT 1 FROM review_sms_accounts WHERE business_id=target.id AND (state<>'draft' OR activation_paid_at IS NOT NULL OR provider_started_at IS NOT NULL))
 OR NOT EXISTS(SELECT 1 FROM subscriptions WHERE business_id=target.id AND plan='chat_only' AND status='active' AND NOT cancel_at_period_end
  AND pending_plan IS NULL AND stripe_subscription_id IS NOT NULL AND stripe_customer_id IS NOT NULL AND current_period_end>now()) THEN RAISE EXCEPTION 'shared_registration_target_ineligible'; END IF;
 IF NOT EXISTS(SELECT 1 FROM telnyx_brand_link_requests WHERE business_id=source.id AND status='consumed'
 AND lower(telnyx_brand_id)=lower(p_expected_brand_id) AND upper(tcr_brand_id)=upper(p_expected_tcr_brand_id)) THEN RAISE EXCEPTION 'shared_registration_source_proof_missing'; END IF;
 identity:=shared_registration_identity(to_jsonb(source));
 IF identity IS DISTINCT FROM shared_registration_identity(p_provider_identity)
 OR identity->>'ein' !~ '^[0-9]{9}$' OR EXISTS(SELECT 1 FROM jsonb_each_text(identity) WHERE key<>'business_registration_state' AND value='') THEN RAISE EXCEPTION 'shared_registration_identity_mismatch'; END IF;
 FOR k IN SELECT DISTINCT value FROM unnest(ARRAY['brand:'||lower(p_expected_brand_id),'ein:'||(identity->>'ein'),
 'brand:'||lower(coalesce(target.telnyx_brand_id,'')),'ein:'||regexp_replace(coalesce(target.ein,''),'[^0-9]','','g'),
 'brand:'||lower(coalesce(source.telnyx_brand_id,'')),'ein:'||regexp_replace(coalesce(source.ein,''),'[^0-9]','','g')]) value
 WHERE value NOT IN ('ein:','brand:') ORDER BY value LOOP PERFORM pg_advisory_xact_lock(hashtextextended(k,116)); END LOOP;
 IF EXISTS(SELECT 1 FROM businesses b WHERE b.id NOT IN(source.id,target.id) AND b.shared_registration_id IS NULL
 AND (replace(b.ein,'-','')=identity->>'ein' OR (lower(b.telnyx_brand_id)=lower(p_expected_brand_id) AND b.telnyx_unique_claims_released_at IS NULL))) THEN RAISE EXCEPTION 'shared_registration_identity_conflict'; END IF;
 SELECT * INTO g FROM shared_business_registrations WHERE normalized_ein=identity->>'ein' FOR UPDATE;
 SELECT * INTO m FROM shared_business_registration_members WHERE business_id=target.id FOR UPDATE;
 IF coalesce(m.revision,0) IS DISTINCT FROM p_expected_revision OR (m.business_id IS NOT NULL AND (m.owner_id<>target.owner_id OR m.state='active')) THEN RAISE EXCEPTION 'shared_registration_revision_changed'; END IF;
 SELECT * INTO r FROM telnyx_managed_resources WHERE business_id=source.id AND resource_type='brand' AND lower(provider_id)=lower(p_expected_brand_id)
 AND provider_origin='linked_existing' AND local_claim_active AND ownership_state<>'released' FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'shared_registration_brand_ledger_missing'; END IF;
 IF g.id IS NULL THEN
  INSERT INTO shared_business_registrations(normalized_ein,legal_identity,identity_fingerprint,telnyx_brand_id,tcr_brand_id,brand_resource_id,brand_status,provider_verified_at,brand_event_at,created_by)
  VALUES(identity->>'ein',jsonb_build_object('ein',source.ein,'legal_business_name',source.legal_business_name,'business_entity_type',source.business_entity_type,
   'business_registration_state',source.business_registration_state,'address',source.address,'city',source.city,'state',source.state,'zip',source.zip),
   encode(sha256(convert_to(identity::text,'UTF8')),'hex'),lower(p_expected_brand_id),upper(p_expected_tcr_brand_id),r.id,'approved',p_provider_verified_at,p_provider_verified_at,p_actor) RETURNING * INTO g;
 ELSE
  IF g.status<>'active' OR g.brand_status<>'approved' OR g.legal_identity IS NULL OR shared_registration_identity(g.legal_identity)<>identity
  OR g.telnyx_brand_id<>lower(p_expected_brand_id) OR g.tcr_brand_id<>upper(p_expected_tcr_brand_id) OR g.brand_resource_id<>r.id THEN RAISE EXCEPTION 'shared_registration_group_changed'; END IF;
 END IF;
 UPDATE telnyx_managed_resources SET retained_shared_registration_id=g.id WHERE id=r.id;
 INSERT INTO shared_business_registration_members(business_id,registration_id,owner_id,identity_version,purpose,state,approved_by,consumed_at)
 VALUES(source.id,g.id,source.owner_id,g.identity_version,'existing_account','active',p_actor,now()) ON CONFLICT(business_id) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM shared_business_registration_members WHERE business_id=source.id AND registration_id=g.id AND owner_id=source.owner_id AND state='active') THEN RAISE EXCEPTION 'shared_registration_source_membership_changed'; END IF;
 INSERT INTO shared_business_registration_members(business_id,registration_id,owner_id,identity_version,purpose,state,approved_by)
 VALUES(target.id,g.id,target.owner_id,g.identity_version,'chat_review_sms','approved',p_actor)
 ON CONFLICT(business_id) DO UPDATE SET registration_id=excluded.registration_id,identity_version=excluded.identity_version,state='approved',
 revision=shared_business_registration_members.revision+1,approved_by=p_actor,approved_at=now(),revoked_at=NULL,revoke_reason=NULL;
 UPDATE businesses SET shared_registration_id=g.id WHERE id=source.id;
 UPDATE businesses SET public_address_visibility='city_state' WHERE id=target.id;
 UPDATE businesses SET shared_registration_id=g.id,ein=source.ein,has_ein=true,legal_business_name=source.legal_business_name,
 business_entity_type=source.business_entity_type,business_registration_state=source.business_registration_state,address=source.address,city=source.city,state=source.state,zip=source.zip WHERE id=target.id;
 INSERT INTO shared_business_registration_events(registration_id,business_id,actor_id,event,revision) SELECT g.id,target.id,p_actor,'approved',revision FROM shared_business_registration_members WHERE business_id=target.id;
 RETURN g.id;
END $$;

CREATE FUNCTION public.revoke_shared_review_brand_member(p_business uuid,p_actor uuid,p_expected_owner uuid,p_expected_revision bigint,p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b businesses;m shared_business_registration_members;
BEGIN
 SELECT * INTO b FROM businesses WHERE id=p_business FOR UPDATE;
 IF p_actor IS NULL OR b.owner_id IS DISTINCT FROM p_expected_owner OR p_expected_owner IS NULL OR nullif(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'shared_registration_owner_changed'; END IF;
 PERFORM 1 FROM shared_business_registrations WHERE id=b.shared_registration_id FOR UPDATE;
 SELECT * INTO m FROM shared_business_registration_members WHERE business_id=b.id FOR UPDATE;
 IF m.business_id IS NULL OR m.revision IS DISTINCT FROM p_expected_revision OR m.owner_id IS DISTINCT FROM p_expected_owner THEN RAISE EXCEPTION 'shared_registration_revision_changed'; END IF;
 IF m.state<>'approved' OR m.consumed_at IS NOT NULL OR b.telnyx_brand_id IS NOT NULL
 OR EXISTS(SELECT 1 FROM review_sms_accounts WHERE business_id=b.id AND (activation_paid_at IS NOT NULL OR provider_started_at IS NOT NULL OR state NOT IN ('draft','activation_pending')))
 OR EXISTS(SELECT 1 FROM review_sms_billing_operations WHERE business_id=b.id AND state IN ('prepared','confirmed','unknown'))
 THEN RAISE EXCEPTION 'shared_registration_approval_in_use'; END IF;
 UPDATE shared_business_registration_members SET state='revoked',revision=revision+1,revoked_at=now(),revoke_reason=left(p_reason,500) WHERE business_id=b.id;
 INSERT INTO shared_business_registration_events(registration_id,business_id,actor_id,event,revision) VALUES(m.registration_id,b.id,p_actor,'revoked',m.revision+1);
END $$;

CREATE FUNCTION public.shared_review_activation_proof(p_business uuid,p_payload jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM businesses b JOIN shared_business_registration_members m ON m.business_id=b.id
 JOIN shared_business_registrations g ON g.id=m.registration_id WHERE b.id=p_business AND shared_registration_member_valid(b.id,false)
 AND p_payload->'sharedRegistration'=jsonb_build_object('registrationId',g.id,'identityVersion',g.identity_version,'membershipRevision',m.revision,'brandId',g.telnyx_brand_id))
$$;
CREATE FUNCTION public.shared_review_billing_current(p_business uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM businesses b JOIN review_sms_accounts a ON a.business_id=b.id JOIN subscriptions s ON s.business_id=b.id
 WHERE b.id=p_business AND b.owner_id=a.owner_id AND b.deleted_at IS NULL AND b.deletion_scheduled_for IS NULL AND b.operations_suspended_at IS NULL
 AND b.billing_mode='stripe' AND b.partner_id IS NULL AND b.partner_plan IS NULL AND NOT b.billing_pilot AND NOT b.billing_comped AND NOT b.billing_exempt
 AND a.billing_source='direct' AND a.exclusive_resources AND a.cancel_at IS NULL AND a.activation_refunded_at IS NULL
 AND s.plan='chat_only' AND s.status='active' AND NOT s.cancel_at_period_end AND s.pending_plan IS NULL AND s.current_period_end>now()
 AND s.stripe_subscription_id=a.source_subscription_id AND s.stripe_customer_id=a.source_customer_id)
$$;

CREATE FUNCTION public.consume_shared_review_brand_member(p_business uuid,p_owner uuid,p_review_account uuid,p_claim uuid,
 p_expected_registration uuid,p_expected_version bigint,p_expected_membership_revision bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b businesses;a review_sms_accounts;g shared_business_registrations;m shared_business_registration_members;k text;
BEGIN
 SELECT * INTO b FROM businesses WHERE id=p_business FOR UPDATE;
 SELECT * INTO a FROM review_sms_accounts WHERE id=p_review_account AND business_id=b.id FOR UPDATE;
 SELECT * INTO g FROM shared_business_registrations WHERE id=b.shared_registration_id;
 FOR k IN SELECT DISTINCT value FROM unnest(ARRAY['brand:'||lower(coalesce(g.telnyx_brand_id,'')),'brand:'||lower(coalesce(b.telnyx_brand_id,'')),
  'ein:'||regexp_replace(coalesce(b.ein,''),'[^0-9]','','g')]) value WHERE value NOT IN ('ein:','brand:') ORDER BY value LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(k,116)); END LOOP;
 SELECT * INTO g FROM shared_business_registrations WHERE id=b.shared_registration_id FOR UPDATE;
 SELECT * INTO m FROM shared_business_registration_members WHERE business_id=b.id FOR UPDATE;
 IF p_owner IS NULL OR b.owner_id IS DISTINCT FROM p_owner OR a.owner_id IS DISTINCT FROM p_owner OR a.id IS NULL
 OR g.id IS DISTINCT FROM p_expected_registration OR g.identity_version IS DISTINCT FROM p_expected_version OR m.revision IS DISTINCT FROM p_expected_membership_revision
 OR NOT shared_registration_member_valid(b.id,false) OR NOT review_sms_provisioning_claim_valid(b.id,p_claim)
 OR m.purpose IS DISTINCT FROM 'chat_review_sms' OR NOT shared_review_billing_current(b.id) OR a.activation_refunded_at IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM review_sms_billing_operations o WHERE o.account_id=a.id AND o.owner_id=p_owner AND o.kind='activation' AND o.state='completed'
 AND shared_review_activation_proof(b.id,o.payload)) THEN RETURN false; END IF;
 IF a.brand_id IS NOT NULL AND a.brand_id<>g.telnyx_brand_id THEN RETURN false; END IF;
 -- This is attachment of an already-paid brand, not a paid provider operation.
 UPDATE shared_business_registration_members SET state='active',consumed_at=coalesce(consumed_at,now()) WHERE business_id=b.id;
 UPDATE review_sms_accounts SET brand_id=g.telnyx_brand_id WHERE id=a.id;
 UPDATE businesses SET telnyx_brand_id=g.telnyx_brand_id,telnyx_brand_source='linked_existing',brand_status=g.brand_status WHERE id=b.id;
 INSERT INTO shared_business_registration_events(registration_id,business_id,actor_id,event,revision)
 SELECT g.id,b.id,p_owner,'consumed',m.revision WHERE m.state<>'active';
 RETURN true;
END $$;

DO $$ DECLARE t text;f record;BEGIN
 FOREACH t IN ARRAY ARRAY['shared_business_registrations','shared_business_registration_members','shared_business_registration_events'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO service_role',t);
 END LOOP;
 FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
 AND (p.proname LIKE 'shared_%' OR p.proname IN ('guard_shared_registration_business','approve_shared_review_brand_member','revoke_shared_review_brand_member','consume_shared_review_brand_member')) LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
 END LOOP;
END $$;
COMMIT;
