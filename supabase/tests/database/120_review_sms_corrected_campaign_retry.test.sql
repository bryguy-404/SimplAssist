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
 'optoutKeywords','STOP,STOPALL,STOP ALL,UNSUBSCRIBE,CANCEL,END,QUIT,REVOKE,OPT OUT',
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
SELECT ok(review_sms_reserve_campaign_submission(pg_temp.target(),pg_temp.claim()),'initial provider attempt is retained');
SELECT record_shared_brand_campaign(pg_temp.target(),pg_temp.original(),repeat('a',64),NULL,'unknown');
UPDATE review_sms_accounts SET provisioning_claim=NULL,provisioning_lease_until=NULL WHERE id=pg_temp.account();
CREATE TEMP TABLE prior120 AS SELECT review_sms_authorize_campaign_retry(pg_temp.target(),pg_temp.account(),pg_temp.owner(),pg_temp.owner(),pg_temp.original(),1,pg_temp.filing(),pg_temp.filing(true),repeat('b',64)) value;
CREATE FUNCTION pg_temp.prior() RETURNS uuid LANGUAGE sql AS $$SELECT (value->>'attempt_id')::uuid FROM prior120$$;
UPDATE review_sms_accounts SET provisioning_claim=pg_temp.claim(),provisioning_lease_until=now()+interval '10 minutes' WHERE id=pg_temp.account();
SELECT review_sms_begin_campaign_retry(pg_temp.target(),pg_temp.prior(),(SELECT (value->>'token')::uuid FROM prior120),pg_temp.claim(),ARRAY['source118','external118'],now());
CREATE FUNCTION pg_temp.diagnostics() RETURNS jsonb LANGUAGE sql AS $$SELECT '{"phase":"submit","status":400,"requestId":"synthetic-120-request","providerErrors":[{"code":"10015","title":"Bad Request","detail":"Keywords must be alphanumeric comma(,) separated without space."}]}'::jsonb$$;
SELECT review_sms_finish_campaign_attempt(pg_temp.prior(),pg_temp.claim(),'unknown',NULL,pg_temp.diagnostics());
UPDATE review_sms_accounts SET provisioning_claim=NULL,provisioning_lease_until=NULL WHERE id=pg_temp.account();
CREATE FUNCTION pg_temp.corrected() RETURNS jsonb LANGUAGE sql AS $$SELECT pg_temp.filing(true)||jsonb_build_object('referenceId','reviews:'||pg_temp.account()||':r2','optoutKeywords','STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT,REVOKE')$$;
CREATE FUNCTION pg_temp.authorize(filing jsonb DEFAULT pg_temp.corrected(),actor uuid DEFAULT pg_temp.owner()) RETURNS jsonb LANGUAGE sql AS $$SELECT review_sms_authorize_corrected_campaign_retry(pg_temp.target(),pg_temp.account(),pg_temp.owner(),actor,pg_temp.prior(),1,filing,repeat('c',64))$$;
CREATE TEMP TABLE baseline120 AS SELECT
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY attempt_number) FROM review_sms_campaign_attempts t WHERE account_id=pg_temp.account()) attempts,
 (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM shared_brand_campaign_reservations r WHERE business_id=pg_temp.target()) reservations,
 (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM review_sms_billing_operations o WHERE account_id=pg_temp.account()) billing,
 (SELECT to_jsonb(a) FROM review_sms_accounts a WHERE id=pg_temp.account()) account,
 (SELECT to_jsonb(b) FROM businesses b WHERE id=pg_temp.source()) source;
