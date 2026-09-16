BEGIN;
-- All new capabilities are opt-in. The phone-owning pilot retains accounting;
-- a separately owned demo workspace supplies knowledge and action records.
ALTER TABLE public.voice_pilot_settings
  ADD COLUMN contacts_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN booking_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN signup_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN preparation_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN demo_business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  ADD COLUMN demo_calendar_id text,
  ADD CONSTRAINT voice_demo_is_separate CHECK (demo_business_id IS NULL OR demo_business_id <> business_id);
ALTER TABLE public.voice_pilot_testers
  ADD COLUMN test_mode text NOT NULL DEFAULT 'business' CHECK (test_mode IN ('business','booking_demo')),
  ADD COLUMN invitation_email text;
ALTER TABLE public.voice_sessions
  ADD COLUMN action_business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  ADD COLUMN action_conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  ADD COLUMN demo_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN preparation_started_at timestamptz,
  ADD COLUMN prepared_openai_id text;

CREATE TABLE public.voice_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.voice_sessions(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('contact','booking','booking_request','signup')),
  fingerprint text NOT NULL CHECK (length(fingerprint)=64),
  revision integer NOT NULL CHECK (revision>0),
  status text NOT NULL DEFAULT 'awaiting_confirmation' CHECK (status IN ('awaiting_confirmation','executing','succeeded','failed','superseded','uncertain')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  readback text NOT NULL CHECK (length(readback) BETWEEN 1 AND 4000),
  request_event_ids text[] NOT NULL,
  readback_event_ids text[],
  confirmation_event_ids text[],
  playback_event_id text,
  playback_at timestamptz,
  playback_caller_end_ms bigint,
  confirmed_at timestamptz,
  execution_started_at timestamptz,
  source_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  result jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id,revision),
  UNIQUE(session_id,kind,fingerprint)
);
CREATE UNIQUE INDEX voice_actions_one_pending ON public.voice_actions(session_id) WHERE status='awaiting_confirmation';
CREATE INDEX voice_actions_recovery ON public.voice_actions(updated_at) WHERE status IN ('executing','uncertain');
ALTER TABLE public.voice_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY voice_actions_read ON public.voice_actions FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM public.businesses));
REVOKE ALL ON public.voice_actions FROM anon,authenticated;
GRANT SELECT ON public.voice_actions TO authenticated;
GRANT ALL ON public.voice_actions TO service_role;

-- Admission already holds the settings lock. Resolve routing once in its insert,
-- never from a later browser field, model tool argument, or webhook payload.
CREATE FUNCTION public.freeze_voice_action_route() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE cfg public.voice_pilot_settings; tester public.voice_pilot_testers; owner uuid; c uuid; conv uuid;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.action_business_id,NEW.action_conversation_id,NEW.demo_mode) IS DISTINCT FROM
       ROW(OLD.action_business_id,OLD.action_conversation_id,OLD.demo_mode) THEN
      -- Account deletion can clear links, but cannot retarget surviving calls.
      IF NEW.action_business_id IS NOT NULL OR NEW.action_conversation_id IS NOT NULL THEN
        RAISE EXCEPTION 'voice action route is immutable';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  NEW.action_business_id := NEW.business_id;
  NEW.action_conversation_id := NEW.conversation_id;
  NEW.demo_mode := false;
  IF NEW.response_mode <> 'voice' THEN RETURN NEW; END IF;
  SELECT * INTO cfg FROM public.voice_pilot_settings WHERE business_id=NEW.business_id;
  SELECT * INTO tester FROM public.voice_pilot_testers WHERE business_id=NEW.business_id AND phone_number=NEW.caller_phone;
  IF tester.test_mode='booking_demo' THEN
    SELECT owner_id INTO owner FROM public.businesses WHERE id=NEW.business_id;
    IF cfg.demo_business_id IS NULL OR cfg.demo_calendar_id IS NULL OR NOT EXISTS
      (SELECT 1 FROM public.businesses WHERE id=cfg.demo_business_id AND owner_id=owner AND deleted_at IS NULL
       AND operations_suspended_at IS NULL AND ai_replies_paused_at IS NULL) THEN
      RAISE EXCEPTION 'booking demo is not ready';
    END IF;
    INSERT INTO public.contacts(business_id,phone_number,source_channel) VALUES(cfg.demo_business_id,NEW.caller_phone,'voice')
      ON CONFLICT (business_id,phone_number) WHERE phone_number IS NOT NULL DO UPDATE SET last_contacted_at=now() RETURNING id INTO c;
    INSERT INTO public.conversations(business_id,contact_id,channel,is_ai_handling) VALUES(cfg.demo_business_id,c,'voice',false) RETURNING id INTO conv;
    NEW.action_business_id:=cfg.demo_business_id; NEW.action_conversation_id:=conv; NEW.demo_mode:=true;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER freeze_voice_action_route BEFORE INSERT OR UPDATE OF action_business_id,action_conversation_id,demo_mode
  ON public.voice_sessions FOR EACH ROW EXECUTE FUNCTION public.freeze_voice_action_route();

