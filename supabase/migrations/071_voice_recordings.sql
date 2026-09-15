BEGIN;
-- Retain provider cleanup identities even if account/conversation rows are
-- removed. This private table contains no recording URLs or credentials.
CREATE TABLE public.voice_recordings (
  recording_id text PRIMARY KEY,
  session_id uuid REFERENCES public.voice_sessions(id) ON DELETE SET NULL,
  business_id uuid REFERENCES public.businesses(id) ON DELETE SET NULL,
  delete_after timestamptz NOT NULL,
  deleted_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.voice_recordings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_recordings FROM anon,authenticated;
GRANT ALL ON public.voice_recordings TO service_role;
CREATE INDEX voice_recordings_cleanup ON public.voice_recordings(delete_after,next_attempt_at) WHERE deleted_at IS NULL;

-- Preserve the first terminal response decision: a late command failure may
-- not turn a normally completed voice interaction into an unsolicited SMS.
CREATE OR REPLACE FUNCTION public.finalize_voice_session(p_session_id uuid, p_outcome text, p_error text, p_fallback boolean, p_no_provider_started boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.voice_sessions;
BEGIN
  PERFORM 1 FROM public.voice_pilot_settings WHERE business_id=(SELECT business_id FROM public.voice_sessions WHERE id=p_session_id) FOR UPDATE;
  SELECT * INTO s FROM public.voice_sessions WHERE id=p_session_id FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Unknown voice session'; END IF;
  IF p_no_provider_started AND s.status IN ('ringing','notice') AND s.openai_session_id IS NULL THEN
    UPDATE public.voice_sessions SET usage_confirmed=true WHERE id=s.id;
  END IF;
  UPDATE public.voice_sessions SET status='closed',ended_at=COALESCE(ended_at,now()),
    outcome=CASE WHEN s.status='closed' THEN outcome ELSE p_outcome END,
    error_code=CASE WHEN s.status='closed' THEN error_code ELSE COALESCE(error_code,p_error) END,
    fallback_pending=CASE WHEN s.status='closed' THEN fallback_pending ELSE fallback_pending OR (p_fallback AND fallback_completed_at IS NULL) END,
    reserved_seconds=CASE WHEN usage_confirmed OR response_mode='text' THEN 0 ELSE reserved_seconds END
    WHERE id=s.id;
  UPDATE public.conversations SET status='closed',is_ai_handling=false WHERE id=s.conversation_id;
END $$;
COMMIT;
