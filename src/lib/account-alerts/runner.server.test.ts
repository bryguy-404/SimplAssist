import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), send: vi.fn(), writes: [] as Record<string, unknown>[], writeResult: { data: { id: "saved" }, error: null } as {data: unknown; error: unknown}, business: true }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { rpc: mocks.rpc, from: mocks.from } }));
vi.mock("@/lib/email/client", () => ({ RESEND_FROM: "sender@simplassist.com" }));
vi.mock("@/lib/branding/defaultBrand", () => ({ getCanonicalAppOrigin: () => "https://simplassist.com" }));
vi.mock("./sender.server", () => ({ sendAccountAlert: mocks.send }));
import { runAccountSignupAlerts } from "./runner.server";
const id = "10000000-0000-4000-a000-000000000001";
const payload = { version: 1, businessId: id, name: "Alex", email: "alex@example.test", businessName: null, plan: null,
  signedUpAt: "2026-11-22T15:00:00Z", occurredAt: "2026-11-22T15:01:00Z", kind: "verified_signup", brandStatus: null, campaignStatus: null };
const row = () => ({ id, business_id: id, owner_id: id, payload, message: null, first_attempt_at: new Date().toISOString(), attempt_count: 1 });
function mockClaim(changes = {}) {
  mocks.rpc.mockResolvedValueOnce({ data: 1, error: null }).mockResolvedValueOnce({ data: [{ ...row(), ...changes }], error: null }).mockResolvedValue({ data: [], error: null });
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-22T15:02:00Z"));
  vi.clearAllMocks(); vi.stubEnv("ACCOUNT_SIGNUP_ALERTS_ENABLED", "true"); vi.stubEnv("RESEND_API_KEY", "test");
  mocks.writes = []; mocks.writeResult = { data: { id }, error: null }; mocks.business = true;
  mocks.send.mockResolvedValue({ kind: "accepted", providerId: "provider-1" });
  mocks.from.mockImplementation((table: string) => {
    const builder: Record<string, unknown> = {};
    for (const method of ["eq", "is", "gt", "select"]) builder[method] = vi.fn(() => builder);
    builder.update = vi.fn((values) => { mocks.writes.push(values); return builder; });
    builder.maybeSingle = vi.fn(async () => table === "businesses" ? { data: mocks.business ? { id } : null, error: null } : mocks.writeResult);
    return builder;
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function run() { const result = runAccountSignupAlerts(); await vi.runAllTimersAsync(); return result; }
describe("account alert delivery runner", () => {
  it("is disabled until explicitly enabled", async () => {
    vi.stubEnv("ACCOUNT_SIGNUP_ALERTS_ENABLED", "false");
    expect((await run()).enabled).toBe(false); expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  });
  it("persists the provider message before sending and then records acceptance", async () => {
    mockClaim(); mocks.send.mockImplementation(async () => { expect(mocks.writes[0].message).toBeTruthy(); return { kind: "accepted", providerId: "provider-1" }; });
    expect((await run()).accepted).toBe(1);
    expect(mocks.writes.at(-1)).toMatchObject({ status: "sent", provider_message_id: "provider-1", claim_token: null });
  });
  it("reuses frozen content even after profile or sender changes", async () => {
    const message = { from: "original@example.test", to: "bryan@simplassist.com", replyTo: "old@example.test", subject: "Original", text: "Original", html: "<p>Original</p>" };
    mockClaim({ message, payload: { invalid: true }, attempt_count: 2 }); await run();
    expect(mocks.send).toHaveBeenCalledWith(id, message);
  });
  it("schedules bounded backoff after an ambiguous send", async () => {
    mockClaim(); mocks.send.mockResolvedValue({ kind: "retry", code: "provider_not_confirmed" });
    expect((await run()).retry).toBe(1);
    expect(mocks.writes.at(-1)).toMatchObject({ status: "pending", next_attempt_at: "2026-11-22T15:03:00.000Z" });
  });
  it("does not send when message persistence fails", async () => {
    mockClaim(); mocks.writeResult = { data: null, error: { message: "unavailable" } };
    await expect(runAccountSignupAlerts()).rejects.toThrow("message_save_failed"); expect(mocks.send).not.toHaveBeenCalled();
  });
  it("holds an expired retry instead of risking a duplicate", async () => {
    mockClaim({ first_attempt_at: "2026-11-21T15:00:00Z" });
    expect((await run()).needsReview).toBe(1); expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.writes.at(-1)).toMatchObject({ status: "needs_review", error_code: "retry_window_expired" });
  });
  it("suppresses a deleted or reassigned business", async () => {
    mockClaim(); mocks.business = false; await run(); expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.writes.at(-1)).toMatchObject({ status: "canceled", message: null, payload: {} });
  });
  it("leaves an accepted-but-unsaved delivery recoverable with the same key", async () => {
    mockClaim(); mocks.send.mockImplementation(async () => { mocks.writeResult = { data: null, error: {} }; return { kind: "accepted", providerId: "provider-1" }; });
    await expect(runAccountSignupAlerts()).rejects.toThrow("result_save_failed"); expect(mocks.send).toHaveBeenCalledOnce();
  });
});
