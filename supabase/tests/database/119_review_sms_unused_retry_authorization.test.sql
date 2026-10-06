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
SELECT ok(review_sms_reserve_campaign_submission(pg_temp.target(),pg_temp.claim()),'fixture retains its original consumed submission fence');
SELECT record_shared_brand_campaign(pg_temp.target(),pg_temp.original(),repeat('a',64),NULL,'unknown');
UPDATE review_sms_accounts SET provisioning_claim=NULL,provisioning_lease_until=NULL WHERE id=pg_temp.account();
CREATE TEMP TABLE authorization119 AS SELECT review_sms_authorize_campaign_retry(pg_temp.target(),pg_temp.account(),pg_temp.owner(),pg_temp.owner(),pg_temp.original(),1,pg_temp.filing(),pg_temp.filing(true),repeat('b',64)) value;
CREATE FUNCTION pg_temp.retry() RETURNS uuid LANGUAGE sql AS $$SELECT (value->>'attempt_id')::uuid FROM authorization119$$;
CREATE FUNCTION pg_temp.old_token() RETURNS uuid LANGUAGE sql AS $$SELECT (value->>'token')::uuid FROM authorization119$$;
CREATE FUNCTION pg_temp.refresh(revision bigint DEFAULT 1, actor uuid DEFAULT pg_temp.owner()) RETURNS jsonb LANGUAGE sql AS $$
 SELECT review_sms_refresh_campaign_retry_authorization(pg_temp.target(),pg_temp.retry(),actor,revision)$$;
CREATE TEMP TABLE baseline119 AS SELECT
 (SELECT to_jsonb(a)-ARRAY['authorization_token_hash','authorization_expires_at','authorization_revision','authorization_refreshed_at','updated_at'] FROM review_sms_campaign_attempts a WHERE id=pg_temp.retry()) attempt,
 (SELECT to_jsonb(a) FROM review_sms_accounts a WHERE id=pg_temp.account()) account,
 (SELECT to_jsonb(r) FROM shared_brand_campaign_reservations r WHERE id=pg_temp.original()) reservation,
 (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM review_sms_billing_operations o WHERE account_id=pg_temp.account()) billing;
