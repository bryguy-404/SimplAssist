BEGIN;

-- Retain the existing private alert transport and its OFF/pilot controls.
-- Sign-up-link notifications describe provider acceptance, never registration.
ALTER TABLE public.owner_booking_alert_outbox
  ADD COLUMN voice_action_id uuid REFERENCES public.voice_actions(id) ON DELETE CASCADE,
  DROP CONSTRAINT owner_booking_alert_outbox_kind_check,
  ADD CONSTRAINT owner_booking_alert_outbox_kind_check CHECK(kind IN ('booking','enrollment','signup_link')),
  ADD CONSTRAINT owner_booking_alert_signup_source CHECK((kind='signup_link')=(voice_action_id IS NOT NULL));
CREATE UNIQUE INDEX owner_booking_alert_signup_once ON public.owner_booking_alert_outbox(voice_action_id) WHERE kind='signup_link';

-- Per-kind eligibility is also checked at send time. A sign-up goal must never
-- unlock the existing booking path just because it can enroll for alerts.
CREATE FUNCTION public.owner_booking_alert_kind_eligible(p_business_id uuid,p_kind text,p_owner_id uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.businesses b WHERE b.id=p_business_id
   AND b.owner_id IS NOT NULL AND (p_owner_id IS NULL OR b.owner_id=p_owner_id)
   AND b.deleted_at IS NULL AND b.operations_suspended_at IS NULL
   AND public.website_scan_has_ai_customization_entitlement(b.id)
   AND ((p_kind='signup_link' AND b.primary_goal='signup'
     AND CASE WHEN EXISTS(SELECT 1 FROM public.subscriptions sub WHERE sub.business_id=b.id)
       THEN EXISTS(SELECT 1 FROM public.subscriptions sub WHERE sub.business_id=b.id
         AND sub.status IN ('active','trialing','past_due') AND public.get_business_effective_service_plan(b.id,sub.plan)='full')
       WHEN b.billing_mode IN ('invoiced','comped') THEN b.partner_plan='full'
       WHEN b.billing_mode='stripe' AND b.partner_plan IS NULL AND (b.billing_pilot OR b.billing_comped OR b.billing_exempt) THEN true
       ELSE false END
     AND b.goal_url=btrim(b.goal_url) AND char_length(b.goal_url) BETWEEN 9 AND 2048
     AND b.goal_url ~ '^https://[^[:space:]/?#]+([/?#][^[:space:]]*)?$')
   OR (p_kind='booking' AND b.primary_goal='book' AND b.bookings_paused_at IS NULL
     AND EXISTS(SELECT 1 FROM public.ai_settings ai WHERE ai.business_id=b.id AND ai.booking_enabled AND ai.booking_mode='schedule_direct')
     AND EXISTS(SELECT 1 FROM public.google_calendar_tokens c WHERE c.business_id=b.id AND nullif(c.calendar_id,'') IS NOT NULL))));
