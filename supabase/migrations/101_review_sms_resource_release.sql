CREATE TABLE public.review_sms_release_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL REFERENCES public.review_sms_accounts(id) ON DELETE CASCADE,
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 operation text NOT NULL CHECK(operation IN ('unassign_phone_number_campaign','release_phone_number','deactivate_campaign')),
 ordinal integer NOT NULL,provider_id text NOT NULL,canonical_e164 text,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','submitting','completed','unknown')),
 claim_token uuid,lease_until timestamptz,started_at timestamptz,completed_at timestamptz,last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(account_id,operation)
);
ALTER TABLE public.review_sms_release_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.review_sms_release_actions FROM anon,authenticated;
GRANT ALL ON public.review_sms_release_actions TO service_role;

CREATE FUNCTION public.review_sms_prepare_release(p_business uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a review_sms_accounts;b businesses;pn phone_numbers;v_plan text;
BEGIN
 SELECT * INTO b FROM businesses WHERE id=p_business FOR UPDATE;
 SELECT * INTO a FROM review_sms_accounts WHERE business_id=p_business FOR UPDATE;
 IF NOT FOUND OR a.state='released' THEN RETURN false; END IF;
 IF NOT coalesce(((a.state='ready_unpaid' AND a.ready_expires_at<=now()) OR (a.state='cancel_pending' AND a.cancel_at<=now()) OR (a.state='release_pending' AND a.release_at<=now())),false) THEN RETURN false; END IF;
 SELECT plan INTO v_plan FROM review_business_billing(p_business);
 -- A subsequent base SMS service owns the shared number and campaign. Keep
 -- those resources; review-addon cancellation cannot release another service.
 IF NOT a.exclusive_resources OR v_plan IN ('sms_only','sms_and_chat','full') THEN
  UPDATE review_sms_accounts SET state='released',released_at=now(),updated_at=now() WHERE id=a.id;RETURN false;
 END IF;
 IF b.active_telnyx_release_run_id IS NOT NULL OR EXISTS(SELECT 1 FROM chat_texting_upgrades WHERE business_id=p_business AND state NOT IN ('abandoned','support_required')) THEN RETURN false; END IF;
 SELECT * INTO pn FROM phone_numbers WHERE id=a.phone_number_id AND business_id=p_business;
 IF NOT FOUND OR nullif(pn.telnyx_phone_number_id,'') IS NULL OR nullif(a.campaign_id,'') IS NULL OR nullif(a.messaging_profile_id,'') IS NULL OR b.telnyx_campaign_id IS DISTINCT FROM a.campaign_id OR b.telnyx_messaging_profile_id IS DISTINCT FROM a.messaging_profile_id THEN RETURN false; END IF;
 UPDATE review_sms_accounts SET state='release_pending',release_at=coalesce(release_at,now()),updated_at=now() WHERE id=a.id;
 INSERT INTO review_sms_release_actions(account_id,business_id,operation,ordinal,provider_id,canonical_e164)
 VALUES(a.id,p_business,'unassign_phone_number_campaign',1,pn.telnyx_phone_number_id,pn.phone_number),
 (a.id,p_business,'release_phone_number',2,pn.telnyx_phone_number_id,pn.phone_number),
 (a.id,p_business,'deactivate_campaign',3,a.campaign_id,NULL) ON CONFLICT DO NOTHING;
 RETURN true;
END $$;
CREATE FUNCTION public.review_sms_claim_release() RETURNS SETOF public.review_sms_release_actions
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE action review_sms_release_actions;
BEGIN
 -- A crashed provider boundary is ambiguous. Leave it for reconciliation;
 -- never blindly repeat a campaign deactivation.
 UPDATE review_sms_release_actions SET state='unknown',last_error='release_outcome_unknown'
 WHERE state='submitting' AND lease_until<=now();
 SELECT * INTO action FROM review_sms_release_actions x
 WHERE (x.state='pending' OR (x.state='claimed' AND x.lease_until<=now()))
 AND EXISTS(SELECT 1 FROM review_sms_accounts account WHERE account.id=x.account_id AND account.state='release_pending')
 AND NOT EXISTS(SELECT 1 FROM review_sms_release_actions prior WHERE prior.account_id=x.account_id AND prior.ordinal<x.ordinal AND prior.state<>'completed')
 ORDER BY x.created_at,x.ordinal FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN; END IF;
 UPDATE review_sms_release_actions SET state='claimed',claim_token=gen_random_uuid(),lease_until=now()+interval '2 minutes'
 WHERE id=action.id RETURNING * INTO action;RETURN NEXT action;
END $$;
CREATE FUNCTION public.authorize_review_sms_remote_mutation(p_business_id uuid,p_context text,p_operation text,p_provider_id text,p_action_id uuid,p_lease_token uuid,p_expected_shared_messaging_profile_id text,p_expected_shared_voice_application_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a review_sms_accounts;x review_sms_release_actions;b businesses;pn phone_numbers;c telnyx_resource_release_config;
BEGIN
 SELECT * INTO b FROM businesses WHERE id=p_business_id FOR UPDATE;
 SELECT * INTO a FROM review_sms_accounts WHERE business_id=p_business_id FOR UPDATE;
 SELECT * INTO x FROM review_sms_release_actions WHERE id=p_action_id AND account_id=a.id FOR UPDATE;
 SELECT * INTO c FROM telnyx_resource_release_config WHERE id=1;
 SELECT * INTO pn FROM phone_numbers WHERE id=a.phone_number_id;
 IF coalesce(p_context IS DISTINCT FROM 'review_sms_release' OR p_action_id IS NULL OR p_lease_token IS NULL OR nullif(p_provider_id,'') IS NULL OR p_operation IS NULL
  OR nullif(p_expected_shared_messaging_profile_id,'') IS NULL OR nullif(p_expected_shared_voice_application_id,'') IS NULL
  OR a.id IS NULL OR b.id IS NULL OR pn.id IS NULL OR x.id IS NULL OR x.state NOT IN ('claimed','submitting') OR x.claim_token IS DISTINCT FROM p_lease_token OR x.lease_until IS NULL OR x.lease_until<=now()
  OR x.operation IS DISTINCT FROM p_operation OR x.provider_id IS DISTINCT FROM p_provider_id OR a.state<>'release_pending' OR NOT a.exclusive_resources OR a.release_at IS NULL OR a.release_at>now()
  OR b.active_telnyx_release_run_id IS NOT NULL OR b.telnyx_campaign_id IS DISTINCT FROM a.campaign_id
  OR b.telnyx_messaging_profile_id IS DISTINCT FROM a.messaging_profile_id OR pn.business_id<>b.id
  OR c.id IS NULL OR c.mode='disabled' OR (c.mode='single_business' AND c.single_business_id IS DISTINCT FROM b.id)
  OR c.expected_shared_messaging_profile_id IS DISTINCT FROM p_expected_shared_messaging_profile_id
  OR c.expected_shared_voice_application_id IS DISTINCT FROM p_expected_shared_voice_application_id
  OR c.protection_manifest_fingerprint IS NULL OR c.protection_manifest_fingerprint IS DISTINCT FROM telnyx_release_manifest_fingerprint(p_expected_shared_messaging_profile_id,p_expected_shared_voice_application_id)
  OR c.dry_run_completed_at IS NULL OR c.protection_manifest_verified_at IS NULL
  OR (c.mode='enabled' AND c.single_business_test_completed_at IS NULL)
  OR b.telnyx_messaging_profile_id IS NOT DISTINCT FROM p_expected_shared_messaging_profile_id OR b.telnyx_voice_application_id IS NOT DISTINCT FROM p_expected_shared_voice_application_id
  OR coalesce((SELECT plan FROM review_business_billing(b.id)) IN ('sms_only','sms_and_chat','full'),false)
  OR NOT EXISTS(SELECT 1 FROM subscriptions s WHERE s.business_id=b.id AND s.plan='chat_only' AND s.stripe_subscription_id=a.source_subscription_id AND s.stripe_customer_id=a.source_customer_id)
  OR EXISTS(SELECT 1 FROM chat_texting_upgrades WHERE business_id=b.id AND state NOT IN ('abandoned','support_required'))
  OR EXISTS(SELECT 1 FROM businesses other WHERE other.id<>b.id AND (other.telnyx_campaign_id=a.campaign_id OR other.telnyx_messaging_profile_id=a.messaging_profile_id))
  OR EXISTS(SELECT 1 FROM phone_numbers other WHERE other.business_id<>b.id AND (other.telnyx_phone_number_id=pn.telnyx_phone_number_id OR other.phone_number=pn.phone_number))
  OR EXISTS(SELECT 1 FROM telnyx_release_protections p WHERE (p.scope='business_all' AND p.business_id=b.id) OR (p.scope='resource' AND (p.provider_id IN (x.provider_id,a.messaging_profile_id,a.campaign_id) OR p.canonical_e164=pn.phone_number)))
  OR EXISTS(SELECT 1 FROM telnyx_managed_resources r WHERE r.business_id IS DISTINCT FROM b.id AND r.local_claim_active AND (r.provider_id=x.provider_id OR r.canonical_e164=pn.phone_number))
  OR EXISTS(SELECT 1 FROM owner_booking_alert_control WHERE sender=pn.phone_number OR messaging_profile_id=a.messaging_profile_id)
  OR EXISTS(SELECT 1 FROM review_sms_release_actions prior WHERE prior.account_id=a.id AND prior.ordinal<x.ordinal AND prior.state<>'completed'),true)
 THEN RAISE EXCEPTION 'review_sms_release_not_authorized' USING ERRCODE='42501'; END IF;
 IF (p_operation IN ('release_phone_number','unassign_phone_number_campaign') AND (x.provider_id IS DISTINCT FROM pn.telnyx_phone_number_id OR x.canonical_e164 IS DISTINCT FROM pn.phone_number))
  OR (p_operation='deactivate_campaign' AND x.provider_id IS DISTINCT FROM a.campaign_id) THEN RAISE EXCEPTION 'review_sms_release_target_changed' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('authorized',true,'business_id',b.id,'context',p_context,'operation',p_operation,'action_id',x.id,'provider_id',x.provider_id,'canonical_e164',x.canonical_e164,'public_tcr_id',NULL,'config_updated_at',c.updated_at);
END $$;
CREATE FUNCTION public.review_sms_finish_release(p_action uuid,p_claim uuid,p_success boolean,p_error text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE x review_sms_release_actions;a review_sms_accounts;
BEGIN
 SELECT * INTO x FROM review_sms_release_actions WHERE id=p_action FOR UPDATE;
 IF NOT FOUND OR p_claim IS NULL OR x.claim_token IS DISTINCT FROM p_claim OR x.state<>'submitting' OR p_success IS NULL THEN RETURN false; END IF;
 UPDATE review_sms_release_actions SET state=CASE WHEN p_success THEN 'completed' ELSE 'unknown' END,
  completed_at=CASE WHEN p_success THEN now() END,last_error=p_error WHERE id=x.id;
 IF NOT p_success THEN UPDATE review_sms_accounts SET last_error='review_sms_release_needs_attention' WHERE id=x.account_id;RETURN true; END IF;
 SELECT * INTO a FROM review_sms_accounts WHERE id=x.account_id FOR UPDATE;
 IF x.operation='release_phone_number' THEN UPDATE phone_numbers SET is_active=false WHERE id=a.phone_number_id; END IF;
 IF NOT EXISTS(SELECT 1 FROM review_sms_release_actions WHERE account_id=a.id AND state<>'completed') THEN
  UPDATE phone_numbers SET is_active=false,telnyx_campaign_assignment_status='unassigned',telnyx_campaign_assignment_campaign_id=NULL WHERE id=a.phone_number_id;
  UPDATE businesses SET telnyx_campaign_id=NULL,campaign_status=NULL WHERE id=a.business_id AND telnyx_campaign_id=a.campaign_id;
  UPDATE telnyx_managed_resources SET local_claim_active=false,ownership_state='released',released_at=now(),updated_at=now()
   WHERE business_id=a.business_id AND ((resource_type='campaign' AND provider_id=a.campaign_id) OR (resource_type='phone_number' AND phone_number_id=a.phone_number_id));
  UPDATE review_sms_accounts SET state='released',released_at=now(),last_error=NULL,updated_at=now() WHERE id=a.id;
 END IF;RETURN true;
END $$;
DO $$ DECLARE f record;BEGIN FOR f IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN ('review_sms_prepare_release','review_sms_claim_release','authorize_review_sms_remote_mutation','review_sms_finish_release') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);END LOOP;END $$;
