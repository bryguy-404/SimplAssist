BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();
UPDATE booking_confirmation_control SET enabled=true;
INSERT INTO auth.users(id,email) VALUES ('00000000-0000-4000-a089-000000000001','booking-draft@example.test');
INSERT INTO businesses(id,owner_id,name,business_type,slug,billing_mode,partner_plan,primary_goal) VALUES
 ('10000000-0000-4000-a089-000000000001','00000000-0000-4000-a089-000000000001','Booking','general','booking-089','comped','full','book');
INSERT INTO ai_settings(business_id,booking_enabled,booking_mode) VALUES('10000000-0000-4000-a089-000000000001',true,'schedule_direct') ON CONFLICT(business_id) DO UPDATE SET booking_enabled=true,booking_mode='schedule_direct';
INSERT INTO contacts(id,business_id,phone_number,source_channel) VALUES('20000000-0000-4000-a089-000000000001','10000000-0000-4000-a089-000000000001','+15555550891','sms');
INSERT INTO conversations(id,business_id,contact_id,channel) VALUES('30000000-0000-4000-a089-000000000001','10000000-0000-4000-a089-000000000001','20000000-0000-4000-a089-000000000001','sms');
INSERT INTO messages(id,business_id,conversation_id,role,channel,content,created_at) VALUES('40000000-0000-4000-a089-000000000001','10000000-0000-4000-a089-000000000001','30000000-0000-4000-a089-000000000001','customer','sms','A callback please',now()-interval '1 second');
CREATE TEMP TABLE drafts AS SELECT (prepare_booking_draft('10000000-0000-4000-a089-000000000001','30000000-0000-4000-a089-000000000001','20000000-0000-4000-a089-000000000001','40000000-0000-4000-a089-000000000001',NULL,
 '{"offering":{"settingsRevision":0},"mode":"schedule_direct","email":"first@example.test"}','Review first email?')).*;
SELECT is((SELECT revision FROM drafts),1,'first revision created');
SELECT throws_ok($$SELECT claim_booking_draft('10000000-0000-4000-a089-000000000001',(SELECT id FROM drafts),1,'40000000-0000-4000-a089-000000000001')$$,'P0001','booking confirmation out of order','request cannot confirm itself');
INSERT INTO messages(id,business_id,conversation_id,role,channel,content,created_at) VALUES('40000000-0000-4000-a089-000000000002','10000000-0000-4000-a089-000000000001','30000000-0000-4000-a089-000000000001','assistant','sms','Review first email?',now());
SELECT ok(NOT acknowledge_booking_summary('10000000-0000-4000-a089-000000000001',(SELECT id FROM drafts),1,'40000000-0000-4000-a089-000000000002',NULL),'SMS summary without provider acceptance cannot authorize');
SELECT ok(acknowledge_booking_summary('10000000-0000-4000-a089-000000000001',(SELECT id FROM drafts),1,'40000000-0000-4000-a089-000000000002','provider-089'),'provider accepted review activates confirmation');
INSERT INTO messages(id,business_id,conversation_id,role,channel,content,created_at) VALUES('40000000-0000-4000-a089-000000000003','10000000-0000-4000-a089-000000000001','30000000-0000-4000-a089-000000000001','customer','sms','Actually second@example.test',now()+interval '1 second');
CREATE TEMP TABLE corrected AS SELECT (prepare_booking_draft('10000000-0000-4000-a089-000000000001','30000000-0000-4000-a089-000000000001','20000000-0000-4000-a089-000000000001','40000000-0000-4000-a089-000000000003',NULL,
 '{"offering":{"settingsRevision":0},"mode":"schedule_direct","email":"second@example.test"}','Review corrected email?')).*;
SELECT is((SELECT revision FROM corrected),2,'correction creates a revision');
SELECT is((SELECT status FROM booking_drafts WHERE id=(SELECT id FROM drafts)),'superseded','previous review is superseded');
SELECT throws_ok($$SELECT claim_booking_draft('10000000-0000-4000-a089-000000000001',(SELECT id FROM drafts),1,'40000000-0000-4000-a089-000000000003')$$,'P0001','booking draft superseded','old reviewed draft cannot execute');
SELECT throws_ok($$UPDATE booking_drafts SET snapshot='{}' WHERE id=(SELECT id FROM corrected)$$,'P0001','booking snapshot is immutable','reviewed snapshots immutable');
INSERT INTO messages(id,business_id,conversation_id,role,channel,content,created_at) VALUES('40000000-0000-4000-a089-000000000004','10000000-0000-4000-a089-000000000001','30000000-0000-4000-a089-000000000001','assistant','sms','Review corrected email?',now());
SELECT ok(acknowledge_booking_summary('10000000-0000-4000-a089-000000000001',(SELECT id FROM corrected),2,'40000000-0000-4000-a089-000000000004','provider-089-2'),'corrected review accepted');
INSERT INTO messages(id,business_id,conversation_id,role,channel,content,created_at) VALUES('40000000-0000-4000-a089-000000000005','10000000-0000-4000-a089-000000000001','30000000-0000-4000-a089-000000000001','customer','sms','Yes please',now()+interval '2 seconds');
SELECT is((claim_booking_draft('10000000-0000-4000-a089-000000000001',(SELECT id FROM corrected),2,'40000000-0000-4000-a089-000000000005')->>'execute')::boolean,true,'fresh confirmation owns execution');
SELECT is((claim_booking_draft('10000000-0000-4000-a089-000000000001',(SELECT id FROM corrected),2,'40000000-0000-4000-a089-000000000005')->>'execute')::boolean,false,'duplicate cannot execute twice');
SELECT throws_ok($$UPDATE messages SET conversation_id=gen_random_uuid() WHERE id='40000000-0000-4000-a089-000000000005'$$,'P0001','booking source scope is immutable','confirmation cannot move conversations');
DELETE FROM messages WHERE id='40000000-0000-4000-a089-000000000005';
SELECT is((SELECT count(*)::integer FROM booking_drafts WHERE id=(SELECT id FROM corrected)),0,'deleting confirmation deletes dependent private snapshot');
SELECT * FROM finish();
ROLLBACK;
