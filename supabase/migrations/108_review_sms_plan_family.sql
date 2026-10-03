BEGIN;

-- A Chat account may own a narrowly scoped review-texting number without
-- acquiring the SMS/voice base-plan family. Preserve a service-owned binding
-- for every resource created by that separate, paid review setup.
ALTER TABLE public.review_sms_accounts
 ADD COLUMN brand_id text,
 ADD COLUMN voice_application_id text;

CREATE FUNCTION public.review_sms_owns_plan_family_resources(p_business uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT
  a.billing_source='direct' AND a.exclusive_resources
  AND a.activation_paid_at IS NOT NULL AND a.provider_started_at IS NOT NULL
  AND a.activation_refunded_at IS NULL
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
    (a.brand_id IS NOT NULL AND other.telnyx_brand_id=a.brand_id)
    OR (a.campaign_id IS NOT NULL AND other.telnyx_campaign_id=a.campaign_id)
    OR (a.messaging_profile_id IS NOT NULL AND other.telnyx_messaging_profile_id=a.messaging_profile_id)
    OR (a.voice_application_id IS NOT NULL AND other.telnyx_voice_application_id=a.voice_application_id))
  )
  AND NOT EXISTS (
   SELECT 1 FROM telnyx_managed_resources r WHERE r.business_id<>b.id
    AND r.local_claim_active AND r.ownership_state<>'released' AND coalesce(CASE r.resource_type
     WHEN 'brand' THEN r.provider_id=a.brand_id
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
REVOKE ALL ON FUNCTION public.review_sms_owns_plan_family_resources(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.review_sms_owns_plan_family_resources(uuid) TO service_role;

-- Keep the paid Chat -> SMS transition wrapper from migration 091 intact.
-- Only resource evidence is qualified here; subscriptions, pending plans,
-- partner jobs and historical SMS usage remain conflicting SMS evidence.
CREATE OR REPLACE FUNCTION public.infer_business_plan_family_before_chat_upgrade(p_business_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE v_has_chat boolean; v_has_sms boolean;
 v_review_resources boolean:=public.review_sms_owns_plan_family_resources(p_business_id);
BEGIN
 SELECT
  EXISTS(SELECT 1 FROM subscriptions s WHERE s.business_id=p_business_id AND (s.plan='chat_only' OR s.pending_plan='chat_only'))
  OR EXISTS(SELECT 1 FROM partner_client_provisioning_jobs j WHERE j.business_id=p_business_id AND j.partner_plan='chat_only')
  OR EXISTS(SELECT 1 FROM businesses b WHERE b.id=p_business_id AND b.partner_plan='chat_only')
  OR EXISTS(SELECT 1 FROM billing_usage_periods u WHERE u.business_id=p_business_id AND u.plan='chat_only'),
  EXISTS(SELECT 1 FROM subscriptions s WHERE s.business_id=p_business_id AND (s.plan IN ('sms_only','sms_and_chat','full') OR s.pending_plan IN ('sms_only','sms_and_chat','full')))
  OR EXISTS(SELECT 1 FROM businesses b WHERE b.id=p_business_id AND (
   b.partner_plan IN ('sms_only','sms_and_chat','full')
   OR (b.billing_mode='stripe' AND b.partner_plan IS NULL
    AND NOT EXISTS(SELECT 1 FROM subscriptions s WHERE s.business_id=b.id)
    AND (b.billing_pilot OR b.billing_comped OR b.billing_exempt))
   OR (NOT v_review_resources AND (
    b.telnyx_brand_id IS NOT NULL OR b.telnyx_campaign_id IS NOT NULL
    OR b.telnyx_messaging_profile_id IS NOT NULL OR b.telnyx_voice_application_id IS NOT NULL
    OR b.active_telnyx_release_run_id IS NOT NULL
    OR b.telnyx_resource_state IN ('active','parked','release_pending','releasing','blocked','protected_hold')))))
  OR EXISTS(SELECT 1 FROM partner_client_provisioning_jobs j WHERE j.business_id=p_business_id AND j.partner_plan IN ('sms_only','sms_and_chat','full'))
  OR EXISTS(SELECT 1 FROM billing_usage_periods u WHERE u.business_id=p_business_id AND u.plan IN ('sms_only','sms_and_chat','full'))
  OR (NOT v_review_resources AND EXISTS(SELECT 1 FROM phone_numbers pn WHERE pn.business_id=p_business_id AND pn.resource_status<>'released' AND (pn.is_active OR pn.telnyx_phone_number_id IS NOT NULL)))
  OR (NOT v_review_resources AND EXISTS(SELECT 1 FROM telnyx_managed_resources r WHERE r.business_id=p_business_id AND r.local_claim_active AND r.ownership_state<>'released'))
 INTO v_has_chat,v_has_sms;
 IF v_has_chat AND v_has_sms THEN RAISE EXCEPTION 'business_plan_family_evidence_conflict' USING ERRCODE='55000'; END IF;
 IF v_has_chat THEN RETURN 'chat_only'; END IF;
 IF v_has_sms THEN RETURN 'sms'; END IF;
 RETURN NULL;
END $$;

COMMENT ON FUNCTION public.review_sms_owns_plan_family_resources(uuid) IS
 'Service-only exact ownership evidence for paid, subscription-bound direct Chat review resources; never grants base SMS or voice access.';
COMMIT;
