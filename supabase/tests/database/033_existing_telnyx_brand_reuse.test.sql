BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;

SET LOCAL search_path = public, extensions;

SELECT plan(106);

-- ---------------------------------------------------------------------------
-- Catalog shape, constraints, RLS, and grants
-- ---------------------------------------------------------------------------

SELECT has_column(
  'public',
  'businesses',
  'telnyx_brand_source',
  'businesses record active-brand provenance'
);

SELECT has_table(
  'public',
  'telnyx_brand_link_requests',
  'private existing-brand link state exists'
);

SELECT has_table(
  'public',
  'telnyx_brand_link_events',
  'private existing-brand link audit exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_index AS index_row
    JOIN pg_class AS class_row ON class_row.oid = index_row.indexrelid
    WHERE class_row.relname = 'businesses_normalized_ein_unique'
      AND index_row.indisunique
      AND pg_get_expr(index_row.indpred, index_row.indrelid)
        = '((ein IS NOT NULL) AND (shared_registration_id IS NULL))'
      AND pg_get_indexdef(index_row.indexrelid)
        LIKE '%replace(ein, ''-''::text, ''''::text)%'
  ),
  'ordinary non-null EINs have a unique partial expression index; shared claims require explicit membership'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_index AS index_row
    JOIN pg_class AS class_row ON class_row.oid = index_row.indexrelid
    WHERE class_row.relname =
            'businesses_live_telnyx_brand_id_lower_unique'
      AND index_row.indisunique
      AND pg_get_expr(index_row.indpred, index_row.indrelid)
        LIKE '%telnyx_brand_id IS NOT NULL%'
      AND pg_get_expr(index_row.indpred, index_row.indrelid)
        LIKE '%telnyx_unique_claims_released_at IS NULL%'
      AND pg_get_indexdef(index_row.indexrelid)
        LIKE '%lower(btrim(telnyx_brand_id))%'
  ),
  'live Telnyx brand claims are unique and terminal tombstones release them'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.businesses'::regclass
      AND conname = 'businesses_ein_format_check'
      AND contype = 'c'
  ),
  'business EINs have the canonical-format constraint'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.businesses'::regclass
      AND conname = 'businesses_telnyx_brand_source_consistency_check'
      AND contype = 'c'
  ),
  'brand IDs and provenance must remain structurally consistent'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.telnyx_brand_link_requests'::regclass
      AND conname = 'telnyx_brand_link_requests_approval_check'
      AND contype = 'c'
  )
  AND EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.telnyx_brand_link_requests'::regclass
      AND conname = 'telnyx_brand_link_requests_consumed_check'
      AND contype = 'c'
  ),
  'link approval and consumption lifecycle fields are constrained'
);

SELECT ok(
  (
    SELECT count(*)
    FROM pg_index AS index_row
    JOIN pg_class AS class_row ON class_row.oid = index_row.indexrelid
    WHERE class_row.relname IN (
      'telnyx_brand_link_requests_tcr_unique',
      'telnyx_brand_link_requests_internal_unique'
    )
      AND index_row.indisunique
  ) = 2,
  'public TCR and internal Telnyx brand IDs are uniquely reserved'
);

SELECT ok(
  (
    SELECT relrowsecurity
    FROM pg_class
    WHERE oid = 'public.telnyx_brand_link_requests'::regclass
  ),
  'link requests have RLS enabled'
);

SELECT ok(
  (
    SELECT relrowsecurity
    FROM pg_class
    WHERE oid = 'public.telnyx_brand_link_events'::regclass
  ),
  'link events have RLS enabled'
);

SELECT policies_are(
  'public',
  'telnyx_brand_link_requests',
  ARRAY[]::name[],
  'link requests intentionally have no customer policies'
);

SELECT policies_are(
  'public',
  'telnyx_brand_link_events',
  ARRAY[]::name[],
  'link events intentionally have no customer policies'
);

SELECT table_privs_are(
  'public',
  'telnyx_brand_link_requests',
  'anon',
  ARRAY[]::name[],
  'anon has no link-request privileges'
);

SELECT table_privs_are(
  'public',
  'telnyx_brand_link_requests',
  'authenticated',
  ARRAY[]::name[],
  'authenticated has no link-request privileges'
);

SELECT table_privs_are(
  'public',
  'telnyx_brand_link_requests',
  'service_role',
  ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::name[],
  'service_role has the exact intended link-request privileges'
);

SELECT table_privs_are(
  'public',
  'telnyx_brand_link_events',
  'anon',
  ARRAY[]::name[],
  'anon has no link-event privileges'
);

SELECT table_privs_are(
  'public',
  'telnyx_brand_link_events',
  'authenticated',
  ARRAY[]::name[],
  'authenticated has no link-event privileges'
);

SELECT table_privs_are(
  'public',
  'telnyx_brand_link_events',
  'service_role',
  ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']::name[],
  'service_role has the exact intended link-event privileges'
);

SELECT has_trigger(
  'public',
  'businesses',
  'maintain_telnyx_brand_source',
  'businesses infer and preserve brand provenance'
);

SELECT has_trigger(
  'public',
  'businesses',
  'invalidate_telnyx_brand_link_on_identity_change',
  'business identity edits invalidate approved links'
);

SELECT has_trigger(
  'public',
  'businesses',
  'guard_business_telnyx_authorization_fields',
  'businesses guard provider authorization state'
);

SELECT has_trigger(
  'public',
  'telnyx_brand_link_requests',
  'set_updated_at_telnyx_brand_link_requests',
  'link requests maintain updated_at'
);

SELECT has_function(
  'public',
  'telnyx_brand_link_identity_fingerprint',
  ARRAY['uuid'],
  'identity fingerprint RPC exists'
);

SELECT has_function(
  'public',
  'record_existing_telnyx_brand_inspection',
  ARRAY['uuid', 'text', 'text', 'text', 'text'],
  'standalone inspection audit RPC exists'
);

SELECT has_function(
  'public',
  'stage_existing_telnyx_brand_link',
  ARRAY['uuid', 'text', 'text', 'text'],
  'link staging RPC exists'
);

SELECT has_function(
  'public',
  'approve_existing_telnyx_brand_link',
  ARRAY['uuid', 'text', 'text', 'text', 'text'],
  'link approval RPC exists'
);

SELECT has_function(
  'public',
  'block_existing_telnyx_brand_link',
  ARRAY['uuid', 'text', 'text', 'text', 'text', 'text'],
  'link blocking RPC exists'
);

SELECT has_function(
  'public',
  'reset_existing_telnyx_brand_link',
  ARRAY['uuid', 'text'],
  'link reset RPC exists'
);

SELECT has_function(
  'public',
  'consume_existing_telnyx_brand_link',
  ARRAY['uuid', 'text', 'text', 'text', 'text'],
  'atomic link consumption RPC exists'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_proc AS procedure_row
    CROSS JOIN LATERAL aclexplode(
      COALESCE(procedure_row.proacl, acldefault('f', procedure_row.proowner))
    ) AS acl_row
    WHERE procedure_row.pronamespace = 'public'::regnamespace
      AND procedure_row.proname IN (
        'maintain_telnyx_brand_source',
        'invalidate_telnyx_brand_link_on_identity_change',
        'guard_business_telnyx_authorization_fields',
        'telnyx_brand_link_identity_fingerprint',
        'record_existing_telnyx_brand_inspection',
        'stage_existing_telnyx_brand_link',
        'approve_existing_telnyx_brand_link',
        'block_existing_telnyx_brand_link',
        'reset_existing_telnyx_brand_link',
        'consume_existing_telnyx_brand_link'
      )
      AND acl_row.grantee = 0
  ),
  'PUBLIC cannot execute brand-link functions'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_proc AS procedure_row
    WHERE procedure_row.pronamespace = 'public'::regnamespace
      AND procedure_row.proname IN (
        'maintain_telnyx_brand_source',
        'invalidate_telnyx_brand_link_on_identity_change',
        'guard_business_telnyx_authorization_fields',
        'telnyx_brand_link_identity_fingerprint',
        'record_existing_telnyx_brand_inspection',
        'stage_existing_telnyx_brand_link',
        'approve_existing_telnyx_brand_link',
        'block_existing_telnyx_brand_link',
        'reset_existing_telnyx_brand_link',
        'consume_existing_telnyx_brand_link'
      )
      AND (
        has_function_privilege('anon', procedure_row.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', procedure_row.oid, 'EXECUTE')
      )
  ),
  'anon and authenticated cannot execute brand-link functions'
);

SELECT ok(
  NOT has_function_privilege(
    'service_role',
    'public.maintain_telnyx_brand_source()',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'service_role',
    'public.invalidate_telnyx_brand_link_on_identity_change()',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'service_role',
    'public.guard_business_telnyx_authorization_fields()',
    'EXECUTE'
  ),
  'trigger functions are not directly executable by service_role'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.telnyx_brand_link_identity_fingerprint(uuid)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'service_role',
    'public.record_existing_telnyx_brand_inspection(uuid,text,text,text,text)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'service_role',
    'public.stage_existing_telnyx_brand_link(uuid,text,text,text)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'service_role',
    'public.approve_existing_telnyx_brand_link(uuid,text,text,text,text)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'service_role',
    'public.block_existing_telnyx_brand_link(uuid,text,text,text,text,text)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'service_role',
    'public.reset_existing_telnyx_brand_link(uuid,text)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'service_role',
    'public.consume_existing_telnyx_brand_link(uuid,text,text,text,text)',
    'EXECUTE'
  ),
  'service_role can execute every trusted brand-link RPC'
);

SELECT is(
  (
    SELECT namespace_row.nspname
    FROM pg_extension AS extension_row
    JOIN pg_namespace AS namespace_row
      ON namespace_row.oid = extension_row.extnamespace
    WHERE extension_row.extname = 'pgcrypto'
  ),
  'extensions',
  'pgcrypto is installed in the extensions schema'
);

SELECT ok(
  (
    SELECT NOT procedure_row.prosecdef
       AND procedure_row.proconfig @> ARRAY['search_path=public, pg_temp']
    FROM pg_proc AS procedure_row
    WHERE procedure_row.oid =
      'public.cleanup_expired_business(uuid)'::regprocedure
  ),
  'cleanup retains migration-029 SECURITY INVOKER and search_path'
);

SELECT ok(
  (
    SELECT pg_get_functiondef(procedure_row.oid) LIKE ALL (ARRAY[
      '%ensure_telnyx_release_reason%',
      '%snapshot_telnyx_release_actions%',
      '%queue_account_deletion_stripe_action%',
      '%UPDATE public.messages SET content = ''[deleted]''%',
      '%UPDATE public.contacts%',
      '%DELETE FROM public.subscriptions%',
      '%DELETE FROM public.telnyx_brand_link_events%',
      '%DELETE FROM public.telnyx_brand_link_requests%',
      '%cleanup_pii_scrubbed_at = COALESCE(cleanup_pii_scrubbed_at, now())%'
    ])
    FROM pg_proc AS procedure_row
    WHERE procedure_row.oid =
      'public.cleanup_expired_business(uuid)'::regprocedure
  ),
  'cleanup preserves account privacy work while snapshotting Telnyx release state'
);

SELECT ok(
  (
    SELECT strpos(definition, 'DELETE FROM public.telnyx_brand_link_events')
         < strpos(definition, 'DELETE FROM public.telnyx_brand_link_requests')
       AND strpos(definition, 'DELETE FROM public.telnyx_brand_link_requests')
         < strpos(definition, 'SET name = ''[deleted]''')
    FROM (
      SELECT pg_get_functiondef(
        'public.cleanup_expired_business(uuid)'::regprocedure
      ) AS definition
    ) AS cleanup
  ),
  'cleanup deletes audit then request before scrubbing business identity'
);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE existing_brand_033_test_state (
  name text PRIMARY KEY,
  text_value text,
  uuid_value uuid,
  bigint_value bigint
) ON COMMIT DROP;