$$;
CREATE OR REPLACE FUNCTION public.owner_booking_alert_business_eligible(p_business_id uuid,p_owner_id uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT public.owner_booking_alert_kind_eligible(p_business_id,'booking',p_owner_id)
   OR public.owner_booking_alert_kind_eligible(p_business_id,'signup_link',p_owner_id);
$$;

CREATE FUNCTION public.owner_booking_alert_signup_source_valid(p_action_id uuid,p_business_id uuid,p_verified_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.voice_actions a
   JOIN public.voice_sessions vs ON vs.id=a.session_id
   JOIN public.conversations conv ON conv.id=vs.action_conversation_id
   WHERE a.id=p_action_id AND a.business_id=p_business_id AND a.kind='signup' AND a.status='succeeded'
     AND a.confirmed_at IS NOT NULL AND a.sms_accepted_at IS NOT NULL
     AND a.sms_accepted_at>=p_verified_at AND a.sms_accepted_at<=now()+interval '1 minute'
     AND a.sms_accepted_at>now()-interval '24 hours'
     AND nullif(btrim(a.sms_provider_message_id),'') IS NOT NULL
     AND a.result->>'providerMessageId'=a.sms_provider_message_id
     AND lower(coalesce(a.result->>'deliveryStatus','')) NOT IN ('failed','delivery_failed','sending_failed','expired','cancelled','rejected')
     AND vs.business_id=a.business_id AND vs.action_business_id=a.business_id
     AND NOT vs.demo_mode AND vs.response_mode='voice'
     AND vs.conversation_id=vs.action_conversation_id
     AND conv.business_id=a.business_id AND conv.channel='voice');
$$;

CREATE OR REPLACE FUNCTION public.owner_booking_alert_send_allowed(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.owner_booking_alert_outbox o
   JOIN public.owner_booking_alert_settings s ON s.business_id=o.business_id
   JOIN public.businesses b ON b.id=o.business_id
   JOIN public.owner_booking_alert_control c ON c.singleton
   WHERE o.id=p_id AND c.enabled AND c.sender=o.sender AND c.messaging_profile_id=o.messaging_profile_id
     AND (c.pilot_business_ids IS NULL OR o.business_id=ANY(c.pilot_business_ids))
     AND s.enabled AND s.generation=o.generation AND s.recipient=o.recipient AND s.owner_id=o.owner_id
     AND b.owner_id=o.owner_id AND b.deleted_at IS NULL AND s.verified_at IS NOT NULL
     AND public.owner_booking_alert_business_eligible(b.id)
     AND (b.primary_goal<>'signup' OR s.consent_version='2026-09-24-v2')
     AND NOT EXISTS(SELECT 1 FROM public.owner_booking_alert_recipients r WHERE r.recipient=o.recipient AND r.suppressed)
     AND NOT EXISTS(SELECT 1 FROM public.phone_numbers n WHERE n.phone_number=o.recipient)
     AND o.recipient<>o.sender AND o.expires_at>now()
     AND (o.kind='enrollment'
       OR (o.kind='booking' AND public.owner_booking_alert_kind_eligible(b.id,'booking')
         AND EXISTS(SELECT 1 FROM public.calendar_bookings cb WHERE cb.id=o.booking_id AND cb.business_id=o.business_id AND cb.status='confirmed' AND cb.starts_at>now()))
       OR (o.kind='signup_link' AND s.consent_version='2026-09-24-v2'
         AND public.owner_booking_alert_kind_eligible(b.id,'signup_link')
         AND public.owner_booking_alert_signup_source_valid(o.voice_action_id,b.id,s.verified_at))));
$$;

CREATE OR REPLACE FUNCTION public.configure_owner_booking_alert(
 p_business_id uuid,p_owner_id uuid,p_expected_revision integer,p_action text,
 p_recipient text DEFAULT NULL,p_challenge_digest text DEFAULT NULL,p_consent_version text DEFAULT NULL,
 p_disclosure text DEFAULT NULL,p_verification_expires_at timestamptz DEFAULT NULL)
RETURNS public.owner_booking_alert_settings LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.owner_booking_alert_settings; v public.owner_booking_alert_verifications;
BEGIN
 PERFORM 1 FROM public.businesses WHERE id=p_business_id AND owner_id=p_owner_id AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND OR p_owner_id IS NULL THEN RAISE EXCEPTION 'booking alert access denied' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(930093);
 INSERT INTO public.owner_booking_alert_settings(business_id,owner_id) VALUES(p_business_id,p_owner_id) ON CONFLICT DO NOTHING;
 SELECT * INTO s FROM public.owner_booking_alert_settings WHERE business_id=p_business_id FOR UPDATE;
 IF s.owner_id<>p_owner_id OR s.revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'booking alert settings conflict' USING ERRCODE='40001'; END IF;
 IF p_action='enroll' THEN
   IF NOT public.owner_booking_alert_business_eligible(p_business_id) THEN RAISE EXCEPTION 'booking alerts unavailable' USING ERRCODE='42501'; END IF;
   IF p_recipient IS NULL OR p_recipient !~ '^\+1[2-9][0-9]{9}$' OR p_challenge_digest IS NULL OR p_challenge_digest !~ '^[0-9a-f]{64}$'
      OR (EXISTS(SELECT 1 FROM public.businesses WHERE id=p_business_id AND primary_goal='signup') AND p_consent_version IS DISTINCT FROM '2026-09-24-v2')
      OR nullif(p_consent_version,'') IS NULL OR length(p_consent_version)>100 OR nullif(p_disclosure,'') IS NULL OR length(p_disclosure)>4000
      OR p_verification_expires_at IS NULL OR p_verification_expires_at<=now() OR p_verification_expires_at>now()+interval '15 minutes'
      OR EXISTS(SELECT 1 FROM public.phone_numbers WHERE phone_number=p_recipient)
      OR EXISTS(SELECT 1 FROM public.owner_booking_alert_control WHERE sender=p_recipient) THEN
     RAISE EXCEPTION 'invalid booking alert enrollment' USING ERRCODE='22023'; END IF;
   IF (SELECT count(*) FROM public.owner_booking_alert_verifications WHERE business_id=p_business_id AND created_at>now()-interval '1 hour')>=5
      OR (SELECT count(*) FROM public.owner_booking_alert_verifications WHERE recipient=p_recipient AND created_at>now()-interval '1 hour')>=10 THEN
     RAISE EXCEPTION 'booking alert verification rate limited' USING ERRCODE='P0429'; END IF;
   INSERT INTO public.owner_booking_alert_verifications(business_id,owner_id,recipient,challenge_digest,consent_version,disclosure,expires_at)
     VALUES(p_business_id,p_owner_id,p_recipient,p_challenge_digest,p_consent_version,p_disclosure,p_verification_expires_at) RETURNING * INTO v;
   INSERT INTO public.owner_booking_alert_consent_events(business_id,owner_id,recipient,action,consent_version,disclosure,verification_id)
     VALUES(p_business_id,p_owner_id,p_recipient,'requested',p_consent_version,p_disclosure,v.id);
   UPDATE public.owner_booking_alert_settings SET pending_recipient=p_recipient,pending_verification_id=v.id,revision=revision+1,updated_at=now() WHERE business_id=p_business_id RETURNING * INTO s;
 ELSIF p_action='disable' THEN
   INSERT INTO public.owner_booking_alert_consent_events(business_id,owner_id,recipient,action,consent_version,disclosure)
     VALUES(p_business_id,p_owner_id,s.recipient,'disabled',s.consent_version,s.disclosure);
   UPDATE public.owner_booking_alert_settings SET enabled=false,generation=gen_random_uuid(),pending_recipient=NULL,pending_verification_id=NULL,revision=revision+1,updated_at=now() WHERE business_id=p_business_id RETURNING * INTO s;
   UPDATE public.owner_booking_alert_outbox SET status='cancelled',claim_token=NULL,lease_until=NULL,updated_at=now() WHERE business_id=p_business_id AND status IN ('pending','claimed');
 ELSIF p_action='dismiss' THEN
   UPDATE public.owner_booking_alert_settings SET nudge_dismissed_at=now(),revision=revision+1,updated_at=now() WHERE business_id=p_business_id RETURNING * INTO s;
 ELSE RAISE EXCEPTION 'invalid booking alert action' USING ERRCODE='22023'; END IF;
 RETURN s;
END $$;

CREATE OR REPLACE FUNCTION public.consume_owner_booking_alert_verification(p_challenge_digest text,p_recipient text,p_sender text,p_profile_id text,p_event_id text)
RETURNS public.owner_booking_alert_settings LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v public.owner_booking_alert_verifications; s public.owner_booking_alert_settings; c public.owner_booking_alert_control;
BEGIN
 -- Match the calendar RPC's business-before-alert lock order. Holding the
 -- program lock before an INSERT's business FK check can deadlock a booking.
 SELECT * INTO v FROM public.owner_booking_alert_verifications WHERE challenge_digest=p_challenge_digest AND recipient=p_recipient;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM 1 FROM public.businesses WHERE id=v.business_id AND owner_id=v.owner_id AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(930093);
 SELECT * INTO c FROM public.owner_booking_alert_control WHERE singleton AND enabled AND sender=p_sender AND messaging_profile_id=p_profile_id;
 IF NOT FOUND OR nullif(p_event_id,'') IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO v FROM public.owner_booking_alert_verifications WHERE challenge_digest=p_challenge_digest AND recipient=p_recipient FOR UPDATE;
 IF NOT FOUND OR v.consumed_at IS NOT NULL OR v.expires_at<=now() THEN RETURN NULL; END IF;
 SELECT * INTO s FROM public.owner_booking_alert_settings WHERE business_id=v.business_id AND owner_id=v.owner_id AND pending_verification_id=v.id AND pending_recipient=v.recipient FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.businesses WHERE id=v.business_id AND owner_id=v.owner_id AND deleted_at IS NULL)
    OR NOT public.owner_booking_alert_business_eligible(v.business_id)
    OR (EXISTS(SELECT 1 FROM public.businesses WHERE id=v.business_id AND primary_goal='signup') AND v.consent_version IS DISTINCT FROM '2026-09-24-v2')
    OR (c.pilot_business_ids IS NOT NULL AND NOT v.business_id=ANY(c.pilot_business_ids))
    OR EXISTS(SELECT 1 FROM public.owner_booking_alert_recipients WHERE recipient=v.recipient AND suppressed)
    OR v.recipient=p_sender OR EXISTS(SELECT 1 FROM public.phone_numbers WHERE phone_number=v.recipient) THEN RETURN NULL; END IF;
 UPDATE public.owner_booking_alert_verifications SET consumed_at=now(),event_id=p_event_id WHERE id=v.id;
 UPDATE public.owner_booking_alert_settings SET recipient=v.recipient,verified_at=now(),consent_version=v.consent_version,disclosure=v.disclosure,
   enabled=true,generation=gen_random_uuid(),pending_recipient=NULL,pending_verification_id=NULL,revision=revision+1,updated_at=now() WHERE business_id=v.business_id RETURNING * INTO s;
 UPDATE public.owner_booking_alert_outbox SET status='cancelled',claim_token=NULL,lease_until=NULL,updated_at=now() WHERE business_id=v.business_id AND status IN ('pending','claimed');
 INSERT INTO public.owner_booking_alert_consent_events(business_id,owner_id,recipient,action,consent_version,disclosure,verification_id,provider_event_id)
   VALUES(v.business_id,v.owner_id,v.recipient,'verified',v.consent_version,v.disclosure,v.id,p_event_id);
 INSERT INTO public.owner_booking_alert_outbox(business_id,owner_id,kind,generation,recipient,sender,messaging_profile_id,expires_at)
   VALUES(s.business_id,s.owner_id,'enrollment',s.generation,s.recipient,c.sender,c.messaging_profile_id,now()+interval '1 hour');
 RETURN s;
