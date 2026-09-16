BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

SELECT plan(147);

-- ---------------------------------------------------------------------------
-- Durable shape, least privilege, and lock-order contracts
-- ---------------------------------------------------------------------------

-- 1
SELECT has_table(
  'public',
  'calendar_provider_operations',
  'calendar provider operations have a durable private table'
);

-- 2
SELECT is(
  (
    SELECT jsonb_object_agg(
      attribute.attname,
      format_type(attribute.atttypid, attribute.atttypmod)
    )
    FROM pg_attribute AS attribute
    WHERE attribute.attrelid =
          'public.calendar_provider_operations'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ),
  jsonb_build_object(
    'id', 'uuid',
    'business_id', 'uuid',
    'operation_kind', 'text',
    'google_calendar_id', 'text',
    'desired_starts_at', 'timestamp with time zone',
    'desired_ends_at', 'timestamp with time zone',
    'linked_booking_id', 'uuid',
    'deterministic_google_event_id', 'text',
    'target_google_event_id', 'text',
    'provider_target_event_id', 'text',
    'request_fingerprint', 'text',
    'status', 'text',
    'claim_token', 'uuid',
    'claimed_at', 'timestamp with time zone',
    'claim_expires_at', 'timestamp with time zone',
    'claim_released_at', 'timestamp with time zone',
    'reconciliation_review_after_at', 'timestamp with time zone',
    'attempt_count', 'integer',
    'provider_submission_started_at', 'timestamp with time zone',
    'provider_event_id', 'text',
    'provider_starts_at', 'timestamp with time zone',
    'provider_ends_at', 'timestamp with time zone',
    'provider_evidence', 'jsonb',
    'provider_applied_at', 'timestamp with time zone',
    'finalized_at', 'timestamp with time zone',
    'failed_at', 'timestamp with time zone',
    'failure_reason', 'text',
    'reconciliation_claim_token', 'uuid',
    'reconciliation_claimed_at', 'timestamp with time zone',
    'reconciliation_claim_expires_at', 'timestamp with time zone',
    'reconciliation_attempt_count', 'integer',
    'reconciliation_attempted_at', 'timestamp with time zone',
    'created_at', 'timestamp with time zone',
    'updated_at', 'timestamp with time zone'
  ),
  'provider operations expose only the exact thirty-four lifecycle columns'
);

-- 3
SELECT ok(
  (
    SELECT attribute.attgenerated = 's'
       AND pg_get_expr(default_value.adbin, default_value.adrelid) =
             'COALESCE(target_google_event_id, deterministic_google_event_id)'
    FROM pg_attribute AS attribute
    JOIN pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid =
          'public.calendar_provider_operations'::regclass
      AND attribute.attname = 'provider_target_event_id'
  ),
  'the provider target is a stored coalesced create/update/delete identity'
);

-- 4
SELECT ok(
  (
    SELECT pg_get_expr(default_value.adbin, default_value.adrelid) =
             '''holding''::text'
    FROM pg_attribute AS attribute
    JOIN pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid =
          'public.calendar_provider_operations'::regclass
      AND attribute.attname = 'status'
  )
  AND (
    SELECT pg_get_expr(default_value.adbin, default_value.adrelid) = '1'
    FROM pg_attribute AS attribute
    JOIN pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid =
          'public.calendar_provider_operations'::regclass
      AND attribute.attname = 'attempt_count'
  )
  AND (
    SELECT pg_get_expr(default_value.adbin, default_value.adrelid) = '0'
    FROM pg_attribute AS attribute
    JOIN pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid =
          'public.calendar_provider_operations'::regclass
      AND attribute.attname = 'reconciliation_attempt_count'
  ),
  'new provider operations default to one holding attempt and no reconciliation'
);

-- 5
SELECT is(
  (
    SELECT count(*)::integer
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
          'public.calendar_provider_operations'::regclass
      AND constraint_row.convalidated
      AND constraint_row.conname IN (
        'calendar_provider_operations_kind_valid',
        'calendar_provider_operations_status_valid',
        'calendar_provider_operations_time_order',
        'calendar_provider_operations_calendar_id_valid',
        'calendar_provider_operations_fingerprint_valid',
        'calendar_provider_operations_attempt_count_valid',
        'calendar_provider_operations_reconciliation_attempt_count_valid',
        'calendar_provider_operations_provider_time_order',
        'calendar_provider_operations_failure_reason_valid',
        'calendar_provider_operations_event_ids_valid',
        'calendar_provider_operations_evidence_valid',
        'calendar_provider_operations_kind_shape',
        'calendar_provider_operations_claim_shape',
        'calendar_provider_operations_reconciliation_claim_shape',
        'calendar_provider_operations_lifecycle_shape'
      )
  ),
  15,
  'all fifteen provider identity, evidence, claim, and lifecycle checks are validated'
);

SELECT ok(
  (
    SELECT pg_get_constraintdef(constraint_row.oid) LIKE ALL (ARRAY[
      '%length(deterministic_google_event_id) >= 5%',
      '%length(deterministic_google_event_id) <= 1024%',
      '%deterministic_google_event_id ~ ''^[0-9a-v]+$''%'
    ])
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
          'public.calendar_provider_operations'::regclass
      AND constraint_row.conname =
          'calendar_provider_operations_event_ids_valid'
  )
  AND pg_get_functiondef(
    'public.acquire_calendar_provider_operation(uuid,uuid,text,text,timestamptz,timestamptz,uuid,text,text,text,uuid)'::regprocedure
  ) LIKE ALL (ARRAY[
    '%length(p_deterministic_google_event_id) < 5%',
    '%length(p_deterministic_google_event_id) > 1024%',
    '%p_deterministic_google_event_id !~ ''^[0-9a-v]+$''%'
  ]),
  'deterministic provider IDs use explicit Google length and base32hex character checks'
);

-- 6
SELECT ok(
  pg_get_indexdef(
    'public.calendar_provider_operations_create_event_unique'::regclass
  ) LIKE '%business_id, google_calendar_id, deterministic_google_event_id%'
  AND pg_get_indexdef(
    'public.calendar_provider_operations_live_slot_idx'::regclass
  ) LIKE '%status = ANY (ARRAY[''holding''::text, ''provider_applied''::text])%'
  AND pg_get_indexdef(
    'public.calendar_provider_operations_reconciliation_idx'::regclass
  ) LIKE '%reconciliation_attempted_at%created_at%'
  AND pg_get_indexdef(
    'public.calendar_provider_operations_live_target_unique'::regclass
  ) LIKE '%provider_target_event_id%status = ANY (ARRAY[''holding''::text, ''provider_applied''::text])%',
  'provider operations have exact create, live-slot, fair-queue, and live-target indexes'
);

-- 7
SELECT ok(
  (
    SELECT class.relrowsecurity
    FROM pg_class AS class
    WHERE class.oid = 'public.calendar_provider_operations'::regclass
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_policy AS policy
    WHERE policy.polrelid =
          'public.calendar_provider_operations'::regclass
  ),
  'provider operations enable RLS without any customer-visible policy'
);

-- 8
SELECT ok(
  has_table_privilege(
    'service_role',
    'public.calendar_provider_operations',
    'SELECT'
  )
  AND NOT has_table_privilege(
    'service_role',
    'public.calendar_provider_operations',
    'INSERT'
  )
  AND NOT has_table_privilege(
    'service_role',
    'public.calendar_provider_operations',
    'UPDATE'
  )
  AND NOT has_table_privilege(
    'service_role',
    'public.calendar_provider_operations',
    'DELETE'
  )
  AND NOT has_table_privilege(
    'authenticated',
    'public.calendar_provider_operations',
    'SELECT'
  )
  AND NOT has_table_privilege(
    'authenticated',
    'public.calendar_provider_operations',
    'INSERT'
  )
  AND NOT has_table_privilege(
    'authenticated',
    'public.calendar_provider_operations',
    'UPDATE'
  )
  AND NOT has_table_privilege(
    'authenticated',
    'public.calendar_provider_operations',
    'DELETE'
  )
  AND NOT has_table_privilege(
    'anon',
    'public.calendar_provider_operations',
    'SELECT'
  )
  AND NOT has_table_privilege(
    'anon',
    'public.calendar_provider_operations',
    'INSERT'
  )
  AND NOT has_table_privilege(
    'anon',
    'public.calendar_provider_operations',
    'UPDATE'
  )
  AND NOT has_table_privilege(
    'anon',
    'public.calendar_provider_operations',
    'DELETE'
  ),
  'the lifecycle table is service-readable and RPC-write-only'
);

-- 9
SELECT ok(
  NOT has_table_privilege(
    'authenticated',
    'public.google_calendar_tokens',
    'INSERT'
  )
  AND NOT has_table_privilege(
    'authenticated',
    'public.google_calendar_tokens',
    'UPDATE'
  )
  AND NOT has_table_privilege(
    'authenticated',
    'public.google_calendar_tokens',
    'DELETE'
  )
  AND NOT has_table_privilege(
    'anon',
    'public.google_calendar_tokens',
    'INSERT'
  )
  AND NOT has_table_privilege(
    'anon',
    'public.google_calendar_tokens',
    'UPDATE'
  )
  AND NOT has_table_privilege(
    'anon',
    'public.google_calendar_tokens',
    'DELETE'
  ),
  'browser roles cannot bypass the guarded Google credential lifecycle'
);

-- 9a
SELECT ok(
  (
    SELECT attribute.atttypid = 'uuid'::regtype
       AND attribute.attnotnull
       AND pg_get_expr(default_value.adbin, default_value.adrelid) =
             'gen_random_uuid()'
       AND col_description(attribute.attrelid, attribute.attnum) LIKE
             '%Non-secret CAS generation%'
    FROM pg_attribute AS attribute
    JOIN pg_attrdef AS default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid =
          'public.google_calendar_tokens'::regclass
      AND attribute.attname = 'credential_version'
  ),
  'Google credentials carry a required non-secret CAS generation'
);

-- 9b
SELECT ok(
  (
    SELECT constraint_row.convalidated
       AND pg_get_constraintdef(constraint_row.oid) LIKE ALL (ARRAY[
             '%google_email = lower(btrim(google_email))%',
             '%length(google_email)%3%254%',
             '%calendar_id = btrim(calendar_id)%',
             '%length(calendar_id)%1%1024%',
             '%[^[:space:]@]+@[^[:space:]@]+%'
           ])
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
          'public.google_calendar_tokens'::regclass
      AND constraint_row.conname =
          'google_calendar_tokens_provider_namespace_valid'
  ),
  'Google credentials require a normalized bounded account/calendar namespace'
);

-- 9c
SELECT ok(
  has_table_privilege(
    'service_role',
    'public.google_calendar_tokens',
    'DELETE'
  )
  AND has_table_privilege(
    'service_role',
    'public.google_calendar_tokens',
    'UPDATE'
  )
  AND EXISTS (
    SELECT 1
    FROM pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.google_calendar_tokens'::regclass
      AND trigger_row.tgname = 'guard_google_calendar_token_delete'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND pg_get_triggerdef(trigger_row.oid) LIKE
            '%BEFORE DELETE ON public.google_calendar_tokens%'
      AND trigger_row.tgfoid =
          'public.guard_google_calendar_token_delete()'::regprocedure
  )
  AND (
    SELECT procedure.prosecdef
       AND procedure.proconfig =
             ARRAY['search_path=public, pg_temp']::text[]
       AND NOT has_function_privilege(
             'service_role', procedure.oid, 'EXECUTE'
           )
    FROM pg_proc AS procedure
    WHERE procedure.oid =
          'public.guard_google_calendar_token_delete()'::regprocedure
  ),
  'service cleanup retains DELETE while a pinned table trigger enforces provider authority'
);

-- 9d
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.google_calendar_tokens'::regclass
      AND trigger_row.tgname =
          'rotate_google_calendar_token_credential_version'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND pg_get_triggerdef(trigger_row.oid) LIKE
            '%BEFORE INSERT OR UPDATE ON public.google_calendar_tokens%'
      AND trigger_row.tgfoid =
          'public.rotate_google_calendar_token_credential_version()'::regprocedure
  )
  AND (
    SELECT procedure.prosecdef
       AND procedure.proconfig =
             ARRAY['search_path=public, pg_temp']::text[]
       AND NOT has_function_privilege(
             'service_role', procedure.oid, 'EXECUTE'
           )
    FROM pg_proc AS procedure
    WHERE procedure.oid =
          'public.rotate_google_calendar_token_credential_version()'::regprocedure
  ),
  'a pinned uncallable table trigger rotates every legacy credential mutation generation'
);

-- 10
SELECT ok(
  obj_description(
    'public.calendar_provider_operations'::regclass,
    'pg_class'
  ) LIKE '%Private durable intents%provider evidence%'
  AND NOT EXISTS (
    SELECT 1
    FROM pg_attribute AS attribute
    WHERE attribute.attrelid =
          'public.calendar_provider_operations'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attname IN (
        'customer_email',
        'customer_name',
        'event_summary',
        'event_description',
        'event_location',
        'attendees',
        'provider_payload',
        'raw_response'
      )
  ),
  'the private operation row has no raw customer or provider payload columns'
);

-- 11
SELECT ok(
  pg_get_constraintdef(
    (
      SELECT constraint_row.oid
      FROM pg_constraint AS constraint_row
      WHERE constraint_row.conrelid =
            'public.calendar_provider_operations'::regclass
        AND constraint_row.conname =
            'calendar_provider_operations_evidence_valid'
    )
  ) LIKE ALL (ARRAY[
    '%operation_marker_verified%',
    '%provider_status%',
    '%provider_etag_sha256%',
    '%provider_absence_verified%'
  ])
  AND pg_get_constraintdef(
    (
      SELECT constraint_row.oid
      FROM pg_constraint AS constraint_row
      WHERE constraint_row.conrelid =
            'public.calendar_provider_operations'::regclass
        AND constraint_row.conname =
            'calendar_provider_operations_evidence_valid'
    )
  ) NOT LIKE ALL (ARRAY[
    '%customer_email%',
    '%event_summary%',
    '%description%',
    '%location%',
    '%attendee%',
    '%payload%'
  ]),
  'provider evidence is constrained to the four content-free proof keys'
);

-- 12
SELECT is(
  (
    SELECT count(*)::integer
    FROM (
      VALUES
        ('public.acquire_calendar_provider_operation(uuid,uuid,text,text,timestamptz,timestamptz,uuid,text,text,text,uuid)'),
        ('public.mark_calendar_provider_submission_started(uuid,uuid,uuid)'),
        ('public.mark_calendar_provider_operation_applied(uuid,uuid,uuid,text,timestamptz,timestamptz,jsonb)'),
        ('public.mark_calendar_provider_delete_applied(uuid,uuid,uuid,text)'),
        ('public.finalize_calendar_provider_operation(uuid,uuid)'),
        ('public.resolve_calendar_provider_operation_absent(uuid,uuid,uuid)'),
        ('public.fail_calendar_provider_operation(uuid,uuid,uuid,text)'),
        ('public.claim_next_calendar_provider_operation_reconciliation(uuid)'),
        ('public.disconnect_google_calendar_token(uuid)'),
        ('public.persist_google_calendar_token_refresh_if_unchanged(uuid,uuid,text,timestamptz)'),
        ('public.disconnect_google_calendar_token_if_unchanged(uuid,uuid)'),
        ('public.mark_calendar_booking_submission_started(uuid,uuid,uuid,timestamptz)')
    ) AS expected(identity)
    WHERE to_regprocedure(expected.identity) IS NOT NULL
  ),
  12,
  'all twelve provider-operation, booking-fence, and credential-CAS RPC identities exist exactly'
);

-- 13
SELECT ok(
  (
    SELECT count(*) = 8
       AND bool_and(
         pg_get_function_result(procedure.oid) LIKE
           '%calendar_provider_operations%'
       )
    FROM pg_proc AS procedure
    WHERE procedure.pronamespace = 'public'::regnamespace
      AND procedure.proname IN (
        'acquire_calendar_provider_operation',
        'mark_calendar_provider_submission_started',
        'mark_calendar_provider_operation_applied',
        'mark_calendar_provider_delete_applied',
        'finalize_calendar_provider_operation',
        'resolve_calendar_provider_operation_absent',
        'fail_calendar_provider_operation',
        'claim_next_calendar_provider_operation_reconciliation'
      )
  )
  AND pg_get_function_result(
    'public.disconnect_google_calendar_token(uuid)'::regprocedure
  ) = 'text'
  AND pg_get_function_result(
    'public.persist_google_calendar_token_refresh_if_unchanged(uuid,uuid,text,timestamptz)'::regprocedure
  ) = 'boolean'
  AND pg_get_function_result(
    'public.disconnect_google_calendar_token_if_unchanged(uuid,uuid)'::regprocedure
  ) = 'boolean'
  AND pg_get_function_result(
    'public.mark_calendar_booking_submission_started(uuid,uuid,uuid,timestamptz)'::regprocedure
  ) LIKE '%calendar_bookings%',
  'lifecycle RPCs return durable rows while disconnect and credential CAS return bounded scalars'
);

-- 14
SELECT ok(
  (
    SELECT count(*) = 12
       AND bool_and(procedure.prosecdef)
       AND bool_and(
         procedure.proconfig = ARRAY['search_path=public, pg_temp']::text[]
       )
    FROM pg_proc AS procedure
    WHERE procedure.pronamespace = 'public'::regnamespace
      AND procedure.proname IN (
        'acquire_calendar_provider_operation',
        'mark_calendar_provider_submission_started',
        'mark_calendar_provider_operation_applied',
        'mark_calendar_provider_delete_applied',
        'finalize_calendar_provider_operation',
        'resolve_calendar_provider_operation_absent',
        'fail_calendar_provider_operation',
        'claim_next_calendar_provider_operation_reconciliation',
        'disconnect_google_calendar_token',
        'persist_google_calendar_token_refresh_if_unchanged',
        'disconnect_google_calendar_token_if_unchanged',
        'mark_calendar_booking_submission_started'
      )
  ),
  'all provider RPCs are pinned SECURITY DEFINER code'
);

-- 15
SELECT ok(
  (
    SELECT count(*) = 12
       AND bool_and(
         has_function_privilege('service_role', procedure.oid, 'EXECUTE')
       )
       AND bool_and(
         NOT has_function_privilege('authenticated', procedure.oid, 'EXECUTE')
       )
       AND bool_and(
         NOT has_function_privilege('anon', procedure.oid, 'EXECUTE')
       )
    FROM pg_proc AS procedure
    WHERE procedure.pronamespace = 'public'::regnamespace
      AND procedure.proname IN (
        'acquire_calendar_provider_operation',
        'mark_calendar_provider_submission_started',
        'mark_calendar_provider_operation_applied',
        'mark_calendar_provider_delete_applied',
        'finalize_calendar_provider_operation',
        'resolve_calendar_provider_operation_absent',
        'fail_calendar_provider_operation',
        'claim_next_calendar_provider_operation_reconciliation',
        'disconnect_google_calendar_token',
        'persist_google_calendar_token_refresh_if_unchanged',
        'disconnect_google_calendar_token_if_unchanged',
        'mark_calendar_booking_submission_started'
      )
  ),
  'only service_role can execute the provider lifecycle RPCs'
);

-- 16
SELECT ok(
  (
    SELECT procedure.prosecdef
       AND procedure.proconfig =
             ARRAY['search_path=public, pg_temp']::text[]
    FROM pg_proc AS procedure
    WHERE procedure.oid =
          'public.guard_hot_lead_cleanup_inflight()'::regprocedure
  )
  AND NOT has_function_privilege(
    'service_role',
    'public.guard_hot_lead_cleanup_inflight()',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.guard_hot_lead_cleanup_inflight()',
    'EXECUTE'
  ),
  'the account-cleanup trigger remains uncallable pinned definer code'
);

-- 17
SELECT ok(
  pg_get_functiondef(
    'public.reserve_calendar_booking(uuid,uuid,uuid,uuid,timestamptz,timestamptz,uuid,text,text,text)'::regprocedure
  ) LIKE ALL (ARRAY[
    '%FROM public.businesses AS business%',
    '%FOR UPDATE%',
    '%FROM public.google_calendar_tokens AS token%',
    '%FROM public.calendar_provider_operations AS operation%',
    '%operation.status IN (''holding'', ''provider_applied'')%'
  ])
  AND strpos(
    pg_get_functiondef(
      'public.reserve_calendar_booking(uuid,uuid,uuid,uuid,timestamptz,timestamptz,uuid,text,text,text)'::regprocedure
    ),
    'FROM public.google_calendar_tokens AS token'
  ) > strpos(
    pg_get_functiondef(
      'public.reserve_calendar_booking(uuid,uuid,uuid,uuid,timestamptz,timestamptz,uuid,text,text,text)'::regprocedure
    ),
    'SELECT booking.*'
  )
  AND strpos(
    pg_get_functiondef(
      'public.reserve_calendar_booking(uuid,uuid,uuid,uuid,timestamptz,timestamptz,uuid,text,text,text)'::regprocedure
    ),
    'IF v_booking.status = ''confirmed'''
  ) < strpos(
    pg_get_functiondef(
      'public.reserve_calendar_booking(uuid,uuid,uuid,uuid,timestamptz,timestamptz,uuid,text,text,text)'::regprocedure
    ),
    'FROM public.google_calendar_tokens AS token'
  ),
  'AI reservation recovers confirmed rows before credential checks but gates every provider-capable path'
);

