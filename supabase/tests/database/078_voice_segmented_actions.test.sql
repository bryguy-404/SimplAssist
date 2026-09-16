BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

-- The worker now expands short model-facing segment references into these
-- original stored IDs. Exercise that unchanged database boundary with enough
-- fragments that making a model copy every long ID was unreliable.
INSERT INTO auth.users(id,email) VALUES ('00000000-0000-4000-a079-000000000001','voice-segments@example.test');
INSERT INTO public.businesses(id,owner_id,name,business_type,slug,primary_goal,goal_url)
  VALUES ('ea848911-ef72-44a6-8cf3-c47b3959be26','00000000-0000-4000-a079-000000000001','Voice','general','voice-segments','signup','https://example.test/signup');
INSERT INTO public.voice_pilot_settings(business_id,enabled,contacts_enabled,signup_enabled)
  VALUES ('ea848911-ef72-44a6-8cf3-c47b3959be26',true,true,true);
INSERT INTO public.subscriptions(business_id,stripe_customer_id,stripe_subscription_id,plan,status)
  VALUES ('ea848911-ef72-44a6-8cf3-c47b3959be26','cus_segments','sub_segments','sms_and_chat','active');
INSERT INTO public.voice_pilot_testers(business_id,phone_number)
  VALUES ('ea848911-ef72-44a6-8cf3-c47b3959be26','+15555550101');
INSERT INTO public.contacts(id,business_id,phone_number,source_channel)
  VALUES ('20000000-0000-4000-a079-000000000001','ea848911-ef72-44a6-8cf3-c47b3959be26','+15555550101','voice');
INSERT INTO public.conversations(id,business_id,contact_id,channel)
  SELECT ('30000000-0000-4000-a079-'||lpad(i::text,12,'0'))::uuid,'ea848911-ef72-44a6-8cf3-c47b3959be26','20000000-0000-4000-a079-000000000001','voice'
  FROM generate_series(1,2) i;
INSERT INTO public.voice_sessions(id,business_id,conversation_id,call_control_id,call_session_id,caller_phone,called_phone,response_mode,status,reserved_seconds)
  SELECT ('40000000-0000-4000-a079-'||lpad(i::text,12,'0'))::uuid,'ea848911-ef72-44a6-8cf3-c47b3959be26',
    ('30000000-0000-4000-a079-'||lpad(i::text,12,'0'))::uuid,'segments-control-'||i,'segments-session-'||i,'+15555550101','+15742638634','voice','active',600
  FROM generate_series(1,2) i;

CREATE TEMP TABLE request_fragments AS
  SELECT i::integer AS seq,'event_'||md5('synthetic-contact-'||i) AS event_id,word AS content,
    (i*200)::integer AS start_ms,(i*200+200)::integer AS end_ms
  FROM unnest(string_to_array('My name is Taylor Example and my email address is taylor at example dot test. You can use that address to send information about getting started. I am interested in a signup link and would like to know what the next steps are after I receive it. If possible please make sure that the spelling is correct before saving anything.',' '))
    WITH ORDINALITY AS words(word,i);
SELECT ok((SELECT count(*) BETWEEN 40 AND 80 FROM request_fragments),'fixture contains a realistically fragmented contact request');
SELECT public.record_voice_fragment(s.id,f.event_id,'customer',f.content,f.start_ms,f.end_ms)
  FROM public.voice_sessions s CROSS JOIN request_fragments f ORDER BY s.id,f.seq;
CREATE TEMP TABLE request_evidence AS
  SELECT array_agg(event_id ORDER BY seq) AS ids,max(end_ms) AS caller_end FROM request_fragments;

SELECT throws_ok($$SELECT public.propose_voice_action('40000000-0000-4000-a079-000000000001','contact',repeat('a',64),
  '{"kind":"contact","name":"Taylor Example","phone":"+15555550101","email":"taylor@example.test"}',
  'May I save these details?',(SELECT ids||ARRAY['event_invented'] FROM request_evidence))$$,
  'P0001','request transcript evidence missing','one invented raw reference rejects the entire proposal');
SELECT is((SELECT count(*)::integer FROM public.voice_actions),0,'invalid proposal creates no action');
SELECT lives_ok($$SELECT public.propose_voice_action('40000000-0000-4000-a079-000000000001','contact',repeat('a',64),
  '{"kind":"contact","name":"Taylor Example","phone":"+15555550101","email":"taylor@example.test"}',
  'May I save Taylor Example, phone +15555550101, email taylor@example.test?',(SELECT ids FROM request_evidence))$$,
  'expanded original caller references create the contact proposal');
