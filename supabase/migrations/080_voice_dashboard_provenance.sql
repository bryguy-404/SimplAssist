BEGIN;

-- Provider acceptance, customer-visible bookkeeping, delivery polling, and SMS
-- usage are separate facts. None of these columns authorize a provider send.
ALTER TABLE public.voice_actions
  ADD COLUMN sms_provider_message_id text,
  ADD COLUMN sms_accepted_at timestamptz,
  ADD COLUMN goal_event_recorded_at timestamptz,
  ADD COLUMN bookkeeping_attempted_at timestamptz,
  ADD CONSTRAINT voice_signup_provider_identity CHECK (
    sms_provider_message_id IS NULL OR (
      kind='signup' AND length(btrim(sms_provider_message_id)) BETWEEN 1 AND 256
      AND sms_provider_message_id=btrim(sms_provider_message_id)
      AND result->>'providerMessageId' IS NOT DISTINCT FROM sms_provider_message_id
    )
  ),
  ADD CONSTRAINT voice_signup_acceptance_identity CHECK (
    sms_accepted_at IS NULL OR sms_provider_message_id IS NOT NULL
  );
CREATE UNIQUE INDEX voice_signup_provider_message_unique
  ON public.voice_actions(sms_provider_message_id) WHERE sms_provider_message_id IS NOT NULL;
CREATE INDEX voice_signup_bookkeeping_pending ON public.voice_actions(bookkeeping_attempted_at,updated_at)
  WHERE kind='signup' AND status='succeeded' AND sms_accepted_at IS NOT NULL
    AND (goal_event_recorded_at IS NULL OR sms_logged_at IS NULL);

ALTER TABLE public.goal_events
  ADD COLUMN origin_kind text NOT NULL DEFAULT 'conversation'
    CHECK (origin_kind IN ('conversation','voice_action')),
  ADD COLUMN voice_action_id uuid REFERENCES public.voice_actions(id) ON DELETE SET NULL,
  ADD COLUMN source_conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  ADD COLUMN time_source text NOT NULL DEFAULT 'action_recorded'
    CHECK (time_source IN ('action_recorded','provider_accepted','message_recorded')),
  ADD CONSTRAINT goal_events_voice_origin CHECK (
    (origin_kind='conversation' AND voice_action_id IS NULL AND source_conversation_id IS NULL AND time_source='action_recorded')
    OR (origin_kind='voice_action' AND channel='sms' AND goal_at_event='signup'
      AND time_source IN ('provider_accepted','message_recorded'))
  );
CREATE UNIQUE INDEX goal_events_voice_action_unique ON public.goal_events(voice_action_id,event_type)
  WHERE voice_action_id IS NOT NULL;
CREATE INDEX goal_events_source_conversation_idx ON public.goal_events(source_conversation_id)
  WHERE source_conversation_id IS NOT NULL;
COMMENT ON COLUMN public.goal_events.time_source IS
  'Provider acceptance for new voice sends; original outbound message time for verified historical voice sends; legacy recorder time otherwise.';

CREATE FUNCTION public.guard_voice_signup_bookkeeping() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.sms_provider_message_id IS NOT NULL THEN
    IF ROW(NEW.id,NEW.business_id,NEW.session_id,NEW.kind,NEW.payload,NEW.confirmed_at,
      NEW.sms_provider_message_id,NEW.sms_accepted_at,NEW.result->>'providerMessageId',NEW.result->>'smsBody')
      IS DISTINCT FROM ROW(OLD.id,OLD.business_id,OLD.session_id,OLD.kind,OLD.payload,OLD.confirmed_at,
      OLD.sms_provider_message_id,OLD.sms_accepted_at,OLD.result->>'providerMessageId',OLD.result->>'smsBody')
      OR (NEW.source_message_id IS DISTINCT FROM OLD.source_message_id AND NEW.source_message_id IS NOT NULL)
      OR (OLD.goal_event_recorded_at IS NOT NULL AND NEW.goal_event_recorded_at IS DISTINCT FROM OLD.goal_event_recorded_at) THEN
      RAISE EXCEPTION 'accepted voice signup identity is immutable' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_voice_signup_bookkeeping BEFORE UPDATE ON public.voice_actions
  FOR EACH ROW EXECUTE FUNCTION public.guard_voice_signup_bookkeeping();
