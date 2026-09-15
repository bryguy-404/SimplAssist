-- Internal Q&A pilot only. Commercial voice entitlements are a later rollout.
BEGIN;

ALTER TABLE public.contacts DROP CONSTRAINT contacts_source_channel_check;
ALTER TABLE public.contacts ADD CONSTRAINT contacts_source_channel_check CHECK (source_channel IN ('sms','web_chat','voice'));
ALTER TABLE public.conversations DROP CONSTRAINT conversations_channel_check;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_channel_check CHECK (channel IN ('sms','web_chat','voice'));
ALTER TABLE public.messages DROP CONSTRAINT messages_channel_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_channel_check CHECK (channel IN ('sms','web_chat','voice'));
DROP INDEX public.conversations_one_open_thread_unique;
CREATE UNIQUE INDEX conversations_one_open_thread_unique ON public.conversations (business_id, contact_id, channel)
  WHERE status <> 'closed' AND channel <> 'voice';
ALTER TABLE public.conversations ADD CONSTRAINT conversations_id_business_unique UNIQUE (id, business_id);

CREATE TABLE public.voice_pilot_settings (
  business_id uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE
    CHECK (business_id = 'ea848911-ef72-44a6-8cf3-c47b3959be26'),
  enabled boolean NOT NULL DEFAULT false,
  budget_seconds integer NOT NULL DEFAULT 12000 CHECK (budget_seconds BETWEEN 0 AND 360000),
  max_concurrent_calls integer NOT NULL DEFAULT 2 CHECK (max_concurrent_calls BETWEEN 1 AND 2),
  max_call_seconds integer NOT NULL DEFAULT 600 CHECK (max_call_seconds BETWEEN 60 AND 600),
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
-- Fresh/local databases may not contain the designated business.
INSERT INTO public.voice_pilot_settings (business_id)
  SELECT id FROM public.businesses WHERE id = 'ea848911-ef72-44a6-8cf3-c47b3959be26';

CREATE TABLE public.voice_pilot_testers (
  business_id uuid NOT NULL REFERENCES public.voice_pilot_settings(business_id) ON DELETE CASCADE,
  phone_number text NOT NULL CHECK (phone_number ~ '^\+[1-9][0-9]{7,14}$'),
  label text NOT NULL DEFAULT '' CHECK (length(label) <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, phone_number)
);

CREATE TABLE public.voice_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  conversation_id uuid,
  call_control_id text NOT NULL UNIQUE,
  call_session_id text NOT NULL,
  caller_phone text NOT NULL,
  called_phone text NOT NULL,
  response_mode text NOT NULL CHECK (response_mode IN ('text','voice')),
  status text NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing','notice','starting','active','closing','closed')),
  outcome text,
  reserved_seconds integer NOT NULL DEFAULT 0 CHECK (reserved_seconds >= 0),
  used_seconds numeric NOT NULL DEFAULT 0 CHECK (used_seconds >= 0),
  usage_confirmed boolean NOT NULL DEFAULT false,
  openai_session_id text,
  notice_completed_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  fallback_pending boolean NOT NULL DEFAULT false,
  fallback_completed_at timestamptz,
  error_code text,
  first_audio_at timestamptz,
  playback_acknowledged_at timestamptz,
  feedback text CHECK (length(feedback) <= 4000),
  UNIQUE (id, business_id),
  FOREIGN KEY (conversation_id, business_id) REFERENCES public.conversations(id, business_id) ON DELETE SET NULL (conversation_id)
);
CREATE INDEX voice_sessions_business_created ON public.voice_sessions(business_id, created_at DESC);
CREATE INDEX voice_sessions_unfinished ON public.voice_sessions(heartbeat_at) WHERE status <> 'closed';

CREATE TABLE public.voice_stream_credentials (
  session_id uuid PRIMARY KEY REFERENCES public.voice_sessions(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE TABLE public.voice_transcript_fragments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  business_id uuid NOT NULL,
  event_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('customer','assistant')),
  content text NOT NULL CHECK (length(content) <= 16000),
  start_ms numeric NOT NULL CHECK (start_ms >= 0),
  end_ms numeric NOT NULL CHECK (end_ms >= start_ms),
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, event_id),
  FOREIGN KEY (session_id, business_id) REFERENCES public.voice_sessions(id, business_id) ON DELETE CASCADE
);
CREATE TABLE public.voice_provider_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  business_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('openai','anthropic','telnyx')),
  request_id text NOT NULL,
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','confirmed','unconfirmed','failed','superseded')),
  seconds numeric NOT NULL DEFAULT 0 CHECK (seconds >= 0),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  estimated_cost_usd numeric,
  latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, provider, request_id),
  FOREIGN KEY (session_id, business_id) REFERENCES public.voice_sessions(id, business_id) ON DELETE CASCADE
);

