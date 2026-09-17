BEGIN;
-- Keep legacy pilot behavior as a separate branch; never rewrite its clock or
-- turn private prior-disclosure acknowledgment into a customer bypass.
ALTER FUNCTION public.consume_voice_stream(text) RENAME TO consume_voice_pilot_stream_legacy;
ALTER FUNCTION public.activate_voice_session(uuid,text) RENAME TO activate_voice_pilot_session_legacy;
ALTER FUNCTION public.claim_voice_preparation(uuid) RENAME TO claim_voice_pilot_preparation_legacy;
ALTER FUNCTION public.update_voice_usage(uuid,numeric,boolean) RENAME TO update_voice_pilot_usage_legacy;
ALTER FUNCTION public.finalize_voice_session(uuid,text,text,boolean,boolean) RENAME TO finalize_voice_pilot_session_legacy;
ALTER FUNCTION public.voice_action_allowed(uuid,text) RENAME TO voice_pilot_action_allowed_legacy;

CREATE FUNCTION public.consume_voice_stream(p_token_hash text) RETURNS public.voice_sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.voice_sessions; sid uuid;
BEGIN
  SELECT v.* INTO s FROM public.voice_sessions v JOIN public.voice_stream_credentials c ON c.session_id=v.id WHERE c.token_hash=p_token_hash;
  IF s.id IS NULL THEN RETURN NULL; END IF;
  IF s.access_source='pilot' THEN RETURN public.consume_voice_pilot_stream_legacy(p_token_hash); END IF;
  UPDATE public.voice_stream_credentials c SET consumed_at=clock_timestamp() WHERE c.token_hash=p_token_hash AND c.consumed_at IS NULL AND c.expires_at>clock_timestamp()
    AND s.status='starting' AND s.notice_completed_at IS NOT NULL AND public.voice_session_continuation_allowed(s.id) RETURNING c.session_id INTO sid;
  IF sid IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO s FROM public.voice_sessions WHERE id=sid;
  RETURN s;
END $$;