SELECT ok(NOT has_function_privilege('anon','review_sms_authorize_corrected_campaign_retry(uuid,uuid,uuid,uuid,uuid,bigint,jsonb,text)','EXECUTE'),'anonymous callers cannot authorize correction');
SELECT ok(NOT has_function_privilege('authenticated','review_sms_authorize_corrected_campaign_retry(uuid,uuid,uuid,uuid,uuid,bigint,jsonb,text)','EXECUTE'),'owners cannot bypass administrator authorization');
SELECT ok(has_function_privilege('service_role','review_sms_authorize_corrected_campaign_retry(uuid,uuid,uuid,uuid,uuid,bigint,jsonb,text)','EXECUTE'),'authenticated administrator adapter has service capability');
SELECT throws_ok($$SELECT review_sms_authorize_corrected_campaign_retry(pg_temp.source(),pg_temp.account(),pg_temp.owner(),pg_temp.owner(),pg_temp.prior(),1,pg_temp.corrected(),repeat('c',64))$$,'P0001','review_sms_campaign_retry_not_authorized','only exact Bryan pilot may authorize correction');
SELECT throws_ok($$SELECT pg_temp.authorize(pg_temp.corrected(),gen_random_uuid())$$,'P0001','review_sms_campaign_retry_not_authorized','original authorizing administrator must approve correction');
SELECT throws_ok($$SELECT review_sms_authorize_corrected_campaign_retry(pg_temp.target(),pg_temp.account(),gen_random_uuid(),pg_temp.owner(),pg_temp.prior(),1,pg_temp.corrected(),repeat('c',64))$$,'P0001','review_sms_campaign_retry_changed','expected owner binding is enforced');
SELECT throws_ok($$SELECT review_sms_authorize_corrected_campaign_retry(pg_temp.target(),pg_temp.account(),pg_temp.owner(),pg_temp.owner(),pg_temp.prior(),2,pg_temp.corrected(),repeat('c',64))$$,'P0001','review_sms_campaign_retry_changed','membership revision cannot drift');
SELECT throws_ok($$SELECT review_sms_authorize_corrected_campaign_retry(pg_temp.target(),pg_temp.account(),pg_temp.owner(),pg_temp.owner(),(SELECT id FROM review_sms_campaign_attempts WHERE account_id=pg_temp.account() AND attempt_number=1),1,pg_temp.corrected(),repeat('c',64))$$,'P0001','review_sms_campaign_retry_not_authorized','original unknown attempt does not supply rejection proof');
SELECT throws_ok($$SELECT pg_temp.authorize(pg_temp.corrected()||'{"description":"Changed marketing"}')$$,'P0001','review_sms_campaign_retry_filing_changed','unrelated filing fields cannot change');
SELECT throws_ok($$SELECT pg_temp.authorize(pg_temp.corrected()||'{"optoutKeywords":"STOP,STOPALL"}')$$,'P0001','review_sms_campaign_retry_filing_changed','arbitrary keyword removal is forbidden');
SELECT throws_ok($$SELECT pg_temp.authorize(pg_temp.corrected()||'{"referenceId":"reviews:other:r2"}')$$,'P0001','review_sms_campaign_retry_filing_changed','reference must identify the exact next attempt');
UPDATE review_sms_campaign_attempts SET diagnostics=pg_temp.diagnostics()||'{"status":500}' WHERE id=pg_temp.prior();
SELECT throws_ok($$SELECT pg_temp.authorize()$$,'P0001','review_sms_campaign_retry_filing_changed','server uncertainty is not the required keyword rejection');
UPDATE review_sms_campaign_attempts SET diagnostics=jsonb_set(pg_temp.diagnostics(),'{providerErrors}',(pg_temp.diagnostics()->'providerErrors')||'[{"code":"other","detail":"Additional rejection"}]'::jsonb) WHERE id=pg_temp.prior();
SELECT throws_ok($$SELECT pg_temp.authorize()$$,'P0001','review_sms_campaign_retry_filing_changed','additional provider errors require separate review');
UPDATE review_sms_campaign_attempts SET diagnostics=jsonb_set(pg_temp.diagnostics(),'{providerErrors}','{}'::jsonb) WHERE id=pg_temp.prior();
SELECT throws_ok($$SELECT pg_temp.authorize()$$,'P0001','review_sms_campaign_retry_filing_changed','nonarray error evidence fails closed');
UPDATE review_sms_campaign_attempts SET diagnostics=pg_temp.diagnostics()-'requestId' WHERE id=pg_temp.prior();
SELECT throws_ok($$SELECT pg_temp.authorize()$$,'P0001','review_sms_campaign_retry_filing_changed','missing provider request evidence fails closed');
UPDATE review_sms_campaign_attempts SET diagnostics=pg_temp.diagnostics()||'{"providerErrors":[{"code":"10015","detail":"Other validation"}]}' WHERE id=pg_temp.prior();
SELECT throws_ok($$SELECT pg_temp.authorize()$$,'P0001','review_sms_campaign_retry_filing_changed','another validation reason is insufficient');
UPDATE review_sms_campaign_attempts SET diagnostics=pg_temp.diagnostics(),response_campaign_id='possibly-created120' WHERE id=pg_temp.prior();
SELECT throws_ok($$SELECT pg_temp.authorize()$$,'P0001','review_sms_campaign_retry_filing_changed','a returned campaign identifier prevents another submission');
UPDATE review_sms_campaign_attempts SET response_campaign_id=NULL WHERE id=pg_temp.prior();
UPDATE review_sms_accounts SET activation_refunded_at=now() WHERE id=pg_temp.account();
SELECT throws_ok($$SELECT pg_temp.authorize()$$,'P0001','review_sms_campaign_retry_changed','original activation refund blocks correction');
UPDATE review_sms_accounts SET activation_refunded_at=NULL WHERE id=pg_temp.account();
UPDATE subscriptions SET cancel_at_period_end=true WHERE business_id=pg_temp.target();
SELECT throws_ok($$SELECT pg_temp.authorize()$$,'P0001','review_sms_campaign_retry_changed','base cancellation blocks correction');
UPDATE subscriptions SET cancel_at_period_end=false WHERE business_id=pg_temp.target();
UPDATE review_sms_accounts SET messaging_profile_id='different120' WHERE id=pg_temp.account();
SELECT throws_ok($$SELECT pg_temp.authorize()$$,'P0001','review_sms_campaign_retry_changed','substituting a messaging profile fails');
UPDATE review_sms_accounts SET messaging_profile_id='118-profile',provisioning_claim=pg_temp.claim(),provisioning_lease_until=now()+interval '1 minute' WHERE id=pg_temp.account();
SELECT throws_ok($$SELECT pg_temp.authorize()$$,'P0001','review_sms_campaign_retry_changed','worker ownership excludes administrator preparation');
UPDATE review_sms_accounts SET provisioning_claim=NULL,provisioning_lease_until=NULL WHERE id=pg_temp.account();
CREATE TEMP TABLE correction120 AS SELECT pg_temp.authorize() value;
CREATE FUNCTION pg_temp.third() RETURNS uuid LANGUAGE sql AS $$SELECT (value->>'attempt_id')::uuid FROM correction120$$;
CREATE FUNCTION pg_temp.old_token() RETURNS uuid LANGUAGE sql AS $$SELECT (value->>'token')::uuid FROM correction120$$;
SELECT is((SELECT attempt_number FROM review_sms_campaign_attempts WHERE id=pg_temp.third()),3,'one separately identifiable correction is prepared');
SELECT is((SELECT predecessor_attempt_id FROM review_sms_campaign_attempts WHERE id=pg_temp.third()),pg_temp.prior(),'correction records its exact rejected predecessor');
SELECT is((SELECT authorization_revision FROM review_sms_campaign_attempts WHERE id=pg_temp.third()),1::bigint,'new capability begins at revision one');
SELECT is((SELECT to_jsonb(a) FROM review_sms_accounts a WHERE id=pg_temp.account()),(SELECT account FROM baseline120),'preparation does not modify account, billing or attempt count');
SELECT throws_ok($$SELECT pg_temp.authorize()$$,'P0001','review_sms_campaign_retry_already_authorized','replayed approval cannot create a fourth provider opportunity');
SELECT throws_ok($$UPDATE review_sms_campaign_attempts SET predecessor_attempt_id=gen_random_uuid() WHERE id=pg_temp.third()$$,'P0001','review_sms_campaign_attempt_snapshot_immutable','approved predecessor is immutable');
SELECT throws_ok($$UPDATE review_sms_campaign_attempts SET filing=filing||'{"optoutKeywords":"STOP"}' WHERE id=pg_temp.third()$$,'P0001','review_sms_campaign_attempt_snapshot_immutable','corrected filing freezes at approval');
SELECT throws_ok($$SELECT review_sms_refresh_campaign_retry_authorization(pg_temp.target(),pg_temp.third(),gen_random_uuid(),1)$$,'P0001','review_sms_campaign_retry_not_authorized','only original administrator can renew unused capability');
UPDATE review_sms_campaign_attempts SET authorization_expires_at=now()-interval '1 minute' WHERE id=pg_temp.third();
CREATE TEMP TABLE refreshed120 AS SELECT review_sms_refresh_campaign_retry_authorization(pg_temp.target(),pg_temp.third(),pg_temp.owner(),1) value;
CREATE FUNCTION pg_temp.token() RETURNS uuid LANGUAGE sql AS $$SELECT (value->>'token')::uuid FROM refreshed120$$;
SELECT is((SELECT (value->>'authorization_revision')::bigint FROM refreshed120),2::bigint,'safe timestamp/token refresh supports unused third attempt');
SELECT throws_ok($$SELECT review_sms_refresh_campaign_retry_authorization(pg_temp.target(),pg_temp.third(),pg_temp.owner(),1)$$,'P0001','review_sms_campaign_retry_revision_changed','stale refresh cannot invalidate replacement capability');
UPDATE review_sms_accounts SET provisioning_claim=pg_temp.claim(),provisioning_lease_until=now()+interval '10 minutes' WHERE id=pg_temp.account();
CREATE FUNCTION pg_temp.begin_third(inventory text[] DEFAULT ARRAY['source118','external118'],verified_at timestamptz DEFAULT now()) RETURNS jsonb LANGUAGE sql AS $$SELECT review_sms_begin_campaign_retry(pg_temp.target(),pg_temp.third(),pg_temp.token(),pg_temp.claim(),inventory,verified_at)$$;
SELECT throws_ok($$SELECT review_sms_begin_campaign_retry(pg_temp.target(),pg_temp.third(),pg_temp.old_token(),pg_temp.claim(),ARRAY['source118','external118'],now())$$,'P0001','review_sms_campaign_retry_not_authorized','superseded capability cannot send');
SELECT throws_ok($$SELECT pg_temp.begin_third(ARRAY['source118','external118','third-existing'])$$,'P0001','shared_brand_campaign_capacity','both earlier unknown reservations retain capacity');
SELECT throws_ok($$SELECT pg_temp.begin_third(ARRAY['source118','external118'],now()-interval '6 minutes')$$,'P0001','shared_campaign_inventory_required','fresh provider inventory is mandatory');
UPDATE review_sms_campaign_attempts SET diagnostics=pg_temp.diagnostics()||'{"status":503}' WHERE id=pg_temp.prior();
SELECT throws_ok($$SELECT pg_temp.begin_third()$$,'P0001','review_sms_campaign_retry_changed','rejection evidence is revalidated immediately before consume');
UPDATE review_sms_campaign_attempts SET diagnostics=pg_temp.diagnostics() WHERE id=pg_temp.prior();
UPDATE review_sms_accounts SET cancel_at=now() WHERE id=pg_temp.account();
SELECT throws_ok($$SELECT pg_temp.begin_third()$$,'P0001','review_sms_campaign_retry_changed','cancellation wins before provider submission');
UPDATE review_sms_accounts SET cancel_at=NULL WHERE id=pg_temp.account();
SELECT is((pg_temp.begin_third()->>'submit')::boolean,true,'corrected capability authorizes exactly one provider attempt');
SELECT is((pg_temp.begin_third()->>'submit')::boolean,false,'double click cannot purchase another provider attempt');
SELECT is((SELECT provider_attempt_count FROM review_sms_accounts WHERE id=pg_temp.account()),3,'provider count accumulates without resetting either earlier attempt');
SELECT is((SELECT count(*)::int FROM review_sms_campaign_attempts WHERE account_id=pg_temp.account()),3,'there are exactly three durable attempts');
SELECT throws_ok($$SELECT pg_temp.authorize()$$,'P0001','review_sms_campaign_retry_changed','consumed count-three account cannot authorize another correction');
SELECT is((SELECT count(*)::int FROM shared_brand_campaign_reservations WHERE business_id=pg_temp.target()),3,'each attempt retains a separate capacity reservation');
SELECT is((SELECT operation_id FROM shared_brand_campaign_reservations WHERE id=(SELECT reservation_id FROM review_sms_campaign_attempts WHERE id=pg_temp.third())),pg_temp.third(),'third reservation belongs to its exact attempt');
SELECT ok(NOT review_sms_reserve_campaign_submission(pg_temp.target(),pg_temp.claim()),'normal worker cannot restart initial paid submission');
SELECT throws_ok($$UPDATE review_sms_accounts SET provider_attempt_count=4 WHERE id=pg_temp.account()$$,'23514',NULL,'counter cannot exceed the one additional approved attempt');
SELECT throws_ok($$UPDATE review_sms_campaign_attempts SET authorization_consumed_at=NULL WHERE id=pg_temp.third()$$,'P0001','review_sms_campaign_attempt_authority_immutable','consumed third authority cannot be restored');
SELECT throws_ok($$SELECT review_sms_refresh_campaign_retry_authorization(pg_temp.target(),pg_temp.third(),pg_temp.owner(),2)$$,'P0001','review_sms_campaign_retry_changed','consumed third capability is nonrenewable');
SELECT throws_ok($$SELECT review_sms_finish_campaign_attempt(pg_temp.third(),pg_temp.claim(),'accepted','candidate120',NULL,pg_temp.filing(true)||'{"campaignId":"candidate120"}')$$,'P0001','review_sms_campaign_evidence_mismatch','previous filing is not accepted as corrected campaign proof');
CREATE FUNCTION pg_temp.late_original_probe() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb;BEGIN
 BEGIN
  result:=review_sms_finish_campaign_attempt((SELECT id FROM review_sms_campaign_attempts WHERE account_id=pg_temp.account() AND attempt_number=1),pg_temp.claim(),'accepted','late-original120',NULL,pg_temp.filing()||'{"campaignId":"late-original120"}');
  result:=result||jsonb_build_object('recorded',(SELECT state='bound' FROM shared_brand_campaign_reservations WHERE id=pg_temp.original()),
   'unattached',(SELECT campaign_id IS NULL FROM review_sms_accounts WHERE id=pg_temp.account()));
  RAISE EXCEPTION 'rollback original probe' USING ERRCODE='ZY120';
 EXCEPTION WHEN SQLSTATE 'ZY120' THEN NULL;END;
 RETURN result;
