BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

-- Remote workers commit only the synthetic starting fixtures. Admission itself
-- always rolls back: retained canonical registrations must never be force-deleted.
DO $require_disposable_database$
DECLARE
  v_address inet := inet_server_addr();
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres'
     OR current_setting('port') <> '5432'
     OR coalesce(nullif(current_setting('simplassist.test_database_host', true), ''),
       'supabase_db_SimplAssist') NOT IN ('supabase_db_SimplAssist','supabase_db_SimplAssistReviews')
     OR NOT (v_address IS NULL OR v_address <<= inet '127.0.0.0/8'
       OR v_address <<= inet '10.0.0.0/8' OR v_address <<= inet '172.16.0.0/12'
       OR v_address <<= inet '192.168.0.0/16' OR v_address <<= inet '::1/128'
       OR v_address <<= inet 'fc00::/7')
     OR NOT coalesce((current_setting('data_directory') = '/var/lib/postgresql/data'
       AND current_setting('app.settings.jwt_secret', true) =
         'super-secret-jwt-token-with-at-least-32-characters-long')
       OR current_setting('simplassist.disposable_test_database', true) = 'on', false) THEN
    RAISE EXCEPTION 'test_116_concurrency_requires_disposable_local_database'
      USING ERRCODE = '55000';
  END IF;
END;
$require_disposable_database$;

SELECT plan(13);
CREATE TEMP TABLE shared_116_race_result (
  admission_sent integer, admission_ready boolean, admission jsonb,
  uncommitted_hidden boolean, claim_sent integer, claim_waited boolean,
  claim_result jsonb, outsider_unchanged boolean, canonical_rolled_back boolean,
  source_preserved boolean, cleanup_ok boolean, orchestration_error text
) ON COMMIT DROP;

CREATE FUNCTION pg_temp.cleanup_shared_116_race() RETURNS boolean
LANGUAGE plpgsql SET search_path = public, extensions, pg_temp AS $$
DECLARE connection_name text; cleanup_ok boolean := true;
BEGIN
  FOREACH connection_name IN ARRAY ARRAY['shared_116_a', 'shared_116_b'] LOOP
    IF connection_name = ANY(coalesce(dblink_get_connections(), ARRAY[]::text[])) THEN
      BEGIN
        IF dblink_is_busy(connection_name) = 1 THEN
          PERFORM dblink_cancel_query(connection_name);
        END IF;
        BEGIN
          PERFORM value FROM dblink_get_result(connection_name, false) AS pending(value text);
        EXCEPTION WHEN OTHERS THEN NULL; END;
        BEGIN
          PERFORM value FROM dblink_get_result(connection_name, false) AS drained(value text);
        EXCEPTION WHEN OTHERS THEN NULL; END;
        PERFORM dblink_exec(connection_name, 'ROLLBACK');
        PERFORM dblink_disconnect(connection_name);
      EXCEPTION WHEN OTHERS THEN
        cleanup_ok := false;
        BEGIN PERFORM dblink_disconnect(connection_name); EXCEPTION WHEN OTHERS THEN NULL; END;
      END;
    END IF;
  END LOOP;
  IF 'shared_116_setup' = ANY(coalesce(dblink_get_connections(), ARRAY[]::text[])) THEN
    BEGIN
      PERFORM dblink_exec('shared_116_setup', $cleanup$
        BEGIN;
        DELETE FROM public.telnyx_managed_resources
        WHERE business_id = '10000000-0000-4000-c116-000000000001'
          AND provider_id = '11600000-0000-4000-8116-000000000091'
          AND retained_shared_registration_id IS NULL;
        DELETE FROM public.businesses
        WHERE owner_id = '00000000-0000-4000-c116-000000000001';
        DELETE FROM auth.users
        WHERE id = '00000000-0000-4000-c116-000000000001'
          AND email = 'shared116-race@example.test';
        COMMIT;
      $cleanup$);
      PERFORM dblink_disconnect('shared_116_setup');
    EXCEPTION WHEN OTHERS THEN
      cleanup_ok := false;
      BEGIN PERFORM dblink_disconnect('shared_116_setup'); EXCEPTION WHEN OTHERS THEN NULL; END;
    END;
  END IF;
  RETURN cleanup_ok;
END;
$$;

DO $race$
DECLARE
  -- Supabase trusts loopback, which non-superuser dblink deliberately rejects.
  -- The Docker hostname uses password authentication. Dedicated local runners
  -- can set simplassist.test_database_host without changing the suite default.
  connection_string text := format('host=%L port=5432 dbname=postgres user=postgres password=postgres',
    coalesce(nullif(current_setting('simplassist.test_database_host', true), ''), 'supabase_db_SimplAssist'));
  result shared_116_race_result;
  ignored jsonb;
