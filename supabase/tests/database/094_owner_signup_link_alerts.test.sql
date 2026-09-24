BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();

INSERT INTO auth.users(id,email) VALUES
 ('00000000-0000-4000-a094-000000000001','signup-alert-1@example.test'),
 ('00000000-0000-4000-a094-000000000002','signup-alert-2@example.test');
INSERT INTO businesses(id,owner_id,name,business_type,slug,billing_mode,partner_plan,primary_goal,goal_url,bookings_paused_at) VALUES
 ('10000000-0000-4000-a094-000000000001','00000000-0000-4000-a094-000000000001','Signup Business','general','alerts-094-1','comped','full','signup','https://example.test/signup',now()),
 ('10000000-0000-4000-a094-000000000002','00000000-0000-4000-a094-000000000002','Booking Business','general','alerts-094-2','comped','chat_only','book',NULL,NULL);
INSERT INTO ai_settings(business_id,booking_enabled,booking_mode) VALUES
 ('10000000-0000-4000-a094-000000000001',false,'collect_info'),
 ('10000000-0000-4000-a094-000000000002',true,'schedule_direct') ON CONFLICT(business_id) DO UPDATE SET booking_enabled=excluded.booking_enabled,booking_mode=excluded.booking_mode;
INSERT INTO google_calendar_tokens(business_id,access_token,refresh_token,token_expiry,calendar_id,google_email) VALUES
 ('10000000-0000-4000-a094-000000000002','fixture-access','fixture-refresh',now()+interval '1 day','primary','signup-alert-2@example.test');
INSERT INTO contacts(id,business_id,name,phone_number,source_channel) VALUES
 ('20000000-0000-4000-a094-000000000001','10000000-0000-4000-a094-000000000001','Caller','+15745550199','voice');
INSERT INTO conversations(id,business_id,contact_id,channel)
 SELECT ('30000000-0000-4000-a094-'||lpad(n::text,12,'0'))::uuid,'10000000-0000-4000-a094-000000000001','20000000-0000-4000-a094-000000000001','voice' FROM generate_series(1,30) n;
INSERT INTO voice_sessions(id,business_id,conversation_id,call_control_id,call_session_id,caller_phone,called_phone,response_mode,status)
 SELECT ('40000000-0000-4000-a094-'||lpad(n::text,12,'0'))::uuid,'10000000-0000-4000-a094-000000000001',
 ('30000000-0000-4000-a094-'||lpad(n::text,12,'0'))::uuid,'alert-control-'||n,'alert-session-'||n,'+15745550199','+15742638634','voice','active' FROM generate_series(1,30) n;
INSERT INTO messages(id,business_id,conversation_id,role,channel,content)
 SELECT ('70000000-0000-4000-a094-'||lpad(n::text,12,'0'))::uuid,'10000000-0000-4000-a094-000000000001',('30000000-0000-4000-a094-'||lpad(n::text,12,'0'))::uuid,'customer','voice','Yes, send the signup link.' FROM generate_series(1,30) n;
INSERT INTO voice_actions(id,session_id,business_id,kind,fingerprint,revision,status,payload,readback,request_event_ids,confirmed_at,source_message_id)
 SELECT ('50000000-0000-4000-a094-'||lpad(n::text,12,'0'))::uuid,('40000000-0000-4000-a094-'||lpad(n::text,12,'0'))::uuid,
 '10000000-0000-4000-a094-000000000001','signup',repeat('a',64),1,'executing','{"kind":"signup","approvedUrl":"https://example.test/signup"}','May I text the sign-up link?',ARRAY['request-'||n],now(),('70000000-0000-4000-a094-'||lpad(n::text,12,'0'))::uuid FROM generate_series(1,30) n;
CREATE FUNCTION pg_temp.accept_signup(p_n integer,p_accepted timestamptz DEFAULT now(),p_finalize boolean DEFAULT true) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE voice_actions SET status='succeeded',sms_provider_message_id='signup-provider-'||p_n,sms_accepted_at=p_accepted,
 result=jsonb_build_object('providerMessageId','signup-provider-'||p_n,'deliveryStatus','accepted','smsBody','Business sign-up link')
 WHERE id=('50000000-0000-4000-a094-'||lpad(p_n::text,12,'0'))::uuid;
 IF p_finalize THEN PERFORM finalize_voice_signup_bookkeeping(('50000000-0000-4000-a094-'||lpad(p_n::text,12,'0'))::uuid); END IF;
