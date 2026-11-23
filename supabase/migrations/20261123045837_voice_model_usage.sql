BEGIN;

-- Preserve the existing pilot/commercial accounting, including reconciliation
-- by older workers. Both Live models have the same per-second charge.
CREATE FUNCTION public.update_voice_model_usage(
  p_session_id uuid, p_seconds numeric, p_confirmed boolean, p_model text
) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF p_model IS NULL OR p_model NOT IN ('gpt-live-1', 'gpt-live-1.1') THEN
    RAISE EXCEPTION 'Unsupported voice usage model' USING ERRCODE = '22023';
  END IF;

  PERFORM public.update_voice_usage(p_session_id, p_seconds, p_confirmed);
  UPDATE public.voice_provider_usage SET model = p_model
    WHERE session_id = p_session_id AND provider = 'openai'
      AND request_id = 'session' AND model IS DISTINCT FROM p_model;
END
$$;

REVOKE ALL ON FUNCTION public.update_voice_model_usage(uuid,numeric,boolean,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_voice_model_usage(uuid,numeric,boolean,text) TO service_role;

COMMIT;
