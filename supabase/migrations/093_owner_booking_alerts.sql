BEGIN;

-- This program is independent of customer messaging and is OFF after migration.
-- Activation requires a reviewed sender/profile plus the application's own gate.
CREATE TABLE public.owner_booking_alert_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false,
  sender text CHECK(sender ~ '^\+[1-9][0-9]{7,14}$'),
  messaging_profile_id text,
  pilot_business_ids uuid[],
  next_send_at timestamptz,
  CHECK(NOT enabled OR (sender IS NOT NULL AND nullif(messaging_profile_id,'') IS NOT NULL))
);
INSERT INTO public.owner_booking_alert_control(singleton) VALUES(true);

CREATE TABLE public.owner_booking_alert_settings (
  business_id uuid PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  enabled boolean NOT NULL DEFAULT false,
  recipient text CHECK(recipient ~ '^\+[1-9][0-9]{7,14}$'),
  verified_at timestamptz,
  consent_version text,
  disclosure text,
  pending_recipient text CHECK(pending_recipient ~ '^\+[1-9][0-9]{7,14}$'),
  pending_verification_id uuid,
  nudge_dismissed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(NOT enabled OR (recipient IS NOT NULL AND verified_at IS NOT NULL AND consent_version IS NOT NULL AND disclosure IS NOT NULL))
);
CREATE TABLE public.owner_booking_alert_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  recipient text NOT NULL CHECK(recipient ~ '^\+[1-9][0-9]{7,14}$'),
  challenge_digest text NOT NULL UNIQUE CHECK(challenge_digest ~ '^[0-9a-f]{64}$'),
  consent_version text NOT NULL,
  disclosure text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  event_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX owner_booking_alert_verification_business ON public.owner_booking_alert_verifications(business_id,created_at);
CREATE INDEX owner_booking_alert_verification_recipient ON public.owner_booking_alert_verifications(recipient,created_at);
CREATE INDEX owner_booking_alert_verification_cleanup ON public.owner_booking_alert_verifications(expires_at);
CREATE TABLE public.owner_booking_alert_consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  recipient text,
  action text NOT NULL CHECK(action IN ('requested','verified','disabled','stopped','owner_changed','deleted')),
  consent_version text,
  disclosure text,
  verification_id uuid,
  provider_event_id text,
  source_path text NOT NULL DEFAULT '/settings#booking-alerts',
  created_at timestamptz NOT NULL DEFAULT now()
);
-- A recipient may enroll for several businesses. Carrier STOP applies to all.
CREATE TABLE public.owner_booking_alert_recipients (
  recipient text PRIMARY KEY CHECK(recipient ~ '^\+[1-9][0-9]{7,14}$'),
  suppressed boolean NOT NULL DEFAULT false,
  suppressed_at timestamptz,
  provider_event_at timestamptz,
  provider_event_id text
);
CREATE TABLE public.owner_booking_alert_suppression_events (
  provider_event_id text PRIMARY KEY,
  recipient text NOT NULL,
  suppressed boolean NOT NULL,
  provider_event_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.owner_booking_alert_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  booking_id uuid REFERENCES public.calendar_bookings(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('booking','enrollment')),
  generation uuid NOT NULL,
  recipient text NOT NULL,
  sender text NOT NULL,
  messaging_profile_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','submitting','accepted','delivered','failed','uncertain','cancelled','expired')),
  content text CHECK(length(content) BETWEEN 1 AND 1600),
  link_token_digest text UNIQUE CHECK(link_token_digest ~ '^[0-9a-f]{64}$'),
  link_expires_at timestamptz,
  attempt_id uuid UNIQUE,
  claim_token uuid,
  lease_until timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 3),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  provider_message_id text UNIQUE,
  accepted_at timestamptz,
  delivered_at timestamptz,
  parts integer CHECK(parts BETWEEN 1 AND 100),
  cost_amount numeric(18,8) CHECK(cost_amount>=0),
  cost_currency text CHECK(cost_currency ~ '^[A-Z]{3}$'),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((kind='booking')=(booking_id IS NOT NULL)),
  CHECK((link_token_digest IS NULL)=(link_expires_at IS NULL))
);
CREATE UNIQUE INDEX owner_booking_alert_booking_once ON public.owner_booking_alert_outbox(booking_id,kind) WHERE kind='booking';
CREATE UNIQUE INDEX owner_booking_alert_enrollment_once ON public.owner_booking_alert_outbox(generation,kind) WHERE kind='enrollment';
CREATE INDEX owner_booking_alert_due ON public.owner_booking_alert_outbox(next_attempt_at) WHERE status IN ('pending','claimed','submitting');
CREATE INDEX owner_booking_alert_outbox_cleanup ON public.owner_booking_alert_outbox(expires_at);
CREATE TABLE public.owner_booking_alert_webhook_events (
  id text PRIMARY KEY,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error_code text
);
CREATE INDEX owner_booking_alert_webhook_cleanup ON public.owner_booking_alert_webhook_events(created_at) WHERE processed_at IS NOT NULL;
CREATE TABLE public.owner_booking_alert_lookup_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  recipient text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX owner_booking_alert_lookup_business ON public.owner_booking_alert_lookup_attempts(business_id,created_at);
CREATE INDEX owner_booking_alert_lookup_recipient ON public.owner_booking_alert_lookup_attempts(recipient,created_at);
CREATE INDEX owner_booking_alert_lookup_cleanup ON public.owner_booking_alert_lookup_attempts(created_at);

