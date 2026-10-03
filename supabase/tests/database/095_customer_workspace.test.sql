BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();
INSERT INTO auth.users(id,email) VALUES
 ('00000000-0000-4000-a095-000000000001','customer-owner-a@example.test'),
 ('00000000-0000-4000-a095-000000000002','customer-owner-b@example.test');
INSERT INTO businesses(id,owner_id,name,business_type,slug,billing_mode,partner_plan) VALUES
 ('10000000-0000-4000-a095-000000000001','00000000-0000-4000-a095-000000000001','Customers A','general','customers-095-a','comped','chat_only'),
 ('10000000-0000-4000-a095-000000000002','00000000-0000-4000-a095-000000000002','Customers B','general','customers-095-b','comped','chat_only');
CREATE TEMP TABLE customer_test_ids(key text PRIMARY KEY,id uuid);
CREATE FUNCTION pg_temp.save_customer(p_values jsonb,p_id uuid DEFAULT NULL) RETURNS public.contacts LANGUAGE sql AS $$
 SELECT public.customer_workspace_save('10000000-0000-4000-a095-000000000001','00000000-0000-4000-a095-000000000001',p_id,p_values);
$$;
CREATE FUNCTION pg_temp.preview_customer(p_rows jsonb) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.customer_workspace_import_preview('10000000-0000-4000-a095-000000000001','00000000-0000-4000-a095-000000000001',p_rows);
$$;
CREATE FUNCTION pg_temp.commit_customer(p_id uuid) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.customer_workspace_import_commit('10000000-0000-4000-a095-000000000001','00000000-0000-4000-a095-000000000001',p_id);
$$;
INSERT INTO customer_test_ids VALUES('manual',(SELECT (pg_temp.save_customer('{"name":"Pat","email":"PAT@EXAMPLE.TEST","phone_number":"+15745550951","service_address":"1 Main Street","tags":["repeat"]}')).id));
SELECT is((SELECT email FROM contacts WHERE id=(SELECT id FROM customer_test_ids WHERE key='manual')),'pat@example.test','manual email is normalized');
SELECT is((SELECT customer_stage FROM contacts WHERE id=(SELECT id FROM customer_test_ids WHERE key='manual')),'customer','manual records start as customers');
SELECT is((SELECT lead_status FROM contacts WHERE id=(SELECT id FROM customer_test_ids WHERE key='manual')),'normal','manual email does not create an automatic hot lead');
SELECT is((SELECT count(*)::integer FROM lead_events WHERE business_id='10000000-0000-4000-a095-000000000001'),0,'manual capture has no lead event');
SELECT is((SELECT count(*)::integer FROM business_metric_events WHERE business_id='10000000-0000-4000-a095-000000000001' AND metric_key='contact_created'),0,'manual record does not inflate generated contact metric');
SELECT lives_ok($$SELECT pg_temp.save_customer('{"owner_warmth_override":"hot","is_priority":true}',(SELECT id FROM customer_test_ids WHERE key='manual'))$$,'owner can set manual hot priority');
SELECT is((SELECT lead_status FROM contacts WHERE id=(SELECT id FROM customer_test_ids WHERE key='manual')),'normal','manual hot preserves automatic classification');
SELECT is((customer_workspace_list('10000000-0000-4000-a095-000000000001','{"view":"hot"}')->'pagination'->>'total')::integer,1,'hot view uses manual warmth');
SELECT throws_ok($$SELECT pg_temp.save_customer('{"business_id":"10000000-0000-4000-a095-000000000002"}',(SELECT id FROM customer_test_ids WHERE key='manual'))$$,'22023','customer_fields_invalid','tenant fields are not writable');
SELECT throws_ok($$SELECT customer_workspace_save('10000000-0000-4000-a095-000000000001','00000000-0000-4000-a095-000000000002',NULL,'{"name":"Other"}')$$,'42501','customer_workspace_denied','wrong owner is denied');
SELECT throws_ok($$SELECT pg_temp.save_customer('{"name":"Duplicate","email":"pat@example.test"}')$$,'23505','customer_identity_conflict','manual destination collision does not merge');
SELECT throws_ok($$SELECT pg_temp.save_customer('{"name":"Bad phone","phone_number":"555"}')$$,'22023','customer_phone_invalid','SQL also validates phone identities');
SELECT lives_ok($$SELECT pg_temp.save_customer('{"name":"Pat"}')$$,'names alone are not merged');

