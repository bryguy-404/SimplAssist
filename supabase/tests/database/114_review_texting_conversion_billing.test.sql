BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();
CREATE TEMP TABLE conversion_fixture(label text PRIMARY KEY,b uuid,own uuid,a uuid,u uuid,op uuid,paid timestamptz);
CREATE FUNCTION pg_temp.conversion_fixture(label text,fee integer DEFAULT 2500) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE bid uuid:=gen_random_uuid(); own uuid:=gen_random_uuid(); aid uuid:=gen_random_uuid(); activation uuid:=gen_random_uuid(); pn uuid:=gen_random_uuid();
 result jsonb; uid uuid; suffix text:=replace(bid::text,'-',''); phone text:='+1212555'||lpad((SELECT count(*)+2000 FROM conversion_fixture)::text,4,'0');
BEGIN
 INSERT INTO auth.users(id,email) VALUES(own,own||'@example.test');
 INSERT INTO businesses(id,owner_id,name,business_type,slug,onboarding_completed_at,onboarding_selected_plan,telnyx_resource_state)
 VALUES(bid,own,'Review upgrade','general','upgrade-'||bid,now()-interval '30 days','chat_only','active');
 INSERT INTO subscriptions(business_id,stripe_customer_id,stripe_subscription_id,plan,status,current_period_start,current_period_end,stripe_price_id)
 VALUES(bid,'cus_'||suffix,'sub_'||suffix,'chat_only','active',now()-interval '15 days',now()+interval '15 days','price_chat');
 INSERT INTO business_plan_family_locks(business_id,family,claimed_by) VALUES(bid,'chat_only','stripe_sync');
 INSERT INTO chat_only_checkout_attempts(business_id,stripe_price_id,request_fingerprint,state,claim_token,claimed_at,claim_expires_at,stripe_checkout_session_id,
  stripe_customer_id,stripe_subscription_id,checkout_session_expires_at,completed_at,created_at)
 VALUES(bid,'price_chat',repeat('a',64),'completed',gen_random_uuid(),now()-interval '30 days',now()-interval '29 days','cs_'||suffix,
  'cus_'||suffix,'sub_'||suffix,now()-interval '29 days',now()-interval '30 days',now()-interval '30 days');
 INSERT INTO phone_numbers(id,business_id,phone_number,telnyx_phone_number_id,is_active,resource_status,telnyx_campaign_assignment_status,telnyx_campaign_assignment_campaign_id)
 VALUES(pn,bid,phone,pn::text,true,'active','assigned','campaign-new-'||suffix);
 INSERT INTO review_sms_accounts(id,business_id,owner_id,state,billing_source,source_subscription_id,source_customer_id,activation_paid_at,activation_payment_intent_id,
  provider_started_at,provider_submitted_at,review_usecase_approved_at,approval_evidence,brand_id,campaign_id,messaging_profile_id,phone_number_id,
  exclusive_resources,stripe_item_id,stripe_price_id,paid_period_start,paid_period_end,paid_invoice_id,period_allowance)
 VALUES(aid,bid,own,'active','direct','sub_'||suffix,'cus_'||suffix,now()-interval '20 days','pi_'||suffix,now()-interval '20 days',now()-interval '19 days',now(),'fixture-only',
  bid::text,'campaign-new-'||suffix,own::text,pn,true,'si_'||suffix,'price_reviews',now()-interval '15 days',now()+interval '15 days','in_source'||suffix,250);
 UPDATE businesses SET telnyx_brand_id=bid::text,telnyx_campaign_id='campaign-new-'||suffix,telnyx_messaging_profile_id=own::text,brand_status='approved',campaign_status='approved' WHERE id=bid;
 INSERT INTO review_sms_billing_operations(id,account_id,business_id,owner_id,kind,state,fingerprint,payload,checkout_session_id,completed_at)
 VALUES(activation,aid,bid,own,'activation','completed',repeat('a',64),jsonb_build_object('amountCents',fee,'feeId','price_originalsetup','customerId','cus_'||suffix,'subscriptionId','sub_'||suffix),'cs_activation'||suffix,now()-interval '20 days');
 result:=save_chat_texting_upgrade(bid,own,'sms_and_chat',false);uid:=(result->>'id')::uuid;
 INSERT INTO review_texting_provider_upgrades(upgrade_id,business_id,owner_id,review_account_id,stage,source_campaign_id,candidate_campaign_id,brand_id,messaging_profile_id,
  phone_number_id,phone_number,filing,filing_hash,handoff_token,handoff_requested_at,handoff_completed_at,approval_evidence,retirement_state)
 VALUES(uid,bid,own,aid,'review_ready','campaign-old-'||suffix,'campaign-new-'||suffix,bid::text,own::text,pn,phone,
  '{"usecase":"MIXED","subUsecases":["CUSTOMER_CARE","MARKETING"]}',repeat('c',64),gen_random_uuid(),now()-interval '1 hour',now(),
  jsonb_build_object('campaignId','campaign-new-'||suffix,'filingHash',repeat('c',64)),'done');
 INSERT INTO billing_usage_periods(business_id,period_start,period_end,plan,included_sms_parts,inbound_sms_parts,outbound_sms_parts)
 VALUES(bid,now()-interval '15 days',now()+interval '15 days','chat_only',0,5,7);
 INSERT INTO conversion_fixture VALUES(label,bid,own,aid,uid,NULL,NULL);
 RETURN uid;
