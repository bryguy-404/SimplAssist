ALTER TABLE public.review_sms_accounts ADD COLUMN provider_brand_attempted_at timestamptz;
CREATE FUNCTION public.review_sms_save_setup(p_business uuid,p_owner uuid,p_patch jsonb,p_draft jsonb)
RETURNS public.review_sms_accounts LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b businesses; a review_sms_accounts;
BEGIN
 PERFORM review_assert_owner(p_business,p_owner);
 SELECT * INTO b FROM businesses WHERE id=p_business;
 SELECT * INTO a FROM review_sms_accounts WHERE business_id=p_business FOR UPDATE;
 IF FOUND AND (a.state<>'draft' OR a.provider_started_at IS NOT NULL) THEN RAISE EXCEPTION 'review_sms_setup_already_started'; END IF;
 IF b.telnyx_brand_id IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_each(p_patch) p WHERE p.key<>'compliance_info_completed_at' AND p.value IS DISTINCT FROM to_jsonb(b)->p.key) THEN RAISE EXCEPTION 'review_sms_existing_brand_identity_locked'; END IF;
 UPDATE businesses SET legal_business_name=coalesce(p_patch->>'legal_business_name',legal_business_name),
  business_entity_type=coalesce(p_patch->>'business_entity_type',business_entity_type),ein=coalesce(p_patch->>'ein',ein),has_ein=coalesce((p_patch->>'has_ein')::boolean,has_ein),
  address=coalesce(p_patch->>'address',address),city=coalesce(p_patch->>'city',city),state=coalesce(p_patch->>'state',state),zip=coalesce(p_patch->>'zip',zip),
  authorized_rep_name=coalesce(p_patch->>'authorized_rep_name',authorized_rep_name),authorized_rep_email=coalesce(p_patch->>'authorized_rep_email',authorized_rep_email),authorized_rep_phone=coalesce(p_patch->>'authorized_rep_phone',authorized_rep_phone),
  compliance_info_completed_at=coalesce(compliance_info_completed_at,(p_patch->>'compliance_info_completed_at')::timestamptz)
  WHERE id=p_business;
 RETURN review_sms_acquire_account(p_business,p_owner,p_draft);
END $$;
CREATE FUNCTION public.review_sms_provisioning_claim_valid(p_business uuid,p_claim uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT a.state='carrier_pending' AND a.provisioning_claim=p_claim AND a.provisioning_lease_until>now()
  AND a.activation_paid_at IS NOT NULL AND a.activation_refunded_at IS NULL AND a.cancel_at IS NULL
  AND b.owner_id=a.owner_id AND b.deleted_at IS NULL AND b.operations_suspended_at IS NULL
  AND NOT b.telnyx_submission_disabled AND b.active_telnyx_release_run_id IS NULL
  AND (SELECT allowed FROM review_business_billing(b.id))
  FROM review_sms_accounts a JOIN businesses b ON b.id=a.business_id WHERE a.business_id=p_business),false)
