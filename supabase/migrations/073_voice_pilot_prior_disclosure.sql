-- A private tester who already knows the call uses AI and saves audio/transcripts
-- can hear the natural greeting directly. New testers keep the spoken notice.
-- Acknowledgments are populated separately, only from actual prior disclosure;
-- this migration does not acknowledge anyone or enable any business/caller.
BEGIN;

ALTER TABLE public.voice_pilot_testers ADD COLUMN prior_disclosure_acknowledged_at timestamptz;
COMMENT ON COLUMN public.voice_pilot_testers.prior_disclosure_acknowledged_at IS
  'Prior acknowledgment of this private pilot using AI, recording audio for 30 days, and saving transcripts. Service-managed; never inferred from caller location or tester membership.';
ALTER TABLE public.voice_sessions ADD COLUMN prior_disclosure_acknowledged_at timestamptz;
ALTER TABLE public.voice_sessions ADD COLUMN media_start_requested_at timestamptz;
UPDATE public.voice_sessions SET media_start_requested_at=notice_completed_at WHERE notice_completed_at IS NOT NULL;

CREATE FUNCTION public.prepare_preinformed_voice_session(p_session_id uuid)
RETURNS public.voice_sessions LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.voice_sessions; acknowledged timestamptz;
BEGIN
  SELECT * INTO s FROM public.voice_sessions WHERE id=p_session_id FOR UPDATE;
  IF s.id IS NULL OR s.business_id <> 'ea848911-ef72-44a6-8cf3-c47b3959be26'
    OR s.called_phone <> '+15742638634' OR s.response_mode <> 'voice'
    OR NOT (s.status='ringing' OR (s.status='starting' AND s.prior_disclosure_acknowledged_at IS NOT NULL))
    THEN RETURN NULL; END IF;
  SELECT t.prior_disclosure_acknowledged_at INTO acknowledged
    FROM public.voice_pilot_testers t
    WHERE t.business_id=s.business_id AND t.phone_number=s.caller_phone
      AND t.prior_disclosure_acknowledged_at <= s.created_at FOR SHARE;
  IF acknowledged IS NULL
    OR NOT EXISTS (SELECT 1 FROM public.voice_pilot_settings p JOIN public.businesses b ON b.id=p.business_id
      WHERE p.business_id=s.business_id AND p.enabled AND b.deleted_at IS NULL AND b.operations_suspended_at IS NULL AND b.ai_replies_paused_at IS NULL)
    OR NOT EXISTS (SELECT 1 FROM public.subscriptions WHERE business_id=s.business_id AND status IN ('active','trialing'))
    THEN RETURN NULL; END IF;
  UPDATE public.voice_sessions SET status='starting',
    prior_disclosure_acknowledged_at=COALESCE(prior_disclosure_acknowledged_at,acknowledged),
    media_start_requested_at=COALESCE(media_start_requested_at,now()),heartbeat_at=now()
    WHERE id=s.id RETURNING * INTO s;
  RETURN s;
END $$;

