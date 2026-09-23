BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();

INSERT INTO auth.users(id,email) VALUES
 ('00000000-0000-4000-a093-000000000001','owner-alert-1@example.test'),
 ('00000000-0000-4000-a093-000000000002','owner-alert-2@example.test');
INSERT INTO businesses(id,owner_id,name,business_type,slug,billing_mode,partner_plan,primary_goal) VALUES
 ('10000000-0000-4000-a093-000000000001','00000000-0000-4000-a093-000000000001','Chat Only Solar','general','alerts-093-1','comped','chat_only','book'),
 ('10000000-0000-4000-a093-000000000002','00000000-0000-4000-a093-000000000002','Other Solar','general','alerts-093-2','comped','full','book');
INSERT INTO ai_settings(business_id,booking_enabled,booking_mode) VALUES
 ('10000000-0000-4000-a093-000000000001',true,'schedule_direct'),
 ('10000000-0000-4000-a093-000000000002',true,'schedule_direct') ON CONFLICT(business_id) DO UPDATE SET booking_enabled=true,booking_mode='schedule_direct';
INSERT INTO google_calendar_tokens(business_id,access_token,refresh_token,token_expiry,calendar_id,google_email) VALUES
 ('10000000-0000-4000-a093-000000000001','fixture-access','fixture-refresh',now()+interval '1 day','primary','owner-alert-1@example.test'),
 ('10000000-0000-4000-a093-000000000002','fixture-access','fixture-refresh',now()+interval '1 day','primary','owner-alert-2@example.test');
INSERT INTO contacts(id,business_id,name,source_channel) VALUES('20000000-0000-4000-a093-000000000001','10000000-0000-4000-a093-000000000001','Booking Customer','web_chat');
INSERT INTO conversations(id,business_id,contact_id,channel) VALUES('30000000-0000-4000-a093-000000000001','10000000-0000-4000-a093-000000000001','20000000-0000-4000-a093-000000000001','web_chat');

CREATE FUNCTION pg_temp.alert_enroll(p_number integer,p_digest text,p_recipient text DEFAULT '+15745550101') RETURNS public.owner_booking_alert_settings LANGUAGE plpgsql AS $$
DECLARE biz uuid:=('10000000-0000-4000-a093-'||lpad(p_number::text,12,'0'))::uuid;
 own uuid:=('00000000-0000-4000-a093-'||lpad(p_number::text,12,'0'))::uuid; result public.owner_booking_alert_settings;
BEGIN
 SELECT * INTO result FROM configure_owner_booking_alert(biz,own,coalesce((SELECT revision FROM owner_booking_alert_settings WHERE business_id=biz),0),'enroll',p_recipient,p_digest,'owner-alerts-v1','I agree to receive SimplAssist booking alerts. STOP to opt out.',now()+interval '10 minutes');
 RETURN result;
END $$;
CREATE FUNCTION pg_temp.alert_book(p_number integer,p_confirm boolean DEFAULT true) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE message_id uuid:=gen_random_uuid(); booking public.calendar_bookings;
BEGIN
 INSERT INTO messages(id,business_id,conversation_id,role,channel,content)
 VALUES(message_id,'10000000-0000-4000-a093-000000000001','30000000-0000-4000-a093-000000000001','customer','web_chat','Please book this appointment');
 SELECT * INTO booking FROM reserve_calendar_booking('10000000-0000-4000-a093-000000000001','20000000-0000-4000-a093-000000000001',
 '30000000-0000-4000-a093-000000000001',message_id,now()+interval '2 days'+make_interval(hours=>p_number),now()+interval '2 days'+make_interval(hours=>p_number,mins=>30),
 gen_random_uuid(),'primary','Owner alert fixture',encode(digest(message_id::text,'sha256'),'hex'));
 IF p_confirm THEN PERFORM confirm_calendar_booking(booking.business_id,booking.id,'a093'||lpad(p_number::text,8,'0'),booking.starts_at,booking.ends_at,booking.operation_claim_token); END IF;
 RETURN booking.id;
END $$;

