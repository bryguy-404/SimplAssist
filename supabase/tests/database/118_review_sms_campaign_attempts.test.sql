BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();
CREATE FUNCTION pg_temp.source() RETURNS uuid LANGUAGE sql AS $$SELECT '10000000-0000-4000-a118-000000000001'::uuid$$;
CREATE FUNCTION pg_temp.target() RETURNS uuid LANGUAGE sql AS $$SELECT '0e2bf188-ab53-4d3b-8e1a-7aac49125811'::uuid$$;
CREATE FUNCTION pg_temp.owner() RETURNS uuid LANGUAGE sql AS $$SELECT '00000000-0000-4000-a118-000000000001'::uuid$$;
CREATE FUNCTION pg_temp.account() RETURNS uuid LANGUAGE sql AS $$SELECT '30000000-0000-4000-a118-000000000001'::uuid$$;
CREATE FUNCTION pg_temp.claim() RETURNS uuid LANGUAGE sql AS $$SELECT '40000000-0000-4000-a118-000000000001'::uuid$$;
CREATE FUNCTION pg_temp.brand() RETURNS text LANGUAGE sql AS $$SELECT '11800000-0000-4000-8118-000000000001'$$;
CREATE FUNCTION pg_temp.filing(retry boolean DEFAULT false) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('brandId',pg_temp.brand(),'usecase','MARKETING','description','Synthetic test only',
 'referenceId','reviews:'||pg_temp.account()::text||CASE WHEN retry THEN ':r1' ELSE '' END,
 'webhookURL','https://example.test/webhook','webhookFailoverURL','https://example.test/webhook')$$;
INSERT INTO auth.users(id,email) VALUES(pg_temp.owner(),'campaign118@example.test');
INSERT INTO businesses(id,owner_id,name,business_type,slug,billing_mode,onboarding_completed_at,ein,has_ein,legal_business_name,business_entity_type,business_registration_state,address,city,state,zip,telnyx_brand_id,telnyx_brand_source,brand_status,telnyx_campaign_id)
 VALUES(pg_temp.source(),pg_temp.owner(),'Source fixture','general','campaign118-source','stripe',now(),'12-3456118',true,'Campaign Test LLC','llc','IN','118 Synthetic Street','South Bend','IN','46601',pg_temp.brand(),'linked_existing','approved','source118');
INSERT INTO businesses(id,owner_id,name,business_type,slug,billing_mode,onboarding_completed_at)
 VALUES(pg_temp.target(),pg_temp.owner(),'Retry fixture','general','campaign118-target','stripe',now());
INSERT INTO subscriptions(business_id,stripe_customer_id,stripe_subscription_id,plan,status,current_period_start,current_period_end)
 VALUES(pg_temp.source(),'cus_source118','sub_source118','full','active',now()-interval '1 day',now()+interval '29 days'),
 (pg_temp.target(),'cus_target118','sub_target118','chat_only','active',now()-interval '1 day',now()+interval '29 days');
INSERT INTO business_plan_family_locks(business_id,family,claimed_by) VALUES(pg_temp.target(),'chat_only','stripe_sync');
INSERT INTO telnyx_brand_link_requests(business_id,tcr_brand_id,telnyx_brand_id,status,identity_fingerprint,inspected_by,approved_by,approved_at,consumed_at)
 VALUES(pg_temp.source(),'B118TEST',pg_temp.brand(),'consumed',repeat('a',64),'admin118','admin118',now(),now());
INSERT INTO telnyx_managed_resources(business_id,resource_type,provider_id,public_tcr_id,provider_origin)
 VALUES(pg_temp.source(),'brand',pg_temp.brand(),'B118TEST','linked_existing');
SELECT approve_shared_review_brand_member(pg_temp.source(),pg_temp.target(),pg_temp.owner(),pg_temp.owner(),pg_temp.owner(),0,pg_temp.brand(),'B118TEST',to_jsonb(b),now()) FROM businesses b WHERE id=pg_temp.source();
INSERT INTO review_sms_accounts(id,business_id,owner_id,billing_source,state,source_subscription_id,source_customer_id,exclusive_resources,draft,
 activation_paid_at,activation_payment_intent_id,provisioning_claim,provisioning_lease_until)
 VALUES(pg_temp.account(),pg_temp.target(),pg_temp.owner(),'direct','carrier_pending','sub_target118','cus_target118',true,'{}',now(),'pi_campaign118',pg_temp.claim(),now()+interval '10 minutes');
