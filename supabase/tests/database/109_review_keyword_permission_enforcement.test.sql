BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES('00000000-0000-4000-a109-000000000001','keyword-109@example.test',now());
INSERT INTO businesses(id,owner_id,name,business_type,slug,billing_mode,partner_plan,telnyx_messaging_profile_id,telnyx_campaign_id,campaign_status,review_sms_signup_enabled) VALUES
 ('10000000-0000-4000-a109-000000000001','00000000-0000-4000-a109-000000000001','Hosted Keyword','general','keyword-109','comped','full','profile-109','campaign-109','approved',true),
 ('10000000-0000-4000-a109-000000000002','00000000-0000-4000-a109-000000000001','Legacy Custom','general','custom-109','comped','full',NULL,NULL,NULL,false);
INSERT INTO phone_numbers(id,business_id,phone_number,telnyx_phone_number_id,is_active,resource_status,telnyx_campaign_assignment_status,telnyx_campaign_assignment_campaign_id)
 VALUES('30000000-0000-4000-a109-000000000001','10000000-0000-4000-a109-000000000001','+15745550109','phone-109',true,'active','assigned','campaign-109');
INSERT INTO review_sms_accounts(business_id,owner_id,state,billing_source,review_usecase_approved_at,approval_evidence,campaign_id,messaging_profile_id,phone_number_id,draft)
 VALUES('10000000-0000-4000-a109-000000000001','00000000-0000-4000-a109-000000000001','active','included',now(),'approved for reviews','campaign-109','profile-109','30000000-0000-4000-a109-000000000001','{"consentMode":"hosted_keyword"}');
INSERT INTO contacts(id,business_id,email,phone_number,source_channel) VALUES
 ('40000000-0000-4000-a109-000000000001','10000000-0000-4000-a109-000000000001','customer109@example.test','+15745550110','manual'),
 ('40000000-0000-4000-a109-000000000002','10000000-0000-4000-a109-000000000002','custom109@example.test','+15745550111','manual');
INSERT INTO conversations(id,business_id,contact_id,channel,is_ai_handling)
 VALUES('50000000-0000-4000-a109-000000000001','10000000-0000-4000-a109-000000000001','40000000-0000-4000-a109-000000000001','sms',true);
UPDATE review_email_control SET enabled=true,sms_sending_enabled=true,pilot_business_ids=ARRAY['10000000-0000-4000-a109-000000000001'::uuid],excluded_business_ids='{}';
SELECT review_initialize_settings('10000000-0000-4000-a109-000000000001','00000000-0000-4000-a109-000000000001');
UPDATE review_settings SET google_review_url='https://g.page/r/example/review',paused=false WHERE business_id='10000000-0000-4000-a109-000000000001';
INSERT INTO billing_usage_periods(id,business_id,period_start,period_end,plan,included_sms_parts)
 VALUES('80000000-0000-4000-a109-000000000001','10000000-0000-4000-a109-000000000001',now()-interval '1 day',now()+interval '29 days','full',1000);

CREATE FUNCTION pg_temp.block() RETURNS text LANGUAGE sql AS $$ SELECT review_recipient_block('10000000-0000-4000-a109-000000000001','40000000-0000-4000-a109-000000000001','+15745550110',ARRAY['phone:+15745550110']) $$;
CREATE FUNCTION pg_temp.permission(granted boolean,channel text DEFAULT 'sms') RETURNS void LANGUAGE sql AS $$
 SELECT review_record_permission('10000000-0000-4000-a109-000000000001','00000000-0000-4000-a109-000000000001','40000000-0000-4000-a109-000000000001',channel,granted,'Owner recorded customer request',NULL)
$$;
CREATE FUNCTION pg_temp.confirm() RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO review_campaign_previews(id,business_id,owner_id,settings_revision,snapshot)
 SELECT '70000000-0000-4000-a109-000000000001',s.business_id,s.owner_id,s.revision,
 jsonb_build_object('channel','sms','subject','Review','body','Honest review','reminderEnabled',false,'scheduledAt',now(),'googleReviewUrl','https://g.page/r/example/review','smsSender','+15745550109','smsMessagingProfileId','profile-109','summary','{}'::jsonb,'recipients',jsonb_build_array(jsonb_build_object('contactId','40000000-0000-4000-a109-000000000001','enrollmentId','71000000-0000-4000-a109-000000000001','phone','+15745550110','identities',jsonb_build_array('phone:+15745550110'),'timezone','America/New_York','scheduledAt',now())))
 FROM review_settings s WHERE business_id='10000000-0000-4000-a109-000000000001' ON CONFLICT DO NOTHING;
 RETURN review_confirm_sms_campaign('70000000-0000-4000-a109-000000000001','10000000-0000-4000-a109-000000000001','00000000-0000-4000-a109-000000000001',jsonb_build_array(jsonb_build_object('id','72000000-0000-4000-a109-000000000001','enrollmentId','71000000-0000-4000-a109-000000000001','body','Honest review')));
