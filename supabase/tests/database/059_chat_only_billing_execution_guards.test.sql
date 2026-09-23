BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SET LOCAL search_path = public, extensions;

SELECT plan(98);

-- ---------------------------------------------------------------------------
-- Catalog, locking, and authority boundaries
-- ---------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.subscriptions'::regclass
      AND constraint_row.conname = 'subscriptions_chat_only_has_no_setup_fee'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
  ),
  'Chat Only no-setup-fee constraint exists and is validated'
);

SELECT has_table(
  'public',
  'business_plan_family_locks',
  'durable business plan-family lock table exists'
);

SELECT ok(
  (
    SELECT table_row.relrowsecurity
    FROM pg_class AS table_row
    WHERE table_row.oid = 'public.business_plan_family_locks'::regclass
  )
  AND EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.business_plan_family_locks'::regclass
      AND constraint_row.contype = 'p'
  ),
  'family locks use a business primary key and RLS'
);

SELECT ok(
  has_table_privilege(
    'service_role',
    'public.business_plan_family_locks',
    'SELECT,INSERT,UPDATE'
  )
  AND NOT has_table_privilege(
    'authenticated',
    'public.business_plan_family_locks',
    'SELECT'
  )
  AND NOT has_table_privilege(
    'anon',
    'public.business_plan_family_locks',
    'SELECT'
  ),
  'durable family locks are service-owned'
);

SELECT has_function(
  'public',
  'infer_business_plan_family',
  ARRAY['uuid'],
  'family inference RPC exists'
);

SELECT has_function(
  'public',
  'claim_business_plan_family',
  ARRAY['uuid', 'text', 'text'],
  'atomic family claim RPC exists'
);

SELECT has_function(
  'public',
  'claim_direct_checkout_plan',
  ARRAY['uuid', 'text', 'boolean'],
  'atomic exact-plan Checkout claim RPC exists'
);

SELECT has_function(
  'public',
  'save_direct_onboarding_plan_intent',
  ARRAY['uuid', 'uuid', 'text', 'text'],
  'atomic direct onboarding intent RPC exists'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.claim_direct_checkout_plan(uuid,text,boolean)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.claim_direct_checkout_plan(uuid,text,boolean)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'anon',
    'public.claim_direct_checkout_plan(uuid,text,boolean)',
    'EXECUTE'
  )
  AND pg_get_functiondef(
    'public.claim_direct_checkout_plan(uuid,text,boolean)'::regprocedure
  ) LIKE ALL (ARRAY[
    '%FOR UPDATE%',
    '%business.onboarding_selected_plan IS DISTINCT FROM p_plan%',
    '%public.subscriptions%',
    '%claim_business_plan_family%'
  ]),
  'exact Checkout claim is service-only and checks current plan intent under the family lock'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.infer_business_plan_family(uuid)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'service_role',
    'public.claim_business_plan_family(uuid,text,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.infer_business_plan_family(uuid)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.claim_business_plan_family(uuid,text,text)',
    'EXECUTE'
  )
  -- 091 keeps the original evidence checks in a private delegate, with a
  -- narrowly verified paid-conversion wrapper. Inspect the evidence body in
  -- either schema version rather than requiring its old physical name.
  AND pg_get_functiondef(COALESCE(
    to_regprocedure('public.infer_business_plan_family_before_chat_upgrade(uuid)'),
    'public.infer_business_plan_family(uuid)'::regprocedure
  )) LIKE ALL (ARRAY[
    '%subscription.pending_plan%',
    '%partner_client_provisioning_jobs%',
    '%telnyx_voice_application_id%',
    '%business_plan_family_evidence_conflict%'
  ])
  AND pg_get_functiondef(
    'public.claim_business_plan_family(uuid,text,text)'::regprocedure
  ) LIKE ALL (ARRAY[
    '%FOR UPDATE%',
    '%infer_business_plan_family%',
    '%plan_family_transition_not_supported%',
    '%SET claimed_by = p_claimed_by%'
  ]),
  'family inference and claims are service-only'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.save_direct_onboarding_plan_intent(uuid,uuid,text,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.save_direct_onboarding_plan_intent(uuid,uuid,text,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'anon',
    'public.save_direct_onboarding_plan_intent(uuid,uuid,text,text)',
    'EXECUTE'
  )
  AND pg_get_functiondef(
    'public.save_direct_onboarding_plan_intent(uuid,uuid,text,text)'
      ::regprocedure
  ) LIKE ALL (ARRAY[
    '%FOR UPDATE%',
    '%business.owner_id = p_owner_id%',
    '%business.onboarding_selected_plan IS DISTINCT FROM p_expected_plan%',
    '%public.subscriptions%',
    '%public.business_plan_family_locks%',
    '%plan_family_transition_not_supported%'
  ]),
  'direct intent compare-and-swap is service-only and serialized with billing authority'
);

SELECT has_function(
  'public',
  'guard_business_onboarding_plan_intent_family',
  ARRAY[]::text[],
  'direct owner intent family guard exists'
);

SELECT has_trigger(
  'public',
  'businesses',
  'guard_business_onboarding_plan_intent_family',
  'businesses apply the durable plan-family intent guard'
);

SELECT ok(
  (
    SELECT procedure.prosecdef
       AND procedure.proconfig = ARRAY['search_path=public, pg_temp']::text[]
    FROM pg_proc AS procedure
    WHERE procedure.oid =
      'public.guard_business_onboarding_plan_intent_family()'::regprocedure
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.guard_business_onboarding_plan_intent_family()',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'anon',
    'public.guard_business_onboarding_plan_intent_family()',
    'EXECUTE'
  ),
  'intent guard has fixed definer authority without a callable customer RPC'
);

