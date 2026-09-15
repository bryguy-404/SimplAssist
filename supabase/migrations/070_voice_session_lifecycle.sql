BEGIN;
CREATE FUNCTION public.record_voice_fragment(p_session_id uuid, p_event_id text, p_role text, p_content text, p_start_ms numeric, p_end_ms numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.voice_sessions; inserted uuid;
BEGIN
  SELECT * INTO s FROM public.voice_sessions WHERE id = p_session_id FOR UPDATE;
  IF s.id IS NULL OR s.response_mode <> 'voice' THEN RAISE EXCEPTION 'Unknown voice session'; END IF;
  INSERT INTO public.voice_transcript_fragments(session_id,business_id,event_id,role,content,start_ms,end_ms)
    VALUES(s.id,s.business_id,p_event_id,p_role,p_content,p_start_ms,p_end_ms)
    ON CONFLICT(session_id,event_id) DO NOTHING RETURNING id INTO inserted;
  IF inserted IS NOT NULL AND s.conversation_id IS NOT NULL THEN
    INSERT INTO public.messages(conversation_id,business_id,channel,role,content)
      VALUES(s.conversation_id,s.business_id,'voice',p_role,p_content);
    UPDATE public.conversations SET last_message_at=now() WHERE id=s.conversation_id;
  END IF;
END $$;

CREATE FUNCTION public.update_voice_usage(p_session_id uuid, p_seconds numeric, p_confirmed boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.voice_sessions;
BEGIN
  IF p_seconds IS NULL OR p_seconds < 0 OR p_seconds > 86400 THEN RAISE EXCEPTION 'Invalid voice usage'; END IF;
  -- Same lock order as admission and finalization.
  PERFORM 1 FROM public.voice_pilot_settings WHERE business_id=(SELECT business_id FROM public.voice_sessions WHERE id=p_session_id) FOR UPDATE;
  UPDATE public.voice_sessions SET used_seconds=GREATEST(used_seconds,p_seconds), usage_confirmed=usage_confirmed OR p_confirmed,
    reserved_seconds=CASE WHEN (usage_confirmed OR p_confirmed) AND status='closed' THEN 0 ELSE reserved_seconds END
    WHERE id=p_session_id AND response_mode='voice' RETURNING * INTO s;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Unknown voice session'; END IF;
  INSERT INTO public.voice_provider_usage(session_id,business_id,provider,request_id,model,status,seconds,estimated_cost_usd)
    VALUES(s.id,s.business_id,'openai','session','gpt-live-1',CASE WHEN s.usage_confirmed THEN 'confirmed' ELSE 'unconfirmed' END,s.used_seconds,s.used_seconds*0.05/60)
    ON CONFLICT(session_id,provider,request_id) DO UPDATE SET status=EXCLUDED.status,seconds=EXCLUDED.seconds,estimated_cost_usd=EXCLUDED.estimated_cost_usd;
END $$;

CREATE FUNCTION public.finalize_voice_session(p_session_id uuid, p_outcome text, p_error text, p_fallback boolean, p_no_provider_started boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.voice_sessions;
BEGIN
  PERFORM 1 FROM public.voice_pilot_settings WHERE business_id=(SELECT business_id FROM public.voice_sessions WHERE id=p_session_id) FOR UPDATE;
  SELECT * INTO s FROM public.voice_sessions WHERE id=p_session_id FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Unknown voice session'; END IF;
  -- Only the pre-stream phases can prove that no billable session started.
  IF p_no_provider_started AND s.status IN ('ringing','notice') AND s.openai_session_id IS NULL THEN
    UPDATE public.voice_sessions SET usage_confirmed=true WHERE id=s.id;
  END IF;
  UPDATE public.voice_sessions SET status='closed',ended_at=COALESCE(ended_at,now()),
    outcome=CASE WHEN s.status='closed' THEN outcome ELSE p_outcome END,
    error_code=COALESCE(error_code,p_error),
    fallback_pending=fallback_pending OR (p_fallback AND fallback_completed_at IS NULL),
    reserved_seconds=CASE WHEN usage_confirmed OR response_mode='text' THEN 0 ELSE reserved_seconds END
    WHERE id=s.id;
  UPDATE public.conversations SET status='closed',is_ai_handling=false WHERE id=s.conversation_id;
END $$;

-- Worker startup must recheck operational state after the notice and token
-- consumption, not merely rely on the admission snapshot.
CREATE FUNCTION public.activate_voice_session(p_session_id uuid,p_openai_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE changed uuid;
BEGIN
  UPDATE public.voice_sessions s SET status='active',openai_session_id=p_openai_id,started_at=now(),heartbeat_at=now()
    WHERE s.id=p_session_id AND s.status='starting' AND s.notice_completed_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.voice_pilot_settings p JOIN public.businesses b ON b.id=p.business_id
      WHERE p.business_id=s.business_id AND p.enabled AND b.deleted_at IS NULL AND b.operations_suspended_at IS NULL AND b.ai_replies_paused_at IS NULL)
    AND EXISTS (SELECT 1 FROM public.subscriptions WHERE business_id=s.business_id AND status IN ('active','trialing'))
    RETURNING s.id INTO changed;
  RETURN changed IS NOT NULL;
END $$;

REVOKE ALL ON FUNCTION public.record_voice_fragment(uuid,text,text,text,numeric,numeric),public.update_voice_usage(uuid,numeric,boolean),public.finalize_voice_session(uuid,text,text,boolean,boolean),public.activate_voice_session(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_voice_fragment(uuid,text,text,text,numeric,numeric),public.update_voice_usage(uuid,numeric,boolean),public.finalize_voice_session(uuid,text,text,boolean,boolean),public.activate_voice_session(uuid,text) TO service_role;
COMMIT;