CREATE FUNCTION public.owner_booking_alert_business_eligible(p_business_id uuid,p_owner_id uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM public.businesses b WHERE b.id=p_business_id
   AND b.owner_id IS NOT NULL AND (p_owner_id IS NULL OR b.owner_id=p_owner_id) AND b.deleted_at IS NULL AND b.operations_suspended_at IS NULL AND b.primary_goal='book' AND b.bookings_paused_at IS NULL
   AND public.website_scan_has_ai_customization_entitlement(b.id)
   AND EXISTS(SELECT 1 FROM public.ai_settings ai WHERE ai.business_id=b.id AND ai.booking_enabled AND ai.booking_mode='schedule_direct')
   AND EXISTS(SELECT 1 FROM public.google_calendar_tokens c WHERE c.business_id=b.id AND nullif(c.calendar_id,'') IS NOT NULL));
$$;
CREATE FUNCTION public.reserve_owner_booking_alert_lookup(p_business_id uuid,p_owner_id uuid,p_recipient text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM 1 FROM public.businesses WHERE id=p_business_id AND owner_id=p_owner_id AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND OR p_owner_id IS NULL OR p_recipient IS NULL OR p_recipient !~ '^\+1[2-9][0-9]{9}$' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(930093);
 IF NOT public.owner_booking_alert_business_eligible(p_business_id,p_owner_id)
   OR (SELECT count(*) FROM public.owner_booking_alert_lookup_attempts WHERE business_id=p_business_id AND created_at>now()-interval '1 hour')>=10
   OR (SELECT count(*) FROM public.owner_booking_alert_lookup_attempts WHERE recipient=p_recipient AND created_at>now()-interval '1 hour')>=20 THEN RETURN false; END IF;
 INSERT INTO public.owner_booking_alert_lookup_attempts(business_id,recipient) VALUES(p_business_id,p_recipient);
 RETURN true;
END $$;
CREATE FUNCTION public.owner_booking_alert_send_allowed(p_id uuid) RETURNS boolean
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
     AND NOT EXISTS(SELECT 1 FROM public.owner_booking_alert_recipients r WHERE r.recipient=o.recipient AND r.suppressed)
     AND NOT EXISTS(SELECT 1 FROM public.phone_numbers n WHERE n.phone_number=o.recipient)
     AND o.recipient<>o.sender AND o.expires_at>now()
     AND (o.kind='enrollment' OR EXISTS(SELECT 1 FROM public.calendar_bookings cb WHERE cb.id=o.booking_id AND cb.business_id=o.business_id AND cb.status='confirmed' AND cb.starts_at>now())));
$$;

