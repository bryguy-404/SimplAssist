BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();
CREATE TEMP TABLE fixture(b uuid,o uuid);
INSERT INTO fixture VALUES(gen_random_uuid(),gen_random_uuid());
INSERT INTO auth.users(id,email) SELECT o,'sms-billing-test@example.test' FROM fixture;
INSERT INTO public.businesses(id,owner_id,name,business_type,slug) SELECT b,o,'Billing tests','general','sms-billing-'||b FROM fixture;
CREATE TEMP TABLE operations(label text PRIMARY KEY,id uuid);
CREATE FUNCTION pg_temp.acquire(k text,plan text,fp text DEFAULT 'a',terminal_proof boolean DEFAULT false) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE s public.subscriptions; result jsonb;
BEGIN
 SELECT * INTO s FROM public.subscriptions WHERE business_id=(SELECT b FROM fixture);
 result:=public.acquire_sms_billing_operation((SELECT b FROM fixture),(SELECT o FROM fixture),jsonb_build_object(
   'kind',k,'target_plan',plan,'target_price_id','price_'||replace(plan,'_',''),
   'expected_subscription_id',s.stripe_subscription_id,'expected_customer_id',s.stripe_customer_id,
   'stripe_item_id','si_primary','source_fingerprint',repeat(fp,64),'setup_fee_price_id','price_setup','proration_at',now(),
   'previous_source_terminal_status',CASE WHEN terminal_proof THEN 'canceled' END,
   'previous_source_terminal_verified_at',CASE WHEN terminal_proof THEN now() END));
 RETURN (result->>'id')::uuid;
END $$;
CREATE FUNCTION pg_temp.snapshot(sid text,plan text,ps timestamptz DEFAULT now(),pe timestamptz DEFAULT now()+interval '30 days') RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('subscription_id',sid,'customer_id','cus_owner','plan',plan,'price_id','price_'||replace(plan,'_',''),
   'status','active','period_start',ps,'period_end',pe,'cancel_at_period_end',false)
$$;
CREATE FUNCTION pg_temp.payment(i text,sid text,status text DEFAULT 'paid') RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('invoice_id',i,'subscription_id',sid,'customer_id','cus_owner','status',status,'paid_at',now())
$$;

SELECT ok(NOT has_table_privilege('authenticated','public.sms_billing_operations','SELECT'),'owners cannot inspect other billing authority');
SELECT ok(NOT has_table_privilege('authenticated','public.sms_billing_operations','UPDATE'),'owners cannot forge paid evidence');
SELECT ok(NOT has_table_privilege('anon','public.sms_billing_accounts','SELECT'),'anonymous cannot inspect provider identity');
SELECT ok(NOT has_function_privilege('authenticated','public.finalize_paid_sms_billing_operation(uuid,jsonb,jsonb)','EXECUTE'),'paid finalization is service only');
SELECT ok(NOT has_function_privilege('service_role','public.sync_stripe_subscription_before_sms_operations(uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,timestamptz,boolean,timestamptz)','EXECUTE'),'legacy authority cannot be called around the source guard');
SELECT ok((SELECT prosecdef AND proconfig @> ARRAY['search_path=""'] FROM pg_proc WHERE oid='public.sync_stripe_subscription_if_business_active(uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,timestamptz,boolean,timestamptz)'::regprocedure),'source wrapper uses a fixed empty definer search path');
SELECT ok(pg_get_functiondef('public.sync_stripe_subscription_if_business_active(uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,timestamptz,boolean,timestamptz)'::regprocedure)
 LIKE ALL(ARRAY['%FOR UPDATE%','%payment_verified_at IS NOT NULL%','%expected_subscription_id IS NOT DISTINCT FROM s.stripe_subscription_id%','%sync_stripe_subscription_before_sms_operations%']),
 'source wrapper retains the business mutex, payment/source guard, and original guarded writer');