GRANT ALL ON TABLE existing_brand_033_test_state TO service_role;

INSERT INTO auth.users (id, email)
VALUES
  ('00000000-0000-4000-a000-000000000331', 'brand-link-a@example.test'),
  ('00000000-0000-4000-a000-000000000332', 'brand-link-b@example.test'),
  ('00000000-0000-4000-a000-000000000333', 'brand-link-c@example.test'),
  ('00000000-0000-4000-a000-000000000334', 'brand-link-cleanup@example.test'),
  ('00000000-0000-4000-a000-000000000335', 'brand-link-rollback@example.test'),
  ('00000000-0000-4000-a000-000000000336', 'brand-link-incomplete@example.test');

UPDATE public.businesses
SET id = '10000000-0000-4000-a000-000000000331',
    name = 'Brand Link Test A',
    slug = 'brand-link-test-a',
    legal_business_name = 'Simpl Assist Demo LLC',
    business_entity_type = 'llc',
    business_registration_state = 'IN',
    has_ein = true,
    tax_id_type = 'ein',
    ein = '33-0000001',
    state = 'IN',
    zip = '46220',
    a2p_risk_review_status = 'passed',
    onboarding_registration_status = 'not_started'
WHERE owner_id = '00000000-0000-4000-a000-000000000331';

