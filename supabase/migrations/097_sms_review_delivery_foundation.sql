-- Every tenant SMS reserves the same metered pool before entering Telnyx.
-- Submitting/uncertain reservations deliberately do not expire into a resend.
CREATE TABLE public.tenant_sms_sends (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 usage_period_id uuid NOT NULL REFERENCES billing_usage_periods(id), idempotency_key text NOT NULL,
 fingerprint text NOT NULL, purpose text NOT NULL CHECK(purpose IN ('manual_dashboard_send','ai_reply','mms_fallback','missed_call','voice_followup','review_invitation','review_reminder','review_reply')),
 messaging_profile_id text NOT NULL, sender text NOT NULL, destination text NOT NULL,
 sms_parts integer NOT NULL CHECK(sms_parts>0),
 status text NOT NULL DEFAULT 'submitting' CHECK(status IN ('submitting','accepted','uncertain','not_sent')),
 provider_message_id text UNIQUE, delivery_status text, failure_reason text,
 conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
 review_enrollment_id uuid REFERENCES review_enrollments(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), reconciled_at timestamptz,
 UNIQUE(business_id,idempotency_key)
);
CREATE INDEX tenant_sms_reserved_pool ON tenant_sms_sends(usage_period_id) WHERE status IN ('submitting','uncertain');
CREATE TABLE public.tenant_sms_suppressions (
 business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 messaging_profile_id text NOT NULL, destination text NOT NULL, suppressed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,messaging_profile_id,destination)
);
CREATE TABLE public.tenant_sms_human_holds (
 business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
 messaging_profile_id text NOT NULL, destination text NOT NULL,
 conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz,
 PRIMARY KEY(business_id,messaging_profile_id,destination)
);
ALTER TABLE tenant_sms_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_sms_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_sms_human_holds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON tenant_sms_sends,tenant_sms_suppressions,tenant_sms_human_holds FROM PUBLIC,anon,authenticated;
GRANT ALL ON tenant_sms_sends,tenant_sms_suppressions,tenant_sms_human_holds TO service_role;