SELECT throws_ok($$SELECT public.acquire_sms_billing_operation((SELECT b FROM fixture),gen_random_uuid(),'{}')$$,'42501','sms_billing_forbidden','another owner cannot acquire billing work');
INSERT INTO operations VALUES('initial',pg_temp.acquire('checkout','sms_and_chat'));
SELECT is(pg_temp.acquire('checkout','sms_and_chat'),(SELECT id FROM operations WHERE label='initial'),'duplicate Checkout reuses the durable operation');
SELECT is((SELECT count(*)::integer FROM public.sms_billing_operations WHERE business_id=(SELECT b FROM fixture)),1,'single-flight persists one operation');
SELECT throws_ok($$SELECT pg_temp.acquire('checkout','full')$$,'P0001','sms_billing_operation_in_progress','different simultaneous purchase cannot create another payable operation');
SELECT is((SELECT setup_fee_price_id FROM public.sms_billing_operations WHERE id=(SELECT id FROM operations WHERE label='initial')),'price_setup','first acquisition includes the setup fee');
SELECT public.confirm_sms_billing_operation((SELECT id FROM operations WHERE label='initial'),(SELECT o FROM fixture),repeat('a',64));
SELECT public.record_sms_billing_operation((SELECT id FROM operations WHERE label='initial'),' {"stripe_customer_id":"cus_owner","checkout_session_id":"cs_initial","state":"pending"}'::jsonb);
SELECT is((SELECT stripe_customer_id FROM public.sms_billing_accounts WHERE business_id=(SELECT b FROM fixture)),'cus_owner','created customer is durable before payment');
SELECT throws_ok($$UPDATE public.businesses SET deleted_at=now() WHERE id=(SELECT b FROM fixture)$$,'55000','sms_billing_authority_locked','unknown payable Checkout blocks loss of deletion authority');
SELECT throws_ok($$SELECT public.record_sms_billing_operation((SELECT id FROM operations WHERE label='initial'),'{"stripe_customer_id":"cus_other"}')$$,'P0001','sms_billing_provider_identity_changed','customer identity cannot drift');
SELECT throws_ok($$SELECT public.finalize_paid_sms_billing_operation((SELECT id FROM operations WHERE label='initial'),pg_temp.snapshot('sub_first','sms_and_chat'),pg_temp.payment('in_first','sub_first','open'))$$,
 'P0001','sms_billing_payment_unverified','open invoice cannot establish paid service');
SELECT is((SELECT count(*)::integer FROM public.subscriptions WHERE business_id=(SELECT b FROM fixture)),0,'failed payment creates no canonical subscription');
SELECT throws_ok($$SELECT public.finalize_paid_sms_billing_operation((SELECT id FROM operations WHERE label='initial'),pg_temp.snapshot('sub_first','sms_and_chat'),pg_temp.payment('in_first','sub_other'))$$,
 'P0001','sms_billing_payment_unverified','foreign invoice cannot establish paid service');
SELECT ok(public.finalize_paid_sms_billing_operation((SELECT id FROM operations WHERE label='initial'),pg_temp.snapshot('sub_first','sms_and_chat',now()-interval '1 day',now()+interval '29 days'),pg_temp.payment('in_first','sub_first')),'verified first payment establishes canonical service');
SELECT ok((SELECT setup_fee_paid_at IS NOT NULL FROM public.sms_billing_accounts WHERE business_id=(SELECT b FROM fixture)),'setup fulfillment retained independently of subscription');
SELECT ok(public.finalize_paid_sms_billing_operation((SELECT id FROM operations WHERE label='initial'),pg_temp.snapshot('sub_first','sms_and_chat'),pg_temp.payment('in_first','sub_first')),'same payment retry is idempotent');
SELECT throws_ok($$UPDATE public.sms_billing_operations SET payment_effective_at=now()+interval '1 minute' WHERE id=(SELECT id FROM operations WHERE label='initial')$$,
 'P0001','sms_billing_applied_operation_immutable','historical effective payment time is immutable');
SELECT throws_ok($$SELECT public.finalize_paid_sms_billing_operation((SELECT id FROM operations WHERE label='initial'),pg_temp.snapshot('sub_first','sms_and_chat'),pg_temp.payment('in_other','sub_first'))$$,
 'P0001','sms_billing_provider_identity_changed','retry cannot swap invoice identity');
SELECT throws_ok($$SELECT pg_temp.acquire('checkout','full')$$,'P0001','sms_billing_existing_subscription','active owner must upgrade existing subscription');
SELECT ok(NOT public.sync_stripe_subscription_if_business_active((SELECT b FROM fixture),'cus_owner','sub_orphan','full','active',now(),now()+interval '30 days','price_full',NULL,NULL,NULL,false,now()),'orphan event cannot replace canonical billing source');