-- Imported rows commit once, preserve existing nonempty data and recheck identities.
INSERT INTO customer_test_ids VALUES('import',(pg_temp.preview_customer('[
 {"rowNumber":2,"action":"create","errors":[],"values":{"email":"pat@example.test","name":"Replace name","company":"Example Co"}},
 {"rowNumber":3,"action":"create","errors":[],"values":{"name":"New customer","email":"new@example.test"}},
 {"rowNumber":4,"action":"create","errors":[],"values":{"name":"Duplicate row","email":"new@example.test"}},
 {"rowNumber":5,"action":"conflict","errors":["Invalid email"],"values":{}}
]')->>'previewToken')::uuid);
SELECT is((SELECT rows->0->>'action' FROM customer_imports WHERE id=(SELECT id FROM customer_test_ids WHERE key='import')),'fill_blanks','preview fills blanks only');
SELECT is((SELECT rows->2->>'action' FROM customer_imports WHERE id=(SELECT id FROM customer_test_ids WHERE key='import')),'conflict','repeated destination in file is surfaced');
CREATE TEMP TABLE customer_test_receipts AS SELECT pg_temp.commit_customer((SELECT id FROM customer_test_ids WHERE key='import')) AS result;
SELECT is((SELECT result->>'created' FROM customer_test_receipts),'1','import creates one customer');
SELECT is((SELECT result->>'updated' FROM customer_test_receipts),'1','import fills one existing record');
SELECT is((SELECT result->>'conflicts' FROM customer_test_receipts),'2','invalid and duplicate rows remain conflicts');
SELECT is((SELECT name FROM contacts WHERE email='pat@example.test' AND business_id='10000000-0000-4000-a095-000000000001'),'Pat','existing name survives fill blanks');
SELECT is((SELECT company FROM contacts WHERE email='pat@example.test' AND business_id='10000000-0000-4000-a095-000000000001'),'Example Co','blank company filled');
SELECT is((SELECT owner_warmth_override FROM contacts WHERE email='pat@example.test' AND business_id='10000000-0000-4000-a095-000000000001'),'hot','manual warmth preserved');
SELECT is(pg_temp.commit_customer((SELECT id FROM customer_test_ids WHERE key='import')),(SELECT result FROM customer_test_receipts),'commit retry returns same receipt');
SELECT is((SELECT rows FROM customer_imports WHERE id=(SELECT id FROM customer_test_ids WHERE key='import')),'[]'::jsonb,'committed preview payload is purged');
SELECT is((SELECT lead_status FROM contacts WHERE email='new@example.test' AND business_id='10000000-0000-4000-a095-000000000001'),'normal','CSV email does not create hot lead');
INSERT INTO customer_test_ids VALUES('stale',(pg_temp.preview_customer('[{"rowNumber":2,"action":"create","errors":[],"values":{"name":"Race","email":"race@example.test"}}]')->>'previewToken')::uuid);
SELECT pg_temp.save_customer('{"name":"Another writer","email":"race@example.test"}');
SELECT is(pg_temp.commit_customer((SELECT id FROM customer_test_ids WHERE key='stale'))->>'conflicts','1','identity created after preview is conflict');
SELECT throws_ok($$SELECT customer_workspace_import_commit('10000000-0000-4000-a095-000000000002','00000000-0000-4000-a095-000000000002',(SELECT id FROM customer_test_ids WHERE key='import'))$$,'P0002','customer_import_not_found','preview token is tenant bound');

-- Completion records never fabricate calendar bookings and are retry stable.
INSERT INTO customer_test_ids VALUES('event',(SELECT (customer_workspace_service_event('10000000-0000-4000-a095-000000000001','00000000-0000-4000-a095-000000000001',(SELECT id FROM customer_test_ids WHERE key='manual'),NULL,'{"idempotencyKey":"service-job-1","description":"Repair","serviceDate":"2026-10-01"}')).id));
SELECT is((SELECT completed_by FROM customer_service_events WHERE id=(SELECT id FROM customer_test_ids WHERE key='event')),'00000000-0000-4000-a095-000000000001'::uuid,'completion records actor');
SELECT is((SELECT service_address_snapshot FROM customer_service_events WHERE id=(SELECT id FROM customer_test_ids WHERE key='event')),'1 Main Street','service event preserves address snapshot');
SELECT is((SELECT (customer_workspace_service_event('10000000-0000-4000-a095-000000000001','00000000-0000-4000-a095-000000000001',(SELECT id FROM customer_test_ids WHERE key='manual'),NULL,'{"idempotencyKey":"service-job-1","description":"Repair","serviceDate":"2026-10-01"}')).id),(SELECT id FROM customer_test_ids WHERE key='event'),'completion retry returns existing event');
SELECT throws_ok($$SELECT customer_workspace_service_event('10000000-0000-4000-a095-000000000001','00000000-0000-4000-a095-000000000001',(SELECT id FROM customer_test_ids WHERE key='manual'),NULL,'{"idempotencyKey":"service-job-1","description":"Different"}')$$,'23505','customer_event_idempotency_conflict','changed idempotency payload rejected');
SELECT lives_ok($$SELECT customer_workspace_service_event('10000000-0000-4000-a095-000000000001','00000000-0000-4000-a095-000000000001',(SELECT id FROM customer_test_ids WHERE key='manual'),(SELECT id FROM customer_test_ids WHERE key='event'),'{"status":"open"}')$$,'completed work can be reopened');
SELECT ok((SELECT completed_at IS NULL FROM customer_service_events WHERE id=(SELECT id FROM customer_test_ids WHERE key='event')),'reopen clears completed timestamp');
SELECT is((SELECT count(*)::integer FROM calendar_bookings WHERE business_id='10000000-0000-4000-a095-000000000001'),0,'service completion invents no calendar event');
SELECT throws_ok($$INSERT INTO customer_service_events(business_id,contact_id,status,completed_at,idempotency_key,request_fingerprint) VALUES('10000000-0000-4000-a095-000000000002',(SELECT id FROM customer_test_ids WHERE key='manual'),'completed',now(),'invalid-cross-tenant','{}')$$,'23503',NULL,'service-event composite FK rejects cross-tenant contact');

SELECT customer_workspace_saved_view('10000000-0000-4000-a095-000000000001','00000000-0000-4000-a095-000000000001',NULL,'Priority','{"view":"priority"}');
SELECT customer_workspace_saved_view('10000000-0000-4000-a095-000000000002','00000000-0000-4000-a095-000000000002',NULL,'Other business','{}');
SELECT ok(NOT has_function_privilege('authenticated','public.customer_workspace_save(uuid,uuid,uuid,jsonb,text,boolean)','EXECUTE'),'owner cannot bypass API via mutation RPC');
SELECT ok(NOT has_function_privilege('anon','public.customer_workspace_list(uuid,jsonb,integer,integer)','EXECUTE'),'anonymous cannot list arbitrary business');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-a095-000000000001',true);
SELECT is((SELECT count(*)::integer FROM customer_saved_views),1,'saved view RLS isolates owner');
SELECT is((SELECT count(*)::integer FROM customer_service_events),1,'service-event RLS isolates owner');
RESET ROLE;

-- Owner contact details do not replace legacy/public chat routing identity.
INSERT INTO contacts(id,business_id,name,phone_number,session_id,source_channel)
 VALUES('20000000-0000-4000-a095-000000000099','10000000-0000-4000-a095-000000000001','Widget Customer','session_legacy_095','legacy-session-095','web_chat');
SELECT lives_ok($$SELECT pg_temp.save_customer('{"tags":["follow-up"]}','20000000-0000-4000-a095-000000000099')$$,'tag edits preserve an unchanged synthetic widget phone');
SELECT lives_ok($$SELECT pg_temp.save_customer('{"phone_number":"+15745550959"}','20000000-0000-4000-a095-000000000099')$$,'owner may store real callback details for a widget customer');
SELECT is((SELECT phone_number FROM contacts WHERE id='20000000-0000-4000-a095-000000000099'),'session_legacy_095','synthetic phone identity is unchanged');
SELECT is((SELECT provided_phone_number FROM contacts WHERE id='20000000-0000-4000-a095-000000000099'),'+15745550959','real customer phone is stored separately');
SELECT is((SELECT lead_status FROM contacts WHERE id='20000000-0000-4000-a095-000000000099'),'normal','owner callback correction does not manufacture a hot lead');
SELECT throws_ok($$SELECT pg_temp.save_customer('{"name":"Phone collision","phone_number":"+15745550959"}')$$,'23505','customer_identity_conflict','provided phone participates in safe customer deduplication');

INSERT INTO conversations(business_id,contact_id,channel) VALUES('10000000-0000-4000-a095-000000000001',(SELECT id FROM customer_test_ids WHERE key='manual'),'voice');
SELECT throws_ok($$SELECT customer_workspace_delete('10000000-0000-4000-a095-000000000001','00000000-0000-4000-a095-000000000001',(SELECT id FROM customer_test_ids WHERE key='manual'))$$,'23514','customer_voice_history_protected','backend preserves voice-history deletion protection');
SELECT throws_ok($$UPDATE contacts SET session_id='new-session' WHERE id=(SELECT id FROM customer_test_ids WHERE key='manual')$$,'23514','customer_identity_immutable','stable identity cannot be rewritten');

-- Bulk pagination/export is not truncated at the common API row limit.
INSERT INTO contacts(business_id,name,source_channel) SELECT '10000000-0000-4000-a095-000000000001','Bulk '||n,'csv_import' FROM generate_series(1,1005)n;
SELECT is((customer_workspace_list('10000000-0000-4000-a095-000000000001','{"q":"Bulk "}',2,1000)->'customers')::jsonb->>0 IS NOT NULL,true,'second page exists beyond 1000');
SELECT is((customer_workspace_list('10000000-0000-4000-a095-000000000001','{"q":"Bulk "}',2,1000)->'pagination'->>'total')::integer,1005,'aggregate total is complete');
SELECT is((SELECT count(*)::integer FROM customer_workspace_export_page('10000000-0000-4000-a095-000000000001','{"q":"Bulk "}',now())),1000,'export exposes bounded first page');

-- Tombstone cleanup preserves core accounting but removes new customer PII.
UPDATE businesses SET owner_id=NULL WHERE id='10000000-0000-4000-a095-000000000001';
SELECT ok(NOT EXISTS(SELECT 1 FROM contacts WHERE business_id='10000000-0000-4000-a095-000000000001' AND (company IS NOT NULL OR service_address IS NOT NULL OR cardinality(tags)>0 OR next_follow_up_at IS NOT NULL)),'new customer PII is scrubbed');
SELECT is((SELECT count(*)::integer FROM customer_service_events WHERE business_id='10000000-0000-4000-a095-000000000001'),0,'job history removed on tombstone');
SELECT is((SELECT count(*)::integer FROM customer_imports WHERE business_id='10000000-0000-4000-a095-000000000001'),0,'preview PII removed on tombstone');
SELECT is((SELECT count(*)::integer FROM customer_saved_views WHERE business_id='10000000-0000-4000-a095-000000000001'),0,'saved view PII removed on tombstone');
SELECT * FROM finish();
ROLLBACK;
