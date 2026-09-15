BEGIN;
ALTER TABLE public.voice_provider_usage ADD COLUMN provider_request_id text;
ALTER TABLE public.voice_sessions ADD COLUMN recording_checked_at timestamptz;
ALTER TABLE public.voice_sessions ADD COLUMN phone_ended_at timestamptz;
ALTER TABLE public.voice_sessions ADD COLUMN provider_hangup_confirmed_at timestamptz;
CREATE TABLE public.voice_pilot_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  admin_id uuid NOT NULL,
  old_revision integer NOT NULL,
  new_settings jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.voice_pilot_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_pilot_audit FROM anon,authenticated;
GRANT ALL ON public.voice_pilot_audit TO service_role;

CREATE FUNCTION public.configure_voice_pilot(p_revision integer,p_enabled boolean,p_budget_seconds integer,p_testers jsonb,p_admin uuid)
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
  DELETE FROM public.voice_pilot_testers WHERE business_id=cfg.business_id;
  INSERT INTO public.voice_pilot_testers(business_id,phone_number,label)
    SELECT cfg.business_id,t->>'phone',COALESCE(t->>'label','') FROM jsonb_array_elements(p_testers) t;
  INSERT INTO public.voice_pilot_audit(business_id,admin_id,old_revision,new_settings)
    VALUES(cfg.business_id,p_admin,cfg.revision,jsonb_build_object('enabled',p_enabled,'budget_seconds',p_budget_seconds,'testers',p_testers));
  UPDATE public.voice_pilot_settings SET enabled=p_enabled,budget_seconds=p_budget_seconds,revision=revision+1,updated_at=now(),updated_by=p_admin
    WHERE business_id=cfg.business_id RETURNING * INTO cfg;
  RETURN cfg;
END $$;

