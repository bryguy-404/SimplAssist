-- The hosted keyword program requires customer-originated permission, not
-- an owner checkbox. Existing approved custom consent programs are unchanged.
CREATE FUNCTION public.review_sms_requires_keyword(p_business uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT b.review_sms_signup_enabled OR EXISTS(
   SELECT 1 FROM review_sms_accounts a WHERE a.business_id=b.id AND a.draft->>'consentMode'='hosted_keyword'
 ) FROM businesses b WHERE b.id=p_business),false)
$$;

CREATE FUNCTION public.review_sms_has_keyword_consent(p_business uuid,p_contact uuid,p_destination text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(
  SELECT 1 FROM review_permissions rp
  JOIN review_sms_consent_events ce ON ce.id=rp.sms_consent_event_id AND ce.business_id=rp.business_id
  JOIN review_sms_accounts a ON a.business_id=rp.business_id
  JOIN businesses b ON b.id=a.business_id AND b.owner_id=a.owner_id
  JOIN phone_numbers pn ON pn.id=a.phone_number_id AND pn.business_id=a.business_id
  WHERE rp.business_id=p_business AND rp.contact_id=p_contact AND rp.destination=p_destination
   AND rp.revoked_at IS NULL AND rp.actor_id IS NULL
   AND ce.outcome='granted' AND ce.keyword='REVIEWS' AND ce.copy_version='review-texts-v1'
   AND ce.destination=p_destination AND ce.messaging_profile_id=a.messaging_profile_id
   AND ce.messaging_profile_id=b.telnyx_messaging_profile_id AND ce.sender=pn.phone_number
   AND pn.is_active AND pn.telnyx_campaign_assignment_status='assigned'
   AND pn.telnyx_campaign_assignment_campaign_id=a.campaign_id
   AND a.campaign_id=b.telnyx_campaign_id
 )
$$;

ALTER FUNCTION public.review_recipient_block(uuid,uuid,text,text[],uuid) RENAME TO review_recipient_block_before_keyword_consent;
CREATE FUNCTION public.review_recipient_block(p_business uuid,p_contact uuid,p_destination text,p_identities text[],p_exclude uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE reason text;
BEGIN
 reason:=review_recipient_block_before_keyword_consent(p_business,p_contact,p_destination,p_identities,p_exclude);
 IF reason IS NOT NULL THEN RETURN reason; END IF;
 IF p_destination NOT LIKE '%@%' AND review_sms_requires_keyword(p_business)
    AND NOT review_sms_has_keyword_consent(p_business,p_contact,p_destination)
 THEN RETURN 'review_sms_keyword_permission_required'; END IF;
 RETURN NULL;
END $$;

ALTER FUNCTION public.review_record_permission(uuid,uuid,uuid,text,boolean,text,text) RENAME TO review_record_permission_before_keyword_consent;
CREATE FUNCTION public.review_record_permission(p_business uuid,p_owner uuid,p_contact uuid,p_channel text,p_granted boolean,p_evidence text,p_timezone text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM review_assert_owner(p_business,p_owner);
 IF p_channel='sms' AND p_granted AND review_sms_requires_keyword(p_business) THEN
  RAISE EXCEPTION 'review_sms_keyword_permission_required' USING ERRCODE='22023';
 END IF;
 PERFORM review_record_permission_before_keyword_consent(p_business,p_owner,p_contact,p_channel,p_granted,p_evidence,p_timezone);
END $$;

-- Recheck at the final reservation boundary, after a worker has begun a send.
-- Idempotent receipt lookups remain valid after permission is withdrawn.
ALTER FUNCTION public.reserve_tenant_sms(uuid,uuid,text,text,text,text,text,text,integer,uuid,uuid) RENAME TO reserve_tenant_sms_before_keyword_consent;
CREATE FUNCTION public.reserve_tenant_sms(p_business uuid,p_period uuid,p_key text,p_fingerprint text,p_purpose text,
 p_profile text,p_from text,p_to text,p_parts integer,p_conversation uuid DEFAULT NULL,p_enrollment uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE contact uuid;
BEGIN
 PERFORM 1 FROM businesses WHERE id=p_business FOR UPDATE;
 IF p_purpose IN ('review_invitation','review_reminder') AND review_sms_requires_keyword(p_business)
    AND NOT EXISTS(SELECT 1 FROM tenant_sms_sends WHERE business_id=p_business AND idempotency_key=p_key) THEN
  SELECT original_contact_id INTO contact FROM review_enrollments
   WHERE id=p_enrollment AND business_id=p_business AND channel='sms' AND destination=p_to;
  IF contact IS NULL OR NOT review_sms_has_keyword_consent(p_business,contact,p_to) THEN
   RAISE EXCEPTION 'sms_review_keyword_permission_required' USING ERRCODE='22023';
  END IF;
 END IF;
 RETURN reserve_tenant_sms_before_keyword_consent(p_business,p_period,p_key,p_fingerprint,p_purpose,p_profile,p_from,p_to,p_parts,p_conversation,p_enrollment);
END $$;

REVOKE ALL ON FUNCTION public.review_sms_requires_keyword(uuid),public.review_sms_has_keyword_consent(uuid,uuid,text),
 public.review_recipient_block(uuid,uuid,text,text[],uuid),public.review_record_permission(uuid,uuid,uuid,text,boolean,text,text),
 public.reserve_tenant_sms(uuid,uuid,text,text,text,text,text,text,integer,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.review_sms_requires_keyword(uuid),public.review_sms_has_keyword_consent(uuid,uuid,text),
 public.review_recipient_block(uuid,uuid,text,text[],uuid),public.review_record_permission(uuid,uuid,uuid,text,boolean,text,text),
 public.reserve_tenant_sms(uuid,uuid,text,text,text,text,text,text,integer,uuid,uuid) TO service_role;
