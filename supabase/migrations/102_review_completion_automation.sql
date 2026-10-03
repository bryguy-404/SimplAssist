-- Explicit future-only completion automation. Never scan imports or old jobs.
ALTER TABLE public.review_settings ADD COLUMN automation_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN automation_channel text NOT NULL DEFAULT 'email' CHECK(automation_channel IN ('email','sms'));
ALTER TABLE public.review_permissions ADD COLUMN timezone text;
ALTER TABLE public.review_enrollments ADD COLUMN service_event_id uuid REFERENCES public.customer_service_events(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX review_one_enrollment_per_service_event ON public.review_enrollments(service_event_id) WHERE service_event_id IS NOT NULL;
CREATE TABLE public.review_automation_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 owner_id uuid NOT NULL REFERENCES auth.users(id),contact_id uuid NOT NULL,
 service_event_id uuid NOT NULL UNIQUE REFERENCES public.customer_service_events(id) ON DELETE CASCADE,
 channel text NOT NULL CHECK(channel IN ('email','sms')),destination text NOT NULL,
 scheduled_at timestamptz NOT NULL,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','enrolled','cancelled','expired','blocked')),
 claim_token uuid,lease_until timestamptz,campaign_id uuid REFERENCES public.review_campaigns(id) ON DELETE SET NULL,
 last_error text,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.review_automation_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.review_automation_events FROM anon,authenticated;
GRANT ALL ON public.review_automation_events TO service_role;
CREATE FUNCTION public.review_contact_destination(p_contact public.contacts,p_channel text) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN p_channel='email' THEN lower(trim(p_contact.email))
 WHEN p_channel='sms' THEN CASE
  WHEN p_contact.source_channel='web_chat' THEN coalesce(lead_normalize_phone(p_contact.provided_phone_number),lead_normalize_phone(p_contact.phone_number))
  ELSE coalesce(lead_normalize_phone(p_contact.phone_number),lead_normalize_phone(p_contact.provided_phone_number)) END END
$$;
CREATE FUNCTION public.review_configure_automation(p_business uuid,p_owner uuid,p_enabled boolean,p_channel text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM review_assert_owner(p_business,p_owner);
 IF p_channel IS NULL OR p_channel NOT IN ('email','sms') OR p_enabled IS NULL THEN RAISE EXCEPTION 'invalid_review_channel' USING ERRCODE='22023';END IF;
 UPDATE review_settings SET automation_enabled=p_enabled,automation_channel=p_channel,revision=revision+1,updated_at=now() WHERE business_id=p_business AND owner_id=p_owner;
 IF NOT p_enabled THEN UPDATE review_automation_events SET status='cancelled',last_error='automation_disabled' WHERE business_id=p_business AND status IN ('pending','claimed');END IF;
END $$;
CREATE FUNCTION public.review_record_permission(p_business uuid,p_owner uuid,p_contact uuid,p_channel text,p_granted boolean,p_evidence text,p_timezone text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c contacts;v_destination text;r record;
BEGIN
 PERFORM review_assert_owner(p_business,p_owner);
 SELECT * INTO c FROM contacts WHERE id=p_contact AND business_id=p_business;
 IF NOT FOUND OR p_channel IS NULL OR p_channel NOT IN ('email','sms') OR p_granted IS NULL OR coalesce(length(trim(p_evidence)),0) NOT BETWEEN 10 AND 1000 THEN RAISE EXCEPTION 'invalid_review_permission' USING ERRCODE='22023';END IF;
 v_destination:=review_contact_destination(c,p_channel);
 IF nullif(v_destination,'') IS NULL THEN RAISE EXCEPTION 'review_destination_missing' USING ERRCODE='22023';END IF;
 IF p_granted AND EXISTS(SELECT 1 FROM review_suppressions WHERE business_id=p_business AND identity=(CASE WHEN p_channel='email' THEN 'email:' ELSE 'phone:' END)||v_destination) THEN RAISE EXCEPTION 'review_recipient_suppressed' USING ERRCODE='22023';END IF;
 INSERT INTO review_permissions(business_id,contact_id,destination,granted_at,actor_id,evidence,revoked_at,timezone)
 VALUES(p_business,p_contact,v_destination,now(),p_owner,trim(p_evidence),CASE WHEN p_granted THEN NULL ELSE now() END,p_timezone)
 ON CONFLICT(business_id,contact_id,destination) DO UPDATE SET granted_at=excluded.granted_at,actor_id=excluded.actor_id,evidence=excluded.evidence,revoked_at=excluded.revoked_at,timezone=excluded.timezone;
 IF NOT p_granted THEN FOR r IN SELECT id FROM review_enrollments WHERE business_id=p_business AND channel=p_channel AND destination=v_destination AND status='active' LOOP PERFORM review_stop_enrollment(r.id,'permission_revoked');END LOOP;END IF;
END $$;
CREATE FUNCTION public.review_on_service_completion() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s review_settings;c contacts;p review_permissions;v_destination text;v_timezone text;r record;
BEGIN
 IF TG_OP='UPDATE' AND OLD.status='completed' AND NEW.status<>'completed' THEN
  UPDATE review_automation_events SET status='cancelled',last_error='service_reopened' WHERE service_event_id=NEW.id AND status IN ('pending','claimed');
  FOR r IN SELECT id FROM review_enrollments WHERE service_event_id=NEW.id LOOP PERFORM review_stop_enrollment(r.id,'service_reopened');END LOOP;RETURN NEW;
 END IF;
 IF NEW.status<>'completed' OR (TG_OP='UPDATE' AND OLD.status='completed') THEN RETURN NEW;END IF;
 SELECT * INTO s FROM review_settings WHERE business_id=NEW.business_id AND automation_enabled;
 IF NOT FOUND OR s.paused OR NOT review_program_enabled(NEW.business_id) THEN RETURN NEW;END IF;
 SELECT * INTO c FROM contacts WHERE id=NEW.contact_id AND business_id=NEW.business_id;
 v_destination:=review_contact_destination(c,s.automation_channel);
 SELECT * INTO p FROM review_permissions WHERE business_id=NEW.business_id AND contact_id=NEW.contact_id AND destination=v_destination AND revoked_at IS NULL;
 IF NOT FOUND THEN RETURN NEW;END IF;
 v_timezone:=coalesce(p.timezone,s.timezone);
 INSERT INTO review_automation_events(business_id,owner_id,contact_id,service_event_id,channel,destination,scheduled_at)
 VALUES(NEW.business_id,s.owner_id,NEW.contact_id,NEW.id,s.automation_channel,v_destination,(date_trunc('day',now() AT TIME ZONE v_timezone)+interval '1 day 10 hours') AT TIME ZONE v_timezone) ON CONFLICT(service_event_id) DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER review_on_service_completion AFTER INSERT OR UPDATE OF status ON public.customer_service_events FOR EACH ROW EXECUTE FUNCTION public.review_on_service_completion();
CREATE FUNCTION public.review_claim_automations(p_limit integer DEFAULT 5) RETURNS SETOF public.review_automation_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE review_automation_events SET status='pending',claim_token=NULL,lease_until=NULL WHERE status='claimed' AND lease_until<now();
 UPDATE review_automation_events SET status='expired',last_error='schedule_stale' WHERE status='pending' AND scheduled_at<now()-interval '24 hours';
 RETURN QUERY WITH picked AS(SELECT a.id FROM review_automation_events a WHERE a.status='pending' AND review_program_enabled(a.business_id)
  AND EXISTS(SELECT 1 FROM review_settings s WHERE s.business_id=a.business_id AND s.automation_enabled AND NOT s.paused)
  AND (SELECT allowed FROM review_business_billing(a.business_id))
  AND (a.channel='email' OR has_review_sms_access(a.business_id))
  ORDER BY a.created_at FOR UPDATE SKIP LOCKED LIMIT greatest(0,least(p_limit,10)))
 UPDATE review_automation_events e SET status='claimed',claim_token=gen_random_uuid(),lease_until=now()+interval '2 minutes' FROM picked WHERE e.id=picked.id RETURNING e.*;
END $$;
CREATE FUNCTION public.review_guard_automation_campaign() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a review_automation_events;s customer_service_events;p review_permissions;
BEGIN
 SELECT * INTO a FROM review_automation_events WHERE id=NEW.id FOR UPDATE;IF NOT FOUND THEN RETURN NEW;END IF;
 SELECT * INTO s FROM customer_service_events WHERE id=a.service_event_id;
 SELECT * INTO p FROM review_permissions WHERE business_id=a.business_id AND contact_id=a.contact_id AND destination=a.destination AND revoked_at IS NULL;
 IF a.status NOT IN ('pending','claimed') OR a.business_id<>NEW.business_id OR a.owner_id<>NEW.owner_id OR s.status IS DISTINCT FROM 'completed' OR p.contact_id IS NULL OR NOT EXISTS(SELECT 1 FROM review_settings WHERE business_id=a.business_id AND automation_enabled AND automation_channel=a.channel) THEN RAISE EXCEPTION 'review_automation_cancelled' USING ERRCODE='22023';END IF;
 NEW.permission_attested_at:=p.granted_at;NEW.completed_service_attested_at:=s.completed_at;RETURN NEW;
END $$;
CREATE TRIGGER review_guard_automation_campaign BEFORE INSERT ON public.review_campaigns FOR EACH ROW EXECUTE FUNCTION public.review_guard_automation_campaign();
CREATE FUNCTION public.review_link_automation_enrollment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a review_automation_events;
BEGIN
 SELECT * INTO a FROM review_automation_events WHERE id=NEW.campaign_id;
 IF FOUND THEN
  IF NEW.original_contact_id<>a.contact_id OR NEW.destination<>a.destination OR NEW.channel<>a.channel THEN RAISE EXCEPTION 'review_automation_audience_changed' USING ERRCODE='22023';END IF;
  NEW.service_event_id:=a.service_event_id;
  UPDATE review_automation_events SET status='enrolled',campaign_id=NEW.campaign_id,claim_token=NULL,lease_until=NULL WHERE id=a.id;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER review_link_automation_enrollment BEFORE INSERT ON public.review_enrollments FOR EACH ROW EXECUTE FUNCTION public.review_link_automation_enrollment();
CREATE FUNCTION public.review_automation_tombstone() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN IF NEW.owner_id IS NULL AND OLD.owner_id IS NOT NULL THEN DELETE FROM review_automation_events WHERE business_id=NEW.id;END IF;RETURN NEW;END $$;
CREATE TRIGGER review_automation_tombstone AFTER UPDATE OF owner_id ON public.businesses FOR EACH ROW EXECUTE FUNCTION public.review_automation_tombstone();
DO $$ DECLARE f record;BEGIN
 FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'review_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);END LOOP;
END $$;
