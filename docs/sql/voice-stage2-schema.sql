-- SimplAssist private voice actions: migrations 074–076.
-- Apply once in the production Supabase SQL editor. All capabilities remain OFF.
-- This file is generated from the three canonical migrations; do not edit separately.
BEGIN;

-- 074_voice_actions.sql
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
      IF (NEW.action_business_id IS DISTINCT FROM OLD.action_business_id AND NEW.action_business_id IS NOT NULL)
        OR (NEW.action_conversation_id IS DISTINCT FROM OLD.action_conversation_id AND NEW.action_conversation_id IS NOT NULL)
        OR NEW.demo_mode IS DISTINCT FROM OLD.demo_mode THEN
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
      (SELECT 1 FROM public.businesses WHERE id=cfg.demo_business_id AND owner_id IS NOT NULL AND owner_id<>owner AND deleted_at IS NULL
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
      AND (NOT s.demo_mode OR (b.id=p.demo_business_id AND b.owner_id IS NOT NULL AND b.owner_id<>owner_business.owner_id))
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
    WHERE a.id=p_action_id AND a.session_id=p_session_id AND a.status='awaiting_confirmation'
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

-- 075_voice_action_controls.sql
ALTER TABLE public.voice_actions ADD COLUMN sms_logged_at timestamptz, ADD COLUMN reconciled_at timestamptz, ADD COLUMN recovery_complete boolean NOT NULL DEFAULT false;
CREATE TABLE public.voice_availability (
  session_id uuid NOT NULL REFERENCES public.voice_sessions(id) ON DELETE CASCADE,
  date text NOT NULL,
  slots jsonb NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id,date)
);
ALTER TABLE public.voice_availability ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_availability FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.voice_availability TO service_role;

CREATE FUNCTION public.configure_voice_actions(p_revision integer,p_contacts boolean,p_booking boolean,p_signup boolean,p_preparation boolean,
 p_demo_business_id uuid,p_demo_calendar_id text,p_tester_modes jsonb,p_admin uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE cfg public.voice_pilot_settings; owner uuid;
BEGIN
  IF p_admin IS NULL OR p_contacts IS NULL OR p_booking IS NULL OR p_signup IS NULL OR p_preparation IS NULL
    OR jsonb_typeof(p_tester_modes)<>'array' OR jsonb_array_length(p_tester_modes)>50 OR (p_booking AND NOT p_contacts) THEN RAISE EXCEPTION 'invalid voice capabilities'; END IF;
  SELECT * INTO cfg FROM public.voice_pilot_settings WHERE business_id='ea848911-ef72-44a6-8cf3-c47b3959be26' FOR UPDATE;
  IF cfg.revision<>p_revision THEN RAISE EXCEPTION 'settings changed' USING ERRCODE='40001'; END IF;
  SELECT owner_id INTO owner FROM public.businesses WHERE id=cfg.business_id;
  IF p_demo_business_id IS NOT NULL AND (p_demo_business_id=cfg.business_id OR NOT EXISTS(
    SELECT 1 FROM public.businesses b WHERE b.id=p_demo_business_id AND b.owner_id IS NOT NULL AND b.owner_id<>owner AND b.deleted_at IS NULL
  )) THEN RAISE EXCEPTION 'demo requires a separate test account'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_tester_modes) t WHERE
    COALESCE(t->>'mode','') NOT IN ('business','booking_demo') OR NOT EXISTS(
      SELECT 1 FROM public.voice_pilot_testers WHERE business_id=cfg.business_id AND phone_number=t->>'phone')
    OR (t->>'mode'='booking_demo' AND (p_demo_business_id IS NULL OR NULLIF(p_demo_calendar_id,'') IS NULL))
    OR length(COALESCE(t->>'email',''))>254) THEN RAISE EXCEPTION 'invalid tester mode'; END IF;
  IF p_demo_business_id IS NOT NULL AND NULLIF(p_demo_calendar_id,'') IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.google_calendar_tokens WHERE business_id=p_demo_business_id AND calendar_id=p_demo_calendar_id
  ) THEN RAISE EXCEPTION 'connect the dedicated demo calendar first'; END IF;
  UPDATE public.voice_pilot_settings SET contacts_enabled=p_contacts,booking_enabled=p_booking,signup_enabled=p_signup,preparation_enabled=p_preparation,
    demo_business_id=p_demo_business_id,demo_calendar_id=NULLIF(p_demo_calendar_id,''),revision=revision+1,updated_at=now(),updated_by=p_admin WHERE business_id=cfg.business_id;
  UPDATE public.voice_pilot_testers t SET test_mode=j->>'mode',invitation_email=NULLIF(lower(j->>'email'),'')
    FROM jsonb_array_elements(p_tester_modes) j WHERE t.business_id=cfg.business_id AND t.phone_number=j->>'phone';
  INSERT INTO public.voice_pilot_audit(business_id,admin_id,old_revision,new_settings)
    VALUES(cfg.business_id,p_admin,p_revision,jsonb_build_object('contacts',p_contacts,'booking',p_booking,'signup',p_signup,'preparation',p_preparation,'demo_business_id',p_demo_business_id,'testers',p_tester_modes));
