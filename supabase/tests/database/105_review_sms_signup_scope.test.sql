BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
 ('00000000-0000-4000-a105-000000000001','signup-scope@example.test',now());
INSERT INTO businesses(id,owner_id,name,business_type,slug) VALUES
 ('10000000-0000-4000-a105-000000000001','00000000-0000-4000-a105-000000000001','New review signup','general','signup-review-105');

SELECT ok(NOT (SELECT review_sms_signup_enabled FROM businesses WHERE id='10000000-0000-4000-a105-000000000001'),'new business defaults to customer-care-only');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','00000000-0000-4000-a105-000000000001',true);
SELECT throws_ok($$UPDATE businesses SET review_sms_signup_enabled=true WHERE id='10000000-0000-4000-a105-000000000001'$$,
 'P0001','review_sms_signup_scope_service_only','direct browser updates cannot opt a business into a different campaign');
RESET ROLE;

SET LOCAL ROLE service_role;
SELECT lives_ok($$UPDATE businesses SET review_sms_signup_enabled=true WHERE id='10000000-0000-4000-a105-000000000001'$$,'authorized server can persist an explicit new-signup choice');
SELECT lives_ok($$UPDATE businesses SET review_sms_signup_enabled=false WHERE id='10000000-0000-4000-a105-000000000001'$$,'owner can change the choice before filing');
UPDATE businesses SET review_sms_signup_enabled=true WHERE id='10000000-0000-4000-a105-000000000001';
UPDATE businesses SET onboarding_registration_status='submitting' WHERE id='10000000-0000-4000-a105-000000000001';
SELECT throws_ok($$UPDATE businesses SET review_sms_signup_enabled=false WHERE id='10000000-0000-4000-a105-000000000001'$$,
 'P0001','review_sms_signup_scope_locked','signup program scope is frozen while registration runs');
UPDATE businesses SET onboarding_registration_status='failed',telnyx_campaign_id='existing-review-scope-campaign' WHERE id='10000000-0000-4000-a105-000000000001';
SELECT throws_ok($$UPDATE businesses SET review_sms_signup_enabled=false WHERE id='10000000-0000-4000-a105-000000000001'$$,
 'P0001','review_sms_signup_scope_locked','an existing campaign is never silently reclassified');
SELECT lives_ok($$UPDATE businesses SET review_sms_signup_enabled=true,name='Same program' WHERE id='10000000-0000-4000-a105-000000000001'$$,'unchanged scope does not block unrelated updates');
RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
