-- A signed inbound REVIEWS message is separate from customer-care opt-in.
-- Only the service webhook may grant this permission; browser requests cannot.
CREATE TABLE public.review_sms_consent_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 provider_message_id text NOT NULL CHECK(length(provider_message_id) BETWEEN 1 AND 150),
 source_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
 conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
 messaging_profile_id text NOT NULL,
 sender text NOT NULL, destination text NOT NULL,
 keyword text NOT NULL DEFAULT 'REVIEWS' CHECK(keyword='REVIEWS'),
 copy_version text NOT NULL CHECK(copy_version='review-texts-v1'),
 business_name text NOT NULL, consent_path text NOT NULL,
 occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 outcome text NOT NULL CHECK(outcome IN ('granted','blocked')),
 blocked_reason text,
 UNIQUE(business_id,provider_message_id)
);
ALTER TABLE public.review_sms_consent_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.review_sms_consent_events FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,DELETE ON public.review_sms_consent_events TO service_role;
ALTER TABLE public.review_permissions ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE public.review_permissions ADD COLUMN sms_consent_event_id uuid REFERENCES public.review_sms_consent_events(id) ON DELETE SET NULL;

CREATE FUNCTION public.review_record_sms_consent(
 p_business uuid,p_profile text,p_from text,p_to text,p_conversation uuid,
 p_source_message uuid,p_provider_message text,p_occurred_at timestamptz,p_copy_version text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b businesses; a review_sms_accounts; e review_sms_consent_events; v_reason text;
BEGIN
 SELECT * INTO b FROM businesses WHERE id=p_business FOR UPDATE;
 IF NOT FOUND OR b.owner_id IS NULL OR b.deleted_at IS NOT NULL OR b.operations_suspended_at IS NOT NULL
  OR b.texting_paused_at IS NOT NULL OR b.telnyx_submission_disabled OR b.active_telnyx_release_run_id IS NOT NULL
  OR NOT review_program_enabled(p_business) THEN RETURN jsonb_build_object('granted',false,'canConfirm',false); END IF;
 IF p_from IS NULL OR p_to IS NULL OR p_from !~ '^\+[1-9][0-9]{7,14}$' OR p_to !~ '^\+[1-9][0-9]{7,14}$'
  OR p_profile IS DISTINCT FROM b.telnyx_messaging_profile_id OR nullif(p_profile,'') IS NULL
  OR p_provider_message IS NULL OR length(p_provider_message) NOT BETWEEN 1 AND 150
  OR p_copy_version IS DISTINCT FROM 'review-texts-v1' OR p_occurred_at IS NULL OR p_occurred_at>now()+interval '5 minutes'
  OR NOT EXISTS(SELECT 1 FROM messages m JOIN conversations c ON c.id=m.conversation_id
    JOIN contacts t ON t.id=c.contact_id AND t.business_id=c.business_id
    WHERE m.id=p_source_message AND m.business_id=p_business AND m.conversation_id=p_conversation
     AND m.channel='sms' AND m.role='customer' AND upper(btrim(m.content))='REVIEWS'
     AND c.business_id=p_business AND c.channel='sms' AND t.phone_number=p_from)
 THEN RAISE EXCEPTION 'review_sms_consent_identity_invalid'; END IF;
 SELECT * INTO a FROM review_sms_accounts WHERE business_id=p_business;
 IF NOT FOUND OR a.owner_id<>b.owner_id OR a.state NOT IN ('ready_unpaid','active','cancel_pending')
  OR a.review_usecase_approved_at IS NULL OR nullif(a.approval_evidence,'') IS NULL
  OR a.campaign_id IS DISTINCT FROM b.telnyx_campaign_id OR a.messaging_profile_id IS DISTINCT FROM p_profile
  OR b.campaign_status IS DISTINCT FROM 'approved'
  OR NOT EXISTS(SELECT 1 FROM phone_numbers WHERE id=a.phone_number_id AND business_id=p_business
    AND phone_number=p_to AND is_active AND telnyx_campaign_assignment_status='assigned'
    AND telnyx_campaign_assignment_campaign_id=a.campaign_id)
 THEN RETURN jsonb_build_object('granted',false,'canConfirm',false); END IF;
 SELECT * INTO e FROM review_sms_consent_events WHERE business_id=p_business AND provider_message_id=p_provider_message;
 IF FOUND THEN
  IF e.destination<>p_from OR e.sender<>p_to OR e.messaging_profile_id<>p_profile OR e.copy_version<>p_copy_version THEN RAISE EXCEPTION 'review_sms_consent_replay_mismatch'; END IF;
  -- A provider replay can recover confirmation delivery, never re-grant a
  -- permission revoked after the original message.
  RETURN jsonb_build_object('granted',e.outcome='granted','businessName',e.business_name,'canConfirm',has_review_sms_access(p_business)
   AND NOT EXISTS(SELECT 1 FROM tenant_sms_suppressions WHERE business_id=p_business AND messaging_profile_id=p_profile AND destination=p_from)
   AND NOT EXISTS(SELECT 1 FROM review_suppressions WHERE business_id=p_business AND identity='phone:'||p_from)
   AND EXISTS(SELECT 1 FROM review_permissions WHERE business_id=p_business AND destination=p_from AND sms_consent_event_id=e.id AND revoked_at IS NULL));
 END IF;
 IF p_occurred_at<now()-interval '24 hours' THEN v_reason:='stale_message';
 ELSIF EXISTS(SELECT 1 FROM tenant_sms_suppressions WHERE business_id=p_business AND messaging_profile_id=p_profile AND destination=p_from) THEN v_reason:='sms_stopped';
 ELSIF EXISTS(SELECT 1 FROM review_suppressions WHERE business_id=p_business AND identity='phone:'||p_from AND (reason NOT IN ('sms_stop','stop') OR suppressed_at>=p_occurred_at)) THEN v_reason:='review_suppressed';
 ELSIF EXISTS(SELECT 1 FROM review_permissions WHERE business_id=p_business AND destination=p_from AND revoked_at>=p_occurred_at) THEN v_reason:='permission_revoked_after_message'; END IF;
 INSERT INTO review_sms_consent_events(business_id,provider_message_id,source_message_id,conversation_id,messaging_profile_id,sender,destination,copy_version,business_name,consent_path,occurred_at,outcome,blocked_reason)
 VALUES(p_business,p_provider_message,p_source_message,p_conversation,p_profile,p_to,p_from,p_copy_version,b.name,'/c/'||b.slug||'/review-texts',p_occurred_at,CASE WHEN v_reason IS NULL THEN 'granted' ELSE 'blocked' END,v_reason) RETURNING * INTO e;
 IF v_reason IS NOT NULL THEN RETURN jsonb_build_object('granted',false,'canConfirm',false); END IF;
 -- Only an explicit new REVIEWS after START may clear an earlier SMS STOP.
 -- Other suppression reasons remain authoritative and cannot be bypassed.
 DELETE FROM review_suppressions WHERE business_id=p_business AND identity='phone:'||p_from AND reason IN ('sms_stop','stop') AND suppressed_at<p_occurred_at;
 INSERT INTO review_permissions(business_id,contact_id,destination,granted_at,actor_id,evidence,revoked_at,sms_consent_event_id)
 SELECT p_business,c.id,p_from,p_occurred_at,NULL,'Customer sent REVIEWS from their phone; disclosure '||p_copy_version||'; provider message '||p_provider_message,NULL,e.id
 FROM contacts c WHERE c.business_id=p_business AND review_contact_destination(c,'sms')=p_from
 ON CONFLICT(business_id,contact_id,destination) DO UPDATE SET granted_at=excluded.granted_at,actor_id=NULL,evidence=excluded.evidence,revoked_at=NULL,sms_consent_event_id=excluded.sms_consent_event_id;
 -- Permission alone neither enrolls a campaign nor sends a review request.
 RETURN jsonb_build_object('granted',true,'canConfirm',has_review_sms_access(p_business),'businessName',b.name);
END $$;
REVOKE ALL ON FUNCTION public.review_record_sms_consent(uuid,text,text,text,uuid,uuid,text,timestamptz,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.review_record_sms_consent(uuid,text,text,text,uuid,uuid,text,timestamptz,text) TO service_role;

CREATE FUNCTION public.scrub_review_sms_consent_after_owner_cleanup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.owner_id IS NOT NULL AND NEW.owner_id IS NULL THEN DELETE FROM review_sms_consent_events WHERE business_id=NEW.id; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER scrub_review_sms_consent_after_owner_cleanup AFTER UPDATE OF owner_id ON public.businesses FOR EACH ROW EXECUTE FUNCTION public.scrub_review_sms_consent_after_owner_cleanup();
REVOKE ALL ON FUNCTION public.scrub_review_sms_consent_after_owner_cleanup() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.scrub_review_sms_consent_after_owner_cleanup() TO service_role;

ALTER TABLE public.tenant_sms_sends DROP CONSTRAINT tenant_sms_sends_purpose_check;
ALTER TABLE public.tenant_sms_sends ADD CONSTRAINT tenant_sms_sends_purpose_check CHECK(purpose IN ('manual_dashboard_send','ai_reply','mms_fallback','missed_call','voice_followup','review_invitation','review_reminder','review_reply','review_consent_confirmation'));
CREATE OR REPLACE FUNCTION public.reserve_tenant_sms(p_business uuid,p_period uuid,p_key text,p_fingerprint text,p_purpose text,
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
  OR p_purpose NOT IN ('manual_dashboard_send','ai_reply','mms_fallback','missed_call','voice_followup','review_invitation','review_reminder','review_reply','review_consent_confirmation') THEN RAISE EXCEPTION 'sms_payload_invalid'; END IF;
 IF b.operations_suspended_at IS NOT NULL OR b.texting_paused_at IS NOT NULL OR b.telnyx_submission_disabled THEN RAISE EXCEPTION 'sms_operations_paused'; END IF;
 IF b.telnyx_messaging_profile_id IS DISTINCT FROM p_profile OR b.campaign_status IS DISTINCT FROM 'approved'
  OR NOT EXISTS(SELECT 1 FROM phone_numbers WHERE business_id=p_business AND phone_number=p_from AND is_active
    AND telnyx_campaign_assignment_status='assigned' AND telnyx_campaign_assignment_campaign_id=b.telnyx_campaign_id)
 THEN RAISE EXCEPTION 'sms_sender_unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM tenant_sms_suppressions WHERE business_id=p_business AND messaging_profile_id=p_profile AND destination=p_to) THEN RAISE EXCEPTION 'sms_recipient_opted_out'; END IF;
 v_plan:=tenant_sms_service_plan(p_business);
 v_review:=p_purpose IN ('review_invitation','review_reminder','review_reply','review_consent_confirmation');
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
 IF p_purpose='review_consent_confirmation' THEN
  IF NOT review_program_enabled(p_business) OR NOT EXISTS(SELECT 1 FROM review_email_control WHERE singleton AND sms_sending_enabled) THEN RAISE EXCEPTION 'sms_reviews_paused'; END IF;
  IF p_enrollment IS NOT NULL OR p_conversation IS NULL OR NOT EXISTS(
   SELECT 1 FROM review_sms_consent_events ce
   WHERE ce.business_id=p_business AND ce.destination=p_to AND ce.sender=p_from
    AND ce.messaging_profile_id=p_profile AND ce.conversation_id=p_conversation
    AND ce.outcome='granted' AND p_key='review-consent/v1/'||ce.provider_message_id
    AND ce.occurred_at>now()-interval '24 hours'
    AND EXISTS(SELECT 1 FROM review_permissions rp WHERE rp.business_id=ce.business_id AND rp.destination=ce.destination AND rp.revoked_at IS NULL)
  ) THEN RAISE EXCEPTION 'sms_review_consent_unavailable'; END IF;
 ELSIF p_purpose='review_reply' THEN
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
   ON CONFLICT(business_id,contact_id,channel) WHERE status<>'closed' AND channel<>'voice' DO UPDATE SET is_ai_handling=false,status='handed_off' RETURNING id INTO v_conversation;
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
