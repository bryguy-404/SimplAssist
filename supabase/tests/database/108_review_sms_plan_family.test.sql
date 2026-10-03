BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();
INSERT INTO auth.users(id,email) VALUES('00000000-0000-4000-a108-000000000001','review-family@example.test');
INSERT INTO businesses(id,owner_id,name,business_type,slug,telnyx_brand_id,telnyx_campaign_id,telnyx_messaging_profile_id,telnyx_voice_application_id)
VALUES('10000000-0000-4000-a108-000000000001','00000000-0000-4000-a108-000000000001','Review family','general','review-family-108','10800000-0000-4000-8108-000000000001','campaign108','10800000-0000-4000-8108-000000000002','108000001');
INSERT INTO subscriptions(business_id,stripe_customer_id,stripe_subscription_id,plan,status,current_period_start,current_period_end)
VALUES('10000000-0000-4000-a108-000000000001','cus_family108','sub_family108','chat_only','active',now()-interval '1 day',now()+interval '29 days');
INSERT INTO business_plan_family_locks(business_id,family,claimed_by) VALUES('10000000-0000-4000-a108-000000000001','chat_only','stripe_sync');
INSERT INTO phone_numbers(id,business_id,phone_number,telnyx_phone_number_id,is_active)
VALUES('20000000-0000-4000-a108-000000000001','10000000-0000-4000-a108-000000000001','+15555550108','10800000-0000-4000-8108-000000000003',true);
CREATE FUNCTION pg_temp.family() RETURNS text LANGUAGE sql AS $$ SELECT infer_business_plan_family('10000000-0000-4000-a108-000000000001') $$;
CREATE FUNCTION pg_temp.owned() RETURNS boolean LANGUAGE sql AS $$ SELECT review_sms_owns_plan_family_resources('10000000-0000-4000-a108-000000000001') $$;
SELECT throws_ok($$SELECT pg_temp.family()$$,'55000','business_plan_family_evidence_conflict','unbound resources still conflict with Chat');
INSERT INTO review_sms_accounts(business_id,owner_id,billing_source,state,source_subscription_id,source_customer_id,exclusive_resources,activation_paid_at,provider_started_at,brand_id,campaign_id,messaging_profile_id,voice_application_id,phone_number_id)
VALUES('10000000-0000-4000-a108-000000000001','00000000-0000-4000-a108-000000000001','direct','carrier_pending','sub_family108','cus_family108',true,now(),now(),'10800000-0000-4000-8108-000000000001','campaign108','10800000-0000-4000-8108-000000000002','108000001','20000000-0000-4000-a108-000000000001');
SELECT is(pg_temp.owned(),true,'paid direct review setup owns its exact bound provider resources');
SELECT is(pg_temp.family(),'chat_only','bound review resources preserve the Chat family');
SELECT is(has_review_sms_access('10000000-0000-4000-a108-000000000001'),false,'resource ownership alone does not grant review sending');
SELECT is(tenant_sms_service_plan('10000000-0000-4000-a108-000000000001'),'chat_only','resource ownership preserves Chat rather than granting an SMS base plan');
SELECT ok(NOT has_function_privilege('authenticated','review_sms_owns_plan_family_resources(uuid)','EXECUTE'),'owner cannot inspect private ownership authority');
UPDATE review_sms_accounts SET messaging_profile_id='wrong' WHERE business_id='10000000-0000-4000-a108-000000000001';
SELECT throws_ok($$SELECT pg_temp.family()$$,'55000','business_plan_family_evidence_conflict','a changed profile fails closed');
UPDATE review_sms_accounts SET messaging_profile_id='10800000-0000-4000-8108-000000000002',brand_id=NULL WHERE business_id='10000000-0000-4000-a108-000000000001';
SELECT throws_ok($$SELECT pg_temp.family()$$,'55000','business_plan_family_evidence_conflict','unbound brand is not exempt');
UPDATE review_sms_accounts SET brand_id='10800000-0000-4000-8108-000000000001',voice_application_id=NULL WHERE business_id='10000000-0000-4000-a108-000000000001';
SELECT throws_ok($$SELECT pg_temp.family()$$,'55000','business_plan_family_evidence_conflict','unbound voice application is not exempt');
UPDATE review_sms_accounts SET voice_application_id='108000001',exclusive_resources=false WHERE business_id='10000000-0000-4000-a108-000000000001';
SELECT throws_ok($$SELECT pg_temp.family()$$,'55000','business_plan_family_evidence_conflict','shared resources are not exempt');
UPDATE review_sms_accounts SET exclusive_resources=true,source_subscription_id='sub_other' WHERE business_id='10000000-0000-4000-a108-000000000001';
SELECT throws_ok($$SELECT pg_temp.family()$$,'55000','business_plan_family_evidence_conflict','changed billing source is not exempt');
UPDATE review_sms_accounts SET source_subscription_id='sub_family108',activation_paid_at=NULL WHERE business_id='10000000-0000-4000-a108-000000000001';
SELECT throws_ok($$SELECT pg_temp.family()$$,'55000','business_plan_family_evidence_conflict','unpaid setup cannot reinterpret provider evidence');
UPDATE review_sms_accounts SET activation_paid_at=now(),provider_started_at=NULL WHERE business_id='10000000-0000-4000-a108-000000000001';
SELECT throws_ok($$SELECT pg_temp.family()$$,'55000','business_plan_family_evidence_conflict','setup without the provider boundary cannot reinterpret evidence');
UPDATE review_sms_accounts SET provider_started_at=now() WHERE business_id='10000000-0000-4000-a108-000000000001';
INSERT INTO phone_numbers(id,business_id,phone_number,telnyx_phone_number_id,is_active)
VALUES('20000000-0000-4000-a108-000000000002','10000000-0000-4000-a108-000000000001','+15555550109','10800000-0000-4000-8108-000000000004',true);
SELECT throws_ok($$SELECT pg_temp.family()$$,'55000','business_plan_family_evidence_conflict','an extra unbound phone retains conflicting SMS evidence');
DELETE FROM phone_numbers WHERE id='20000000-0000-4000-a108-000000000002';
INSERT INTO telnyx_managed_resources(business_id,resource_type,provider_id)
VALUES('10000000-0000-4000-a108-000000000001','campaign','extra-campaign108');
SELECT throws_ok($$SELECT pg_temp.family()$$,'55000','business_plan_family_evidence_conflict','an extra managed resource retains conflicting evidence');
UPDATE telnyx_managed_resources SET provider_id='campaign108' WHERE business_id='10000000-0000-4000-a108-000000000001';
SELECT is(pg_temp.family(),'chat_only','an exact owned managed resource is exempt');
INSERT INTO businesses(id,owner_id,name,business_type,slug)
VALUES('10000000-0000-4000-a108-000000000002','00000000-0000-4000-a108-000000000001','Other business','general','review-family-108-other');
UPDATE telnyx_managed_resources SET business_id='10000000-0000-4000-a108-000000000002' WHERE business_id='10000000-0000-4000-a108-000000000001';
SELECT throws_ok($$SELECT pg_temp.family()$$,'55000','business_plan_family_evidence_conflict','a conflicting managed claim prevents exclusive ownership');
DELETE FROM telnyx_managed_resources WHERE business_id='10000000-0000-4000-a108-000000000002';
UPDATE subscriptions SET pending_plan='sms_only' WHERE business_id='10000000-0000-4000-a108-000000000001';
SELECT throws_ok($$SELECT pg_temp.family()$$,'55000','business_plan_family_evidence_conflict','a pending SMS plan remains conflicting financial evidence');
UPDATE subscriptions SET pending_plan=NULL,status='canceled' WHERE business_id='10000000-0000-4000-a108-000000000001';
SELECT is(pg_temp.family(),'chat_only','cancellation webhooks retain original Chat family for safe reconciliation');
UPDATE review_sms_accounts SET state='released' WHERE business_id='10000000-0000-4000-a108-000000000001';
UPDATE businesses SET telnyx_campaign_id=NULL WHERE id='10000000-0000-4000-a108-000000000001';
SELECT is(pg_temp.family(),'chat_only','retained owned brand/profile after release do not change the base plan');
SELECT * FROM finish();
ROLLBACK;