-- All alert-state mutations use one short transaction advisory lock. No network
-- work is done while locked; it closes enrollment/STOP/claim races across tenants.
CREATE FUNCTION public.configure_owner_booking_alert(
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

CREATE FUNCTION public.consume_owner_booking_alert_verification(p_challenge_digest text,p_recipient text,p_sender text,p_profile_id text,p_event_id text)
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

CREATE FUNCTION public.set_owner_booking_alert_suppression(p_recipient text,p_suppressed boolean,p_event_at timestamptz,p_event_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r public.owner_booking_alert_recipients;
BEGIN
 IF p_recipient IS NULL OR p_recipient !~ '^\+[1-9][0-9]{7,14}$' OR p_event_at IS NULL OR p_suppressed IS NULL OR nullif(p_event_id,'') IS NULL THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(930093);
 INSERT INTO public.owner_booking_alert_recipients(recipient) VALUES(p_recipient) ON CONFLICT DO NOTHING;
 SELECT * INTO r FROM public.owner_booking_alert_recipients WHERE recipient=p_recipient FOR UPDATE;
 -- At equal timestamps STOP wins. A START does not re-enable any subscription.
 IF r.provider_event_at>p_event_at OR (r.provider_event_at=p_event_at AND (r.suppressed OR NOT p_suppressed)) THEN RETURN false; END IF;
 UPDATE public.owner_booking_alert_recipients SET suppressed=p_suppressed,suppressed_at=CASE WHEN p_suppressed THEN p_event_at ELSE NULL END,provider_event_at=p_event_at,provider_event_id=p_event_id WHERE recipient=p_recipient;
 -- Recipient-scoped audit intentionally has no business FK: STOP is global
 -- across businesses and must not invert their existing booking mutex order.
 INSERT INTO public.owner_booking_alert_suppression_events(provider_event_id,recipient,suppressed,provider_event_at)
   VALUES(p_event_id,p_recipient,p_suppressed,p_event_at) ON CONFLICT DO NOTHING;
 IF p_suppressed THEN
   UPDATE public.owner_booking_alert_settings SET enabled=CASE WHEN recipient=p_recipient THEN false ELSE enabled END,
     pending_recipient=NULL,pending_verification_id=NULL,revision=revision+1,updated_at=now() WHERE recipient=p_recipient OR pending_recipient=p_recipient;
   UPDATE public.owner_booking_alert_outbox SET status='cancelled',claim_token=NULL,lease_until=NULL,updated_at=now() WHERE recipient=p_recipient AND status IN ('pending','claimed');
 END IF;
 RETURN true;
END $$;

CREATE FUNCTION public.enqueue_owner_booking_alert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s public.owner_booking_alert_settings; c public.owner_booking_alert_control;
BEGIN
 IF OLD.status<>'pending' OR NEW.status<>'confirmed' OR NEW.starts_at<=now() THEN RETURN NEW; END IF;
 PERFORM 1 FROM public.businesses WHERE id=NEW.business_id FOR UPDATE;
 PERFORM pg_advisory_xact_lock(930093);
 SELECT * INTO c FROM public.owner_booking_alert_control WHERE singleton AND enabled;
 IF NOT FOUND OR (c.pilot_business_ids IS NOT NULL AND NOT NEW.business_id=ANY(c.pilot_business_ids)) THEN RETURN NEW; END IF;
 SELECT * INTO s FROM public.owner_booking_alert_settings WHERE business_id=NEW.business_id AND enabled;
 IF NOT FOUND OR NOT public.owner_booking_alert_business_eligible(NEW.business_id)
   OR NOT EXISTS(SELECT 1 FROM public.businesses WHERE id=NEW.business_id AND owner_id=s.owner_id AND deleted_at IS NULL)
   OR EXISTS(SELECT 1 FROM public.owner_booking_alert_recipients WHERE recipient=s.recipient AND suppressed)
   OR s.recipient=c.sender OR EXISTS(SELECT 1 FROM public.phone_numbers WHERE phone_number=s.recipient) THEN RETURN NEW; END IF;
 INSERT INTO public.owner_booking_alert_outbox(business_id,owner_id,booking_id,kind,generation,recipient,sender,messaging_profile_id,expires_at)
   VALUES(NEW.business_id,s.owner_id,NEW.id,'booking',s.generation,s.recipient,c.sender,c.messaging_profile_id,least(NEW.starts_at,now()+interval '24 hours')) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER enqueue_owner_booking_alert AFTER UPDATE OF status ON public.calendar_bookings FOR EACH ROW EXECUTE FUNCTION public.enqueue_owner_booking_alert();

CREATE FUNCTION public.claim_owner_booking_alerts(p_limit integer DEFAULT 20) RETURNS SETOF public.owner_booking_alert_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(930093);
 UPDATE public.owner_booking_alert_outbox SET status='uncertain',claim_token=NULL,lease_until=NULL,error_code='submission_lease_expired',updated_at=now() WHERE status='submitting' AND lease_until<=now();
 UPDATE public.owner_booking_alert_outbox SET status='pending',claim_token=NULL,lease_until=NULL,updated_at=now() WHERE status='claimed' AND lease_until<=now();
 UPDATE public.owner_booking_alert_outbox SET status='expired',claim_token=NULL,lease_until=NULL,updated_at=now() WHERE status IN ('pending','claimed') AND expires_at<=now();
 UPDATE public.owner_booking_alert_outbox SET status='cancelled',claim_token=NULL,lease_until=NULL,updated_at=now() WHERE status IN ('pending','claimed') AND NOT public.owner_booking_alert_send_allowed(id);
 RETURN QUERY UPDATE public.owner_booking_alert_outbox o SET status='claimed',claim_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',updated_at=now()
 WHERE o.id IN (SELECT n.id FROM public.owner_booking_alert_outbox n WHERE n.status='pending' AND n.next_attempt_at<=now() AND n.attempt_count<3
   AND public.owner_booking_alert_send_allowed(n.id) ORDER BY n.created_at,n.id LIMIT greatest(0,least(coalesce(p_limit,20),100)) FOR UPDATE SKIP LOCKED) RETURNING o.*;
END $$;

CREATE FUNCTION public.begin_owner_booking_alert_send(p_id uuid,p_claim_token uuid,p_attempt_id uuid,p_content text,p_link_token_digest text DEFAULT NULL)
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
   OR (o.kind='booking' AND p_link_token_digest IS NULL)
   OR (o.content IS NOT NULL AND (o.content IS DISTINCT FROM p_content OR o.link_token_digest IS DISTINCT FROM p_link_token_digest)) THEN
   RAISE EXCEPTION 'invalid booking alert send' USING ERRCODE='22023'; END IF;
 UPDATE public.owner_booking_alert_control SET next_send_at=now()+interval '1 second' WHERE singleton;
 UPDATE public.owner_booking_alert_outbox SET status='submitting',content=p_content,link_token_digest=p_link_token_digest,
   link_expires_at=CASE WHEN p_link_token_digest IS NOT NULL THEN coalesce(link_expires_at,now()+interval '90 days') ELSE NULL END,
   attempt_id=p_attempt_id,attempt_count=attempt_count+1,lease_until=now()+interval '2 minutes',updated_at=now() WHERE id=o.id RETURNING * INTO o;
 RETURN o;
END $$;
CREATE FUNCTION public.finish_owner_booking_alert_send(p_id uuid,p_claim_token uuid,p_attempt_id uuid,p_status text,p_provider_message_id text DEFAULT NULL,p_error_code text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.owner_booking_alert_outbox;
BEGIN
 PERFORM pg_advisory_xact_lock(930093);
 SELECT * INTO o FROM public.owner_booking_alert_outbox WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR o.attempt_id IS DISTINCT FROM p_attempt_id OR p_attempt_id IS NULL THEN RETURN false; END IF;
 -- A signed callback may have arrived before the API response; it wins.
 IF o.status IN ('accepted','delivered','failed') AND o.provider_message_id IS NOT NULL THEN RETURN o.provider_message_id=p_provider_message_id; END IF;
 IF o.status NOT IN ('submitting','uncertain') OR (o.status='submitting' AND (p_claim_token IS NULL OR o.claim_token IS DISTINCT FROM p_claim_token)) THEN RETURN false; END IF;
 IF p_status='accepted' AND nullif(p_provider_message_id,'') IS NOT NULL THEN
   UPDATE public.owner_booking_alert_outbox SET status='accepted',provider_message_id=p_provider_message_id,accepted_at=coalesce(accepted_at,now()),claim_token=NULL,lease_until=NULL,error_code=NULL,updated_at=now() WHERE id=o.id;
 ELSIF p_status='uncertain' THEN
   UPDATE public.owner_booking_alert_outbox SET status='uncertain',claim_token=NULL,lease_until=NULL,error_code=left(p_error_code,100),updated_at=now() WHERE id=o.id;
 ELSIF o.status='submitting' AND p_status IN ('failed','retry') THEN
   UPDATE public.owner_booking_alert_outbox SET status=CASE WHEN p_status='retry' AND attempt_count<3 AND expires_at>now()+interval '1 minute' THEN 'pending' ELSE 'failed' END,
    next_attempt_at=now()+make_interval(secs=>30*attempt_count),claim_token=NULL,lease_until=NULL,error_code=left(p_error_code,100),updated_at=now() WHERE id=o.id;
 ELSE RETURN false; END IF;
 RETURN true;
END $$;
CREATE FUNCTION public.apply_owner_booking_alert_delivery(p_attempt_id uuid,p_provider_message_id text,p_status text,p_sender text,p_recipient text,p_profile_id text,p_event_at timestamptz,
 p_parts integer DEFAULT NULL,p_cost_amount numeric DEFAULT NULL,p_cost_currency text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o public.owner_booking_alert_outbox;
BEGIN
 IF p_attempt_id IS NULL OR nullif(p_provider_message_id,'') IS NULL OR p_status IS NULL OR p_status NOT IN ('accepted','delivered','failed') OR p_event_at IS NULL
    OR (p_parts IS NOT NULL AND p_parts NOT BETWEEN 1 AND 100) OR (p_cost_amount IS NOT NULL AND (p_cost_amount<0 OR p_cost_amount>=10000000000))
    OR (p_cost_currency IS NOT NULL AND p_cost_currency !~ '^[A-Z]{3}$') THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(930093);
 SELECT * INTO o FROM public.owner_booking_alert_outbox WHERE attempt_id=p_attempt_id AND sender=p_sender AND recipient=p_recipient AND messaging_profile_id=p_profile_id FOR UPDATE;
 IF NOT FOUND OR o.status NOT IN ('submitting','uncertain','accepted','delivered','failed')
    OR (o.provider_message_id IS NOT NULL AND o.provider_message_id<>p_provider_message_id) THEN RETURN false; END IF;
 IF o.status IN ('delivered','failed') AND o.provider_message_id IS NOT NULL THEN
   UPDATE public.owner_booking_alert_outbox SET parts=coalesce(parts,p_parts),cost_amount=coalesce(cost_amount,p_cost_amount),cost_currency=coalesce(cost_currency,p_cost_currency) WHERE id=o.id;
   RETURN true; END IF;
 UPDATE public.owner_booking_alert_outbox SET status=p_status,provider_message_id=p_provider_message_id,accepted_at=coalesce(accepted_at,p_event_at),
   delivered_at=CASE WHEN p_status='delivered' THEN p_event_at ELSE delivered_at END,claim_token=NULL,lease_until=NULL,
   parts=coalesce(parts,p_parts),cost_amount=coalesce(cost_amount,p_cost_amount),cost_currency=coalesce(cost_currency,p_cost_currency),
   error_code=CASE WHEN p_status='failed' THEN 'provider_delivery_failed' ELSE NULL END,updated_at=now() WHERE id=o.id;
 RETURN true;
END $$;

CREATE FUNCTION public.resolve_owner_booking_alert_link(p_token_hash text) RETURNS TABLE(business_id uuid,owner_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT o.business_id,o.owner_id FROM public.owner_booking_alert_outbox o
 JOIN public.businesses b ON b.id=o.business_id JOIN public.owner_booking_alert_settings s ON s.business_id=o.business_id
 WHERE o.link_token_digest=p_token_hash AND o.link_expires_at>now() AND b.deleted_at IS NULL AND b.owner_id=o.owner_id
   AND s.owner_id=o.owner_id AND s.generation=o.generation AND s.recipient=o.recipient;
$$;
CREATE FUNCTION public.cleanup_owner_booking_alerts() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NEW.owner_id IS NOT DISTINCT FROM OLD.owner_id AND (OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL) THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(930093);
 IF NEW.owner_id IS NULL OR NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
   DELETE FROM public.owner_booking_alert_outbox WHERE business_id=NEW.id;
   DELETE FROM public.owner_booking_alert_verifications WHERE business_id=NEW.id;
   DELETE FROM public.owner_booking_alert_lookup_attempts WHERE business_id=NEW.id;
   DELETE FROM public.owner_booking_alert_consent_events WHERE business_id=NEW.id;
   DELETE FROM public.owner_booking_alert_settings WHERE business_id=NEW.id;
 ELSE
   INSERT INTO public.owner_booking_alert_consent_events(business_id,owner_id,recipient,action,consent_version,disclosure)
     SELECT business_id,owner_id,recipient,'deleted',consent_version,disclosure FROM public.owner_booking_alert_settings WHERE business_id=NEW.id;
   UPDATE public.owner_booking_alert_settings SET enabled=false,generation=gen_random_uuid(),pending_recipient=NULL,pending_verification_id=NULL,revision=revision+1,updated_at=now() WHERE business_id=NEW.id;
   DELETE FROM public.owner_booking_alert_verifications WHERE business_id=NEW.id;
   UPDATE public.owner_booking_alert_outbox SET status='cancelled',claim_token=NULL,lease_until=NULL,updated_at=now() WHERE business_id=NEW.id AND status IN ('pending','claimed');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cleanup_owner_booking_alerts AFTER UPDATE OF owner_id,deleted_at ON public.businesses FOR EACH ROW EXECUTE FUNCTION public.cleanup_owner_booking_alerts();

CREATE FUNCTION public.purge_owner_booking_alert_operational_data() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 DELETE FROM public.owner_booking_alert_webhook_events WHERE id IN (SELECT id FROM public.owner_booking_alert_webhook_events WHERE processed_at IS NOT NULL AND created_at<now()-interval '30 days' ORDER BY created_at LIMIT 500);
 DELETE FROM public.owner_booking_alert_verifications WHERE id IN (SELECT id FROM public.owner_booking_alert_verifications WHERE expires_at<now()-interval '1 day' ORDER BY expires_at LIMIT 500);
 DELETE FROM public.owner_booking_alert_lookup_attempts WHERE id IN (SELECT id FROM public.owner_booking_alert_lookup_attempts WHERE created_at<now()-interval '1 day' ORDER BY created_at LIMIT 500);
 -- Delivery payloads are operational data, not indefinite customer records.
 -- Business consent evidence remains separate; recipient STOP state is retained.
 DELETE FROM public.owner_booking_alert_outbox WHERE id IN (SELECT id FROM public.owner_booking_alert_outbox WHERE expires_at<now()-interval '90 days' ORDER BY expires_at LIMIT 500);
END $$;

-- Only the safe settings record is owner-readable. Secret challenges, audit
-- history, delivery data and provider controls are service-only.
DO $$ DECLARE t text; f regprocedure; BEGIN
 FOREACH t IN ARRAY ARRAY['owner_booking_alert_control','owner_booking_alert_settings','owner_booking_alert_verifications','owner_booking_alert_consent_events','owner_booking_alert_recipients','owner_booking_alert_suppression_events','owner_booking_alert_outbox','owner_booking_alert_webhook_events','owner_booking_alert_lookup_attempts'] LOOP
   EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
   EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
   EXECUTE format('GRANT ALL ON public.%I TO service_role',t);
 END LOOP;
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN
  ('owner_booking_alert_business_eligible','owner_booking_alert_send_allowed','configure_owner_booking_alert','consume_owner_booking_alert_verification','set_owner_booking_alert_suppression','enqueue_owner_booking_alert','claim_owner_booking_alerts','begin_owner_booking_alert_send','finish_owner_booking_alert_send','apply_owner_booking_alert_delivery','resolve_owner_booking_alert_link','cleanup_owner_booking_alerts','reserve_owner_booking_alert_lookup','purge_owner_booking_alert_operational_data') LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f);
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
 END LOOP;
END $$;
GRANT SELECT ON public.owner_booking_alert_settings TO authenticated;
CREATE POLICY owner_booking_alert_settings_owner ON public.owner_booking_alert_settings FOR SELECT TO authenticated
 USING(owner_id=auth.uid() AND EXISTS(SELECT 1 FROM public.businesses b WHERE b.id=business_id AND b.owner_id=auth.uid() AND b.deleted_at IS NULL));
-- Consent evidence is append-only for application code. Lifecycle cleanup is
-- performed by the security-definer trigger when a business is removed.
REVOKE UPDATE,DELETE,TRUNCATE ON public.owner_booking_alert_consent_events FROM service_role;
REVOKE UPDATE,DELETE,TRUNCATE ON public.owner_booking_alert_suppression_events FROM service_role;
COMMIT;