INSERT INTO review_sms_billing_operations(id,account_id,business_id,owner_id,kind,state,fingerprint,payload,completed_at)
 SELECT '50000000-0000-4000-a118-000000000001',pg_temp.account(),pg_temp.target(),pg_temp.owner(),'activation','completed','proof118',
 jsonb_build_object('sharedRegistration',jsonb_build_object('registrationId',b.shared_registration_id,'identityVersion',1,'membershipRevision',1,'brandId',pg_temp.brand())),now()
 FROM businesses b WHERE id=pg_temp.target();
SELECT consume_shared_review_brand_member(pg_temp.target(),pg_temp.owner(),pg_temp.account(),pg_temp.claim(),b.shared_registration_id,1,1) FROM businesses b WHERE id=pg_temp.target();
UPDATE businesses SET telnyx_messaging_profile_id='118-profile',telnyx_voice_application_id='118-voice' WHERE id=pg_temp.target();
INSERT INTO phone_numbers(id,business_id,phone_number,telnyx_phone_number_id,is_active)
 VALUES('60000000-0000-4000-a118-000000000001',pg_temp.target(),'+15745550118','118-provider-phone',true);
UPDATE review_sms_accounts SET messaging_profile_id='118-profile',voice_application_id='118-voice',phone_number_id='60000000-0000-4000-a118-000000000001' WHERE id=pg_temp.account();
CREATE TEMP TABLE original118 AS SELECT reserve_shared_brand_campaign(pg_temp.target(),'review_initial',pg_temp.account(),'reviews:'||pg_temp.account(),repeat('a',64),ARRAY['source118','external118'],now(),pg_temp.claim(),1) value;
CREATE FUNCTION pg_temp.original() RETURNS uuid LANGUAGE sql AS $$SELECT (value->>'id')::uuid FROM original118$$;
SELECT ok(review_sms_reserve_campaign_submission(pg_temp.target(),pg_temp.claim()),'original paid fence authorizes exactly one first attempt');
SELECT ok(NOT has_table_privilege('authenticated','review_sms_campaign_attempts','SELECT'),'owners cannot read filing or diagnostics');
SELECT ok(NOT has_table_privilege('anon','review_sms_campaign_attempts','SELECT'),'anonymous callers cannot read the journal');
SELECT ok(NOT has_function_privilege('authenticated','review_sms_begin_campaign_retry(uuid,uuid,uuid,uuid,text[],timestamptz)','EXECUTE'),'retry capability is service-only');
SELECT throws_ok($$SELECT review_sms_begin_campaign_attempt(pg_temp.target(),gen_random_uuid(),'reviews:'||pg_temp.account(),repeat('a',64),pg_temp.filing(),pg_temp.original())$$,'P0001','review_sms_campaign_attempt_changed','initial journal requires current normal provisioning claim');
CREATE TEMP TABLE first118 AS SELECT review_sms_begin_campaign_attempt(pg_temp.target(),pg_temp.claim(),'reviews:'||pg_temp.account(),repeat('a',64),pg_temp.filing(),pg_temp.original()) value;
SELECT is((SELECT (value->>'submit')::boolean FROM first118),true,'first journal starts before the provider call');
SELECT is((review_sms_begin_campaign_attempt(pg_temp.target(),pg_temp.claim(),'reviews:'||pg_temp.account(),repeat('a',64),pg_temp.filing(),pg_temp.original())->>'submit')::boolean,false,'replayed journal never reauthorizes a paid submit');
SELECT lives_ok($$SELECT review_sms_finish_campaign_attempt((SELECT (value->>'attempt_id')::uuid FROM first118),pg_temp.claim(),'unknown',NULL,'{"status":422,"requestId":"test-request"}')$$,'failure diagnostics are durably separate from generic account error');
SELECT is((SELECT diagnostics->>'requestId' FROM review_sms_campaign_attempts WHERE account_id=pg_temp.account()),'test-request','request evidence is retained');
CREATE FUNCTION pg_temp.authorize() RETURNS jsonb LANGUAGE sql AS $$SELECT review_sms_authorize_campaign_retry(pg_temp.target(),pg_temp.account(),pg_temp.owner(),pg_temp.owner(),pg_temp.original(),1,pg_temp.filing(),pg_temp.filing(true),repeat('b',64))$$;
SELECT throws_ok($$SELECT pg_temp.authorize()$$,'P0001','review_sms_campaign_retry_changed','an active worker lease fences administrative authorization');
UPDATE review_sms_accounts SET provisioning_claim=NULL,provisioning_lease_until=NULL WHERE id=pg_temp.account();
SELECT throws_ok($$SELECT review_sms_authorize_campaign_retry(pg_temp.source(),pg_temp.account(),pg_temp.owner(),pg_temp.owner(),pg_temp.original(),1,pg_temp.filing(),pg_temp.filing(true),repeat('b',64))$$,'P0001','review_sms_campaign_retry_not_authorized','another business cannot use the private retry exception');
SELECT throws_ok($$SELECT review_sms_authorize_campaign_retry(pg_temp.target(),pg_temp.account(),gen_random_uuid(),pg_temp.owner(),pg_temp.original(),1,pg_temp.filing(),pg_temp.filing(true),repeat('b',64))$$,'P0001','review_sms_campaign_retry_changed','expected exact owner is rechecked');
SELECT throws_ok($$SELECT review_sms_authorize_campaign_retry(pg_temp.target(),pg_temp.account(),pg_temp.owner(),pg_temp.owner(),pg_temp.original(),2,pg_temp.filing(),pg_temp.filing(true),repeat('b',64))$$,'P0001','review_sms_campaign_retry_changed','stale membership revision cannot authorize a retry');
SELECT throws_ok($$SELECT review_sms_authorize_campaign_retry(pg_temp.target(),pg_temp.account(),pg_temp.owner(),pg_temp.owner(),pg_temp.original(),1,pg_temp.filing(),pg_temp.filing(true)||'{"description":"Different marketing"}',repeat('b',64))$$,'P0001','review_sms_campaign_retry_filing_changed','authorization cannot silently change the filing');
UPDATE review_sms_accounts SET activation_refunded_at=now() WHERE id=pg_temp.account();
SELECT throws_ok($$SELECT pg_temp.authorize()$$,'P0001','review_sms_campaign_retry_changed','a refunded receipt cannot authorize a retry');
UPDATE review_sms_accounts SET activation_refunded_at=NULL WHERE id=pg_temp.account();
UPDATE subscriptions SET cancel_at_period_end=true WHERE business_id=pg_temp.target();
SELECT throws_ok($$SELECT pg_temp.authorize()$$,'P0001','review_sms_campaign_retry_changed','pending base cancellation cannot authorize a retry');
UPDATE subscriptions SET cancel_at_period_end=false WHERE business_id=pg_temp.target();
-- Model the deployed pre-journal first attempt without rewriting its capacity row.
DELETE FROM review_sms_campaign_attempts WHERE account_id=pg_temp.account();
CREATE TEMP TABLE retry118 AS SELECT pg_temp.authorize() value;
CREATE FUNCTION pg_temp.retry() RETURNS uuid LANGUAGE sql AS $$SELECT (value->>'attempt_id')::uuid FROM retry118$$;
CREATE FUNCTION pg_temp.token() RETURNS uuid LANGUAGE sql AS $$SELECT (value->>'token')::uuid FROM retry118$$;
SELECT is((SELECT state FROM review_sms_campaign_attempts WHERE account_id=pg_temp.account() AND attempt_number=1),'unknown','legacy attempt is backfilled honestly as unknown');
SELECT is((SELECT state FROM shared_brand_campaign_reservations WHERE id=pg_temp.original()),'unknown','authorization preserves the original uncertain reservation');
SELECT is((SELECT provider_attempt_count FROM review_sms_accounts WHERE id=pg_temp.account()),1,'preparing authorization does not submit or reset the count');
SELECT throws_ok($$UPDATE review_sms_campaign_attempts SET filing=filing||'{"description":"Changed after approval"}' WHERE id=pg_temp.retry()$$,'P0001','review_sms_campaign_attempt_snapshot_immutable','approved filing cannot be rewritten');
SELECT throws_ok($$SELECT review_sms_finish_campaign_attempt((SELECT id FROM review_sms_campaign_attempts WHERE account_id=pg_temp.account() AND attempt_number=1),gen_random_uuid(),'unknown',NULL,'{}')$$,'P0001','review_sms_campaign_attempt_changed','historical attempt with null claim requires a real recovery claim');
SELECT throws_ok($$SELECT pg_temp.authorize()$$,'P0001','review_sms_campaign_retry_already_authorized','a second authorization is forbidden');
SELECT throws_ok($$SELECT review_sms_begin_campaign_retry(pg_temp.target(),pg_temp.retry(),gen_random_uuid(),pg_temp.claim(),ARRAY['source118','external118'],now())$$,'P0001','review_sms_campaign_retry_not_authorized','knowledge of attempt ID cannot consume the secret capability');
UPDATE review_sms_accounts SET provisioning_claim=pg_temp.claim(),provisioning_lease_until=now()+interval '10 minutes' WHERE id=pg_temp.account();
CREATE FUNCTION pg_temp.begin_retry(inventory text[] DEFAULT ARRAY['source118','external118']) RETURNS jsonb LANGUAGE sql AS $$SELECT review_sms_begin_campaign_retry(pg_temp.target(),pg_temp.retry(),pg_temp.token(),pg_temp.claim(),inventory,now())$$;
UPDATE review_sms_campaign_attempts SET authorization_expires_at=now()-interval '1 second' WHERE id=pg_temp.retry();
SELECT throws_ok($$SELECT pg_temp.begin_retry()$$,'P0001','review_sms_campaign_retry_changed','expired authorization cannot begin');
UPDATE review_sms_campaign_attempts SET authorization_expires_at=now()+interval '10 minutes' WHERE id=pg_temp.retry();
SELECT throws_ok($$SELECT pg_temp.begin_retry(ARRAY['a','b','c','d'])$$,'P0001','shared_brand_campaign_capacity','original unknown attempt still consumes capacity');
SELECT is((SELECT authorization_consumed_at IS NULL FROM review_sms_campaign_attempts WHERE id=pg_temp.retry()),true,'failed capacity check leaves the one-shot authorization unused');
UPDATE review_sms_accounts SET cancel_at=now() WHERE id=pg_temp.account();
SELECT throws_ok($$SELECT pg_temp.begin_retry()$$,'P0001','review_sms_campaign_retry_changed','cancellation wins before consume');
UPDATE review_sms_accounts SET cancel_at=NULL WHERE id=pg_temp.account();
SELECT is((pg_temp.begin_retry()->>'submit')::boolean,true,'one authorized retry atomically consumes its capability');
SELECT is((pg_temp.begin_retry()->>'submit')::boolean,false,'double click cannot submit another paid attempt');
SELECT is((SELECT provider_attempt_count FROM review_sms_accounts WHERE id=pg_temp.account()),2,'provider attempts accumulate to two without resetting history');
SELECT throws_ok($$UPDATE review_sms_campaign_attempts SET authorization_consumed_at=NULL WHERE id=pg_temp.retry()$$,'P0001','review_sms_campaign_attempt_authority_immutable','consumed authorization cannot be reset');
SELECT is((SELECT count(*)::int FROM shared_brand_campaign_reservations WHERE business_id=pg_temp.target()),2,'retry owns a separate capacity reservation');
SELECT is((SELECT operation_id FROM shared_brand_campaign_reservations WHERE id=(SELECT reservation_id FROM review_sms_campaign_attempts WHERE id=pg_temp.retry())),pg_temp.retry(),'retry reservation is keyed by its exact operation');
SELECT is((SELECT state FROM shared_brand_campaign_reservations WHERE id=pg_temp.original()),'unknown','consuming retry does not resolve or erase the original unknown outcome');
CREATE FUNCTION pg_temp.late_original_probe() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb;BEGIN
 BEGIN
  result:=review_sms_finish_campaign_attempt((SELECT id FROM review_sms_campaign_attempts WHERE account_id=pg_temp.account() AND attempt_number=1),
   pg_temp.claim(),'accepted','late-original118',NULL,pg_temp.filing()||'{"campaignId":"late-original118"}');
  result:=result||jsonb_build_object('originalRecorded',(SELECT state='bound' FROM shared_brand_campaign_reservations WHERE id=pg_temp.original()),
   'unattached',(SELECT campaign_id IS NULL FROM review_sms_accounts WHERE id=pg_temp.account()));
  RAISE EXCEPTION 'rollback late original probe' USING ERRCODE='ZX118';
 EXCEPTION WHEN SQLSTATE 'ZX118' THEN NULL;END;
 RETURN result;
