BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES('00000000-0000-4000-a111-000000000001','candidate-owner@example.test',now());
INSERT INTO businesses(id,owner_id,name,business_type,slug,billing_mode,partner_plan,review_sms_signup_enabled,telnyx_campaign_id,telnyx_messaging_profile_id,operations_suspended_at,texting_paused_at)
SELECT ('10000000-0000-4000-a111-'||lpad(i::text,12,'0'))::uuid,'00000000-0000-4000-a111-000000000001','Signup '||i,'general',
 CASE WHEN i=6 THEN 'pending-candidate-111' ELSE 'candidate-111-'||i END,'comped',CASE WHEN i=3 THEN 'chat_only' ELSE 'full' END,
 i<>2,CASE WHEN i=7 THEN NULL ELSE 'campaign111-'||i END,'profile111-'||i,
 CASE WHEN i=4 THEN now() ELSE NULL END,CASE WHEN i=5 THEN now() ELSE NULL END
FROM generate_series(1,10) i;
INSERT INTO phone_numbers(business_id,phone_number,telnyx_phone_number_id,is_active)
SELECT ('10000000-0000-4000-a111-'||lpad(i::text,12,'0'))::uuid,'+1574555'||lpad(i::text,4,'0'),'number111-'||i,true
FROM generate_series(1,10) i WHERE i<>9;
INSERT INTO review_sms_accounts(business_id,owner_id,state,billing_source)
VALUES('10000000-0000-4000-a111-000000000008','00000000-0000-4000-a111-000000000001','carrier_pending','included');
UPDATE review_email_control SET enabled=true,all_businesses_enabled=true,excluded_business_ids='{}';
SELECT results_eq($$SELECT business_id FROM review_sms_signup_candidates()$$,$$SELECT '10000000-0000-4000-a111-000000000001'::uuid UNION ALL SELECT '10000000-0000-4000-a111-000000000010'::uuid$$,'scan selects only opted-in eligible uninitialized texting accounts with a sender');
SELECT is((SELECT count(*)::integer FROM review_sms_signup_candidates(NULL,'{}',1)),1,'work is bounded');
SELECT is((SELECT count(*)::integer FROM review_sms_signup_candidates('{}','{}',5)),0,'empty pilot does not mean all businesses');
SELECT results_eq($$SELECT business_id FROM review_sms_signup_candidates(ARRAY['10000000-0000-4000-a111-000000000010'::uuid])$$,$$SELECT '10000000-0000-4000-a111-000000000010'::uuid$$,'exact pilot applied before the bounded scan');
SELECT results_eq($$SELECT business_id FROM review_sms_signup_candidates(NULL,ARRAY['10000000-0000-4000-a111-000000000001'::uuid],1)$$,$$SELECT '10000000-0000-4000-a111-000000000010'::uuid$$,'excluded oldest business cannot starve a later eligible signup');
SELECT ok(review_sms_initialize_signup('10000000-0000-4000-a111-000000000001','00000000-0000-4000-a111-000000000001','{"consentMode":"hosted_keyword"}'),'candidate initializes through the existing no-fee guarded path');
SELECT results_eq($$SELECT business_id FROM review_sms_signup_candidates()$$,$$SELECT '10000000-0000-4000-a111-000000000010'::uuid$$,'initialized account moves to normal lifecycle reconciliation');
UPDATE review_email_control SET enabled=false;
SELECT is((SELECT count(*)::integer FROM review_sms_signup_candidates()),0,'database rollout switch respected');
SELECT ok(NOT has_function_privilege('anon','review_sms_signup_candidates(uuid[],uuid[],integer)','EXECUTE'),'anonymous callers cannot enumerate customers');
SELECT ok(NOT has_function_privilege('authenticated','review_sms_signup_candidates(uuid[],uuid[],integer)','EXECUTE'),'owners cannot enumerate other accounts');
SELECT * FROM finish();
ROLLBACK;
