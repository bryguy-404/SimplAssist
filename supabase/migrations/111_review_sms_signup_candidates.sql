-- Find only new, opted-in, paid texting accounts whose existing sender and
-- campaign can be reconciled. No dashboard visit or new provider fee is needed.
CREATE FUNCTION public.review_sms_signup_candidates(
 p_allowed_businesses uuid[] DEFAULT NULL,p_excluded_businesses uuid[] DEFAULT '{}',p_limit integer DEFAULT 5)
RETURNS TABLE(business_id uuid,owner_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT b.id,b.owner_id FROM businesses b
 JOIN LATERAL review_business_billing(b.id) billing ON billing.allowed
 WHERE b.review_sms_signup_enabled AND b.owner_id IS NOT NULL
  AND b.deleted_at IS NULL AND b.operations_suspended_at IS NULL
  AND NOT b.telnyx_submission_disabled AND b.texting_paused_at IS NULL
  AND b.active_telnyx_release_run_id IS NULL
  AND b.slug IS NOT NULL AND b.slug NOT LIKE 'pending-%'
  AND b.telnyx_campaign_id IS NOT NULL AND b.telnyx_messaging_profile_id IS NOT NULL
  AND billing.plan IN ('sms_only','sms_and_chat','full')
  AND review_program_enabled(b.id)
  AND (p_allowed_businesses IS NULL OR b.id=ANY(p_allowed_businesses))
  AND NOT b.id=ANY(coalesce(p_excluded_businesses,'{}'))
  AND NOT EXISTS(SELECT 1 FROM review_sms_accounts a WHERE a.business_id=b.id)
  AND 1=(SELECT count(*) FROM phone_numbers pn WHERE pn.business_id=b.id AND pn.is_active)
 ORDER BY b.created_at,b.id LIMIT greatest(0,least(coalesce(p_limit,5),20))
$$;
REVOKE ALL ON FUNCTION public.review_sms_signup_candidates(uuid[],uuid[],integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.review_sms_signup_candidates(uuid[],uuid[],integer) TO service_role;