UPDATE public.businesses
SET id = '10000000-0000-4000-a000-000000000332',
    name = 'Brand Link Test B',
    slug = 'brand-link-test-b',
    legal_business_name = 'Second Brand Test LLC',
    business_entity_type = 'llc',
    business_registration_state = 'IN',
    has_ein = true,
    tax_id_type = 'ein',
    state = 'IN',
    zip = '46221',
    a2p_risk_review_status = 'not_started',
    onboarding_registration_status = 'not_started'
WHERE owner_id = '00000000-0000-4000-a000-000000000332';

UPDATE public.businesses
SET id = '10000000-0000-4000-a000-000000000333',
    name = 'Brand Link Test C',
    slug = 'brand-link-test-c'
WHERE owner_id = '00000000-0000-4000-a000-000000000333';

UPDATE public.businesses
SET id = '10000000-0000-4000-a000-000000000334',
    name = 'Brand Link Cleanup',
    slug = 'brand-link-cleanup',
    legal_business_name = 'Cleanup Brand LLC',
    business_entity_type = 'llc',
    business_registration_state = 'IN',
    has_ein = true,
    tax_id_type = 'ein',
    ein = '33-0000004',
    state = 'IN',
    zip = '46224',
    a2p_risk_review_status = 'passed',
    onboarding_registration_status = 'submitting'
WHERE owner_id = '00000000-0000-4000-a000-000000000334';

UPDATE public.businesses
SET id = '10000000-0000-4000-a000-000000000335',
    name = 'Brand Link Rollback',
    slug = 'brand-link-rollback',
    legal_business_name = 'Rollback Brand LLC',
    business_entity_type = 'llc',
    business_registration_state = 'IN',
    has_ein = true,
    tax_id_type = 'ein',
    ein = '33-0000005',
    state = 'IN',
    zip = '46225',
    a2p_risk_review_status = 'passed',
    onboarding_registration_status = 'submitting'
WHERE owner_id = '00000000-0000-4000-a000-000000000335';

UPDATE public.businesses
SET id = '10000000-0000-4000-a000-000000000336',
    name = 'Brand Link Incomplete',
    slug = 'brand-link-incomplete',
    has_ein = true,
    tax_id_type = 'ein',
    a2p_risk_review_status = 'passed',
    onboarding_registration_status = 'not_started'
WHERE owner_id = '00000000-0000-4000-a000-000000000336';

-- ---------------------------------------------------------------------------
-- EIN uniqueness, provenance, fingerprint, and direct-client guard
-- ---------------------------------------------------------------------------

SELECT throws_ok(
  $$
    UPDATE public.businesses
    SET ein = '330000003'
    WHERE id = '10000000-0000-4000-a000-000000000333'
  $$,
  '23514',
  NULL,
  'non-canonical EINs are rejected'
);

SELECT throws_ok(
  $$
    UPDATE public.businesses
    SET ein = '33-0000001'
    WHERE id = '10000000-0000-4000-a000-000000000332'
  $$,
  '23505',
  NULL,
  'one normalized EIN cannot belong to two retained businesses'
);

UPDATE public.businesses
SET ein = '33-0000002'
WHERE id = '10000000-0000-4000-a000-000000000332';

SELECT is(
  (
    SELECT count(*)::bigint
    FROM public.businesses
    WHERE id IN (
      '10000000-0000-4000-a000-000000000333',
      '10000000-0000-4000-a000-000000000336'
    )
      AND ein IS NULL
  ),
  2::bigint,
  'the partial EIN index permits placeholder businesses without an EIN'
);

UPDATE public.businesses
SET telnyx_brand_id = '33000000-0000-4000-a000-000000000003'
WHERE id = '10000000-0000-4000-a000-000000000333';

SELECT is(
  (
    SELECT telnyx_brand_source
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a000-000000000333'
  ),
  'created_by_simplassist',
  'legacy app writes infer created-brand provenance'
);

UPDATE public.businesses
SET telnyx_brand_source = 'linked_existing'
WHERE id = '10000000-0000-4000-a000-000000000333';

UPDATE public.businesses
SET telnyx_brand_source = NULL
WHERE id = '10000000-0000-4000-a000-000000000333';

SELECT is(
  (
    SELECT telnyx_brand_source
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a000-000000000333'
  ),
  'linked_existing',
  'linked-existing provenance survives an accidental NULL rewrite'
);

SELECT throws_ok(
  $$
    UPDATE public.businesses
    SET telnyx_brand_source = 'created_by_simplassist'
    WHERE id = '10000000-0000-4000-a000-000000000333'
  $$,
  '42501',
  'linked-existing brand provenance cannot be downgraded',
  'linked-existing provenance cannot be reclassified as created'
);

UPDATE public.businesses
SET telnyx_brand_id = NULL
WHERE id = '10000000-0000-4000-a000-000000000333';

SELECT ok(
  (
    SELECT telnyx_brand_id IS NULL AND telnyx_brand_source IS NULL
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a000-000000000333'
  ),
  'clearing a brand ID also clears provenance'
);

INSERT INTO existing_brand_033_test_state (name, text_value)
VALUES (
  'fingerprint_a',
  public.telnyx_brand_link_identity_fingerprint(
    '10000000-0000-4000-a000-000000000331'
  )
);

