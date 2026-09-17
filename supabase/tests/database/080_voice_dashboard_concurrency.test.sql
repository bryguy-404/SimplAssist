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
      'test_080_voice_dashboard_concurrency_requires_disposable_local_database'
      USING ERRCODE = '55000';
  END IF;
END;
$require_disposable_local_database$;
SELECT extensions.dblink_connect('dashboard_setup','host=supabase_db_SimplAssist port=5432 dbname=postgres user=postgres password=postgres');
SELECT extensions.dblink_exec('dashboard_setup',$setup$
 INSERT INTO auth.users(id,email) VALUES('00000000-0000-4000-a081-000000000001','dashboard-concurrency@example.test');
 INSERT INTO public.businesses(id,owner_id,name,business_type,slug) VALUES('10000000-0000-4000-a081-000000000001','00000000-0000-4000-a081-000000000001','Concurrency','general','dashboard-concurrency-080');
 INSERT INTO public.contacts(id,business_id,phone_number,source_channel) VALUES('20000000-0000-4000-a081-000000000001','10000000-0000-4000-a081-000000000001','+15555550101','voice');
 INSERT INTO public.conversations(id,business_id,contact_id,channel) VALUES('30000000-0000-4000-a081-000000000001','10000000-0000-4000-a081-000000000001','20000000-0000-4000-a081-000000000001','voice');
 INSERT INTO public.voice_sessions(id,business_id,conversation_id,call_control_id,call_session_id,caller_phone,called_phone,response_mode,status) VALUES
  ('40000000-0000-4000-a081-000000000001','10000000-0000-4000-a081-000000000001','30000000-0000-4000-a081-000000000001','080-race-control','080-race-session','+15555550101','+15742638634','voice','closed');
 INSERT INTO public.messages(id,business_id,conversation_id,role,channel,content) VALUES('50000000-0000-4000-a081-000000000001','10000000-0000-4000-a081-000000000001','30000000-0000-4000-a081-000000000001','customer','voice','Yes, please.');
 INSERT INTO public.voice_actions(id,session_id,business_id,kind,fingerprint,revision,status,payload,readback,request_event_ids,confirmed_at,source_message_id,result,sms_provider_message_id,sms_accepted_at) VALUES
 ('60000000-0000-4000-a081-000000000001','40000000-0000-4000-a081-000000000001','10000000-0000-4000-a081-000000000001','signup',repeat('a',64),1,'succeeded','{}','May I text the link?',ARRAY['request'],now(),
 '50000000-0000-4000-a081-000000000001','{"providerMessageId":"080-race-provider","smsBody":"Here is your link.","deliveryStatus":"accepted"}','080-race-provider',now());
$setup$);
SELECT extensions.dblink_connect('dashboard_a','host=supabase_db_SimplAssist port=5432 dbname=postgres user=postgres password=postgres');
SELECT extensions.dblink_connect('dashboard_b','host=supabase_db_SimplAssist port=5432 dbname=postgres user=postgres password=postgres');
SELECT extensions.dblink_exec('dashboard_a','BEGIN');
CREATE TEMP TABLE dashboard_race_results(created boolean);
INSERT INTO dashboard_race_results SELECT * FROM extensions.dblink('dashboard_a',$call$SELECT created_event FROM public.finalize_voice_signup_bookkeeping('60000000-0000-4000-a081-000000000001')$call$) AS t(created boolean);
SELECT extensions.dblink_send_query('dashboard_b',$call$SELECT created_event FROM public.finalize_voice_signup_bookkeeping('60000000-0000-4000-a081-000000000001')$call$);
SELECT pg_sleep(0.05);
SELECT is(extensions.dblink_is_busy('dashboard_b'),1,'second finalizer waits for the first action lock');
SELECT extensions.dblink_exec('dashboard_a','COMMIT');
INSERT INTO dashboard_race_results SELECT * FROM extensions.dblink_get_result('dashboard_b') AS t(created boolean);
SELECT is((SELECT count(*)::integer FROM dashboard_race_results WHERE created),1,'one concurrent finalizer creates the lead');
SELECT is((SELECT count(*)::integer FROM dashboard_race_results WHERE NOT created),1,'the other concurrent finalizer returns the same existing lead');
SELECT is((SELECT count(*)::integer FROM public.goal_events WHERE business_id='10000000-0000-4000-a081-000000000001'),1,'one durable lead');
SELECT is((SELECT count(*)::integer FROM public.messages WHERE id='60000000-0000-4000-a081-000000000001'),1,'one durable outbound message');
SELECT is((SELECT count(*)::integer FROM public.conversations WHERE business_id='10000000-0000-4000-a081-000000000001' AND channel='sms'),1,'one SMS conversation');
SELECT is((SELECT count(*)::integer FROM public.billing_usage_events WHERE business_id='10000000-0000-4000-a081-000000000001'),0,'finalizer has no billing side effect');
SELECT extensions.dblink_disconnect('dashboard_a');
SELECT extensions.dblink_disconnect('dashboard_b');
SELECT extensions.dblink_exec('dashboard_setup',$cleanup$
 ALTER TABLE public.business_metric_events DISABLE TRIGGER reject_business_metric_events_mutation;
 DELETE FROM public.business_metric_events WHERE business_id='10000000-0000-4000-a081-000000000001';
 ALTER TABLE public.business_metric_events ENABLE TRIGGER reject_business_metric_events_mutation;
 DELETE FROM public.businesses WHERE id='10000000-0000-4000-a081-000000000001';
 DELETE FROM auth.users WHERE id='00000000-0000-4000-a081-000000000001';
$cleanup$);
SELECT extensions.dblink_disconnect('dashboard_setup');
SELECT * FROM finish();
ROLLBACK;