-- 18
SELECT ok(
  pg_get_functiondef(
    'public.confirm_calendar_booking(uuid,uuid,text,timestamptz,timestamptz,uuid)'::regprocedure
  ) LIKE ALL (ARRAY[
    '%FROM public.businesses AS business%',
    '%FOR UPDATE%',
    '%operation.provider_target_event_id = btrim(p_google_event_id)%',
    '%operation.status IN (''holding'', ''provider_applied'')%',
    '%calendar_booking_slot_unavailable%'
  ]),
  'AI confirmation shares both provider target and provider slot fences'
);

-- 18a
WITH fence_sources AS (
  SELECT
    regexp_replace(
      pg_get_functiondef(
        'public.mark_calendar_provider_submission_started(uuid,uuid,uuid)'::regprocedure
      ),
      '[[:space:]]+',
      ' ',
      'g'
    ) AS provider_source,
    regexp_replace(
      pg_get_functiondef(
        'public.mark_calendar_booking_submission_started(uuid,uuid,uuid,timestamptz)'::regprocedure
      ),
      '[[:space:]]+',
      ' ',
      'g'
    ) AS booking_source
)
SELECT ok(
  strpos(provider_source, 'FROM public.businesses AS business') > 0
  AND strpos(provider_source, 'FROM public.calendar_provider_operations AS operation') >
        strpos(provider_source, 'FROM public.businesses AS business')
  AND provider_source LIKE ALL (ARRAY[
    '%v_operation.provider_submission_started_at IS NULL%',
    '%v_business.owner_id IS NULL%',
    '%v_business.deleted_at IS NOT NULL%',
    '%v_business.operations_suspended_at IS NOT NULL%',
    '%v_operation.operation_kind = ''create''%',
    '%v_business.bookings_paused_at IS NOT NULL%',
    '%FROM public.google_calendar_tokens AS token%',
    '%provider_submission_started_at = COALESCE(%',
    '%claimed_at = v_now%'
  ])
  AND (
    provider_source LIKE
      '%claim_expires_at = v_now + interval ''5 minutes''%'
    OR provider_source LIKE
      '%claim_expires_at = v_now + ''00:05:00''::interval%'
  )
  AND booking_source LIKE ALL (ARRAY[
    '%FROM public.businesses AS business%',
    '%FROM public.calendar_bookings AS booking%',
    '%FROM public.google_calendar_tokens AS token%',
    '%operation_claimed_at IS DISTINCT FROM p_expected_claimed_at%',
    '%SET operation_claimed_at = v_now%'
  ])
  AND strpos(booking_source, 'FROM public.businesses AS business') <
        strpos(booking_source, 'FROM public.calendar_bookings AS booking'),
  'both provider side-effect fences renew authority under business-first serialization'
)
FROM fence_sources;

-- 19
SELECT ok(
  strpos(
    pg_get_functiondef(
      'public.disconnect_google_calendar_token(uuid)'::regprocedure
    ),
    'FROM public.businesses AS business'
  ) < strpos(
    pg_get_functiondef(
      'public.disconnect_google_calendar_token(uuid)'::regprocedure
    ),
    'UPDATE public.calendar_provider_operations'
  )
  AND strpos(
    pg_get_functiondef(
      'public.disconnect_google_calendar_token(uuid)'::regprocedure
    ),
    'UPDATE public.calendar_provider_operations'
  ) < strpos(
    pg_get_functiondef(
      'public.disconnect_google_calendar_token(uuid)'::regprocedure
    ),
    'DELETE FROM public.google_calendar_tokens'
  )
  AND pg_get_functiondef(
    'public.disconnect_google_calendar_token(uuid)'::regprocedure
  ) LIKE ALL (ARRAY[
    '%booking.status = ''pending''%',
    '%operation.status IN (''holding'', ''provider_applied'')%',
    '%calendar_provider_operation_busy%'
  ]),
  'disconnect locks, retires safe pre-submit work, fences live work, then deletes credentials'
);

-- 20
SELECT ok(
  pg_get_functiondef(
    'public.claim_next_calendar_provider_operation_reconciliation(uuid)'::regprocedure
  ) LIKE ALL (ARRAY[
    '%reconciliation_attempted_at ASC NULLS FIRST%',
    '%operation.created_at%',
    '%operation.id%',
    '%reconciliation_claim_expires_at <= v_now%'
  ])
  AND pg_get_functiondef(
    'public.acquire_calendar_provider_operation(uuid,uuid,text,text,timestamptz,timestamptz,uuid,text,text,text,uuid)'::regprocedure
  ) NOT LIKE '%reconciliation_review_after_at <=%'
  AND pg_get_functiondef(
    'public.disconnect_google_calendar_token(uuid)'::regprocedure
  ) NOT LIKE '%reconciliation_review_after_at <=%',
  'fair reconciliation eligibility is lease-based and review time never releases authority'
);

-- 20a
WITH oauth_source AS (
  SELECT
    procedure.oid,
    procedure.prosecdef,
    procedure.proconfig,
    pg_get_functiondef(procedure.oid) AS source
  FROM pg_proc AS procedure
  WHERE procedure.oid =
    'public.complete_google_calendar_oauth_connection(uuid,uuid,uuid,uuid,text,text,text,timestamptz,text,text)'::regprocedure
)
SELECT ok(
  prosecdef
  AND proconfig = ARRAY['search_path=public, pg_temp']::text[]
  AND has_function_privilege('service_role', oid, 'EXECUTE')
  AND NOT has_function_privilege('anon', oid, 'EXECUTE')
  AND NOT has_function_privilege('authenticated', oid, 'EXECUTE')
  AND NOT EXISTS (
    SELECT 1
    FROM aclexplode(
      (SELECT procedure.proacl FROM pg_proc AS procedure WHERE procedure.oid = oauth_source.oid)
    ) AS acl
    WHERE acl.grantee = 0
      AND acl.privilege_type = 'EXECUTE'
  )
  AND strpos(source, 'SELECT business.*') > 0
  AND strpos(source, 'FOR UPDATE;') > strpos(source, 'SELECT business.*')
  AND strpos(source, 'INTO v_has_unresolved_provider_work') >
        strpos(source, 'FOR UPDATE;')
  AND strpos(source, 'SELECT token.*') >
        strpos(source, 'INTO v_has_unresolved_provider_work')
  AND source LIKE ALL (ARRAY[
    '%lower(btrim(v_existing_token.google_email))%',
    '%lower(btrim(p_google_email))%',
    '%v_existing_token.calendar_id%',
    '%calendar_provider_oauth_namespace_busy%',
    '%ERRCODE = ''55P03''%'
  ]),
  'service-only OAuth completion locks the business and forbids unresolved namespace switches'
)
FROM oauth_source;

