BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SET LOCAL search_path = public, extensions;

SELECT plan(29);

-- ---------------------------------------------------------------------------
-- Exact durable boundaries and unchanged execution authority
-- ---------------------------------------------------------------------------

SELECT is(
  (
    SELECT count(*)::integer
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
  ),
  5,
  'all five established plan constraints remain present and validated'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
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
      AND NOT (
        pg_get_constraintdef(constraint_row.oid) LIKE ALL (ARRAY[
          '%sms_only%',
          '%sms_and_chat%',
          '%full%',
          '%chat_only%'
        ])
      )
  ),
  'every durable plan boundary admits all three existing plans and chat_only'
);

SELECT ok(
  (
    SELECT pg_get_expr(default_row.adbin, default_row.adrelid) =
      '''sms_only''::text'
    FROM pg_attribute AS attribute
    JOIN pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.subscriptions'::regclass
      AND attribute.attname = 'plan'
  )
  AND (
    SELECT pg_get_expr(default_row.adbin, default_row.adrelid) =
      '''sms_only''::text'
    FROM pg_attribute AS attribute
    JOIN pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.billing_usage_periods'::regclass
      AND attribute.attname = 'plan'
  )
  AND (
    SELECT pg_get_expr(default_row.adbin, default_row.adrelid) =
      '''sms_and_chat''::text'
    FROM pg_attribute AS attribute
    JOIN pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid =
        'public.partner_client_provisioning_jobs'::regclass
      AND attribute.attname = 'partner_plan'
  ),
  'existing Starter and Growth defaults are unchanged'
);

SELECT ok(
  pg_get_functiondef(
    'public.assign_business_partner_billing(uuid,uuid,text,uuid,text)'
      ::regprocedure
  ) LIKE ALL (ARRAY[
    '%p_partner_plan NOT IN (''sms_only'', ''sms_and_chat'', ''full'', ''chat_only'')%',
    '%v_business.partner_plan IN (''sms_only'', ''sms_and_chat'', ''full'', ''chat_only'')%',
    '%ELSE ''sms_and_chat''%',
    '%FOR UPDATE%',
    '%FOR SHARE NOWAIT%',
    '%subscription_exists%'
  ]),
  'partner assignment adds chat_only without changing defaults, locks, or conflicts'
);

SELECT ok(
  pg_get_functiondef(
    'public.sync_stripe_subscription_before_sms_operations(uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,timestamptz,boolean,timestamptz)'
      ::regprocedure
  ) LIKE ALL (ARRAY[
    '%p_plan NOT IN (''sms_only'', ''sms_and_chat'', ''full'', ''chat_only'')%',
    '%business.billing_mode = ''stripe''%',
    '%FOR UPDATE%',
    '%ON CONFLICT (business_id) DO UPDATE%',
    '%pending_plan = NULL%'
  ]),
  'Stripe synchronization adds chat_only without changing its lock or upsert'
);

SELECT ok(
  pg_get_functiondef(
    'public.list_admin_business_health_v2(uuid,text,text,uuid,text,text)'
      ::regprocedure
  ) LIKE ALL (ARRAY[
    '%p_plan NOT IN (''sms_only'', ''sms_and_chat'', ''full'', ''chat_only'')%',
    '%snapshot.snapshot_effective_plan = p_plan%',
    '%LIMIT 75%'
  ]),
  'admin health v2 adds only chat_only to its bounded plan filter'
);

SELECT ok(
  (
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
        ::regprocedure
    ])
  )
  AND (
    SELECT procedure_row.provolatile = 's'
    FROM pg_proc AS procedure_row
    WHERE procedure_row.oid =
      'public.list_admin_business_health_v2(uuid,text,text,uuid,text,text)'
        ::regprocedure
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
  ),
  'all three active RPCs retain fixed paths, security modes, and service-only execution'
);

-- ---------------------------------------------------------------------------
-- Fixtures proving every durable column and RPC boundary
-- ---------------------------------------------------------------------------

INSERT INTO public.partners (
  id, name, slug, custom_domain, domain_status, status
) VALUES (
  '20000000-0000-4000-a057-000000000001',
  'Chat Only Partner 057',
  'chat-only-partner-a057',
  'chat-only-a057.example.com',
  'connected',
  'active'
);

INSERT INTO auth.users (id, email)
VALUES (
  '00000000-0000-4000-a057-000000000001',
  'chat-only-owner-a057@example.test'
);

UPDATE public.businesses
SET id = '10000000-0000-4000-a057-000000000003',
    name = 'Partner Chat Only 057',
    email = 'partner-chat-only-a057@example.test',
    slug = 'partner-chat-only-a057'
WHERE owner_id = '00000000-0000-4000-a057-000000000001';

INSERT INTO public.businesses (
  id, name, email, business_type, slug, created_at
) VALUES
  (
    '10000000-0000-4000-a057-000000000001',
    'Durable Chat Only 057',
    'durable-chat-only-a057@example.test',
    'general',
    'durable-chat-only-a057',
    '2057-01-01 00:00:00+00'
  ),
  (
    '10000000-0000-4000-a057-000000000002',
    'Stripe Chat Only 057',
    'stripe-chat-only-a057@example.test',
    'general',
    'stripe-chat-only-a057',
    '2057-01-02 00:00:00+00'
  ),
  (
    '10000000-0000-4000-a057-000000000004',
    'Partner SMS Regression 057',
    'partner-sms-regression-a057@example.test',
    'general',
    'partner-sms-regression-a057',
    '2057-01-04 00:00:00+00'
  );

INSERT INTO public.subscriptions (
  id, business_id, stripe_customer_id, stripe_subscription_id,
  plan, pending_plan, status
) VALUES (
  '30000000-0000-4000-a057-000000000001',
  '10000000-0000-4000-a057-000000000001',
  'cus_durable_a057',
  'sub_durable_a057',
  'chat_only',
  'chat_only',
  'active'
);

INSERT INTO public.billing_usage_periods (
  id, business_id, period_start, period_end, plan, included_sms_parts
) VALUES (
  '40000000-0000-4000-a057-000000000001',
  '10000000-0000-4000-a057-000000000001',
  '2057-01-01 00:00:00+00',
  '2057-02-01 00:00:00+00',
  'chat_only',
  0
);

INSERT INTO public.partner_client_provisioning_jobs (
  id, email, requested_business_name, partner_id, billing_mode,
  partner_plan, created_by_admin_id
) VALUES (
  '50000000-0000-4000-a057-000000000001',
  'provision-chat-only-a057@example.test',
  'Provision Chat Only 057',
  '20000000-0000-4000-a057-000000000001',
  'invoiced',
  'chat_only',
  '90000000-0000-4000-a057-000000000001'
);

SELECT ok(
  (
    SELECT plan = 'chat_only' AND pending_plan = 'chat_only'
    FROM public.subscriptions
    WHERE id = '30000000-0000-4000-a057-000000000001'
  )
  AND (
    SELECT plan = 'chat_only' AND included_sms_parts = 0
    FROM public.billing_usage_periods
    WHERE id = '40000000-0000-4000-a057-000000000001'
  )
  AND (
    SELECT partner_plan = 'chat_only'
    FROM public.partner_client_provisioning_jobs
    WHERE id = '50000000-0000-4000-a057-000000000001'
  ),
  'subscriptions, pending transitions, usage periods, and provisioning jobs store chat_only'
);

SELECT lives_ok(
  $old_plans$
    DO $exercise_old_plans$
    DECLARE
      v_plan text;
    BEGIN
      FOREACH v_plan IN ARRAY ARRAY['sms_only', 'sms_and_chat', 'full'] LOOP
        UPDATE public.subscriptions
        SET plan = v_plan,
            pending_plan = v_plan
        WHERE id = '30000000-0000-4000-a057-000000000001';

        UPDATE public.billing_usage_periods
        SET plan = v_plan
        WHERE id = '40000000-0000-4000-a057-000000000001';

        UPDATE public.partner_client_provisioning_jobs
        SET partner_plan = v_plan
        WHERE id = '50000000-0000-4000-a057-000000000001';
      END LOOP;

      UPDATE public.subscriptions
      SET plan = 'chat_only',
          pending_plan = 'chat_only'
      WHERE id = '30000000-0000-4000-a057-000000000001';

      UPDATE public.billing_usage_periods
      SET plan = 'chat_only'
      WHERE id = '40000000-0000-4000-a057-000000000001';

      UPDATE public.partner_client_provisioning_jobs
      SET partner_plan = 'chat_only'
      WHERE id = '50000000-0000-4000-a057-000000000001';
    END;
    $exercise_old_plans$;
  $old_plans$,
  'all three existing plans remain valid at every non-business column boundary'
);

SELECT throws_ok(
  $$
    UPDATE public.subscriptions
    SET plan = 'enterprise'
    WHERE id = '30000000-0000-4000-a057-000000000001'
  $$,
  '23514',
  NULL,
  'subscriptions still reject an unknown current plan'
);

SELECT throws_ok(
  $$
    UPDATE public.subscriptions
    SET pending_plan = 'enterprise'
    WHERE id = '30000000-0000-4000-a057-000000000001'
  $$,
  '23514',
  NULL,
  'subscriptions still reject an unknown pending plan'
);

SELECT throws_ok(
  $$
    UPDATE public.billing_usage_periods
    SET plan = 'enterprise'
    WHERE id = '40000000-0000-4000-a057-000000000001'
  $$,
  '23514',
  NULL,
  'usage periods still reject an unknown plan'
);

SELECT throws_ok(
  $$
    UPDATE public.partner_client_provisioning_jobs
    SET partner_plan = 'enterprise'
    WHERE id = '50000000-0000-4000-a057-000000000001'
  $$,
  '23514',
  NULL,
  'provisioning jobs still reject an unknown plan'
);

SET LOCAL ROLE service_role;

SELECT results_eq(
  $$
    SELECT partner_plan
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a057-000000000003',
      '20000000-0000-4000-a057-000000000001',
      'invoiced',
      '90000000-0000-4000-a057-000000000002',
      'chat_only'
    )
  $$,
  $$ VALUES ('chat_only'::text) $$,
  'partner assignment accepts an explicit chat_only plan'
);

SELECT ok(
  (
    SELECT billing_mode = 'invoiced'
       AND partner_id = '20000000-0000-4000-a057-000000000001'
       AND partner_plan = 'chat_only'
       AND NOT billing_pilot
       AND NOT billing_comped
       AND NOT billing_exempt
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a057-000000000003'
  ),
  'chat_only partner assignment preserves native authority and clears no-sale legacy bridges'
);

SELECT results_eq(
  $$
    SELECT partner_plan
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a057-000000000003',
      '20000000-0000-4000-a057-000000000001',
      'comped',
      '90000000-0000-4000-a057-000000000003'
    )
  $$,
  $$ VALUES ('chat_only'::text) $$,
  'an omitted same-partner plan preserves chat_only'
);

SELECT lives_ok(
  $old_partner_plans$
    DO $exercise_old_partner_plans$
    DECLARE
      v_plan text;
    BEGIN
      FOREACH v_plan IN ARRAY ARRAY[
        'sms_only', 'sms_and_chat', 'full'
      ] LOOP
        PERFORM 1
        FROM public.assign_business_partner_billing(
          '10000000-0000-4000-a057-000000000004',
          '20000000-0000-4000-a057-000000000001',
          'invoiced',
          '90000000-0000-4000-a057-000000000004',
          v_plan
        );
      END LOOP;
    END;
    $exercise_old_partner_plans$;
  $old_partner_plans$,
  'partner assignment keeps all existing SMS-family transitions valid alongside chat_only'
);

SELECT throws_ok(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a057-000000000003',
      '20000000-0000-4000-a057-000000000001',
      'invoiced',
      '90000000-0000-4000-a057-000000000005',
      'enterprise'
    )
  $$,
  '22023',
  'invalid_partner_plan',
  'partner assignment still rejects an unknown plan'
);

SELECT throws_ok(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a057-000000000002',
      NULL,
      'stripe',
      '90000000-0000-4000-a057-000000000006',
      'chat_only'
    )
  $$,
  '22023',
  'invalid_partner_plan',
  'Stripe authority still rejects a partner-plan argument'
);

SELECT results_eq(
  $$
    SELECT public.sync_stripe_subscription_if_business_active(
      '10000000-0000-4000-a057-000000000002',
      'cus_sync_a057',
      'sub_sync_a057',
      'chat_only',
      'active',
      '2057-01-01 00:00:00+00',
      '2057-02-01 00:00:00+00',
      'price_chat_only_a057',
      NULL,
      'cs_chat_only_a057',
      NULL,
      false,
      '2057-01-01 00:00:00+00'
    )
  $$,
  $$ VALUES (true) $$,
  'Stripe synchronization inserts chat_only for an active direct business'
);

UPDATE public.subscriptions
SET pending_plan = 'chat_only'
WHERE business_id = '10000000-0000-4000-a057-000000000002';

SELECT results_eq(
  $$
    SELECT public.sync_stripe_subscription_if_business_active(
      '10000000-0000-4000-a057-000000000002',
      'cus_sync_a057',
      'sub_sync_a057',
      'chat_only',
      'trialing',
      '2057-02-01 00:00:00+00',
      '2057-03-01 00:00:00+00',
      'price_chat_only_a057',
      NULL,
      NULL,
      NULL,
      true,
      '2057-02-01 00:00:00+00'
    )
  $$,
  $$ VALUES (true) $$,
  'Stripe synchronization upserts an existing chat_only subscription'
);

SELECT ok(
  (
    SELECT plan = 'chat_only'
       AND status = 'trialing'
       AND stripe_setup_fee_price_id IS NULL
       AND stripe_checkout_session_id = 'cs_chat_only_a057'
       AND setup_fee_paid_at IS NULL
       AND cancel_at_period_end
       AND pending_plan IS NULL
    FROM public.subscriptions
    WHERE business_id = '10000000-0000-4000-a057-000000000002'
  ),
  'the chat_only upsert remains no-fee and clears pending_plan'
);

SELECT throws_ok(
  $$
    SELECT public.sync_stripe_subscription_if_business_active(
      '10000000-0000-4000-a057-000000000002',
      'cus_sync_a057', 'sub_sync_a057', 'enterprise', 'active',
      now(), now() + interval '30 days', 'price_unknown_a057',
      NULL, NULL, NULL, false, now()
    )
  $$,
  '22023',
  'invalid Stripe subscription sync payload',
  'Stripe synchronization still rejects an unknown plan'
);

SELECT results_eq(
  $$
    SELECT public.sync_stripe_subscription_if_business_active(
      '10000000-0000-4000-a057-000000000003',
      'cus_wrong_authority_a057', 'sub_wrong_authority_a057',
      'chat_only', 'active', now(), now() + interval '30 days',
      'price_chat_only_a057', NULL, NULL, NULL, false, now()
    )
  $$,
  $$ VALUES (false) $$,
  'Stripe synchronization cannot cross into partner billing authority'
);

SELECT results_eq(
  $$
    SELECT business_id, subscription_plan, effective_plan
    FROM public.list_admin_business_health_v2(
      p_business_id => '10000000-0000-4000-a057-000000000002',
      p_plan => 'chat_only'
    )
  $$,
  $$
    VALUES (
      '10000000-0000-4000-a057-000000000002'::uuid,
      'chat_only'::text,
      'chat_only'::text
    )
  $$,
  'admin health v2 accepts and returns the chat_only plan filter'
);

SELECT throws_ok(
  $$
    SELECT count(*)
    FROM public.list_admin_business_health_v2(p_plan => 'enterprise')
  $$,
  '22023',
  'invalid_admin_plan_filter',
  'admin health v2 still rejects an unknown plan filter'
);

RESET ROLE;

SELECT throws_ok(
  $$
    UPDATE public.businesses
    SET partner_plan = 'enterprise'
    WHERE id = '10000000-0000-4000-a057-000000000003'
  $$,
  '23514',
  NULL,
  'business partner plans still reject an unknown durable value'
);

SELECT set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-a057-000000000001',
  true
);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$
    UPDATE public.businesses
    SET partner_plan = 'full'
    WHERE id = '10000000-0000-4000-a057-000000000003'
  $$,
  '42501',
  'customer writes cannot change protected business billing fields',
  'an owner cannot self-upgrade a chat_only partner assignment'
);

SELECT throws_ok(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a057-000000000003',
      '20000000-0000-4000-a057-000000000001',
      'invoiced',
      '00000000-0000-4000-a057-000000000001',
      'full'
    )
  $$,
  '42501',
  NULL,
  'an authenticated owner still cannot execute partner-plan transitions'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
