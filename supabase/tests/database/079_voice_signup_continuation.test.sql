BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

INSERT INTO auth.users(id,email) VALUES ('00000000-0000-4000-a079-000000000001','voice-continuation@example.test');
INSERT INTO public.businesses(id,owner_id,name,business_type,slug,primary_goal,goal_url) VALUES
  ('ea848911-ef72-44a6-8cf3-c47b3959be26','00000000-0000-4000-a079-000000000001','Voice','general','voice-079','signup','https://example.test/get-started'),
  ('10000000-0000-4000-a079-000000000002','00000000-0000-4000-a079-000000000001','Other business','general','voice-other-079','signup','https://other.example.test/signup');
INSERT INTO public.voice_pilot_settings(business_id,enabled,contacts_enabled,signup_enabled) VALUES ('ea848911-ef72-44a6-8cf3-c47b3959be26',true,true,true);
INSERT INTO public.subscriptions(business_id,stripe_customer_id,stripe_subscription_id,plan,status) VALUES ('ea848911-ef72-44a6-8cf3-c47b3959be26','cus_voice','sub_voice','sms_and_chat','active');
INSERT INTO public.voice_pilot_testers(business_id,phone_number) VALUES ('ea848911-ef72-44a6-8cf3-c47b3959be26','+15555550101');
INSERT INTO public.contacts(id,business_id,phone_number,source_channel,name,email) VALUES
  ('20000000-0000-4000-a079-000000000001','ea848911-ef72-44a6-8cf3-c47b3959be26','+15555550101','voice','Taylor','taylor@example.test');
INSERT INTO public.conversations(id,business_id,contact_id,channel)
  SELECT ('30000000-0000-4000-a079-'||lpad(i::text,12,'0'))::uuid,'ea848911-ef72-44a6-8cf3-c47b3959be26','20000000-0000-4000-a079-000000000001','voice'
  FROM generate_series(1,50) i;
INSERT INTO public.voice_sessions(id,business_id,conversation_id,call_control_id,call_session_id,caller_phone,called_phone,response_mode,status,reserved_seconds)
  SELECT ('40000000-0000-4000-a079-'||lpad(i::text,12,'0'))::uuid,'ea848911-ef72-44a6-8cf3-c47b3959be26',
    ('30000000-0000-4000-a079-'||lpad(i::text,12,'0'))::uuid,'continuation-control-'||i,'continuation-session-'||i,'+15555550101','+15742638634','voice','active',600
  FROM generate_series(1,50) i;

