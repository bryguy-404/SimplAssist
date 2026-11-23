BEGIN;

ALTER TABLE public.conversations
  ADD COLUMN spam_state text NOT NULL DEFAULT 'inbox' CHECK (spam_state IN ('inbox','suspected','spam')),
  ADD COLUMN spam_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN call_kind text CHECK (call_kind IN ('ai','phone'));
CREATE INDEX conversations_inbox_folder_idx ON public.conversations(business_id,spam_state,last_message_at DESC,id DESC);

CREATE TABLE public.inbound_call_screening (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  phone_number_id uuid REFERENCES public.phone_numbers(id) ON DELETE SET NULL,
  call_control_id text NOT NULL UNIQUE CHECK (length(call_control_id) BETWEEN 1 AND 1000),
  call_session_id text NOT NULL CHECK (length(call_session_id) BETWEEN 1 AND 1000),
  caller_phone text NOT NULL CHECK (length(caller_phone)<=128),
  called_phone text NOT NULL CHECK (length(called_phone)<=128),
  verdict text NOT NULL DEFAULT 'unknown' CHECK (verdict IN ('unknown','not_flagged','spam_likely')),
  evidence jsonb,
  review_decision text CHECK (review_decision IN ('spam','not_spam')),
  revision integer NOT NULL DEFAULT 0,
  followup_suppressed boolean NOT NULL DEFAULT false,
  conversation_id uuid UNIQUE,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  ended_time_verified boolean NOT NULL DEFAULT true,
  status_checked_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id,business_id) REFERENCES public.conversations(id,business_id) ON DELETE SET NULL (conversation_id),
  CHECK (evidence IS NULL OR octet_length(evidence::text)<=4096)
);
CREATE INDEX inbound_call_screening_session_idx ON public.inbound_call_screening(business_id,call_session_id);
CREATE INDEX inbound_call_screening_unfinished_idx ON public.inbound_call_screening(created_at) WHERE ended_at IS NULL AND deleted_at IS NULL;
ALTER TABLE public.inbound_call_screening ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inbound_call_screening FROM anon,authenticated;
GRANT ALL ON public.inbound_call_screening TO service_role;

CREATE FUNCTION public.guard_inbox_screening_projection() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  IF current_user NOT IN ('postgres','service_role') AND
    ((TG_OP='INSERT' AND (NEW.spam_state<>'inbox' OR NEW.spam_revision<>0 OR NEW.call_kind IS NOT NULL)) OR
     (TG_OP='UPDATE' AND ROW(NEW.spam_state,NEW.spam_revision,NEW.call_kind) IS DISTINCT FROM ROW(OLD.spam_state,OLD.spam_revision,OLD.call_kind))) THEN
    RAISE EXCEPTION 'Call review is server controlled' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_inbox_screening_projection BEFORE INSERT OR UPDATE ON public.conversations
FOR EACH ROW EXECUTE FUNCTION public.guard_inbox_screening_projection();

