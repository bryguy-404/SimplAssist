BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES('00000000-0000-4000-a099-000000000001','reviewsms@example.test',now());
INSERT INTO businesses(id,owner_id,name,business_type,slug,billing_mode,partner_plan) VALUES('10000000-0000-4000-a099-000000000001','00000000-0000-4000-a099-000000000001','SMS Review Business','general','review-099','comped','chat_only');
INSERT INTO contacts(id,business_id,name,email,phone_number,source_channel) VALUES
 ('20000000-0000-4000-a099-000000000001','10000000-0000-4000-a099-000000000001','One','smsreview1@example.test','+15745550191','manual'),
 ('20000000-0000-4000-a099-000000000002','10000000-0000-4000-a099-000000000001','Two','smsreview2@example.test','+15745550192','manual');
SELECT review_initialize_settings('10000000-0000-4000-a099-000000000001','00000000-0000-4000-a099-000000000001');
SELECT ok(NOT (SELECT sms_sending_enabled FROM review_email_control),'SMS send gate defaults off');
SELECT ok(NOT has_function_privilege('authenticated','review_claim_sms(integer)','EXECUTE'),'only service can claim SMS');
INSERT INTO review_campaigns(id,business_id,owner_id,subject,body,reminder_enabled,scheduled_at,completed_service_attested_at,permission_attested_at,audience_count,channel) VALUES('50000000-0000-4000-a099-000000000001','10000000-0000-4000-a099-000000000001','00000000-0000-4000-a099-000000000001','Review','Honest review',true,now(),now(),now(),2,'sms');
INSERT INTO review_enrollments(id,business_id,campaign_id,contact_id,original_contact_id,identities,destination,channel,google_review_url,timezone) VALUES
 ('30000000-0000-4000-a099-000000000001','10000000-0000-4000-a099-000000000001','50000000-0000-4000-a099-000000000001','20000000-0000-4000-a099-000000000001','20000000-0000-4000-a099-000000000001',ARRAY['email:smsreview1@example.test','phone:+15745550191'],'+15745550191','sms','https://g.page/r/review/review','America/New_York'),
 ('30000000-0000-4000-a099-000000000002','10000000-0000-4000-a099-000000000001','50000000-0000-4000-a099-000000000001','20000000-0000-4000-a099-000000000002','20000000-0000-4000-a099-000000000002',ARRAY['email:smsreview2@example.test','phone:+15745550192'],'+15745550192','sms','https://g.page/r/review/review','America/New_York');
INSERT INTO review_sms_outbox(id,business_id,owner_id,enrollment_id,kind,destination,sender,messaging_profile_id,body,status,scheduled_at,next_attempt_at,expires_at,lease_until,first_attempt_at) VALUES
 ('40000000-0000-4000-a099-000000000001','10000000-0000-4000-a099-000000000001','00000000-0000-4000-a099-000000000001','30000000-0000-4000-a099-000000000001','initial','+15745550191','+15745550190','profile','Honest review','submitting',now(),now(),now()+interval '24 hours',now()-interval '1 second',now()),
 ('40000000-0000-4000-a099-000000000002','10000000-0000-4000-a099-000000000001','00000000-0000-4000-a099-000000000001','30000000-0000-4000-a099-000000000002','initial','+15745550192','+15745550190','profile','Honest review','pending',now(),now(),now()+interval '24 hours',NULL,NULL);
