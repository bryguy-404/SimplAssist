BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();
CREATE FUNCTION pg_temp.source() RETURNS uuid LANGUAGE sql AS $$ SELECT '10000000-0000-4000-a116-000000000001'::uuid $$;
CREATE FUNCTION pg_temp.target() RETURNS uuid LANGUAGE sql AS $$ SELECT '10000000-0000-4000-a116-000000000002'::uuid $$;
CREATE FUNCTION pg_temp.owner() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-4000-a116-000000000001'::uuid $$;
CREATE FUNCTION pg_temp.account() RETURNS uuid LANGUAGE sql AS $$ SELECT '30000000-0000-4000-a116-000000000001'::uuid $$;
CREATE FUNCTION pg_temp.claim() RETURNS uuid LANGUAGE sql AS $$ SELECT '40000000-0000-4000-a116-000000000001'::uuid $$;
CREATE FUNCTION pg_temp.brand() RETURNS text LANGUAGE sql AS $$ SELECT '11600000-0000-4000-8116-000000000001' $$;
CREATE FUNCTION pg_temp.group_id() RETURNS uuid LANGUAGE sql AS $$ SELECT shared_registration_id FROM businesses WHERE id=pg_temp.source() $$;
CREATE FUNCTION pg_temp.revision() RETURNS bigint LANGUAGE sql AS $$ SELECT revision FROM shared_business_registration_members WHERE business_id=pg_temp.target() $$;
CREATE FUNCTION pg_temp.approve(revision bigint DEFAULT 0) RETURNS uuid LANGUAGE sql AS $$
 SELECT approve_shared_review_brand_member(pg_temp.source(),pg_temp.target(),pg_temp.owner(),pg_temp.owner(),pg_temp.owner(),revision,pg_temp.brand(),'B116TEST',to_jsonb(b),now()) FROM businesses b WHERE id=pg_temp.source()
$$;
CREATE FUNCTION pg_temp.proof() RETURNS jsonb LANGUAGE sql AS $$SELECT jsonb_build_object('sharedRegistration',jsonb_build_object('registrationId',pg_temp.group_id(),'identityVersion',1,'membershipRevision',pg_temp.revision(),'brandId',pg_temp.brand()))$$;
CREATE FUNCTION pg_temp.consume() RETURNS boolean LANGUAGE sql AS $$SELECT consume_shared_review_brand_member(pg_temp.target(),pg_temp.owner(),pg_temp.account(),pg_temp.claim(),pg_temp.group_id(),1,pg_temp.revision())$$;
INSERT INTO auth.users(id,email) VALUES(pg_temp.owner(),'shared116@example.test');
INSERT INTO businesses(id,owner_id,name,business_type,slug,billing_mode,onboarding_completed_at,ein,has_ein,legal_business_name,business_entity_type,business_registration_state,address,city,state,zip,telnyx_brand_id,telnyx_brand_source,brand_status,telnyx_campaign_id)
 VALUES(pg_temp.source(),pg_temp.owner(),'Existing account','general','shared116-source','stripe',now(),'12-3456116',true,'Shared Legal LLC','llc','IN','123 Test Street','South Bend','IN','46601',pg_temp.brand(),'linked_existing','approved','source116');
INSERT INTO businesses(id,owner_id,name,business_type,slug,billing_mode,onboarding_completed_at)
 VALUES(pg_temp.target(),pg_temp.owner(),'Second DBA','general','shared116-target','stripe',now()),('10000000-0000-4000-a116-000000000003',pg_temp.owner(),'Other','general','shared116-other','stripe',now());
INSERT INTO subscriptions(business_id,stripe_customer_id,stripe_subscription_id,plan,status,current_period_start,current_period_end)
 VALUES(pg_temp.source(),'cus_source116','sub_source116','full','active',now()-interval '1 day',now()+interval '29 days'),
 (pg_temp.target(),'cus_target116','sub_target116','chat_only','active',now()-interval '1 day',now()+interval '29 days');
INSERT INTO business_plan_family_locks(business_id,family,claimed_by) VALUES(pg_temp.target(),'chat_only','stripe_sync');
INSERT INTO telnyx_brand_link_requests(business_id,tcr_brand_id,telnyx_brand_id,status,identity_fingerprint,inspected_by,approved_by,approved_at,consumed_at)
 VALUES(pg_temp.source(),'B116TEST',pg_temp.brand(),'consumed',repeat('a',64),'admin116','admin116',now(),now());