-- All feature mutations serialize on the business before touching call/history
-- rows. Admission and deletion use the same order; no provider I/O holds a lock.
CREATE FUNCTION public.project_inbound_call_screening(p_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE r public.inbound_call_screening; contact uuid; conv uuid; folder text;
BEGIN
  SELECT * INTO r FROM public.inbound_call_screening WHERE id=p_id FOR UPDATE;
  IF r.id IS NULL OR r.deleted_at IS NOT NULL THEN RETURN; END IF;
  folder:=CASE WHEN r.review_decision='not_spam' THEN 'inbox' WHEN r.review_decision='spam' THEN 'spam'
    WHEN r.verdict='spam_likely' THEN 'suspected' ELSE 'inbox' END;
  IF r.conversation_id IS NULL THEN
    SELECT s.conversation_id INTO conv FROM public.voice_sessions s
      WHERE s.business_id=r.business_id AND s.call_control_id=r.call_control_id;
    IF conv IS NULL AND r.ended_at IS NOT NULL AND folder<>'inbox' THEN
      IF r.caller_phone ~ '^\+[1-9][0-9]{7,14}$' THEN
        INSERT INTO public.contacts(business_id,phone_number,source_channel)
          VALUES(r.business_id,r.caller_phone,'voice')
          ON CONFLICT(business_id,phone_number) WHERE phone_number IS NOT NULL
          DO UPDATE SET last_contacted_at=GREATEST(public.contacts.last_contacted_at,excluded.last_contacted_at)
          RETURNING id INTO contact;
      ELSE
        INSERT INTO public.contacts(business_id,name,source_channel) VALUES(r.business_id,'Unknown caller','voice') RETURNING id INTO contact;
      END IF;
      INSERT INTO public.conversations(business_id,contact_id,channel,status,is_ai_handling,last_message_at,call_kind)
        VALUES(r.business_id,contact,'voice','closed',false,r.started_at,'phone') RETURNING id INTO conv;
    END IF;
    IF conv IS NOT NULL THEN UPDATE public.inbound_call_screening SET conversation_id=conv WHERE id=r.id; END IF;
  ELSE conv:=r.conversation_id;
  END IF;
  UPDATE public.conversations SET spam_state=folder,spam_revision=r.revision
    WHERE id=conv AND business_id=r.business_id;
END $$;

CREATE FUNCTION public.observe_inbound_call_screening(p_business uuid,p_control text,p_session text,p_caller text,p_called text,
  p_verdict text,p_evidence jsonb,p_started timestamptz) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE r public.inbound_call_screening; phone uuid;
BEGIN
  PERFORM 1 FROM public.businesses WHERE id=p_business AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'screening_business_unavailable'; END IF;
  SELECT id INTO phone FROM public.phone_numbers WHERE business_id=p_business AND phone_number=p_called AND is_active;
  IF phone IS NULL THEN RAISE EXCEPTION 'screening_number_unavailable'; END IF;
  IF p_verdict NOT IN ('unknown','not_flagged','spam_likely') OR p_started IS NULL THEN RAISE EXCEPTION 'screening_invalid_event'; END IF;
  INSERT INTO public.inbound_call_screening(business_id,phone_number_id,call_control_id,call_session_id,caller_phone,called_phone,verdict,evidence,started_at,followup_suppressed)
    VALUES(p_business,phone,p_control,p_session,p_caller,p_called,p_verdict,p_evidence,p_started,p_verdict='spam_likely')
    ON CONFLICT(call_control_id) DO NOTHING;
  SELECT * INTO r FROM public.inbound_call_screening WHERE call_control_id=p_control FOR UPDATE;
  IF ROW(r.business_id,r.call_session_id,r.caller_phone,r.called_phone) IS DISTINCT FROM ROW(p_business,p_session,p_caller,p_called) THEN
    RAISE EXCEPTION 'screening_call_identity_mismatch';
  END IF;
  IF r.deleted_at IS NOT NULL THEN RETURN r.id; END IF;
  -- Missing/less-specific callbacks never clear an earlier positive verdict.
  IF p_verdict='spam_likely' AND r.verdict<>'spam_likely' THEN
    UPDATE public.inbound_call_screening SET verdict=p_verdict,evidence=p_evidence,followup_suppressed=true,revision=revision+1 WHERE id=r.id;
  END IF;
  PERFORM public.project_inbound_call_screening(r.id);
  RETURN r.id;
END $$;

CREATE FUNCTION public.finish_inbound_call_screening(p_control text,p_ended timestamptz,p_exact_time boolean DEFAULT true) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE b uuid; rid uuid;
BEGIN
  SELECT business_id INTO b FROM public.inbound_call_screening WHERE call_control_id=p_control;
  IF b IS NULL THEN RETURN; END IF;
  PERFORM 1 FROM public.businesses WHERE id=b AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.inbound_call_screening SET
    ended_at=CASE WHEN ended_at IS NULL OR (NOT ended_time_verified AND p_exact_time)
      THEN GREATEST(started_at,COALESCE(p_ended,now())) ELSE ended_at END,
    ended_time_verified=CASE WHEN ended_at IS NULL OR NOT ended_time_verified THEN COALESCE(p_exact_time,false) AND p_ended IS NOT NULL ELSE ended_time_verified END
    WHERE call_control_id=p_control RETURNING id INTO rid;
  PERFORM public.project_inbound_call_screening(rid);
END $$;

CREATE FUNCTION public.link_voice_call_screening() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE r public.inbound_call_screening;
BEGIN
  IF NEW.conversation_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO r FROM public.inbound_call_screening WHERE call_control_id=NEW.call_control_id;
  IF r.id IS NULL THEN RETURN NEW; END IF;
  IF r.business_id<>NEW.business_id OR r.deleted_at IS NOT NULL OR (r.conversation_id IS NOT NULL AND r.conversation_id<>NEW.conversation_id) THEN
    RAISE EXCEPTION 'screening_call_identity_mismatch';
  END IF;
  UPDATE public.inbound_call_screening SET conversation_id=NEW.conversation_id WHERE id=r.id;
  UPDATE public.conversations SET call_kind='ai' WHERE id=NEW.conversation_id AND business_id=NEW.business_id;
  PERFORM public.project_inbound_call_screening(r.id);
  RETURN NEW;
END $$;
CREATE TRIGGER link_voice_call_screening AFTER INSERT ON public.voice_sessions FOR EACH ROW EXECUTE FUNCTION public.link_voice_call_screening();

ALTER FUNCTION public.admit_voice_commercial(uuid,text,text,text,text,boolean) RENAME TO admit_voice_commercial_before_screening;
CREATE FUNCTION public.admit_voice_commercial(p_business_id uuid,p_call_control_id text,p_call_session_id text,p_caller text,p_called text,p_worker_ready boolean)
RETURNS public.voice_sessions LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  PERFORM 1 FROM public.businesses WHERE id=p_business_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.inbound_call_screening WHERE call_control_id=p_call_control_id AND (ended_at IS NOT NULL OR deleted_at IS NOT NULL))
    AND NOT EXISTS(SELECT 1 FROM public.voice_sessions WHERE call_control_id=p_call_control_id) THEN RETURN NULL; END IF;
  RETURN public.admit_voice_commercial_before_screening(p_business_id,p_call_control_id,p_call_session_id,p_caller,p_called,p_worker_ready);
