BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();
CREATE TEMP TABLE upgrade_fixture(label text PRIMARY KEY,b uuid,o uuid,u uuid,op uuid,paid_at timestamptz);
CREATE FUNCTION pg_temp.upgrade_fixture(label text,target text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE bid uuid:=gen_random_uuid(); own uuid:=gen_random_uuid(); result jsonb;
BEGIN
 INSERT INTO auth.users(id,email) VALUES(own,own||'@example.test');
 INSERT INTO public.businesses(id,owner_id,name,business_type,slug,onboarding_step,onboarding_completed_at,onboarding_last_saved_at,onboarding_selected_plan,
  phone_number,email,address,city,state,zip,has_ein,legal_business_name,business_entity_type,business_registration_state,ein,
  authorized_rep_name,authorized_rep_title,authorized_rep_email,authorized_rep_phone,use_case_description,estimated_monthly_volume,sample_messages,opt_in_description,
  compliance_info_completed_at,a2p_risk_review_status,a2p_risk_review_input_hash,primary_goal)
 VALUES(bid,own,'Chat upgrade','general','chat-upgrade-'||bid,'complete',now()-interval '1 day',now()-interval '1 day','chat_only',
  '+12125550100','owner@example.test','1 Test St','Chicago','IL','60601',true,'Upgrade LLC','llc','IL','12-'||lpad((1000000+floor(random()*8000000))::bigint::text,7,'0'),
  'Owner Name','Owner','owner@example.test','+12125550100','Customer appointments','100',ARRAY['Sample one','Sample two','Sample three'],'Website consent',
  now(),'passed',repeat('a',64),'book');
 INSERT INTO public.subscriptions(business_id,stripe_customer_id,stripe_subscription_id,plan,status,current_period_start,current_period_end,stripe_price_id)
 VALUES(bid,'cus_'||replace(bid::text,'-',''),'sub_'||replace(bid::text,'-',''),'chat_only','active',now()-interval '10 days',now()+interval '20 days','price_chat');
 INSERT INTO public.business_plan_family_locks(business_id,family,claimed_by) VALUES(bid,'chat_only','stripe_sync');
 INSERT INTO public.chat_only_checkout_attempts(business_id,stripe_price_id,request_fingerprint,state,claim_token,claimed_at,claim_expires_at,
  stripe_checkout_session_id,stripe_customer_id,stripe_subscription_id,checkout_session_expires_at,completed_at,created_at)
 VALUES(bid,'price_chat',repeat('a',64),'completed',gen_random_uuid(),now()-interval '1 day',now()-interval '1 day',
  'cs_'||replace(bid::text,'-',''),'cus_'||replace(bid::text,'-',''),'sub_'||replace(bid::text,'-',''),now(),now()-interval '1 day',now()-interval '1 day');
 INSERT INTO public.business_hours(business_id,day_of_week,is_closed,open_time,close_time) SELECT bid,d,true,'09:00','17:00' FROM generate_series(0,6) d;
 INSERT INTO public.ai_settings(business_id) VALUES(bid);
 INSERT INTO public.services(business_id,name) SELECT bid,'Service '||n FROM generate_series(1,3) n;
 INSERT INTO public.faqs(business_id,question,answer) SELECT bid,'Question '||n,'Detailed answer to question '||n FROM generate_series(1,3) n;
 INSERT INTO public.billing_usage_periods(business_id,period_start,period_end,plan,included_sms_parts)
 VALUES(bid,now()-interval '40 days',now()-interval '10 days','chat_only',0);
 INSERT INTO public.ai_reply_usage_periods(business_id,period_start,period_end,billing_source,plan,included_ai_replies,completed_replies)
 VALUES(bid,now()-interval '10 days',now()+interval '20 days','subscription','chat_only',200,199);
 result:=public.save_chat_texting_upgrade(bid,own,target,target='sms_only');
 INSERT INTO upgrade_fixture VALUES(label,bid,own,(result->>'id')::uuid,NULL,NULL);
 RETURN (result->>'id')::uuid;
END $$;
CREATE FUNCTION pg_temp.prepare_upgrade(label text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE f upgrade_fixture; s public.subscriptions; result jsonb;
BEGIN
 SELECT * INTO f FROM upgrade_fixture WHERE upgrade_fixture.label=prepare_upgrade.label;
 PERFORM public.save_chat_texting_upgrade_details(f.u,f.o,'business','{"name":"Chat upgrade"}');
 PERFORM public.save_chat_texting_upgrade_details(f.u,f.o,'phone',jsonb_build_object('pending_phone_number','+12125550101','pending_phone_number_selected_at',now(),'pending_phone_number_failure_reason',NULL));
 SELECT * INTO s FROM public.subscriptions WHERE business_id=f.b;
 result:=public.acquire_chat_texting_upgrade_quote(f.u,f.o,jsonb_build_object('target_plan',(SELECT target_plan FROM public.chat_texting_upgrades WHERE id=f.u),
  'expected_setup_fingerprint',public.read_chat_texting_upgrade_setup(f.u,f.o)->>'setupFingerprint',
  'target_price_id','price_target','setup_fee_price_id','price_setup','stripe_item_id','si_primary','source_fingerprint',repeat('b',64),
  'expected_subscription_id',s.stripe_subscription_id,'expected_customer_id',s.stripe_customer_id,'proration_at',now(),
  'quote',jsonb_build_object('amountDueCents',3500,'currency','usd','monthlyPriceCents',2500)));
 UPDATE upgrade_fixture SET op=(result->>'id')::uuid WHERE upgrade_fixture.label=prepare_upgrade.label;
 RETURN (result->>'id')::uuid;
END $$;
CREATE FUNCTION pg_temp.payment_details(label text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('subscription_id',u.source_subscription_id,'customer_id',u.source_customer_id,'plan',u.target_plan,'price_id',o.target_price_id,
 'status','active','current_period_start',o.source_period_start,'current_period_end',o.source_period_end,'cancel_at_period_end',false,
 'invoice_id','in_'||replace(u.id::text,'-',''),'invoice_status','paid','invoice_paid_at',f.paid_at,'invoice_created_at',o.confirmed_at,
 'invoice_amount_due',3500,'invoice_currency','usd','setup_fee_price_id',o.setup_fee_price_id,'setup_fee_verified',true,
 'payment_period_start',o.source_period_start,'payment_period_end',o.source_period_end)
 FROM upgrade_fixture f JOIN public.chat_texting_upgrades u ON u.id=f.u JOIN public.sms_billing_operations o ON o.id=f.op WHERE f.label=payment_details.label
$$;
CREATE FUNCTION pg_temp.pay_upgrade(label text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE f upgrade_fixture;
BEGIN
 SELECT * INTO f FROM upgrade_fixture WHERE upgrade_fixture.label=pay_upgrade.label;
 PERFORM public.confirm_chat_texting_upgrade(f.u,f.o,f.op,repeat('b',64));
 UPDATE upgrade_fixture SET paid_at=clock_timestamp() WHERE upgrade_fixture.label=pay_upgrade.label;
 RETURN public.finalize_chat_texting_upgrade_payment(f.op,pg_temp.payment_details(label));
END $$;
CREATE FUNCTION pg_temp.ready_upgrade(label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE bid uuid;
BEGIN
 SELECT b INTO bid FROM upgrade_fixture WHERE upgrade_fixture.label=ready_upgrade.label;
 UPDATE public.businesses SET brand_status='approved',campaign_status='approved',telnyx_brand_id='brand_'||bid,telnyx_campaign_id='campaign_'||bid,telnyx_messaging_profile_id='profile_'||bid WHERE id=bid;
 INSERT INTO public.phone_numbers(business_id,phone_number,telnyx_phone_number_id,is_active,resource_status,telnyx_campaign_assignment_status,telnyx_campaign_assignment_campaign_id)
 VALUES(bid,'+1'||lpad((2000000000+floor(random()*7000000000))::bigint::text,10,'0'),'phone_'||bid,true,'active','assigned','campaign_'||bid);
END $$;

SELECT ok(NOT has_table_privilege('authenticated','public.chat_texting_upgrades','SELECT'),'upgrade authority is private');
SELECT ok(NOT has_table_privilege('service_role','public.chat_texting_upgrades','UPDATE'),'service writes use guarded RPCs');
SELECT ok(NOT has_function_privilege('authenticated','public.finalize_chat_texting_upgrade_payment(uuid,jsonb)','EXECUTE'),'paid transition is service-only');
SELECT ok(NOT has_function_privilege('service_role','public.confirm_sms_billing_operation_before_chat_upgrade(uuid,uuid,text)','EXECUTE'),'generic confirmation cannot bypass new guard');
SELECT pg_temp.upgrade_fixture('starter','sms_only');
SELECT throws_ok($$SELECT public.save_chat_texting_upgrade_details((SELECT u FROM upgrade_fixture WHERE label='starter'),gen_random_uuid(),'business','{"name":"Attack"}')$$,'42501','texting_upgrade_forbidden','owner identity is enforced');
SELECT throws_ok($$SELECT public.acquire_chat_texting_upgrade_quote((SELECT u FROM upgrade_fixture WHERE label='starter'),(SELECT o FROM upgrade_fixture WHERE label='starter'),'{}')$$,'P0001','texting_upgrade_incomplete','skipping explicit setup confirmations cannot start billing');
SELECT throws_ok($$SELECT public.save_chat_texting_upgrade_details((SELECT u FROM upgrade_fixture WHERE label='starter'),(SELECT o FROM upgrade_fixture WHERE label='starter'),'business','{"billing_mode":"comped"}')$$,'P0001','texting_upgrade_invalid_details','business save rejects authority fields');
SELECT pg_temp.prepare_upgrade('starter');
SELECT is((SELECT count(*)::integer FROM public.sms_billing_operations WHERE business_id=(SELECT b FROM upgrade_fixture WHERE label='starter')),1,'one prepared quote, no checkout or second subscription');
SELECT ok((SELECT onboarding_step='complete' AND onboarding_completed_at=now()-interval '1 day' AND onboarding_last_saved_at=now()-interval '1 day' FROM public.businesses WHERE id=(SELECT b FROM upgrade_fixture WHERE label='starter')),'upgrade saves preserve original onboarding progress');
SELECT ok((SELECT sms_consent_agreed AND sms_consent_agreed_at IS NOT NULL FROM public.businesses WHERE id=(SELECT b FROM upgrade_fixture WHERE label='starter')),'phone step stores explicit consent');
SELECT throws_ok($$SELECT public.confirm_sms_billing_operation((SELECT op FROM upgrade_fixture WHERE label='starter'),(SELECT o FROM upgrade_fixture WHERE label='starter'),repeat('b',64))$$,'P0001','texting_upgrade_required','ordinary SMS confirm cannot execute a Chat conversion');
SELECT public.confirm_chat_texting_upgrade((SELECT u FROM upgrade_fixture WHERE label='starter'),(SELECT o FROM upgrade_fixture WHERE label='starter'),(SELECT op FROM upgrade_fixture WHERE label='starter'),repeat('b',64));
UPDATE upgrade_fixture SET paid_at=clock_timestamp() WHERE label='starter';
SELECT throws_ok($$SELECT public.finalize_chat_texting_upgrade_payment((SELECT op FROM upgrade_fixture WHERE label='starter'),pg_temp.payment_details('starter')||'{"setup_fee_verified":false}')$$,'P0001','texting_upgrade_payment_unverified','missing setup fee proof cannot authorize service');
SELECT throws_ok($$UPDATE public.businesses SET legal_business_name='Changed' WHERE id=(SELECT b FROM upgrade_fixture WHERE label='starter')$$,'55000','texting_upgrade_details_locked','payable work freezes carrier input');
SELECT ok(public.finalize_chat_texting_upgrade_payment((SELECT op FROM upgrade_fixture WHERE label='starter'),pg_temp.payment_details('starter')),'paid conversion applies atomically');
SELECT is((SELECT plan FROM public.subscriptions WHERE business_id=(SELECT b FROM upgrade_fixture WHERE label='starter')),'sms_only','billed subscription transitions to Starter');
SELECT is(public.infer_business_plan_family((SELECT b FROM upgrade_fixture WHERE label='starter')),'sms','historical Chat usage is compatible with proven conversion');
SELECT is(public.get_business_effective_service_plan((SELECT b FROM upgrade_fixture WHERE label='starter'),'sms_only'),'chat_only','delivered service remains Chat while carrier is pending');
SELECT is((public.get_current_ai_reply_usage((SELECT b FROM upgrade_fixture WHERE label='starter'))->>'remaining_replies')::integer,1,'payment preserves existing 199 of 200 reply usage');
SELECT ok(public.website_scan_has_ai_customization_entitlement((SELECT b FROM upgrade_fixture WHERE label='starter')),'pending Starter retains Chat website scan access');
SELECT ok(NOT public.activate_chat_texting_upgrade((SELECT u FROM upgrade_fixture WHERE label='starter')),'payment alone cannot activate SMS');
SELECT ok(public.finalize_chat_texting_upgrade_payment((SELECT op FROM upgrade_fixture WHERE label='starter'),pg_temp.payment_details('starter')),'repeated paid finalization is idempotent');
SELECT ok(NOT public.sync_stripe_subscription_if_business_active((SELECT b FROM upgrade_fixture WHERE label='starter'),(SELECT source_customer_id FROM public.chat_texting_upgrades WHERE id=(SELECT u FROM upgrade_fixture WHERE label='starter')),
 (SELECT source_subscription_id FROM public.chat_texting_upgrades WHERE id=(SELECT u FROM upgrade_fixture WHERE label='starter')),'chat_only','active',now()-interval '10 days',now()+interval '20 days','price_chat',NULL,NULL,NULL,false,now()),'old Chat projection cannot revert paid conversion');
SELECT throws_ok($$SELECT public.acquire_sms_billing_operation((SELECT b FROM upgrade_fixture WHERE label='starter'),(SELECT o FROM upgrade_fixture WHERE label='starter'),'{"kind":"upgrade","target_plan":"full","target_price_id":"price_full","source_fingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}')$$,'P0001','texting_upgrade_in_progress','later SMS tier change is frozen before activation');
SELECT is((SELECT count(*)::integer FROM public.claim_chat_texting_upgrade_reconciliation(5,120)),1,'scheduler claims due upgrade');
SELECT is((SELECT count(*)::integer FROM public.claim_chat_texting_upgrade_reconciliation(5,120)),0,'overlapping scheduler does not claim again');
SELECT pg_temp.ready_upgrade('starter');
UPDATE public.businesses SET deletion_scheduled_for=now()+interval '7 days' WHERE id=(SELECT b FROM upgrade_fixture WHERE label='starter');
SELECT ok(NOT public.activate_chat_texting_upgrade((SELECT u FROM upgrade_fixture WHERE label='starter')),'scheduled account deletion prevents late carrier activation');
UPDATE public.businesses SET deletion_scheduled_for=NULL,operations_suspended_at=now() WHERE id=(SELECT b FROM upgrade_fixture WHERE label='starter');
SELECT ok(NOT public.activate_chat_texting_upgrade((SELECT u FROM upgrade_fixture WHERE label='starter')),'operational suspension prevents carrier activation');
UPDATE public.businesses SET operations_suspended_at=NULL,telnyx_unique_claims_released_at=now() WHERE id=(SELECT b FROM upgrade_fixture WHERE label='starter');
SELECT ok(NOT public.activate_chat_texting_upgrade((SELECT u FROM upgrade_fixture WHERE label='starter')),'released ownership prevents carrier activation');
UPDATE public.businesses SET telnyx_unique_claims_released_at=NULL WHERE id=(SELECT b FROM upgrade_fixture WHERE label='starter');
UPDATE public.subscriptions SET cancel_at_period_end=true WHERE business_id=(SELECT b FROM upgrade_fixture WHERE label='starter');
SELECT ok(NOT public.activate_chat_texting_upgrade((SELECT u FROM upgrade_fixture WHERE label='starter')),'late carrier approval cannot activate after cancellation request');
SELECT is(public.get_business_effective_service_plan((SELECT b FROM upgrade_fixture WHERE label='starter'),'sms_only'),'chat_only','paid Chat remains until cancellation takes effect');
UPDATE public.subscriptions SET cancel_at_period_end=false WHERE business_id=(SELECT b FROM upgrade_fixture WHERE label='starter');
SELECT ok(public.activate_chat_texting_upgrade((SELECT u FROM upgrade_fixture WHERE label='starter')),'complete fresh carrier readiness activates');
SELECT ok(public.activate_chat_texting_upgrade((SELECT u FROM upgrade_fixture WHERE label='starter')),'activation replay is idempotent');
SELECT is(public.get_business_effective_service_plan((SELECT b FROM upgrade_fixture WHERE label='starter'),'sms_only'),'sms_only','Starter removes Chat only after activation');
SELECT ok(NOT public.website_scan_has_ai_customization_entitlement((SELECT b FROM upgrade_fixture WHERE label='starter')),'Starter feature loss applies after activation');
SELECT is(public.get_current_ai_reply_usage((SELECT b FROM upgrade_fixture WHERE label='starter'))->>'outcome','not_entitled','Starter stops new Chat usage');
UPDATE public.businesses SET campaign_status='pending' WHERE id=(SELECT b FROM upgrade_fixture WHERE label='starter');
SELECT is(public.get_business_effective_service_plan((SELECT b FROM upgrade_fixture WHERE label='starter'),'sms_only'),'sms_only','carrier regression never resurrects temporary Chat access');

SELECT pg_temp.upgrade_fixture('full','full');
SELECT pg_temp.prepare_upgrade('full');
SELECT ok(pg_temp.pay_upgrade('full'),'Full paid conversion uses voice entitlement hook');
SELECT is(public.get_business_effective_service_plan((SELECT b FROM upgrade_fixture WHERE label='full'),'full'),'chat_only','Full also retains exact Chat service while pending');
SELECT is((public.get_current_ai_reply_usage((SELECT b FROM upgrade_fixture WHERE label='full'))->>'allowance')::integer,200,'Full does not grant unlimited replies before activation');
SELECT is((SELECT count(*)::integer FROM public.voice_billing_projection WHERE business_id=(SELECT b FROM upgrade_fixture WHERE label='full')),1,'Full paid projection exists once');
SELECT ok(public.finalize_chat_texting_upgrade_payment((SELECT op FROM upgrade_fixture WHERE label='full'),pg_temp.payment_details('full')),'Full replay reuses original grant');
UPDATE public.subscriptions SET status='canceled' WHERE business_id=(SELECT b FROM upgrade_fixture WHERE label='full');
SELECT is(public.get_current_ai_reply_usage((SELECT b FROM upgrade_fixture WHERE label='full'))->>'outcome','not_entitled','canceled billing cannot receive permanent Chat grace');
SELECT ok(NOT public.activate_chat_texting_upgrade((SELECT u FROM upgrade_fixture WHERE label='full')),'canceled Full cannot activate');

SELECT pg_temp.upgrade_fixture('recovery','sms_and_chat');
SELECT pg_temp.prepare_upgrade('recovery');
SELECT ok(pg_temp.pay_upgrade('recovery'),'Growth conversion pays before provider recovery');
UPDATE public.businesses SET pending_phone_number_failure_reason='Number unavailable',onboarding_registration_status='failed'
 WHERE id=(SELECT b FROM upgrade_fixture WHERE label='recovery');
SELECT lives_ok($$SELECT public.save_chat_texting_upgrade_details((SELECT u FROM upgrade_fixture WHERE label='recovery'),(SELECT o FROM upgrade_fixture WHERE label='recovery'),
 'phone',jsonb_build_object('pending_phone_number','+12125550103','pending_phone_number_selected_at',now(),'pending_phone_number_failure_reason',NULL))$$,'paid missing-number recovery saves without a second billing operation');
SELECT is((SELECT count(*)::integer FROM public.sms_billing_operations WHERE business_id=(SELECT b FROM upgrade_fixture WHERE label='recovery')),1,'phone replacement keeps exactly one paid operation');
UPDATE public.businesses SET onboarding_registration_status='submitting' WHERE id=(SELECT b FROM upgrade_fixture WHERE label='recovery');
SELECT ok(public.persist_chat_texting_upgrade_campaign_copy((SELECT b FROM upgrade_fixture WHERE label='recovery'),NULL,'Final carrier opt-in disclosure'),'provider can persist generated carrier copy through narrow RPC');
SELECT ok((SELECT provider_copy_write_token IS NULL FROM public.chat_texting_upgrades WHERE id=(SELECT u FROM upgrade_fixture WHERE label='recovery')),'provider write permission is cleared atomically');
SELECT throws_ok($$UPDATE public.businesses SET opt_in_description='Customer override' WHERE id=(SELECT b FROM upgrade_fixture WHERE label='recovery')$$,'55000','texting_upgrade_details_locked','provider RPC does not leave owner input unlocked');
UPDATE public.businesses SET campaign_status='rejected' WHERE id=(SELECT b FROM upgrade_fixture WHERE label='recovery');
SELECT ok(NOT public.activate_chat_texting_upgrade((SELECT u FROM upgrade_fixture WHERE label='recovery')),'rejected campaign cannot activate');
SELECT is((SELECT state FROM public.chat_texting_upgrades WHERE id=(SELECT u FROM upgrade_fixture WHERE label='recovery')),'support_required','rejection enters durable support review');
SELECT is(public.get_business_effective_service_plan((SELECT b FROM upgrade_fixture WHERE label='recovery'),'sms_and_chat'),'chat_only','support review retains the exact paid Chat service');
SELECT throws_ok($$SELECT public.persist_chat_texting_upgrade_campaign_copy((SELECT b FROM upgrade_fixture WHERE label='recovery'),NULL,'Unauthorized resubmission')$$,
 'P0001','texting_upgrade_provider_write_forbidden','support-required rejection cannot resubmit carrier copy');
SELECT throws_ok($$SELECT public.resume_chat_texting_upgrade_after_admin_recheck((SELECT b FROM upgrade_fixture WHERE label='recovery'),gen_random_uuid())$$,
 '55000','phone_assignment_recheck_unavailable','support resume requires an actor-audited request in the same transaction');
SELECT pg_temp.ready_upgrade('recovery');
SELECT ok(NOT public.activate_chat_texting_upgrade((SELECT u FROM upgrade_fixture WHERE label='recovery')),'carrier callback cannot bypass the explicit support hold');
UPDATE public.phone_numbers SET telnyx_campaign_assignment_status='unassigned',telnyx_campaign_assignment_campaign_id=NULL
 WHERE business_id=(SELECT b FROM upgrade_fixture WHERE label='recovery');
UPDATE public.subscriptions SET cancel_at_period_end=true WHERE business_id=(SELECT b FROM upgrade_fixture WHERE label='recovery');
SELECT throws_ok($$SELECT public.request_admin_phone_assignment_recheck((SELECT b FROM upgrade_fixture WHERE label='recovery'),(SELECT o FROM upgrade_fixture WHERE label='recovery'))$$,
 '55000','phone_assignment_recheck_unavailable','admin recheck cannot resume canceled upgrade provisioning');
SELECT is((SELECT count(*)::integer FROM public.admin_action_events WHERE business_id=(SELECT b FROM upgrade_fixture WHERE label='recovery')),0,'failed support resume rolls back its audit and state together');
UPDATE public.subscriptions SET cancel_at_period_end=false WHERE business_id=(SELECT b FROM upgrade_fixture WHERE label='recovery');
GRANT SELECT ON upgrade_fixture TO service_role;
SET LOCAL ROLE service_role;
SELECT lives_ok($$SELECT public.request_admin_phone_assignment_recheck((SELECT b FROM upgrade_fixture WHERE label='recovery'),(SELECT o FROM upgrade_fixture WHERE label='recovery'))$$,
 'admin correction resumes assignment of the existing approved unassigned number');
RESET ROLE;
SELECT is((SELECT state FROM public.chat_texting_upgrades WHERE id=(SELECT u FROM upgrade_fixture WHERE label='recovery')),'carrier_pending','audited recovery clears only support hold');
SELECT is((SELECT count(*)::integer FROM public.admin_action_events WHERE business_id=(SELECT b FROM upgrade_fixture WHERE label='recovery') AND action='phone_assignment_recheck_requested'),1,'support resume records the existing actor-attributed audit');
UPDATE public.businesses SET campaign_status='rejected' WHERE id=(SELECT b FROM upgrade_fixture WHERE label='recovery');
SELECT public.activate_chat_texting_upgrade((SELECT u FROM upgrade_fixture WHERE label='recovery'));
UPDATE public.businesses SET campaign_status='approved' WHERE id=(SELECT b FROM upgrade_fixture WHERE label='recovery');
UPDATE public.phone_numbers SET telnyx_campaign_assignment_status='assigned',telnyx_campaign_assignment_campaign_id='campaign_'||business_id
 WHERE business_id=(SELECT b FROM upgrade_fixture WHERE label='recovery');
SELECT lives_ok($$SELECT public.request_admin_phone_assignment_recheck((SELECT b FROM upgrade_fixture WHERE label='recovery'),(SELECT o FROM upgrade_fixture WHERE label='recovery'))$$,
 'already assigned paid upgrade can use admin recheck for activation-only recovery');
SELECT ok(public.activate_chat_texting_upgrade((SELECT u FROM upgrade_fixture WHERE label='recovery')),'corrected carrier approval can activate after audited support resume');

SELECT pg_temp.upgrade_fixture('renewal','sms_and_chat');
SELECT pg_temp.prepare_upgrade('renewal');
SELECT public.confirm_chat_texting_upgrade((SELECT u FROM upgrade_fixture WHERE label='renewal'),(SELECT o FROM upgrade_fixture WHERE label='renewal'),(SELECT op FROM upgrade_fixture WHERE label='renewal'),repeat('b',64));
-- Simulate an exact paid invoice from the previous billing cycle whose local
-- finalization was delayed until after Stripe renewed the same subscription.
UPDATE public.sms_billing_operations SET source_period_start=now()-interval '40 days',source_period_end=now()-interval '10 days',
 confirmed_at=now()-interval '15 days',created_at=now()-interval '15 days',expires_at=now()-interval '15 days'+interval '10 minutes'
 WHERE id=(SELECT op FROM upgrade_fixture WHERE label='renewal');
UPDATE upgrade_fixture SET paid_at=now()-interval '15 days'+interval '1 minute' WHERE label='renewal';
SELECT ok(public.finalize_chat_texting_upgrade_payment((SELECT op FROM upgrade_fixture WHERE label='renewal'),pg_temp.payment_details('renewal')||
 jsonb_build_object('current_period_start',now()-interval '10 days','current_period_end',now()+interval '20 days')),'exact prior-cycle payment recovers across a later renewal');
SELECT is((SELECT current_period_start FROM public.subscriptions WHERE business_id=(SELECT b FROM upgrade_fixture WHERE label='renewal')),now()-interval '10 days','recovery keeps current provider billing period');
SELECT is((SELECT payment_effective_at FROM public.sms_billing_operations WHERE id=(SELECT op FROM upgrade_fixture WHERE label='renewal')),now()-interval '15 days'+interval '1 minute','recovery preserves original payment time');
SELECT is((public.get_current_ai_reply_usage((SELECT b FROM upgrade_fixture WHERE label='renewal'))->>'remaining_replies')::integer,1,'delayed recovery does not reset the current Chat allowance');

SELECT pg_temp.upgrade_fixture('refresh','sms_and_chat');
SELECT pg_temp.prepare_upgrade('refresh');
SELECT throws_ok($$SELECT public.acquire_chat_texting_upgrade_quote((SELECT u FROM upgrade_fixture WHERE label='refresh'),(SELECT o FROM upgrade_fixture WHERE label='refresh'),'{"expected_setup_fingerprint":"stale"}')$$,
 'P0001','texting_upgrade_source_changed','quote rejects stale setup snapshot before touching billing authority');
CREATE TEMP TABLE original_quote AS SELECT op FROM upgrade_fixture WHERE label='refresh';
SELECT pg_temp.prepare_upgrade('refresh');
SELECT is((SELECT state FROM public.sms_billing_operations WHERE id=(SELECT op FROM original_quote)),'expired','editing or refreshing expires the old unconfirmed quote');
SELECT throws_ok($$SELECT public.confirm_chat_texting_upgrade((SELECT u FROM upgrade_fixture WHERE label='refresh'),(SELECT o FROM upgrade_fixture WHERE label='refresh'),(SELECT op FROM original_quote),repeat('b',64))$$,'P0001','texting_upgrade_locked','old quote cannot confirm after a refresh');
UPDATE public.faqs SET answer='Updated current knowledge' WHERE business_id=(SELECT b FROM upgrade_fixture WHERE label='refresh');
SELECT throws_ok($$SELECT public.confirm_chat_texting_upgrade((SELECT u FROM upgrade_fixture WHERE label='refresh'),(SELECT o FROM upgrade_fixture WHERE label='refresh'),(SELECT op FROM upgrade_fixture WHERE label='refresh'),repeat('b',64))$$,'P0001','texting_upgrade_incomplete','knowledge changes invalidate a prepared quote');

SELECT pg_temp.upgrade_fixture('cancel','sms_and_chat');
SELECT pg_temp.prepare_upgrade('cancel');
SELECT public.confirm_chat_texting_upgrade((SELECT u FROM upgrade_fixture WHERE label='cancel'),(SELECT o FROM upgrade_fixture WHERE label='cancel'),(SELECT op FROM upgrade_fixture WHERE label='cancel'),repeat('b',64));
SELECT throws_ok($$SELECT public.cancel_chat_texting_upgrade((SELECT u FROM upgrade_fixture WHERE label='cancel'),(SELECT o FROM upgrade_fixture WHERE label='cancel'))$$,'P0001','texting_upgrade_payment_unresolved','unknown provider work cannot be abandoned');
SELECT public.record_sms_billing_operation((SELECT op FROM upgrade_fixture WHERE label='cancel'),'{"state":"expired"}');
SELECT is((SELECT state FROM public.chat_texting_upgrades WHERE id=(SELECT u FROM upgrade_fixture WHERE label='cancel')),'draft','verified provider expiry returns unpaid upgrade to draft');
SELECT public.cancel_chat_texting_upgrade((SELECT u FROM upgrade_fixture WHERE label='cancel'),(SELECT o FROM upgrade_fixture WHERE label='cancel'));
SELECT is((SELECT state FROM public.chat_texting_upgrades WHERE id=(SELECT u FROM upgrade_fixture WHERE label='cancel')),'abandoned','resolved unpaid draft can be abandoned');
SELECT is((SELECT plan FROM public.subscriptions WHERE business_id=(SELECT b FROM upgrade_fixture WHERE label='cancel')),'chat_only','abandoning preserves original paid Chat subscription');
SELECT * FROM finish();
ROLLBACK;
