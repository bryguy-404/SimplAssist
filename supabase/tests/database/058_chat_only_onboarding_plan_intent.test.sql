BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SET LOCAL search_path = public, extensions;

SELECT plan(26);

-- ---------------------------------------------------------------------------
-- Catalog shape and unchanged state-machine boundaries
-- ---------------------------------------------------------------------------

SELECT has_column(
  'public',
  'businesses',
  'onboarding_selected_plan',
  'businesses carry durable onboarding plan intent'
);

SELECT ok(
  (
    SELECT attribute.atttypid = 'text'::regtype
       AND NOT attribute.attnotnull
       AND default_row.oid IS NULL
    FROM pg_attribute AS attribute
    LEFT JOIN pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.businesses'::regclass
      AND attribute.attname = 'onboarding_selected_plan'
      AND NOT attribute.attisdropped
  ),
  'onboarding plan intent is nullable text with no implicit default'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.businesses'::regclass
      AND constraint_row.conname IN (
        'businesses_onboarding_selected_plan_check',
        'businesses_onboarding_step_check'
      )
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
  ),
  2,
  'both onboarding constraints are present and validated'
);

SELECT ok(
  (
    SELECT pg_get_constraintdef(constraint_row.oid) LIKE ALL (ARRAY[
      '%sms_only%',
      '%sms_and_chat%',
      '%full%',
      '%chat_only%'
    ])
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.businesses'::regclass
      AND constraint_row.conname =
        'businesses_onboarding_selected_plan_check'
  ),
  'plan intent recognizes every existing plan and chat_only'
);

SELECT ok(
  (
    SELECT pg_get_constraintdef(constraint_row.oid) LIKE ALL (ARRAY[
      '%plan_selection%',
      '%business_info%',
      '%business_hours%',
      '%services_faqs%',
      '%ai_settings%',
      '%legal_verification%',
      '%sms_use_case%',
      '%phone_number%',
      '%review_submit%',
      '%carrier_review%',
      '%complete%'
    ])
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.businesses'::regclass
      AND constraint_row.conname = 'businesses_onboarding_step_check'
  ),
  'plan_selection extends every established onboarding step'
);

