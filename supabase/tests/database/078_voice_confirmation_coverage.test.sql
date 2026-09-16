BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

INSERT INTO auth.users(id,email) VALUES ('00000000-0000-4000-a078-000000000001','voice-coverage@example.test');
INSERT INTO public.businesses(id,owner_id,name,business_type,slug) VALUES ('ea848911-ef72-44a6-8cf3-c47b3959be26','00000000-0000-4000-a078-000000000001','Voice','general','voice-078');
INSERT INTO public.voice_pilot_settings(business_id,enabled,contacts_enabled,signup_enabled) VALUES ('ea848911-ef72-44a6-8cf3-c47b3959be26',true,true,true);
INSERT INTO public.subscriptions(business_id,stripe_customer_id,stripe_subscription_id,plan,status) VALUES ('ea848911-ef72-44a6-8cf3-c47b3959be26','cus_voice','sub_voice','sms_and_chat','active');
INSERT INTO public.voice_pilot_testers(business_id,phone_number) VALUES ('ea848911-ef72-44a6-8cf3-c47b3959be26','+15555550101');
INSERT INTO public.contacts(id,business_id,phone_number,source_channel) VALUES ('20000000-0000-4000-a078-000000000001','ea848911-ef72-44a6-8cf3-c47b3959be26','+15555550101','voice');
INSERT INTO public.conversations(id,business_id,contact_id,channel)
  SELECT ('30000000-0000-4000-a078-'||lpad(i::text,12,'0'))::uuid,'ea848911-ef72-44a6-8cf3-c47b3959be26','20000000-0000-4000-a078-000000000001','voice'
  FROM generate_series(1,5) i;
INSERT INTO public.voice_sessions(id,business_id,conversation_id,call_control_id,call_session_id,caller_phone,called_phone,response_mode,status,reserved_seconds)
  SELECT ('40000000-0000-4000-a078-'||lpad(i::text,12,'0'))::uuid,'ea848911-ef72-44a6-8cf3-c47b3959be26',
    ('30000000-0000-4000-a078-'||lpad(i::text,12,'0'))::uuid,'coverage-control-'||i,'coverage-session-'||i,'+15555550101','+15742638634','voice','active',600
  FROM generate_series(1,5) i;

