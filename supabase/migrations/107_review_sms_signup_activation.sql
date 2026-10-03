-- Service-only synchronization for new paid texting signups that explicitly
-- requested review texts. Provider approval is verified server-side first;
-- current ownership, entitlement and sender assignment are rechecked here.
CREATE FUNCTION public.review_sms_initialize_signup(p_business uuid, p_owner uuid, p_draft jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b businesses; a review_sms_accounts; v_plan text;
BEGIN
 PERFORM review_assert_owner(p_business,p_owner);
 SELECT * INTO b FROM businesses WHERE id=p_business;
 SELECT plan INTO v_plan FROM review_business_billing(p_business) WHERE allowed;
 IF NOT b.review_sms_signup_enabled OR NOT review_program_enabled(p_business)
   OR v_plan IS NULL OR v_plan NOT IN ('sms_only','sms_and_chat','full')
   OR b.telnyx_submission_disabled OR b.operations_suspended_at IS NOT NULL OR b.texting_paused_at IS NOT NULL
   OR b.active_telnyx_release_run_id IS NOT NULL THEN RETURN false; END IF;
 SELECT * INTO a FROM review_sms_accounts WHERE business_id=p_business FOR UPDATE;
 IF a.id IS NULL THEN
   a := review_sms_acquire_account(p_business,p_owner,p_draft);
 END IF;
 IF a.billing_source<>'included' OR a.owner_id IS DISTINCT FROM p_owner THEN RETURN false; END IF;
 IF a.state='draft' AND a.cancel_at IS NULL AND a.provider_started_at IS NULL THEN
   UPDATE review_sms_accounts SET state='carrier_pending',draft=p_draft,updated_at=now() WHERE id=a.id;
 END IF;
 RETURN true;
END $$;

CREATE FUNCTION public.review_sms_activate_signup(p_business uuid,p_owner uuid,p_campaign text,p_profile text,p_phone uuid,p_evidence text,p_forbidden_profiles text[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b businesses; a review_sms_accounts; pn phone_numbers; v_plan text;
BEGIN
 PERFORM review_assert_owner(p_business,p_owner);
 SELECT * INTO b FROM businesses WHERE id=p_business;
 SELECT * INTO a FROM review_sms_accounts WHERE business_id=p_business FOR UPDATE;
 SELECT * INTO pn FROM phone_numbers WHERE id=p_phone AND business_id=p_business AND is_active;
 SELECT plan INTO v_plan FROM review_business_billing(p_business) WHERE allowed;
 IF NOT b.review_sms_signup_enabled OR NOT review_program_enabled(p_business)
   OR v_plan IS NULL OR v_plan NOT IN ('sms_only','sms_and_chat','full')
   OR b.telnyx_submission_disabled OR b.texting_paused_at IS NOT NULL OR b.active_telnyx_release_run_id IS NOT NULL
   OR b.campaign_status IS DISTINCT FROM 'approved' OR b.telnyx_campaign_id IS DISTINCT FROM p_campaign
   OR b.telnyx_messaging_profile_id IS DISTINCT FROM p_profile
   OR a.id IS NULL OR a.billing_source<>'included' OR a.owner_id IS DISTINCT FROM p_owner
   OR a.state NOT IN ('draft','carrier_pending','active') OR a.cancel_at IS NOT NULL
   OR a.exclusive_resources OR a.stripe_item_id IS NOT NULL OR pn.id IS NULL
   OR pn.telnyx_campaign_assignment_status IS DISTINCT FROM 'assigned'
   OR pn.telnyx_campaign_assignment_campaign_id IS DISTINCT FROM p_campaign
   OR coalesce(length(trim(p_evidence)),0)<20
   OR NOT review_sms_resource_scope_safe(p_business,p_profile,pn.phone_number,p_campaign,p_forbidden_profiles)
 THEN RETURN false; END IF;
 UPDATE review_sms_accounts SET state='active',review_usecase_approved_at=coalesce(review_usecase_approved_at,now()),
   approval_evidence=p_evidence,campaign_id=p_campaign,messaging_profile_id=p_profile,phone_number_id=p_phone,
   ready_at=coalesce(ready_at,now()),last_error=NULL,updated_at=now() WHERE id=a.id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.review_sms_initialize_signup(uuid,uuid,jsonb),public.review_sms_activate_signup(uuid,uuid,text,text,uuid,text,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.review_sms_initialize_signup(uuid,uuid,jsonb),public.review_sms_activate_signup(uuid,uuid,text,text,uuid,text,text[]) TO service_role;