SELECT is(
  (
    SELECT pg_get_expr(default_row.adbin, default_row.adrelid)
    FROM pg_attribute AS attribute
    JOIN pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.businesses'::regclass
      AND attribute.attname = 'onboarding_step'
  ),
  '''business_info''::text',
  'existing businesses still default to business_info'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.businesses
    WHERE onboarding_selected_plan IS NOT NULL
  ),
  'the migration does not invent plan intent for existing businesses'
);

SELECT policies_are(
  'public',
  'businesses',
  ARRAY[
    'businesses_delete',
    'businesses_insert',
    'businesses_select',
    'businesses_update'
  ],
  'existing owner business policies remain unchanged'
);

SELECT has_trigger(
  'public',
  'businesses',
  'guard_business_billing_authorization_fields',
  'the established customer billing-field guard remains active'
);

SELECT ok(
  (
    SELECT count(*) = 5
    FROM pg_constraint AS constraint_row
    WHERE (constraint_row.conrelid, constraint_row.conname) IN (
      ('public.subscriptions'::regclass, 'subscriptions_plan_check'),
      ('public.subscriptions'::regclass, 'subscriptions_pending_plan_check'),
      ('public.billing_usage_periods'::regclass,
        'billing_usage_periods_plan_check'),
      ('public.businesses'::regclass, 'businesses_partner_plan_valid'),
      ('public.partner_client_provisioning_jobs'::regclass,
        'partner_client_provisioning_jobs_partner_plan_check')
    )
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND pg_get_constraintdef(constraint_row.oid) LIKE ALL (ARRAY[
        '%sms_only%',
        '%sms_and_chat%',
        '%full%',
        '%chat_only%'
      ])
  ),
  'all five established entitlement plan constraints remain validated and unchanged'
);

SELECT ok(
  pg_get_functiondef(
    'public.assign_business_partner_billing(uuid,uuid,text,uuid,text)'
      ::regprocedure
  ) LIKE ALL (ARRAY[
    '%p_partner_plan NOT IN (''sms_only'', ''sms_and_chat'', ''full'', ''chat_only'')%',
    '%v_business.partner_plan IN (''sms_only'', ''sms_and_chat'', ''full'', ''chat_only'')%',
    '%FOR UPDATE%',
    '%FOR SHARE NOWAIT%'
  ])
  AND pg_get_functiondef(
    'public.sync_stripe_subscription_before_sms_operations(uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,timestamptz,boolean,timestamptz)'
      ::regprocedure
  ) LIKE ALL (ARRAY[
    '%p_plan NOT IN (''sms_only'', ''sms_and_chat'', ''full'', ''chat_only'')%',
    '%business.billing_mode = ''stripe''%',
    '%ON CONFLICT (business_id) DO UPDATE%'
  ])
  AND pg_get_functiondef(
    'public.list_admin_business_health_v2(uuid,text,text,uuid,text,text)'
      ::regprocedure
  ) LIKE ALL (ARRAY[
    '%p_plan NOT IN (''sms_only'', ''sms_and_chat'', ''full'', ''chat_only'')%',
    '%snapshot.snapshot_effective_plan = p_plan%',
    '%LIMIT 75%'
  ])
  AND (
    SELECT bool_and(
      NOT procedure_row.prosecdef
      AND procedure_row.proconfig @> ARRAY['search_path=public, pg_temp']
    )
    FROM pg_proc AS procedure_row
    WHERE procedure_row.oid = ANY (ARRAY[
      'public.assign_business_partner_billing(uuid,uuid,text,uuid,text)'
        ::regprocedure,
      'public.sync_stripe_subscription_before_sms_operations(uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,timestamptz,boolean,timestamptz)'
        ::regprocedure,
      'public.list_admin_business_health_v2(uuid,text,text,uuid,text,text)'
        ::regprocedure,
      'public.guard_business_billing_authorization_fields()'::regprocedure
    ])
  )
  AND has_function_privilege(
    'service_role',
    'public.assign_business_partner_billing(uuid,uuid,text,uuid,text)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'service_role',
    'public.sync_stripe_subscription_if_business_active(uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,timestamptz,boolean,timestamptz)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'service_role',
    'public.list_admin_business_health_v2(uuid,text,text,uuid,text,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.assign_business_partner_billing(uuid,uuid,text,uuid,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.sync_stripe_subscription_if_business_active(uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,timestamptz,boolean,timestamptz)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.list_admin_business_health_v2(uuid,text,text,uuid,text,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.guard_business_billing_authorization_fields()',
    'EXECUTE'
  ),
  'billing RPC definitions, invoker paths, and service-only execution remain unchanged'
);

SELECT ok(
  has_table_privilege('authenticated', 'public.businesses', 'SELECT')
  AND has_table_privilege('authenticated', 'public.businesses', 'INSERT')
  AND has_table_privilege('authenticated', 'public.businesses', 'UPDATE')
  AND has_table_privilege('authenticated', 'public.businesses', 'DELETE')
  AND has_table_privilege('service_role', 'public.businesses', 'SELECT')
  AND has_table_privilege('service_role', 'public.businesses', 'INSERT')
  AND has_table_privilege('service_role', 'public.businesses', 'UPDATE')
  AND has_table_privilege('service_role', 'public.businesses', 'DELETE')
  AND has_table_privilege('authenticated', 'public.subscriptions', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.subscriptions', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.subscriptions', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.subscriptions', 'DELETE')
  AND has_table_privilege('service_role', 'public.subscriptions', 'SELECT')
  AND has_table_privilege('service_role', 'public.subscriptions', 'INSERT')
  AND has_table_privilege('service_role', 'public.subscriptions', 'UPDATE')
  AND has_table_privilege('service_role', 'public.subscriptions', 'DELETE'),
  'business owner grants and subscription service authority remain unchanged'
);

-- ---------------------------------------------------------------------------
-- Value regressions
-- ---------------------------------------------------------------------------

INSERT INTO auth.users (id, email)
VALUES
  (
    '00000000-0000-4000-a058-000000000001',
    'direct-owner-a058@example.test'
  ),
  (
    '00000000-0000-4000-a058-000000000002',
    'partner-owner-a058@example.test'
  ),
  (
    '00000000-0000-4000-a058-000000000003',
    'foreign-owner-a058@example.test'
  );

UPDATE public.businesses
SET id = CASE owner_id
      WHEN '00000000-0000-4000-a058-000000000001'::uuid
        THEN '10000000-0000-4000-a058-000000000001'::uuid
      WHEN '00000000-0000-4000-a058-000000000002'::uuid
        THEN '10000000-0000-4000-a058-000000000002'::uuid
      ELSE '10000000-0000-4000-a058-000000000003'::uuid
    END,
    name = CASE owner_id
      WHEN '00000000-0000-4000-a058-000000000001'::uuid
        THEN 'Direct Intent 058'
      WHEN '00000000-0000-4000-a058-000000000002'::uuid
        THEN 'Partner Intent 058'
      ELSE 'Foreign Intent 058'
    END,
    email = CASE owner_id
      WHEN '00000000-0000-4000-a058-000000000001'::uuid
        THEN 'direct-business-a058@example.test'
      WHEN '00000000-0000-4000-a058-000000000002'::uuid
        THEN 'partner-business-a058@example.test'
      ELSE 'foreign-business-a058@example.test'
    END,
    slug = CASE owner_id
      WHEN '00000000-0000-4000-a058-000000000001'::uuid
        THEN 'direct-intent-a058'
      WHEN '00000000-0000-4000-a058-000000000002'::uuid
        THEN 'partner-intent-a058'
      ELSE 'foreign-intent-a058'
    END
WHERE owner_id IN (
  '00000000-0000-4000-a058-000000000001',
  '00000000-0000-4000-a058-000000000002',
  '00000000-0000-4000-a058-000000000003'
);

INSERT INTO public.partners (
  id, name, slug, custom_domain, domain_status, status
) VALUES (
  '20000000-0000-4000-a058-000000000001',
  'Intent Partner 058',
  'intent-partner-a058',
  'intent-partner-a058.example.com',
  'connected',
  'active'
);

UPDATE public.businesses
SET partner_id = '20000000-0000-4000-a058-000000000001',
    billing_mode = 'invoiced',
    partner_plan = 'sms_only'
WHERE id = '10000000-0000-4000-a058-000000000002';

INSERT INTO public.subscriptions (
  id, business_id, stripe_customer_id, stripe_subscription_id,
  plan, status
) VALUES (
  '30000000-0000-4000-a058-000000000001',
  '10000000-0000-4000-a058-000000000001',
  'cus_direct_a058',
  'sub_direct_a058',
  'full',
  'active'
);

SELECT lives_ok(
  $old_plan_intents$
    DO $exercise_old_plan_intents$
    DECLARE
      v_plan text;
    BEGIN
      FOREACH v_plan IN ARRAY ARRAY[
        'sms_only', 'sms_and_chat', 'full', 'chat_only'
      ] LOOP
        UPDATE public.businesses
        SET onboarding_selected_plan = v_plan
        WHERE id = '10000000-0000-4000-a058-000000000001';
      END LOOP;
    END;
    $exercise_old_plan_intents$;
  $old_plan_intents$,
  'all existing plans remain valid onboarding intents alongside chat_only'
);

SELECT throws_ok(
  $$
    UPDATE public.businesses
    SET onboarding_selected_plan = 'enterprise'
    WHERE id = '10000000-0000-4000-a058-000000000001'
  $$,
  '23514',
  NULL,
  'unknown onboarding plan intent is rejected'
);

SELECT lives_ok(
  $old_onboarding_steps$
    DO $exercise_old_onboarding_steps$
    DECLARE
      v_step text;
    BEGIN
      FOREACH v_step IN ARRAY ARRAY[
        'business_info',
        'business_hours',
        'services_faqs',
        'ai_settings',
        'legal_verification',
        'sms_use_case',
        'phone_number',
        'review_submit',
        'carrier_review',
        'complete',
        'plan_selection'
      ] LOOP
        UPDATE public.businesses
        SET onboarding_step = v_step
        WHERE id = '10000000-0000-4000-a058-000000000001';
      END LOOP;
    END;
    $exercise_old_onboarding_steps$;
  $old_onboarding_steps$,
  'all established onboarding steps remain valid alongside plan_selection'
);

SELECT throws_ok(
  $$
    UPDATE public.businesses
    SET onboarding_step = 'payment_magic'
    WHERE id = '10000000-0000-4000-a058-000000000001'
  $$,
  '23514',
  NULL,
  'unknown onboarding steps remain rejected'
);

-- ---------------------------------------------------------------------------
-- Owner intent writes without billing authority
-- ---------------------------------------------------------------------------

SELECT set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-a058-000000000001',
  true
);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$
    UPDATE public.businesses
    SET onboarding_selected_plan = 'chat_only',
        onboarding_step = 'plan_selection'
    WHERE id = '10000000-0000-4000-a058-000000000001'
  $$,
  'an owner can persist its advisory plan selection'
);

SELECT ok(
  (
    SELECT onboarding_selected_plan = 'chat_only'
       AND onboarding_step = 'plan_selection'
       AND billing_mode = 'stripe'
       AND partner_id IS NULL
       AND partner_plan IS NULL
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a058-000000000001'
  )
  AND (
    SELECT plan = 'full' AND status = 'active'
    FROM public.subscriptions
    WHERE business_id = '10000000-0000-4000-a058-000000000001'
  ),
  'direct intent does not alter Stripe billing authority or entitlement state'
);

SELECT throws_ok(
  $$
    UPDATE public.subscriptions
    SET plan = 'chat_only'
    WHERE business_id = '10000000-0000-4000-a058-000000000001'
  $$,
  '42501',
  NULL,
  'an owner cannot turn onboarding intent into a subscription entitlement'
);

SELECT throws_ok(
  $$
    UPDATE public.businesses
    SET onboarding_selected_plan = 'chat_only',
        partner_id = '20000000-0000-4000-a058-000000000001',
        billing_mode = 'invoiced',
        partner_plan = 'full'
    WHERE id = '10000000-0000-4000-a058-000000000001'
  $$,
  '42501',
  'customer writes cannot change protected business billing fields',
  'an owner cannot combine selection intent with a billing-authority change'
);

SELECT results_eq(
  $$
    WITH attempted_update AS (
      UPDATE public.businesses
      SET onboarding_selected_plan = 'sms_only'
      WHERE id = '10000000-0000-4000-a058-000000000003'
      RETURNING id
    )
    SELECT id FROM attempted_update
  $$,
  $$ SELECT NULL::uuid WHERE false $$,
  'owner RLS prevents plan-intent writes to another business'
);

RESET ROLE;

SELECT results_eq(
  $$
    SELECT effective_plan
    FROM public.list_admin_business_health_v2(
      p_business_id => '10000000-0000-4000-a058-000000000001'
    )
  $$,
  $$ VALUES ('full'::text) $$,
  'direct effective-plan reads ignore onboarding selection intent'
);

SELECT set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-a058-000000000002',
  true
);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$
    UPDATE public.businesses
    SET onboarding_selected_plan = 'chat_only',
        onboarding_step = 'plan_selection'
    WHERE id = '10000000-0000-4000-a058-000000000002'
  $$,
  'a partner client owner can store advisory onboarding intent'
);

RESET ROLE;

SELECT ok(
  (
    SELECT onboarding_selected_plan = 'chat_only'
       AND billing_mode = 'invoiced'
       AND partner_plan = 'sms_only'
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a058-000000000002'
  )
  AND (
    SELECT effective_plan = 'sms_only'
    FROM public.list_admin_business_health_v2(
      p_business_id => '10000000-0000-4000-a058-000000000002'
    )
  ),
  'partner effective entitlement remains partner_plan, not onboarding intent'
);

SELECT set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-a058-000000000001',
  true
);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$
    UPDATE public.businesses
    SET onboarding_selected_plan = NULL
    WHERE id = '10000000-0000-4000-a058-000000000001'
  $$,
  'an owner can clear an abandoned onboarding plan selection'
);

RESET ROLE;

SELECT is(
  (
    SELECT onboarding_selected_plan
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a058-000000000001'
  ),
  NULL::text,
  'clearing intent still leaves the nullable durable field empty'
);

SELECT * FROM finish();

ROLLBACK;
