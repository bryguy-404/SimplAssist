BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SET LOCAL search_path = public, extensions;

SELECT plan(115);

-- ---------------------------------------------------------------------------
-- Catalog shape, constraints, RLS, and service-only execution
-- ---------------------------------------------------------------------------

-- 1
SELECT is(
  (
    SELECT jsonb_object_agg(
      attribute.attname,
      format_type(attribute.atttypid, attribute.atttypmod)
    )
    FROM pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.contacts'::regclass
      AND attribute.attname IN (
        'lead_status',
        'lead_status_updated_at',
        'provided_phone_number'
      )
      AND NOT attribute.attisdropped
  ),
  jsonb_build_object(
    'lead_status', 'text',
    'lead_status_updated_at', 'timestamp with time zone',
    'provided_phone_number', 'text'
  ),
  'contacts have the exact lead-classification column types'
);

-- 2
SELECT ok(
  (
    SELECT attribute.attnotnull
       AND pg_get_expr(default_value.adbin, default_value.adrelid) =
             '''normal''::text'
    FROM pg_attribute AS attribute
    JOIN pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.contacts'::regclass
      AND attribute.attname = 'lead_status'
  )
  AND (
    SELECT attribute.attnotnull
       AND pg_get_expr(default_value.adbin, default_value.adrelid) = 'now()'
    FROM pg_attribute AS attribute
    JOIN pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.contacts'::regclass
      AND attribute.attname = 'lead_status_updated_at'
  ),
  'contact lead status and timestamp are required with safe defaults'
);

-- 3
SELECT is(
  (
    SELECT count(*)::integer
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.contacts'::regclass
      AND constraint_row.conname IN (
        'contacts_lead_status_valid',
        'contacts_provided_phone_e164'
      )
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
  ),
  2,
  'contact lead tiers and volunteered phone values are constrained'
);

-- 4
SELECT ok(
  to_regclass('public.contacts_business_lead_status_idx') IS NOT NULL,
  'the dashboard lead-status access path exists'
);

-- 5
SELECT is(
  public.lead_normalize_email(' PERSON@Example.COM '),
  'person@example.com',
  'backfill email normalization is deterministic'
);

-- 6
SELECT is(
  public.lead_normalize_phone('(317) 555-1234'),
  '+13175551234',
  'backfill phone normalization produces E.164'
);

-- 7
SELECT is(
  public.lead_extract_email('Please use Person+tag@Example.com, thanks.'),
  'person+tag@example.com',
  'backfill extracts a valid email from customer text'
);

-- 8
SELECT is(
  public.lead_extract_phone('Call me at 317.555.1234.'),
  '+13175551234',
  'backfill extracts a volunteered phone from customer text'
);

-- 9
SELECT is(
  ARRAY[
    public.lead_tier_rank('normal'),
    public.lead_tier_rank('warm'),
    public.lead_tier_rank('hot')
  ],
  ARRAY[0, 1, 2],
  'lead tiers have a monotonic total order'
);

-- 10
SELECT has_table(
  'public',
  'calendar_bookings',
  'durable calendar bookings exist'
);

-- 11
SELECT has_table(
  'public',
  'lead_events',
  'durable lead audit events exist'
);

-- 12
SELECT is(
  (
    SELECT jsonb_object_agg(
      attribute.attname,
      format_type(attribute.atttypid, attribute.atttypmod)
    )
    FROM pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.calendar_bookings'::regclass
      AND attribute.attname IN (
        'id',
        'business_id',
        'contact_id',
        'conversation_id',
        'source_message_id',
        'google_calendar_id',
        'google_event_id',
        'event_summary',
        'request_fingerprint',
        'status',
        'starts_at',
        'ends_at',
        'operation_claim_token',
        'operation_claimed_at',
        'reconciliation_attempt_count',
        'reconciliation_attempted_at',
        'confirmed_at',
        'failed_at',
        'cancelled_at',
        'failure_reason',
        'created_at',
        'updated_at'
      )
      AND NOT attribute.attisdropped
  ),
  jsonb_build_object(
    'id', 'uuid',
    'business_id', 'uuid',
    'contact_id', 'uuid',
    'conversation_id', 'uuid',
    'source_message_id', 'uuid',
    'google_calendar_id', 'text',
    'google_event_id', 'text',
    'event_summary', 'text',
    'request_fingerprint', 'text',
    'status', 'text',
    'starts_at', 'timestamp with time zone',
    'ends_at', 'timestamp with time zone',
    'operation_claim_token', 'uuid',
    'operation_claimed_at', 'timestamp with time zone',
    'reconciliation_attempt_count', 'integer',
    'reconciliation_attempted_at', 'timestamp with time zone',
    'confirmed_at', 'timestamp with time zone',
    'failed_at', 'timestamp with time zone',
    'cancelled_at', 'timestamp with time zone',
    'failure_reason', 'text',
    'created_at', 'timestamp with time zone',
    'updated_at', 'timestamp with time zone'
  ),
  'calendar bookings have the exact durable lifecycle column types'
);

-- 13
SELECT ok(
  (
    SELECT pg_get_expr(default_value.adbin, default_value.adrelid) =
             'gen_random_uuid()'
    FROM pg_attribute AS attribute
    JOIN pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.calendar_bookings'::regclass
      AND attribute.attname = 'id'
  )
  AND (
    SELECT pg_get_expr(default_value.adbin, default_value.adrelid) =
             '''pending''::text'
    FROM pg_attribute AS attribute
    JOIN pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.calendar_bookings'::regclass
      AND attribute.attname = 'status'
  )
  AND (
    SELECT pg_get_expr(default_value.adbin, default_value.adrelid) = '0'
    FROM pg_attribute AS attribute
    JOIN pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.calendar_bookings'::regclass
      AND attribute.attname = 'reconciliation_attempt_count'
  ),
  'calendar bookings default to a generated pending reservation with no retries'
);

-- 14
SELECT is(
  (
    SELECT count(*)::integer
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.calendar_bookings'::regclass
      AND constraint_row.conname IN (
        'calendar_bookings_status_valid',
        'calendar_bookings_time_order',
        'calendar_bookings_calendar_id_valid',
        'calendar_bookings_summary_valid',
        'calendar_bookings_fingerprint_valid',
        'calendar_bookings_event_id_valid',
        'calendar_bookings_reconciliation_count_valid',
        'calendar_bookings_failure_reason_valid',
        'calendar_bookings_lifecycle_shape'
      )
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
  ),
  9,
  'all booking value and lifecycle checks are validated'
);

-- 15
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.calendar_bookings'::regclass
      AND constraint_row.conname = 'calendar_bookings_calendar_id_valid'
      AND pg_get_constraintdef(constraint_row.oid)
            LIKE '%length(google_calendar_id) <= 1024%'
  ),
  'Google calendar ids are nonblank and bounded'
);

-- 16
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.calendar_bookings'::regclass
      AND constraint_row.conname = 'calendar_bookings_lifecycle_shape'
      AND pg_get_constraintdef(constraint_row.oid) LIKE '%status = ''pending''%'
      AND pg_get_constraintdef(constraint_row.oid) LIKE '%status = ''confirmed''%'
      AND pg_get_constraintdef(constraint_row.oid) LIKE '%status = ''failed''%'
      AND pg_get_constraintdef(constraint_row.oid) LIKE '%status = ''cancelled''%'
  ),
  'booking status requires a complete compatible lifecycle shape'
);

-- 17
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_index AS index_row
    WHERE index_row.indexrelid =
          'public.calendar_bookings_source_message_unique'::regclass
      AND index_row.indisunique
      AND pg_get_indexdef(index_row.indexrelid)
            LIKE '%(business_id, source_message_id)%'
  ),
  'one source message can create only one booking per tenant'
);

-- 18
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_index AS index_row
    WHERE index_row.indexrelid =
          'public.calendar_bookings_google_event_unique'::regclass
      AND index_row.indisunique
      AND pg_get_indexdef(index_row.indexrelid)
            LIKE '%(business_id, google_calendar_id, google_event_id)%'
      AND pg_get_expr(index_row.indpred, index_row.indrelid) =
            '(google_event_id IS NOT NULL)'
  ),
  'Google event uniqueness is scoped by tenant and calendar'
);