BEGIN
  BEGIN
    -- Never overwrite a prior incomplete run or another fixture owner.
    IF EXISTS(SELECT 1 FROM auth.users WHERE id = '00000000-0000-4000-c116-000000000001')
      OR EXISTS(SELECT 1 FROM shared_business_registrations WHERE normalized_ein = '123456191') THEN
      RAISE EXCEPTION 'shared_116_race_fixture_already_exists';
    END IF;
    PERFORM dblink_connect('shared_116_setup', connection_string);
    PERFORM dblink_exec('shared_116_setup', $fixtures$
      BEGIN;
      INSERT INTO auth.users(id,email)
        VALUES('00000000-0000-4000-c116-000000000001','shared116-race@example.test');
      INSERT INTO public.businesses(id,owner_id,name,business_type,slug,billing_mode,onboarding_completed_at,
        ein,has_ein,legal_business_name,business_entity_type,business_registration_state,address,city,state,zip,
        telnyx_brand_id,telnyx_brand_source,brand_status,telnyx_campaign_id)
      VALUES('10000000-0000-4000-c116-000000000001','00000000-0000-4000-c116-000000000001',
        'Shared race source','general','shared116-race-source','stripe',now(),
        '12-3456191',true,'Shared Race LLC','llc','IN','191 Test Street','South Bend','IN','46601',
        '11600000-0000-4000-8116-000000000091','linked_existing','approved','shared116-race-source-campaign');
      INSERT INTO public.businesses(id,owner_id,name,business_type,slug,billing_mode,onboarding_completed_at)
      VALUES('10000000-0000-4000-c116-000000000002','00000000-0000-4000-c116-000000000001',
        'Shared race target','general','shared116-race-target','stripe',now()),
        ('10000000-0000-4000-c116-000000000003','00000000-0000-4000-c116-000000000001',
        'Shared race outsider','general','shared116-race-outsider','stripe',now());
      INSERT INTO public.subscriptions(business_id,stripe_customer_id,stripe_subscription_id,plan,status,current_period_start,current_period_end)
      VALUES('10000000-0000-4000-c116-000000000001','cus_shared116_race_source','sub_shared116_race_source',
        'full','active',now()-interval '1 day',now()+interval '29 days'),
        ('10000000-0000-4000-c116-000000000002','cus_shared116_race_target','sub_shared116_race_target',
        'chat_only','active',now()-interval '1 day',now()+interval '29 days');
      INSERT INTO public.business_plan_family_locks(business_id,family,claimed_by)
      VALUES('10000000-0000-4000-c116-000000000002','chat_only','stripe_sync');
      INSERT INTO public.telnyx_brand_link_requests(business_id,tcr_brand_id,telnyx_brand_id,status,
        identity_fingerprint,inspected_by,approved_by,approved_at,consumed_at)
      VALUES('10000000-0000-4000-c116-000000000001','B116RACE','11600000-0000-4000-8116-000000000091',
        'consumed',repeat('c',64),'race116','race116',now(),now());
      INSERT INTO public.telnyx_managed_resources(business_id,resource_type,provider_id,public_tcr_id,provider_origin)
      VALUES('10000000-0000-4000-c116-000000000001','brand','11600000-0000-4000-8116-000000000091',
        'B116RACE','linked_existing');
      COMMIT;
    $fixtures$);
    PERFORM dblink_connect('shared_116_a', connection_string);
    PERFORM dblink_connect('shared_116_b', connection_string);
    PERFORM dblink_exec('shared_116_a', $admission_helper$
      CREATE FUNCTION pg_temp.admit() RETURNS jsonb LANGUAGE plpgsql AS $body$
      DECLARE registration_id uuid;
      BEGIN
        SELECT public.approve_shared_review_brand_member(b.id,'10000000-0000-4000-c116-000000000002',
          b.owner_id,b.owner_id,b.owner_id,0,b.telnyx_brand_id,'B116RACE',to_jsonb(b),now())
          INTO registration_id FROM public.businesses b WHERE b.id='10000000-0000-4000-c116-000000000001';
        RETURN jsonb_build_object('registrationId',registration_id);
      EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('errorState',SQLSTATE,'error',SQLERRM);
      END; $body$;
    $admission_helper$);
    PERFORM dblink_exec('shared_116_b', $claim_helper$
      CREATE FUNCTION pg_temp.claim_ein() RETURNS jsonb LANGUAGE plpgsql AS $body$
      BEGIN
        UPDATE public.businesses SET ein='12-3456191',has_ein=true
          WHERE id='10000000-0000-4000-c116-000000000003';
        RETURN jsonb_build_object('unexpectedSuccess',true);
      EXCEPTION WHEN OTHERS THEN RETURN jsonb_build_object('errorState',SQLSTATE,'error',SQLERRM);
      END; $body$;
    $claim_helper$);
    PERFORM dblink_exec('shared_116_a', 'BEGIN; SET LOCAL statement_timeout = ''5s''');
    PERFORM dblink_exec('shared_116_b', 'BEGIN; SET LOCAL statement_timeout = ''5s''');
    -- Reproduce the former cycle's irrelevant empty-identity lock. Admission
    -- must not request it while holding the real EIN/brand locks. No business
    -- identity may ever depend on these blank global keys.
    SELECT payload INTO ignored FROM dblink('shared_116_b',
      'SELECT jsonb_build_array(pg_advisory_xact_lock(hashtextextended(''brand:'',116)),pg_advisory_xact_lock(hashtextextended(''ein:'',116)))') AS held(payload jsonb);
    result.admission_sent := dblink_send_query('shared_116_a', 'SELECT pg_temp.admit()');
    FOR attempt IN 1..80 LOOP
      EXIT WHEN dblink_is_busy('shared_116_a') = 0;
      PERFORM pg_sleep(0.025);
    END LOOP;
    result.admission_ready := dblink_is_busy('shared_116_a') = 0;
    IF NOT result.admission_ready THEN
      RAISE EXCEPTION 'admission_waited_on_empty_identity_lock';
    END IF;
    SELECT payload INTO result.admission FROM dblink_get_result('shared_116_a') AS admitted(payload jsonb);
    PERFORM payload FROM dblink_get_result('shared_116_a') AS drained(payload jsonb);
    IF result.admission->>'registrationId' IS NULL THEN
      RAISE EXCEPTION 'admission_failed: %',result.admission;
    END IF;
    result.uncommitted_hidden := NOT EXISTS(SELECT 1 FROM shared_business_registrations WHERE normalized_ein='123456191');
    result.claim_sent := dblink_send_query('shared_116_b', 'SELECT pg_temp.claim_ein()');
    PERFORM pg_sleep(0.1);
    result.claim_waited := dblink_is_busy('shared_116_b') = 1;
    -- Release the canonical identity locks without retaining any shared group.
    PERFORM dblink_exec('shared_116_a', 'ROLLBACK');
    SELECT payload INTO result.claim_result FROM dblink_get_result('shared_116_b') AS claimed(payload jsonb);
    PERFORM payload FROM dblink_get_result('shared_116_b') AS drained(payload jsonb);
    PERFORM dblink_exec('shared_116_b', 'ROLLBACK');
    result.outsider_unchanged := EXISTS(SELECT 1 FROM businesses WHERE id='10000000-0000-4000-c116-000000000003' AND ein IS NULL AND shared_registration_id IS NULL);
    result.canonical_rolled_back := NOT EXISTS(SELECT 1 FROM shared_business_registrations WHERE normalized_ein='123456191')
      AND NOT EXISTS(SELECT 1 FROM shared_business_registration_members WHERE owner_id='00000000-0000-4000-c116-000000000001');
    result.source_preserved := EXISTS(SELECT 1 FROM businesses b JOIN telnyx_managed_resources r ON r.business_id=b.id
      WHERE b.id='10000000-0000-4000-c116-000000000001' AND b.ein='12-3456191' AND b.shared_registration_id IS NULL
      AND b.telnyx_campaign_id='shared116-race-source-campaign' AND r.provider_id=b.telnyx_brand_id
      AND r.local_claim_active AND r.retained_shared_registration_id IS NULL);
  EXCEPTION WHEN OTHERS THEN
    result.orchestration_error := SQLSTATE || ': ' || SQLERRM;
  END;
  result.cleanup_ok := pg_temp.cleanup_shared_116_race();
  INSERT INTO shared_116_race_result SELECT result.*;
