BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT no_plan();
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
 ('00000000-0000-4000-a096-000000000001','owner-review@example.test',now()),
 ('00000000-0000-4000-a096-000000000002','unverified-review@example.test',NULL);
INSERT INTO businesses(id,owner_id,name,business_type,slug,billing_mode,partner_plan) VALUES
 ('10000000-0000-4000-a096-000000000001','00000000-0000-4000-a096-000000000001','Review Business','general','review-096-1','comped','chat_only'),
 ('10000000-0000-4000-a096-000000000002','00000000-0000-4000-a096-000000000002','Other Business','general','review-096-2','comped','full');
INSERT INTO contacts(id,business_id,name,email,phone_number,source_channel)
 SELECT ('20000000-0000-4000-a096-'||lpad(n::text,12,'0'))::uuid,'10000000-0000-4000-a096-000000000001','Customer '||n,'review'||n||'@example.test','+15745550'||lpad(n::text,3,'0'),'manual' FROM generate_series(1,12)n;
SELECT ok(NOT (SELECT enabled OR sending_enabled FROM review_email_control),'review rollout and sending start disabled');
SELECT ok(NOT has_table_privilege('authenticated','review_email_outbox','SELECT'),'outbox recipient snapshots are service-only');
SELECT ok(NOT has_function_privilege('anon','review_begin_email(uuid,uuid)','EXECUTE'),'anonymous callers cannot admit deliveries');
SELECT throws_ok($$SELECT review_initialize_settings('10000000-0000-4000-a096-000000000001','00000000-0000-4000-a096-000000000002')$$,'42501','review_workspace_denied','cross-tenant owner denied');
SELECT throws_ok($$SELECT review_initialize_settings('10000000-0000-4000-a096-000000000002','00000000-0000-4000-a096-000000000002')$$,'22023','verified_owner_email_required','unverified owner cannot bootstrap email');
SELECT is((review_initialize_settings('10000000-0000-4000-a096-000000000001','00000000-0000-4000-a096-000000000001')).reply_to,'owner-review@example.test','confirmed owner is initial Reply-To');
SELECT is((SELECT allowance FROM review_business_billing('10000000-0000-4000-a096-000000000001')),500,'Chat Only includes500review emails');
-- Make local noon independently of wall-clock test execution.
UPDATE review_settings SET google_review_url='https://g.page/r/review-test/review',postal_address='123 Main Street',timezone='Etc/GMT'||CASE WHEN extract(hour FROM now() AT TIME ZONE 'UTC')::integer-12>=0 THEN '+' ELSE '-' END||abs(extract(hour FROM now() AT TIME ZONE 'UTC')::integer-12)::text;
UPDATE review_email_control SET enabled=true,sending_enabled=true,pilot_business_ids=ARRAY['10000000-0000-4000-a096-000000000001'::uuid];
CREATE FUNCTION pg_temp.review_queue(n integer,remind boolean DEFAULT false) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_preview uuid:=('50000000-0000-4000-a096-'||lpad(n::text,12,'0'))::uuid;
 v_enrollment uuid:=('30000000-0000-4000-a096-'||lpad(n::text,12,'0'))::uuid;
 v_delivery uuid:=('40000000-0000-4000-a096-'||lpad(n::text,12,'0'))::uuid;
 v_contact uuid:=('20000000-0000-4000-a096-'||lpad(n::text,12,'0'))::uuid;
 v_email text:='review'||n||'@example.test'; v_payload jsonb;
BEGIN
 v_payload:=jsonb_build_object('from','SimplAssist <reviews@example.test>','to',jsonb_build_array(v_email),'replyTo','owner-review@example.test','subject','Honest review','text','Share an honest review');
 INSERT INTO review_campaign_previews(id,business_id,owner_id,settings_revision,snapshot)
 SELECT v_preview,s.business_id,s.owner_id,s.revision,jsonb_build_object('subject','Honest review','body','Share an honest review','reminderEnabled',remind,'scheduledAt',now(),'googleReviewUrl',s.google_review_url,'recipients',jsonb_build_array(jsonb_build_object('contactId',v_contact,'enrollmentId',v_enrollment,'email',v_email,'identities',jsonb_build_array('email:'||v_email),'timezone',s.timezone,'scheduledAt',now()))) FROM review_settings s;
 PERFORM review_confirm_campaign(v_preview,'10000000-0000-4000-a096-000000000001','00000000-0000-4000-a096-000000000001',jsonb_build_array(jsonb_build_object('id',v_delivery,'enrollmentId',v_enrollment,'payload',v_payload,'reminderPayload',v_payload)));
 RETURN v_delivery;