INSERT INTO telnyx_managed_resources(business_id,resource_type,provider_id,public_tcr_id,provider_origin)
 VALUES(pg_temp.source(),'brand',pg_temp.brand(),'B116TEST','linked_existing');
SELECT ok(NOT has_function_privilege('authenticated','approve_shared_review_brand_member(uuid,uuid,uuid,uuid,uuid,bigint,text,text,jsonb,timestamptz)','EXECUTE'),'membership approval is service-only');
SELECT ok(NOT has_table_privilege('authenticated','shared_business_registrations','SELECT'),'private registration is not owner-readable');
SELECT ok(shared_brand_sms_allowed(pg_temp.source()),'ordinary account remains unaffected before admission');
SELECT throws_ok($$SELECT approve_shared_review_brand_member(pg_temp.source(),pg_temp.target(),pg_temp.owner(),gen_random_uuid(),pg_temp.owner(),0,pg_temp.brand(),'B116TEST',to_jsonb(b),now()) FROM businesses b WHERE id=pg_temp.source()$$,'P0001','shared_registration_source_changed','exact source owner is mandatory');
SELECT throws_ok($$SELECT approve_shared_review_brand_member(pg_temp.source(),pg_temp.target(),pg_temp.owner(),pg_temp.owner(),pg_temp.owner(),0,pg_temp.brand(),'B116TEST',to_jsonb(b),now()-interval '6 minutes') FROM businesses b WHERE id=pg_temp.source()$$,'P0001','shared_registration_inspection_required','stale provider inspection cannot authorize sharing');
SELECT throws_ok($$SELECT approve_shared_review_brand_member(pg_temp.source(),pg_temp.target(),pg_temp.owner(),pg_temp.owner(),pg_temp.owner(),0,pg_temp.brand(),'B116TEST',to_jsonb(b)||'{"city":"Other"}',now()) FROM businesses b WHERE id=pg_temp.source()$$,'P0001','shared_registration_identity_mismatch','full canonical mailing identity must match');
SELECT lives_ok($$SELECT pg_temp.approve()$$,'exact source proof admits fresh completed Chat account');
SELECT is((apply_shared_brand_event(pg_temp.brand(),'pre-admission116',now()-interval '1 minute','rejected','old event')->>'applied')::boolean,false,'stale negative event cannot override fresh admission verification');
SELECT ok(shared_brand_sms_allowed(pg_temp.source()),'stale pre-admission rejection does not interrupt source sender');
SELECT is((SELECT count(*)::int FROM telnyx_managed_resources WHERE resource_type='brand' AND provider_id=pg_temp.brand()),1,'sharing preserves one physical ledger row');
SELECT is((SELECT public_address_visibility FROM businesses WHERE id=pg_temp.target()),'city_state','target street address is private before identity copy');
SELECT is((SELECT telnyx_brand_id FROM businesses WHERE id=pg_temp.target()),NULL,'approval does not bind an unpaid brand');
SELECT is((SELECT telnyx_campaign_id FROM businesses WHERE id=pg_temp.source()),'source116','existing campaign is unchanged');
SELECT is((SELECT ein FROM businesses WHERE id=pg_temp.target()),'12-3456116','approved sibling receives canonical identity');
SELECT ok(shared_brand_sms_allowed(pg_temp.source()),'source active membership preserves approved sending');
SELECT ok(NOT shared_brand_sms_allowed(pg_temp.target()),'unconsumed approval grants no SMS');
SELECT throws_ok($$SELECT pg_temp.approve()$$,'P0001','shared_registration_revision_changed','approval revision prevents stale admin replay');
SELECT throws_ok($$UPDATE businesses SET ein='12-3456116' WHERE id='10000000-0000-4000-a116-000000000003'$$,'23505','shared_registration_approval_required','unrelated EIN reuse remains rejected');
SELECT throws_ok($$UPDATE businesses SET telnyx_brand_id=pg_temp.brand() WHERE id='10000000-0000-4000-a116-000000000003'$$,'23505','shared_registration_approval_required','unrelated brand reuse remains rejected');
SELECT throws_ok($$UPDATE businesses SET address='999 Wrong Street' WHERE id=pg_temp.target()$$,'P0001','shared_registration_identity_locked','legal identity is immutable before consume');
SELECT throws_ok($$UPDATE businesses SET shared_registration_id=NULL WHERE id=pg_temp.target()$$,'P0001','shared_registration_cannot_detach','owner cannot detach identity protection');
SELECT throws_ok($$UPDATE shared_business_registrations SET normalized_ein='123456789' WHERE id=pg_temp.group_id()$$,'P0001','shared_registration_identity_immutable','canonical identity cannot drift behind a paid proof');
SELECT throws_ok($$UPDATE telnyx_managed_resources SET local_claim_active=false WHERE retained_shared_registration_id=pg_temp.group_id()$$,'55000','shared_brand_retained','canonical ledger claim cannot be cleared');
SELECT throws_ok($$DELETE FROM telnyx_managed_resources WHERE retained_shared_registration_id=pg_temp.group_id()$$,'55000','shared_brand_retained','canonical ledger cannot be deleted');
SELECT throws_ok($$UPDATE telnyx_managed_resources SET ownership_state='released' WHERE retained_shared_registration_id=pg_temp.group_id()$$,'55000','shared_brand_retained','canonical ledger cannot be released');
SELECT lives_ok($$SELECT revoke_shared_review_brand_member(pg_temp.target(),pg_temp.owner(),pg_temp.owner(),1,'Unused approval')$$,'unused approval can be revoked');
SELECT is(pg_temp.revision(),2::bigint,'revocation advances approval revision');
SELECT lives_ok($$SELECT pg_temp.approve(2)$$,'fresh admin approval can replace unused revoked approval');
SELECT is(pg_temp.revision(),3::bigint,'reapproval advances revision');
INSERT INTO review_sms_accounts(id,business_id,owner_id,billing_source,state,source_subscription_id,source_customer_id,exclusive_resources,draft)
 VALUES(pg_temp.account(),pg_temp.target(),pg_temp.owner(),'direct','draft','sub_target116','cus_target116',true,'{}');
