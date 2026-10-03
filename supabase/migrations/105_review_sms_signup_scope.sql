-- Opt-in is a business owner's explicit choice for a new texting filing.
-- No existing campaign or account is upgraded by this migration.
ALTER TABLE public.businesses ADD COLUMN review_sms_signup_enabled boolean NOT NULL DEFAULT false;

CREATE FUNCTION public.guard_review_sms_signup_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF (TG_OP='INSERT' AND NEW.review_sms_signup_enabled)
     OR (TG_OP='UPDATE' AND NEW.review_sms_signup_enabled IS DISTINCT FROM OLD.review_sms_signup_enabled) THEN
    IF current_user NOT IN ('service_role','postgres','supabase_admin') THEN
      RAISE EXCEPTION 'review_sms_signup_scope_service_only';
    END IF;
    IF TG_OP='UPDATE' AND (
      OLD.telnyx_campaign_id IS NOT NULL OR OLD.onboarding_completed_at IS NOT NULL
      OR COALESCE(OLD.onboarding_registration_status,'not_started') NOT IN ('not_started','failed')
    ) THEN
      RAISE EXCEPTION 'review_sms_signup_scope_locked';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_review_sms_signup_scope BEFORE INSERT OR UPDATE OF review_sms_signup_enabled
ON public.businesses FOR EACH ROW EXECUTE FUNCTION public.guard_review_sms_signup_scope();