END $$;
CREATE TEMP TABLE late_original118 AS SELECT pg_temp.late_original_probe() value;
SELECT ok((SELECT value->>'originalRecorded'='true' AND value->>'unattached'='true' AND value->>'attached'='false' FROM late_original118),'late original evidence is retained but cannot displace the consumed retry choice');
SELECT ok(NOT review_sms_reserve_campaign_submission(pg_temp.target(),pg_temp.claim()),'legacy worker cannot receive another ordinary submit authorization');
SELECT throws_ok($$SELECT review_sms_finish_campaign_attempt(pg_temp.retry(),pg_temp.claim(),'accepted','candidate118',NULL,pg_temp.filing()||'{"campaignId":"candidate118"}')$$,'P0001','review_sms_campaign_evidence_mismatch','original reference cannot be substituted for retry evidence');
SELECT throws_ok($$SELECT review_sms_finish_campaign_attempt(pg_temp.retry(),pg_temp.claim(),'accepted','candidate118',NULL,pg_temp.filing(true)||'{"campaignId":"candidate118","brandId":"different"}')$$,'P0001','review_sms_campaign_evidence_mismatch','candidate from another brand is rejected');
UPDATE review_sms_accounts SET provisioning_claim=NULL,provisioning_lease_until=NULL WHERE id=pg_temp.account();
SELECT throws_ok($$SELECT review_sms_finish_campaign_attempt(pg_temp.retry(),gen_random_uuid(),'unknown',NULL,'{}')$$,'P0001','review_sms_campaign_attempt_changed','unrelated caller cannot settle a provider attempt');
SELECT lives_ok($$SELECT review_sms_finish_campaign_attempt(pg_temp.retry(),pg_temp.claim(),'unknown','candidate118','{"message":"Retrieve failed after create response"}')$$,'original submitting claim can preserve response evidence after its lease expires');
SELECT is((SELECT response_campaign_id FROM review_sms_campaign_attempts WHERE id=pg_temp.retry()),'candidate118','unverified response campaign ID is recoverable');
SELECT ok((SELECT provider_campaign_id IS NULL FROM review_sms_campaign_attempts WHERE id=pg_temp.retry()),'unverified response does not become verified campaign evidence');
UPDATE review_sms_accounts SET provisioning_claim=pg_temp.claim(),provisioning_lease_until=now()+interval '10 minutes' WHERE id=pg_temp.account();
-- A canceled account may retain a real provider outcome for cleanup, but must
-- never regain service from that late outcome.
UPDATE review_sms_accounts SET cancel_at=now() WHERE id=pg_temp.account();
SELECT is((review_sms_finish_campaign_attempt(pg_temp.retry(),pg_temp.claim(),'accepted','candidate118',NULL,pg_temp.filing(true)||'{"campaignId":"candidate118"}')->>'attached')::boolean,false,'late accepted outcome is recorded without reviving cancellation');
SELECT is((SELECT state FROM review_sms_campaign_attempts WHERE id=pg_temp.retry()),'accepted','actual provider outcome survives cancellation');
SELECT ok((SELECT campaign_id IS NULL AND cancel_at IS NOT NULL FROM review_sms_accounts WHERE id=pg_temp.account()),'canceled account campaign and decision stay unchanged');
UPDATE review_sms_accounts SET cancel_at=NULL WHERE id=pg_temp.account();
SELECT is((review_sms_finish_campaign_attempt(pg_temp.retry(),pg_temp.claim(),'accepted','candidate118',NULL,pg_temp.filing(true)||'{"campaignId":"candidate118"}')->>'attached')::boolean,true,'verified live claim can atomically attach exact retry outcome');
SELECT ok((SELECT a.campaign_id='candidate118' AND b.telnyx_campaign_id='candidate118' AND a.provider_submitted_at IS NOT NULL
 FROM review_sms_accounts a JOIN businesses b ON b.id=a.business_id WHERE a.id=pg_temp.account()),'business and review account commit matching campaign bindings');
