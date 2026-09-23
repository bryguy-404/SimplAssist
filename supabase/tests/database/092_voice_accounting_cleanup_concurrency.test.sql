BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();

-- These connections commit synthetic fixtures. Only the attested disposable
-- local test harness may run this file; never run it against a hosted database.
DO $$ BEGIN
  IF current_user<>'postgres' OR current_setting('port')<>'5432'
    OR current_setting('simplassist.disposable_test_database',true) IS DISTINCT FROM 'on'
    OR (inet_server_addr() IS NOT NULL AND NOT (inet_server_addr()<<=inet '127.0.0.0/8'
      OR inet_server_addr()<<=inet '10.0.0.0/8' OR inet_server_addr()<<=inet '172.16.0.0/12'
      OR inet_server_addr()<<=inet '192.168.0.0/16' OR inet_server_addr()<<=inet '::1/128'))
  THEN RAISE EXCEPTION 'test_092_requires_disposable_local_database' USING ERRCODE='55000'; END IF;
END $$;

SELECT extensions.dblink_connect('cleanup092_setup','host=supabase_db_SimplAssist port=5432 dbname=postgres user=postgres password=postgres');
SELECT extensions.dblink_connect('cleanup092_history','host=supabase_db_SimplAssist port=5432 dbname=postgres user=postgres password=postgres application_name=cleanup092_history');
SELECT extensions.dblink_connect('cleanup092_business','host=supabase_db_SimplAssist port=5432 dbname=postgres user=postgres password=postgres application_name=cleanup092_business');
SELECT extensions.dblink_exec('cleanup092_setup',$fixture$
CREATE TEMP TABLE cleanup092_fixture(label text,b uuid,o uuid,p uuid,s uuid);
DO $$ DECLARE bid uuid; own uuid; period uuid; sid uuid; label text; BEGIN
  FOREACH label IN ARRAY ARRAY['history_first','business_first'] LOOP
    bid:=gen_random_uuid(); own:=gen_random_uuid(); period:=gen_random_uuid(); sid:=gen_random_uuid();
    INSERT INTO auth.users(id,email) VALUES(own,own||'@example.test');
    INSERT INTO public.businesses(id,owner_id,name,business_type,slug) VALUES(bid,own,'Cleanup race','general','cleanup092-'||bid);
    INSERT INTO public.voice_allowance_periods(id,business_id,subscription_id,period_start,period_end,included_seconds,grant_effective_at)
      VALUES(period,bid,'sub_cleanup092_'||bid,now()-interval '1 day',now()+interval '29 days',6000,now()-interval '1 day');
    INSERT INTO public.voice_sessions(id,business_id,call_control_id,call_session_id,caller_phone,called_phone,response_mode,status,access_source,allowance_period_id,reserved_seconds)
      VALUES(sid,bid,'cleanup092-'||bid,'session-'||bid,'+12125550100','+12125550101','voice','closed','commercial',period,60);
    INSERT INTO public.voice_customer_usage(call_key,call_identity_hash,business_id,session_id,period_id,reserved_seconds,settled_seconds,state,settled_at)
      VALUES(sid,encode(extensions.digest('cleanup092-'||bid,'sha256'),'hex'),bid,sid,period,60,23,'settled',now());
    INSERT INTO cleanup092_fixture VALUES(label,bid,own,period,sid);
  END LOOP;
END $$;
$fixture$);
CREATE TEMP TABLE cleanup092_fixture AS SELECT * FROM extensions.dblink('cleanup092_setup','SELECT * FROM cleanup092_fixture')
  AS f(label text,b uuid,o uuid,p uuid,s uuid);

-- Holding history first reproduces the lock inversion that would occur if the
-- business trigger detached usage before locking the call history.
SELECT extensions.dblink_exec('cleanup092_history','BEGIN; SET LOCAL statement_timeout=''3s'';');
SELECT extensions.dblink_exec('cleanup092_history',(SELECT format('DO $$ BEGIN PERFORM 1 FROM public.voice_sessions WHERE id=%L FOR UPDATE; END $$;',s)
  FROM cleanup092_fixture WHERE label='history_first'));
SELECT extensions.dblink_send_query('cleanup092_business',(SELECT format('DELETE FROM public.businesses WHERE id=%L RETURNING id',b)
  FROM cleanup092_fixture WHERE label='history_first'));
DO $$ DECLARE n integer; BEGIN
  FOR n IN 1..200 LOOP
    PERFORM pg_stat_clear_snapshot();
    IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='cleanup092_business' AND wait_event_type='Lock') THEN RETURN; END IF;
    PERFORM pg_sleep(0.01);
  END LOOP;
  RAISE EXCEPTION 'business deletion did not wait for call history';
