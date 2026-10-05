BEGIN;

-- Presentation preferences only. Nothing here grants an entitlement or starts billing.
CREATE TABLE public.dashboard_upgrade_preferences (
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  offer_key text NOT NULL CHECK (offer_key IN ('review_texting','growth','voice')),
  dismissal_count integer NOT NULL DEFAULT 0 CHECK (dismissal_count >= 0),
  snoozed_until timestamptz,
  hidden_at timestamptz,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, offer_key)
);
ALTER TABLE public.dashboard_upgrade_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dashboard_upgrade_preferences FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.dashboard_upgrade_preferences TO authenticated;
GRANT ALL ON public.dashboard_upgrade_preferences TO service_role;
CREATE POLICY dashboard_upgrade_preferences_owner_read ON public.dashboard_upgrade_preferences
FOR SELECT TO authenticated USING (EXISTS (
  SELECT 1 FROM public.businesses b WHERE b.id = business_id AND b.owner_id = auth.uid() AND b.deleted_at IS NULL
));

CREATE FUNCTION public.save_dashboard_upgrade_preference(
  p_business_id uuid, p_owner_id uuid, p_offer_key text, p_action text, p_expected_revision integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE b public.businesses; preference public.dashboard_upgrade_preferences; count_after integer;
BEGIN
  SELECT * INTO b FROM public.businesses WHERE id = p_business_id FOR UPDATE;
  IF b.id IS NULL OR b.owner_id IS DISTINCT FROM p_owner_id OR b.deleted_at IS NOT NULL
    OR b.operations_suspended_at IS NOT NULL OR b.billing_mode <> 'stripe' OR b.partner_id IS NOT NULL
    OR b.partner_plan IS NOT NULL OR b.billing_pilot OR b.billing_comped OR b.billing_exempt THEN
    RAISE EXCEPTION 'upgrade_prompt_forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_offer_key IS NULL OR p_offer_key NOT IN ('review_texting','growth','voice')
    OR p_action IS NULL OR p_action NOT IN ('snooze','hide')
    OR p_expected_revision IS NULL OR p_expected_revision < 0 THEN
    RAISE EXCEPTION 'upgrade_prompt_invalid' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.dashboard_upgrade_preferences(business_id, offer_key)
    VALUES (p_business_id, p_offer_key) ON CONFLICT DO NOTHING;
  SELECT * INTO preference FROM public.dashboard_upgrade_preferences
    WHERE business_id = p_business_id AND offer_key = p_offer_key FOR UPDATE;
  IF preference.revision <> p_expected_revision THEN
    RAISE EXCEPTION 'upgrade_prompt_changed' USING ERRCODE = '40001';
  END IF;
  count_after := preference.dismissal_count + CASE WHEN p_action = 'snooze' THEN 1 ELSE 0 END;
  UPDATE public.dashboard_upgrade_preferences SET
    dismissal_count = count_after,
    snoozed_until = CASE WHEN p_action = 'hide' THEN NULL ELSE now() + CASE WHEN count_after >= 3 THEN interval '30 days' ELSE interval '7 days' END END,
    hidden_at = CASE WHEN p_action = 'hide' THEN coalesce(hidden_at, now()) ELSE hidden_at END,
    revision = revision + 1, updated_at = now()
  WHERE business_id = p_business_id AND offer_key = p_offer_key RETURNING * INTO preference;
  RETURN to_jsonb(preference);
END $$;
REVOKE ALL ON FUNCTION public.save_dashboard_upgrade_preference(uuid,uuid,text,text,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_dashboard_upgrade_preference(uuid,uuid,text,text,integer) TO service_role;
COMMIT;