SELECT ok(
  pg_get_functiondef(
    'public.sync_stripe_subscription_before_sms_operations(uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,timestamptz,boolean,timestamptz)'
      ::regprocedure
  ) LIKE ALL (ARRAY[
    '%business.billing_mode = ''stripe''%',
    '%FOR UPDATE%',
    '%chat_only_setup_fee_not_allowed%',
    '%plan_family_transition_not_supported%',
    '%business.partner_id IS NOT NULL%',
    '%business.partner_plan IS NOT NULL%',
    '%claim_business_plan_family%',
    '%ON CONFLICT (business_id) DO UPDATE%'
  ]),
  'Stripe sync retains its guarded upsert while serializing and rejecting unsupported family/fee writes'
);

SELECT ok(
  pg_get_functiondef(
    'public.assign_business_partner_billing(uuid,uuid,text,uuid,text)'
      ::regprocedure
  ) LIKE ALL (ARRAY[
    '%FOR UPDATE%',
    '%FOR SHARE NOWAIT%',
    '%subscription_exists%',
    '%claim_business_plan_family%'
  ]),
  'partner assignment retains its lock/conflict contract and adds the family guard'
);

SELECT has_function(
  'public',
  'finalize_chat_only_onboarding_if_paid',
  ARRAY['uuid', 'text', 'text'],
  'atomic Chat Only completion RPC exists'
);

SELECT ok(
  (
    SELECT NOT procedure.prosecdef
       AND procedure.provolatile = 'v'
       AND procedure.proconfig = ARRAY['search_path=public, pg_temp']::text[]
    FROM pg_proc AS procedure
    WHERE procedure.oid =
      'public.finalize_chat_only_onboarding_if_paid(uuid,text,text)'
        ::regprocedure
  )
  AND pg_get_functiondef(
    'public.finalize_chat_only_onboarding_if_paid(uuid,text,text)'
      ::regprocedure
  ) LIKE ALL (ARRAY[
    '%business.billing_mode = ''stripe''%',
    '%business.partner_id IS NULL%',
    '%business.partner_plan IS NULL%',
    '%business.primary_goal IS NOT NULL%',
    '%public.business_hours%',
    '%public.ai_settings%',
    '%public.normalize_ai_knowledge_key%',
    '%v_service_count < 3%',
    '%v_faq_count < 3%',
    '%subscription.plan = ''chat_only''%',
    '%subscription.status IN (''active'', ''trialing'')%',
    '%FOR UPDATE%'
  ]),
  'completion RPC is fixed-path and requires exact unpartnered direct paid authority under lock'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.finalize_chat_only_onboarding_if_paid(uuid,text,text)',
    'EXECUTE'
  ),
  'service role can execute Chat Only completion'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.finalize_chat_only_onboarding_if_paid(uuid,text,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'anon',
    'public.finalize_chat_only_onboarding_if_paid(uuid,text,text)',
    'EXECUTE'
  ),
  'customer roles cannot execute Chat Only completion'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.sync_stripe_subscription_if_business_active(uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,timestamptz,boolean,timestamptz)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.sync_stripe_subscription_if_business_active(uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,timestamptz,boolean,timestamptz)',
    'EXECUTE'
  ),
  'Stripe sync retains service-only execution'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.assign_business_partner_billing(uuid,uuid,text,uuid,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.assign_business_partner_billing(uuid,uuid,text,uuid,text)',
    'EXECUTE'
  ),
  'partner assignment retains service-only execution'
);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

INSERT INTO public.partners (
  id, name, slug, custom_domain, domain_status, status
) VALUES (
  '20000000-0000-4000-a059-000000000001',
  'Chat Billing Partner 059',
  'chat-billing-partner-a059',
  'chat-billing-a059.example.com',
  'connected',
  'active'
);

INSERT INTO auth.users (id, email)
VALUES (
  '00000000-0000-4000-a059-000000000001',
  'chat-billing-owner-a059@example.test'
);

UPDATE public.businesses
SET id = '10000000-0000-4000-a059-000000000003',
    name = 'Partner Billing 059',
    email = 'partner-billing-a059@example.test',
    slug = 'partner-billing-a059'
WHERE owner_id = '00000000-0000-4000-a059-000000000001';

INSERT INTO public.businesses (
  id, name, email, business_type, slug, created_at,
  onboarding_selected_plan
) VALUES
  (
    '10000000-0000-4000-a059-000000000001',
    'Direct Chat Billing 059',
    'direct-chat-billing-a059@example.test',
    'general',
    'direct-chat-billing-a059',
    '2059-01-01 00:00:00+00',
    'chat_only'
  ),
  (
    '10000000-0000-4000-a059-000000000002',
    'Direct SMS Billing 059',
    'direct-sms-billing-a059@example.test',
    'general',
    'direct-sms-billing-a059',
    '2059-01-02 00:00:00+00',
    'sms_and_chat'
  ),
  (
    '10000000-0000-4000-a059-000000000004',
    'Partner SMS Billing 059',
    'partner-sms-billing-a059@example.test',
    'general',
    'partner-sms-billing-a059',
    '2059-01-04 00:00:00+00',
    NULL
  ),
  (
    '10000000-0000-4000-a059-000000000005',
    'Retained Provider Billing 059',
    'retained-provider-a059@example.test',
    'general',
    'retained-provider-a059',
    '2059-01-05 00:00:00+00',
    NULL
  ),
  (
    '10000000-0000-4000-a059-000000000006',
    'Local SMS Form Billing 059',
    'local-sms-form-a059@example.test',
    'general',
    'local-sms-form-a059',
    '2059-01-06 00:00:00+00',
    'chat_only'
  ),
  (
    '10000000-0000-4000-a059-000000000007',
    'Partner Stripe Guard 059',
    'partner-stripe-guard-a059@example.test',
    'general',
    'partner-stripe-guard-a059',
    '2059-01-07 00:00:00+00',
    NULL
  ),
  (
    '10000000-0000-4000-a059-000000000008',
    'Provisioning History 059',
    'provisioning-history-a059@example.test',
    'general',
    'provisioning-history-a059',
    '2059-01-08 00:00:00+00',
    NULL
  ),
  (
    '10000000-0000-4000-a059-000000000009',
    'Pending Plan Conflict 059',
    'pending-plan-conflict-a059@example.test',
    'general',
    'pending-plan-conflict-a059',
    '2059-01-09 00:00:00+00',
    NULL
  ),
  (
    '10000000-0000-4000-a059-000000000010',
    'Family Evidence Drift 059',
    'family-evidence-drift-a059@example.test',
    'general',
    'family-evidence-drift-a059',
    '2059-01-10 00:00:00+00',
    NULL
  );

