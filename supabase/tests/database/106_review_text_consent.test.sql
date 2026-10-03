BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();
INSERT INTO auth.users(id,email) VALUES('00000000-0000-4000-a106-000000000001','review-consent@example.test');
INSERT INTO businesses(id,owner_id,name,business_type,slug,billing_mode,partner_plan,telnyx_messaging_profile_id,telnyx_campaign_id,campaign_status)
VALUES('10000000-0000-4000-a106-000000000001','00000000-0000-4000-a106-000000000001','Consent Business','general','consent-106','comped','full','profile-106','campaign-106','approved');
INSERT INTO phone_numbers(id,business_id,phone_number,telnyx_phone_number_id,is_active,resource_status,telnyx_campaign_assignment_status,telnyx_campaign_assignment_campaign_id)
VALUES('30000000-0000-4000-a106-000000000001','10000000-0000-4000-a106-000000000001','+15745550106','phone-106',true,'active','assigned','campaign-106');
INSERT INTO review_sms_accounts(business_id,owner_id,state,billing_source,review_usecase_approved_at,approval_evidence,campaign_id,messaging_profile_id,phone_number_id)
VALUES('10000000-0000-4000-a106-000000000001','00000000-0000-4000-a106-000000000001','active','included',now(),'review scope approved','campaign-106','profile-106','30000000-0000-4000-a106-000000000001');
INSERT INTO contacts(id,business_id,phone_number,provided_phone_number,source_channel) VALUES
('40000000-0000-4000-a106-000000000001','10000000-0000-4000-a106-000000000001','+15745550107',NULL,'sms'),
('40000000-0000-4000-a106-000000000002','10000000-0000-4000-a106-000000000001',NULL,'+15745550107','manual'),
('40000000-0000-4000-a106-000000000003','10000000-0000-4000-a106-000000000001','+15745550108',NULL,'manual');
INSERT INTO conversations(id,business_id,contact_id,channel,is_ai_handling)
VALUES('50000000-0000-4000-a106-000000000001','10000000-0000-4000-a106-000000000001','40000000-0000-4000-a106-000000000001','sms',true);
UPDATE review_email_control SET enabled=true,sms_sending_enabled=true,pilot_business_ids=ARRAY['10000000-0000-4000-a106-000000000001'::uuid],excluded_business_ids='{}';
INSERT INTO billing_usage_periods(id,business_id,period_start,period_end,plan,included_sms_parts)
VALUES('80000000-0000-4000-a106-000000000001','10000000-0000-4000-a106-000000000001',now()-interval '1 day',now()+interval '29 days','full',1000);

CREATE FUNCTION pg_temp.consent(n integer, at_time timestamptz DEFAULT now(), content text DEFAULT 'REVIEWS') RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE m uuid:=('60000000-0000-4000-a106-'||lpad(n::text,12,'0'))::uuid;
BEGIN
 INSERT INTO messages(id,business_id,conversation_id,channel,role,content,provider_event_id)
 VALUES(m,'10000000-0000-4000-a106-000000000001','50000000-0000-4000-a106-000000000001','sms','customer',content,'consent-provider-'||n) ON CONFLICT DO NOTHING;
 RETURN review_record_sms_consent('10000000-0000-4000-a106-000000000001','profile-106','+15745550107','+15745550106','50000000-0000-4000-a106-000000000001',m,'provider-'||n,at_time,'review-texts-v1');