REVOKE ALL ON FUNCTION public.guard_voice_signup_bookkeeping() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.validate_goal_event_tenant() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.voice_actions; s public.voice_sessions; source_conv uuid;
BEGIN
  IF TG_OP='INSERT' AND (NEW.contact_id IS NULL OR NEW.conversation_id IS NULL
      OR NEW.source_message_id IS NULL OR NEW.assistant_message_id IS NULL
      OR (NEW.origin_kind='voice_action' AND (NEW.voice_action_id IS NULL OR NEW.source_conversation_id IS NULL))) THEN
    RAISE EXCEPTION 'goal event requires contact, conversation, source message, and assistant message linkage'
      USING ERRCODE='23514',CONSTRAINT='goal_events_initial_linkage_required';
  END IF;
  IF NEW.contact_id IS NOT NULL THEN
    PERFORM 1 FROM public.contacts WHERE id=NEW.contact_id AND business_id=NEW.business_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'goal event contact tenant mismatch' USING ERRCODE='23514',CONSTRAINT='goal_events_contact_match'; END IF;
  END IF;
  IF NEW.conversation_id IS NOT NULL THEN
    PERFORM 1 FROM public.conversations WHERE id=NEW.conversation_id AND business_id=NEW.business_id
      AND (NEW.contact_id IS NULL OR contact_id=NEW.contact_id) AND channel=NEW.channel FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'goal event conversation tenant mismatch' USING ERRCODE='23514',CONSTRAINT='goal_events_conversation_match'; END IF;
  END IF;
  source_conv:=NEW.conversation_id;
  IF NEW.origin_kind='voice_action' THEN
    source_conv:=NEW.source_conversation_id;
    IF source_conv IS NOT NULL THEN
      PERFORM 1 FROM public.conversations WHERE id=source_conv AND business_id=NEW.business_id AND channel='voice'
        AND (NEW.contact_id IS NULL OR contact_id=NEW.contact_id) FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'goal event voice conversation mismatch' USING ERRCODE='23514'; END IF;
    END IF;
    IF NEW.voice_action_id IS NOT NULL THEN
      SELECT * INTO a FROM public.voice_actions WHERE id=NEW.voice_action_id FOR SHARE;
      SELECT * INTO s FROM public.voice_sessions WHERE id=a.session_id FOR SHARE;
      IF a.id IS NULL OR s.id IS NULL OR s.demo_mode OR s.response_mode<>'voice'
        OR a.business_id<>NEW.business_id OR s.business_id<>NEW.business_id
        OR COALESCE(s.action_business_id,s.business_id)<>NEW.business_id
        OR a.kind<>'signup' OR a.confirmed_at IS NULL OR a.sms_provider_message_id IS NULL
        OR (source_conv IS NOT NULL AND COALESCE(s.action_conversation_id,s.conversation_id) IS DISTINCT FROM source_conv)
        OR (NEW.source_message_id IS NOT NULL AND a.source_message_id IS DISTINCT FROM NEW.source_message_id)
        OR (NEW.assistant_message_id IS NOT NULL AND NEW.assistant_message_id<>a.id)
        OR NEW.idempotency_key<>'voice-signup:'||a.id::text
        OR (TG_OP='INSERT' AND (a.status<>'succeeded'
          OR (NEW.time_source='provider_accepted' AND a.sms_accepted_at IS DISTINCT FROM NEW.occurred_at)
          OR (NEW.time_source='message_recorded' AND (a.sms_accepted_at IS NOT NULL OR NOT EXISTS(
            SELECT 1 FROM public.messages m WHERE m.id=a.id AND m.created_at=NEW.occurred_at))))) THEN
        RAISE EXCEPTION 'goal event voice action mismatch' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  IF NEW.source_message_id IS NOT NULL THEN
    PERFORM 1 FROM public.messages WHERE id=NEW.source_message_id AND business_id=NEW.business_id
      AND conversation_id=source_conv AND channel=CASE WHEN NEW.origin_kind='voice_action' THEN 'voice' ELSE NEW.channel END
      AND role='customer' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'goal event source message tenant mismatch' USING ERRCODE='23514',CONSTRAINT='goal_events_source_message_match'; END IF;
  END IF;
  IF NEW.assistant_message_id IS NOT NULL THEN
    PERFORM 1 FROM public.messages WHERE id=NEW.assistant_message_id AND business_id=NEW.business_id
      AND conversation_id=NEW.conversation_id AND channel=NEW.channel AND role='assistant' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'goal event assistant message tenant mismatch' USING ERRCODE='23514',CONSTRAINT='goal_events_assistant_message_match'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.guard_goal_event_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
  IF ROW(NEW.id,NEW.business_id,NEW.goal_at_event,NEW.event_type,NEW.channel,NEW.occurred_at,NEW.idempotency_key,NEW.created_at,NEW.origin_kind,NEW.time_source)
    IS DISTINCT FROM ROW(OLD.id,OLD.business_id,OLD.goal_at_event,OLD.event_type,OLD.channel,OLD.occurred_at,OLD.idempotency_key,OLD.created_at,OLD.origin_kind,OLD.time_source)
    OR (NEW.contact_id IS DISTINCT FROM OLD.contact_id AND NEW.contact_id IS NOT NULL)
    OR (NEW.conversation_id IS DISTINCT FROM OLD.conversation_id AND NEW.conversation_id IS NOT NULL)
    OR (NEW.source_message_id IS DISTINCT FROM OLD.source_message_id AND NEW.source_message_id IS NOT NULL)
    OR (NEW.assistant_message_id IS DISTINCT FROM OLD.assistant_message_id AND NEW.assistant_message_id IS NOT NULL)
    OR (NEW.source_conversation_id IS DISTINCT FROM OLD.source_conversation_id AND NEW.source_conversation_id IS NOT NULL)
    OR (NEW.voice_action_id IS DISTINCT FROM OLD.voice_action_id AND NEW.voice_action_id IS NOT NULL) THEN
    RAISE EXCEPTION 'goal event history is immutable; retained linkages may only be cleared' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.guard_conversation_goal_event_linkage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF ROW(NEW.id,NEW.business_id,NEW.contact_id,NEW.channel) IS DISTINCT FROM ROW(OLD.id,OLD.business_id,OLD.contact_id,OLD.channel)
    AND EXISTS(SELECT 1 FROM public.goal_events WHERE conversation_id=OLD.id OR source_conversation_id=OLD.id) THEN
    RAISE EXCEPTION 'conversation linkage is immutable while goal events exist' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.unlink_goal_events_before_conversation_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.businesses WHERE id=OLD.business_id) THEN
    UPDATE public.goal_events SET conversation_id=NULL,assistant_message_id=NULL,
      source_message_id=CASE WHEN origin_kind='conversation' THEN NULL ELSE source_message_id END
      WHERE conversation_id=OLD.id;
    UPDATE public.goal_events SET source_conversation_id=NULL,source_message_id=NULL,voice_action_id=NULL
      WHERE source_conversation_id=OLD.id;
  END IF;
  RETURN OLD;
