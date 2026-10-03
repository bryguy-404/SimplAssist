-- Chat signup does not run the ordinary SMS use-case form which assigns a
-- public business slug. Allocate it once, with collision handling inside the
-- owner lock, before building the hosted review-text consent URL.
CREATE FUNCTION public.review_sms_prepare_hosted_slug(p_business uuid,p_owner uuid,p_base text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b businesses; a review_sms_accounts; candidate text; attempt integer;
BEGIN
 PERFORM review_assert_owner(p_business,p_owner);
 SELECT * INTO b FROM businesses WHERE id=p_business;
 IF b.operations_suspended_at IS NOT NULL THEN RAISE EXCEPTION 'review_sms_forbidden'; END IF;
 SELECT * INTO a FROM review_sms_accounts WHERE business_id=p_business FOR UPDATE;
 IF a.id IS NOT NULL AND (a.state<>'draft' OR a.provider_started_at IS NOT NULL) THEN
  RAISE EXCEPTION 'review_sms_setup_already_started';
 END IF;
 IF b.slug IS NOT NULL AND b.slug<>'' AND b.slug NOT LIKE 'pending-%' THEN RETURN b.slug; END IF;
 IF b.telnyx_campaign_id IS NOT NULL OR b.telnyx_brand_id IS NOT NULL THEN
  RAISE EXCEPTION 'review_sms_existing_brand_identity_locked';
 END IF;
 IF p_base IS NULL OR length(p_base)>60 OR p_base !~ '^[a-z0-9][a-z0-9-]*$'
  OR p_base LIKE 'pending-%' OR p_base LIKE 'deleted-%' THEN
  RAISE EXCEPTION 'review_sms_slug_invalid';
 END IF;
 candidate:=p_base;
 FOR attempt IN 0..5 LOOP
  BEGIN
   UPDATE businesses SET slug=candidate WHERE id=p_business;
   RETURN candidate;
  EXCEPTION WHEN unique_violation THEN
   candidate:=p_base||'-'||substr(replace(gen_random_uuid()::text,'-',''),1,8);
  END;
 END LOOP;
 RAISE EXCEPTION 'review_sms_slug_unavailable';
END $$;
REVOKE ALL ON FUNCTION public.review_sms_prepare_hosted_slug(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.review_sms_prepare_hosted_slug(uuid,uuid,text) TO service_role;
