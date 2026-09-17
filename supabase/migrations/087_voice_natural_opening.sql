BEGIN;
-- Protected rollout policy: deploying this migration alone preserves the current
-- announcement. Each new public call snapshots the policy; existing calls never
-- switch protocols in flight. Version 2 still identifies the AI in its greeting.
ALTER TABLE public.voice_rollout_control ADD COLUMN recording_announcement_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE public.voice_sessions DROP CONSTRAINT voice_sessions_disclosure_version_check;
ALTER TABLE public.voice_sessions ADD CONSTRAINT voice_sessions_disclosure_version_check CHECK(disclosure_version IN (0,1,2));
ALTER TABLE public.voice_sessions ADD CONSTRAINT voice_natural_opening_evidence CHECK (
  disclosure_version<>2 OR ((access_source='commercial' OR public_notice_rehearsal)
    AND prior_disclosure_acknowledged_at IS NULL
    AND disclosure_started_at IS NULL AND notice_completed_at IS NULL AND disclosure_event_id IS NULL
    AND conversation_handoff_event_id IS NULL AND conversation_handoff_started_at IS NULL));

CREATE FUNCTION public.select_voice_opening_policy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF (NEW.access_source='commercial' OR NEW.public_notice_rehearsal)
    AND NOT (SELECT recording_announcement_enabled FROM public.voice_rollout_control WHERE singleton) THEN
    NEW.disclosure_version:=2;
  END IF;
  RETURN NEW;
END $$;
-- Alphabetical ordering is intentional: first consume any one-call rehearsal,
-- then freeze the public opening policy for that admitted call.
CREATE TRIGGER zz_select_voice_opening_policy BEFORE INSERT ON public.voice_sessions
  FOR EACH ROW EXECUTE FUNCTION public.select_voice_opening_policy();

CREATE FUNCTION public.guard_voice_opening_policy() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF ROW(NEW.disclosure_version,NEW.public_notice_rehearsal) IS DISTINCT FROM ROW(OLD.disclosure_version,OLD.public_notice_rehearsal) THEN
    RAISE EXCEPTION 'voice opening policy is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.disclosure_version=2 AND (
    (OLD.recording_started_at IS NOT NULL AND NEW.recording_started_at IS DISTINCT FROM OLD.recording_started_at)
    OR (OLD.started_at IS NOT NULL AND ROW(NEW.started_at,NEW.conversation_input_start_ms) IS DISTINCT FROM ROW(OLD.started_at,OLD.conversation_input_start_ms))) THEN
    RAISE EXCEPTION 'voice natural opening evidence is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_voice_opening_policy BEFORE UPDATE ON public.voice_sessions
  FOR EACH ROW EXECUTE FUNCTION public.guard_voice_opening_policy();

-- Extend only the authenticated startup transport. The existing v1 notice and
-- handoff RPCs still reject v2; no skipped announcement is marked as completed.
DO $$ DECLARE d text; needle text; BEGIN
  d:=pg_get_functiondef('public.voice_disclosure_continuation_allowed(uuid)'::regprocedure);
  needle:='s.disclosure_version=1';
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'voice disclosure continuation drift'; END IF;
  EXECUTE replace(d,needle,'s.disclosure_version IN (1,2)');
  d:=pg_get_functiondef('public.consume_voice_stream(text)'::regprocedure);
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'voice stream definition drift'; END IF;
  EXECUTE replace(d,needle,'s.disclosure_version IN (1,2)');
END $$;