END $$;
REVOKE ALL ON FUNCTION public.configure_voice_actions(integer,boolean,boolean,boolean,boolean,uuid,text,jsonb,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.configure_voice_actions(integer,boolean,boolean,boolean,boolean,uuid,text,jsonb,uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.scrub_voice_business_data() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    UPDATE public.voice_pilot_settings SET enabled=false,revision=revision+1 WHERE business_id=NEW.id AND enabled;
  END IF;
  IF OLD.owner_id IS NOT NULL AND NEW.owner_id IS NULL THEN
    UPDATE public.voice_recordings SET delete_after=now(),next_attempt_at=now() WHERE business_id=NEW.id AND deleted_at IS NULL;
    UPDATE public.voice_transcript_fragments SET content='[deleted]' WHERE business_id=NEW.id;
    UPDATE public.voice_sessions SET caller_phone='',called_phone='',feedback=NULL,fallback_pending=false WHERE business_id=NEW.id;
    DELETE FROM public.voice_actions WHERE business_id=NEW.id OR session_id IN (SELECT id FROM public.voice_sessions WHERE business_id=NEW.id);
    DELETE FROM public.voice_availability WHERE session_id IN (SELECT id FROM public.voice_sessions WHERE business_id=NEW.id OR action_business_id=NEW.id);
    DELETE FROM public.voice_pilot_testers WHERE business_id=NEW.id;
    DELETE FROM public.voice_pilot_audit WHERE business_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.voice_action_execution_current(p_action_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.voice_actions a WHERE a.id=p_action_id AND a.status='executing'
   AND public.voice_action_allowed(a.session_id,a.kind)
   AND (SELECT max(f.end_ms) FROM public.voice_transcript_fragments f WHERE f.session_id=a.session_id AND f.role='customer')
     = (SELECT max(f.end_ms) FROM public.voice_transcript_fragments f WHERE f.session_id=a.session_id AND f.event_id=ANY(a.confirmation_event_ids)));
$$;
REVOKE ALL ON FUNCTION public.voice_action_execution_current(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.voice_action_execution_current(uuid) TO service_role;
CREATE FUNCTION public.save_voice_action_contact(p_action_id uuid) RETURNS jsonb
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
   IF NULLIF(btrim(a.payload->>'name'),'') IS NULL OR a.payload->>'phone'<>s.caller_phone THEN RAISE EXCEPTION 'invalid confirmed identity'; END IF;
   IF NULLIF(c.name,'') IS NOT NULL AND lower(c.name)<>lower(a.payload->>'name') THEN conflicts:=conflicts||'"name"'::jsonb; END IF;
   IF NULLIF(c.email,'') IS NOT NULL AND NULLIF(a.payload->>'email','') IS NOT NULL AND lower(c.email)<>lower(a.payload->>'email') THEN conflicts:=conflicts||'"email"'::jsonb; END IF;
   UPDATE public.contacts SET name=COALESCE(NULLIF(name,''),a.payload->>'name'),email=COALESCE(NULLIF(email,''),a.payload->>'email') WHERE id=c.id;
 END IF;
 RETURN jsonb_build_object('contactId',c.id,'conversationId',conv,'conflicts',conflicts);
END $$;
REVOKE ALL ON FUNCTION public.save_voice_action_contact(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_voice_action_contact(uuid) TO service_role;

-- 076_voice_preparation.sql
CREATE FUNCTION public.claim_voice_preparation(p_session_id uuid) RETURNS public.voice_sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.voice_sessions;
BEGIN
  SELECT * INTO s FROM public.voice_sessions WHERE id=p_session_id FOR UPDATE;
  IF s.response_mode<>'voice' OR s.status<>'ringing' OR s.preparation_started_at IS NOT NULL OR s.phone_ended_at IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM public.voice_pilot_settings p JOIN public.voice_pilot_testers t USING(business_id)
      JOIN public.businesses b ON b.id=p.business_id
      WHERE p.business_id=s.business_id AND p.enabled AND p.preparation_enabled AND t.phone_number=s.caller_phone
      AND t.prior_disclosure_acknowledged_at<=s.created_at AND b.deleted_at IS NULL AND b.operations_suspended_at IS NULL AND b.ai_replies_paused_at IS NULL)
    THEN RETURN NULL; END IF;
  UPDATE public.voice_sessions SET preparation_started_at=clock_timestamp(),heartbeat_at=clock_timestamp() WHERE id=s.id RETURNING * INTO s;
  RETURN s;
END $$;
REVOKE ALL ON FUNCTION public.claim_voice_preparation(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_voice_preparation(uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.finalize_voice_session(p_session_id uuid, p_outcome text, p_error text, p_fallback boolean, p_no_provider_started boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.voice_sessions;
BEGIN
  PERFORM 1 FROM public.voice_pilot_settings WHERE business_id=(SELECT business_id FROM public.voice_sessions WHERE id=p_session_id) FOR UPDATE;
  SELECT * INTO s FROM public.voice_sessions WHERE id=p_session_id FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Unknown voice session'; END IF;
  IF p_no_provider_started AND s.preparation_started_at IS NULL AND s.status IN ('ringing','notice') AND s.openai_session_id IS NULL THEN
    UPDATE public.voice_sessions SET usage_confirmed=true WHERE id=s.id;
  END IF;
  UPDATE public.voice_sessions SET status='closed',ended_at=COALESCE(ended_at,now()),
    outcome=CASE WHEN s.status='closed' THEN outcome ELSE p_outcome END,
    error_code=CASE WHEN s.status='closed' THEN error_code ELSE COALESCE(error_code,p_error) END,
    fallback_pending=CASE WHEN s.status='closed' THEN fallback_pending ELSE fallback_pending OR (p_fallback AND fallback_completed_at IS NULL) END,
    reserved_seconds=CASE WHEN usage_confirmed OR response_mode='text' THEN 0 ELSE reserved_seconds END
    WHERE id=s.id;
  UPDATE public.conversations SET status='closed',is_ai_handling=false WHERE id IN (s.conversation_id,s.action_conversation_id);
  UPDATE public.voice_actions SET status='superseded',updated_at=now() WHERE session_id=s.id AND status='awaiting_confirmation';
END $$;

CREATE OR REPLACE FUNCTION public.reconcile_unstarted_voice_sessions()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s record; changed integer:=0;
BEGIN
  FOR s IN SELECT v.id FROM public.voice_sessions v LEFT JOIN public.voice_stream_credentials c ON c.session_id=v.id
    WHERE v.preparation_started_at IS NULL AND v.status='closed' AND v.response_mode='voice' AND NOT v.usage_confirmed AND v.openai_session_id IS NULL
      AND c.consumed_at IS NULL AND COALESCE(c.expires_at,v.created_at+interval '2 minutes')<now() LOOP
    PERFORM public.update_voice_usage(s.id,0,true); changed:=changed+1;
  END LOOP;
  RETURN changed;
END $$;

COMMIT;
