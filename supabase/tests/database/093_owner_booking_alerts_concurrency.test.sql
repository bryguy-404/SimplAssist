BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();
-- Committed cross-session fixtures are allowed only on the disposable local DB.
DO $$ BEGIN
 IF current_database()<>'postgres' OR current_user<>'postgres' OR current_setting('port')<>'5432'
   OR NOT coalesce((current_setting('data_directory')='/var/lib/postgresql/data'
     AND current_setting('app.settings.jwt_secret',true)='super-secret-jwt-token-with-at-least-32-characters-long'),false)
     AND NOT coalesce(current_setting('simplassist.disposable_test_database',true)='on',false) THEN
   RAISE EXCEPTION 'owner_alert_concurrency_requires_disposable_local_database'; END IF;
END $$;
CREATE TEMP TABLE alert_race_results(name text PRIMARY KEY,value text);
-- Prefer this session's server address. Supabase loopback uses trust auth, which
-- dblink correctly refuses for the non-superuser postgres role; use the local
-- project's authenticated bridge host if the harness connects over loopback.
SELECT dblink_connect(n,'host='||coalesce(nullif(nullif(host(inet_server_addr()),'127.0.0.1'),'::1'),'supabase_db_SimplAssist')||' port=5432 dbname=postgres user=postgres password=postgres')
 FROM unnest(ARRAY['alert093_setup','alert093_a','alert093_b']) n;
CREATE FUNCTION pg_temp.cleanup_alert_race() RETURNS void LANGUAGE plpgsql AS $$
DECLARE conn text;
BEGIN
 FOREACH conn IN ARRAY ARRAY['alert093_a','alert093_b'] LOOP
   IF conn=ANY(coalesce(dblink_get_connections(),ARRAY[]::text[])) THEN
     PERFORM dblink_cancel_query(conn);
     PERFORM dblink_disconnect(conn);
   END IF;
 END LOOP;
 PERFORM dblink_exec('alert093_setup',$cleanup$
   BEGIN;
   DELETE FROM public.businesses WHERE id='10000000-0000-4000-a093-000000000101';
   DELETE FROM auth.users WHERE id='00000000-0000-4000-a093-000000000101';
   DELETE FROM public.owner_booking_alert_recipients WHERE recipient='+15745550191';
   DELETE FROM public.owner_booking_alert_suppression_events WHERE recipient='+15745550191';
   DELETE FROM public.owner_booking_alert_control;
   INSERT INTO public.owner_booking_alert_control SELECT * FROM saved_alert_control;
   COMMIT;
 $cleanup$);
 PERFORM dblink_disconnect('alert093_setup');
