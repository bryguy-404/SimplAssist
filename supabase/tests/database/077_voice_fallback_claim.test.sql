BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT no_plan();
INSERT INTO auth.users(id,email) VALUES ('00000000-0000-4000-a077-000000000001','voice-opening@example.test');
INSERT INTO public.businesses(id,owner_id,name,business_type,slug) VALUES ('ea848911-ef72-44a6-8cf3-c47b3959be26','00000000-0000-4000-a077-000000000001','Voice','general','voice-077');
INSERT INTO public.voice_pilot_settings(business_id,enabled) VALUES ('ea848911-ef72-44a6-8cf3-c47b3959be26',true);
INSERT INTO public.subscriptions(business_id,stripe_customer_id,stripe_subscription_id,plan,status) VALUES ('ea848911-ef72-44a6-8cf3-c47b3959be26','cus_voice','sub_voice','sms_and_chat','active');
INSERT INTO public.contacts(id,business_id,phone_number,source_channel) VALUES ('20000000-0000-4000-a077-000000000001','ea848911-ef72-44a6-8cf3-c47b3959be26','+15555550101','voice');
INSERT INTO public.conversations(id,business_id,contact_id,channel) VALUES ('30000000-0000-4000-a077-000000000001','ea848911-ef72-44a6-8cf3-c47b3959be26','20000000-0000-4000-a077-000000000001','voice');
INSERT INTO public.voice_sessions(id,business_id,conversation_id,call_control_id,call_session_id,caller_phone,called_phone,response_mode,status,reserved_seconds) VALUES ('40000000-0000-4000-a077-000000000001','ea848911-ef72-44a6-8cf3-c47b3959be26','30000000-0000-4000-a077-000000000001','control','session','+15555550101','+15742638634','voice','active',600);


UPDATE public.voice_sessions SET status='closed',fallback_pending=true;
WITH claim AS (
 UPDATE public.voice_sessions SET fallback_claimed_at=clock_timestamp()
 WHERE id='40000000-0000-4000-a077-000000000001' AND fallback_pending AND fallback_completed_at IS NULL AND fallback_claimed_at IS NULL RETURNING id
) SELECT is((SELECT count(*)::integer FROM claim),1,'first delivery owns durable claim');
WITH claim AS (
 UPDATE public.voice_sessions SET fallback_claimed_at=clock_timestamp()
 WHERE id='40000000-0000-4000-a077-000000000001' AND fallback_pending AND fallback_completed_at IS NULL AND fallback_claimed_at IS NULL RETURNING id
) SELECT is((SELECT count(*)::integer FROM claim),0,'duplicate cannot take existing claim');
SELECT public.finalize_voice_session('40000000-0000-4000-a077-000000000001','backend_failed','backend_failed',true,false);
SELECT ok((SELECT fallback_claimed_at IS NOT NULL FROM public.voice_sessions),'replayed finalization does not release ambiguous delivery');
SELECT ok(NOT has_table_privilege('authenticated','public.voice_sessions','UPDATE'),'customer cannot release claim');
SELECT ok(NOT has_table_privilege('anon','public.voice_sessions','UPDATE'),'anonymous caller cannot release claim');
SELECT * FROM finish();
ROLLBACK;