UPDATE public.subscriptions SET status='canceled' WHERE business_id=(SELECT b FROM fixture);
SELECT public.queue_account_deletion_stripe_action((SELECT b FROM fixture),'sub_first','resume');
-- Migration can seed this row before an already-open legacy Checkout pays.
UPDATE public.sms_billing_accounts SET setup_fee_paid_at=NULL WHERE business_id=(SELECT b FROM fixture);
INSERT INTO operations VALUES('rejoin',pg_temp.acquire('checkout','sms_and_chat','b',true));
SELECT is((SELECT setup_fee_price_id FROM public.sms_billing_operations WHERE id=(SELECT id FROM operations WHERE label='rejoin')),NULL::text,'returning business does not pay setup again');
SELECT is((SELECT setup_fee_paid_at FROM public.sms_billing_accounts WHERE business_id=(SELECT b FROM fixture)),now(),'late legacy setup fulfillment repairs the durable fee ledger');
SELECT public.confirm_sms_billing_operation((SELECT id FROM operations WHERE label='rejoin'),(SELECT o FROM fixture),repeat('b',64));
SELECT public.record_sms_billing_operation((SELECT id FROM operations WHERE label='rejoin'),'{"checkout_session_id":"cs_rejoin","state":"pending"}');
SELECT ok(public.finalize_paid_sms_billing_operation((SELECT id FROM operations WHERE label='rejoin'),pg_temp.snapshot('sub_second','sms_and_chat'),pg_temp.payment('in_second','sub_second')),'paid rejoin replaces only its exact terminal source');
SELECT is((SELECT stripe_subscription_id FROM public.subscriptions WHERE business_id=(SELECT b FROM fixture)),'sub_second','new paid source becomes canonical');
SELECT is((SELECT previous_deletion_action->>'subscription_id' FROM public.sms_billing_operations WHERE id=(SELECT id FROM operations WHERE label='rejoin')),'sub_first','terminal previous deletion authority is retained with replacement proof');
SELECT is((SELECT count(*)::integer FROM public.account_deletion_stripe_actions WHERE business_id=(SELECT b FROM fixture)),0,'proven terminal old outbox no longer blocks cancellation of the replacement');
SELECT ok(NOT public.sync_stripe_subscription_if_business_active((SELECT b FROM fixture),'cus_owner','sub_first','sms_and_chat','canceled',now()-interval '1 day',now()+interval '29 days','price_smsandchat',NULL,NULL,NULL,false,now()),'old cancellation cannot overwrite the new source');
SELECT is((SELECT setup_fee_paid_at FROM public.sms_billing_accounts WHERE business_id=(SELECT b FROM fixture)),now(),'setup payment keeps its original time');
INSERT INTO public.billing_usage_periods(business_id,period_start,period_end,plan,included_sms_parts,inbound_sms_parts,outbound_sms_parts)
 SELECT b,now(),now()+interval '30 days','sms_and_chat',1500,400,600 FROM fixture;
UPDATE public.businesses SET sms_overage_opt_in=true WHERE id=(SELECT b FROM fixture);
INSERT INTO operations VALUES('upgrade',pg_temp.acquire('upgrade','full','c'));
SELECT public.confirm_sms_billing_operation((SELECT id FROM operations WHERE label='upgrade'),(SELECT o FROM fixture),repeat('c',64));
SELECT public.record_sms_billing_operation((SELECT id FROM operations WHERE label='upgrade'),'{"stripe_subscription_id":"sub_second","invoice_id":"in_upgrade","state":"pending"}');
SELECT throws_ok($$SELECT public.finalize_paid_sms_billing_operation((SELECT id FROM operations WHERE label='upgrade'),pg_temp.snapshot('sub_second','full',now()+interval '1 hour'),pg_temp.payment('in_upgrade','sub_second'))$$,
 'P0001','sms_billing_period_changed','upgrade cannot reset the billing anchor');