INSERT INTO public.businesses (
  id, owner_id, name, email, business_type, slug, created_at,
  onboarding_selected_plan
) VALUES (
  '10000000-0000-4000-a059-000000000011',
  '00000000-0000-4000-a059-000000000001',
  'Direct Intent CAS 059',
  'direct-intent-cas-a059@example.test',
  'general',
  'direct-intent-cas-a059',
  '2059-01-11 00:00:00+00',
  NULL
);

INSERT INTO public.businesses (
  id, owner_id, name, email, business_type, slug, created_at,
  onboarding_selected_plan, partner_id, billing_mode, partner_plan
) VALUES (
  '10000000-0000-4000-a059-000000000012',
  '00000000-0000-4000-a059-000000000001',
  'Partner Intent CAS 059',
  'partner-intent-cas-a059@example.test',
  'general',
  'partner-intent-cas-a059',
  '2059-01-12 00:00:00+00',
  NULL,
  '20000000-0000-4000-a059-000000000001',
  'invoiced',
  'chat_only'
);

INSERT INTO public.businesses (
  id, name, email, business_type, slug, created_at,
  onboarding_selected_plan, billing_exempt
) VALUES (
  '10000000-0000-4000-a059-000000000013',
  'Legacy Override Family 059',
  'legacy-override-family-a059@example.test',
  'general',
  'legacy-override-family-a059',
  '2059-01-13 00:00:00+00',
  'chat_only',
  true
);

INSERT INTO public.businesses (
  id, name, email, business_type, slug, created_at,
  partner_id, billing_mode, partner_plan, billing_comped
) VALUES (
  '10000000-0000-4000-a059-000000000014',
  'Partner Chat Comped Family 059',
  'partner-chat-comped-family-a059@example.test',
  'general',
  'partner-chat-comped-family-a059',
  '2059-01-14 00:00:00+00',
  '20000000-0000-4000-a059-000000000001',
  'comped',
  'chat_only',
  true
);

INSERT INTO public.businesses (
  id, name, email, business_type, slug, created_at,
  onboarding_selected_plan, billing_pilot
) VALUES (
  '10000000-0000-4000-a059-000000000015',
  'Chat Subscription Stale Override 059',
  'chat-subscription-stale-override-a059@example.test',
  'general',
  'chat-subscription-stale-override-a059',
  '2059-01-15 00:00:00+00',
  'chat_only',
  true
);

SET LOCAL ROLE service_role;

UPDATE public.businesses
SET telnyx_voice_application_id = 'voice-retained-a059'
WHERE id = '10000000-0000-4000-a059-000000000005';

UPDATE public.businesses
SET compliance_info_completed_at = now(),
    onboarding_registration_status = 'failed',
    brand_status = 'pending',
    campaign_status = 'pending',
    pending_phone_number = '+13175550106',
    pending_phone_number_area_code = '317',
    pending_phone_number_selected_at = now()
WHERE id = '10000000-0000-4000-a059-000000000006';

UPDATE public.businesses
SET partner_id = '20000000-0000-4000-a059-000000000001'
WHERE id = '10000000-0000-4000-a059-000000000007';

INSERT INTO public.partner_client_provisioning_jobs (
  id, email, requested_business_name, partner_id, billing_mode,
  partner_plan, business_id, created_by_admin_id
) VALUES (
  '50000000-0000-4000-a059-000000000008',
  'provisioning-history-job-a059@example.test',
  'Provisioning History 059',
  '20000000-0000-4000-a059-000000000001',
  'invoiced',
  'chat_only',
  '10000000-0000-4000-a059-000000000008',
  '90000000-0000-4000-a059-000000000008'
);

INSERT INTO public.subscriptions (
  id, business_id, stripe_customer_id, stripe_subscription_id,
  plan, pending_plan, status
) VALUES (
  '30000000-0000-4000-a059-000000000009',
  '10000000-0000-4000-a059-000000000009',
  'cus_pending_conflict_a059',
  'sub_pending_conflict_a059',
  'sms_only',
  'chat_only',
  'canceled'
);

INSERT INTO public.subscriptions (
  id, business_id, stripe_customer_id, stripe_subscription_id,
  plan, status
) VALUES (
  '30000000-0000-4000-a059-000000000015',
  '10000000-0000-4000-a059-000000000015',
  'cus_stale_override_a059',
  'sub_stale_override_a059',
  'chat_only',
  'active'
);

SELECT results_eq(
  $$
    SELECT public.infer_business_plan_family(
      '10000000-0000-4000-a059-000000000013'
    )
  $$,
  $$ VALUES ('sms'::text) $$,
  'a direct no-subscription legacy billing override is SMS-family evidence'
);

SELECT throws_ok(
  $$
    SELECT public.claim_direct_checkout_plan(
      '10000000-0000-4000-a059-000000000013',
      'chat_only',
      true
    )
  $$,
  '55000',
  'plan_family_transition_not_supported',
  'legacy SMS override evidence rejects a crafted Chat Checkout claim'
);

SELECT results_eq(
  $$
    SELECT public.infer_business_plan_family(
      '10000000-0000-4000-a059-000000000014'
    )
  $$,
  $$ VALUES ('chat_only'::text) $$,
  'partner-comped Chat authority does not misclassify its stale override flag'
);

