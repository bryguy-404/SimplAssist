// Apply the feature schema layers inside a rollback-only transaction.
// Never reset or migrate the developer database, and never connect to hosted DBs.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const withAlerts = process.argv.includes("--with-account-alerts");
const migrations = ["20261122071820_inbox_bulk_deletion.sql", ...(withAlerts ? ["20261122080319_account_signup_alerts.sql"] : []), "20261122081018_call_screening_and_spam_inbox.sql"];
const suites = ["inbox_bulk_deletion.test.sql", ...(withAlerts ? ["account_signup_alerts.test.sql"] : []), "call_screening.test.sql"];
const stripTransaction = s => s.trim().replace(/^BEGIN;/, "").replace(/(?:COMMIT|ROLLBACK);$/, "");
const schema = migrations.map(name => stripTransaction(readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8"))).join("\n");
for (const name of suites) {
  const tests = stripTransaction(readFileSync(new URL(`../supabase/tests/database/${name}`, import.meta.url), "utf8"));
  const result = spawnSync("/usr/local/bin/docker", ["exec", "-i", "supabase_db_SimplAssist", "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-X", "-q", "-A", "-t"], { input: `BEGIN;\n${schema}\n${tests}\nROLLBACK;\n`, encoding: "utf8" });
  process.stdout.write(`${name}\n${result.stdout}`);
  process.stderr.write(result.stderr);
  if (result.status !== 0 || /(?:^|\n)not ok\b/.test(result.stdout)) process.exit(1);
}