END $$;
CREATE FUNCTION pg_temp.quote_conversion(label text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE f conversion_fixture; u chat_texting_upgrades; s subscriptions; result jsonb;
BEGIN
 SELECT * INTO f FROM conversion_fixture WHERE conversion_fixture.label=quote_conversion.label;
 SELECT * INTO u FROM chat_texting_upgrades WHERE id=f.u; SELECT * INTO s FROM subscriptions WHERE business_id=f.b;
 result:=acquire_chat_texting_upgrade_quote(f.u,f.own,jsonb_build_object('target_plan','sms_and_chat','target_price_id','price_growth',
  'expected_subscription_id',u.source_subscription_id,'expected_customer_id',u.source_customer_id,'stripe_item_id','si_base'||replace(f.b::text,'-',''),
  'expected_setup_fingerprint',review_texting_upgrade_billing_fingerprint(u.id),'source_fingerprint',repeat('b',64),'proration_at',now(),
  'quote',jsonb_build_object('amountDueCents',700,'currency','usd','setupFeeCents',0,'sourceMode','review_sms','sourceReviewItemId',u.source_review_item_id,
   'sourceBasePriceId','price_chat','sourceReviewPriceId','price_reviews')));
 UPDATE conversion_fixture SET op=(result->>'id')::uuid WHERE conversion_fixture.label=quote_conversion.label;
 RETURN (result->>'id')::uuid;
END $$;
CREATE FUNCTION pg_temp.confirm_conversion(label text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE f conversion_fixture; r jsonb;
BEGIN
 SELECT * INTO f FROM conversion_fixture WHERE conversion_fixture.label=confirm_conversion.label;
 r:=confirm_chat_texting_upgrade(f.u,f.own,f.op,repeat('b',64));
 UPDATE conversion_fixture SET paid=clock_timestamp() WHERE conversion_fixture.label=confirm_conversion.label;
 RETURN r;
END $$;
CREATE FUNCTION pg_temp.conversion_payment(label text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('subscription_id',u.source_subscription_id,'customer_id',u.source_customer_id,'plan','sms_and_chat','price_id','price_growth',
 'status','active','current_period_start',o.source_period_start,'current_period_end',o.source_period_end,'cancel_at_period_end',false,
 'invoice_id','in_'||replace(u.id::text,'-',''),'invoice_status','paid','invoice_paid_at',f.paid,'invoice_created_at',o.confirmed_at,
 'invoice_amount_due',700,'invoice_currency','usd','review_conversion_invoice_verified',true,'source_review_item_id',u.source_review_item_id,
 'payment_period_start',o.source_period_start,'payment_period_end',o.source_period_end)
 FROM conversion_fixture f JOIN chat_texting_upgrades u ON u.id=f.u JOIN sms_billing_operations o ON o.id=f.op WHERE f.label=conversion_payment.label
$$;
SELECT lives_ok($$SELECT pg_temp.conversion_fixture('paid')$$,'paid direct review account may select Growth');
SELECT is((SELECT source_mode FROM chat_texting_upgrades WHERE id=(SELECT u FROM conversion_fixture WHERE label='paid')),'review_sms','review source is explicit');
SELECT is((SELECT original_activation_operation_id IS NOT NULL FROM chat_texting_upgrades WHERE id=(SELECT u FROM conversion_fixture WHERE label='paid')),true,'original setup payment is bound');
SELECT throws_ok($$SELECT save_chat_texting_upgrade(b,own,'full',false) FROM conversion_fixture WHERE label='paid'$$,'P0001','texting_upgrade_invalid_plan','review source cannot skip directly to Full');
SELECT throws_ok($$SELECT save_chat_texting_upgrade(b,own,'sms_only',false) FROM conversion_fixture WHERE label='paid'$$,'P0001','texting_upgrade_invalid_plan','review source cannot target SMS Only');
SELECT lives_ok($$SELECT pg_temp.quote_conversion('paid')$$,'completed handoff permits a no-fee quote');
SELECT is((SELECT setup_fee_price_id FROM sms_billing_operations WHERE id=(SELECT op FROM conversion_fixture WHERE label='paid')),NULL,'conversion has no setup charge');
SELECT is((SELECT source_plan FROM sms_billing_operations WHERE id=(SELECT op FROM conversion_fixture WHERE label='paid')),'chat_only','quoted conversion does not change paid source');
SELECT throws_ok($$SELECT review_sms_acquire_operation(b,own,'cancel',repeat('d',64),'{}') FROM conversion_fixture WHERE label='paid'$$,'P0001','review_sms_upgrade_in_progress','concurrent addon cancellation is fenced');
SELECT lives_ok($$SELECT pg_temp.confirm_conversion('paid')$$,'exact handoff and source permit payment claim');
SELECT is((SELECT review_sms_begin_reconcile(b,'sub_'||replace(b::text,'-',''),'cus_'||replace(b::text,'-','')) FROM conversion_fixture WHERE label='paid'),NULL,'old addon reconciliation cannot race pending deletion');
SELECT throws_ok($$SELECT finalize_chat_texting_upgrade_payment(op,pg_temp.conversion_payment('paid')||'{"review_conversion_invoice_verified":false}'::jsonb) FROM conversion_fixture WHERE label='paid'$$,'P0001','texting_upgrade_payment_unverified','invoice proof is mandatory');
SELECT is((SELECT finalize_chat_texting_upgrade_payment(op,pg_temp.conversion_payment('paid')) FROM conversion_fixture WHERE label='paid'),true,'verified payment atomically activates Growth');
SELECT is((SELECT state FROM chat_texting_upgrades WHERE id=(SELECT u FROM conversion_fixture WHERE label='paid')),'activated','no second carrier-registration phase follows payment');
SELECT is((SELECT plan FROM subscriptions WHERE business_id=(SELECT b FROM conversion_fixture WHERE label='paid')),'sms_and_chat','base plan is Growth');
SELECT is((SELECT infer_business_plan_family(b) FROM conversion_fixture WHERE label='paid'),'sms','paid conversion supersedes historical Chat evidence');
SELECT is((SELECT billing_source FROM review_sms_accounts WHERE id=(SELECT a FROM conversion_fixture WHERE label='paid')),'included','reviews become included');
SELECT is((SELECT exclusive_resources FROM review_sms_accounts WHERE id=(SELECT a FROM conversion_fixture WHERE label='paid')),false,'addon cleanup no longer owns shared Growth resources');
SELECT is((SELECT stripe_item_id FROM review_sms_accounts WHERE id=(SELECT a FROM conversion_fixture WHERE label='paid')),NULL,'obsolete addon item is removed');
SELECT is((SELECT included_sms_parts FROM billing_usage_periods WHERE business_id=(SELECT b FROM conversion_fixture WHERE label='paid')),1500,'Growth uses one 1500-part cap');
SELECT is((SELECT inbound_sms_parts+outbound_sms_parts FROM billing_usage_periods WHERE business_id=(SELECT b FROM conversion_fixture WHERE label='paid')),12,'existing usage is preserved');
SELECT is((SELECT review_sms_allowance(b) FROM conversion_fixture WHERE label='paid'),0,'250 addon allowance is not stacked');
SELECT is((SELECT s.setup_fee_paid_at=a.activation_paid_at FROM subscriptions s JOIN review_sms_accounts a USING(business_id) WHERE s.business_id=(SELECT b FROM conversion_fixture WHERE label='paid')),true,'original activation receipt credits setup');
SELECT is((SELECT finalize_chat_texting_upgrade_payment(op,pg_temp.conversion_payment('paid')) FROM conversion_fixture WHERE label='paid'),true,'duplicate payment is idempotent');
SELECT is((SELECT review_sms_record_paid_period(b,999,'si_stale','price_reviews','in_stale',now()-interval '1 day',now()+interval '29 days',250) FROM conversion_fixture WHERE label='paid'),false,'stale addon paid-period writes cannot recreate the addon');
SELECT is((SELECT sync_stripe_subscription_if_business_active(b,'cus_'||replace(b::text,'-',''),'sub_'||replace(b::text,'-',''),'chat_only','active',now()-interval '15 days',now()+interval '15 days','price_chat',NULL,NULL,NULL,false,now()) FROM conversion_fixture WHERE label='paid'),false,'old Chat webhook cannot restore Chat after payment');
SELECT lives_ok($$SELECT pg_temp.conversion_fixture('legacy49',4900);SELECT pg_temp.quote_conversion('legacy49');SELECT pg_temp.confirm_conversion('legacy49')$$,'historical49 activation may upgrade without another setup fee');
SELECT is((SELECT finalize_chat_texting_upgrade_payment(op,pg_temp.conversion_payment('legacy49')||'{"status":"canceled","cancel_at_period_end":true}'::jsonb) FROM conversion_fixture WHERE label='legacy49'),true,'late paid invoice still records conversion');
SELECT is((SELECT status FROM subscriptions WHERE business_id=(SELECT b FROM conversion_fixture WHERE label='legacy49')),'canceled','late payment recovery preserves current cancellation');
SELECT is((SELECT has_review_sms_access(b) FROM conversion_fixture WHERE label='legacy49'),false,'late recovery cannot grant access to canceled billing');
SELECT lives_ok($$SELECT pg_temp.conversion_fixture('cancel-race');SELECT pg_temp.quote_conversion('cancel-race');SELECT pg_temp.confirm_conversion('cancel-race')$$,'race fixture claims a valid payment');
UPDATE subscriptions SET status='canceled',cancel_at_period_end=true WHERE business_id=(SELECT b FROM conversion_fixture WHERE label='cancel-race');
SELECT is((SELECT finalize_chat_texting_upgrade_payment(op,pg_temp.conversion_payment('cancel-race')) FROM conversion_fixture WHERE label='cancel-race'),true,'paid plan transition is recorded despite a newer local cancellation');
SELECT is((SELECT status FROM subscriptions WHERE business_id=(SELECT b FROM conversion_fixture WHERE label='cancel-race')),'canceled','older active provider snapshot cannot undo locked cancellation');
SELECT is((SELECT cancel_at_period_end FROM subscriptions WHERE business_id=(SELECT b FROM conversion_fixture WHERE label='cancel-race')),true,'cancellation flag survives conversion race');
SELECT is((SELECT has_review_sms_access(b) FROM conversion_fixture WHERE label='cancel-race'),false,'cancellation race never restores review access');
SELECT lives_ok($$SELECT pg_temp.conversion_fixture('changed');SELECT pg_temp.quote_conversion('changed')$$,'second fixture prepares an exact quote');
UPDATE review_texting_provider_upgrades SET approval_evidence=approval_evidence||'{"revision":"new"}' WHERE upgrade_id=(SELECT u FROM conversion_fixture WHERE label='changed');
SELECT throws_ok($$SELECT pg_temp.confirm_conversion('changed')$$,'P0001','texting_upgrade_source_changed','changed handoff evidence invalidates a prepared quote');
SELECT lives_ok($$SELECT cancel_chat_texting_upgrade(u,own) FROM conversion_fixture WHERE label='changed'$$,'unpaid prepared conversion can be abandoned after completed handoff');
SELECT is((SELECT save_chat_texting_upgrade(b,own,'sms_and_chat',false)->>'id' FROM conversion_fixture WHERE label='changed'),(SELECT u::text FROM conversion_fixture WHERE label='changed'),'restarting reuses exact completed handoff instead of filing another campaign');
SELECT lives_ok($$UPDATE businesses SET deleted_at=now()-interval '61 days',deletion_scheduled_for=now()-interval '1 day' WHERE id=(SELECT b FROM conversion_fixture WHERE label='paid'); SELECT queue_account_deletion_stripe_action(b,'sub_'||replace(b::text,'-',''),'cancel') FROM conversion_fixture WHERE label='paid'; UPDATE businesses SET owner_id=NULL,cleanup_pii_scrubbed_at=now() WHERE id=(SELECT b FROM conversion_fixture WHERE label='paid')$$,'completed paid conversion permits existing owner cleanup without circular historical foreign keys');
SELECT is((SELECT count(*)::integer FROM review_sms_accounts WHERE id=(SELECT a FROM conversion_fixture WHERE label='paid')),0,'owner cleanup removes the review account');
SELECT is((SELECT count(*)::integer FROM review_texting_provider_upgrades WHERE upgrade_id=(SELECT u FROM conversion_fixture WHERE label='paid')),0,'owner cleanup removes retired provider filing and contact information');
SELECT ok((SELECT source_review_account_id=f.a AND original_activation_operation_id IS NOT NULL AND paid_at IS NOT NULL AND state='activated' FROM chat_texting_upgrades u JOIN conversion_fixture f ON u.id=f.u WHERE f.label='paid'),'immutable source receipt references survive account cleanup');
SELECT is((SELECT state FROM sms_billing_operations WHERE id=(SELECT op FROM conversion_fixture WHERE label='paid')),'applied','paid billing proof is retained after owner cleanup');
SELECT ok(NOT has_function_privilege('authenticated','finalize_chat_texting_upgrade_payment(uuid,jsonb)','EXECUTE'),'owners cannot write payment authority');
SELECT ok(NOT has_function_privilege('service_role','finalize_chat_texting_upgrade_payment_before_review_sms(uuid,jsonb)','EXECUTE'),'service callers cannot bypass conversion wrapper');
SELECT * FROM finish();
ROLLBACK;
