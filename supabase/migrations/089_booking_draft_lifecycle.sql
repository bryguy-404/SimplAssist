BEGIN;
ALTER TABLE public.voice_availability ADD COLUMN service_id uuid REFERENCES public.services(id) ON DELETE SET NULL, ADD COLUMN settings_revision integer;
ALTER TABLE public.booking_drafts ADD COLUMN reconciled_at timestamptz;
CREATE INDEX booking_drafts_recovery ON public.booking_drafts(reconciled_at,updated_at) WHERE status IN ('submitted','uncertain');
CREATE TABLE public.booking_confirmation_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), enabled boolean NOT NULL DEFAULT false
);
INSERT INTO public.booking_confirmation_control(singleton) VALUES(true);
ALTER TABLE public.booking_confirmation_control ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.booking_confirmation_control FROM anon,authenticated;
GRANT ALL ON public.booking_confirmation_control TO service_role;
ALTER TABLE public.booking_drafts ALTER COLUMN source_message_id DROP NOT NULL;
ALTER TABLE public.booking_drafts ADD COLUMN summary_text text NOT NULL DEFAULT '',
  ADD COLUMN summary_provider_message_id text;
ALTER TABLE public.booking_drafts ADD CONSTRAINT booking_draft_source_required CHECK(source_message_id IS NOT NULL OR voice_action_id IS NOT NULL);

CREATE FUNCTION public.prepare_booking_draft(p_business_id uuid,p_conversation_id uuid,p_contact_id uuid,p_source_message_id uuid,p_voice_action_id uuid,p_snapshot jsonb,p_summary text,p_new_appointment boolean DEFAULT false)
RETURNS public.booking_drafts LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE prior public.booking_drafts; created public.booking_drafts; channel text; current_revision integer;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.booking_confirmation_control WHERE enabled) THEN RAISE EXCEPTION 'booking rollout disabled'; END IF;
  PERFORM 1 FROM public.businesses WHERE id=p_business_id AND owner_id IS NOT NULL AND deleted_at IS NULL AND operations_suspended_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'booking unavailable'; END IF;
  SELECT c.channel INTO channel FROM public.conversations c WHERE c.id=p_conversation_id AND c.business_id=p_business_id AND c.contact_id=p_contact_id AND c.status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'booking conversation unavailable'; END IF;
  IF channel='voice' THEN
    IF NOT EXISTS(SELECT 1 FROM public.voice_actions a JOIN public.voice_sessions s ON s.id=a.session_id WHERE a.id=p_voice_action_id
      AND a.business_id=p_business_id AND s.action_conversation_id=p_conversation_id AND s.status='active'
      AND a.status='awaiting_confirmation' AND a.kind IN ('booking','booking_request') AND a.readback=p_summary) THEN
      RAISE EXCEPTION 'booking voice proposal unavailable'; END IF;
  ELSIF p_voice_action_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.messages WHERE id=p_source_message_id AND conversation_id=p_conversation_id AND business_id=p_business_id AND role='customer') THEN
    RAISE EXCEPTION 'booking request source unavailable';
  END IF;
  SELECT coalesce((SELECT revision FROM public.booking_settings WHERE business_id=p_business_id),0) INTO current_revision;
  IF (p_snapshot->'offering'->>'settingsRevision')::integer IS DISTINCT FROM current_revision OR length(p_summary) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'booking settings changed'; END IF;
  SELECT * INTO prior FROM public.booking_drafts WHERE conversation_id=p_conversation_id ORDER BY revision DESC LIMIT 1;
  IF prior.id IS NOT NULL THEN
    IF prior.status IN ('submitted','uncertain') THEN RAISE EXCEPTION 'previous booking unresolved'; END IF;
    IF prior.status IN ('confirmed','requested') AND NOT p_new_appointment THEN RETURN prior; END IF;
    IF prior.status IN ('preparing','awaiting_confirmation') AND prior.snapshot=p_snapshot AND prior.voice_action_id IS NOT DISTINCT FROM p_voice_action_id THEN RETURN prior; END IF;
    UPDATE public.booking_drafts SET status='superseded',updated_at=now() WHERE id=prior.id AND status IN ('preparing','awaiting_confirmation');
  END IF;
  INSERT INTO public.booking_drafts(business_id,conversation_id,contact_id,revision,snapshot,source_message_id,voice_action_id,summary_text)
    VALUES(p_business_id,p_conversation_id,p_contact_id,coalesce(prior.revision,0)+1,p_snapshot,p_source_message_id,p_voice_action_id,p_summary) RETURNING * INTO created;
  RETURN created;