SELECT ok(
  (
    SELECT text_value ~ '^[0-9a-f]{64}$'
    FROM existing_brand_033_test_state
    WHERE name = 'fingerprint_a'
  ),
  'complete legal identity produces a lowercase SHA-256 fingerprint'
);

UPDATE public.businesses
SET legal_business_name = '  simpl   assist demo llc '
WHERE id = '10000000-0000-4000-a000-000000000331';

SELECT is(
  public.telnyx_brand_link_identity_fingerprint(
    '10000000-0000-4000-a000-000000000331'
  ),
  (
    SELECT text_value
    FROM existing_brand_033_test_state
    WHERE name = 'fingerprint_a'
  ),
  'legal-name case and spacing normalize consistently'
);

UPDATE public.businesses
SET has_ein = false
WHERE id = '10000000-0000-4000-a000-000000000331';

SELECT is(
  public.telnyx_brand_link_identity_fingerprint(
    '10000000-0000-4000-a000-000000000331'
  ),
  NULL::text,
  'a business marked as having no EIN has no approvable fingerprint'
);

UPDATE public.businesses
SET has_ein = true
WHERE id = '10000000-0000-4000-a000-000000000331';

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'public.businesses'::regclass
      AND tgname = 'invalidate_telnyx_brand_link_on_identity_change'
      AND pg_get_triggerdef(oid) LIKE '%has_ein%'
  ),
  'has_ein edits participate in immediate link-approval invalidation'
);

SELECT is(
  public.telnyx_brand_link_identity_fingerprint(
    '10000000-0000-4000-a000-000000000336'
  ),
  NULL::text,
  'incomplete legal identity has no approvable fingerprint'
);

SELECT set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-a000-000000000331',
  true
);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$
    SELECT public.telnyx_brand_link_identity_fingerprint(
      '10000000-0000-4000-a000-000000000331'
    )
  $$,
  '42501',
  NULL,
  'customers cannot execute the identity fingerprint RPC'
);

SELECT throws_ok(
  $$SELECT count(*) FROM public.telnyx_brand_link_requests$$,
  '42501',
  NULL,
  'customers cannot read private link requests'
);

SELECT throws_ok(
  $$SELECT count(*) FROM public.telnyx_brand_link_events$$,
  '42501',
  NULL,
  'customers cannot read private link events'
);

SELECT lives_ok(
  $$
    UPDATE public.businesses
    SET name = 'Brand Link Customer Rename'
    WHERE id = '10000000-0000-4000-a000-000000000331'
  $$,
  'ordinary owner profile writes remain available'
);

SELECT throws_ok(
  $$
    UPDATE public.businesses
    SET brand_status = 'pending',
        campaign_status = 'pending',
        onboarding_registration_status = 'submitted',
        a2p_risk_review_status = 'admin_approved'
    WHERE id = '10000000-0000-4000-a000-000000000331'
  $$,
  '42501',
  'customer writes cannot change protected registration fields',
  'customers cannot forge carrier or risk-review authorization state'
);

SELECT throws_ok(
  $$
    INSERT INTO public.businesses (
      owner_id,
      name,
      business_type,
      slug,
      brand_status
    ) VALUES (
      '00000000-0000-4000-a000-000000000331',
      'Forged Carrier Business',
      'general',
      'forged-carrier-business-033',
      'approved'
    )
  $$,
  '42501',
  'customer writes cannot set protected registration fields',
  'customers cannot seed protected carrier state during insert'
);

RESET ROLE;
SET LOCAL ROLE service_role;

SELECT lives_ok(
  $$
    UPDATE public.businesses
    SET brand_status = 'pending'
    WHERE id = '10000000-0000-4000-a000-000000000333'
  $$,
  'trusted service writes may manage carrier state'
);

UPDATE public.businesses
SET brand_status = NULL
WHERE id = '10000000-0000-4000-a000-000000000333';

-- ---------------------------------------------------------------------------
-- Standalone inspection and lifecycle transitions
-- ---------------------------------------------------------------------------

SELECT lives_ok(
  $$
    SELECT public.record_existing_telnyx_brand_inspection(
      '10000000-0000-4000-a000-000000000331',
      ' bl69pdp ',
      '33000000-0000-4000-a000-000000000001',
      'preview_ok',
      'admin-033'
    )
  $$,
  'standalone inspection can be audited before staging'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.telnyx_brand_link_events
    WHERE business_id = '10000000-0000-4000-a000-000000000331'
      AND event_type = 'inspection_recorded'
      AND status = 'preview_ok'
      AND request_id IS NULL
      AND tcr_brand_id = 'BL69PDP'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.telnyx_brand_link_requests
    WHERE business_id = '10000000-0000-4000-a000-000000000331'
  ),
  'inspection records only a normalized, request-free audit event'
);

SELECT throws_ok(
  $$
    SELECT public.record_existing_telnyx_brand_inspection(
      '10000000-0000-4000-a000-000000000331',
      'BL69PDP',
      '33000000-0000-4000-a000-000000000001',
      'Invalid Outcome',
      'admin-033'
    )
  $$,
  '22023',
  'existing_brand_link_invalid_outcome_code',
  'inspection accepts only stable PII-free outcome codes'
);

SELECT throws_ok(
  $$
    SELECT public.stage_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000336',
      'BLINCOMPLETE',
      '33000000-0000-4000-a000-000000000006',
      'admin-033'
    )
  $$,
  '23514',
  'existing_brand_link_identity_incomplete',
  'incomplete legal identity cannot be staged'
);

SELECT lives_ok(
  $$
    SELECT public.stage_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      ' bl69pdp ',
      '33000000-0000-4000-a000-000000000001',
      'admin-033'
    )
  $$,
  'a complete business can stage a verified existing brand'
);

INSERT INTO existing_brand_033_test_state (name, uuid_value)
SELECT 'request_a', id
FROM public.telnyx_brand_link_requests
WHERE business_id = '10000000-0000-4000-a000-000000000331';

SELECT lives_ok(
  $$
    SELECT public.stage_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      'BL69PDP',
      '33000000-0000-4000-a000-000000000001',
      'admin-033'
    )
  $$,
  'identical staging safely refreshes the same pending request'
);

