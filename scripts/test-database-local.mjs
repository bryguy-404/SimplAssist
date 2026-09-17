#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = realpathSync(path.resolve(SCRIPT_DIR, ".."));
const CONFIG_PATH = path.join(REPO_ROOT, "supabase", "config.toml");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const DATABASE_TESTS = "supabase/tests/database";

const PROJECT_NAME = "SimplAssist";
const DATABASE_CONTAINER = `supabase_db_${PROJECT_NAME}`;
const DATABASE_HOST_PORT = "54322";
const DATABASE_CONTAINER_PORT = "5432";
const API_HOST_PORT = 54321;
const DATABASE_MAJOR_VERSION = 17;
const SUPABASE_CLI_VERSION = "2.115.0";
const LOCAL_JWT_SENTINEL =
  "super-secret-jwt-token-with-at-least-32-characters-long";
const PRE_PG_CRON_MIGRATION_VERSIONS = Object.freeze([
  "001",
  "002",
  "003",
  "004",
  "005",
  "006",
  "007",
  "008",
]);

const DOCKER_TARGET_ENVIRONMENT_KEYS = Object.freeze([
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
]);

const REMOTE_ENVIRONMENT_KEYS = [
  "DATABASE_URL",
  "DIRECT_URL",
  "PGDATABASE",
  "PGHOST",
  "PGPASSWORD",
  "PGPORT",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGUSER",
  "SUPABASE_ACCESS_TOKEN",
  "SUPABASE_ANON_KEY",
  "SUPABASE_DB_PASSWORD",
  "SUPABASE_PROJECT_ID",
  "SUPABASE_PROJECT_REF",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
];

const POST_RESET_PRIVILEGE_EXPRESSIONS = Object.freeze([
  ["authenticated_businesses_select", "has_table_privilege('authenticated', 'public.businesses', 'SELECT')"],
  ["authenticated_businesses_insert", "has_table_privilege('authenticated', 'public.businesses', 'INSERT')"],
  ["authenticated_businesses_update", "has_table_privilege('authenticated', 'public.businesses', 'UPDATE')"],
  ["authenticated_businesses_delete", "has_table_privilege('authenticated', 'public.businesses', 'DELETE')"],
  ["service_role_businesses_select", "has_table_privilege('service_role', 'public.businesses', 'SELECT')"],
  ["service_role_businesses_insert", "has_table_privilege('service_role', 'public.businesses', 'INSERT')"],
  ["service_role_businesses_update", "has_table_privilege('service_role', 'public.businesses', 'UPDATE')"],
  ["service_role_businesses_delete", "has_table_privilege('service_role', 'public.businesses', 'DELETE')"],
  ["authenticated_subscriptions_select", "has_table_privilege('authenticated', 'public.subscriptions', 'SELECT')"],
  ["authenticated_subscriptions_insert_denied", "NOT has_table_privilege('authenticated', 'public.subscriptions', 'INSERT')"],
  ["authenticated_subscriptions_update_denied", "NOT has_table_privilege('authenticated', 'public.subscriptions', 'UPDATE')"],
  ["authenticated_subscriptions_delete_denied", "NOT has_table_privilege('authenticated', 'public.subscriptions', 'DELETE')"],
  ["anon_deletion_actions_select_denied", "NOT has_table_privilege('anon', 'public.account_deletion_stripe_actions', 'SELECT')"],
  ["anon_deletion_actions_insert_denied", "NOT has_table_privilege('anon', 'public.account_deletion_stripe_actions', 'INSERT')"],
  ["anon_deletion_actions_update_denied", "NOT has_table_privilege('anon', 'public.account_deletion_stripe_actions', 'UPDATE')"],
  ["anon_deletion_actions_delete_denied", "NOT has_table_privilege('anon', 'public.account_deletion_stripe_actions', 'DELETE')"],
  ["authenticated_deletion_actions_select_denied", "NOT has_table_privilege('authenticated', 'public.account_deletion_stripe_actions', 'SELECT')"],
  ["authenticated_deletion_actions_insert_denied", "NOT has_table_privilege('authenticated', 'public.account_deletion_stripe_actions', 'INSERT')"],
  ["authenticated_deletion_actions_update_denied", "NOT has_table_privilege('authenticated', 'public.account_deletion_stripe_actions', 'UPDATE')"],
  ["authenticated_deletion_actions_delete_denied", "NOT has_table_privilege('authenticated', 'public.account_deletion_stripe_actions', 'DELETE')"],
  ["anon_telnyx_resources_select_denied", "NOT has_table_privilege('anon', 'public.telnyx_managed_resources', 'SELECT')"],
  ["anon_telnyx_resources_insert_denied", "NOT has_table_privilege('anon', 'public.telnyx_managed_resources', 'INSERT')"],
  ["anon_telnyx_resources_update_denied", "NOT has_table_privilege('anon', 'public.telnyx_managed_resources', 'UPDATE')"],
  ["anon_telnyx_resources_delete_denied", "NOT has_table_privilege('anon', 'public.telnyx_managed_resources', 'DELETE')"],
  ["authenticated_telnyx_resources_select_denied", "NOT has_table_privilege('authenticated', 'public.telnyx_managed_resources', 'SELECT')"],
  ["authenticated_telnyx_resources_insert_denied", "NOT has_table_privilege('authenticated', 'public.telnyx_managed_resources', 'INSERT')"],
  ["authenticated_telnyx_resources_update_denied", "NOT has_table_privilege('authenticated', 'public.telnyx_managed_resources', 'UPDATE')"],
  ["authenticated_telnyx_resources_delete_denied", "NOT has_table_privilege('authenticated', 'public.telnyx_managed_resources', 'DELETE')"],
]);

