BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();
INSERT INTO auth.users(id,email) VALUES ('00000000-0000-4000-a080-000000000001','voice-dashboard@example.test'),('00000000-0000-4000-a080-000000000002','other-dashboard@example.test');
INSERT INTO public.businesses(id,owner_id,name,business_type,slug) VALUES
 ('ea848911-ef72-44a6-8cf3-c47b3959be26','00000000-0000-4000-a080-000000000001','Dashboard','general','voice-dashboard-080'),
 ('10000000-0000-4000-a080-000000000002','00000000-0000-4000-a080-000000000002','Other','general','other-dashboard-080');
INSERT INTO public.billing_usage_periods(id,business_id,period_start,period_end,plan) VALUES
 ('90000000-0000-4000-a080-000000000001','ea848911-ef72-44a6-8cf3-c47b3959be26','2026-09-01Z','2026-10-01Z','sms_and_chat');
CREATE TEMP TABLE cases(n integer PRIMARY KEY,action_id uuid,session_id uuid,call_id uuid,contact_id uuid,source_id uuid,sms_id uuid);
CREATE FUNCTION pg_temp.fixture(n integer,historical boolean DEFAULT false) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE c uuid; conv uuid; s uuid; source uuid; a uuid; sms uuid; result jsonb;
BEGIN
  INSERT INTO public.contacts(business_id,phone_number,source_channel) VALUES('ea848911-ef72-44a6-8cf3-c47b3959be26','+1555555'||lpad(n::text,4,'0'),'voice') RETURNING id INTO c;
  INSERT INTO public.conversations(business_id,contact_id,channel) VALUES('ea848911-ef72-44a6-8cf3-c47b3959be26',c,'voice') RETURNING id INTO conv;
  INSERT INTO public.voice_sessions(business_id,conversation_id,call_control_id,call_session_id,caller_phone,called_phone,response_mode,status)
    VALUES('ea848911-ef72-44a6-8cf3-c47b3959be26',conv,'080-control-'||n,'080-session-'||n,'+1555555'||lpad(n::text,4,'0'),'+15742638634','voice','closed') RETURNING id INTO s;
  INSERT INTO public.messages(business_id,conversation_id,role,channel,content,created_at)
    VALUES('ea848911-ef72-44a6-8cf3-c47b3959be26',conv,'customer','voice','Yes, please.','2026-09-16T03:59:00Z') RETURNING id INTO source;
  result:=jsonb_build_object('providerMessageId','080-provider-'||n,'smsBody','Here is the signup link.','deliveryStatus',CASE WHEN historical THEN 'delivered' ELSE 'accepted' END);
  INSERT INTO public.voice_actions(session_id,business_id,kind,fingerprint,revision,status,payload,readback,request_event_ids,
      confirmed_at,source_message_id,result,sms_provider_message_id,sms_accepted_at,sms_logged_at)
    VALUES(s,'ea848911-ef72-44a6-8cf3-c47b3959be26','signup',repeat('a',64),1,'succeeded','{"kind":"signup","approvedUrl":"https://example.test/join"}',
      'May I text the link?',ARRAY['request'],'2026-09-16T03:59:00Z',source,result,
      CASE WHEN historical THEN NULL ELSE '080-provider-'||n END,CASE WHEN historical THEN NULL ELSE '2026-09-16T04:00:00Z'::timestamptz END,
      CASE WHEN historical THEN '2026-09-16T04:00:01Z'::timestamptz ELSE NULL END) RETURNING id INTO a;
  IF historical THEN
    INSERT INTO public.conversations(business_id,contact_id,channel,status,last_message_at)
      VALUES('ea848911-ef72-44a6-8cf3-c47b3959be26',c,'sms','closed','2026-09-16T05:00:00Z') RETURNING id INTO sms;
    INSERT INTO public.messages(id,business_id,conversation_id,role,channel,content,created_at)
      VALUES(a,'ea848911-ef72-44a6-8cf3-c47b3959be26',sms,'assistant','sms','Here is the signup link.','2026-09-16T04:00:00Z');
    INSERT INTO public.billing_usage_events(business_id,usage_period_id,idempotency_key,direction,channel,source,sms_parts,provider_message_id)
      VALUES('ea848911-ef72-44a6-8cf3-c47b3959be26','90000000-0000-4000-a080-000000000001','voice-followup:'||a::text,'outbound','sms','voice_followup_sms',1,'080-provider-'||n);
  END IF;
  INSERT INTO cases VALUES(n,a,s,conv,c,source,sms);
  RETURN a;