SELECT results_eq(
  $$
    SELECT public.infer_business_plan_family(
      '10000000-0000-4000-a059-000000000015'
    )
  $$,
  $$ VALUES ('chat_only'::text) $$,
  'a Chat subscription outranks stale legacy override flags during inference'
);

-- ---------------------------------------------------------------------------
-- Advisory intent: atomic CAS without conferring or contradicting authority
-- ---------------------------------------------------------------------------

SELECT results_eq(
  $$
    SELECT public.save_direct_onboarding_plan_intent(
      '10000000-0000-4000-a059-000000000011',
      '00000000-0000-4000-a059-000000000001',
      NULL,
      'chat_only'
    )
  $$,
  $$ VALUES (true) $$,
  'a pristine direct business can save Chat Only advisory intent'
);

SELECT ok(
  (
    SELECT business.onboarding_selected_plan = 'chat_only'
       AND business.onboarding_last_saved_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM public.business_plan_family_locks AS family_lock
         WHERE family_lock.business_id = business.id
       )
    FROM public.businesses AS business
    WHERE business.id = '10000000-0000-4000-a059-000000000011'
  ),
  'advisory selection persists without creating plan-family authority'
);

SELECT results_eq(
  $$
    SELECT public.claim_direct_checkout_plan(
      '10000000-0000-4000-a059-000000000011',
      'chat_only',
      true
    )
  $$,
  $$ VALUES (true) $$,
  'direct Checkout can claim the family after advisory selection'
);

SELECT results_eq(
  $$
    SELECT public.save_direct_onboarding_plan_intent(
      '10000000-0000-4000-a059-000000000011',
      '00000000-0000-4000-a059-000000000001',
      'chat_only',
      'chat_only'
    )
  $$,
  $$ VALUES (true) $$,
  'a matching durable family lock permits an idempotent advisory save'
);

SELECT results_eq(
  $$
    SELECT public.save_direct_onboarding_plan_intent(
      '10000000-0000-4000-a059-000000000011',
      '00000000-0000-4000-a059-000000000001',
      'sms_only',
      'chat_only'
    )
  $$,
  $$ VALUES (false) $$,
  'a missed advisory compare-and-swap returns false under the business lock'
);

SELECT throws_ok(
  $$
    SELECT public.save_direct_onboarding_plan_intent(
      '10000000-0000-4000-a059-000000000011',
      '00000000-0000-4000-a059-000000000001',
      'chat_only',
      'sms_and_chat'
    )
  $$,
  '55000',
  'plan_family_transition_not_supported',
  'an opposing durable family lock rejects contradictory advisory intent'
);

INSERT INTO public.subscriptions (
  id, business_id, stripe_customer_id, stripe_subscription_id,
  plan, status
) VALUES (
  '30000000-0000-4000-a059-000000000011',
  '10000000-0000-4000-a059-000000000011',
  'cus_intent_cas_a059',
  'sub_intent_cas_a059',
  'chat_only',
  'canceled'
);

SELECT results_eq(
  $$
    SELECT public.save_direct_onboarding_plan_intent(
      '10000000-0000-4000-a059-000000000011',
      '00000000-0000-4000-a059-000000000001',
      'chat_only',
      'chat_only'
    )
  $$,
  $$ VALUES (false) $$,
  'existing subscription authority prevents later advisory selection writes'
);

SELECT results_eq(
  $$
    SELECT public.claim_direct_checkout_plan(
      '10000000-0000-4000-a059-000000000011',
      'chat_only',
      true
    )
  $$,
  $$ VALUES (false) $$,
  'new-acquisition intent claims reject a business once any subscription exists'
);

SELECT results_eq(
  $$
    SELECT public.claim_direct_checkout_plan(
      '10000000-0000-4000-a059-000000000011',
      'chat_only',
      false
    )
  $$,
  $$ VALUES (true) $$,
  'canceled same-family reacquisition explicitly bypasses advisory intent'
);

SELECT results_eq(
  $$
    SELECT public.save_direct_onboarding_plan_intent(
      '10000000-0000-4000-a059-000000000012',
      '00000000-0000-4000-a059-000000000001',
      NULL,
      'chat_only'
    )
  $$,
  $$ VALUES (false) $$,
  'partner authority prevents direct advisory selection writes'
);

-- ---------------------------------------------------------------------------
-- Direct Stripe ingestion: no fee and no cross-family transition
-- ---------------------------------------------------------------------------

SELECT results_eq(
  $$
    SELECT public.claim_direct_checkout_plan(
      '10000000-0000-4000-a059-000000000002',
      'sms_only',
      true
    )
  $$,
  $$ VALUES (false) $$,
  'exact intent claim rejects a stale same-family SMS plan selection'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.business_plan_family_locks
    WHERE business_id = '10000000-0000-4000-a059-000000000002'
  ),
  'a stale exact-plan claim creates no family lock before Stripe work'
);

SELECT results_eq(
  $$
    SELECT public.claim_direct_checkout_plan(
      '10000000-0000-4000-a059-000000000001',
      'chat_only',
      true
    )
  $$,
  $$ VALUES (true) $$,
  'pristine direct Checkout can atomically claim the Chat Only family'
);

SELECT ok(
  (
    SELECT family = 'chat_only'
       AND claimed_by = 'direct_checkout'
    FROM public.business_plan_family_locks
    WHERE business_id = '10000000-0000-4000-a059-000000000001'
  ),
  'Checkout claim persists before Stripe mutation'
);

SELECT results_eq(
  $$
    SELECT public.sync_stripe_subscription_if_business_active(
      '10000000-0000-4000-a059-000000000001',
      'cus_chat_a059', 'sub_chat_a059', 'chat_only', 'active',
      '2059-01-01 00:00:00+00', '2059-02-01 00:00:00+00',
      'price_chat_a059', NULL, 'cs_chat_a059', NULL, false,
      '2059-01-01 00:00:00+00'
    )
  $$,
  $$ VALUES (true) $$,
  'initial Chat Only Stripe synchronization succeeds without a setup fee'
);

