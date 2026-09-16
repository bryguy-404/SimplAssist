BEGIN;
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
COMMIT;
