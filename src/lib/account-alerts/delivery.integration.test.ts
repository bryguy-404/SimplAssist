import { createHmac, randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// Opt-in test against the disposable DB documented in docs/account-signup-alerts.md.
const restUrl = process.env.ACCOUNT_ALERTS_TEST_REST_URL;
const suite = restUrl ? describe : describe.skip;
suite("real outbox to Resend HTTP delivery", () => {
  let server: Server;
  let run: typeof import("./runner.server").runAccountSignupAlerts;
  let db: typeof import("@/lib/supabase/admin").supabaseAdmin;
  const owner = randomUUID();
  const requests: { key: string; message: Record<string, unknown> }[] = [];
  const delivered = new Map<string, string>();
  let loseFirstReply = true;
  function sql(query: string) {
    return execFileSync("docker", ["exec", "-e", "PGPASSWORD=postgres", "supabase_db_SimplAssist", "psql", "-w", "-X", "-U", "supabase_admin", "-d", "simplassist_account_alerts_verify", "-v", "ON_ERROR_STOP=1", "-Atc", query], { encoding: "utf8" });
  }
  beforeAll(async () => {
    if (restUrl !== "http://127.0.0.1:56431") throw new Error("Refusing a nonlocal test database");
    const secret = "super-secret-jwt-token-with-at-least-32-characters-long";
    const body = [Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({ role: "service_role", iss: "supabase", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")].join(".");
    const token = body + "." + createHmac("sha256", secret).update(body).digest("base64url");
    server = createServer(async (req, res) => {
      let raw = ""; for await (const chunk of req) raw += chunk;
      if (req.url === "/emails" && req.method === "POST") {
        const key = String(req.headers["idempotency-key"]);
        const message = JSON.parse(raw);
        requests.push({ key, message });
        if (!delivered.has(key)) delivered.set(key, randomUUID());
        if (loseFirstReply) { loseFirstReply = false; res.destroy(); return; }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id: delivered.get(key) })); return;
      }
      if (!req.url?.startsWith("/rest/v1/")) { res.writeHead(404).end(); return; }
      try {
        const upstream = await fetch(restUrl + req.url.slice("/rest/v1".length), {
          method: req.method, headers: {
            authorization: req.headers.authorization ?? "", "content-type": "application/json",
            ...(req.headers.accept ? { accept: req.headers.accept } : {}),
            ...(req.headers.prefer ? { prefer: [req.headers.prefer].flat().join(", ") } : {}),
          }, body: ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : raw,
        });
        res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch { res.writeHead(502).end(); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", origin); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", token);
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
    vi.stubEnv("RESEND_BASE_URL", origin); vi.stubEnv("RESEND_API_KEY", "re_local_fake_transport");
    vi.stubEnv("RESEND_FROM_EMAIL", "SimplAssist <notifications@simplassist.com>");
    vi.stubEnv("ACCOUNT_SIGNUP_ALERTS_ENABLED", "true");
    vi.resetModules();
    run = (await import("./runner.server")).runAccountSignupAlerts;
    db = (await import("@/lib/supabase/admin")).supabaseAdmin;
    sql(`INSERT INTO auth.users(id,email,created_at,raw_user_meta_data) VALUES ('${owner}','delivery-fixture@example.test',now(),'{"full_name":"Delivery Fixture"}');`);
  });
  afterAll(async () => {
    sql(`DELETE FROM auth.users WHERE id='${owner}';`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
  });
  it("captures confirmation, recovers a lost provider response, then sends setup once", async () => {
    expect((await run()).accepted).toBe(0); expect(delivered.size).toBe(0);
    sql(`UPDATE auth.users SET email_confirmed_at=now() WHERE id='${owner}';`);
    expect((await run()).retry).toBe(1);
    expect(delivered.size).toBe(1);
    const pending = await db.from("account_signup_alerts").select("id,status,message").eq("owner_id", owner).single();
    expect(pending.error).toBeNull(); expect(pending.data?.status).toBe("pending");
    const reschedule = await db.from("account_signup_alerts").update({ next_attempt_at: new Date(0).toISOString() }).eq("id", pending.data!.id);
    expect(reschedule.error).toBeNull();
    expect((await run()).accepted).toBe(1);
    expect(delivered.size).toBe(1); // Retry went through real SDK/HTTP but was deduplicated.
    expect(requests[1]).toEqual(requests[0]);
    sql(`INSERT INTO subscriptions(business_id,stripe_customer_id,stripe_subscription_id,plan,status)
      SELECT id,'cus_local_alerts','sub_local_alerts','chat_only','active' FROM businesses WHERE owner_id='${owner}';
      UPDATE businesses SET onboarding_completed_at=now() WHERE owner_id='${owner}';`);
    expect((await run()).accepted).toBe(1);
    expect(delivered.size).toBe(2);
    expect(requests.at(-1)?.message.subject).toContain("Chat Only account ready");
    expect(requests.every((request) => request.message.to === "bryan@simplassist.com")).toBe(true);
    expect((await run()).accepted).toBe(0); expect(delivered.size).toBe(2);
    const statuses = await db.from("account_signup_alerts").select("milestone,status,provider_message_id").eq("owner_id", owner);
    expect(statuses.error).toBeNull(); expect(statuses.data).toHaveLength(2);
    expect(statuses.data?.every((row) => row.status === "sent" && row.provider_message_id)).toBe(true);
  }, 30000);
  it("gives concurrent workers different rows while the first claim is locked", async () => {
    const owners = [randomUUID(), randomUUID()];
    try {
      for (const fixture of owners) sql(`INSERT INTO auth.users(id,email,created_at,email_confirmed_at)
        VALUES ('${fixture}','${fixture}@example.test',now(),now());`);
      const results = await Promise.all(owners.map(() => promisify(execFile)("docker", [
        "exec", "-e", "PGPASSWORD=postgres", "supabase_db_SimplAssist", "psql", "-w", "-X", "-U", "supabase_admin",
        "-d", "simplassist_account_alerts_verify", "-v", "ON_ERROR_STOP=1", "-Atc",
        `BEGIN; SELECT id FROM public.claim_account_signup_alert('${randomUUID()}'); SELECT pg_sleep(0.5); COMMIT;`,
      ])));
      const claimed = results.map((result) => result.stdout.split("\n").find((line) => /^[0-9a-f-]{36}$/.test(line)));
      expect(claimed.every(Boolean)).toBe(true); expect(new Set(claimed).size).toBe(2);
    } finally {
      for (const fixture of owners) sql(`DELETE FROM auth.users WHERE id='${fixture}';`);
    }
  }, 10000);
});