END $$;
SELECT is(extensions.dblink_is_busy('cleanup092_business'),1,'account cleanup waits behind the history lock');
SELECT is(extensions.dblink_exec('cleanup092_history',(SELECT format('DELETE FROM public.voice_sessions WHERE id=%L',s)
  FROM cleanup092_fixture WHERE label='history_first')),'DELETE 1','history cleanup completes without a usage-lock inversion');
SELECT extensions.dblink_exec('cleanup092_history','COMMIT');
SELECT is((SELECT count(*)::integer FROM extensions.dblink_get_result('cleanup092_business') AS r(id uuid)),1,
  'waiting account cleanup finishes after history deletion commits');
SELECT * FROM extensions.dblink_get_result('cleanup092_business') AS r(id uuid);
SELECT ok((SELECT u.business_id IS NULL AND u.session_id IS NULL AND u.settled_seconds=23
  FROM public.voice_customer_usage u JOIN cleanup092_fixture f ON f.s=u.call_key WHERE f.label='history_first'),
  'history-first race preserves the same anonymous settled usage');

-- Reverse order: the account cascade owns history first. A later direct
-- history deletion waits and then observes the already-removed history.
SELECT extensions.dblink_exec('cleanup092_business','BEGIN; SET LOCAL statement_timeout=''3s'';');
SELECT is(extensions.dblink_exec('cleanup092_business',(SELECT format('DELETE FROM public.businesses WHERE id=%L',b)
  FROM cleanup092_fixture WHERE label='business_first')),'DELETE 1','account cleanup can win the race');
SELECT extensions.dblink_send_query('cleanup092_history',(SELECT format('DELETE FROM public.voice_sessions WHERE id=%L RETURNING id',s)
  FROM cleanup092_fixture WHERE label='business_first'));
DO $$ DECLARE n integer; BEGIN
  FOR n IN 1..200 LOOP
    PERFORM pg_stat_clear_snapshot();
    IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='cleanup092_history' AND wait_event_type='Lock') THEN RETURN; END IF;
    PERFORM pg_sleep(0.01);
  END LOOP;
  RAISE EXCEPTION 'history deletion did not wait for account cleanup';
END $$;
SELECT is(extensions.dblink_is_busy('cleanup092_history'),1,'later history cleanup waits for the account cascade');
SELECT extensions.dblink_exec('cleanup092_business','COMMIT');
SELECT is((SELECT count(*)::integer FROM extensions.dblink_get_result('cleanup092_history') AS r(id uuid)),0,
  'later history cleanup observes the existing deletion');
SELECT * FROM extensions.dblink_get_result('cleanup092_history') AS r(id uuid);
SELECT ok((SELECT u.business_id IS NULL AND u.session_id IS NULL AND u.settled_seconds=23
  FROM public.voice_customer_usage u JOIN cleanup092_fixture f ON f.s=u.call_key WHERE f.label='business_first'),
  'account-first race preserves the same anonymous settled usage');

-- Dispose only this file's random synthetic immutable facts. The attestation
-- above is mandatory; application cleanup must never erase accounting.
SELECT extensions.dblink_exec('cleanup092_setup',$cleanup$
BEGIN;
ALTER TABLE public.voice_customer_usage DISABLE TRIGGER guard_voice_customer_usage;
DELETE FROM public.voice_customer_usage WHERE call_key IN(SELECT s FROM cleanup092_fixture);
ALTER TABLE public.voice_customer_usage ENABLE TRIGGER guard_voice_customer_usage;
ALTER TABLE public.voice_allowance_periods DISABLE TRIGGER guard_voice_allowance_period;
DELETE FROM public.voice_allowance_periods WHERE id IN(SELECT p FROM cleanup092_fixture);
ALTER TABLE public.voice_allowance_periods ENABLE TRIGGER guard_voice_allowance_period;
DELETE FROM auth.users WHERE id IN(SELECT o FROM cleanup092_fixture);
COMMIT;
$cleanup$);
SELECT extensions.dblink_disconnect(n) FROM unnest(ARRAY['cleanup092_setup','cleanup092_history','cleanup092_business']) n;
SELECT is((SELECT count(*)::integer FROM public.voice_customer_usage WHERE call_key IN(SELECT s FROM cleanup092_fixture)),0,
  'synthetic accounting fixtures are removed');
SELECT is((SELECT count(*)::integer FROM auth.users WHERE id IN(SELECT o FROM cleanup092_fixture)),0,
  'synthetic owners are removed');
SELECT * FROM finish();
ROLLBACK;