CREATE OR REPLACE FUNCTION public.consume_voice_stream(p_token_hash text)
RETURNS public.voice_sessions LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE sid uuid; result public.voice_sessions;
BEGIN
  UPDATE public.voice_stream_credentials c SET consumed_at = now()
    WHERE c.token_hash = p_token_hash AND c.consumed_at IS NULL AND c.expires_at > now()
    AND EXISTS (SELECT 1 FROM public.voice_sessions s JOIN public.voice_pilot_settings p USING (business_id)
      WHERE s.id=c.session_id AND s.response_mode='voice' AND s.status='starting'
        AND (s.notice_completed_at IS NOT NULL OR s.prior_disclosure_acknowledged_at IS NOT NULL) AND p.enabled)
    RETURNING session_id INTO sid;
  IF sid IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO result FROM public.voice_sessions WHERE id=sid;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.activate_voice_session(p_session_id uuid,p_openai_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE changed uuid;
BEGIN
  UPDATE public.voice_sessions s SET status='active',openai_session_id=p_openai_id,started_at=now(),heartbeat_at=now()
    WHERE s.id=p_session_id AND s.status='starting'
    AND (s.notice_completed_at IS NOT NULL OR s.prior_disclosure_acknowledged_at IS NOT NULL)
    AND EXISTS (SELECT 1 FROM public.voice_pilot_settings p JOIN public.businesses b ON b.id=p.business_id
      WHERE p.business_id=s.business_id AND p.enabled AND b.deleted_at IS NULL AND b.operations_suspended_at IS NULL AND b.ai_replies_paused_at IS NULL)
    AND EXISTS (SELECT 1 FROM public.subscriptions WHERE business_id=s.business_id AND status IN ('active','trialing'))
    RETURNING s.id INTO changed;
  RETURN changed IS NOT NULL;
END $$;

CREATE OR REPLACE FUNCTION public.estimate_voice_telnyx_usage(p_notice_characters integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_notice_characters NOT BETWEEN 0 AND 1000 THEN RAISE EXCEPTION 'Invalid notice length'; END IF;
  INSERT INTO public.voice_provider_usage(session_id,business_id,provider,request_id,model,status,seconds,estimated_cost_usd)
    SELECT id,business_id,'telnyx','call','voice-api-us-estimate-2026-09-14','unconfirmed',
      GREATEST(0,extract(epoch FROM phone_ended_at-created_at)),
      GREATEST(0,extract(epoch FROM phone_ended_at-created_at))*0.0052/60
      + CASE WHEN COALESCE(media_start_requested_at,notice_completed_at) IS NOT NULL
          THEN GREATEST(0,extract(epoch FROM phone_ended_at-COALESCE(media_start_requested_at,notice_completed_at)))*0.0055/60 ELSE 0 END
      + CASE WHEN notice_completed_at IS NOT NULL THEN p_notice_characters*0.000024 ELSE 0 END
    FROM public.voice_sessions WHERE response_mode='voice' AND phone_ended_at IS NOT NULL
    ON CONFLICT(session_id,provider,request_id) DO UPDATE SET seconds=EXCLUDED.seconds,estimated_cost_usd=EXCLUDED.estimated_cost_usd
      WHERE voice_provider_usage.seconds IS DISTINCT FROM EXCLUDED.seconds OR voice_provider_usage.estimated_cost_usd IS DISTINCT FROM EXCLUDED.estimated_cost_usd;
END $$;

-- Preserve prior acknowledgments on ordinary label/budget edits. Removing a
-- tester deletes the acknowledgment; newly added testers always get the notice.
CREATE OR REPLACE FUNCTION public.configure_voice_pilot(p_revision integer,p_enabled boolean,p_budget_seconds integer,p_testers jsonb,p_admin uuid)
RETURNS public.voice_pilot_settings LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE cfg public.voice_pilot_settings; committed numeric;
BEGIN
  IF p_admin IS NULL OR p_budget_seconds IS NULL OR p_budget_seconds NOT BETWEEN 0 AND 360000
    OR p_testers IS NULL OR jsonb_typeof(p_testers) <> 'array' OR jsonb_array_length(p_testers)>50 THEN RAISE EXCEPTION 'Invalid pilot settings'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_testers) t WHERE COALESCE(t->>'phone','') !~ '^\+[1-9][0-9]{7,14}$' OR length(COALESCE(t->>'label',''))>100) THEN RAISE EXCEPTION 'Invalid tester'; END IF;
  SELECT * INTO cfg FROM public.voice_pilot_settings WHERE business_id='ea848911-ef72-44a6-8cf3-c47b3959be26' FOR UPDATE;
  IF cfg.business_id IS NULL THEN RAISE EXCEPTION 'Pilot business not configured'; END IF;
  IF cfg.revision <> p_revision THEN RAISE EXCEPTION 'Pilot settings changed; reload' USING ERRCODE='40001'; END IF;
  SELECT COALESCE(sum(GREATEST(used_seconds,reserved_seconds)),0) INTO committed FROM public.voice_sessions WHERE business_id=cfg.business_id;
  IF p_budget_seconds < committed THEN RAISE EXCEPTION 'Budget is below used and reserved minutes'; END IF;
  IF p_enabled AND jsonb_array_length(p_testers)=0 THEN RAISE EXCEPTION 'At least one approved tester is required'; END IF;
  DELETE FROM public.voice_pilot_testers WHERE business_id=cfg.business_id
    AND phone_number NOT IN (SELECT t->>'phone' FROM jsonb_array_elements(p_testers) t);
  INSERT INTO public.voice_pilot_testers(business_id,phone_number,label)
    SELECT cfg.business_id,t->>'phone',COALESCE(t->>'label','') FROM jsonb_array_elements(p_testers) t
    ON CONFLICT(business_id,phone_number) DO UPDATE SET label=EXCLUDED.label;
  INSERT INTO public.voice_pilot_audit(business_id,admin_id,old_revision,new_settings)
    VALUES(cfg.business_id,p_admin,cfg.revision,jsonb_build_object('enabled',p_enabled,'budget_seconds',p_budget_seconds,'testers',p_testers));
  UPDATE public.voice_pilot_settings SET enabled=p_enabled,budget_seconds=p_budget_seconds,revision=revision+1,updated_at=now(),updated_by=p_admin
    WHERE business_id=cfg.business_id RETURNING * INTO cfg;
  RETURN cfg;
END $$;

REVOKE ALL ON FUNCTION public.configure_voice_pilot(integer,boolean,integer,jsonb,uuid),public.prepare_preinformed_voice_session(uuid),public.consume_voice_stream(text),public.activate_voice_session(uuid,text),public.estimate_voice_telnyx_usage(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.configure_voice_pilot(integer,boolean,integer,jsonb,uuid),public.prepare_preinformed_voice_session(uuid),public.consume_voice_stream(text),public.activate_voice_session(uuid,text),public.estimate_voice_telnyx_usage(integer) TO service_role;
COMMIT;