export const POST_RESET_PRIVILEGE_CHECK_NAMES = Object.freeze(
  POST_RESET_PRIVILEGE_EXPRESSIONS.map(([name]) => name)
);

const IS_MAIN =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_MAIN) {
  try {
    main();
  } catch (error) {
    process.exitCode = 1;
    console.error(`Local database tests refused: ${errorMessage(error)}`);
  }
}

function main() {
  assert.equal(
    process.argv.length,
    2,
    "This harness accepts no database URLs, project references, or other target arguments."
  );

  assertNoDockerEnvironmentOverrides(process.env);
  assertRepositoryConfiguration();
  const dockerEndpoint = verifyLocalDockerContext();
  assertPinnedCli(dockerEndpoint);
  ensureLocalStackStarted(dockerEndpoint);

  const inspection = inspectAndValidateDatabaseContainer(dockerEndpoint);
  assertDisposableDatabaseSignature(inspection.Id, dockerEndpoint);
  replayFreshLocalDatabase(dockerEndpoint);

  const resetInspection = inspectAndValidateDatabaseContainer(dockerEndpoint);
  assertDisposableDatabaseSignature(resetInspection.Id, dockerEndpoint);
  assertPostResetCatalog(resetInspection.Id, dockerEndpoint);
  const cleanlinessBaseline = readDatabaseCleanlinessSnapshot(
    resetInspection.Id,
    dockerEndpoint
  );

  console.log("Test: run pgTAP against the verified local stack");
  let testFailure = null;
  let cleanlinessFailure = null;
  try {
    runLocalCliStreaming(
      ["test", "db", DATABASE_TESTS, "--local"],
      { PGOPTIONS: "-c simplassist.disposable_test_database=on" },
      dockerEndpoint
    );
  } catch (error) {
    testFailure = toError(error);
  } finally {
    try {
      const finalInspection = inspectAndValidateDatabaseContainer(dockerEndpoint);
      assertDisposableDatabaseSignature(finalInspection.Id, dockerEndpoint);
      const finalSnapshot = readDatabaseCleanlinessSnapshot(
        finalInspection.Id,
        dockerEndpoint
      );
      assertDatabaseCleanliness(cleanlinessBaseline, finalSnapshot);
    } catch (error) {
      cleanlinessFailure = toError(error);
    }
  }

  const finalFailure = combineHarnessFailures(testFailure, cleanlinessFailure);
  if (finalFailure) throw finalFailure;
}

function replayFreshLocalDatabase(dockerEndpoint) {
  console.log("Reset: replay migrations against the verified local stack");
  const resetResult = runLocalCli(
    ["db", "reset", "--local"],
    { allowFailure: true },
    dockerEndpoint
  );
  writeCommandOutput(resetResult);
  if (didProcessSucceed(resetResult)) return;

  if (!isKnownPgCronBootstrapFailure(resetResult)) {
    throw commandFailure(
      "npx",
      pinnedCliArguments(["db", "reset", "--local"]),
      resetResult
    );
  }

  // db reset recreates the postgres database, so pg_cron cannot be installed
  // before it. Validate the newly recreated local database, install the one
  // known prerequisite there, and resume only the unapplied local migrations.
  const inspection = inspectAndValidateDatabaseContainer(dockerEndpoint);
  assertDisposableDatabaseSignature(inspection.Id, dockerEndpoint);
  assertPrePgCronBootstrapCatalog(inspection.Id, dockerEndpoint);
  console.warn(
    "Reset stopped at migration 009 because pg_cron was absent; applying the guarded local bootstrap and resuming migrations."
  );

  const defaultPrivilegeResult = runLocalPsql(
    inspection.Id,
    "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public " +
      "GRANT ALL ON TABLES TO anon, authenticated, service_role; " +
      "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public " +
      "GRANT ALL ON SEQUENCES TO anon, authenticated, service_role; " +
      "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public " +
      "GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role; " +
      "SELECT 'legacy_defaults_ready';",
    "postgres",
    dockerEndpoint
  );
  assert.equal(
    lastNonemptyLine(defaultPrivilegeResult.stdout),
    "legacy_defaults_ready",
    "Legacy local default privileges were not configured by their postgres owner"
  );

  const extensionResult = runLocalPsql(
    inspection.Id,
    "CREATE EXTENSION IF NOT EXISTS pg_cron; " +
      "SELECT CASE WHEN EXISTS (" +
      "SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'" +
      ") THEN 'pg_cron_ready' ELSE 'pg_cron_missing' END;",
    "supabase_admin",
    dockerEndpoint
  );
  assert.equal(
    lastNonemptyLine(extensionResult.stdout),
    "pg_cron_ready",
    "pg_cron was not installed in the disposable local database"
  );

  runLocalCliStreaming(["migration", "up", "--local"], {}, dockerEndpoint);
}