INSERT INTO review_sms_billing_operations(id,account_id,business_id,owner_id,kind,state,fingerprint,payload)
 VALUES('50000000-0000-4000-a116-000000000001',pg_temp.account(),pg_temp.target(),pg_temp.owner(),'activation','prepared','proof116',pg_temp.proof());
SELECT throws_ok($$SELECT revoke_shared_review_brand_member(pg_temp.target(),pg_temp.owner(),pg_temp.owner(),3,'Payment open')$$,'P0001','shared_registration_approval_in_use','approval cannot be revoked while checkout is unresolved');
UPDATE review_sms_billing_operations SET payload=jsonb_set(payload,'{sharedRegistration,membershipRevision}','1') WHERE account_id=pg_temp.account();
SELECT throws_ok($$SELECT review_sms_confirm_operation('50000000-0000-4000-a116-000000000001',pg_temp.owner(),'proof116')$$,'P0001','shared_registration_approval_changed','old revision cannot authorize payment');
UPDATE review_sms_billing_operations SET payload=pg_temp.proof() WHERE account_id=pg_temp.account();
SELECT lives_ok($$SELECT review_sms_confirm_operation('50000000-0000-4000-a116-000000000001',pg_temp.owner(),'proof116')$$,'frozen current approval permits payment confirmation');
SELECT ok(NOT pg_temp.consume(),'unpaid setup cannot bind shared brand');
UPDATE review_sms_accounts SET state='carrier_pending',activation_paid_at=now(),activation_payment_intent_id='pi_shared116',provisioning_claim=pg_temp.claim(),provisioning_lease_until=now()+interval '10 minutes' WHERE id=pg_temp.account();
SELECT ok(NOT pg_temp.consume(),'paid account without completed exact receipt cannot bind');
UPDATE review_sms_billing_operations SET state='completed',completed_at=now() WHERE account_id=pg_temp.account();
UPDATE subscriptions SET current_period_end=now()-interval '1 hour' WHERE business_id=pg_temp.target();
SELECT ok(NOT pg_temp.consume(),'expired paid base period blocks brand binding');
SELECT ok(NOT review_sms_provisioning_claim_valid(pg_temp.target(),pg_temp.claim()),'expired paid base period fences provider work');
UPDATE subscriptions SET current_period_end=now()+interval '29 days',cancel_at_period_end=true WHERE business_id=pg_temp.target();
SELECT ok(NOT pg_temp.consume(),'pending subscription cancellation blocks new brand binding');
UPDATE subscriptions SET cancel_at_period_end=false WHERE business_id=pg_temp.target();
SELECT ok(pg_temp.consume(),'paid exact frozen proof consumes approval');
SELECT ok(pg_temp.consume(),'retry consumes idempotently');
SELECT is((SELECT provider_started_at FROM review_sms_accounts WHERE id=pg_temp.account()),NULL::timestamptz,'brand reuse never fakes a paid provider operation');
SELECT is((SELECT telnyx_brand_source FROM businesses WHERE id=pg_temp.target()),'linked_existing','bound brand records existing provenance');
SELECT is(infer_business_plan_family(pg_temp.target()),'chat_only','retained shared brand does not change Chat family');
SELECT ok(NOT review_sms_begin_paid_provider_step(pg_temp.target(),pg_temp.claim(),'brand'),'shared brand cannot enter brand creation charge boundary');
SELECT throws_ok($$SELECT revoke_shared_review_brand_member(pg_temp.target(),pg_temp.owner(),pg_temp.owner(),3,'Already consumed')$$,'P0001','shared_registration_approval_in_use','consumed membership cannot be revoked as unused approval');
UPDATE review_sms_accounts SET activation_refunded_at=now(),state='released' WHERE id=pg_temp.account();
SELECT is(infer_business_plan_family(pg_temp.target()),'chat_only','refund before provider step retains Chat family with harmless brand attachment');
SELECT ok(NOT has_review_sms_access(pg_temp.target()),'refunded attachment grants no sending');
SELECT ok(NOT pg_temp.consume(),'refund wins over stale provisioning claim');
UPDATE review_sms_accounts SET activation_refunded_at=NULL,state='carrier_pending' WHERE id=pg_temp.account();
-- Execute the real sibling deletion in a subtransaction, then roll it back so
-- the same fixture can exercise its later campaign and upgrade lifecycle.
CREATE FUNCTION pg_temp.probe_target_cleanup() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb;generation bigint;claim jsonb;
BEGIN
 BEGIN
  UPDATE businesses SET deleted_at=now()-interval '61 days',deletion_scheduled_for=now()-interval '1 day' WHERE id=pg_temp.target();
  PERFORM cleanup_expired_business(pg_temp.target());
  SELECT a.generation INTO generation FROM account_deletion_stripe_actions a WHERE business_id=pg_temp.target();
  claim:=claim_account_deletion_stripe_action(pg_temp.target(),generation,'shared-target-cleanup-test',60);
  PERFORM finish_account_deletion_stripe_action(pg_temp.target(),generation,(claim->>'lease_token')::uuid,'applied','cancel',NULL,NULL);
  PERFORM complete_expired_business_cleanup(pg_temp.target(),generation);
  SELECT jsonb_build_object('scrubbed',b.owner_id IS NULL AND b.ein IS NULL AND b.deletion_scheduled_for IS NULL,
   'sourceAllowed',shared_brand_sms_allowed(pg_temp.source()),'oneBrand',(SELECT count(*)=1 FROM telnyx_managed_resources WHERE resource_type='brand' AND provider_id=pg_temp.brand()),
   'claimed',(SELECT local_claim_active FROM telnyx_managed_resources WHERE retained_shared_registration_id=pg_temp.group_id())) INTO result FROM businesses b WHERE b.id=pg_temp.target();
  RAISE EXCEPTION 'rollback cleanup probe' USING ERRCODE='ZX116';
 EXCEPTION WHEN SQLSTATE 'ZX116' THEN NULL;
 END;
 RETURN result;
