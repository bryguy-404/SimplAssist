import { describe, expect, it } from "vitest";
import {
  POST_RESET_PRIVILEGE_CHECK_NAMES,
  assertDatabaseCleanliness,
  assertDatabaseContainerInspection,
  assertNoDockerEnvironmentOverrides,
  assertPostResetCatalogState,
  assertPrePgCronBootstrapState,
  assertSafeLocalCliArguments,
  combineHarnessFailures,
  commandFailure,
  databaseCleanlinessDifferences,
  databaseContainerInspectArguments,
  didProcessFailNormally,
  didProcessSucceed,
  dockerUnixSocketPathFromContextInspection,
  isKnownPgCronBootstrapFailure,
  localOnlyEnvironment,
  parseDockerContextName,
  resolveRealLocalDockerEndpoint,
} from "./test-database-local.mjs";

const VERIFIED_DOCKER_ENDPOINT = "unix:///private/docker.sock";

describe("local database harness target isolation", () => {
  it("inspects only containers when the stopped stack retains a same-named backup volume", () => {
    expect(databaseContainerInspectArguments(VERIFIED_DOCKER_ENDPOINT)).toEqual([
      "--host", VERIFIED_DOCKER_ENDPOINT, "inspect", "--type", "container", "supabase_db_SimplAssist",
    ]);
  });

  it("accepts only explicitly local database commands and local-only startup", () => {
    expect(() => assertSafeLocalCliArguments(["--version"])).not.toThrow();
    expect(() => assertSafeLocalCliArguments(["start"])).not.toThrow();
    expect(() =>
      assertSafeLocalCliArguments(["db", "reset", "--local"])
    ).not.toThrow();
    expect(() =>
      assertSafeLocalCliArguments(["migration", "up", "--local"])
    ).not.toThrow();
    expect(() =>
      assertSafeLocalCliArguments([
        "test",
        "db",
        "supabase/tests/database",
        "--local",
      ])
    ).not.toThrow();
  });

  it("rejects unscoped and explicitly remote Supabase commands", () => {
    expect(() => assertSafeLocalCliArguments(["db", "reset"])).toThrow();
    expect(() =>
      assertSafeLocalCliArguments(["db", "push", "--local"])
    ).toThrow();
    expect(() =>
      assertSafeLocalCliArguments(["db", "reset", "--linked", "--local"])
    ).toThrow();
    expect(() =>
      assertSafeLocalCliArguments([
        "db",
        "reset",
        "--db-url",
        "postgresql://remote.example/database",
        "--local",
      ])
    ).toThrow();
    expect(() =>
      assertSafeLocalCliArguments([
        "test",
        "db",
        "--project-ref",
        "remote-project",
        "--local",
      ])
    ).toThrow();
    expect(() =>
      assertSafeLocalCliArguments([
        "db",
        "reset",
        "--db-url=postgresql://remote.example/database",
        "--local",
      ])
    ).toThrow();
  });

  it("rejects caller-selected Docker targets", () => {
    expect(() =>
      assertNoDockerEnvironmentOverrides({ PATH: "/bin" })
    ).not.toThrow();
    expect(() =>
      assertNoDockerEnvironmentOverrides({ DOCKER_HOST: "" })
    ).not.toThrow();
    expect(() =>
      assertNoDockerEnvironmentOverrides({
        DOCKER_HOST: "ssh://remote.example",
      })
    ).toThrow(/DOCKER_HOST/);
    expect(() =>
      assertNoDockerEnvironmentOverrides({ DOCKER_CONTEXT: "remote" })
    ).toThrow(/DOCKER_CONTEXT/);
    expect(() =>
      assertNoDockerEnvironmentOverrides({
        DOCKER_CONFIG: "/tmp/remote-config",
      })
    ).toThrow(/DOCKER_CONFIG/);
  });

  it("strips remote credentials and pins only the verified Docker endpoint", () => {
    const environment = localOnlyEnvironment(
      {
        DOCKER_HOST: "tcp://attacker.example:2375",
        PGOPTIONS: "-c simplassist.disposable_test_database=on",
      },
      {
        PATH: "/usr/bin",
        DATABASE_URL: "postgresql://remote.example/database",
        DOCKER_CONTEXT: "remote",
        PGHOST: "remote.example",
        SUPABASE_ACCESS_TOKEN: "remote-token",
        SUPABASE_PROJECT_REF: "remote-project",
      },
      VERIFIED_DOCKER_ENDPOINT
    );

    expect(environment).toEqual({
      PATH: "/usr/bin",
      DOCKER_HOST: VERIFIED_DOCKER_ENDPOINT,
      PGOPTIONS: "-c simplassist.disposable_test_database=on",
      SUPABASE_TELEMETRY_DISABLED: "1",
    });
  });

  it("accepts only a single active context backed by an absolute Unix socket", () => {
    expect(parseDockerContextName("desktop-linux\n")).toBe("desktop-linux");
    expect(() => parseDockerContextName("one\ntwo\n")).toThrow();

    const inspection = JSON.stringify([
      {
        Name: "desktop-linux",
        Endpoints: {
          docker: { Host: "unix:///Users/test/.docker/run/docker.sock" },
        },
      },
    ]);
    expect(
      dockerUnixSocketPathFromContextInspection(inspection, "desktop-linux")
    ).toBe("/Users/test/.docker/run/docker.sock");

    const remoteInspection = JSON.stringify([
      {
        Name: "remote",
        Endpoints: { docker: { Host: "ssh://remote.example" } },
      },
    ]);
    expect(() =>
      dockerUnixSocketPathFromContextInspection(remoteInspection, "remote")
    ).toThrow(/local Unix socket/);
  });

  it("canonicalizes the context path only when it is a real Unix socket", () => {
    const filesystem = {
      realpathSync: () => "/private/var/run/docker.sock",
      statSync: () => ({ isSocket: () => true }),
    };
    expect(
      resolveRealLocalDockerEndpoint("/var/run/docker.sock", filesystem)
    ).toBe("unix:///private/var/run/docker.sock");

    expect(() =>
      resolveRealLocalDockerEndpoint("/tmp/not-a-socket", {
        realpathSync: (value) => value,
        statSync: () => ({ isSocket: () => false }),
      })
    ).toThrow(/Unix socket/);
  });

  it("validates a stopped matching container before start but requires running later", () => {
    const inspection = databaseContainerInspection(false);
    const options = {
      expectedRepoRoot: "/repo/SimplAssist",
      resolvedWorkdir: "/repo/SimplAssist",
    };
    expect(() =>
      assertDatabaseContainerInspection(inspection, {
        ...options,
        requireRunning: false,
      })
    ).not.toThrow();
    expect(() =>
      assertDatabaseContainerInspection(inspection, {
        ...options,
        requireRunning: true,
      })
    ).toThrow(/not running/);

    inspection.Config.Labels["com.supabase.cli.project"] = "OtherProject";
    expect(() =>
      assertDatabaseContainerInspection(inspection, {
        ...options,
        requireRunning: false,
      })
    ).toThrow(/wrong Supabase project/);
  });
});

