BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SET LOCAL statement_timeout='30s';
SELECT no_plan();

-- The fixtures below commit on a second connection to exercise real row-lock
-- contention. Require an explicitly attested, isolated local database.
DO $local_only$
BEGIN
 IF current_user<>'postgres' OR current_setting('port')<>'5432'
  OR current_setting('simplassist.disposable_test_database',true) IS DISTINCT FROM 'on'
  OR (inet_server_addr() IS NOT NULL AND NOT (inet_server_addr()<<=inet '127.0.0.0/8'
   OR inet_server_addr()<<=inet '10.0.0.0/8' OR inet_server_addr()<<=inet '172.16.0.0/12'
   OR inet_server_addr()<<=inet '192.168.0.0/16' OR inet_server_addr()<<=inet '::1/128'))
  THEN RAISE EXCEPTION 'test_091_requires_disposable_local_database' USING ERRCODE='55000'; END IF;
END $local_only$;

SELECT extensions.dblink_connect(n,'host=supabase_db_SimplAssist port=5432 dbname='||current_database()||' user=postgres password=postgres')
 FROM unnest(ARRAY['upgrade_setup','upgrade_a','upgrade_b']) n;
SELECT extensions.dblink_exec(n,'SET statement_timeout=''20s''; SET lock_timeout=''5s''')
 FROM unnest(ARRAY['upgrade_setup','upgrade_a','upgrade_b']) n;
SELECT extensions.dblink_exec('upgrade_setup',$fixtures$
SET search_path=public,extensions;
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


DO $$ BEGIN
 PERFORM pg_temp.upgrade_fixture('payment','full');
 PERFORM pg_temp.prepare_upgrade('payment');
 PERFORM public.confirm_chat_texting_upgrade((SELECT u FROM upgrade_fixture WHERE label='payment'),
  (SELECT o FROM upgrade_fixture WHERE label='payment'),(SELECT op FROM upgrade_fixture WHERE label='payment'),repeat('b',64));
 UPDATE upgrade_fixture SET paid_at=clock_timestamp() WHERE label='payment';
 PERFORM pg_temp.upgrade_fixture('quote','sms_only');
 PERFORM pg_temp.prepare_upgrade('quote');
END $$;
$fixtures$);
CREATE TEMP TABLE concurrency_fixture AS SELECT * FROM extensions.dblink('upgrade_setup',
 'SELECT label,b,o,u,op,pg_temp.payment_details(label) FROM upgrade_fixture') AS f(label text,b uuid,o uuid,u uuid,op uuid,payment jsonb);

-- A finalizer that has already applied billing still holds the business lock.
-- A simultaneous webhook must wait, then observe the same paid operation.
SELECT extensions.dblink_exec('upgrade_a','BEGIN');
SELECT ok(result,'first paid finalizer succeeds') FROM extensions.dblink('upgrade_a',
 (SELECT format('SELECT public.finalize_chat_texting_upgrade_payment(%L,%L::jsonb)',op,payment) FROM concurrency_fixture WHERE label='payment')) AS r(result boolean);
SELECT extensions.dblink_send_query('upgrade_b',
 (SELECT format('SELECT public.finalize_chat_texting_upgrade_payment(%L,%L::jsonb)',op,payment) FROM concurrency_fixture WHERE label='payment'));
SELECT pg_sleep(0.1);
SELECT is(extensions.dblink_is_busy('upgrade_b'),1,'duplicate paid finalization waits on the business lock');
SELECT extensions.dblink_exec('upgrade_a','COMMIT');
SELECT ok(result,'duplicate paid finalizer observes the same committed payment') FROM extensions.dblink_get_result('upgrade_b') AS r(result boolean);
SELECT * FROM extensions.dblink_get_result('upgrade_b') AS r(result boolean);
SELECT is((SELECT count(*)::integer FROM public.sms_billing_operations WHERE business_id=(SELECT b FROM concurrency_fixture WHERE label='payment') AND state='applied'),1,'concurrent delivery records exactly one paid operation');
SELECT is((SELECT count(*)::integer FROM public.voice_allowance_periods WHERE subscription_id=(SELECT source_subscription_id FROM public.chat_texting_upgrades WHERE id=(SELECT u FROM concurrency_fixture WHERE label='payment'))),1,'concurrent paid delivery grants one Full voice period');
SELECT is((SELECT count(*)::integer FROM public.voice_billing_payments WHERE subscription_id=(SELECT source_subscription_id FROM public.chat_texting_upgrades WHERE id=(SELECT u FROM concurrency_fixture WHERE label='payment'))),1,'concurrent paid delivery records one voice payment fact');