END $$;
CREATE TEMP TABLE target_cleanup116 AS SELECT pg_temp.probe_target_cleanup() result;
SELECT is((SELECT result->>'scrubbed' FROM target_cleanup116),'true','sibling can close its account through real privacy cleanup');
SELECT is((SELECT result->>'sourceAllowed' FROM target_cleanup116),'true','sibling deletion preserves source sender authority');
SELECT is((SELECT result->>'oneBrand' FROM target_cleanup116),'true','sibling cleanup snapshot does not duplicate the source brand');
SELECT is((SELECT result->>'claimed' FROM target_cleanup116),'true','sibling finalization keeps canonical brand claimed');

SELECT ok(NOT review_sms_reserve_campaign_submission(pg_temp.target(),pg_temp.claim()),'shared paid campaign fence requires capacity reservation');
-- Capacity uses the complete provider inventory, including campaigns outside
-- SimplAssist; unresolved local outcomes also retain their slot.
SELECT throws_ok($$SELECT reserve_shared_brand_campaign(pg_temp.target(),'review_initial',pg_temp.account(),'reviews:'||pg_temp.account(),repeat('a',64),ARRAY['a','b','c','d','e'],now(),pg_temp.claim(),3)$$,'P0001','shared_brand_campaign_capacity','five provider campaigns block another charged filing');
SELECT throws_ok($$SELECT reserve_shared_brand_campaign(pg_temp.target(),'review_initial',pg_temp.account(),'reviews:'||pg_temp.account(),repeat('a',64),ARRAY['a'],now()-interval '6 minutes',pg_temp.claim(),3)$$,'P0001','shared_campaign_inventory_required','stale campaign inventory cannot reserve capacity');
SELECT throws_ok($$SELECT reserve_shared_brand_campaign(pg_temp.target(),'review_initial',pg_temp.account(),'reviews:'||pg_temp.account(),repeat('a',64),NULL,now(),pg_temp.claim(),3)$$,'P0001','shared_campaign_inventory_required','missing inventory fails closed');
INSERT INTO shared_brand_campaign_reservations(registration_id,business_id,owner_id,purpose,operation_id,reference_id,payload_hash,membership_revision,state)
SELECT pg_temp.group_id(),pg_temp.source(),pg_temp.owner(),'review_initial',gen_random_uuid(),'external-unknown116-'||n,repeat('b',64),1,'unknown' FROM generate_series(1,3) n;
SELECT throws_ok($$SELECT reserve_shared_brand_campaign(pg_temp.target(),'review_initial',pg_temp.account(),'reviews:'||pg_temp.account(),repeat('a',64),ARRAY['a','b'],now(),pg_temp.claim(),3)$$,'P0001','shared_brand_campaign_capacity','unknown reservations consume brand-wide slots');
DELETE FROM shared_brand_campaign_reservations WHERE business_id=pg_temp.source();

