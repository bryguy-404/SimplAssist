BEGIN;
-- Configuration is written only through an owner-bound, revision-checked RPC.
CREATE TABLE public.booking_settings (
  business_id uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 0 CHECK(revision >= 0),
  defaults jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.booking_service_settings (
  service_id uuid PRIMARY KEY REFERENCES public.services(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  setting jsonb NOT NULL
);
CREATE FUNCTION public.valid_booking_offering(p_value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
BEGIN
  RETURN COALESCE(jsonb_typeof(p_value)='object'
    AND p_value->>'format' IN ('phone_callback','business_visit','customer_site')
    AND jsonb_typeof(p_value->'label')='string' AND length(btrim(p_value->>'label')) BETWEEN 1 AND 240
    AND jsonb_typeof(p_value->'durationMinutes')='number'
    AND (p_value->>'durationMinutes')::numeric BETWEEN 30 AND 240
    AND mod((p_value->>'durationMinutes')::numeric,30)=0
    AND CASE WHEN p_value->>'format'='business_visit'
      THEN jsonb_typeof(p_value->'businessAddress')='string' AND length(btrim(p_value->>'businessAddress')) BETWEEN 1 AND 500
      ELSE p_value->'businessAddress'='null'::jsonb END,false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
ALTER TABLE public.booking_settings ADD CONSTRAINT booking_defaults_valid CHECK(defaults IS NULL OR public.valid_booking_offering(defaults));
ALTER TABLE public.booking_service_settings ADD CONSTRAINT booking_override_valid CHECK(
  COALESCE(setting->>'mode' IN ('inherit','unavailable') OR (setting->>'mode'='override' AND public.valid_booking_offering(setting->'offering')),false));
CREATE FUNCTION public.configure_booking_settings(p_business_id uuid,p_owner_id uuid,p_expected_revision integer,p_defaults jsonb,p_services jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE current_revision integer; item jsonb;
BEGIN
  PERFORM 1 FROM public.businesses WHERE id=p_business_id AND owner_id=p_owner_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR p_owner_id IS NULL THEN RAISE EXCEPTION 'booking access denied' USING ERRCODE='42501'; END IF;
  IF NOT public.website_scan_has_ai_customization_entitlement(p_business_id) AND NOT EXISTS(SELECT 1 FROM public.businesses WHERE id=p_business_id AND onboarding_completed_at IS NULL) THEN
    RAISE EXCEPTION 'booking feature unavailable' USING ERRCODE='42501'; END IF;
  IF NOT public.valid_booking_offering(p_defaults) OR jsonb_typeof(p_services) IS DISTINCT FROM 'array' OR jsonb_array_length(p_services)>500 THEN
    RAISE EXCEPTION 'invalid booking settings' USING ERRCODE='22023'; END IF;
  INSERT INTO public.booking_settings(business_id) VALUES(p_business_id) ON CONFLICT DO NOTHING;
  SELECT revision INTO current_revision FROM public.booking_settings WHERE business_id=p_business_id FOR UPDATE;
  IF current_revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'booking settings conflict' USING ERRCODE='40001'; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_services)) <> (SELECT count(DISTINCT v->>'serviceId') FROM jsonb_array_elements(p_services) v) THEN
    RAISE EXCEPTION 'duplicate booking service' USING ERRCODE='22023'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_services) LOOP
    IF NOT EXISTS(SELECT 1 FROM public.services WHERE id=(item->>'serviceId')::uuid AND business_id=p_business_id) THEN
      RAISE EXCEPTION 'booking service mismatch' USING ERRCODE='42501'; END IF;
  END LOOP;
  DELETE FROM public.booking_service_settings WHERE business_id=p_business_id;
  INSERT INTO public.booking_service_settings(service_id,business_id,setting)
    SELECT (v->>'serviceId')::uuid,p_business_id,v->'setting' FROM jsonb_array_elements(p_services) v;
  UPDATE public.booking_settings SET defaults=p_defaults,revision=current_revision+1,updated_at=now() WHERE business_id=p_business_id;
  RETURN current_revision+1;
END $$;
REVOKE ALL ON FUNCTION public.configure_booking_settings(uuid,uuid,integer,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.configure_booking_settings(uuid,uuid,integer,jsonb,jsonb) TO service_role;

-- Snapshots are per revision. Corrections create a new row, never overwrite what
-- the caller previously reviewed. Provider execution and notification IDs are separate.
CREATE TABLE public.booking_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK(revision>0),
  status text NOT NULL DEFAULT 'preparing' CHECK(status IN ('preparing','awaiting_confirmation','submitted','confirmed','requested','uncertain','failed','abandoned','superseded')),
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  source_message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  summary_message_id uuid REFERENCES public.messages(id) ON DELETE CASCADE,
  summary_accepted_at timestamptz,
  confirmation_message_id uuid REFERENCES public.messages(id) ON DELETE CASCADE,
  voice_action_id uuid REFERENCES public.voice_actions(id) ON DELETE CASCADE,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conversation_id,revision),
  UNIQUE(id,business_id),
  CHECK ((summary_message_id IS NULL)=(summary_accepted_at IS NULL))
);
CREATE UNIQUE INDEX booking_drafts_one_open ON public.booking_drafts(conversation_id)
  WHERE status IN ('preparing','awaiting_confirmation','submitted','uncertain');
CREATE TABLE public.booking_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL,
  draft_revision integer NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('review','confirmation')),
  permission_action_id uuid NOT NULL REFERENCES public.voice_actions(id) ON DELETE CASCADE,
  destination text NOT NULL,
  content text NOT NULL CHECK(length(content) BETWEEN 1 AND 1600),
  status text NOT NULL DEFAULT 'authorized' CHECK(status IN ('authorized','submitting','accepted','delivered','failed','uncertain','cancelled')),
  provider_message_id text UNIQUE,
  outbound_message_id uuid REFERENCES public.messages(id) ON DELETE CASCADE,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(draft_id,business_id) REFERENCES public.booking_drafts(id,business_id) ON DELETE CASCADE,
  UNIQUE(draft_id,purpose),
  UNIQUE(permission_action_id)
);
CREATE FUNCTION public.guard_booking_foundation_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF TG_TABLE_NAME='booking_service_settings' THEN
    IF NOT EXISTS(SELECT 1 FROM public.services WHERE id=NEW.service_id AND business_id=NEW.business_id) THEN
      RAISE EXCEPTION 'booking service scope mismatch'; END IF;
  ELSIF TG_TABLE_NAME='booking_drafts' THEN
    IF NOT EXISTS(SELECT 1 FROM public.conversations WHERE id=NEW.conversation_id AND business_id=NEW.business_id AND contact_id=NEW.contact_id)
      OR NOT EXISTS(SELECT 1 FROM public.contacts WHERE id=NEW.contact_id AND business_id=NEW.business_id)
      OR EXISTS(SELECT 1 FROM unnest(ARRAY[NEW.source_message_id,NEW.summary_message_id,NEW.confirmation_message_id]) m(id)
        WHERE m.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.messages x WHERE x.id=m.id AND x.business_id=NEW.business_id AND x.conversation_id=NEW.conversation_id))
      OR (NEW.voice_action_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.voice_actions a JOIN public.voice_sessions s ON s.id=a.session_id
        WHERE a.id=NEW.voice_action_id AND a.business_id=NEW.business_id AND s.action_conversation_id=NEW.conversation_id)) THEN
      RAISE EXCEPTION 'booking draft scope mismatch'; END IF;
    IF TG_OP='UPDATE' AND ROW(NEW.business_id,NEW.conversation_id,NEW.contact_id,NEW.revision,NEW.snapshot,NEW.source_message_id)
      IS DISTINCT FROM ROW(OLD.business_id,OLD.conversation_id,OLD.contact_id,OLD.revision,OLD.snapshot,OLD.source_message_id) THEN
      RAISE EXCEPTION 'booking snapshot is immutable'; END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM public.booking_drafts d JOIN public.voice_actions a ON a.id=NEW.permission_action_id
      JOIN public.voice_sessions s ON s.id=a.session_id
      WHERE d.id=NEW.draft_id AND d.business_id=NEW.business_id AND d.revision=NEW.draft_revision
        AND a.business_id=d.business_id AND s.action_conversation_id=d.conversation_id AND s.caller_phone=NEW.destination) THEN
      RAISE EXCEPTION 'booking notification scope mismatch'; END IF;
    IF NEW.outbound_message_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.messages WHERE id=NEW.outbound_message_id AND business_id=NEW.business_id) THEN
      RAISE EXCEPTION 'booking notification message mismatch'; END IF;
    IF TG_OP='UPDATE' AND ROW(NEW.business_id,NEW.draft_id,NEW.draft_revision,NEW.purpose,NEW.permission_action_id,NEW.destination,NEW.content)
      IS DISTINCT FROM ROW(OLD.business_id,OLD.draft_id,OLD.draft_revision,OLD.purpose,OLD.permission_action_id,OLD.destination,OLD.content) THEN
      RAISE EXCEPTION 'booking notification is immutable'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER booking_service_scope BEFORE INSERT OR UPDATE ON public.booking_service_settings FOR EACH ROW EXECUTE FUNCTION public.guard_booking_foundation_scope();