-- 20b
SELECT ok(
  pg_get_functiondef(
    'public.claim_calendar_booking_reconciliation(uuid,uuid,uuid)'::regprocedure
  ) LIKE ALL (ARRAY[
    '%business.owner_id IS NOT NULL%',
    '%FROM public.businesses AS business%',
    '%FOR UPDATE%',
    '%FROM public.google_calendar_tokens AS token%',
    '%FROM public.calendar_bookings AS booking%'
  ])
  AND strpos(
    pg_get_functiondef(
      'public.claim_calendar_booking_reconciliation(uuid,uuid,uuid)'::regprocedure
    ),
    'FROM public.businesses AS business'
  ) < strpos(
    pg_get_functiondef(
      'public.claim_calendar_booking_reconciliation(uuid,uuid,uuid)'::regprocedure
    ),
    'FROM public.calendar_bookings AS booking'
  )
  AND strpos(
    pg_get_functiondef(
      'public.fail_calendar_booking(uuid,uuid,uuid,text)'::regprocedure
    ),
    'FROM public.businesses AS business'
  ) < strpos(
    pg_get_functiondef(
      'public.fail_calendar_booking(uuid,uuid,uuid,text)'::regprocedure
    ),
    'FROM public.calendar_bookings AS booking'
  ),
  'AI reconciliation and failure use the shared business-before-booking lock order'
);

-- ---------------------------------------------------------------------------
-- Tenant fixtures
-- ---------------------------------------------------------------------------

INSERT INTO auth.users (id, email)
VALUES
  (
    '00000000-0000-4000-a063-000000000001',
    'provider-operations-a063@example.test'
  ),
  (
    '00000000-0000-4000-a063-000000000002',
    'provider-cleanup-a063@example.test'
  ),
  (
    '00000000-0000-4000-a063-000000000003',
    'provider-expiry-a063@example.test'
  ),
  (
    '00000000-0000-4000-a063-000000000004',
    'provider-disconnect-a063@example.test'
  );

UPDATE public.businesses
SET id = '10000000-0000-4000-a063-000000000001',
    name = 'Provider Operations 063',
    slug = 'provider-operations-a063'
WHERE owner_id = '00000000-0000-4000-a063-000000000001';

UPDATE public.businesses
SET id = '10000000-0000-4000-a063-000000000002',
    name = 'Provider Cleanup 063',
    slug = 'provider-cleanup-a063'
WHERE owner_id = '00000000-0000-4000-a063-000000000002';

UPDATE public.businesses
SET id = '10000000-0000-4000-a063-000000000003',
    name = 'Provider Expiry 063',
    slug = 'provider-expiry-a063'
WHERE owner_id = '00000000-0000-4000-a063-000000000003';

UPDATE public.businesses
SET id = '10000000-0000-4000-a063-000000000004',
    name = 'Provider Disconnect 063',
    slug = 'provider-disconnect-a063'
WHERE owner_id = '00000000-0000-4000-a063-000000000004';

INSERT INTO public.ai_settings (
  business_id,
  booking_enabled,
  booking_mode
) VALUES
  (
    '10000000-0000-4000-a063-000000000001',
    false,
    'collect_info'
  ),
  (
    '10000000-0000-4000-a063-000000000002',
    false,
    'collect_info'
  ),
  (
    '10000000-0000-4000-a063-000000000003',
    false,
    'collect_info'
  ),
  (
    '10000000-0000-4000-a063-000000000004',
    false,
    'collect_info'
  );

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
    '62000000-0000-4000-a063-000000000001',
    '10000000-0000-4000-a063-000000000001',
    'fixture-access-a063-1',
    'fixture-refresh-a063-1',
    '2099-01-01 00:00:00+00',
    'primary',
    'provider-operations-a063@example.test',
    '2063-01-01 00:00:00+00',
    '2063-01-01 00:00:00+00'
  ),
  (
    '62000000-0000-4000-a063-000000000002',
    '10000000-0000-4000-a063-000000000002',
    'fixture-access-a063-2',
    'fixture-refresh-a063-2',
    '2099-01-01 00:00:00+00',
    'primary',
    'provider-cleanup-a063@example.test',
    '2063-01-01 00:00:00+00',
    '2063-01-01 00:00:00+00'
  ),
  (
    '62000000-0000-4000-a063-000000000003',
    '10000000-0000-4000-a063-000000000003',
    'fixture-access-a063-3',
    'fixture-refresh-a063-3',
    '2099-01-01 00:00:00+00',
    'primary',
    'provider-expiry-a063@example.test',
    '2063-01-01 00:00:00+00',
    '2063-01-01 00:00:00+00'
  ),
  (
    '62000000-0000-4000-a063-000000000004',
    '10000000-0000-4000-a063-000000000004',
    'fixture-access-a063-4',
    'fixture-refresh-a063-4',
    '2099-01-01 00:00:00+00',
    'primary',
    'provider-disconnect-a063@example.test',
    '2063-01-01 00:00:00+00',
    '2063-01-01 00:00:00+00'
  );

CREATE TEMP TABLE calendar_063_main_state (
  key text PRIMARY KEY,
  uuid_value uuid,
  timestamptz_value timestamptz
) ON COMMIT DROP;
GRANT SELECT, INSERT ON calendar_063_main_state TO service_role;

INSERT INTO calendar_063_main_state (key, uuid_value)
SELECT 'credential_version_initial', token.credential_version
FROM public.google_calendar_tokens AS token
WHERE token.business_id = '10000000-0000-4000-a063-000000000004';

INSERT INTO public.contacts (
  id,
  business_id,
  name,
  email,
  source_channel,
  lead_score
) VALUES (
  '20000000-0000-4000-a063-000000000001',
  '10000000-0000-4000-a063-000000000001',
  'Provider Operation Contact',
  'provider-operation-contact-a063@example.test',
  'web_chat',
  0
);

INSERT INTO public.conversations (
  id,
  business_id,
  contact_id,
  channel,
  status,
  is_ai_handling
) VALUES (
  '30000000-0000-4000-a063-000000000001',
  '10000000-0000-4000-a063-000000000001',
  '20000000-0000-4000-a063-000000000001',
  'web_chat',
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
    '40000000-0000-4000-a063-000000000001',
    '30000000-0000-4000-a063-000000000001',
    '10000000-0000-4000-a063-000000000001',
    'customer',
    'Create the linked booking fixture.',
    'web_chat'
  ),
  (
    '40000000-0000-4000-a063-000000000002',
    '30000000-0000-4000-a063-000000000001',
    '10000000-0000-4000-a063-000000000001',
    'customer',
    'Reserve the provider-operation slot.',
    'web_chat'
  ),
  (
    '40000000-0000-4000-a063-000000000003',
    '30000000-0000-4000-a063-000000000001',
    '10000000-0000-4000-a063-000000000001',
    'customer',
    'Try the slot while a dashboard operation holds it.',
    'web_chat'
  ),
  (
    '40000000-0000-4000-a063-000000000004',
    '30000000-0000-4000-a063-000000000001',
    '10000000-0000-4000-a063-000000000001',
    'customer',
    'Create the linked update and delete fixture.',
    'web_chat'
  );

SET LOCAL ROLE authenticated;

-- 21
SELECT throws_ok(
  $$
    SELECT count(*)
    FROM public.calendar_provider_operations
  $$,
  '42501',
  NULL,
  'authenticated customers cannot read provider operation rows'
);

-- 22
SELECT throws_ok(
  $$
    INSERT INTO public.google_calendar_tokens (
      business_id,
      access_token,
      refresh_token,
      token_expiry
    ) VALUES (
      '10000000-0000-4000-a063-000000000001',
      'browser-bypass-access',
      'browser-bypass-refresh',
      '2099-01-01 00:00:00+00'
    )
  $$,
  '42501',
  NULL,
  'authenticated customers cannot mutate Google credentials directly'
);

RESET ROLE;

SET LOCAL ROLE service_role;

-- 22a
SELECT lives_ok(
  $$
    UPDATE public.google_calendar_tokens
    SET access_token = 'legacy-service-update-access-a063'
    WHERE business_id = '10000000-0000-4000-a063-000000000004'
  $$,
  'a rolling legacy service writer can still update a credential row'
);

-- 22b
SELECT ok(
  (
    SELECT token.access_token = 'legacy-service-update-access-a063'
       AND token.credential_version IS DISTINCT FROM (
         SELECT state.uuid_value
         FROM calendar_063_main_state AS state
         WHERE state.key = 'credential_version_initial'
       )
    FROM public.google_calendar_tokens AS token
    WHERE token.business_id = '10000000-0000-4000-a063-000000000004'
  ),
  'the table trigger rotates credential generation for a legacy direct update'
);

RESET ROLE;

INSERT INTO calendar_063_main_state (key, uuid_value)
SELECT 'credential_version_after_legacy_update', token.credential_version
FROM public.google_calendar_tokens AS token
WHERE token.business_id = '10000000-0000-4000-a063-000000000004';

SET LOCAL ROLE service_role;

-- 22c
SELECT throws_ok(
  $$
    SELECT public.persist_google_calendar_token_refresh_if_unchanged(
      '10000000-0000-4000-a063-000000000004',
      NULL::uuid,
      'invalid-refresh-access-a063',
      '2099-02-01 00:00:00+00'
    )
  $$,
  '22023',
  'invalid Google Calendar refresh persistence input',
  'refresh persistence rejects a missing credential generation'
);

-- 22d
SELECT throws_ok(
  $$
    SELECT public.disconnect_google_calendar_token_if_unchanged(
      '10000000-0000-4000-a063-000000000004',
      NULL::uuid
    )
  $$,
  '22023',
  'invalid conditional Google Calendar disconnect input',
  'conditional invalid-credential disconnect rejects a missing generation'
);

-- 22e
SELECT is(
  public.persist_google_calendar_token_refresh_if_unchanged(
    '10000000-0000-4000-a063-000000000004',
    (
      SELECT state.uuid_value
      FROM calendar_063_main_state AS state
      WHERE state.key = 'credential_version_after_legacy_update'
    ),
    'refreshed-access-a063-4',
    '2099-02-01 00:00:00+00'
  ),
  true,
  'an exact credential generation atomically persists a bounded access refresh'
);

INSERT INTO calendar_063_main_state (key, uuid_value)
SELECT 'credential_version_refreshed', token.credential_version
FROM public.google_calendar_tokens AS token
WHERE token.business_id = '10000000-0000-4000-a063-000000000004';

-- 22f
SELECT ok(
  (
    SELECT token.access_token = 'refreshed-access-a063-4'
       AND token.refresh_token = 'fixture-refresh-a063-4'
       AND token.token_expiry = '2099-02-01 00:00:00+00'::timestamptz
       AND token.google_email = 'provider-disconnect-a063@example.test'
       AND token.calendar_id = 'primary'
       AND token.credential_version IS DISTINCT FROM (
             SELECT state.uuid_value
             FROM calendar_063_main_state AS state
             WHERE state.key = 'credential_version_after_legacy_update'
           )
    FROM public.google_calendar_tokens AS token
    WHERE token.business_id = '10000000-0000-4000-a063-000000000004'
  ),
  'refresh persistence rotates only the CAS generation and bounded access state'
);

-- 22g
SELECT is(
  public.persist_google_calendar_token_refresh_if_unchanged(
    '10000000-0000-4000-a063-000000000004',
    (
      SELECT state.uuid_value
      FROM calendar_063_main_state AS state
      WHERE state.key = 'credential_version_after_legacy_update'
    ),
    'stale-refresh-must-not-persist-a063',
    '2099-03-01 00:00:00+00'
  ),
  false,
  'a stale refresh generation cannot overwrite a newer credential'
);

-- 22h
SELECT ok(
  (
    SELECT token.access_token = 'refreshed-access-a063-4'
       AND token.token_expiry = '2099-02-01 00:00:00+00'::timestamptz
       AND token.credential_version = (
             SELECT state.uuid_value
             FROM calendar_063_main_state AS state
             WHERE state.key = 'credential_version_refreshed'
           )
    FROM public.google_calendar_tokens AS token
    WHERE token.business_id = '10000000-0000-4000-a063-000000000004'
  ),
  'a rejected stale refresh leaves the current credential byte-for-byte authoritative'
);

-- 22i
SELECT ok(
  NOT public.disconnect_google_calendar_token_if_unchanged(
    '10000000-0000-4000-a063-000000000004',
    (
      SELECT state.uuid_value
      FROM calendar_063_main_state AS state
      WHERE state.key = 'credential_version_after_legacy_update'
    )
  )
  AND EXISTS (
    SELECT 1
    FROM public.google_calendar_tokens AS token
    WHERE token.business_id = '10000000-0000-4000-a063-000000000004'
      AND token.credential_version = (
        SELECT state.uuid_value
        FROM calendar_063_main_state AS state
        WHERE state.key = 'credential_version_refreshed'
      )
  ),
  'a stale invalid-grant result cannot delete a replacement credential'
);

-- 22j
SELECT is(
  public.disconnect_google_calendar_token_if_unchanged(
    '10000000-0000-4000-a063-000000000004',
    (
      SELECT state.uuid_value
      FROM calendar_063_main_state AS state
      WHERE state.key = 'credential_version_refreshed'
    )
  ),
  true,
  'a definitive invalid credential can disconnect its exact unchanged generation'
);

