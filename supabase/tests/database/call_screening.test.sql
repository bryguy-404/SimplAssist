BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();
CREATE TEMP TABLE screening_fixture(label text PRIMARY KEY,b uuid,owner uuid,phone uuid,contact uuid,conv uuid);
CREATE FUNCTION pg_temp.screening_fixture() RETURNS void LANGUAGE plpgsql AS $$
DECLARE b uuid:=gen_random_uuid(); owner uuid:=gen_random_uuid(); b2 uuid:=gen_random_uuid(); owner2 uuid:=gen_random_uuid(); phone uuid; contact uuid; conv uuid; label text; msg uuid;
BEGIN
  INSERT INTO auth.users(id,email) VALUES(owner,owner||'@example.test'),(owner2,owner2||'@example.test');
  INSERT INTO public.businesses(id,owner_id,name,business_type,slug) VALUES(b,owner,'Screening test','general','screen-'||b),(b2,owner2,'Other screen','general','screen-'||b2);
  INSERT INTO public.phone_numbers(business_id,phone_number,telnyx_phone_number_id) VALUES(b,'+12025550981','999999991') RETURNING id INTO phone;
  INSERT INTO screening_fixture VALUES('owner',b,owner,phone,NULL,NULL),('foreign',b2,owner2,NULL,NULL,NULL);
  INSERT INTO public.contacts(business_id,name,phone_number,source_channel) VALUES(b,'Real customer','+12025550982','sms') RETURNING id INTO contact;
  FOREACH label IN ARRAY ARRAY['sms','old','active','booked','legacy_delete'] LOOP
    INSERT INTO public.conversations(business_id,contact_id,channel,status,last_message_at)
      VALUES(b,contact,CASE WHEN label='sms' THEN 'sms' ELSE 'voice' END,CASE WHEN label='active' THEN 'active' ELSE 'closed' END,'2026-11-01T00:00:00Z') RETURNING id INTO conv;
    IF label<>'sms' THEN
      INSERT INTO public.voice_sessions(business_id,conversation_id,call_control_id,call_session_id,caller_phone,called_phone,response_mode,status)
        VALUES(b,conv,'screen-'||label,'session-'||label,'+12025550982','+12025550981','voice',CASE WHEN label='active' THEN 'active' ELSE 'closed' END);
    END IF;
    IF label='booked' THEN
      INSERT INTO public.messages(business_id,conversation_id,role,channel,content) VALUES(b,conv,'customer','voice','Appointment') RETURNING id INTO msg;
      INSERT INTO public.calendar_bookings(business_id,contact_id,conversation_id,source_message_id,google_calendar_id,event_summary,request_fingerprint,status,starts_at,ends_at,operation_claim_token,operation_claimed_at)
        VALUES(b,contact,conv,msg,'primary','Preserve appointment',repeat('b',64),'pending',now()+interval '1 day',now()+interval '1 day 30 minutes',gen_random_uuid(),now());
    END IF;
    INSERT INTO screening_fixture VALUES(label,b,owner,phone,contact,conv);
  END LOOP;
END $$;
SELECT pg_temp.screening_fixture();
GRANT SELECT ON screening_fixture TO service_role,authenticated;