SELECT ok(
  (
    SELECT plan = 'chat_only'
       AND stripe_setup_fee_price_id IS NULL
       AND setup_fee_paid_at IS NULL
    FROM public.subscriptions
    WHERE business_id = '10000000-0000-4000-a059-000000000001'
  ),
  'synchronized Chat Only fee fields remain NULL'
);

SELECT ok(
  (
    SELECT family = 'chat_only'
       AND claimed_by = 'stripe_sync'
       AND updated_at >= claimed_at
    FROM public.business_plan_family_locks
    WHERE business_id = '10000000-0000-4000-a059-000000000001'
  ),
  'authoritative Stripe sync promotes the provisional Checkout audit source'
);

SELECT throws_ok(
  $$
    SELECT public.sync_stripe_subscription_if_business_active(
      '10000000-0000-4000-a059-000000000001',
      'cus_chat_a059', 'sub_chat_a059', 'chat_only', 'active',
      now(), now() + interval '30 days', 'price_chat_a059',
      'price_setup_a059', NULL, NULL, false, now()
    )
  $$,
  '22023',
  'chat_only_setup_fee_not_allowed',
  'Chat Only sync rejects setup-fee Price metadata'
);

SELECT throws_ok(
  $$
    SELECT public.sync_stripe_subscription_if_business_active(
      '10000000-0000-4000-a059-000000000001',
      'cus_chat_a059', 'sub_chat_a059', 'chat_only', 'active',
      now(), now() + interval '30 days', 'price_chat_a059',
      NULL, NULL, now(), false, now()
    )
  $$,
  '22023',
  'chat_only_setup_fee_not_allowed',
  'Chat Only sync rejects a setup-fee paid timestamp'
);

SELECT throws_ok(
  $$
    UPDATE public.subscriptions
    SET stripe_setup_fee_price_id = 'price_setup_direct_a059'
    WHERE business_id = '10000000-0000-4000-a059-000000000001'
  $$,
  '23514',
  NULL,
  'the table constraint rejects direct Chat Only fee writes'
);

SELECT results_eq(
  $$
    SELECT public.sync_stripe_subscription_if_business_active(
      '10000000-0000-4000-a059-000000000001',
      'cus_chat_a059', 'sub_chat_a059', 'chat_only', 'trialing',
      '2059-02-01 00:00:00+00', '2059-03-01 00:00:00+00',
      'price_chat_a059', NULL, NULL, NULL, true,
      '2059-02-01 00:00:00+00'
    )
  $$,
  $$ VALUES (true) $$,
  'same-family Chat Only status synchronization remains supported'
);

SELECT throws_ok(
  $$
    SELECT public.sync_stripe_subscription_if_business_active(
      '10000000-0000-4000-a059-000000000001',
      'cus_chat_a059', 'sub_chat_a059', 'sms_and_chat', 'active',
      now(), now() + interval '30 days', 'price_growth_a059',
      'price_setup_a059', 'cs_cross_a059', now(), false, now()
    )
  $$,
  '55000',
  'plan_family_transition_not_supported',
  'Stripe sync rejects Chat Only to SMS-family transition'
);

SELECT ok(
  (
    SELECT plan = 'chat_only' AND status = 'trialing'
    FROM public.subscriptions
    WHERE business_id = '10000000-0000-4000-a059-000000000001'
  ),
  'rejected Chat Only transition leaves the subscription unchanged'
);

SELECT results_eq(
  $$
    SELECT public.sync_stripe_subscription_if_business_active(
      '10000000-0000-4000-a059-000000000002',
      'cus_sms_a059', 'sub_sms_a059', 'sms_only', 'active',
      '2059-01-01 00:00:00+00', '2059-02-01 00:00:00+00',
      'price_starter_a059', 'price_setup_a059', 'cs_sms_a059',
      '2059-01-01 00:00:00+00', false,
      '2059-01-01 00:00:00+00'
    )
  $$,
  $$ VALUES (true) $$,
  'initial SMS Stripe synchronization retains its setup fee'
);

SELECT ok(
  (
    SELECT family = 'sms' AND claimed_by = 'stripe_sync'
    FROM public.business_plan_family_locks
    WHERE business_id = '10000000-0000-4000-a059-000000000002'
  ),
  'initial SMS synchronization records durable same-family authority'
);

SELECT results_eq(
  $$
    SELECT public.sync_stripe_subscription_if_business_active(
      '10000000-0000-4000-a059-000000000002',
      'cus_sms_a059', 'sub_sms_a059', 'full', 'active',
      '2059-02-01 00:00:00+00', '2059-03-01 00:00:00+00',
      'price_full_a059', NULL, NULL, NULL, false,
      '2059-02-01 00:00:00+00'
    )
  $$,
  $$ VALUES (true) $$,
  'same-family existing SMS plan changes remain supported'
);

SELECT throws_ok(
  $$
    SELECT public.sync_stripe_subscription_if_business_active(
      '10000000-0000-4000-a059-000000000002',
      'cus_sms_a059', 'sub_sms_a059', 'chat_only', 'active',
      now(), now() + interval '30 days', 'price_chat_a059',
      NULL, NULL, NULL, false, now()
    )
  $$,
  '55000',
  'plan_family_transition_not_supported',
  'Stripe sync rejects SMS-family to Chat Only transition'
);

SELECT ok(
  (
    SELECT plan = 'full'
       AND stripe_setup_fee_price_id = 'price_setup_a059'
       AND setup_fee_paid_at = '2059-01-01 00:00:00+00'::timestamptz
    FROM public.subscriptions
    WHERE business_id = '10000000-0000-4000-a059-000000000002'
  ),
  'SMS same-family sync preserves established setup-fee history'
);