SELECT ok(NOT (SELECT enabled FROM owner_booking_alert_control),'migration defaults outbound program off');
SELECT ok(NOT has_table_privilege('authenticated','owner_booking_alert_settings','INSERT'),'owner cannot manufacture a verified enrollment');
SELECT ok(NOT has_table_privilege('authenticated','owner_booking_alert_verifications','SELECT'),'owner cannot read stored verification secrets');
SELECT ok(NOT has_table_privilege('anon','owner_booking_alert_outbox','SELECT'),'outbox is private');
SELECT ok(NOT has_table_privilege('service_role','owner_booking_alert_consent_events','UPDATE'),'application cannot overwrite consent evidence');
SELECT ok(NOT has_table_privilege('service_role','owner_booking_alert_consent_events','TRUNCATE'),'application cannot truncate consent evidence');
SELECT ok(NOT has_table_privilege('service_role','owner_booking_alert_suppression_events','TRUNCATE'),'application cannot truncate opt-out evidence');
SELECT ok(NOT has_function_privilege('authenticated','configure_owner_booking_alert(uuid,uuid,integer,text,text,text,text,text,timestamptz)','EXECUTE'),'mutation RPC requires server authentication');
SELECT ok(owner_booking_alert_business_eligible('10000000-0000-4000-a093-000000000001'),'Chat Only with direct booking is eligible without SMS campaign');
SELECT ok(NOT owner_booking_alert_business_eligible('10000000-0000-4000-a093-000000000001','00000000-0000-4000-a093-000000000002'),'eligibility rejects another owner');
SELECT is((pg_temp.alert_enroll(1,repeat('a',64))).revision,1,'enrollment records a pending challenge');
SELECT ok((consume_owner_booking_alert_verification(repeat('a',64),'+15745550101','+15742133931','profile-093','verify-off')).business_id IS NULL,'verification cannot enable before provider readiness');
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_outbox),0,'no preapproval SMS queued');
SELECT throws_ok($$SELECT configure_owner_booking_alert('10000000-0000-4000-a093-000000000001','00000000-0000-4000-a093-000000000002',1,'disable')$$,'42501','booking alert access denied','cross-account writes rejected');
SELECT throws_ok($$SELECT configure_owner_booking_alert('10000000-0000-4000-a093-000000000001','00000000-0000-4000-a093-000000000001',0,'disable')$$,'40001','booking alert settings conflict','stale owner settings writes rejected');
UPDATE owner_booking_alert_control SET sender='+15742133931',messaging_profile_id='profile-093',enabled=true;
SELECT ok((consume_owner_booking_alert_verification(repeat('a',64),'+15745550102','+15742133931','profile-093','wrong-phone')).business_id IS NULL,'verification rejects the wrong originating number');
SELECT ok((consume_owner_booking_alert_verification(repeat('a',64),'+15745550101','+15742133931','wrong-profile','wrong-profile')).business_id IS NULL,'verification rejects a different messaging profile');
SELECT ok((consume_owner_booking_alert_verification(repeat('a',64),'+15745550101','+15742133931','profile-093','verify-1')).enabled,'signed matching challenge enables enrollment');
SELECT ok((consume_owner_booking_alert_verification(repeat('a',64),'+15745550101','+15742133931','profile-093','verify-replay')).business_id IS NULL,'consumed verification cannot replay');
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_outbox WHERE kind='enrollment'),1,'one enrollment confirmation queued');
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_consent_events WHERE action='verified'),1,'exact verified consent retained once');

