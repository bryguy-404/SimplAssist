BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();
DO $require_disposable_local_database$
DECLARE
  v_server_address inet := inet_server_addr();
  v_known_local_jwt boolean := current_setting(
    'app.settings.jwt_secret',
    true
  ) = 'super-secret-jwt-token-with-at-least-32-characters-long';
  v_explicit_disposable_attestation boolean := current_setting(
    'simplassist.disposable_test_database',
    true
  ) = 'on';
BEGIN
  IF current_user <> 'postgres'
     OR current_setting('port') <> '5432'
     OR NOT (
       v_server_address IS NULL
       OR v_server_address <<= inet '127.0.0.0/8'
       OR v_server_address <<= inet '10.0.0.0/8'
       OR v_server_address <<= inet '172.16.0.0/12'
       OR v_server_address <<= inet '192.168.0.0/16'
       OR v_server_address <<= inet '::1/128'
       OR v_server_address <<= inet 'fc00::/7'
     )
     OR NOT (
       (
         current_database() = 'postgres'
         AND current_setting('data_directory') = '/var/lib/postgresql/data'
         AND v_known_local_jwt
       )
       OR v_explicit_disposable_attestation
     ) THEN
    RAISE EXCEPTION
      'test_082_voice_concurrency_requires_disposable_local_database'
      USING ERRCODE = '55000';
  END IF;