SELECT is((SELECT count(*)::integer FROM review_claim_sms()),0,'off gate claims no outbound work');
SELECT is((SELECT status FROM review_sms_outbox WHERE id='40000000-0000-4000-a099-000000000001'),'unknown','expired submitting SMS becomes unknown, never pending');
SELECT is(review_recipient_block('10000000-0000-4000-a099-000000000001','20000000-0000-4000-a099-000000000001','smsreview1@example.test',ARRAY['email:smsreview1@example.test']),'cooldown','unknown SMS prevents cross-channel duplicate email');
UPDATE review_sms_outbox SET status='submitting',claim_token='60000000-0000-4000-a099-000000000002',first_attempt_at=now() WHERE id='40000000-0000-4000-a099-000000000002';
SELECT review_finish_sms('40000000-0000-4000-a099-000000000002','60000000-0000-4000-a099-000000000002','deferred',NULL,NULL,'sms_usage_limit_reached');
SELECT ok((SELECT status='pending' AND first_attempt_at IS NULL FROM review_sms_outbox WHERE id='40000000-0000-4000-a099-000000000002'),'quota admission denial with no reservation safely defers without sending');
SELECT is((SELECT status FROM review_enrollments WHERE id='30000000-0000-4000-a099-000000000002'),'active','temporary quota denial preserves active review enrollment');
SELECT review_stop_sms_destination('10000000-0000-4000-a099-000000000001','+15745550192','sms_reply');
SELECT is((SELECT status FROM review_sms_outbox WHERE id='40000000-0000-4000-a099-000000000002'),'cancelled','human reply cancels pending review SMS');
SELECT review_stop_sms_destination('10000000-0000-4000-a099-000000000001','+15745550191','sms_stop');
SELECT ok(EXISTS(SELECT 1 FROM review_suppressions WHERE identity='phone:+15745550191'),'STOP persists normalized destination suppression');
SELECT is((SELECT status FROM review_sms_outbox WHERE id='40000000-0000-4000-a099-000000000001'),'unknown','STOP cannot erase uncertain provider acceptance');
SELECT is(review_recipient_block('10000000-0000-4000-a099-000000000001','20000000-0000-4000-a099-000000000002','wrong@example.test',ARRAY['email:wrong@example.test']),'customer_changed','wrong destination cannot pass via null contact field');
UPDATE review_enrollments SET accepted_at=now()-interval '89 days' WHERE id='30000000-0000-4000-a099-000000000002';
SELECT is(review_recipient_block('10000000-0000-4000-a099-000000000001','20000000-0000-4000-a099-000000000002','smsreview2@example.test',ARRAY['email:smsreview2@example.test']),'cooldown','accepted SMS maintains cooldown for future email');
-- Existing permission evidence belongs to the original grant, including when
-- an automatic completed-service campaign confirms a pre-authorized audience.
UPDATE businesses SET partner_plan='full',telnyx_campaign_id='campaign-099',telnyx_messaging_profile_id='profile-099',campaign_status='approved' WHERE id='10000000-0000-4000-a099-000000000001';
INSERT INTO phone_numbers(id,business_id,phone_number,telnyx_phone_number_id,is_active,resource_status,telnyx_campaign_assignment_status,telnyx_campaign_assignment_campaign_id)
 VALUES('70000000-0000-4000-a099-000000000001','10000000-0000-4000-a099-000000000001','+15745550190','phone-099',true,'active','assigned','campaign-099');
INSERT INTO review_sms_accounts(business_id,owner_id,state,billing_source,review_usecase_approved_at,approval_evidence,campaign_id,messaging_profile_id,phone_number_id)
 VALUES('10000000-0000-4000-a099-000000000001','00000000-0000-4000-a099-000000000001','active','included',now(),'Approved review usecase','campaign-099','profile-099','70000000-0000-4000-a099-000000000001');
UPDATE review_email_control SET enabled=true,sms_sending_enabled=true,pilot_business_ids=ARRAY['10000000-0000-4000-a099-000000000001'::uuid];
INSERT INTO contacts(id,business_id,name,phone_number,source_channel) VALUES
 ('20000000-0000-4000-a099-000000000003','10000000-0000-4000-a099-000000000001','Granted customer','+15745550193','manual'),
 ('20000000-0000-4000-a099-000000000004','10000000-0000-4000-a099-000000000001','Revoked customer','+15745550194','manual');
INSERT INTO review_permissions(business_id,contact_id,destination,granted_at,actor_id,evidence,revoked_at) VALUES
 ('10000000-0000-4000-a099-000000000001','20000000-0000-4000-a099-000000000003','+15745550193','2026-01-01T12:00:00Z','00000000-0000-4000-a099-000000000001','Signed SMS permission from completed service',NULL),
 ('10000000-0000-4000-a099-000000000001','20000000-0000-4000-a099-000000000004','+15745550194',now(),'00000000-0000-4000-a099-000000000001','Revoked SMS permission',now());
CREATE FUNCTION pg_temp.confirm_permission_sms(n integer) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE p uuid:=('50000000-0000-4000-a099-'||lpad(n::text,12,'0'))::uuid;
 e uuid:=('30000000-0000-4000-a099-'||lpad(n::text,12,'0'))::uuid;
 c uuid:=('20000000-0000-4000-a099-'||lpad(n::text,12,'0'))::uuid;
 d uuid:=('40000000-0000-4000-a099-'||lpad(n::text,12,'0'))::uuid;
 phone text:='+1574555019'||n::text;
