BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();

CREATE TEMP TABLE cleanup_fixture(label text PRIMARY KEY,b uuid,p uuid,s uuid);
CREATE FUNCTION pg_temp.cleanup_fixture(label text,settled boolean) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE bid uuid:=gen_random_uuid(); own uuid:=gen_random_uuid(); period uuid:=gen_random_uuid(); sid uuid:=gen_random_uuid();
BEGIN
  INSERT INTO auth.users(id,email) VALUES(own,own||'@example.test');
  INSERT INTO public.businesses(id,owner_id,name,business_type,slug)
    VALUES(bid,own,'Cleanup fixture','general','cleanup-092-'||bid);
  INSERT INTO public.voice_allowance_periods(id,business_id,subscription_id,period_start,period_end,included_seconds,grant_effective_at)
    VALUES(period,bid,'sub_cleanup_'||label,now()-interval '1 day',now()+interval '29 days',6000,now()-interval '1 day');
  INSERT INTO public.voice_sessions(id,business_id,call_control_id,call_session_id,caller_phone,called_phone,response_mode,status,
    access_source,allowance_period_id,reserved_seconds)
    VALUES(sid,bid,'cleanup-092-'||label,'session-'||label,'+12125550100','+12125550101','voice',
      CASE WHEN settled THEN 'closed' ELSE 'active' END,'commercial',period,60);
  INSERT INTO public.voice_customer_usage(call_key,call_identity_hash,business_id,session_id,period_id,reserved_seconds,settled_seconds,state,settled_at)
    VALUES(sid,encode(extensions.digest('cleanup-092-'||label,'sha256'),'hex'),bid,sid,period,60,
      CASE WHEN settled THEN 23 END,CASE WHEN settled THEN 'settled' ELSE 'reserved' END,CASE WHEN settled THEN now() END);
  INSERT INTO cleanup_fixture VALUES(label,bid,period,sid);
END $$;
SELECT pg_temp.cleanup_fixture('direct',true);
SELECT pg_temp.cleanup_fixture('account',true);
SELECT pg_temp.cleanup_fixture('unsettled',false);
SELECT pg_temp.cleanup_fixture('mixed',true);

-- An unlinked historical usage fact must be retained alongside linked calls.
INSERT INTO public.voice_customer_usage(call_key,call_identity_hash,business_id,period_id,reserved_seconds,settled_seconds,state,settled_at)
  SELECT gen_random_uuid(),encode(extensions.digest('cleanup-092-historical','sha256'),'hex'),b,p,60,12,'settled',now()
  FROM cleanup_fixture WHERE label='account';
INSERT INTO public.voice_customer_usage(call_key,call_identity_hash,business_id,period_id,reserved_seconds)
  SELECT gen_random_uuid(),encode(extensions.digest('cleanup-092-pending','sha256'),'hex'),b,p,60 FROM cleanup_fixture WHERE label='mixed';
CREATE TEMP TABLE saved_usage AS SELECT u.call_key,to_jsonb(u)-'business_id'-'session_id' AS facts
  FROM public.voice_customer_usage u JOIN cleanup_fixture f ON f.b=u.business_id;
CREATE TEMP TABLE saved_period AS SELECT a.id,to_jsonb(a)-'business_id' AS facts
  FROM public.voice_allowance_periods a JOIN cleanup_fixture f ON f.p=a.id;

SELECT ok(NOT has_function_privilege('anon','public.unlink_settled_voice_usage_on_business_delete()','EXECUTE'),
  'anonymous callers cannot invoke cleanup helper');
SELECT ok(NOT has_function_privilege('authenticated','public.unlink_settled_voice_usage_on_business_delete()','EXECUTE'),
  'customers cannot invoke cleanup helper');
SELECT ok(NOT has_function_privilege('service_role','public.unlink_settled_voice_usage_on_business_delete()','EXECUTE'),
  'service calls must use the guarded deletion path');
SELECT ok((SELECT NOT condeferrable FROM pg_constraint WHERE conrelid='public.voice_customer_usage'::regclass AND conname='voice_customer_usage_session_id_fkey'),
  'session foreign key remains immediate');

SELECT lives_ok($$DELETE FROM public.voice_sessions WHERE id=(SELECT s FROM cleanup_fixture WHERE label='direct')$$,
  'direct settled history deletion still succeeds');