END $$;
CREATE FUNCTION pg_temp.signup_enroll(p_digest text,p_version text DEFAULT '2026-09-24-v2') RETURNS public.owner_booking_alert_settings LANGUAGE sql AS $$
 SELECT configure_owner_booking_alert('10000000-0000-4000-a094-000000000001','00000000-0000-4000-a094-000000000001',
 coalesce((SELECT revision FROM owner_booking_alert_settings WHERE business_id='10000000-0000-4000-a094-000000000001'),0),
 'enroll','+15745550101',p_digest,p_version,'I agree to receive SimplAssist booking and sign-up-link alerts. STOP to opt out.',now()+interval '10 minutes');
$$;
CREATE FUNCTION pg_temp.signup_verify(p_digest text) RETURNS public.owner_booking_alert_settings LANGUAGE sql AS $$
 SELECT consume_owner_booking_alert_verification(p_digest,'+15745550101','+15742133931','profile-094','verify-'||p_digest);
$$;

SELECT ok(NOT (SELECT enabled FROM owner_booking_alert_control),'migration preserves outbound default-off');
SELECT ok(NOT has_function_privilege('anon','enqueue_owner_signup_link_alert()','EXECUTE'),'anon cannot enqueue owner sign-up alerts');
SELECT ok(NOT has_function_privilege('authenticated','owner_booking_alert_signup_source_valid(uuid,uuid,timestamptz)','EXECUTE'),'source evidence is service-only');
SELECT ok(NOT has_function_privilege('authenticated','owner_booking_alert_kind_eligible(uuid,text,uuid)','EXECUTE'),'kind eligibility is service-only');
SELECT ok(owner_booking_alert_business_eligible('10000000-0000-4000-a094-000000000001'),'signup eligible without calendar and despite paused or disabled bookings');
SELECT ok(NOT owner_booking_alert_kind_eligible('10000000-0000-4000-a094-000000000001','booking'),'signup eligibility does not unlock bookings');
SELECT ok(owner_booking_alert_kind_eligible('10000000-0000-4000-a094-000000000002','booking'),'existing Chat Only direct booking remains eligible');
UPDATE businesses SET partner_plan='chat_only' WHERE id='10000000-0000-4000-a094-000000000001';
SELECT ok(NOT owner_booking_alert_business_eligible('10000000-0000-4000-a094-000000000001'),'caller signup-link alerts require effective Full Suite');
UPDATE businesses SET partner_plan='full' WHERE id='10000000-0000-4000-a094-000000000001';
INSERT INTO subscriptions(business_id,stripe_customer_id,stripe_subscription_id,plan,status)
 VALUES('10000000-0000-4000-a094-000000000001','cus_signup_alert_094','sub_signup_alert_094','chat_only','active');
SELECT ok(NOT owner_booking_alert_business_eligible('10000000-0000-4000-a094-000000000001'),'effective subscription takes precedence over a comped Full Suite setting');
DELETE FROM subscriptions WHERE business_id='10000000-0000-4000-a094-000000000001';
SELECT throws_ok($$SELECT pg_temp.signup_enroll(repeat('b',64),'2026-09-23-v1')$$,'22023','invalid booking alert enrollment','signup enrollment requires newly scoped consent');
SELECT is((pg_temp.signup_enroll(repeat('a',64))).pending_recipient,'+15745550101','signup owner can begin v2 verification');
SELECT ok((pg_temp.signup_verify(repeat('a',64))).business_id IS NULL,'disabled program cannot consume proof');
SELECT pg_temp.accept_signup(1);
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_outbox),0,'gate-off acceptance creates no backlog');
UPDATE owner_booking_alert_control SET sender='+15742133931',messaging_profile_id='profile-094',enabled=true,pilot_business_ids=ARRAY['10000000-0000-4000-a094-000000000001'::uuid];
SELECT ok((pg_temp.signup_verify(repeat('a',64))).enabled,'v2 proof enables signup owner alerts');
UPDATE voice_actions SET status='succeeded',bookkeeping_attempted_at=now() WHERE id='50000000-0000-4000-a094-000000000001';
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_outbox WHERE kind='signup_link'),0,'later recovery cannot replay gate-off acceptance');