-- Each case starts after an independently confirmed, successful contact save.
-- The RPC under test cannot supply new transcript evidence or contact results.
CREATE TEMP TABLE continuation_cases(n integer PRIMARY KEY,session_id uuid NOT NULL,contact_action_id uuid NOT NULL);
CREATE FUNCTION pg_temp.completed_contact(p_case integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s uuid; a public.voice_actions;
BEGIN
  s:=('40000000-0000-4000-a079-'||lpad(p_case::text,12,'0'))::uuid;
  PERFORM public.record_voice_fragment(s,'request-'||p_case,'customer','My name is Taylor, email taylor@example.test',100,200);
  SELECT * INTO a FROM public.propose_voice_action(s,'contact',repeat('a',64),
    '{"kind":"contact","name":"Taylor","phone":"+15555550101","email":"taylor@example.test"}',
    'May I save Taylor and taylor@example.test?',ARRAY['request-'||p_case]);
  UPDATE public.voice_actions SET status='succeeded',confirmed_at=now(),execution_started_at=now(),
    result='{"summary":"The confirmed contact details were saved.","contactId":"20000000-0000-4000-a079-000000000001","conflicts":[]}',
    recovery_complete=true WHERE id=a.id;
  INSERT INTO continuation_cases VALUES(p_case,s,a.id);
END $$;
SELECT pg_temp.completed_contact(i) FROM generate_series(1,50) i;

CREATE FUNCTION pg_temp.prepare_signup(p_case integer,p_fingerprint text DEFAULT repeat('b',64),p_url text DEFAULT 'https://example.test/get-started')
RETURNS public.voice_actions LANGUAGE sql AS $$
  SELECT public.prepare_voice_signup_after_contact(c.session_id,c.contact_action_id,p_fingerprint,
    jsonb_build_object('kind','signup','approvedUrl',p_url),'May I text the signup link to the number you are calling from?')
  FROM continuation_cases c WHERE n=p_case;
$$;

CREATE TEMP TABLE before_signup_messages AS SELECT count(*)::integer AS message_count FROM public.messages;
CREATE TEMP TABLE first_offer AS SELECT a.* FROM pg_temp.prepare_signup(1) a;
SELECT ok((SELECT id IS NOT NULL FROM first_offer),'successful current contact prepares a signup offer');
SELECT is((SELECT kind FROM first_offer),'signup','continuation prepares only a signup action');
SELECT is((SELECT status FROM first_offer),'awaiting_confirmation','prepared offer does not execute');
SELECT is((SELECT revision FROM first_offer),2,'offer immediately follows the contact revision');
SELECT is((SELECT request_event_ids FROM first_offer),ARRAY['request-1'],'offer uses the contact action stored request evidence');
SELECT ok((SELECT playback_at IS NULL AND playback_event_id IS NULL AND confirmed_at IS NULL
  AND readback_event_ids IS NULL AND confirmation_event_ids IS NULL AND execution_started_at IS NULL
  AND source_message_id IS NULL AND result IS NULL FROM first_offer),'contact consent and result are not copied into signup permission');
SELECT is((SELECT status FROM public.voice_actions WHERE id=(SELECT contact_action_id FROM continuation_cases WHERE n=1)),'succeeded','contact success is preserved');
SELECT is((SELECT email FROM public.contacts WHERE id='20000000-0000-4000-a079-000000000001'),'taylor@example.test','continuation preserves saved contact details');
SELECT is((pg_temp.prepare_signup(1)).id,(SELECT id FROM first_offer),'duplicate continuation returns the same immediate pending signup');
SELECT is((SELECT count(*)::integer FROM public.voice_actions WHERE session_id=(SELECT session_id FROM continuation_cases WHERE n=1)),2,'duplicate continuation adds no extra action');
SELECT is((SELECT count(*)::integer FROM public.messages),(SELECT message_count FROM before_signup_messages),'preparing or repeating the offer creates no extra message');
SELECT throws_ok($$SELECT public.claim_voice_action((SELECT session_id FROM continuation_cases WHERE n=1),(SELECT id FROM first_offer),ARRAY['old-contact-readback'],ARRAY['request-1'])$$,
  'P0001','voice action not confirmable','signup still requires its own phone playback');

-- Even after playing the signup question, earlier contact evidence cannot be
-- used as permission. Only a new reply after this question can claim the send.
UPDATE public.voice_actions SET created_at=clock_timestamp()-interval '5 seconds' WHERE id=(SELECT id FROM first_offer);
SELECT public.record_voice_fragment((SELECT session_id FROM continuation_cases WHERE n=1),'signup-readback','assistant','May I text you the signup link?',300,450);
UPDATE public.voice_transcript_fragments SET received_at=clock_timestamp()-interval '1 second'
  WHERE session_id=(SELECT session_id FROM continuation_cases WHERE n=1) AND event_id='signup-readback';
SELECT ok(public.mark_voice_action_playback((SELECT session_id FROM continuation_cases WHERE n=1),(SELECT id FROM first_offer),'signup-readback',200),'new signup question can receive its own playback acknowledgment');
SELECT throws_ok($$SELECT public.claim_voice_action((SELECT session_id FROM continuation_cases WHERE n=1),(SELECT id FROM first_offer),ARRAY['signup-readback'],ARRAY['request-1'])$$,
  'P0001','confirmation evidence out of order','contact request cannot confirm signup after the new playback');
SELECT public.record_voice_fragment((SELECT session_id FROM continuation_cases WHERE n=1),'signup-yes','customer','Yes, please text it.',500,650);
UPDATE public.voice_transcript_fragments SET received_at=clock_timestamp()+interval '1 second'
  WHERE session_id=(SELECT session_id FROM continuation_cases WHERE n=1) AND event_id='signup-yes';
SELECT lives_ok($$SELECT public.claim_voice_action((SELECT session_id FROM continuation_cases WHERE n=1),(SELECT id FROM first_offer),ARRAY['signup-readback'],ARRAY['signup-yes'])$$,'fresh signup confirmation can claim the prepared offer');
SELECT is((SELECT status FROM public.voice_actions WHERE id=(SELECT id FROM first_offer)),'executing','signup advances only through the existing confirmation boundary');
SELECT ok((pg_temp.prepare_signup(1)).id IS NULL,'an executing signup cannot be prepared or retried');

UPDATE public.voice_actions SET status='awaiting_confirmation' WHERE id=(SELECT contact_action_id FROM continuation_cases WHERE n=2);
SELECT ok((pg_temp.prepare_signup(2)).id IS NULL,'unconfirmed contact cannot start signup continuation');
UPDATE public.voice_actions SET status='failed' WHERE id=(SELECT contact_action_id FROM continuation_cases WHERE n=3);
SELECT ok((pg_temp.prepare_signup(3)).id IS NULL,'failed contact cannot start signup continuation');
UPDATE public.voice_actions SET result=NULL WHERE id=(SELECT contact_action_id FROM continuation_cases WHERE n=4);
SELECT ok((pg_temp.prepare_signup(4)).id IS NULL,'success status without a stored contact result cannot continue');
UPDATE public.voice_actions SET result='{}' WHERE id=(SELECT contact_action_id FROM continuation_cases WHERE n=5);
SELECT ok((pg_temp.prepare_signup(5)).id IS NULL,'empty contact result cannot continue');
UPDATE public.voice_actions SET result='{"summary":"Saved","contactId":"20000000-0000-4000-a079-000000000002"}' WHERE id=(SELECT contact_action_id FROM continuation_cases WHERE n=6);
SELECT ok((pg_temp.prepare_signup(6)).id IS NULL,'result must name the contact linked to this call');
UPDATE public.voice_actions SET business_id='10000000-0000-4000-a079-000000000002' WHERE id=(SELECT contact_action_id FROM continuation_cases WHERE n=7);
SELECT ok((pg_temp.prepare_signup(7)).id IS NULL,'contact from another business cannot prepare signup');
SELECT ok((public.prepare_voice_signup_after_contact((SELECT session_id FROM continuation_cases WHERE n=8),
  (SELECT contact_action_id FROM continuation_cases WHERE n=1),repeat('b',64),'{"kind":"signup","approvedUrl":"https://example.test/get-started"}','May I text the signup link?')).id IS NULL,
  'contact from another call cannot prepare signup');
UPDATE public.voice_actions SET kind='booking_request' WHERE id=(SELECT contact_action_id FROM continuation_cases WHERE n=9);
SELECT ok((pg_temp.prepare_signup(9)).id IS NULL,'successful non-contact action cannot prepare this continuation');
SELECT ok((public.prepare_voice_signup_after_contact('40000000-0000-4000-a079-000000000099',
  (SELECT contact_action_id FROM continuation_cases WHERE n=10),repeat('b',64),'{"kind":"signup","approvedUrl":"https://example.test/get-started"}','May I text the signup link?')).id IS NULL,
  'unknown call cannot prepare signup');

UPDATE public.businesses SET primary_goal='book' WHERE id='ea848911-ef72-44a6-8cf3-c47b3959be26';
SELECT ok((pg_temp.prepare_signup(10)).id IS NULL,'current business goal must still be signup');
UPDATE public.businesses SET primary_goal='signup' WHERE id='ea848911-ef72-44a6-8cf3-c47b3959be26';
UPDATE public.voice_pilot_settings SET signup_enabled=false;
SELECT ok((pg_temp.prepare_signup(10)).id IS NULL,'disabled signup capability blocks continuation');
UPDATE public.voice_pilot_settings SET signup_enabled=true,enabled=false;
SELECT ok((pg_temp.prepare_signup(10)).id IS NULL,'disabled pilot blocks continuation');
UPDATE public.voice_pilot_settings SET enabled=true;
UPDATE public.subscriptions SET status='canceled' WHERE business_id='ea848911-ef72-44a6-8cf3-c47b3959be26';
SELECT ok((pg_temp.prepare_signup(10)).id IS NULL,'inactive subscription blocks continuation');
UPDATE public.subscriptions SET status='active' WHERE business_id='ea848911-ef72-44a6-8cf3-c47b3959be26';
UPDATE public.voice_sessions SET status='closed' WHERE id=(SELECT session_id FROM continuation_cases WHERE n=11);
SELECT ok((pg_temp.prepare_signup(11)).id IS NULL,'closed call cannot prepare signup');
UPDATE public.voice_sessions SET phone_ended_at=now() WHERE id=(SELECT session_id FROM continuation_cases WHERE n=12);
SELECT ok((pg_temp.prepare_signup(12)).id IS NULL,'ended phone call cannot prepare signup even if session remains active');
UPDATE public.voice_sessions SET response_mode='text' WHERE id=(SELECT session_id FROM continuation_cases WHERE n=13);
SELECT ok((pg_temp.prepare_signup(13)).id IS NULL,'text response mode cannot prepare signup');

SELECT ok((pg_temp.prepare_signup(10,repeat('b',64),'https://other.example.test/signup')).id IS NULL,'unapproved URL is rejected');
SELECT ok((public.prepare_voice_signup_after_contact((SELECT session_id FROM continuation_cases WHERE n=10),
  (SELECT contact_action_id FROM continuation_cases WHERE n=10),repeat('b',64),
  '{"kind":"signup","approvedUrl":"https://example.test/get-started","phone":"+15555550999"}','May I text the signup link?')).id IS NULL,
  'payload cannot inject a destination phone or extra action parameters');
SELECT ok((public.prepare_voice_signup_after_contact((SELECT session_id FROM continuation_cases WHERE n=10),
  (SELECT contact_action_id FROM continuation_cases WHERE n=10),repeat('b',64),
  '{"kind":"contact","approvedUrl":"https://example.test/get-started"}','May I text the signup link?')).id IS NULL,
  'payload must be a signup offer');
SELECT throws_ok($$SELECT pg_temp.prepare_signup(10,repeat('z',64))$$,'P0001','invalid signup continuation parameters','fingerprint must be a SHA-256 hex value');
SELECT throws_ok($$SELECT public.prepare_voice_signup_after_contact((SELECT session_id FROM continuation_cases WHERE n=10),
  (SELECT contact_action_id FROM continuation_cases WHERE n=10),repeat('b',64),'{"kind":"signup","approvedUrl":"https://example.test/get-started"}','')$$,
  'P0001','invalid signup continuation parameters','readback cannot be empty');
SELECT throws_ok($$SELECT public.prepare_voice_signup_after_contact((SELECT session_id FROM continuation_cases WHERE n=10),
  (SELECT contact_action_id FROM continuation_cases WHERE n=10),repeat('b',64),'{"kind":"signup","approvedUrl":"https://example.test/get-started"}',repeat('a',4001))$$,
  'P0001','invalid signup continuation parameters','readback respects the action table bound');

-- Every prior send state is a barrier, including a definitively failed send.
CREATE TEMP TABLE prior_signups AS
  SELECT i AS n,(pg_temp.prepare_signup(i)).id AS id FROM generate_series(14,18) i;
UPDATE public.voice_actions a SET status=CASE c.n WHEN 14 THEN 'succeeded' WHEN 15 THEN 'failed'
  WHEN 16 THEN 'uncertain' WHEN 17 THEN 'superseded' ELSE 'executing' END
  FROM prior_signups c WHERE a.id=c.id;
SELECT ok((pg_temp.prepare_signup(14)).id IS NULL,'successful signup is never retried');
SELECT ok((pg_temp.prepare_signup(15)).id IS NULL,'failed signup is never retried by contact continuation');
SELECT ok((pg_temp.prepare_signup(16)).id IS NULL,'uncertain signup is never retried');
SELECT ok((pg_temp.prepare_signup(17)).id IS NULL,'superseded signup cannot be revived by its older contact');
SELECT ok((pg_temp.prepare_signup(18)).id IS NULL,'executing signup is never retried');
SELECT is((SELECT count(*)::integer FROM public.voice_actions a JOIN prior_signups c ON a.session_id=(SELECT session_id FROM continuation_cases WHERE n=c.n) WHERE a.kind='signup'),5,
  'blocked prior attempts remain one signup per call');

SELECT pg_temp.prepare_signup(19);
SELECT ok((pg_temp.prepare_signup(19,repeat('c',64))).id IS NULL,'different fingerprint cannot replace a pending signup');
UPDATE public.businesses SET goal_url='https://example.test/new-signup' WHERE id='ea848911-ef72-44a6-8cf3-c47b3959be26';
SELECT ok((pg_temp.prepare_signup(19)).id IS NULL,'previous URL no longer matches current approved URL');
SELECT ok((pg_temp.prepare_signup(19,repeat('c',64),'https://example.test/new-signup')).id IS NULL,'changed URL cannot retry or supersede the original signup');
SELECT is((SELECT payload->>'approvedUrl' FROM public.voice_actions WHERE session_id=(SELECT session_id FROM continuation_cases WHERE n=19) AND kind='signup'),
  'https://example.test/get-started','blocked URL change preserves the original offer');
UPDATE public.businesses SET goal_url='https://example.test/get-started' WHERE id='ea848911-ef72-44a6-8cf3-c47b3959be26';

-- Delayed completion of contact A must not erase a newer request B.
SELECT public.propose_voice_action((SELECT session_id FROM continuation_cases WHERE n=20),'contact',repeat('c',64),
  '{"kind":"contact","name":"New Name","phone":"+15555550101"}','May I save New Name?',ARRAY['request-20']);
SELECT ok((pg_temp.prepare_signup(20)).id IS NULL,'a newer pending contact is preserved');
SELECT is((SELECT status FROM public.voice_actions WHERE session_id=(SELECT session_id FROM continuation_cases WHERE n=20) AND revision=2),
  'awaiting_confirmation','continuation does not supersede the newer pending action');
SELECT public.propose_voice_action((SELECT session_id FROM continuation_cases WHERE n=21),'contact',repeat('c',64),
  '{"kind":"contact","name":"New Name","phone":"+15555550101"}','May I save New Name?',ARRAY['request-21']);
UPDATE public.voice_actions SET status='succeeded' WHERE session_id=(SELECT session_id FROM continuation_cases WHERE n=21) AND revision=2;
SELECT ok((pg_temp.prepare_signup(21)).id IS NULL,'newer completed non-signup action also blocks stale continuation');
SELECT public.propose_voice_action((SELECT session_id FROM continuation_cases WHERE n=22),'contact',repeat('c',64),
  '{"kind":"contact","name":"New Name","phone":"+15555550101"}','May I save New Name?',ARRAY['request-22']);
UPDATE public.voice_actions SET status='uncertain' WHERE session_id=(SELECT session_id FROM continuation_cases WHERE n=22) AND revision=2;
SELECT ok((pg_temp.prepare_signup(22)).id IS NULL,'unresolved other action blocks continuation');

-- A pending signup must actually be the immediate successor of this contact,
-- with the same source evidence; matching only its fingerprint is insufficient.
SELECT pg_temp.prepare_signup(23);
UPDATE public.voice_actions SET revision=3 WHERE session_id=(SELECT session_id FROM continuation_cases WHERE n=23) AND kind='signup';
SELECT ok((pg_temp.prepare_signup(23)).id IS NULL,'pending signup with a revision gap cannot be reused');
SELECT pg_temp.prepare_signup(24);
UPDATE public.voice_actions SET request_event_ids=ARRAY['different-request'] WHERE session_id=(SELECT session_id FROM continuation_cases WHERE n=24) AND kind='signup';
SELECT ok((pg_temp.prepare_signup(24)).id IS NULL,'pending signup from different request evidence cannot be reused');
SELECT pg_temp.prepare_signup(25);
UPDATE public.voice_actions SET status='superseded' WHERE session_id=(SELECT session_id FROM continuation_cases WHERE n=25) AND kind='signup';
SELECT public.propose_voice_action((SELECT session_id FROM continuation_cases WHERE n=25),'signup',repeat('c',64),
  '{"kind":"signup","approvedUrl":"https://example.test/get-started"}','May I text the signup link?',ARRAY['request-25']);
SELECT ok((pg_temp.prepare_signup(25,repeat('c',64))).id IS NULL,'later pending signup does not revive an earlier attempt');

UPDATE public.voice_actions SET request_event_ids=ARRAY[]::text[] WHERE id=(SELECT contact_action_id FROM continuation_cases WHERE n=26);
SELECT ok((pg_temp.prepare_signup(26)).id IS NULL,'missing stored contact evidence blocks continuation');
UPDATE public.voice_actions SET request_event_ids=ARRAY['request-1'] WHERE id=(SELECT contact_action_id FROM continuation_cases WHERE n=27);
SELECT ok((pg_temp.prepare_signup(27)).id IS NULL,'stored evidence must belong to this call');
SELECT public.record_voice_fragment((SELECT session_id FROM continuation_cases WHERE n=28),'assistant-only','assistant','May I save those details?',220,300);
UPDATE public.voice_actions SET request_event_ids=ARRAY['assistant-only'] WHERE id=(SELECT contact_action_id FROM continuation_cases WHERE n=28);
SELECT ok((pg_temp.prepare_signup(28)).id IS NULL,'stored offer evidence must come from the caller');
UPDATE public.businesses SET goal_url='https://Example.test/Get-Started' WHERE id='ea848911-ef72-44a6-8cf3-c47b3959be26';
SELECT ok((pg_temp.prepare_signup(29,repeat('b',64),'https://Example.test/Get-Started')).id IS NOT NULL,'approved URL preserves host and path casing exactly');
SELECT ok((pg_temp.prepare_signup(30)).id IS NULL,'different URL path casing does not match the current approved URL');
UPDATE public.businesses SET goal_url='https://example.test/get-started' WHERE id='ea848911-ef72-44a6-8cf3-c47b3959be26';

-- A contact correction supersedes the unanswered signup offer. Only after the
-- corrected contact is confirmed and saved may that unattempted offer become a
-- fresh question, with all former playback/permission evidence discarded.
CREATE TEMP TABLE corrected_contact_cases(
  n integer PRIMARY KEY,session_id uuid NOT NULL,original_contact_id uuid NOT NULL,
  signup_id uuid NOT NULL,old_playback_at timestamptz NOT NULL,corrected_contact_id uuid NOT NULL
);
CREATE FUNCTION pg_temp.correct_contact_after_signup(p_case integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c continuation_cases; offer public.voice_actions; corrected public.voice_actions; saved jsonb;
BEGIN
  SELECT * INTO c FROM continuation_cases WHERE n=p_case;
  SELECT * INTO offer FROM pg_temp.prepare_signup(p_case);
  IF offer.id IS NULL THEN RAISE EXCEPTION 'fixture signup missing'; END IF;
  UPDATE public.voice_actions SET created_at=clock_timestamp()-interval '5 seconds' WHERE id=offer.id;
  PERFORM public.record_voice_fragment(c.session_id,'old-signup-readback','assistant',offer.readback,300,450);
  UPDATE public.voice_transcript_fragments SET received_at=clock_timestamp()-interval '1 second'
    WHERE session_id=c.session_id AND event_id='old-signup-readback';
  PERFORM public.mark_voice_action_playback(c.session_id,offer.id,'old-signup-readback',200);
  SELECT * INTO offer FROM public.voice_actions WHERE id=offer.id;
  PERFORM public.record_voice_fragment(c.session_id,'old-signup-yes','customer','Yes, please text it.',500,600);
  UPDATE public.voice_transcript_fragments SET received_at=offer.playback_at+interval '1 microsecond'
    WHERE session_id=c.session_id AND event_id='old-signup-yes';
  -- The caller corrects their details before any signup is claimed/executed.
  PERFORM public.record_voice_fragment(c.session_id,'corrected-contact-request','customer','Actually, my name is Taylor Adams.',700,900);
  UPDATE public.voice_transcript_fragments SET received_at=clock_timestamp()
    WHERE session_id=c.session_id AND event_id='corrected-contact-request';
  SELECT * INTO corrected FROM public.propose_voice_action(c.session_id,'contact',repeat('d',64),
    '{"kind":"contact","name":"Taylor Adams","phone":"+15555550101","email":"taylor@example.test"}',
    'May I save Taylor Adams and taylor@example.test?',ARRAY['corrected-contact-request']);
  UPDATE public.voice_actions SET created_at=clock_timestamp()-interval '5 seconds' WHERE id=corrected.id;
  PERFORM public.record_voice_fragment(c.session_id,'corrected-contact-readback','assistant',corrected.readback,1000,1150);
  UPDATE public.voice_transcript_fragments SET received_at=clock_timestamp()
    WHERE session_id=c.session_id AND event_id='corrected-contact-readback';
  PERFORM public.mark_voice_action_playback(c.session_id,corrected.id,'corrected-contact-readback',900);
  PERFORM public.record_voice_fragment(c.session_id,'corrected-contact-yes','customer','Yes, save those details.',1200,1400);
  UPDATE public.voice_transcript_fragments SET received_at=clock_timestamp()+interval '1 microsecond'
    WHERE session_id=c.session_id AND event_id='corrected-contact-yes';
  PERFORM public.claim_voice_action(c.session_id,corrected.id,ARRAY['corrected-contact-readback'],ARRAY['corrected-contact-yes']);
  saved:=public.save_voice_action_contact(corrected.id);
  UPDATE public.voice_actions SET status='succeeded',execution_started_at=clock_timestamp(),
    result=saved||'{"summary":"The confirmed contact details were saved."}'::jsonb,recovery_complete=true
    WHERE id=corrected.id;
  INSERT INTO corrected_contact_cases VALUES(p_case,c.session_id,c.contact_action_id,offer.id,offer.playback_at,corrected.id);
  UPDATE continuation_cases SET contact_action_id=corrected.id WHERE n=p_case;
END $$;

SELECT pg_temp.correct_contact_after_signup(31);
SELECT is((SELECT status FROM public.voice_actions WHERE id=(SELECT signup_id FROM corrected_contact_cases WHERE n=31)),
  'superseded','new corrected contact supersedes the prior pending signup through the existing proposal flow');
CREATE TEMP TABLE corrected_offer AS SELECT a.* FROM pg_temp.prepare_signup(31) a;
SELECT is((SELECT id FROM corrected_offer),(SELECT signup_id FROM corrected_contact_cases WHERE n=31),'corrected contact reuses only the original unexecuted signup row');
SELECT is((SELECT revision FROM corrected_offer),4,'rearmed offer gets a fresh revision after corrected contact');
SELECT is((SELECT status FROM corrected_offer),'awaiting_confirmation','corrected continuation remains only an offer');
SELECT is((SELECT request_event_ids FROM corrected_offer),ARRAY['corrected-contact-request'],'rearmed offer sources the corrected contact evidence');
SELECT ok((SELECT created_at>(SELECT old_playback_at FROM corrected_contact_cases WHERE n=31) FROM corrected_offer),
  'rearmed creation time is later than the previous playback');
SELECT ok((SELECT playback_at IS NULL AND playback_event_id IS NULL AND playback_caller_end_ms IS NULL
  AND readback_event_ids IS NULL AND confirmation_event_ids IS NULL AND confirmed_at IS NULL
  AND source_message_id IS NULL AND execution_started_at IS NULL AND result IS NULL AND error_code IS NULL
  AND sms_logged_at IS NULL AND reconciled_at IS NULL AND NOT recovery_complete FROM corrected_offer),
  'rearming clears every previous playback, confirmation, execution, and recovery field');
SELECT is((SELECT status FROM public.voice_actions WHERE id=(SELECT corrected_contact_id FROM corrected_contact_cases WHERE n=31)),
  'succeeded','corrected contact save remains successful');
SELECT is((SELECT count(*)::integer FROM public.voice_actions WHERE session_id=(SELECT session_id FROM corrected_contact_cases WHERE n=31) AND kind='signup'),
  1,'rearming creates no duplicate signup row');
SELECT is((pg_temp.prepare_signup(31)).id,(SELECT id FROM corrected_offer),'repeating the corrected continuation returns its same pending offer');
SELECT ok((public.prepare_voice_signup_after_contact((SELECT session_id FROM corrected_contact_cases WHERE n=31),
  (SELECT original_contact_id FROM corrected_contact_cases WHERE n=31),repeat('b',64),
  '{"kind":"signup","approvedUrl":"https://example.test/get-started"}','May I text the signup link?')).id IS NULL,
  'stale original contact cannot resurrect or replace the corrected signup');
SELECT throws_ok($$SELECT public.claim_voice_action((SELECT session_id FROM corrected_contact_cases WHERE n=31),
  (SELECT id FROM corrected_offer),ARRAY['old-signup-readback'],ARRAY['old-signup-yes'])$$,
  'P0001','voice action not confirmable','old signup consent cannot claim the rearmed offer before fresh playback');
SELECT ok(NOT public.mark_voice_action_playback((SELECT session_id FROM corrected_contact_cases WHERE n=31),
  (SELECT id FROM corrected_offer),'old-signup-readback',200),'old playback fragment cannot acknowledge the new signup revision');
SELECT public.record_voice_fragment((SELECT session_id FROM corrected_contact_cases WHERE n=31),'new-signup-readback','assistant',
  'May I text the signup link to the number you are calling from?',1500,1700);
UPDATE public.voice_transcript_fragments SET received_at=clock_timestamp()
  WHERE session_id=(SELECT session_id FROM corrected_contact_cases WHERE n=31) AND event_id='new-signup-readback';
SELECT ok(public.mark_voice_action_playback((SELECT session_id FROM corrected_contact_cases WHERE n=31),
  (SELECT id FROM corrected_offer),'new-signup-readback',1400),'rearmed signup accepts only fresh playback');
SELECT throws_ok($$SELECT public.claim_voice_action((SELECT session_id FROM corrected_contact_cases WHERE n=31),
  (SELECT id FROM corrected_offer),ARRAY['new-signup-readback'],ARRAY['old-signup-yes'])$$,
  'P0001','confirmation evidence out of order','old SMS assent cannot confirm the newly played signup question');
SELECT throws_ok($$SELECT public.claim_voice_action((SELECT session_id FROM corrected_contact_cases WHERE n=31),
  (SELECT id FROM corrected_offer),ARRAY['new-signup-readback'],ARRAY['corrected-contact-yes'])$$,
  'P0001','confirmation evidence out of order','corrected contact permission cannot confirm the signup send');
SELECT public.record_voice_fragment((SELECT session_id FROM corrected_contact_cases WHERE n=31),'new-signup-yes','customer','Yes, please send the link.',1800,2000);
UPDATE public.voice_transcript_fragments SET received_at=clock_timestamp()+interval '1 microsecond'
  WHERE session_id=(SELECT session_id FROM corrected_contact_cases WHERE n=31) AND event_id='new-signup-yes';
SELECT lives_ok($$SELECT public.claim_voice_action((SELECT session_id FROM corrected_contact_cases WHERE n=31),
  (SELECT id FROM corrected_offer),ARRAY['new-signup-readback'],ARRAY['new-signup-yes'])$$,
  'fresh complete signup permission can claim the rearmed offer once');
SELECT is((SELECT status FROM public.voice_actions WHERE id=(SELECT id FROM corrected_offer)),
  'executing','corrected signup executes only through fresh confirmation');
SELECT ok((pg_temp.prepare_signup(31)).id IS NULL,'claimed corrected signup cannot be rearmed again');

SELECT pg_temp.correct_contact_after_signup(i) FROM generate_series(32,50) i;
UPDATE public.businesses SET goal_url='https://example.test/new-signup' WHERE id='ea848911-ef72-44a6-8cf3-c47b3959be26';
SELECT ok((pg_temp.prepare_signup(32,repeat('b',64),'https://example.test/new-signup')).id IS NULL,
  'corrected contact cannot rearm a signup for a different approved URL');
UPDATE public.businesses SET goal_url='https://example.test/get-started' WHERE id='ea848911-ef72-44a6-8cf3-c47b3959be26';
SELECT ok((pg_temp.prepare_signup(33,repeat('c',64))).id IS NULL,'corrected contact cannot rearm a different fingerprint');
SELECT public.propose_voice_action((SELECT session_id FROM corrected_contact_cases WHERE n=34),'contact',repeat('e',64),
  '{"kind":"contact","name":"Another Name","phone":"+15555550101"}','May I save Another Name?',ARRAY['corrected-contact-request']);
SELECT ok((pg_temp.prepare_signup(34)).id IS NULL,'another pending contact after the correction blocks rearming');
SELECT is((SELECT status FROM public.voice_actions WHERE session_id=(SELECT session_id FROM corrected_contact_cases WHERE n=34) AND revision=4),
  'awaiting_confirmation','blocked rearming preserves the newest pending question');

-- Any indication that the old signup was claimed, attempted, or reconciled
-- prevents rearming, even if its status was later changed to superseded.
UPDATE public.voice_actions SET confirmed_at=now() WHERE id=(SELECT signup_id FROM corrected_contact_cases WHERE n=35);
UPDATE public.voice_actions SET source_message_id=(SELECT source_message_id FROM public.voice_actions WHERE id=(SELECT corrected_contact_id FROM corrected_contact_cases WHERE n=36))
  WHERE id=(SELECT signup_id FROM corrected_contact_cases WHERE n=36);
UPDATE public.voice_actions SET execution_started_at=now() WHERE id=(SELECT signup_id FROM corrected_contact_cases WHERE n=37);
UPDATE public.voice_actions SET result='{"providerMessageId":"already-submitted"}' WHERE id=(SELECT signup_id FROM corrected_contact_cases WHERE n=38);
UPDATE public.voice_actions SET error_code='previous_attempt' WHERE id=(SELECT signup_id FROM corrected_contact_cases WHERE n=39);
UPDATE public.voice_actions SET readback_event_ids=ARRAY['old-signup-readback'] WHERE id=(SELECT signup_id FROM corrected_contact_cases WHERE n=40);
UPDATE public.voice_actions SET confirmation_event_ids=ARRAY['old-signup-yes'] WHERE id=(SELECT signup_id FROM corrected_contact_cases WHERE n=41);
UPDATE public.voice_actions SET sms_logged_at=now() WHERE id=(SELECT signup_id FROM corrected_contact_cases WHERE n=42);
UPDATE public.voice_actions SET reconciled_at=now() WHERE id=(SELECT signup_id FROM corrected_contact_cases WHERE n=43);
UPDATE public.voice_actions SET recovery_complete=true WHERE id=(SELECT signup_id FROM corrected_contact_cases WHERE n=44);
SELECT ok((pg_temp.prepare_signup(n)).id IS NULL,
  'superseded signup with '||CASE n WHEN 35 THEN 'confirmed_at' WHEN 36 THEN 'source_message_id'
    WHEN 37 THEN 'execution_started_at' WHEN 38 THEN 'result' WHEN 39 THEN 'error_code'
    WHEN 40 THEN 'readback_event_ids' WHEN 41 THEN 'confirmation_event_ids' WHEN 42 THEN 'sms_logged_at'
    WHEN 43 THEN 'reconciled_at' ELSE 'recovery_complete' END||' cannot be rearmed')
  FROM corrected_contact_cases WHERE n BETWEEN 35 AND 44 ORDER BY n;

SELECT public.propose_voice_action((SELECT session_id FROM corrected_contact_cases WHERE n=45),'signup',repeat('c',64),
  '{"kind":"signup","approvedUrl":"https://example.test/get-started"}','May I text the signup link?',ARRAY['corrected-contact-request']);
SELECT ok((pg_temp.prepare_signup(45)).id IS NULL,'multiple signup rows prevent rearming any earlier offer');
SELECT public.propose_voice_action((SELECT session_id FROM corrected_contact_cases WHERE n=46),'contact',repeat('e',64),
  '{"kind":"contact","name":"Another Name","phone":"+15555550101"}','May I save Another Name?',ARRAY['corrected-contact-request']);
UPDATE public.voice_actions SET status='succeeded' WHERE session_id=(SELECT session_id FROM corrected_contact_cases WHERE n=46) AND revision=4;
SELECT ok((pg_temp.prepare_signup(46)).id IS NULL,'newer completed action prevents stale corrected-contact rearming');
UPDATE public.voice_actions a SET status=CASE c.n WHEN 47 THEN 'failed' WHEN 48 THEN 'succeeded'
  WHEN 49 THEN 'executing' ELSE 'uncertain' END FROM corrected_contact_cases c
  WHERE c.n BETWEEN 47 AND 50 AND a.id=c.signup_id;
SELECT ok((pg_temp.prepare_signup(n)).id IS NULL,
  'newer corrected contact cannot rearm signup status '||CASE n WHEN 47 THEN 'failed' WHEN 48 THEN 'succeeded'
    WHEN 49 THEN 'executing' ELSE 'uncertain' END)
  FROM corrected_contact_cases WHERE n BETWEEN 47 AND 50 ORDER BY n;

SELECT ok(NOT has_function_privilege('authenticated','public.prepare_voice_signup_after_contact(uuid,uuid,text,jsonb,text)','EXECUTE'),
  'customer cannot invoke signup continuation');
SELECT ok(NOT has_function_privilege('anon','public.prepare_voice_signup_after_contact(uuid,uuid,text,jsonb,text)','EXECUTE'),
  'anonymous caller cannot invoke signup continuation');
SELECT ok(has_function_privilege('service_role','public.prepare_voice_signup_after_contact(uuid,uuid,text,jsonb,text)','EXECUTE'),
  'only trusted backend retains continuation permission');

SELECT * FROM finish();
ROLLBACK;