-- ---------------------------------------------------------------------------
-- Partner authority: new assignment works; cross-family change does not
-- ---------------------------------------------------------------------------

SELECT results_eq(
  $$
    SELECT partner_plan
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a059-000000000003',
      '20000000-0000-4000-a059-000000000001',
      'invoiced',
      '90000000-0000-4000-a059-000000000001',
      'chat_only'
    )
  $$,
  $$ VALUES ('chat_only'::text) $$,
  'a new partner assignment can select Chat Only'
);

SELECT results_eq(
  $$
    SELECT partner_plan
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a059-000000000003',
      '20000000-0000-4000-a059-000000000001',
      'comped',
      '90000000-0000-4000-a059-000000000002',
      'chat_only'
    )
  $$,
  $$ VALUES ('chat_only'::text) $$,
  'same-family partner Chat Only authority can change invoicing mode'
);

SELECT throws_ok(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a059-000000000003',
      '20000000-0000-4000-a059-000000000001',
      'invoiced',
      '90000000-0000-4000-a059-000000000003',
      'sms_and_chat'
    )
  $$,
  '55000',
  'plan_family_transition_not_supported',
  'partner assignment rejects Chat Only to SMS-family transition'
);

SELECT ok(
  (
    SELECT billing_mode = 'comped' AND partner_plan = 'chat_only'
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a059-000000000003'
  ),
  'rejected partner family transition leaves authority unchanged'
);

SELECT results_eq(
  $$
    SELECT billing_mode
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a059-000000000003',
      NULL,
      'stripe',
      '90000000-0000-4000-a059-000000000004',
      NULL
    )
  $$,
  $$ VALUES ('stripe'::text) $$,
  'returning to unselected direct authority remains supported'
);

SELECT throws_ok(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a059-000000000003',
      '20000000-0000-4000-a059-000000000001',
      'invoiced',
      '90000000-0000-4000-a059-000000000005',
      'sms_only'
    )
  $$,
  '55000',
  'plan_family_transition_not_supported',
  'unassignment cannot erase the durable Chat family before SMS reassignment'
);

SELECT results_eq(
  $$
    SELECT partner_plan
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a059-000000000004',
      '20000000-0000-4000-a059-000000000001',
      'invoiced',
      '90000000-0000-4000-a059-000000000006',
      'sms_only'
    )
  $$,
  $$ VALUES ('sms_only'::text) $$,
  'a pristine partner assignment can select an SMS plan'
);

SELECT results_eq(
  $$
    SELECT partner_plan
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a059-000000000004',
      '20000000-0000-4000-a059-000000000001',
      'comped',
      '90000000-0000-4000-a059-000000000007',
      'full'
    )
  $$,
  $$ VALUES ('full'::text) $$,
  'same-family partner SMS plan and invoicing-mode changes remain supported'
);

SELECT results_eq(
  $$
    SELECT billing_mode
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a059-000000000004',
      NULL,
      'stripe',
      '90000000-0000-4000-a059-000000000009',
      NULL
    )
  $$,
  $$ VALUES ('stripe'::text) $$,
  'SMS partner authority can be unassigned without erasing its family lock'
);

SELECT throws_ok(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a059-000000000004',
      '20000000-0000-4000-a059-000000000001',
      'invoiced',
      '90000000-0000-4000-a059-000000000008',
      'chat_only'
    )
  $$,
  '55000',
  'plan_family_transition_not_supported',
  'partner assignment rejects SMS-family to Chat Only transition'
);

SELECT ok(
  (
    SELECT billing_mode = 'stripe'
       AND partner_id IS NULL
       AND partner_plan IS NULL
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a059-000000000004'
  ),
  'rejected inverse two-step transition leaves SMS business unassigned'
);

SELECT ok(
  (
    SELECT family = 'chat_only'
       AND claimed_by = 'partner_assignment'
    FROM public.business_plan_family_locks
    WHERE business_id = '10000000-0000-4000-a059-000000000003'
  ),
  'partner unassignment retains its durable family and authoritative audit source'
);

-- ---------------------------------------------------------------------------
-- Durable evidence and repair-window boundaries
-- ---------------------------------------------------------------------------

SELECT throws_ok(
  $$
    SELECT public.claim_business_plan_family(
      '10000000-0000-4000-a059-000000000005',
      'chat_only',
      'direct_checkout'
    )
  $$,
  '55000',
  'plan_family_transition_not_supported',
  'retained provider resource evidence rejects a Chat family claim'
);

SELECT results_eq(
  $$
    SELECT public.claim_business_plan_family(
      '10000000-0000-4000-a059-000000000006',
      'chat_only',
      'direct_checkout'
    )
  $$,
  $$ VALUES (true) $$,
  'local SMS forms, failed registration state, and pending number alone do not lock the SMS family'
);

SELECT throws_ok(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a059-000000000006',
      '20000000-0000-4000-a059-000000000001',
      'invoiced',
      '90000000-0000-4000-a059-000000000010',
      'chat_only'
    )
  $$,
  '55000',
  'plan_family_transition_not_supported',
  'an open direct Chat Checkout claim fences same-family partner reassignment'
);

SELECT throws_ok(
  $$
    SELECT public.claim_business_plan_family(
      '10000000-0000-4000-a059-000000000008',
      'sms',
      'direct_checkout'
    )
  $$,
  '55000',
  'plan_family_transition_not_supported',
  'linked partner provisioning history remains durable Chat family evidence'
);

SELECT throws_ok(
  $$
    SELECT public.claim_business_plan_family(
      '10000000-0000-4000-a059-000000000009',
      'sms',
      'direct_checkout'
    )
  $$,
  '55000',
  'business_plan_family_evidence_conflict',
  'opposing protected current and pending subscription plans fail closed'
);