BEGIN
 INSERT INTO review_campaign_previews(id,business_id,owner_id,settings_revision,snapshot)
 SELECT p,s.business_id,s.owner_id,s.revision,jsonb_build_object('channel','sms','subject','Review','body','Honest review','reminderEnabled',false,'scheduledAt',now(),'googleReviewUrl','https://g.page/r/review/review','smsSender','+15745550190','smsMessagingProfileId','profile-099','summary','{}'::jsonb,'recipients',jsonb_build_array(jsonb_build_object('contactId',c,'enrollmentId',e,'phone',phone,'identities',jsonb_build_array('phone:'||phone),'timezone','America/New_York','scheduledAt',now()))) FROM review_settings s;
 RETURN review_confirm_sms_campaign(p,'10000000-0000-4000-a099-000000000001','00000000-0000-4000-a099-000000000001',jsonb_build_array(jsonb_build_object('id',d,'enrollmentId',e,'body','Honest review')));
END $$;
SELECT lives_ok($$SELECT pg_temp.confirm_permission_sms(3)$$,'SMS campaign can use existing valid customer permission');
SELECT is((SELECT evidence FROM review_permissions WHERE destination='+15745550193'),'Signed SMS permission from completed service','SMS campaign preserves original permission evidence');
SELECT is((SELECT granted_at FROM review_permissions WHERE destination='+15745550193'),'2026-01-01T12:00:00Z'::timestamptz,'SMS campaign preserves original grant time');
SELECT is(review_preview_blocks('10000000-0000-4000-a099-000000000001','[{"contactId":"20000000-0000-4000-a099-000000000004","destination":"+15745550194","identities":["phone:+15745550194"]}]')->0->>'reason','permission_revoked','preview excludes revoked SMS permission');
SELECT throws_ok($$SELECT pg_temp.confirm_permission_sms(4)$$,'22023','review_audience_changed:permission_revoked','SMS confirmation cannot revive revoked permission');
SELECT is((SELECT count(*)::integer FROM review_sms_outbox WHERE destination='+15745550194'),0,'revoked SMS audience never reaches the outbox');
-- Waiting accepted receipts cannot starve a later actionable receipt.
INSERT INTO billing_usage_periods(id,business_id,period_start,period_end,plan,included_sms_parts)
 VALUES('80000000-0000-4000-a099-000000000001','10000000-0000-4000-a099-000000000001',date_trunc('month',now()),date_trunc('month',now())+interval '1 month','full',1000);
INSERT INTO review_enrollments(id,business_id,campaign_id,contact_id,original_contact_id,identities,destination,channel,google_review_url,timezone)
 SELECT ('30000000-0000-4000-a099-'||lpad(n::text,12,'0'))::uuid,'10000000-0000-4000-a099-000000000001','50000000-0000-4000-a099-000000000001','20000000-0000-4000-a099-000000000003','20000000-0000-4000-a099-000000000003',ARRAY['phone:+15745550193'],'+15745550193','sms','https://g.page/r/review/review','America/New_York' FROM generate_series(100,200) n;
INSERT INTO review_sms_outbox(id,business_id,owner_id,enrollment_id,kind,destination,sender,messaging_profile_id,body,status,scheduled_at,next_attempt_at,expires_at,first_attempt_at,created_at)
 SELECT ('40000000-0000-4000-a099-'||lpad(n::text,12,'0'))::uuid,'10000000-0000-4000-a099-000000000001','00000000-0000-4000-a099-000000000001',('30000000-0000-4000-a099-'||lpad(n::text,12,'0'))::uuid,'initial','+15745550193','+15745550190','profile-099','Honest review',CASE WHEN n=200 THEN 'unknown' ELSE 'accepted' END,now(),now(),now()+interval '24 hours',now(),now()-interval '1 day'+n*interval '1 second' FROM generate_series(100,200) n;
INSERT INTO tenant_sms_sends(business_id,usage_period_id,idempotency_key,fingerprint,purpose,messaging_profile_id,sender,destination,sms_parts,status,provider_message_id,delivery_status,review_enrollment_id)
 SELECT '10000000-0000-4000-a099-000000000001','80000000-0000-4000-a099-000000000001','review-sms/v1/40000000-0000-4000-a099-'||lpad(n::text,12,'0'),'fixture-'||n,'review_invitation','profile-099','+15745550190','+15745550193',1,'accepted','fixture-provider-'||n,CASE WHEN n=200 THEN 'delivered' ELSE 'queued' END,('30000000-0000-4000-a099-'||lpad(n::text,12,'0'))::uuid FROM generate_series(100,200) n;
SELECT is(review_reconcile_sms_receipts(),1,'100 queued accepted receipts do not starve a later settled receipt');
SELECT is((SELECT status FROM review_sms_outbox WHERE id='40000000-0000-4000-a099-000000000200'),'delivered','late verified acceptance and delivery reconcile without another provider send');
SELECT is(review_reconcile_sms_receipts(),0,'repeated reconciliation does not reprocess nonactionable or completed receipts');
SELECT * FROM finish();ROLLBACK;
