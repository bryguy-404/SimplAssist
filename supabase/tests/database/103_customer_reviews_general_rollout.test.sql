BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();

INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
 ('00000000-0000-4000-a103-000000000001','rollout-owner@example.test',now());
INSERT INTO businesses(id,owner_id,name,business_type,slug,billing_mode,partner_plan) VALUES
 ('10000000-0000-4000-a103-000000000001','00000000-0000-4000-a103-000000000001','Pilot business','general','review-103-pilot','comped','chat_only'),
 ('10000000-0000-4000-a103-000000000002','00000000-0000-4000-a103-000000000001','Existing excluded business','general','review-103-existing','comped','full');

SELECT ok(NOT (SELECT all_businesses_enabled FROM review_email_control),'general rollout starts disabled');
SELECT is((SELECT cardinality(excluded_business_ids) FROM review_email_control),0,'migration adds no account exclusions itself');
SELECT ok(NOT has_table_privilege('authenticated','review_email_control','UPDATE'),'owners cannot change launch controls');
SELECT ok(NOT has_function_privilege('authenticated','review_program_enabled(uuid)','EXECUTE'),'rollout admission remains service-only');

UPDATE review_email_control SET enabled=true,sending_enabled=false,sms_sending_enabled=false,
 pilot_business_ids=ARRAY['10000000-0000-4000-a103-000000000001'::uuid],
 excluded_business_ids=ARRAY['10000000-0000-4000-a103-000000000002'::uuid];
SELECT ok(review_program_enabled('10000000-0000-4000-a103-000000000001'),'explicit pilot retains access');
SELECT ok(NOT review_program_enabled('10000000-0000-4000-a103-000000000002'),'excluded existing business stays out');

UPDATE review_email_control SET all_businesses_enabled=true;
INSERT INTO businesses(id,owner_id,name,business_type,slug,billing_mode,partner_plan) VALUES
 ('10000000-0000-4000-a103-000000000003','00000000-0000-4000-a103-000000000001','New signup after launch','general','review-103-new','comped','chat_only');
SELECT ok(review_program_enabled('10000000-0000-4000-a103-000000000003'),'new signup is admitted without changing the pilot UUID list');
SELECT ok(review_program_enabled('10000000-0000-4000-a103-000000000001'),'pilot remains admitted during general launch');
SELECT ok(NOT review_program_enabled('10000000-0000-4000-a103-000000000002'),'general launch cannot override existing exclusions');
SELECT ok(NOT review_program_enabled(NULL),'null business cannot enter general rollout');
SELECT ok(NOT review_program_enabled('10000000-0000-4000-a103-000000000099'),'nonexistent business cannot enter general rollout');
SELECT ok(NOT (SELECT sending_enabled OR sms_sending_enabled FROM review_email_control),'feature access does not enable email or text delivery');
SELECT is((SELECT count(*)::integer FROM review_settings WHERE business_id='10000000-0000-4000-a103-000000000003'),0,'new signup is not silently configured or enrolled');
SELECT lives_ok($$SELECT review_initialize_settings('10000000-0000-4000-a103-000000000003','00000000-0000-4000-a103-000000000001')$$,'new owner can open settings through the existing lazy setup');
SELECT ok((SELECT google_review_url IS NULL AND NOT reminder_enabled AND NOT automation_enabled FROM review_settings WHERE business_id='10000000-0000-4000-a103-000000000003'),'Google link needs owner setup and both automations stay off');
SELECT is((SELECT count(*)::integer FROM review_enrollments WHERE business_id='10000000-0000-4000-a103-000000000003'),0,'initial setup never enrolls customers');

UPDATE review_email_control SET pilot_business_ids=pilot_business_ids||ARRAY['10000000-0000-4000-a103-000000000002'::uuid];
SELECT ok(NOT review_program_enabled('10000000-0000-4000-a103-000000000002'),'exclusion also overrides explicit pilot admission');
UPDATE review_email_control SET enabled=false;
SELECT ok(NOT review_program_enabled('10000000-0000-4000-a103-000000000001'),'master switch disables an explicit pilot');
SELECT ok(NOT review_program_enabled('10000000-0000-4000-a103-000000000003'),'master switch disables a newly admitted signup');
UPDATE review_email_control SET enabled=true,all_businesses_enabled=false;
SELECT ok(NOT review_program_enabled('10000000-0000-4000-a103-000000000003'),'turning general launch off restores pilot-only access');
UPDATE review_email_control SET all_businesses_enabled=true;
UPDATE businesses SET deleted_at=now(),deletion_scheduled_for=now()+interval '60 days'
 WHERE id='10000000-0000-4000-a103-000000000003';
SELECT ok(NOT review_program_enabled('10000000-0000-4000-a103-000000000003'),'deleted businesses are not admitted by the broad switch');

SELECT * FROM finish();
ROLLBACK;