SELECT results_eq(
  $$
    SELECT public.claim_business_plan_family(
      '10000000-0000-4000-a059-000000000010',
      'sms',
      'test_seed'
    )
  $$,
  $$ VALUES (true) $$,
  'a pristine business can establish an SMS family lock'
);

INSERT INTO public.billing_usage_periods (
  id, business_id, period_start, period_end, plan, included_sms_parts
) VALUES (
  '40000000-0000-4000-a059-000000000010',
  '10000000-0000-4000-a059-000000000010',
  '2059-01-01 00:00:00+00',
  '2059-02-01 00:00:00+00',
  'chat_only',
  0
);

SELECT throws_ok(
  $$
    SELECT public.claim_business_plan_family(
      '10000000-0000-4000-a059-000000000010',
      'sms',
      'stripe_sync'
    )
  $$,
  '55000',
  'business_plan_family_evidence_conflict',
  'a matching stale lock does not hide later conflicting authoritative evidence'
);

SELECT results_eq(
  $$
    SELECT public.claim_business_plan_family(
      '10000000-0000-4000-a059-000000000007',
      'chat_only',
      'direct_checkout'
    )
  $$,
  $$ VALUES (false) $$,
  'direct Chat Checkout rejects a partner-linked Stripe repair row'
);

SELECT throws_ok(
  $$
    SELECT public.sync_stripe_subscription_if_business_active(
      '10000000-0000-4000-a059-000000000007',
      'cus_partner_chat_a059', 'sub_partner_chat_a059',
      'chat_only', 'active', now(), now() + interval '30 days',
      'price_chat_a059', NULL, NULL, NULL, false, now()
    )
  $$,
  '55000',
  'plan_family_transition_not_supported',
  'Stripe ingestion rejects Chat authority for a partner-linked business'
);

SELECT results_eq(
  $$
    SELECT public.claim_business_plan_family(
      '10000000-0000-4000-a059-000000000007',
      'sms',
      'direct_checkout'
    )
  $$,
  $$ VALUES (true) $$,
  'legacy SMS Checkout remains available for a Stripe-mode partner repair row'
);

SELECT results_eq(
  $$
    SELECT public.sync_stripe_subscription_if_business_active(
      '10000000-0000-4000-a059-000000000007',
      'cus_partner_sms_a059', 'sub_partner_sms_a059',
      'sms_only', 'active', now(), now() + interval '30 days',
      'price_starter_a059', 'price_setup_a059',
      'cs_partner_sms_a059', now(), false, now()
    )
  $$,
  $$ VALUES (true) $$,
  'Stripe ingestion preserves SMS billing for a partner-linked repair row'
);

-- ---------------------------------------------------------------------------
-- Atomic, exact-authority, idempotent completion
-- ---------------------------------------------------------------------------

UPDATE public.subscriptions
SET status = 'active'
WHERE business_id = '10000000-0000-4000-a059-000000000001';

SELECT results_eq(
  $$
    SELECT public.finalize_chat_only_onboarding_if_paid(
      '10000000-0000-4000-a059-000000000001',
      'cus_chat_a059',
      'sub_chat_a059'
    )
  $$,
  $$ VALUES (false) $$,
  'paid Chat authority alone cannot complete missing core onboarding facts'
);

SELECT ok(
  (
    SELECT onboarding_completed_at IS NULL
       AND onboarding_step IS DISTINCT FROM 'complete'
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a059-000000000001'
  ),
  'missing core facts leave the protected completion markers untouched'
);

UPDATE public.businesses
SET phone_number = '+13175550101',
    address = '101 Chat Street',
    city = 'Indianapolis',
    state = 'IN',
    zip = '46204'
WHERE id = '10000000-0000-4000-a059-000000000001';

INSERT INTO public.business_hours (
  business_id, day_of_week, open_time, close_time, is_closed
)
SELECT
  '10000000-0000-4000-a059-000000000001',
  day_of_week,
  '09:00'::time,
  '17:00'::time,
  false
FROM generate_series(0, 6) AS day_of_week;

INSERT INTO public.ai_settings (business_id)
VALUES ('10000000-0000-4000-a059-000000000001');

INSERT INTO public.services (business_id, name)
VALUES
  ('10000000-0000-4000-a059-000000000001', 'Chat Service One'),
  ('10000000-0000-4000-a059-000000000001', 'Chat Service Two'),
  ('10000000-0000-4000-a059-000000000001', 'Chat Service Three');

INSERT INTO public.faqs (business_id, question, answer)
VALUES
  (
    '10000000-0000-4000-a059-000000000001',
    'Chat question one?',
    'Chat answer one.'
  ),
  (
    '10000000-0000-4000-a059-000000000001',
    'Chat question two?',
    'Chat answer two.'
  ),
  (
    '10000000-0000-4000-a059-000000000001',
    'Chat question three?',
    repeat('x', 2000)
  );

SELECT results_eq(
  $$
    SELECT public.finalize_chat_only_onboarding_if_paid(
      '10000000-0000-4000-a059-000000000001',
      'cus_chat_a059',
      'sub_chat_a059'
    )
  $$,
  $$ VALUES (false) $$,
  'exact minimum core facts still require a primary goal'
);

UPDATE public.businesses
SET primary_goal = 'book'
WHERE id = '10000000-0000-4000-a059-000000000001';

SELECT results_eq(
  $$
    SELECT public.finalize_chat_only_onboarding_if_paid(
      '10000000-0000-4000-a059-000000000001',
      'cus_chat_a059',
      'sub_chat_a059'
    )
  $$,
  $$ VALUES (true) $$,
  'exact active Chat Only authority completes onboarding'
);

SELECT ok(
  (
    SELECT onboarding_step = 'complete'
       AND onboarding_completed_at IS NOT NULL
       AND onboarding_last_saved_at = onboarding_completed_at
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a059-000000000001'
  ),
  'Chat Only completion writes the core onboarding markers together'
);