CREATE TEMP TABLE reservation AS SELECT reserve_shared_brand_campaign(pg_temp.target(),'review_initial',pg_temp.account(),'reviews:'||pg_temp.account(),repeat('a',64),ARRAY['source116','external116'],now(),pg_temp.claim(),3) r;
SELECT is((SELECT (r->>'submit')::boolean FROM reservation),true,'first capacity reservation authorizes one provider attempt');
SELECT is((reserve_shared_brand_campaign(pg_temp.target(),'review_initial',pg_temp.account(),'reviews:'||pg_temp.account(),repeat('a',64),ARRAY['source116','external116'],now(),pg_temp.claim(),3)->>'submit')::boolean,false,'same operation can never receive second submit authority');
SELECT ok(review_sms_reserve_campaign_submission(pg_temp.target(),pg_temp.claim()),'reserved capacity permits paid campaign boundary');
SELECT lives_ok($$SELECT record_shared_brand_campaign(pg_temp.target(),(SELECT (r->>'id')::uuid FROM reservation),repeat('a',64),NULL,'unknown')$$,'lost provider result retains unknown reservation');
SELECT is((SELECT state FROM shared_brand_campaign_reservations WHERE business_id=pg_temp.target()),'unknown','unknown reservation survives');
SELECT throws_ok($$SELECT record_shared_brand_campaign(pg_temp.target(),(SELECT (r->>'id')::uuid FROM reservation),repeat('a',64),'source116','bound')$$,'P0001','shared_campaign_owner_conflict','reservation cannot steal source campaign');
SELECT lives_ok($$SELECT record_shared_brand_campaign(pg_temp.target(),(SELECT (r->>'id')::uuid FROM reservation),repeat('a',64),'target116','bound')$$,'exact recovered private candidate can be recorded');
SELECT throws_ok($$SELECT record_shared_brand_campaign(pg_temp.target(),(SELECT (r->>'id')::uuid FROM reservation),repeat('a',64),'replacement116','bound')$$,'P0001','shared_campaign_owner_conflict','bound reservation identity is immutable');
SELECT is((apply_shared_brand_event(pg_temp.brand(),'reject116',now(),'rejected','Provider rejected brand')->>'applied')::boolean,true,'brand rejection applies once to canonical registration');
SELECT is((SELECT brand_status FROM businesses WHERE id=pg_temp.source()),'rejected','source sees brand rejection');
SELECT is((SELECT brand_status FROM businesses WHERE id=pg_temp.target()),'rejected','sibling sees brand rejection in same transaction');
SELECT ok(NOT shared_brand_sms_allowed(pg_temp.source()) AND NOT shared_brand_sms_allowed(pg_temp.target()),'brand rejection blocks both sender boundaries');
SELECT throws_ok($$SELECT reserve_tenant_sms(pg_temp.source(),gen_random_uuid(),'denied','hash','review_request','profile','+15745550116','+15745550117',1)$$,'P0001','shared_brand_sms_unavailable','canonical rejection precedes any quota/provider work');
SELECT is((apply_shared_brand_event(pg_temp.brand(),'older116',now()-interval '1 minute','approved')->>'applied')::boolean,false,'out of order approval cannot reopen rejected brand');
SELECT is((apply_shared_brand_event(pg_temp.brand(),'equal116',now(),'approved')->>'applied')::boolean,false,'same-timestamp approval cannot reopen rejected brand');
SELECT is((apply_shared_brand_event(pg_temp.brand(),'reject116',now()+interval '1 minute','approved')->>'applied')::boolean,false,'duplicate event cannot change canonical outcome');
SELECT is((apply_shared_brand_event(pg_temp.brand(),'approve116',now()+interval '1 second','approved')->>'applied')::boolean,true,'newer verified approval restores canonical state');
SELECT ok(shared_brand_sms_allowed(pg_temp.source()) AND shared_brand_sms_allowed(pg_temp.target()),'fresh approval restores eligible memberships');
SELECT throws_ok($$SELECT authorize_telnyx_remote_mutation(pg_temp.target(),'account_cleanup','delete_brand',pg_temp.brand(),NULL,NULL,NULL,NULL)$$,'P0001','shared_brand_retained','provider brand deletion blocked independent of release flags');
SELECT ok(NOT has_function_privilege('service_role','review_sms_confirm_operation_before_shared_registration(uuid,uuid,text)','EXECUTE'),'old payment wrapper cannot bypass new approval fence');
SELECT ok(NOT has_function_privilege('authenticated','reserve_shared_brand_campaign(uuid,text,uuid,text,text,text[],timestamptz,uuid,bigint)','EXECUTE'),'capacity submit authority is private');
-- The shared-brand exception is limited to the brand. This DBA still owns its
-- exact campaign, profile and sender before a future MIXED conversion.
INSERT INTO phone_numbers(id,business_id,phone_number,telnyx_phone_number_id,is_active,telnyx_campaign_assignment_status,telnyx_campaign_assignment_campaign_id)
VALUES('20000000-0000-4000-a116-000000000001',pg_temp.target(),'+15745550116','11600000-0000-4000-8116-000000000003',true,'assigned','target116');
UPDATE review_sms_accounts SET state='active',campaign_id='target116',messaging_profile_id='11600000-0000-4000-8116-000000000002',
 phone_number_id='20000000-0000-4000-a116-000000000001',stripe_item_id='si_shared116',paid_period_start=now()-interval '1 day',paid_period_end=now()+interval '29 days',paid_invoice_id='in_shared116',period_allowance=250,review_usecase_approved_at=now(),approval_evidence='exact filing verification',draft='{"consentMode":"hosted_keyword"}' WHERE id=pg_temp.account();