SELECT ok(
  (
    SELECT request.id = state.uuid_value
       AND request.status = 'pending_admin'
       AND request.identity_fingerprint ~ '^[0-9a-f]{64}$'
    FROM public.telnyx_brand_link_requests AS request
    JOIN existing_brand_033_test_state AS state
      ON state.name = 'request_a'
    WHERE request.business_id = '10000000-0000-4000-a000-000000000331'
  ),
  'staging retry retains the request identity and pending state'
);

SELECT throws_ok(
  $$
    SELECT public.stage_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000332',
      'BL69PDP',
      '33000000-0000-4000-a000-000000000002',
      'admin-033'
    )
  $$,
  '23505',
  'existing_brand_link_brand_already_reserved',
  'another business cannot reserve the same public TCR brand ID'
);

UPDATE public.businesses
SET telnyx_brand_id = '33000000-0000-4000-a000-000000000013'
WHERE id = '10000000-0000-4000-a000-000000000333';

SELECT throws_ok(
  $$
    SELECT public.stage_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000333',
      'BLCARRIER',
      '33000000-0000-4000-a000-000000000003',
      'admin-033'
    )
  $$,
  '55000',
  'existing_brand_link_resources_already_exist',
  'businesses with carrier resources cannot stage a link'
);

SELECT throws_ok(
  $$
    SELECT public.stage_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000332',
      'BLATTACHED',
      '33000000-0000-4000-a000-000000000013',
      'admin-033'
    )
  $$,
  '23505',
  'existing_brand_link_brand_already_attached',
  'a brand already attached to another business cannot be staged'
);

UPDATE public.businesses
SET telnyx_brand_id = NULL
WHERE id = '10000000-0000-4000-a000-000000000333';

UPDATE public.businesses
SET a2p_risk_review_status = 'not_started'
WHERE id = '10000000-0000-4000-a000-000000000331';

SELECT throws_ok(
  $$
    SELECT public.approve_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      'BL69PDP',
      '33000000-0000-4000-a000-000000000001',
      (SELECT identity_fingerprint
       FROM public.telnyx_brand_link_requests
       WHERE business_id = '10000000-0000-4000-a000-000000000331'),
      'admin-033'
    )
  $$,
  '55000',
  'existing_brand_link_risk_review_not_cleared',
  'approval requires a cleared A2P risk review'
);

UPDATE public.businesses
SET a2p_risk_review_status = 'passed'
WHERE id = '10000000-0000-4000-a000-000000000331';

SELECT throws_ok(
  $$
    SELECT public.approve_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      'BLCHANGED',
      '33000000-0000-4000-a000-000000000001',
      (SELECT identity_fingerprint
       FROM public.telnyx_brand_link_requests
       WHERE business_id = '10000000-0000-4000-a000-000000000331'),
      'admin-033'
    )
  $$,
  '23514',
  'existing_brand_link_provider_identity_changed',
  'approval rejects changed provider identity'
);

SELECT throws_ok(
  $$
    SELECT public.approve_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      'BL69PDP',
      '33000000-0000-4000-a000-000000000001',
      repeat('0', 64),
      'admin-033'
    )
  $$,
  '23514',
  'existing_brand_link_identity_changed',
  'approval rejects a stale identity fingerprint'
);

SELECT lives_ok(
  $$
    SELECT public.approve_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      'BL69PDP',
      '33000000-0000-4000-a000-000000000001',
      (SELECT identity_fingerprint
       FROM public.telnyx_brand_link_requests
       WHERE business_id = '10000000-0000-4000-a000-000000000331'),
      'admin-033'
    )
  $$,
  'matching cleared identity can be approved'
);

SELECT lives_ok(
  $$
    SELECT public.approve_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      'BL69PDP',
      '33000000-0000-4000-a000-000000000001',
      (SELECT identity_fingerprint
       FROM public.telnyx_brand_link_requests
       WHERE business_id = '10000000-0000-4000-a000-000000000331'),
      'admin-033'
    )
  $$,
  'identical approval retry is idempotent'
);

SELECT is(
  (
    SELECT count(*)::bigint
    FROM public.telnyx_brand_link_events
    WHERE business_id = '10000000-0000-4000-a000-000000000331'
      AND event_type = 'link_approved'
  ),
  1::bigint,
  'approval retry does not duplicate its audit event'
);

SELECT throws_ok(
  $$
    SELECT public.stage_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      'BL69PDP',
      '33000000-0000-4000-a000-000000000001',
      'admin-033'
    )
  $$,
  '55000',
  'existing_brand_link_already_approved_reset_first',
  'approved links cannot be restaged without an explicit reset'
);

SELECT throws_ok(
  $$
    SELECT public.block_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      'WRONG-BRAND',
      '33000000-0000-4000-a000-000000000001',
      (SELECT identity_fingerprint
       FROM public.telnyx_brand_link_requests
       WHERE business_id = '10000000-0000-4000-a000-000000000331'),
      'telnyx_brand_campaign_cap_reached',
      'admin-033'
    )
  $$,
  '23514',
  'existing_brand_link_provider_identity_changed',
  'blocking refuses to affect a request other than the exact revalidated tuple'
);

SELECT ok(
  (
    SELECT status = 'approved'
       AND last_error_code IS NULL
    FROM public.telnyx_brand_link_requests
    WHERE business_id = '10000000-0000-4000-a000-000000000331'
  ),
  'a stale block attempt leaves the newly current approval unchanged'
);

SELECT lives_ok(
  $$
    SELECT public.block_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      'BL69PDP',
      '33000000-0000-4000-a000-000000000001',
      (SELECT identity_fingerprint
       FROM public.telnyx_brand_link_requests
       WHERE business_id = '10000000-0000-4000-a000-000000000331'),
      'telnyx_brand_campaign_cap_reached',
      'admin-033'
    )
  $$,
  'an approved request can be blocked with a stable reason code'
);

SELECT ok(
  (
    SELECT status = 'blocked'
       AND approved_at IS NULL
       AND approved_by IS NULL
       AND last_error_code = 'telnyx_brand_campaign_cap_reached'
    FROM public.telnyx_brand_link_requests
    WHERE business_id = '10000000-0000-4000-a000-000000000331'
  ),
  'blocking clears approval and retains the exact campaign-cap reason'
);