$$;
CREATE FUNCTION public.review_sms_reserve_campaign_submission(p_business uuid,p_claim uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM businesses WHERE id=p_business FOR UPDATE;
 PERFORM 1 FROM review_sms_accounts WHERE business_id=p_business FOR UPDATE;
 IF NOT review_sms_provisioning_claim_valid(p_business,p_claim) THEN RETURN false; END IF;
 UPDATE review_sms_accounts SET provider_attempt_count=1,provider_started_at=coalesce(provider_started_at,now()),updated_at=now()
  WHERE business_id=p_business AND provider_attempt_count=0 AND campaign_id IS NULL;
 RETURN FOUND;
END $$;
CREATE FUNCTION public.review_sms_begin_paid_provider_step(p_business uuid,p_claim uuid,p_step text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM businesses WHERE id=p_business FOR UPDATE;
 PERFORM 1 FROM review_sms_accounts WHERE business_id=p_business FOR UPDATE;
 IF NOT review_sms_provisioning_claim_valid(p_business,p_claim) OR p_step IS NULL OR p_step NOT IN ('brand','number') THEN RETURN false; END IF;
 UPDATE review_sms_accounts SET provider_started_at=coalesce(provider_started_at,now()),
  provider_brand_attempted_at=CASE WHEN p_step='brand' THEN now() ELSE provider_brand_attempted_at END
  WHERE business_id=p_business AND (p_step<>'brand' OR provider_brand_attempted_at IS NULL);
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.review_sms_save_setup(uuid,uuid,jsonb,jsonb),public.review_sms_provisioning_claim_valid(uuid,uuid),public.review_sms_reserve_campaign_submission(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.review_sms_save_setup(uuid,uuid,jsonb,jsonb),public.review_sms_provisioning_claim_valid(uuid,uuid),public.review_sms_reserve_campaign_submission(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.review_sms_begin_paid_provider_step(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.review_sms_begin_paid_provider_step(uuid,uuid,text) TO service_role;

-- Readiness must belong to a tenant resource, never the platform alert sender
-- or a profile/number another business owns. Used before writes and approvals.
CREATE FUNCTION public.review_sms_resource_scope_safe(p_business uuid,p_profile text,p_sender text,p_campaign text,p_forbidden_profiles text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce((SELECT nullif(p_profile,'') IS NOT NULL AND p_sender ~ '^\+1[2-9][0-9]{9}$'
  AND coalesce(cardinality(p_forbidden_profiles),0)>0 AND NOT p_profile=ANY(p_forbidden_profiles)
  AND b.owner_id IS NOT NULL AND b.deleted_at IS NULL AND b.operations_suspended_at IS NULL
  AND b.telnyx_messaging_profile_id=p_profile AND b.telnyx_campaign_id IS NOT DISTINCT FROM p_campaign
  AND NOT EXISTS(SELECT 1 FROM owner_booking_alert_control WHERE sender=p_sender OR messaging_profile_id=p_profile)
  AND NOT EXISTS(SELECT 1 FROM telnyx_release_protections p WHERE (p.scope='business_all' AND p.business_id=b.id)
   OR (p.scope='resource' AND (p.provider_id IN (p_profile,p_campaign) OR p.canonical_e164=p_sender
    OR p.provider_id IN (SELECT telnyx_phone_number_id FROM phone_numbers WHERE business_id=b.id AND phone_number=p_sender))))
  AND NOT EXISTS(SELECT 1 FROM businesses other WHERE other.id<>b.id AND (other.telnyx_messaging_profile_id=p_profile OR (p_campaign IS NOT NULL AND other.telnyx_campaign_id=p_campaign)))
  AND NOT EXISTS(SELECT 1 FROM phone_numbers other WHERE other.business_id<>b.id AND other.phone_number=p_sender)
  AND NOT EXISTS(SELECT 1 FROM telnyx_managed_resources r WHERE r.business_id IS DISTINCT FROM b.id AND r.local_claim_active AND (r.provider_id IN (p_profile,p_campaign) OR r.canonical_e164=p_sender))
 FROM businesses b WHERE b.id=p_business),false)
$$;
CREATE FUNCTION public.review_sms_record_existing_approval(p_business uuid,p_admin uuid,p_campaign text,p_profile text,p_phone uuid,p_evidence text,p_grant_expires timestamptz,p_forbidden_profiles text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a review_sms_accounts;b businesses;pn phone_numbers;
BEGIN
 SELECT * INTO b FROM businesses WHERE id=p_business FOR UPDATE;
 SELECT * INTO a FROM review_sms_accounts WHERE business_id=p_business FOR UPDATE;
 SELECT * INTO pn FROM phone_numbers WHERE id=p_phone AND business_id=p_business AND is_active;
 IF a.id IS NULL OR a.owner_id IS DISTINCT FROM b.owner_id OR pn.id IS NULL OR p_admin IS NULL OR coalesce(length(trim(p_evidence)),0)<20
  OR b.telnyx_campaign_id IS DISTINCT FROM p_campaign OR b.telnyx_messaging_profile_id IS DISTINCT FROM p_profile
  OR NOT review_sms_resource_scope_safe(p_business,p_profile,pn.phone_number,p_campaign,p_forbidden_profiles)
  OR a.state IN ('release_pending','released','support_required')
 THEN RAISE EXCEPTION 'review_sms_approval_not_authorized' USING ERRCODE='42501';END IF;
 IF p_grant_expires IS NOT NULL AND (p_grant_expires<=now() OR (a.billing_source<>'grant' AND (a.state IN ('active','cancel_pending') OR a.stripe_item_id IS NOT NULL))) THEN RAISE EXCEPTION 'review_sms_paid_account_cannot_be_granted' USING ERRCODE='22023';END IF;
 -- Approval cannot rewind an active paid account to unpaid or erase a pending
 -- cancellation. Granting/re-granting must not silently resurrect cancellation.
 IF a.state='cancel_pending' THEN RAISE EXCEPTION 'review_sms_cancellation_pending' USING ERRCODE='22023';END IF;
 UPDATE review_sms_accounts SET state=CASE WHEN a.state='active' THEN 'active' WHEN a.billing_source='direct' AND p_grant_expires IS NULL THEN 'ready_unpaid' ELSE 'active' END,
 billing_source=CASE WHEN p_grant_expires IS NULL THEN billing_source ELSE 'grant' END,
 grant_actor=CASE WHEN p_grant_expires IS NULL THEN grant_actor ELSE p_admin END,grant_expires_at=coalesce(p_grant_expires,grant_expires_at),
 review_usecase_approved_at=now(),approval_evidence=trim(p_evidence),campaign_id=p_campaign,messaging_profile_id=p_profile,phone_number_id=pn.id,
 exclusive_resources=CASE WHEN a.campaign_id=p_campaign AND a.phone_number_id=pn.id THEN a.exclusive_resources ELSE false END,ready_at=coalesce(ready_at,now()),ready_expires_at=coalesce(ready_expires_at,now()+interval '7 days'),last_error=NULL,updated_at=now() WHERE id=a.id;
END $$;
REVOKE ALL ON FUNCTION public.review_sms_resource_scope_safe(uuid,text,text,text,text[]),public.review_sms_record_existing_approval(uuid,uuid,text,text,uuid,text,timestamptz,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.review_sms_resource_scope_safe(uuid,text,text,text,text[]),public.review_sms_record_existing_approval(uuid,uuid,text,text,uuid,text,timestamptz,text[]) TO service_role;
CREATE FUNCTION public.review_sms_record_provider_ready(p_business uuid,p_campaign text,p_profile text,p_phone uuid,p_forbidden_profiles text[]) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a review_sms_accounts;b businesses;pn phone_numbers;
BEGIN
 SELECT * INTO b FROM businesses WHERE id=p_business FOR UPDATE;
 SELECT * INTO a FROM review_sms_accounts WHERE business_id=p_business FOR UPDATE;
 SELECT * INTO pn FROM phone_numbers WHERE id=p_phone AND business_id=p_business AND is_active;
 IF a.id IS NULL OR a.owner_id IS DISTINCT FROM b.owner_id OR a.state NOT IN ('carrier_pending','ready_unpaid') OR a.cancel_at IS NOT NULL OR a.activation_refunded_at IS NOT NULL
  OR a.campaign_id IS DISTINCT FROM p_campaign OR a.provider_submitted_at IS NULL OR pn.id IS NULL
  OR NOT review_sms_resource_scope_safe(p_business,p_profile,pn.phone_number,p_campaign,p_forbidden_profiles)
 THEN RETURN false;END IF;
 UPDATE review_sms_accounts SET state=CASE WHEN billing_source='direct' THEN 'ready_unpaid' ELSE 'active' END,
  review_usecase_approved_at=now(),approval_evidence='provider:'||p_campaign||':MARKETING:reviews:'||a.id,
  phone_number_id=pn.id,messaging_profile_id=p_profile,ready_at=coalesce(ready_at,now()),ready_expires_at=coalesce(ready_expires_at,now()+interval '7 days'),last_error=NULL,updated_at=now() WHERE id=a.id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.review_sms_record_provider_ready(uuid,text,text,uuid,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.review_sms_record_provider_ready(uuid,text,text,uuid,text[]) TO service_role;