-- 22k
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.google_calendar_tokens AS token
    WHERE token.business_id = '10000000-0000-4000-a063-000000000004'
  ),
  'successful conditional disconnect removes exactly the matched generation'
);

RESET ROLE;

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
) VALUES (
  '62000000-0000-4000-a063-000000000004',
  '10000000-0000-4000-a063-000000000004',
  'fixture-access-a063-4',
  'fixture-refresh-a063-4',
  '2099-01-01 00:00:00+00',
  'primary',
  'provider-disconnect-a063@example.test',
  '2063-01-01 00:00:00+00',
  '2063-01-01 00:00:00+00'
);

SET LOCAL ROLE service_role;
DO $seed_linked_booking$
DECLARE
  v_booking public.calendar_bookings;
BEGIN
  v_booking := public.reserve_calendar_booking(
    p_business_id => '10000000-0000-4000-a063-000000000001',
    p_contact_id => '20000000-0000-4000-a063-000000000001',
    p_conversation_id => '30000000-0000-4000-a063-000000000001',
    p_source_message_id => '40000000-0000-4000-a063-000000000001',
    p_starts_at => '2063-09-10 09:00:00+00',
    p_ends_at => '2063-09-10 09:30:00+00',
    p_claim_token => '50000000-0000-4000-a063-000000000001',
    p_google_calendar_id => 'primary',
    p_event_summary => 'Late Recovery Booking 063',
    p_request_fingerprint => repeat('f', 64)
  );

  PERFORM public.confirm_calendar_booking(
    p_business_id => v_booking.business_id,
    p_booking_id => v_booking.id,
    p_google_event_id => 'abcde0630000099',
    p_starts_at => v_booking.starts_at,
    p_ends_at => v_booking.ends_at,
    p_claim_token => v_booking.operation_claim_token
  );

  v_booking := public.reserve_calendar_booking(
    p_business_id => '10000000-0000-4000-a063-000000000001',
    p_contact_id => '20000000-0000-4000-a063-000000000001',
    p_conversation_id => '30000000-0000-4000-a063-000000000001',
    p_source_message_id => '40000000-0000-4000-a063-000000000004',
    p_starts_at => '2063-09-10 10:00:00+00',
    p_ends_at => '2063-09-10 10:30:00+00',
    p_claim_token => '50000000-0000-4000-a063-000000000004',
    p_google_calendar_id => 'primary',
    p_event_summary => 'Linked Booking 063',
    p_request_fingerprint => repeat('c', 64)
  );

  PERFORM public.confirm_calendar_booking(
    p_business_id => v_booking.business_id,
    p_booking_id => v_booking.id,
    p_google_event_id => 'abcde0630000002',
    p_starts_at => v_booking.starts_at,
    p_ends_at => v_booking.ends_at,
    p_claim_token => v_booking.operation_claim_token
  );
END;
$seed_linked_booking$;

-- ---------------------------------------------------------------------------
-- Create lifecycle, durable ambiguity, and AI interlock
-- ---------------------------------------------------------------------------

-- 23
SELECT throws_ok(
  $$
    SELECT public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000001',
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_kind => 'create',
      p_google_calendar_id => 'primary',
      p_starts_at => '2063-09-10 14:00:00+00',
      p_ends_at => '2063-09-10 14:30:00+00',
      p_linked_booking_id => NULL,
      p_deterministic_google_event_id => NULL,
      p_target_google_event_id => NULL,
      p_request_fingerprint => repeat('a', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000001'
    )
  $$,
  '22023',
  NULL,
  'create acquisition rejects a missing deterministic provider identity'
);

-- 24
SELECT lives_ok(
  $$
    SELECT public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000001',
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_kind => 'create',
      p_google_calendar_id => ' primary ',
      p_starts_at => '2063-09-10 14:00:00+00',
      p_ends_at => '2063-09-10 14:30:00+00',
      p_linked_booking_id => NULL,
      p_deterministic_google_event_id => 'abcde0630000001',
      p_target_google_event_id => NULL,
      p_request_fingerprint => repeat('a', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000001'
    )
  $$,
  'a connected active business can acquire one deterministic create operation'
);

-- 25
SELECT ok(
  (
    SELECT operation.operation_kind = 'create'
       AND operation.google_calendar_id = 'primary'
       AND operation.deterministic_google_event_id = 'abcde0630000001'
       AND operation.target_google_event_id IS NULL
       AND operation.provider_target_event_id = 'abcde0630000001'
       AND operation.status = 'holding'
       AND operation.claim_token =
             '63100000-0000-4000-a063-000000000001'::uuid
       AND operation.claim_expires_at > operation.claimed_at
       AND operation.reconciliation_review_after_at >
             operation.created_at + interval '47 hours'
       AND operation.attempt_count = 1
    FROM public.calendar_provider_operations AS operation
    WHERE operation.id = '63000000-0000-4000-a063-000000000001'
  ),
  'create acquisition persists its exact target, worker lease, and review SLA'
);

-- 26
SELECT is(
  (
    SELECT recovered.attempt_count
    FROM public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000001',
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_kind => 'create',
      p_google_calendar_id => 'primary',
      p_starts_at => '2063-09-10 14:00:00+00',
      p_ends_at => '2063-09-10 14:30:00+00',
      p_linked_booking_id => NULL,
      p_deterministic_google_event_id => 'abcde0630000001',
      p_target_google_event_id => NULL,
      p_request_fingerprint => repeat('a', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000001'
    ) AS recovered
  ),
  1,
  'an exact active-claim retry returns the original operation without another attempt'
);

-- 27
SELECT throws_ok(
  $$
    SELECT public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000001',
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_kind => 'create',
      p_google_calendar_id => 'primary',
      p_starts_at => '2063-09-10 14:00:00+00',
      p_ends_at => '2063-09-10 14:30:00+00',
      p_linked_booking_id => NULL,
      p_deterministic_google_event_id => 'abcde0630000001',
      p_target_google_event_id => NULL,
      p_request_fingerprint => repeat('b', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000001'
    )
  $$,
  '23514',
  'calendar_provider_operation_idempotency_conflict',
  'one operation id cannot be reused with a different request fingerprint'
);

-- 28
SELECT throws_ok(
  $$
    SELECT public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000001',
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_kind => 'create',
      p_google_calendar_id => 'primary',
      p_starts_at => '2063-09-10 14:00:00+00',
      p_ends_at => '2063-09-10 14:30:00+00',
      p_linked_booking_id => NULL,
      p_deterministic_google_event_id => 'abcde0630000001',
      p_target_google_event_id => NULL,
      p_request_fingerprint => repeat('a', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000002'
    )
  $$,
  '55P03',
  'calendar_provider_operation_busy',
  'a different worker cannot steal an active operation claim'
);

-- 28a
SELECT lives_ok(
  $$
    SELECT public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000043',
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_kind => 'create',
      p_google_calendar_id => 'primary',
      p_starts_at => '2063-09-12 16:00:00+00',
      p_ends_at => '2063-09-12 16:30:00+00',
      p_linked_booking_id => NULL,
      p_deterministic_google_event_id => 'abcde0630000043',
      p_target_google_event_id => NULL,
      p_request_fingerprint => repeat('d', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000043'
    )
  $$,
  'a create can acquire before a later bookings pause commits'
);

RESET ROLE;

UPDATE public.businesses
SET bookings_paused_at = clock_timestamp()
WHERE id = '10000000-0000-4000-a063-000000000001';

SET LOCAL ROLE service_role;

-- 28b
SELECT throws_ok(
  $$
    SELECT public.mark_calendar_provider_submission_started(
      '10000000-0000-4000-a063-000000000001',
      '63000000-0000-4000-a063-000000000043',
      '63100000-0000-4000-a063-000000000043'
    )
  $$,
  '55000',
  'calendar_provider_operation_business_unavailable',
  'a committed bookings pause wins before the first CREATE provider mutation'
);

-- 28c
SELECT ok(
  (
    SELECT operation.status = 'holding'
       AND operation.provider_submission_started_at IS NULL
       AND operation.provider_applied_at IS NULL
    FROM public.calendar_provider_operations AS operation
    WHERE operation.id = '63000000-0000-4000-a063-000000000043'
  ),
  'a rejected first-submission fence preserves content-free pre-submit state'
);

RESET ROLE;

UPDATE public.businesses
SET bookings_paused_at = NULL
WHERE id = '10000000-0000-4000-a063-000000000001';

SET LOCAL ROLE service_role;

-- 28d
SELECT lives_ok(
  $$
    SELECT public.fail_calendar_provider_operation(
      '10000000-0000-4000-a063-000000000001',
      '63000000-0000-4000-a063-000000000043',
      '63100000-0000-4000-a063-000000000043',
      'Provider submission was blocked by a later bookings pause.'
    )
  $$,
  'the side-effect-free paused CREATE can be terminalized without provider evidence'
);

-- 29
SELECT throws_ok(
  $$
    SELECT public.mark_calendar_provider_submission_started(
      '10000000-0000-4000-a063-000000000001',
      '63000000-0000-4000-a063-000000000001',
      '63100000-0000-4000-a063-000000000099'
    )
  $$,
  '42501',
  'calendar provider operation claim mismatch',
  'only the active worker can cross the durable provider-submission fence'
);

RESET ROLE;

UPDATE public.calendar_provider_operations
SET claimed_at = clock_timestamp() - interval '4 minutes 30 seconds',
    claim_expires_at = clock_timestamp() + interval '30 seconds'
WHERE id = '63000000-0000-4000-a063-000000000001';

SET LOCAL ROLE service_role;

-- 30
SELECT lives_ok(
  $$
    SELECT public.mark_calendar_provider_submission_started(
      '10000000-0000-4000-a063-000000000001',
      '63000000-0000-4000-a063-000000000001',
      '63100000-0000-4000-a063-000000000001'
    )
  $$,
  'the active worker durably marks provider submission before the side effect'
);

-- 31
SELECT ok(
  (
    SELECT operation.status = 'holding'
       AND operation.provider_submission_started_at IS NOT NULL
       AND operation.claimed_at > clock_timestamp() - interval '5 seconds'
       AND operation.claim_expires_at >
             clock_timestamp() + interval '4 minutes 55 seconds'
       AND operation.provider_applied_at IS NULL
       AND operation.provider_evidence IS NULL
    FROM public.calendar_provider_operations AS operation
    WHERE operation.id = '63000000-0000-4000-a063-000000000001'
  ),
  'submission start preserves a content-free ambiguous holding state'
);

RESET ROLE;

UPDATE public.calendar_provider_operations
SET claimed_at = clock_timestamp() - interval '6 minutes',
    claim_expires_at = clock_timestamp() - interval '1 minute',
    reconciliation_review_after_at = '2000-01-01 00:00:00+00'
WHERE id = '63000000-0000-4000-a063-000000000001';

UPDATE public.businesses
SET operations_suspended_at = clock_timestamp()
WHERE id = '10000000-0000-4000-a063-000000000001';

SET LOCAL ROLE service_role;

-- 32
SELECT lives_ok(
  $$
    SELECT public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000001',
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_kind => 'create',
      p_google_calendar_id => 'primary',
      p_starts_at => '2063-09-10 14:00:00+00',
      p_ends_at => '2063-09-10 14:30:00+00',
      p_linked_booking_id => NULL,
      p_deterministic_google_event_id => 'abcde0630000001',
      p_target_google_event_id => NULL,
      p_request_fingerprint => repeat('a', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000002'
    )
  $$,
  'post-submit ambiguity remains recoverable after suspension'
);

-- 33
SELECT ok(
  (
    SELECT operation.status = 'holding'
       AND operation.claim_token =
             '63100000-0000-4000-a063-000000000002'::uuid
       AND operation.attempt_count = 2
       AND operation.provider_submission_started_at IS NOT NULL
       AND operation.reconciliation_review_after_at >
             clock_timestamp() + interval '47 hours'
    FROM public.calendar_provider_operations AS operation
    WHERE operation.id = '63000000-0000-4000-a063-000000000001'
  ),
  'ambiguity recovery rotates the worker lease and extends review without losing authority'
);

RESET ROLE;

UPDATE public.businesses
SET operations_suspended_at = NULL
WHERE id = '10000000-0000-4000-a063-000000000001';

UPDATE public.calendar_provider_operations
SET claimed_at = clock_timestamp() - interval '6 minutes',
    claim_expires_at = clock_timestamp() - interval '1 minute',
    reconciliation_review_after_at = '2000-01-01 00:00:00+00'
WHERE id = '63000000-0000-4000-a063-000000000001';

SET LOCAL ROLE service_role;

-- 34
SELECT throws_ok(
  $$
    SELECT public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000002',
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_kind => 'update',
      p_google_calendar_id => 'primary',
      p_starts_at => '2063-09-10 15:00:00+00',
      p_ends_at => '2063-09-10 15:30:00+00',
      p_linked_booking_id => NULL,
      p_deterministic_google_event_id => NULL,
      p_target_google_event_id => 'abcde0630000001',
      p_request_fingerprint => repeat('b', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000004'
    )
  $$,
  '55P03',
  'calendar_provider_operation_busy',
  'an overdue ambiguous create still owns its target against update'
);

-- 35
SELECT throws_ok(
  $$
    SELECT public.reserve_calendar_booking(
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_contact_id => '20000000-0000-4000-a063-000000000001',
      p_conversation_id => '30000000-0000-4000-a063-000000000001',
      p_source_message_id => '40000000-0000-4000-a063-000000000003',
      p_starts_at => '2063-09-10 14:10:00+00',
      p_ends_at => '2063-09-10 14:20:00+00',
      p_claim_token => '50000000-0000-4000-a063-000000000003',
      p_google_calendar_id => 'primary',
      p_event_summary => 'Blocked by dashboard hold',
      p_request_fingerprint => repeat('e', 64)
    )
  $$,
  '23P01',
  'calendar_booking_slot_unavailable',
  'an overdue ambiguous dashboard hold still blocks an overlapping AI reservation'
);