SELECT lives_ok(
  $$
    SELECT public.reset_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      'admin-033'
    )
  $$,
  'a blocked request can be reset for another inspection'
);

SELECT ok(
  (
    SELECT status = 'pending_admin'
       AND identity_fingerprint IS NULL
       AND last_error_code IS NULL
    FROM public.telnyx_brand_link_requests
    WHERE business_id = '10000000-0000-4000-a000-000000000331'
  ),
  'reset preserves the hold row but clears stale approval identity'
);

SELECT lives_ok(
  $$
    SELECT public.stage_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      'BL69PDP',
      '33000000-0000-4000-a000-000000000001',
      'admin-033'
    )
  $$,
  'reset request can be inspected and staged again'
);

SELECT lives_ok(
  $$
    SELECT public.approve_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      'BL69PDP',
      '33000000-0000-4000-a000-000000000001',
      (SELECT identity_fingerprint
       FROM public.telnyx_brand_link_requests
       WHERE business_id = '10000000-0000-4000-a000-000000000331'),
      'admin-033'
    )
  $$,
  'restaged identity can be approved again'
);

RESET ROLE;
SELECT set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-a000-000000000331',
  true
);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$
    UPDATE public.businesses
    SET legal_business_name = 'Simpl Assist Demo Updated LLC'
    WHERE id = '10000000-0000-4000-a000-000000000331'
  $$,
  'owners may correct legal identity before a link is consumed'
);

RESET ROLE;
SET LOCAL ROLE service_role;

SELECT ok(
  (
    SELECT status = 'pending_admin'
       AND identity_fingerprint IS NULL
       AND approved_at IS NULL
       AND approved_by IS NULL
       AND last_error_code = 'business_identity_changed'
    FROM public.telnyx_brand_link_requests
    WHERE business_id = '10000000-0000-4000-a000-000000000331'
  )
  AND EXISTS (
    SELECT 1
    FROM public.telnyx_brand_link_events
    WHERE business_id = '10000000-0000-4000-a000-000000000331'
      AND event_type = 'approval_invalidated'
      AND reason_code = 'business_identity_changed'
      AND actor_user_id = '00000000-0000-4000-a000-000000000331'
  ),
  'identity edits immediately invalidate approval and record the actor'
);

SELECT lives_ok(
  $$
    SELECT public.stage_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      'BL69PDP',
      '33000000-0000-4000-a000-000000000001',
      'admin-033'
    )
  $$,
  'changed identity can be restaged after fresh provider comparison'
);

SELECT lives_ok(
  $$
    SELECT public.approve_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      'BL69PDP',
      '33000000-0000-4000-a000-000000000001',
      (SELECT identity_fingerprint
       FROM public.telnyx_brand_link_requests
       WHERE business_id = '10000000-0000-4000-a000-000000000331'),
      'admin-033'
    )
  $$,
  'freshly compared identity can be re-approved'
);

SELECT throws_ok(
  $$
    SELECT public.consume_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      'BL69PDP',
      '33000000-0000-4000-a000-000000000001',
      (SELECT identity_fingerprint
       FROM public.telnyx_brand_link_requests
       WHERE business_id = '10000000-0000-4000-a000-000000000331'),
      'launch-033'
    )
  $$,
  '55000',
  'existing_brand_link_launch_not_claimed',
  'consumption requires the paid launch claim first'
);

UPDATE public.businesses
SET onboarding_registration_status = 'submitting'
WHERE id = '10000000-0000-4000-a000-000000000331';

UPDATE public.businesses
SET a2p_risk_review_status = 'not_started'
WHERE id = '10000000-0000-4000-a000-000000000331';

SELECT throws_ok(
  $$
    SELECT public.consume_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      'BL69PDP',
      '33000000-0000-4000-a000-000000000001',
      (SELECT identity_fingerprint
       FROM public.telnyx_brand_link_requests
       WHERE business_id = '10000000-0000-4000-a000-000000000331'),
      'launch-033'
    )
  $$,
  '55000',
  'existing_brand_link_risk_review_not_cleared',
  'launch rechecks risk clearance immediately before consumption'
);

UPDATE public.businesses
SET a2p_risk_review_status = 'passed',
    telnyx_submission_disabled = true
WHERE id = '10000000-0000-4000-a000-000000000331';

SELECT throws_ok(
  $$
    SELECT public.consume_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      'BL69PDP',
      '33000000-0000-4000-a000-000000000001',
      (SELECT identity_fingerprint
       FROM public.telnyx_brand_link_requests
       WHERE business_id = '10000000-0000-4000-a000-000000000331'),
      'launch-033'
    )
  $$,
  '55000',
  'existing_brand_link_telnyx_submission_disabled',
  'launch kill switch prevents link consumption'
);

UPDATE public.businesses
SET telnyx_submission_disabled = false
WHERE id = '10000000-0000-4000-a000-000000000331';

UPDATE public.businesses
SET telnyx_brand_id = '33000000-0000-4000-a000-000000000001'
WHERE id = '10000000-0000-4000-a000-000000000333';

SELECT throws_ok(
  $$
    SELECT public.consume_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      'BL69PDP',
      '33000000-0000-4000-a000-000000000001',
      (SELECT identity_fingerprint
       FROM public.telnyx_brand_link_requests
       WHERE business_id = '10000000-0000-4000-a000-000000000331'),
      'launch-033'
    )
  $$,
  '23505',
  'existing_brand_link_brand_already_attached',
  'launch rechecks that another business did not attach the brand'
);

UPDATE public.businesses
SET telnyx_brand_id = NULL
WHERE id = '10000000-0000-4000-a000-000000000333';

RESET ROLE;

CREATE FUNCTION public.test_033_poison_consumed_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '033 poison consumed event' USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER test_033_poison_consumed_event
BEFORE INSERT ON public.telnyx_brand_link_events
FOR EACH ROW
WHEN (NEW.event_type = 'link_consumed')
EXECUTE FUNCTION public.test_033_poison_consumed_event();

SET LOCAL ROLE service_role;