CREATE FUNCTION public.voice_action_allowed(p_session_id uuid,p_kind text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT EXISTS (SELECT 1 FROM public.voice_sessions s
    JOIN public.voice_pilot_settings p ON p.business_id=s.business_id
    JOIN public.voice_pilot_testers t ON t.business_id=s.business_id AND t.phone_number=s.caller_phone
    JOIN public.businesses b ON b.id=COALESCE(s.action_business_id,s.business_id)
    JOIN public.businesses owner_business ON owner_business.id=s.business_id
    JOIN public.subscriptions sub ON sub.business_id=s.business_id
    WHERE s.id=p_session_id AND s.status='active' AND s.response_mode='voice' AND p.enabled
      AND s.phone_ended_at IS NULL AND sub.status IN ('active','trialing')
      AND owner_business.deleted_at IS NULL AND owner_business.operations_suspended_at IS NULL AND owner_business.ai_replies_paused_at IS NULL
      AND b.deleted_at IS NULL AND b.operations_suspended_at IS NULL AND b.ai_replies_paused_at IS NULL
      AND (NOT s.demo_mode OR (b.id=p.demo_business_id AND b.owner_id=owner_business.owner_id))
      AND CASE p_kind WHEN 'contact' THEN p.contacts_enabled
        WHEN 'booking' THEN p.booking_enabled AND p.contacts_enabled AND b.bookings_paused_at IS NULL
        WHEN 'booking_request' THEN p.booking_enabled AND p.contacts_enabled AND b.bookings_paused_at IS NULL
        WHEN 'signup' THEN p.signup_enabled AND NOT s.demo_mode AND b.texting_paused_at IS NULL
        ELSE false END);
$$;

CREATE FUNCTION public.propose_voice_action(p_session_id uuid,p_kind text,p_fingerprint text,p_payload jsonb,p_readback text,p_event_ids text[])
RETURNS public.voice_actions LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.voice_sessions; a public.voice_actions; rev integer;
BEGIN
  SELECT * INTO s FROM public.voice_sessions WHERE id=p_session_id FOR UPDATE;
  IF NOT public.voice_action_allowed(p_session_id,p_kind) THEN RAISE EXCEPTION 'voice action disabled'; END IF;
  IF cardinality(p_event_ids) NOT BETWEEN 1 AND 100 OR EXISTS (SELECT 1 FROM unnest(p_event_ids) e
    WHERE NOT EXISTS(SELECT 1 FROM public.voice_transcript_fragments f WHERE f.session_id=s.id AND f.event_id=e AND f.role='customer')) THEN
    RAISE EXCEPTION 'request transcript evidence missing'; END IF;
  SELECT * INTO a FROM public.voice_actions WHERE session_id=s.id AND kind=p_kind AND fingerprint=p_fingerprint;
  IF a.id IS NOT NULL THEN RETURN a; END IF;
  IF EXISTS(SELECT 1 FROM public.voice_actions WHERE session_id=s.id AND status IN ('executing','uncertain')) THEN
    RAISE EXCEPTION 'previous action unresolved'; END IF;
  IF p_kind IN ('booking','booking_request') AND EXISTS(SELECT 1 FROM public.voice_actions WHERE session_id=s.id AND kind IN ('booking','booking_request') AND status='succeeded') THEN
    RAISE EXCEPTION 'appointment already captured'; END IF;
  UPDATE public.voice_actions SET status='superseded',updated_at=now() WHERE session_id=s.id AND status='awaiting_confirmation';
  SELECT COALESCE(max(revision),0)+1 INTO rev FROM public.voice_actions WHERE session_id=s.id;
  INSERT INTO public.voice_actions(session_id,business_id,kind,fingerprint,revision,payload,readback,request_event_ids)
    VALUES(s.id,COALESCE(s.action_business_id,s.business_id),p_kind,p_fingerprint,rev,p_payload,p_readback,p_event_ids) RETURNING * INTO a;
  RETURN a;
END $$;

-- This is a transport mark acknowledgment, not merely generated text.
CREATE FUNCTION public.mark_voice_action_playback(p_session_id uuid,p_action_id uuid,p_event_id text,p_caller_end_ms bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE changed uuid;
BEGIN
  UPDATE public.voice_actions a SET playback_event_id=p_event_id,playback_at=clock_timestamp(),playback_caller_end_ms=p_caller_end_ms
    WHERE a.id=p_action_id AND a.session_id=p_session_id AND a.status='awaiting_confirmation' AND a.playback_at IS NULL
      AND public.voice_action_allowed(p_session_id,a.kind)
      AND EXISTS (SELECT 1 FROM public.voice_transcript_fragments f WHERE f.session_id=p_session_id AND f.event_id=p_event_id
        AND f.role='assistant' AND f.received_at>=a.created_at)
    RETURNING id INTO changed;
  RETURN changed IS NOT NULL;
END $$;

CREATE FUNCTION public.claim_voice_action(p_session_id uuid,p_action_id uuid,p_readback_ids text[],p_confirmation_ids text[])
RETURNS public.voice_actions LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.voice_sessions; a public.voice_actions; msg uuid; text_body text; last_end bigint; cited_end bigint;
BEGIN
  SELECT * INTO s FROM public.voice_sessions WHERE id=p_session_id FOR UPDATE;
  SELECT * INTO a FROM public.voice_actions WHERE id=p_action_id AND session_id=s.id FOR UPDATE;
  IF a.id IS NULL THEN RAISE EXCEPTION 'voice action missing'; END IF;
  IF a.status<>'awaiting_confirmation' THEN RETURN a; END IF;
  IF NOT public.voice_action_allowed(s.id,a.kind) OR a.playback_at IS NULL THEN RAISE EXCEPTION 'voice action not confirmable'; END IF;
  IF cardinality(p_readback_ids) NOT BETWEEN 1 AND 100 OR cardinality(p_confirmation_ids) NOT BETWEEN 1 AND 100
    OR NOT a.playback_event_id=ANY(p_readback_ids) THEN RAISE EXCEPTION 'readback evidence missing'; END IF;
  IF EXISTS(SELECT 1 FROM unnest(p_readback_ids) e WHERE NOT EXISTS(SELECT 1 FROM public.voice_transcript_fragments f
    WHERE f.session_id=s.id AND f.event_id=e AND f.role='assistant' AND f.received_at>=a.created_at AND f.received_at<=a.playback_at))
    OR EXISTS(SELECT 1 FROM unnest(p_confirmation_ids) e WHERE NOT EXISTS(SELECT 1 FROM public.voice_transcript_fragments f
      WHERE f.session_id=s.id AND f.event_id=e AND f.role='customer' AND f.received_at>a.playback_at AND f.start_ms>=a.playback_caller_end_ms))
    THEN RAISE EXCEPTION 'confirmation evidence out of order'; END IF;
  SELECT max(end_ms) INTO last_end FROM public.voice_transcript_fragments WHERE session_id=s.id AND role='customer';
  SELECT max(end_ms),string_agg(content,' ' ORDER BY start_ms,event_id) INTO cited_end,text_body
    FROM public.voice_transcript_fragments WHERE session_id=s.id AND event_id=ANY(p_confirmation_ids);
  IF cited_end<>last_end OR length(text_body)>2000 THEN RAISE EXCEPTION 'confirmation superseded'; END IF;
  INSERT INTO public.messages(business_id,conversation_id,role,channel,content)
    VALUES(a.business_id,COALESCE(s.action_conversation_id,s.conversation_id),'customer','voice',text_body) RETURNING id INTO msg;
  UPDATE public.voice_actions SET status='executing',confirmed_at=now(),updated_at=now(),source_message_id=msg,
    readback_event_ids=p_readback_ids,confirmation_event_ids=p_confirmation_ids WHERE id=a.id RETURNING * INTO a;
  RETURN a;
END $$;

REVOKE ALL ON FUNCTION public.freeze_voice_action_route() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.voice_action_allowed(uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.propose_voice_action(uuid,text,text,jsonb,text,text[]) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.mark_voice_action_playback(uuid,uuid,text,bigint) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_voice_action(uuid,uuid,text[],text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.voice_action_allowed(uuid,text),public.propose_voice_action(uuid,text,text,jsonb,text,text[]),
 public.mark_voice_action_playback(uuid,uuid,text,bigint),public.claim_voice_action(uuid,uuid,text[],text[]) TO service_role;
COMMIT;