END $$;
CREATE TEMP TABLE late_original120 AS SELECT pg_temp.late_original_probe() value;
SELECT ok((SELECT value->>'recorded'='true' AND value->>'unattached'='true' AND value->>'attached'='false' FROM late_original120),'late original evidence cannot displace consumed correction');
CREATE FUNCTION pg_temp.late_prior_probe() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb;BEGIN
 BEGIN
  result:=review_sms_finish_campaign_attempt(pg_temp.prior(),pg_temp.claim(),'accepted','late-prior120',NULL,pg_temp.filing(true)||'{"campaignId":"late-prior120"}');
  result:=result||jsonb_build_object('recorded',(SELECT state='bound' FROM shared_brand_campaign_reservations WHERE id=(SELECT reservation_id FROM review_sms_campaign_attempts WHERE id=pg_temp.prior())),
   'unattached',(SELECT campaign_id IS NULL FROM review_sms_accounts WHERE id=pg_temp.account()));
  RAISE EXCEPTION 'rollback prior probe' USING ERRCODE='ZX120';
 EXCEPTION WHEN SQLSTATE 'ZX120' THEN NULL;END;
 RETURN result;
END $$;
CREATE TEMP TABLE late120 AS SELECT pg_temp.late_prior_probe() value;
SELECT ok((SELECT value->>'recorded'='true' AND value->>'unattached'='true' AND value->>'attached'='false' FROM late120),'late predecessor evidence is retained but cannot displace consumed correction');
UPDATE review_sms_accounts SET cancel_at=now() WHERE id=pg_temp.account();
SELECT is((review_sms_finish_campaign_attempt(pg_temp.third(),pg_temp.claim(),'accepted','candidate120',NULL,pg_temp.corrected()||'{"campaignId":"candidate120"}')->>'attached')::boolean,false,'late accepted correction never revives canceled account');
SELECT ok((SELECT campaign_id IS NULL AND cancel_at IS NOT NULL FROM review_sms_accounts WHERE id=pg_temp.account()),'cancellation and campaign binding stay unchanged');
UPDATE review_sms_accounts SET cancel_at=NULL WHERE id=pg_temp.account();
SELECT is((review_sms_finish_campaign_attempt(pg_temp.third(),pg_temp.claim(),'accepted','candidate120',NULL,pg_temp.corrected()||'{"campaignId":"candidate120"}')->>'attached')::boolean,true,'newest consumed correction may attach exact verified campaign');
UPDATE businesses SET campaign_status='approved' WHERE id=pg_temp.target();
SELECT lives_ok($$SELECT review_sms_finish_campaign_attempt(pg_temp.third(),pg_temp.claim(),'accepted','candidate120',NULL,pg_temp.corrected()||'{"campaignId":"candidate120"}')$$,'accepted correction can reconcile after carrier approval');
SELECT is((SELECT campaign_status FROM businesses WHERE id=pg_temp.target()),'approved','reconciliation does not overwrite newer carrier status');
SELECT is((SELECT jsonb_agg(to_jsonb(t) ORDER BY attempt_number) FROM review_sms_campaign_attempts t WHERE account_id=pg_temp.account() AND attempt_number<3),(SELECT attempts FROM baseline120),'both earlier attempt records remain byte-for-byte unchanged');
SELECT is((SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM shared_brand_campaign_reservations r WHERE business_id=pg_temp.target() AND operation_id IN(pg_temp.account(),pg_temp.prior())),(SELECT reservations FROM baseline120),'both earlier unknown reservations remain byte-for-byte unchanged');
SELECT is((SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM review_sms_billing_operations o WHERE account_id=pg_temp.account()),(SELECT billing FROM baseline120),'correction creates no Stripe operation or altered receipt');
SELECT is((SELECT to_jsonb(b) FROM businesses b WHERE id=pg_temp.source()),(SELECT source FROM baseline120),'existing SimplAssist source stays unchanged');
SELECT ok((SELECT phone_number_id='60000000-0000-4000-a118-000000000001'::uuid AND messaging_profile_id='118-profile' AND voice_application_id='118-voice' AND activation_payment_intent_id='pi_campaign118' FROM review_sms_accounts WHERE id=pg_temp.account()),'same phone, profile, voice application and original payment retained');
SELECT * FROM finish();
ROLLBACK;