SELECT throws_ok(
  $$
    SELECT public.consume_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      'BL69PDP',
      '33000000-0000-4000-a000-000000000001',
      (SELECT identity_fingerprint
       FROM public.telnyx_brand_link_requests
       WHERE business_id = '10000000-0000-4000-a000-000000000331'),
      'launch-033'
    )
  $$,
  'P0001',
  '033 poison consumed event',
  'a failed consumption audit aborts the entire transition'
);

SELECT ok(
  (
    SELECT telnyx_brand_id IS NULL
       AND telnyx_brand_source IS NULL
       AND brand_status IS NULL
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a000-000000000331'
  )
  AND (
    SELECT status = 'approved' AND consumed_at IS NULL
    FROM public.telnyx_brand_link_requests
    WHERE business_id = '10000000-0000-4000-a000-000000000331'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.telnyx_brand_link_events
    WHERE business_id = '10000000-0000-4000-a000-000000000331'
      AND event_type = 'link_consumed'
  ),
  'failed consumption leaves no partial business, request, or audit state'
);

RESET ROLE;
DROP TRIGGER test_033_poison_consumed_event
  ON public.telnyx_brand_link_events;
DROP FUNCTION public.test_033_poison_consumed_event();
SET LOCAL ROLE service_role;

SELECT lives_ok(
  $$
    SELECT public.consume_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      'BL69PDP',
      '33000000-0000-4000-a000-000000000001',
      (SELECT identity_fingerprint
       FROM public.telnyx_brand_link_requests
       WHERE business_id = '10000000-0000-4000-a000-000000000331'),
      'launch-033'
    )
  $$,
  'approved link consumes after the poison is removed'
);

SELECT ok(
  (
    SELECT telnyx_brand_id = '33000000-0000-4000-a000-000000000001'
       AND telnyx_brand_source = 'linked_existing'
       AND brand_status = 'approved'
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a000-000000000331'
  )
  AND (
    SELECT status = 'consumed' AND consumed_at IS NOT NULL
    FROM public.telnyx_brand_link_requests
    WHERE business_id = '10000000-0000-4000-a000-000000000331'
  ),
  'consumption atomically connects the existing brand with linked provenance'
);

UPDATE public.businesses
SET onboarding_registration_status = 'submitted'
WHERE id = '10000000-0000-4000-a000-000000000331';

UPDATE public.businesses
SET a2p_risk_review_status = 'blocked'
WHERE id = '10000000-0000-4000-a000-000000000331';

SELECT throws_ok(
  $$
    SELECT public.consume_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      'BL69PDP',
      '33000000-0000-4000-a000-000000000001',
      (SELECT identity_fingerprint
       FROM public.telnyx_brand_link_requests
       WHERE business_id = '10000000-0000-4000-a000-000000000331'),
      'launch-033'
    )
  $$,
  '55000',
  'existing_brand_link_risk_review_not_cleared',
  'a consumed retry still honors a newly applied risk hold'
);

UPDATE public.businesses
SET a2p_risk_review_status = 'passed',
    telnyx_submission_disabled = true
WHERE id = '10000000-0000-4000-a000-000000000331';

SELECT throws_ok(
  $$
    SELECT public.consume_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      'BL69PDP',
      '33000000-0000-4000-a000-000000000001',
      (SELECT identity_fingerprint
       FROM public.telnyx_brand_link_requests
       WHERE business_id = '10000000-0000-4000-a000-000000000331'),
      'launch-033'
    )
  $$,
  '55000',
  'existing_brand_link_telnyx_submission_disabled',
  'a consumed retry still honors a newly applied Telnyx kill switch'
);

UPDATE public.businesses
SET telnyx_submission_disabled = false
WHERE id = '10000000-0000-4000-a000-000000000331';

SELECT lives_ok(
  $$
    SELECT public.consume_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      'BL69PDP',
      '33000000-0000-4000-a000-000000000001',
      (SELECT identity_fingerprint
       FROM public.telnyx_brand_link_requests
       WHERE business_id = '10000000-0000-4000-a000-000000000331'),
      'launch-033'
    )
  $$,
  'identical consumption retry stays idempotent after launch advances'
);

SELECT is(
  (
    SELECT count(*)::bigint
    FROM public.telnyx_brand_link_events
    WHERE business_id = '10000000-0000-4000-a000-000000000331'
      AND event_type = 'link_consumed'
  ),
  1::bigint,
  'consumption retry does not duplicate its audit event'
);

RESET ROLE;
SELECT set_config(
  'request.jwt.claim.sub',
  '00000000-0000-4000-a000-000000000331',
  true
);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$
    UPDATE public.businesses
    SET zip = '46299'
    WHERE id = '10000000-0000-4000-a000-000000000331'
  $$,
  '42501',
  'carrier identity cannot change after brand-link consumption',
  'consumed carrier identity cannot drift'
);

SELECT throws_ok(
  $$
    UPDATE public.businesses
    SET has_ein = false
    WHERE id = '10000000-0000-4000-a000-000000000331'
  $$,
  '42501',
  'carrier identity cannot change after brand-link consumption',
  'consumed carrier identity cannot be changed to the no-EIN path'
);

RESET ROLE;
SET LOCAL ROLE service_role;

SELECT throws_ok(
  $$
    UPDATE public.businesses
    SET telnyx_brand_source = 'created_by_simplassist'
    WHERE id = '10000000-0000-4000-a000-000000000331'
  $$,
  '42501',
  'consumed linked-existing brand attachment cannot be changed',
  'trusted code cannot downgrade consumed imported-brand provenance'
);

SELECT throws_ok(
  $$
    SELECT public.reset_existing_telnyx_brand_link(
      '10000000-0000-4000-a000-000000000331',
      'admin-033'
    )
  $$,
  '55000',
  'existing_brand_link_already_consumed',
  'consumed links cannot be reset'
);

-- ---------------------------------------------------------------------------
-- Cleanup success and transaction rollback
-- ---------------------------------------------------------------------------

RESET ROLE;

UPDATE public.businesses
SET telnyx_brand_id = '33000000-0000-4000-a000-000000000004',
    telnyx_brand_source = 'linked_existing',
    brand_status = 'approved'
WHERE id = '10000000-0000-4000-a000-000000000334';

