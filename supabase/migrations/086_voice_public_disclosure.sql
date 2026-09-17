BEGIN;
-- Existing sessions retain their admitted protocol. New commercial sessions
-- require the public same-Marin opening; no private acknowledgment can bypass it.
ALTER TABLE public.voice_sessions
  ADD COLUMN disclosure_version integer NOT NULL DEFAULT 0 CHECK(disclosure_version IN (0,1)),
  ADD COLUMN public_notice_rehearsal boolean NOT NULL DEFAULT false,
  ADD COLUMN disclosure_started_at timestamptz,
  ADD COLUMN disclosure_event_id text,
  ADD COLUMN recording_started_at timestamptz,
  ADD COLUMN conversation_handoff_event_id text,
  ADD COLUMN conversation_handoff_started_at timestamptz,
  ADD COLUMN conversation_input_start_ms numeric;
ALTER TABLE public.voice_sessions ALTER COLUMN disclosure_version SET DEFAULT 1;

-- A protected, expiring rehearsal consumes the existing tester's next admitted
-- private call. It never creates a commercial grant or changes pilot billing.
ALTER TABLE public.voice_pilot_testers ADD COLUMN public_notice_rehearsal_until timestamptz;
CREATE FUNCTION public.arm_voice_public_opening_rehearsal(p_phone text,p_admin uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE cfg public.voice_pilot_settings; changed text;
BEGIN
  PERFORM 1 FROM public.businesses WHERE id='ea848911-ef72-44a6-8cf3-c47b3959be26' FOR UPDATE;
  SELECT * INTO cfg FROM public.voice_pilot_settings WHERE business_id='ea848911-ef72-44a6-8cf3-c47b3959be26' FOR UPDATE;
  IF p_admin IS NULL OR cfg.business_id IS NULL OR NOT cfg.enabled OR cfg.retired_at IS NOT NULL
    OR EXISTS(SELECT 1 FROM public.voice_sessions WHERE business_id=cfg.business_id AND response_mode='voice' AND status<>'closed') THEN RETURN false; END IF;
  UPDATE public.voice_pilot_testers SET public_notice_rehearsal_until=clock_timestamp()+interval '30 minutes'
    WHERE business_id=cfg.business_id AND phone_number=p_phone AND test_mode='business' RETURNING phone_number INTO changed;
  IF changed IS NULL THEN RETURN false; END IF;
  INSERT INTO public.voice_pilot_audit(business_id,admin_id,old_revision,new_settings)
    VALUES(cfg.business_id,p_admin,cfg.revision,jsonb_build_object('public_notice_rehearsal','next_approved_call','expires_in_minutes',30));
  RETURN true;
END $$;
CREATE FUNCTION public.select_voice_public_opening_rehearsal() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE selected text;
BEGIN
  IF NEW.access_source='pilot' AND NEW.response_mode='voice' AND NOT NEW.demo_mode THEN
    UPDATE public.voice_pilot_testers SET public_notice_rehearsal_until=NULL
      WHERE business_id=NEW.business_id AND phone_number=NEW.caller_phone AND test_mode='business'
        AND public_notice_rehearsal_until>clock_timestamp() RETURNING phone_number INTO selected;
    IF selected IS NOT NULL THEN NEW.public_notice_rehearsal:=true; NEW.disclosure_version:=1; NEW.prior_disclosure_acknowledged_at:=NULL; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER select_voice_public_opening_rehearsal BEFORE INSERT ON public.voice_sessions FOR EACH ROW EXECUTE FUNCTION public.select_voice_public_opening_rehearsal();

CREATE FUNCTION public.voice_disclosure_continuation_allowed(p_session_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT public.voice_session_continuation_allowed(p_session_id) OR EXISTS(
    SELECT 1 FROM public.voice_sessions s JOIN public.voice_pilot_settings p USING(business_id)
      JOIN public.businesses b ON b.id=s.business_id JOIN public.voice_pilot_testers t ON t.business_id=s.business_id AND t.phone_number=s.caller_phone
      JOIN public.subscriptions sub ON sub.business_id=b.id
    WHERE s.id=p_session_id AND s.access_source='pilot' AND s.public_notice_rehearsal AND s.disclosure_version=1
      AND s.status NOT IN ('closing','closed') AND s.phone_ended_at IS NULL AND NOT s.demo_mode AND p.enabled
      AND (p.retired_at IS NULL OR s.created_at<p.retired_at) AND t.test_mode='business'
      AND b.owner_id IS NOT NULL AND b.deleted_at IS NULL AND b.operations_suspended_at IS NULL AND b.ai_replies_paused_at IS NULL
      AND sub.status IN ('active','trialing') AND s.created_at+interval '120 seconds'>clock_timestamp());
$$;

CREATE OR REPLACE FUNCTION public.consume_voice_stream(p_token_hash text) RETURNS public.voice_sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.voice_sessions; sid uuid;
BEGIN
  SELECT v.* INTO s FROM public.voice_sessions v JOIN public.voice_stream_credentials c ON c.session_id=v.id WHERE c.token_hash=p_token_hash;
  IF s.id IS NULL THEN RETURN NULL; END IF;
  IF s.access_source='pilot' AND NOT s.public_notice_rehearsal THEN RETURN public.consume_voice_pilot_stream_legacy(p_token_hash); END IF;
  UPDATE public.voice_stream_credentials c SET consumed_at=clock_timestamp() WHERE c.token_hash=p_token_hash AND c.consumed_at IS NULL AND c.expires_at>clock_timestamp()
    AND ((s.disclosure_version=1 AND s.status='notice' AND s.notice_completed_at IS NULL)
      OR (s.disclosure_version=0 AND s.status='starting' AND s.notice_completed_at IS NOT NULL))
    AND public.voice_disclosure_continuation_allowed(s.id) RETURNING c.session_id INTO sid;
  IF sid IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO s FROM public.voice_sessions WHERE id=sid;
  RETURN s;
END $$;

CREATE OR REPLACE FUNCTION public.activate_voice_session(p_session_id uuid,p_openai_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE changed uuid;
BEGIN
  IF EXISTS(SELECT 1 FROM public.voice_sessions WHERE id=p_session_id AND access_source='pilot' AND NOT public_notice_rehearsal) THEN
    RETURN public.activate_voice_pilot_session_legacy(p_session_id,p_openai_id); END IF;
  IF NULLIF(p_openai_id,'') IS NULL THEN RETURN false; END IF;
  UPDATE public.voice_sessions s SET status='active',openai_session_id=p_openai_id,started_at=clock_timestamp(),heartbeat_at=clock_timestamp()
    WHERE s.id=p_session_id AND s.disclosure_version=0 AND s.status='starting' AND s.notice_completed_at IS NOT NULL
      AND public.voice_disclosure_continuation_allowed(s.id) RETURNING s.id INTO changed;
  RETURN changed IS NOT NULL;
END $$;

CREATE FUNCTION public.begin_voice_disclosure(p_session_id uuid,p_openai_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE changed uuid;
BEGIN
  IF NULLIF(p_openai_id,'') IS NULL OR length(p_openai_id)>200 THEN RETURN false; END IF;
  UPDATE public.voice_sessions s SET openai_session_id=p_openai_id,disclosure_started_at=COALESCE(disclosure_started_at,clock_timestamp()),heartbeat_at=clock_timestamp()
    WHERE s.id=p_session_id AND (s.access_source='commercial' OR s.public_notice_rehearsal) AND s.disclosure_version=1 AND s.status='notice'
      AND (s.openai_session_id IS NULL OR s.openai_session_id=p_openai_id) AND s.notice_completed_at IS NULL
      AND EXISTS(SELECT 1 FROM public.voice_stream_credentials c WHERE c.session_id=s.id AND c.consumed_at IS NOT NULL)
      AND public.voice_disclosure_continuation_allowed(s.id) RETURNING s.id INTO changed;
  RETURN changed IS NOT NULL;
END $$;

-- Only the authenticated worker supplies this identity, after complete actual
-- audible notice playback and a current-stream, non-interrupted transport ACK.
CREATE FUNCTION public.complete_voice_disclosure(p_session_id uuid,p_event_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE changed uuid;
BEGIN
  IF p_event_id IS NULL OR p_event_id !~ '^notice-[12]-[a-zA-Z0-9-]{1,100}$' THEN RETURN false; END IF;
  UPDATE public.voice_sessions s SET notice_completed_at=COALESCE(notice_completed_at,clock_timestamp()),disclosure_event_id=p_event_id
    WHERE s.id=p_session_id AND (s.access_source='commercial' OR s.public_notice_rehearsal) AND s.disclosure_version=1 AND s.status='notice'
      AND s.disclosure_started_at IS NOT NULL AND s.disclosure_started_at>clock_timestamp()-interval '25 seconds'
      AND (s.disclosure_event_id IS NULL OR s.disclosure_event_id=p_event_id)
      AND public.voice_disclosure_continuation_allowed(s.id) RETURNING s.id INTO changed;
  RETURN changed IS NOT NULL;
END $$;

CREATE FUNCTION public.mark_voice_recording_started(p_session_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE changed uuid;
BEGIN
  UPDATE public.voice_sessions s SET recording_started_at=COALESCE(recording_started_at,clock_timestamp())
    WHERE s.id=p_session_id AND (s.access_source='commercial' OR s.public_notice_rehearsal) AND s.disclosure_version=1 AND s.status='notice'
      AND s.notice_completed_at IS NOT NULL AND s.disclosure_event_id IS NOT NULL
      AND public.voice_disclosure_continuation_allowed(s.id) RETURNING s.id INTO changed;
  RETURN changed IS NOT NULL;
END $$;

CREATE FUNCTION public.begin_voice_conversation_handoff(p_session_id uuid,p_event_id text,p_started_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.voice_sessions;
BEGIN
  PERFORM 1 FROM public.businesses WHERE id=(SELECT business_id FROM public.voice_sessions WHERE id=p_session_id) FOR UPDATE;
  PERFORM 1 FROM public.voice_allowance_periods WHERE id=(SELECT period_id FROM public.voice_customer_usage WHERE call_key=p_session_id) FOR UPDATE;
  PERFORM 1 FROM public.voice_customer_usage WHERE call_key=p_session_id FOR UPDATE;
  SELECT * INTO s FROM public.voice_sessions WHERE id=p_session_id FOR UPDATE;
  IF s.id IS NULL OR (s.access_source<>'commercial' AND NOT s.public_notice_rehearsal) OR s.disclosure_version<>1 OR s.status<>'notice'
    OR s.recording_started_at IS NULL OR p_started_at<s.recording_started_at-interval '1 second'
    OR p_event_id IS NULL OR p_event_id !~ '^handoff-[a-zA-Z0-9-]{1,100}$'
    OR (s.conversation_handoff_event_id IS NOT NULL AND s.conversation_handoff_event_id<>p_event_id)
    OR NOT public.voice_disclosure_continuation_allowed(s.id) THEN RETURN false; END IF;
  UPDATE public.voice_sessions SET conversation_handoff_event_id=p_event_id,conversation_handoff_started_at=COALESCE(conversation_handoff_started_at,p_started_at) WHERE id=s.id;
  IF s.access_source='commercial' THEN PERFORM public.record_voice_customer_start(s.id,p_event_id,p_started_at); END IF;
  RETURN true;
END $$;

CREATE FUNCTION public.acknowledge_voice_conversation_handoff(p_session_id uuid,p_event_id text,p_input_start_ms numeric) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.voice_sessions; u public.voice_customer_usage;
BEGIN
  PERFORM 1 FROM public.businesses WHERE id=(SELECT business_id FROM public.voice_sessions WHERE id=p_session_id) FOR UPDATE;
  PERFORM 1 FROM public.voice_allowance_periods WHERE id=(SELECT period_id FROM public.voice_customer_usage WHERE call_key=p_session_id) FOR UPDATE;
  SELECT * INTO u FROM public.voice_customer_usage WHERE call_key=p_session_id FOR UPDATE;
  SELECT * INTO s FROM public.voice_sessions WHERE id=p_session_id FOR UPDATE;
  IF s.id IS NULL OR (s.access_source<>'commercial' AND NOT s.public_notice_rehearsal) OR s.disclosure_version<>1 OR s.status NOT IN ('notice','active')
    OR s.notice_completed_at IS NULL OR s.recording_started_at IS NULL OR s.conversation_handoff_started_at IS NULL
    OR s.conversation_handoff_event_id IS DISTINCT FROM p_event_id
    OR (s.access_source='commercial' AND (u.started_at IS NULL OR u.start_event_id IS DISTINCT FROM p_event_id))
    OR p_input_start_ms IS NULL OR p_input_start_ms NOT BETWEEN 0 AND 120000
    OR NOT public.voice_disclosure_continuation_allowed(s.id) THEN RETURN false; END IF;
  IF s.status='active' THEN RETURN s.conversation_input_start_ms=p_input_start_ms; END IF;
  UPDATE public.voice_sessions SET status='active',started_at=s.conversation_handoff_started_at,conversation_input_start_ms=p_input_start_ms,heartbeat_at=clock_timestamp() WHERE id=s.id;
  IF s.access_source='commercial' THEN PERFORM public.acknowledge_voice_customer_start(s.id,p_event_id); END IF;
  RETURN true;
END $$;

DO $$ DECLARE d text; needle text; BEGIN
  d:=pg_get_functiondef('public.claim_voice_preparation(uuid)'::regprocedure);
  needle:='WHERE s.id=p_session_id AND s.access_source=''pilot'' AND (p.retired_at IS NULL OR s.created_at<p.retired_at)) THEN';
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'voice preparation definition drift'; END IF;
  EXECUTE replace(d,needle,'WHERE s.id=p_session_id AND s.access_source=''pilot'' AND NOT s.public_notice_rehearsal AND (p.retired_at IS NULL OR s.created_at<p.retired_at)) THEN');
  d:=pg_get_functiondef('public.prepare_preinformed_voice_session(uuid)'::regprocedure);
  needle:='BEGIN';
  EXECUTE replace(d,needle,E'BEGIN\n  IF EXISTS(SELECT 1 FROM public.voice_sessions WHERE id=p_session_id AND public_notice_rehearsal) THEN RETURN NULL; END IF;');
END $$;

-- Existing RPC identities and their callers stay intact. No transcript fragment
-- or generic activation/customer-audio RPC may bypass the versioned handoff.
DO $$ DECLARE d text; needle text; BEGIN
  d:=pg_get_functiondef('public.record_voice_fragment(uuid,text,text,text,numeric,numeric)'::regprocedure);
  needle:='IF s.id IS NULL OR s.response_mode <> ''voice'' THEN RAISE EXCEPTION ''Unknown voice session''; END IF;';
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'voice fragment definition drift'; END IF;
  EXECUTE replace(d,needle,needle||E'\n  IF (s.access_source=''commercial'' OR s.public_notice_rehearsal) AND s.disclosure_version=1 AND (s.started_at IS NULL OR s.conversation_input_start_ms IS NULL OR p_start_ms<s.conversation_input_start_ms) THEN RAISE EXCEPTION ''voice conversation not activated''; END IF;');
  d:=pg_get_functiondef('public.record_voice_customer_start(uuid,text,timestamptz)'::regprocedure);
  needle:='IF u.settled_at IS NOT NULL THEN RETURN jsonb_build_object(''state'',u.state); END IF;';
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'voice start definition drift'; END IF;
  EXECUTE replace(d,needle,needle||E'\n  IF EXISTS(SELECT 1 FROM public.voice_sessions s WHERE s.id=p_session_id AND s.access_source=''commercial'' AND s.disclosure_version=1 AND (s.notice_completed_at IS NULL OR s.recording_started_at IS NULL OR s.conversation_handoff_event_id IS DISTINCT FROM p_event_id)) THEN RAISE EXCEPTION ''voice handoff required''; END IF;');
  d:=pg_get_functiondef('public.acknowledge_voice_customer_start(uuid,text)'::regprocedure);
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'voice start ack definition drift'; END IF;
  EXECUTE replace(d,needle,needle||E'\n  IF EXISTS(SELECT 1 FROM public.voice_sessions s WHERE s.id=p_session_id AND s.access_source=''commercial'' AND s.disclosure_version=1 AND s.started_at IS NULL) THEN RAISE EXCEPTION ''voice handoff acknowledgment required''; END IF;');
  d:=pg_get_functiondef('public.settle_voice_customer_usage(uuid,boolean)'::regprocedure);
  needle:='IF NOT u.evidence_conflict AND u.start_acknowledged_at IS NOT NULL AND u.ended_at>=u.started_at THEN';
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'voice settlement definition drift'; END IF;
  d:=replace(d,needle,E'IF EXISTS(SELECT 1 FROM public.voice_sessions s WHERE s.id=u.session_id AND s.access_source=''commercial'' AND s.disclosure_version=1 AND s.started_at IS NULL) THEN\n    amount:=0; adjustment:=true;\n  ELSIF NOT u.evidence_conflict AND u.start_acknowledged_at IS NOT NULL AND u.ended_at>=u.started_at THEN');
  d:=replace(d,'''unproven_customer_time_waived''','CASE WHEN EXISTS(SELECT 1 FROM public.voice_sessions s WHERE s.id=u.session_id AND s.disclosure_version=1 AND s.started_at IS NULL) THEN ''disclosure_only_no_customer_usage'' ELSE ''unproven_customer_time_waived'' END');
  EXECUTE d;
END $$;

-- Same-Marin opening has no Telnyx TTS charge. Streaming begins at media
-- startup and recording begins only after the acknowledged disclosure.
CREATE OR REPLACE FUNCTION public.estimate_voice_telnyx_usage(p_notice_characters integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF p_notice_characters NOT BETWEEN 0 AND 1000 THEN RAISE EXCEPTION 'Invalid notice length'; END IF;
  INSERT INTO public.voice_provider_usage(session_id,business_id,provider,request_id,model,status,seconds,estimated_cost_usd)
    SELECT id,business_id,'telnyx','call','voice-api-us-estimate-2026-09-14','unconfirmed',
      GREATEST(0,extract(epoch FROM phone_ended_at-created_at)),
      GREATEST(0,extract(epoch FROM phone_ended_at-created_at))*0.0052/60
      + CASE WHEN disclosure_version=1 AND (access_source='commercial' OR public_notice_rehearsal) THEN
          CASE WHEN media_start_requested_at IS NOT NULL THEN GREATEST(0,extract(epoch FROM phone_ended_at-media_start_requested_at))*0.0035/60 ELSE 0 END
          + CASE WHEN recording_started_at IS NOT NULL THEN GREATEST(0,extract(epoch FROM phone_ended_at-recording_started_at))*0.002/60 ELSE 0 END
        ELSE
          CASE WHEN COALESCE(media_start_requested_at,notice_completed_at) IS NOT NULL THEN GREATEST(0,extract(epoch FROM phone_ended_at-COALESCE(media_start_requested_at,notice_completed_at)))*0.0055/60 ELSE 0 END
          + CASE WHEN notice_completed_at IS NOT NULL THEN p_notice_characters*0.000024 ELSE 0 END
        END
    FROM public.voice_sessions WHERE response_mode='voice' AND phone_ended_at IS NOT NULL
    ON CONFLICT(session_id,provider,request_id) DO UPDATE SET seconds=EXCLUDED.seconds,estimated_cost_usd=EXCLUDED.estimated_cost_usd
      WHERE voice_provider_usage.seconds IS DISTINCT FROM EXCLUDED.seconds OR voice_provider_usage.estimated_cost_usd IS DISTINCT FROM EXCLUDED.estimated_cost_usd;
END $$;

DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY(ARRAY[
    'arm_voice_public_opening_rehearsal','select_voice_public_opening_rehearsal','voice_disclosure_continuation_allowed','begin_voice_disclosure','complete_voice_disclosure','mark_voice_recording_started','begin_voice_conversation_handoff','acknowledge_voice_conversation_handoff']) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
  END LOOP;
END $$;
COMMIT;