UPDATE businesses SET telnyx_campaign_id='target116',telnyx_messaging_profile_id='11600000-0000-4000-8116-000000000002',campaign_status='approved',telnyx_resource_state='active' WHERE id=pg_temp.target();
INSERT INTO telnyx_managed_resources(business_id,resource_type,provider_id,provider_origin) VALUES(pg_temp.target(),'campaign','target116','created_by_simplassist'),(pg_temp.target(),'messaging_profile','11600000-0000-4000-8116-000000000002','created_by_simplassist');
SELECT is(infer_business_plan_family(pg_temp.target()),'chat_only','real dedicated review sender still has Chat family');
SELECT ok(has_review_sms_access(pg_temp.target()),'paid scoped review subscription may send with shared approved brand');
UPDATE telnyx_managed_resources SET business_id='10000000-0000-4000-a116-000000000003' WHERE resource_type='campaign' AND provider_id='target116';
SELECT ok(NOT review_sms_owns_plan_family_resources(pg_temp.target()),'shared brand never exempts another business campaign ledger');
UPDATE telnyx_managed_resources SET business_id=pg_temp.target() WHERE resource_type='campaign' AND provider_id='target116';
INSERT INTO chat_texting_upgrades(id,business_id,owner_id,source_subscription_id,source_customer_id,target_plan,source_mode,source_review_account_id,source_review_item_id,original_activation_operation_id)
VALUES('60000000-0000-4000-a116-000000000001',pg_temp.target(),pg_temp.owner(),'sub_target116','cus_target116','sms_and_chat','review_sms',pg_temp.account(),'si_shared116','50000000-0000-4000-a116-000000000001');
CREATE FUNCTION pg_temp.upgrade() RETURNS uuid LANGUAGE sql AS $$SELECT '60000000-0000-4000-a116-000000000001'::uuid$$;
CREATE FUNCTION pg_temp.forbidden() RETURNS text[] LANGUAGE sql AS $$SELECT ARRAY['11600000-0000-4000-8116-000000000099']$$;
SELECT lives_ok($$SELECT review_texting_provider_prepare(pg_temp.target(),pg_temp.owner(),jsonb_build_object('usecase','MIXED','subUsecases','["CUSTOMER_CARE","MARKETING"]'::jsonb,'referenceId','upgrade:'||pg_temp.upgrade(),'brandId',pg_temp.brand(),'optinKeywords','REVIEWS','embeddedLink',true),repeat('c',64),pg_temp.forbidden())$$,'shared legal brand supports distinct future MIXED filing');
CREATE TEMP TABLE upgrade_claim AS SELECT review_texting_provider_claim(pg_temp.upgrade()) token;
SELECT ok(NOT review_texting_provider_authorize(pg_temp.upgrade(),(SELECT token FROM upgrade_claim),'submit',pg_temp.forbidden()),'future filing cannot submit without capacity reservation');
SELECT throws_ok($$SELECT reserve_shared_brand_campaign(pg_temp.target(),'review_upgrade',pg_temp.upgrade(),'upgrade:'||pg_temp.upgrade(),repeat('c',64),ARRAY['source116','external116','target116','fourth','fifth'],now(),(SELECT token FROM upgrade_claim),3)$$,'P0001','shared_brand_campaign_capacity','future MIXED filing shares brand-wide limit');
CREATE TEMP TABLE upgrade_slot AS SELECT reserve_shared_brand_campaign(pg_temp.target(),'review_upgrade',pg_temp.upgrade(),'upgrade:'||pg_temp.upgrade(),repeat('c',64),ARRAY['source116','external116','target116','fourth'],now(),(SELECT token FROM upgrade_claim),3) r;
SELECT is((SELECT (r->>'submit')::boolean FROM upgrade_slot),true,'known bound campaign is not double-counted against capacity');
SELECT ok(review_texting_provider_authorize(pg_temp.upgrade(),(SELECT token FROM upgrade_claim),'submit',pg_temp.forbidden()),'future MIXED filing respects existing paid one-attempt boundary');
SELECT ok(NOT review_texting_provider_authorize(pg_temp.upgrade(),(SELECT token FROM upgrade_claim),'submit',pg_temp.forbidden()),'future MIXED filing cannot charge twice');
SELECT lives_ok($$SELECT record_shared_brand_campaign(pg_temp.target(),(SELECT (r->>'id')::uuid FROM upgrade_slot),repeat('c',64),NULL,'unknown')$$,'unknown future filing retains capacity');
SELECT is((SELECT count(*)::int FROM shared_brand_campaign_reservations WHERE registration_id=pg_temp.group_id()),2,'initial and future filings have distinct durable receipts');
-- Source cleanup must preserve its sibling and the group's only physical brand.
UPDATE businesses SET deleted_at=now()-interval '61 days',deletion_scheduled_for=now()-interval '1 day' WHERE id=pg_temp.source();
SELECT lives_ok($$SELECT cleanup_expired_business(pg_temp.source())$$,'source account follows ordinary privacy scrub with shared brand retained');
SELECT ok((SELECT owner_id IS NULL AND ein IS NULL AND address IS NULL FROM businesses WHERE id=pg_temp.source()),'source business private identity is scrubbed');
SELECT is((SELECT state FROM shared_business_registration_members WHERE business_id=pg_temp.source()),'revoked','source cleanup retires only its membership');
SELECT ok((SELECT local_claim_active FROM telnyx_managed_resources WHERE retained_shared_registration_id=pg_temp.group_id()),'canonical ledger survives source scrub');
SELECT ok(shared_brand_sms_allowed(pg_temp.target()),'sibling still has valid approved legal registration after source closes');
SELECT is((SELECT count(*)::int FROM telnyx_managed_resources WHERE resource_type='brand' AND provider_id=pg_temp.brand()),1,'cleanup snapshot never creates a duplicate physical brand');
SELECT ok(EXISTS(SELECT 1 FROM telnyx_resource_release_actions WHERE business_id=pg_temp.source() AND resource_type='brand' AND desired_action='retain' AND state='retained'),'source release records explicit retained brand disposition');
-- Existing unrelated campaign cleanup may require separate verification; mark
-- that fixture's local release disposition terminal to exercise finalization.
UPDATE telnyx_resource_release_actions SET state='retained',desired_action='retain',classification='policy_retain' WHERE business_id=pg_temp.source() AND resource_type<>'brand';
SELECT refresh_telnyx_release_run((SELECT active_telnyx_release_run_id FROM businesses WHERE id=pg_temp.source()));
CREATE TEMP TABLE cancel_claim116 AS SELECT claim_account_deletion_stripe_action(pg_temp.source(),(SELECT generation FROM account_deletion_stripe_actions WHERE business_id=pg_temp.source()),'shared-cleanup-test',60) payload;
SELECT ok(finish_account_deletion_stripe_action(pg_temp.source(),(SELECT (payload->>'generation')::bigint FROM cancel_claim116),(SELECT (payload->>'lease_token')::uuid FROM cancel_claim116),'applied','cancel',NULL,NULL),'source Stripe cancellation follows existing lease guard');
SELECT lives_ok($$SELECT complete_expired_business_cleanup(pg_temp.source(),(SELECT generation FROM account_deletion_stripe_actions WHERE business_id=pg_temp.source()))$$,'source cleanup finalizes without dropping shared brand claim');
SELECT ok((SELECT local_claim_active FROM telnyx_managed_resources WHERE retained_shared_registration_id=pg_temp.group_id()),'finalization leaves canonical brand claimed');
SELECT ok(shared_brand_sms_allowed(pg_temp.target()),'completed source deletion cannot interrupt sibling sender');