SELECT ok((SELECT u.session_id IS NULL AND u.business_id=f.b FROM public.voice_customer_usage u JOIN cleanup_fixture f ON f.s=u.call_key WHERE f.label='direct'),
  'history deletion retains the existing business linkage');
SELECT throws_ok($$SELECT public.admit_voice_commercial((SELECT b FROM cleanup_fixture WHERE label='direct'),'cleanup-092-direct','replayed','+12125550100','+12125550101',true)$$,
  '55000','voice call history was deleted; replay denied','retained accounting still prevents replay after history deletion');

SELECT lives_ok($$DELETE FROM public.businesses WHERE id=(SELECT b FROM cleanup_fixture WHERE label='account')$$,
  'hard account deletion with settled call history succeeds');
SELECT is((SELECT count(*)::integer FROM public.voice_sessions WHERE business_id=(SELECT b FROM cleanup_fixture WHERE label='account')),0,
  'account deletion removes call history');
SELECT is((SELECT count(*)::integer FROM public.voice_customer_usage WHERE period_id=(SELECT p FROM cleanup_fixture WHERE label='account') AND business_id IS NULL AND session_id IS NULL),2,
  'account deletion retains linked and historical usage with both links cleared');
SELECT ok((SELECT business_id IS NULL FROM public.voice_allowance_periods WHERE id=(SELECT p FROM cleanup_fixture WHERE label='account')),
  'allowance remains anonymous after account deletion');

SELECT throws_ok($$DELETE FROM public.voice_sessions WHERE id=(SELECT s FROM cleanup_fixture WHERE label='unsettled')$$,
  '55000','settle commercial voice before deleting its history','unsettled direct history deletion remains blocked');
SELECT throws_ok($$DELETE FROM public.businesses WHERE id=(SELECT b FROM cleanup_fixture WHERE label='unsettled')$$,
  '55000','settle commercial voice before deleting its history','unsettled account deletion remains blocked');
SELECT ok((SELECT u.session_id=f.s AND u.business_id=f.b FROM public.voice_customer_usage u JOIN cleanup_fixture f ON f.s=u.call_key WHERE f.label='unsettled'),
  'failed deletion leaves unsettled accounting attached');
SELECT throws_ok($$DELETE FROM public.businesses WHERE id=(SELECT b FROM cleanup_fixture WHERE label='mixed')$$,
  '55000','settle commercial voice before deleting its history','unsettled usage without history also prevents account deletion');
SELECT ok((SELECT u.session_id=f.s AND u.business_id=f.b FROM public.voice_customer_usage u JOIN cleanup_fixture f ON f.s=u.call_key WHERE f.label='mixed'),
  'a rejected mixed account deletion does not partially detach settled usage');

SELECT throws_ok($$INSERT INTO public.voice_customer_usage(call_key,call_identity_hash,business_id,session_id,period_id,reserved_seconds)
  SELECT gen_random_uuid(),encode(extensions.digest('missing-session','sha256'),'hex'),b,gen_random_uuid(),p,60 FROM cleanup_fixture WHERE label='mixed'$$,
  '23503',NULL,'new usage cannot reference a nonexistent session');
SELECT throws_ok($$UPDATE public.voice_customer_usage SET settled_seconds=24 WHERE call_key=(SELECT s FROM cleanup_fixture WHERE label='account')$$,
  '55000','voice customer accounting is immutable','anonymous settled usage cannot be rewritten');
SELECT throws_ok($$DELETE FROM public.voice_customer_usage WHERE call_key=(SELECT s FROM cleanup_fixture WHERE label='account')$$,
  '55000','voice accounting cannot be deleted','anonymous usage cannot be erased');
SELECT throws_ok($$UPDATE public.voice_allowance_periods SET included_seconds=5999 WHERE id=(SELECT p FROM cleanup_fixture WHERE label='account')$$,
  '55000','voice allowance grant is immutable','anonymous allowance cannot be changed');
SELECT is((SELECT count(*)::integer FROM saved_usage old JOIN public.voice_customer_usage current USING(call_key)
  WHERE old.facts IS DISTINCT FROM to_jsonb(current)-'business_id'-'session_id'),0,'all usage evidence and amounts remain unchanged');
SELECT is((SELECT count(*)::integer FROM saved_period old JOIN public.voice_allowance_periods current USING(id)
  WHERE old.facts IS DISTINCT FROM to_jsonb(current)-'business_id'),0,'all allowance facts remain unchanged');

SELECT * FROM finish();
ROLLBACK;