CREATE TRIGGER booking_draft_scope BEFORE INSERT OR UPDATE ON public.booking_drafts FOR EACH ROW EXECUTE FUNCTION public.guard_booking_foundation_scope();
CREATE TRIGGER booking_notification_scope BEFORE INSERT OR UPDATE ON public.booking_notifications FOR EACH ROW EXECUTE FUNCTION public.guard_booking_foundation_scope();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['booking_settings','booking_service_settings','booking_drafts','booking_notifications'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon,authenticated',t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated',t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role',t);
    EXECUTE format('CREATE POLICY booking_owner_read ON public.%I FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.businesses b WHERE b.id=business_id AND b.owner_id=auth.uid() AND b.deleted_at IS NULL))',t);
  END LOOP;
END $$;
CREATE FUNCTION public.cleanup_booking_foundation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.owner_id IS NULL AND OLD.owner_id IS NOT NULL THEN
    DELETE FROM public.booking_drafts WHERE business_id=NEW.id;
    DELETE FROM public.booking_service_settings WHERE business_id=NEW.id;
    DELETE FROM public.booking_settings WHERE business_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cleanup_booking_foundation AFTER UPDATE OF owner_id ON public.businesses FOR EACH ROW EXECUTE FUNCTION public.cleanup_booking_foundation();
-- Prevent a later parent edit from moving a retained snapshot to another owner.
CREATE FUNCTION public.guard_booking_parent_scope() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE linked boolean := false;
BEGIN
  IF TG_TABLE_NAME='contacts' AND NEW.business_id IS DISTINCT FROM OLD.business_id THEN
    SELECT EXISTS(SELECT 1 FROM public.booking_drafts WHERE contact_id=OLD.id) INTO linked;
  ELSIF TG_TABLE_NAME='conversations' AND (to_jsonb(NEW)->'business_id',to_jsonb(NEW)->'contact_id') IS DISTINCT FROM (to_jsonb(OLD)->'business_id',to_jsonb(OLD)->'contact_id') THEN
    SELECT EXISTS(SELECT 1 FROM public.booking_drafts WHERE conversation_id=OLD.id) INTO linked;
  ELSIF TG_TABLE_NAME='messages' AND (to_jsonb(NEW)->'business_id',to_jsonb(NEW)->'conversation_id') IS DISTINCT FROM (to_jsonb(OLD)->'business_id',to_jsonb(OLD)->'conversation_id') THEN
    SELECT EXISTS(SELECT 1 FROM public.booking_drafts WHERE OLD.id IN (source_message_id,summary_message_id,confirmation_message_id))
      OR EXISTS(SELECT 1 FROM public.booking_notifications WHERE outbound_message_id=OLD.id) INTO linked;
  ELSIF TG_TABLE_NAME='services' AND NEW.business_id IS DISTINCT FROM OLD.business_id THEN
    SELECT EXISTS(SELECT 1 FROM public.booking_service_settings WHERE service_id=OLD.id) INTO linked;
  END IF;
  IF linked THEN RAISE EXCEPTION 'booking source scope is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER booking_contact_parent_scope BEFORE UPDATE OF business_id ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.guard_booking_parent_scope();
CREATE TRIGGER booking_conversation_parent_scope BEFORE UPDATE OF business_id,contact_id ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.guard_booking_parent_scope();
CREATE TRIGGER booking_message_parent_scope BEFORE UPDATE OF business_id,conversation_id ON public.messages FOR EACH ROW EXECUTE FUNCTION public.guard_booking_parent_scope();
CREATE TRIGGER booking_service_parent_scope BEFORE UPDATE OF business_id ON public.services FOR EACH ROW EXECUTE FUNCTION public.guard_booking_parent_scope();
COMMIT;
