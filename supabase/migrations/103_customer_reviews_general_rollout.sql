-- New signups can use reviews without an ongoing per-business pilot list.
-- Explicit exclusions preserve existing accounts until an owner opts them in.
-- Neither feature admission nor this migration enables customer delivery.
ALTER TABLE public.review_email_control
 ADD COLUMN all_businesses_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN excluded_business_ids uuid[] NOT NULL DEFAULT '{}';

CREATE OR REPLACE FUNCTION public.review_program_enabled(p_business uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT coalesce((
  SELECT enabled AND p_business IS NOT NULL
   AND EXISTS(SELECT 1 FROM businesses WHERE id=p_business AND deleted_at IS NULL)
   AND NOT p_business=ANY(excluded_business_ids)
   AND (all_businesses_enabled OR p_business=ANY(pilot_business_ids))
  FROM review_email_control WHERE singleton
 ),false)
$$;

REVOKE ALL ON FUNCTION public.review_program_enabled(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.review_program_enabled(uuid) TO service_role;