END $$;

CREATE OR REPLACE FUNCTION public.enqueue_owner_booking_alert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.owner_booking_alert_settings; c public.owner_booking_alert_control;
BEGIN
 IF OLD.status<>'pending' OR NEW.status<>'confirmed' OR NEW.starts_at<=now() THEN RETURN NEW; END IF;
 PERFORM 1 FROM public.businesses WHERE id=NEW.business_id FOR UPDATE;
 PERFORM pg_advisory_xact_lock(930093);
 SELECT * INTO c FROM public.owner_booking_alert_control WHERE singleton AND enabled;
 IF NOT FOUND OR (c.pilot_business_ids IS NOT NULL AND NOT NEW.business_id=ANY(c.pilot_business_ids)) THEN RETURN NEW; END IF;
 SELECT * INTO s FROM public.owner_booking_alert_settings WHERE business_id=NEW.business_id AND enabled;
 IF NOT FOUND OR NOT public.owner_booking_alert_kind_eligible(NEW.business_id,'booking')
   OR NOT EXISTS(SELECT 1 FROM public.businesses WHERE id=NEW.business_id AND owner_id=s.owner_id AND deleted_at IS NULL)
   OR EXISTS(SELECT 1 FROM public.owner_booking_alert_recipients WHERE recipient=s.recipient AND suppressed)
   OR s.recipient=c.sender OR EXISTS(SELECT 1 FROM public.phone_numbers WHERE phone_number=s.recipient) THEN RETURN NEW; END IF;
 INSERT INTO public.owner_booking_alert_outbox(business_id,owner_id,booking_id,kind,generation,recipient,sender,messaging_profile_id,expires_at)
   VALUES(NEW.business_id,s.owner_id,NEW.id,'booking',s.generation,s.recipient,c.sender,c.messaging_profile_id,least(NEW.starts_at,now()+interval '24 hours')) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;