CREATE FUNCTION public.stop_voice_pilot(p_admin uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE cfg public.voice_pilot_settings;
BEGIN
  IF p_admin IS NULL THEN RAISE EXCEPTION 'Admin required'; END IF;
  UPDATE public.voice_pilot_settings SET enabled=false,revision=revision+1,updated_at=now(),updated_by=p_admin
    WHERE business_id='ea848911-ef72-44a6-8cf3-c47b3959be26' RETURNING * INTO cfg;
  INSERT INTO public.voice_pilot_audit(business_id,admin_id,old_revision,new_settings)
    VALUES(cfg.business_id,p_admin,cfg.revision-1,'{"action":"stop"}'::jsonb);
END $$;

CREATE FUNCTION public.reconcile_voice_usage(p_session_id uuid,p_seconds numeric,p_reference text,p_admin uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.voice_sessions;
BEGIN
  IF p_admin IS NULL OR length(trim(p_reference))<10 OR length(p_reference)>1000 THEN RAISE EXCEPTION 'Provider evidence reference required'; END IF;
  PERFORM 1 FROM public.voice_pilot_settings WHERE business_id=(SELECT business_id FROM public.voice_sessions WHERE id=p_session_id) FOR UPDATE;
  SELECT * INTO s FROM public.voice_sessions WHERE id=p_session_id FOR UPDATE;
  IF s.id IS NULL OR s.status<>'closed' OR s.usage_confirmed OR p_seconds<s.used_seconds THEN RAISE EXCEPTION 'Usage cannot be reconciled with these values'; END IF;
  PERFORM public.update_voice_usage(s.id,p_seconds,true);
  INSERT INTO public.voice_pilot_audit(business_id,admin_id,old_revision,new_settings)
    VALUES(s.business_id,p_admin,0,jsonb_build_object('action','usage_reconciliation','session_id',s.id,'seconds',p_seconds,'evidence_reference',p_reference));
END $$;

CREATE FUNCTION public.claim_voice_recording_cleanup(p_limit integer DEFAULT 10)
RETURNS SETOF public.voice_recordings LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN QUERY WITH due AS (
    SELECT recording_id FROM public.voice_recordings
    WHERE deleted_at IS NULL AND (delete_after<=now() OR business_id IS NULL)
      AND next_attempt_at<=now() AND (lease_expires_at IS NULL OR lease_expires_at<now())
    ORDER BY delete_after LIMIT LEAST(GREATEST(p_limit,1),50) FOR UPDATE SKIP LOCKED
  ) UPDATE public.voice_recordings r SET lease_token=gen_random_uuid(),lease_expires_at=now()+interval '2 minutes',attempts=attempts+1
    FROM due WHERE r.recording_id=due.recording_id RETURNING r.*;
END $$;
CREATE FUNCTION public.finish_voice_recording_cleanup(p_recording_id text,p_lease uuid,p_success boolean,p_error text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.voice_recordings SET deleted_at=CASE WHEN p_success THEN now() ELSE NULL END,
    last_error_code=CASE WHEN p_success THEN NULL ELSE left(p_error,100) END,
    next_attempt_at=now()+make_interval(secs=>LEAST(3600,power(2,LEAST(attempts,10))::integer*30)),
    lease_token=NULL,lease_expires_at=NULL
    WHERE recording_id=p_recording_id AND lease_token=p_lease;
END $$;

-- A session for which no stream credential was ever consumed could not have
-- reached the voice worker. After closure and credential expiry, its unused
-- reservation can be released with positive evidence, not a guessed zero.
CREATE FUNCTION public.reconcile_unstarted_voice_sessions()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s record; changed integer:=0;
BEGIN
  FOR s IN SELECT v.id FROM public.voice_sessions v LEFT JOIN public.voice_stream_credentials c ON c.session_id=v.id
    WHERE v.status='closed' AND v.response_mode='voice' AND NOT v.usage_confirmed AND v.openai_session_id IS NULL
      AND c.consumed_at IS NULL AND COALESCE(c.expires_at,v.created_at+interval '2 minutes')<now() LOOP
    PERFORM public.update_voice_usage(s.id,0,true); changed:=changed+1;
  END LOOP;
  RETURN changed;
END $$;

CREATE FUNCTION public.scrub_voice_business_data() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    UPDATE public.voice_pilot_settings SET enabled=false,revision=revision+1 WHERE business_id=NEW.id AND enabled;
  END IF;
  IF OLD.owner_id IS NOT NULL AND NEW.owner_id IS NULL THEN
    UPDATE public.voice_recordings SET delete_after=now(),next_attempt_at=now() WHERE business_id=NEW.id AND deleted_at IS NULL;
    UPDATE public.voice_transcript_fragments SET content='[deleted]' WHERE business_id=NEW.id;
    UPDATE public.voice_sessions SET caller_phone='',called_phone='',feedback=NULL,fallback_pending=false WHERE business_id=NEW.id;
    DELETE FROM public.voice_pilot_testers WHERE business_id=NEW.id;
    DELETE FROM public.voice_pilot_audit WHERE business_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scrub_voice_on_business_cleanup AFTER UPDATE OF owner_id,deleted_at ON public.businesses FOR EACH ROW EXECUTE FUNCTION public.scrub_voice_business_data();

CREATE VIEW public.voice_pilot_totals AS
  SELECT p.business_id,COALESCE(sum(s.used_seconds),0) AS used_seconds,
    COALESCE(sum(GREATEST(s.used_seconds,s.reserved_seconds)),0) AS committed_seconds,
    count(s.id) FILTER (WHERE s.response_mode='voice' AND s.status<>'closed') AS active_calls,
    count(s.id) FILTER (WHERE s.response_mode='voice' AND s.status='closed' AND NOT s.usage_confirmed) AS unconfirmed_calls
  FROM public.voice_pilot_settings p LEFT JOIN public.voice_sessions s ON s.business_id=p.business_id GROUP BY p.business_id;
REVOKE ALL ON public.voice_pilot_totals FROM anon,authenticated;
GRANT SELECT ON public.voice_pilot_totals TO service_role;

CREATE FUNCTION public.protect_late_voice_data() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.businesses WHERE id=NEW.business_id AND owner_id IS NULL) THEN
    IF TG_TABLE_NAME='voice_recordings' THEN NEW.delete_after=now();
    ELSE NEW.content='[deleted]'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_late_voice_fragments BEFORE INSERT OR UPDATE ON public.voice_transcript_fragments FOR EACH ROW EXECUTE FUNCTION public.protect_late_voice_data();
CREATE TRIGGER protect_late_voice_recordings BEFORE INSERT OR UPDATE ON public.voice_recordings FOR EACH ROW EXECUTE FUNCTION public.protect_late_voice_data();

CREATE OR REPLACE FUNCTION public.record_voice_fragment(p_session_id uuid, p_event_id text, p_role text, p_content text, p_start_ms numeric, p_end_ms numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.voice_sessions; inserted uuid;
BEGIN
  SELECT * INTO s FROM public.voice_sessions WHERE id = p_session_id FOR UPDATE;
  IF s.id IS NULL OR s.response_mode <> 'voice' THEN RAISE EXCEPTION 'Unknown voice session'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.businesses WHERE id=s.business_id AND owner_id IS NOT NULL) THEN RETURN; END IF;
  INSERT INTO public.voice_transcript_fragments(session_id,business_id,event_id,role,content,start_ms,end_ms)
    VALUES(s.id,s.business_id,p_event_id,p_role,p_content,p_start_ms,p_end_ms)
    ON CONFLICT(session_id,event_id) DO NOTHING RETURNING id INTO inserted;
  IF inserted IS NOT NULL AND s.conversation_id IS NOT NULL THEN
    INSERT INTO public.messages(conversation_id,business_id,channel,role,content)
      VALUES(s.conversation_id,s.business_id,'voice',p_role,p_content);
    UPDATE public.conversations SET last_message_at=now() WHERE id=s.conversation_id;
  END IF;
END $$;

CREATE FUNCTION public.estimate_voice_telnyx_usage(p_notice_characters integer)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_notice_characters NOT BETWEEN 0 AND 1000 THEN RAISE EXCEPTION 'Invalid notice length'; END IF;
  INSERT INTO public.voice_provider_usage(session_id,business_id,provider,request_id,model,status,seconds,estimated_cost_usd)
    SELECT id,business_id,'telnyx','call','voice-api-us-estimate-2026-09-14','unconfirmed',
      GREATEST(0,extract(epoch FROM phone_ended_at-created_at)),
      GREATEST(0,extract(epoch FROM phone_ended_at-created_at))*0.0052/60
      + CASE WHEN notice_completed_at IS NOT NULL THEN GREATEST(0,extract(epoch FROM phone_ended_at-notice_completed_at))*0.0055/60 + p_notice_characters*0.000024 ELSE 0 END
    FROM public.voice_sessions WHERE response_mode='voice' AND phone_ended_at IS NOT NULL
    ON CONFLICT(session_id,provider,request_id) DO UPDATE SET seconds=EXCLUDED.seconds,estimated_cost_usd=EXCLUDED.estimated_cost_usd
      WHERE voice_provider_usage.seconds IS DISTINCT FROM EXCLUDED.seconds OR voice_provider_usage.estimated_cost_usd IS DISTINCT FROM EXCLUDED.estimated_cost_usd;
END $$;

REVOKE ALL ON FUNCTION public.configure_voice_pilot(integer,boolean,integer,jsonb,uuid),public.claim_voice_recording_cleanup(integer),public.finish_voice_recording_cleanup(text,uuid,boolean,text),public.reconcile_unstarted_voice_sessions() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.configure_voice_pilot(integer,boolean,integer,jsonb,uuid),public.claim_voice_recording_cleanup(integer),public.finish_voice_recording_cleanup(text,uuid,boolean,text),public.reconcile_unstarted_voice_sessions() TO service_role;
REVOKE ALL ON FUNCTION public.stop_voice_pilot(uuid),public.reconcile_voice_usage(uuid,numeric,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.stop_voice_pilot(uuid),public.reconcile_voice_usage(uuid,numeric,text,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.estimate_voice_telnyx_usage(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.estimate_voice_telnyx_usage(integer) TO service_role;
COMMIT;