SELECT is((SELECT state FROM shared_brand_campaign_reservations WHERE id=pg_temp.original()),'unknown','successful retry still retains the original ambiguous slot');
UPDATE businesses SET campaign_status='approved' WHERE id=pg_temp.target();
SELECT lives_ok($$SELECT review_sms_finish_campaign_attempt(pg_temp.retry(),pg_temp.claim(),'accepted','candidate118',NULL,pg_temp.filing(true)||'{"campaignId":"candidate118"}')$$,'accepted evidence can be replayed after a carrier callback');
SELECT is((SELECT campaign_status FROM businesses WHERE id=pg_temp.target()),'approved','accepted replay preserves newer carrier status');
SELECT is((review_sms_finish_campaign_attempt(pg_temp.retry(),pg_temp.claim(),'unknown',NULL,'{"message":"stale failure"}')->>'state'),'accepted','late failure cannot overwrite accepted evidence');
SELECT is((SELECT activation_payment_intent_id FROM review_sms_accounts WHERE id=pg_temp.account()),'pi_campaign118','original activation receipt remains unchanged');
SELECT is((SELECT telnyx_brand_id FROM businesses WHERE id=pg_temp.source()),pg_temp.brand(),'source brand and account remain untouched');
SELECT * FROM finish();
ROLLBACK;