END $$;
CREATE FUNCTION pg_temp.keyword(text) RETURNS jsonb LANGUAGE sql AS $$ SELECT tenant_sms_inbound('10000000-0000-4000-a106-000000000001','profile-106','+15745550107',$1,'50000000-0000-4000-a106-000000000001'); $$;
CREATE FUNCTION pg_temp.confirm_consent(key text) RETURNS jsonb LANGUAGE sql AS $$
SELECT reserve_tenant_sms('10000000-0000-4000-a106-000000000001','80000000-0000-4000-a106-000000000001',key,'confirmation-fingerprint','review_consent_confirmation','profile-106','+15745550106','+15745550107',2,'50000000-0000-4000-a106-000000000001');
$$;
SELECT ok(NOT has_table_privilege('anon','review_sms_consent_events','INSERT'),'public pages cannot grant permission');
SELECT ok(NOT has_function_privilege('authenticated','review_record_sms_consent(uuid,text,text,text,uuid,uuid,text,timestamptz,text)','EXECUTE'),'owners cannot impersonate inbound customer permission');
SELECT throws_ok($$SELECT pg_temp.consent(9,now(),'START')$$,'P0001','review_sms_consent_identity_invalid','START is never review consent');
SELECT is(pg_temp.consent(1)->>'granted','true','verified inbound REVIEWS grants permission');
SELECT is((SELECT count(*)::int FROM review_permissions WHERE business_id='10000000-0000-4000-a106-000000000001' AND revoked_at IS NULL),2,'grants both current matching customer records and no other destination');
SELECT ok((SELECT bool_and(actor_id IS NULL AND sms_consent_event_id IS NOT NULL) FROM review_permissions WHERE business_id='10000000-0000-4000-a106-000000000001'),'customer-owned permission has durable evidence without inventing an owner attestation');
SELECT is((SELECT count(*)::int FROM review_enrollments WHERE business_id='10000000-0000-4000-a106-000000000001'),0,'consent does not enroll anyone');
SELECT is((SELECT count(*)::int FROM review_sms_outbox WHERE business_id='10000000-0000-4000-a106-000000000001'),0,'consent does not queue a review');
SELECT is(pg_temp.consent(1)->>'canConfirm','true','same inbound message can recover an unsent confirmation');
SELECT is((SELECT count(*)::int FROM review_sms_consent_events WHERE business_id='10000000-0000-4000-a106-000000000001'),1,'duplicate inbound message has one evidence record');
SELECT throws_ok($$SELECT pg_temp.confirm_consent('review-consent/v1/arbitrary')$$,'P0001','sms_review_consent_unavailable','confirmation requires exact persisted provider message');
SELECT is(pg_temp.confirm_consent('review-consent/v1/provider-1')->>'send','true','confirmation reserves existing metered pool');
SELECT is(pg_temp.confirm_consent('review-consent/v1/provider-1')->>'send','false','confirmation provider reservation is never repeated');
SELECT is((SELECT count(*)::int FROM tenant_sms_human_holds WHERE business_id='10000000-0000-4000-a106-000000000001'),0,'confirmation does not change normal conversation routing');
SELECT pg_temp.keyword('STOP');
SELECT is(pg_temp.consent(2,now()+interval '1 second')->>'granted','false','REVIEWS cannot bypass carrier STOP');
SELECT is(pg_temp.consent(1)->>'canConfirm','false','replayed prior consent cannot confirm after STOP');
SELECT is((SELECT count(*)::int FROM review_permissions WHERE business_id='10000000-0000-4000-a106-000000000001' AND revoked_at IS NULL),0,'STOP revokes every matching customer permission');
SELECT pg_temp.keyword('START');
SELECT is((SELECT count(*)::int FROM review_permissions WHERE business_id='10000000-0000-4000-a106-000000000001' AND revoked_at IS NULL),0,'START alone does not restore review consent');
SELECT is(pg_temp.consent(2,now()+interval '1 second')->>'granted','false','blocked event replay remains blocked after START');
SELECT is(pg_temp.consent(3,now()+interval '2 seconds')->>'granted','true','new REVIEWS after START restores separate review permission');
SELECT is((SELECT count(*)::int FROM review_suppressions WHERE business_id='10000000-0000-4000-a106-000000000001'),0,'new explicit permission clears only old SMS STOP suppression');
INSERT INTO review_suppressions(business_id,identity,reason) VALUES('10000000-0000-4000-a106-000000000001','phone:+15745550107','unsubscribe');
SELECT is(pg_temp.consent(4,now()+interval '3 seconds')->>'granted','false','other suppression cannot be bypassed by REVIEWS');
DELETE FROM review_suppressions WHERE business_id='10000000-0000-4000-a106-000000000001';
SELECT is(pg_temp.consent(5,now()-interval '25 hours')->>'granted','false','stale inbound events do not grant consent');
UPDATE review_sms_accounts SET state='ready_unpaid' WHERE business_id='10000000-0000-4000-a106-000000000001';
SELECT is(pg_temp.consent(6)->>'granted','true','approved unpaid setup may store permission');
SELECT is(pg_temp.consent(6)->>'canConfirm','false','unpaid setup cannot spend on confirmation');
UPDATE review_sms_accounts SET state='active' WHERE business_id='10000000-0000-4000-a106-000000000001';
UPDATE businesses SET operations_suspended_at=now() WHERE id='10000000-0000-4000-a106-000000000001';
SELECT is(pg_temp.consent(7)->>'granted','false','suspended businesses cannot collect permission');
UPDATE businesses SET operations_suspended_at=NULL WHERE id='10000000-0000-4000-a106-000000000001';
UPDATE review_email_control SET excluded_business_ids=ARRAY['10000000-0000-4000-a106-000000000001'::uuid];
SELECT is(pg_temp.consent(8)->>'granted','false','excluded legacy accounts do not receive new consent behavior');
UPDATE review_email_control SET excluded_business_ids='{}',sms_sending_enabled=false;
SELECT throws_ok($$SELECT pg_temp.confirm_consent('review-consent/v1/provider-6')$$,'P0001','sms_reviews_paused','global SMS dispatch off blocks confirmations too');
UPDATE businesses SET owner_id=NULL WHERE id='10000000-0000-4000-a106-000000000001';
SELECT is((SELECT count(*)::int FROM review_sms_consent_events WHERE business_id='10000000-0000-4000-a106-000000000001'),0,'owner cleanup removes recipient evidence');
SELECT * FROM finish();
ROLLBACK;
