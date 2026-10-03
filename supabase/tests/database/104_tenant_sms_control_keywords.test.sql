BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();

INSERT INTO auth.users(id,email)
VALUES('00000000-0000-4000-a104-000000000001','keywords-owner@example.test');
INSERT INTO businesses(id,owner_id,name,business_type,slug,billing_mode,partner_plan,telnyx_messaging_profile_id)
VALUES('10000000-0000-4000-a104-000000000001','00000000-0000-4000-a104-000000000001','Keyword Test','general','keywords-104','comped','sms_and_chat','profile-104');
INSERT INTO contacts(id,business_id,phone_number,source_channel)
VALUES('40000000-0000-4000-a104-000000000001','10000000-0000-4000-a104-000000000001','+15555550104','sms');
INSERT INTO conversations(id,business_id,contact_id,channel,is_ai_handling)
VALUES('50000000-0000-4000-a104-000000000001','10000000-0000-4000-a104-000000000001','40000000-0000-4000-a104-000000000001','sms',true);

CREATE FUNCTION pg_temp.sms_keyword(p_text text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT tenant_sms_inbound('10000000-0000-4000-a104-000000000001','profile-104','+15555550104',p_text,'50000000-0000-4000-a104-000000000001');
$$;

SELECT is(pg_temp.sms_keyword(word)->>'keyword','stop','recognizes stop keyword: '||word)
FROM unnest(ARRAY['STOP','STOPALL','STOP ALL','UNSUBSCRIBE','CANCEL','END','QUIT','REVOKE','OPT OUT',E' \tstop\t all\n']) AS word;
SELECT is((SELECT count(*)::integer FROM tenant_sms_suppressions WHERE business_id='10000000-0000-4000-a104-000000000001'),1,'STOP variants produce one durable destination suppression');
SELECT is(pg_temp.sms_keyword('HELP')->>'keyword','help','HELP is a provider control message');
SELECT is(pg_temp.sms_keyword(E' \tinfo\n')->>'keyword','help','INFO recognizes surrounding whitespace');
SELECT is((SELECT count(*)::integer FROM tenant_sms_suppressions WHERE business_id='10000000-0000-4000-a104-000000000001'),1,'HELP cannot clear suppression');
SELECT is(pg_temp.sms_keyword('START')->>'keyword','start','START is a provider control message');
SELECT is(pg_temp.sms_keyword('UNSTOP')->>'keyword','start','UNSTOP is a provider control message');
SELECT is((SELECT count(*)::integer FROM tenant_sms_suppressions WHERE business_id='10000000-0000-4000-a104-000000000001'),0,'START clears only the carrier suppression');
SELECT is(pg_temp.sms_keyword('I need help scheduling')->>'keyword',NULL,'ordinary help request remains a conversation');
SELECT is(pg_temp.sms_keyword('Please stop by tomorrow')->>'keyword',NULL,'substring matching cannot interpret ordinary content as STOP');

INSERT INTO tenant_sms_human_holds(business_id,messaging_profile_id,destination,conversation_id)
VALUES('10000000-0000-4000-a104-000000000001','profile-104','+15555550104','50000000-0000-4000-a104-000000000001');
SELECT is(pg_temp.sms_keyword('HELP')->>'reviewHeld','true','HELP preserves the review human hold');
SELECT is(pg_temp.sms_keyword('START')->>'reviewHeld','true','START cannot release the review human hold');
SELECT ok((SELECT NOT is_ai_handling AND status='handed_off' FROM conversations WHERE id='50000000-0000-4000-a104-000000000001'),'control messages cannot resume held AI');
SELECT ok(NOT has_function_privilege('authenticated','public.tenant_sms_inbound(uuid,text,text,text,uuid)','EXECUTE'),'control keyword mutation remains service-only');

SELECT * FROM finish();
ROLLBACK;