-- Each case has its own active call and acknowledged contact readback.
CREATE FUNCTION pg_temp.prepare_contact(p_session_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a public.voice_actions;
BEGIN
  PERFORM public.record_voice_fragment(p_session_id,'request','customer','My name is Taylor, email taylor@example.test',100,200);
  SELECT * INTO a FROM public.propose_voice_action(p_session_id,'contact',repeat('a',64),
    '{"kind":"contact","name":"Taylor","phone":"+15555550101","email":"taylor@example.test"}',
    'May I save Taylor, phone +15555550101, email taylor@example.test?',ARRAY['request']);
  UPDATE public.voice_actions SET created_at=clock_timestamp()-interval '5 seconds' WHERE id=a.id;
  PERFORM public.record_voice_fragment(p_session_id,'readback','assistant',a.readback,210,400);
  UPDATE public.voice_transcript_fragments SET received_at=clock_timestamp()-interval '1 second' WHERE session_id=p_session_id AND event_id='readback';
  PERFORM public.mark_voice_action_playback(p_session_id,a.id,'readback',200);
END $$;
SELECT pg_temp.prepare_contact(id) FROM public.voice_sessions ORDER BY id;

-- received_at deliberately follows the actual mark rather than transaction now().
CREATE FUNCTION pg_temp.caller_fragment(p_session_id uuid,p_event_id text,p_content text,p_start integer,p_end integer)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.record_voice_fragment(p_session_id,p_event_id,'customer',p_content,p_start,p_end);
  UPDATE public.voice_transcript_fragments SET received_at=clock_timestamp()+interval '1 second'
    WHERE session_id=p_session_id AND event_id=p_event_id;
END $$;

SELECT pg_temp.caller_fragment('40000000-0000-4000-a078-000000000001','yes-1','Yes,',500,550);
SELECT pg_temp.caller_fragment('40000000-0000-4000-a078-000000000001','yes-2',' you can',550,650);
SELECT pg_temp.caller_fragment('40000000-0000-4000-a078-000000000001','yes-3',' save those.',650,800);
SELECT lives_ok($$SELECT public.claim_voice_action('40000000-0000-4000-a078-000000000001',(SELECT id FROM public.voice_actions WHERE session_id='40000000-0000-4000-a078-000000000001'),ARRAY['readback'],ARRAY['yes-1','yes-2','yes-3'])$$,'complete natural multi-fragment permission claims contact action');
SELECT is((SELECT status FROM public.voice_actions WHERE session_id='40000000-0000-4000-a078-000000000001'),'executing','contact action is ready for one execution');
SELECT is((SELECT cardinality(confirmation_event_ids) FROM public.voice_actions WHERE session_id='40000000-0000-4000-a078-000000000001'),3,'all actual response fragments are retained');
CREATE TEMP TABLE source_snapshot AS SELECT source_message_id,(SELECT count(*) FROM public.messages) AS message_count FROM public.voice_actions WHERE session_id='40000000-0000-4000-a078-000000000001';
SELECT lives_ok($$SELECT public.claim_voice_action('40000000-0000-4000-a078-000000000001',(SELECT id FROM public.voice_actions WHERE session_id='40000000-0000-4000-a078-000000000001'),ARRAY['readback'],ARRAY['yes-1','yes-2','yes-3'])$$,'duplicate claim returns the existing action');
SELECT is((SELECT source_message_id FROM public.voice_actions WHERE session_id='40000000-0000-4000-a078-000000000001'),(SELECT source_message_id FROM source_snapshot),'duplicate claim retains the original source message');
SELECT is((SELECT count(*) FROM public.messages),(SELECT message_count FROM source_snapshot),'duplicate claim creates no extra source message');
SELECT lives_ok($$SELECT public.save_voice_action_contact((SELECT id FROM public.voice_actions WHERE session_id='40000000-0000-4000-a078-000000000001'))$$,'confirmed natural response can save contact details');
SELECT is((SELECT email FROM public.contacts WHERE id='20000000-0000-4000-a078-000000000001'),'taylor@example.test','confirmed contact email is saved');

SELECT pg_temp.caller_fragment('40000000-0000-4000-a078-000000000002','condition','If it is free,',500,650);
SELECT pg_temp.caller_fragment('40000000-0000-4000-a078-000000000002','conditional-yes',' yes.',650,800);
SELECT throws_ok($$SELECT public.claim_voice_action('40000000-0000-4000-a078-000000000002',(SELECT id FROM public.voice_actions WHERE session_id='40000000-0000-4000-a078-000000000002'),ARRAY['readback'],ARRAY['conditional-yes'])$$,'P0001','confirmation evidence incomplete','cannot omit a condition prefix even when the cited yes ends at the latest caller timestamp');
SELECT is((SELECT status FROM public.voice_actions WHERE session_id='40000000-0000-4000-a078-000000000002'),'awaiting_confirmation','incomplete evidence cannot advance the action');
SELECT ok((SELECT source_message_id IS NULL FROM public.voice_actions WHERE session_id='40000000-0000-4000-a078-000000000002'),'incomplete evidence creates no confirmed source');

SELECT pg_temp.caller_fragment('40000000-0000-4000-a078-000000000003','earlier-signup-yes','Yes, send me the signup link.',50,90);
UPDATE public.voice_transcript_fragments f SET received_at=a.playback_at-interval '1 second' FROM public.voice_actions a
  WHERE f.session_id=a.session_id AND f.session_id='40000000-0000-4000-a078-000000000003' AND f.event_id='earlier-signup-yes';
SELECT throws_ok($$SELECT public.claim_voice_action('40000000-0000-4000-a078-000000000003',(SELECT id FROM public.voice_actions WHERE session_id='40000000-0000-4000-a078-000000000003'),ARRAY['readback'],ARRAY['earlier-signup-yes'])$$,'P0001','confirmation evidence out of order','earlier signup permission cannot confirm a later contact readback');

SELECT pg_temp.caller_fragment('40000000-0000-4000-a078-000000000004','initial-yes','Yes, please.',500,600);
-- This fragment arrived after the model selected the initial yes, before claim.
SELECT pg_temp.caller_fragment('40000000-0000-4000-a078-000000000004','late-correction','Actually, use a different email.',600,850);
SELECT throws_ok($$SELECT public.claim_voice_action('40000000-0000-4000-a078-000000000004',(SELECT id FROM public.voice_actions WHERE session_id='40000000-0000-4000-a078-000000000004'),ARRAY['readback'],ARRAY['initial-yes'])$$,'P0001','confirmation evidence incomplete','a correction arriving before claim blocks stale confirmation');
SELECT is((SELECT status FROM public.voice_actions WHERE session_id='40000000-0000-4000-a078-000000000004'),'awaiting_confirmation','late correction leaves the action unexecuted');

SELECT throws_ok($$SELECT public.claim_voice_action('40000000-0000-4000-a078-000000000005',(SELECT id FROM public.voice_actions WHERE session_id='40000000-0000-4000-a078-000000000005'),ARRAY['readback'],ARRAY['yes-1','yes-2','yes-3'])$$,'P0001','confirmation evidence out of order','another call cannot supply confirmation fragments');
SELECT throws_ok($$SELECT public.claim_voice_action('40000000-0000-4000-a078-000000000005',(SELECT id FROM public.voice_actions WHERE session_id='40000000-0000-4000-a078-000000000001'),ARRAY['readback'],ARRAY['yes-1','yes-2','yes-3'])$$,'P0001','voice action missing','another call cannot supply the action itself');
SELECT ok(NOT has_function_privilege('authenticated','public.claim_voice_action(uuid,uuid,text[],text[])','EXECUTE'),'customer cannot bypass the backend confirmation boundary');
SELECT ok(NOT has_function_privilege('anon','public.claim_voice_action(uuid,uuid,text[],text[])','EXECUTE'),'anonymous caller cannot invoke action confirmation');
SELECT ok(has_function_privilege('service_role','public.claim_voice_action(uuid,uuid,text[],text[])','EXECUTE'),'backend keeps its existing confirmation permission');

SELECT * FROM finish();
ROLLBACK;