END $$;
SELECT pg_temp.fixture(i) FROM generate_series(1,16) i;
SELECT pg_temp.fixture(i,true) FROM generate_series(21,31) i;

SELECT ok(NOT has_function_privilege('anon','public.finalize_voice_signup_bookkeeping(uuid,timestamptz)','EXECUTE'),'anonymous cannot finalize');
SELECT ok(NOT has_function_privilege('authenticated','public.finalize_voice_signup_bookkeeping(uuid,timestamptz)','EXECUTE'),'owners cannot manufacture leads');
SELECT ok(has_function_privilege('service_role','public.finalize_voice_signup_bookkeeping(uuid,timestamptz)','EXECUTE'),'backend can finalize');
SELECT ok(NOT has_table_privilege('authenticated','public.goal_events','INSERT'),'owner lead ledger remains read-only');

CREATE TEMP TABLE first_result AS SELECT * FROM public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=1));
SELECT ok((SELECT created_event FROM first_result),'first acceptance creates a lead');
SELECT is((SELECT occurred_at FROM first_result),'2026-09-16T04:00:00Z'::timestamptz,'lead date uses provider acceptance');
SELECT is((SELECT channel FROM public.goal_events WHERE id=(SELECT goal_event_id FROM first_result)),'sms','delivery remains SMS');
SELECT is((SELECT source_conversation_id FROM public.goal_events WHERE id=(SELECT goal_event_id FROM first_result)),(SELECT call_id FROM cases WHERE n=1),'source is the real voice call');
SELECT is((SELECT source_message_id FROM public.goal_events WHERE id=(SELECT goal_event_id FROM first_result)),(SELECT source_id FROM cases WHERE n=1),'source is real caller confirmation');
SELECT is((SELECT time_source FROM public.goal_events WHERE id=(SELECT goal_event_id FROM first_result)),'provider_accepted','acceptance provenance explicit');
SELECT ok((SELECT goal_event_recorded_at IS NOT NULL AND sms_logged_at IS NULL FROM public.voice_actions WHERE id=(SELECT action_id FROM cases WHERE n=1)),'lead completion does not pretend SMS usage has been metered');
SELECT is((SELECT count(*)::integer FROM public.billing_usage_events),11,'finalization cannot bill usage');
SELECT ok(NOT (SELECT created_event FROM public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=1))),'retry reports existing event');
SELECT is((SELECT count(*)::integer FROM public.goal_events),1,'retry cannot duplicate a lead');
SELECT is((SELECT count(*)::integer FROM public.messages WHERE id=(SELECT action_id FROM cases WHERE n=1)),1,'retry cannot duplicate a text');

-- Closed original thread must win over a newer open thread.
INSERT INTO public.conversations(business_id,contact_id,channel,last_message_at)
 SELECT 'ea848911-ef72-44a6-8cf3-c47b3959be26',contact_id,'sms','2026-09-17T10:00:00Z' FROM cases WHERE n=21;
