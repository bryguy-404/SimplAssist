BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;

SET LOCAL search_path = public, extensions;

SELECT plan(126);

-- ---------------------------------------------------------------------------
-- Catalog shape, protected fields, and service-only boundaries
-- ---------------------------------------------------------------------------

SELECT is(
  (
    SELECT jsonb_object_agg(
      attribute.attname,
      format_type(attribute.atttypid, attribute.atttypmod)
    )
    FROM pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.partners'::regclass
      AND attribute.attname IN (
        'email_from_status',
        'email_from_verified_at',
        'email_from_verified_by'
      )
      AND NOT attribute.attisdropped
  ),
  jsonb_build_object(
    'email_from_status', 'text',
    'email_from_verified_at', 'timestamp with time zone',
    'email_from_verified_by', 'uuid'
  ),
  'partners have the exact sender-verification column types'
);

SELECT ok(
  (
    SELECT attribute.attnotnull
       AND pg_get_expr(default_value.adbin, default_value.adrelid) =
         '''unconfigured''::text'
    FROM pg_attribute AS attribute
    JOIN pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.partners'::regclass
      AND attribute.attname = 'email_from_status'
  )
  AND (
    SELECT bool_and(NOT attribute.attnotnull)
    FROM pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.partners'::regclass
      AND attribute.attname IN (
        'email_from_verified_at',
        'email_from_verified_by'
      )
  ),
  'sender state is required and defaults unconfigured while audit fields are nullable'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.partners'::regclass
      AND constraint_row.conname = 'partners_email_from_status_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
  )
  AND EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.partners'::regclass
      AND constraint_row.conname = 'partners_email_from_mailbox'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
  )
  AND EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.partners'::regclass
      AND constraint_row.conname = 'partners_email_from_state'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
  ),
  'sender status, mailbox, and state checks are validated'
);

SELECT ok(
  (
    SELECT format_type(attribute.atttypid, attribute.atttypmod) = 'text'
       AND NOT attribute.attnotnull
       AND default_value.oid IS NULL
    FROM pg_attribute AS attribute
    LEFT JOIN pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.businesses'::regclass
      AND attribute.attname = 'partner_plan'
  ),
  'business partner_plan is nullable text with no default'
);

SELECT is(
  (
    SELECT array_agg(constraint_row.conname::name ORDER BY constraint_row.conname)
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.businesses'::regclass
      AND constraint_row.conname IN (
        'businesses_partner_plan_valid',
        'businesses_partner_plan_matches_mode'
      )
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
  ),
  ARRAY[
    'businesses_partner_plan_matches_mode',
    'businesses_partner_plan_valid'
  ]::name[],
  'partner plans have both validated value and billing-mode checks'
);

SELECT ok(
  pg_get_constraintdef(
    (
      SELECT constraint_row.oid
      FROM pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = 'public.businesses'::regclass
        AND constraint_row.conname = 'businesses_partner_plan_matches_mode'
    )
  ) LIKE '%billing_mode = ''stripe''%partner_plan IS NULL%'
  AND pg_get_constraintdef(
    (
      SELECT constraint_row.oid
      FROM pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = 'public.businesses'::regclass
        AND constraint_row.conname = 'businesses_partner_plan_matches_mode'
    )
  ) LIKE '%billing_mode = ANY%invoiced%comped%partner_plan IS NOT NULL%',
  'Stripe requires a null partner plan and non-Stripe modes require a plan'
);

SELECT ok(
  pg_get_functiondef(
    'public.guard_business_billing_authorization_fields()'::regprocedure
  ) LIKE ALL (ARRAY[
    '%billing_pilot%',
    '%billing_comped%',
    '%billing_exempt%',
    '%sms_overage_opt_in%',
    '%sms_overage_opted_in_at%',
    '%sms_overage_opted_in_by%',
    '%telnyx_submission_disabled%',
    '%billing_admin_notes%',
    '%billing_flags_updated_at%',
    '%billing_flags_updated_by%',
    '%partner_id%',
    '%billing_mode%',
    '%partner_plan%'
  ]),
  'the customer-write guard retains every protected field and adds partner_plan'
);

SELECT ok(
  (
    SELECT NOT procedure_row.prosecdef
       AND procedure_row.proconfig @> ARRAY['search_path=public, pg_temp']
    FROM pg_proc AS procedure_row
    WHERE procedure_row.oid =
      'public.guard_business_billing_authorization_fields()'::regprocedure
  )
  AND NOT has_function_privilege(
    'anon',
    'public.guard_business_billing_authorization_fields()',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.guard_business_billing_authorization_fields()',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'service_role',
    'public.guard_business_billing_authorization_fields()',
    'EXECUTE'
  ),
  'the protected-field trigger remains an uncallable SECURITY INVOKER function'
);

SELECT has_function(
  'public',
  'assign_business_partner_billing',
  ARRAY['uuid', 'uuid', 'text', 'uuid', 'text'],
  'the assignment RPC has the five-argument identity'
);

SELECT is(
  pg_get_function_result(
    'public.assign_business_partner_billing(uuid,uuid,text,uuid,text)'::regprocedure
  ),
  'TABLE(business_id uuid, partner_id uuid, billing_mode text, partner_plan text, billing_comped boolean)',
  'the assignment RPC returns its complete final billing state'
);

SELECT ok(
  (
    SELECT procedure_row.pronargdefaults = 1
       AND procedure_row.proargnames = ARRAY[
         'p_business_id',
         'p_partner_id',
         'p_billing_mode',
         'p_actor_user_id',
         'p_partner_plan',
         'business_id',
         'partner_id',
         'billing_mode',
         'partner_plan',
         'billing_comped'
       ]
    FROM pg_proc AS procedure_row
    WHERE procedure_row.oid =
      'public.assign_business_partner_billing(uuid,uuid,text,uuid,text)'::regprocedure
  ),
  'only the trailing partner-plan argument is defaulted'
);

SELECT ok(
  (
    SELECT NOT procedure_row.prosecdef
       AND procedure_row.proconfig @> ARRAY['search_path=public, pg_temp']
       AND pg_get_functiondef(procedure_row.oid) LIKE '%FOR UPDATE%'
       AND pg_get_functiondef(procedure_row.oid) LIKE '%FOR SHARE NOWAIT%'
       AND pg_get_functiondef(procedure_row.oid) LIKE '%domain_status%connected%'
       AND pg_get_functiondef(procedure_row.oid) LIKE '%subscription_exists%'
       AND pg_get_functiondef(procedure_row.oid) LIKE '%billing_pilot%false%'
       AND pg_get_functiondef(procedure_row.oid) LIKE '%billing_comped%false%'
       AND pg_get_functiondef(procedure_row.oid) LIKE '%billing_exempt%false%'
    FROM pg_proc AS procedure_row
    WHERE procedure_row.oid =
      'public.assign_business_partner_billing(uuid,uuid,text,uuid,text)'::regprocedure
  ),
  'the invoker RPC preserves its locks and enforces connected native partner billing'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_proc AS procedure_row
    CROSS JOIN LATERAL aclexplode(
      COALESCE(procedure_row.proacl, acldefault('f', procedure_row.proowner))
    ) AS acl_row
    WHERE procedure_row.oid =
      'public.assign_business_partner_billing(uuid,uuid,text,uuid,text)'::regprocedure
      AND acl_row.grantee = 0
  )
  AND NOT has_function_privilege(
    'anon',
    'public.assign_business_partner_billing(uuid,uuid,text,uuid,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.assign_business_partner_billing(uuid,uuid,text,uuid,text)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'service_role',
    'public.assign_business_partner_billing(uuid,uuid,text,uuid,text)',
    'EXECUTE'
  ),
  'only service_role can execute the five-argument assignment RPC'
);

SELECT ok(
  pg_get_functiondef(
    'public.sync_stripe_subscription_before_sms_operations(uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,timestamptz,boolean,timestamptz)'::regprocedure
  ) LIKE '%business.billing_mode = ''stripe''%FOR UPDATE%'
  AND pg_get_functiondef(
    'public.mark_stripe_subscription_past_due_if_business_active(text,timestamptz)'::regprocedure
  ) LIKE '%business.billing_mode = ''stripe''%FOR SHARE OF business%'
  AND pg_get_functiondef(
    'public.mark_stripe_subscription_past_due_if_business_active(text,timestamptz)'::regprocedure
  ) LIKE '%UPDATE public.subscriptions%business.billing_mode = ''stripe''%',
  'both Stripe mutation functions gate on Stripe mode while holding the business lock'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.sync_stripe_subscription_if_business_active(uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,timestamptz,boolean,timestamptz)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'anon',
    'public.sync_stripe_subscription_if_business_active(uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,timestamptz,boolean,timestamptz)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.sync_stripe_subscription_if_business_active(uuid,text,text,text,text,timestamptz,timestamptz,text,text,text,timestamptz,boolean,timestamptz)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'service_role',
    'public.mark_stripe_subscription_past_due_if_business_active(text,timestamptz)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'anon',
    'public.mark_stripe_subscription_past_due_if_business_active(text,timestamptz)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.mark_stripe_subscription_past_due_if_business_active(text,timestamptz)',
    'EXECUTE'
  ),
  'Stripe synchronization functions remain service-role-only'
);

-- ---------------------------------------------------------------------------
-- Assignment versus Stripe synchronization serialization
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE partner_044_concurrency_state (
  name text PRIMARY KEY,
  payload jsonb
);

-- dblink sessions commit independently from this pgTAP transaction. Fixed
-- fixture ids plus up-front/final cleanup make interrupted local reruns safe.
DO $local_setup$
DECLARE
  -- Local Supabase dev-stack default; this pgTAP file is local-only.
  v_connection_string text :=
    'host=supabase_db_SimplAssist port=' || current_setting('port') ||
    ' dbname=' || current_database() || ' user=' || current_user ||
    ' password=postgres';
BEGIN
  PERFORM extensions.dblink_connect('test_044_setup', v_connection_string);
  PERFORM extensions.dblink_connect('test_044_a_assign', v_connection_string);
  PERFORM extensions.dblink_connect('test_044_a_sync', v_connection_string);
  PERFORM extensions.dblink_connect('test_044_b_sync', v_connection_string);
  PERFORM extensions.dblink_connect('test_044_b_assign', v_connection_string);

  PERFORM extensions.dblink_exec(
    'test_044_setup',
    $remote_setup$
      DO $fixture$
      BEGIN
        DELETE FROM public.businesses
        WHERE id IN (
          '10000000-0000-4000-a044-000000000091',
          '10000000-0000-4000-a044-000000000092'
        );

        DELETE FROM auth.users
        WHERE id IN (
          '00000000-0000-4000-a044-000000000091',
          '00000000-0000-4000-a044-000000000092'
        );

        DELETE FROM public.partners
        WHERE id = '20000000-0000-4000-a044-000000000091';

        INSERT INTO public.partners (
          id, name, slug, custom_domain, domain_status, status
        ) VALUES (
          '20000000-0000-4000-a044-000000000091',
          'Concurrency Partner 044',
          'concurrency-partner-044',
          'concurrency-044.example.com',
          'connected',
          'active'
        );

        INSERT INTO auth.users (id, email)
        VALUES
          (
            '00000000-0000-4000-a044-000000000091',
            'concurrency-assign-first-a044@example.test'
          ),
          (
            '00000000-0000-4000-a044-000000000092',
            'concurrency-sync-first-a044@example.test'
          );

        UPDATE public.businesses
        SET id = '10000000-0000-4000-a044-000000000091',
            name = 'Concurrency Assign First 044',
            slug = 'concurrency-assign-first-044'
        WHERE owner_id = '00000000-0000-4000-a044-000000000091';

        UPDATE public.businesses
        SET id = '10000000-0000-4000-a044-000000000092',
            name = 'Concurrency Sync First 044',
            slug = 'concurrency-sync-first-044'
        WHERE owner_id = '00000000-0000-4000-a044-000000000092';
      END;
      $fixture$;
    $remote_setup$
  );

  -- Catch the expected post-wait subscription conflict on the remote session
  -- so the local pgTAP transaction can assert the stable error string.
  PERFORM extensions.dblink_exec(
    'test_044_b_assign',
    $remote_helper$
      CREATE FUNCTION pg_temp.try_partner_assignment_044()
      RETURNS text
      LANGUAGE plpgsql
      AS $helper$
      BEGIN
        PERFORM *
        FROM public.assign_business_partner_billing(
          '10000000-0000-4000-a044-000000000092',
          '20000000-0000-4000-a044-000000000091',
          'invoiced',
          '90000000-0000-4000-a044-000000000091'
        );
        RETURN 'unexpected_success';
      EXCEPTION
        WHEN OTHERS THEN
          RETURN SQLERRM;
      END;
      $helper$;
    $remote_helper$
  );
END;
$local_setup$;

-- Assignment-first: FOR UPDATE wins, Stripe FOR SHARE waits, then rechecks the
-- committed non-Stripe mode and returns false without inserting authority.
DO $start_assignment_first$
BEGIN
  PERFORM extensions.dblink_exec('test_044_a_assign', 'BEGIN');
END;
$start_assignment_first$;

INSERT INTO partner_044_concurrency_state (name, payload)
SELECT 'assignment_first', jsonb_build_object('plan', partner_plan)
FROM extensions.dblink(
  'test_044_a_assign',
  $remote_assignment_first$
    SELECT partner_plan
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000091',
      '20000000-0000-4000-a044-000000000091',
      'invoiced',
      '90000000-0000-4000-a044-000000000091'
    )
  $remote_assignment_first$
) AS remote_result(partner_plan text);

SELECT is(
  (
    SELECT payload ->> 'plan'
    FROM partner_044_concurrency_state
    WHERE name = 'assignment_first'
  ),
  'sms_and_chat',
  'assignment-first race stores the default Growth plan while holding its lock'
);

SELECT is(
  extensions.dblink_send_query(
    'test_044_a_sync',
    $remote_sync_after_assignment$
      SELECT public.sync_stripe_subscription_if_business_active(
        '10000000-0000-4000-a044-000000000091',
        'cus_assignment_first_a044',
        'sub_assignment_first_a044',
        'sms_and_chat',
        'active',
        now(),
        now() + interval '30 days',
        'price_assignment_first_a044',
        NULL,
        NULL,
        NULL,
        false,
        now()
      )
    $remote_sync_after_assignment$
  ),
  1,
  'assignment-first race starts Stripe synchronization on a second connection'
);

DO $wait_assignment_first$
BEGIN
  PERFORM pg_sleep(0.1);
END;
$wait_assignment_first$;

SELECT is(
  extensions.dblink_is_busy('test_044_a_sync'),
  1,
  'Stripe synchronization waits while assignment holds the business lock'
);

DO $commit_assignment_first$
BEGIN
  PERFORM extensions.dblink_exec('test_044_a_assign', 'COMMIT');
END;
$commit_assignment_first$;

INSERT INTO partner_044_concurrency_state (name, payload)
SELECT 'sync_after_assignment', jsonb_build_object('result', result)
FROM extensions.dblink_get_result('test_044_a_sync')
  AS remote_result(result boolean);

DO $drain_assignment_first$
BEGIN
  PERFORM result
  FROM extensions.dblink_get_result('test_044_a_sync')
    AS remote_result(result boolean);
END;
$drain_assignment_first$;

SELECT is(
  (
    SELECT (payload ->> 'result')::boolean
    FROM partner_044_concurrency_state
    WHERE name = 'sync_after_assignment'
  ),
  false,
  'waiting Stripe synchronization rechecks mode and returns false'
);

SELECT is(
  (
    SELECT count(*)::bigint
    FROM public.subscriptions
    WHERE business_id = '10000000-0000-4000-a044-000000000091'
  ),
  0::bigint,
  'assignment-first serialization creates no stale subscription row'
);

-- Sync-first: FOR SHARE wins and creates the subscription. Assignment waits
-- for FOR UPDATE, then sees the committed row and returns subscription_exists.
DO $start_sync_first$
BEGIN
  PERFORM extensions.dblink_exec('test_044_b_sync', 'BEGIN');
END;
$start_sync_first$;

INSERT INTO partner_044_concurrency_state (name, payload)
SELECT 'sync_first', jsonb_build_object('result', result)
FROM extensions.dblink(
  'test_044_b_sync',
  $remote_sync_first$
    SELECT public.sync_stripe_subscription_if_business_active(
      '10000000-0000-4000-a044-000000000092',
      'cus_sync_first_a044',
      'sub_sync_first_a044',
      'sms_only',
      'active',
      now(),
      now() + interval '30 days',
      'price_sync_first_a044',
      NULL,
      NULL,
      NULL,
      false,
      now()
    )
  $remote_sync_first$
) AS remote_result(result boolean);

SELECT is(
  (
    SELECT (payload ->> 'result')::boolean
    FROM partner_044_concurrency_state
    WHERE name = 'sync_first'
  ),
  true,
  'sync-first race creates Stripe authority while holding its shared lock'
);

SELECT is(
  extensions.dblink_send_query(
    'test_044_b_assign',
    'SELECT pg_temp.try_partner_assignment_044()'
  ),
  1,
  'sync-first race starts partner assignment on a second connection'
);

DO $wait_sync_first$
BEGIN
  PERFORM pg_sleep(0.1);
END;
$wait_sync_first$;

SELECT is(
  extensions.dblink_is_busy('test_044_b_assign'),
  1,
  'partner assignment waits while Stripe sync holds the business lock'
);

DO $commit_sync_first$
BEGIN
  PERFORM extensions.dblink_exec('test_044_b_sync', 'COMMIT');
END;
$commit_sync_first$;

INSERT INTO partner_044_concurrency_state (name, payload)
SELECT 'assignment_after_sync', jsonb_build_object('result', result)
FROM extensions.dblink_get_result('test_044_b_assign')
  AS remote_result(result text);

DO $drain_sync_first$
BEGIN
  PERFORM result
  FROM extensions.dblink_get_result('test_044_b_assign')
    AS remote_result(result text);
END;
$drain_sync_first$;

SELECT is(
  (
    SELECT payload ->> 'result'
    FROM partner_044_concurrency_state
    WHERE name = 'assignment_after_sync'
  ),
  'subscription_exists',
  'waiting partner assignment rechecks and reports subscription_exists'
);

SELECT ok(
  (
    SELECT business.billing_mode = 'stripe'
       AND business.partner_id IS NULL
       AND business.partner_plan IS NULL
       AND subscription.stripe_subscription_id = 'sub_sync_first_a044'
    FROM public.businesses AS business
    JOIN public.subscriptions AS subscription
      ON subscription.business_id = business.id
    WHERE business.id = '10000000-0000-4000-a044-000000000092'
  ),
  'sync-first serialization leaves Stripe authority intact'
);

DO $concurrency_cleanup$
BEGIN
  PERFORM extensions.dblink_exec(
    'test_044_setup',
    $remote_cleanup$
      DELETE FROM auth.users
      WHERE id IN (
        '00000000-0000-4000-a044-000000000091',
        '00000000-0000-4000-a044-000000000092'
      );

      DELETE FROM public.partners
      WHERE id = '20000000-0000-4000-a044-000000000091';
    $remote_cleanup$
  );

  PERFORM extensions.dblink_disconnect('test_044_a_assign');
  PERFORM extensions.dblink_disconnect('test_044_a_sync');
  PERFORM extensions.dblink_disconnect('test_044_b_sync');
  PERFORM extensions.dblink_disconnect('test_044_b_assign');
  PERFORM extensions.dblink_disconnect('test_044_setup');
END;
$concurrency_cleanup$;

-- ---------------------------------------------------------------------------
-- Concierge provisioning table catalog and authorization boundary
-- ---------------------------------------------------------------------------

SELECT has_table(
  'public',
  'partner_client_provisioning_jobs',
  'concierge provisioning has a private durable job table'
);

SELECT col_is_pk(
  'public',
  'partner_client_provisioning_jobs',
  'id',
  'provisioning job ids are the primary key'
);

SELECT is(
  (
    SELECT jsonb_object_agg(
      attribute.attname,
      format_type(attribute.atttypid, attribute.atttypmod)
    )
    FROM pg_attribute AS attribute
    WHERE attribute.attrelid =
      'public.partner_client_provisioning_jobs'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ),
  jsonb_build_object(
    'id', 'uuid',
    'email', 'text',
    'requested_business_name', 'text',
    'partner_id', 'uuid',
    'billing_mode', 'text',
    'partner_plan', 'text',
    'auth_user_id', 'uuid',
    'business_id', 'uuid',
    'status', 'text',
    'last_error_code', 'text',
    'setup_email_sent_at', 'timestamp with time zone',
    'invite_attempt_count', 'integer',
    'dismissed_at', 'timestamp with time zone',
    'dismissed_by_admin_id', 'uuid',
    'operation_token', 'uuid',
    'operation_kind', 'text',
    'operation_started_at', 'timestamp with time zone',
    'operation_expires_at', 'timestamp with time zone',
    'created_by_admin_id', 'uuid',
    'created_at', 'timestamp with time zone',
    'updated_at', 'timestamp with time zone'
  ),
  'provisioning jobs have the exact approved column types'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM pg_attribute AS attribute
    WHERE attribute.attrelid =
      'public.partner_client_provisioning_jobs'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ),
  21,
  'provisioning jobs have no extra or missing columns'
);

SELECT is(
  (
    SELECT array_agg(attribute.attname ORDER BY attribute.attname)
    FROM pg_attribute AS attribute
    WHERE attribute.attrelid =
      'public.partner_client_provisioning_jobs'::regclass
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ),
  ARRAY[
    'billing_mode',
    'created_at',
    'created_by_admin_id',
    'email',
    'id',
    'invite_attempt_count',
    'partner_id',
    'partner_plan',
    'requested_business_name',
    'status',
    'updated_at'
  ]::name[],
  'only approved provisioning fields are required'
);

SELECT is(
  (
    SELECT jsonb_object_agg(
      attribute.attname,
      pg_get_expr(default_value.adbin, default_value.adrelid)
    )
    FROM pg_attribute AS attribute
    JOIN pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid =
      'public.partner_client_provisioning_jobs'::regclass
  ),
  jsonb_build_object(
    'id', 'gen_random_uuid()',
    'partner_plan', '''sms_and_chat''::text',
    'status', '''pending''::text',
    'invite_attempt_count', '0',
    'created_at', 'now()',
    'updated_at', 'now()'
  ),
  'provisioning jobs have the exact approved defaults'
);

SELECT is(
  (
    SELECT array_agg(constraint_row.conname::name ORDER BY constraint_row.conname)
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.partner_client_provisioning_jobs'::regclass
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
  ),
  ARRAY[
    'partner_client_provisioning_jobs_billing_mode_check',
    'partner_client_provisioning_jobs_invite_attempt_count_check',
    'partner_client_provisioning_jobs_partner_plan_check',
    'partner_client_provisioning_jobs_requested_business_name_check',
    'partner_client_provisioning_jobs_status_check',
    'provisioning_dismissed_shape',
    'provisioning_email_canonical',
    'provisioning_operation_shape'
  ]::name[],
  'all provisioning value checks exist and are validated'
);

SELECT is(
  (
    SELECT array_agg(constraint_row.conname::name ORDER BY constraint_row.conname)
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.partner_client_provisioning_jobs'::regclass
      AND constraint_row.contype = 'u'
  ),
  ARRAY[
    'partner_client_provisioning_jobs_auth_user_id_key',
    'partner_client_provisioning_jobs_business_id_key',
    'partner_client_provisioning_jobs_email_key'
  ]::name[],
  'email, auth user, and business are independently unique per provisioning job'
);

SELECT ok(
  (
    SELECT constraint_row.confrelid = 'public.partners'::regclass
       AND constraint_row.confdeltype = 'r'
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.partner_client_provisioning_jobs'::regclass
      AND constraint_row.conname =
        'partner_client_provisioning_jobs_partner_id_fkey'
  ),
  'provisioning jobs restrict deletion of their partner'
);

SELECT ok(
  (
    SELECT constraint_row.confrelid = 'auth.users'::regclass
       AND constraint_row.confdeltype = 'n'
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.partner_client_provisioning_jobs'::regclass
      AND constraint_row.conname =
        'partner_client_provisioning_jobs_auth_user_id_fkey'
  ),
  'deleted auth users are detached from provisioning jobs'
);

SELECT ok(
  (
    SELECT constraint_row.confrelid = 'public.businesses'::regclass
       AND constraint_row.confdeltype = 'n'
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.partner_client_provisioning_jobs'::regclass
      AND constraint_row.conname =
        'partner_client_provisioning_jobs_business_id_fkey'
  ),
  'deleted businesses are detached from provisioning jobs'
);

SELECT ok(
  (
    SELECT NOT index_row.indisunique
       AND pg_get_indexdef(index_row.indexrelid)
         LIKE '%(status, updated_at)%'
    FROM pg_index AS index_row
    WHERE index_row.indexrelid =
      'public.partner_client_provisioning_jobs_status_idx'::regclass
  ),
  'provisioning retry queues have the approved status/update index'
);

SELECT has_trigger(
  'public',
  'partner_client_provisioning_jobs',
  'set_updated_at_partner_client_provisioning_jobs',
  'provisioning writes maintain updated_at'
);

SELECT ok(
  (
    SELECT class_row.relrowsecurity
    FROM pg_class AS class_row
    WHERE class_row.oid =
      'public.partner_client_provisioning_jobs'::regclass
  ),
  'provisioning jobs have row-level security enabled'
);

SELECT policies_are(
  'public',
  'partner_client_provisioning_jobs',
  ARRAY[]::name[],
  'provisioning jobs intentionally have no customer policies'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_class AS class_row
    CROSS JOIN LATERAL aclexplode(
      COALESCE(class_row.relacl, acldefault('r', class_row.relowner))
    ) AS acl_row
    WHERE class_row.oid =
      'public.partner_client_provisioning_jobs'::regclass
      AND acl_row.grantee = 0
  ),
  'PUBLIC has no provisioning-table privilege'
);

SELECT table_privs_are(
  'public',
  'partner_client_provisioning_jobs',
  'anon',
  ARRAY[]::name[],
  'anon has no provisioning-table privileges'
);

SELECT table_privs_are(
  'public',
  'partner_client_provisioning_jobs',
  'authenticated',
  ARRAY[]::name[],
  'authenticated has no provisioning-table privileges'
);

SELECT table_privs_are(
  'public',
  'partner_client_provisioning_jobs',
  'service_role',
  ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::name[],
  'service_role has exact provisioning CRUD privileges'
);

-- ---------------------------------------------------------------------------
-- Fixtures and sender-state constraints
-- ---------------------------------------------------------------------------

INSERT INTO public.partners (
  id,
  name,
  slug,
  custom_domain,
  domain_status,
  status
) VALUES
  (
    '20000000-0000-4000-a044-000000000001',
    'Connected Partner A',
    'connected-partner-a',
    'partner-a.example.com',
    'connected',
    'active'
  ),
  (
    '20000000-0000-4000-a044-000000000002',
    'Connected Partner B',
    'connected-partner-b',
    'partner-b.example.com',
    'connected',
    'active'
  ),
  (
    '20000000-0000-4000-a044-000000000003',
    'Inactive Partner',
    'inactive-partner-a044',
    'inactive-a044.example.com',
    'connected',
    'inactive'
  ),
  (
    '20000000-0000-4000-a044-000000000004',
    'Pending Partner',
    'pending-partner-a044',
    'pending-a044.example.com',
    'pending',
    'active'
  ),
  (
    '20000000-0000-4000-a044-000000000005',
    'Disconnected Partner',
    'disconnected-partner-a044',
    NULL,
    'pending',
    'active'
  ),
  (
    '20000000-0000-4000-a044-000000000006',
    'Disposable Partner',
    'disposable-partner-a044',
    'disposable-a044.example.com',
    'connected',
    'active'
  ),
  (
    '20000000-0000-4000-a044-000000000007',
    'Malformed Read Boundary',
    'malformed-partner-a044',
    'valid-before-corruption.example.com',
    'connected',
    'active'
  );

SELECT ok(
  (
    SELECT email_from IS NULL
       AND email_from_status = 'unconfigured'
       AND email_from_verified_at IS NULL
       AND email_from_verified_by IS NULL
    FROM public.partners
    WHERE id = '20000000-0000-4000-a044-000000000001'
  ),
  'new partners default to a consistent unconfigured sender state'
);

SELECT lives_ok(
  $$
    UPDATE public.partners
    SET email_from = 'billing@partner-a.example.com',
        email_from_status = 'pending'
    WHERE id = '20000000-0000-4000-a044-000000000001'
  $$,
  'a canonical mailbox may enter Pending without verification audit fields'
);

SELECT lives_ok(
  $$
    UPDATE public.partners
    SET email_from_status = 'verified',
        email_from_verified_at = now(),
        email_from_verified_by =
          '90000000-0000-4000-a044-000000000001'
    WHERE id = '20000000-0000-4000-a044-000000000001'
  $$,
  'a configured mailbox may enter Verified with both audit fields'
);

SELECT throws_ok(
  $$
    UPDATE public.partners
    SET email_from = 'Billing@partner-a.example.com',
        email_from_status = 'pending',
        email_from_verified_at = NULL,
        email_from_verified_by = NULL
    WHERE id = '20000000-0000-4000-a044-000000000001'
  $$,
  '23514',
  NULL,
  'sender mailboxes must already be lowercase'
);

SELECT throws_ok(
  $$
    UPDATE public.partners
    SET email_from = 'Alpha Dog <billing@partner-a.example.com>',
        email_from_status = 'pending',
        email_from_verified_at = NULL,
        email_from_verified_by = NULL
    WHERE id = '20000000-0000-4000-a044-000000000001'
  $$,
  '23514',
  NULL,
  'sender mailboxes cannot contain a display name or header syntax'
);

SELECT throws_ok(
  $$
    UPDATE public.partners
    SET email_from = 'billing@localhost',
        email_from_status = 'pending',
        email_from_verified_at = NULL,
        email_from_verified_by = NULL
    WHERE id = '20000000-0000-4000-a044-000000000001'
  $$,
  '23514',
  NULL,
  'sender mailboxes require a dotted DNS domain'
);

SELECT throws_ok(
  $$
    UPDATE public.partners
    SET email_from_status = 'unconfigured',
        email_from_verified_at = NULL,
        email_from_verified_by = NULL
    WHERE id = '20000000-0000-4000-a044-000000000001'
  $$,
  '23514',
  NULL,
  'an address cannot be present in Unconfigured state'
);

SELECT throws_ok(
  $$
    UPDATE public.partners
    SET email_from = NULL,
        email_from_status = 'pending',
        email_from_verified_at = NULL,
        email_from_verified_by = NULL
    WHERE id = '20000000-0000-4000-a044-000000000001'
  $$,
  '23514',
  NULL,
  'Pending requires a configured address'
);

SELECT throws_ok(
  $$
    UPDATE public.partners
    SET email_from_status = 'pending',
        email_from_verified_at = now(),
        email_from_verified_by =
          '90000000-0000-4000-a044-000000000001'
    WHERE id = '20000000-0000-4000-a044-000000000001'
  $$,
  '23514',
  NULL,
  'Pending cannot retain verification audit fields'
);

SELECT throws_ok(
  $$
    UPDATE public.partners
    SET email_from_status = 'verified',
        email_from_verified_at = NULL,
        email_from_verified_by = NULL
    WHERE id = '20000000-0000-4000-a044-000000000001'
  $$,
  '23514',
  NULL,
  'Verified requires both verification audit fields'
);

-- Restore the primary fixture to Pending for later provisioning tests.
UPDATE public.partners
SET email_from_status = 'pending',
    email_from_verified_at = NULL,
    email_from_verified_by = NULL
WHERE id = '20000000-0000-4000-a044-000000000001';

-- ---------------------------------------------------------------------------
-- Business fixtures and exact cleanup-scope regression
-- ---------------------------------------------------------------------------

INSERT INTO auth.users (id, email)
VALUES
  (
    '00000000-0000-4000-a044-000000000001',
    'partner-plan-primary@example.test'
  ),
  (
    '00000000-0000-4000-a044-000000000002',
    'partner-plan-subscribed@example.test'
  ),
  (
    '00000000-0000-4000-a044-000000000003',
    'partner-plan-deleted@example.test'
  ),
  (
    '00000000-0000-4000-a044-000000000004',
    'stripe-legacy-cleanup@example.test'
  ),
  (
    '00000000-0000-4000-a044-000000000005',
    'partner-cleanup@example.test'
  ),
  (
    '00000000-0000-4000-a044-000000000006',
    'stripe-sync@example.test'
  ),
  (
    '00000000-0000-4000-a044-000000000007',
    'partner-sync@example.test'
  ),
  (
    '00000000-0000-4000-a044-000000000008',
    'partner-orphan@example.test'
  ),
  (
    '00000000-0000-4000-a044-000000000009',
    'stripe-past-due@example.test'
  ),
  (
    '00000000-0000-4000-a044-000000000010',
    'partner-comped-cleanup@example.test'
  );

UPDATE public.businesses
SET id = '10000000-0000-4000-a044-000000000001',
    name = 'Partner Plan Primary',
    slug = 'partner-plan-primary-a044'
WHERE owner_id = '00000000-0000-4000-a044-000000000001';

UPDATE public.businesses
SET id = '10000000-0000-4000-a044-000000000002',
    name = 'Partner Plan Subscribed',
    slug = 'partner-plan-subscribed-a044'
WHERE owner_id = '00000000-0000-4000-a044-000000000002';

UPDATE public.businesses
SET id = '10000000-0000-4000-a044-000000000003',
    name = 'Partner Plan Deleted',
    slug = 'partner-plan-deleted-a044'
WHERE owner_id = '00000000-0000-4000-a044-000000000003';

UPDATE public.businesses
SET id = '10000000-0000-4000-a044-000000000004',
    name = 'Stripe Legacy Cleanup',
    slug = 'stripe-legacy-cleanup-a044',
    billing_pilot = true,
    billing_comped = true,
    billing_exempt = true,
    billing_flags_updated_at = '2026-01-01 00:00:00+00',
    billing_flags_updated_by = 'migration-019-fixture',
    billing_admin_notes = 'must survive migration 044'
WHERE owner_id = '00000000-0000-4000-a044-000000000004';

UPDATE public.businesses
SET id = '10000000-0000-4000-a044-000000000005',
    name = 'Partner Cleanup',
    slug = 'partner-cleanup-a044',
    partner_id = '20000000-0000-4000-a044-000000000001',
    billing_mode = 'invoiced',
    partner_plan = 'full',
    billing_pilot = true,
    billing_comped = true,
    billing_exempt = true,
    billing_flags_updated_by = 'phase-1-bridge'
WHERE owner_id = '00000000-0000-4000-a044-000000000005';

UPDATE public.businesses
SET id = '10000000-0000-4000-a044-000000000006',
    name = 'Stripe Sync',
    slug = 'stripe-sync-a044'
WHERE owner_id = '00000000-0000-4000-a044-000000000006';

UPDATE public.businesses
SET id = '10000000-0000-4000-a044-000000000007',
    name = 'Partner Sync',
    slug = 'partner-sync-a044'
WHERE owner_id = '00000000-0000-4000-a044-000000000007';

UPDATE public.businesses
SET id = '10000000-0000-4000-a044-000000000008',
    name = 'Partner Orphan',
    slug = 'partner-orphan-a044'
WHERE owner_id = '00000000-0000-4000-a044-000000000008';

UPDATE public.businesses
SET id = '10000000-0000-4000-a044-000000000009',
    name = 'Stripe Past Due',
    slug = 'stripe-past-due-a044'
WHERE owner_id = '00000000-0000-4000-a044-000000000009';

UPDATE public.businesses
SET id = '10000000-0000-4000-a044-000000000010',
    name = 'Partner Comped Cleanup',
    slug = 'partner-comped-cleanup-a044',
    partner_id = '20000000-0000-4000-a044-000000000002',
    billing_mode = 'comped',
    partner_plan = 'sms_only',
    billing_pilot = true,
    billing_comped = true,
    billing_exempt = true,
    billing_flags_updated_by = 'phase-1-comped-bridge'
WHERE owner_id = '00000000-0000-4000-a044-000000000010';

UPDATE public.businesses
SET deleted_at = now(),
    deletion_scheduled_for = now() + interval '60 days'
WHERE id = '10000000-0000-4000-a044-000000000003';

SELECT ok(
  (
    SELECT bool_and(
      billing_mode = 'stripe'
      AND partner_id IS NULL
      AND partner_plan IS NULL
    )
    FROM public.businesses
    WHERE owner_id IN (
      '00000000-0000-4000-a044-000000000001',
      '00000000-0000-4000-a044-000000000002',
      '00000000-0000-4000-a044-000000000003',
      '00000000-0000-4000-a044-000000000006',
      '00000000-0000-4000-a044-000000000007',
      '00000000-0000-4000-a044-000000000008',
      '00000000-0000-4000-a044-000000000009'
    )
  ),
  'new businesses default to Stripe mode with no partner plan'
);

INSERT INTO public.billing_usage_periods (
  id,
  business_id,
  period_start,
  period_end,
  plan,
  included_sms_parts,
  updated_at
) VALUES
  (
    '30000000-0000-4000-a044-000000000001',
    '10000000-0000-4000-a044-000000000004',
    now() - interval '1 day',
    now() + interval '29 days',
    'full',
    2500,
    '2026-01-02 00:00:00+00'
  ),
  (
    '30000000-0000-4000-a044-000000000002',
    '10000000-0000-4000-a044-000000000005',
    now() - interval '1 day',
    now() + interval '29 days',
    'full',
    2500,
    '2026-01-02 00:00:00+00'
  ),
  (
    '30000000-0000-4000-a044-000000000003',
    '10000000-0000-4000-a044-000000000005',
    now() - interval '60 days',
    now() - interval '30 days',
    'full',
    2500,
    '2026-01-02 00:00:00+00'
  ),
  (
    '30000000-0000-4000-a044-000000000004',
    '10000000-0000-4000-a044-000000000010',
    now() - interval '1 day',
    now() + interval '29 days',
    'sms_only',
    500,
    '2026-01-02 00:00:00+00'
  ),
  (
    '30000000-0000-4000-a044-000000000005',
    '10000000-0000-4000-a044-000000000010',
    now() + interval '1 day',
    now() + interval '31 days',
    'sms_only',
    500,
    '2026-01-02 00:00:00+00'
  );

-- Exercise the exact migration cleanup predicates inside this rolled-back
-- test transaction. Migrations run before pgTAP, so post-migration catalog
-- tests cannot otherwise manufacture a before/after row pair.
UPDATE public.businesses
SET partner_plan = 'sms_and_chat',
    billing_comped = false,
    billing_pilot = false,
    billing_exempt = false,
    updated_at = now()
WHERE billing_mode IN ('invoiced', 'comped');

UPDATE public.billing_usage_periods AS period
SET plan = 'sms_and_chat',
    included_sms_parts = 1500,
    updated_at = now()
FROM public.businesses AS business
WHERE period.business_id = business.id
  AND business.billing_mode IN ('invoiced', 'comped')
  AND period.period_start <= now()
  AND period.period_end > now();

SELECT is(
  (
    SELECT jsonb_build_object(
      'billing_mode', billing_mode,
      'partner_plan', partner_plan,
      'billing_pilot', billing_pilot,
      'billing_comped', billing_comped,
      'billing_exempt', billing_exempt,
      'source', CASE
        WHEN billing_pilot OR billing_comped OR billing_exempt
          THEN 'billing_override'
        ELSE 'missing'
      END,
      'plan', CASE
        WHEN billing_pilot OR billing_comped OR billing_exempt
          THEN 'full'
        ELSE NULL
      END,
      'status', CASE
        WHEN billing_pilot OR billing_comped OR billing_exempt
          THEN 'billing_override'
        ELSE 'subscription_missing'
      END,
      'active', billing_pilot OR billing_comped OR billing_exempt
    )
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a044-000000000004'
  ),
  jsonb_build_object(
    'billing_mode', 'stripe',
    'partner_plan', NULL,
    'billing_pilot', true,
    'billing_comped', true,
    'billing_exempt', true,
    'source', 'billing_override',
    'plan', 'full',
    'status', 'billing_override',
    'active', true
  ),
  'cleanup leaves a Stripe legacy fixture and its Full active override eligibility identical'
);

SELECT ok(
  (
    SELECT billing_flags_updated_at = '2026-01-01 00:00:00+00'::timestamptz
       AND billing_flags_updated_by = 'migration-019-fixture'
       AND billing_admin_notes = 'must survive migration 044'
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a044-000000000004'
  ),
  'cleanup does not alter Stripe-mode legacy audit state'
);

SELECT ok(
  (
    SELECT plan = 'full'
       AND included_sms_parts = 2500
       AND updated_at = '2026-01-02 00:00:00+00'::timestamptz
    FROM public.billing_usage_periods
    WHERE id = '30000000-0000-4000-a044-000000000001'
  ),
  'cleanup leaves the Stripe legacy fixture current usage snapshot untouched'
);

SELECT ok(
  (
    SELECT billing_mode = 'invoiced'
       AND partner_plan = 'sms_and_chat'
       AND NOT billing_pilot
       AND NOT billing_comped
       AND NOT billing_exempt
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a044-000000000005'
  ),
  'cleanup backfills only the non-Stripe business to Growth without legacy flags'
);

SELECT ok(
  (
    SELECT plan = 'sms_and_chat'
       AND included_sms_parts = 1500
    FROM public.billing_usage_periods
    WHERE id = '30000000-0000-4000-a044-000000000002'
  ),
  'cleanup reconciles the current non-Stripe usage snapshot to Growth'
);

SELECT ok(
  (
    SELECT plan = 'full'
       AND included_sms_parts = 2500
       AND updated_at = '2026-01-02 00:00:00+00'::timestamptz
    FROM public.billing_usage_periods
    WHERE id = '30000000-0000-4000-a044-000000000003'
  ),
  'cleanup leaves historical non-Stripe usage periods untouched'
);

SELECT ok(
  (
    SELECT billing_mode = 'comped'
       AND partner_plan = 'sms_and_chat'
       AND NOT billing_pilot
       AND NOT billing_comped
       AND NOT billing_exempt
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a044-000000000010'
  ),
  'cleanup applies the same Growth backfill to comped businesses'
);

SELECT ok(
  (
    SELECT plan = 'sms_and_chat'
       AND included_sms_parts = 1500
    FROM public.billing_usage_periods
    WHERE id = '30000000-0000-4000-a044-000000000004'
  ),
  'cleanup reconciles a current comped usage period to Growth'
);

SELECT ok(
  (
    SELECT plan = 'sms_only'
       AND included_sms_parts = 500
       AND updated_at = '2026-01-02 00:00:00+00'::timestamptz
    FROM public.billing_usage_periods
    WHERE id = '30000000-0000-4000-a044-000000000005'
  ),
  'cleanup leaves future non-Stripe usage periods untouched'
);

-- ---------------------------------------------------------------------------
-- Provisioning runtime constraints and isolation
-- ---------------------------------------------------------------------------

INSERT INTO public.partner_client_provisioning_jobs (
  id,
  email,
  requested_business_name,
  partner_id,
  billing_mode,
  auth_user_id,
  business_id,
  created_by_admin_id
) VALUES (
  '40000000-0000-4000-a044-000000000001',
  'client@partner-a.example.com',
  'Partner Client',
  '20000000-0000-4000-a044-000000000001',
  'invoiced',
  '00000000-0000-4000-a044-000000000001',
  '10000000-0000-4000-a044-000000000001',
  '90000000-0000-4000-a044-000000000001'
);

SELECT ok(
  (
    SELECT partner_plan = 'sms_and_chat'
       AND status = 'pending'
       AND invite_attempt_count = 0
       AND last_error_code IS NULL
       AND setup_email_sent_at IS NULL
       AND created_at IS NOT NULL
       AND updated_at IS NOT NULL
    FROM public.partner_client_provisioning_jobs
    WHERE id = '40000000-0000-4000-a044-000000000001'
  ),
  'a minimal provisioning job receives every operational default'
);

UPDATE public.partner_client_provisioning_jobs
SET status = 'auth_created',
    updated_at = '2000-01-01 00:00:00+00'
WHERE id = '40000000-0000-4000-a044-000000000001';

SELECT ok(
  (
    SELECT updated_at > '2000-01-01 00:00:00+00'::timestamptz
    FROM public.partner_client_provisioning_jobs
    WHERE id = '40000000-0000-4000-a044-000000000001'
  ),
  'provisioning job updates refresh updated_at'
);

SELECT lives_ok(
  $$
    UPDATE public.partner_client_provisioning_jobs
    SET status = 'pending'
    WHERE id = '40000000-0000-4000-a044-000000000001';

    UPDATE public.partner_client_provisioning_jobs
    SET status = 'admin_setup'
    WHERE id = '40000000-0000-4000-a044-000000000001';

    UPDATE public.partner_client_provisioning_jobs
    SET status = 'auth_created'
    WHERE id = '40000000-0000-4000-a044-000000000001';

    UPDATE public.partner_client_provisioning_jobs
    SET status = 'business_prepared'
    WHERE id = '40000000-0000-4000-a044-000000000001';

    UPDATE public.partner_client_provisioning_jobs
    SET status = 'assigned'
    WHERE id = '40000000-0000-4000-a044-000000000001';

    UPDATE public.partner_client_provisioning_jobs
    SET status = 'invite_pending'
    WHERE id = '40000000-0000-4000-a044-000000000001';

    UPDATE public.partner_client_provisioning_jobs
    SET status = 'setup_email_sent'
    WHERE id = '40000000-0000-4000-a044-000000000001';

    UPDATE public.partner_client_provisioning_jobs
    SET status = 'needs_attention'
    WHERE id = '40000000-0000-4000-a044-000000000001'
  $$,
  'provisioning jobs accept every approved lifecycle state including admin_setup'
);

SELECT throws_ok(
  $$
    INSERT INTO public.partner_client_provisioning_jobs (
      email, requested_business_name, partner_id, billing_mode,
      created_by_admin_id
    ) VALUES (
      'Client@partner-a.example.com', 'Uppercase Email',
      '20000000-0000-4000-a044-000000000001', 'invoiced',
      '90000000-0000-4000-a044-000000000001'
    )
  $$,
  '23514',
  NULL,
  'provisioning email must be canonical lowercase'
);

SELECT throws_ok(
  $$
    INSERT INTO public.partner_client_provisioning_jobs (
      email, requested_business_name, partner_id, billing_mode,
      created_by_admin_id
    ) VALUES (
      'client-two@partner-a.example.com', '   ',
      '20000000-0000-4000-a044-000000000001', 'invoiced',
      '90000000-0000-4000-a044-000000000001'
    )
  $$,
  '23514',
  NULL,
  'provisioning business names cannot be blank'
);

SELECT throws_ok(
  $$
    INSERT INTO public.partner_client_provisioning_jobs (
      email, requested_business_name, partner_id, billing_mode,
      created_by_admin_id
    ) VALUES (
      'client-three@partner-a.example.com', 'Stripe Client',
      '20000000-0000-4000-a044-000000000001', 'stripe',
      '90000000-0000-4000-a044-000000000001'
    )
  $$,
  '23514',
  NULL,
  'provisioning jobs allow only partner-managed billing modes'
);

SELECT throws_ok(
  $$
    INSERT INTO public.partner_client_provisioning_jobs (
      email, requested_business_name, partner_id, billing_mode, partner_plan,
      created_by_admin_id
    ) VALUES (
      'client-four@partner-a.example.com', 'Bad Plan',
      '20000000-0000-4000-a044-000000000001', 'comped', 'enterprise',
      '90000000-0000-4000-a044-000000000001'
    )
  $$,
  '23514',
  NULL,
  'provisioning jobs reject unknown plans'
);

SELECT throws_ok(
  $$
    UPDATE public.partner_client_provisioning_jobs
    SET status = 'complete'
    WHERE id = '40000000-0000-4000-a044-000000000001'
  $$,
  '23514',
  NULL,
  'provisioning jobs reject unknown statuses'
);

SELECT throws_ok(
  $$
    UPDATE public.partner_client_provisioning_jobs
    SET invite_attempt_count = -1
    WHERE id = '40000000-0000-4000-a044-000000000001'
  $$,
  '23514',
  NULL,
  'provisioning invite attempts cannot become negative'
);

SELECT throws_ok(
  $$
    INSERT INTO public.partner_client_provisioning_jobs (
      email, requested_business_name, partner_id, billing_mode,
      created_by_admin_id
    ) VALUES (
      'client@partner-a.example.com', 'Duplicate Email',
      '20000000-0000-4000-a044-000000000001', 'comped',
      '90000000-0000-4000-a044-000000000001'
    )
  $$,
  '23505',
  NULL,
  'provisioning email is unique'
);

SELECT throws_ok(
  $$
    DELETE FROM public.partners
    WHERE id = '20000000-0000-4000-a044-000000000001'
  $$,
  '23503',
  NULL,
  'a referenced provisioning partner cannot be deleted'
);

SET LOCAL ROLE anon;

SELECT throws_ok(
  'SELECT count(*) FROM public.partner_client_provisioning_jobs',
  '42501',
  NULL,
  'anon cannot read provisioning jobs'
);

RESET ROLE;

-- ---------------------------------------------------------------------------
-- Stripe synchronization guard and unchanged Stripe upsert behavior
-- ---------------------------------------------------------------------------

SET LOCAL ROLE service_role;

SELECT results_eq(
  $$
    SELECT public.sync_stripe_subscription_if_business_active(
      '10000000-0000-4000-a044-000000000006',
      'cus_sync_a044',
      'sub_sync_a044',
      'sms_only',
      'active',
      '2026-01-01 00:00:00+00',
      '2026-02-01 00:00:00+00',
      'price_starter_a044',
      'price_setup_a044',
      'cs_sync_a044',
      '2026-01-01 00:00:00+00',
      false,
      '2026-01-01 00:00:00+00'
    )
  $$,
  $$ VALUES (true) $$,
  'Stripe sync still creates a subscription for an active Stripe-mode business'
);

SELECT ok(
  (
    SELECT stripe_customer_id = 'cus_sync_a044'
       AND stripe_subscription_id = 'sub_sync_a044'
       AND plan = 'sms_only'
       AND status = 'active'
       AND stripe_price_id = 'price_starter_a044'
       AND stripe_setup_fee_price_id = 'price_setup_a044'
       AND stripe_checkout_session_id = 'cs_sync_a044'
       AND setup_fee_paid_at = '2026-01-01 00:00:00+00'::timestamptz
       AND NOT cancel_at_period_end
    FROM public.subscriptions
    WHERE business_id = '10000000-0000-4000-a044-000000000006'
  ),
  'Stripe sync preserves the complete original insert behavior'
);

SELECT results_eq(
  $$
    SELECT public.sync_stripe_subscription_if_business_active(
      '10000000-0000-4000-a044-000000000006',
      'cus_sync_a044',
      'sub_sync_a044',
      'sms_and_chat',
      'trialing',
      '2026-02-01 00:00:00+00',
      '2026-03-01 00:00:00+00',
      'price_growth_a044',
      NULL,
      NULL,
      NULL,
      true,
      '2026-02-01 00:00:00+00'
    )
  $$,
  $$ VALUES (true) $$,
  'Stripe sync still updates an existing Stripe-mode subscription'
);

SELECT ok(
  (
    SELECT plan = 'sms_and_chat'
       AND status = 'trialing'
       AND stripe_price_id = 'price_growth_a044'
       AND stripe_setup_fee_price_id = 'price_setup_a044'
       AND stripe_checkout_session_id = 'cs_sync_a044'
       AND setup_fee_paid_at = '2026-01-01 00:00:00+00'::timestamptz
       AND cancel_at_period_end
       AND pending_plan IS NULL
    FROM public.subscriptions
    WHERE business_id = '10000000-0000-4000-a044-000000000006'
  ),
  'Stripe sync keeps original COALESCE and pending-plan reset behavior'
);

SELECT results_eq(
  $$
    SELECT partner_plan
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000007',
      '20000000-0000-4000-a044-000000000002',
      'invoiced',
      '90000000-0000-4000-a044-000000000012',
      'sms_only'
    )
  $$,
  $$ VALUES ('sms_only'::text) $$,
  'a clean business can enter partner mode before a stale Stripe sync'
);

SELECT results_eq(
  $$
    SELECT public.sync_stripe_subscription_if_business_active(
      '10000000-0000-4000-a044-000000000007',
      'cus_partner_sync_a044',
      'sub_partner_sync_a044',
      'sms_only',
      'active',
      now(),
      now() + interval '30 days',
      'price_partner_sync_a044',
      NULL,
      NULL,
      NULL,
      false,
      now()
    )
  $$,
  $$ VALUES (false) $$,
  'Stripe synchronization returns false for a non-Stripe business'
);

SELECT is(
  (
    SELECT count(*)::bigint
    FROM public.subscriptions
    WHERE business_id = '10000000-0000-4000-a044-000000000007'
  ),
  0::bigint,
  'refused non-Stripe synchronization creates no subscription row'
);

SELECT results_eq(
  $$
    SELECT public.sync_stripe_subscription_if_business_active(
      '10000000-0000-4000-a044-000000000009',
      'cus_past_due_a044',
      'sub_past_due_a044',
      'full',
      'active',
      now(),
      now() + interval '30 days',
      'price_full_a044',
      NULL,
      NULL,
      NULL,
      false,
      now()
    )
  $$,
  $$ VALUES (true) $$,
  'a second Stripe fixture receives its active subscription'
);

SELECT results_eq(
  $$
    SELECT public.mark_stripe_subscription_past_due_if_business_active(
      'cus_past_due_a044',
      '2026-03-01 00:00:00+00'
    )
  $$,
  $$ VALUES (true) $$,
  'past-due synchronization still updates a Stripe-mode business'
);

SELECT ok(
  (
    SELECT status = 'past_due'
       AND updated_at = '2026-03-01 00:00:00+00'::timestamptz
    FROM public.subscriptions
    WHERE business_id = '10000000-0000-4000-a044-000000000009'
  ),
  'Stripe-mode past-due synchronization preserves its original mutation'
);

RESET ROLE;

-- Manufacture the impossible state that migration 044 refuses: a business
-- with partner authority and any subscription row. This direct trusted write
-- is test-only and remains inside the rolled-back transaction.
UPDATE public.businesses
SET partner_id = '20000000-0000-4000-a044-000000000002',
    billing_mode = 'invoiced',
    partner_plan = 'sms_only'
WHERE id = '10000000-0000-4000-a044-000000000009';

SET LOCAL ROLE service_role;

SELECT results_eq(
  $$
    SELECT public.mark_stripe_subscription_past_due_if_business_active(
      'cus_past_due_a044',
      '2026-04-01 00:00:00+00'
    )
  $$,
  $$ VALUES (false) $$,
  'past-due synchronization returns false for a non-Stripe business'
);

SELECT ok(
  (
    SELECT status = 'past_due'
       AND updated_at = '2026-03-01 00:00:00+00'::timestamptz
    FROM public.subscriptions
    WHERE business_id = '10000000-0000-4000-a044-000000000009'
  ),
  'refused non-Stripe past-due synchronization mutates nothing'
);

RESET ROLE;

SELECT throws_ok(
  $test$
    DO $body$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM public.businesses AS business
        JOIN public.subscriptions AS subscription
          ON subscription.business_id = business.id
        WHERE business.billing_mode IN ('invoiced', 'comped')
      ) THEN
        RAISE EXCEPTION
          'Migration 044 found a subscription row on a non-Stripe business';
      END IF;
    END;
    $body$
  $test$,
  'P0001',
  'Migration 044 found a subscription row on a non-Stripe business',
  'migration preflight fails rather than reconciling split Stripe and partner authority'
);

-- ---------------------------------------------------------------------------
-- Customer-write guard
-- ---------------------------------------------------------------------------

SELECT set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-a044-000000000001',
  true
);

-- Keep this transaction portable to historical local stacks where the table
-- ACL drifted while the owner policy and guard remained present.
GRANT SELECT, INSERT, UPDATE ON TABLE public.businesses TO authenticated;

SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$
    UPDATE public.businesses
    SET name = 'Partner Plan Primary Renamed'
    WHERE id = '10000000-0000-4000-a044-000000000001'
  $$,
  'an owner can still update an ordinary business field'
);

SELECT throws_ok(
  $$
    UPDATE public.businesses
    SET partner_plan = 'sms_only'
    WHERE id = '10000000-0000-4000-a044-000000000001'
  $$,
  '42501',
  'customer writes cannot change protected business billing fields',
  'an owner cannot change partner_plan'
);

SELECT throws_ok(
  $$
    INSERT INTO public.businesses (
      owner_id, name, business_type, slug, partner_plan
    ) VALUES (
      '00000000-0000-4000-a044-000000000001',
      'Forged Partner Plan',
      'general',
      'forged-partner-plan-a044',
      'sms_and_chat'
    )
  $$,
  '42501',
  'customer writes cannot set protected business billing fields',
  'an owner cannot seed partner_plan on insert'
);

RESET ROLE;

SELECT ok(
  (
    SELECT name = 'Partner Plan Primary Renamed'
       AND billing_mode = 'stripe'
       AND partner_id IS NULL
       AND partner_plan IS NULL
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a044-000000000001'
  ),
  'ordinary owner changes persist while rejected plan changes persist nothing'
);

-- ---------------------------------------------------------------------------
-- Native partner-plan RPC behavior
-- ---------------------------------------------------------------------------

INSERT INTO public.subscriptions (
  business_id,
  stripe_customer_id,
  stripe_subscription_id,
  plan,
  status
) VALUES (
  '10000000-0000-4000-a044-000000000002',
  'cus_partner_a044_canceled',
  'sub_partner_a044_canceled',
  'sms_only',
  'canceled'
);

SET LOCAL ROLE anon;

SELECT throws_ok(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000001',
      NULL,
      'stripe',
      '90000000-0000-4000-a044-000000000001'
    )
  $$,
  '42501',
  NULL,
  'anon cannot execute the assignment RPC through its default argument'
);

RESET ROLE;
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000001',
      NULL,
      'stripe',
      '90000000-0000-4000-a044-000000000001'
    )
  $$,
  '42501',
  NULL,
  'authenticated cannot execute the assignment RPC through its default argument'
);

RESET ROLE;
SET LOCAL ROLE service_role;

SELECT throws_ok(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-999999999999',
      NULL,
      'stripe',
      '90000000-0000-4000-a044-000000000001'
    )
  $$,
  'P0002',
  'business_not_found',
  'the assignment RPC rejects an unknown business'
);

SELECT throws_ok(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000003',
      NULL,
      'stripe',
      '90000000-0000-4000-a044-000000000001'
    )
  $$,
  'P0002',
  'business_not_found',
  'the assignment RPC rejects a soft-deleted business'
);

SELECT throws_ok(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000001',
      NULL,
      'free',
      '90000000-0000-4000-a044-000000000001'
    )
  $$,
  '22023',
  'invalid_billing_mode',
  'the assignment RPC rejects an unknown billing mode'
);

SELECT throws_ok(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000001',
      NULL,
      'stripe',
      NULL
    )
  $$,
  '22004',
  'actor_required',
  'the assignment RPC requires an audit actor'
);

SELECT throws_ok(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000001',
      '20000000-0000-4000-a044-000000000001',
      'invoiced',
      '90000000-0000-4000-a044-000000000001',
      'enterprise'
    )
  $$,
  '22023',
  'invalid_partner_plan',
  'the assignment RPC rejects an unknown partner plan'
);

SELECT throws_ok(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000001',
      NULL,
      'stripe',
      '90000000-0000-4000-a044-000000000001',
      'sms_only'
    )
  $$,
  '22023',
  'invalid_partner_plan',
  'Stripe mode rejects a partner plan'
);

SELECT throws_ok(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000001',
      NULL,
      'invoiced',
      '90000000-0000-4000-a044-000000000001'
    )
  $$,
  '22004',
  'partner_required',
  'non-Stripe assignment requires a partner'
);

SELECT throws_ok(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000001',
      '20000000-0000-4000-a044-999999999999',
      'invoiced',
      '90000000-0000-4000-a044-000000000001'
    )
  $$,
  '55000',
  'partner_inactive',
  'non-Stripe assignment rejects a missing partner'
);

SELECT throws_ok(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000001',
      '20000000-0000-4000-a044-000000000003',
      'comped',
      '90000000-0000-4000-a044-000000000001'
    )
  $$,
  '55000',
  'partner_inactive',
  'non-Stripe assignment rejects an inactive partner'
);

SELECT throws_ok(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000001',
      '20000000-0000-4000-a044-000000000004',
      'invoiced',
      '90000000-0000-4000-a044-000000000001'
    )
  $$,
  '55000',
  'partner_inactive',
  'non-Stripe assignment rejects a pending partner even with a domain'
);

SELECT throws_ok(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000001',
      '20000000-0000-4000-a044-000000000005',
      'invoiced',
      '90000000-0000-4000-a044-000000000001'
    )
  $$,
  '55000',
  'partner_inactive',
  'non-Stripe assignment rejects a disconnected partner'
);

SELECT throws_ok(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000002',
      '20000000-0000-4000-a044-000000000001',
      'invoiced',
      '90000000-0000-4000-a044-000000000001'
    )
  $$,
  '55000',
  'subscription_exists',
  'any subscription row, including canceled, blocks non-Stripe assignment'
);

SELECT ok(
  (
    SELECT billing_mode = 'stripe'
       AND partner_id IS NULL
       AND partner_plan IS NULL
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a044-000000000002'
  ),
  'a rejected subscription conflict changes no billing authority state'
);

-- Seed all legacy flags to prove that entering native partner billing clears
-- each one without using the Phase 1 comp bridge.
UPDATE public.businesses
SET billing_pilot = true,
    billing_comped = true,
    billing_exempt = true
WHERE id = '10000000-0000-4000-a044-000000000001';

SELECT results_eq(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000001',
      '20000000-0000-4000-a044-000000000001',
      'invoiced',
      '90000000-0000-4000-a044-000000000001'
    )
  $$,
  $$
    VALUES (
      '10000000-0000-4000-a044-000000000001'::uuid,
      '20000000-0000-4000-a044-000000000001'::uuid,
      'invoiced'::text,
      'sms_and_chat'::text,
      false
    )
  $$,
  'the four-argument RPC remains compatible and defaults a new assignment to Growth'
);

SELECT ok(
  (
    SELECT partner_plan = 'sms_and_chat'
       AND NOT billing_pilot
       AND NOT billing_comped
       AND NOT billing_exempt
       AND billing_flags_updated_at IS NOT NULL
       AND billing_flags_updated_by =
         '90000000-0000-4000-a044-000000000001'
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a044-000000000001'
  ),
  'native partner billing stores Growth and clears every legacy entitlement flag'
);

SELECT results_eq(
  $$
    SELECT partner_plan, billing_comped
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000001',
      '20000000-0000-4000-a044-000000000001',
      'invoiced',
      '90000000-0000-4000-a044-000000000002',
      'sms_only'
    )
  $$,
  $$ VALUES ('sms_only'::text, false) $$,
  'an explicit Starter assignment is stored without a comp bridge'
);

SELECT results_eq(
  $$
    SELECT partner_plan, billing_comped
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000001',
      '20000000-0000-4000-a044-000000000001',
      'comped',
      '90000000-0000-4000-a044-000000000003',
      'sms_and_chat'
    )
  $$,
  $$ VALUES ('sms_and_chat'::text, false) $$,
  'an explicit Growth assignment is valid in comped mode'
);

SELECT results_eq(
  $$
    SELECT partner_plan, billing_comped
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000001',
      '20000000-0000-4000-a044-000000000001',
      'comped',
      '90000000-0000-4000-a044-000000000004',
      'full'
    )
  $$,
  $$ VALUES ('full'::text, false) $$,
  'an explicit Full assignment is valid in comped mode'
);

SELECT results_eq(
  $$
    SELECT partner_plan, billing_comped
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000001',
      '20000000-0000-4000-a044-000000000001',
      'invoiced',
      '90000000-0000-4000-a044-000000000005'
    )
  $$,
  $$ VALUES ('full'::text, false) $$,
  'same-partner assignment preserves Full when the plan is omitted'
);

SELECT results_eq(
  $$
    SELECT partner_id, partner_plan, billing_comped
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000001',
      '20000000-0000-4000-a044-000000000002',
      'invoiced',
      '90000000-0000-4000-a044-000000000006'
    )
  $$,
  $$
    VALUES (
      '20000000-0000-4000-a044-000000000002'::uuid,
      'sms_and_chat'::text,
      false
    )
  $$,
  'changing partner with an omitted plan resets the assignment to Growth'
);

-- Simulate stale Phase 1 flags on a non-Stripe row so the transition back to
-- Stripe must actively clear them rather than merely preserving false values.
UPDATE public.businesses
SET billing_pilot = true,
    billing_comped = true,
    billing_exempt = true
WHERE id = '10000000-0000-4000-a044-000000000001';

SELECT results_eq(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000001',
      NULL,
      'stripe',
      '90000000-0000-4000-a044-000000000007'
    )
  $$,
  $$
    VALUES (
      '10000000-0000-4000-a044-000000000001'::uuid,
      NULL::uuid,
      'stripe'::text,
      NULL::text,
      false
    )
  $$,
  'returning to Stripe clears partner assignment and plan terms'
);

SELECT ok(
  (
    SELECT NOT billing_pilot
       AND NOT billing_comped
       AND NOT billing_exempt
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a044-000000000001'
  ),
  'leaving non-Stripe mode actively clears all stale legacy entitlement flags'
);

UPDATE public.businesses
SET billing_pilot = true,
    billing_comped = true,
    billing_exempt = true,
    billing_flags_updated_by = 'legacy-stripe-save'
WHERE id = '10000000-0000-4000-a044-000000000001';

SELECT results_eq(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000001',
      NULL,
      'stripe',
      '90000000-0000-4000-a044-000000000008'
    )
  $$,
  $$
    VALUES (
      '10000000-0000-4000-a044-000000000001'::uuid,
      NULL::uuid,
      'stripe'::text,
      NULL::text,
      true
    )
  $$,
  'an unrelated Stripe-mode save preserves a legacy comp override'
);

SELECT ok(
  (
    SELECT billing_pilot
       AND billing_comped
       AND billing_exempt
       AND partner_plan IS NULL
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a044-000000000001'
  ),
  'Stripe-to-Stripe assignment preserves every unrelated legacy flag'
);

SELECT results_eq(
  $$
    SELECT partner_plan, billing_comped
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000008',
      '20000000-0000-4000-a044-000000000006',
      'comped',
      '90000000-0000-4000-a044-000000000009',
      'full'
    )
  $$,
  $$ VALUES ('full'::text, false) $$,
  'the disposable partner can own a native Full assignment'
);

SELECT lives_ok(
  $$
    DELETE FROM public.partners
    WHERE id = '20000000-0000-4000-a044-000000000006'
  $$,
  'deleting an unreferenced provisioning partner preserves its assigned business'
);

SELECT ok(
  (
    SELECT partner_id IS NULL
       AND billing_mode = 'comped'
       AND partner_plan = 'full'
       AND NOT billing_pilot
       AND NOT billing_comped
       AND NOT billing_exempt
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a044-000000000008'
  ),
  'partner deletion leaves an orphaned non-Stripe plan without legacy flags'
);

SELECT throws_ok(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000007',
      '20000000-0000-4000-a044-000000000006',
      'invoiced',
      '90000000-0000-4000-a044-000000000010'
    )
  $$,
  '55000',
  'partner_inactive',
  'a deleted partner cannot be assigned'
);

RESET ROLE;

-- Corrupt a fixture only after catalog checks to prove the RPC revalidates
-- stored domain data at its read boundary, independent of write constraints.
ALTER TABLE public.partners
  DROP CONSTRAINT partners_custom_domain_canonical;

UPDATE public.partners
SET custom_domain = 'https://malformed.example.com/path'
WHERE id = '20000000-0000-4000-a044-000000000007';

SET LOCAL ROLE service_role;

SELECT throws_ok(
  $$
    SELECT *
    FROM public.assign_business_partner_billing(
      '10000000-0000-4000-a044-000000000007',
      '20000000-0000-4000-a044-000000000007',
      'invoiced',
      '90000000-0000-4000-a044-000000000011'
    )
  $$,
  '55000',
  'partner_inactive',
  'the assignment RPC rejects malformed stored partner domains'
);

RESET ROLE;

SET LOCAL ROLE authenticated;

SELECT throws_ok(
  'SELECT count(*) FROM public.partner_client_provisioning_jobs',
  '42501',
  NULL,
  'authenticated cannot read provisioning jobs'
);

RESET ROLE;
SET LOCAL ROLE service_role;

SELECT lives_ok(
  $$
    INSERT INTO public.partner_client_provisioning_jobs (
      id, email, requested_business_name, partner_id, billing_mode,
      created_by_admin_id
    ) VALUES (
      '40000000-0000-4000-a044-000000000009',
      'service-crud@partner-b.example.com',
      'Service CRUD',
      '20000000-0000-4000-a044-000000000002',
      'comped',
      '90000000-0000-4000-a044-000000000001'
    );

    UPDATE public.partner_client_provisioning_jobs
    SET status = 'admin_setup'
    WHERE id = '40000000-0000-4000-a044-000000000009';

    DELETE FROM public.partner_client_provisioning_jobs
    WHERE id = '40000000-0000-4000-a044-000000000009';
  $$,
  'service_role can perform every granted provisioning CRUD operation'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