END;
$require_disposable_local_database$;
SELECT extensions.dblink_connect('monthly_setup','host=supabase_db_SimplAssist port=5432 dbname=postgres user=postgres password=postgres');
SELECT extensions.dblink_exec('monthly_setup',$setup$
CREATE TEMP TABLE monthly_audit_before AS SELECT id FROM public.voice_commercial_audit;
-- This concurrency fixture exercises the legacy meter without changing an admitted protocol.
ALTER TABLE public.voice_sessions ALTER COLUMN disclosure_version SET DEFAULT 0;
INSERT INTO auth.users(id,email) VALUES('00000000-0000-4000-a082-000000000001','monthly-race@example.test');
INSERT INTO public.businesses(id,owner_id,name,business_type,slug) VALUES('10000000-0000-4000-a082-000000000001','00000000-0000-4000-a082-000000000001','Monthly race','general','monthly-race');
INSERT INTO public.voice_rollout_businesses(business_id,enabled) VALUES('10000000-0000-4000-a082-000000000001',true);
INSERT INTO public.voice_commercial_settings(business_id,primary_response) VALUES('10000000-0000-4000-a082-000000000001','voice');
INSERT INTO public.subscriptions(business_id,stripe_customer_id,stripe_subscription_id,plan,status,current_period_start,current_period_end)
  VALUES('10000000-0000-4000-a082-000000000001','cus_monthly_race','sub_monthly_race','full','active',date_trunc('day',now())-interval '10 days',date_trunc('day',now())+interval '20 days');
INSERT INTO public.phone_numbers(business_id,phone_number,telnyx_phone_number_id,is_active) VALUES('10000000-0000-4000-a082-000000000001','+15555558888','monthly-race-number',true);
DO $$ DECLARE rev bigint; p uuid; operation uuid; BEGIN
  rev:=public.begin_voice_billing_reconciliation('10000000-0000-4000-a082-000000000001','sub_monthly_race','cus_monthly_race');
  INSERT INTO public.sms_billing_operations(business_id,owner_id,kind,state,target_plan,target_price_id,stripe_subscription_id,stripe_customer_id,
    source_fingerprint,expires_at,confirmed_at,applied_at,invoice_id,payment_effective_at,payment_verified_at)
    VALUES('10000000-0000-4000-a082-000000000001','00000000-0000-4000-a082-000000000001','checkout','applied','full','price_fixture',
      'sub_monthly_race','cus_monthly_race',repeat('a',64),now()+interval '1 day',now(),now(),'in_monthly_race',date_trunc('day',now())-interval '10 days',now()) RETURNING id INTO operation;
  UPDATE public.voice_billing_projection SET entitlement_operation_id=operation WHERE business_id='10000000-0000-4000-a082-000000000001';
  PERFORM public.record_voice_billing_payment('10000000-0000-4000-a082-000000000001',rev,'sub_monthly_race','cus_monthly_race','in_monthly_race',
    date_trunc('day',now())-interval '10 days',date_trunc('day',now())+interval '20 days',date_trunc('day',now())-interval '10 days');
  PERFORM public.apply_voice_billing_projection('10000000-0000-4000-a082-000000000001',rev,'sub_monthly_race','full','active',date_trunc('day',now())-interval '10 days',date_trunc('day',now())+interval '20 days',false,date_trunc('day',now())-interval '10 days');
  SELECT id INTO p FROM public.voice_allowance_periods WHERE business_id='10000000-0000-4000-a082-000000000001';
  INSERT INTO public.voice_customer_usage(call_key,call_identity_hash,business_id,period_id,reserved_seconds,settled_seconds,state,settled_at)
    SELECT gen_random_uuid(),encode(extensions.digest('monthly-race-historical-'||i,'sha256'),'hex'),'10000000-0000-4000-a082-000000000001',p,600,589,'settled',now() FROM generate_series(1,10)i;
END $$;
UPDATE public.voice_rollout_control SET enabled=true;
$setup$);
SELECT extensions.dblink_connect('monthly_a','host=supabase_db_SimplAssist port=5432 dbname=postgres user=postgres password=postgres');
SELECT extensions.dblink_connect('monthly_b','host=supabase_db_SimplAssist port=5432 dbname=postgres user=postgres password=postgres');
SELECT extensions.dblink_connect('monthly_c','host=supabase_db_SimplAssist port=5432 dbname=postgres user=postgres password=postgres');
SELECT extensions.dblink_send_query('monthly_a',$call$WITH result AS MATERIALIZED(SELECT public.admit_voice_commercial('10000000-0000-4000-a082-000000000001','monthly-race-a','session-a','+15555557777','+15555558888',true) AS s) SELECT (s).response_mode FROM result$call$);
SELECT extensions.dblink_send_query('monthly_b',$call$WITH result AS MATERIALIZED(SELECT public.admit_voice_commercial('10000000-0000-4000-a082-000000000001','monthly-race-b','session-b','+15555557777','+15555558888',true) AS s) SELECT (s).response_mode FROM result$call$);
SELECT extensions.dblink_send_query('monthly_c',$call$WITH result AS MATERIALIZED(SELECT public.admit_voice_commercial('10000000-0000-4000-a082-000000000001','monthly-race-c','session-c','+15555557777','+15555558888',true) AS s) SELECT (s).response_mode FROM result$call$);
CREATE TEMP TABLE results(mode text);
INSERT INTO results SELECT * FROM extensions.dblink_get_result('monthly_a') AS t(mode text);
INSERT INTO results SELECT * FROM extensions.dblink_get_result('monthly_b') AS t(mode text);
INSERT INTO results SELECT * FROM extensions.dblink_get_result('monthly_c') AS t(mode text);
SELECT is((SELECT count(*)::integer FROM results WHERE mode='voice'),1,'only one concurrent call can reserve the last 110 seconds');
SELECT is((SELECT count(*)::integer FROM results WHERE mode='text'),2,'other concurrent calls receive a frozen fallback decision');
SELECT is((SELECT sum(reserved_seconds)::integer FROM public.voice_customer_usage WHERE business_id='10000000-0000-4000-a082-000000000001' AND settled_at IS NULL),110,'remaining allowance is reserved exactly once');
SELECT is((SELECT sum(COALESCE(settled_seconds,reserved_seconds)) FROM public.voice_customer_usage WHERE business_id='10000000-0000-4000-a082-000000000001'),6000::numeric,'concurrency cannot overspend the 100-minute pool');
SELECT extensions.dblink_disconnect('monthly_a');
SELECT extensions.dblink_disconnect('monthly_b');
SELECT extensions.dblink_disconnect('monthly_c');
-- Hold the history row while a late provider end settles its ledger. Deletion
-- must fail promptly while unsettled, rather than wait on the ledger FK and
-- deadlock the end event which is waiting for this history row.
SELECT extensions.dblink_exec('monthly_setup',$prepare$
ALTER TABLE public.voice_sessions ALTER COLUMN disclosure_version SET DEFAULT 1;
DO $$ DECLARE s public.voice_customer_usage; BEGIN
  SELECT * INTO s FROM public.voice_customer_usage WHERE business_id='10000000-0000-4000-a082-000000000001' AND settled_at IS NULL;
  PERFORM public.record_voice_customer_start(s.call_key,'race-first-audible',s.created_at);
  PERFORM public.acknowledge_voice_customer_start(s.call_key,'race-first-audible');
  PERFORM public.record_voice_customer_termination(s.call_key,'race-proven-termination',clock_timestamp());
END $$;
$prepare$);
SELECT extensions.dblink_connect('monthly_delete','host=supabase_db_SimplAssist port=5432 dbname=postgres user=postgres password=postgres');
SELECT extensions.dblink_connect('monthly_end','host=supabase_db_SimplAssist port=5432 dbname=postgres user=postgres password=postgres application_name=monthly_end_fixture');
SELECT extensions.dblink_exec('monthly_delete',$lock$BEGIN; SET LOCAL lock_timeout='4s'; DO $$ BEGIN
  PERFORM 1 FROM public.voice_sessions WHERE business_id='10000000-0000-4000-a082-000000000001' AND response_mode='voice' FOR UPDATE;
END $$;$lock$);
SELECT extensions.dblink_send_query('monthly_end',$end$SELECT public.record_voice_customer_end(call_key,'race-original-hangup',clock_timestamp())->>'state'
  FROM public.voice_customer_usage WHERE business_id='10000000-0000-4000-a082-000000000001' AND settled_at IS NULL$end$);
