BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();

CREATE TEMP TABLE ids AS SELECT gen_random_uuid() AS b,gen_random_uuid() AS owner,gen_random_uuid() AS contact,
  gen_random_uuid() AS period,gen_random_uuid() AS sms,gen_random_uuid() AS voice,gen_random_uuid() AS other,
  gen_random_uuid() AS chat,gen_random_uuid() AS vm,gen_random_uuid() AS legacy,gen_random_uuid() AS flagged;
INSERT INTO auth.users(id,email) SELECT owner,owner||'@example.test' FROM ids;
INSERT INTO businesses(id,owner_id,name,business_type,slug) SELECT b,owner,'Inbox folders','general','folders-'||b FROM ids;
INSERT INTO contacts(id,business_id,name,phone_number,source_channel) SELECT contact,b,'7-11 Market','+15745550711','sms' FROM ids;
INSERT INTO billing_usage_periods(id,business_id,period_start,period_end,plan,included_sms_parts)
  SELECT period,b,date_trunc('month',now()),date_trunc('month',now())+interval '1 month','sms_and_chat',100 FROM ids;
INSERT INTO conversations(id,business_id,contact_id,channel,status,last_message_at)
  SELECT x.id,b,contact,x.channel,'closed',now() FROM ids CROSS JOIN LATERAL
  (VALUES(sms,'sms'),(voice,'voice'),(other,'voice'),(chat,'web_chat'),(vm,'sms'),(legacy,'sms'),(flagged,'voice')) x(id,channel);
INSERT INTO voice_sessions(business_id,conversation_id,call_control_id,call_session_id,caller_phone,called_phone,response_mode,status,outcome,inbox_reply_state)
  SELECT b,x.id,'ctrl-'||x.id,'sess-'||x.id,'+15745550711','+15745550712','voice','closed',x.outcome,x.state FROM ids
  CROSS JOIN LATERAL (VALUES(voice,'caller_abandoned',NULL::text),(other,'caller_hangup',NULL::text),(flagged,'caller_hangup','silent')) x(id,outcome,state);
UPDATE conversations SET spam_state='suspected' WHERE id=(SELECT flagged FROM ids);
INSERT INTO tenant_sms_sends(business_id,usage_period_id,idempotency_key,fingerprint,purpose,messaging_profile_id,sender,destination,sms_parts,
  status,provider_message_id,conversation_id,inbox_call_origin)
  SELECT b,period,'missed-call:'||x.key,'fingerprint','missed_call','profile','+15745550712','+15745550711',1,'accepted','msg-'||x.key,x.id,x.origin
  FROM ids CROSS JOIN LATERAL (VALUES(sms,'sess-'||voice,'missed'),(sms,'another-call','missed'),(vm,'voicemail','voicemail'),(legacy,'legacy',NULL::text)) x(id,key,origin);
INSERT INTO widget_configs(business_id,welcome_message,is_active) SELECT b,'Welcome!',false FROM ids
  ON CONFLICT (business_id) DO UPDATE SET welcome_message=excluded.welcome_message;