CREATE TEMP TABLE alert_test_ids(k text PRIMARY KEY,id uuid,token uuid);
INSERT INTO alert_test_ids(k,id) VALUES('booking1',pg_temp.alert_book(1)),('pending',pg_temp.alert_book(2,false));
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_outbox WHERE kind='booking'),1,'only confirmed booking queues an owner alert');
SELECT lives_ok($$SELECT confirm_calendar_booking(b.business_id,b.id,b.google_event_id,b.starts_at,b.ends_at,gen_random_uuid()) FROM calendar_bookings b JOIN alert_test_ids t ON t.id=b.id WHERE t.k='booking1'$$,'recovered repeat confirmation is idempotent');
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_outbox WHERE kind='booking'),1,'duplicate confirmation never duplicates alert');
SELECT is((SELECT count(*)::integer FROM claim_owner_booking_alerts(10)),2,'claims booking and enrollment independently of customer text budget');
INSERT INTO alert_test_ids(k,id,token) SELECT 'alert1',id,claim_token FROM owner_booking_alert_outbox WHERE kind='booking';
SELECT ok((begin_owner_booking_alert_send((SELECT id FROM alert_test_ids WHERE k='alert1'),gen_random_uuid(),gen_random_uuid(),'SimplAssist booking alert',repeat('c',64))).id IS NULL,'stale worker claim cannot submit');
SELECT is((begin_owner_booking_alert_send((SELECT id FROM alert_test_ids WHERE k='alert1'),(SELECT token FROM alert_test_ids WHERE k='alert1'),'40000000-0000-4000-a093-000000000001','SimplAssist: Chat Only Solar booked tomorrow. https://simplassist.com/booking-alerts/open/token',repeat('c',64))).status,'submitting','current claim freezes message and begins one submission');
SELECT is((begin_owner_booking_alert_send((SELECT id FROM owner_booking_alert_outbox WHERE kind='enrollment'),(SELECT claim_token FROM owner_booking_alert_outbox WHERE kind='enrollment'),gen_random_uuid(),'SimplAssist: Booking alerts enabled.',NULL)).status,'pending','shared sender throttles another immediate submission');
SELECT ok(apply_owner_booking_alert_delivery('40000000-0000-4000-a093-000000000001','telnyx-alert1','delivered','+15742133931','+15745550101','profile-093',now()),'callback can reconcile before API response');
SELECT ok(finish_owner_booking_alert_send((SELECT id FROM alert_test_ids WHERE k='alert1'),(SELECT token FROM alert_test_ids WHERE k='alert1'),'40000000-0000-4000-a093-000000000001','accepted','telnyx-alert1'),'late API acceptance recognizes callback result');
SELECT is((SELECT status FROM owner_booking_alert_outbox WHERE id=(SELECT id FROM alert_test_ids WHERE k='alert1')),'delivered','late acceptance cannot regress delivery');
SELECT ok(apply_owner_booking_alert_delivery('40000000-0000-4000-a093-000000000001','telnyx-alert1','delivered','+15742133931','+15745550101','profile-093',now(),2,0.012,'USD'),'final callback stores platform-only SMS accounting');
SELECT is((SELECT parts FROM owner_booking_alert_outbox WHERE id=(SELECT id FROM alert_test_ids WHERE k='alert1')),2,'signed segment count is recorded without customer meters');
SELECT ok(NOT apply_owner_booking_alert_delivery('40000000-0000-4000-a093-000000000001','telnyx-alert1','failed','+15742133931','+15745550102','profile-093',now()),'delivery callback cannot affect another recipient');
SELECT is((SELECT count(*)::integer FROM resolve_owner_booking_alert_link(repeat('c',64))),1,'opaque navigation resolves current owner and recipient');
SELECT is((SELECT count(*)::integer FROM resolve_owner_booking_alert_link(repeat('d',64))),0,'unknown navigation digest does not resolve');
SELECT is((SELECT count(*)::integer FROM claim_owner_booking_alerts(10)),0,'accepted and throttled rows cannot be claimed immediately');

SELECT is((pg_temp.alert_enroll(1,repeat('b',64),'+15745550102')).recipient,'+15745550101','phone change preserves old verified number until new proof');
SELECT ok((SELECT enabled FROM owner_booking_alert_settings WHERE business_id='10000000-0000-4000-a093-000000000001'),'old enrollment remains enabled while replacement awaits proof');
SELECT is((pg_temp.alert_enroll(2,repeat('d',64))).pending_recipient,'+15745550101','same personal mobile can serve two separate businesses');
SELECT ok((consume_owner_booking_alert_verification(repeat('d',64),'+15745550101','+15742133931','profile-093','verify-2')).enabled,'second business requires its own consent verification');
SELECT ok(set_owner_booking_alert_suppression('+15745550101',true,now(),'stop-1'),'STOP accepted');
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_settings WHERE enabled),0,'STOP disables every business on this mobile');
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_outbox WHERE recipient='+15745550101' AND status IN ('pending','claimed')),0,'STOP cancels unsent alerts across businesses');
SELECT is((SELECT count(*)::integer FROM resolve_owner_booking_alert_link(repeat('c',64))),1,'STOP does not turn historical dashboard links into auth or remove normal navigation');
SELECT ok(NOT set_owner_booking_alert_suppression('+15745550101',false,now()-interval '1 minute','old-start'),'old START cannot clear later STOP');
SELECT ok(set_owner_booking_alert_suppression('+15745550101',false,now()+interval '1 second','start-1'),'new START clears carrier suppression');
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_settings WHERE enabled),0,'START never silently reenables business consent');
INSERT INTO alert_test_ids(k,id) VALUES('after-stop',pg_temp.alert_book(3));
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_outbox WHERE kind='booking'),1,'booking while opted out does not create future backfill');
SELECT ok((consume_owner_booking_alert_verification(repeat('b',64),'+15745550102','+15742133931','profile-093','stale-new-number')).business_id IS NULL,'STOP invalidates pending replacement challenge');

