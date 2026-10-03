BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();
INSERT INTO auth.users(id,email) VALUES('00000000-0000-4000-a110-000000000001','slug-owner@example.test');
INSERT INTO businesses(id,owner_id,name,business_type,slug)
VALUES('10000000-0000-4000-a110-000000000001','00000000-0000-4000-a110-000000000001','New Chat','general','pending-chat110'),
('10000000-0000-4000-a110-000000000002','00000000-0000-4000-a110-000000000001','Other','general','new-chat');
SELECT throws_ok($$SELECT review_sms_prepare_hosted_slug('10000000-0000-4000-a110-000000000001','00000000-0000-4000-a110-000000000002','new-chat')$$,'42501','review_workspace_denied','wrong owner cannot assign public URL');
SELECT throws_ok($$SELECT review_sms_prepare_hosted_slug('10000000-0000-4000-a110-000000000001','00000000-0000-4000-a110-000000000001','pending-invalid')$$,'P0001','review_sms_slug_invalid','placeholder namespace is not a public URL');
SELECT matches(review_sms_prepare_hosted_slug('10000000-0000-4000-a110-000000000001','00000000-0000-4000-a110-000000000001','new-chat'),'^new-chat-[a-f0-9]{8}$','collision gets a unique suffix');
SELECT is(review_sms_prepare_hosted_slug('10000000-0000-4000-a110-000000000001','00000000-0000-4000-a110-000000000001','changed-name'),(SELECT slug FROM businesses WHERE id='10000000-0000-4000-a110-000000000001'),'repeated saves preserve the public URL');
SELECT is((SELECT slug FROM businesses WHERE id='10000000-0000-4000-a110-000000000002'),'new-chat','existing tenant URL is unchanged');
SELECT ok(NOT has_function_privilege('authenticated','review_sms_prepare_hosted_slug(uuid,uuid,text)','EXECUTE'),'browser cannot bypass owner validation');
SELECT ok(NOT has_function_privilege('anon','review_sms_prepare_hosted_slug(uuid,uuid,text)','EXECUTE'),'public caller cannot assign URLs');
SELECT * FROM finish();
ROLLBACK;