-- 36
SELECT lives_ok(
  $$
    SELECT public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000001',
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_kind => 'create',
      p_google_calendar_id => 'primary',
      p_starts_at => '2063-09-10 14:00:00+00',
      p_ends_at => '2063-09-10 14:30:00+00',
      p_linked_booking_id => NULL,
      p_deterministic_google_event_id => 'abcde0630000001',
      p_target_google_event_id => NULL,
      p_request_fingerprint => repeat('a', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000003'
    )
  $$,
  'the exact ambiguous operation can rotate to another recovery worker'
);

-- 37
SELECT throws_ok(
  $$
    SELECT public.mark_calendar_provider_operation_applied(
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_id => '63000000-0000-4000-a063-000000000001',
      p_claim_token => '63100000-0000-4000-a063-000000000003',
      p_provider_event_id => 'abcde0630000001',
      p_provider_starts_at => '2063-09-10 14:05:00+00',
      p_provider_ends_at => '2063-09-10 14:35:00+00',
      p_provider_evidence => jsonb_build_object(
        'operation_marker_verified', true,
        'customer_email', 'must-not-persist@example.test'
      )
    )
  $$,
  '23514',
  NULL,
  'provider evidence rejects raw customer identity keys'
);

-- 38
SELECT ok(
  (
    SELECT operation.status = 'holding'
       AND operation.provider_evidence IS NULL
       AND operation.provider_event_id IS NULL
       AND operation.provider_applied_at IS NULL
    FROM public.calendar_provider_operations AS operation
    WHERE operation.id = '63000000-0000-4000-a063-000000000001'
  ),
  'rejected raw evidence leaves no partial provider payload behind'
);

-- 39
SELECT lives_ok(
  $$
    SELECT public.mark_calendar_provider_operation_applied(
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_id => '63000000-0000-4000-a063-000000000001',
      p_claim_token => '63100000-0000-4000-a063-000000000003',
      p_provider_event_id => 'abcde0630000001',
      p_provider_starts_at => '2063-09-10 14:05:00+00',
      p_provider_ends_at => '2063-09-10 14:35:00+00',
      p_provider_evidence => jsonb_build_object(
        'operation_marker_verified', true,
        'provider_status', 'confirmed',
        'provider_etag_sha256', repeat('c', 64)
      )
    )
  $$,
  'content-free provider evidence is durably applied before finalization'
);

-- 40
SELECT ok(
  (
    SELECT operation.status = 'provider_applied'
       AND operation.claim_token IS NULL
       AND operation.provider_event_id = 'abcde0630000001'
       AND operation.provider_starts_at =
             '2063-09-10 14:05:00+00'::timestamptz
       AND operation.provider_ends_at =
             '2063-09-10 14:35:00+00'::timestamptz
       AND operation.provider_evidence = jsonb_build_object(
             'operation_marker_verified', true,
             'provider_status', 'confirmed',
             'provider_etag_sha256', repeat('c', 64)
           )
       AND operation.provider_applied_at IS NOT NULL
    FROM public.calendar_provider_operations AS operation
    WHERE operation.id = '63000000-0000-4000-a063-000000000001'
  ),
  'provider-applied state clears the worker lease and stores exact sanitized proof'
);

RESET ROLE;

UPDATE public.businesses
SET operations_suspended_at = clock_timestamp()
WHERE id = '10000000-0000-4000-a063-000000000001';

SET LOCAL ROLE service_role;

-- 41
SELECT is(
  (
    SELECT recovered.status
    FROM public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000001',
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_kind => 'create',
      p_google_calendar_id => 'primary',
      p_starts_at => '2063-09-10 14:00:00+00',
      p_ends_at => '2063-09-10 14:30:00+00',
      p_linked_booking_id => NULL,
      p_deterministic_google_event_id => 'abcde0630000001',
      p_target_google_event_id => NULL,
      p_request_fingerprint => repeat('a', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000099'
    ) AS recovered
  ),
  'provider_applied',
  'exact provider-applied recovery precedes current suspension gates'
);

-- 42
SELECT throws_ok(
  $$
    SELECT public.mark_calendar_provider_operation_applied(
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_id => '63000000-0000-4000-a063-000000000001',
      p_claim_token => '63100000-0000-4000-a063-000000000099',
      p_provider_event_id => 'abcde0630000001',
      p_provider_starts_at => '2063-09-10 14:06:00+00',
      p_provider_ends_at => '2063-09-10 14:36:00+00',
      p_provider_evidence => jsonb_build_object(
        'operation_marker_verified', true
      )
    )
  $$,
  '23514',
  'calendar provider evidence conflict',
  'provider-applied recovery rejects contradictory provider times'
);

-- 43
SELECT is(
  (
    SELECT preserved.status
    FROM public.fail_calendar_provider_operation(
      '10000000-0000-4000-a063-000000000001',
      '63000000-0000-4000-a063-000000000001',
      '63100000-0000-4000-a063-000000000099',
      'must not erase applied evidence'
    ) AS preserved
  ),
  'provider_applied',
  'a generic failure path cannot erase durable applied evidence'
);

RESET ROLE;

UPDATE public.businesses
SET operations_suspended_at = NULL
WHERE id = '10000000-0000-4000-a063-000000000001';

UPDATE public.calendar_provider_operations
SET reconciliation_review_after_at = '2000-01-01 00:00:00+00'
WHERE id = '63000000-0000-4000-a063-000000000001';

SET LOCAL ROLE service_role;

-- 44
SELECT throws_ok(
  $$
    SELECT public.reserve_calendar_booking(
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_contact_id => '20000000-0000-4000-a063-000000000001',
      p_conversation_id => '30000000-0000-4000-a063-000000000001',
      p_source_message_id => '40000000-0000-4000-a063-000000000003',
      p_starts_at => '2063-09-10 14:10:00+00',
      p_ends_at => '2063-09-10 14:20:00+00',
      p_claim_token => '50000000-0000-4000-a063-000000000003',
      p_google_calendar_id => 'primary',
      p_event_summary => 'Blocked by applied evidence',
      p_request_fingerprint => repeat('e', 64)
    )
  $$,
  '23P01',
  'calendar_booking_slot_unavailable',
  'provider-applied evidence keeps blocking AI after its review SLA passes'
);

-- 45
SELECT lives_ok(
  $$
    SELECT public.finalize_calendar_provider_operation(
      '10000000-0000-4000-a063-000000000001',
      '63000000-0000-4000-a063-000000000001'
    )
  $$,
  'provider-applied create finalizes under the shared business mutex'
);

-- 46
SELECT ok(
  (
    SELECT operation.status = 'finalized'
       AND operation.finalized_at IS NOT NULL
       AND operation.provider_applied_at IS NOT NULL
       AND operation.provider_evidence ? 'operation_marker_verified'
       AND operation.reconciliation_claim_token IS NULL
    FROM public.calendar_provider_operations AS operation
    WHERE operation.id = '63000000-0000-4000-a063-000000000001'
  ),
  'finalization preserves proof and releases all reconciliation claims'
);

-- 47
SELECT is(
  (
    SELECT finalized.status
    FROM public.finalize_calendar_provider_operation(
      '10000000-0000-4000-a063-000000000001',
      '63000000-0000-4000-a063-000000000001'
    ) AS finalized
  ),
  'finalized',
  'finalization is idempotent for an already-finalized operation'
);

-- 48
SELECT lives_ok(
  $$
    SELECT public.reserve_calendar_booking(
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_contact_id => '20000000-0000-4000-a063-000000000001',
      p_conversation_id => '30000000-0000-4000-a063-000000000001',
      p_source_message_id => '40000000-0000-4000-a063-000000000002',
      p_starts_at => '2063-09-10 14:10:00+00',
      p_ends_at => '2063-09-10 14:20:00+00',
      p_claim_token => '50000000-0000-4000-a063-000000000002',
      p_google_calendar_id => 'primary',
      p_event_summary => 'AI reservation after finalization',
      p_request_fingerprint => repeat('d', 64)
    )
  $$,
  'a finalized dashboard hold no longer masquerades as unresolved authority'
);

-- 49
SELECT throws_ok(
  $$
    SELECT public.disconnect_google_calendar_token(
      '10000000-0000-4000-a063-000000000001'
    )
  $$,
  '55P03',
  'calendar_provider_operation_busy',
  'disconnect refuses to remove credentials beneath a pending AI booking'
);

-- 50
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.google_calendar_tokens AS token
    WHERE token.business_id = '10000000-0000-4000-a063-000000000001'
  ),
  'a rejected pending-booking disconnect leaves the credential row intact'
);

-- 51
SELECT throws_ok(
  $$
    SELECT public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000003',
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_kind => 'update',
      p_google_calendar_id => 'primary',
      p_starts_at => '2063-09-10 15:00:00+00',
      p_ends_at => '2063-09-10 15:30:00+00',
      p_linked_booking_id => NULL,
      p_deterministic_google_event_id => NULL,
      p_target_google_event_id => (
        SELECT replace(booking.id::text, '-', '')
        FROM public.calendar_bookings AS booking
        WHERE booking.source_message_id =
              '40000000-0000-4000-a063-000000000002'
      ),
      p_request_fingerprint => repeat('c', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000005'
    )
  $$,
  '55P03',
  'calendar_provider_operation_busy',
  'a pending AI booking owns its deterministic provider target before Google insert'
);

-- 52
SELECT throws_ok(
  $$
    SELECT public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000004',
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_kind => 'create',
      p_google_calendar_id => 'primary',
      p_starts_at => '2063-09-10 14:10:00+00',
      p_ends_at => '2063-09-10 14:20:00+00',
      p_linked_booking_id => NULL,
      p_deterministic_google_event_id => 'abcde0630000008',
      p_target_google_event_id => NULL,
      p_request_fingerprint => repeat('b', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000006'
    )
  $$,
  '23P01',
  'calendar_provider_slot_unavailable',
  'a pending AI booking also owns its local interval against dashboard create'
);

RESET ROLE;

UPDATE public.calendar_bookings
SET operation_claimed_at = clock_timestamp() - interval '4 minutes 59 seconds'
WHERE source_message_id = '40000000-0000-4000-a063-000000000002';

INSERT INTO calendar_063_main_state (key, timestamptz_value)
SELECT 'booking_submission_expected_claimed_at', booking.operation_claimed_at
FROM public.calendar_bookings AS booking
WHERE booking.source_message_id = '40000000-0000-4000-a063-000000000002';

SET LOCAL ROLE service_role;

-- 52a
SELECT lives_ok(
  $$
    SELECT public.mark_calendar_booking_submission_started(
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_booking_id => (
        SELECT booking.id
        FROM public.calendar_bookings AS booking
        WHERE booking.source_message_id =
              '40000000-0000-4000-a063-000000000002'
      ),
      p_claim_token => '50000000-0000-4000-a063-000000000002',
      p_expected_claimed_at => (
        SELECT state.timestamptz_value
        FROM calendar_063_main_state AS state
        WHERE state.key = 'booking_submission_expected_claimed_at'
      )
    )
  $$,
  'a near-expiry AI worker renews its claim at the provider side-effect fence'
);

-- 52b
SELECT ok(
  (
    SELECT booking.operation_claimed_at > clock_timestamp() - interval '5 seconds'
       AND booking.operation_claimed_at > (
         SELECT state.timestamptz_value
         FROM calendar_063_main_state AS state
         WHERE state.key = 'booking_submission_expected_claimed_at'
       )
    FROM public.calendar_bookings AS booking
    WHERE booking.source_message_id =
          '40000000-0000-4000-a063-000000000002'
  ),
  'the AI submission fence rotates claimed-at without changing the stable claim token'
);

RESET ROLE;

UPDATE public.calendar_bookings
SET operation_claimed_at = clock_timestamp() - interval '6 minutes'
WHERE source_message_id = '40000000-0000-4000-a063-000000000002';

UPDATE public.businesses
SET deleted_at = statement_timestamp(),
    deletion_scheduled_for = statement_timestamp() + interval '60 days'
WHERE id = '10000000-0000-4000-a063-000000000001';

SET LOCAL ROLE service_role;

-- 52c
SELECT lives_ok(
  $$
    SELECT public.claim_calendar_booking_reconciliation(
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_booking_id => (
        SELECT booking.id
        FROM public.calendar_bookings AS booking
        WHERE booking.source_message_id =
              '40000000-0000-4000-a063-000000000002'
      ),
      p_claim_token => '50000000-0000-4000-a063-000000000002'
    )
  $$,
  'owner-linked soft-deleted accounts can reconcile already-pending provider work'
);

RESET ROLE;

UPDATE public.businesses
SET deleted_at = NULL,
    deletion_scheduled_for = NULL
WHERE id = '10000000-0000-4000-a063-000000000001';

SET LOCAL ROLE service_role;

-- 53
SELECT lives_ok(
  $$
    SELECT public.fail_calendar_booking(
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_booking_id => (
        SELECT booking.id
        FROM public.calendar_bookings AS booking
        WHERE booking.source_message_id =
              '40000000-0000-4000-a063-000000000002'
      ),
      p_claim_token => '50000000-0000-4000-a063-000000000002',
      p_failure_reason => 'provider operation interlock fixture complete'
    )
  $$,
  'the AI fixture releases its target and interval after definitive failure'
);

-- ---------------------------------------------------------------------------
-- Unified target serialization and linked update/delete finalization
-- ---------------------------------------------------------------------------