SELECT throws_ok($$SELECT public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=21))$$,'P0001','voice signup historical evidence missing','legacy timestamp cannot silently become recovery time');
CREATE TEMP TABLE historical_result AS SELECT * FROM public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=21),'2026-09-16T04:00:00Z');
SELECT is((SELECT conversation_id FROM historical_result),(SELECT sms_id FROM cases WHERE n=21),'historical message stays on its original closed SMS thread');
SELECT is((SELECT last_message_at FROM public.conversations WHERE id=(SELECT sms_id FROM cases WHERE n=21)),'2026-09-16T05:00:00Z'::timestamptz,'recovery never moves activity backwards');
SELECT is((SELECT time_source FROM public.goal_events WHERE id=(SELECT goal_event_id FROM historical_result)),'message_recorded','legacy message timestamp is labelled honestly');
SELECT ok((SELECT sms_accepted_at IS NULL AND sms_provider_message_id='080-provider-21' FROM public.voice_actions WHERE id=(SELECT action_id FROM cases WHERE n=21)),'historical restoration does not fabricate acceptance time');
SELECT ok(NOT (SELECT created_event FROM public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=21),'2026-09-16T04:00:00Z')),'historical repeat inserts nothing');
SELECT is((SELECT count(*)::integer FROM public.billing_usage_events),11,'historical restore does not rebill');
SELECT throws_ok($$SELECT public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=21),now())$$,'P0001','voice signup event collision','historical retry cannot change event time');
SELECT throws_ok($$SELECT public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=1),'2026-09-16T04:00:00Z')$$,'P0001','voice signup event collision','current acceptance replay cannot masquerade as a historical restoration');
SELECT is((SELECT count(*)::integer FROM public.goal_events WHERE (occurred_at AT TIME ZONE 'America/Indiana/Indianapolis')::date='2026-09-16'),2,'counts retain business-local original date');

SELECT throws_ok($$UPDATE public.voice_actions SET sms_provider_message_id='changed',result=jsonb_set(result,'{providerMessageId}','"changed"') WHERE id=(SELECT action_id FROM cases WHERE n=1)$$,'55000','accepted voice signup identity is immutable','provider acceptance cannot be repointed');
SELECT throws_ok($$UPDATE public.voice_actions SET sms_accepted_at=now() WHERE id=(SELECT action_id FROM cases WHERE n=1)$$,'55000','accepted voice signup identity is immutable','acceptance time immutable');
SELECT throws_ok($$UPDATE public.voice_actions SET source_message_id=(SELECT source_id FROM cases WHERE n=2) WHERE id=(SELECT action_id FROM cases WHERE n=1)$$,'55000','accepted voice signup identity is immutable','confirmation reference cannot be repointed');
SELECT throws_ok($$UPDATE public.goal_events SET source_conversation_id=(SELECT call_id FROM cases WHERE n=2) WHERE id=(SELECT goal_event_id FROM first_result)$$,'55000','goal event history is immutable; retained linkages may only be cleared','event call provenance immutable');
SELECT throws_ok($$UPDATE public.conversations SET contact_id=(SELECT contact_id FROM cases WHERE n=2) WHERE id=(SELECT call_id FROM cases WHERE n=1)$$,'23514','conversation linkage is immutable while goal events exist','call contact cannot drift after event');
SELECT throws_ok($$UPDATE public.messages SET conversation_id=(SELECT call_id FROM cases WHERE n=2) WHERE id=(SELECT source_id FROM cases WHERE n=1)$$,'23514','message linkage is immutable while goal events exist','voice source message cannot drift');
UPDATE public.messages SET content='Contradictory log' WHERE id=(SELECT action_id FROM cases WHERE n=1);
SELECT throws_ok($$SELECT public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=1))$$,'P0001','voice signup message collision','replay verifies existing message content');
UPDATE public.messages SET content='Here is the signup link.' WHERE id=(SELECT action_id FROM cases WHERE n=1);

