BEGIN;

-- The delegated model interprets natural-language permission. The database must
-- independently prevent it from confirming on a cherry-picked fragment such as
-- only the final "yes" in "if it is free, yes". Keep the complete response since
-- the current acknowledged readback, including any late-arriving corrections.
CREATE OR REPLACE FUNCTION public.claim_voice_action(p_session_id uuid,p_action_id uuid,p_readback_ids text[],p_confirmation_ids text[])
RETURNS public.voice_actions LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.voice_sessions; a public.voice_actions; msg uuid; text_body text; last_end bigint; cited_end bigint;
BEGIN
  -- record_voice_fragment takes the same session lock, so coverage is checked
  -- against all persisted speech before the action can move to executing.
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
  IF EXISTS(SELECT 1 FROM public.voice_transcript_fragments f
    WHERE f.session_id=s.id AND f.role='customer' AND f.received_at>a.playback_at
      AND f.start_ms>=a.playback_caller_end_ms
      AND NOT f.event_id=ANY(COALESCE(p_confirmation_ids,ARRAY[]::text[])))
    THEN RAISE EXCEPTION 'confirmation evidence incomplete'; END IF;
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

REVOKE ALL ON FUNCTION public.claim_voice_action(uuid,uuid,text[],text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_voice_action(uuid,uuid,text[],text[]) TO service_role;
COMMIT;