describe("pg_cron bootstrap fail-closed behavior", () => {
  const expectedFailure = {
    status: 1,
    signal: null,
    stdout: "Applying migration 009_processed_webhook_events.sql...",
    stderr:
      'ERROR: schema "cron" does not exist (SQLSTATE 3F000)\nSELECT cron.schedule(...)',
  };

  it("distinguishes success, normal failure, and abnormal termination", () => {
    expect(didProcessSucceed({ status: 0, signal: null })).toBe(true);
    expect(didProcessFailNormally(expectedFailure)).toBe(true);
    expect(isKnownPgCronBootstrapFailure(expectedFailure)).toBe(true);
    expect(
      isKnownPgCronBootstrapFailure({
        ...expectedFailure,
        stderr:
          'LegacyMigrationApplyError: ERROR: schema \\"cron\\" does not exist (SQLSTATE 3F000)\\nSELECT cron.schedule(...)',
      })
    ).toBe(true);

    expect(
      isKnownPgCronBootstrapFailure({ ...expectedFailure, status: 0 })
    ).toBe(false);
    expect(
      isKnownPgCronBootstrapFailure({
        ...expectedFailure,
        status: null,
        signal: "SIGTERM",
      })
    ).toBe(false);
    expect(
      isKnownPgCronBootstrapFailure({
        ...expectedFailure,
        status: null,
        error: new Error("ENOBUFS"),
      })
    ).toBe(false);
    expect(
      isKnownPgCronBootstrapFailure({
        ...expectedFailure,
        stderr: "ERROR: migration 010 failed",
      })
    ).toBe(false);

    const spawnError = commandFailure("npx", ["supabase"], {
      error: new Error("ENOBUFS"),
      status: null,
      stdout: "partial output",
    });
    expect(spawnError.message).toMatch(/spawn error: ENOBUFS/);
    expect(spawnError.message).toMatch(/partial output/);
  });

  it("requires the exact pre-009 catalog state before bootstrap", () => {
    const state = {
      cleanupJobCount: 0,
      cronJobRelationPresent: false,
      migrationVersions: [
        "001",
        "002",
        "003",
        "004",
        "005",
        "006",
        "007",
        "008",
      ],
      pgCronInstalled: false,
      processedWebhookEventsPresent: false,
    };
    expect(() => assertPrePgCronBootstrapState(state)).not.toThrow();
    expect(() =>
      assertPrePgCronBootstrapState({
        ...state,
        migrationVersions: [...state.migrationVersions, "009"],
      })
    ).toThrow(/009 must be absent/);
    expect(() =>
      assertPrePgCronBootstrapState({ ...state, pgCronInstalled: true })
    ).toThrow(/already installed/);
    expect(() =>
      assertPrePgCronBootstrapState({
        ...state,
        cronJobRelationPresent: true,
      })
    ).toThrow(/cron\.job already exists/);
    expect(() =>
      assertPrePgCronBootstrapState({ ...state, cleanupJobCount: 1 })
    ).toThrow(/already exists/);
  });

  it("reports the exact post-reset catalog assertion that failed", () => {
    const state = validPostResetCatalogState();
    expect(() =>
      assertPostResetCatalogState(state, ["001", "056"])
    ).not.toThrow();

    state.privileges.authenticated_subscriptions_insert_denied = false;
    expect(() =>
      assertPostResetCatalogState(state, ["001", "056"])
    ).toThrow(/authenticated_subscriptions_insert_denied/);
  });
});