END $$;
CREATE FUNCTION pg_temp.review_begin(n integer) RETURNS public.review_email_outbox LANGUAGE plpgsql AS $$
DECLARE v_id uuid:=('40000000-0000-4000-a096-'||lpad(n::text,12,'0'))::uuid;v_claim uuid:=gen_random_uuid(); result review_email_outbox;
BEGIN
 UPDATE review_email_control SET next_send_at=now()-interval '1 second';
 UPDATE review_email_outbox SET status='claimed',claim_token=v_claim,lease_until=now()+interval '2 minutes' WHERE id=v_id;
 SELECT * INTO result FROM review_begin_email(v_id,v_claim); RETURN result;
END $$;
INSERT INTO review_permissions(business_id,contact_id,destination,granted_at,actor_id,evidence)
 VALUES('10000000-0000-4000-a096-000000000001','20000000-0000-4000-a096-000000000001','review1@example.test','2026-01-01T12:00:00Z','00000000-0000-4000-a096-000000000002','Customer signed the service agreement email permission clause');
SELECT pg_temp.review_queue(1,true);
SELECT is((SELECT evidence FROM review_permissions WHERE destination='review1@example.test'),'Customer signed the service agreement email permission clause','campaign confirmation preserves durable permission evidence');
SELECT is((SELECT granted_at FROM review_permissions WHERE destination='review1@example.test'),'2026-01-01T12:00:00Z'::timestamptz,'campaign confirmation preserves original grant time');
SELECT is((SELECT actor_id FROM review_permissions WHERE destination='review1@example.test'),'00000000-0000-4000-a096-000000000002'::uuid,'campaign confirmation preserves original permission actor');
SELECT is((SELECT count(*)::integer FROM review_email_outbox),1,'confirmation only queues the initial request');
SELECT is((pg_temp.review_begin(1)).status,'submitting','final admission reserves and submits');
SELECT is((SELECT used FROM review_email_usage),1,'first submission atomically reserves one email');
SELECT review_finish_email('40000000-0000-4000-a096-000000000001',(SELECT claim_token FROM review_email_outbox WHERE id='40000000-0000-4000-a096-000000000001'),'accepted','email-096-1',NULL);
SELECT is((SELECT count(*)::integer FROM review_email_outbox WHERE kind='reminder'),1,'acceptance schedules exactly one reminder');
SELECT ok((SELECT scheduled_at>=now()+interval '4 days' FROM review_email_outbox WHERE kind='reminder'),'reminder starts four days after acceptance');
SELECT is(review_recipient_block('10000000-0000-4000-a096-000000000001','20000000-0000-4000-a096-000000000001','review1@example.test',ARRAY['email:review1@example.test']),'cooldown','accepted review enforces90day cooldown');
SELECT review_unsubscribe('30000000-0000-4000-a096-000000000001');
SELECT is((SELECT status FROM review_email_outbox WHERE kind='reminder'),'cancelled','unsubscribe cancels reminder');
SELECT is(review_recipient_block('10000000-0000-4000-a096-000000000001','20000000-0000-4000-a096-000000000001','review1@example.test',ARRAY['email:review1@example.test']),'suppressed','unsubscribe persists stronger than campaign attestation');
SELECT pg_temp.review_queue(2);
SELECT pg_temp.review_begin(2);
SELECT review_finish_email('40000000-0000-4000-a096-000000000002',(SELECT claim_token FROM review_email_outbox WHERE id='40000000-0000-4000-a096-000000000002'),'ambiguous',NULL,'timeout');
SELECT is((SELECT status FROM review_email_outbox WHERE id='40000000-0000-4000-a096-000000000002'),'pending','ambiguous send remains retryable inside the key window');
SELECT is((SELECT used FROM review_email_usage),2,'ambiguous send keeps quota reserved');
SELECT is((pg_temp.review_begin(2)).idempotency_key,'review-email/v1/40000000-0000-4000-a096-000000000002','retry uses same frozen key');
SELECT is((SELECT used FROM review_email_usage),2,'retry does not reserve quota again');
UPDATE review_email_outbox SET first_attempt_at=now()-interval '23 hours' WHERE id='40000000-0000-4000-a096-000000000002';
SELECT ok((pg_temp.review_begin(2)).id IS NULL,'expired idempotency window cannot call provider');
SELECT is((SELECT status FROM review_email_outbox WHERE id='40000000-0000-4000-a096-000000000002'),'unknown','expired ambiguous attempt needs reconciliation');
-- A callback arriving before the submit response recovers the provider id and
-- creates one reminder. A later sent event cannot undo bounce/complaint.
SELECT pg_temp.review_queue(3,true);
SELECT pg_temp.review_begin(3);
INSERT INTO review_email_provider_events(event_id,provider_message_id,event_type,occurred_at,received_at)
 SELECT 'unrelated-096-'||n,'unrelated-provider-'||n,'email.sent',now(),now()-interval '1 minute' FROM generate_series(1,101)n;