-- Metadata is readable under the same business visibility as existing history.
-- Operational controls, stream secrets and all writes are service-owned.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['voice_pilot_settings','voice_pilot_testers','voice_sessions','voice_stream_credentials','voice_transcript_fragments','voice_provider_usage'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['voice_sessions','voice_transcript_fragments','voice_provider_usage'] LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (business_id IN (SELECT id FROM public.businesses))', t || '_read', t);
  END LOOP;
END $$;

-- Existing permissive history policies must not allow customer-side voice
-- transcript injection or human takeover. Service role is the only writer.
CREATE FUNCTION public.protect_voice_history() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF current_user <> 'service_role' AND current_user <> 'postgres' THEN
    IF (TG_OP <> 'INSERT' AND OLD.channel = 'voice') OR (TG_OP <> 'DELETE' AND NEW.channel = 'voice') THEN
      RAISE EXCEPTION 'Voice history is read-only' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' AND TG_TABLE_NAME = 'messages' AND NEW.channel = 'voice' THEN
    IF NOT EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = NEW.conversation_id AND c.business_id = NEW.business_id AND c.channel = 'voice') THEN
      RAISE EXCEPTION 'Voice message scope mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_voice_conversations BEFORE INSERT OR UPDATE OR DELETE ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.protect_voice_history();
CREATE TRIGGER protect_voice_messages BEFORE INSERT OR UPDATE OR DELETE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.protect_voice_history();

-- One settings-row lock serializes all admissions and budget changes. The
-- original decision survives retries, tester edits, and operational changes.
CREATE FUNCTION public.admit_voice_pilot(p_business_id uuid, p_call_control_id text, p_call_session_id text, p_caller text, p_called text, p_worker_ready boolean)
RETURNS public.voice_sessions LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE cfg public.voice_pilot_settings; result public.voice_sessions; reserved integer := 0;
  used numeric; concurrent integer; contact uuid; conversation uuid; reason text := 'not_eligible';
BEGIN
  SELECT * INTO cfg FROM public.voice_pilot_settings WHERE business_id = p_business_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO result FROM public.voice_sessions WHERE call_control_id = p_call_control_id;
  IF FOUND THEN
    IF result.business_id <> p_business_id OR result.caller_phone <> p_caller OR result.called_phone <> p_called OR result.call_session_id <> p_call_session_id THEN
      RAISE EXCEPTION 'Call identity mismatch';
    END IF;
    RETURN result;
  END IF;
  IF p_called <> '+15742638634' OR NOT EXISTS (SELECT 1 FROM public.phone_numbers WHERE business_id = p_business_id AND phone_number = p_called AND is_active) THEN RETURN NULL; END IF;
  IF cfg.enabled AND EXISTS (SELECT 1 FROM public.voice_pilot_testers WHERE business_id = p_business_id AND phone_number = p_caller) THEN
    reason := 'operationally_unavailable';
    IF EXISTS (SELECT 1 FROM public.businesses WHERE id = p_business_id AND deleted_at IS NULL AND operations_suspended_at IS NULL AND ai_replies_paused_at IS NULL)
      AND EXISTS (SELECT 1 FROM public.subscriptions WHERE business_id = p_business_id AND status IN ('active','trialing')) THEN
      reason := 'worker_unavailable';
      IF p_worker_ready THEN
        SELECT COALESCE(sum(GREATEST(used_seconds, reserved_seconds)),0), count(*) FILTER (WHERE status <> 'closed' AND response_mode = 'voice')
          INTO used, concurrent FROM public.voice_sessions WHERE business_id = p_business_id;
        reason := 'capacity_unavailable';
        IF concurrent < cfg.max_concurrent_calls THEN
          reason := 'minutes_unavailable';
          IF cfg.budget_seconds - used >= 60 THEN
            reserved := LEAST(cfg.max_call_seconds, floor(cfg.budget_seconds - used)::integer);
            reason := NULL;
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;
  IF reserved > 0 THEN
    INSERT INTO public.contacts (business_id, phone_number, source_channel) VALUES (p_business_id, p_caller, 'voice')
      ON CONFLICT (business_id, phone_number) WHERE phone_number IS NOT NULL DO UPDATE SET last_contacted_at = now() RETURNING id INTO contact;
    INSERT INTO public.conversations (business_id, contact_id, channel, is_ai_handling) VALUES (p_business_id, contact, 'voice', false) RETURNING id INTO conversation;
  END IF;
  INSERT INTO public.voice_sessions (business_id, conversation_id, call_control_id, call_session_id, caller_phone, called_phone, response_mode, reserved_seconds, outcome)
    VALUES (p_business_id, conversation, p_call_control_id, p_call_session_id, p_caller, p_called, CASE WHEN reserved > 0 THEN 'voice' ELSE 'text' END, reserved, reason) RETURNING * INTO result;
  RETURN result;
END $$;

CREATE FUNCTION public.consume_voice_stream(p_token_hash text)
RETURNS public.voice_sessions LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE sid uuid; result public.voice_sessions;
BEGIN
  UPDATE public.voice_stream_credentials c SET consumed_at = now()
    WHERE c.token_hash = p_token_hash AND c.consumed_at IS NULL AND c.expires_at > now()
    AND EXISTS (SELECT 1 FROM public.voice_sessions s JOIN public.voice_pilot_settings p USING (business_id)
      WHERE s.id = c.session_id AND s.response_mode = 'voice' AND s.status = 'starting' AND s.notice_completed_at IS NOT NULL AND p.enabled)
    RETURNING session_id INTO sid;
  IF sid IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO result FROM public.voice_sessions WHERE id = sid;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.admit_voice_pilot(uuid,text,text,text,text,boolean), public.consume_voice_stream(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admit_voice_pilot(uuid,text,text,text,text,boolean), public.consume_voice_stream(text) TO service_role;
COMMIT;