-- 54
SELECT lives_ok(
  $$
    SELECT public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000010',
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_kind => 'update',
      p_google_calendar_id => 'primary',
      p_starts_at => '2063-09-10 10:30:00+00',
      p_ends_at => '2063-09-10 11:00:00+00',
      p_linked_booking_id => (
        SELECT booking.id
        FROM public.calendar_bookings AS booking
        WHERE booking.source_message_id =
              '40000000-0000-4000-a063-000000000004'
      ),
      p_deterministic_google_event_id => NULL,
      p_target_google_event_id => 'abcde0630000002',
      p_request_fingerprint => repeat('a', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000010'
    )
  $$,
  'a linked dashboard update can hold the confirmed provider target and desired slot'
);

-- 55
SELECT throws_ok(
  $$
    SELECT public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000011',
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_kind => 'delete',
      p_google_calendar_id => 'primary',
      p_starts_at => NULL,
      p_ends_at => NULL,
      p_linked_booking_id => (
        SELECT booking.id
        FROM public.calendar_bookings AS booking
        WHERE booking.source_message_id =
              '40000000-0000-4000-a063-000000000004'
      ),
      p_deterministic_google_event_id => NULL,
      p_target_google_event_id => 'abcde0630000002',
      p_request_fingerprint => repeat('b', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000011'
    )
  $$,
  '55P03',
  'calendar_provider_operation_busy',
  'delete cannot race a holding update of the same provider target'
);

-- 56
SELECT throws_ok(
  $$
    SELECT public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000012',
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_kind => 'create',
      p_google_calendar_id => 'primary',
      p_starts_at => '2063-09-10 12:00:00+00',
      p_ends_at => '2063-09-10 12:30:00+00',
      p_linked_booking_id => NULL,
      p_deterministic_google_event_id => 'abcde0630000002',
      p_target_google_event_id => NULL,
      p_request_fingerprint => repeat('c', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000012'
    )
  $$,
  '55P03',
  'calendar_provider_operation_busy',
  'deterministic create shares the same target mutex with update and delete'
);

-- 57
SELECT lives_ok(
  $$
    SELECT public.mark_calendar_provider_submission_started(
      '10000000-0000-4000-a063-000000000001',
      '63000000-0000-4000-a063-000000000010',
      '63100000-0000-4000-a063-000000000010'
    )
  $$,
  'linked update crosses the provider-submission fence'
);

-- 58
SELECT lives_ok(
  $$
    SELECT public.mark_calendar_provider_operation_applied(
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_id => '63000000-0000-4000-a063-000000000010',
      p_claim_token => '63100000-0000-4000-a063-000000000010',
      p_provider_event_id => 'abcde0630000002',
      p_provider_starts_at => '2063-09-10 10:30:00+00',
      p_provider_ends_at => '2063-09-10 11:00:00+00',
      p_provider_evidence => jsonb_build_object(
        'operation_marker_verified', true,
        'provider_status', 'confirmed',
        'provider_etag_sha256', repeat('d', 64)
      )
    )
  $$,
  'linked update persists exact marker and ETag proof'
);

-- 59
SELECT lives_ok(
  $$
    SELECT public.finalize_calendar_provider_operation(
      '10000000-0000-4000-a063-000000000001',
      '63000000-0000-4000-a063-000000000010'
    )
  $$,
  'linked update finalizes its local booking projection atomically'
);

-- 60
SELECT ok(
  (
    SELECT booking.status = 'confirmed'
       AND booking.google_event_id = 'abcde0630000002'
       AND booking.starts_at = '2063-09-10 10:30:00+00'::timestamptz
       AND booking.ends_at = '2063-09-10 11:00:00+00'::timestamptz
    FROM public.calendar_bookings AS booking
    WHERE booking.source_message_id =
          '40000000-0000-4000-a063-000000000004'
  ),
  'linked update moves only the confirmed booking interval and preserves identity'
);

-- 61
SELECT lives_ok(
  $$
    SELECT public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000013',
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_kind => 'delete',
      p_google_calendar_id => 'primary',
      p_starts_at => NULL,
      p_ends_at => NULL,
      p_linked_booking_id => (
        SELECT booking.id
        FROM public.calendar_bookings AS booking
        WHERE booking.source_message_id =
              '40000000-0000-4000-a063-000000000004'
      ),
      p_deterministic_google_event_id => NULL,
      p_target_google_event_id => 'abcde0630000002',
      p_request_fingerprint => repeat('e', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000013'
    )
  $$,
  'delete acquires the linked provider target after update finalizes'
);

-- 62
SELECT throws_ok(
  $$
    SELECT public.mark_calendar_provider_delete_applied(
      '10000000-0000-4000-a063-000000000001',
      '63000000-0000-4000-a063-000000000013',
      '63100000-0000-4000-a063-000000000013',
      'abcde0630000002'
    )
  $$,
  '23514',
  'calendar provider submission was not started',
  'delete absence cannot be recorded before the submission fence'
);

-- 63
SELECT lives_ok(
  $$
    SELECT public.mark_calendar_provider_submission_started(
      '10000000-0000-4000-a063-000000000001',
      '63000000-0000-4000-a063-000000000013',
      '63100000-0000-4000-a063-000000000013'
    )
  $$,
  'delete durably crosses the provider-submission fence'
);

-- 64
SELECT throws_ok(
  $$
    SELECT public.mark_calendar_provider_delete_applied(
      '10000000-0000-4000-a063-000000000001',
      '63000000-0000-4000-a063-000000000013',
      '63100000-0000-4000-a063-000000000013',
      'different-provider-target-a063'
    )
  $$,
  '42501',
  'calendar provider delete claim mismatch',
  'delete absence proof must match the durable provider target exactly'
);

-- 65
SELECT lives_ok(
  $$
    SELECT public.mark_calendar_provider_delete_applied(
      '10000000-0000-4000-a063-000000000001',
      '63000000-0000-4000-a063-000000000013',
      '63100000-0000-4000-a063-000000000013',
      'abcde0630000002'
    )
  $$,
  'verified provider absence is durably applied for delete'
);

-- 66
SELECT ok(
  (
    SELECT operation.status = 'provider_applied'
       AND operation.provider_event_id = 'abcde0630000002'
       AND operation.provider_starts_at IS NULL
       AND operation.provider_ends_at IS NULL
       AND operation.provider_evidence = jsonb_build_object(
             'provider_absence_verified', true,
             'provider_status', 'unknown'
           )
    FROM public.calendar_provider_operations AS operation
    WHERE operation.id = '63000000-0000-4000-a063-000000000013'
  ),
  'delete persists only content-free absence evidence'
);

-- 67
SELECT lives_ok(
  $$
    SELECT public.finalize_calendar_provider_operation(
      '10000000-0000-4000-a063-000000000001',
      '63000000-0000-4000-a063-000000000013'
    )
  $$,
  'delete finalizes the linked local cancellation'
);

-- 68
SELECT ok(
  (
    SELECT booking.status = 'cancelled'
       AND booking.cancelled_at IS NOT NULL
       AND booking.google_event_id = 'abcde0630000002'
    FROM public.calendar_bookings AS booking
    WHERE booking.source_message_id =
          '40000000-0000-4000-a063-000000000004'
  ),
  'linked delete cancels the booking without erasing provider identity'
);

-- ---------------------------------------------------------------------------
-- Absence reconciliation and pre-submit retry gates
-- ---------------------------------------------------------------------------

-- 69
SELECT lives_ok(
  $$
    SELECT public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000020',
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_kind => 'create',
      p_google_calendar_id => 'primary',
      p_starts_at => '2063-09-10 16:00:00+00',
      p_ends_at => '2063-09-10 16:30:00+00',
      p_linked_booking_id => NULL,
      p_deterministic_google_event_id => 'abcde0630000003',
      p_target_google_event_id => NULL,
      p_request_fingerprint => repeat('a', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000020'
    )
  $$,
  'a second create can enter an ambiguous holding state'
);

-- 70
SELECT lives_ok(
  $$
    SELECT public.mark_calendar_provider_submission_started(
      '10000000-0000-4000-a063-000000000001',
      '63000000-0000-4000-a063-000000000020',
      '63100000-0000-4000-a063-000000000020'
    )
  $$,
  'the absence-reconciliation fixture crosses the provider fence'
);

-- 71
SELECT throws_ok(
  $$
    SELECT public.resolve_calendar_provider_operation_absent(
      '10000000-0000-4000-a063-000000000001',
      '63000000-0000-4000-a063-000000000020',
      '63100000-0000-4000-a063-000000000099'
    )
  $$,
  '23514',
  'calendar provider operation cannot resolve absent',
  'absence reconciliation rejects a worker without the exact claim'
);

-- 72
SELECT is(
  (
    SELECT resolved.status
    FROM public.resolve_calendar_provider_operation_absent(
      '10000000-0000-4000-a063-000000000001',
      '63000000-0000-4000-a063-000000000020',
      '63100000-0000-4000-a063-000000000020'
    ) AS resolved
  ),
  'failed',
  'verified provider absence releases an ambiguous create hold'
);

-- 73
SELECT ok(
  (
    SELECT operation.status = 'failed'
       AND operation.claim_token IS NULL
       AND operation.provider_applied_at IS NULL
       AND operation.provider_evidence IS NULL
       AND operation.failure_reason =
             'Provider event was absent during reconciliation.'
    FROM public.calendar_provider_operations AS operation
    WHERE operation.id = '63000000-0000-4000-a063-000000000020'
  ),
  'absence resolution records a bounded reason without inventing provider proof'
);

-- 74
SELECT lives_ok(
  $$
    SELECT public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000030',
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_kind => 'create',
      p_google_calendar_id => 'primary',
      p_starts_at => '2063-09-10 17:00:00+00',
      p_ends_at => '2063-09-10 17:30:00+00',
      p_linked_booking_id => NULL,
      p_deterministic_google_event_id => 'abcde0630000004',
      p_target_google_event_id => NULL,
      p_request_fingerprint => repeat('b', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000030'
    )
  $$,
  'a pre-submit operation starts with a bounded worker lease'
);

RESET ROLE;

UPDATE public.calendar_provider_operations
SET claimed_at = clock_timestamp() - interval '6 minutes',
    claim_expires_at = clock_timestamp() - interval '1 minute'
WHERE id = '63000000-0000-4000-a063-000000000030';

UPDATE public.businesses
SET bookings_paused_at = clock_timestamp()
WHERE id = '10000000-0000-4000-a063-000000000001';

SET LOCAL ROLE service_role;

-- 75
SELECT throws_ok(
  $$
    SELECT public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000030',
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_kind => 'create',
      p_google_calendar_id => 'primary',
      p_starts_at => '2063-09-10 17:00:00+00',
      p_ends_at => '2063-09-10 17:30:00+00',
      p_linked_booking_id => NULL,
      p_deterministic_google_event_id => 'abcde0630000004',
      p_target_google_event_id => NULL,
      p_request_fingerprint => repeat('b', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000031'
    )
  $$,
  '55000',
  'calendar_provider_operation_business_unavailable',
  'an expired pre-submit retry rechecks the current booking pause'
);

-- 76
SELECT ok(
  (
    SELECT operation.status = 'holding'
       AND operation.provider_submission_started_at IS NULL
       AND operation.provider_applied_at IS NULL
       AND operation.claim_token =
             '63100000-0000-4000-a063-000000000030'::uuid
       AND operation.claim_expires_at <= clock_timestamp()
       AND operation.failure_reason IS NULL
    FROM public.calendar_provider_operations AS operation
    WHERE operation.id = '63000000-0000-4000-a063-000000000030'
  ),
  'gate rejection rolls back housekeeping but leaves only expired pre-submit authority'
);

RESET ROLE;

UPDATE public.businesses
SET bookings_paused_at = NULL
WHERE id = '10000000-0000-4000-a063-000000000001';

SET LOCAL ROLE service_role;

-- 77
SELECT is(
  (
    SELECT retried.attempt_count
    FROM public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000030',
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_kind => 'create',
      p_google_calendar_id => 'primary',
      p_starts_at => '2063-09-10 17:00:00+00',
      p_ends_at => '2063-09-10 17:30:00+00',
      p_linked_booking_id => NULL,
      p_deterministic_google_event_id => 'abcde0630000004',
      p_target_google_event_id => NULL,
      p_request_fingerprint => repeat('b', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000031'
    ) AS retried
  ),
  2,
  'a definitively side-effect-free operation can retry after gates reopen'
);

RESET ROLE;

UPDATE public.calendar_provider_operations
SET claimed_at = clock_timestamp() - interval '6 minutes',
    claim_expires_at = clock_timestamp() - interval '1 minute'
WHERE id = '63000000-0000-4000-a063-000000000030';

SET LOCAL ROLE service_role;

-- 78
SELECT throws_ok(
  $$
    SELECT public.mark_calendar_provider_submission_started(
      '10000000-0000-4000-a063-000000000001',
      '63000000-0000-4000-a063-000000000030',
      '63100000-0000-4000-a063-000000000031'
    )
  $$,
  '42501',
  'calendar provider operation claim mismatch',
  'an expired worker cannot cross the provider side-effect fence'
);

-- 79
SELECT lives_ok(
  $$
    SELECT public.fail_calendar_provider_operation(
      '10000000-0000-4000-a063-000000000001',
      '63000000-0000-4000-a063-000000000030',
      '63100000-0000-4000-a063-000000000031',
      ' pre-submit fixture complete '
    )
  $$,
  'the owning claim can terminalize a definitive pre-submit failure'
);

-- 80
SELECT ok(
  (
    SELECT operation.status = 'failed'
       AND operation.claim_token IS NULL
       AND operation.failed_at IS NOT NULL
       AND operation.failure_reason = 'pre-submit fixture complete'
    FROM public.calendar_provider_operations AS operation
    WHERE operation.id = '63000000-0000-4000-a063-000000000030'
  ),
  'explicit failure clears the lease and trims its bounded reason'
);