-- Preserve the existing billing precedence, including paid Chat upgrades whose
-- new SMS services have not been activated yet.
CREATE FUNCTION public.tenant_sms_service_plan(p_business uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b businesses; s subscriptions; p text;
BEGIN
 SELECT * INTO b FROM businesses WHERE id=p_business;
 IF NOT FOUND OR b.owner_id IS NULL OR b.deleted_at IS NOT NULL THEN RETURN NULL; END IF;
 SELECT * INTO s FROM subscriptions WHERE business_id=p_business;
 IF FOUND THEN
  IF s.status='canceled' THEN RETURN NULL; END IF;
  RETURN get_business_effective_service_plan(p_business,s.plan);
 END IF;
 IF b.billing_mode IN ('invoiced','comped') THEN RETURN b.partner_plan; END IF;
 IF b.billing_mode='stripe' AND (b.billing_comped OR b.billing_exempt OR b.billing_pilot) THEN RETURN 'full'; END IF;
 RETURN NULL;
END $$;

CREATE FUNCTION public.reserve_tenant_sms(p_business uuid,p_period uuid,p_key text,p_fingerprint text,p_purpose text,
 p_profile text,p_from text,p_to text,p_parts integer,p_conversation uuid DEFAULT NULL,p_enrollment uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b businesses; u billing_usage_periods; r tenant_sms_sends; e review_enrollments;
 v_plan text; v_review boolean; v_access boolean:=false; v_extra integer:=0; v_reserved bigint; v_overage boolean;
 v_contact uuid; v_conversation uuid:=p_conversation;
BEGIN
 SELECT * INTO b FROM businesses WHERE id=p_business FOR UPDATE;
 IF NOT FOUND OR b.owner_id IS NULL OR b.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'sms_business_unavailable'; END IF;
 SELECT * INTO r FROM tenant_sms_sends WHERE business_id=p_business AND idempotency_key=p_key;
 IF FOUND THEN
  IF r.fingerprint<>p_fingerprint THEN RAISE EXCEPTION 'sms_idempotency_conflict'; END IF;
  RETURN jsonb_build_object('send',false,'reservation',to_jsonb(r));
 END IF;
 IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 200 OR p_fingerprint IS NULL OR p_parts NOT BETWEEN 1 AND 100
  OR p_from !~ '^\+[1-9][0-9]{7,14}$' OR p_to !~ '^\+[1-9][0-9]{7,14}$'
  OR p_purpose NOT IN ('manual_dashboard_send','ai_reply','mms_fallback','missed_call','voice_followup','review_invitation','review_reminder','review_reply') THEN RAISE EXCEPTION 'sms_payload_invalid'; END IF;
 IF b.operations_suspended_at IS NOT NULL OR b.texting_paused_at IS NOT NULL OR b.telnyx_submission_disabled THEN RAISE EXCEPTION 'sms_operations_paused'; END IF;
 IF b.telnyx_messaging_profile_id IS DISTINCT FROM p_profile OR b.campaign_status IS DISTINCT FROM 'approved'
  OR NOT EXISTS(SELECT 1 FROM phone_numbers WHERE business_id=p_business AND phone_number=p_from AND is_active
    AND telnyx_campaign_assignment_status='assigned' AND telnyx_campaign_assignment_campaign_id=b.telnyx_campaign_id)
 THEN RAISE EXCEPTION 'sms_sender_unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM tenant_sms_suppressions WHERE business_id=p_business AND messaging_profile_id=p_profile AND destination=p_to) THEN RAISE EXCEPTION 'sms_recipient_opted_out'; END IF;
 v_plan:=tenant_sms_service_plan(p_business);
 v_review:=p_purpose IN ('review_invitation','review_reminder','review_reply');
 IF v_review THEN
  IF to_regprocedure('public.has_review_sms_access(uuid)') IS NOT NULL THEN
   EXECUTE 'SELECT public.has_review_sms_access($1),public.review_sms_allowance($1)' INTO v_access,v_extra USING p_business;
  END IF;
  IF NOT coalesce(v_access,false) THEN RAISE EXCEPTION 'sms_reviews_not_entitled'; END IF;
  IF EXISTS(SELECT 1 FROM review_suppressions WHERE business_id=p_business AND identity='phone:'||p_to) THEN RAISE EXCEPTION 'sms_recipient_opted_out'; END IF;
 ELSE
  IF v_plan IS NULL OR v_plan='chat_only' OR (p_purpose IN ('ai_reply','mms_fallback','voice_followup') AND v_plan NOT IN ('sms_and_chat','full')) THEN RAISE EXCEPTION 'sms_plan_not_entitled'; END IF;
  IF p_purpose IN ('ai_reply','mms_fallback','voice_followup') AND b.ai_replies_paused_at IS NOT NULL THEN RAISE EXCEPTION 'sms_ai_paused'; END IF;
 END IF;
 IF p_conversation IS NOT NULL AND NOT EXISTS(SELECT 1 FROM conversations c JOIN contacts t ON t.id=c.contact_id AND t.business_id=c.business_id WHERE c.id=p_conversation AND c.business_id=p_business AND c.channel='sms' AND (lead_normalize_phone(t.phone_number)=p_to OR lead_normalize_phone(t.provided_phone_number)=p_to)) THEN RAISE EXCEPTION 'sms_conversation_mismatch'; END IF;
 IF p_purpose IN ('ai_reply','mms_fallback','missed_call') AND EXISTS(SELECT 1 FROM tenant_sms_human_holds WHERE business_id=p_business AND messaging_profile_id=p_profile AND destination=p_to AND released_at IS NULL) THEN RAISE EXCEPTION 'sms_review_human_hold'; END IF;
 IF p_purpose IN ('ai_reply','mms_fallback') AND (p_conversation IS NULL OR NOT EXISTS(SELECT 1 FROM conversations WHERE id=p_conversation AND is_ai_handling AND status='active')) THEN RAISE EXCEPTION 'sms_human_handling'; END IF;
 IF p_purpose='review_reply' THEN
  IF p_conversation IS NULL OR NOT EXISTS(SELECT 1 FROM tenant_sms_human_holds WHERE business_id=p_business AND messaging_profile_id=p_profile AND destination=p_to AND conversation_id=p_conversation AND released_at IS NULL) THEN RAISE EXCEPTION 'sms_review_reply_unavailable'; END IF;
 ELSIF v_review THEN
  SELECT * INTO e FROM review_enrollments WHERE id=p_enrollment AND business_id=p_business AND channel='sms' AND destination=p_to AND status='active' AND stopped_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'sms_review_enrollment_unavailable'; END IF;
  IF NOT review_program_enabled(p_business) OR NOT EXISTS(SELECT 1 FROM review_settings WHERE business_id=p_business AND NOT paused) OR NOT EXISTS(SELECT 1 FROM review_email_control ctl WHERE singleton AND coalesce((to_jsonb(ctl)->>'sms_sending_enabled')::boolean,false)) THEN RAISE EXCEPTION 'sms_reviews_paused'; END IF;
  IF NOT EXISTS(SELECT 1 FROM review_permissions WHERE business_id=p_business AND contact_id=e.original_contact_id AND destination=p_to AND revoked_at IS NULL) THEN RAISE EXCEPTION 'sms_review_permission_missing'; END IF;
  IF EXISTS(SELECT 1 FROM review_suppressions WHERE business_id=p_business AND (identity='phone:'||p_to OR (identity LIKE 'phone:%' AND identity=ANY(e.identities)))) THEN RAISE EXCEPTION 'sms_recipient_opted_out'; END IF;
  SELECT id INTO v_contact FROM contacts WHERE business_id=p_business AND phone_number=p_to;
  IF v_contact IS NULL THEN SELECT id INTO v_contact FROM contacts WHERE id=e.contact_id AND business_id=p_business AND (lead_normalize_phone(phone_number)=p_to OR lead_normalize_phone(provided_phone_number)=p_to); END IF;
  IF v_contact IS NULL THEN RAISE EXCEPTION 'sms_review_identity_changed'; END IF;
  INSERT INTO conversations(business_id,contact_id,channel,status,is_ai_handling) VALUES(p_business,v_contact,'sms','handed_off',false)
   ON CONFLICT(business_id,contact_id,channel) WHERE status<>'closed' DO UPDATE SET is_ai_handling=false,status='handed_off' RETURNING id INTO v_conversation;
  INSERT INTO tenant_sms_human_holds(business_id,messaging_profile_id,destination,conversation_id)
   VALUES(p_business,p_profile,p_to,v_conversation) ON CONFLICT(business_id,messaging_profile_id,destination)
   DO UPDATE SET conversation_id=excluded.conversation_id,released_at=NULL;
 END IF;
 SELECT * INTO u FROM billing_usage_periods WHERE id=p_period AND business_id=p_business FOR UPDATE;
 -- Legacy active/trialing/past_due SMS keeps its existing recorded period;
 -- review sends require a current paid window and never borrow future usage.
 IF NOT FOUND OR (v_review AND u.period_end<=now()) OR u.period_start>now() THEN RAISE EXCEPTION 'sms_usage_period_unavailable'; END IF;
 SELECT coalesce(sum(sms_parts),0) INTO v_reserved FROM tenant_sms_sends WHERE usage_period_id=p_period AND status IN ('submitting','uncertain');
 v_overage:=NOT v_review AND (EXISTS(SELECT 1 FROM subscriptions WHERE business_id=p_business) OR b.billing_mode='stripe') AND (b.sms_overage_opt_in OR (NOT EXISTS(SELECT 1 FROM subscriptions WHERE business_id=p_business) AND (b.billing_comped OR b.billing_exempt OR b.billing_pilot)));
 IF u.inbound_sms_parts+u.outbound_sms_parts+v_reserved+p_parts>u.included_sms_parts+v_extra AND NOT v_overage THEN RAISE EXCEPTION 'sms_usage_limit_reached'; END IF;
 INSERT INTO tenant_sms_sends(business_id,usage_period_id,idempotency_key,fingerprint,purpose,messaging_profile_id,sender,destination,sms_parts,conversation_id,review_enrollment_id)
  VALUES(p_business,p_period,p_key,p_fingerprint,p_purpose,p_profile,p_from,p_to,p_parts,v_conversation,p_enrollment) RETURNING * INTO r;
 RETURN jsonb_build_object('send',true,'reservation',to_jsonb(r));
END $$;

CREATE FUNCTION public.settle_tenant_sms(p_id uuid,p_outcome text,p_provider_id text DEFAULT NULL,p_delivery_status text DEFAULT NULL,p_reason text DEFAULT NULL)
RETURNS public.tenant_sms_sends LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r tenant_sms_sends;
BEGIN
 SELECT * INTO r FROM tenant_sms_sends WHERE id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'sms_reservation_not_found'; END IF;
 PERFORM 1 FROM businesses WHERE id=r.business_id FOR UPDATE;
 PERFORM 1 FROM billing_usage_periods WHERE id=r.usage_period_id FOR UPDATE;
 SELECT * INTO r FROM tenant_sms_sends WHERE id=p_id FOR UPDATE;
 IF p_outcome NOT IN ('accepted','not_sent','uncertain') OR (p_outcome='accepted' AND nullif(p_provider_id,'') IS NULL) THEN RAISE EXCEPTION 'sms_outcome_invalid'; END IF;
 IF r.provider_message_id IS NOT NULL AND p_provider_id IS NOT NULL AND r.provider_message_id<>p_provider_id THEN RAISE EXCEPTION 'sms_provider_identity_conflict'; END IF;
 IF r.status='accepted' THEN
  -- Reordered receipts never reverse a final delivery status.
  UPDATE tenant_sms_sends SET delivery_status=CASE WHEN delivery_status IN ('delivered','delivery_failed','sending_failed','expired','cancelled') THEN delivery_status ELSE coalesce(p_delivery_status,delivery_status) END,updated_at=now() WHERE id=r.id RETURNING * INTO r;
  RETURN r;
 END IF;
 IF r.status='not_sent' AND p_outcome<>'accepted' THEN RETURN r; END IF;
 IF p_outcome='accepted' THEN
  PERFORM record_billing_usage_event(r.business_id,r.usage_period_id,'tenant-sms:'||r.id,'outbound','sms',r.purpose,r.sms_parts,0,p_provider_id,jsonb_build_object('reservationId',r.id));
 END IF;
 UPDATE tenant_sms_sends SET status=p_outcome,provider_message_id=coalesce(p_provider_id,provider_message_id),delivery_status=coalesce(p_delivery_status,delivery_status),failure_reason=p_reason,updated_at=now() WHERE id=r.id RETURNING * INTO r;
 RETURN r;
END $$;

CREATE FUNCTION public.tenant_sms_inbound(p_business uuid,p_profile text,p_phone text,p_text text,p_conversation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE k text; held boolean; b businesses;
BEGIN
 SELECT * INTO b FROM businesses WHERE id=p_business FOR UPDATE;
 IF NOT FOUND OR b.telnyx_messaging_profile_id IS DISTINCT FROM p_profile OR p_phone !~ '^\+[1-9][0-9]{7,14}$'
  OR NOT EXISTS(SELECT 1 FROM conversations c JOIN contacts t ON t.id=c.contact_id AND t.business_id=c.business_id WHERE c.id=p_conversation AND c.business_id=p_business AND c.channel='sms' AND t.phone_number=p_phone) THEN RAISE EXCEPTION 'sms_inbound_identity_invalid'; END IF;
 k:=CASE WHEN upper(btrim(p_text)) IN ('STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT','REVOKE','OPT OUT') THEN 'stop' WHEN upper(btrim(p_text)) IN ('START','UNSTOP') THEN 'start' ELSE NULL END;
 IF k='stop' THEN
  INSERT INTO tenant_sms_suppressions(business_id,messaging_profile_id,destination) VALUES(p_business,p_profile,p_phone) ON CONFLICT(business_id,messaging_profile_id,destination) DO UPDATE SET suppressed_at=now();
 ELSIF k='start' THEN
  DELETE FROM tenant_sms_suppressions WHERE business_id=p_business AND messaging_profile_id=p_profile AND destination=p_phone;
 END IF;
 SELECT EXISTS(SELECT 1 FROM tenant_sms_human_holds WHERE business_id=p_business AND messaging_profile_id=p_profile AND destination=p_phone AND released_at IS NULL) INTO held;
 IF held THEN
  UPDATE tenant_sms_human_holds SET conversation_id=p_conversation WHERE business_id=p_business AND messaging_profile_id=p_profile AND destination=p_phone AND released_at IS NULL;
  UPDATE conversations SET is_ai_handling=false,status='handed_off' WHERE id=p_conversation;
 END IF;
 IF k='stop' OR held THEN
  IF to_regprocedure('public.review_stop_sms_destination(uuid,text,text)') IS NOT NULL THEN
   EXECUTE 'SELECT public.review_stop_sms_destination($1,$2,$3)' USING p_business,p_phone,CASE WHEN k='stop' THEN 'sms_stop' ELSE 'sms_reply' END;
  ELSE
   PERFORM review_stop_enrollment(id,CASE WHEN k='stop' THEN 'sms_stop' ELSE 'sms_reply' END) FROM review_enrollments WHERE business_id=p_business AND channel='sms' AND destination=p_phone AND status='active';
  END IF;
 END IF;
 RETURN jsonb_build_object('reviewHeld',held,'keyword',k);
END $$;

CREATE FUNCTION public.guard_tenant_sms_human_hold() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.channel='sms' AND NEW.is_ai_handling AND EXISTS(SELECT 1 FROM tenant_sms_human_holds WHERE business_id=NEW.business_id AND conversation_id=NEW.id AND released_at IS NULL) THEN
  IF auth.role()='authenticated' AND EXISTS(SELECT 1 FROM businesses WHERE id=NEW.business_id AND owner_id=auth.uid() AND operations_suspended_at IS NULL AND ai_replies_paused_at IS NULL)
   AND tenant_sms_service_plan(NEW.business_id) IN ('sms_and_chat','full') THEN
   UPDATE tenant_sms_human_holds SET released_at=now() WHERE business_id=NEW.business_id AND conversation_id=NEW.id AND released_at IS NULL;
  ELSE RAISE EXCEPTION 'sms_review_human_hold'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_tenant_sms_human_hold BEFORE UPDATE OF is_ai_handling ON conversations FOR EACH ROW EXECUTE FUNCTION guard_tenant_sms_human_hold();

CREATE FUNCTION public.scrub_tenant_sms_after_owner_cleanup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.owner_id IS NOT NULL AND NEW.owner_id IS NULL THEN
  DELETE FROM tenant_sms_sends WHERE business_id=NEW.id;
  DELETE FROM tenant_sms_suppressions WHERE business_id=NEW.id;
  DELETE FROM tenant_sms_human_holds WHERE business_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER scrub_tenant_sms_after_owner_cleanup AFTER UPDATE OF owner_id ON businesses FOR EACH ROW EXECUTE FUNCTION scrub_tenant_sms_after_owner_cleanup();
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('tenant_sms_service_plan','reserve_tenant_sms','settle_tenant_sms','tenant_sms_inbound','guard_tenant_sms_human_hold','scrub_tenant_sms_after_owner_cleanup')
 LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature); EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature); END LOOP;
END $$;

-- Preserve migration-050 metric mirrors and their isolated failure handling.
CREATE OR REPLACE FUNCTION public.record_billing_usage_event(
  p_business_id uuid,
  p_usage_period_id uuid,
  p_idempotency_key text,
  p_direction text,
  p_channel text,
  p_source text,
  p_sms_parts integer,
  p_mms_events integer,
  p_provider_message_id text,
  p_metadata jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_inserted boolean;
  v_existing_usage_key text;
  v_event_id uuid;
  v_event_business_id uuid;
  v_event_direction text;
  v_event_channel text;
  v_event_sms_parts integer;
  v_event_mms_events integer;
  v_event_created_at timestamptz;
  v_event_partner_id_at_event uuid;
  v_event_partner_snapshot_captured boolean;
  v_event_attribution text;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = ''
     OR p_direction IS NULL OR p_direction NOT IN ('inbound', 'outbound')
     OR p_channel IS NULL OR p_channel NOT IN ('sms', 'mms')
     OR p_source IS NULL OR btrim(p_source) = ''
     OR p_sms_parts IS NULL OR p_sms_parts < 0
     OR p_mms_events IS NULL OR p_mms_events < 0 THEN
    RAISE EXCEPTION 'invalid billing usage event payload'
      USING ERRCODE = '22023';
  END IF;

  -- Serialize inbound usage with outbound reservations. Legacy bookkeeping
  -- keys may differ, but a provider SMS consumes allowance exactly once.
  PERFORM 1 FROM public.billing_usage_periods WHERE id=p_usage_period_id AND business_id=p_business_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'usage period does not belong to business' USING ERRCODE='23503'; END IF;
  IF p_direction='outbound' AND p_provider_message_id IS NOT NULL THEN
    SELECT idempotency_key INTO v_existing_usage_key FROM public.billing_usage_events
     WHERE business_id=p_business_id AND direction='outbound' AND provider_message_id=p_provider_message_id ORDER BY created_at,id LIMIT 1;
    -- Continue the existing duplicate path so failed metric mirrors still heal.
    IF FOUND THEN p_idempotency_key:=v_existing_usage_key; END IF;
  END IF;

  -- Capturing attribution is metric-only work. Resolve it through an ordinary
  -- MVCC read with no row lock and isolate every failure so authoritative
  -- usage insertion/counters retain their pre-050 behavior.
  v_event_partner_id_at_event := NULL;
  v_event_partner_snapshot_captured := false;
  BEGIN
    SELECT business.partner_id
    INTO v_event_partner_id_at_event
    FROM public.businesses AS business
    WHERE business.id = p_business_id;

    v_event_partner_snapshot_captured := FOUND;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'business metric partner snapshot failed for business %',
      p_business_id;
  END;

  INSERT INTO public.billing_usage_events (
    business_id,
    usage_period_id,
    idempotency_key,
    direction,
    channel,
    source,
    sms_parts,
    mms_events,
    provider_message_id,
    metadata,
    metric_partner_id_at_event,
    metric_partner_snapshot_captured
  ) VALUES (
    p_business_id,
    p_usage_period_id,
    p_idempotency_key,
    p_direction,
    p_channel,
    p_source,
    p_sms_parts,
    p_mms_events,
    p_provider_message_id,
    p_metadata,
    v_event_partner_id_at_event,
    v_event_partner_snapshot_captured
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING
    id,
    business_id,
    direction,
    channel,
    sms_parts,
    mms_events,
    created_at,
    metric_partner_id_at_event,
    metric_partner_snapshot_captured
  INTO
    v_event_id,
    v_event_business_id,
    v_event_direction,
    v_event_channel,
    v_event_sms_parts,
    v_event_mms_events,
    v_event_created_at,
    v_event_partner_id_at_event,
    v_event_partner_snapshot_captured;

  v_inserted := FOUND;

  IF v_inserted THEN
    UPDATE public.billing_usage_periods
    SET inbound_sms_parts = inbound_sms_parts
          + CASE WHEN p_direction = 'inbound' THEN p_sms_parts ELSE 0 END,
        outbound_sms_parts = outbound_sms_parts
          + CASE WHEN p_direction = 'outbound' THEN p_sms_parts ELSE 0 END,
        inbound_mms_events = inbound_mms_events
          + CASE WHEN p_direction = 'inbound' AND p_channel = 'mms'
              THEN p_mms_events ELSE 0 END,
        outbound_mms_events = outbound_mms_events
          + CASE WHEN p_direction = 'outbound' AND p_channel = 'mms'
              THEN p_mms_events ELSE 0 END,
        updated_at = now()
    WHERE id = p_usage_period_id
      AND business_id = p_business_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'usage period % does not belong to business %',
        p_usage_period_id, p_business_id
        USING ERRCODE = '23503';
    END IF;
  ELSE
    SELECT
      usage_event.id,
      usage_event.business_id,
      usage_event.direction,
      usage_event.channel,
      usage_event.sms_parts,
      usage_event.mms_events,
      usage_event.created_at,
      usage_event.metric_partner_id_at_event,
      usage_event.metric_partner_snapshot_captured
    INTO
      v_event_id,
      v_event_business_id,
      v_event_direction,
      v_event_channel,
      v_event_sms_parts,
      v_event_mms_events,
      v_event_created_at,
      v_event_partner_id_at_event,
      v_event_partner_snapshot_captured
    FROM public.billing_usage_events AS usage_event
    WHERE usage_event.idempotency_key = p_idempotency_key;

    IF NOT FOUND THEN
      RETURN false;
    END IF;
  END IF;

  BEGIN
    IF v_event_partner_snapshot_captured THEN
      v_event_attribution := 'event_time';
    ELSE
      SELECT business.partner_id
      INTO v_event_partner_id_at_event
      FROM public.businesses AS business
      WHERE business.id = v_event_business_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'metric business not found'
          USING ERRCODE = '23503';
      END IF;

      v_event_attribution := 'current_assignment_backfill';
    END IF;

    INSERT INTO public.business_metric_events (
      business_id,
      partner_id_at_event,
      metric_key,
      quantity,
      occurred_at,
      definition_version,
      attribution,
      source_key,
      origin
    ) VALUES (
      v_event_business_id,
      v_event_partner_id_at_event,
      'sms_message_' || v_event_direction,
      1,
      v_event_created_at,
      1,
      v_event_attribution,
      'billing-usage:' || v_event_id::text,
      NULL
    )
    ON CONFLICT (metric_key, source_key) DO NOTHING;

    IF v_event_sms_parts > 0 THEN
      INSERT INTO public.business_metric_events (
        business_id,
        partner_id_at_event,
        metric_key,
        quantity,
        occurred_at,
        definition_version,
        attribution,
        source_key,
        origin
      ) VALUES (
        v_event_business_id,
        v_event_partner_id_at_event,
        'sms_parts_' || v_event_direction,
        v_event_sms_parts,
        v_event_created_at,
        1,
        v_event_attribution,
        'billing-usage:' || v_event_id::text,
        NULL
      )
      ON CONFLICT (metric_key, source_key) DO NOTHING;
    END IF;

    IF v_event_mms_events > 0 THEN
      INSERT INTO public.business_metric_events (
        business_id,
        partner_id_at_event,
        metric_key,
        quantity,
        occurred_at,
        definition_version,
        attribution,
        source_key,
        origin
      ) VALUES (
        v_event_business_id,
        v_event_partner_id_at_event,
        'mms_event_' || v_event_direction,
        v_event_mms_events,
        v_event_created_at,
        1,
        v_event_attribution,
        'billing-usage:' || v_event_id::text,
        NULL
      )
      ON CONFLICT (metric_key, source_key) DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'business metric mirror failed for business % direction %',
      v_event_business_id,
      v_event_direction;
  END;

  RETURN v_inserted;
END;
$$;
