BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT no_plan();

SELECT ok(NOT has_table_privilege('anon', 'public.account_signup_alerts', 'SELECT'), 'anonymous visitors cannot read alerts');
SELECT ok(NOT has_table_privilege('authenticated', 'public.account_signup_alerts', 'SELECT'), 'customers cannot read alerts');
SELECT ok(NOT has_table_privilege('authenticated', 'public.account_signup_alerts', 'INSERT,UPDATE,DELETE'), 'customers cannot mutate alerts');
SELECT ok(NOT has_schema_privilege('authenticated', 'account_alerts_private', 'USAGE'), 'auth data helpers are unexposed');
SELECT ok(NOT has_function_privilege('authenticated', 'public.reconcile_account_signup_alerts()', 'EXECUTE'), 'customers cannot discover signup data');
SELECT ok(NOT has_function_privilege('anon', 'public.claim_account_signup_alert(uuid)', 'EXECUTE'), 'visitors cannot claim delivery');
SELECT ok(has_function_privilege('service_role', 'public.claim_account_signup_alert(uuid)', 'EXECUTE'), 'worker can claim delivery');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.account_signup_alerts'::regclass), 'outbox RLS enabled');

-- All rows are disposable; rollback leaves the database unchanged.
INSERT INTO auth.users(id, email, created_at, email_confirmed_at, raw_user_meta_data)
SELECT ('00000000-0000-4000-a123-' || lpad(n::text, 12, '0'))::uuid,
  'account-alert-' || n || '@example.test', now(), CASE WHEN n = 1 THEN NULL ELSE now() END,
  '{"full_name":"Test Customer"}'::jsonb
FROM generate_series(1, 7) n;
INSERT INTO auth.users(id, email, created_at, email_confirmed_at) VALUES
  ('00000000-0000-4000-a123-000000000008', 'old-alert@example.test', now() - interval '2 days', now());
INSERT INTO auth.users(id, email, created_at, email_confirmed_at, is_anonymous) VALUES
  ('00000000-0000-4000-a123-000000000009', 'anonymous-alert@example.test', now(), now(), true);
INSERT INTO auth.users(id, email, created_at, email_confirmed_at, raw_app_meta_data) VALUES
  ('00000000-0000-4000-a123-000000000010', 'concierge-alert@example.test', now(), now(), '{"concierge_provisioning_id":"fixture"}');
SELECT is((SELECT count(*)::integer FROM account_signup_alerts), 6, 'only confirmed new self-service signups are captured');
SELECT is((SELECT count(*)::integer FROM account_signup_alerts WHERE owner_id = '00000000-0000-4000-a123-000000000001'), 0, 'unverified form submission sends nothing');
ALTER TABLE account_signup_alerts ADD CONSTRAINT fixture_unavailable_outbox CHECK (false) NOT VALID;
SELECT lives_ok($$UPDATE auth.users SET email_confirmed_at = now() WHERE id = '00000000-0000-4000-a123-000000000001'$$, 'outbox failure cannot break email verification');
SELECT is((SELECT count(*)::integer FROM account_signup_alerts WHERE owner_id = '00000000-0000-4000-a123-000000000001'), 0, 'failed optional capture leaves no partial alert');
ALTER TABLE account_signup_alerts DROP CONSTRAINT fixture_unavailable_outbox;
SELECT is(reconcile_account_signup_alerts(), 1, 'background sweep repairs failed verification capture');
SELECT is((SELECT count(*)::integer FROM account_signup_alerts WHERE owner_id = '00000000-0000-4000-a123-000000000001'), 1, 'verification captures the first milestone');
SELECT is((SELECT payload->>'plan' FROM account_signup_alerts WHERE owner_id = '00000000-0000-4000-a123-000000000001'), NULL::text, 'early signup has no invented tier');
UPDATE auth.users SET email_confirmed_at = now(), last_sign_in_at = now() WHERE id = '00000000-0000-4000-a123-000000000001';
SELECT is(reconcile_account_signup_alerts(), 0, 'repeated confirmation and sweep do not duplicate alerts');

UPDATE businesses SET onboarding_selected_plan = 'chat_only', onboarding_completed_at = now()
  WHERE owner_id = '00000000-0000-4000-a123-000000000002';
SELECT is((SELECT count(*)::integer FROM account_signup_alerts WHERE milestone = 'setup'), 0, 'completion marker without payment does not alert');
INSERT INTO subscriptions(business_id, stripe_customer_id, stripe_subscription_id, plan, status)
SELECT id, 'cus_alert_' || right(owner_id::text, 1), 'sub_alert_' || right(owner_id::text, 1),
  CASE right(owner_id::text, 1) WHEN '2' THEN 'chat_only' WHEN '3' THEN 'sms_only' WHEN '4' THEN 'sms_and_chat' WHEN '5' THEN 'full' ELSE 'sms_only' END,
  CASE WHEN right(owner_id::text, 1) = '6' THEN 'past_due' ELSE 'active' END
FROM businesses WHERE owner_id BETWEEN '00000000-0000-4000-a123-000000000002' AND '00000000-0000-4000-a123-000000000006';
SELECT is((SELECT payload->>'kind' FROM account_signup_alerts WHERE owner_id = '00000000-0000-4000-a123-000000000002' AND milestone = 'setup'), 'chat_ready', 'paid Chat Only readiness captured even if payment arrives last');
SELECT is((SELECT count(*)::integer FROM account_signup_alerts WHERE milestone = 'setup'), 1, 'paid texting before submission does not alert');
UPDATE businesses SET telnyx_brand_id = 'B' || right(owner_id::text, 6), brand_status = 'pending',
  onboarding_registration_status = 'submitted', onboarding_registration_submitted_at = now()