SELECT ok(NOT has_table_privilege('authenticated','public.inbound_call_screening','SELECT'),'call evidence is server-only');
SELECT ok(NOT has_table_privilege('authenticated','public.call_screening_settings','UPDATE'),'browser cannot change provider synchronization');
SELECT ok(NOT has_function_privilege('authenticated','public.review_inbox_call_spam(uuid,uuid,uuid,text,integer)','EXECUTE'),'review RPC requires server authorization');
SELECT ok(NOT has_function_privilege('anon','public.read_inbox_page(uuid,uuid,text,text,text,timestamptz,uuid,uuid)','EXECUTE'),'inbox RPC is not public');
SELECT set_config('request.jwt.claim.sub',(SELECT owner::text FROM screening_fixture WHERE label='owner'),true);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$UPDATE public.conversations SET spam_state='spam' WHERE id=(SELECT conv FROM screening_fixture WHERE label='sms')$$,'42501','Call review is server controlled','owner cannot forge the projection');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT public.read_inbox_page(b,gen_random_uuid()) FROM screening_fixture WHERE label='owner'$$,'42501','screening_access_denied','list checks owner');
SELECT throws_ok($$SELECT public.observe_inbound_call_screening(b,'foreign','foreign','+12025550982','+12025550981','spam_likely',NULL,now()) FROM screening_fixture WHERE label='foreign'$$,'P0001','screening_number_unavailable','destination must belong to business');
SELECT public.observe_inbound_call_screening(b,'basic','basic-session','+12025550982','+12025550981','spam_likely','"spam_likely"','2026-11-02T00:00:00Z') FROM screening_fixture WHERE label='owner';
SELECT is((SELECT count(*)::int FROM public.inbound_call_screening WHERE call_control_id='basic'),1,'one captured inbound call');
SELECT is((SELECT conversation_id FROM public.inbound_call_screening WHERE call_control_id='basic'),NULL::uuid,'no invented AI session while routing');
SELECT is((SELECT public.call_followup_screening(b,'basic-session','+12025550982',true) FROM screening_fixture WHERE label='owner'),'suppressed','session lookup suppresses automatic text');
SELECT is((SELECT public.call_followup_screening(b,'basic','+12025550982',true) FROM screening_fixture WHERE label='owner'),'suppressed','control lookup suppresses automatic text');
SELECT is((SELECT public.call_followup_screening(b,'basic','+12025550983',true) FROM screening_fixture WHERE label='owner'),'unavailable','wrong caller cannot reuse evidence');
SELECT is((SELECT public.call_followup_screening(b,'missing','+12025550982',true) FROM screening_fixture WHERE label='owner'),'unavailable','new tracked calls fail closed without evidence');
SELECT is((SELECT public.call_followup_screening(b,'missing','+12025550982',false) FROM screening_fixture WHERE label='owner'),'legacy','old callbacks remain compatible');
SELECT public.finish_inbound_call_screening('basic','2026-11-02T00:00:15Z');
SELECT is((SELECT c.call_kind FROM public.conversations c JOIN public.inbound_call_screening r ON r.conversation_id=c.id WHERE r.call_control_id='basic'),'phone','flagged normal route gets basic call record');
SELECT is((SELECT c.spam_state FROM public.conversations c JOIN public.inbound_call_screening r ON r.conversation_id=c.id WHERE r.call_control_id='basic'),'suspected','carrier flag routes to suspected Spam');
SELECT is((SELECT count(*)::int FROM public.voice_sessions WHERE call_control_id='basic'),0,'basic record adds no AI session or usage');
SELECT public.observe_inbound_call_screening(b,'recovered','recovered-session','+12025550982','+12025550981','unknown',NULL,'2026-11-02T00:00:00Z') FROM screening_fixture WHERE label='owner';
SELECT public.finish_inbound_call_screening('recovered','2026-11-02T00:15:00Z',false);
SELECT is((SELECT ended_time_verified FROM public.inbound_call_screening WHERE call_control_id='recovered'),false,'status-only recovery does not claim an exact end time');
SELECT public.finish_inbound_call_screening('recovered','2026-11-02T00:00:15Z',true);
SELECT is((SELECT ended_at FROM public.inbound_call_screening WHERE call_control_id='recovered'),'2026-11-02T00:00:15Z'::timestamptz,'later signed termination improves the recovered timestamp');
SELECT public.observe_inbound_call_screening(b,'basic','basic-session','+12025550982','+12025550981','unknown',NULL,now()) FROM screening_fixture WHERE label='owner';
SELECT public.finish_inbound_call_screening('basic',now());
SELECT is((SELECT count(*)::int FROM public.conversations WHERE call_kind='phone'),1,'duplicates do not recreate call history');
SELECT is((SELECT verdict FROM public.inbound_call_screening WHERE call_control_id='basic'),'spam_likely','missing verdict cannot erase positive evidence');
SELECT is((SELECT (public.admit_voice_commercial(b,'basic','basic-session','+12025550982','+12025550981',true)).id FROM screening_fixture WHERE label='owner'),NULL::uuid,'late AI admission cannot duplicate completed basic call');
SELECT is((SELECT public.read_inbox_page(b,owner,'inbox')->'counts'->>'spam' FROM screening_fixture WHERE label='owner'),'1','folder counts include suspected calls');
SELECT is((SELECT jsonb_array_length(public.read_inbox_page(b,owner,'spam')->'conversations') FROM screening_fixture WHERE label='owner'),1,'server Spam filter returns only flagged calls');
SELECT is((SELECT public.read_inbox_page(f.b,f.owner,'inbox','all','',NULL,NULL,r.conversation_id)->>'folder' FROM screening_fixture f,public.inbound_call_screening r WHERE f.label='owner' AND r.call_control_id='basic'),'spam','owned deep link opens correct folder');
SELECT is((SELECT public.read_inbox_page(f.b,f.owner,'inbox','all','',NULL,NULL,r.conversation_id)->'selected' FROM screening_fixture f,public.inbound_call_screening r WHERE f.label='foreign' AND r.call_control_id='basic'),'null'::jsonb,'foreign deep link reveals no call');
SELECT public.review_inbox_call_spam(f.b,f.owner,r.conversation_id,'not_spam',0) FROM screening_fixture f,public.inbound_call_screening r WHERE f.label='owner' AND r.call_control_id='basic';
SELECT is((SELECT c.spam_state FROM public.conversations c JOIN public.inbound_call_screening r ON r.conversation_id=c.id WHERE r.call_control_id='basic'),'inbox','Not spam restores only this call');
SELECT is((SELECT public.call_followup_screening(b,'basic','+12025550982',true) FROM screening_fixture WHERE label='owner'),'suppressed','restoring never sends a delayed automatic text');
SELECT public.observe_inbound_call_screening(b,'basic','basic-session','+12025550982','+12025550981','spam_likely',NULL,now()) FROM screening_fixture WHERE label='owner';
SELECT is((SELECT c.spam_state FROM public.conversations c JOIN public.inbound_call_screening r ON r.conversation_id=c.id WHERE r.call_control_id='basic'),'inbox','manual review wins over later carrier callback');
SELECT throws_ok($$SELECT public.review_inbox_call_spam(f.b,f.owner,r.conversation_id,'spam',0) FROM screening_fixture f,public.inbound_call_screening r WHERE f.label='owner' AND r.call_control_id='basic'$$,'P0001','screening_revision_conflict','stale browser cannot override a newer review');
SELECT public.review_inbox_call_spam(b,owner,conv,'spam',0) FROM screening_fixture WHERE label='old';
SELECT is((SELECT c.spam_state FROM public.conversations c JOIN screening_fixture f ON f.conv=c.id WHERE f.label='old'),'spam','old call can be manually marked');
SELECT is((SELECT c.spam_state FROM public.conversations c JOIN screening_fixture f ON f.conv=c.id WHERE f.label='sms'),'inbox','separate SMS from same contact stays in Inbox');
SELECT throws_ok($$SELECT public.review_inbox_call_spam(b,owner,conv,'spam',0) FROM screening_fixture WHERE label='sms'$$,'P0001','screening_call_not_found','manual classification is call-only');
SELECT throws_ok($$SELECT public.review_inbox_call_spam(b,owner,conv,'spam',0) FROM screening_fixture WHERE label='active'$$,'P0001','screening_call_active','active call cannot be reviewed');
SELECT throws_ok($$SELECT public.reserve_tenant_sms(b,gen_random_uuid(),'missed-call:basic-session','fingerprint','missed_call','profile','+12025550981','+12025550982',1) FROM screening_fixture WHERE label='owner'$$,'P0001','sms_call_screened','database blocks automatic reservation before quota');
SELECT public.review_inbox_call_spam(b,owner,conv,'spam',0) FROM screening_fixture WHERE label='booked';
SELECT throws_ok($$SELECT public.delete_inbox_conversations(b,owner,ARRAY[conv]) FROM screening_fixture WHERE label='booked'$$,'P0001','conversation_has_appointments','marked appointments remain protected');
SELECT is((SELECT r.deleted_at FROM public.inbound_call_screening r JOIN screening_fixture f ON f.conv=r.conversation_id WHERE f.label='booked'),NULL::timestamptz,'failed deletion rolls back tombstone');
SELECT public.delete_inbox_conversations(b,owner,ARRAY[conv]) FROM screening_fixture WHERE label='legacy_delete';
SELECT ok((SELECT deleted_at IS NOT NULL AND conversation_id IS NULL FROM public.inbound_call_screening WHERE call_control_id='screen-legacy_delete'),'legacy deletion also keeps callback tombstone');
SELECT public.observe_inbound_call_screening(b,'screen-legacy_delete','session-legacy_delete','+12025550982','+12025550981','spam_likely',NULL,now()) FROM screening_fixture WHERE label='owner';
SELECT public.finish_inbound_call_screening('screen-legacy_delete',now());
SELECT is((SELECT conversation_id FROM public.inbound_call_screening WHERE call_control_id='screen-legacy_delete'),NULL::uuid,'late flagged callback cannot recreate deleted history');
SELECT public.delete_inbox_conversations(f.b,f.owner,ARRAY[r.conversation_id]) FROM screening_fixture f,public.inbound_call_screening r WHERE f.label='owner' AND r.call_control_id='basic';
SELECT is((SELECT public.call_followup_screening(b,'basic','+12025550982',true) FROM screening_fixture WHERE label='owner'),'suppressed','deleted call cannot trigger recovery text');

