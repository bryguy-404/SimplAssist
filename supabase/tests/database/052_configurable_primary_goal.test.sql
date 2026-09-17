BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SET LOCAL search_path = public, extensions;

SELECT plan(68);

-- ---------------------------------------------------------------------------
-- Catalog and authorization contract
-- ---------------------------------------------------------------------------

-- 1
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
      AND attribute.attname = 'primary_goal'
  )
  AND (
    SELECT format_type(attribute.atttypid, attribute.atttypmod) = 'text'
       AND NOT attribute.attnotnull
       AND default_value.oid IS NULL
    FROM pg_attribute AS attribute
    LEFT JOIN pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.businesses'::regclass
      AND attribute.attname = 'goal_url'
  ),
  'business goals are nullable text columns with intentionally no defaults'
);

-- 2
SELECT is(
  (
    SELECT count(*)::integer
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.businesses'::regclass
      AND constraint_row.conname IN (
        'businesses_primary_goal_check',
        'businesses_goal_url_https_check',
        'businesses_signup_goal_url_required',
        'businesses_scrubbed_goal_url_null'
      )
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
  ),
  4,
  'all business goal checks exist and are validated'
);

-- 3
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.businesses'::regclass
      AND trigger_row.tgname = 'scrub_business_goal_url_on_cleanup'
      AND NOT trigger_row.tgisinternal
  )
  AND (
    SELECT NOT procedure_row.prosecdef
       AND procedure_row.proconfig @> ARRAY['search_path=public, pg_temp']
    FROM pg_proc AS procedure_row
    WHERE procedure_row.oid =
      'public.scrub_business_goal_url_on_cleanup()'::regprocedure
  )
  AND NOT has_function_privilege(
    'anon',
    'public.scrub_business_goal_url_on_cleanup()',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.scrub_business_goal_url_on_cleanup()',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'service_role',
    'public.scrub_business_goal_url_on_cleanup()',
    'EXECUTE'
  ),
  'cleanup scrubbing is an invoker trigger with a fixed, non-callable boundary'
);

-- 4
SELECT has_table(
  'public',
  'goal_events',
  'goal events have an authoritative ledger table'
);

