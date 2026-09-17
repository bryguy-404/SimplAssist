import { beforeEach, expect, it, vi } from "vitest";
import type { VoiceAction } from "./actions";
const m = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), retrieve: vi.fn(), usage: vi.fn(), send: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: m.from, rpc: m.rpc } }));
vi.mock("@/lib/messaging/client", () => ({ telnyx: { messages: { retrieve: m.retrieve, send: m.send } } }));
vi.mock("@/lib/billing/usage", () => ({ recordOutboundSmsUsage: m.usage }));
import { persistVoiceSmsBookkeeping, recoverVoiceActions, recoverVoiceSignupBookkeeping } from "./actionRecovery.server";
type Row = Record<string, unknown> & { result?: Record<string, unknown> | null };
let rows: Row[];
let updates: { id: unknown; patch: Row }[];
let ordering: unknown[][];
function accepted(overrides: Row = {}): Row {
  return {
    id: "accepted", business_id: "business", session_id: "session", kind: "signup",
    status: "succeeded", updated_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z",
    recovery_complete: false, sms_provider_message_id: "provider-message", sms_accepted_at: "2026-01-01T00:00:00Z",
    result: { providerMessageId: "provider-message", smsBody: "Requested link", summary: "Link accepted, signup incomplete" },
    ...overrides,
  };
}
beforeEach(() => {
  vi.resetAllMocks(); updates = []; ordering = [];
  rows = [{ id: "unknown", kind: "signup", business_id: "business", session_id: "session", status: "uncertain", recovery_complete: false, updated_at: "2026-01-01T00:00:00Z", result: null }];
  m.usage.mockResolvedValue(undefined);
  m.retrieve.mockResolvedValue({ data: { from: { phone_number: "+15555550102" }, to: [{ phone_number: "+15555550101", status: "delivered" }] } });
  m.rpc.mockImplementation(async (_name, args) => {
    const row = rows.find(r => r.id === args.p_action_id);
    if (row) row.goal_event_recorded_at = "2026-01-02T00:00:00Z";
    return { data: [{ message_id: args.p_action_id, conversation_id: "original-sms", goal_event_id: "lead", occurred_at: "2026-01-01T00:00:00Z", created_event: true }], error: null };
  });
  m.from.mockImplementation((table: string) => {
    let patch: Row | undefined, id: unknown;
    const filters: ((row: Row) => boolean)[] = [];
    const q = {
      select: () => q,
      in: (key: string, values: unknown[]) => { filters.push(r => values.includes(r[key])); return q; },
      not: (key: string, _operator: string, value: unknown) => { filters.push(r => (r[key] ?? null) !== value); return q; },
      is: (key: string, value: unknown) => { filters.push(r => (r[key] ?? null) === value); return q; },
      or: (condition: string) => {
        if (condition === "goal_event_recorded_at.is.null,sms_logged_at.is.null") filters.push(r => !r.goal_event_recorded_at || !r.sms_logged_at);
        return q;
      },
      limit: () => q,
      order: (...args: unknown[]) => { ordering.push(args); return q; },
      eq: (key: string, value: unknown) => { if (key === "id") id = value; filters.push(r => r[key] === value); return q; },
      update: (value: Row) => { patch = value; return q; },
      single: () => q,
      then: (resolve: (v: unknown) => unknown) => {
        const selected = rows.filter(r => filters.every(f => f(r)));
        if (patch) { updates.push({ id, patch }); selected.forEach(r => Object.assign(r, patch)); }
        return Promise.resolve({ data: table === "voice_sessions" ? { called_phone: "+15555550102", caller_phone: "+15555550101" } : selected.map(r => ({ ...r })), error: null }).then(resolve);
      },
    };
    return q;
  });
});
it("rotates unresolved sends without resubmitting them or blocking newer calls", async () => {
  await recoverVoiceActions();
  expect(m.retrieve).not.toHaveBeenCalled();
  expect(m.send).not.toHaveBeenCalled();
  expect(updates).toContainEqual({ id: "unknown", patch: { reconciled_at: expect.any(String) } });
  expect(ordering).toContainEqual(["reconciled_at", { nullsFirst: true }]);
});
it("verifies provider identity and records delivery independently of signup completion", async () => {
  rows = [accepted({ sms_logged_at: "2026-01-01", goal_event_recorded_at: "2026-01-01" })];
  await recoverVoiceActions();
  expect(updates).toContainEqual({ id: "accepted", patch: expect.objectContaining({ recovery_complete: true, result: expect.objectContaining({ deliveryStatus: "delivered", summary: "Link accepted, signup incomplete" }) }) });
});
it("rejects another recipient's delivery result and rotates the lookup", async () => {
  rows = [accepted({ sms_logged_at: "2026-01-01", goal_event_recorded_at: "2026-01-01" })];
  m.retrieve.mockResolvedValue({ data: { from: { phone_number: "+15555550102" }, to: [{ phone_number: "+15555559999", status: "delivered" }] } });
  await recoverVoiceActions();
  expect(updates).toEqual([{ id: "accepted", patch: { reconciled_at: expect.any(String) } }]);
});
it("repairs a missing lead even after delivery recovery completed without billing or sending again", async () => {
  rows = [accepted({ recovery_complete: true, sms_logged_at: "2026-01-01" })];
  await recoverVoiceActions();
  expect(m.rpc).toHaveBeenCalledExactlyOnceWith("finalize_voice_signup_bookkeeping", { p_action_id: "accepted" });
  expect(m.usage).not.toHaveBeenCalled();
  expect(m.retrieve).not.toHaveBeenCalled();
  expect(m.send).not.toHaveBeenCalled();
  await recoverVoiceActions();
  expect(m.rpc).toHaveBeenCalledTimes(1);
});
it("retries usage after lead finalization fails to finish metering, preserving the original usage key", async () => {
  rows = [accepted({ recovery_complete: true })];
  m.usage.mockRejectedValueOnce(new Error("usage unavailable"));
  await recoverVoiceSignupBookkeeping();
  expect(rows[0].goal_event_recorded_at).toBeTruthy();
  expect(rows[0].sms_logged_at).toBeUndefined();
  rows[0].bookkeeping_attempted_at = "2026-01-01T00:00:00Z";
  await recoverVoiceSignupBookkeeping();
  expect(m.usage).toHaveBeenCalledTimes(2);
  for (const [args] of m.usage.mock.calls) expect(args.idempotencyKey).toBe("voice-followup:accepted");
  expect(rows[0].sms_logged_at).toBeTruthy();
  expect(m.send).not.toHaveBeenCalled();
});
it("keeps delivery reconciliation progressing when lead finalization fails", async () => {
  rows = [accepted()];
  m.rpc.mockResolvedValue({ data: null, error: { message: "database down" } });
  await recoverVoiceActions();
  expect(rows[0].status).toBe("succeeded");
  expect(rows[0].result!.deliveryStatus).toBe("delivered");
  expect(rows[0].bookkeeping_attempted_at).toBeTruthy();
  expect(m.usage).not.toHaveBeenCalled();
  expect(m.send).not.toHaveBeenCalled();
});
it("leaves legacy timestamps for the guarded restoration and respects the retry cooldown", async () => {
  rows = [accepted({ sms_accepted_at: null }), accepted({ id: "recent", bookkeeping_attempted_at: new Date().toISOString() })];
  await recoverVoiceSignupBookkeeping();
  expect(m.rpc).not.toHaveBeenCalled();
  expect(m.usage).not.toHaveBeenCalled();
});
it("does not meter or log a send when the transactional finalizer rejects its provenance", async () => {
  const a = accepted();
  m.rpc.mockResolvedValue({ data: null, error: { message: "identity mismatch" } });
  await expect(persistVoiceSmsBookkeeping(a as unknown as VoiceAction, a.result!)).rejects.toThrow("finalize_failed");
  expect(m.usage).not.toHaveBeenCalled();
  expect(updates).toEqual([]);
});