END $$;
CREATE OR REPLACE FUNCTION public.unlink_goal_events_before_contact_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.businesses WHERE id=OLD.business_id) THEN
    UPDATE public.goal_events SET contact_id=NULL,conversation_id=NULL,source_message_id=NULL,assistant_message_id=NULL,
      source_conversation_id=NULL,voice_action_id=NULL WHERE contact_id=OLD.id;
  END IF;
  RETURN OLD;
END $$;
CREATE FUNCTION public.unlink_goal_events_before_voice_action_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.businesses WHERE id=OLD.business_id) THEN
    UPDATE public.goal_events SET voice_action_id=NULL,source_conversation_id=NULL,source_message_id=NULL
      WHERE voice_action_id=OLD.id;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER unlink_goal_events_before_voice_action_delete BEFORE DELETE ON public.voice_actions
  FOR EACH ROW EXECUTE FUNCTION public.unlink_goal_events_before_voice_action_delete();
REVOKE ALL ON FUNCTION public.unlink_goal_events_before_voice_action_delete() FROM PUBLIC,anon,authenticated,service_role;

-- Atomically reconcile local records only. It cannot send an SMS, execute an
-- action, bill usage, or recreate deleted provenance. Replays retain the event's
-- original time and its original (possibly now closed) SMS conversation.
CREATE FUNCTION public.finalize_voice_signup_bookkeeping(p_action_id uuid,p_historical_occurred_at timestamptz DEFAULT NULL)
RETURNS TABLE(message_id uuid,conversation_id uuid,goal_event_id uuid,occurred_at timestamptz,created_event boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a public.voice_actions; s public.voice_sessions; m public.messages; e public.goal_events;
  call_conv public.conversations; sms_conv public.conversations; contact public.contacts;
  event_time timestamptz; time_origin text; provider_id text; sms_body text;
BEGIN
  SELECT * INTO a FROM public.voice_actions WHERE id=p_action_id FOR UPDATE;
  IF a.id IS NULL THEN RAISE EXCEPTION 'voice signup action missing'; END IF;
  SELECT * INTO e FROM public.goal_events WHERE business_id=a.business_id AND idempotency_key='voice-signup:'||a.id::text;
  IF e.id IS NOT NULL THEN
    IF e.origin_kind<>'voice_action' OR (e.voice_action_id IS NOT NULL AND e.voice_action_id<>a.id)
      OR (e.time_source='provider_accepted' AND (a.sms_accepted_at IS DISTINCT FROM e.occurred_at OR p_historical_occurred_at IS NOT NULL))
      OR (e.time_source='message_recorded' AND (a.sms_accepted_at IS NOT NULL OR
        (p_historical_occurred_at IS NOT NULL AND p_historical_occurred_at IS DISTINCT FROM e.occurred_at))) THEN
      RAISE EXCEPTION 'voice signup event collision';
    END IF;
    IF e.source_conversation_id IS NOT NULL THEN
      SELECT * INTO s FROM public.voice_sessions WHERE id=a.session_id FOR SHARE;
      SELECT * INTO call_conv FROM public.conversations WHERE id=e.source_conversation_id FOR SHARE;
      IF s.id IS NULL OR s.demo_mode OR s.business_id<>a.business_id
        OR COALESCE(s.action_conversation_id,s.conversation_id) IS DISTINCT FROM e.source_conversation_id
        OR call_conv.business_id IS DISTINCT FROM a.business_id OR call_conv.channel<>'voice'
        OR (e.contact_id IS NOT NULL AND call_conv.contact_id IS DISTINCT FROM e.contact_id)
        OR (e.source_message_id IS NOT NULL AND e.source_message_id IS DISTINCT FROM a.source_message_id) THEN
        RAISE EXCEPTION 'voice signup event collision';
      END IF;
    END IF;
    IF e.assistant_message_id IS NOT NULL THEN
      SELECT * INTO m FROM public.messages WHERE id=e.assistant_message_id FOR SHARE;
      SELECT * INTO sms_conv FROM public.conversations WHERE id=e.conversation_id FOR SHARE;
      IF m.id IS DISTINCT FROM a.id OR m.business_id IS DISTINCT FROM a.business_id
        OR m.conversation_id IS DISTINCT FROM e.conversation_id OR m.channel<>'sms' OR m.role<>'assistant'
        OR m.content IS DISTINCT FROM a.result->>'smsBody'
        OR (e.time_source='message_recorded' AND m.created_at IS DISTINCT FROM e.occurred_at)
        OR sms_conv.business_id IS DISTINCT FROM a.business_id
        OR (e.contact_id IS NOT NULL AND sms_conv.contact_id IS DISTINCT FROM e.contact_id) THEN
        RAISE EXCEPTION 'voice signup message collision';
      END IF;
    END IF;
    -- Never reattach a cleared reference or recreate an erased message.
    RETURN QUERY SELECT e.assistant_message_id,e.conversation_id,e.id,e.occurred_at,false;
    RETURN;
  END IF;
  IF a.goal_event_recorded_at IS NOT NULL THEN RAISE EXCEPTION 'voice signup event was removed'; END IF;
  SELECT * INTO s FROM public.voice_sessions WHERE id=a.session_id FOR SHARE;
  IF a.kind<>'signup' OR a.status<>'succeeded' OR a.confirmed_at IS NULL OR a.source_message_id IS NULL
    OR s.id IS NULL OR s.demo_mode OR s.response_mode<>'voice' OR s.business_id<>a.business_id
    OR COALESCE(s.action_business_id,s.business_id)<>a.business_id THEN
    RAISE EXCEPTION 'voice signup is not an accepted confirmed business action';
  END IF;
  PERFORM 1 FROM public.businesses WHERE id=a.business_id AND owner_id IS NOT NULL AND deleted_at IS NULL
    AND cleanup_pii_scrubbed_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'voice signup business unavailable'; END IF;
  SELECT * INTO call_conv FROM public.conversations WHERE id=COALESCE(s.action_conversation_id,s.conversation_id)
    AND business_id=a.business_id AND channel='voice' FOR SHARE;
  SELECT * INTO contact FROM public.contacts WHERE id=call_conv.contact_id AND business_id=a.business_id FOR UPDATE;
  IF call_conv.id IS NULL OR contact.id IS NULL THEN RAISE EXCEPTION 'voice signup call contact missing'; END IF;
  PERFORM 1 FROM public.messages confirmed WHERE confirmed.id=a.source_message_id AND confirmed.business_id=a.business_id
    AND confirmed.conversation_id=call_conv.id AND confirmed.channel='voice' AND confirmed.role='customer' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'voice signup confirmation missing'; END IF;
  provider_id:=NULLIF(btrim(a.result->>'providerMessageId'),''); sms_body:=a.result->>'smsBody';
  IF provider_id IS NULL OR length(provider_id)>256 OR sms_body IS NULL OR length(btrim(sms_body))=0
    OR (a.sms_provider_message_id IS NOT NULL AND a.sms_provider_message_id<>provider_id)
    OR (a.result->>'contactId' IS NOT NULL AND a.result->>'contactId'<>contact.id::text) THEN
    RAISE EXCEPTION 'voice signup provider identity mismatch';
  END IF;
  -- Existing legacy provider identities also participate before their explicit
  -- provider column is backfilled. Serialize by identity across different calls.
  PERFORM pg_advisory_xact_lock(hashtextextended('voice-signup-provider:'||provider_id,0));
  IF EXISTS(SELECT 1 FROM public.voice_actions other WHERE other.id<>a.id
    AND (other.sms_provider_message_id=provider_id OR other.result->>'providerMessageId'=provider_id)) THEN
    RAISE EXCEPTION 'voice signup provider identity reused';
  END IF;
  SELECT * INTO m FROM public.messages WHERE id=a.id FOR SHARE;
  IF m.id IS NOT NULL THEN
    SELECT * INTO sms_conv FROM public.conversations WHERE id=m.conversation_id FOR UPDATE;
    IF m.business_id IS DISTINCT FROM a.business_id OR m.channel<>'sms' OR m.role<>'assistant'
      OR m.content IS DISTINCT FROM sms_body OR sms_conv.business_id IS DISTINCT FROM a.business_id
      OR sms_conv.contact_id IS DISTINCT FROM contact.id OR sms_conv.channel<>'sms' THEN
      RAISE EXCEPTION 'voice signup message collision';
    END IF;
  END IF;
  IF a.sms_accepted_at IS NOT NULL THEN
    IF a.sms_provider_message_id IS DISTINCT FROM provider_id OR p_historical_occurred_at IS NOT NULL THEN
      RAISE EXCEPTION 'voice signup acceptance mismatch';
    END IF;
    event_time:=a.sms_accepted_at; time_origin:='provider_accepted';
  ELSE
    IF p_historical_occurred_at IS NULL OR m.id IS NULL OR m.created_at IS DISTINCT FROM p_historical_occurred_at
      OR a.result->>'deliveryStatus' IS DISTINCT FROM 'delivered' OR a.sms_logged_at IS NULL
      OR NOT EXISTS(SELECT 1 FROM public.billing_usage_events u WHERE u.business_id=a.business_id
        AND u.idempotency_key='voice-followup:'||a.id::text AND u.provider_message_id=provider_id
        AND u.direction='outbound' AND u.channel='sms' AND u.source='voice_followup_sms') THEN
      RAISE EXCEPTION 'voice signup historical evidence missing';
    END IF;
    event_time:=m.created_at; time_origin:='message_recorded';
    UPDATE public.voice_actions SET sms_provider_message_id=provider_id WHERE id=a.id;
  END IF;
  IF m.id IS NULL THEN
    SELECT * INTO sms_conv FROM public.conversations WHERE business_id=a.business_id AND contact_id=contact.id
      AND channel='sms' AND status<>'closed' ORDER BY is_ai_handling,status DESC,last_message_at DESC,started_at DESC LIMIT 1 FOR UPDATE;
    IF sms_conv.id IS NULL THEN
      INSERT INTO public.conversations(business_id,contact_id,channel,status,is_ai_handling,started_at,last_message_at)
        VALUES(a.business_id,contact.id,'sms','active',true,event_time,event_time)
        ON CONFLICT (business_id,contact_id,channel) WHERE status<>'closed' AND channel<>'voice' DO NOTHING
        RETURNING * INTO sms_conv;
      IF sms_conv.id IS NULL THEN
        SELECT * INTO sms_conv FROM public.conversations WHERE business_id=a.business_id AND contact_id=contact.id
          AND channel='sms' AND status<>'closed' FOR UPDATE;
      END IF;
    END IF;
    IF sms_conv.id IS NULL THEN RAISE EXCEPTION 'voice signup SMS conversation missing'; END IF;
    INSERT INTO public.messages(id,business_id,conversation_id,role,channel,content,created_at)
      VALUES(a.id,a.business_id,sms_conv.id,'assistant','sms',sms_body,event_time) RETURNING * INTO m;
  END IF;
  INSERT INTO public.goal_events(business_id,contact_id,conversation_id,source_message_id,assistant_message_id,
    goal_at_event,event_type,channel,occurred_at,idempotency_key,origin_kind,voice_action_id,source_conversation_id,time_source)
    VALUES(a.business_id,contact.id,sms_conv.id,a.source_message_id,m.id,'signup','link_sent','sms',event_time,
      'voice-signup:'||a.id::text,'voice_action',a.id,call_conv.id,time_origin) RETURNING * INTO e;
  UPDATE public.conversations SET last_message_at=GREATEST(last_message_at,event_time) WHERE id=sms_conv.id;
  UPDATE public.voice_actions SET goal_event_recorded_at=clock_timestamp() WHERE id=a.id;
  RETURN QUERY SELECT m.id,sms_conv.id,e.id,e.occurred_at,true;
END $$;
REVOKE ALL ON FUNCTION public.finalize_voice_signup_bookkeeping(uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_voice_signup_bookkeeping(uuid,timestamptz) TO service_role;
COMMIT;