-- 5
SELECT is(
  (
    SELECT jsonb_object_agg(
      attribute.attname,
      format_type(attribute.atttypid, attribute.atttypmod)
    )
    FROM pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.goal_events'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ),
  jsonb_build_object(
    'id', 'uuid',
    'business_id', 'uuid',
    'contact_id', 'uuid',
    'conversation_id', 'uuid',
    'source_message_id', 'uuid',
    'assistant_message_id', 'uuid',
    'goal_at_event', 'text',
    'event_type', 'text',
    'channel', 'text',
    'occurred_at', 'timestamp with time zone',
    'idempotency_key', 'text',
    'created_at', 'timestamp with time zone',
    'origin_kind', 'text',
    'voice_action_id', 'uuid',
    'source_conversation_id', 'uuid',
    'time_source', 'text'
  ),
  'goal events expose exactly the approved column types'
);

-- 6
SELECT is(
  (
    SELECT array_agg(attribute.attname ORDER BY attribute.attname)
    FROM pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.goal_events'::regclass
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ),
  ARRAY[
    'business_id',
    'channel',
    'created_at',
    'event_type',
    'goal_at_event',
    'id',
    'idempotency_key',
    'occurred_at',
    'origin_kind',
    'time_source'
  ]::name[],
  'only durable event fields are required after provenance retention'
);

-- 7
SELECT ok(
  (
    SELECT pg_get_expr(default_value.adbin, default_value.adrelid)
      = 'gen_random_uuid()'
    FROM pg_attribute AS attribute
    JOIN pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.goal_events'::regclass
      AND attribute.attname = 'id'
  )
  AND (
    SELECT pg_get_expr(default_value.adbin, default_value.adrelid) = 'now()'
    FROM pg_attribute AS attribute
    JOIN pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.goal_events'::regclass
      AND attribute.attname = 'created_at'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_attribute AS attribute
    JOIN pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.goal_events'::regclass
      AND attribute.attname IN ('occurred_at', 'event_type')
  ),
  'event identity and insertion time default while action time and type are explicit'
);

-- 8
SELECT is(
  (
    SELECT count(*)::integer
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.goal_events'::regclass
      AND constraint_row.conname IN (
        'goal_events_goal_check',
        'goal_events_type_check',
        'goal_events_channel_check',
        'goal_events_link_sent_goal_check',
        'goal_events_idempotency_key_check'
      )
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
  ),
  5,
  'all event vocabulary and shape checks exist and are validated'
);

-- 9
SELECT is(
  (
    SELECT array_agg(
      constraint_row.conname || ':' || constraint_row.confdeltype::text
      ORDER BY constraint_row.conname
    )
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.goal_events'::regclass
      AND constraint_row.contype = 'f'
  ),
  ARRAY[
    'goal_events_assistant_message_id_fkey:n',
    'goal_events_business_id_fkey:c',
    'goal_events_contact_id_fkey:n',
    'goal_events_conversation_id_fkey:n',
    'goal_events_source_conversation_id_fkey:n',
    'goal_events_source_message_id_fkey:n',
    'goal_events_voice_action_id_fkey:n'
  ]::text[],
  'business deletion cascades while provenance deletions retain events'
);

-- 10
SELECT is(
  (
    SELECT count(*)::integer
    FROM pg_class AS index_class
    JOIN pg_index AS index_row
      ON index_row.indexrelid = index_class.oid
    WHERE index_row.indrelid = 'public.goal_events'::regclass
      AND index_class.relname IN (
        'goal_events_business_idempotency_unique',
        'goal_events_assistant_type_unique',
        'goal_events_business_occurred_idx',
        'goal_events_contact_idx',
        'goal_events_conversation_idx',
        'goal_events_source_message_idx'
      )
  ),
  6,
  'all idempotency, dashboard, and retention indexes exist'
);

-- 11
SELECT ok(
  pg_get_indexdef(
    'public.goal_events_business_occurred_idx'::regclass
  ) LIKE '%(business_id, occurred_at DESC, id DESC)',
  'the dashboard index supports stable newest-first business reads'
);

-- 12
SELECT ok(
  (
    SELECT class_row.relrowsecurity
    FROM pg_class AS class_row
    WHERE class_row.oid = 'public.goal_events'::regclass
  ),
  'goal events have row-level security enabled'
);

-- 13
SELECT ok(
  (
    SELECT count(*) = 1
       AND bool_and(policy_row.polname = 'goal_events_select')
       AND bool_and(
         policy_row.polroles = ARRAY[
           (SELECT oid FROM pg_roles WHERE rolname = 'authenticated')
         ]
       )
    FROM pg_policy AS policy_row
    WHERE policy_row.polrelid = 'public.goal_events'::regclass
  ),
  'goal events expose exactly one authenticated owner-select policy'
);

-- 14
SELECT ok(
  has_table_privilege('authenticated', 'public.goal_events', 'SELECT')
  AND NOT has_table_privilege(
    'authenticated', 'public.goal_events', 'INSERT'
  )
  AND NOT has_table_privilege(
    'authenticated', 'public.goal_events', 'UPDATE'
  )
  AND NOT has_table_privilege(
    'authenticated', 'public.goal_events', 'DELETE'
  ),
  'authenticated owners receive read-only table privileges'
);

-- 15
SELECT ok(
  has_table_privilege('service_role', 'public.goal_events', 'SELECT')
  AND has_table_privilege('service_role', 'public.goal_events', 'INSERT')
  AND NOT has_table_privilege(
    'service_role', 'public.goal_events', 'UPDATE'
  )
  AND NOT has_table_privilege(
    'service_role', 'public.goal_events', 'DELETE'
  )
  AND NOT has_table_privilege('anon', 'public.goal_events', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.goal_events', 'INSERT')
  AND NOT has_table_privilege('anon', 'public.goal_events', 'UPDATE')
  AND NOT has_table_privilege('anon', 'public.goal_events', 'DELETE'),
  'service role is append/read only and anonymous clients have no access'
);

-- 16
SELECT ok(
  (
    SELECT count(*) = 8
       AND count(*) FILTER (WHERE procedure_row.prosecdef) = 6
       AND bool_and(
         procedure_row.proconfig @> ARRAY['search_path=public, pg_temp']
       )
       AND bool_and(
         NOT has_function_privilege(
           'anon', procedure_row.oid, 'EXECUTE'
         )
       )
       AND bool_and(
         NOT has_function_privilege(
           'authenticated', procedure_row.oid, 'EXECUTE'
         )
       )
       AND bool_and(
         NOT has_function_privilege(
           'service_role', procedure_row.oid, 'EXECUTE'
         )
       )
    FROM pg_proc AS procedure_row
    WHERE procedure_row.pronamespace = 'public'::regnamespace
      AND procedure_row.proname IN (
        'scrub_business_goal_url_on_cleanup',
        'validate_goal_event_tenant',
        'guard_goal_event_mutation',
        'guard_contact_goal_event_linkage',
        'guard_conversation_goal_event_linkage',
        'guard_message_goal_event_linkage',
        'unlink_goal_events_before_conversation_delete',
        'unlink_goal_events_before_contact_delete'
      )
  ),
  'all goal helper functions pin search_path and deny direct API execution'
);

-- ---------------------------------------------------------------------------
-- Explicit-choice and URL behavior
-- ---------------------------------------------------------------------------

INSERT INTO auth.users (id, email)
VALUES
  (
    '00000000-0000-4000-a052-000000000001',
    'goal-owner-a-052@example.test'
  ),
  (
    '00000000-0000-4000-a052-000000000002',
    'goal-owner-b-052@example.test'
  );

UPDATE public.businesses
SET id = '10000000-0000-4000-a052-000000000001',
    name = 'Goal Business A 052',
    slug = 'goal-business-a-052'
WHERE owner_id = '00000000-0000-4000-a052-000000000001';

UPDATE public.businesses
SET id = '10000000-0000-4000-a052-000000000002',
    name = 'Goal Business B 052',
    slug = 'goal-business-b-052'
WHERE owner_id = '00000000-0000-4000-a052-000000000002';

-- 17
SELECT ok(
  (
    SELECT count(*) = 2
       AND bool_and(primary_goal IS NULL)
       AND bool_and(goal_url IS NULL)
    FROM public.businesses
    WHERE owner_id IN (
      '00000000-0000-4000-a052-000000000001',
      '00000000-0000-4000-a052-000000000002'
    )
  ),
  'Auth-created businesses begin with an unanswered goal and no URL'
);

UPDATE public.businesses
SET name = 'Goal Business A Renamed 052'
WHERE id = '10000000-0000-4000-a052-000000000001';

-- 18
SELECT results_eq(
  $$
    SELECT primary_goal, goal_url
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a052-000000000001'
  $$,
  $$ VALUES (NULL::text, NULL::text) $$,
  'a provisioning-style name update does not manufacture a goal choice'
);

INSERT INTO public.businesses (
  id,
  name,
  business_type,
  slug
) VALUES (
  '10000000-0000-4000-a052-000000000003',
  'Direct Goal Business 052',
  'general',
  'direct-goal-business-052'
);

-- 19
SELECT results_eq(
  $$
    SELECT primary_goal, goal_url
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a052-000000000003'
  $$,
  $$ VALUES (NULL::text, NULL::text) $$,
  'post-migration direct business inserts also require explicit choice'
);

-- 20
SELECT lives_ok(
  $$
    UPDATE public.businesses
    SET primary_goal = 'book', goal_url = NULL
    WHERE id = '10000000-0000-4000-a052-000000000001';

    UPDATE public.businesses
    SET primary_goal = 'quote', goal_url = NULL
    WHERE id = '10000000-0000-4000-a052-000000000001';

    UPDATE public.businesses
    SET primary_goal = 'callback', goal_url = NULL
    WHERE id = '10000000-0000-4000-a052-000000000001';

    UPDATE public.businesses
    SET primary_goal = 'signup',
        goal_url = 'https://example.test/signup'
    WHERE id = '10000000-0000-4000-a052-000000000001'
  $$,
  'the schema accepts all four goals and an atomic signup destination'
);

-- 21
SELECT throws_ok(
  $$
    UPDATE public.businesses
    SET primary_goal = 'purchase'
    WHERE id = '10000000-0000-4000-a052-000000000001'
  $$,
  '23514',
  NULL,
  'unknown goals are rejected'
);

-- 22
SELECT throws_ok(
  $$
    UPDATE public.businesses
    SET primary_goal = 'signup', goal_url = NULL
    WHERE id = '10000000-0000-4000-a052-000000000001'
  $$,
  '23514',
  NULL,
  'active signup goals require a URL'
);

-- 23
SELECT throws_ok(
  $$
    UPDATE public.businesses
    SET primary_goal = 'signup', goal_url = 'http://example.test/signup'
    WHERE id = '10000000-0000-4000-a052-000000000001'
  $$,
  '23514',
  NULL,
  'signup URLs require HTTPS'
);

-- 24
SELECT throws_ok(
  $$
    UPDATE public.businesses
    SET primary_goal = 'signup', goal_url = 'https://'
    WHERE id = '10000000-0000-4000-a052-000000000001'
  $$,
  '23514',
  NULL,
  'signup URLs require a nonempty authority'
);

-- 25
SELECT throws_ok(
  $$
    UPDATE public.businesses
    SET primary_goal = 'signup',
        goal_url = ' https://example.test/signup '
    WHERE id = '10000000-0000-4000-a052-000000000001'
  $$,
  '23514',
  NULL,
  'signup URLs reject surrounding whitespace'
);

-- 26
SELECT throws_ok(
  $$
    UPDATE public.businesses
    SET primary_goal = 'signup',
        goal_url = 'https://example.test/' || repeat('x', 2028)
    WHERE id = '10000000-0000-4000-a052-000000000001'
  $$,
  '23514',
  NULL,
  'signup URLs reject values longer than 2048 characters'
);

-- 27
SELECT lives_ok(
  $$
    UPDATE public.businesses
    SET primary_goal = 'signup',
        goal_url = 'https://example.test/path?source=ai#signup'
    WHERE id = '10000000-0000-4000-a052-000000000001'
  $$,
  'valid HTTPS paths, queries, and fragments persist atomically'
);

UPDATE public.businesses
SET primary_goal = 'signup',
    goal_url = 'https://cleanup.example.test/signup'
WHERE id = '10000000-0000-4000-a052-000000000003';

UPDATE public.businesses
SET cleanup_pii_scrubbed_at = now()
WHERE id = '10000000-0000-4000-a052-000000000003';

-- 28
SELECT results_eq(
  $$
    SELECT primary_goal, goal_url, cleanup_pii_scrubbed_at IS NOT NULL
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a052-000000000003'
  $$,
  $$ VALUES ('signup'::text, NULL::text, true) $$,
  'permanent cleanup retains the categorical goal and scrubs its URL'
);

-- ---------------------------------------------------------------------------
-- Goal-event fixtures and insert contract
-- ---------------------------------------------------------------------------

UPDATE public.businesses
SET primary_goal = 'signup',
    goal_url = 'https://example.test/a'
WHERE id = '10000000-0000-4000-a052-000000000001';

UPDATE public.businesses
SET primary_goal = 'signup',
    goal_url = 'https://example.test/b'
WHERE id = '10000000-0000-4000-a052-000000000002';

INSERT INTO public.contacts (
  id,
  business_id,
  name,
  email,
  source_channel
) VALUES
  (
    '20000000-0000-4000-a052-000000000001',
    '10000000-0000-4000-a052-000000000001',
    'Goal Contact A1',
    'goal-a1@example.test',
    'web_chat'
  ),
  (
    '20000000-0000-4000-a052-000000000002',
    '10000000-0000-4000-a052-000000000001',
    'Goal Contact A2',
    'goal-a2@example.test',
    'web_chat'
  ),
  (
    '20000000-0000-4000-a052-000000000003',
    '10000000-0000-4000-a052-000000000001',
    'Goal Contact A3',
    'goal-a3@example.test',
    'web_chat'
  ),
  (
    '20000000-0000-4000-a052-000000000004',
    NULL,
    'Goal Contact B1',
    NULL,
    'web_chat'
  );

-- Keep the hard-delete fixture free of the pre-existing immutable metrics
-- ledger: its contact-created hook intentionally ignores an initially
-- unassigned contact, and linkage is completed before any goal event exists.
UPDATE public.contacts
SET business_id = '10000000-0000-4000-a052-000000000002'
WHERE id = '20000000-0000-4000-a052-000000000004';

INSERT INTO public.conversations (
  id,
  business_id,
  contact_id,
  channel
) VALUES
  (
    '30000000-0000-4000-a052-000000000001',
    '10000000-0000-4000-a052-000000000001',
    '20000000-0000-4000-a052-000000000001',
    'web_chat'
  ),
  (
    '30000000-0000-4000-a052-000000000002',
    '10000000-0000-4000-a052-000000000001',
    '20000000-0000-4000-a052-000000000002',
    'web_chat'
  ),
  (
    '30000000-0000-4000-a052-000000000003',
    '10000000-0000-4000-a052-000000000001',
    '20000000-0000-4000-a052-000000000003',
    'web_chat'
  ),
  (
    '30000000-0000-4000-a052-000000000004',
    '10000000-0000-4000-a052-000000000002',
    '20000000-0000-4000-a052-000000000004',
    'web_chat'
  );

INSERT INTO public.messages (
  id,
  conversation_id,
  business_id,
  role,
  content,
  channel
) VALUES
  (
    '40000000-0000-4000-a052-000000000001',
    '30000000-0000-4000-a052-000000000001',
    '10000000-0000-4000-a052-000000000001',
    'customer',
    'How do I sign up?',
    'web_chat'
  ),
  (
    '40000000-0000-4000-a052-000000000002',
    '30000000-0000-4000-a052-000000000001',
    '10000000-0000-4000-a052-000000000001',
    'assistant',
    'You can sign up using our link.',
    'web_chat'
  ),
  (
    '40000000-0000-4000-a052-000000000003',
    '30000000-0000-4000-a052-000000000002',
    '10000000-0000-4000-a052-000000000001',
    'customer',
    'Please send the signup page.',
    'web_chat'
  ),
  (
    '40000000-0000-4000-a052-000000000004',
    '30000000-0000-4000-a052-000000000002',
    '10000000-0000-4000-a052-000000000001',
    'assistant',
    'Here is the signup page.',
    'web_chat'
  ),
  (
    '40000000-0000-4000-a052-000000000005',
    '30000000-0000-4000-a052-000000000003',
    '10000000-0000-4000-a052-000000000001',
    'customer',
    'Where is registration?',
    'web_chat'
  ),
  (
    '40000000-0000-4000-a052-000000000006',
    '30000000-0000-4000-a052-000000000003',
    '10000000-0000-4000-a052-000000000001',
    'assistant',
    'Registration is available here.',
    'web_chat'
  ),
  (
    '40000000-0000-4000-a052-000000000007',
    '30000000-0000-4000-a052-000000000004',
    '10000000-0000-4000-a052-000000000002',
    'customer',
    'Can I enroll?',
    'web_chat'
  ),
  (
    '40000000-0000-4000-a052-000000000008',
    '30000000-0000-4000-a052-000000000004',
    '10000000-0000-4000-a052-000000000002',
    'assistant',
    'Use this enrollment link.',
    'web_chat'
  );

SET LOCAL ROLE service_role;

-- 29
SELECT lives_ok(
  $$
    INSERT INTO public.goal_events (
      id,
      business_id,
      contact_id,
      conversation_id,
      source_message_id,
      assistant_message_id,
      goal_at_event,
      event_type,
      channel,
      occurred_at,
      idempotency_key
    ) VALUES (
      '50000000-0000-4000-a052-000000000001',
      '10000000-0000-4000-a052-000000000001',
      '20000000-0000-4000-a052-000000000001',
      '30000000-0000-4000-a052-000000000001',
      '40000000-0000-4000-a052-000000000001',
      '40000000-0000-4000-a052-000000000002',
      'signup',
      'link_sent',
      'web_chat',
      '2052-01-01 12:00:00+00',
      'goal-link:a1:052'
    )
  $$,
  'service role can finalize a fully linked signup event'
);

INSERT INTO public.goal_events (
  id,
  business_id,
  contact_id,
  conversation_id,
  source_message_id,
  assistant_message_id,
  goal_at_event,
  event_type,
  channel,
  occurred_at,
  idempotency_key
) VALUES
  (
    '50000000-0000-4000-a052-000000000002',
    '10000000-0000-4000-a052-000000000001',
    '20000000-0000-4000-a052-000000000002',
    '30000000-0000-4000-a052-000000000002',
    '40000000-0000-4000-a052-000000000003',
    '40000000-0000-4000-a052-000000000004',
    'signup',
    'link_sent',
    'web_chat',
    '2052-01-02 12:00:00+00',
    'goal-link:a2:052'
  ),
  (
    '50000000-0000-4000-a052-000000000003',
    '10000000-0000-4000-a052-000000000001',
    '20000000-0000-4000-a052-000000000003',
    '30000000-0000-4000-a052-000000000003',
    '40000000-0000-4000-a052-000000000005',
    '40000000-0000-4000-a052-000000000006',
    'signup',
    'link_sent',
    'web_chat',
    '2052-01-03 12:00:00+00',
    'goal-link:a3:052'
  ),
  (
    '50000000-0000-4000-a052-000000000004',
    '10000000-0000-4000-a052-000000000002',
    '20000000-0000-4000-a052-000000000004',
    '30000000-0000-4000-a052-000000000004',
    '40000000-0000-4000-a052-000000000007',
    '40000000-0000-4000-a052-000000000008',
    'signup',
    'link_sent',
    'web_chat',
    '2052-01-04 12:00:00+00',
    'goal-link:b1:052'
  );

RESET ROLE;

-- 30
SELECT results_eq(
  $$
    SELECT
      business_id,
      contact_id,
      conversation_id,
      source_message_id,
      assistant_message_id,
      goal_at_event,
      event_type,
      channel,
      occurred_at,
      idempotency_key
    FROM public.goal_events
    WHERE id = '50000000-0000-4000-a052-000000000001'
  $$,
  $$
    VALUES (
      '10000000-0000-4000-a052-000000000001'::uuid,
      '20000000-0000-4000-a052-000000000001'::uuid,
      '30000000-0000-4000-a052-000000000001'::uuid,
      '40000000-0000-4000-a052-000000000001'::uuid,
      '40000000-0000-4000-a052-000000000002'::uuid,
      'signup'::text,
      'link_sent'::text,
      'web_chat'::text,
      '2052-01-01 12:00:00+00'::timestamptz,
      'goal-link:a1:052'::text
    )
  $$,
  'a finalized event preserves its complete event-time contract'
);

-- 31
SELECT throws_ok(
  $$
    INSERT INTO public.goal_events (
      business_id,
      goal_at_event,
      event_type,
      channel,
      occurred_at,
      idempotency_key
    ) VALUES (
      '10000000-0000-4000-a052-000000000001',
      'signup',
      'link_sent',
      'web_chat',
      now(),
      'goal-link:missing:052'
    )
  $$,
  '23514',
  'goal event requires contact, conversation, source message, and assistant message linkage',
  'events cannot be finalized before complete message provenance exists'
);

-- 32
SELECT throws_ok(
  $$
    INSERT INTO public.goal_events (
      business_id,
      contact_id,
      conversation_id,
      source_message_id,
      assistant_message_id,
      goal_at_event,
      event_type,
      channel,
      occurred_at,
      idempotency_key
    ) VALUES (
      '10000000-0000-4000-a052-000000000001',
      '20000000-0000-4000-a052-000000000004',
      '30000000-0000-4000-a052-000000000001',
      '40000000-0000-4000-a052-000000000001',
      '40000000-0000-4000-a052-000000000002',
      'signup',
      'link_sent',
      'web_chat',
      now(),
      'goal-link:foreign-contact:052'
    )
  $$,
  '23514',
  'goal event contact tenant mismatch',
  'events reject contacts from another business'
);

-- 33
SELECT throws_ok(
  $$
    INSERT INTO public.goal_events (
      business_id,
      contact_id,
      conversation_id,
      source_message_id,
      assistant_message_id,
      goal_at_event,
      event_type,
      channel,
      occurred_at,
      idempotency_key
    ) VALUES (
      '10000000-0000-4000-a052-000000000001',
      '20000000-0000-4000-a052-000000000001',
      '30000000-0000-4000-a052-000000000004',
      '40000000-0000-4000-a052-000000000007',
      '40000000-0000-4000-a052-000000000008',
      'signup',
      'link_sent',
      'web_chat',
      now(),
      'goal-link:foreign-conversation:052'
    )
  $$,
  '23514',
  'goal event conversation tenant mismatch',
  'events reject conversations from another business or contact'
);

-- 34
SELECT throws_ok(
  $$
    INSERT INTO public.goal_events (
      business_id,
      contact_id,
      conversation_id,
      source_message_id,
      assistant_message_id,
      goal_at_event,
      event_type,
      channel,
      occurred_at,
      idempotency_key
    ) VALUES (
      '10000000-0000-4000-a052-000000000001',
      '20000000-0000-4000-a052-000000000001',
      '30000000-0000-4000-a052-000000000001',
      '40000000-0000-4000-a052-000000000002',
      '40000000-0000-4000-a052-000000000002',
      'signup',
      'link_sent',
      'web_chat',
      now(),
      'goal-link:assistant-as-source:052'
    )
  $$,
  '23514',
  'goal event source message tenant mismatch',
  'source provenance must reference a customer message'
);

-- 35
SELECT throws_ok(
  $$
    INSERT INTO public.goal_events (
      business_id,
      contact_id,
      conversation_id,
      source_message_id,
      assistant_message_id,
      goal_at_event,
      event_type,
      channel,
      occurred_at,
      idempotency_key
    ) VALUES (
      '10000000-0000-4000-a052-000000000001',
      '20000000-0000-4000-a052-000000000001',
      '30000000-0000-4000-a052-000000000001',
      '40000000-0000-4000-a052-000000000001',
      '40000000-0000-4000-a052-000000000001',
      'signup',
      'link_sent',
      'web_chat',
      now(),
      'goal-link:customer-as-assistant:052'
    )
  $$,
  '23514',
  'goal event assistant message tenant mismatch',
  'assistant provenance must reference an assistant message'
);

-- 36
SELECT throws_ok(
  $$
    INSERT INTO public.goal_events (
      business_id,
      contact_id,
      conversation_id,
      source_message_id,
      assistant_message_id,
      goal_at_event,
      event_type,
      channel,
      occurred_at,
      idempotency_key
    ) VALUES (
      '10000000-0000-4000-a052-000000000001',
      '20000000-0000-4000-a052-000000000001',
      '30000000-0000-4000-a052-000000000001',
      '40000000-0000-4000-a052-000000000001',
      '40000000-0000-4000-a052-000000000002',
      'signup',
      'link_sent',
      'sms',
      now(),
      'goal-link:wrong-channel:052'
    )
  $$,
  '23514',
  'goal event conversation tenant mismatch',
  'event channel must match its conversation and messages'
);

-- 37
SELECT throws_ok(
  $$
    INSERT INTO public.goal_events (
      business_id,
      contact_id,
      conversation_id,
      source_message_id,
      assistant_message_id,
      goal_at_event,
      event_type,
      channel,
      occurred_at,
      idempotency_key
    ) VALUES (
      '10000000-0000-4000-a052-000000000001',
      '20000000-0000-4000-a052-000000000001',
      '30000000-0000-4000-a052-000000000001',
      '40000000-0000-4000-a052-000000000001',
      '40000000-0000-4000-a052-000000000002',
      'book',
      'link_sent',
      'web_chat',
      now(),
      'goal-link:book:052'
    )
  $$,
  '23514',
  NULL,
  'v1 link events can only snapshot the signup goal'
);

-- 38
SELECT throws_ok(
  $$
    INSERT INTO public.goal_events (
      business_id,
      contact_id,
      conversation_id,
      source_message_id,
      assistant_message_id,
      goal_at_event,
      event_type,
      channel,
      occurred_at,
      idempotency_key
    ) VALUES (
      '10000000-0000-4000-a052-000000000001',
      '20000000-0000-4000-a052-000000000001',
      '30000000-0000-4000-a052-000000000001',
      '40000000-0000-4000-a052-000000000001',
      '40000000-0000-4000-a052-000000000002',
      'signup',
      'quote_requested',
      'web_chat',
      now(),
      'goal-link:future-type:052'
    )
  $$,
  '23514',
  NULL,
  'deferred event types cannot be recorded in v1'
);

-- 39
SELECT throws_ok(
  $$
    INSERT INTO public.goal_events (
      business_id,
      contact_id,
      conversation_id,
      source_message_id,
      assistant_message_id,
      goal_at_event,
      event_type,
      channel,
      occurred_at,
      idempotency_key
    ) VALUES (
      '10000000-0000-4000-a052-000000000001',
      '20000000-0000-4000-a052-000000000001',
      '30000000-0000-4000-a052-000000000001',
      '40000000-0000-4000-a052-000000000001',
      '40000000-0000-4000-a052-000000000002',
      'signup',
      'link_sent',
      'email',
      now(),
      'goal-link:email:052'
    )
  $$,
  '23514',
  NULL,
  'goal events accept only the shared conversation channels'
);

-- 40
SELECT throws_ok(
  $$
    INSERT INTO public.goal_events (
      business_id,
      contact_id,
      conversation_id,
      source_message_id,
      assistant_message_id,
      goal_at_event,
      event_type,
      channel,
      occurred_at,
      idempotency_key
    ) VALUES (
      '10000000-0000-4000-a052-000000000001',
      '20000000-0000-4000-a052-000000000001',
      '30000000-0000-4000-a052-000000000001',
      '40000000-0000-4000-a052-000000000001',
      '40000000-0000-4000-a052-000000000002',
      'signup',
      'link_sent',
      'web_chat',
      now(),
      '   '
    )
  $$,
  '23514',
  NULL,
  'idempotency keys cannot be blank or untrimmed'
);

-- 41
SELECT throws_ok(
  $$
    INSERT INTO public.goal_events (
      business_id,
      contact_id,
      conversation_id,
      source_message_id,
      assistant_message_id,
      goal_at_event,
      event_type,
      channel,
      occurred_at,
      idempotency_key
    ) VALUES (
      '10000000-0000-4000-a052-000000000001',
      '20000000-0000-4000-a052-000000000002',
      '30000000-0000-4000-a052-000000000002',
      '40000000-0000-4000-a052-000000000003',
      '40000000-0000-4000-a052-000000000004',
      'signup',
      'link_sent',
      'web_chat',
      now(),
      'goal-link:a1:052'
    )
  $$,
  '23505',
  NULL,
  'a business cannot finalize the same idempotency key twice'
);

-- 42
SELECT throws_ok(
  $$
    INSERT INTO public.goal_events (
      business_id,
      contact_id,
      conversation_id,
      source_message_id,
      assistant_message_id,
      goal_at_event,
      event_type,
      channel,
      occurred_at,
      idempotency_key
    ) VALUES (
      '10000000-0000-4000-a052-000000000001',
      '20000000-0000-4000-a052-000000000001',
      '30000000-0000-4000-a052-000000000001',
      '40000000-0000-4000-a052-000000000001',
      '40000000-0000-4000-a052-000000000002',
      'signup',
      'link_sent',
      'web_chat',
      now(),
      'goal-link:same-assistant:052'
    )
  $$,
  '23505',
  NULL,
  'one assistant message cannot produce duplicate link events'
);

UPDATE public.businesses
SET primary_goal = 'book'
WHERE id = '10000000-0000-4000-a052-000000000001';

-- 43
SELECT is(
  (
    SELECT goal_at_event
    FROM public.goal_events
    WHERE id = '50000000-0000-4000-a052-000000000001'
  ),
  'signup',
  'later Settings changes do not reinterpret historical event goals'
);

-- 44
SELECT throws_ok(
  $$
    UPDATE public.goal_events
    SET goal_at_event = 'book'
    WHERE id = '50000000-0000-4000-a052-000000000001'
  $$,
  '55000',
  'goal event history is immutable; retained linkages may only be cleared',
  'core event history cannot be rewritten'
);

-- 45
SELECT throws_ok(
  $$
    UPDATE public.contacts
    SET business_id = '10000000-0000-4000-a052-000000000002'
    WHERE id = '20000000-0000-4000-a052-000000000001'
  $$,
  '23514',
  'contact linkage is immutable while goal events exist',
  'linked contacts cannot drift between businesses'
);

-- 46
SELECT throws_ok(
  $$
    UPDATE public.conversations
    SET channel = 'sms'
    WHERE id = '30000000-0000-4000-a052-000000000001'
  $$,
  '23514',
  'conversation linkage is immutable while goal events exist',
  'linked conversation identity and channel cannot drift'
);

-- 47
SELECT throws_ok(
  $$
    UPDATE public.messages
    SET role = 'human_agent'
    WHERE id = '40000000-0000-4000-a052-000000000002'
  $$,
  '23514',
  'message linkage is immutable while goal events exist',
  'linked message role and tenant identity cannot drift'
);

-- 48
SELECT lives_ok(
  $$
    UPDATE public.messages
    SET content = '[deleted]'
    WHERE id = '40000000-0000-4000-a052-000000000003';

    UPDATE public.contacts
    SET name = NULL,
        email = NULL,
        phone_number = NULL,
        notes = NULL
    WHERE id = '20000000-0000-4000-a052-000000000002'
  $$,
  'goal linkage guards permit message and contact PII anonymization'
);

-- ---------------------------------------------------------------------------
-- Runtime RLS and exact mutation denial
-- ---------------------------------------------------------------------------

-- The existing owner read required by businesses-based RLS policies is
-- transaction-local test setup; migration 052 itself grants only goal_events.
GRANT SELECT ON public.businesses TO authenticated;

SELECT set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-a052-000000000001',
  true
);
SET LOCAL ROLE authenticated;

-- 49
SELECT is(
  (SELECT count(*)::integer FROM public.goal_events),
  3,
  'an owner sees only their own goal events'
);

-- 50
SELECT throws_ok(
  $$
    INSERT INTO public.goal_events (
      business_id,
      goal_at_event,
      event_type,
      channel,
      occurred_at,
      idempotency_key
    ) VALUES (
      '10000000-0000-4000-a052-000000000001',
      'signup',
      'link_sent',
      'web_chat',
      now(),
      'goal-link:owner-forged:052'
    )
  $$,
  '42501',
  NULL,
  'owners cannot forge goal events'
);

-- 51
SELECT throws_ok(
  $$ UPDATE public.goal_events SET channel = 'sms' $$,
  '42501',
  NULL,
  'owners cannot rewrite goal events'
);

-- 52
SELECT throws_ok(
  $$ DELETE FROM public.goal_events $$,
  '42501',
  NULL,
  'owners cannot delete goal events'
);

RESET ROLE;

SELECT set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-a052-000000000002',
  true
);
SET LOCAL ROLE authenticated;

