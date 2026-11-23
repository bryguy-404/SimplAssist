BEGIN;

ALTER TABLE public.conversations ADD COLUMN inbox_kept boolean NOT NULL DEFAULT false;
ALTER TABLE public.voice_sessions ADD COLUMN inbox_reply_state text
  CHECK (inbox_reply_state IN ('responded','silent','unknown'));
ALTER TABLE public.tenant_sms_sends ADD COLUMN inbox_call_origin text
  CHECK (inbox_call_origin IN ('unverified','missed','voicemail','unknown'));
-- Earlier receipts keep NULL (legacy). A new unannotated receipt is explicitly uncertain.
ALTER TABLE public.tenant_sms_sends ALTER COLUMN inbox_call_origin SET DEFAULT 'unverified';

CREATE FUNCTION public.guard_inbox_keep() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  IF current_user NOT IN ('service_role','postgres') AND
    ((TG_OP='INSERT' AND NEW.inbox_kept) OR (TG_OP='UPDATE' AND NEW.inbox_kept IS DISTINCT FROM OLD.inbox_kept)) THEN
    RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_inbox_keep BEFORE INSERT OR UPDATE OF inbox_kept ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.guard_inbox_keep();

CREATE INDEX inbox_sends_by_thread ON public.tenant_sms_sends(business_id,conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX inbox_voice_by_session_key ON public.voice_sessions(business_id,call_session_id);
CREATE INDEX inbox_caller_transcript ON public.voice_transcript_fragments(session_id,business_id) WHERE role='customer';

-- One row per original conversation, with a shared display ID for a proven call/text pair.
-- Source identifiers stay on the server. Only dated links to owner-visible call details leave it.
CREATE FUNCTION public.inbox_activity_rows(p_business uuid)
RETURNS TABLE(conversation_id uuid,item_id uuid,folder text,reason text,sort_time timestamptz,call_history jsonb,protected_booking boolean)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $activity$
WITH threads AS MATERIALIZED (
  SELECT c.id,c.contact_id,c.channel,c.status,c.spam_state,c.inbox_kept,
    coalesce(c.last_message_at,c.started_at,'epoch'::timestamptz) AS activity_at
  FROM public.conversations c WHERE c.business_id=p_business
), call_keys AS (
  SELECT v.conversation_id,v.call_session_id,v.call_control_id,v.caller_phone,v.created_at AS started_at
  FROM public.voice_sessions v WHERE v.business_id=p_business AND v.response_mode='voice' AND v.conversation_id IS NOT NULL
  UNION
  SELECT r.conversation_id,r.call_session_id,r.call_control_id,r.caller_phone,r.started_at
  FROM public.inbound_call_screening r WHERE r.business_id=p_business AND r.deleted_at IS NULL AND r.conversation_id IS NOT NULL
), receipts AS MATERIALIZED (
  SELECT s.conversation_id AS sms_id, matched.voice_id,coalesce(matched.started_at,a.created_at,s.created_at) AS at,
    CASE WHEN s.status<>'accepted' OR s.provider_message_id IS NULL
           OR s.delivery_status IN ('delivery_failed','sending_failed','failed','expired','cancelled') THEN 'delivery_issue'
      WHEN s.inbox_call_origin='unverified' THEN 'unknown'
      WHEN s.inbox_call_origin IS NOT NULL THEN s.inbox_call_origin
      WHEN a.status='abandoned' AND a.connected_at IS NULL THEN 'missed'
      ELSE 'legacy' END AS origin
  FROM public.tenant_sms_sends s
  JOIN threads sms ON sms.id=s.conversation_id AND sms.channel='sms'
  LEFT JOIN public.call_forwarding_attempts a ON a.business_id=s.business_id AND a.caller_phone=s.destination
    AND a.call_session_id=substr(s.idempotency_key,13)
  LEFT JOIN LATERAL (
    SELECT CASE WHEN count(DISTINCT k.conversation_id)=1 THEN (array_agg(k.conversation_id))[1] END AS voice_id,
      min(k.started_at) AS started_at
    FROM call_keys k JOIN threads v ON v.id=k.conversation_id AND v.contact_id=sms.contact_id AND v.channel='voice'
    WHERE k.caller_phone=s.destination AND substr(s.idempotency_key,13) IN (k.call_session_id,k.call_control_id)
  ) matched ON true
  WHERE s.business_id=p_business AND s.purpose='missed_call' AND s.idempotency_key LIKE 'missed-call:%'
), evidence AS (
  SELECT t.*, v.id AS session_id, v.outcome,v.inbox_reply_state,v.status AS session_status,v.error_code,
    EXISTS(SELECT 1 FROM public.messages m WHERE m.conversation_id=t.id AND m.business_id=p_business
      AND (m.role IN ('customer','human_agent','system') OR m.content ~* '(https?://|www[.])')) AS meaningful_message,
    CASE WHEN t.channel='sms' THEN (SELECT bool_and(m.role='assistant' AND (
        m.content LIKE E'Hi, this is % — saw your call come in. Just reply here with what you need and we''ll get you taken care of.\n\nMsg frequency varies. Msg & data rates may apply. Reply HELP for help or STOP to opt out.'
        OR m.content LIKE E'Hola, somos % — vimos tu llamada. Solo responde aquí con lo que necesitas y nos encargaremos de ayudarte.\n\nLa frecuencia de mensajes varía. Pueden aplicarse tarifas de mensajes y datos. Responde HELP para recibir ayuda o STOP para dejar de recibir mensajes.'
        OR m.content LIKE 'Hi, this is %. We received your call and can help by text. Msg frequency varies. Msg & data rates may apply. Reply HELP for help or STOP to opt out.'
        OR m.content LIKE 'Hola, somos %. Recibimos su llamada y podemos ayudar por texto. La frecuencia de mensajes varia. Pueden aplicar tarifas de mensajes y datos. Responda HELP para ayuda o STOP para cancelar.'
        OR m.content LIKE 'Hi, this is %. We saw your missed call and wanted to follow up. What service or question can we help with? Reply STOP to opt out.'
      )) FROM public.messages m WHERE m.business_id=p_business AND m.conversation_id=t.id) END AS only_missed_call_templates,
    EXISTS(SELECT 1 FROM public.calendar_bookings b WHERE b.business_id=p_business AND
      (b.conversation_id=t.id OR EXISTS(SELECT 1 FROM public.messages m WHERE m.id=b.source_message_id AND m.business_id=p_business AND m.conversation_id=t.id))) AS booked,
    EXISTS(SELECT 1 FROM public.goal_events g WHERE g.business_id=p_business AND t.id IN (g.conversation_id,g.source_conversation_id))
      OR EXISTS(SELECT 1 FROM public.lead_events l WHERE l.business_id=p_business AND l.conversation_id=t.id)
      OR EXISTS(SELECT 1 FROM public.voice_actions act WHERE act.session_id=v.id AND act.business_id=p_business) AS has_action,
    EXISTS(SELECT 1 FROM public.voice_transcript_fragments f WHERE f.session_id=v.id AND f.business_id=p_business
      AND f.role='customer' AND btrim(f.content)<>'') AS caller_spoke,
    EXISTS(SELECT 1 FROM public.inbound_call_screening s WHERE s.business_id=p_business AND s.conversation_id=t.id
      AND s.review_decision='not_spam') AS restored_call
  FROM threads t LEFT JOIN public.voice_sessions v ON t.channel='voice' AND v.business_id=p_business
    AND v.conversation_id=t.id AND v.response_mode='voice'
), individual AS MATERIALIZED (
  SELECT e.*, CASE
    WHEN e.spam_state<>'inbox' THEN 'spam'
    WHEN e.inbox_kept OR e.restored_call THEN 'kept'
    WHEN e.booked OR e.has_action OR e.meaningful_message OR e.caller_spoke OR e.inbox_reply_state='responded' THEN 'engaged'
    WHEN e.channel='voice' AND (e.status<>'closed' OR e.session_status<>'closed') THEN 'active_call'
    WHEN e.channel='voice' AND e.error_code IS NULL AND e.outcome='caller_abandoned' THEN 'abandoned'
    WHEN e.channel='voice' AND e.error_code IS NULL AND e.inbox_reply_state='silent' THEN 'silent'
    WHEN e.channel='voice' THEN 'needs_review'
    WHEN e.channel='web_chat' AND (SELECT bool_and(m.role='assistant' AND (
      m.content IN ('Hi! How can we help you today?', 'Hi there! 👋 How can we help you today?')
      OR EXISTS(SELECT 1 FROM public.widget_configs w WHERE w.business_id=p_business AND w.welcome_message=m.content)))
      FROM public.messages m WHERE m.business_id=p_business AND m.conversation_id=e.id) THEN 'greeting'
    WHEN EXISTS(SELECT 1 FROM receipts r WHERE r.sms_id=e.id AND r.origin='voicemail') THEN 'voicemail'
    WHEN EXISTS(SELECT 1 FROM public.tenant_sms_sends s WHERE s.business_id=p_business AND s.conversation_id=e.id
      AND s.purpose<>'missed_call') THEN 'engaged'
    WHEN EXISTS(SELECT 1 FROM receipts r WHERE r.sms_id=e.id AND r.origin='delivery_issue') THEN 'needs_review'
    WHEN EXISTS(SELECT 1 FROM receipts r WHERE r.sms_id=e.id AND r.origin='unknown') THEN 'needs_review'
    WHEN e.channel='sms' AND e.only_missed_call_templates IS FALSE THEN 'history'
    -- These old SMS threads prove only that the standard follow-up got no text reply.
    -- They do not establish silence, supply a voice identity, or group by phone number.
    WHEN e.only_missed_call_templates AND NOT EXISTS(SELECT 1 FROM receipts r WHERE r.sms_id=e.id AND r.origin<>'legacy')
      THEN 'legacy_text'
    WHEN EXISTS(SELECT 1 FROM receipts r WHERE r.sms_id=e.id AND r.origin='legacy' AND r.voice_id IS NULL) THEN 'needs_review'
    WHEN EXISTS(SELECT 1 FROM receipts r WHERE r.sms_id=e.id) THEN 'text_sent'
    ELSE 'history' END AS own_reason
  FROM evidence e
), pairs AS (
  SELECT r.voice_id,(array_agg(DISTINCT r.sms_id))[1] AS parent
  FROM receipts r JOIN individual v ON v.id=r.voice_id AND v.spam_state='inbox' AND v.status='closed'
    AND (v.session_id IS NULL OR v.session_status='closed') AND NOT v.restored_call
  GROUP BY r.voice_id HAVING count(DISTINCT r.sms_id)=1
), members AS MATERIALIZED (
  SELECT i.*,coalesce(p.parent,i.id) AS root FROM individual i LEFT JOIN pairs p ON p.voice_id=i.id
), groups AS (
  SELECT m.root,max(m.activity_at) AS latest,bool_or(m.booked) AS protected_booking,
    CASE WHEN bool_or(m.own_reason='spam') THEN 'spam'
      WHEN bool_or(m.own_reason='kept') THEN 'kept'
      WHEN bool_or(m.own_reason='engaged') THEN 'engaged'
      WHEN bool_or(m.own_reason='voicemail') THEN 'voicemail'
      WHEN bool_or(m.own_reason='needs_review') THEN 'needs_review'
      WHEN bool_or(m.own_reason='active_call') THEN 'active_call'
      ELSE max(m.own_reason) FILTER(WHERE m.id=m.root) END AS group_reason
  FROM members m GROUP BY m.root
), history AS (
  SELECT r.sms_id,jsonb_agg(jsonb_build_object('at',r.at,'origin',r.origin,'conversation_id',
    CASE WHEN v.spam_state='inbox' THEN v.id END) ORDER BY r.at DESC,r.voice_id) AS calls
  FROM receipts r LEFT JOIN threads v ON v.id=r.voice_id GROUP BY r.sms_id
)
SELECT m.id,m.root,
  CASE WHEN g.group_reason='spam' THEN 'spam'
       WHEN g.group_reason IN ('abandoned','silent','greeting','text_sent','legacy_text') THEN 'no_reply' ELSE 'inbox' END,
  g.group_reason,g.latest,coalesce(h.calls,'[]'::jsonb),g.protected_booking
FROM members m JOIN groups g ON g.root=m.root LEFT JOIN history h ON h.sms_id=m.id
$activity$;

CREATE FUNCTION public.read_conversation_folder_page(p_business uuid,p_owner uuid,p_folder text,p_channel text,
  p_search text,p_phone_search text,p_cursor_time timestamptz,p_cursor_id uuid,p_focus uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.businesses WHERE id=p_business AND owner_id=p_owner AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'inbox_access_denied' USING ERRCODE='42501';
  END IF;
  IF p_folder IS NULL OR p_folder NOT IN ('inbox','no_reply','spam') OR p_channel IS NULL OR p_channel NOT IN ('all','sms','web_chat','voice')
    OR p_search IS NULL OR length(p_search)>120 OR length(p_phone_search)>120 OR (p_cursor_time IS NULL)<>(p_cursor_id IS NULL) THEN
    RAISE EXCEPTION 'inbox_invalid_filter';
  END IF;
  WITH rows AS MATERIALIZED (SELECT * FROM public.inbox_activity_rows(p_business)),
  focus AS (SELECT * FROM rows WHERE conversation_id=p_focus),
  roots AS MATERIALIZED (SELECT * FROM rows WHERE conversation_id=item_id),
  eligible AS (
    SELECT r.* FROM roots r JOIN public.conversations c ON c.id=r.item_id
    LEFT JOIN public.contacts ct ON ct.id=c.contact_id AND ct.business_id=p_business
    WHERE r.folder=coalesce((SELECT folder FROM focus),p_folder)
      AND (p_channel='all' OR c.channel=p_channel OR (p_channel='voice' AND jsonb_array_length(r.call_history)>0))
      AND (p_search='' OR position(lower(p_search) IN lower(ct.name))>0 OR position(p_search IN ct.phone_number)>0
        OR (p_phone_search IS NOT NULL AND (position(p_phone_search IN ct.name)>0 OR position(p_phone_search IN ct.phone_number)>0)))
  ), candidates AS (SELECT * FROM eligible WHERE p_cursor_time IS NULL OR (sort_time,item_id)<(p_cursor_time,p_cursor_id)
    ORDER BY sort_time DESC,item_id DESC LIMIT 101),
  page AS (SELECT * FROM candidates ORDER BY sort_time DESC,item_id DESC LIMIT 100),
  details AS (
    SELECT r.conversation_id,public.inbox_conversation_json(c)||jsonb_build_object('inbox_folder',r.folder,'inbox_reason',r.reason,
      'inbox_item_id',r.item_id,'inbox_sort_time',r.sort_time,'missed_calls',r.call_history,
      'has_bookings',r.protected_booking) AS value FROM rows r JOIN public.conversations c ON c.id=r.conversation_id
    WHERE r.conversation_id IN (SELECT item_id FROM page) OR r.conversation_id=p_focus
  )
  SELECT jsonb_build_object('folder',coalesce((SELECT folder FROM focus),p_folder),
    'conversations',coalesce((SELECT jsonb_agg(d.value ORDER BY p.sort_time DESC,p.item_id DESC) FROM page p JOIN details d ON d.conversation_id=p.item_id),'[]'::jsonb),
    'selected',(SELECT value FROM details WHERE conversation_id=p_focus),'total',(SELECT count(*) FROM eligible),
    'counts',(SELECT jsonb_build_object('inbox',count(*) FILTER(WHERE folder='inbox'),'no_reply',count(*) FILTER(WHERE folder='no_reply'),
      'spam',count(*) FILTER(WHERE folder='spam')) FROM roots),
    'next',(SELECT CASE WHEN (SELECT count(*) FROM candidates)>100 THEN jsonb_build_object('time',sort_time,'id',item_id) END FROM page ORDER BY sort_time,item_id LIMIT 1))
    INTO result;
  RETURN result;
END $$;

CREATE FUNCTION public.keep_inbox_conversation(p_business uuid,p_owner uuid,p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE entry record;
BEGIN
  PERFORM 1 FROM public.businesses WHERE id=p_business AND owner_id=p_owner AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO entry FROM public.inbox_activity_rows(p_business) WHERE conversation_id=p_id;
  IF NOT FOUND OR entry.folder='spam' THEN RAISE EXCEPTION 'conversation_selection_changed'; END IF;
  UPDATE public.conversations SET inbox_kept=true WHERE business_id=p_business AND id=entry.item_id AND NOT inbox_kept;
END $$;

-- Legacy readers and single-record deletion continue to use their original RPCs.
CREATE FUNCTION public.delete_inbox_folder_items(p_business_id uuid,p_owner_id uuid,p_ids uuid[],p_folder text)
RETURNS TABLE(deleted_id uuid) LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE members uuid[]; confirmed uuid[]; selection uuid[]; batch_start int;
BEGIN
  IF cardinality(p_ids) NOT BETWEEN 1 AND 100 OR p_ids IS NULL OR array_position(p_ids,NULL) IS NOT NULL
    OR p_folder IS NULL OR p_folder NOT IN ('inbox','spam','no_reply') THEN RAISE EXCEPTION 'invalid_conversation_selection'; END IF;
  PERFORM 1 FROM public.businesses WHERE id=p_business_id AND owner_id=p_owner_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
  SELECT array_agg(DISTINCT i ORDER BY i) INTO selection FROM unnest(p_ids) i;
  SELECT array_agg(conversation_id ORDER BY conversation_id) INTO members FROM public.inbox_activity_rows(p_business_id)
    WHERE item_id=ANY(selection) AND folder=p_folder;
  IF members IS NULL OR NOT selection <@ members THEN RAISE EXCEPTION 'conversation_selection_changed'; END IF;
  PERFORM 1 FROM public.conversations WHERE business_id=p_business_id AND id=ANY(members) ORDER BY id FOR UPDATE;
  SELECT array_agg(conversation_id ORDER BY conversation_id) INTO confirmed FROM public.inbox_activity_rows(p_business_id)
    WHERE item_id=ANY(selection) AND folder=p_folder;
  IF confirmed IS DISTINCT FROM members THEN RAISE EXCEPTION 'conversation_selection_changed'; END IF;
  FOR batch_start IN 0..((cardinality(members)-1)/100) LOOP
    RETURN QUERY SELECT d.deleted_id FROM public.delete_inbox_conversations(p_business_id,p_owner_id,
      members[(batch_start*100+1):(batch_start*100+100)]) d;
  END LOOP;
END $$;

DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('guard_inbox_keep','inbox_activity_rows','read_conversation_folder_page',
      'keep_inbox_conversation','delete_inbox_folder_items')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
  END LOOP;
END $$;
COMMIT;