-- 19
SELECT ok(
  to_regclass('public.calendar_bookings_pending_claim_idx') IS NOT NULL,
  'stale pending claims have a bounded reconciliation access path'
);

-- 20
SELECT is(
  (
    SELECT jsonb_object_agg(
      attribute.attname,
      format_type(attribute.atttypid, attribute.atttypmod)
    )
    FROM pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.lead_events'::regclass
      AND attribute.attname IN (
        'id',
        'business_id',
        'contact_id',
        'conversation_id',
        'source_message_id',
        'calendar_booking_id',
        'event_type',
        'reason',
        'created_at'
      )
      AND NOT attribute.attisdropped
  ),
  jsonb_build_object(
    'id', 'uuid',
    'business_id', 'uuid',
    'contact_id', 'uuid',
    'conversation_id', 'uuid',
    'source_message_id', 'uuid',
    'calendar_booking_id', 'uuid',
    'event_type', 'text',
    'reason', 'text',
    'created_at', 'timestamp with time zone'
  ),
  'lead events have exact tenant, source, booking, and audit types'
);

-- 21
SELECT ok(
  (
    SELECT pg_get_expr(default_value.adbin, default_value.adrelid) =
             '''became_hot''::text'
    FROM pg_attribute AS attribute
    JOIN pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.lead_events'::regclass
      AND attribute.attname = 'event_type'
  ),
  'lead audit rows default to the first-HOT event'
);

-- 22
SELECT is(
  (
    SELECT count(*)::integer
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.lead_events'::regclass
      AND constraint_row.conname IN (
        'lead_events_type_valid',
        'lead_events_reason_valid',
        'lead_events_source_shape'
      )
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
  ),
  3,
  'lead event type, reason, and source shape are constrained'
);

-- 23
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_index AS index_row
    WHERE index_row.indexrelid =
          'public.lead_events_first_hot_unique'::regclass
      AND index_row.indisunique
      AND pg_get_indexdef(index_row.indexrelid)
            LIKE '%(contact_id, event_type)%'
  ),
  'first-HOT audit events have a durable deduplication fence'
);

-- 24
SELECT ok(
  (
    SELECT count(*) = 2 AND bool_and(class_row.relrowsecurity)
    FROM pg_class AS class_row
    WHERE class_row.oid IN (
      'public.calendar_bookings'::regclass,
      'public.lead_events'::regclass
    )
  ),
  'both service-owned tables have RLS enabled'
);

-- 25
SELECT is(
  (
    SELECT count(*)::integer
    FROM pg_policy AS policy_row
    WHERE policy_row.polrelid IN (
      'public.calendar_bookings'::regclass,
      'public.lead_events'::regclass
    )
  ),
  0,
  'service-owned tables expose no customer RLS policy'
);

-- 26
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_class AS class_row
    CROSS JOIN LATERAL aclexplode(
      COALESCE(class_row.relacl, acldefault('r', class_row.relowner))
    ) AS acl_row
    WHERE class_row.oid IN (
      'public.calendar_bookings'::regclass,
      'public.lead_events'::regclass
    )
      AND acl_row.grantee = 0
  ),
  'PUBLIC has no booking or lead-audit table privilege'
);

-- 27
SELECT ok(
  NOT has_table_privilege('anon', 'public.calendar_bookings', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.lead_events', 'SELECT')
  AND NOT has_table_privilege(
    'authenticated',
    'public.calendar_bookings',
    'SELECT'
  )
  AND NOT has_table_privilege('authenticated', 'public.lead_events', 'SELECT'),
  'anon and authenticated have no service-table privileges'
);

-- 28
SELECT ok(
  has_table_privilege('service_role', 'public.calendar_bookings', 'SELECT')
  AND has_table_privilege(
    'service_role',
    'public.calendar_bookings',
    'INSERT'
  )
  AND has_table_privilege('service_role', 'public.calendar_bookings', 'UPDATE')
  AND has_table_privilege('service_role', 'public.calendar_bookings', 'DELETE')
  AND has_table_privilege('service_role', 'public.lead_events', 'SELECT')
  AND has_table_privilege('service_role', 'public.lead_events', 'INSERT')
  AND has_table_privilege('service_role', 'public.lead_events', 'UPDATE')
  AND has_table_privilege('service_role', 'public.lead_events', 'DELETE'),
  'service_role owns booking and lead-audit persistence'
);

-- 29
SELECT is(
  (
    SELECT count(*)::integer
    FROM pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid IN (
      'public.contacts'::regclass,
      'public.conversations'::regclass,
      'public.messages'::regclass,
      'public.calendar_bookings'::regclass,
      'public.lead_events'::regclass,
      'public.businesses'::regclass
    )
      AND trigger_row.tgname IN (
        'validate_calendar_booking_tenant_on_insert',
        'validate_calendar_booking_tenant_on_linkage_update',
        'validate_lead_event_tenant',
        'guard_contact_lead_linkage',
        'guard_conversation_lead_linkage',
        'guard_message_lead_linkage',
        'unlink_lead_events_before_conversation_delete',
        'guard_contact_lead_fields',
        'guard_calendar_booking_lifecycle',
        'promote_contact_info_lead',
        'guard_hot_lead_cleanup_inflight',
        'cleanup_hot_lead_data_on_tombstone'
      )
      AND NOT trigger_row.tgisinternal
  ),
  12,
  'all tenant, lifecycle, identity, and cleanup triggers exist'
);

-- 30
SELECT ok(
  (
    SELECT count(*) = 16
       AND bool_and(
         procedure_row.proconfig @>
           ARRAY['search_path=public, pg_temp']::text[]
       )
    FROM pg_proc AS procedure_row
    WHERE procedure_row.pronamespace = 'public'::regnamespace
      AND procedure_row.proname IN (
        'lead_tier_rank',
        'lead_normalize_email',
        'lead_normalize_phone',
        'lead_extract_email',
        'lead_extract_phone',
        'validate_calendar_booking_tenant',
        'validate_lead_event_tenant',
        'guard_contact_lead_linkage',
        'guard_conversation_lead_linkage',
        'guard_message_lead_linkage',
        'unlink_lead_events_before_conversation_delete',
        'guard_contact_lead_fields',
        'guard_calendar_booking_lifecycle',
        'promote_contact_info_lead',
        'guard_hot_lead_cleanup_inflight',
        'cleanup_hot_lead_data_on_tombstone'
      )
  ),
  'all helper and trigger functions pin their search path'
);

-- 31
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_proc AS procedure_row
    WHERE procedure_row.pronamespace = 'public'::regnamespace
      AND procedure_row.proname IN (
        'lead_tier_rank',
        'lead_normalize_email',
        'lead_normalize_phone',
        'lead_extract_email',
        'lead_extract_phone',
        'validate_calendar_booking_tenant',
        'validate_lead_event_tenant',
        'guard_contact_lead_linkage',
        'guard_conversation_lead_linkage',
        'guard_message_lead_linkage',
        'unlink_lead_events_before_conversation_delete',
        'guard_contact_lead_fields',
        'guard_calendar_booking_lifecycle',
        'promote_contact_info_lead',
        'guard_hot_lead_cleanup_inflight',
        'cleanup_hot_lead_data_on_tombstone'
      )
      AND (
        has_function_privilege('anon', procedure_row.oid, 'EXECUTE')
        OR has_function_privilege(
          'authenticated',
          procedure_row.oid,
          'EXECUTE'
        )
        OR has_function_privilege('service_role', procedure_row.oid, 'EXECUTE')
      )
  ),
  'helper and trigger functions cannot be invoked directly'
);

-- 32
SELECT is(
  (
    SELECT count(*)::integer
    FROM unnest(ARRAY[
      to_regprocedure(
        'public.promote_contact_lead_status(uuid,uuid,text,text,uuid,uuid,uuid,boolean)'
      ),
      to_regprocedure(
        'public.reserve_calendar_booking(uuid,uuid,uuid,uuid,timestamptz,timestamptz,uuid,text,text,text)'
      ),
      to_regprocedure(
        'public.confirm_calendar_booking(uuid,uuid,text,timestamptz,timestamptz,uuid)'
      ),
      to_regprocedure(
        'public.claim_calendar_booking_reconciliation(uuid,uuid,uuid)'
      ),
      to_regprocedure(
        'public.fail_calendar_booking(uuid,uuid,uuid,text)'
      )
    ]) AS procedure_oid
    WHERE procedure_oid IS NOT NULL
  ),
  5,
  'all service RPCs have the exact intended signatures'
);

-- 33
SELECT ok(
  (
    SELECT count(*) = 5
       AND bool_and(procedure_row.prosecdef)
       AND bool_and(
         procedure_row.proconfig @>
           ARRAY['search_path=public, pg_temp']::text[]
       )
    FROM pg_proc AS procedure_row
    WHERE procedure_row.pronamespace = 'public'::regnamespace
      AND procedure_row.proname IN (
        'promote_contact_lead_status',
        'reserve_calendar_booking',
        'claim_calendar_booking_reconciliation',
        'confirm_calendar_booking',
        'fail_calendar_booking'
      )
  ),
  'service RPCs are SECURITY DEFINER with fixed search paths'
);

-- 34
SELECT ok(
  (
    SELECT count(*) = 5
       AND bool_and(
         has_function_privilege('service_role', procedure_row.oid, 'EXECUTE')
       )
       AND bool_and(
         NOT has_function_privilege('anon', procedure_row.oid, 'EXECUTE')
       )
       AND bool_and(
         NOT has_function_privilege(
           'authenticated',
           procedure_row.oid,
           'EXECUTE'
         )
       )
    FROM pg_proc AS procedure_row
    WHERE procedure_row.pronamespace = 'public'::regnamespace
      AND procedure_row.proname IN (
        'promote_contact_lead_status',
        'reserve_calendar_booking',
        'claim_calendar_booking_reconciliation',
        'confirm_calendar_booking',
        'fail_calendar_booking'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM aclexplode(
          COALESCE(
            procedure_row.proacl,
            acldefault('f', procedure_row.proowner)
          )
        ) AS privilege
        WHERE privilege.grantee = 0
          AND privilege.privilege_type = 'EXECUTE'
      )
  ),
  'only service_role, never PUBLIC, can execute lead and booking RPCs'
);

-- ---------------------------------------------------------------------------
-- Tenant-isolated fixtures
-- ---------------------------------------------------------------------------

INSERT INTO auth.users (id, email)
VALUES
  (
    '00000000-0000-4000-a039-000000000001',
    'hot-lead-a-039@example.test'
  ),
  (
    '00000000-0000-4000-a039-000000000002',
    'hot-lead-b-039@example.test'
  );

UPDATE public.businesses
SET id = '10000000-0000-4000-a039-000000000001',
    name = 'Hot Lead Test A',
    slug = 'hot-lead-test-a-039'
WHERE owner_id = '00000000-0000-4000-a039-000000000001';

UPDATE public.businesses
SET id = '10000000-0000-4000-a039-000000000002',
    name = 'Hot Lead Test B',
    slug = 'hot-lead-test-b-039'
WHERE owner_id = '00000000-0000-4000-a039-000000000002';

INSERT INTO public.google_calendar_tokens (
  id,
  business_id,
  access_token,
  refresh_token,
  token_expiry,
  calendar_id,
  google_email,
  created_at,
  updated_at
) VALUES
  (
    '62000000-0000-4000-a039-000000000001',
    '10000000-0000-4000-a039-000000000001',
    'fixture-access-a039-1',
    'fixture-refresh-a039-1',
    '2099-01-01 00:00:00+00',
    'primary',
    'hot-lead-a-039@example.test',
    '2039-01-01 00:00:00+00',
    '2039-01-01 00:00:00+00'
  ),
  (
    '62000000-0000-4000-a039-000000000002',
    '10000000-0000-4000-a039-000000000002',
    'fixture-access-a039-2',
    'fixture-refresh-a039-2',
    '2099-01-01 00:00:00+00',
    'primary',
    'hot-lead-b-039@example.test',
    '2039-01-01 00:00:00+00',
    '2039-01-01 00:00:00+00'
  );

INSERT INTO public.contacts (
  id,
  business_id,
  name,
  phone_number,
  email,
  provided_phone_number,
  source_channel,
  lead_score
) VALUES
  (
    '20000000-0000-4000-a039-000000000001',
    '10000000-0000-4000-a039-000000000001',
    'Promotion Contact',
    '+13175550391',
    NULL,
    NULL,
    'sms',
    0
  ),
  (
    '20000000-0000-4000-a039-000000000002',
    '10000000-0000-4000-a039-000000000001',
    'Email Contact',
    NULL,
    ' Person.Email@Example.com ',
    NULL,
    'web_chat',
    0
  ),
  (
    '20000000-0000-4000-a039-000000000003',
    '10000000-0000-4000-a039-000000000001',
    'Phone Contact',
    NULL,
    NULL,
    '+13175550393',
    'web_chat',
    0
  ),
  (
    '20000000-0000-4000-a039-000000000004',
    '10000000-0000-4000-a039-000000000001',
    'Client Guard Contact',
    NULL,
    'not-an-email',
    NULL,
    'web_chat',
    0
  ),
  (
    '20000000-0000-4000-a039-000000000005',
    '10000000-0000-4000-a039-000000000001',
    'Primary Booking Contact',
    '+13175550395',
    NULL,
    NULL,
    'sms',
    0
  ),
  (
    '20000000-0000-4000-a039-000000000006',
    '10000000-0000-4000-a039-000000000001',
    'Secondary Calendar Contact',
    '+13175550396',
    NULL,
    NULL,
    'sms',
    0
  ),
  (
    '20000000-0000-4000-a039-000000000007',
    '10000000-0000-4000-a039-000000000001',
    'Duplicate Event Contact',
    '+13175550397',
    NULL,
    NULL,
    'sms',
    0
  ),
  (
    '20000000-0000-4000-a039-000000000011',
    '10000000-0000-4000-a039-000000000002',
    'Other Tenant Contact',
    '+13175550401',
    NULL,
    NULL,
    'sms',
    0
  ),
  (
    '20000000-0000-4000-a039-000000000012',
    '10000000-0000-4000-a039-000000000002',
    'Cleanup Contact',
    '+13175550402',
    NULL,
    NULL,
    'sms',
    0
  );

INSERT INTO public.conversations (
  id,
  business_id,
  contact_id,
  channel,
  status,
  is_ai_handling
) VALUES
  (
    '30000000-0000-4000-a039-000000000001',
    '10000000-0000-4000-a039-000000000001',
    '20000000-0000-4000-a039-000000000001',
    'sms',
    'active',
    true
  ),
  (
    '30000000-0000-4000-a039-000000000005',
    '10000000-0000-4000-a039-000000000001',
    '20000000-0000-4000-a039-000000000005',
    'sms',
    'active',
    true
  ),
  (
    '30000000-0000-4000-a039-000000000006',
    '10000000-0000-4000-a039-000000000001',
    '20000000-0000-4000-a039-000000000006',
    'sms',
    'active',
    true
  ),
  (
    '30000000-0000-4000-a039-000000000007',
    '10000000-0000-4000-a039-000000000001',
    '20000000-0000-4000-a039-000000000007',
    'sms',
    'active',
    true
  ),
  (
    '30000000-0000-4000-a039-000000000011',
    '10000000-0000-4000-a039-000000000002',
    '20000000-0000-4000-a039-000000000011',
    'sms',
    'active',
    true
  ),
  (
    '30000000-0000-4000-a039-000000000012',
    '10000000-0000-4000-a039-000000000002',
    '20000000-0000-4000-a039-000000000012',
    'sms',
    'active',
    true
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
    '40000000-0000-4000-a039-000000000001',
    '30000000-0000-4000-a039-000000000001',
    '10000000-0000-4000-a039-000000000001',
    'customer',
    'This is urgent.',
    'sms'
  ),
  (
    '40000000-0000-4000-a039-000000000005',
    '30000000-0000-4000-a039-000000000005',
    '10000000-0000-4000-a039-000000000001',
    'customer',
    'Please book the estimate.',
    'sms'
  ),
  (
    '40000000-0000-4000-a039-000000000006',
    '30000000-0000-4000-a039-000000000006',
    '10000000-0000-4000-a039-000000000001',
    'customer',
    'Please book the secondary calendar.',
    'sms'
  ),
  (
    '40000000-0000-4000-a039-000000000007',
    '30000000-0000-4000-a039-000000000007',
    '10000000-0000-4000-a039-000000000001',
    'customer',
    'Please book this too.',
    'sms'
  ),
  (
    '40000000-0000-4000-a039-000000000011',
    '30000000-0000-4000-a039-000000000011',
    '10000000-0000-4000-a039-000000000002',
    'customer',
    'Other tenant message.',
    'sms'
  ),
  (
    '40000000-0000-4000-a039-000000000012',
    '30000000-0000-4000-a039-000000000012',
    '10000000-0000-4000-a039-000000000002',
    'customer',
    'Cleanup booking message.',
    'sms'
  ),
  (
    '40000000-0000-4000-a039-000000000099',
    '30000000-0000-4000-a039-000000000005',
    '10000000-0000-4000-a039-000000000001',
    'assistant',
    'Assistant messages cannot source bookings.',
    'sms'
  );

-- 35
SELECT ok(
  (
    SELECT lead_status = 'normal'
       AND lead_status_updated_at IS NOT NULL
       AND provided_phone_number IS NULL
    FROM public.contacts
    WHERE id = '20000000-0000-4000-a039-000000000001'
  ),
  'new contacts default to NORMAL with a classification timestamp'
);

-- 36
SELECT is(
  (
    SELECT lead_status
    FROM public.contacts
    WHERE id = '20000000-0000-4000-a039-000000000002'
  ),
  'hot',
  'a valid stored email promotes a new contact to HOT'
);

-- 37
SELECT is(
  (
    SELECT reason
    FROM public.lead_events
    WHERE contact_id = '20000000-0000-4000-a039-000000000002'
  ),
  'email_captured',
  'email promotion emits the first-HOT audit reason'
);

-- 38
SELECT is(
  (
    SELECT lead_status
    FROM public.contacts
    WHERE id = '20000000-0000-4000-a039-000000000003'
  ),
  'hot',
  'a valid volunteered phone promotes a new contact to HOT'
);

-- 39
SELECT is(
  (
    SELECT reason
    FROM public.lead_events
    WHERE contact_id = '20000000-0000-4000-a039-000000000003'
  ),
  'phone_captured',
  'phone promotion emits the first-HOT audit reason'
);

-- 40
SELECT is(
  (
    SELECT lead_status
    FROM public.contacts
    WHERE id = '20000000-0000-4000-a039-000000000004'
  ),
  'normal',
  'an invalid email does not promote a contact'
);

-- 41
SELECT throws_ok(
  $$
    UPDATE public.contacts
    SET provided_phone_number = '555-1234'
    WHERE id = '20000000-0000-4000-a039-000000000004'
  $$,
  '23514',
  NULL,
  'non-E.164 volunteered phone values are rejected'
);

-- ---------------------------------------------------------------------------
-- Client guard and authenticated identity-trigger path
-- ---------------------------------------------------------------------------

GRANT SELECT, UPDATE ON public.businesses, public.contacts TO authenticated;
SELECT set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-a039-000000000001',
  true
);
SET LOCAL ROLE authenticated;

-- 42
SELECT throws_ok(
  $$SELECT count(*) FROM public.calendar_bookings$$,
  '42501',
  NULL,
  'authenticated owners cannot read service-only booking rows'
);

-- 43
SELECT throws_ok(
  $$
    SELECT public.promote_contact_lead_status(
      '10000000-0000-4000-a039-000000000001',
      '20000000-0000-4000-a039-000000000004',
      'hot',
      'forged'
    )
  $$,
  '42501',
  NULL,
  'authenticated owners cannot execute the promotion RPC'
);

-- 44
SELECT throws_ok(
  $$
    UPDATE public.contacts
    SET lead_status = 'hot'
    WHERE id = '20000000-0000-4000-a039-000000000004'
  $$,
  '42501',
  'lead status is service-managed',
  'authenticated owners cannot forge a lead tier'
);

-- 45
SELECT lives_ok(
  $$
    UPDATE public.contacts
    SET notes = 'ordinary owner note'
    WHERE id = '20000000-0000-4000-a039-000000000004'
  $$,
  'the lead guard preserves ordinary owner contact updates'
);

-- 46
SELECT lives_ok(
  $$
    UPDATE public.contacts
    SET email = 'client.captured@example.test'
    WHERE id = '20000000-0000-4000-a039-000000000004'
  $$,
  'an owner can persist captured identity through the normal contact path'
);

RESET ROLE;

-- 47
SELECT is(
  (
    SELECT lead_status
    FROM public.contacts
    WHERE id = '20000000-0000-4000-a039-000000000004'
  ),
  'normal',
  'owner identity edits do not manufacture a captured hot lead (customer workspace)'
);

-- 48
SELECT ok(
  (
    SELECT count(*) = 0
    FROM public.lead_events
    WHERE contact_id = '20000000-0000-4000-a039-000000000004'
  ),
  'owner identity edits produce no generated-lead audit (automatic capture still does)'
);

-- ---------------------------------------------------------------------------
-- Monotonic promotion and audit deduplication
-- ---------------------------------------------------------------------------

-- The local test role has no legacy-table grants from 001. Grant only the
-- access needed to exercise the service guard; the transaction rolls it back.
GRANT SELECT, UPDATE ON public.contacts TO service_role;

SET LOCAL ROLE service_role;

-- 49
SELECT lives_ok(
  $$
    SELECT public.promote_contact_lead_status(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_contact_id => '20000000-0000-4000-a039-000000000001',
      p_new_status => 'warm',
      p_reason => 'urgent_intent',
      p_conversation_id => '30000000-0000-4000-a039-000000000001',
      p_source_message_id => '40000000-0000-4000-a039-000000000001'
    )
  $$,
  'service promotion raises a NORMAL contact to WARM'
);

-- 50
SELECT is(
  (
    SELECT lead_status
    FROM public.contacts
    WHERE id = '20000000-0000-4000-a039-000000000001'
  ),
  'warm',
  'the WARM tier is persisted'
);

-- 51
SELECT is(
  (
    SELECT count(*)::integer
    FROM public.lead_events
    WHERE contact_id = '20000000-0000-4000-a039-000000000001'
  ),
  0,
  'WARM promotion does not emit a became-HOT audit'
);

-- 52
SELECT lives_ok(
  $$
    SELECT public.promote_contact_lead_status(
      '10000000-0000-4000-a039-000000000001',
      '20000000-0000-4000-a039-000000000001',
      'normal',
      'stale_classifier_result'
    )
  $$,
  'a stale downgrade request is accepted idempotently'
);

-- 53
SELECT is(
  (
    SELECT lead_status
    FROM public.contacts
    WHERE id = '20000000-0000-4000-a039-000000000001'
  ),
  'warm',
  'promotion RPCs never downgrade a lead'
);

-- 54
SELECT lives_ok(
  $$
    SELECT public.promote_contact_lead_status(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_contact_id => '20000000-0000-4000-a039-000000000001',
      p_new_status => 'hot',
      p_reason => 'urgent_with_identity',
      p_conversation_id => '30000000-0000-4000-a039-000000000001',
      p_source_message_id => '40000000-0000-4000-a039-000000000001'
    )
  $$,
  'a WARM contact can be promoted to HOT'
);

-- 55
SELECT is(
  (
    SELECT lead_status
    FROM public.contacts
    WHERE id = '20000000-0000-4000-a039-000000000001'
  ),
  'hot',
  'the HOT tier is persisted'
);

-- 56
SELECT ok(
  (
    SELECT count(*) = 1
       AND bool_and(reason = 'urgent_with_identity')
       AND bool_and(
         conversation_id =
           '30000000-0000-4000-a039-000000000001'::uuid
       )
       AND bool_and(
         source_message_id =
           '40000000-0000-4000-a039-000000000001'::uuid
       )
    FROM public.lead_events
    WHERE contact_id = '20000000-0000-4000-a039-000000000001'
  ),
  'first HOT promotion records its exact conversation and message'
);

-- 57
SELECT lives_ok(
  $$
    SELECT public.promote_contact_lead_status(
      '10000000-0000-4000-a039-000000000001',
      '20000000-0000-4000-a039-000000000001',
      'hot',
      'duplicate_hot'
    )
  $$,
  'repeating HOT promotion is idempotent'
);

-- 58
SELECT is(
  (
    SELECT count(*)::integer
    FROM public.lead_events
    WHERE contact_id = '20000000-0000-4000-a039-000000000001'
      AND event_type = 'became_hot'
  ),
  1,
  'repeated HOT promotion cannot duplicate its audit event'
);

-- 59
SELECT throws_ok(
  $$
    UPDATE public.contacts
    SET lead_status = 'normal'
    WHERE id = '20000000-0000-4000-a039-000000000001'
  $$,
  '42501',
  'lead status is service-managed',
  'service clients also use the authoritative promotion RPC'
);

-- 60
SELECT throws_ok(
  $$
    SELECT public.promote_contact_lead_status(
      '10000000-0000-4000-a039-000000000001',
      '20000000-0000-4000-a039-000000000011',
      'hot',
      'tenant_mismatch'
    )
  $$,
  '23503',
  NULL,
  'promotion rejects a contact from another tenant'
);

-- 61
SELECT throws_ok(
  $$
    SELECT public.promote_contact_lead_status(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_contact_id => '20000000-0000-4000-a039-000000000005',
      p_new_status => 'hot',
      p_reason => 'tenant_mismatch',
      p_conversation_id => '30000000-0000-4000-a039-000000000006'
    )
  $$,
  '23514',
  NULL,
  'promotion rejects a conversation linked to another contact'
);

-- 62
SELECT throws_ok(
  $$
    SELECT public.promote_contact_lead_status(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_contact_id => '20000000-0000-4000-a039-000000000005',
      p_new_status => 'hot',
      p_reason => 'tenant_mismatch',
      p_conversation_id => '30000000-0000-4000-a039-000000000005',
      p_source_message_id => '40000000-0000-4000-a039-000000000006'
    )
  $$,
  '23514',
  NULL,
  'promotion rejects a source message from another conversation'
);

-- ---------------------------------------------------------------------------
-- Reservation identity, CAS failure/reclaim, and confirmation
-- ---------------------------------------------------------------------------

-- 63
SELECT throws_ok(
  $$
    SELECT public.reserve_calendar_booking(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_contact_id => '20000000-0000-4000-a039-000000000011',
      p_conversation_id => '30000000-0000-4000-a039-000000000011',
      p_source_message_id => '40000000-0000-4000-a039-000000000011',
      p_starts_at => '2039-09-10T14:00:00Z',
      p_ends_at => '2039-09-10T14:30:00Z',
      p_claim_token => '50000000-0000-4000-a039-000000000001',
      p_google_calendar_id => 'primary',
      p_event_summary => 'Cross Tenant',
      p_request_fingerprint =>
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )
  $$,
  '23514',
  NULL,
  'reservation rejects a contact from another tenant'
);

-- 64
SELECT throws_ok(
  $$
    SELECT public.reserve_calendar_booking(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_contact_id => '20000000-0000-4000-a039-000000000005',
      p_conversation_id => '30000000-0000-4000-a039-000000000006',
      p_source_message_id => '40000000-0000-4000-a039-000000000006',
      p_starts_at => '2039-09-10T14:00:00Z',
      p_ends_at => '2039-09-10T14:30:00Z',
      p_claim_token => '50000000-0000-4000-a039-000000000001',
      p_google_calendar_id => 'primary',
      p_event_summary => 'Wrong Conversation',
      p_request_fingerprint =>
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )
  $$,
  '23514',
  NULL,
  'reservation rejects a conversation from another contact'
);

-- 65
SELECT throws_ok(
  $$
    SELECT public.reserve_calendar_booking(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_contact_id => '20000000-0000-4000-a039-000000000005',
      p_conversation_id => '30000000-0000-4000-a039-000000000005',
      p_source_message_id => '40000000-0000-4000-a039-000000000006',
      p_starts_at => '2039-09-10T14:00:00Z',
      p_ends_at => '2039-09-10T14:30:00Z',
      p_claim_token => '50000000-0000-4000-a039-000000000001',
      p_google_calendar_id => 'primary',
      p_event_summary => 'Wrong Message',
      p_request_fingerprint =>
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )
  $$,
  '23514',
  NULL,
  'reservation rejects a source message from another conversation'
);

-- 66
SELECT throws_ok(
  $$
    SELECT public.reserve_calendar_booking(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_contact_id => '20000000-0000-4000-a039-000000000005',
      p_conversation_id => '30000000-0000-4000-a039-000000000005',
      p_source_message_id => '40000000-0000-4000-a039-000000000099',
      p_starts_at => '2039-09-10T14:00:00Z',
      p_ends_at => '2039-09-10T14:30:00Z',
      p_claim_token => '50000000-0000-4000-a039-000000000001',
      p_google_calendar_id => 'primary',
      p_event_summary => 'Assistant Source',
      p_request_fingerprint =>
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )
  $$,
  '23514',
  NULL,
  'reservation requires a customer-authored source message'
);

-- 67
SELECT throws_ok(
  $$
    SELECT public.reserve_calendar_booking(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_contact_id => '20000000-0000-4000-a039-000000000005',
      p_conversation_id => '30000000-0000-4000-a039-000000000005',
      p_source_message_id => '40000000-0000-4000-a039-000000000005',
      p_starts_at => '2039-09-10T14:00:00Z',
      p_ends_at => '2039-09-10T14:30:00Z',
      p_claim_token => '50000000-0000-4000-a039-000000000001',
      p_google_calendar_id => repeat('x', 1025),
      p_event_summary => 'Overlong Calendar',
      p_request_fingerprint =>
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )
  $$,
  '22023',
  NULL,
  'reservation rejects an overlong Google calendar id'
);

-- 68
SELECT lives_ok(
  $$
    SELECT public.reserve_calendar_booking(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_contact_id => '20000000-0000-4000-a039-000000000005',
      p_conversation_id => '30000000-0000-4000-a039-000000000005',
      p_source_message_id => '40000000-0000-4000-a039-000000000005',
      p_starts_at => '2039-09-10T14:00:00Z',
      p_ends_at => '2039-09-10T14:30:00Z',
      p_claim_token => '50000000-0000-4000-a039-000000000001',
      p_google_calendar_id => ' primary ',
      p_event_summary => ' Estimate - Primary ',
      p_request_fingerprint =>
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )
  $$,
  'a linked customer message creates one pending reservation'
);

-- 69
SELECT ok(
  (
    SELECT status = 'pending'
       AND google_event_id IS NULL
       AND operation_claim_token =
             '50000000-0000-4000-a039-000000000001'::uuid
       AND operation_claimed_at IS NOT NULL
       AND confirmed_at IS NULL
       AND failed_at IS NULL
       AND cancelled_at IS NULL
       AND failure_reason IS NULL
    FROM public.calendar_bookings
    WHERE source_message_id =
          '40000000-0000-4000-a039-000000000005'
  ),
  'new reservations have the complete pending lifecycle shape'
);

-- 70
SELECT lives_ok(
  $$
    SELECT public.reserve_calendar_booking(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_contact_id => '20000000-0000-4000-a039-000000000005',
      p_conversation_id => '30000000-0000-4000-a039-000000000005',
      p_source_message_id => '40000000-0000-4000-a039-000000000005',
      p_starts_at => '2039-09-10T15:00:00Z',
      p_ends_at => '2039-09-10T16:00:00Z',
      p_claim_token => '50000000-0000-4000-a039-000000000002',
      p_google_calendar_id => 'different-calendar',
      p_event_summary => 'Different Summary',
      p_request_fingerprint =>
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )
  $$,
  'a fresh idempotent retry reuses the existing reservation'
);

-- 71
SELECT is(
  (
    SELECT count(*)::integer
    FROM public.calendar_bookings
    WHERE business_id = '10000000-0000-4000-a039-000000000001'
      AND source_message_id =
            '40000000-0000-4000-a039-000000000005'
  ),
  1,
  'idempotent reservation retry cannot create a duplicate row'
);

-- 72
SELECT ok(
  (
    SELECT google_calendar_id = 'primary'
       AND event_summary = 'Estimate - Primary'
       AND request_fingerprint =
             'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
       AND starts_at = '2039-09-10T14:00:00Z'::timestamptz
       AND ends_at = '2039-09-10T14:30:00Z'::timestamptz
       AND operation_claim_token =
             '50000000-0000-4000-a039-000000000001'::uuid
    FROM public.calendar_bookings
    WHERE source_message_id =
          '40000000-0000-4000-a039-000000000005'
  ),
  'retry preserves original calendar, summary, fingerprint, time, and claim'
);

-- 73
SELECT throws_ok(
  $$
    SELECT public.reserve_calendar_booking(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_contact_id => '20000000-0000-4000-a039-000000000005',
      p_conversation_id => '30000000-0000-4000-a039-000000000005',
      p_source_message_id => '40000000-0000-4000-a039-000000000005',
      p_starts_at => '2039-09-10T14:00:00Z',
      p_ends_at => '2039-09-10T14:30:00Z',
      p_claim_token => '50000000-0000-4000-a039-000000000002',
      p_google_calendar_id => 'primary',
      p_event_summary => 'Estimate - Primary',
      p_request_fingerprint =>
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    )
  $$,
  '23514',
  NULL,
  'a source message cannot be replayed with a different fingerprint'
);

-- 74
SELECT throws_ok(
  $$
    INSERT INTO public.calendar_bookings (
      business_id,
      contact_id,
      conversation_id,
      source_message_id,
      google_calendar_id,
      event_summary,
      request_fingerprint,
      starts_at,
      ends_at,
      operation_claim_token,
      operation_claimed_at
    ) VALUES (
      '10000000-0000-4000-a039-000000000001',
      '20000000-0000-4000-a039-000000000007',
      '30000000-0000-4000-a039-000000000007',
      '40000000-0000-4000-a039-000000000007',
      'primary',
      'Forged Direct Booking',
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      '2039-09-10T14:00:00Z',
      '2039-09-10T14:30:00Z',
      '50000000-0000-4000-a039-000000000007',
      clock_timestamp()
    )
  $$,
  '42501',
  'calendar bookings must be reserved through service RPC',
  'service clients cannot bypass the booking reservation RPC'
);

RESET ROLE;

-- 75
SELECT throws_ok(
  $$
    UPDATE public.calendar_bookings
    SET status = 'confirmed',
        google_event_id = 'malformed-shape'
    WHERE source_message_id =
          '40000000-0000-4000-a039-000000000005'
  $$,
  '23514',
  NULL,
  'the lifecycle constraint rejects a partial confirmed state'
);

SET LOCAL ROLE service_role;

-- 76
SELECT throws_ok(
  $$
    SELECT public.fail_calendar_booking(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_booking_id => (
        SELECT id
        FROM public.calendar_bookings
        WHERE source_message_id =
              '40000000-0000-4000-a039-000000000005'
      ),
      p_claim_token => '50000000-0000-4000-a039-000000000009',
      p_failure_reason => 'wrong claim'
    )
  $$,
  '42501',
  NULL,
  'a losing claim cannot fail a pending booking'
);

-- 77
SELECT lives_ok(
  $$
    SELECT public.fail_calendar_booking(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_booking_id => (
        SELECT id
        FROM public.calendar_bookings
        WHERE source_message_id =
              '40000000-0000-4000-a039-000000000005'
      ),
      p_claim_token => '50000000-0000-4000-a039-000000000001',
      p_failure_reason => ' definitive provider failure '
    )
  $$,
  'the active claim can fail a pending booking'
);

-- 78
SELECT ok(
  (
    SELECT status = 'failed'
       AND operation_claim_token IS NULL
       AND operation_claimed_at IS NULL
       AND failed_at IS NOT NULL
       AND failure_reason = 'definitive provider failure'
    FROM public.calendar_bookings
    WHERE source_message_id =
          '40000000-0000-4000-a039-000000000005'
  ),
  'failure atomically clears the lease and records its reason'
);

-- 79
SELECT lives_ok(
  $$
    SELECT public.fail_calendar_booking(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_booking_id => (
        SELECT id
        FROM public.calendar_bookings
        WHERE source_message_id =
              '40000000-0000-4000-a039-000000000005'
      ),
      p_claim_token => '50000000-0000-4000-a039-000000000009',
      p_failure_reason => 'idempotent repeat'
    )
  $$,
  'repeated failure is idempotent after terminal persistence'
);

-- 80
SELECT lives_ok(
  $$
    SELECT public.reserve_calendar_booking(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_contact_id => '20000000-0000-4000-a039-000000000005',
      p_conversation_id => '30000000-0000-4000-a039-000000000005',
      p_source_message_id => '40000000-0000-4000-a039-000000000005',
      p_starts_at => '2039-09-10T14:00:00Z',
      p_ends_at => '2039-09-10T14:30:00Z',
      p_claim_token => '50000000-0000-4000-a039-000000000003',
      p_google_calendar_id => 'ignored-on-reclaim',
      p_event_summary => 'Ignored on Reclaim',
      p_request_fingerprint =>
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    )
  $$,
  'a failed reservation can be reclaimed'
);

-- 81
SELECT ok(
  (
    SELECT status = 'pending'
       AND google_calendar_id = 'primary'
       AND event_summary = 'Estimate - Primary'
       AND operation_claim_token =
             '50000000-0000-4000-a039-000000000003'::uuid
       AND operation_claimed_at IS NOT NULL
       AND failed_at IS NULL
       AND failure_reason IS NULL
    FROM public.calendar_bookings
    WHERE source_message_id =
          '40000000-0000-4000-a039-000000000005'
  ),
  'failed reclaim restores a clean pending lease without mutating identity'
);

-- 82
SELECT throws_ok(
  $$
    SELECT public.confirm_calendar_booking(
      p_business_id => '10000000-0000-4000-a039-000000000002',
      p_booking_id => (
        SELECT id
        FROM public.calendar_bookings
        WHERE source_message_id =
              '40000000-0000-4000-a039-000000000005'
      ),
      p_google_event_id => 'google-primary-039',
      p_starts_at => '2039-09-10T14:00:00Z',
      p_ends_at => '2039-09-10T14:30:00Z',
      p_claim_token => '50000000-0000-4000-a039-000000000003'
    )
  $$,
  '23503',
  NULL,
  'confirmation rejects a booking from another tenant'
);

-- 83
SELECT throws_ok(
  $$
    SELECT public.confirm_calendar_booking(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_booking_id => (
        SELECT id
        FROM public.calendar_bookings
        WHERE source_message_id =
              '40000000-0000-4000-a039-000000000005'
      ),
      p_google_event_id => 'google-primary-039',
      p_starts_at => '2039-09-10T14:00:00Z',
      p_ends_at => '2039-09-10T14:30:00Z',
      p_claim_token => '50000000-0000-4000-a039-000000000009'
    )
  $$,
  '42501',
  NULL,
  'a losing claim cannot confirm a booking'
);

-- 84
SELECT lives_ok(
  $$
    SELECT public.confirm_calendar_booking(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_booking_id => (
        SELECT id
        FROM public.calendar_bookings
        WHERE source_message_id =
              '40000000-0000-4000-a039-000000000005'
      ),
      p_google_event_id => ' google-primary-039 ',
      p_starts_at => '2039-09-10T14:05:00Z',
      p_ends_at => '2039-09-10T14:35:00Z',
      p_claim_token => '50000000-0000-4000-a039-000000000003'
    )
  $$,
  'the active claim confirms the provider event'
);

-- 85
SELECT ok(
  (
    SELECT status = 'confirmed'
       AND google_event_id = 'google-primary-039'
       AND starts_at = '2039-09-10T14:05:00Z'::timestamptz
       AND ends_at = '2039-09-10T14:35:00Z'::timestamptz
       AND operation_claim_token IS NULL
       AND operation_claimed_at IS NULL
       AND confirmed_at IS NOT NULL
    FROM public.calendar_bookings
    WHERE source_message_id =
          '40000000-0000-4000-a039-000000000005'
  ),
  'confirmation persists the complete confirmed shape'
);

-- 86
SELECT is(
  (
    SELECT lead_status
    FROM public.contacts
    WHERE id = '20000000-0000-4000-a039-000000000005'
  ),
  'hot',
  'booking confirmation promotes the linked contact to HOT transactionally'
);

-- 87
SELECT ok(
  (
    SELECT count(*) = 1
       AND bool_and(reason = 'booking_confirmed')
       AND bool_and(
         conversation_id =
           '30000000-0000-4000-a039-000000000005'::uuid
       )
       AND bool_and(
         source_message_id =
           '40000000-0000-4000-a039-000000000005'::uuid
       )
       AND bool_and(
         calendar_booking_id = (
           SELECT id
           FROM public.calendar_bookings
           WHERE source_message_id =
                 '40000000-0000-4000-a039-000000000005'
         )
       )
    FROM public.lead_events
    WHERE contact_id = '20000000-0000-4000-a039-000000000005'
  ),
  'confirmation emits one booking-linked became-HOT audit'
);

-- 88
SELECT lives_ok(
  $$
    SELECT public.confirm_calendar_booking(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_booking_id => (
        SELECT id
        FROM public.calendar_bookings
        WHERE source_message_id =
              '40000000-0000-4000-a039-000000000005'
      ),
      p_google_event_id => 'google-primary-039',
      p_starts_at => '2039-09-10T14:05:00Z',
      p_ends_at => '2039-09-10T14:35:00Z',
      p_claim_token => '50000000-0000-4000-a039-000000000003'
    )
  $$,
  'same-event confirmation is idempotent'
);

-- 89
SELECT throws_ok(
  $$
    SELECT public.confirm_calendar_booking(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_booking_id => (
        SELECT id
        FROM public.calendar_bookings
        WHERE source_message_id =
              '40000000-0000-4000-a039-000000000005'
      ),
      p_google_event_id => 'google-conflict-039',
      p_starts_at => '2039-09-10T14:05:00Z',
      p_ends_at => '2039-09-10T14:35:00Z',
      p_claim_token => '50000000-0000-4000-a039-000000000003'
    )
  $$,
  '23514',
  NULL,
  'a confirmed booking rejects a conflicting provider event'
);

-- 90
SELECT lives_ok(
  $$
    DO $secondary_calendar$
    DECLARE
      v_booking public.calendar_bookings;
    BEGIN
      v_booking := public.reserve_calendar_booking(
        p_business_id => '10000000-0000-4000-a039-000000000001',
        p_contact_id => '20000000-0000-4000-a039-000000000006',
        p_conversation_id => '30000000-0000-4000-a039-000000000006',
        p_source_message_id => '40000000-0000-4000-a039-000000000006',
        p_starts_at => '2039-09-11T14:00:00Z',
        p_ends_at => '2039-09-11T14:30:00Z',
        p_claim_token => '50000000-0000-4000-a039-000000000006',
        p_google_calendar_id => 'secondary',
        p_event_summary => 'Estimate - Secondary',
        p_request_fingerprint =>
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
      );
      PERFORM public.confirm_calendar_booking(
        p_business_id => v_booking.business_id,
        p_booking_id => v_booking.id,
        p_google_event_id => 'google-primary-039',
        p_starts_at => v_booking.starts_at,
        p_ends_at => v_booking.ends_at,
        p_claim_token => v_booking.operation_claim_token
      );
    END;
    $secondary_calendar$
  $$,
  'the same provider event id can exist on a different Google calendar'
);

-- 91
SELECT ok(
  (
    SELECT status = 'confirmed'
       AND google_calendar_id = 'secondary'
       AND google_event_id = 'google-primary-039'
    FROM public.calendar_bookings
    WHERE source_message_id =
          '40000000-0000-4000-a039-000000000006'
  ),
  'provider event identity remains calendar-scoped'
);

-- 92
SELECT lives_ok(
  $$
    SELECT public.reserve_calendar_booking(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_contact_id => '20000000-0000-4000-a039-000000000007',
      p_conversation_id => '30000000-0000-4000-a039-000000000007',
      p_source_message_id => '40000000-0000-4000-a039-000000000007',
      p_starts_at => '2039-09-12T14:00:00Z',
      p_ends_at => '2039-09-12T14:30:00Z',
      p_claim_token => '50000000-0000-4000-a039-000000000007',
      p_google_calendar_id => 'primary',
      p_event_summary => 'Estimate - Duplicate',
      p_request_fingerprint =>
        'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    )
  $$,
  'a distinct customer message reserves a second primary-calendar booking'
);

-- 93
SELECT throws_ok(
  $$
    SELECT public.confirm_calendar_booking(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_booking_id => (
        SELECT id
        FROM public.calendar_bookings
        WHERE source_message_id =
              '40000000-0000-4000-a039-000000000007'
      ),
      p_google_event_id => 'google-primary-039',
      p_starts_at => '2039-09-12T14:00:00Z',
      p_ends_at => '2039-09-12T14:30:00Z',
      p_claim_token => '50000000-0000-4000-a039-000000000007'
    )
  $$,
  '23505',
  NULL,
  'one tenant/calendar cannot link the same provider event twice'
);

-- 94
SELECT ok(
  (
    SELECT booking.status = 'pending'
       AND contact.lead_status = 'normal'
       AND NOT EXISTS (
         SELECT 1
         FROM public.lead_events AS event
         WHERE event.contact_id = contact.id
       )
    FROM public.calendar_bookings AS booking
    JOIN public.contacts AS contact
      ON contact.id = booking.contact_id
    WHERE booking.source_message_id =
          '40000000-0000-4000-a039-000000000007'
  ),
  'event collision rolls back booking confirmation and HOT promotion together'
);

-- 95
SELECT throws_ok(
  $$
    SELECT public.promote_contact_lead_status(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_contact_id => '20000000-0000-4000-a039-000000000001',
      p_new_status => 'hot',
      p_reason => 'booking_confirmed',
      p_conversation_id => '30000000-0000-4000-a039-000000000001',
      p_source_message_id => '40000000-0000-4000-a039-000000000001',
      p_calendar_booking_id => (
        SELECT id
        FROM public.calendar_bookings
        WHERE source_message_id =
              '40000000-0000-4000-a039-000000000005'
      )
    )
  $$,
  '23514',
  NULL,
  'promotion rejects a calendar booking linked to another contact'
);

RESET ROLE;

-- 96
SELECT throws_ok(
  $$
    INSERT INTO public.lead_events (
      business_id,
      contact_id,
      event_type,
      reason
    ) VALUES (
      '10000000-0000-4000-a039-000000000001',
      '20000000-0000-4000-a039-000000000011',
      'became_hot',
      'tenant mismatch'
    )
  $$,
  '23514',
  NULL,
  'lead audit rejects a contact from another tenant'
);

-- 97
SELECT throws_ok(
  $$
    INSERT INTO public.lead_events (
      business_id,
      contact_id,
      conversation_id,
      event_type,
      reason
    ) VALUES (
      '10000000-0000-4000-a039-000000000001',
      '20000000-0000-4000-a039-000000000007',
      '30000000-0000-4000-a039-000000000006',
      'became_hot',
      'tenant mismatch'
    )
  $$,
  '23514',
  NULL,
  'lead audit rejects a conversation from another contact'
);

-- 98
SELECT throws_ok(
  $$
    INSERT INTO public.lead_events (
      business_id,
      contact_id,
      conversation_id,
      source_message_id,
      event_type,
      reason
    ) VALUES (
      '10000000-0000-4000-a039-000000000001',
      '20000000-0000-4000-a039-000000000007',
      '30000000-0000-4000-a039-000000000007',
      '40000000-0000-4000-a039-000000000006',
      'became_hot',
      'tenant mismatch'
    )
  $$,
  '23514',
  NULL,
  'lead audit rejects a source message from another conversation'
);

-- 99
SELECT throws_ok(
  $$
    INSERT INTO public.lead_events (
      business_id,
      contact_id,
      conversation_id,
      source_message_id,
      calendar_booking_id,
      event_type,
      reason
    ) VALUES (
      '10000000-0000-4000-a039-000000000001',
      '20000000-0000-4000-a039-000000000007',
      '30000000-0000-4000-a039-000000000007',
      '40000000-0000-4000-a039-000000000007',
      (
        SELECT id
        FROM public.calendar_bookings
        WHERE source_message_id =
              '40000000-0000-4000-a039-000000000005'
      ),
      'became_hot',
      'tenant mismatch'
    )
  $$,
  '23514',
  NULL,
  'lead audit rejects a booking from another contact'
);

-- ---------------------------------------------------------------------------
-- Cancellation is terminal and account cleanup removes provider/PII linkage
-- ---------------------------------------------------------------------------

SET LOCAL ROLE service_role;

-- 100
SELECT lives_ok(
  $$
    UPDATE public.calendar_bookings
    SET status = 'cancelled',
        cancelled_at = clock_timestamp()
    WHERE source_message_id =
          '40000000-0000-4000-a039-000000000005'
  $$,
  'service cancellation can transition a confirmed booking'
);

-- 101
SELECT ok(
  (
    SELECT booking.status = 'cancelled'
       AND booking.cancelled_at IS NOT NULL
       AND contact.lead_status = 'hot'
    FROM public.calendar_bookings AS booking
    JOIN public.contacts AS contact
      ON contact.id = booking.contact_id
    WHERE booking.source_message_id =
          '40000000-0000-4000-a039-000000000005'
  ),
  'cancellation never downgrades the HOT contact'
);

RESET ROLE;

-- 102
SELECT throws_ok(
  $$
    UPDATE public.calendar_bookings
    SET status = 'confirmed',
        cancelled_at = NULL
    WHERE source_message_id =
          '40000000-0000-4000-a039-000000000005'
  $$,
  '23514',
  'cancelled calendar bookings are terminal',
  'cancelled bookings cannot be reopened'
);

SET LOCAL ROLE service_role;

-- 103
SELECT lives_ok(
  $$
    DO $cleanup_booking$
    DECLARE
      v_booking public.calendar_bookings;
    BEGIN
      v_booking := public.reserve_calendar_booking(
        p_business_id => '10000000-0000-4000-a039-000000000002',
        p_contact_id => '20000000-0000-4000-a039-000000000012',
        p_conversation_id => '30000000-0000-4000-a039-000000000012',
        p_source_message_id => '40000000-0000-4000-a039-000000000012',
        p_starts_at => '2039-09-13T14:00:00Z',
        p_ends_at => '2039-09-13T14:30:00Z',
        p_claim_token => '50000000-0000-4000-a039-000000000012',
        p_google_calendar_id => 'primary',
        p_event_summary => 'Estimate - Cleanup',
        p_request_fingerprint =>
          'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
      );
      PERFORM public.confirm_calendar_booking(
        p_business_id => v_booking.business_id,
        p_booking_id => v_booking.id,
        p_google_event_id => 'google-cleanup-039',
        p_starts_at => v_booking.starts_at,
        p_ends_at => v_booking.ends_at,
        p_claim_token => v_booking.operation_claim_token
      );
    END;
    $cleanup_booking$
  $$,
  'cleanup fixture has a confirmed booking and booking-linked HOT audit'
);

RESET ROLE;

-- 104
SELECT lives_ok(
  $$
    DO $cleanup_tombstone$
    BEGIN
      UPDATE public.contacts
      SET provided_phone_number = '+13175550999'
      WHERE id = '20000000-0000-4000-a039-000000000012';

      UPDATE public.businesses
      SET owner_id = NULL
      WHERE id = '10000000-0000-4000-a039-000000000002';
    END;
    $cleanup_tombstone$
  $$,
  'tombstoning a business runs hot-lead cleanup'
);

-- 105
SELECT ok(
  (
    SELECT provided_phone_number IS NULL
    FROM public.contacts
    WHERE id = '20000000-0000-4000-a039-000000000012'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.calendar_bookings
    WHERE business_id = '10000000-0000-4000-a039-000000000002'
  ),
  'cleanup clears volunteered phone PII and deletes provider booking linkage'
);

-- 106
SELECT ok(
  (
    SELECT contact.lead_status = 'hot'
       AND count(event.id) = 1
       AND bool_and(event.calendar_booking_id IS NULL)
    FROM public.contacts AS contact
    JOIN public.lead_events AS event
      ON event.contact_id = contact.id
    WHERE contact.id = '20000000-0000-4000-a039-000000000012'
    GROUP BY contact.lead_status
  ),
  'cleanup retains non-PII HOT audit history and nulls deleted booking linkage'
);

UPDATE public.calendar_bookings
SET operation_claimed_at = clock_timestamp() - interval '6 minutes'
WHERE source_message_id =
      '40000000-0000-4000-a039-000000000007';

-- 107
SET LOCAL ROLE service_role;
SELECT lives_ok(
  $$
    SELECT public.claim_calendar_booking_reconciliation(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_booking_id => (
        SELECT id
        FROM public.calendar_bookings
        WHERE source_message_id =
              '40000000-0000-4000-a039-000000000007'
      ),
      p_claim_token => '50000000-0000-4000-a039-000000000007'
    )
  $$,
  'the reconciler atomically renews an expired operation claim'
);
RESET ROLE;

-- 108
SELECT ok(
  (
    SELECT reconciliation_attempt_count = 1
       AND reconciliation_attempted_at IS NOT NULL
       AND operation_claimed_at >
             clock_timestamp() - interval '1 minute'
    FROM public.calendar_bookings
    WHERE source_message_id =
          '40000000-0000-4000-a039-000000000007'
  ),
  'reconciliation attempts rotate pending rows and renew their lease'
);

-- 109
SELECT throws_ok(
  $$
    UPDATE public.businesses
    SET owner_id = NULL
    WHERE id = '10000000-0000-4000-a039-000000000001'
  $$,
  '55000',
  'account cleanup is waiting for an in-flight calendar booking',
  'terminal cleanup cannot race a recently claimed provider operation'
);

-- 110
SET LOCAL ROLE service_role;
SELECT lives_ok(
  $$
    SELECT public.fail_calendar_booking(
      p_business_id => '10000000-0000-4000-a039-000000000001',
      p_booking_id => (
        SELECT id
        FROM public.calendar_bookings
        WHERE source_message_id =
              '40000000-0000-4000-a039-000000000007'
      ),
      p_claim_token => '50000000-0000-4000-a039-000000000007',
      p_failure_reason => 'reconciliation fixture complete'
    )
  $$,
  'a completed reconciliation releases the cleanup fence'
);
RESET ROLE;

-- 111
SELECT throws_ok(
  $$
    UPDATE public.conversations
    SET contact_id = '20000000-0000-4000-a039-000000000007'
    WHERE id = '30000000-0000-4000-a039-000000000005'
  $$,
  '23514',
  'conversation linkage is immutable while lead data exists',
  'parent conversation linkage cannot drift after booking validation'
);

-- 112
SELECT throws_ok(
  $$
    UPDATE public.messages
    SET role = 'assistant'
    WHERE id = '40000000-0000-4000-a039-000000000005'
  $$,
  '23514',
  'message linkage is immutable while lead data exists',
  'a booking source cannot later stop being customer-authored'
);

-- 113
SELECT lives_ok(
  $$
    DELETE FROM public.conversations
    WHERE id = '30000000-0000-4000-a039-000000000001'
  $$,
  'conversation retention cleanup atomically detaches lead audit linkage'
);

-- 114
SELECT ok(
  (
    SELECT count(*) = 1
       AND bool_and(conversation_id IS NULL)
       AND bool_and(source_message_id IS NULL)
       AND bool_and(calendar_booking_id IS NULL)
    FROM public.lead_events
    WHERE contact_id = '20000000-0000-4000-a039-000000000001'
  ),
  'conversation deletion retains one contact audit without dangling sources'
);

-- 115
SET LOCAL ROLE service_role;
SELECT throws_ok(
  $$
    SELECT public.reserve_calendar_booking(
      p_business_id => '10000000-0000-4000-a039-000000000002',
      p_contact_id => '20000000-0000-4000-a039-000000000012',
      p_conversation_id => '30000000-0000-4000-a039-000000000012',
      p_source_message_id => '40000000-0000-4000-a039-000000000012',
      p_starts_at => '2039-09-15T14:00:00Z',
      p_ends_at => '2039-09-15T14:30:00Z',
      p_claim_token => '50000000-0000-4000-a039-000000000012',
      p_google_calendar_id => 'primary',
      p_event_summary => 'Post-cleanup booking',
      p_request_fingerprint =>
        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    )
  $$,
  '23514',
  'calendar booking business is not active',
  'a tombstoned business cannot recreate provider booking linkage'
);
RESET ROLE;

DELETE FROM public.calendar_bookings
WHERE business_id IN (
  '10000000-0000-4000-a039-000000000001',
  '10000000-0000-4000-a039-000000000002'
);

DELETE FROM public.google_calendar_tokens
WHERE (id, business_id) IN (
  (
    '62000000-0000-4000-a039-000000000001',
    '10000000-0000-4000-a039-000000000001'
  ),
  (
    '62000000-0000-4000-a039-000000000002',
    '10000000-0000-4000-a039-000000000002'
  )
);

SELECT * FROM finish();

ROLLBACK;