UPDATE public.voice_actions SET status='uncertain' WHERE id=(SELECT action_id FROM cases WHERE n=2);
SELECT throws_ok($$SELECT public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=2))$$,'P0001','voice signup is not an accepted confirmed business action','uncertain send is not a completed lead');
UPDATE public.voice_actions SET confirmed_at=NULL WHERE id=(SELECT action_id FROM cases WHERE n=22);
SELECT throws_ok($$SELECT public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=22),'2026-09-16T04:00:00Z')$$,'P0001','voice signup is not an accepted confirmed business action','missing confirmation cannot be restored');
UPDATE public.voice_actions SET result=jsonb_set(result,'{deliveryStatus}','"delivery_failed"') WHERE id=(SELECT action_id FROM cases WHERE n=23);
SELECT throws_ok($$SELECT public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=23),'2026-09-16T04:00:00Z')$$,'P0001','voice signup historical evidence missing','historical manifest must be delivered');
SELECT throws_ok($$SELECT public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=24),now())$$,'P0001','voice signup historical evidence missing','historical date must match original message');
DELETE FROM public.billing_usage_events WHERE idempotency_key='voice-followup:'||(SELECT action_id FROM cases WHERE n=25)::text;
SELECT throws_ok($$SELECT public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=25),'2026-09-16T04:00:00Z')$$,'P0001','voice signup historical evidence missing','historical provider acceptance needs independent ledger evidence');
UPDATE public.messages SET content='Wrong body' WHERE id=(SELECT action_id FROM cases WHERE n=26);
SELECT throws_ok($$SELECT public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=26),'2026-09-16T04:00:00Z')$$,'P0001','voice signup message collision','existing UUID with wrong body rejected');
UPDATE public.messages SET role='customer' WHERE id=(SELECT action_id FROM cases WHERE n=27);
SELECT throws_ok($$SELECT public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=27),'2026-09-16T04:00:00Z')$$,'P0001','voice signup message collision','existing UUID with wrong role rejected');
UPDATE public.voice_actions SET source_message_id=(SELECT source_id FROM cases WHERE n=29) WHERE id=(SELECT action_id FROM cases WHERE n=28);
SELECT throws_ok($$SELECT public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=28),'2026-09-16T04:00:00Z')$$,'P0001','voice signup confirmation missing','another calls confirmation rejected');
UPDATE public.voice_actions SET business_id='10000000-0000-4000-a080-000000000002' WHERE id=(SELECT action_id FROM cases WHERE n=29);
SELECT throws_ok($$SELECT public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=29),'2026-09-16T04:00:00Z')$$,'P0001','voice signup is not an accepted confirmed business action','foreign business action rejected');
UPDATE public.voice_actions SET result=jsonb_set(result,'{providerMessageId}','"080-provider-24"') WHERE id=(SELECT action_id FROM cases WHERE n=30);
SELECT throws_ok($$SELECT public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=30),'2026-09-16T04:00:00Z')$$,'P0001','voice signup provider identity reused','legacy duplicate provider identity rejected');
UPDATE public.messages SET business_id='10000000-0000-4000-a080-000000000002' WHERE id=(SELECT action_id FROM cases WHERE n=31);
SELECT throws_ok($$SELECT public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=31),'2026-09-16T04:00:00Z')$$,'P0001','voice signup message collision','foreign tenant outbound message rejected');

INSERT INTO public.voice_pilot_settings(business_id,demo_business_id,demo_calendar_id)
 VALUES('ea848911-ef72-44a6-8cf3-c47b3959be26','10000000-0000-4000-a080-000000000002','dedicated-test-calendar');
INSERT INTO public.voice_pilot_testers(business_id,phone_number,test_mode)
 VALUES('ea848911-ef72-44a6-8cf3-c47b3959be26','+15555550017','booking_demo');
SELECT pg_temp.fixture(17);
SELECT throws_ok($$SELECT public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=17))$$,'P0001','voice signup is not an accepted confirmed business action','booking demo cannot manufacture real signup leads');

-- A current accepted send remains a sent lead even if delivery subsequently fails.
UPDATE public.voice_actions SET result=jsonb_set(result,'{deliveryStatus}','"delivery_failed"') WHERE id=(SELECT action_id FROM cases WHERE n=3);
SELECT lives_ok($$SELECT public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=3))$$,'provider acceptance and delivery failure are separate facts');

-- Tombstone linkage without replaying erased records.
SELECT public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=4));
DELETE FROM public.messages WHERE id=(SELECT action_id FROM cases WHERE n=4);
SELECT ok(NOT (SELECT created_event FROM public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=4))),'retry keeps tombstoned event');
SELECT is((SELECT count(*)::integer FROM public.messages WHERE id=(SELECT action_id FROM cases WHERE n=4)),0,'deleted outbound text never resurrected');
SELECT public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=5));
DELETE FROM public.conversations WHERE id=(SELECT call_id FROM cases WHERE n=5);
SELECT ok((SELECT source_message_id IS NULL AND source_conversation_id IS NULL AND voice_action_id IS NULL
 FROM public.goal_events WHERE idempotency_key='voice-signup:'||(SELECT action_id FROM cases WHERE n=5)::text),'deleted source call clears all call navigation');