SELECT ok(NOT hold_shared_brand_identity(pg_temp.brand(),now()-interval '1 minute'),'stale identity observation cannot freeze newly verified registration');
SELECT ok(hold_shared_brand_identity(pg_temp.brand(),now()+interval '2 seconds'),'concrete fresh provider identity drift holds registration');
SELECT ok(NOT shared_brand_sms_allowed(pg_temp.target()),'identity hold blocks surviving member send boundary');
SELECT is((SELECT brand_status FROM shared_business_registrations WHERE id=pg_temp.group_id()),'approved','identity hold preserves separately known carrier approval');
SELECT is((apply_shared_brand_event(pg_temp.brand(),'approved-during-hold116',now()+interval '3 seconds','approved')->>'applied')::boolean,true,'new provider status event is still recorded during hold');
SELECT ok(NOT shared_brand_sms_allowed(pg_temp.target()),'carrier approval cannot automatically reopen identity hold');
SELECT ok(NOT hold_shared_brand_identity(pg_temp.brand(),now()+interval '4 seconds'),'identity hold is idempotent');
SELECT is((SELECT count(*)::int FROM shared_business_registration_events WHERE registration_id=pg_temp.group_id() AND event='provider_identity_changed'),1,'only current active member receives safe identity-hold audit');
SELECT * FROM finish();
ROLLBACK;