function assertRepositoryConfiguration() {
  const config = readFileSync(CONFIG_PATH, "utf8");
  assert.equal(
    readTopLevelTomlString(config, "project_id"),
    PROJECT_NAME,
    `Expected project_id = "${PROJECT_NAME}" in supabase/config.toml`
  );
  assert.equal(
    readTomlInteger(config, "api", "port"),
    API_HOST_PORT,
    `Expected the local API host port to be ${API_HOST_PORT}`
  );
  assert.equal(
    readTomlInteger(config, "db", "port"),
    Number(DATABASE_HOST_PORT),
    `Expected the local database host port to be ${DATABASE_HOST_PORT}`
  );
  assert.equal(
    readTomlInteger(config, "db", "major_version"),
    DATABASE_MAJOR_VERSION,
    `Expected local PostgreSQL major version ${DATABASE_MAJOR_VERSION}`
  );
  assert.equal(
    readTomlBoolean(config, "api", "auto_expose_new_tables"),
    true,
    "The transitional pgTAP lane requires api.auto_expose_new_tables = true"
  );
}

export function assertNoDockerEnvironmentOverrides(environment) {
  const overrides = DOCKER_TARGET_ENVIRONMENT_KEYS.filter((key) => {
    const value = environment?.[key];
    return typeof value === "string" ? value.trim() !== "" : value != null;
  });
  assert.deepEqual(
    overrides,
    [],
    `Refusing Docker target environment overrides: ${overrides.join(", ")}`
  );
}

function verifyLocalDockerContext() {
  const contextResult = runCommand("docker", ["context", "show"]);
  const contextName = parseDockerContextName(contextResult.stdout);
  const inspectionResult = runCommand("docker", [
    "context",
    "inspect",
    contextName,
  ]);
  const socketPath = dockerUnixSocketPathFromContextInspection(
    inspectionResult.stdout,
    contextName
  );
  return resolveRealLocalDockerEndpoint(socketPath);
}

export function parseDockerContextName(output) {
  assert.equal(typeof output, "string", "docker context show returned no output");
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.equal(lines.length, 1, "Expected exactly one active Docker context");
  return lines[0];
}

