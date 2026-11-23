BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

CREATE TEMP TABLE ids AS SELECT gen_random_uuid() AS business, gen_random_uuid() AS owner,
  gen_random_uuid() AS pilot, gen_random_uuid() AS commercial, gen_random_uuid() AS prior;
INSERT INTO auth.users(id,email) SELECT owner, owner||'@example.test' FROM ids;
INSERT INTO public.businesses(id,owner_id,name,business_type,slug)
  SELECT business,owner,'Voice model usage','general','voice-model-'||business FROM ids;
INSERT INTO public.voice_sessions(id,business_id,call_control_id,call_session_id,caller_phone,called_phone,response_mode,status,access_source)
  SELECT v.id,business,'control-'||v.id,'session-'||v.id,'+15745550101','+15745550102','voice','closed',v.source
  FROM ids CROSS JOIN LATERAL (VALUES (pilot,'pilot'),(commercial,'commercial'),(prior,'commercial')) v(id,source);

GRANT SELECT ON ids TO service_role;
SELECT ok(NOT has_function_privilege('anon','public.update_voice_model_usage(uuid,numeric,boolean,text)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.update_voice_model_usage(uuid,numeric,boolean,text)','EXECUTE'),
  'model-aware accounting is private');
SET LOCAL ROLE service_role;
SELECT public.update_voice_usage(prior, 60, true) FROM ids;
SELECT public.update_voice_model_usage(pilot, 60, true, 'gpt-live-1.1') FROM ids;
SELECT public.update_voice_model_usage(commercial, 60, true, 'gpt-live-1.1') FROM ids;
SELECT public.update_voice_model_usage(commercial, 20, false, 'gpt-live-1.1') FROM ids;
SELECT public.update_voice_usage(pilot, 30, false) FROM ids;
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.voice_provider_usage,ids WHERE session_id IN (pilot,commercial)
    AND model='gpt-live-1.1' AND seconds=60 AND estimated_cost_usd=0.05 AND status='confirmed'),2,
  'pilot, commercial, retries and legacy reconciliation retain the new model and the same charge');
SELECT is((SELECT model FROM public.voice_provider_usage,ids WHERE session_id=prior),'gpt-live-1','prior sessions keep their model');
SELECT throws_ok($q$SELECT public.update_voice_model_usage(pilot, 90, true, 'invalid-model') FROM ids$q$,
  '22023','Unsupported voice usage model','unsupported models cannot modify accounting');
SELECT * FROM finish();
ROLLBACK;