CREATE FUNCTION public.enqueue_owner_signup_link_alert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.owner_booking_alert_settings; c public.owner_booking_alert_control; accepted_at timestamptz;
BEGIN
 -- Provider acceptance is persisted before this optional bookkeeping event.
 -- Recovery may retry the event using its original acceptance timestamp, but
 -- never creates an alert for historical sends or owners enrolled afterward.
 IF NEW.origin_kind<>'voice_action' OR NEW.goal_at_event<>'signup' OR NEW.event_type<>'link_sent'
   OR NEW.channel<>'sms' OR NEW.time_source<>'provider_accepted' OR NEW.voice_action_id IS NULL THEN RETURN NEW; END IF;
 SELECT sms_accepted_at INTO accepted_at FROM public.voice_actions WHERE id=NEW.voice_action_id AND business_id=NEW.business_id;
 IF accepted_at IS NULL OR accepted_at IS DISTINCT FROM NEW.occurred_at THEN RETURN NEW; END IF;
 -- The bookkeeping RPC/tenant validation already acquires the business lock
 -- before this advisory lock. Never upgrade it here after accepting caller SMS.
 PERFORM pg_advisory_xact_lock(930093);
 SELECT * INTO c FROM public.owner_booking_alert_control WHERE singleton AND enabled;
 IF NOT FOUND OR (c.pilot_business_ids IS NOT NULL AND NOT NEW.business_id=ANY(c.pilot_business_ids)) THEN RETURN NEW; END IF;
 SELECT * INTO s FROM public.owner_booking_alert_settings WHERE business_id=NEW.business_id AND enabled;
 IF NOT FOUND OR s.consent_version IS DISTINCT FROM '2026-09-24-v2'
   OR NOT public.owner_booking_alert_kind_eligible(NEW.business_id,'signup_link',s.owner_id)
   OR NOT public.owner_booking_alert_signup_source_valid(NEW.voice_action_id,NEW.business_id,s.verified_at)
   OR EXISTS(SELECT 1 FROM public.owner_booking_alert_recipients WHERE recipient=s.recipient AND suppressed)
   OR s.recipient=c.sender OR EXISTS(SELECT 1 FROM public.phone_numbers WHERE phone_number=s.recipient) THEN RETURN NEW; END IF;
 INSERT INTO public.owner_booking_alert_outbox(business_id,owner_id,voice_action_id,kind,generation,recipient,sender,messaging_profile_id,expires_at)
   VALUES(NEW.business_id,s.owner_id,NEW.voice_action_id,'signup_link',s.generation,s.recipient,c.sender,c.messaging_profile_id,accepted_at+interval '24 hours') ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER enqueue_owner_signup_link_alert AFTER INSERT ON public.goal_events FOR EACH ROW EXECUTE FUNCTION public.enqueue_owner_signup_link_alert();