-- 53
SELECT is(
  (SELECT count(*)::integer FROM public.goal_events),
  1,
  'a second owner sees only the second business event'
);

RESET ROLE;
SET LOCAL ROLE anon;

-- 54
SELECT throws_ok(
  $$ SELECT count(*) FROM public.goal_events $$,
  '42501',
  NULL,
  'anonymous clients cannot read goal events'
);

RESET ROLE;
SET LOCAL ROLE service_role;

-- 55
SELECT throws_ok(
  $$
    UPDATE public.goal_events
    SET channel = 'sms'
    WHERE id = '50000000-0000-4000-a052-000000000001'
  $$,
  '42501',
  NULL,
  'service role cannot update finalized goal events'
);

-- 56
SELECT throws_ok(
  $$
    DELETE FROM public.goal_events
    WHERE id = '50000000-0000-4000-a052-000000000001'
  $$,
  '42501',
  NULL,
  'service role cannot delete finalized goal events'
);

RESET ROLE;

-- ---------------------------------------------------------------------------
-- Message, conversation, contact, and business retention
-- ---------------------------------------------------------------------------

-- 57
SELECT lives_ok(
  $$
    DELETE FROM public.messages
    WHERE id = '40000000-0000-4000-a052-000000000003'
  $$,
  'an individual source message can be deleted without deleting its event'
);