END $$;
CREATE FUNCTION pg_temp.reserve() RETURNS jsonb LANGUAGE sql AS $$
 SELECT reserve_tenant_sms('10000000-0000-4000-a109-000000000001','80000000-0000-4000-a109-000000000001','keyword-send-109','fingerprint-109','review_invitation','profile-109','+15745550109','+15745550110',1,NULL,'71000000-0000-4000-a109-000000000001')
$$;

SELECT ok(review_sms_requires_keyword('10000000-0000-4000-a109-000000000001'),'new hosted program requires customer keyword');
SELECT ok(NOT review_sms_requires_keyword('10000000-0000-4000-a109-000000000002'),'legacy custom program unchanged');
SELECT ok(NOT has_function_privilege('authenticated','review_sms_has_keyword_consent(uuid,uuid,text)','EXECUTE'),'private evidence helper service only');
SELECT is(pg_temp.block(),'review_sms_keyword_permission_required','imported phone number alone cannot enter SMS audience');
SELECT throws_ok($$SELECT pg_temp.permission(true)$$,'22023','review_sms_keyword_permission_required','manual owner permission cannot bypass hosted keyword');
SELECT lives_ok($$SELECT pg_temp.permission(true,'email')$$,'email permission is unchanged');
SELECT lives_ok($$SELECT review_record_permission('10000000-0000-4000-a109-000000000002','00000000-0000-4000-a109-000000000001','40000000-0000-4000-a109-000000000002','sms',true,'Existing custom consent evidence',NULL)$$,'legacy custom SMS permission remains available');
SELECT is(review_preview_blocks('10000000-0000-4000-a109-000000000001','[{"contactId":"40000000-0000-4000-a109-000000000001","destination":"+15745550110","identities":["phone:+15745550110"]}]')->0->>'reason','review_sms_keyword_permission_required','preview explains missing keyword consent');
SELECT throws_ok($$SELECT pg_temp.confirm()$$,'22023','review_audience_changed:review_sms_keyword_permission_required','confirmation rejects a forged or stale eligible audience');
SELECT is((SELECT count(*)::integer FROM review_sms_outbox WHERE business_id='10000000-0000-4000-a109-000000000001'),0,'denied confirmation queues nothing');
INSERT INTO messages(id,business_id,conversation_id,channel,role,content,provider_event_id)
 VALUES('60000000-0000-4000-a109-000000000001','10000000-0000-4000-a109-000000000001','50000000-0000-4000-a109-000000000001','sms','customer','REVIEWS','provider-consent-109');
SELECT is(review_record_sms_consent('10000000-0000-4000-a109-000000000001','profile-109','+15745550110','+15745550109','50000000-0000-4000-a109-000000000001','60000000-0000-4000-a109-000000000001','provider-109',now(),'review-texts-v1')->>'granted','true','signed customer keyword grants permission');
SELECT is(pg_temp.block(),NULL::text,'recorded keyword makes the customer eligible');
SELECT ok(NOT review_sms_has_keyword_consent('10000000-0000-4000-a109-000000000002','40000000-0000-4000-a109-000000000001','+15745550110'),'consent cannot cross businesses');
SELECT lives_ok($$SELECT pg_temp.confirm()$$,'confirmed keyword audience may queue a review');
SELECT ok((SELECT actor_id IS NULL AND sms_consent_event_id IS NOT NULL FROM review_permissions WHERE destination='+15745550110'),'campaign confirmation preserves customer-owned evidence');

-- A permission mutation after preview/claim is caught again at dispatch.
UPDATE review_permissions SET actor_id='00000000-0000-4000-a109-000000000001' WHERE destination='+15745550110';
SELECT throws_ok($$SELECT pg_temp.reserve()$$,'22023','sms_review_keyword_permission_required','final reservation rejects owner-attestation substitution');
UPDATE review_sms_outbox SET status='claimed',claim_token='73000000-0000-4000-a109-000000000001',lease_until=now()+interval '2 minutes' WHERE id='72000000-0000-4000-a109-000000000001';
SELECT is((review_begin_sms('72000000-0000-4000-a109-000000000001','73000000-0000-4000-a109-000000000001')).id,NULL::uuid,'worker does not begin a send after keyword evidence is lost');
SELECT is((SELECT last_error FROM review_sms_outbox WHERE id='72000000-0000-4000-a109-000000000001'),'review_sms_keyword_permission_required','worker saves an actionable permission reason');
UPDATE review_permissions SET actor_id=NULL WHERE destination='+15745550110';
SELECT is(pg_temp.reserve()->>'send','true','current genuine keyword permission authorizes final reservation');
SELECT lives_ok($$SELECT pg_temp.permission(false)$$,'owner can still withdraw SMS permission');
SELECT is(pg_temp.reserve()->>'send','false','receipt replay cannot send twice after withdrawal');
SELECT * FROM finish();
ROLLBACK;