CREATE OR REPLACE FUNCTION public.begin_owner_booking_alert_send(p_id uuid,p_claim_token uuid,p_attempt_id uuid,p_content text,p_link_token_digest text DEFAULT NULL)
RETURNS public.owner_booking_alert_outbox LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.owner_booking_alert_outbox; c public.owner_booking_alert_control;
BEGIN
 PERFORM pg_advisory_xact_lock(930093);
 SELECT * INTO o FROM public.owner_booking_alert_outbox WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR o.status<>'claimed' OR o.claim_token IS DISTINCT FROM p_claim_token OR p_claim_token IS NULL OR o.lease_until<=now() THEN RETURN NULL; END IF;
 IF NOT public.owner_booking_alert_send_allowed(o.id) THEN
   UPDATE public.owner_booking_alert_outbox SET status='cancelled',claim_token=NULL,lease_until=NULL,updated_at=now() WHERE id=o.id RETURNING * INTO o; RETURN o; END IF;
 SELECT * INTO c FROM public.owner_booking_alert_control WHERE singleton FOR UPDATE;
 IF c.next_send_at>now() THEN
   UPDATE public.owner_booking_alert_outbox SET status='pending',next_attempt_at=c.next_send_at,claim_token=NULL,lease_until=NULL,updated_at=now() WHERE id=o.id RETURNING * INTO o;
   RETURN o;
 END IF;
 IF p_attempt_id IS NULL OR nullif(p_content,'') IS NULL OR length(p_content)>1600
   OR (p_link_token_digest IS NOT NULL AND p_link_token_digest !~ '^[0-9a-f]{64}$')
   OR (o.kind IN ('booking','signup_link') AND p_link_token_digest IS NULL)
   OR (o.content IS NOT NULL AND (o.content IS DISTINCT FROM p_content OR o.link_token_digest IS DISTINCT FROM p_link_token_digest)) THEN
   RAISE EXCEPTION 'invalid booking alert send' USING ERRCODE='22023'; END IF;
 UPDATE public.owner_booking_alert_control SET next_send_at=now()+interval '1 second' WHERE singleton;
 UPDATE public.owner_booking_alert_outbox SET status='submitting',content=p_content,link_token_digest=p_link_token_digest,
   link_expires_at=CASE WHEN p_link_token_digest IS NOT NULL THEN coalesce(link_expires_at,now()+interval '90 days') ELSE NULL END,
   attempt_id=p_attempt_id,attempt_count=attempt_count+1,lease_until=now()+interval '2 minutes',updated_at=now() WHERE id=o.id RETURNING * INTO o;
 RETURN o;
END $$;

-- Existing table RLS, consent evidence, STOP serialization, sender/pilot gates,
-- owner/generation fencing, and at-most-once transport remain in force.
DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN
   ('owner_booking_alert_kind_eligible','owner_booking_alert_signup_source_valid','enqueue_owner_signup_link_alert') LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f);
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
 END LOOP;
END $$;
COMMIT;