SELECT pg_temp.accept_signup(2,now(),false);
SELECT is((SELECT sms_provider_message_id FROM voice_actions WHERE id='50000000-0000-4000-a094-000000000002'),'signup-provider-2','caller provider acceptance is durable before optional alert bookkeeping');
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_outbox WHERE kind='signup_link'),0,'provider acceptance save performs no owner-outbox write');
SELECT lives_ok($$SELECT finalize_voice_signup_bookkeeping('50000000-0000-4000-a094-000000000002')$$,'later bookkeeping recovery can create the original accepted event');
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_outbox WHERE kind='signup_link'),1,'new provider acceptance queues one sign-up-link alert');
SELECT lives_ok($$SELECT finalize_voice_signup_bookkeeping('50000000-0000-4000-a094-000000000002')$$,'replayed bookkeeping uses the existing event');
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_outbox WHERE kind='signup_link'),1,'replayed bookkeeping never duplicates owner alert');
SELECT is((SELECT voice_action_id FROM owner_booking_alert_outbox WHERE kind='signup_link'),'50000000-0000-4000-a094-000000000002'::uuid,'alert keeps real source action identity');
SELECT is((SELECT expires_at FROM owner_booking_alert_outbox WHERE kind='signup_link'),now()+interval '24 hours','expiry is 24 hours after provider acceptance');
UPDATE voice_actions SET status='succeeded',sms_accepted_at=sms_accepted_at,result=jsonb_set(result,'{deliveryStatus}','"delivered"'),recovery_complete=true WHERE id='50000000-0000-4000-a094-000000000002';
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_outbox WHERE kind='signup_link'),1,'status replay and delivery bookkeeping cannot duplicate the alert');
SELECT ok(owner_booking_alert_send_allowed((SELECT id FROM owner_booking_alert_outbox WHERE kind='signup_link')),'accepted valid source can send');
UPDATE businesses SET partner_plan='sms_and_chat' WHERE id='10000000-0000-4000-a094-000000000001';
SELECT ok(NOT owner_booking_alert_send_allowed((SELECT id FROM owner_booking_alert_outbox WHERE kind='signup_link')),'plan downgrade blocks queued caller signup-link alerts');
UPDATE businesses SET partner_plan='full' WHERE id='10000000-0000-4000-a094-000000000001';
UPDATE voice_actions SET result=jsonb_set(result,'{deliveryStatus}','"delivery_failed"') WHERE id='50000000-0000-4000-a094-000000000002';
SELECT ok(NOT owner_booking_alert_send_allowed((SELECT id FROM owner_booking_alert_outbox WHERE kind='signup_link')),'known failed caller delivery blocks unsent owner notification');
UPDATE voice_actions SET result=jsonb_set(result,'{deliveryStatus}','"delivered"') WHERE id='50000000-0000-4000-a094-000000000002';

UPDATE voice_actions SET status='awaiting_confirmation',confirmed_at=NULL WHERE id='50000000-0000-4000-a094-000000000003';
SELECT throws_ok($$SELECT finalize_voice_signup_bookkeeping('50000000-0000-4000-a094-000000000003')$$,'P0001','voice signup is not an accepted confirmed business action','link offer cannot create a sent event');
UPDATE voice_actions SET status='failed' WHERE id='50000000-0000-4000-a094-000000000004';
SELECT throws_ok($$SELECT finalize_voice_signup_bookkeeping('50000000-0000-4000-a094-000000000004')$$,'P0001','voice signup is not an accepted confirmed business action','failed send cannot create a sent event');
UPDATE voice_actions SET status='uncertain' WHERE id='50000000-0000-4000-a094-000000000005';
SELECT throws_ok($$SELECT finalize_voice_signup_bookkeeping('50000000-0000-4000-a094-000000000005')$$,'P0001','voice signup is not an accepted confirmed business action','uncertain send cannot create a sent event');
SELECT pg_temp.accept_signup(6,now()-interval '1 minute');
SELECT pg_temp.accept_signup(7,now()-interval '1 day');
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_outbox WHERE kind='signup_link'),1,'offers, failures, uncertainty, and pre-enrollment sends never enqueue');
UPDATE voice_actions SET business_id='10000000-0000-4000-a094-000000000002' WHERE id='50000000-0000-4000-a094-000000000009';
SELECT pg_temp.accept_signup(9,now(),false);
SELECT ok(NOT owner_booking_alert_signup_source_valid('50000000-0000-4000-a094-000000000009','10000000-0000-4000-a094-000000000002',now()),'final source check rejects cross-business session evidence');
UPDATE voice_sessions SET action_conversation_id=NULL WHERE id='40000000-0000-4000-a094-000000000010';
SELECT pg_temp.accept_signup(10,now(),false);
SELECT ok(NOT owner_booking_alert_signup_source_valid('50000000-0000-4000-a094-000000000010','10000000-0000-4000-a094-000000000001',now()),'missing source route fails final send validation');
UPDATE voice_sessions SET response_mode='text' WHERE id='40000000-0000-4000-a094-000000000011';
SELECT pg_temp.accept_signup(11,now(),false);
SELECT ok(NOT owner_booking_alert_signup_source_valid('50000000-0000-4000-a094-000000000011','10000000-0000-4000-a094-000000000001',now()),'text fallback is not a real voice signup source');