-- Real AI admission links to the same conversation; projection never manufactures a second AI call.
SELECT public.observe_inbound_call_screening(b,'new-ai','new-ai-session','+12025550982','+12025550981','spam_likely',NULL,now()) FROM screening_fixture WHERE label='owner';
INSERT INTO public.conversations(business_id,contact_id,channel,status) SELECT b,contact,'voice','active' FROM screening_fixture WHERE label='old';
INSERT INTO public.voice_sessions(business_id,conversation_id,call_control_id,call_session_id,caller_phone,called_phone,response_mode,status)
  SELECT b,(SELECT id FROM public.conversations WHERE business_id=f.b AND channel='voice' AND status='active' AND id<>(SELECT conv FROM screening_fixture WHERE label='active') LIMIT 1),'new-ai','new-ai-session','+12025550982','+12025550981','voice','active' FROM screening_fixture f WHERE label='owner';
SELECT is((SELECT c.call_kind||':'||c.spam_state FROM public.conversations c JOIN public.inbound_call_screening r ON r.conversation_id=c.id WHERE r.call_control_id='new-ai'),'ai:suspected','new AI session reuses existing call conversation');

-- Enough calls to exceed default API row limits; filtering happens before paging.
INSERT INTO public.conversations(business_id,contact_id,channel,status,spam_state,last_message_at)
  SELECT b,contact,'voice','closed','spam','2026-11-03T00:00:00Z' FROM screening_fixture,generate_series(1,1005) WHERE label='old';
