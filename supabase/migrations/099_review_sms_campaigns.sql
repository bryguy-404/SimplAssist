-- SMS joins the same customer/cooldown ledger. One enrollment always has one
-- selected channel; there is no automatic fallback from either channel.
ALTER TABLE public.review_campaigns ADD COLUMN channel text NOT NULL DEFAULT 'email' CHECK(channel IN ('email','sms'));
ALTER TABLE public.review_settings ADD COLUMN sms_body text NOT NULL DEFAULT 'Thank you for choosing {{business_name}}. Would you share an honest Google review?';
ALTER TABLE public.review_email_control ADD COLUMN sms_sending_enabled boolean NOT NULL DEFAULT false;
CREATE TABLE public.review_sms_outbox (
 id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 owner_id uuid NOT NULL REFERENCES auth.users(id), enrollment_id uuid NOT NULL REFERENCES public.review_enrollments(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('initial','reminder')), destination text NOT NULL,
 sender text NOT NULL, messaging_profile_id text NOT NULL, body text NOT NULL, reminder_body text,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','submitting','accepted','delivered','failed','unknown','cancelled','needs_reschedule','expired')),
 scheduled_at timestamptz NOT NULL,next_attempt_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 claim_token uuid,lease_until timestamptz,first_attempt_at timestamptz,provider_message_id text UNIQUE,
 reservation_id uuid,accepted_at timestamptz,delivered_at timestamptz,last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(enrollment_id,kind)
);
CREATE INDEX review_sms_outbox_due_idx ON public.review_sms_outbox(next_attempt_at) WHERE status IN ('pending','claimed','submitting');
ALTER TABLE public.review_sms_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.review_sms_outbox FROM anon,authenticated;
GRANT ALL ON public.review_sms_outbox TO service_role;
CREATE OR REPLACE FUNCTION public.review_recipient_block(p_business uuid,p_contact uuid,p_destination text,p_identities text[],p_exclude uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c contacts; v_ids text[];
BEGIN
 SELECT * INTO c FROM contacts WHERE id=p_contact AND business_id=p_business;
 IF NOT FOUND OR NOT (coalesce(lower(trim(c.email))=p_destination,false) OR coalesce(lead_normalize_phone(c.phone_number)=p_destination,false) OR coalesce(lead_normalize_phone(c.provided_phone_number)=p_destination,false)) THEN RETURN 'customer_changed'; END IF;
 SELECT array_agg(DISTINCT identity) INTO v_ids FROM (
  SELECT CASE WHEN raw_identity LIKE 'phone:%' THEN 'phone:'||lead_normalize_phone(substring(raw_identity FROM 7)) ELSE raw_identity END identity FROM unnest(p_identities) raw_identity
  UNION SELECT CASE WHEN identity LIKE 'phone:%' THEN 'phone:'||lead_normalize_phone(substring(identity FROM 7)) ELSE identity END FROM review_identity_history WHERE business_id=p_business AND contact_id=p_contact
  UNION SELECT 'email:'||lower(trim(c.email)) WHERE c.email IS NOT NULL
  UNION SELECT 'phone:'||lead_normalize_phone(c.phone_number)
  UNION SELECT 'phone:'||lead_normalize_phone(c.provided_phone_number)
 ) all_identities WHERE identity IS NOT NULL;
 IF EXISTS(SELECT 1 FROM review_suppressions WHERE business_id=p_business AND identity=ANY(v_ids) AND identity LIKE CASE WHEN p_destination LIKE '%@%' THEN 'email:%' ELSE 'phone:%' END) THEN RETURN 'suppressed'; END IF;
 IF EXISTS(SELECT 1 FROM review_permissions WHERE business_id=p_business AND contact_id=p_contact AND destination=p_destination AND revoked_at IS NOT NULL) THEN RETURN 'permission_revoked'; END IF;
 IF EXISTS(SELECT 1 FROM review_enrollments e WHERE e.business_id=p_business AND e.id IS DISTINCT FROM p_exclude
  AND (e.original_contact_id=p_contact OR e.identities && v_ids)
  AND (e.accepted_at>now()-interval '90 days'
   OR EXISTS(SELECT 1 FROM review_email_outbox o WHERE o.enrollment_id=e.id AND o.status IN ('pending','claimed','submitting','unknown'))
   OR EXISTS(SELECT 1 FROM review_sms_outbox o WHERE o.enrollment_id=e.id AND o.status IN ('pending','claimed','submitting','unknown')))) THEN RETURN 'cooldown'; END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION public.review_confirm_sms_campaign(p_preview uuid,p_business uuid,p_owner uuid,p_deliveries jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE p review_campaign_previews;s review_settings;a review_sms_accounts;pn phone_numbers;item jsonb;d jsonb;v_ids text[];v_block text;v_count integer;
BEGIN
 PERFORM review_assert_owner(p_business,p_owner);
 SELECT * INTO p FROM review_campaign_previews WHERE id=p_preview AND business_id=p_business AND owner_id=p_owner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'review_preview_missing' USING ERRCODE='22023'; END IF;
 IF p.campaign_id IS NOT NULL THEN RETURN p.campaign_id; END IF;
 IF p.expires_at<=now() OR p.snapshot->>'channel' IS DISTINCT FROM 'sms' THEN RAISE EXCEPTION 'review_preview_expired' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM review_settings WHERE business_id=p_business;
 IF NOT review_program_enabled(p_business) OR s.paused OR s.revision<>p.settings_revision OR NOT has_review_sms_access(p_business) THEN RAISE EXCEPTION 'review_settings_or_eligibility_changed' USING ERRCODE='22023'; END IF;
 SELECT * INTO a FROM review_sms_accounts WHERE business_id=p_business;
 SELECT * INTO pn FROM phone_numbers WHERE id=a.phone_number_id AND is_active;
 IF pn.phone_number IS DISTINCT FROM p.snapshot->>'smsSender' OR a.messaging_profile_id IS DISTINCT FROM p.snapshot->>'smsMessagingProfileId' THEN RAISE EXCEPTION 'review_sms_sender_changed' USING ERRCODE='22023'; END IF;
 v_count:=jsonb_array_length(p.snapshot->'recipients');
 IF v_count<1 OR v_count>500 OR jsonb_array_length(p_deliveries)<>v_count THEN RAISE EXCEPTION 'invalid_review_audience' USING ERRCODE='22023'; END IF;
 INSERT INTO review_campaigns(id,business_id,owner_id,subject,body,reminder_enabled,scheduled_at,completed_service_attested_at,permission_attested_at,audience_count,summary,channel)
 VALUES(p.id,p_business,p_owner,p.snapshot->>'subject',p.snapshot->>'body',(p.snapshot->>'reminderEnabled')::boolean,(p.snapshot->>'scheduledAt')::timestamptz,now(),now(),v_count,p.snapshot->'summary','sms');
 FOR item IN SELECT * FROM jsonb_array_elements(p.snapshot->'recipients') LOOP
  SELECT array_agg(DISTINCT normalized) INTO v_ids FROM (
   SELECT CASE WHEN value LIKE 'phone:%' THEN 'phone:'||lead_normalize_phone(substring(value FROM 7)) ELSE value END normalized
   FROM jsonb_array_elements_text(item->'identities')
  ) recipient_identities WHERE normalized IS NOT NULL;
  v_block:=review_recipient_block(p_business,(item->>'contactId')::uuid,item->>'phone',v_ids);
  IF v_block IS NOT NULL THEN RAISE EXCEPTION 'review_audience_changed:%',v_block USING ERRCODE='22023'; END IF;
  SELECT value INTO d FROM jsonb_array_elements(p_deliveries) WHERE value->>'enrollmentId'=item->>'enrollmentId';
  IF d IS NULL THEN RAISE EXCEPTION 'invalid_review_payload' USING ERRCODE='22023'; END IF;
  INSERT INTO review_enrollments(id,business_id,campaign_id,contact_id,original_contact_id,identities,destination,channel,google_review_url,timezone)
   VALUES((item->>'enrollmentId')::uuid,p_business,p.id,(item->>'contactId')::uuid,(item->>'contactId')::uuid,v_ids,item->>'phone','sms',p.snapshot->>'googleReviewUrl',item->>'timezone');
  INSERT INTO review_identity_history(business_id,contact_id,identity) SELECT p_business,(item->>'contactId')::uuid,unnest(v_ids) ON CONFLICT DO NOTHING;
  INSERT INTO review_permissions(business_id,contact_id,destination,granted_at,actor_id,evidence)
   VALUES(p_business,(item->>'contactId')::uuid,item->>'phone',now(),p_owner,'Owner confirmed completed service and documented permission to receive review requests by text')
   ON CONFLICT(business_id,contact_id,destination) DO NOTHING;
  INSERT INTO review_sms_outbox(id,business_id,owner_id,enrollment_id,kind,destination,sender,messaging_profile_id,body,reminder_body,scheduled_at,next_attempt_at,expires_at)
   VALUES((d->>'id')::uuid,p_business,p_owner,(item->>'enrollmentId')::uuid,'initial',item->>'phone',pn.phone_number,a.messaging_profile_id,d->>'body',CASE WHEN (p.snapshot->>'reminderEnabled')::boolean THEN d->>'reminderBody' ELSE NULL END,(item->>'scheduledAt')::timestamptz,(item->>'scheduledAt')::timestamptz,(item->>'scheduledAt')::timestamptz+interval '24 hours');
 END LOOP;
 UPDATE review_campaign_previews SET campaign_id=p.id WHERE id=p_preview;
 RETURN p.id;
END $$;
CREATE FUNCTION public.review_cancel_sms_on_stop() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NEW.status<>'active' THEN UPDATE review_sms_outbox SET status='cancelled',last_error=NEW.stop_reason,claim_token=NULL,lease_until=NULL,updated_at=now() WHERE enrollment_id=NEW.id AND status IN ('pending','claimed','needs_reschedule'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER review_cancel_sms_on_stop AFTER UPDATE OF status ON public.review_enrollments FOR EACH ROW EXECUTE FUNCTION public.review_cancel_sms_on_stop();
CREATE FUNCTION public.review_stop_sms_destination(p_business uuid,p_phone text,p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r record;
BEGIN
 PERFORM 1 FROM businesses WHERE id=p_business FOR UPDATE;
 IF p_reason IN ('stop','sms_stop','opt_out','unsubscribe') THEN
  INSERT INTO review_suppressions(business_id,identity,reason) VALUES(p_business,'phone:'||p_phone,p_reason) ON CONFLICT DO NOTHING;
  UPDATE review_permissions SET revoked_at=coalesce(revoked_at,now()) WHERE business_id=p_business AND destination=p_phone;
 END IF;
 FOR r IN SELECT id FROM review_enrollments WHERE business_id=p_business AND channel='sms' AND destination=p_phone AND status='active' LOOP PERFORM review_stop_enrollment(r.id,p_reason); END LOOP;
END $$;
CREATE FUNCTION public.review_claim_sms(p_limit integer DEFAULT 2) RETURNS SETOF public.review_sms_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 UPDATE review_sms_outbox SET status='pending',claim_token=NULL,lease_until=NULL WHERE status='claimed' AND lease_until<now();
 UPDATE review_sms_outbox SET status='unknown',last_error='submission_lease_expired',claim_token=NULL,lease_until=NULL WHERE status='submitting' AND lease_until<now();
 UPDATE review_sms_outbox SET status=CASE WHEN kind='initial' THEN 'needs_reschedule' ELSE 'expired' END,last_error='schedule_stale' WHERE status='pending' AND expires_at<=now();
 UPDATE review_enrollments e SET status='needs_reschedule' WHERE status='active' AND EXISTS(SELECT 1 FROM review_sms_outbox o WHERE o.enrollment_id=e.id AND o.kind='initial' AND o.status='needs_reschedule');
 RETURN QUERY WITH picked AS(SELECT o.id FROM review_sms_outbox o WHERE o.status='pending' AND o.next_attempt_at<=now() AND review_program_enabled(o.business_id) AND (SELECT sms_sending_enabled FROM review_email_control WHERE singleton) ORDER BY o.next_attempt_at FOR UPDATE SKIP LOCKED LIMIT greatest(0,least(p_limit,5)))
 UPDATE review_sms_outbox o SET status='claimed',claim_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',updated_at=now() FROM picked WHERE o.id=picked.id RETURNING o.*;
END $$;
CREATE FUNCTION public.review_begin_sms(p_id uuid,p_claim uuid) RETURNS public.review_sms_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE o review_sms_outbox;e review_enrollments;s review_settings;a review_sms_accounts;b businesses;v_hour integer;v_next timestamptz;v_block text;
BEGIN
 SELECT * INTO o FROM review_sms_outbox WHERE id=p_id;IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO b FROM businesses WHERE id=o.business_id FOR UPDATE;
 SELECT * INTO o FROM review_sms_outbox WHERE id=p_id FOR UPDATE;
 IF o.status<>'claimed' OR o.claim_token IS DISTINCT FROM p_claim OR o.lease_until<=now() THEN RETURN NULL; END IF;
 IF o.first_attempt_at IS NOT NULL THEN UPDATE review_sms_outbox SET status='unknown',last_error='resubmission_forbidden',claim_token=NULL,lease_until=NULL WHERE id=p_id;RETURN NULL;END IF;
 IF o.expires_at<=now() THEN UPDATE review_sms_outbox SET status=CASE WHEN kind='initial' THEN 'needs_reschedule' ELSE 'expired' END,last_error='schedule_stale',claim_token=NULL,lease_until=NULL WHERE id=p_id;RETURN NULL;END IF;
 SELECT * INTO s FROM review_settings WHERE business_id=o.business_id;
 IF NOT review_program_enabled(o.business_id) OR NOT (SELECT sms_sending_enabled FROM review_email_control WHERE singleton) OR NOT has_review_sms_access(o.business_id) OR s.paused THEN UPDATE review_sms_outbox SET status='pending',next_attempt_at=now()+interval '15 minutes',claim_token=NULL,lease_until=NULL WHERE id=p_id;RETURN NULL;END IF;
 SELECT * INTO e FROM review_enrollments WHERE id=o.enrollment_id;
 SELECT * INTO a FROM review_sms_accounts WHERE business_id=o.business_id;
 IF b.owner_id IS DISTINCT FROM o.owner_id OR e.status<>'active' OR e.contact_id IS NULL THEN v_block:='customer_unavailable'; END IF;
 v_block:=coalesce(v_block,review_recipient_block(o.business_id,e.contact_id,o.destination,e.identities,e.id));
 IF NOT EXISTS(SELECT 1 FROM review_permissions WHERE business_id=o.business_id AND contact_id=e.original_contact_id AND destination=o.destination AND revoked_at IS NULL) THEN v_block:='permission_missing'; END IF;
 IF a.messaging_profile_id IS DISTINCT FROM o.messaging_profile_id OR NOT EXISTS(SELECT 1 FROM phone_numbers WHERE id=a.phone_number_id AND phone_number=o.sender AND is_active) THEN v_block:='review_sms_sender_changed'; END IF;
 IF v_block IS NOT NULL THEN UPDATE review_sms_outbox SET status='cancelled',last_error=v_block,claim_token=NULL,lease_until=NULL WHERE id=p_id; RETURN NULL; END IF;
 v_hour:=extract(hour FROM now() AT TIME ZONE e.timezone);
 IF v_hour<9 OR v_hour>=18 THEN
  v_next:=(date_trunc('day',now() AT TIME ZONE e.timezone)+CASE WHEN v_hour>=18 THEN interval '1 day' ELSE interval '0 days' END+interval '9 hours') AT TIME ZONE e.timezone;
  UPDATE review_sms_outbox SET status='pending',next_attempt_at=v_next,claim_token=NULL,lease_until=NULL WHERE id=p_id;RETURN NULL;
 END IF;
 UPDATE review_sms_outbox SET status='submitting',first_attempt_at=now(),lease_until=now()+interval '2 minutes',updated_at=now() WHERE id=p_id RETURNING * INTO o;RETURN o;
END $$;
CREATE FUNCTION public.review_finish_sms(p_id uuid,p_claim uuid,p_outcome text,p_provider_id text DEFAULT NULL,p_reservation uuid DEFAULT NULL,p_error text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE o review_sms_outbox;e review_enrollments;v_next timestamptz;v_hour integer;
BEGIN
 SELECT * INTO o FROM review_sms_outbox WHERE id=p_id;IF NOT FOUND THEN RETURN;END IF;
 PERFORM 1 FROM businesses WHERE id=o.business_id FOR UPDATE;
 SELECT * INTO o FROM review_sms_outbox WHERE id=p_id FOR UPDATE;
 IF o.status NOT IN ('submitting','unknown') OR o.claim_token IS DISTINCT FROM p_claim THEN RETURN;END IF;
 IF p_outcome='accepted' AND p_provider_id IS NOT NULL THEN
  UPDATE review_sms_outbox SET status='accepted',provider_message_id=p_provider_id,reservation_id=p_reservation,accepted_at=now(),claim_token=NULL,lease_until=NULL WHERE id=p_id;
  INSERT INTO messages(business_id,conversation_id,role,channel,content,provider_event_id)
   SELECT o.business_id,t.conversation_id,'human_agent','sms',o.body,'tenant-sms:'||t.id::text
   FROM tenant_sms_sends t WHERE t.id=p_reservation AND t.business_id=o.business_id AND t.review_enrollment_id=o.enrollment_id AND t.conversation_id IS NOT NULL
   ON CONFLICT(provider_event_id) WHERE provider_event_id IS NOT NULL DO NOTHING;
  IF o.kind='initial' THEN
   UPDATE review_enrollments SET accepted_at=coalesce(accepted_at,now()) WHERE id=o.enrollment_id RETURNING * INTO e;
   IF o.reminder_body IS NOT NULL AND e.status='active' THEN
    v_next:=now()+interval '4 days';v_hour:=extract(hour FROM v_next AT TIME ZONE e.timezone);
    IF v_hour<9 OR v_hour>=18 THEN v_next:=(date_trunc('day',v_next AT TIME ZONE e.timezone)+CASE WHEN v_hour>=18 THEN interval '1 day' ELSE interval '0 days' END+interval '9 hours') AT TIME ZONE e.timezone;END IF;
    INSERT INTO review_sms_outbox(id,business_id,owner_id,enrollment_id,kind,destination,sender,messaging_profile_id,body,scheduled_at,next_attempt_at,expires_at)
     VALUES(gen_random_uuid(),o.business_id,o.owner_id,o.enrollment_id,'reminder',o.destination,o.sender,o.messaging_profile_id,o.reminder_body,v_next,v_next,v_next+interval '24 hours') ON CONFLICT(enrollment_id,kind) DO NOTHING;
   END IF;
  END IF;
 ELSIF p_outcome='deferred' THEN
  -- A storage timeout can hide a committed reservation. Only proof that no
  -- provider-boundary reservation exists permits a safe admission retry.
  IF NOT EXISTS(SELECT 1 FROM tenant_sms_sends WHERE business_id=o.business_id AND idempotency_key='review-sms/v1/'||o.id::text) THEN
   UPDATE review_sms_outbox SET status='pending',first_attempt_at=NULL,next_attempt_at=now()+interval '15 minutes',last_error=left(p_error,160),claim_token=NULL,lease_until=NULL WHERE id=p_id;
  ELSE UPDATE review_sms_outbox SET status='unknown',last_error='reservation_requires_reconciliation',claim_token=NULL,lease_until=NULL WHERE id=p_id;END IF;
 ELSIF p_outcome='not_sent' THEN
  UPDATE review_sms_outbox SET status='failed',last_error=left(p_error,160),claim_token=NULL,lease_until=NULL WHERE id=p_id;
  PERFORM review_stop_enrollment(o.enrollment_id,'hard_failure');
 ELSE UPDATE review_sms_outbox SET status='unknown',last_error=left(coalesce(p_error,'provider_ambiguous'),160),claim_token=NULL,lease_until=NULL WHERE id=p_id;
 END IF;
END $$;
CREATE FUNCTION public.review_reschedule_sms(p_id uuid,p_business uuid,p_owner uuid,p_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 PERFORM review_assert_owner(p_business,p_owner);
 IF p_at<now() OR p_at>now()+interval '90 days' THEN RAISE EXCEPTION 'invalid_review_schedule' USING ERRCODE='22023';END IF;
 UPDATE review_sms_outbox SET status='pending',scheduled_at=p_at,next_attempt_at=p_at,expires_at=p_at+interval '24 hours',last_error=NULL WHERE enrollment_id=p_id AND business_id=p_business AND kind='initial' AND status IN ('pending','needs_reschedule') AND first_attempt_at IS NULL;
 IF NOT FOUND THEN RETURN false;END IF;
 UPDATE review_enrollments SET status='active',stopped_at=NULL,stop_reason=NULL WHERE id=p_id AND business_id=p_business;RETURN true;
END $$;
CREATE FUNCTION public.review_reconcile_sms_receipts() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r record;n integer:=0;
BEGIN
 FOR r IN SELECT o.id,o.claim_token,o.enrollment_id,o.status AS outbox_status,t.id AS reservation_id,t.status,t.provider_message_id,t.delivery_status FROM review_sms_outbox o JOIN tenant_sms_sends t ON t.business_id=o.business_id AND t.idempotency_key='review-sms/v1/'||o.id::text
  WHERE (o.status IN ('submitting','unknown') AND t.status IN ('accepted','not_sent'))
   OR (o.status='accepted' AND t.status='accepted' AND t.delivery_status IN ('delivered','delivery_failed','sending_failed','expired','cancelled'))
  ORDER BY o.created_at LIMIT 100 LOOP
  IF r.outbox_status IN ('submitting','unknown') THEN PERFORM review_finish_sms(r.id,r.claim_token,CASE WHEN r.status='accepted' THEN 'accepted' ELSE 'not_sent' END,r.provider_message_id,r.reservation_id,'reservation_reconciled');END IF;
  IF r.delivery_status='delivered' THEN UPDATE review_sms_outbox SET status='delivered',delivered_at=coalesce(delivered_at,now()) WHERE id=r.id AND status='accepted';
  ELSIF r.delivery_status IN ('delivery_failed','sending_failed','expired','cancelled') THEN UPDATE review_sms_outbox SET status='failed',last_error=r.delivery_status WHERE id=r.id;PERFORM review_stop_enrollment(r.enrollment_id,'hard_failure');END IF;
  n:=n+1;
 END LOOP;
 RETURN n;
END $$;
DO $$ DECLARE f record;BEGIN
 FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'review_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
 END LOOP;
END $$;