SELECT ok(public.finalize_paid_sms_billing_operation((SELECT id FROM operations WHERE label='upgrade'),pg_temp.snapshot('sub_second','full'),pg_temp.payment('in_upgrade','sub_second')),'paid upgrade applies to the existing subscription');
SELECT is((SELECT included_sms_parts FROM public.billing_usage_periods WHERE business_id=(SELECT b FROM fixture)),2500,'existing SMS total cap increases to 2500');
SELECT is((SELECT inbound_sms_parts+outbound_sms_parts FROM public.billing_usage_periods WHERE business_id=(SELECT b FROM fixture)),1000,'consumed SMS parts do not reset');
SELECT ok((SELECT sms_overage_opt_in FROM public.businesses WHERE id=(SELECT b FROM fixture)),'SMS overage preference is preserved');
SELECT is((SELECT count(*)::integer FROM public.voice_allowance_periods WHERE business_id=(SELECT b FROM fixture)),1,'paid upgrade creates exactly one voice allowance');
SELECT ok(public.finalize_paid_sms_billing_operation((SELECT id FROM operations WHERE label='upgrade'),pg_temp.snapshot('sub_second','full'),pg_temp.payment('in_upgrade','sub_second')),'upgrade replay is idempotent');
SELECT is((SELECT count(*)::integer FROM public.voice_allowance_periods WHERE business_id=(SELECT b FROM fixture)),1,'replay cannot refill voice');
INSERT INTO operations VALUES('downgrade',pg_temp.acquire('downgrade','sms_and_chat','d'));
SELECT public.confirm_sms_billing_operation((SELECT id FROM operations WHERE label='downgrade'),(SELECT o FROM fixture),repeat('d',64));
SELECT public.record_sms_billing_operation((SELECT id FROM operations WHERE label='downgrade'),'{"schedule_id":"sub_sched_future","state":"scheduled"}');
SELECT ok(NOT public.complete_sms_billing_downgrade((SELECT id FROM operations WHERE label='downgrade'),'sub_second',now()),'scheduled downgrade cannot apply before renewal');
SELECT is((SELECT plan FROM public.subscriptions WHERE business_id=(SELECT b FROM fixture)),'full','prepaid tier remains through current period');
SELECT throws_ok($$DELETE FROM public.businesses WHERE id=(SELECT b FROM fixture)$$,'55000','sms_billing_retention_unresolved','hard delete cannot erase payable or historical source authority');
-- Exercise the real scrub -> queued cancellation -> provider acknowledgement ->
-- completion workflow. No synthetic scrub timestamp can conceal a deadlock.
SELECT public.record_sms_billing_operation((SELECT id FROM operations WHERE label='downgrade'),'{"state":"expired"}');
UPDATE public.businesses SET deleted_at=now()-interval '61 days',deletion_scheduled_for=now()-interval '1 day' WHERE id=(SELECT b FROM fixture);
SELECT is(public.cleanup_expired_business((SELECT b FROM fixture)),(SELECT o FROM fixture),'real cleanup scrubs and queues cancellation without losing billing authority');
SELECT is((SELECT count(*)::integer FROM public.sms_billing_operations WHERE business_id=(SELECT b FROM fixture)),4,'billing proof survives the scrub while provider cancellation is pending');
SELECT ok((SELECT desired_action='cancel' AND status='pending' FROM public.account_deletion_stripe_actions WHERE business_id=(SELECT b FROM fixture)),'cancellation queue commits before external work');
SELECT throws_ok($$SELECT public.complete_expired_business_cleanup((SELECT b FROM fixture),(SELECT generation FROM public.account_deletion_stripe_actions WHERE business_id=(SELECT b FROM fixture)))$$,
 '55000','sms_billing_retention_unresolved','final completion cannot erase an unapplied cancellation');
CREATE TEMP TABLE cancel_claim AS SELECT public.claim_account_deletion_stripe_action((SELECT b FROM fixture),
 (SELECT generation FROM public.account_deletion_stripe_actions WHERE business_id=(SELECT b FROM fixture)),'billing-cleanup-test',60) AS payload;
SELECT ok(public.finish_account_deletion_stripe_action((SELECT b FROM fixture),(SELECT (payload->>'generation')::bigint FROM cancel_claim),
 (SELECT (payload->>'lease_token')::uuid FROM cancel_claim),'applied','cancel',NULL,NULL),'provider cancellation acknowledgement uses existing generation and lease guard');
DELETE FROM auth.users WHERE id=(SELECT o FROM fixture);
SELECT ok(public.complete_expired_business_cleanup((SELECT b FROM fixture),(SELECT generation FROM public.account_deletion_stripe_actions WHERE business_id=(SELECT b FROM fixture))),
 'existing completion succeeds after cancellation and clears retained billing authority');
SELECT is((SELECT count(*)::integer FROM public.sms_billing_operations WHERE business_id=(SELECT b FROM fixture)),0,'final completion purges operation owner/source data');
SELECT is((SELECT count(*)::integer FROM public.sms_billing_accounts WHERE business_id=(SELECT b FROM fixture)),0,'final completion purges the durable customer and setup record');
SELECT ok((SELECT deleted_at IS NOT NULL AND owner_id IS NULL AND deletion_scheduled_for IS NULL FROM public.businesses WHERE id=(SELECT b FROM fixture)),'completion preserves the existing business tombstone contract');
SELECT ok(public.complete_expired_business_cleanup((SELECT b FROM fixture),NULL),'completed cleanup retry is idempotent');
SELECT ok(NOT public.sync_stripe_subscription_if_business_active((SELECT b FROM fixture),'cus_owner','sub_second','full','active',now(),now()+interval '30 days','price_full',NULL,NULL,NULL,false,now()),'late legacy source cannot resurrect the scrubbed tombstone');
SELECT * FROM finish();
ROLLBACK;