INSERT INTO messages(business_id,conversation_id,role,content,channel) SELECT b,chat,'assistant','Welcome!','web_chat' FROM ids;
CREATE FUNCTION pg_temp.page(folder text, term text DEFAULT '', digits text DEFAULT NULL, focus uuid DEFAULT NULL, ch text DEFAULT 'all',
  cursor_time timestamptz DEFAULT NULL, cursor_id uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.read_conversation_folder_page(b,owner,folder,ch,term,digits,cursor_time,cursor_id,focus) FROM ids
$$;
CREATE FUNCTION pg_temp.folder_for(row_id uuid) RETURNS text LANGUAGE sql AS $$
  SELECT r.folder FROM ids CROSS JOIN LATERAL public.inbox_activity_rows(b) r WHERE conversation_id=row_id
$$;
SELECT is(pg_temp.page('no_reply')->'counts','{"inbox":3,"no_reply":2,"spam":1}'::jsonb,'folder counts include each displayed item once');
SELECT is((pg_temp.page('no_reply','7-11','711')->>'total')::int,2,'literal names and phone digits do not double count');
SELECT is((pg_temp.page('no_reply','','',NULL,'voice')->>'total')::int,1,'a grouped call remains discoverable with the voice filter');
SELECT is(pg_temp.page('inbox','',NULL,(SELECT voice FROM ids))->>'folder','no_reply','original call deep link opens its current folder');
SELECT is(pg_temp.page('inbox','',NULL,(SELECT voice FROM ids))#>>'{selected,id}',(SELECT voice::text FROM ids),'call details keep their original ID');
SELECT is(pg_temp.page('inbox','',NULL,(SELECT voice FROM ids))#>>'{selected,inbox_item_id}',(SELECT sms::text FROM ids),'call links back to its exact text thread');
SELECT is(jsonb_array_length(pg_temp.page('inbox','',NULL,(SELECT sms FROM ids))#>'{selected,missed_calls}'),2,'repeat calls are accessible inside one text thread');
SELECT is(pg_temp.folder_for((SELECT other FROM ids)),'inbox','same number and missing transcript do not identify a matching call');
SELECT is(pg_temp.folder_for((SELECT vm FROM ids)),'inbox','a saved voicemail stays visible without a text reply');
SELECT is(pg_temp.folder_for((SELECT legacy FROM ids)),'inbox','unverified historical voicemail origin stays visible');
SELECT is(pg_temp.folder_for((SELECT flagged FROM ids)),'spam','carrier spam is independent of caller silence');
SELECT throws_ok($$SELECT public.read_conversation_folder_page(b,gen_random_uuid(),'inbox','all','',NULL,NULL,NULL,NULL) FROM ids$$,
 '42501','inbox_access_denied','fresh ownership required');
SELECT ok(NOT has_function_privilege('authenticated','public.inbox_activity_rows(uuid)','execute'),'browser cannot read business-wide evidence directly');
INSERT INTO messages(business_id,conversation_id,role,content,channel) SELECT b,chat,'assistant','Your order is ready for pickup.','web_chat' FROM ids;
SELECT is(pg_temp.folder_for((SELECT chat FROM ids)),'inbox','a saved assistant message other than the widget greeting stays visible');
DELETE FROM messages WHERE conversation_id=(SELECT chat FROM ids) AND content='Your order is ready for pickup.';
SELECT public.keep_inbox_conversation(b,owner,chat) FROM ids;
SELECT is(pg_temp.folder_for((SELECT chat FROM ids)),'inbox','manual move persists on subsequent reads');
INSERT INTO messages(business_id,conversation_id,role,content,channel) SELECT b,sms,'customer','Can I book Friday?','sms' FROM ids;
SELECT is(pg_temp.folder_for((SELECT sms FROM ids)),'inbox','first real reply promotes the group');
SELECT is(pg_temp.folder_for((SELECT voice FROM ids)),'inbox','the paired call follows the thread');
SELECT throws_ok($$SELECT public.delete_inbox_folder_items(b,owner,ARRAY[sms],'no_reply') FROM ids$$,
 'P0001','conversation_selection_changed','a stale selection cannot delete a newly engaged conversation');
INSERT INTO messages(business_id,conversation_id,role,content,channel) SELECT b,sms,'assistant','Another follow-up','sms' FROM ids;
SELECT is(pg_temp.folder_for((SELECT sms FROM ids)),'inbox','an established thread stays in Inbox after another outbound message');

UPDATE voice_sessions SET inbox_reply_state='silent' WHERE conversation_id=(SELECT other FROM ids);
SELECT is(pg_temp.folder_for((SELECT other FROM ids)),'no_reply','a closed call with verified silent input is eligible');
INSERT INTO voice_transcript_fragments(session_id,business_id,event_id,role,content,start_ms,end_ms)
  SELECT v.id,b,'late-turn','customer','Can you call me back?',100,200 FROM ids JOIN voice_sessions v ON v.conversation_id=other;
SELECT is(pg_temp.folder_for((SELECT other FROM ids)),'inbox','late caller speech overrides a silent completion');
UPDATE voice_sessions SET inbox_reply_state='silent' WHERE conversation_id=(SELECT other FROM ids);
INSERT INTO messages(business_id,conversation_id,role,content,channel) SELECT b,voice,'customer','Appointment','voice' FROM ids;
INSERT INTO calendar_bookings(business_id,contact_id,conversation_id,source_message_id,google_calendar_id,event_summary,request_fingerprint,status,starts_at,ends_at,operation_claim_token,operation_claimed_at)
  SELECT b,contact,voice,m.id,'primary','Protected',repeat('b',64),'pending',now()+interval '1 day',now()+interval '1 day 30 minutes',gen_random_uuid(),now()
  FROM ids JOIN messages m ON m.conversation_id=voice;
SELECT is((pg_temp.page('inbox','',NULL,(SELECT sms FROM ids))#>>'{selected,has_bookings}')::boolean,true,'the visible group inherits booking protection');
SELECT throws_ok($$SELECT public.delete_inbox_folder_items(b,owner,ARRAY[sms],'inbox') FROM ids$$,
 'P0001','conversation_has_appointments','bulk deletion rolls back for a booked call inside the group');
SELECT is((SELECT count(*)::int FROM conversations,ids WHERE id IN (voice,sms)),2,'both originals remain after a refused delete');

INSERT INTO conversations(business_id,contact_id,channel,status,last_message_at) SELECT b,contact,'web_chat','closed','2026-11-01 14:00:00.123456+00' FROM ids,generate_series(1,201);
CREATE TEMP TABLE pages AS SELECT pg_temp.page('inbox','7-11','711',NULL,'web_chat') AS first;
ALTER TABLE pages ADD COLUMN second jsonb;
UPDATE pages SET second=pg_temp.page('inbox','7-11','711',NULL,'web_chat',(first#>>'{next,time}')::timestamptz,(first#>>'{next,id}')::uuid);
SELECT is((SELECT (first->>'total')::int FROM pages),202,'filtered total covers all pages and uses both search terms once');
SELECT is((SELECT jsonb_array_length(first->'conversations')+jsonb_array_length(second->'conversations') FROM pages),200,'keyset paging returns two full pages');
SELECT ok(NOT EXISTS(SELECT 1 FROM pages, jsonb_array_elements(first->'conversations') a,jsonb_array_elements(second->'conversations') b WHERE a->>'id'=b->>'id'),'pages do not overlap');
-- Historical text-only records can be identified by their entire known outbound template.
INSERT INTO messages(business_id,conversation_id,role,content,channel) SELECT b,legacy,'assistant',
  E'Hi, this is Test — saw your call come in. Just reply here with what you need and we''ll get you taken care of.\n\nMsg frequency varies. Msg & data rates may apply. Reply HELP for help or STOP to opt out.','sms' FROM ids;
SELECT is(pg_temp.folder_for((SELECT legacy FROM ids)),'no_reply','known legacy text alone is an unanswered SMS');
SELECT is(pg_temp.page('inbox','',NULL,(SELECT legacy FROM ids))#>>'{selected,inbox_reason}','legacy_text','text-only evidence does not assert caller silence');
CREATE TEMP TABLE legacy_without_receipt AS SELECT gen_random_uuid() AS id;
INSERT INTO conversations(id,business_id,contact_id,channel,status) SELECT id,b,contact,'sms','closed' FROM legacy_without_receipt,ids;
INSERT INTO messages(business_id,conversation_id,role,content,channel)
  SELECT b,old_text.id,'assistant',m.content,'sms' FROM ids JOIN messages m ON m.conversation_id=legacy CROSS JOIN legacy_without_receipt old_text;
SELECT is(pg_temp.folder_for((SELECT id FROM legacy_without_receipt)),'no_reply','a template-only thread predating send receipts is still an unanswered text');
UPDATE tenant_sms_sends SET inbox_call_origin='unverified' WHERE conversation_id=(SELECT legacy FROM ids);
SELECT is(pg_temp.folder_for((SELECT legacy FROM ids)),'inbox','a new receipt waiting for voicemail evidence is visible for review');
UPDATE tenant_sms_sends SET inbox_call_origin='missed' WHERE conversation_id=(SELECT legacy FROM ids);
INSERT INTO messages(business_id,conversation_id,role,content,channel) SELECT b,legacy,'assistant','Here is the link you requested: https://example.test/book','sms' FROM ids;
SELECT is(pg_temp.folder_for((SELECT legacy FROM ids)),'inbox','a requested link is protected even without a historical goal event');

INSERT INTO tenant_sms_sends(business_id,usage_period_id,idempotency_key,fingerprint,purpose,messaging_profile_id,sender,destination,sms_parts,
  status,provider_message_id,conversation_id,inbox_call_origin)
  SELECT b,period,'missed-call:sess-'||other,'fingerprint','missed_call','profile','+15745550712','+15745550711',1,'accepted','other-provider',legacy,'missed' FROM ids;
SELECT is((SELECT count(*)::int FROM ids CROSS JOIN LATERAL public.delete_inbox_folder_items(b,owner,ARRAY[legacy],'inbox')),2,
  'confirmed group deletion removes both eligible originals');
SELECT is((SELECT count(*)::int FROM conversations,ids WHERE id IN (other,legacy)),0,'removed group does not reappear as orphaned call rows');
SELECT is((SELECT count(*)::int FROM conversations,ids WHERE id IN (sms,voice,flagged,vm)),4,'deleting one group preserves other calls from the same number');
SELECT * FROM finish();
ROLLBACK;