CREATE FUNCTION public.activate_voice_session(p_session_id uuid,p_openai_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE changed uuid;
BEGIN
  IF EXISTS(SELECT 1 FROM public.voice_sessions WHERE id=p_session_id AND access_source='pilot') THEN
    RETURN public.activate_voice_pilot_session_legacy(p_session_id,p_openai_id); END IF;
  IF NULLIF(p_openai_id,'') IS NULL THEN RETURN false; END IF;
  UPDATE public.voice_sessions s SET status='active',openai_session_id=p_openai_id,started_at=clock_timestamp(),heartbeat_at=clock_timestamp()
    WHERE s.id=p_session_id AND s.status='starting' AND s.notice_completed_at IS NOT NULL
      AND public.voice_session_continuation_allowed(s.id) RETURNING s.id INTO changed;
  RETURN changed IS NOT NULL;
END $$;

CREATE FUNCTION public.claim_voice_preparation(p_session_id uuid) RETURNS public.voice_sessions
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.voice_sessions;
BEGIN
  IF EXISTS(SELECT 1 FROM public.voice_sessions WHERE id=p_session_id AND access_source='pilot') THEN
    RETURN public.claim_voice_pilot_preparation_legacy(p_session_id); END IF;
  -- Commercial prewarming has not passed its separate transport acceptance.
  RETURN NULL;
END $$;

CREATE FUNCTION public.update_voice_usage(p_session_id uuid,p_seconds numeric,p_confirmed boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.voice_sessions;
BEGIN
  IF EXISTS(SELECT 1 FROM public.voice_sessions WHERE id=p_session_id AND access_source='pilot') THEN
    PERFORM public.update_voice_pilot_usage_legacy(p_session_id,p_seconds,p_confirmed); RETURN; END IF;
  IF p_seconds IS NULL OR p_seconds<0 OR p_seconds>86400 OR p_confirmed IS NULL THEN RAISE EXCEPTION 'Invalid voice usage'; END IF;
  UPDATE public.voice_sessions SET used_seconds=GREATEST(used_seconds,p_seconds),usage_confirmed=usage_confirmed OR p_confirmed
    WHERE id=p_session_id AND response_mode='voice' AND access_source='commercial' RETURNING * INTO s;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Unknown voice session'; END IF;
  INSERT INTO public.voice_provider_usage(session_id,business_id,provider,request_id,model,status,seconds,estimated_cost_usd)
    VALUES(s.id,s.business_id,'openai','session','gpt-live-1',CASE WHEN s.usage_confirmed THEN 'confirmed' ELSE 'unconfirmed' END,s.used_seconds,s.used_seconds*0.05/60)
    ON CONFLICT(session_id,provider,request_id) DO UPDATE SET status=EXCLUDED.status,seconds=EXCLUDED.seconds,estimated_cost_usd=EXCLUDED.estimated_cost_usd;
END $$;

CREATE FUNCTION public.finalize_voice_session(p_session_id uuid,p_outcome text,p_error text,p_fallback boolean,p_no_provider_started boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.voice_sessions;
BEGIN
  IF EXISTS(SELECT 1 FROM public.voice_sessions WHERE id=p_session_id AND access_source='pilot') THEN
    PERFORM public.finalize_voice_pilot_session_legacy(p_session_id,p_outcome,p_error,p_fallback,p_no_provider_started); RETURN; END IF;
  SELECT * INTO s FROM public.voice_sessions WHERE id=p_session_id FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Unknown voice session'; END IF;
  UPDATE public.voice_sessions SET status='closed',ended_at=COALESCE(ended_at,clock_timestamp()),
    outcome=CASE WHEN s.status='closed' THEN outcome ELSE p_outcome END,
    error_code=CASE WHEN s.status='closed' THEN error_code ELSE COALESCE(error_code,p_error) END,
    fallback_pending=CASE WHEN s.status='closed' THEN fallback_pending ELSE fallback_pending OR
      (COALESCE(p_fallback,false) AND text_fallback_enabled AND fallback_completed_at IS NULL) END
    WHERE id=s.id;
  UPDATE public.conversations SET status='closed',is_ai_handling=false WHERE id IN (s.conversation_id,s.action_conversation_id);
  UPDATE public.voice_actions SET status='superseded',updated_at=clock_timestamp() WHERE session_id=s.id AND status='awaiting_confirmation';
  -- Provider closure and no-provider-start claims cannot release a customer
  -- hold. Verified phone termination is recorded independently by its RPC.
END $$;

CREATE FUNCTION public.voice_action_allowed(p_session_id uuid,p_kind text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.voice_sessions WHERE id=p_session_id AND access_source='pilot') THEN
    RETURN public.voice_pilot_action_allowed_legacy(p_session_id,p_kind); END IF;
  RETURN EXISTS(SELECT 1 FROM public.voice_sessions s JOIN public.businesses b ON b.id=s.business_id
    WHERE s.id=p_session_id AND s.status='active' AND s.action_business_id=s.business_id AND NOT s.demo_mode
      AND public.voice_session_continuation_allowed(s.id)
      AND CASE p_kind WHEN 'contact' THEN true WHEN 'signup' THEN b.texting_paused_at IS NULL AND EXISTS(
        SELECT 1 FROM public.subscriptions sub WHERE sub.business_id=b.id AND sub.status IN ('active','trialing','past_due')
          AND sub.plan IN ('sms_only','sms_and_chat','full')) ELSE false END);
END $$;

-- Source routing remains immutable. Commercial calls can never select a private
-- booking-demo workspace, even if pilot configuration is added in the future.
DO $$ DECLARE d text; needle text:='IF NEW.response_mode <> ''voice'' THEN RETURN NEW; END IF;'; BEGIN
  d:=pg_get_functiondef('public.freeze_voice_action_route()'::regprocedure);
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'voice route definition drift'; END IF;
  d:=replace(d,needle,'IF NEW.response_mode <> ''voice'' OR NEW.access_source=''commercial'' THEN RETURN NEW; END IF;');
  EXECUTE d;
END $$;

-- Serialize all worker admission claims under one shared capacity lock and
-- explicitly exclude commercial rows from the existing lifetime pilot budget.
DO $$ DECLARE d text; needle text; BEGIN
  d:=pg_get_functiondef('public.admit_voice_pilot(uuid,text,text,text,text,boolean)'::regprocedure);
  needle:='INTO used, concurrent FROM public.voice_sessions WHERE business_id = p_business_id;';
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'pilot admission definition drift'; END IF;
  EXECUTE replace(d,needle,'INTO used, concurrent FROM public.voice_sessions WHERE business_id = p_business_id AND access_source=''pilot'';');
  d:=pg_get_functiondef('public.configure_voice_pilot(integer,boolean,integer,jsonb,uuid)'::regprocedure);
  needle:='INTO committed FROM public.voice_sessions WHERE business_id=cfg.business_id;';
  IF position(needle IN d)=0 THEN RAISE EXCEPTION 'pilot budget definition drift'; END IF;
  EXECUTE replace(d,needle,'INTO committed FROM public.voice_sessions WHERE business_id=cfg.business_id AND access_source=''pilot'';');
END $$;
ALTER FUNCTION public.admit_voice_pilot(uuid,text,text,text,text,boolean) RENAME TO admit_voice_pilot_legacy;
CREATE FUNCTION public.admit_voice_pilot(p_business_id uuid,p_call_control_id text,p_call_session_id text,p_caller text,p_called text,p_worker_ready boolean)
RETURNS public.voice_sessions LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE cap integer; ready boolean; prior boolean; result public.voice_sessions;
BEGIN
  SELECT max_concurrent_calls INTO cap FROM public.voice_rollout_control WHERE singleton FOR UPDATE;
  ready:=COALESCE(p_worker_ready,false) AND (SELECT count(*) FROM public.voice_sessions v WHERE v.response_mode='voice' AND (v.status<>'closed'
    OR (v.access_source='commercial' AND EXISTS(SELECT 1 FROM public.voice_customer_usage u WHERE u.session_id=v.id AND u.termination_at IS NULL))))<cap;
  prior:=EXISTS(SELECT 1 FROM public.voice_sessions WHERE call_control_id=p_call_control_id);
  result:=public.admit_voice_pilot_legacy(p_business_id,p_call_control_id,p_call_session_id,p_caller,p_called,ready);
  IF NOT prior AND p_worker_ready AND NOT ready AND result.outcome='worker_unavailable' THEN
    UPDATE public.voice_sessions SET outcome='capacity_unavailable' WHERE id=result.id RETURNING * INTO result;
  END IF;
  RETURN result;
END $$;
CREATE OR REPLACE VIEW public.voice_pilot_totals AS
  SELECT p.business_id,COALESCE(sum(s.used_seconds),0) AS used_seconds,
    COALESCE(sum(GREATEST(s.used_seconds,s.reserved_seconds)),0) AS committed_seconds,
    count(s.id) FILTER (WHERE s.response_mode='voice' AND s.status<>'closed') AS active_calls,
    count(s.id) FILTER (WHERE s.response_mode='voice' AND s.status='closed' AND NOT s.usage_confirmed) AS unconfirmed_calls
  FROM public.voice_pilot_settings p LEFT JOIN public.voice_sessions s ON s.business_id=p.business_id AND s.access_source='pilot' GROUP BY p.business_id;

CREATE FUNCTION public.guard_active_commercial_voice_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF OLD.access_source='commercial' AND EXISTS(SELECT 1 FROM public.voice_customer_usage WHERE session_id=OLD.id AND settled_at IS NULL) THEN
    RAISE EXCEPTION 'settle commercial voice before deleting its history' USING ERRCODE='55000'; END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER guard_active_commercial_voice_delete BEFORE DELETE ON public.voice_sessions FOR EACH ROW EXECUTE FUNCTION public.guard_active_commercial_voice_delete();

CREATE FUNCTION public.stop_commercial_voice_on_cleanup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.owner_id IS NULL THEN
    UPDATE public.voice_commercial_settings SET primary_response='text',revision=revision+1,updated_at=clock_timestamp() WHERE business_id=NEW.id AND primary_response<>'text';
    UPDATE public.voice_rollout_businesses SET enabled=false,emergency_stop=true,updated_at=clock_timestamp() WHERE business_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stop_commercial_voice_on_cleanup AFTER UPDATE OF owner_id,deleted_at ON public.businesses FOR EACH ROW EXECUTE FUNCTION public.stop_commercial_voice_on_cleanup();

DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY(ARRAY[
    'consume_voice_stream','activate_voice_session','claim_voice_preparation','update_voice_usage','finalize_voice_session','voice_action_allowed','admit_voice_pilot',
    'guard_active_commercial_voice_delete','stop_commercial_voice_on_cleanup']) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
  END LOOP;
END $$;
COMMIT;