WHERE owner_id BETWEEN '00000000-0000-4000-a123-000000000003' AND '00000000-0000-4000-a123-000000000006';
SELECT is((SELECT count(*)::integer FROM account_signup_alerts WHERE milestone = 'setup'), 4, 'all three paid texting tiers notify before carrier approval');
SELECT is((SELECT count(*)::integer FROM account_signup_alerts WHERE owner_id = '00000000-0000-4000-a123-000000000006' AND milestone = 'setup'), 0, 'nonactive subscription excluded');
SELECT is((SELECT count(*)::integer FROM account_signup_alerts WHERE payload->>'kind' = 'texting_submitted'), 3, 'texting milestone differs from Chat Only readiness');
UPDATE businesses SET onboarding_registration_submitted_at = now() + interval '1 minute'
WHERE owner_id BETWEEN '00000000-0000-4000-a123-000000000003' AND '00000000-0000-4000-a123-000000000005';
SELECT is((SELECT count(*)::integer FROM account_signup_alerts WHERE milestone = 'setup'), 4, 'carrier resubmission never duplicates setup alert');

-- A recorded milestone remains available even if the carrier later rejects it.
UPDATE businesses SET onboarding_registration_status = 'failed', onboarding_registration_submitted_at = NULL
WHERE owner_id = '00000000-0000-4000-a123-000000000003';
SELECT is((SELECT count(*)::integer FROM account_signup_alerts WHERE owner_id = '00000000-0000-4000-a123-000000000003' AND milestone = 'setup'), 1, 'later rejection does not erase original milestone');

DELETE FROM account_signup_alerts WHERE owner_id = '00000000-0000-4000-a123-000000000001';
SET LOCAL ROLE service_role;
SELECT is(reconcile_account_signup_alerts(), 1, 'worker repairs a missed capture using stored facts');
RESET ROLE;

-- Isolate delivery fixtures from the other milestone cases.
UPDATE account_signup_alerts SET status = 'sent';
UPDATE account_signup_alerts SET status = 'pending' WHERE owner_id = '00000000-0000-4000-a123-000000000002';
CREATE TEMP TABLE first_claim AS SELECT * FROM claim_account_signup_alert('20000000-0000-4000-a123-000000000001');
SELECT is((SELECT milestone FROM first_claim), 'verified_signup', 'signup is delivered before setup');
SELECT is((SELECT count(*)::integer FROM claim_account_signup_alert('20000000-0000-4000-a123-000000000002')), 0, 'inflight signup cannot be claimed twice or overtaken by setup');
UPDATE account_signup_alerts SET status = 'sent', claim_token = NULL, claimed_until = NULL WHERE id = (SELECT id FROM first_claim);
SELECT is((SELECT milestone FROM claim_account_signup_alert('20000000-0000-4000-a123-000000000002')), 'setup', 'setup becomes eligible after signup acceptance');
UPDATE account_signup_alerts SET claimed_until = now() - interval '1 second', message = '{"frozen":"original"}' WHERE status = 'sending';
CREATE TEMP TABLE recovered AS SELECT * FROM claim_account_signup_alert('20000000-0000-4000-a123-000000000003');
SELECT is((SELECT attempt_count FROM recovered), 2, 'expired worker lease is recovered');
SELECT is((SELECT message->>'frozen' FROM recovered), 'original', 'worker recovery preserves exact provider content');
UPDATE account_signup_alerts SET claimed_until = now() - interval '1 second', first_attempt_at = now() - interval '24 hours' WHERE status = 'sending';
SELECT is((SELECT count(*)::integer FROM claim_account_signup_alert('20000000-0000-4000-a123-000000000004')), 0, 'old ambiguous delivery is not retried beyond provider dedupe window');
SELECT is((SELECT status FROM account_signup_alerts WHERE id = (SELECT id FROM recovered)), 'needs_review', 'expired ambiguous outcome remains visible for review');

UPDATE account_signup_alerts SET status = 'pending' WHERE owner_id = '00000000-0000-4000-a123-000000000007';
UPDATE businesses SET deleted_at = now(), deletion_scheduled_for = now() + interval '60 days' WHERE owner_id = '00000000-0000-4000-a123-000000000007';
SELECT is((SELECT count(*)::integer FROM claim_account_signup_alert('20000000-0000-4000-a123-000000000005')), 0, 'deleted account is suppressed');
SELECT is((SELECT status FROM account_signup_alerts WHERE owner_id = '00000000-0000-4000-a123-000000000007'), 'canceled', 'deleted account delivery is canceled');
SELECT is((SELECT payload FROM account_signup_alerts WHERE owner_id = '00000000-0000-4000-a123-000000000007'), '{}'::jsonb, 'cancellation scrubs queued customer details');
DELETE FROM auth.users WHERE id = '00000000-0000-4000-a123-000000000001';
SELECT is((SELECT count(*)::integer FROM account_signup_alerts WHERE owner_id = '00000000-0000-4000-a123-000000000001'), 0, 'permanent deletion cascades alert data');
SELECT * FROM finish();
ROLLBACK;