END $$;
DO $$
DECLARE item record; claimed_id uuid; claimed_token uuid; successes integer:=0; stopped boolean; ready boolean;
BEGIN
 PERFORM dblink_exec('alert093_setup',$setup$
   CREATE TEMP TABLE saved_alert_control AS SELECT * FROM public.owner_booking_alert_control;
   BEGIN;
   INSERT INTO auth.users(id,email) VALUES('00000000-0000-4000-a093-000000000101','alert-race@example.test');
   INSERT INTO public.businesses(id,owner_id,name,business_type,slug,billing_mode,partner_plan,primary_goal)
     VALUES('10000000-0000-4000-a093-000000000101','00000000-0000-4000-a093-000000000101','Alert race','general','alert-race-093','comped','chat_only','book');
   INSERT INTO public.ai_settings(business_id,booking_enabled,booking_mode) VALUES('10000000-0000-4000-a093-000000000101',true,'schedule_direct')
     ON CONFLICT(business_id) DO UPDATE SET booking_enabled=true,booking_mode='schedule_direct';
   INSERT INTO public.google_calendar_tokens(business_id,access_token,refresh_token,token_expiry,calendar_id,google_email)
     VALUES('10000000-0000-4000-a093-000000000101','fixture','fixture',now()+interval '1 day','primary','alert-race@example.test');
   INSERT INTO public.owner_booking_alert_settings(business_id,owner_id,enabled,recipient,verified_at,consent_version,disclosure)
     VALUES('10000000-0000-4000-a093-000000000101','00000000-0000-4000-a093-000000000101',true,'+15745550191',now(),'test','Fixture consent');
   UPDATE public.owner_booking_alert_control SET enabled=true,sender='+15742133931',messaging_profile_id='race-profile',pilot_business_ids=NULL,next_send_at=NULL;
   INSERT INTO public.owner_booking_alert_outbox(business_id,owner_id,kind,generation,recipient,sender,messaging_profile_id,expires_at)
     SELECT business_id,owner_id,'enrollment',generation,recipient,'+15742133931','race-profile',now()+interval '1 hour' FROM public.owner_booking_alert_settings WHERE business_id='10000000-0000-4000-a093-000000000101';
   COMMIT;
 $setup$);
 PERFORM dblink_exec('alert093_a','BEGIN');
 SELECT * INTO item FROM dblink('alert093_a','SELECT id,claim_token FROM public.claim_owner_booking_alerts(1)') AS t(id uuid,claim_token uuid);
 claimed_id:=item.id; claimed_token:=item.claim_token;
 INSERT INTO alert_race_results VALUES('first_claim',CASE WHEN claimed_id IS NOT NULL THEN '1' ELSE '0' END);
 PERFORM dblink_send_query('alert093_b','SELECT count(*)::integer FROM public.claim_owner_booking_alerts(1)');
 PERFORM dblink_exec('alert093_a','COMMIT');
 SELECT * INTO item FROM dblink_get_result('alert093_b') AS t(n integer);
 INSERT INTO alert_race_results VALUES('second_claim',item.n::text);
 PERFORM * FROM dblink_get_result('alert093_b') AS t(n integer);
 PERFORM dblink_send_query('alert093_a',format('SELECT (public.begin_owner_booking_alert_send(%L,%L,%L,%L,NULL)).status',claimed_id,claimed_token,gen_random_uuid(),'SimplAssist booking alerts enabled.'));
 PERFORM dblink_send_query('alert093_b',format('SELECT (public.begin_owner_booking_alert_send(%L,%L,%L,%L,NULL)).status',claimed_id,claimed_token,gen_random_uuid(),'SimplAssist booking alerts enabled.'));
 SELECT * INTO item FROM dblink_get_result('alert093_a') AS t(status text);
 IF item.status='submitting' THEN successes:=successes+1; END IF;
 SELECT * INTO item FROM dblink_get_result('alert093_b') AS t(status text);
 IF item.status='submitting' THEN successes:=successes+1; END IF;
 INSERT INTO alert_race_results VALUES('submission_winners',successes::text);
 PERFORM * FROM dblink_get_result('alert093_a') AS t(status text);
 PERFORM * FROM dblink_get_result('alert093_b') AS t(status text);
 -- A booking owns its business mutex before entering the alert subsystem.
 -- STOP must not wait for that mutex while holding the program mutex.
 PERFORM dblink_exec('alert093_a','BEGIN');
 PERFORM * FROM dblink('alert093_a',$hold$SELECT id FROM public.businesses WHERE id='10000000-0000-4000-a093-000000000101' FOR UPDATE$hold$) AS t(id uuid);
 PERFORM dblink_send_query('alert093_b',$stop$SELECT public.set_owner_booking_alert_suppression('+15745550191',true,now(),'race-stop-093')$stop$);
 FOR i IN 1..20 LOOP
   EXIT WHEN dblink_is_busy('alert093_b')=0;
   PERFORM pg_sleep(0.025);
 END LOOP;
 ready:=dblink_is_busy('alert093_b')=0;
 INSERT INTO alert_race_results VALUES('stop_does_not_wait_for_business',ready::text);
 PERFORM dblink_exec('alert093_a','COMMIT');
 SELECT * INTO item FROM dblink_get_result('alert093_b') AS t(stopped boolean);
 INSERT INTO alert_race_results VALUES('stop_applied',item.stopped::text);
 PERFORM * FROM dblink_get_result('alert093_b') AS t(stopped boolean);
 PERFORM pg_temp.cleanup_alert_race();
EXCEPTION WHEN OTHERS THEN
 PERFORM pg_temp.cleanup_alert_race();
 RAISE;
END $$;
SELECT is((SELECT value FROM alert_race_results WHERE name='first_claim'),'1','first concurrent worker claims the alert');
SELECT is((SELECT value FROM alert_race_results WHERE name='second_claim'),'0','second concurrent worker cannot claim the same alert');
SELECT is((SELECT value FROM alert_race_results WHERE name='submission_winners'),'1','only one worker with the same claim can cross submission boundary');
SELECT is((SELECT value FROM alert_race_results WHERE name='stop_does_not_wait_for_business'),'true','STOP avoids lock inversion with calendar confirmation');
SELECT is((SELECT value FROM alert_race_results WHERE name='stop_applied'),'true','STOP completes after concurrent submission claim');
SELECT ok(NOT EXISTS(SELECT 1 FROM businesses WHERE id='10000000-0000-4000-a093-000000000101'),'committed race fixture removed');
SELECT ok(NOT (SELECT enabled FROM owner_booking_alert_control),'race restores disabled provider gate');
SELECT * FROM finish();
ROLLBACK;