SELECT is((SELECT request_event_ids FROM public.voice_actions),(SELECT ids FROM request_evidence),'proposal retains every original caller ID in order');

-- Clock timestamps are arranged explicitly because all assertions share one
-- transaction; production fragment requests occur in separate transactions.
CREATE FUNCTION pg_temp.play_readback(p_action_id uuid,p_event_id text,p_start integer,p_end integer,p_caller_end integer)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE a public.voice_actions;
BEGIN
  SELECT * INTO a FROM public.voice_actions WHERE id=p_action_id;
  UPDATE public.voice_actions SET created_at=clock_timestamp()-interval '5 seconds' WHERE id=a.id;
  PERFORM public.record_voice_fragment(a.session_id,p_event_id,'assistant',a.readback,p_start,p_end);
  UPDATE public.voice_transcript_fragments SET received_at=clock_timestamp()-interval '1 second'
    WHERE session_id=a.session_id AND event_id=p_event_id;
  PERFORM public.mark_voice_action_playback(a.session_id,a.id,p_event_id,p_caller_end);
END $$;
CREATE FUNCTION pg_temp.caller_fragment(p_session_id uuid,p_event_id text,p_content text,p_start integer,p_end integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.record_voice_fragment(p_session_id,p_event_id,'customer',p_content,p_start,p_end);
  UPDATE public.voice_transcript_fragments SET received_at=clock_timestamp()+interval '1 second'
    WHERE session_id=p_session_id AND event_id=p_event_id;
END $$;

SELECT pg_temp.play_readback((SELECT id FROM public.voice_actions),'event_contact_readback',15000,19000,(SELECT caller_end FROM request_evidence));
SELECT pg_temp.caller_fragment('40000000-0000-4000-a079-000000000001','event_contact_yes1','Yes,',20000,20200);
SELECT pg_temp.caller_fragment('40000000-0000-4000-a079-000000000001','event_contact_yes2','that is',20200,20400);
SELECT pg_temp.caller_fragment('40000000-0000-4000-a079-000000000001','event_contact_yes3','fine,',20400,20600);
SELECT pg_temp.caller_fragment('40000000-0000-4000-a079-000000000001','event_contact_yes4','please save those.',20600,21000);
SELECT lives_ok($$SELECT public.claim_voice_action('40000000-0000-4000-a079-000000000001',(SELECT id FROM public.voice_actions),
  ARRAY['event_contact_readback'],ARRAY['event_contact_yes1','event_contact_yes2','event_contact_yes3','event_contact_yes4'])$$,
  'complete segmented contact permission reaches execution');
CREATE TEMP TABLE contact_action_snapshot AS
  SELECT id,source_message_id,(SELECT count(*) FROM public.messages WHERE conversation_id='30000000-0000-4000-a079-000000000001') AS message_count
  FROM public.voice_actions;
SELECT lives_ok($$SELECT public.save_voice_action_contact((SELECT id FROM contact_action_snapshot))$$,'real contact save succeeds after expanded evidence');
SELECT is((SELECT name FROM public.contacts WHERE id='20000000-0000-4000-a079-000000000001'),'Taylor Example','confirmed caller name is stored');
SELECT is((SELECT email FROM public.contacts WHERE id='20000000-0000-4000-a079-000000000001'),'taylor@example.test','confirmed caller email is stored');
SELECT lives_ok($$SELECT public.save_voice_action_contact((SELECT id FROM contact_action_snapshot))$$,'repeated save is safe');
SELECT lives_ok($$SELECT public.claim_voice_action('40000000-0000-4000-a079-000000000001',(SELECT id FROM contact_action_snapshot),
  ARRAY['event_contact_readback'],ARRAY['event_contact_yes1','event_contact_yes2','event_contact_yes3','event_contact_yes4'])$$,
  'repeated confirmation returns the existing action');
SELECT is((SELECT count(*)::integer FROM public.contacts),1,'repeated save creates no duplicate contact');
SELECT is((SELECT source_message_id FROM public.voice_actions WHERE id=(SELECT id FROM contact_action_snapshot)),(SELECT source_message_id FROM contact_action_snapshot),'repeated claim retains the original confirmed message');
SELECT is((SELECT count(*) FROM public.messages WHERE conversation_id='30000000-0000-4000-a079-000000000001'),(SELECT message_count FROM contact_action_snapshot),'repeated claim creates no duplicate confirmation message');

-- The application records success before starting the separate signup action.
UPDATE public.voice_actions SET status='succeeded',result='{"summary":"Contact details saved."}' WHERE id=(SELECT id FROM contact_action_snapshot);
SELECT lives_ok($$SELECT public.propose_voice_action('40000000-0000-4000-a079-000000000001','signup',repeat('b',64),
  '{"kind":"signup","approvedUrl":"https://example.test/signup"}',
  'May I text the signup link to the number you are calling from, ending in 0101?',(SELECT ids FROM request_evidence))$$,
  'successful contact capture allows a separate signup proposal');
SELECT is((SELECT count(*)::integer FROM public.voice_actions WHERE session_id='40000000-0000-4000-a079-000000000001'),2,'contact and signup remain distinct actions');
SELECT is((SELECT status FROM public.voice_actions WHERE kind='signup'),'awaiting_confirmation','contact permission never automatically authorizes the signup text');
SELECT pg_temp.play_readback((SELECT id FROM public.voice_actions WHERE kind='signup'),'event_signup_readback',22000,24500,21000);
SELECT throws_ok($$SELECT public.claim_voice_action('40000000-0000-4000-a079-000000000001',(SELECT id FROM public.voice_actions WHERE kind='signup'),
  ARRAY['event_signup_readback'],ARRAY['event_contact_yes1','event_contact_yes2','event_contact_yes3','event_contact_yes4'])$$,
  'P0001','confirmation evidence out of order','contact confirmation cannot be reused as signup permission');
SELECT pg_temp.caller_fragment('40000000-0000-4000-a079-000000000001','event_signup_yes1','Sure,',25000,25200);
SELECT pg_temp.caller_fragment('40000000-0000-4000-a079-000000000001','event_signup_yes2','please send it.',25200,25600);
SELECT lives_ok($$SELECT public.claim_voice_action('40000000-0000-4000-a079-000000000001',(SELECT id FROM public.voice_actions WHERE kind='signup'),
  ARRAY['event_signup_readback'],ARRAY['event_signup_yes1','event_signup_yes2'])$$,
  'fresh complete signup permission reaches execution without sending a real SMS');

SELECT public.propose_voice_action('40000000-0000-4000-a079-000000000002','contact',repeat('c',64),
  '{"kind":"contact","name":"Taylor Example","phone":"+15555550101","email":"taylor@example.test"}',
  'May I save Taylor Example, phone +15555550101, email taylor@example.test?',(SELECT ids FROM request_evidence));
SELECT pg_temp.play_readback((SELECT id FROM public.voice_actions WHERE session_id='40000000-0000-4000-a079-000000000002'),'event_correction_readback',15000,19000,(SELECT caller_end FROM request_evidence));
SELECT pg_temp.caller_fragment('40000000-0000-4000-a079-000000000002','event_initial_yes','Yes, please.',20000,20200);
SELECT pg_temp.caller_fragment('40000000-0000-4000-a079-000000000002','event_late_correction1','Actually,',20200,20400);
SELECT pg_temp.caller_fragment('40000000-0000-4000-a079-000000000002','event_late_correction2','use my other email.',20400,20900);
SELECT throws_ok($$SELECT public.claim_voice_action('40000000-0000-4000-a079-000000000002',
  (SELECT id FROM public.voice_actions WHERE session_id='40000000-0000-4000-a079-000000000002'),
  ARRAY['event_correction_readback'],ARRAY['event_initial_yes'])$$,
  'P0001','confirmation evidence incomplete','late correction omitted from the model snapshot still blocks the action');
SELECT is((SELECT status FROM public.voice_actions WHERE session_id='40000000-0000-4000-a079-000000000002'),'awaiting_confirmation','late corrected contact action stays unexecuted');
SELECT ok((SELECT source_message_id IS NULL FROM public.voice_actions WHERE session_id='40000000-0000-4000-a079-000000000002'),'late correction creates no confirmed source message');
SELECT is((SELECT email FROM public.contacts WHERE id='20000000-0000-4000-a079-000000000001'),'taylor@example.test','rejected correction cannot overwrite saved contact data');

SELECT * FROM finish();
ROLLBACK;
