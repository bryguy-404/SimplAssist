BEGIN;
-- A claim is never automatically released: a worker can die after the provider
-- accepted a message. Retrying that ambiguous send could text the caller twice.
ALTER TABLE public.voice_sessions
  ADD COLUMN fallback_claimed_at timestamptz,
  ADD COLUMN fallback_error_code text;
COMMENT ON COLUMN public.voice_sessions.fallback_claimed_at IS
  'Single atomic send claim; claimed without completion requires provider reconciliation, never automatic resend.';
COMMIT;
