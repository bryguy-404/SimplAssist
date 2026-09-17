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
      'test_085_voice_capacity_requires_disposable_local_database'
      USING ERRCODE = '55000';
  END IF;
END;
$require_disposable_local_database$;

SELECT extensions.dblink_connect('capacity_setup','host=supabase_db_SimplAssist port=5432 dbname=postgres user=postgres password=postgres');
SELECT extensions.dblink_exec('capacity_setup',$setup$
CREATE TEMP TABLE capacity_audit_before AS SELECT id FROM public.voice_commercial_audit;
DO $$ DECLARE b uuid; o uuid; op uuid; rev bigint; n integer; BEGIN
  FOR n IN 1..5 LOOP
    b:=('10000000-0000-4000-a085-'||lpad(n::text,12,'0'))::uuid;
    o:=('00000000-0000-4000-a085-'||lpad(n::text,12,'0'))::uuid;
    INSERT INTO auth.users(id,email) VALUES(o,'public85-capacity-'||n||'@example.test');
    INSERT INTO public.businesses(id,owner_id,name,business_type,slug) VALUES(b,o,'Capacity','general','public85-capacity-'||n);
    INSERT INTO public.voice_commercial_settings(business_id,primary_response) VALUES(b,'voice');
    INSERT INTO public.subscriptions(business_id,stripe_customer_id,stripe_subscription_id,plan,status,current_period_start,current_period_end)
      VALUES(b,'cus_capacity85'||n,'sub_capacity85'||n,'full','active',date_trunc('day',now()),date_trunc('day',now())+interval '30 days');
    INSERT INTO public.phone_numbers(business_id,phone_number,telnyx_phone_number_id,is_active) VALUES(b,'+15555552'||lpad(n::text,3,'0'),'capacity85-number-'||n,true);
    INSERT INTO public.sms_billing_operations(business_id,owner_id,kind,state,target_plan,target_price_id,stripe_subscription_id,stripe_customer_id,
      source_fingerprint,expires_at,confirmed_at,applied_at,invoice_id,payment_effective_at,payment_verified_at)
      VALUES(b,o,'checkout','applied','full','price_full85','sub_capacity85'||n,'cus_capacity85'||n,repeat('a',64),now()+interval '1 day',now(),now(),
        'in_capacity85'||n,date_trunc('day',now()),now()) RETURNING id INTO op;
    rev:=public.begin_voice_billing_reconciliation(b,'sub_capacity85'||n,'cus_capacity85'||n);
    UPDATE public.voice_billing_projection SET entitlement_operation_id=op WHERE business_id=b;
    PERFORM public.record_voice_billing_payment(b,rev,'sub_capacity85'||n,'cus_capacity85'||n,'in_capacity85'||n,date_trunc('day',now()),date_trunc('day',now())+interval '30 days',date_trunc('day',now()));
    PERFORM public.apply_voice_billing_projection(b,rev,'sub_capacity85'||n,'full','active',date_trunc('day',now()),date_trunc('day',now())+interval '30 days',false,now());
  END LOOP;
END $$;
UPDATE public.voice_rollout_control SET enabled=true,max_concurrent_calls=4;
$setup$);
SELECT extensions.dblink_connect('capacity_'||n,'host=supabase_db_SimplAssist port=5432 dbname=postgres user=postgres password=postgres') FROM generate_series(1,5)n;
SELECT extensions.dblink_send_query('capacity_'||n,format($call$
 WITH result AS MATERIALIZED(SELECT public.admit_voice_commercial(%L::uuid,%L,%L,'+15555559999',%L,true) AS s) SELECT (s).response_mode FROM result
 $call$,'10000000-0000-4000-a085-'||lpad(n::text,12,'0'),'capacity85-call-'||n,'capacity85-session-'||n,'+15555552'||lpad(n::text,3,'0'))) FROM generate_series(1,5)n;