-- Scheduler workers skip rows held by the other claim instead of waiting and
-- making a second provider request for that same upgrade.
SELECT extensions.dblink_exec('upgrade_a','BEGIN');
SELECT is(result,1,'first reconciliation worker claims paid upgrade') FROM extensions.dblink('upgrade_a',
 'SELECT count(*)::integer FROM public.claim_chat_texting_upgrade_reconciliation(1,120)') AS r(result integer);
SELECT is(result,0,'overlapping reconciliation skips the locked upgrade') FROM extensions.dblink('upgrade_b',
 'SELECT count(*)::integer FROM public.claim_chat_texting_upgrade_reconciliation(1,120)') AS r(result integer);
SELECT extensions.dblink_exec('upgrade_a','COMMIT');

-- Once confirmation wins the lock, preview refresh cannot replace its invoice
-- authority with a newly prepared quote.
SELECT extensions.dblink_exec('upgrade_a','BEGIN');
SELECT result->>'state' FROM extensions.dblink('upgrade_a',
 (SELECT format('SELECT public.confirm_chat_texting_upgrade(%L,%L,%L,%L)',u,o,op,repeat('b',64)) FROM concurrency_fixture WHERE label='quote')) AS r(result jsonb);
SELECT extensions.dblink_send_query('upgrade_b',
 (SELECT format('SELECT public.acquire_chat_texting_upgrade_quote(%L,%L,%L::jsonb)',u,o,'{}') FROM concurrency_fixture WHERE label='quote'));
SELECT pg_sleep(0.1);
SELECT is(extensions.dblink_is_busy('upgrade_b'),1,'quote refresh waits for concurrent confirmation');
SELECT extensions.dblink_exec('upgrade_a','COMMIT');
SELECT * FROM extensions.dblink_get_result('upgrade_b',false) AS r(result jsonb);
SELECT ok(extensions.dblink_error_message('upgrade_b') LIKE '%texting_upgrade_locked%','confirmed operation rejects the waiting quote refresh');
SELECT * FROM extensions.dblink_get_result('upgrade_b',false) AS r(result jsonb);
SELECT is((SELECT count(*)::integer FROM public.sms_billing_operations WHERE business_id=(SELECT b FROM concurrency_fixture WHERE label='quote')),1,'confirmation versus refresh creates no second billing operation');

-- Fresh cancellation is projected using the existing business lock. Carrier
-- activation arriving while that projection is committing must see canceled.
SELECT extensions.dblink_exec('upgrade_setup',$ready$
DO $$ BEGIN PERFORM pg_temp.ready_upgrade('payment'); END $$;
$ready$);
SELECT extensions.dblink_exec('upgrade_a','BEGIN');
SELECT ok(result,'verified cancellation projects successfully') FROM extensions.dblink('upgrade_a',
 (SELECT format('SELECT public.sync_stripe_subscription_if_business_active(%L,%L,%L,%L,%L,%L::timestamptz,%L::timestamptz,%L,%L,NULL,%L::timestamptz,false,clock_timestamp())',
  f.b,u.source_customer_id,u.source_subscription_id,u.target_plan,'canceled',s.current_period_start,s.current_period_end,s.stripe_price_id,s.stripe_setup_fee_price_id,u.paid_at)
  FROM concurrency_fixture f JOIN public.chat_texting_upgrades u ON u.id=f.u JOIN public.subscriptions s ON s.business_id=f.b WHERE f.label='payment')) AS r(result boolean);
SELECT extensions.dblink_send_query('upgrade_b',
 (SELECT format('SELECT public.activate_chat_texting_upgrade(%L)',u) FROM concurrency_fixture WHERE label='payment'));