END $$;

-- SMS needs a provider acceptance identity; chat needs its committed assistant
-- row. Generating words inside an LLM call does not grant approval authority.
CREATE FUNCTION public.acknowledge_booking_summary(p_business_id uuid,p_draft_id uuid,p_revision integer,p_message_id uuid,p_provider_message_id text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d public.booking_drafts; m public.messages;
BEGIN
  SELECT * INTO d FROM public.booking_drafts WHERE id=p_draft_id AND business_id=p_business_id FOR UPDATE;
  IF NOT FOUND OR d.revision<>p_revision OR d.status NOT IN ('preparing','awaiting_confirmation') OR d.voice_action_id IS NOT NULL THEN RETURN false; END IF;
  SELECT * INTO m FROM public.messages WHERE id=p_message_id AND conversation_id=d.conversation_id AND business_id=d.business_id AND role='assistant';
  IF NOT FOUND OR left(m.content,length(d.summary_text))<>d.summary_text OR m.created_at<d.created_at OR m.channel NOT IN ('sms','web_chat') THEN RETURN false; END IF;
  IF m.channel='sms' AND nullif(btrim(p_provider_message_id),'') IS NULL THEN RETURN false; END IF;
  IF d.summary_message_id IS NOT NULL THEN RETURN d.summary_message_id=p_message_id; END IF;
  UPDATE public.booking_drafts SET status='awaiting_confirmation',summary_message_id=p_message_id,summary_accepted_at=now(),summary_provider_message_id=p_provider_message_id,updated_at=now() WHERE id=d.id;
  RETURN true;
END $$;

CREATE FUNCTION public.claim_booking_draft(p_business_id uuid,p_draft_id uuid,p_revision integer,p_confirmation_message_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d public.booking_drafts; m public.messages; a public.voice_actions; current_revision integer;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.booking_confirmation_control WHERE enabled) THEN RAISE EXCEPTION 'booking rollout disabled'; END IF;
  PERFORM 1 FROM public.businesses WHERE id=p_business_id AND owner_id IS NOT NULL AND deleted_at IS NULL AND operations_suspended_at IS NULL AND bookings_paused_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'booking unavailable'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.businesses b JOIN public.ai_settings cfg ON cfg.business_id=b.id WHERE b.id=p_business_id AND b.primary_goal='book' AND cfg.booking_enabled) THEN RAISE EXCEPTION 'booking unavailable'; END IF;
  SELECT * INTO d FROM public.booking_drafts WHERE id=p_draft_id AND business_id=p_business_id FOR UPDATE;
  IF NOT FOUND OR d.revision<>p_revision THEN RAISE EXCEPTION 'booking revision mismatch'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.ai_settings WHERE business_id=p_business_id AND booking_mode=d.snapshot->>'mode') THEN RAISE EXCEPTION 'booking mode changed'; END IF;
  IF d.status IN ('submitted','confirmed','requested','uncertain') THEN RETURN jsonb_build_object('execute',false,'draft',to_jsonb(d)); END IF;
  IF EXISTS(SELECT 1 FROM public.booking_drafts WHERE conversation_id=d.conversation_id AND revision>d.revision) THEN RAISE EXCEPTION 'booking draft superseded'; END IF;
  SELECT coalesce((SELECT revision FROM public.booking_settings WHERE business_id=p_business_id),0) INTO current_revision;
  IF (d.snapshot->'offering'->>'settingsRevision')::integer IS DISTINCT FROM current_revision THEN RAISE EXCEPTION 'booking settings changed'; END IF;
  SELECT * INTO m FROM public.messages WHERE id=p_confirmation_message_id AND conversation_id=d.conversation_id AND business_id=d.business_id AND role='customer';
  IF NOT FOUND THEN RAISE EXCEPTION 'booking confirmation missing'; END IF;
  IF d.voice_action_id IS NOT NULL THEN
    SELECT * INTO a FROM public.voice_actions WHERE id=d.voice_action_id AND business_id=d.business_id;
    IF a.status IS DISTINCT FROM 'executing' OR a.source_message_id IS DISTINCT FROM m.id OR a.playback_at IS NULL OR a.confirmed_at IS NULL
      OR a.readback IS DISTINCT FROM d.summary_text OR NOT public.voice_action_allowed(a.session_id,a.kind) THEN RAISE EXCEPTION 'booking voice confirmation missing'; END IF;
    IF d.status<>'preparing' THEN RAISE EXCEPTION 'booking draft not confirmable'; END IF;
  ELSE
    IF d.status<>'awaiting_confirmation' OR d.summary_accepted_at IS NULL OR m.created_at<=d.summary_accepted_at OR m.id=d.source_message_id THEN
      RAISE EXCEPTION 'booking confirmation out of order'; END IF;
    -- A newer complete customer message must be processed before acting on an old yes.
    IF EXISTS(SELECT 1 FROM public.messages WHERE conversation_id=d.conversation_id AND business_id=d.business_id AND role='customer' AND created_at>m.created_at) THEN
      RAISE EXCEPTION 'booking confirmation superseded'; END IF;
  END IF;
  UPDATE public.booking_drafts SET status='submitted',confirmation_message_id=m.id,updated_at=now() WHERE id=d.id RETURNING * INTO d;
  RETURN jsonb_build_object('execute',true,'draft',to_jsonb(d));