SELECT ok(NOT (SELECT created_event FROM public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=5))),'deleted call cannot be reattached');
DELETE FROM public.conversations WHERE id=(SELECT call_id FROM cases WHERE n=6);
SELECT throws_ok($$SELECT public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=6))$$,'P0001','voice signup is not an accepted confirmed business action','deleted confirmation cannot create a new lead');
SELECT public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=7));
DELETE FROM public.contacts WHERE id=(SELECT contact_id FROM cases WHERE n=7);
SELECT ok((SELECT contact_id IS NULL AND conversation_id IS NULL AND source_message_id IS NULL AND assistant_message_id IS NULL
 AND source_conversation_id IS NULL AND voice_action_id IS NULL FROM public.goal_events WHERE idempotency_key='voice-signup:'||(SELECT action_id FROM cases WHERE n=7)::text),'contact deletion clears every customer navigation link');
SELECT ok(NOT (SELECT created_event FROM public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=7))),'contact deletion cannot recreate a contact or SMS');
SELECT public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=8));
DELETE FROM public.voice_sessions WHERE id=(SELECT session_id FROM cases WHERE n=8);
SELECT ok((SELECT voice_action_id IS NULL AND source_conversation_id IS NULL AND source_message_id IS NULL FROM public.goal_events
 WHERE idempotency_key='voice-signup:'||(SELECT action_id FROM cases WHERE n=8)::text),'session deletion unlinks action provenance');
SELECT throws_ok($$SELECT public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=8))$$,'P0001','voice signup action missing','deleted action cannot recover');
SELECT public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=9));
DELETE FROM public.conversations WHERE id=(SELECT conversation_id FROM public.goal_events WHERE voice_action_id=(SELECT action_id FROM cases WHERE n=9));
SELECT ok((SELECT conversation_id IS NULL AND assistant_message_id IS NULL AND source_conversation_id IS NOT NULL FROM public.goal_events
 WHERE voice_action_id=(SELECT action_id FROM cases WHERE n=9)),'SMS deletion retains genuine separate call history');
SELECT ok(NOT (SELECT created_event FROM public.finalize_voice_signup_bookkeeping((SELECT action_id FROM cases WHERE n=9))),'deleted SMS conversation cannot be recreated');

-- Direct ledger writes must obey the same narrow cross-channel relationship.
SELECT throws_ok($$INSERT INTO public.goal_events(business_id,contact_id,conversation_id,source_message_id,assistant_message_id,goal_at_event,event_type,channel,occurred_at,idempotency_key,
 origin_kind,voice_action_id,source_conversation_id,time_source)
 SELECT business_id,contact_id,conversation_id,(SELECT source_id FROM cases WHERE n=10),assistant_message_id,goal_at_event,event_type,channel,occurred_at,'bad-source',
 origin_kind,voice_action_id,source_conversation_id,time_source FROM public.goal_events WHERE id=(SELECT goal_event_id FROM first_result)$$,
 '23514','goal event voice action mismatch','direct insert cannot attach another calls confirmation');
SELECT throws_ok($$INSERT INTO public.goal_events(business_id,contact_id,conversation_id,source_message_id,assistant_message_id,goal_at_event,event_type,channel,occurred_at,idempotency_key)
 SELECT business_id,contact_id,conversation_id,source_message_id,assistant_message_id,goal_at_event,event_type,channel,occurred_at,'pretend-sms'
 FROM public.goal_events WHERE id=(SELECT goal_event_id FROM first_result)$$,
 '23514','goal event source message tenant mismatch','legacy SMS path cannot pretend voice confirmation was SMS');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-a080-000000000002',true);
SELECT is((SELECT count(*)::integer FROM public.goal_events),0,'other owner cannot read voice-origin leads');
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-a080-000000000001',true);
SELECT ok((SELECT count(*) FROM public.goal_events)>0,'business owner can read history');
RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