END;
$race$;

SELECT is(admission_sent,1,'shared admission starts in an independent transaction') FROM shared_116_race_result;
SELECT ok(admission_ready,'empty identity keys cannot deadlock canonical admission') FROM shared_116_race_result;
SELECT ok(admission->>'registrationId' IS NOT NULL,'exact approved source proof creates the staged membership') FROM shared_116_race_result;
SELECT ok(uncommitted_hidden,'another connection cannot observe the uncommitted shared group') FROM shared_116_race_result;
SELECT is(claim_sent,1,'ordinary duplicate EIN claim starts concurrently') FROM shared_116_race_result;
SELECT ok(claim_waited,'ordinary EIN claim waits for the admission identity fence') FROM shared_116_race_result;
SELECT is(claim_result->>'errorState','23505','ordinary duplicate claim fails uniqueness after admission rolls back') FROM shared_116_race_result;
SELECT ok(outsider_unchanged,'unapproved account never receives the shared EIN or membership') FROM shared_116_race_result;
SELECT ok(canonical_rolled_back,'rollback leaves no canonical group or memberships') FROM shared_116_race_result;
SELECT ok(source_preserved,'original sender keeps its EIN, campaign, and only brand ledger') FROM shared_116_race_result;
SELECT is(orchestration_error,NULL::text,'concurrent operations finish without timeout or deadlock') FROM shared_116_race_result;
SELECT ok(cleanup_ok,'all remote sessions and committed starting fixtures are cleaned') FROM shared_116_race_result;
SELECT ok(NOT EXISTS(SELECT 1 FROM auth.users WHERE id='00000000-0000-4000-c116-000000000001')
  AND NOT EXISTS(SELECT 1 FROM businesses WHERE owner_id='00000000-0000-4000-c116-000000000001'),
  'no synthetic owner or business remains after the test');
SELECT * FROM finish();
ROLLBACK;