SELECT is((pg_temp.alert_enroll(1,repeat('e',64))).pending_recipient,'+15745550101','fresh explicit reenrollment is available');
SELECT ok((consume_owner_booking_alert_verification(repeat('e',64),'+15745550101','+15742133931','profile-093','verify-3')).enabled,'fresh verification reenables only that business');
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_settings WHERE enabled),1,'other business stays disabled');
SELECT is((SELECT count(*)::integer FROM resolve_owner_booking_alert_link(repeat('c',64))),0,'previous enrollment generation navigation expires after reenrollment');
INSERT INTO alert_test_ids(k,id) VALUES('booking4',pg_temp.alert_book(4));
UPDATE owner_booking_alert_outbox SET status='cancelled' WHERE kind='enrollment' AND status='pending';
UPDATE owner_booking_alert_control SET next_send_at=NULL;
SELECT is((SELECT count(*)::integer FROM claim_owner_booking_alerts(10)),1,'only new post-enrollment booking is queued');
INSERT INTO alert_test_ids(k,id,token) SELECT 'alert4',id,claim_token FROM owner_booking_alert_outbox WHERE booking_id=(SELECT id FROM alert_test_ids WHERE k='booking4');
SELECT is((begin_owner_booking_alert_send((SELECT id FROM alert_test_ids WHERE k='alert4'),(SELECT token FROM alert_test_ids WHERE k='alert4'),'40000000-0000-4000-a093-000000000004','SimplAssist booking four',repeat('f',64))).status,'submitting','new booking can begin transport');
SELECT ok(finish_owner_booking_alert_send((SELECT id FROM alert_test_ids WHERE k='alert4'),(SELECT token FROM alert_test_ids WHERE k='alert4'),'40000000-0000-4000-a093-000000000004','uncertain',NULL,'timeout'),'ambiguous response records uncertainty');
SELECT is((SELECT count(*)::integer FROM claim_owner_booking_alerts(10)),0,'uncertain send is never blindly retried');
SELECT ok(NOT finish_owner_booking_alert_send((SELECT id FROM alert_test_ids WHERE k='alert4'),NULL,'40000000-0000-4000-a093-000000000004','retry',NULL,'timeout'),'uncertain cannot be converted into retry');
SELECT ok(apply_owner_booking_alert_delivery('40000000-0000-4000-a093-000000000004','telnyx-alert4','accepted','+15742133931','+15745550101','profile-093',now()),'signed callback recovers ambiguous acceptance');
SELECT is((SELECT status FROM owner_booking_alert_outbox WHERE id=(SELECT id FROM alert_test_ids WHERE k='alert4')),'accepted','recovered acceptance remains deliverable for final status');

SELECT ok(reserve_owner_booking_alert_lookup('10000000-0000-4000-a093-000000000001','00000000-0000-4000-a093-000000000001','+15745550109'),'paid lookup budget granted to current owner');
SELECT ok(NOT reserve_owner_booking_alert_lookup('10000000-0000-4000-a093-000000000001','00000000-0000-4000-a093-000000000002','+15745550109'),'lookup budget rejects another owner');
INSERT INTO owner_booking_alert_lookup_attempts(business_id,recipient) SELECT '10000000-0000-4000-a093-000000000001','+15745550109' FROM generate_series(1,9);
SELECT ok(NOT reserve_owner_booking_alert_lookup('10000000-0000-4000-a093-000000000001','00000000-0000-4000-a093-000000000001','+15745550108'),'business lookup budget stops different-number abuse');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-a093-000000000001',true);
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_settings),1,'owner can only read their own settings');
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-a093-000000000002',true);
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_settings),1,'second owner cannot read first business recipient');
RESET ROLE;
SELECT lives_ok($$SELECT fail_calendar_booking(business_id,id,operation_claim_token,'fixture request not confirmed') FROM calendar_bookings WHERE id=(SELECT id FROM alert_test_ids WHERE k='pending')$$,'pending booking fixture is settled before permanent account cleanup');
UPDATE businesses SET owner_id=NULL WHERE id='10000000-0000-4000-a093-000000000001';
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_settings WHERE business_id='10000000-0000-4000-a093-000000000001'),0,'permanent account cleanup scrubs recipient settings');
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_outbox WHERE business_id='10000000-0000-4000-a093-000000000001'),0,'permanent account cleanup scrubs delivery content');
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_consent_events WHERE business_id='10000000-0000-4000-a093-000000000001'),0,'permanent cleanup removes business-linked consent PII');
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_verifications WHERE business_id='10000000-0000-4000-a093-000000000001'),0,'permanent cleanup removes challenges');
SELECT is((SELECT count(*)::integer FROM resolve_owner_booking_alert_link(repeat('f',64))),0,'deleted owner links cannot resolve');

SELECT * FROM finish();
ROLLBACK;
