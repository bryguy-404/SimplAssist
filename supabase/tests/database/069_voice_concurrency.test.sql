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
      'test_069_voice_concurrency_requires_disposable_local_database'
      USING ERRCODE = '55000';
  END IF;
END;
$require_disposable_local_database$;
SELECT extensions.dblink_connect('voice_setup','host=supabase_db_SimplAssist port=5432 dbname=postgres user=postgres password=postgres');
SELECT extensions.dblink_exec('voice_setup',$setup$
  INSERT INTO auth.users(id,email) VALUES('00000000-0000-4000-a073-000000000001','voice-concurrency@example.test');
  INSERT INTO public.businesses(id,owner_id,name,business_type,slug) VALUES('ea848911-ef72-44a6-8cf3-c47b3959be26','00000000-0000-4000-a073-000000000001','Concurrency','general','voice-concurrency-073');
  INSERT INTO public.phone_numbers(business_id,phone_number,telnyx_phone_number_id,is_active) VALUES('ea848911-ef72-44a6-8cf3-c47b3959be26','+15742638634','local-concurrency',true);
  INSERT INTO public.subscriptions(business_id,stripe_customer_id,stripe_subscription_id,plan,status) VALUES('ea848911-ef72-44a6-8cf3-c47b3959be26','cus_voice','sub_voice','sms_and_chat','active');
  INSERT INTO public.voice_pilot_settings(business_id,enabled,budget_seconds) VALUES('ea848911-ef72-44a6-8cf3-c47b3959be26',true,1200);
  INSERT INTO public.voice_pilot_testers(business_id,phone_number) VALUES('ea848911-ef72-44a6-8cf3-c47b3959be26','+15555550101');
$setup$);
SELECT extensions.dblink_connect('voice_a','host=supabase_db_SimplAssist port=5432 dbname=postgres user=postgres password=postgres');
SELECT extensions.dblink_connect('voice_b','host=supabase_db_SimplAssist port=5432 dbname=postgres user=postgres password=postgres');
SELECT extensions.dblink_connect('voice_c','host=supabase_db_SimplAssist port=5432 dbname=postgres user=postgres password=postgres');
SELECT extensions.dblink_send_query('voice_a',$call$WITH result AS MATERIALIZED (SELECT public.admit_voice_pilot('ea848911-ef72-44a6-8cf3-c47b3959be26','race-a','race-a','+15555550101','+15742638634',true) AS s) SELECT (s).response_mode FROM result$call$);
SELECT extensions.dblink_send_query('voice_b',$call$WITH result AS MATERIALIZED (SELECT public.admit_voice_pilot('ea848911-ef72-44a6-8cf3-c47b3959be26','race-b','race-b','+15555550101','+15742638634',true) AS s) SELECT (s).response_mode FROM result$call$);
SELECT extensions.dblink_send_query('voice_c',$call$WITH result AS MATERIALIZED (SELECT public.admit_voice_pilot('ea848911-ef72-44a6-8cf3-c47b3959be26','race-c','race-c','+15555550101','+15742638634',true) AS s) SELECT (s).response_mode FROM result$call$);
CREATE TEMP TABLE voice_race_results(mode text);
INSERT INTO voice_race_results SELECT * FROM extensions.dblink_get_result('voice_a') AS t(mode text);
INSERT INTO voice_race_results SELECT * FROM extensions.dblink_get_result('voice_b') AS t(mode text);
INSERT INTO voice_race_results SELECT * FROM extensions.dblink_get_result('voice_c') AS t(mode text);
SELECT is((SELECT count(*)::integer FROM voice_race_results WHERE mode='voice'),2,'only two racing calls acquire voice capacity');
SELECT is((SELECT count(*)::integer FROM voice_race_results WHERE mode='text'),1,'the third racing call preserves text response mode');
SELECT is((SELECT sum(reserved_seconds)::integer FROM public.voice_sessions WHERE business_id='ea848911-ef72-44a6-8cf3-c47b3959be26'),1200,'simultaneous admission never over-reserves the shared budget');
SELECT extensions.dblink_disconnect('voice_a'); SELECT extensions.dblink_disconnect('voice_b'); SELECT extensions.dblink_disconnect('voice_c');
SELECT extensions.dblink_exec('voice_setup',$cleanup$ALTER TABLE public.business_metric_events DISABLE TRIGGER reject_business_metric_events_mutation; DELETE FROM public.business_metric_events WHERE business_id='ea848911-ef72-44a6-8cf3-c47b3959be26'; ALTER TABLE public.business_metric_events ENABLE TRIGGER reject_business_metric_events_mutation; DELETE FROM public.businesses WHERE id='ea848911-ef72-44a6-8cf3-c47b3959be26'; DELETE FROM auth.users WHERE id='00000000-0000-4000-a073-000000000001';$cleanup$);
SELECT extensions.dblink_disconnect('voice_setup');
SELECT * FROM finish();
ROLLBACK;