-- ---------------------------------------------------------------------------
-- Cleanup guard, reconciliation fairness, and guarded disconnect
-- ---------------------------------------------------------------------------

-- 81
SELECT lives_ok(
  $$
    SELECT public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000040',
      p_business_id => '10000000-0000-4000-a063-000000000002',
      p_operation_kind => 'create',
      p_google_calendar_id => 'primary',
      p_starts_at => '2063-09-11 14:00:00+00',
      p_ends_at => '2063-09-11 14:30:00+00',
      p_linked_booking_id => NULL,
      p_deterministic_google_event_id => 'abcde0630000005',
      p_target_google_event_id => NULL,
      p_request_fingerprint => repeat('a', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000040'
    )
  $$,
  'cleanup fixture acquires one live provider operation'
);

-- 81d
SELECT throws_ok(
  $$
    SELECT public.disconnect_google_calendar_token_if_unchanged(
      '10000000-0000-4000-a063-000000000002',
      (
        SELECT token.credential_version
        FROM public.google_calendar_tokens AS token
        WHERE token.business_id =
              '10000000-0000-4000-a063-000000000002'
      )
    )
  $$,
  '55P03',
  'calendar_provider_operation_busy',
  'conditional invalid-credential disconnect cannot erase a live provider namespace'
);

-- 81e
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.google_calendar_tokens AS token
    WHERE token.business_id = '10000000-0000-4000-a063-000000000002'
      AND token.access_token = 'fixture-access-a063-2'
  ),
  'busy conditional disconnect preserves the exact credential row'
);

-- 81f
SELECT throws_ok(
  $$
    DELETE FROM public.google_calendar_tokens
    WHERE business_id = '10000000-0000-4000-a063-000000000002'
  $$,
  '55P03',
  'calendar_provider_operation_busy',
  'the table-boundary delete guard blocks a legacy service writer during unresolved work'
);

RESET ROLE;

UPDATE public.businesses
SET primary_goal = 'book'
WHERE id = '10000000-0000-4000-a063-000000000002';

INSERT INTO public.google_calendar_oauth_attempts (
  id,
  state_digest,
  origin_verifier_digest,
  handoff_digest,
  business_id,
  owner_user_id,
  origin_partner_id,
  origin_hostname,
  status,
  authorization_code,
  sanitized_result,
  expires_at,
  handoff_expires_at,
  claimed_at
) VALUES
  (
    '65000000-0000-4000-a063-000000000001',
    repeat('1', 64),
    repeat('a', 64),
    repeat('4', 64),
    '10000000-0000-4000-a063-000000000002',
    '00000000-0000-4000-a063-000000000002',
    NULL,
    'provider-cleanup-a063.example.test',
    'claimed',
    NULL,
    NULL,
    now() + interval '10 minutes',
    now() + interval '5 minutes',
    now()
  ),
  (
    '65000000-0000-4000-a063-000000000002',
    repeat('2', 64),
    repeat('b', 64),
    repeat('5', 64),
    '10000000-0000-4000-a063-000000000002',
    '00000000-0000-4000-a063-000000000002',
    NULL,
    'provider-cleanup-a063.example.test',
    'claimed',
    NULL,
    NULL,
    now() + interval '10 minutes',
    now() + interval '5 minutes',
    now()
  ),
  (
    '65000000-0000-4000-a063-000000000003',
    repeat('3', 64),
    repeat('c', 64),
    repeat('6', 64),
    '10000000-0000-4000-a063-000000000002',
    '00000000-0000-4000-a063-000000000002',
    NULL,
    'provider-cleanup-a063.example.test',
    'claimed',
    NULL,
    NULL,
    now() + interval '10 minutes',
    now() + interval '5 minutes',
    now()
  ),
  (
    '65000000-0000-4000-a063-000000000004',
    repeat('4', 64),
    repeat('d', 64),
    repeat('7', 64),
    '10000000-0000-4000-a063-000000000002',
    '00000000-0000-4000-a063-000000000002',
    NULL,
    'provider-cleanup-a063.example.test',
    'claimed',
    NULL,
    NULL,
    now() + interval '10 minutes',
    now() + interval '5 minutes',
    now()
  );

INSERT INTO calendar_063_main_state (key, uuid_value)
SELECT 'oauth_same_namespace_previous_version', token.credential_version
FROM public.google_calendar_tokens AS token
WHERE token.business_id = '10000000-0000-4000-a063-000000000002';

SET LOCAL ROLE service_role;

-- 81a
SELECT throws_ok(
  $$
    SELECT public.complete_google_calendar_oauth_connection(
      '65000000-0000-4000-a063-000000000001',
      '10000000-0000-4000-a063-000000000002',
      '00000000-0000-4000-a063-000000000002',
      NULL,
      'provider-cleanup-a063.example.test',
      'invalid-email-access-a063',
      'invalid-email-refresh-a063',
      '2099-01-01 00:00:00+00',
      'not-an-email',
      'primary'
    )
  $$,
  '22023',
  'invalid_google_credentials',
  'OAuth completion rejects an invalid provider-account namespace'
);

-- 81b
SELECT throws_ok(
  $$
    SELECT public.complete_google_calendar_oauth_connection(
      '65000000-0000-4000-a063-000000000001',
      '10000000-0000-4000-a063-000000000002',
      '00000000-0000-4000-a063-000000000002',
      NULL,
      'provider-cleanup-a063.example.test',
      'invalid-calendar-access-a063',
      'invalid-calendar-refresh-a063',
      '2099-01-01 00:00:00+00',
      'provider-cleanup-a063@example.test',
      E'bad\ncalendar'
    )
  $$,
  '22023',
  'invalid_google_credentials',
  'OAuth completion rejects control characters in the provider calendar namespace'
);

-- 81c
SELECT throws_ok(
  $$
    SELECT public.complete_google_calendar_oauth_connection(
      '65000000-0000-4000-a063-000000000001',
      '10000000-0000-4000-a063-000000000002',
      '00000000-0000-4000-a063-000000000002',
      NULL,
      'provider-cleanup-a063.example.test',
      'mismatch-access-a063',
      'mismatch-refresh-a063',
      '2099-01-01 00:00:00+00',
      'different-google-account@example.test',
      'primary'
    )
  $$,
  '55P03',
  'calendar_provider_oauth_namespace_busy',
  'unresolved provider work rejects an OAuth Google-account switch'
);

-- 81d
SELECT throws_ok(
  $$
    SELECT public.complete_google_calendar_oauth_connection(
      '65000000-0000-4000-a063-000000000002',
      '10000000-0000-4000-a063-000000000002',
      '00000000-0000-4000-a063-000000000002',
      NULL,
      'provider-cleanup-a063.example.test',
      'calendar-switch-access-a063',
      'calendar-switch-refresh-a063',
      '2099-01-01 00:00:00+00',
      'provider-cleanup-a063@example.test',
      'secondary'
    )
  $$,
  '55P03',
  'calendar_provider_oauth_namespace_busy',
  'unresolved provider work rejects an OAuth calendar switch'
);

-- 81e
SELECT is(
  public.complete_google_calendar_oauth_connection(
    '65000000-0000-4000-a063-000000000003',
    '10000000-0000-4000-a063-000000000002',
    '00000000-0000-4000-a063-000000000002',
    NULL,
    'provider-cleanup-a063.example.test',
    'same-namespace-access-a063',
    'same-namespace-refresh-a063',
    '2099-01-01 00:00:00+00',
    ' Provider-Cleanup-A063@Example.Test ',
    ' primary '
  ),
  true,
  'unresolved work permits normalized same-account exact-calendar token recovery'
);

-- 81f
SELECT ok(
  (
    SELECT token.google_email = 'provider-cleanup-a063@example.test'
       AND token.calendar_id = 'primary'
       AND token.credential_version IS DISTINCT FROM (
         SELECT state.uuid_value
         FROM calendar_063_main_state AS state
         WHERE state.key = 'oauth_same_namespace_previous_version'
       )
    FROM public.google_calendar_tokens AS token
    WHERE token.business_id = '10000000-0000-4000-a063-000000000002'
  ),
  'OAuth completion normalizes the namespace and rotates its credential generation'
);

RESET ROLE;

-- 82
SELECT throws_ok(
  $$
    UPDATE public.businesses
    SET owner_id = NULL
    WHERE id = '10000000-0000-4000-a063-000000000002'
  $$,
  '55000',
  'account cleanup is waiting for a calendar provider operation',
  'account cleanup cannot tombstone a live provider operation'
);

SET LOCAL ROLE service_role;

-- 83
SELECT lives_ok(
  $$
    SELECT public.fail_calendar_provider_operation(
      '10000000-0000-4000-a063-000000000002',
      '63000000-0000-4000-a063-000000000040',
      '63100000-0000-4000-a063-000000000040',
      'cleanup fixture complete'
    )
  $$,
  'definitive provider failure releases the cleanup hold'
);

-- 83a
SELECT lives_ok(
  $$
    DELETE FROM public.google_calendar_tokens
    WHERE business_id = '10000000-0000-4000-a063-000000000002'
  $$,
  'the same legacy service delete proceeds after provider authority is terminal'
);

-- 83b
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.google_calendar_tokens AS token
    WHERE token.business_id = '10000000-0000-4000-a063-000000000002'
  ),
  'an allowed direct cleanup delete removes exactly the terminal credential row'
);

RESET ROLE;

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
) VALUES (
  '62000000-0000-4000-a063-000000000002',
  '10000000-0000-4000-a063-000000000002',
  'fixture-access-a063-2',
  'fixture-refresh-a063-2',
  '2099-01-01 00:00:00+00',
  'primary',
  'provider-cleanup-a063@example.test',
  '2063-01-01 00:00:00+00',
  '2063-01-01 00:00:00+00'
);

SET LOCAL ROLE service_role;

-- 83c
SELECT lives_ok(
  $$
    SELECT public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000042',
      p_business_id => '10000000-0000-4000-a063-000000000002',
      p_operation_kind => 'create',
      p_google_calendar_id => 'primary',
      p_starts_at => '2063-09-11 15:00:00+00',
      p_ends_at => '2063-09-11 15:30:00+00',
      p_linked_booking_id => NULL,
      p_deterministic_google_event_id => 'abcde0630000042',
      p_target_google_event_id => NULL,
      p_request_fingerprint => repeat('4', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000042'
    )
  $$,
  'the OAuth retirement fixture acquires one pre-submit hold'
);

RESET ROLE;

UPDATE public.calendar_provider_operations
SET claimed_at = clock_timestamp() - interval '6 minutes',
    claim_expires_at = clock_timestamp() - interval '1 minute'
WHERE id = '63000000-0000-4000-a063-000000000042';

INSERT INTO calendar_063_main_state (key, uuid_value)
SELECT 'oauth_retirement_previous_version', token.credential_version
FROM public.google_calendar_tokens AS token
WHERE token.business_id = '10000000-0000-4000-a063-000000000002';

SET LOCAL ROLE service_role;

-- 83d
SELECT is(
  public.complete_google_calendar_oauth_connection(
    '65000000-0000-4000-a063-000000000004',
    '10000000-0000-4000-a063-000000000002',
    '00000000-0000-4000-a063-000000000002',
    NULL,
    'provider-cleanup-a063.example.test',
    'retired-hold-access-a063',
    'retired-hold-refresh-a063',
    '2099-04-01 00:00:00+00',
    'retired-hold-account@example.test',
    'secondary'
  ),
  true,
  'OAuth replacement retires expired never-submitted work before its namespace guard'
);

-- 83e
SELECT ok(
  (
    SELECT operation.status = 'failed'
       AND operation.provider_submission_started_at IS NULL
       AND operation.claim_token IS NULL
       AND operation.failure_reason = 'Provider submission was never started.'
    FROM public.calendar_provider_operations AS operation
    WHERE operation.id = '63000000-0000-4000-a063-000000000042'
  )
  AND (
    SELECT token.access_token = 'retired-hold-access-a063'
       AND token.refresh_token = 'retired-hold-refresh-a063'
       AND token.google_email = 'retired-hold-account@example.test'
       AND token.calendar_id = 'secondary'
       AND token.credential_version IS DISTINCT FROM (
         SELECT state.uuid_value
         FROM calendar_063_main_state AS state
         WHERE state.key = 'oauth_retirement_previous_version'
       )
    FROM public.google_calendar_tokens AS token
    WHERE token.business_id = '10000000-0000-4000-a063-000000000002'
  ),
  'safe hold retirement and credential replacement commit as one serialized transition'
);

RESET ROLE;

-- 84
SELECT lives_ok(
  $$
    UPDATE public.businesses
    SET owner_id = NULL
    WHERE id = '10000000-0000-4000-a063-000000000002'
  $$,
  'account cleanup can tombstone after provider work becomes terminal'
);

-- 85
SELECT ok(
  (
    SELECT business.owner_id IS NULL
    FROM public.businesses AS business
    WHERE business.id = '10000000-0000-4000-a063-000000000002'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.calendar_provider_operations AS operation
    WHERE operation.business_id =
          '10000000-0000-4000-a063-000000000002'
  ),
  'successful tombstone scrubs terminal provider-operation metadata'
);

SET LOCAL ROLE service_role;

-- 86
SELECT lives_ok(
  $$
    SELECT public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000041',
      p_business_id => '10000000-0000-4000-a063-000000000003',
      p_operation_kind => 'create',
      p_google_calendar_id => 'primary',
      p_starts_at => '2063-09-11 15:00:00+00',
      p_ends_at => '2063-09-11 15:30:00+00',
      p_linked_booking_id => NULL,
      p_deterministic_google_event_id => 'abcde0630000006',
      p_target_google_event_id => NULL,
      p_request_fingerprint => repeat('b', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000041'
    )
  $$,
  'expiry cleanup fixture acquires one pre-submit operation'
);