INSERT INTO public.telnyx_brand_link_requests (
  business_id,
  tcr_brand_id,
  telnyx_brand_id,
  status,
  identity_fingerprint,
  inspected_by,
  approved_at,
  approved_by,
  consumed_at
) VALUES (
  '10000000-0000-4000-a000-000000000334',
  'BLCLEANUP',
  '33000000-0000-4000-a000-000000000004',
  'consumed',
  public.telnyx_brand_link_identity_fingerprint(
    '10000000-0000-4000-a000-000000000334'
  ),
  'admin-033',
  now(),
  'admin-033',
  now()
);

INSERT INTO public.telnyx_brand_link_events (
  business_id,
  request_id,
  event_type,
  status,
  tcr_brand_id,
  telnyx_brand_id,
  actor_user_id
)
SELECT
  request.business_id,
  request.id,
  'link_consumed',
  'consumed',
  request.tcr_brand_id,
  request.telnyx_brand_id,
  'launch-033'
FROM public.telnyx_brand_link_requests AS request
WHERE request.business_id = '10000000-0000-4000-a000-000000000334';

UPDATE public.businesses
SET deleted_at = now() - interval '61 days',
    deletion_scheduled_for = now() - interval '1 day'
WHERE id = '10000000-0000-4000-a000-000000000334';

SET LOCAL ROLE service_role;

SELECT results_eq(
  $$
    SELECT public.cleanup_expired_business(
      '10000000-0000-4000-a000-000000000334'
    )
  $$,
  ARRAY['00000000-0000-4000-a000-000000000334'::uuid],
  'cleanup returns the durable auth linkage for a linked-brand account'
);

SELECT ok(
  (
    SELECT owner_id IS NULL
       AND cleanup_auth_user_id = '00000000-0000-4000-a000-000000000334'
       AND name = '[deleted]'
       AND ein IS NULL
       AND cleanup_pii_scrubbed_at IS NOT NULL
       AND telnyx_brand_id = '33000000-0000-4000-a000-000000000004'
       AND telnyx_brand_source = 'linked_existing'
       AND brand_status IS NULL
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a000-000000000334'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.telnyx_brand_link_requests
    WHERE business_id = '10000000-0000-4000-a000-000000000334'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.telnyx_brand_link_events
    WHERE business_id = '10000000-0000-4000-a000-000000000334'
  )
  AND EXISTS (
    SELECT 1
    FROM public.telnyx_resource_release_actions AS action
    JOIN public.telnyx_resource_release_runs AS run
      ON run.id = action.run_id
     AND run.business_id = action.business_id
    JOIN public.businesses AS business
      ON business.id = action.business_id
     AND business.active_telnyx_release_run_id = run.id
    WHERE action.business_id = '10000000-0000-4000-a000-000000000334'
      AND action.resource_type = 'brand'
      AND action.provider_id = '33000000-0000-4000-a000-000000000004'
      AND action.classification = 'policy_retain'
      AND action.desired_action = 'retain'
      AND action.state = 'retained'
      AND run.status = 'protected_hold'
  ),
  'cleanup removes local link state and PII while durably retaining Telnyx release provenance'
);

RESET ROLE;

UPDATE public.businesses
SET telnyx_brand_id = '33000000-0000-4000-a000-000000000005',
    telnyx_brand_source = 'linked_existing',
    brand_status = 'approved'
WHERE id = '10000000-0000-4000-a000-000000000335';

INSERT INTO public.telnyx_brand_link_requests (
  business_id,
  tcr_brand_id,
  telnyx_brand_id,
  status,
  identity_fingerprint,
  inspected_by,
  approved_at,
  approved_by,
  consumed_at
) VALUES (
  '10000000-0000-4000-a000-000000000335',
  'BLROLLBACK',
  '33000000-0000-4000-a000-000000000005',
  'consumed',
  public.telnyx_brand_link_identity_fingerprint(
    '10000000-0000-4000-a000-000000000335'
  ),
  'admin-033',
  now(),
  'admin-033',
  now()
);

INSERT INTO public.telnyx_brand_link_events (
  business_id,
  request_id,
  event_type,
  status,
  tcr_brand_id,
  telnyx_brand_id,
  actor_user_id
)
SELECT
  request.business_id,
  request.id,
  'link_consumed',
  'consumed',
  request.tcr_brand_id,
  request.telnyx_brand_id,
  'launch-033'
FROM public.telnyx_brand_link_requests AS request
WHERE request.business_id = '10000000-0000-4000-a000-000000000335';

UPDATE public.businesses
SET deleted_at = now() - interval '61 days',
    deletion_scheduled_for = now() - interval '1 day'
WHERE id = '10000000-0000-4000-a000-000000000335';

CREATE FUNCTION public.test_033_poison_tombstone_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '033 poison tombstone update' USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER test_033_poison_tombstone_update
BEFORE UPDATE ON public.businesses
FOR EACH ROW
WHEN (
  OLD.id = '10000000-0000-4000-a000-000000000335'
  AND NEW.name = '[deleted]'
)
EXECUTE FUNCTION public.test_033_poison_tombstone_update();

SET LOCAL ROLE service_role;

SELECT throws_ok(
  $$
    SELECT public.cleanup_expired_business(
      '10000000-0000-4000-a000-000000000335'
    )
  $$,
  'P0001',
  '033 poison tombstone update',
  'a failed tombstone update rolls back preceding link deletion'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.telnyx_brand_link_requests
    WHERE business_id = '10000000-0000-4000-a000-000000000335'
      AND status = 'consumed'
  )
  AND EXISTS (
    SELECT 1
    FROM public.telnyx_brand_link_events
    WHERE business_id = '10000000-0000-4000-a000-000000000335'
      AND event_type = 'link_consumed'
  )
  AND (
    SELECT owner_id = '00000000-0000-4000-a000-000000000335'
       AND ein = '33-0000005'
       AND telnyx_brand_id = '33000000-0000-4000-a000-000000000005'
       AND telnyx_brand_source = 'linked_existing'
    FROM public.businesses
    WHERE id = '10000000-0000-4000-a000-000000000335'
  ),
  'failed cleanup preserves the complete linked-brand account state'
);

RESET ROLE;
DROP TRIGGER test_033_poison_tombstone_update ON public.businesses;
DROP FUNCTION public.test_033_poison_tombstone_update();

SELECT * FROM finish();

ROLLBACK;