INSERT INTO public.conversations(business_id,contact_id,channel,status,last_message_at)
  SELECT b,contact,'sms','closed','2026-11-03T00:00:00Z' FROM screening_fixture,generate_series(1,105) WHERE label='old';
SELECT is((SELECT jsonb_array_length(public.read_inbox_page(b,owner)->'conversations') FROM screening_fixture WHERE label='owner'),100,'inbox page bounded at 100 after filtering');
SELECT ok((SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(public.read_inbox_page(b,owner)->'conversations') c WHERE c->>'spam_state'<>'inbox') FROM screening_fixture WHERE label='owner'),'spam does not crowd normal inbox');
SELECT is((SELECT public.read_inbox_page(b,owner,'inbox','sms','Real customer')->>'total' FROM screening_fixture WHERE label='owner'),'106','search and channel counts cover all records');
SELECT ok((SELECT public.read_inbox_page(b,owner,'spam')->'next'<>'null'::jsonb FROM screening_fixture WHERE label='owner'),'spam page exposes next cursor');
WITH first AS (SELECT b,owner,public.read_inbox_page(b,owner,'spam') page FROM screening_fixture WHERE label='owner'), second AS (
 SELECT page,public.read_inbox_page(b,owner,'spam','all','',(page->'next'->>'time')::timestamptz,(page->'next'->>'id')::uuid) page2 FROM first)