DO $$ DECLARE n integer; BEGIN
  FOR n IN 1..200 LOOP
    PERFORM pg_stat_clear_snapshot();
    IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='monthly_end_fixture' AND wait_event_type='Lock') THEN RETURN; END IF;
    PERFORM pg_sleep(0.01);
  END LOOP;
  RAISE EXCEPTION 'late end did not reach the contested history lock';
END $$;
SELECT extensions.dblink_exec('monthly_delete',$delete$DO $$ BEGIN
  BEGIN
    DELETE FROM public.voice_sessions WHERE business_id='10000000-0000-4000-a082-000000000001' AND response_mode='voice';
    RAISE EXCEPTION 'unsettled deletion unexpectedly allowed';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL;
  END;
END $$; COMMIT;$delete$);
CREATE TEMP TABLE settlement_result(state text);
INSERT INTO settlement_result SELECT * FROM extensions.dblink_get_result('monthly_end') AS t(state text);
SELECT is((SELECT state FROM settlement_result),'settled','late end can finish after a competing deletion attempt without lock inversion');
SELECT is((SELECT count(*)::integer FROM public.voice_sessions WHERE business_id='10000000-0000-4000-a082-000000000001' AND response_mode='voice'),1,'unsettled deletion did not remove the call');
SELECT extensions.dblink_exec('monthly_delete',$delete$DELETE FROM public.voice_sessions WHERE business_id='10000000-0000-4000-a082-000000000001' AND response_mode='voice';$delete$);
SELECT is((SELECT count(*)::integer FROM public.voice_customer_usage WHERE business_id='10000000-0000-4000-a082-000000000001' AND settled_at IS NOT NULL),11,'post-settlement deletion preserves all usage');
SELECT extensions.dblink_disconnect('monthly_delete');
SELECT extensions.dblink_disconnect('monthly_end');
SELECT extensions.dblink_exec('monthly_setup',$cleanup$
DO $$ DECLARE s record; BEGIN
  FOR s IN SELECT id FROM public.voice_sessions WHERE business_id='10000000-0000-4000-a082-000000000001' AND response_mode='voice' LOOP
    PERFORM public.record_voice_customer_termination(s.id,'verified-cleanup-termination',clock_timestamp());
    UPDATE public.voice_customer_usage SET reconcile_after=clock_timestamp()-interval '1 second' WHERE call_key=s.id;
    PERFORM public.settle_voice_customer_usage(s.id,true);
  END LOOP;
END $$;
ALTER TABLE public.business_metric_events DISABLE TRIGGER reject_business_metric_events_mutation;
DELETE FROM public.business_metric_events WHERE business_id='10000000-0000-4000-a082-000000000001';
ALTER TABLE public.business_metric_events ENABLE TRIGGER reject_business_metric_events_mutation;
ALTER TABLE public.voice_billing_payments DISABLE TRIGGER guard_voice_payment_history;
DELETE FROM public.voice_billing_payments WHERE invoice_id='in_monthly_race';
ALTER TABLE public.voice_billing_payments ENABLE TRIGGER guard_voice_payment_history;
DELETE FROM public.sms_billing_operations WHERE business_id='10000000-0000-4000-a082-000000000001';
DELETE FROM public.sms_billing_accounts WHERE business_id='10000000-0000-4000-a082-000000000001';
DELETE FROM public.businesses WHERE id='10000000-0000-4000-a082-000000000001';
DELETE FROM auth.users WHERE id='00000000-0000-4000-a082-000000000001';
UPDATE public.voice_rollout_control SET enabled=false;
DELETE FROM public.voice_commercial_audit WHERE id NOT IN (SELECT id FROM monthly_audit_before);
$cleanup$);
SELECT extensions.dblink_disconnect('monthly_setup');
SELECT is((SELECT count(*)::integer FROM public.voice_customer_usage WHERE business_id IS NULL AND call_identity_hash=encode(extensions.digest('monthly-race-historical-1','sha256'),'hex')),1,'account deletion retains anonymous non-content usage fact');
-- Dispose only this fixture's durable, anonymous accounting. The local-only
-- attestation above is mandatory; application cleanup must never do this.
SELECT extensions.dblink_connect('monthly_cleanup','host=supabase_db_SimplAssist port=5432 dbname=postgres user=postgres password=postgres');
SELECT extensions.dblink_exec('monthly_cleanup',$dispose$
ALTER TABLE public.voice_customer_usage DISABLE TRIGGER guard_voice_customer_usage;
DELETE FROM public.voice_customer_usage WHERE period_id IN (SELECT id FROM public.voice_allowance_periods WHERE subscription_id='sub_monthly_race');
ALTER TABLE public.voice_customer_usage ENABLE TRIGGER guard_voice_customer_usage;
ALTER TABLE public.voice_allowance_periods DISABLE TRIGGER guard_voice_allowance_period;
DELETE FROM public.voice_allowance_periods WHERE subscription_id='sub_monthly_race';
ALTER TABLE public.voice_allowance_periods ENABLE TRIGGER guard_voice_allowance_period;
$dispose$);
SELECT extensions.dblink_disconnect('monthly_cleanup');
SELECT * FROM finish();
ROLLBACK;