-- 58
SELECT ok(
  (
    SELECT source_message_id IS NULL
       AND assistant_message_id IS NOT NULL
       AND conversation_id IS NOT NULL
       AND contact_id IS NOT NULL
    FROM public.goal_events
    WHERE id = '50000000-0000-4000-a052-000000000002'
  ),
  'source deletion nulls only the source reference'
);

-- 59
SELECT lives_ok(
  $$
    DELETE FROM public.messages
    WHERE id = '40000000-0000-4000-a052-000000000004'
  $$,
  'an individual assistant message can be deleted without deleting its event'
);

-- 60
SELECT ok(
  (
    SELECT source_message_id IS NULL
       AND assistant_message_id IS NULL
       AND conversation_id IS NOT NULL
       AND contact_id IS NOT NULL
       AND goal_at_event = 'signup'
    FROM public.goal_events
    WHERE id = '50000000-0000-4000-a052-000000000002'
  ),
  'message deletion preserves the event and its historical goal'
);

-- 61
SELECT lives_ok(
  $$
    DELETE FROM public.conversations
    WHERE id = '30000000-0000-4000-a052-000000000001'
  $$,
  'conversation deletion atomically detaches retained goal-event linkage'
);

-- 62
SELECT ok(
  (
    SELECT contact_id IS NOT NULL
       AND conversation_id IS NULL
       AND source_message_id IS NULL
       AND assistant_message_id IS NULL
       AND goal_at_event = 'signup'
       AND event_type = 'link_sent'
       AND idempotency_key = 'goal-link:a1:052'
    FROM public.goal_events
    WHERE id = '50000000-0000-4000-a052-000000000001'
  ),
  'conversation deletion retains contact and historical event truth without dangling links'
);