END $$;
CREATE FUNCTION public.abandon_voice_booking_drafts() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.status IN ('closed','failed') AND NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE public.booking_drafts SET status='abandoned',updated_at=now() WHERE conversation_id=NEW.action_conversation_id AND status IN ('preparing','awaiting_confirmation');
    UPDATE public.booking_notifications SET status='cancelled',updated_at=now() WHERE purpose='review' AND status='authorized'
      AND draft_id IN (SELECT id FROM public.booking_drafts WHERE conversation_id=NEW.action_conversation_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER abandon_voice_booking_drafts AFTER UPDATE OF status ON public.voice_sessions FOR EACH ROW EXECUTE FUNCTION public.abandon_voice_booking_drafts();
REVOKE ALL ON FUNCTION public.prepare_booking_draft(uuid,uuid,uuid,uuid,uuid,jsonb,text,boolean),public.acknowledge_booking_summary(uuid,uuid,integer,uuid,text),public.claim_booking_draft(uuid,uuid,integer,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_booking_draft(uuid,uuid,uuid,uuid,uuid,jsonb,text,boolean),public.acknowledge_booking_summary(uuid,uuid,integer,uuid,text),public.claim_booking_draft(uuid,uuid,integer,uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.save_voice_action_contact(p_action_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a public.voice_actions; s public.voice_sessions; c public.contacts; conv uuid; conflicts jsonb := '[]'::jsonb;
BEGIN
 SELECT * INTO a FROM public.voice_actions WHERE id=p_action_id FOR UPDATE;
 IF NOT public.voice_action_execution_current(p_action_id) THEN RAISE EXCEPTION 'voice confirmation superseded'; END IF;
 SELECT * INTO s FROM public.voice_sessions WHERE id=a.session_id;
 conv:=COALESCE(s.action_conversation_id,s.conversation_id);
 SELECT contact.* INTO c FROM public.contacts contact JOIN public.conversations conversation ON conversation.contact_id=contact.id
   WHERE conversation.id=conv AND conversation.business_id=a.business_id AND contact.business_id=a.business_id FOR UPDATE OF contact;
 IF c.id IS NULL THEN RAISE EXCEPTION 'voice contact scope mismatch'; END IF;
 IF a.kind<>'signup' THEN
   IF (a.kind<>'booking_request' AND NULLIF(btrim(a.payload->>'name'),'') IS NULL) OR a.payload->>'phone' IS DISTINCT FROM s.caller_phone THEN RAISE EXCEPTION 'invalid confirmed identity'; END IF;
   IF NULLIF(c.name,'') IS NOT NULL AND lower(c.name)<>lower(a.payload->>'name') THEN conflicts:=conflicts||'"name"'::jsonb; END IF;
   IF NULLIF(c.email,'') IS NOT NULL AND NULLIF(a.payload->>'email','') IS NOT NULL AND lower(c.email)<>lower(a.payload->>'email') THEN conflicts:=conflicts||'"email"'::jsonb; END IF;
   UPDATE public.contacts SET name=COALESCE(NULLIF(name,''),a.payload->>'name'),email=COALESCE(NULLIF(email,''),a.payload->>'email') WHERE id=c.id;
 END IF;
 RETURN jsonb_build_object('contactId',c.id,'conversationId',conv,'conflicts',conflicts);
END $$;
COMMIT;
