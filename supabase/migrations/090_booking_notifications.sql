BEGIN;
ALTER TABLE public.voice_actions DROP CONSTRAINT voice_actions_kind_check;
ALTER TABLE public.voice_actions ADD CONSTRAINT voice_actions_kind_check CHECK(kind IN ('contact','booking','booking_request','signup','booking_review_text','booking_confirmation_text'));
ALTER TABLE public.voice_actions DROP CONSTRAINT voice_actions_session_id_kind_fingerprint_key;
CREATE UNIQUE INDEX voice_actions_live_fingerprint ON public.voice_actions(session_id,kind,fingerprint) WHERE status<>'superseded';
-- Preserve the existing contact/signup identity and continuation behavior.
CREATE UNIQUE INDEX voice_actions_legacy_fingerprint ON public.voice_actions(session_id,kind,fingerprint) WHERE kind IN ('contact','signup');
ALTER TABLE public.booking_notifications ADD COLUMN usage_recorded_at timestamptz, ADD COLUMN reconciled_at timestamptz, ADD COLUMN action_recorded_at timestamptz;
CREATE OR REPLACE FUNCTION public.voice_action_allowed(p_session_id uuid,p_kind text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.voice_sessions WHERE id=p_session_id AND access_source='pilot') THEN
    RETURN public.voice_pilot_action_allowed_legacy(p_session_id,p_kind); END IF;
  RETURN EXISTS(SELECT 1 FROM public.voice_sessions s JOIN public.businesses b ON b.id=s.business_id
    WHERE s.id=p_session_id AND s.status='active' AND s.action_business_id=s.business_id AND NOT s.demo_mode
      AND public.voice_session_continuation_allowed(s.id)
      AND CASE p_kind WHEN 'contact' THEN true
        WHEN 'signup' THEN b.primary_goal='signup' AND b.texting_paused_at IS NULL AND EXISTS(
          SELECT 1 FROM public.subscriptions sub WHERE sub.business_id=b.id AND sub.status IN ('active','trialing','past_due') AND sub.plan IN ('sms_only','sms_and_chat','full'))
        WHEN 'booking' THEN b.primary_goal='book' AND b.bookings_paused_at IS NULL
          AND EXISTS(SELECT 1 FROM public.ai_settings ai WHERE ai.business_id=b.id AND ai.booking_enabled AND ai.booking_mode='schedule_direct')
          AND EXISTS(SELECT 1 FROM public.google_calendar_tokens c WHERE c.business_id=b.id AND NULLIF(c.calendar_id,'') IS NOT NULL)
          AND EXISTS(SELECT 1 FROM public.subscriptions sub WHERE sub.business_id=b.id AND sub.status='active' AND sub.plan IN ('chat_only','sms_and_chat','full'))
        WHEN 'booking_request' THEN b.primary_goal='book' AND b.bookings_paused_at IS NULL
          AND EXISTS(SELECT 1 FROM public.ai_settings ai WHERE ai.business_id=b.id AND ai.booking_enabled AND ai.booking_mode='collect_info')
          AND EXISTS(SELECT 1 FROM public.subscriptions sub WHERE sub.business_id=b.id AND sub.status='active' AND sub.plan IN ('chat_only','sms_and_chat','full'))
        ELSE p_kind IN ('booking_review_text','booking_confirmation_text') AND b.primary_goal='book' AND b.texting_paused_at IS NULL
          AND EXISTS(SELECT 1 FROM public.booking_confirmation_control WHERE enabled)
          AND EXISTS(SELECT 1 FROM public.subscriptions sub WHERE sub.business_id=b.id AND sub.status='active' AND sub.plan='full') END);