SELECT ok(NOT EXISTS(SELECT 1 FROM second,jsonb_array_elements(page->'conversations') a,jsonb_array_elements(page2->'conversations') b WHERE a->>'id'=b->>'id'),'tied timestamps do not duplicate calls across pages');

SELECT throws_ok($$SELECT public.request_call_screening(b,gen_random_uuid(),phone,'flag_calls',0) FROM screening_fixture WHERE label='owner'$$,'42501','screening_access_denied','settings verifies current owner');
SELECT throws_ok($$SELECT public.request_call_screening(b,owner,phone,'reject_calls',0) FROM screening_fixture WHERE label='owner'$$,'P0001','screening_invalid_mode','frontend cannot request blocking');
SELECT public.request_call_screening(b,owner,phone,'flag_calls',0) FROM screening_fixture WHERE label='owner';
SELECT is((SELECT s.confirmed_mode FROM public.call_screening_settings s JOIN screening_fixture f ON f.phone=s.phone_number_id WHERE f.label='owner'),'unknown','requested does not pretend provider is on');
SELECT throws_ok($$SELECT public.request_call_screening(b,owner,phone,'disabled',0) FROM screening_fixture WHERE label='owner'$$,'P0001','screening_revision_conflict','stale settings cannot race provider updates');
SELECT throws_ok($$SELECT public.request_call_screening(b,owner,phone,'disabled',1) FROM screening_fixture WHERE label='owner'$$,'P0001','screening_sync_pending','one provider update at a time');
SELECT public.claim_call_screening_sync(phone) FROM screening_fixture WHERE label='owner';
SELECT is((SELECT (public.claim_call_screening_sync(phone)).lease_token FROM screening_fixture WHERE label='owner'),NULL::uuid,'parallel worker cannot claim active lease');
SELECT is((SELECT public.finish_call_screening_sync(phone,gen_random_uuid(),'flag_calls') FROM screening_fixture WHERE label='owner'),false,'wrong lease cannot report success');
SELECT public.finish_call_screening_sync(phone_number_id,lease_token,'unknown','screening_sync_unconfirmed') FROM public.call_screening_settings WHERE phone_number_id=(SELECT phone FROM screening_fixture WHERE label='owner');
SELECT is((SELECT sync_status FROM public.call_screening_settings WHERE phone_number_id=(SELECT phone FROM screening_fixture WHERE label='owner')),'pending','unconfirmed mutation remains pending for recovery');
UPDATE public.call_screening_settings SET attempted_at=now()-interval '2 minutes' WHERE phone_number_id=(SELECT phone FROM screening_fixture WHERE label='owner');
SELECT public.claim_call_screening_sync(phone) FROM screening_fixture WHERE label='owner';
SELECT public.finish_call_screening_sync(phone_number_id,lease_token,'flag_calls') FROM public.call_screening_settings WHERE phone_number_id=(SELECT phone FROM screening_fixture WHERE label='owner');
SELECT is((SELECT sync_status||':'||confirmed_mode FROM public.call_screening_settings WHERE phone_number_id=(SELECT phone FROM screening_fixture WHERE label='owner')),'idle:flag_calls','only verified provider mode completes setting');
SELECT public.observe_call_screening_setting(b,owner,phone,'reject_calls',1) FROM screening_fixture WHERE label='owner';
SELECT is((SELECT confirmed_mode FROM public.call_screening_settings WHERE phone_number_id=(SELECT phone FROM screening_fixture WHERE label='owner')),'reject_calls','external provider change is reported accurately');
SELECT public.request_call_screening(b,owner,phone,'disabled',1) FROM screening_fixture WHERE label='owner';
SELECT is((SELECT requested_mode FROM public.call_screening_settings WHERE phone_number_id=(SELECT phone FROM screening_fixture WHERE label='owner')),'disabled','owner can request turning screening off');
RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