CREATE TEMP TABLE capacity_results(mode text);
INSERT INTO capacity_results SELECT result.mode FROM generate_series(1,5)n CROSS JOIN LATERAL extensions.dblink_get_result('capacity_'||n) AS result(mode text);
SELECT is((SELECT count(*)::integer FROM capacity_results WHERE mode='voice'),4,'five simultaneous business admissions reserve exactly four fleet slots');
SELECT is((SELECT count(*)::integer FROM capacity_results WHERE mode='text'),1,'the fifth simultaneous call receives a frozen text decision');
SELECT is((SELECT sum(reserved_seconds)::integer FROM public.voice_customer_usage WHERE business_id::text LIKE '10000000-0000-4000-a085-%'),2400,'global race reserves only four ten-minute holds');
SELECT is((SELECT count(*)::integer FROM public.voice_sessions WHERE call_control_id LIKE 'capacity85-call-%' AND outcome='capacity_unavailable'),1,'capacity refusal is recorded accurately');
SELECT extensions.dblink_disconnect('capacity_'||n) FROM generate_series(1,5)n;
SELECT extensions.dblink_exec('capacity_setup',$cleanup$
DO $$ DECLARE s record; BEGIN
  FOR s IN SELECT * FROM public.voice_sessions WHERE call_control_id LIKE 'capacity85-call-%' AND response_mode='voice' LOOP
    -- No handoff occurred: verified phone termination is sufficient for the
    -- disclosure-only zero-use settlement implemented in 086.
    PERFORM public.record_voice_customer_termination(s.id,'capacity85-ended',clock_timestamp());
    PERFORM public.finalize_voice_session(s.id,'caller_hangup',NULL,false);
  END LOOP;
END $$;
ALTER TABLE public.business_metric_events DISABLE TRIGGER reject_business_metric_events_mutation;
DELETE FROM public.business_metric_events WHERE business_id::text LIKE '10000000-0000-4000-a085-%';
ALTER TABLE public.business_metric_events ENABLE TRIGGER reject_business_metric_events_mutation;
DELETE FROM public.sms_billing_operations WHERE business_id::text LIKE '10000000-0000-4000-a085-%';
DELETE FROM public.sms_billing_accounts WHERE business_id::text LIKE '10000000-0000-4000-a085-%';
DELETE FROM public.businesses WHERE id::text LIKE '10000000-0000-4000-a085-%';
DELETE FROM auth.users WHERE id::text LIKE '00000000-0000-4000-a085-%';
UPDATE public.voice_rollout_control SET enabled=false,max_concurrent_calls=2;
DELETE FROM public.voice_commercial_audit WHERE id NOT IN (SELECT id FROM capacity_audit_before);
$cleanup$);
SELECT extensions.dblink_disconnect('capacity_setup');
SELECT is((SELECT count(*)::integer FROM public.voice_customer_usage WHERE business_id IS NULL AND call_identity_hash IN
 (SELECT encode(extensions.digest('capacity85-call-'||n,'sha256'),'hex') FROM generate_series(1,5)n)),4,'hard account cleanup retains the four independent usage facts');
-- Dispose only attested-local synthetic immutable data. Never application cleanup.
SELECT extensions.dblink_connect('capacity_cleanup','host=supabase_db_SimplAssist port=5432 dbname=postgres user=postgres password=postgres');
SELECT extensions.dblink_exec('capacity_cleanup',$dispose$
ALTER TABLE public.voice_customer_usage DISABLE TRIGGER guard_voice_customer_usage;
DELETE FROM public.voice_customer_usage WHERE period_id IN(SELECT id FROM public.voice_allowance_periods WHERE subscription_id LIKE 'sub_capacity85%');
ALTER TABLE public.voice_customer_usage ENABLE TRIGGER guard_voice_customer_usage;
ALTER TABLE public.voice_allowance_periods DISABLE TRIGGER guard_voice_allowance_period;
DELETE FROM public.voice_allowance_periods WHERE subscription_id LIKE 'sub_capacity85%';
ALTER TABLE public.voice_allowance_periods ENABLE TRIGGER guard_voice_allowance_period;
ALTER TABLE public.voice_billing_payments DISABLE TRIGGER guard_voice_payment_history;
DELETE FROM public.voice_billing_payments WHERE subscription_id LIKE 'sub_capacity85%';
ALTER TABLE public.voice_billing_payments ENABLE TRIGGER guard_voice_payment_history;
$dispose$);
SELECT extensions.dblink_disconnect('capacity_cleanup');
SELECT * FROM finish();
ROLLBACK;