CREATE OR REPLACE FUNCTION public.begin_voice_disclosure(p_session_id uuid,p_openai_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE changed uuid;
BEGIN
  IF NULLIF(p_openai_id,'') IS NULL OR length(p_openai_id)>200 THEN RETURN false; END IF;
  UPDATE public.voice_sessions s SET openai_session_id=p_openai_id,
    disclosure_started_at=CASE WHEN s.disclosure_version=1 THEN COALESCE(s.disclosure_started_at,clock_timestamp()) ELSE NULL END,
    heartbeat_at=clock_timestamp()
    WHERE s.id=p_session_id AND (s.access_source='commercial' OR s.public_notice_rehearsal) AND s.disclosure_version IN (1,2) AND s.status='notice'
      AND (s.openai_session_id IS NULL OR s.openai_session_id=p_openai_id) AND s.notice_completed_at IS NULL
      AND EXISTS(SELECT 1 FROM public.voice_stream_credentials c WHERE c.session_id=s.id AND c.consumed_at IS NOT NULL)
      AND public.voice_disclosure_continuation_allowed(s.id) RETURNING s.id INTO changed;
  RETURN changed IS NOT NULL;
END $$;

CREATE OR REPLACE FUNCTION public.mark_voice_recording_started(p_session_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE changed uuid;
BEGIN
  UPDATE public.voice_sessions s SET recording_started_at=COALESCE(s.recording_started_at,clock_timestamp())
    WHERE s.id=p_session_id AND (s.access_source='commercial' OR s.public_notice_rehearsal) AND s.status='notice'
      AND ((s.disclosure_version=1 AND s.notice_completed_at IS NOT NULL AND s.disclosure_event_id IS NOT NULL)
        OR (s.disclosure_version=2 AND s.openai_session_id IS NOT NULL
          AND EXISTS(SELECT 1 FROM public.voice_stream_credentials c WHERE c.session_id=s.id AND c.consumed_at IS NOT NULL)))
      AND public.voice_disclosure_continuation_allowed(s.id) RETURNING s.id INTO changed;
  RETURN changed IS NOT NULL;
END $$;

-- Called after the recording command succeeds and the provider acknowledges
-- normal conversation instructions. This opens transcript/action processing,
-- not the customer minute meter; that still requires first audible playback.
CREATE FUNCTION public.activate_voice_natural_opening(p_session_id uuid,p_openai_id text,p_input_start_ms numeric) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.voice_sessions;
BEGIN
  IF NULLIF(p_openai_id,'') IS NULL OR length(p_openai_id)>200 OR p_input_start_ms IS NULL OR p_input_start_ms NOT BETWEEN 0 AND 120000 THEN RETURN false; END IF;
  PERFORM 1 FROM public.businesses WHERE id=(SELECT business_id FROM public.voice_sessions WHERE id=p_session_id) FOR UPDATE;
  PERFORM 1 FROM public.voice_allowance_periods WHERE id=(SELECT period_id FROM public.voice_customer_usage WHERE call_key=p_session_id) FOR UPDATE;
  PERFORM 1 FROM public.voice_customer_usage WHERE call_key=p_session_id FOR UPDATE;
  SELECT * INTO s FROM public.voice_sessions WHERE id=p_session_id FOR UPDATE;
  IF s.id IS NULL OR (s.access_source<>'commercial' AND NOT s.public_notice_rehearsal) OR s.disclosure_version<>2
    OR s.status NOT IN ('notice','active') OR s.openai_session_id IS DISTINCT FROM p_openai_id OR s.recording_started_at IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.voice_stream_credentials c WHERE c.session_id=s.id AND c.consumed_at IS NOT NULL)
    OR NOT public.voice_disclosure_continuation_allowed(s.id) THEN RETURN false; END IF;
  IF s.status='active' THEN RETURN s.started_at IS NOT NULL AND s.conversation_input_start_ms=p_input_start_ms; END IF;
  UPDATE public.voice_sessions SET status='active',started_at=clock_timestamp(),conversation_input_start_ms=p_input_start_ms,heartbeat_at=clock_timestamp() WHERE id=s.id;
  RETURN true;
END $$;

DO $$ DECLARE d text; needle text; BEGIN
  d:=pg_get_functiondef('public.record_voice_fragment(uuid,text,text,text,numeric,numeric)'::regprocedure);
  needle:='s.disclosure_version=1';
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'voice transcript activation guard drift'; END IF;
  EXECUTE replace(d,needle,'s.disclosure_version IN (1,2)');

  d:=pg_get_functiondef('public.record_voice_customer_start(uuid,text,timestamptz)'::regprocedure);
  needle:='IF u.settled_at IS NOT NULL THEN RETURN jsonb_build_object(''state'',u.state); END IF;';
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'voice customer start definition drift'; END IF;
  EXECUTE replace(d,needle,needle||E'\n  IF EXISTS(SELECT 1 FROM public.voice_sessions s WHERE s.id=p_session_id AND s.access_source=''commercial'' AND s.disclosure_version=2 AND (s.started_at IS NULL OR s.recording_started_at IS NULL OR p_started_at<s.started_at-interval ''1 second'' OR p_started_at<s.recording_started_at-interval ''1 second'')) THEN RAISE EXCEPTION ''voice natural opening activation required''; END IF;');
  d:=pg_get_functiondef('public.acknowledge_voice_customer_start(uuid,text)'::regprocedure);
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'voice customer start ack definition drift'; END IF;
  EXECUTE replace(d,needle,needle||E'\n  IF EXISTS(SELECT 1 FROM public.voice_sessions s WHERE s.id=p_session_id AND s.access_source=''commercial'' AND s.disclosure_version=2 AND (s.started_at IS NULL OR s.recording_started_at IS NULL)) THEN RAISE EXCEPTION ''voice natural opening activation required''; END IF;');

  d:=pg_get_functiondef('public.settle_voice_customer_usage(uuid,boolean)'::regprocedure);
  needle:='s.disclosure_version=1 AND s.started_at IS NULL';
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'voice startup zero-use settlement drift'; END IF;
  d:=replace(d,needle,'s.disclosure_version IN (1,2) AND s.started_at IS NULL');
  needle:='THEN ''disclosure_only_no_customer_usage''';
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'voice zero-use settlement reason drift'; END IF;
  EXECUTE replace(d,needle,'THEN CASE WHEN EXISTS(SELECT 1 FROM public.voice_sessions s WHERE s.id=u.session_id AND s.disclosure_version=2) THEN ''startup_only_no_customer_usage'' ELSE ''disclosure_only_no_customer_usage'' END');

  d:=pg_get_functiondef('public.estimate_voice_telnyx_usage(integer)'::regprocedure);
  needle:='disclosure_version=1 AND (access_source=''commercial'' OR public_notice_rehearsal)';
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'voice provider estimate definition drift'; END IF;
  EXECUTE replace(d,needle,'disclosure_version IN (1,2) AND (access_source=''commercial'' OR public_notice_rehearsal)');
END $$;

REVOKE ALL ON FUNCTION public.select_voice_opening_policy(),public.guard_voice_opening_policy(),public.activate_voice_natural_opening(uuid,text,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.select_voice_opening_policy(),public.guard_voice_opening_policy(),public.activate_voice_natural_opening(uuid,text,numeric) TO service_role;
COMMIT;