END $$;
ALTER FUNCTION public.admit_voice_pilot(uuid,text,text,text,text,boolean) RENAME TO admit_voice_pilot_before_screening;
CREATE FUNCTION public.admit_voice_pilot(p_business_id uuid,p_call_control_id text,p_call_session_id text,p_caller text,p_called text,p_worker_ready boolean)
RETURNS public.voice_sessions LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  PERFORM 1 FROM public.businesses WHERE id=p_business_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.inbound_call_screening WHERE call_control_id=p_call_control_id AND (ended_at IS NOT NULL OR deleted_at IS NOT NULL))
    AND NOT EXISTS(SELECT 1 FROM public.voice_sessions WHERE call_control_id=p_call_control_id) THEN RETURN NULL; END IF;
  RETURN public.admit_voice_pilot_before_screening(p_business_id,p_call_control_id,p_call_session_id,p_caller,p_called,p_worker_ready);
END $$;

CREATE FUNCTION public.review_inbox_call_spam(p_business uuid,p_owner uuid,p_conversation uuid,p_decision text,p_revision integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE c public.conversations; r public.inbound_call_screening; s public.voice_sessions; caller text;
BEGIN
  PERFORM 1 FROM public.businesses WHERE id=p_business AND owner_id=p_owner AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'screening_access_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO c FROM public.conversations WHERE id=p_conversation AND business_id=p_business FOR UPDATE;
  IF c.id IS NULL OR c.channel<>'voice' THEN RAISE EXCEPTION 'screening_call_not_found'; END IF;
  IF c.status<>'closed' OR EXISTS(SELECT 1 FROM public.voice_sessions WHERE (conversation_id=c.id OR action_conversation_id=c.id) AND status<>'closed')
    OR EXISTS(SELECT 1 FROM public.inbound_call_screening WHERE conversation_id=c.id AND ended_at IS NULL)
    THEN RAISE EXCEPTION 'screening_call_active'; END IF;
  IF p_revision IS DISTINCT FROM c.spam_revision THEN RAISE EXCEPTION 'screening_revision_conflict'; END IF;
  IF p_decision NOT IN ('spam','not_spam') OR p_decision IS NULL THEN RAISE EXCEPTION 'screening_invalid_decision'; END IF;
  SELECT * INTO r FROM public.inbound_call_screening WHERE conversation_id=c.id;
  IF r.id IS NULL THEN
    SELECT * INTO s FROM public.voice_sessions WHERE conversation_id=c.id AND business_id=p_business;
    SELECT phone_number INTO caller FROM public.contacts WHERE id=c.contact_id AND business_id=p_business;
    INSERT INTO public.inbound_call_screening(business_id,call_control_id,call_session_id,caller_phone,called_phone,conversation_id,started_at,ended_at)
      VALUES(p_business,COALESCE(s.call_control_id,'manual:'||c.id),COALESCE(s.call_session_id,'manual:'||c.id),COALESCE(s.caller_phone,caller,''),COALESCE(s.called_phone,''),c.id,
        COALESCE(s.created_at,c.started_at,now()),COALESCE(s.ended_at,now())) RETURNING * INTO r;
  END IF;
  UPDATE public.inbound_call_screening SET review_decision=p_decision,revision=revision+1,
    followup_suppressed=followup_suppressed OR p_decision='spam' WHERE id=r.id;
  PERFORM public.project_inbound_call_screening(r.id);
  RETURN (SELECT jsonb_build_object('id',id,'spamState',spam_state,'revision',spam_revision) FROM public.conversations WHERE id=c.id);
END $$;

ALTER FUNCTION public.delete_inbox_conversations(uuid,uuid,uuid[]) RENAME TO delete_inbox_conversations_before_screening;
CREATE FUNCTION public.delete_inbox_conversations(p_business_id uuid,p_owner_id uuid,p_ids uuid[])
RETURNS TABLE(deleted_id uuid) LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  PERFORM 1 FROM public.businesses WHERE id=p_business_id AND owner_id=p_owner_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM public.inbound_call_screening WHERE business_id=p_business_id AND conversation_id=ANY(p_ids) AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'conversation_call_in_progress'; END IF;
  -- The old operation still validates the whole selection and all appointments.
  -- Marking first is transactional: any refused deletion rolls back the marker.
  INSERT INTO public.inbound_call_screening(business_id,call_control_id,call_session_id,caller_phone,called_phone,conversation_id,started_at,ended_at)
    SELECT s.business_id,s.call_control_id,s.call_session_id,s.caller_phone,s.called_phone,s.conversation_id,s.created_at,COALESCE(s.ended_at,now())
    FROM public.voice_sessions s WHERE s.business_id=p_business_id AND s.conversation_id=ANY(p_ids) AND s.status='closed'
    ON CONFLICT(call_control_id) DO NOTHING;
  UPDATE public.inbound_call_screening SET deleted_at=now() WHERE business_id=p_business_id AND conversation_id=ANY(p_ids);
  RETURN QUERY SELECT * FROM public.delete_inbox_conversations_before_screening(p_business_id,p_owner_id,p_ids);
END $$;

CREATE FUNCTION public.call_followup_screening(p_business uuid,p_identity text,p_caller text,p_expected boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE suppressed boolean; found_count integer;
BEGIN
  SELECT count(*),bool_or(followup_suppressed OR deleted_at IS NOT NULL) INTO found_count,suppressed
    FROM public.inbound_call_screening WHERE business_id=p_business AND (call_control_id=p_identity OR call_session_id=p_identity) AND caller_phone=p_caller;
  IF found_count>0 THEN RETURN CASE WHEN suppressed THEN 'suppressed' ELSE 'allowed' END; END IF;
  RETURN CASE WHEN p_expected THEN 'unavailable' ELSE 'legacy' END;
END $$;

-- Guard the existing durable reservation too, including older compatible clients.
ALTER FUNCTION public.reserve_tenant_sms(uuid,uuid,text,text,text,text,text,text,integer,uuid,uuid) RENAME TO reserve_tenant_sms_before_call_screening;
CREATE FUNCTION public.reserve_tenant_sms(p_business uuid,p_period uuid,p_key text,p_fingerprint text,p_purpose text,p_profile text,p_from text,p_to text,p_parts integer,p_conversation uuid DEFAULT NULL,p_enrollment uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  PERFORM 1 FROM public.businesses WHERE id=p_business FOR UPDATE;
  IF p_purpose='missed_call' AND p_key LIKE 'missed-call:%' AND public.call_followup_screening(p_business,substr(p_key,13),p_to,false)='suppressed' THEN
    RAISE EXCEPTION 'sms_call_screened';
  END IF;
  RETURN public.reserve_tenant_sms_before_call_screening(p_business,p_period,p_key,p_fingerprint,p_purpose,p_profile,p_from,p_to,p_parts,p_conversation,p_enrollment);
END $$;

CREATE TABLE public.call_screening_settings (
  phone_number_id uuid PRIMARY KEY REFERENCES public.phone_numbers(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  requested_by uuid,
  requested_mode text NOT NULL DEFAULT 'disabled' CHECK (requested_mode IN ('disabled','flag_calls')),
  confirmed_mode text NOT NULL DEFAULT 'unknown' CHECK (confirmed_mode IN ('unknown','disabled','flag_calls','reject_calls')),
  revision integer NOT NULL DEFAULT 0,
  sync_status text NOT NULL DEFAULT 'idle' CHECK (sync_status IN ('idle','pending','error')),
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz,
  attempted_at timestamptz,
  verified_at timestamptz,
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.call_screening_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.call_screening_settings FROM anon,authenticated;
GRANT ALL ON public.call_screening_settings TO service_role;

CREATE FUNCTION public.request_call_screening(p_business uuid,p_owner uuid,p_number uuid,p_mode text,p_revision integer)
RETURNS public.call_screening_settings LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE r public.call_screening_settings;
BEGIN
  PERFORM 1 FROM public.businesses WHERE id=p_business AND owner_id=p_owner AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'screening_access_denied' USING ERRCODE='42501'; END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('disabled','flag_calls') THEN RAISE EXCEPTION 'screening_invalid_mode'; END IF;
  PERFORM 1 FROM public.phone_numbers WHERE id=p_number AND business_id=p_business AND is_active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'screening_number_unavailable'; END IF;
  INSERT INTO public.call_screening_settings(phone_number_id,business_id) VALUES(p_number,p_business) ON CONFLICT DO NOTHING;
  SELECT * INTO r FROM public.call_screening_settings WHERE phone_number_id=p_number FOR UPDATE;
  IF r.business_id<>p_business THEN RAISE EXCEPTION 'screening_access_denied' USING ERRCODE='42501'; END IF;
  IF r.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'screening_revision_conflict'; END IF;
  IF r.sync_status='pending' THEN RAISE EXCEPTION 'screening_sync_pending'; END IF;
  UPDATE public.call_screening_settings SET requested_by=p_owner,requested_mode=p_mode,revision=revision+1,sync_status='pending',
    attempts=0,lease_token=NULL,lease_until=NULL,attempted_at=NULL,error_code=NULL,updated_at=now()
    WHERE phone_number_id=p_number RETURNING * INTO r;
  RETURN r;
END $$;

CREATE FUNCTION public.claim_call_screening_sync(p_number uuid) RETURNS public.call_screening_settings
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE r public.call_screening_settings;
BEGIN
  UPDATE public.call_screening_settings s SET lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',attempts=attempts+1,attempted_at=now()
    WHERE s.phone_number_id=p_number AND s.sync_status='pending'
      AND (s.lease_until IS NULL OR s.lease_until<now()) AND (s.attempted_at IS NULL OR s.attempted_at<now()-interval '30 seconds')
    RETURNING * INTO r;
  RETURN r;
END $$;

CREATE FUNCTION public.finish_call_screening_sync(p_number uuid,p_lease uuid,p_actual text,p_error text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  IF p_actual NOT IN ('unknown','disabled','flag_calls','reject_calls') OR p_actual IS NULL THEN RAISE EXCEPTION 'screening_invalid_mode'; END IF;
  UPDATE public.call_screening_settings SET confirmed_mode=CASE WHEN p_actual='unknown' THEN confirmed_mode ELSE p_actual END,
    verified_at=CASE WHEN p_actual='unknown' THEN verified_at ELSE now() END,
    sync_status=CASE WHEN p_error IS NULL AND p_actual=requested_mode THEN 'idle'
      WHEN attempts>=3 OR p_error='screening_number_unavailable' THEN 'error' ELSE 'pending' END,
    error_code=CASE WHEN p_error IS NULL AND p_actual=requested_mode THEN NULL ELSE COALESCE(left(p_error,100),'screening_sync_unconfirmed') END,
    lease_token=NULL,lease_until=NULL,updated_at=now()
    WHERE phone_number_id=p_number AND lease_token=p_lease AND sync_status='pending';
  RETURN FOUND;
END $$;

CREATE FUNCTION public.observe_call_screening_setting(p_business uuid,p_owner uuid,p_number uuid,p_actual text,p_revision integer)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  PERFORM 1 FROM public.businesses WHERE id=p_business AND owner_id=p_owner AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'screening_access_denied' USING ERRCODE='42501'; END IF;
  IF p_actual IS NULL OR p_actual NOT IN ('disabled','flag_calls','reject_calls') THEN RAISE EXCEPTION 'screening_invalid_mode'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.phone_numbers WHERE id=p_number AND business_id=p_business AND is_active) THEN RAISE EXCEPTION 'screening_number_unavailable'; END IF;
  INSERT INTO public.call_screening_settings(phone_number_id,business_id,requested_by,requested_mode,confirmed_mode,verified_at)
    VALUES(p_number,p_business,p_owner,CASE WHEN p_actual='flag_calls' THEN p_actual ELSE 'disabled' END,p_actual,now()) ON CONFLICT DO NOTHING;
  UPDATE public.call_screening_settings SET confirmed_mode=p_actual,verified_at=now(),updated_at=now()
    WHERE phone_number_id=p_number AND business_id=p_business AND revision=p_revision;
END $$;

CREATE FUNCTION public.inbox_conversation_json(c public.conversations) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
  SELECT to_jsonb(c)||jsonb_build_object(
    'contact',(SELECT jsonb_build_object('id',ct.id,'name',ct.name,'phone_number',ct.phone_number,'email',ct.email,
      'provided_phone_number',ct.provided_phone_number,'source_channel',ct.source_channel)
      FROM public.contacts ct WHERE ct.id=c.contact_id AND ct.business_id=c.business_id),
    'last_message_preview',CASE WHEN c.channel='voice' THEN CASE WHEN c.call_kind='phone' THEN 'View call details' ELSE 'View call transcript' END
      ELSE (SELECT m.content FROM public.messages m WHERE m.business_id=c.business_id AND m.conversation_id=c.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) END,
    'has_bookings',EXISTS(SELECT 1 FROM public.calendar_bookings b WHERE b.conversation_id=c.id OR b.source_message_id IN
      (SELECT id FROM public.messages WHERE conversation_id=c.id)))
$$;

CREATE FUNCTION public.read_inbox_page(p_business uuid,p_owner uuid,p_folder text DEFAULT 'inbox',p_channel text DEFAULT 'all',p_search text DEFAULT '',
  p_cursor_time timestamptz DEFAULT NULL,p_cursor_id uuid DEFAULT NULL,p_focus uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE folder text:=p_folder; focus public.conversations; result jsonb;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.businesses WHERE id=p_business AND owner_id=p_owner AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'screening_access_denied' USING ERRCODE='42501'; END IF;
  IF p_folder IS NULL OR p_channel IS NULL OR p_search IS NULL OR p_folder NOT IN ('inbox','spam') OR p_channel NOT IN ('all','sms','web_chat','voice') OR length(p_search)>120 THEN RAISE EXCEPTION 'inbox_invalid_filter'; END IF;
  IF (p_cursor_time IS NULL)<>(p_cursor_id IS NULL) THEN RAISE EXCEPTION 'inbox_invalid_cursor'; END IF;
  SELECT * INTO focus FROM public.conversations WHERE id=p_focus AND business_id=p_business;
  IF focus.id IS NOT NULL THEN folder:=CASE WHEN focus.spam_state='inbox' THEN 'inbox' ELSE 'spam' END; END IF;
  WITH eligible AS (
    SELECT c.*,COALESCE(c.last_message_at,c.started_at,'epoch'::timestamptz) AS sort_time
    FROM public.conversations c LEFT JOIN public.contacts ct ON ct.id=c.contact_id AND ct.business_id=c.business_id
    WHERE c.business_id=p_business AND (CASE WHEN folder='spam' THEN c.spam_state<>'inbox' ELSE c.spam_state='inbox' END)
      AND (p_channel='all' OR c.channel=p_channel)
      AND (p_search='' OR position(lower(p_search) IN lower(COALESCE(ct.name,'')))>0 OR position(p_search IN COALESCE(ct.phone_number,''))>0)
  ), candidates AS (
    SELECT * FROM eligible WHERE p_cursor_time IS NULL OR (sort_time,id)<(p_cursor_time,p_cursor_id)
    ORDER BY sort_time DESC,id DESC LIMIT 101
  ), page AS (SELECT * FROM candidates ORDER BY sort_time DESC,id DESC LIMIT 100)
  SELECT jsonb_build_object('folder',folder,
    'conversations',COALESCE((SELECT jsonb_agg(public.inbox_conversation_json(c) ORDER BY p.sort_time DESC,p.id DESC)
      FROM page p JOIN public.conversations c ON c.id=p.id),'[]'::jsonb),
    'selected',CASE WHEN focus.id IS NULL THEN NULL ELSE public.inbox_conversation_json(focus) END,
    'total',(SELECT count(*) FROM eligible),
    'counts',(SELECT jsonb_build_object('inbox',count(*) FILTER(WHERE spam_state='inbox'),'spam',count(*) FILTER(WHERE spam_state<>'inbox')) FROM public.conversations WHERE business_id=p_business),
    'next',(SELECT CASE WHEN (SELECT count(*) FROM candidates)>100 THEN jsonb_build_object('time',sort_time,'id',id) ELSE NULL END FROM page ORDER BY sort_time,id LIMIT 1))
    INTO result;
  RETURN result;
END $$;

CREATE FUNCTION public.scrub_call_screening() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  IF NEW.owner_id IS NULL OR NEW.deleted_at IS NOT NULL THEN
    DELETE FROM public.call_screening_settings WHERE business_id=NEW.id;
    DELETE FROM public.inbound_call_screening WHERE business_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scrub_call_screening AFTER UPDATE OF owner_id,deleted_at ON public.businesses FOR EACH ROW EXECUTE FUNCTION public.scrub_call_screening();

DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN (
      'guard_inbox_screening_projection','project_inbound_call_screening','observe_inbound_call_screening','finish_inbound_call_screening',
      'link_voice_call_screening','admit_voice_commercial','admit_voice_pilot','review_inbox_call_spam','delete_inbox_conversations',
      'call_followup_screening','reserve_tenant_sms','request_call_screening','claim_call_screening_sync','finish_call_screening_sync',
      'observe_call_screening_setting','inbox_conversation_json','read_inbox_page','scrub_call_screening')
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
  END LOOP;
END $$;

COMMIT;