CREATE TEMP TABLE chat_only_completion_snapshot_a059 AS
SELECT onboarding_completed_at, onboarding_last_saved_at
FROM public.businesses
WHERE id = '10000000-0000-4000-a059-000000000001';

SELECT results_eq(
  $$
    SELECT public.finalize_chat_only_onboarding_if_paid(
      '10000000-0000-4000-a059-000000000001',
      'cus_chat_a059',
      'sub_chat_a059'
    )
  $$,
  $$ VALUES (true) $$,
  'repeated Chat Only completion remains successful'
);

SELECT ok(
  (
    SELECT ROW(
      business.onboarding_completed_at,
      business.onboarding_last_saved_at
    ) = ROW(
      snapshot.onboarding_completed_at,
      snapshot.onboarding_last_saved_at
    )
    FROM public.businesses AS business
    CROSS JOIN chat_only_completion_snapshot_a059 AS snapshot
    WHERE business.id = '10000000-0000-4000-a059-000000000001'
  ),
  'idempotent completion preserves the original timestamps'
);

SELECT results_eq(
  $$
    SELECT public.finalize_chat_only_onboarding_if_paid(
      '10000000-0000-4000-a059-000000000001',
      'cus_wrong_a059',
      'sub_chat_a059'
    )
  $$,
  $$ VALUES (false) $$,
  'completion rejects mismatched Stripe customer authority'
);

UPDATE public.businesses
SET onboarding_step = 'plan_selection',
    onboarding_completed_at = NULL,
    onboarding_last_saved_at = NULL
WHERE id = '10000000-0000-4000-a059-000000000001';

UPDATE public.subscriptions
SET status = 'past_due'
WHERE business_id = '10000000-0000-4000-a059-000000000001';

SELECT results_eq(
  $$
    SELECT public.finalize_chat_only_onboarding_if_paid(
      '10000000-0000-4000-a059-000000000001',
      'cus_chat_a059',
      'sub_chat_a059'
    )
  $$,
  $$ VALUES (false) $$,
  'completion rejects a non-paying Chat Only status'
);

SELECT ok(
  (
    SELECT onboarding_completed_at IS NULL
       AND onboarding_step = 'plan_selection'
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a059-000000000001'
  ),
  'failed completion leaves onboarding markers untouched'
);

SELECT throws_ok(
  $$
    SELECT public.finalize_chat_only_onboarding_if_paid(
      '10000000-0000-4000-a059-000000000001',
      '',
      'sub_chat_a059'
    )
  $$,
  '22023',
  'invalid_chat_only_finalize_payload',
  'completion rejects malformed provider linkage'
);

-- ---------------------------------------------------------------------------
-- Existing owner guard protects completion while advisory intent stays writable
-- ---------------------------------------------------------------------------

UPDATE public.businesses
SET owner_id = '00000000-0000-4000-a059-000000000001'
WHERE id = '10000000-0000-4000-a059-000000000002';

RESET ROLE;

SELECT set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-a059-000000000001',
  true
);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$
    SELECT public.claim_business_plan_family(
      '10000000-0000-4000-a059-000000000003',
      'chat_only',
      'customer'
    )
  $$,
  '42501',
  NULL,
  'authenticated cannot execute family claims'
);

SELECT throws_ok(
  $$
    SELECT family
    FROM public.business_plan_family_locks
    LIMIT 1
  $$,
  '42501',
  NULL,
  'authenticated cannot read durable family locks'
);

SELECT throws_ok(
  $$
    UPDATE public.businesses
    SET onboarding_completed_at = now()
    WHERE id = '10000000-0000-4000-a059-000000000003'
  $$,
  '42501',
  'customer writes cannot change protected registration fields',
  'an owner cannot self-complete onboarding'
);

SELECT lives_ok(
  $$
    UPDATE public.businesses
    SET onboarding_selected_plan = 'chat_only',
        onboarding_step = 'plan_selection'
    WHERE id = '10000000-0000-4000-a059-000000000003'
  $$,
  'an owner can still update advisory plan intent and step'
);

SELECT throws_ok(
  $$
    UPDATE public.businesses
    SET onboarding_selected_plan = 'sms_only'
    WHERE id = '10000000-0000-4000-a059-000000000003'
  $$,
  '55000',
  'plan_family_transition_not_supported',
  'an owner cannot write SMS intent across a durable Chat family lock'
);

SELECT results_eq(
  $$
    SELECT onboarding_selected_plan
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a059-000000000003'
  $$,
  $$ VALUES ('chat_only'::text) $$,
  'a rejected owner update preserves the matching Chat intent'
);

SELECT lives_ok(
  $$
    UPDATE public.businesses
    SET onboarding_selected_plan = 'sms_only'
    WHERE id = '10000000-0000-4000-a059-000000000002'
  $$,
  'an owner can change SMS plan variants within a durable SMS family lock'
);

SELECT throws_ok(
  $$
    SELECT public.finalize_chat_only_onboarding_if_paid(
      '10000000-0000-4000-a059-000000000003',
      'cus_none_a059',
      'sub_none_a059'
    )
  $$,
  '42501',
  NULL,
  'authenticated cannot execute the completion RPC'
);

RESET ROLE;
SET LOCAL ROLE anon;

SELECT throws_ok(
  $$
    SELECT public.infer_business_plan_family(
      '10000000-0000-4000-a059-000000000003'
    )
  $$,
  '42501',
  NULL,
  'anonymous cannot execute family inference'
);

SELECT throws_ok(
  $$
    SELECT public.finalize_chat_only_onboarding_if_paid(
      '10000000-0000-4000-a059-000000000003',
      'cus_none_a059',
      'sub_none_a059'
    )
  $$,
  '42501',
  NULL,
  'anonymous cannot execute the completion RPC'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