SELECT ok(NOT has_function_privilege('anon','review_sms_refresh_campaign_retry_authorization(uuid,uuid,uuid,bigint)','EXECUTE'),'anonymous callers cannot rotate capabilities');
SELECT ok(NOT has_function_privilege('authenticated','review_sms_refresh_campaign_retry_authorization(uuid,uuid,uuid,bigint)','EXECUTE'),'account owners cannot rotate capabilities');
SELECT ok(has_function_privilege('service_role','review_sms_refresh_campaign_retry_authorization(uuid,uuid,uuid,bigint)','EXECUTE'),'authenticated administrator adapter may use service RPC');
SELECT throws_ok($$SELECT review_sms_refresh_campaign_retry_authorization(pg_temp.source(),pg_temp.retry(),pg_temp.owner(),1)$$,'P0001','review_sms_campaign_retry_not_authorized','another account cannot enter pilot recovery');
SELECT throws_ok($$SELECT pg_temp.refresh(1,gen_random_uuid())$$,'P0001','review_sms_campaign_retry_not_authorized','only the originally authorizing administrator can refresh');
SELECT throws_ok($$SELECT pg_temp.refresh(2)$$,'P0001','review_sms_campaign_retry_revision_changed','unexpected authorization revision fails closed');
UPDATE review_sms_accounts SET provisioning_claim=pg_temp.claim(),provisioning_lease_until=now()+interval '1 minute' WHERE id=pg_temp.account();
SELECT throws_ok($$SELECT pg_temp.refresh()$$,'P0001','review_sms_campaign_retry_changed','active worker lease prevents capability rotation');
UPDATE review_sms_accounts SET provisioning_claim=NULL,provisioning_lease_until=NULL WHERE id=pg_temp.account();
UPDATE review_sms_accounts SET activation_refunded_at=now() WHERE id=pg_temp.account();
SELECT throws_ok($$SELECT pg_temp.refresh()$$,'P0001','review_sms_campaign_retry_changed','refund blocks capability recovery');
UPDATE review_sms_accounts SET activation_refunded_at=NULL WHERE id=pg_temp.account();
UPDATE subscriptions SET cancel_at_period_end=true WHERE business_id=pg_temp.target();
SELECT throws_ok($$SELECT pg_temp.refresh()$$,'P0001','review_sms_campaign_retry_changed','base cancellation blocks capability recovery');
UPDATE subscriptions SET cancel_at_period_end=false WHERE business_id=pg_temp.target();
UPDATE review_sms_accounts SET messaging_profile_id='wrong119' WHERE id=pg_temp.account();
SELECT throws_ok($$SELECT pg_temp.refresh()$$,'P0001','review_sms_campaign_retry_changed','changed retained resource identity blocks capability recovery');
UPDATE review_sms_accounts SET messaging_profile_id='118-profile' WHERE id=pg_temp.account();
UPDATE shared_business_registration_members SET revision=revision+1 WHERE business_id=pg_temp.target();
SELECT throws_ok($$SELECT pg_temp.refresh()$$,'P0001','review_sms_campaign_retry_changed','membership revision drift blocks capability recovery');
UPDATE shared_business_registration_members SET revision=revision-1 WHERE business_id=pg_temp.target();
UPDATE review_sms_campaign_attempts SET response_campaign_id='observed119' WHERE id=pg_temp.retry();
SELECT throws_ok($$SELECT pg_temp.refresh()$$,'P0001','review_sms_campaign_retry_changed','even unverified provider response evidence forbids refresh');
UPDATE review_sms_campaign_attempts SET response_campaign_id=NULL WHERE id=pg_temp.retry();
UPDATE review_sms_campaign_attempts SET state='unknown' WHERE id=pg_temp.retry();
SELECT throws_ok($$SELECT pg_temp.refresh()$$,'P0001','review_sms_campaign_retry_changed','unknown attempt can never be renewed as an unused authorization');
UPDATE review_sms_campaign_attempts SET state='accepted' WHERE id=pg_temp.retry();
SELECT throws_ok($$SELECT pg_temp.refresh()$$,'P0001','review_sms_campaign_retry_changed','accepted attempt cannot be renewed');
UPDATE review_sms_campaign_attempts SET state='prepared' WHERE id=pg_temp.retry();
SELECT throws_ok($$UPDATE review_sms_campaign_attempts SET authorization_token_hash=repeat('c',64) WHERE id=pg_temp.retry()$$,'P0001','review_sms_campaign_attempt_authority_immutable','hash cannot change without revisioned eligible rotation');
SELECT throws_ok($$UPDATE review_sms_campaign_attempts SET filing=filing||'{"description":"Changed"}' WHERE id=pg_temp.retry()$$,'P0001','review_sms_campaign_attempt_snapshot_immutable','filing remains immutable during recovery');
-- An expired but demonstrably unused capability may be replaced; the provider
-- application, payment receipt and uncertain original never change.
UPDATE review_sms_campaign_attempts SET authorization_expires_at=now()-interval '1 minute' WHERE id=pg_temp.retry();
CREATE TEMP TABLE refreshed119 AS SELECT pg_temp.refresh() value;
CREATE FUNCTION pg_temp.new_token() RETURNS uuid LANGUAGE sql AS $$SELECT (value->>'token')::uuid FROM refreshed119$$;
SELECT is((SELECT (value->>'attempt_id')::uuid FROM refreshed119),pg_temp.retry(),'refresh returns the same original retry attempt');
SELECT is((SELECT (value->>'authorization_revision')::bigint FROM refreshed119),2::bigint,'refresh advances authorization revision once');
SELECT ok(pg_temp.new_token()<>pg_temp.old_token(),'fresh authorization uses a different secret token');
SELECT is((SELECT authorization_expires_at FROM review_sms_campaign_attempts WHERE id=pg_temp.retry()),now()+interval '15 minutes','unused authorization receives a bounded fifteen minute expiry');
SELECT is((SELECT authorization_refreshed_at FROM review_sms_campaign_attempts WHERE id=pg_temp.retry()),now(),'refresh is timestamped in the journal');
SELECT throws_ok($$SELECT pg_temp.refresh()$$,'P0001','review_sms_campaign_retry_revision_changed','replayed rotation cannot invalidate the new capability');
SELECT is((SELECT to_jsonb(a)-ARRAY['authorization_token_hash','authorization_expires_at','authorization_revision','authorization_refreshed_at','updated_at'] FROM review_sms_campaign_attempts a WHERE id=pg_temp.retry()),(SELECT attempt FROM baseline119),'refresh preserves every frozen attempt and provider field');
SELECT is((SELECT to_jsonb(a) FROM review_sms_accounts a WHERE id=pg_temp.account()),(SELECT account FROM baseline119),'refresh changes no account billing, resources, usage or attempt counter');
SELECT is((SELECT to_jsonb(r) FROM shared_brand_campaign_reservations r WHERE id=pg_temp.original()),(SELECT reservation FROM baseline119),'original unknown reservation remains byte-for-byte unchanged');
SELECT is((SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM review_sms_billing_operations o WHERE account_id=pg_temp.account()),(SELECT billing FROM baseline119),'no new billing operation or changed payment evidence');
SELECT is((SELECT count(*)::int FROM review_sms_campaign_attempts WHERE account_id=pg_temp.account()),2,'refresh creates no additional attempt');
SELECT is((SELECT count(*)::int FROM shared_brand_campaign_reservations WHERE business_id=pg_temp.target()),1,'refresh reserves no additional capacity before consume');
UPDATE review_sms_accounts SET provisioning_claim=pg_temp.claim(),provisioning_lease_until=now()+interval '10 minutes' WHERE id=pg_temp.account();
SELECT throws_ok($$SELECT review_sms_begin_campaign_retry(pg_temp.target(),pg_temp.retry(),pg_temp.old_token(),pg_temp.claim(),ARRAY['source118','external118'],now())$$,'P0001','review_sms_campaign_retry_not_authorized','old capability cannot start a provider submission after rotation');
CREATE FUNCTION pg_temp.begin_new() RETURNS jsonb LANGUAGE sql AS $$SELECT review_sms_begin_campaign_retry(pg_temp.target(),pg_temp.retry(),pg_temp.new_token(),pg_temp.claim(),ARRAY['source118','external118'],now())$$;
SELECT is((pg_temp.begin_new()->>'submit')::boolean,true,'new capability authorizes exactly the same single retry');
SELECT is((pg_temp.begin_new()->>'submit')::boolean,false,'replayed new capability cannot purchase a third campaign');
SELECT is((SELECT provider_attempt_count FROM review_sms_accounts WHERE id=pg_temp.account()),2,'only actual consume advances provider attempt count');
UPDATE review_sms_accounts SET provisioning_claim=NULL,provisioning_lease_until=NULL WHERE id=pg_temp.account();
SELECT throws_ok($$SELECT pg_temp.refresh(2)$$,'P0001','review_sms_campaign_retry_changed','begun attempt cannot rotate even after worker lease is released');
SELECT throws_ok($$UPDATE review_sms_campaign_attempts SET authorization_token_hash=repeat('d',64),authorization_revision=3,authorization_refreshed_at=now(),authorization_expires_at=now()+interval '15 minutes' WHERE id=pg_temp.retry()$$,'P0001','review_sms_campaign_attempt_authority_immutable','direct updates cannot rotate consumed authority');
SELECT lives_ok($$SELECT review_sms_finish_campaign_attempt(pg_temp.retry(),pg_temp.claim(),'unknown',NULL,'{"message":"Synthetic uncertain result"}')$$,'the started attempt may preserve a real uncertain result');
SELECT throws_ok($$SELECT pg_temp.refresh(2)$$,'P0001','review_sms_campaign_retry_changed','actual unknown result stays nonrenewable');
SELECT lives_ok($$SELECT review_sms_finish_campaign_attempt(pg_temp.retry(),pg_temp.claim(),'accepted','candidate119',NULL,pg_temp.filing(true)||'{"campaignId":"candidate119"}')$$,'exact later provider evidence can still settle the same operation');
SELECT throws_ok($$SELECT pg_temp.refresh(2)$$,'P0001','review_sms_campaign_retry_changed','actual accepted outcome stays nonrenewable');
SELECT is((SELECT state FROM shared_brand_campaign_reservations WHERE id=pg_temp.original()),'unknown','even successful retry recovery does not erase original uncertainty');
SELECT * FROM finish();
ROLLBACK;