END $$;
CREATE OR REPLACE FUNCTION public.propose_voice_action(p_session_id uuid,p_kind text,p_fingerprint text,p_payload jsonb,p_readback text,p_event_ids text[])
RETURNS public.voice_actions LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.voice_sessions; a public.voice_actions; rev integer;
BEGIN
  SELECT * INTO s FROM public.voice_sessions WHERE id=p_session_id FOR UPDATE;
  IF NOT public.voice_action_allowed(p_session_id,p_kind) THEN RAISE EXCEPTION 'voice action disabled'; END IF;
  IF cardinality(p_event_ids) NOT BETWEEN 1 AND 100 OR EXISTS (SELECT 1 FROM unnest(p_event_ids) e
    WHERE NOT EXISTS(SELECT 1 FROM public.voice_transcript_fragments f WHERE f.session_id=s.id AND f.event_id=e AND f.role='customer')) THEN
    RAISE EXCEPTION 'request transcript evidence missing'; END IF;
  SELECT * INTO a FROM public.voice_actions WHERE session_id=s.id AND kind=p_kind AND fingerprint=p_fingerprint ORDER BY revision DESC LIMIT 1;
  IF a.id IS NOT NULL AND (a.status<>'superseded' OR p_kind IN ('contact','signup')) THEN RETURN a; END IF;
  IF EXISTS(SELECT 1 FROM public.voice_actions WHERE session_id=s.id AND status IN ('executing','uncertain')) THEN
    RAISE EXCEPTION 'previous action unresolved'; END IF;
  IF p_kind IN ('booking','booking_request') AND COALESCE((p_payload->>'newAppointment')::boolean,false)=false AND EXISTS(SELECT 1 FROM public.voice_actions WHERE session_id=s.id AND kind IN ('booking','booking_request') AND status='succeeded') THEN
    RAISE EXCEPTION 'appointment already captured'; END IF;
  UPDATE public.voice_actions SET status='superseded',updated_at=now() WHERE session_id=s.id AND status='awaiting_confirmation';
  SELECT COALESCE(max(revision),0)+1 INTO rev FROM public.voice_actions WHERE session_id=s.id;
  INSERT INTO public.voice_actions(session_id,business_id,kind,fingerprint,revision,payload,readback,request_event_ids)
    VALUES(s.id,COALESCE(s.action_business_id,s.business_id),p_kind,p_fingerprint,rev,p_payload,p_readback,p_event_ids) RETURNING * INTO a;
  RETURN a;
END $$;


CREATE FUNCTION public.authorize_booking_notification(p_action_id uuid,p_content text) RETURNS public.booking_notifications
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a public.voice_actions; s public.voice_sessions; d public.booking_drafts; n public.booking_notifications; notification_purpose text;
BEGIN
  SELECT * INTO a FROM public.voice_actions WHERE id=p_action_id FOR UPDATE;
  IF a.kind NOT IN ('booking_review_text','booking_confirmation_text') OR a.status<>'executing' OR a.confirmed_at IS NULL OR a.source_message_id IS NULL THEN
    RAISE EXCEPTION 'booking text permission missing'; END IF;
  SELECT * INTO s FROM public.voice_sessions WHERE id=a.session_id;
  SELECT * INTO d FROM public.booking_drafts WHERE id=(a.payload->>'draftId')::uuid AND business_id=a.business_id FOR UPDATE;
  IF NOT FOUND OR d.conversation_id IS DISTINCT FROM s.action_conversation_id OR d.revision IS DISTINCT FROM (a.payload->>'revision')::integer THEN
    RAISE EXCEPTION 'booking text draft mismatch'; END IF;
  notification_purpose:=CASE a.kind WHEN 'booking_review_text' THEN 'review' ELSE 'confirmation' END;
  IF notification_purpose='review' AND (s.status<>'active' OR d.status NOT IN ('preparing','awaiting_confirmation') OR EXISTS(SELECT 1 FROM public.booking_drafts WHERE conversation_id=d.conversation_id AND revision>d.revision)) THEN
    RAISE EXCEPTION 'booking review no longer current'; END IF;
  IF notification_purpose='confirmation' AND d.status NOT IN ('confirmed','requested') THEN RAISE EXCEPTION 'booking not completed'; END IF;
  INSERT INTO public.booking_notifications(business_id,draft_id,draft_revision,purpose,permission_action_id,destination,content)
    VALUES(a.business_id,d.id,d.revision,notification_purpose,a.id,s.caller_phone,p_content)
    ON CONFLICT(draft_id,purpose) DO NOTHING;
  SELECT * INTO n FROM public.booking_notifications WHERE draft_id=d.id AND booking_notifications.purpose=notification_purpose;
  RETURN n;