export function dockerUnixSocketPathFromContextInspection(
  output,
  expectedContextName
) {
  let inspections;
  try {
    inspections = JSON.parse(output);
  } catch {
    throw new Error("docker context inspect returned invalid JSON");
  }
  assert.equal(inspections.length, 1, "Expected exactly one Docker context");
  const inspection = inspections[0];
  assert.equal(
    inspection?.Name,
    expectedContextName,
    "Docker inspected a context other than the active context"
  );
  const endpoint = inspection?.Endpoints?.docker?.Host;
  assert.equal(typeof endpoint, "string", "Docker context has no engine endpoint");
  assert.match(
    endpoint,
    /^unix:\/\/\//,
    "Active Docker context is not backed by a local Unix socket"
  );
  assert(!/[?#]/.test(endpoint), "Docker Unix socket endpoint has query data");

  let socketPath;
  try {
    socketPath = decodeURIComponent(endpoint.slice("unix://".length));
  } catch {
    throw new Error("Docker Unix socket endpoint has invalid encoding");
  }
  assert(
    path.isAbsolute(socketPath),
    "Docker Unix socket endpoint is not an absolute path"
  );
  return socketPath;
}

export function resolveRealLocalDockerEndpoint(
  socketPath,
  filesystem = { realpathSync, statSync }
) {
  assert(path.isAbsolute(socketPath), "Docker socket path must be absolute");
  let resolvedPath;
  try {
    resolvedPath = filesystem.realpathSync(socketPath);
  } catch (error) {
    throw new Error(
      `Docker context socket does not resolve locally: ${errorMessage(error)}`
    );
  }

  let socketStat;
  try {
    socketStat = filesystem.statSync(resolvedPath);
  } catch (error) {
    throw new Error(
      `Docker context socket cannot be inspected locally: ${errorMessage(error)}`
    );
  }
  assert(
    socketStat.isSocket(),
    "Docker context endpoint does not resolve to a Unix socket"
  );
  return `unix://${resolvedPath}`;
}

function assertPinnedCli(dockerEndpoint) {
  const result = runLocalCli(["--version"], {}, dockerEndpoint);
  assert.equal(
    result.stdout.trim(),
    SUPABASE_CLI_VERSION,
    `Expected Supabase CLI ${SUPABASE_CLI_VERSION}`
  );
}

function ensureLocalStackStarted(dockerEndpoint) {
  const existing = inspectDatabaseContainer(dockerEndpoint, {
    allowMissing: true,
  });
  if (existing) {
    assertDatabaseContainerMetadata(existing, { requireRunning: false });
    if (existing.State?.Running) return;
  }

  console.log(`Start: pinned Supabase CLI ${SUPABASE_CLI_VERSION}`);
  const result = runLocalCli(
    ["start"],
    { allowFailure: true },
    dockerEndpoint
  );
  if (didProcessSucceed(result)) return;

  if (!isKnownPgCronBootstrapFailure(result)) {
    throw commandFailure("npx", pinnedCliArguments(["start"]), result);
  }

  inspectAndValidateDatabaseContainer(dockerEndpoint);
  console.warn(
    "Start stopped at migration 009 because pg_cron was not installed; continuing with the guarded local bootstrap."
  );
}

export function isKnownPgCronBootstrapFailure(result) {
  if (!didProcessFailNormally(result)) return false;
  const output = commandOutput(result);
  return (
    /Applying migration 009_processed_webhook_events\.sql/i.test(output) &&
    /schema\s+(?:\\?["'])?cron(?:\\?["'])?\s+does not exist/i.test(
      output
    ) &&
    /cron\.schedule/i.test(output)
  );
}

function inspectAndValidateDatabaseContainer(dockerEndpoint) {
  const inspection = inspectDatabaseContainer(dockerEndpoint);
  assertDatabaseContainerMetadata(inspection, { requireRunning: true });
  return inspection;
}

function assertDatabaseContainerMetadata(
  inspection,
  { requireRunning = true } = {}
) {
  const labeledWorkdir = inspection.Config?.Labels?.["com.supabase.cli.workdir"];
  assert.equal(typeof labeledWorkdir, "string", "Database container has no workdir label");
  let resolvedWorkdir;
  try {
    resolvedWorkdir = realpathSync(labeledWorkdir);
  } catch (error) {
    throw new Error(
      `Database container workdir does not resolve locally: ${errorMessage(error)}`
    );
  }
  assertDatabaseContainerInspection(inspection, {
    requireRunning,
    resolvedWorkdir,
  });
}

export function assertDatabaseContainerInspection(
  inspection,
  {
    requireRunning = true,
    resolvedWorkdir,
    expectedRepoRoot = REPO_ROOT,
  } = {}
) {
  assert.match(inspection?.Id ?? "", /^[a-f0-9]{64}$/i, "Invalid container ID");
  assert.equal(inspection.Name, `/${DATABASE_CONTAINER}`);
  assert.equal(
    typeof inspection.State?.Running,
    "boolean",
    "Database container has no running state"
  );
  if (requireRunning) {
    assert.equal(
      inspection.State.Running,
      true,
      "Local database container is not running"
    );
  }
  assert.equal(
    inspection.Config?.Labels?.["com.supabase.cli.project"],
    PROJECT_NAME,
    "Database container has the wrong Supabase project label"
  );
  assert.equal(
    inspection.Config?.Labels?.["com.docker.compose.project"],
    PROJECT_NAME,
    "Database container has the wrong Docker Compose project label"
  );
  const labeledWorkdir = inspection.Config?.Labels?.["com.supabase.cli.workdir"];
  assert.equal(typeof labeledWorkdir, "string", "Database container has no workdir label");
  assert.equal(
    resolvedWorkdir,
    expectedRepoRoot,
    "Database container was not created from this repository"
  );
  assert.match(
    inspection.Config?.Image ?? "",
    new RegExp(`^public\\.ecr\\.aws/supabase/postgres:${DATABASE_MAJOR_VERSION}\\.`),
    "Database container uses an unexpected image or PostgreSQL major version"
  );

  const publishedPorts = Object.entries(inspection.NetworkSettings?.Ports ?? {})
    .filter(([, bindings]) => Array.isArray(bindings) && bindings.length > 0);
  assert.deepEqual(
    publishedPorts.map(([containerPort]) => containerPort),
    [`${DATABASE_CONTAINER_PORT}/tcp`],
    "Database container publishes an unexpected port"
  );
  const bindings = publishedPorts[0]?.[1] ?? [];
  assert(bindings.length > 0, "Database container has no host port binding");
  for (const binding of bindings) {
    assert.equal(
      binding.HostPort,
      DATABASE_HOST_PORT,
      "Database container is mapped to the wrong host port"
    );
    assert(
      ["0.0.0.0", "::", "127.0.0.1", "::1"].includes(binding.HostIp),
      `Database container has an unexpected bind address ${String(binding.HostIp)}`
    );
  }

}

export function databaseContainerInspectArguments(dockerEndpoint) {
  // A stopped stack preserves a volume with this exact name. Unqualified
  // `docker inspect` resolves that volume and hides the missing container.
  return ["--host", dockerEndpoint, "inspect", "--type", "container", DATABASE_CONTAINER];
}

function inspectDatabaseContainer(
  dockerEndpoint,
  { allowMissing = false } = {}
) {
  const dockerArguments = databaseContainerInspectArguments(dockerEndpoint);
  const result = runCommand("docker", dockerArguments, {
    allowFailure: allowMissing,
    dockerEndpoint,
  });
  if (!didProcessSucceed(result)) {
    const detail = commandOutput(result);
    if (
      allowMissing &&
      didProcessFailNormally(result) &&
      /no such (object|container)/i.test(detail)
    ) {
      return null;
    }
    throw commandFailure("docker", dockerArguments, result);
  }

  let inspections;
  try {
    inspections = JSON.parse(result.stdout);
  } catch {
    throw new Error("docker inspect returned invalid JSON");
  }
  assert.equal(inspections.length, 1, "Expected exactly one local database container");
  return inspections[0];
}

function assertDisposableDatabaseSignature(containerId, dockerEndpoint) {
  const sql = `
SELECT CASE WHEN
  current_database() = 'postgres'
  AND current_user = 'supabase_admin'
  AND current_setting('port') = '${DATABASE_CONTAINER_PORT}'
  AND current_setting('data_directory') = '/var/lib/postgresql/data'
  AND current_setting('app.settings.jwt_secret', true) = '${LOCAL_JWT_SENTINEL}'
  AND current_setting('server_version_num')::integer / 10000 = ${DATABASE_MAJOR_VERSION}
  AND NOT pg_is_in_recovery()
THEN 'disposable_local_database'
ELSE 'refuse'
END;
`;
  const result = runLocalPsql(
    containerId,
    sql,
    "supabase_admin",
    dockerEndpoint
  );
  assert.equal(
    lastNonemptyLine(result.stdout),
    "disposable_local_database",
    "Database catalog does not match the disposable SimplAssist local stack"
  );
}

function assertPrePgCronBootstrapCatalog(containerId, dockerEndpoint) {
  const sql = `
SELECT jsonb_build_object(
  'migrationVersions', COALESCE(
    (
      SELECT jsonb_agg(version ORDER BY version)
      FROM supabase_migrations.schema_migrations
    ),
    '[]'::jsonb
  ),
  'pgCronInstalled', EXISTS (
    SELECT 1
    FROM pg_extension
    WHERE extname = 'pg_cron'
  ),
  'cronJobRelationPresent', to_regclass('cron.job') IS NOT NULL,
  'processedWebhookEventsPresent',
    to_regclass('public.processed_webhook_events') IS NOT NULL
)::text;
`;
  const result = runLocalPsql(
    containerId,
    sql,
    "supabase_admin",
    dockerEndpoint
  );
  const state = parseJsonCommandResult(result, "Pre-bootstrap catalog inspection");
  let cleanupJobCount = 0;
  if (state.cronJobRelationPresent) {
    const jobResult = runLocalPsql(
      containerId,
      `SELECT count(*)::integer
       FROM cron.job
       WHERE jobname = 'cleanup_processed_webhook_events';`,
      "supabase_admin",
      dockerEndpoint
    );
    cleanupJobCount = parseNonnegativeInteger(
      lastNonemptyLine(jobResult.stdout),
      "pre-bootstrap cleanup job count"
    );
  }
  assertPrePgCronBootstrapState({ ...state, cleanupJobCount });
}

export function assertPrePgCronBootstrapState(state) {
  assert(Array.isArray(state?.migrationVersions), "Missing migration versions");
  assert(
    !state.migrationVersions.includes("009"),
    "Migration 009 must be absent before the pg_cron bootstrap"
  );
  assert.deepEqual(
    state.migrationVersions,
    PRE_PG_CRON_MIGRATION_VERSIONS,
    "Fresh reset did not stop with exactly migrations 001-008 applied"
  );
  assert.equal(
    state.pgCronInstalled,
    false,
    "pg_cron was already installed at the expected migration 009 stop"
  );
  assert.equal(
    state.cronJobRelationPresent,
    false,
    "cron.job already exists at the expected migration 009 stop"
  );
  assert.equal(
    state.processedWebhookEventsPresent,
    false,
    "Migration 009 left processed_webhook_events behind instead of rolling back"
  );
  assert.equal(
    state.cleanupJobCount,
    0,
    "The cleanup cron job already exists before migration 009 is resumed"
  );
}

function assertPostResetCatalog(containerId, dockerEndpoint) {
  const privilegeJson = POST_RESET_PRIVILEGE_EXPRESSIONS.map(
    ([name, expression]) => `'${name}', (${expression})`
  ).join(",\n    ");
  const sql = `
SELECT jsonb_build_object(
  'migrationVersions', COALESCE(
    (
      SELECT jsonb_agg(version ORDER BY version)
      FROM supabase_migrations.schema_migrations
    ),
    '[]'::jsonb
  ),
  'pgCronExtensions', COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'owner', pg_get_userbyid(extension.extowner),
          'schema', namespace.nspname
        )
      )
      FROM pg_extension AS extension
      JOIN pg_namespace AS namespace
        ON namespace.oid = extension.extnamespace
      WHERE extension.extname = 'pg_cron'
    ),
    '[]'::jsonb
  ),
  'cleanupJobs', COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'active', active,
          'database', database,
          'schedule', schedule
        )
        ORDER BY jobid
      )
      FROM cron.job
      WHERE jobname = 'cleanup_processed_webhook_events'
    ),
    '[]'::jsonb
  ),
  'privileges', jsonb_build_object(
    ${privilegeJson}
  )
)::text;
`;
  const result = runLocalPsql(
    containerId,
    sql,
    "supabase_admin",
    dockerEndpoint
  );
  assertPostResetCatalogState(
    parseJsonCommandResult(result, "Post-reset catalog inspection"),
    expectedMigrationVersions()
  );
}

export function assertPostResetCatalogState(state, expectedVersions) {
  assert.deepEqual(
    state?.migrationVersions,
    expectedVersions,
    "Post-reset migration versions do not exactly match repository migrations"
  );
  assert.deepEqual(
    state?.pgCronExtensions,
    [{ owner: "supabase_admin", schema: "pg_catalog" }],
    "pg_cron must have the expected owner and schema"
  );
  assert.deepEqual(
    state?.cleanupJobs,
    [{ active: true, database: "postgres", schedule: "0 3 * * *" }],
    "Expected exactly one active processed-webhook cleanup job"
  );
  assertPlainObject(state?.privileges, "post-reset privilege results");
  for (const name of POST_RESET_PRIVILEGE_CHECK_NAMES) {
    assert.equal(
      state.privileges[name],
      true,
      `Post-reset privilege assertion failed: ${name}`
    );
  }
}

function expectedMigrationVersions() {
  const versions = readdirSync(MIGRATIONS_DIR)
    .map((name) => /^(\d{3})_[a-z0-9_]+\.sql$/.exec(name)?.[1])
    .filter(Boolean)
    .sort();
  assert(versions.length > 0, "No numbered Supabase migrations were found");
  assert.equal(
    new Set(versions).size,
    versions.length,
    "Supabase migration versions must be unique"
  );
  return versions;
}

function readDatabaseCleanlinessSnapshot(containerId, dockerEndpoint) {
  // pgTAP and dblink sessions can commit fixture rows independently from the
  // outer test transaction. Hash durable table contents in the application
  // schemas; sequence counters and extension-owned/internal schemas are
  // intentionally outside this fixture-cleanliness contract.
  const sql = `
CREATE TEMP TABLE simplassist_cleanliness_snapshot (
  schema_name text NOT NULL,
  table_name text NOT NULL,
  row_count bigint NOT NULL,
  content_hash text NOT NULL
);

DO $snapshot$
DECLARE
  table_record record;
  row_json_expression text;
BEGIN
  FOR table_record IN
    SELECT namespace.nspname AS schema_name, class.relname AS table_name
    FROM pg_class AS class
    JOIN pg_namespace AS namespace
      ON namespace.oid = class.relnamespace
    WHERE namespace.nspname IN ('auth', 'public', 'storage')
      AND class.relkind IN ('r', 'p')
      AND class.relpersistence = 'p'
      AND NOT class.relispartition
    ORDER BY namespace.nspname, class.relname
  LOOP
    row_json_expression := 'to_jsonb(row_value)';
    IF table_record.schema_name = 'public'
       AND table_record.table_name = 'telnyx_resource_release_config' THEN
      -- The guard deliberately advances these audit fields even when a
      -- concurrency fixture restores every operational value.
      row_json_expression :=
        '(to_jsonb(row_value) - ARRAY[''authorization_epoch'', ''updated_at''])';
    END IF;

    EXECUTE format(
      $query$
        INSERT INTO pg_temp.simplassist_cleanliness_snapshot (
          schema_name,
          table_name,
          row_count,
          content_hash
        )
        SELECT
          %L,
          %L,
          count(*)::bigint,
          md5(
            COALESCE(
              string_agg(
                normalized_row::text,
                E'\\n'
                ORDER BY normalized_row::text
              ),
              ''
            )
          )
        FROM (
          SELECT %s AS normalized_row
          FROM %I.%I AS row_value
        ) AS normalized_rows
      $query$,
      table_record.schema_name,
      table_record.table_name,
      row_json_expression,
      table_record.schema_name,
      table_record.table_name
    );
  END LOOP;
END;
$snapshot$;

SELECT COALESCE(
  jsonb_object_agg(
    schema_name || '.' || table_name,
    jsonb_build_object(
      'contentHash', content_hash,
      'rowCount', row_count
    )
    ORDER BY schema_name, table_name
  ),
  '{}'::jsonb
)::text
FROM pg_temp.simplassist_cleanliness_snapshot;
`;
  const result = runLocalPsql(
    containerId,
    sql,
    "supabase_admin",
    dockerEndpoint
  );
  const snapshot = parseJsonCommandResult(
    result,
    "Database cleanliness snapshot"
  );
  assertCleanlinessSnapshotShape(snapshot);
  return snapshot;
}

function assertCleanlinessSnapshotShape(snapshot) {
  assertPlainObject(snapshot, "database cleanliness snapshot");
  for (const [table, value] of Object.entries(snapshot)) {
    assert.match(
      table,
      /^(auth|public|storage)\.[a-zA-Z0-9_]+$/,
      "Cleanliness snapshot contains an unexpected table name"
    );
    assertPlainObject(value, `cleanliness state for ${table}`);
    assert(
      Number.isSafeInteger(value.rowCount) && value.rowCount >= 0,
      `Cleanliness snapshot has an invalid row count for ${table}`
    );
    assert.match(
      value.contentHash ?? "",
      /^[a-f0-9]{32}$/,
      `Cleanliness snapshot has an invalid content hash for ${table}`
    );
  }
}

export function databaseCleanlinessDifferences(before, after) {
  assertCleanlinessSnapshotShape(before);
  assertCleanlinessSnapshotShape(after);
  const tables = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort();
  return tables.filter((table) => {
    const baseline = before[table];
    const final = after[table];
    return (
      baseline?.rowCount !== final?.rowCount ||
      baseline?.contentHash !== final?.contentHash
    );
  });
}

export function assertDatabaseCleanliness(before, after) {
  const differences = databaseCleanlinessDifferences(before, after);
  assert.equal(
    differences.length,
    0,
    `pgTAP left durable database changes in: ${differences.join(", ")}`
  );
}

export function combineHarnessFailures(testFailure, cleanlinessFailure) {
  if (testFailure && cleanlinessFailure) {
    return new AggregateError(
      [testFailure, cleanlinessFailure],
      `pgTAP failed (${errorMessage(testFailure)}); post-test cleanliness verification also failed (${errorMessage(cleanlinessFailure)})`
    );
  }
  return testFailure ?? cleanlinessFailure ?? null;
}

function runLocalPsql(
  containerId,
  sql,
  databaseUser = "supabase_admin",
  dockerEndpoint
) {
  assert.match(containerId, /^[a-f0-9]{64}$/i, "Invalid Docker container ID");
  assertTrustedDockerEndpoint(dockerEndpoint);
  assert(
    databaseUser === "postgres" || databaseUser === "supabase_admin",
    "Unexpected local database bootstrap role"
  );
  return runCommand(
    "docker",
    [
      "--host",
      dockerEndpoint,
      "exec",
      "--env",
      "PGPASSWORD=postgres",
      containerId,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      databaseUser,
      "-d",
      "postgres",
      "-Atqc",
      sql,
    ],
    { dockerEndpoint }
  );
}

function runLocalCli(args, options = {}, dockerEndpoint) {
  assertSafeLocalCliArguments(args);
  return runCommand("npx", pinnedCliArguments(args), {
    ...options,
    dockerEndpoint,
  });
}

function runLocalCliStreaming(args, extraEnvironment = {}, dockerEndpoint) {
  assertSafeLocalCliArguments(args);
  assertTrustedDockerEndpoint(dockerEndpoint);
  const commandArgs = pinnedCliArguments(args);
  const result = spawnSync("npx", commandArgs, {
    cwd: REPO_ROOT,
    env: localOnlyEnvironment(extraEnvironment, process.env, dockerEndpoint),
    shell: false,
    stdio: "inherit",
  });
  if (!didProcessSucceed(result)) {
    throw commandFailure("npx", commandArgs, result);
  }
}

export function assertSafeLocalCliArguments(args) {
  const matches = (expected) =>
    args.length === expected.length &&
    args.every((argument, index) => argument === expected[index]);
  const approvedInvocation =
    matches(["--version"]) ||
    matches(["start"]) ||
    matches(["db", "reset", "--local"]) ||
    matches(["migration", "up", "--local"]) ||
    matches(["test", "db", DATABASE_TESTS, "--local"]);
  assert(
    approvedInvocation,
    `Refusing unapproved Supabase CLI arguments: ${args.join(" ")}`
  );
}

function pinnedCliArguments(args) {
  return ["--yes", `supabase@${SUPABASE_CLI_VERSION}`, ...args];
}

function runCommand(
  command,
  args,
  { allowFailure = false, dockerEndpoint } = {}
) {
  if (dockerEndpoint !== undefined) {
    assertTrustedDockerEndpoint(dockerEndpoint);
  }
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: localOnlyEnvironment({}, process.env, dockerEndpoint),
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
  });
  if (!didProcessSucceed(result) && !allowFailure) {
    throw commandFailure(command, args, result);
  }
  return result;
}

export function localOnlyEnvironment(
  extraEnvironment = {},
  baseEnvironment = process.env,
  dockerEndpoint
) {
  const environment = { ...baseEnvironment, ...extraEnvironment };
  for (const key of [
    ...REMOTE_ENVIRONMENT_KEYS,
    ...DOCKER_TARGET_ENVIRONMENT_KEYS,
  ]) {
    delete environment[key];
  }
  if (dockerEndpoint !== undefined) {
    assertTrustedDockerEndpoint(dockerEndpoint);
    environment.DOCKER_HOST = dockerEndpoint;
  }
  environment.SUPABASE_TELEMETRY_DISABLED = "1";
  return environment;
}

function assertTrustedDockerEndpoint(dockerEndpoint) {
  assert.equal(
    typeof dockerEndpoint,
    "string",
    "A verified Docker endpoint is required"
  );
  assert.match(
    dockerEndpoint,
    /^unix:\/\/\/.+/,
    "Docker endpoint is not a verified Unix socket"
  );
}

export function didProcessSucceed(result) {
  return result?.status === 0 && !result.error && !result.signal;
}

export function didProcessFailNormally(result) {
  return (
    Number.isInteger(result?.status) &&
    result.status > 0 &&
    !result.error &&
    !result.signal
  );
}

function commandOutput(result) {
  return [result?.stdout, result?.stderr]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join("\n");
}

function readTopLevelTomlString(config, key) {
  const topLevel = config.split(/^\s*\[/m, 1)[0];
  return readSingleTomlValue(topLevel, key, /^"([^"]+)"$/, "string");
}

function readTomlInteger(config, section, key) {
  return Number(
    readSingleTomlValue(tomlSection(config, section), key, /^(\d+)$/, "integer")
  );
}

function readTomlBoolean(config, section, key) {
  return readSingleTomlValue(
    tomlSection(config, section),
    key,
    /^(true|false)$/,
    "boolean"
  ) === "true";
}

function tomlSection(config, section) {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const normalized = config.replace(/\r\n/g, "\n");
  const header = new RegExp(`^\\s*\\[${escaped}\\]\\s*$`, "m").exec(normalized);
  assert(header, `Missing [${section}] in supabase/config.toml`);
  const sectionStart = header.index + header[0].length;
  const remainder = normalized.slice(sectionStart);
  const nextHeader = remainder.search(/^\s*\[/m);
  return nextHeader === -1 ? remainder : remainder.slice(0, nextHeader);
}

function readSingleTomlValue(source, key, valuePattern, type) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [
    ...source.matchAll(
      new RegExp(`^\\s*${escaped}\\s*=\\s*([^#\\n]+?)\\s*$`, "gm")
    ),
  ];
  assert.equal(matches.length, 1, `Expected one active ${key} assignment`);
  const parsed = valuePattern.exec(matches[0][1].trim());
  assert(parsed, `Expected ${key} to be a TOML ${type}`);
  return parsed[1];
}

function lastNonemptyLine(value) {
  assert.equal(typeof value, "string", "Command returned no text output");
  return value.trim().split("\n").at(-1)?.trim();
}

function writeCommandOutput(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

export function commandFailure(command, args, result) {
  const termination = result?.error
    ? `spawn error: ${errorMessage(result.error)}`
    : result?.signal
      ? `terminated by signal ${result.signal}`
      : `exit status ${String(result?.status)}`;
  const output = commandOutput(result).trim();
  const detail = output ? `${termination}\n${output}` : termination;
  return new Error(
    `${command} ${args.slice(0, 6).join(" ")} failed: ${detail}`
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function parseJsonCommandResult(result, label) {
  const output = lastNonemptyLine(result.stdout);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function parseNonnegativeInteger(value, label) {
  assert.match(value ?? "", /^\d+$/, `${label} was not a nonnegative integer`);
  const parsed = Number(value);
  assert(Number.isSafeInteger(parsed), `${label} exceeded the safe integer range`);
  return parsed;
}

function assertPlainObject(value, label) {
  assert(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
    `Expected ${label} to be an object`
  );
}