-- 63
SELECT lives_ok(
  $$
    DELETE FROM public.contacts
    WHERE id = '20000000-0000-4000-a052-000000000003'
  $$,
  'contact deletion atomically clears all retained event provenance'
);

-- 64
SELECT ok(
  (
    SELECT contact_id IS NULL
       AND conversation_id IS NULL
       AND source_message_id IS NULL
       AND assistant_message_id IS NULL
       AND goal_at_event = 'signup'
       AND event_type = 'link_sent'
    FROM public.goal_events
    WHERE id = '50000000-0000-4000-a052-000000000003'
  ),
  'contact deletion preserves the event count with no dangling provenance'
);

-- 65
SELECT lives_ok(
  $$
    DELETE FROM public.businesses
    WHERE id = '10000000-0000-4000-a052-000000000002'
  $$,
  'hard business deletion can cascade through goal-event fixtures'
);

-- 66
SELECT is(
  (
    SELECT count(*)::integer
    FROM public.goal_events
    WHERE business_id = '10000000-0000-4000-a052-000000000002'
  ),
  0,
  'hard business deletion removes its goal-event history'
);

-- 67
SELECT is(
  (
    SELECT count(*)::integer
    FROM public.goal_events
    WHERE business_id = '10000000-0000-4000-a052-000000000001'
      AND goal_at_event = 'signup'
      AND event_type = 'link_sent'
  ),
  3,
  'all retained first-business events preserve their event-time goal and type'
);

SELECT set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-a052-000000000001',
  true
);
SET LOCAL ROLE authenticated;

-- 68
SELECT is(
  (SELECT count(*)::integer FROM public.goal_events),
  3,
  'the owner still sees retained events after provenance deletion'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
