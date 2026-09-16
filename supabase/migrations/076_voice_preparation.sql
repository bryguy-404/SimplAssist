BEGIN;
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
