BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

INSERT INTO auth.users(id,email) VALUES ('00000000-0000-4000-a069-000000000001','voice-owner@example.test'), ('00000000-0000-4000-a069-000000000002','voice-other@example.test');
INSERT INTO public.businesses(id,owner_id,name,business_type,slug) VALUES
 ('ea848911-ef72-44a6-8cf3-c47b3959be26','00000000-0000-4000-a069-000000000001','Voice test','general','voice-069'),
 ('10000000-0000-4000-a069-000000000002','00000000-0000-4000-a069-000000000002','Other','general','voice-other-069');
INSERT INTO public.phone_numbers(business_id,phone_number,telnyx_phone_number_id,is_active) VALUES ('ea848911-ef72-44a6-8cf3-c47b3959be26','+15742638634','voice-test-number',true);
INSERT INTO public.subscriptions(business_id,stripe_customer_id,stripe_subscription_id,plan,status) VALUES ('ea848911-ef72-44a6-8cf3-c47b3959be26','cus_voice','sub_voice','sms_and_chat','active');
INSERT INTO public.voice_pilot_settings(business_id) VALUES ('ea848911-ef72-44a6-8cf3-c47b3959be26');
INSERT INTO public.voice_pilot_testers(business_id,phone_number) VALUES ('ea848911-ef72-44a6-8cf3-c47b3959be26','+15555550101');

SELECT is((public.admit_voice_pilot('ea848911-ef72-44a6-8cf3-c47b3959be26','off','off','+15555550101','+15742638634',true)).response_mode,'text','pilot defaults off');
UPDATE public.voice_pilot_settings SET enabled = true;
SELECT is((public.admit_voice_pilot('ea848911-ef72-44a6-8cf3-c47b3959be26','off','off','+15555550101','+15742638634',true)).response_mode,'text','retry preserves original routing after enablement');
SELECT is((public.admit_voice_pilot('ea848911-ef72-44a6-8cf3-c47b3959be26','stranger','stranger','+15555550102','+15742638634',true)).response_mode,'text','non-tester stays on text');
SELECT is((public.admit_voice_pilot('ea848911-ef72-44a6-8cf3-c47b3959be26','worker','worker','+15555550101','+15742638634',false)).outcome,'worker_unavailable','unready worker is not admitted');
SELECT is((public.admit_voice_pilot('ea848911-ef72-44a6-8cf3-c47b3959be26','first','first','+15555550101','+15742638634',true)).response_mode,'voice','approved tester is admitted');
SELECT is((public.admit_voice_pilot('ea848911-ef72-44a6-8cf3-c47b3959be26','second','second','+15555550101','+15742638634',true)).reserved_seconds,600,'second call reserves its full maximum');
SELECT is((SELECT count(DISTINCT conversation_id)::integer FROM public.voice_sessions WHERE response_mode = 'voice'),2,'one distinct conversation per call, including same caller');
SELECT is((public.admit_voice_pilot('ea848911-ef72-44a6-8cf3-c47b3959be26','third','third','+15555550101','+15742638634',true)).outcome,'capacity_unavailable','concurrent capacity enforced');
SELECT is((SELECT count(*)::integer FROM public.contacts WHERE business_id = 'ea848911-ef72-44a6-8cf3-c47b3959be26'),1,'caller identity reused without customer history lookup');
SELECT throws_ok($$ SELECT public.admit_voice_pilot('ea848911-ef72-44a6-8cf3-c47b3959be26','first','first','+15555550999','+15742638634',true) $$,'P0001','Call identity mismatch','cannot reuse a call identity for a different caller');
UPDATE public.voice_sessions SET status='closed' WHERE response_mode='voice';
UPDATE public.voice_pilot_settings SET budget_seconds=1200;
SELECT is((public.admit_voice_pilot('ea848911-ef72-44a6-8cf3-c47b3959be26','empty','empty','+15555550101','+15742638634',true)).outcome,'minutes_unavailable','unconfirmed usage retains reservation after loss');
UPDATE public.voice_pilot_settings SET budget_seconds=12000;
UPDATE public.businesses SET ai_replies_paused_at=now() WHERE id='ea848911-ef72-44a6-8cf3-c47b3959be26';
SELECT is((public.admit_voice_pilot('ea848911-ef72-44a6-8cf3-c47b3959be26','paused','paused','+15555550101','+15742638634',true)).outcome,'operationally_unavailable','AI pause blocks pilot exception');
UPDATE public.businesses SET ai_replies_paused_at=NULL WHERE id='ea848911-ef72-44a6-8cf3-c47b3959be26';
UPDATE public.subscriptions SET status='canceled' WHERE business_id='ea848911-ef72-44a6-8cf3-c47b3959be26';
SELECT is((public.admit_voice_pilot('ea848911-ef72-44a6-8cf3-c47b3959be26','inactive','inactive','+15555550101','+15742638634',true)).outcome,'operationally_unavailable','inactive subscription blocks pilot');

SELECT ok(NOT has_table_privilege('authenticated','public.voice_pilot_settings','UPDATE'),'customer cannot enable pilot or increase budget');
SELECT ok(NOT has_table_privilege('authenticated','public.voice_stream_credentials','SELECT'),'stream credentials not customer-readable');
SELECT ok(NOT has_function_privilege('authenticated','public.admit_voice_pilot(uuid,text,text,text,text,boolean)','EXECUTE'),'admission is service-only');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-4000-a069-000000000002","role":"authenticated"}',true);
SELECT is((SELECT count(*)::integer FROM public.voice_sessions),0,'other business cannot read voice calls');
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-4000-a069-000000000001","role":"authenticated"}',true);
SELECT ok((SELECT count(*) > 0 FROM public.voice_sessions),'owner can read historical calls');
SELECT throws_ok($$ UPDATE public.conversations SET is_ai_handling=true WHERE channel='voice' $$,'42501','Voice history is read-only','customer cannot take over voice conversation');
RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