-- A real booking-demo route belongs to a different action business and never
-- becomes an owner notification merely because its action says succeeded.
INSERT INTO businesses(id,owner_id,name,business_type,slug,billing_mode,partner_plan,primary_goal,goal_url)
 VALUES('ea848911-ef72-44a6-8cf3-c47b3959be26','00000000-0000-4000-a094-000000000001','Demo Phone Owner','general','alert-demo-094','comped','full','signup','https://example.test/signup');
INSERT INTO voice_pilot_settings(business_id,enabled,demo_business_id,demo_calendar_id)
 VALUES('ea848911-ef72-44a6-8cf3-c47b3959be26',true,'10000000-0000-4000-a094-000000000002','primary');
INSERT INTO voice_pilot_testers(business_id,phone_number,test_mode)
 VALUES('ea848911-ef72-44a6-8cf3-c47b3959be26','+15745550198','booking_demo');
INSERT INTO voice_sessions(id,business_id,call_control_id,call_session_id,caller_phone,called_phone,response_mode,status)
 VALUES('40000000-0000-4000-a094-000000000031','ea848911-ef72-44a6-8cf3-c47b3959be26','alert-demo-control','alert-demo-session','+15745550198','+15742638634','voice','active');
INSERT INTO voice_actions(id,session_id,business_id,kind,fingerprint,revision,status,payload,readback,request_event_ids,confirmed_at,result,sms_provider_message_id,sms_accepted_at)
 VALUES('50000000-0000-4000-a094-000000000031','40000000-0000-4000-a094-000000000031','10000000-0000-4000-a094-000000000002','signup',repeat('a',64),1,'succeeded','{"kind":"signup"}','Demo link',ARRAY['request'],now(),'{"providerMessageId":"demo-provider-094"}','demo-provider-094',now());
SELECT ok((SELECT demo_mode FROM voice_sessions WHERE id='40000000-0000-4000-a094-000000000031'),'fixture uses the real isolated booking-demo route');
SELECT ok(NOT owner_booking_alert_signup_source_valid('50000000-0000-4000-a094-000000000031','10000000-0000-4000-a094-000000000002',now()),'booking-demo source never authorizes owner signup alert');

UPDATE owner_booking_alert_settings SET consent_version='2026-09-23-v1' WHERE business_id='10000000-0000-4000-a094-000000000001';
SELECT ok(NOT owner_booking_alert_send_allowed((SELECT id FROM owner_booking_alert_outbox WHERE kind='signup_link')),'old consent cannot authorize signup send');
SELECT pg_temp.accept_signup(12);
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_outbox WHERE kind='signup_link'),1,'old consent cannot queue signup events');
UPDATE owner_booking_alert_settings SET consent_version='2026-09-24-v2' WHERE business_id='10000000-0000-4000-a094-000000000001';
UPDATE owner_booking_alert_control SET pilot_business_ids=ARRAY['10000000-0000-4000-a094-000000000002'::uuid];
SELECT pg_temp.accept_signup(13);
SELECT ok(NOT owner_booking_alert_send_allowed((SELECT id FROM owner_booking_alert_outbox WHERE kind='signup_link')),'pilot gate is enforced again before dispatch');
UPDATE owner_booking_alert_control SET pilot_business_ids=ARRAY['10000000-0000-4000-a094-000000000001'::uuid];
UPDATE businesses SET operations_suspended_at=now() WHERE id='10000000-0000-4000-a094-000000000001';
SELECT pg_temp.accept_signup(14);
SELECT ok(NOT owner_booking_alert_send_allowed((SELECT id FROM owner_booking_alert_outbox WHERE kind='signup_link')),'suspended business cannot dispatch a queued signup alert');
UPDATE businesses SET operations_suspended_at=NULL WHERE id='10000000-0000-4000-a094-000000000001';
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_outbox WHERE kind='signup_link'),1,'pilot and suspension gates drop events rather than backfill');

