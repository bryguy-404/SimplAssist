BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();

CREATE TEMP TABLE inbox_fixture(label text, business_id uuid, owner_id uuid, contact_id uuid, conversation_id uuid, message_id uuid, session_id uuid);
CREATE FUNCTION pg_temp.inbox_fixture() RETURNS void LANGUAGE plpgsql AS $$
DECLARE b uuid:=gen_random_uuid(); owner uuid:=gen_random_uuid(); other_b uuid:=gen_random_uuid(); other_owner uuid:=gen_random_uuid();
  contact uuid; conv uuid; msg uuid; session uuid; period uuid; label text; chan text;
BEGIN
  INSERT INTO auth.users(id,email) VALUES(owner,owner||'@example.test'),(other_owner,other_owner||'@example.test');
  INSERT INTO public.businesses(id,owner_id,name,business_type,slug)
    VALUES(b,owner,'Inbox fixture','general','inbox-'||b),(other_b,other_owner,'Other inbox','general','inbox-'||other_b);
  FOREACH label IN ARRAY ARRAY['sms','chat','voice','active','booked','foreign'] LOOP
    chan:=CASE WHEN label='chat' THEN 'web_chat' WHEN label IN ('voice','active','booked') THEN 'voice' ELSE 'sms' END;
    INSERT INTO public.contacts(business_id,name,source_channel)
      VALUES(CASE WHEN label='foreign' THEN other_b ELSE b END,label,chan) RETURNING id INTO contact;
    INSERT INTO public.conversations(business_id,contact_id,channel,status)
      VALUES(CASE WHEN label='foreign' THEN other_b ELSE b END,contact,chan,CASE WHEN label='active' THEN 'active' ELSE 'closed' END) RETURNING id INTO conv;
    INSERT INTO public.messages(business_id,conversation_id,role,channel,content)
      VALUES(CASE WHEN label='foreign' THEN other_b ELSE b END,conv,'customer',chan,'Fixture message') RETURNING id INTO msg;
    session:=NULL;
    IF chan='voice' THEN
      INSERT INTO public.voice_sessions(business_id,conversation_id,call_control_id,call_session_id,caller_phone,called_phone,response_mode,status)
        VALUES(b,conv,'inbox-'||conv,'inbox-session-'||conv,'+12125550100','+12125550101','voice',CASE WHEN label='active' THEN 'active' ELSE 'closed' END) RETURNING id INTO session;
    END IF;
    INSERT INTO inbox_fixture VALUES(label,CASE WHEN label='foreign' THEN other_b ELSE b END,CASE WHEN label='foreign' THEN other_owner ELSE owner END,contact,conv,msg,session);
    IF label='voice' THEN
      INSERT INTO public.voice_allowance_periods(id,business_id,subscription_id,period_start,period_end,included_seconds,grant_effective_at)
        VALUES(gen_random_uuid(),b,'sub_inbox_'||b,now()-interval '1 day',now()+interval '29 days',6000,now()-interval '1 day') RETURNING id INTO period;
      INSERT INTO public.voice_customer_usage(call_key,call_identity_hash,business_id,session_id,period_id,reserved_seconds,settled_seconds,state,settled_at)
        VALUES(session,encode(extensions.digest(session::text,'sha256'),'hex'),b,session,period,60,23,'settled',now());
      INSERT INTO public.voice_recordings(recording_id,session_id,business_id,delete_after)
        VALUES('inbox-recording-'||session,session,b,now()+interval '30 days');
    END IF;
    IF label='booked' THEN
      INSERT INTO public.calendar_bookings(business_id,contact_id,conversation_id,source_message_id,google_calendar_id,event_summary,request_fingerprint,status,starts_at,ends_at,operation_claim_token,operation_claimed_at)
        VALUES(b,contact,conv,msg,'primary','Keep this appointment',repeat('a',64),'pending',now()+interval '1 day',now()+interval '1 day 30 minutes',gen_random_uuid(),now());
    END IF;
  END LOOP;
END $$;
SELECT pg_temp.inbox_fixture();
GRANT SELECT ON inbox_fixture TO service_role, authenticated;

SELECT ok(NOT has_function_privilege('anon','public.delete_inbox_conversations(uuid,uuid,uuid[])','EXECUTE'),'anonymous cannot delete via RPC');
SELECT ok(NOT has_function_privilege('authenticated','public.delete_inbox_conversations(uuid,uuid,uuid[])','EXECUTE'),'browser cannot bypass API channel checks');
SELECT ok(has_function_privilege('service_role','public.delete_inbox_conversations(uuid,uuid,uuid[])','EXECUTE'),'authorized server can call RPC');
SELECT ok(NOT (SELECT prosecdef FROM pg_proc WHERE oid='public.delete_inbox_conversations(uuid,uuid,uuid[])'::regprocedure),'RPC does not elevate its invoker');

SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT public.delete_inbox_conversations(business_id,gen_random_uuid(),ARRAY[conversation_id]) FROM inbox_fixture WHERE label='sms'$$,'42501','conversation_access_denied','RPC verifies owner again');
SELECT throws_ok($$SELECT public.delete_inbox_conversations(business_id,owner_id,ARRAY[]::uuid[]) FROM inbox_fixture WHERE label='sms'$$,'22023','invalid_conversation_selection','empty selection is rejected');
SELECT throws_ok($$SELECT public.delete_inbox_conversations(business_id,owner_id,array_fill(conversation_id,ARRAY[101])) FROM inbox_fixture WHERE label='sms'$$,'22023','invalid_conversation_selection','batch size is bounded');
SELECT throws_ok($$SELECT public.delete_inbox_conversations(business_id,owner_id,ARRAY[conversation_id,NULL]) FROM inbox_fixture WHERE label='sms'$$,'22023','invalid_conversation_selection','null ID is rejected');
SELECT throws_ok($$SELECT public.delete_inbox_conversations(business_id,owner_id,ARRAY[conversation_id,(SELECT conversation_id FROM inbox_fixture WHERE label='foreign')]) FROM inbox_fixture WHERE label='sms'$$,'P0001','conversation_selection_changed','foreign ID rejects entire selection');
SELECT throws_ok($$SELECT public.delete_inbox_conversations(business_id,owner_id,ARRAY[conversation_id,(SELECT conversation_id FROM inbox_fixture WHERE label='active')]) FROM inbox_fixture WHERE label='sms'$$,'P0001','conversation_call_in_progress','active voice rejects entire selection');
SELECT throws_ok($$SELECT public.delete_inbox_conversations(business_id,owner_id,ARRAY[conversation_id,(SELECT conversation_id FROM inbox_fixture WHERE label='booked')]) FROM inbox_fixture WHERE label='sms'$$,'P0001','conversation_has_appointments','booked call rejects entire selection');
SELECT is((SELECT count(*)::integer FROM public.conversations WHERE id IN (SELECT conversation_id FROM inbox_fixture)),6,'all rejected batches leave every row intact');
SELECT lives_ok($$SELECT public.delete_inbox_conversations(business_id,owner_id,(SELECT array_agg(conversation_id) FROM inbox_fixture WHERE label IN ('sms','chat','voice'))) FROM inbox_fixture WHERE label='sms'$$,'mixed selection deletes successfully');
RESET ROLE;

SELECT is((SELECT count(*)::integer FROM public.conversations WHERE id IN (SELECT conversation_id FROM inbox_fixture WHERE label IN ('sms','chat','voice'))),0,'selected rows are removed');
SELECT is((SELECT count(*)::integer FROM public.messages WHERE id IN (SELECT message_id FROM inbox_fixture WHERE label IN ('sms','chat','voice'))),0,'their messages are removed');
SELECT is((SELECT count(*)::integer FROM public.conversations WHERE id IN (SELECT conversation_id FROM inbox_fixture WHERE label IN ('active','booked','foreign'))),3,'unselected and foreign rows survive');
SELECT is((SELECT count(*)::integer FROM public.contacts WHERE id IN (SELECT contact_id FROM inbox_fixture)),6,'contacts survive');
SELECT is((SELECT count(*)::integer FROM public.calendar_bookings WHERE conversation_id=(SELECT conversation_id FROM inbox_fixture WHERE label='booked')),1,'appointment survives');
SELECT ok((SELECT conversation_id IS NULL AND action_conversation_id IS NULL FROM public.voice_sessions WHERE id=(SELECT session_id FROM inbox_fixture WHERE label='voice')),'completed session survives without deleted inbox links');
SELECT is((SELECT settled_seconds FROM public.voice_customer_usage WHERE session_id=(SELECT session_id FROM inbox_fixture WHERE label='voice')),23::numeric,'settled usage remains unchanged');
SELECT ok((SELECT delete_after>now() AND deleted_at IS NULL FROM public.voice_recordings WHERE session_id=(SELECT session_id FROM inbox_fixture WHERE label='voice')),'recording keeps normal retention');
SELECT * FROM finish();
ROLLBACK;