describe("post-pgTAP cleanliness", () => {
  const baseline = {
    "auth.users": {
      contentHash: "d41d8cd98f00b204e9800998ecf8427e",
      rowCount: 0,
    },
    "public.businesses": {
      contentHash: "d41d8cd98f00b204e9800998ecf8427e",
      rowCount: 0,
    },
  };

  it("detects durable row or relation differences", () => {
    expect(
      databaseCleanlinessDifferences(baseline, structuredClone(baseline))
    ).toEqual([]);
    const dirty = structuredClone(baseline);
    dirty["public.businesses"] = {
      contentHash: "c4ca4238a0b923820dcc509a6f75849b",
      rowCount: 1,
    };
    expect(databaseCleanlinessDifferences(baseline, dirty)).toEqual([
      "public.businesses",
    ]);
    expect(() => assertDatabaseCleanliness(baseline, dirty)).toThrow(
      /public\.businesses/
    );
  });

  it("preserves the pgTAP failure while appending cleanliness failure", () => {
    const testFailure = new Error("pgTAP assertion failed");
    const cleanlinessFailure = new Error("fixture leaked");
    expect(combineHarnessFailures(testFailure, null)).toBe(testFailure);
    expect(combineHarnessFailures(null, cleanlinessFailure)).toBe(
      cleanlinessFailure
    );
    const combined = combineHarnessFailures(testFailure, cleanlinessFailure);
    expect(combined).toBeInstanceOf(AggregateError);
    expect(combined.message).toMatch(/pgTAP assertion failed/);
    expect(combined.message).toMatch(/fixture leaked/);
  });
});

function databaseContainerInspection(running) {
  return {
    Id: "a".repeat(64),
    Name: "/supabase_db_SimplAssist",
    State: { Running: running },
    Config: {
      Image: "public.ecr.aws/supabase/postgres:17.6.1.079",
      Labels: {
        "com.docker.compose.project": "SimplAssist",
        "com.supabase.cli.project": "SimplAssist",
        "com.supabase.cli.workdir": "/repo/SimplAssist",
      },
    },
    NetworkSettings: {
      Ports: {
        "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "54322" }],
      },
    },
  };
}

function validPostResetCatalogState() {
  return {
    cleanupJobs: [
      { active: true, database: "postgres", schedule: "0 3 * * *" },
    ],
    migrationVersions: ["001", "056"],
    pgCronExtensions: [{ owner: "supabase_admin", schema: "pg_catalog" }],
    privileges: Object.fromEntries(
      POST_RESET_PRIVILEGE_CHECK_NAMES.map((name) => [name, true])
    ),
  };
}