RESET ROLE;

UPDATE public.calendar_provider_operations
SET claimed_at = clock_timestamp() - interval '6 minutes',
    claim_expires_at = clock_timestamp() - interval '1 minute'
WHERE id = '63000000-0000-4000-a063-000000000041';

-- 87
SELECT lives_ok(
  $$
    UPDATE public.businesses
    SET owner_id = NULL
    WHERE id = '10000000-0000-4000-a063-000000000003'
  $$,
  'cleanup retires an expired operation proven not to have reached Google'
);

-- 88
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.calendar_provider_operations AS operation
    WHERE operation.id = '63000000-0000-4000-a063-000000000041'
  )
  AND (
    SELECT business.owner_id IS NULL
    FROM public.businesses AS business
    WHERE business.id = '10000000-0000-4000-a063-000000000003'
  ),
  'cleanup terminalizes then scrubs only expired pre-submit authority'
);

SET LOCAL ROLE service_role;

-- 89
SELECT lives_ok(
  $$
    SELECT public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000050',
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_kind => 'create',
      p_google_calendar_id => 'primary',
      p_starts_at => '2063-09-10 18:00:00+00',
      p_ends_at => '2063-09-10 18:30:00+00',
      p_linked_booking_id => NULL,
      p_deterministic_google_event_id => 'abcde0630000006',
      p_target_google_event_id => NULL,
      p_request_fingerprint => repeat('c', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000050'
    )
  $$,
  'first reconciliation fixture acquires an operation'
);

-- 90
SELECT lives_ok(
  $$
    SELECT public.mark_calendar_provider_submission_started(
      '10000000-0000-4000-a063-000000000001',
      '63000000-0000-4000-a063-000000000050',
      '63100000-0000-4000-a063-000000000050'
    )
  $$,
  'first reconciliation fixture becomes provider-ambiguous'
);

-- 91
SELECT lives_ok(
  $$
    SELECT public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000051',
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_operation_kind => 'create',
      p_google_calendar_id => 'primary',
      p_starts_at => '2063-09-10 19:00:00+00',
      p_ends_at => '2063-09-10 19:30:00+00',
      p_linked_booking_id => NULL,
      p_deterministic_google_event_id => 'abcde0630000007',
      p_target_google_event_id => NULL,
      p_request_fingerprint => repeat('d', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000051'
    )
  $$,
  'second reconciliation fixture acquires an operation'
);

-- 92
SELECT lives_ok(
  $$
    SELECT public.mark_calendar_provider_submission_started(
      '10000000-0000-4000-a063-000000000001',
      '63000000-0000-4000-a063-000000000051',
      '63100000-0000-4000-a063-000000000051'
    )
  $$,
  'second reconciliation fixture becomes provider-ambiguous'
);

RESET ROLE;

UPDATE public.calendar_provider_operations
SET claimed_at = clock_timestamp() - interval '6 minutes',
    claim_expires_at = clock_timestamp() - interval '1 minute',
    created_at = CASE id
      WHEN '63000000-0000-4000-a063-000000000050'::uuid
        THEN '2063-01-01 00:00:00+00'::timestamptz
      ELSE '2063-01-02 00:00:00+00'::timestamptz
    END
WHERE id IN (
  '63000000-0000-4000-a063-000000000050',
  '63000000-0000-4000-a063-000000000051'
);

SET LOCAL ROLE service_role;

-- 93
SELECT throws_ok(
  $$
    SELECT public.claim_next_calendar_provider_operation_reconciliation(NULL)
  $$,
  '22023',
  'invalid calendar provider reconciliation claim',
  'reconciliation rejects a missing lease token'
);

-- 94
SELECT is(
  (
    public.claim_next_calendar_provider_operation_reconciliation(
      '63100000-0000-4000-a063-000000000101'
    )
  ).id,
  '63000000-0000-4000-a063-000000000050'::uuid,
  'the fair queue first selects the never-attempted oldest eligible row'
);

-- 95
SELECT is(
  (
    public.claim_next_calendar_provider_operation_reconciliation(
      '63100000-0000-4000-a063-000000000102'
    )
  ).id,
  '63000000-0000-4000-a063-000000000051'::uuid,
  'an active reconciliation lease makes the next eligible row selectable'
);

RESET ROLE;

UPDATE public.calendar_provider_operations
SET claimed_at = clock_timestamp() - interval '6 minutes',
    claim_expires_at = clock_timestamp() - interval '1 minute',
    reconciliation_claimed_at = clock_timestamp() - interval '6 minutes',
    reconciliation_claim_expires_at = clock_timestamp() - interval '1 minute',
    reconciliation_attempted_at = CASE id
      WHEN '63000000-0000-4000-a063-000000000050'::uuid
        THEN clock_timestamp()
      ELSE clock_timestamp() - interval '1 hour'
    END
WHERE id IN (
  '63000000-0000-4000-a063-000000000050',
  '63000000-0000-4000-a063-000000000051'
);

SET LOCAL ROLE service_role;

-- 96
SELECT is(
  (
    public.claim_next_calendar_provider_operation_reconciliation(
      '63100000-0000-4000-a063-000000000103'
    )
  ).id,
  '63000000-0000-4000-a063-000000000051'::uuid,
  'the fair queue rotates to the least-recently attempted eligible row'
);

-- 97
SELECT ok(
  (
    SELECT operation.claim_token =
             '63100000-0000-4000-a063-000000000103'::uuid
       AND operation.reconciliation_claim_token =
             '63100000-0000-4000-a063-000000000103'::uuid
       AND operation.claim_expires_at > operation.claimed_at
       AND operation.reconciliation_claim_expires_at >
             operation.reconciliation_claimed_at
       AND operation.attempt_count = 3
       AND operation.reconciliation_attempt_count = 2
    FROM public.calendar_provider_operations AS operation
    WHERE operation.id = '63000000-0000-4000-a063-000000000051'
  ),
  'maintenance uses separate synchronized worker and reconciliation leases with counters'
);

-- 98
SELECT throws_ok(
  $$
    SELECT public.disconnect_google_calendar_token(
      '10000000-0000-4000-a063-000000000001'
    )
  $$,
  '55P03',
  'calendar_provider_operation_busy',
  'disconnect remains blocked while ambiguous provider operations exist'
);

-- 99
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.google_calendar_tokens AS token
    WHERE token.id = '62000000-0000-4000-a063-000000000001'
  ),
  'failed ambiguous-work disconnect preserves the exact token row'
);

DO $resolve_reconciliation_fixtures$
BEGIN
  PERFORM public.resolve_calendar_provider_operation_absent(
    '10000000-0000-4000-a063-000000000001',
    '63000000-0000-4000-a063-000000000050',
    '63100000-0000-4000-a063-000000000101'
  );
  PERFORM public.resolve_calendar_provider_operation_absent(
    '10000000-0000-4000-a063-000000000001',
    '63000000-0000-4000-a063-000000000051',
    '63100000-0000-4000-a063-000000000103'
  );
END;
$resolve_reconciliation_fixtures$;

-- 100
SELECT is(
  public.disconnect_google_calendar_token(
    '10000000-0000-4000-a063-000000000001'
  ),
  'fixture-access-a063-1',
  'guarded disconnect deletes and returns the exact server-side access token'
);

-- 101
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.google_calendar_tokens AS token
    WHERE token.business_id = '10000000-0000-4000-a063-000000000001'
  ),
  'successful disconnect removes the local credential row first'
);

-- 102
SELECT is(
  (
    SELECT recovered.status
    FROM public.reserve_calendar_booking(
      p_business_id => '10000000-0000-4000-a063-000000000001',
      p_contact_id => '20000000-0000-4000-a063-000000000001',
      p_conversation_id => '30000000-0000-4000-a063-000000000001',
      p_source_message_id => '40000000-0000-4000-a063-000000000001',
      p_starts_at => '2063-09-10 09:00:00+00',
      p_ends_at => '2063-09-10 09:30:00+00',
      p_claim_token => '50000000-0000-4000-a063-000000000001',
      p_google_calendar_id => 'primary',
      p_event_summary => 'Late Recovery Booking 063',
      p_request_fingerprint => repeat('f', 64)
    ) AS recovered
  ),
  'confirmed',
  'late exact confirmed recovery remains authoritative after disconnect'
);

-- 103
SELECT lives_ok(
  $$
    SELECT public.acquire_calendar_provider_operation(
      p_operation_id => '63000000-0000-4000-a063-000000000060',
      p_business_id => '10000000-0000-4000-a063-000000000004',
      p_operation_kind => 'create',
      p_google_calendar_id => 'primary',
      p_starts_at => '2063-09-12 14:00:00+00',
      p_ends_at => '2063-09-12 14:30:00+00',
      p_linked_booking_id => NULL,
      p_deterministic_google_event_id => 'abcde0630000008',
      p_target_google_event_id => NULL,
      p_request_fingerprint => repeat('e', 64),
      p_claim_token => '63100000-0000-4000-a063-000000000060'
    )
  $$,
  'disconnect expiry fixture acquires pre-submit work'
);

RESET ROLE;

UPDATE public.calendar_provider_operations
SET claimed_at = clock_timestamp() - interval '6 minutes',
    claim_expires_at = clock_timestamp() - interval '1 minute'
WHERE id = '63000000-0000-4000-a063-000000000060';

SET LOCAL ROLE service_role;

-- 104
SELECT is(
  public.disconnect_google_calendar_token(
    '10000000-0000-4000-a063-000000000004'
  ),
  'fixture-access-a063-4',
  'disconnect retires expired pre-submit work before deleting credentials'
);

-- 105
SELECT ok(
  (
    SELECT operation.status = 'failed'
       AND operation.provider_submission_started_at IS NULL
       AND operation.claim_token IS NULL
       AND operation.failure_reason = 'Provider submission was never started.'
    FROM public.calendar_provider_operations AS operation
    WHERE operation.id = '63000000-0000-4000-a063-000000000060'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.google_calendar_tokens AS token
    WHERE token.business_id = '10000000-0000-4000-a063-000000000004'
  ),
  'disconnect preserves proof of safe pre-submit retirement and removes only credentials'
);

RESET ROLE;

-- Recreate an invalid hosted provider namespace only after all lifecycle
-- behavior has completed; the surrounding transaction restores the CHECK.
ALTER TABLE public.google_calendar_tokens
  DROP CONSTRAINT google_calendar_tokens_provider_namespace_valid;

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
) VALUES (
  '62000000-0000-4000-a063-000000000004',
  '10000000-0000-4000-a063-000000000004',
  'invalid-namespace-access-a063',
  'invalid-namespace-refresh-a063',
  '2099-01-01 00:00:00+00',
  'primary',
  NULL,
  '2063-01-01 00:00:00+00',
  '2063-01-01 00:00:00+00'
);

-- 106a
SELECT throws_ok(
  $namespace_preflight_sql$
    DO $namespace_preflight$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM public.google_calendar_tokens AS token
        WHERE NULLIF(btrim(token.google_email), '') IS NULL
           OR length(btrim(token.google_email)) > 254
           OR btrim(token.google_email) ~ '[[:cntrl:]]'
           OR lower(btrim(token.google_email)) !~
              '^[^[:space:]@]+@[^[:space:]@]+$'
           OR NULLIF(btrim(token.calendar_id), '') IS NULL
           OR length(btrim(token.calendar_id)) > 1024
           OR btrim(token.calendar_id) ~ '[[:cntrl:]]'
      ) THEN
        RAISE EXCEPTION
          'calendar_provider_operations_preflight_invalid_provider_namespace'
          USING ERRCODE = 'P0001';
      END IF;
    END;
    $namespace_preflight$;
  $namespace_preflight_sql$,
  'P0001',
  'calendar_provider_operations_preflight_invalid_provider_namespace',
  'migration preflight aborts rather than guessing an invalid provider namespace'
);

DELETE FROM public.google_calendar_tokens
WHERE id = '62000000-0000-4000-a063-000000000004';

-- Recreate the exact hosted-data hazard in this outer rollback transaction.
INSERT INTO public.calendar_bookings (
  id,
  business_id,
  contact_id,
  conversation_id,
  source_message_id,
  google_calendar_id,
  event_summary,
  request_fingerprint,
  status,
  starts_at,
  ends_at,
  operation_claim_token,
  operation_claimed_at
) VALUES (
  '64000000-0000-4000-a063-000000000001',
  '10000000-0000-4000-a063-000000000001',
  '20000000-0000-4000-a063-000000000001',
  '30000000-0000-4000-a063-000000000001',
  '40000000-0000-4000-a063-000000000003',
  'primary',
  'Legacy pending preflight fixture',
  repeat('a', 64),
  'pending',
  '2063-09-13 14:00:00+00',
  '2063-09-13 14:30:00+00',
  '50000000-0000-4000-a063-000000000003',
  clock_timestamp()
);

-- 106
SELECT throws_ok(
  $preflight_sql$
    DO $preflight$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM public.calendar_bookings AS booking
        WHERE booking.status = 'pending'
          AND NOT EXISTS (
            SELECT 1
            FROM public.google_calendar_tokens AS token
            WHERE token.business_id = booking.business_id
          )
      ) THEN
        RAISE EXCEPTION
          'calendar_provider_operations_preflight_pending_booking_without_token'
          USING ERRCODE = 'P0001';
      END IF;
    END;
    $preflight$;
  $preflight_sql$,
  'P0001',
  'calendar_provider_operations_preflight_pending_booking_without_token',
  'migration preflight aborts rather than auto-failing ambiguous legacy bookings'
);

DELETE FROM public.calendar_bookings
WHERE id = '64000000-0000-4000-a063-000000000001';

SELECT * FROM finish();

ROLLBACK;