END $$;
CREATE FUNCTION public.finalize_booking_notification(p_notification_id uuid) RETURNS public.messages
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE n public.booking_notifications; d public.booking_drafts; c public.conversations; m public.messages;
BEGIN
  SELECT * INTO n FROM public.booking_notifications WHERE id=p_notification_id FOR UPDATE;
  IF n.provider_message_id IS NULL OR n.accepted_at IS NULL OR n.status NOT IN ('accepted','delivered','failed') THEN RAISE EXCEPTION 'booking text acceptance missing'; END IF;
  SELECT * INTO d FROM public.booking_drafts WHERE id=n.draft_id AND business_id=n.business_id;
  -- Stable message identity wins even after its original SMS thread closes.
  SELECT * INTO m FROM public.messages WHERE id=n.id;
  IF FOUND THEN
    IF m.business_id<>n.business_id OR m.channel<>'sms' OR m.content<>n.content OR m.role<>'assistant' THEN RAISE EXCEPTION 'booking text identity mismatch'; END IF;
  ELSE
    PERFORM 1 FROM public.contacts WHERE id=d.contact_id AND business_id=d.business_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'booking text contact missing'; END IF;
    SELECT * INTO c FROM public.conversations WHERE business_id=d.business_id AND contact_id=d.contact_id AND channel='sms' AND status='active' ORDER BY started_at DESC LIMIT 1;
    IF c.id IS NULL THEN INSERT INTO public.conversations(business_id,contact_id,channel) VALUES(d.business_id,d.contact_id,'sms') RETURNING * INTO c; END IF;
    INSERT INTO public.messages(id,business_id,conversation_id,role,channel,content,created_at) VALUES(n.id,n.business_id,c.id,'assistant','sms',n.content,n.accepted_at) RETURNING * INTO m;
  END IF;
  UPDATE public.conversations SET last_message_at=GREATEST(last_message_at,n.accepted_at) WHERE id=m.conversation_id AND business_id=n.business_id;
  UPDATE public.booking_notifications SET outbound_message_id=m.id WHERE id=n.id;
  RETURN m;
