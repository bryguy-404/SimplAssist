-- Email-only reviews. All writes are service-role RPCs; rollout and sending are
-- separate switches. No import, chat capture, or contact creation enrolls anyone.
CREATE TABLE public.review_email_control (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled boolean NOT NULL DEFAULT false, sending_enabled boolean NOT NULL DEFAULT false,
 pilot_business_ids uuid[] NOT NULL DEFAULT '{}', next_send_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.review_email_control(singleton) VALUES(true);
CREATE TABLE public.review_settings (
 business_id uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
 owner_id uuid NOT NULL REFERENCES auth.users(id), google_review_url text,
 reply_to text NOT NULL, reply_to_verified_at timestamptz NOT NULL,
 notification_email text NOT NULL, postal_address text, pending_reply_to text, pending_reply_to_revision uuid,
 timezone text NOT NULL DEFAULT 'America/New_York', paused boolean NOT NULL DEFAULT false,
 subject text NOT NULL DEFAULT 'How was your experience with {{business_name}}?',
 body text NOT NULL DEFAULT 'Hi {{customer_name}}, thank you for choosing {{business_name}}. We would appreciate your honest feedback on Google. Please share your experience using the link below.',
 reminder_enabled boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.review_reply_to_verifications (
 id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 owner_id uuid NOT NULL REFERENCES auth.users(id), email text NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours', consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.review_campaign_previews (
 id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 owner_id uuid NOT NULL REFERENCES auth.users(id), settings_revision integer NOT NULL,
 snapshot jsonb NOT NULL, expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
 campaign_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.review_campaigns (
 id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 owner_id uuid NOT NULL REFERENCES auth.users(id), subject text NOT NULL, body text NOT NULL,
 reminder_enabled boolean NOT NULL, scheduled_at timestamptz NOT NULL,
 completed_service_attested_at timestamptz NOT NULL, permission_attested_at timestamptz NOT NULL,
 audience_count integer NOT NULL, summary jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.review_enrollments (
 id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 campaign_id uuid NOT NULL REFERENCES public.review_campaigns(id) ON DELETE CASCADE,
 -- SET NULL retains destination cooldown after contact deletion/re-creation.
 contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
 original_contact_id uuid NOT NULL, identities text[] NOT NULL, destination text NOT NULL,
 channel text NOT NULL DEFAULT 'email' CHECK(channel IN ('email','sms')),
 google_review_url text NOT NULL, timezone text NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','clicked','reviewed','cancelled','needs_reschedule','expired','failed')),
 accepted_at timestamptz, stopped_at timestamptz, stop_reason text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_enrollments_identity_idx ON public.review_enrollments USING gin(identities);
CREATE INDEX review_enrollments_business_idx ON public.review_enrollments(business_id,original_contact_id,accepted_at);
CREATE TABLE public.review_identity_history (
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 contact_id uuid NOT NULL, identity text NOT NULL, PRIMARY KEY(business_id,contact_id,identity)
);
CREATE TABLE public.review_permissions (
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 contact_id uuid NOT NULL, destination text NOT NULL, granted_at timestamptz NOT NULL,
 actor_id uuid NOT NULL REFERENCES auth.users(id), evidence text NOT NULL, revoked_at timestamptz,
 PRIMARY KEY(business_id,contact_id,destination)
);
CREATE TABLE public.review_suppressions (
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 identity text NOT NULL, reason text NOT NULL, suppressed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,identity)
);
CREATE TABLE public.review_email_usage (
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 period_start timestamptz NOT NULL, period_end timestamptz NOT NULL,
 used integer NOT NULL DEFAULT 0 CHECK(used>=0), PRIMARY KEY(business_id,period_start)
);
CREATE TABLE public.review_email_outbox (
 id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 owner_id uuid NOT NULL REFERENCES auth.users(id), enrollment_id uuid REFERENCES public.review_enrollments(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('initial','reminder','test','verification')),
 destination text NOT NULL, payload jsonb NOT NULL, reminder_payload jsonb,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','submitting','accepted','delivered','failed','unknown','cancelled','needs_reschedule','expired')),
 scheduled_at timestamptz NOT NULL, next_attempt_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL, claim_token uuid, lease_until timestamptz,
 attempt_count integer NOT NULL DEFAULT 0, first_attempt_at timestamptz, ambiguous_since timestamptz,
 idempotency_key text GENERATED ALWAYS AS ('review-email/v1/'||id::text) STORED,
 usage_period_start timestamptz, quota_reserved boolean NOT NULL DEFAULT false,
 provider_message_id text UNIQUE, accepted_at timestamptz, delivered_at timestamptz,
 provider_event_at timestamptz, provider_event_rank integer NOT NULL DEFAULT 0,
 last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(enrollment_id,kind)
);
CREATE INDEX review_outbox_due_idx ON public.review_email_outbox(next_attempt_at) WHERE status IN ('pending','claimed','submitting');
CREATE TABLE public.review_email_provider_events (
 event_id text PRIMARY KEY, provider_message_id text NOT NULL, delivery_id uuid, event_type text NOT NULL,
 occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), applied_at timestamptz
);
CREATE INDEX review_email_pending_events ON public.review_email_provider_events(received_at) WHERE applied_at IS NULL;

CREATE FUNCTION public.review_business_billing(p_business uuid)
RETURNS TABLE(allowed boolean,plan text,period_start timestamptz,period_end timestamptz,allowance integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE b businesses; s subscriptions; v_plan text; v_allowed boolean := false;
BEGIN
 SELECT * INTO b FROM businesses WHERE id=p_business;
 IF NOT FOUND OR b.owner_id IS NULL OR b.deleted_at IS NOT NULL OR b.operations_suspended_at IS NOT NULL THEN
  RETURN QUERY SELECT false,NULL::text,NULL::timestamptz,NULL::timestamptz,0; RETURN;
 END IF;
 SELECT * INTO s FROM subscriptions WHERE business_id=p_business LIMIT 1;
 IF FOUND THEN
  v_plan:=s.plan::text; v_allowed:=s.status::text='active' AND (s.current_period_end IS NULL OR s.current_period_end>now());
  IF s.current_period_start IS NOT NULL AND s.current_period_end IS NOT NULL THEN period_start:=s.current_period_start; period_end:=s.current_period_end; END IF;
 ELSIF b.billing_mode::text IN ('invoiced','comped') AND b.partner_plan IS NOT NULL THEN
  v_plan:=b.partner_plan::text; v_allowed:=true;
 ELSIF coalesce(b.billing_mode::text,'stripe')='stripe' AND (b.billing_pilot OR b.billing_comped OR b.billing_exempt) THEN
  v_plan:='full'; v_allowed:=true;
 END IF;
 period_start:=coalesce(period_start,date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC');
 period_end:=coalesce(period_end,period_start+interval '1 month');
 allowance:=CASE v_plan WHEN 'chat_only' THEN 500 WHEN 'sms_only' THEN 500 WHEN 'sms_and_chat' THEN 1000 WHEN 'full' THEN 2000 ELSE 0 END;
 RETURN QUERY SELECT v_allowed AND allowance>0,v_plan,period_start,period_end,allowance;
END $$;
CREATE FUNCTION public.review_assert_owner(p_business uuid,p_owner uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 PERFORM 1 FROM businesses WHERE id=p_business AND owner_id=p_owner AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'review_workspace_denied' USING ERRCODE='42501'; END IF;
END $$;
CREATE FUNCTION public.review_program_enabled(p_business uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT coalesce((SELECT enabled AND p_business=ANY(pilot_business_ids) FROM review_email_control WHERE singleton),false)
$$;
CREATE FUNCTION public.review_initialize_settings(p_business uuid,p_owner uuid) RETURNS public.review_settings
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u auth.users; result review_settings;
BEGIN
 PERFORM review_assert_owner(p_business,p_owner);
 SELECT * INTO u FROM auth.users WHERE id=p_owner;
 IF u.email IS NULL OR u.email_confirmed_at IS NULL THEN RAISE EXCEPTION 'verified_owner_email_required' USING ERRCODE='22023'; END IF;
 INSERT INTO review_settings(business_id,owner_id,reply_to,reply_to_verified_at,notification_email,timezone)
 VALUES(p_business,p_owner,lower(trim(u.email)),u.email_confirmed_at,lower(trim(u.email)),coalesce((SELECT timezone FROM businesses WHERE id=p_business),'America/New_York')) ON CONFLICT DO NOTHING;
 SELECT * INTO result FROM review_settings WHERE business_id=p_business;
 IF result.owner_id<>p_owner THEN RAISE EXCEPTION 'review_settings_owner_changed' USING ERRCODE='42501'; END IF;
 RETURN result;
END $$;
CREATE FUNCTION public.review_update_settings(p_business uuid,p_owner uuid,p_patch jsonb) RETURNS public.review_settings
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE result review_settings;
BEGIN
 PERFORM review_assert_owner(p_business,p_owner);
 UPDATE review_settings SET
 google_review_url=CASE WHEN p_patch?'google_review_url' THEN p_patch->>'google_review_url' ELSE google_review_url END,
 postal_address=coalesce(p_patch->>'postal_address',postal_address),timezone=coalesce(p_patch->>'timezone',timezone),paused=coalesce((p_patch->>'paused')::boolean,paused),
 subject=coalesce(p_patch->>'subject',subject),body=coalesce(p_patch->>'body',body),
 reminder_enabled=coalesce((p_patch->>'reminder_enabled')::boolean,reminder_enabled),
 -- Notification mail may only go to the authenticated owner or verified Reply-To.
 notification_email=CASE WHEN p_patch?'notification_email' AND (p_patch->>'notification_email'=reply_to OR p_patch->>'notification_email'=(SELECT lower(trim(email)) FROM auth.users WHERE id=p_owner AND email_confirmed_at IS NOT NULL)) THEN p_patch->>'notification_email' ELSE notification_email END,
 revision=revision+1,updated_at=now() WHERE business_id=p_business AND owner_id=p_owner RETURNING * INTO result;
 RETURN result;
END $$;
CREATE FUNCTION public.review_queue_owner_email(p_business uuid,p_owner uuid,p_id uuid,p_kind text,p_destination text,p_payload jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_count integer;
BEGIN
 PERFORM review_assert_owner(p_business,p_owner);
 IF NOT review_program_enabled(p_business) OR p_kind NOT IN ('test','verification') THEN RAISE EXCEPTION 'review_email_unavailable' USING ERRCODE='22023'; END IF;
 IF p_kind='test' AND NOT EXISTS(SELECT 1 FROM auth.users WHERE id=p_owner AND lower(trim(email))=p_destination AND email_confirmed_at IS NOT NULL) THEN RAISE EXCEPTION 'verified_owner_email_required' USING ERRCODE='22023'; END IF;
 SELECT count(*) INTO v_count FROM review_email_outbox WHERE business_id=p_business AND kind=p_kind AND created_at>now()-interval '24 hours';
 IF v_count>=5 OR EXISTS(SELECT 1 FROM review_email_outbox WHERE business_id=p_business AND kind=p_kind AND created_at>now()-interval '1 minute') THEN RAISE EXCEPTION 'review_email_rate_limit' USING ERRCODE='22023'; END IF;
 IF p_kind='verification' THEN
  INSERT INTO review_reply_to_verifications(id,business_id,owner_id,email) VALUES(p_id,p_business,p_owner,p_destination);
  UPDATE review_settings SET pending_reply_to=p_destination,pending_reply_to_revision=p_id,revision=revision+1 WHERE business_id=p_business;
 END IF;
 INSERT INTO review_email_outbox(id,business_id,owner_id,kind,destination,payload,scheduled_at,next_attempt_at,expires_at)
 VALUES(p_id,p_business,p_owner,p_kind,p_destination,p_payload,now(),now(),now()+interval '24 hours');
 RETURN p_id;
END $$;
CREATE FUNCTION public.review_confirm_reply_to(p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v review_reply_to_verifications;
BEGIN
 SELECT * INTO v FROM review_reply_to_verifications WHERE id=p_id;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM review_assert_owner(v.business_id,v.owner_id);
 SELECT * INTO v FROM review_reply_to_verifications WHERE id=p_id FOR UPDATE;
 IF v.consumed_at IS NOT NULL OR v.expires_at<=now() THEN RETURN false; END IF;
 UPDATE review_settings SET reply_to=v.email,reply_to_verified_at=now(),pending_reply_to=NULL,pending_reply_to_revision=NULL,revision=revision+1,updated_at=now()
 WHERE business_id=v.business_id AND owner_id=v.owner_id AND pending_reply_to_revision=v.id AND pending_reply_to=v.email;
 IF NOT FOUND THEN RETURN false; END IF;
 UPDATE review_reply_to_verifications SET consumed_at=now() WHERE id=p_id;
 RETURN true;
END $$;
CREATE FUNCTION public.review_recipient_block(p_business uuid,p_contact uuid,p_destination text,p_identities text[],p_exclude uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM contacts WHERE id=p_contact AND business_id=p_business AND lower(trim(email))=p_destination) THEN RETURN 'customer_changed'; END IF;
 IF EXISTS(SELECT 1 FROM review_suppressions WHERE business_id=p_business AND identity=ANY(p_identities)) THEN RETURN 'suppressed'; END IF;
 IF EXISTS(SELECT 1 FROM review_permissions WHERE business_id=p_business AND contact_id=p_contact AND destination=p_destination AND revoked_at IS NOT NULL) THEN RETURN 'permission_revoked'; END IF;
 IF EXISTS(SELECT 1 FROM review_enrollments e WHERE e.business_id=p_business AND e.id IS DISTINCT FROM p_exclude
   AND (e.original_contact_id=p_contact OR e.identities && p_identities OR EXISTS(SELECT 1 FROM review_identity_history h WHERE h.business_id=p_business AND h.contact_id=p_contact AND h.identity=ANY(e.identities)))
   AND (e.accepted_at>now()-interval '90 days' OR EXISTS(SELECT 1 FROM review_email_outbox o WHERE o.enrollment_id=e.id AND o.status IN ('pending','claimed','submitting','unknown')))) THEN RETURN 'cooldown'; END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION public.review_confirm_campaign(p_preview uuid,p_business uuid,p_owner uuid,p_deliveries jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE p review_campaign_previews; s review_settings; item jsonb; d jsonb; v_id uuid; v_block text; v_identities text[]; v_count integer;
BEGIN
 PERFORM review_assert_owner(p_business,p_owner);
 SELECT * INTO p FROM review_campaign_previews WHERE id=p_preview AND business_id=p_business AND owner_id=p_owner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'review_preview_missing' USING ERRCODE='22023'; END IF;
 IF p.campaign_id IS NOT NULL THEN RETURN p.campaign_id; END IF;
 IF p.expires_at<=now() THEN RAISE EXCEPTION 'review_preview_expired' USING ERRCODE='22023'; END IF;
 SELECT * INTO s FROM review_settings WHERE business_id=p_business;
 IF NOT review_program_enabled(p_business) OR s.paused OR s.revision<>p.settings_revision OR NOT (SELECT allowed FROM review_business_billing(p_business)) THEN RAISE EXCEPTION 'review_settings_or_eligibility_changed' USING ERRCODE='22023'; END IF;
 v_count:=jsonb_array_length(p.snapshot->'recipients');
 IF v_count<1 OR v_count>500 OR jsonb_array_length(p_deliveries)<>v_count THEN RAISE EXCEPTION 'invalid_review_audience' USING ERRCODE='22023'; END IF;
 v_id:=p.id;
 INSERT INTO review_campaigns(id,business_id,owner_id,subject,body,reminder_enabled,scheduled_at,completed_service_attested_at,permission_attested_at,audience_count,summary)
 VALUES(v_id,p_business,p_owner,p.snapshot->>'subject',p.snapshot->>'body',(p.snapshot->>'reminderEnabled')::boolean,(p.snapshot->>'scheduledAt')::timestamptz,now(),now(),v_count,coalesce(p.snapshot->'summary','{}'));
 FOR item IN SELECT * FROM jsonb_array_elements(p.snapshot->'recipients') LOOP
  SELECT array_agg(DISTINCT normalized) INTO v_identities FROM (
   SELECT CASE WHEN value LIKE 'phone:%' THEN 'phone:'||lead_normalize_phone(substring(value FROM 7)) ELSE value END normalized
   FROM jsonb_array_elements_text(item->'identities')
  ) recipient_identities WHERE normalized IS NOT NULL;
  v_block:=review_recipient_block(p_business,(item->>'contactId')::uuid,item->>'email',v_identities);
  IF v_block IS NOT NULL THEN RAISE EXCEPTION 'review_audience_changed:%',v_block USING ERRCODE='22023'; END IF;
  SELECT value INTO d FROM jsonb_array_elements(p_deliveries) WHERE value->>'enrollmentId'=item->>'enrollmentId';
  IF d IS NULL OR d->'payload'->'to'->>0 IS DISTINCT FROM item->>'email' THEN RAISE EXCEPTION 'invalid_review_payload' USING ERRCODE='22023'; END IF;
  INSERT INTO review_enrollments(id,business_id,campaign_id,contact_id,original_contact_id,identities,destination,google_review_url,timezone)
   VALUES((item->>'enrollmentId')::uuid,p_business,v_id,(item->>'contactId')::uuid,(item->>'contactId')::uuid,v_identities,item->>'email',p.snapshot->>'googleReviewUrl',item->>'timezone');
  INSERT INTO review_identity_history(business_id,contact_id,identity) SELECT p_business,(item->>'contactId')::uuid,unnest(v_identities) ON CONFLICT DO NOTHING;
  INSERT INTO review_permissions(business_id,contact_id,destination,granted_at,actor_id,evidence) VALUES(p_business,(item->>'contactId')::uuid,item->>'email',now(),p_owner,'Owner confirmed completed service and permission to send this review request')
   ON CONFLICT(business_id,contact_id,destination) DO NOTHING;
  INSERT INTO review_email_outbox(id,business_id,owner_id,enrollment_id,kind,destination,payload,reminder_payload,scheduled_at,next_attempt_at,expires_at)
   VALUES((d->>'id')::uuid,p_business,p_owner,(item->>'enrollmentId')::uuid,'initial',item->>'email',d->'payload',CASE WHEN (p.snapshot->>'reminderEnabled')::boolean THEN d->'reminderPayload' ELSE NULL END,(item->>'scheduledAt')::timestamptz,(item->>'scheduledAt')::timestamptz,(item->>'scheduledAt')::timestamptz+interval '24 hours');
 END LOOP;
 UPDATE review_campaign_previews SET campaign_id=v_id WHERE id=p_preview;
 RETURN v_id;
END $$;
CREATE FUNCTION public.review_stop_enrollment(p_id uuid,p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE e review_enrollments;
BEGIN
 SELECT * INTO e FROM review_enrollments WHERE id=p_id;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM 1 FROM businesses WHERE id=e.business_id FOR UPDATE;
 UPDATE review_enrollments SET status=CASE p_reason WHEN 'clicked' THEN 'clicked' WHEN 'reviewed' THEN 'reviewed' ELSE 'cancelled' END,stopped_at=coalesce(stopped_at,now()),stop_reason=p_reason WHERE id=p_id;
 UPDATE review_email_outbox SET status='cancelled',last_error=p_reason,claim_token=NULL,lease_until=NULL,updated_at=now() WHERE enrollment_id=p_id AND status IN ('pending','claimed','needs_reschedule');
 RETURN true;
END $$;
CREATE FUNCTION public.review_unsubscribe(p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE e review_enrollments; r record;
BEGIN
 SELECT * INTO e FROM review_enrollments WHERE id=p_id;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM 1 FROM businesses WHERE id=e.business_id FOR UPDATE;
 INSERT INTO review_suppressions(business_id,identity,reason) VALUES(e.business_id,'email:'||e.destination,'unsubscribe') ON CONFLICT DO NOTHING;
 UPDATE review_permissions SET revoked_at=coalesce(revoked_at,now()) WHERE business_id=e.business_id AND destination=e.destination;
 FOR r IN SELECT id FROM review_enrollments WHERE business_id=e.business_id AND 'email:'||e.destination=ANY(identities) LOOP PERFORM review_stop_enrollment(r.id,'unsubscribe'); END LOOP;
 RETURN true;
END $$;
CREATE FUNCTION public.review_reschedule(p_id uuid,p_business uuid,p_owner uuid,p_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 PERFORM review_assert_owner(p_business,p_owner);
 IF p_at<now() OR p_at>now()+interval '90 days' THEN RAISE EXCEPTION 'invalid_review_schedule' USING ERRCODE='22023'; END IF;
 UPDATE review_email_outbox SET status='pending',scheduled_at=p_at,next_attempt_at=p_at,expires_at=p_at+interval '24 hours',last_error=NULL WHERE enrollment_id=p_id AND business_id=p_business AND kind='initial' AND status IN ('pending','needs_reschedule') AND first_attempt_at IS NULL;
 IF NOT FOUND THEN RETURN false; END IF;
 UPDATE review_enrollments SET status='active',stopped_at=NULL,stop_reason=NULL WHERE id=p_id AND business_id=p_business;
 RETURN true;
END $$;

-- Global row order: business -> outbox -> usage/control. A claimed job has no
-- authority to send until begin checks fresh billing, permission and suppression.
CREATE FUNCTION public.review_claim_emails(p_limit integer DEFAULT 5) RETURNS SETOF public.review_email_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 UPDATE review_email_outbox SET status='pending',claim_token=NULL,lease_until=NULL WHERE status='claimed' AND lease_until<now();
 UPDATE review_email_outbox SET status=CASE WHEN first_attempt_at>now()-interval '23 hours' THEN 'pending' ELSE 'unknown' END,ambiguous_since=coalesce(ambiguous_since,first_attempt_at,now()),claim_token=NULL,lease_until=NULL,next_attempt_at=now()+interval '1 minute',last_error='submission_lease_expired' WHERE status='submitting' AND lease_until<now();
 UPDATE review_email_outbox SET status=CASE WHEN kind='initial' THEN 'needs_reschedule' ELSE 'expired' END,last_error='schedule_stale' WHERE status='pending' AND first_attempt_at IS NULL AND expires_at<=now();
 UPDATE review_enrollments e SET status='needs_reschedule' WHERE status='active' AND EXISTS(SELECT 1 FROM review_email_outbox o WHERE o.enrollment_id=e.id AND o.kind='initial' AND o.status='needs_reschedule');
 RETURN QUERY WITH picked AS (
  SELECT o.id FROM review_email_outbox o WHERE o.status='pending' AND o.next_attempt_at<=now()
  AND review_program_enabled(o.business_id) AND (SELECT sending_enabled FROM review_email_control WHERE singleton)
  ORDER BY o.next_attempt_at FOR UPDATE SKIP LOCKED LIMIT greatest(0,least(p_limit,10))
 ) UPDATE review_email_outbox o SET status='claimed',claim_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',updated_at=now() FROM picked WHERE o.id=picked.id RETURNING o.*;
END $$;
CREATE FUNCTION public.review_begin_email(p_id uuid,p_claim uuid) RETURNS public.review_email_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE o review_email_outbox; e review_enrollments; s review_settings; b businesses; bill record; v_block text; v_hour integer; v_next timestamptz;
BEGIN
 SELECT * INTO o FROM review_email_outbox WHERE id=p_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO b FROM businesses WHERE id=o.business_id FOR UPDATE;
 SELECT * INTO o FROM review_email_outbox WHERE id=p_id FOR UPDATE;
 IF o.status<>'claimed' OR o.claim_token IS DISTINCT FROM p_claim OR o.lease_until<=now() THEN RETURN NULL; END IF;
 SELECT * INTO s FROM review_settings WHERE business_id=o.business_id;
 IF o.first_attempt_at IS NULL AND o.expires_at<=now() THEN UPDATE review_email_outbox SET status=CASE WHEN kind='initial' THEN 'needs_reschedule' ELSE 'expired' END,last_error='schedule_stale',claim_token=NULL,lease_until=NULL WHERE id=p_id; RETURN NULL; END IF;
 IF NOT review_program_enabled(o.business_id) OR NOT (SELECT sending_enabled FROM review_email_control WHERE singleton) THEN
  UPDATE review_email_outbox SET status='pending',claim_token=NULL,lease_until=NULL,next_attempt_at=now()+interval '5 minutes' WHERE id=p_id; RETURN NULL;
 END IF;
 IF b.owner_id IS DISTINCT FROM o.owner_id OR b.deleted_at IS NOT NULL OR b.operations_suspended_at IS NOT NULL THEN v_block:='workspace_unavailable'; END IF;
 IF o.first_attempt_at IS NOT NULL AND o.first_attempt_at<=now()-interval '23 hours' THEN
  UPDATE review_email_outbox SET status='unknown',last_error='idempotency_window_expired',claim_token=NULL,lease_until=NULL WHERE id=p_id; RETURN NULL;
 END IF;
 IF o.kind IN ('initial','reminder') THEN
  SELECT * INTO e FROM review_enrollments WHERE id=o.enrollment_id;
  SELECT * INTO bill FROM review_business_billing(o.business_id);
  IF NOT bill.allowed OR s.paused THEN
   UPDATE review_email_outbox SET status='pending',claim_token=NULL,lease_until=NULL,next_attempt_at=now()+interval '1 hour' WHERE id=p_id; RETURN NULL;
  END IF;
  IF e.status<>'active' OR e.contact_id IS NULL THEN v_block:=coalesce(e.stop_reason,'customer_unavailable'); END IF;
  v_block:=coalesce(v_block,review_recipient_block(o.business_id,e.contact_id,o.destination,e.identities,e.id));
  IF NOT EXISTS(SELECT 1 FROM review_permissions WHERE business_id=o.business_id AND contact_id=e.original_contact_id AND destination=o.destination AND revoked_at IS NULL) THEN v_block:='permission_missing'; END IF;
  -- A later verified Reply-To is not silently substituted into frozen mail.
  IF o.payload->>'replyTo' IS DISTINCT FROM s.reply_to THEN v_block:='reply_to_changed'; END IF;
  v_hour:=extract(hour FROM now() AT TIME ZONE e.timezone);
  IF v_block IS NULL AND (v_hour<9 OR v_hour>=18) THEN
   v_next:=(date_trunc('day',now() AT TIME ZONE e.timezone)+CASE WHEN v_hour>=18 THEN interval '1 day' ELSE interval '0 days' END+interval '9 hours') AT TIME ZONE e.timezone;
   UPDATE review_email_outbox SET status='pending',claim_token=NULL,lease_until=NULL,next_attempt_at=v_next WHERE id=p_id; RETURN NULL;
  END IF;
 ELSIF o.kind='test' AND NOT EXISTS(SELECT 1 FROM auth.users WHERE id=o.owner_id AND email_confirmed_at IS NOT NULL AND lower(trim(email))=o.destination) THEN v_block:='verified_owner_email_required';
 ELSIF o.kind='verification' AND NOT EXISTS(SELECT 1 FROM review_reply_to_verifications v WHERE v.id=o.id AND v.expires_at>now() AND v.consumed_at IS NULL AND s.pending_reply_to_revision=v.id AND s.pending_reply_to=v.email) THEN v_block:='verification_superseded';
 END IF;
 IF v_block IS NOT NULL THEN UPDATE review_email_outbox SET status=CASE WHEN first_attempt_at IS NULL THEN 'cancelled' ELSE 'unknown' END,last_error=v_block,claim_token=NULL,lease_until=NULL WHERE id=p_id; RETURN NULL; END IF;
 SELECT next_send_at INTO v_next FROM review_email_control WHERE singleton FOR UPDATE;
 IF v_next>now() THEN UPDATE review_email_outbox SET status='pending',claim_token=NULL,lease_until=NULL,next_attempt_at=v_next WHERE id=p_id; RETURN NULL; END IF;
 IF o.kind IN ('initial','reminder') AND NOT o.quota_reserved THEN
  INSERT INTO review_email_usage(business_id,period_start,period_end) VALUES(o.business_id,bill.period_start,bill.period_end) ON CONFLICT DO NOTHING;
  UPDATE review_email_usage SET used=used+1 WHERE business_id=o.business_id AND period_start=bill.period_start AND used<bill.allowance;
  IF NOT FOUND THEN UPDATE review_email_outbox SET status='pending',claim_token=NULL,lease_until=NULL,next_attempt_at=least(bill.period_end,now()+interval '1 hour'),last_error='email_allowance_reached' WHERE id=p_id; RETURN NULL; END IF;
  UPDATE review_email_outbox SET quota_reserved=true,usage_period_start=bill.period_start WHERE id=p_id;
 END IF;
 UPDATE review_email_control SET next_send_at=clock_timestamp()+interval '600 milliseconds' WHERE singleton;
 UPDATE review_email_outbox SET status='submitting',first_attempt_at=coalesce(first_attempt_at,now()),attempt_count=attempt_count+1,lease_until=now()+interval '2 minutes',updated_at=now() WHERE id=p_id RETURNING * INTO o;
 RETURN o;
END $$;
CREATE FUNCTION public.review_finish_email(p_id uuid,p_claim uuid,p_outcome text,p_provider_id text DEFAULT NULL,p_error text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE o review_email_outbox; e review_enrollments; v_next timestamptz; v_hour integer;
BEGIN
 SELECT * INTO o FROM review_email_outbox WHERE id=p_id;
 IF NOT FOUND THEN RETURN; END IF;
 PERFORM 1 FROM businesses WHERE id=o.business_id FOR UPDATE;
 SELECT * INTO o FROM review_email_outbox WHERE id=p_id FOR UPDATE;
 IF o.status NOT IN ('submitting','unknown','pending','claimed') OR o.first_attempt_at IS NULL OR o.claim_token IS DISTINCT FROM p_claim THEN RETURN; END IF;
 IF p_outcome='accepted' AND p_provider_id IS NOT NULL THEN
  UPDATE review_email_outbox SET status='accepted',provider_message_id=p_provider_id,accepted_at=now(),claim_token=NULL,lease_until=NULL,last_error=NULL,updated_at=now() WHERE id=p_id;
  IF o.kind='initial' THEN
   UPDATE review_enrollments SET accepted_at=coalesce(accepted_at,now()) WHERE id=o.enrollment_id RETURNING * INTO e;
   IF o.reminder_payload IS NOT NULL AND o.reminder_payload<>'null'::jsonb AND e.status='active' THEN
    v_next:=now()+interval '4 days'; v_hour:=extract(hour FROM v_next AT TIME ZONE e.timezone);
    IF v_hour<9 OR v_hour>=18 THEN v_next:=(date_trunc('day',v_next AT TIME ZONE e.timezone)+CASE WHEN v_hour>=18 THEN interval '1 day' ELSE interval '0 days' END+interval '9 hours') AT TIME ZONE e.timezone; END IF;
    INSERT INTO review_email_outbox(id,business_id,owner_id,enrollment_id,kind,destination,payload,scheduled_at,next_attempt_at,expires_at)
    VALUES(gen_random_uuid(),o.business_id,o.owner_id,o.enrollment_id,'reminder',o.destination,o.reminder_payload,v_next,v_next,v_next+interval '24 hours') ON CONFLICT(enrollment_id,kind) DO NOTHING;
   END IF;
  END IF;
 ELSIF p_outcome='deferred' AND o.ambiguous_since IS NULL THEN
  IF o.quota_reserved THEN UPDATE review_email_usage SET used=greatest(0,used-1) WHERE business_id=o.business_id AND period_start=o.usage_period_start; END IF;
  UPDATE review_email_outbox SET status='pending',next_attempt_at=now()+interval '15 minutes',first_attempt_at=NULL,quota_reserved=false,usage_period_start=NULL,last_error=left(p_error,160),claim_token=NULL,lease_until=NULL,updated_at=now() WHERE id=p_id;
 ELSIF p_outcome='definite_failure' AND o.ambiguous_since IS NULL THEN
  UPDATE review_email_outbox SET status='failed',last_error=left(p_error,160),claim_token=NULL,lease_until=NULL,updated_at=now() WHERE id=p_id;
  IF o.quota_reserved THEN UPDATE review_email_usage SET used=greatest(0,used-1) WHERE business_id=o.business_id AND period_start=o.usage_period_start; UPDATE review_email_outbox SET quota_reserved=false WHERE id=p_id; END IF;
  IF o.enrollment_id IS NOT NULL THEN PERFORM review_stop_enrollment(o.enrollment_id,'hard_failure'); END IF;
 ELSE
  -- Resend keeps keys for 24h. Stay below that boundary and never mint a new key.
  UPDATE review_email_outbox SET status=CASE WHEN first_attempt_at>now()-interval '23 hours' AND attempt_count<8 THEN 'pending' ELSE 'unknown' END,ambiguous_since=coalesce(ambiguous_since,first_attempt_at,now()),
   next_attempt_at=now()+make_interval(secs=>least(3600,60*power(2,least(attempt_count,6))::integer)),last_error=left(coalesce(p_error,'ambiguous_provider_result'),160),claim_token=NULL,lease_until=NULL,updated_at=now() WHERE id=p_id;
 END IF;
END $$;
CREATE FUNCTION public.review_apply_email_events() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE ev review_email_provider_events; o review_email_outbox; v_rank integer; n integer:=0; r record;
BEGIN
 -- Filter before LIMIT: unrelated mail on a shared Resend account and deleted
 -- tenant receipts must not starve matchable review complaints or deliveries.
 FOR ev IN SELECT pe.* FROM review_email_provider_events pe WHERE pe.applied_at IS NULL
  AND EXISTS(SELECT 1 FROM review_email_outbox delivery WHERE delivery.provider_message_id=pe.provider_message_id OR (delivery.id=pe.delivery_id AND delivery.provider_message_id IS NULL AND delivery.first_attempt_at IS NOT NULL))
  ORDER BY pe.received_at LIMIT 100 FOR UPDATE OF pe SKIP LOCKED LOOP
  SELECT * INTO o FROM review_email_outbox WHERE provider_message_id=ev.provider_message_id OR (id=ev.delivery_id AND provider_message_id IS NULL AND first_attempt_at IS NOT NULL);
  IF NOT FOUND THEN CONTINUE; END IF;
  IF o.provider_message_id IS NULL THEN PERFORM review_finish_email(o.id,o.claim_token,'accepted',ev.provider_message_id,NULL); END IF;
  PERFORM 1 FROM businesses WHERE id=o.business_id FOR UPDATE;
  v_rank:=CASE ev.event_type WHEN 'email.sent' THEN 1 WHEN 'email.delivered' THEN 2 WHEN 'email.failed' THEN 3 WHEN 'email.bounced' THEN 4 WHEN 'email.suppressed' THEN 4 WHEN 'email.complained' THEN 5 ELSE 0 END;
  IF v_rank>0 THEN
   UPDATE review_email_outbox SET status=CASE WHEN v_rank=1 THEN 'accepted' WHEN v_rank=2 THEN 'delivered' ELSE 'failed' END,
    delivered_at=CASE WHEN v_rank=2 THEN coalesce(delivered_at,ev.occurred_at) ELSE delivered_at END,provider_event_rank=v_rank,provider_event_at=ev.occurred_at,updated_at=now()
    WHERE id=o.id AND (provider_event_rank<v_rank OR (provider_event_rank=v_rank AND (provider_event_at IS NULL OR provider_event_at<=ev.occurred_at)));
   IF v_rank>=3 AND o.enrollment_id IS NOT NULL THEN PERFORM review_stop_enrollment(o.enrollment_id,'hard_failure'); END IF;
   IF v_rank>=4 THEN
    INSERT INTO review_suppressions(business_id,identity,reason,suppressed_at) VALUES(o.business_id,'email:'||o.destination,ev.event_type,ev.occurred_at) ON CONFLICT DO NOTHING;
    FOR r IN SELECT id FROM review_enrollments WHERE business_id=o.business_id AND destination=o.destination LOOP PERFORM review_stop_enrollment(r.id,ev.event_type); END LOOP;
   END IF;
  END IF;
  UPDATE review_email_provider_events SET applied_at=now() WHERE event_id=ev.event_id; n:=n+1;
 END LOOP;
 DELETE FROM review_email_provider_events WHERE applied_at IS NULL AND received_at<now()-interval '30 days';
 RETURN n;
END $$;
-- Tombstones and deletes retain cooldown only while the business exists; purge
-- customer snapshots when the owner is removed. Never leave queued mail alive.
CREATE FUNCTION public.review_business_tombstone() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NEW.owner_id IS NULL AND OLD.owner_id IS NOT NULL THEN
  DELETE FROM review_email_outbox WHERE business_id=NEW.id;
  DELETE FROM review_campaign_previews WHERE business_id=NEW.id;
  DELETE FROM review_campaigns WHERE business_id=NEW.id;
  DELETE FROM review_reply_to_verifications WHERE business_id=NEW.id;
  DELETE FROM review_settings WHERE business_id=NEW.id;
  DELETE FROM review_permissions WHERE business_id=NEW.id;
  DELETE FROM review_identity_history WHERE business_id=NEW.id;
  DELETE FROM review_suppressions WHERE business_id=NEW.id;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER review_business_tombstone AFTER UPDATE OF owner_id ON public.businesses FOR EACH ROW EXECUTE FUNCTION public.review_business_tombstone();
CREATE FUNCTION public.review_audience_snapshot(p_business uuid,p_contacts uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF cardinality(p_contacts)>500 THEN RAISE EXCEPTION 'invalid_review_audience' USING ERRCODE='22023';END IF;
 RETURN jsonb_build_object(
 'contacts',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'source_channel',source_channel,'email',email,'phone_number',phone_number,'provided_phone_number',provided_phone_number)) FROM contacts WHERE business_id=p_business AND id=ANY(p_contacts)),'[]'),
 'identities',coalesce((SELECT jsonb_agg(to_jsonb(h)) FROM review_identity_history h WHERE business_id=p_business AND contact_id=ANY(p_contacts)),'[]'),
 'permissions',coalesce((SELECT jsonb_agg(to_jsonb(p)) FROM review_permissions p WHERE business_id=p_business AND contact_id=ANY(p_contacts) AND revoked_at IS NULL),'[]'));
END $$;
CREATE FUNCTION public.review_preview_blocks(p_business uuid,p_recipients jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r jsonb;v_ids text[];v_result jsonb:='[]';
BEGIN
 IF jsonb_array_length(p_recipients)>500 THEN RAISE EXCEPTION 'invalid_review_audience' USING ERRCODE='22023';END IF;
 FOR r IN SELECT * FROM jsonb_array_elements(p_recipients) LOOP
  SELECT array_agg(value) INTO v_ids FROM jsonb_array_elements_text(r->'identities');
  v_result:=v_result||jsonb_build_array(jsonb_build_object('contactId',r->>'contactId','reason',review_recipient_block(p_business,(r->>'contactId')::uuid,r->>'destination',v_ids)));
 END LOOP;RETURN v_result;
END $$;
DO $$ DECLARE t text; f record; BEGIN
 FOREACH t IN ARRAY ARRAY['review_email_control','review_settings','review_reply_to_verifications','review_campaign_previews','review_campaigns','review_enrollments','review_identity_history','review_permissions','review_suppressions','review_email_usage','review_email_outbox','review_email_provider_events'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated',t);
  EXECUTE format('GRANT ALL ON public.%I TO service_role',t);
 END LOOP;
 FOR f IN SELECT oid::regprocedure AS signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'review_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',f.signature);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
 END LOOP;
END $$;