INSERT INTO review_email_provider_events(event_id,provider_message_id,delivery_id,event_type,occurred_at) VALUES('event-096-3','email-096-3','40000000-0000-4000-a096-000000000003','email.delivered',now());
SELECT review_apply_email_events();
SELECT is((SELECT status FROM review_email_outbox WHERE id='40000000-0000-4000-a096-000000000003'),'delivered','early callback reconciles submitting delivery');
SELECT is((SELECT count(*)::integer FROM review_email_provider_events WHERE event_id LIKE 'unrelated-096-%' AND applied_at IS NULL),101,'unmatched early/shared-account events remain recoverable without starving valid callbacks');
SELECT is((SELECT count(*)::integer FROM review_email_outbox WHERE enrollment_id='30000000-0000-4000-a096-000000000003' AND kind='reminder'),1,'early callback still creates only one reminder');
INSERT INTO review_email_provider_events(event_id,provider_message_id,event_type,occurred_at) VALUES('event-096-4','email-096-3','email.complained',now()),('event-096-5','email-096-3','email.sent',now()-interval '1 minute');
UPDATE review_email_control SET sending_enabled=false;
SELECT review_apply_email_events();
SELECT is((SELECT status FROM review_email_outbox WHERE id='40000000-0000-4000-a096-000000000003'),'failed','out of order sent event cannot regress complaint');
SELECT ok(EXISTS(SELECT 1 FROM review_suppressions WHERE identity='email:review3@example.test'),'late complaints suppress even when sends are killed');
SELECT is((SELECT count(*)::integer FROM review_claim_emails()),0,'sending kill switch prevents new claims');
UPDATE review_email_control SET sending_enabled=true;
SELECT pg_temp.review_queue(4);
UPDATE review_email_outbox SET expires_at=now()-interval '1 second' WHERE id='40000000-0000-4000-a096-000000000004';
SELECT ok((pg_temp.review_begin(4)).id IS NULL,'stale initial send cannot submit');
SELECT is((SELECT status FROM review_email_outbox WHERE id='40000000-0000-4000-a096-000000000004'),'needs_reschedule','stale initial request requires explicit rescheduling');
SELECT pg_temp.review_queue(5);
UPDATE review_email_usage SET used=500;
SELECT ok((pg_temp.review_begin(5)).id IS NULL,'allowance exhaustion blocks before provider');
SELECT is((SELECT last_error FROM review_email_outbox WHERE id='40000000-0000-4000-a096-000000000005'),'email_allowance_reached','quota reason retained');
UPDATE review_email_usage SET used=3;
SELECT pg_temp.review_queue(6);
INSERT INTO subscriptions(business_id,stripe_customer_id,stripe_subscription_id,plan,status) VALUES('10000000-0000-4000-a096-000000000001','cus_review_096','sub_review_096','chat_only','past_due');
SELECT ok(NOT (SELECT allowed FROM review_business_billing('10000000-0000-4000-a096-000000000001')),'subscription past_due beats partner comp and pauses reviews');
SELECT ok((pg_temp.review_begin(6)).id IS NULL,'payment failure blocks pending delivery');
DELETE FROM subscriptions WHERE business_id='10000000-0000-4000-a096-000000000001';
SELECT pg_temp.review_queue(8);
SELECT pg_temp.review_begin(8);
SELECT review_finish_email('40000000-0000-4000-a096-000000000008',(SELECT claim_token FROM review_email_outbox WHERE id='40000000-0000-4000-a096-000000000008'),'deferred',NULL,'rate_limit_exceeded');
SELECT ok((SELECT status='pending' AND first_attempt_at IS NULL AND NOT quota_reserved FROM review_email_outbox WHERE id='40000000-0000-4000-a096-000000000008'),'definite provider capacity denial safely pauses without quota or retry-window poisoning');
SELECT is((SELECT status FROM review_enrollments WHERE id='30000000-0000-4000-a096-000000000008'),'active','provider capacity failure does not stop customer enrollment');
SELECT pg_temp.review_queue(9);
SELECT pg_temp.review_begin(9);
SELECT review_finish_email('40000000-0000-4000-a096-000000000009',(SELECT claim_token FROM review_email_outbox WHERE id='40000000-0000-4000-a096-000000000009'),'ambiguous',NULL,'timeout');
SELECT pg_temp.review_begin(9);
SELECT review_finish_email('40000000-0000-4000-a096-000000000009',(SELECT claim_token FROM review_email_outbox WHERE id='40000000-0000-4000-a096-000000000009'),'deferred',NULL,'rate_limit_exceeded');
SELECT ok((SELECT first_attempt_at IS NOT NULL AND ambiguous_since IS NOT NULL AND quota_reserved FROM review_email_outbox WHERE id='40000000-0000-4000-a096-000000000009'),'later capacity response cannot erase earlier ambiguous acceptance or reset23hour window');
SELECT throws_ok($$SELECT review_queue_owner_email('10000000-0000-4000-a096-000000000001','00000000-0000-4000-a096-000000000001',gen_random_uuid(),'test','customer@example.test','{}')$$,'22023','verified_owner_email_required','test email cannot target arbitrary recipients');
SELECT review_queue_owner_email('10000000-0000-4000-a096-000000000001','00000000-0000-4000-a096-000000000001','60000000-0000-4000-a096-000000000001','verification','new@example.test','{}');
SELECT is((SELECT reply_to FROM review_settings),'owner-review@example.test','pending verification preserves verified Reply-To');
SELECT ok(review_confirm_reply_to('60000000-0000-4000-a096-000000000001'),'pending address confirmation consumes action once');
SELECT ok(NOT review_confirm_reply_to('60000000-0000-4000-a096-000000000001'),'confirmation token is single use');
SELECT is((SELECT reply_to FROM review_settings),'new@example.test','confirmed address becomes Reply-To');
INSERT INTO review_permissions(business_id,contact_id,destination,granted_at,actor_id,evidence,revoked_at)
 VALUES('10000000-0000-4000-a096-000000000001','20000000-0000-4000-a096-000000000010','review10@example.test',now(),'00000000-0000-4000-a096-000000000001','Revoked by customer',now());
SELECT is(review_preview_blocks('10000000-0000-4000-a096-000000000001','[{"contactId":"20000000-0000-4000-a096-000000000010","destination":"review10@example.test","identities":["email:review10@example.test"]}]')->0->>'reason','permission_revoked','preview excludes revoked email permission');
SELECT throws_ok($$SELECT pg_temp.review_queue(10)$$,'22023','review_audience_changed:permission_revoked','campaign confirmation cannot replace revoked email permission with a fresh attestation');
SELECT is((SELECT count(*)::integer FROM review_email_outbox WHERE destination='review10@example.test'),0,'revoked email audience never reaches the outbox');
SELECT pg_temp.review_queue(7);
DELETE FROM contacts WHERE id='20000000-0000-4000-a096-000000000007';
SELECT ok((pg_temp.review_begin(7)).id IS NULL,'deleted customer cannot receive pending review');
UPDATE businesses SET owner_id=NULL WHERE id='10000000-0000-4000-a096-000000000001';
SELECT is((SELECT count(*)::integer FROM review_email_outbox),0,'business tombstone erases recipient snapshots and queued mail');
SELECT is((SELECT count(*)::integer FROM review_suppressions),0,'business tombstone erases suppression PII');
SELECT * FROM finish();
ROLLBACK;