UPDATE owner_booking_alert_outbox SET status='cancelled' WHERE kind='enrollment';
SELECT is((SELECT count(*)::integer FROM claim_owner_booking_alerts(20)),1,'worker claims the new kind through existing guarded transport');
SELECT throws_ok($$SELECT begin_owner_booking_alert_send(id,claim_token,gen_random_uuid(),'SimplAssist: A signup link was sent to a caller.',NULL) FROM owner_booking_alert_outbox WHERE kind='signup_link'$$,'22023','invalid booking alert send','signup sends require secure dashboard navigation');
SELECT is((begin_owner_booking_alert_send((SELECT id FROM owner_booking_alert_outbox WHERE kind='signup_link'),(SELECT claim_token FROM owner_booking_alert_outbox WHERE kind='signup_link'),
 '60000000-0000-4000-a094-000000000001','SimplAssist: Signup Business sent a sign-up link to a caller. https://simplassist.com/booking-alerts/open/token',repeat('c',64))).status,'submitting','signup transport freezes message and secure token before sending');
SELECT ok(finish_owner_booking_alert_send((SELECT id FROM owner_booking_alert_outbox WHERE kind='signup_link'),(SELECT claim_token FROM owner_booking_alert_outbox WHERE kind='signup_link'),'60000000-0000-4000-a094-000000000001','accepted','owner-provider-094'),'existing finalizer accepts signup alert');
SELECT is((SELECT count(*)::integer FROM resolve_owner_booking_alert_link(repeat('c',64))),1,'signup dashboard token resolves current owner');
SELECT is((SELECT count(*)::integer FROM claim_owner_booking_alerts(20)),0,'accepted signup alert never retries automatically');
SELECT pg_temp.accept_signup(15);
SELECT ok(set_owner_booking_alert_suppression('+15745550101',true,now(),'signup-stop-094'),'STOP updates shared recipient suppression');
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_outbox WHERE kind='signup_link' AND status='pending'),0,'STOP cancels unsent signup alerts');
SELECT pg_temp.accept_signup(16);
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_outbox WHERE kind='signup_link'),2,'STOP prevents new signup enqueue');
SELECT ok(set_owner_booking_alert_suppression('+15745550101',false,now()+interval '1 second','signup-start-094'),'START may clear the suppression');
SELECT ok(NOT (SELECT enabled FROM owner_booking_alert_settings WHERE business_id='10000000-0000-4000-a094-000000000001'),'START does not restore enrollment');

-- A legacy booking challenge cannot become sign-up consent through a goal edit.
SELECT configure_owner_booking_alert('10000000-0000-4000-a094-000000000002','00000000-0000-4000-a094-000000000002',0,'enroll','+15745550102',repeat('e',64),'2026-09-23-v1','Booking alerts only.',now()+interval '10 minutes');
UPDATE businesses SET primary_goal='signup',goal_url='https://example.test/signup',partner_plan='full' WHERE id='10000000-0000-4000-a094-000000000002';
UPDATE owner_booking_alert_control SET pilot_business_ids=NULL;
SELECT ok((consume_owner_booking_alert_verification(repeat('e',64),'+15745550102','+15742133931','profile-094','legacy-goal-change')).business_id IS NULL,'goal edit cannot consume legacy booking-only proof for signup scope');

SELECT is((pg_temp.signup_enroll(repeat('f',64))).pending_recipient,'+15745550101','owner can explicitly request fresh scoped consent');
SELECT ok((pg_temp.signup_verify(repeat('f',64))).enabled,'fresh proof restores only selected account');
SELECT is((SELECT count(*)::integer FROM resolve_owner_booking_alert_link(repeat('c',64))),0,'re-enrollment invalidates prior generation navigation');
SELECT pg_temp.accept_signup(17);
DELETE FROM voice_actions WHERE id='50000000-0000-4000-a094-000000000017';
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_outbox WHERE voice_action_id='50000000-0000-4000-a094-000000000017'),0,'source action removal cascades to its alert');
UPDATE businesses SET owner_id=NULL WHERE id='10000000-0000-4000-a094-000000000001';
SELECT is((SELECT count(*)::integer FROM owner_booking_alert_outbox WHERE business_id='10000000-0000-4000-a094-000000000001'),0,'owner cleanup scrubs signup delivery records');
SELECT * FROM finish();
ROLLBACK;