SELECT pg_sleep(0.1);
SELECT is(extensions.dblink_is_busy('upgrade_b'),1,'carrier activation waits for current cancellation projection');
SELECT extensions.dblink_exec('upgrade_a','COMMIT');
SELECT ok(NOT result,'waiting carrier approval cannot activate canceled billing') FROM extensions.dblink_get_result('upgrade_b') AS r(result boolean);
SELECT * FROM extensions.dblink_get_result('upgrade_b') AS r(result boolean);
SELECT is(result,'not_entitled','cancellation also stops retained Chat service') FROM extensions.dblink('upgrade_b',
 (SELECT format('SELECT public.get_current_ai_reply_usage(%L)->>''outcome''',b) FROM concurrency_fixture WHERE label='payment')) AS r(result text);

-- Restore the synthetic active subscription and race two ready callbacks.
SELECT extensions.dblink_exec('upgrade_setup',$active$
UPDATE public.subscriptions SET status='active' WHERE business_id=(SELECT b FROM upgrade_fixture WHERE label='payment');
$active$);
SELECT extensions.dblink_exec('upgrade_a','BEGIN');
SELECT ok(result,'first fully ready activation succeeds') FROM extensions.dblink('upgrade_a',
 (SELECT format('SELECT public.activate_chat_texting_upgrade(%L)',u) FROM concurrency_fixture WHERE label='payment')) AS r(result boolean);
SELECT extensions.dblink_send_query('upgrade_b',
 (SELECT format('SELECT public.activate_chat_texting_upgrade(%L)',u) FROM concurrency_fixture WHERE label='payment'));
SELECT pg_sleep(0.1);
SELECT is(extensions.dblink_is_busy('upgrade_b'),1,'duplicate activation waits on the same business lock');
SELECT extensions.dblink_exec('upgrade_a','COMMIT');
SELECT ok(result,'duplicate ready callback returns the existing activation') FROM extensions.dblink_get_result('upgrade_b') AS r(result boolean);
SELECT * FROM extensions.dblink_get_result('upgrade_b') AS r(result boolean);
SELECT is((SELECT count(*)::integer FROM public.voice_allowance_periods WHERE subscription_id=(SELECT source_subscription_id FROM public.chat_texting_upgrades WHERE id=(SELECT u FROM concurrency_fixture WHERE label='payment'))),1,'activation never resets or grants a second Full voice period');

-- Dispose only this file's random synthetic IDs. Immutable payment facts are
-- removed here solely because this file requires a disposable database.
SELECT extensions.dblink_exec('upgrade_setup',$cleanup$
ALTER TABLE public.voice_allowance_periods DISABLE TRIGGER guard_voice_allowance_period;
DELETE FROM public.voice_allowance_periods WHERE subscription_id IN (SELECT u.source_subscription_id FROM public.chat_texting_upgrades u JOIN upgrade_fixture f ON f.u=u.id);
ALTER TABLE public.voice_allowance_periods ENABLE TRIGGER guard_voice_allowance_period;
ALTER TABLE public.voice_billing_payments DISABLE TRIGGER guard_voice_payment_history;
DELETE FROM public.voice_billing_payments WHERE subscription_id IN (SELECT u.source_subscription_id FROM public.chat_texting_upgrades u JOIN upgrade_fixture f ON f.u=u.id);
ALTER TABLE public.voice_billing_payments ENABLE TRIGGER guard_voice_payment_history;
DELETE FROM public.sms_billing_operations WHERE business_id IN (SELECT b FROM upgrade_fixture);
DELETE FROM public.sms_billing_accounts WHERE business_id IN (SELECT b FROM upgrade_fixture);
DELETE FROM public.chat_only_checkout_attempts WHERE business_id IN (SELECT b FROM upgrade_fixture);
DELETE FROM public.businesses WHERE id IN (SELECT b FROM upgrade_fixture);
DELETE FROM auth.users WHERE id IN (SELECT o FROM upgrade_fixture);
$cleanup$);
SELECT extensions.dblink_disconnect(n) FROM unnest(ARRAY['upgrade_setup','upgrade_a','upgrade_b']) n;
SELECT is((SELECT count(*)::integer FROM public.businesses WHERE id IN (SELECT b FROM concurrency_fixture)),0,'concurrency fixtures are cleaned up');
SELECT * FROM finish();
ROLLBACK;