END $$;
REVOKE ALL ON FUNCTION public.authorize_booking_notification(uuid,text), public.finalize_booking_notification(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_booking_notification(uuid,text), public.finalize_booking_notification(uuid) TO service_role;
CREATE TABLE public.booking_summary_sends (
  draft_id uuid PRIMARY KEY REFERENCES public.booking_drafts(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  sender text NOT NULL,
  destination text NOT NULL,
  content text NOT NULL CHECK(length(content) BETWEEN 1 AND 2400),
  status text NOT NULL CHECK(status IN ('submitting','accepted','uncertain','failed')),
  provider_message_id text UNIQUE,
  accepted_at timestamptz,
  usage_recorded_at timestamptz,
  reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(draft_id,business_id) REFERENCES public.booking_drafts(id,business_id) ON DELETE CASCADE
);
ALTER TABLE public.booking_summary_sends ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.booking_summary_sends FROM anon,authenticated;
GRANT ALL ON public.booking_summary_sends TO service_role;
CREATE FUNCTION public.claim_booking_summary_send(p_business_id uuid,p_draft_id uuid,p_revision integer,p_sender text,p_destination text,p_content text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d public.booking_drafts; n public.booking_summary_sends;
BEGIN
  SELECT * INTO d FROM public.booking_drafts WHERE id=p_draft_id AND business_id=p_business_id FOR UPDATE;
  IF NOT FOUND OR d.revision<>p_revision OR d.voice_action_id IS NOT NULL OR left(p_content,length(d.summary_text))<>d.summary_text THEN RAISE EXCEPTION 'booking summary mismatch'; END IF;
  SELECT * INTO n FROM public.booking_summary_sends WHERE draft_id=d.id;
  IF FOUND THEN RETURN jsonb_build_object('send',false,'record',to_jsonb(n)); END IF;
  IF d.status<>'preparing' OR EXISTS(SELECT 1 FROM public.booking_drafts WHERE conversation_id=d.conversation_id AND revision>d.revision) THEN RAISE EXCEPTION 'booking summary not current'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.contacts c JOIN public.conversations conv ON conv.contact_id=c.id WHERE conv.id=d.conversation_id AND conv.business_id=d.business_id AND conv.channel='sms' AND c.phone_number=p_destination AND c.business_id=d.business_id)
    OR NOT EXISTS(SELECT 1 FROM public.phone_numbers WHERE business_id=d.business_id AND phone_number=p_sender AND is_active) THEN RAISE EXCEPTION 'booking summary phone mismatch'; END IF;
  INSERT INTO public.booking_summary_sends(draft_id,business_id,revision,sender,destination,content,status) VALUES(d.id,d.business_id,d.revision,p_sender,p_destination,p_content,'submitting') RETURNING * INTO n;
  RETURN jsonb_build_object('send',true,'record',to_jsonb(n));
END $$;
CREATE FUNCTION public.finalize_booking_summary_send(p_draft_id uuid) RETURNS public.messages
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE n public.booking_summary_sends; d public.booking_drafts; m public.messages;
BEGIN
  SELECT * INTO n FROM public.booking_summary_sends WHERE draft_id=p_draft_id FOR UPDATE;
  IF NOT FOUND OR n.status<>'accepted' OR n.provider_message_id IS NULL OR n.accepted_at IS NULL THEN RAISE EXCEPTION 'booking summary acceptance missing'; END IF;
  SELECT * INTO d FROM public.booking_drafts WHERE id=n.draft_id AND business_id=n.business_id FOR UPDATE;
  SELECT * INTO m FROM public.messages WHERE id=n.draft_id;
  IF FOUND THEN
    IF m.business_id<>d.business_id OR m.conversation_id<>d.conversation_id OR m.role<>'assistant' OR m.channel<>'sms' OR m.content<>n.content THEN RAISE EXCEPTION 'booking summary message mismatch'; END IF;
  ELSE
    INSERT INTO public.messages(id,business_id,conversation_id,role,channel,content,created_at) VALUES(n.draft_id,d.business_id,d.conversation_id,'assistant','sms',n.content,n.accepted_at) RETURNING * INTO m;
  END IF;
  IF d.status='preparing' THEN UPDATE public.booking_drafts SET status='awaiting_confirmation',summary_message_id=m.id,summary_accepted_at=n.accepted_at,summary_provider_message_id=n.provider_message_id,updated_at=now() WHERE id=d.id; END IF;
  UPDATE public.conversations SET last_message_at=GREATEST(last_message_at,n.accepted_at) WHERE id=d.conversation_id AND business_id=d.business_id;
  RETURN m;
END $$;
REVOKE ALL ON FUNCTION public.claim_booking_summary_send(uuid,uuid,integer,text,text,text), public.finalize_booking_summary_send(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_booking_summary_send(uuid,uuid,integer,text,text,text), public.finalize_booking_summary_send(uuid) TO service_role;
CREATE FUNCTION public.recover_booking_chat_summary(p_business_id uuid,p_conversation_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d public.booking_drafts; m public.messages;
BEGIN
 SELECT * INTO d FROM public.booking_drafts WHERE business_id=p_business_id AND conversation_id=p_conversation_id AND voice_action_id IS NULL AND status='preparing' ORDER BY revision DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.booking_drafts WHERE conversation_id=d.conversation_id AND revision>d.revision) THEN RETURN false; END IF;
 SELECT * INTO m FROM public.messages WHERE business_id=d.business_id AND conversation_id=d.conversation_id AND role='assistant' AND channel='web_chat' AND created_at>=d.created_at AND content=d.summary_text ORDER BY created_at LIMIT 1;
 IF NOT FOUND THEN RETURN false; END IF;
 UPDATE public.booking_drafts SET status='awaiting_confirmation',summary_message_id=m.id,summary_accepted_at=m.created_at,updated_at=now() WHERE id=d.id;
 RETURN true;
END $$;
CREATE FUNCTION public.guard_booking_summary_send() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.booking_drafts d JOIN public.conversations c ON c.id=d.conversation_id JOIN public.contacts ct ON ct.id=d.contact_id WHERE d.id=NEW.draft_id AND d.business_id=NEW.business_id AND d.revision=NEW.revision AND d.voice_action_id IS NULL AND c.channel='sms' AND ct.phone_number=NEW.destination AND left(NEW.content,length(d.summary_text))=d.summary_text) THEN RAISE EXCEPTION 'booking summary scope mismatch'; END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.draft_id,NEW.business_id,NEW.revision,NEW.sender,NEW.destination,NEW.content) IS DISTINCT FROM ROW(OLD.draft_id,OLD.business_id,OLD.revision,OLD.sender,OLD.destination,OLD.content) THEN RAISE EXCEPTION 'booking summary immutable'; END IF;
 IF TG_OP='UPDATE' AND OLD.provider_message_id IS NOT NULL AND ROW(NEW.provider_message_id,NEW.accepted_at) IS DISTINCT FROM ROW(OLD.provider_message_id,OLD.accepted_at) THEN RAISE EXCEPTION 'booking acceptance immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER booking_summary_scope BEFORE INSERT OR UPDATE ON public.booking_summary_sends FOR EACH ROW EXECUTE FUNCTION public.guard_booking_summary_send();
REVOKE ALL ON FUNCTION public.recover_booking_chat_summary(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.recover_booking_chat_summary(uuid,uuid) TO service_role;

CREATE FUNCTION public.has_live_booking_review(p_business_id uuid,p_caller text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.booking_notifications n JOIN public.booking_drafts d ON d.id=n.draft_id JOIN public.voice_sessions s ON s.action_conversation_id=d.conversation_id
 WHERE n.business_id=p_business_id AND d.business_id=p_business_id AND s.business_id=p_business_id AND s.caller_phone=p_caller AND s.status='active' AND n.purpose='review' AND n.provider_message_id IS NOT NULL AND n.status IN ('accepted','delivered') AND d.status IN ('preparing','awaiting_confirmation','superseded'));
$$;
REVOKE ALL ON FUNCTION public.has_live_booking_review(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.has_live_booking_review(uuid,text) TO service_role;
COMMIT;
