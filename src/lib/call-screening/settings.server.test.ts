import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), retrieve: vi.fn(), readVoice: vi.fn(), updateVoice: vi.fn(), recoverId: vi.fn(), entitlements: vi.fn(), allowed: vi.fn(), rollout: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: m.from, rpc: m.rpc } }));
vi.mock("@/lib/messaging/client", () => ({ telnyx: { phoneNumbers: { retrieve: m.retrieve, voice: { retrieve: m.readVoice, update: m.updateVoice } } } }));
vi.mock("@/lib/messaging/numbers", () => ({ normalizeTelnyxPhoneNumberResourceId: (id: string) => { if (!/^\d+$/.test(id)) throw new Error("invalid"); return id; }, findOwnedNumberId: m.recoverId }));
vi.mock("@/lib/billing/entitlements", () => ({ resolveBusinessEntitlements: m.entitlements, canUseFeature: m.allowed }));
vi.mock("./rollout.server", () => ({ canEnableCallScreening: m.rollout }));
import { getCallScreeningSettings, syncCallScreening, updateCallScreening } from "./settings.server";
let owner: unknown; let phone: Record<string, unknown> | null; let row: Record<string, unknown> | null;
const queries: { table: string; filters: [string, unknown][] }[] = [];
beforeEach(() => {
  vi.resetAllMocks(); queries.length = 0;
  owner = { id: "business" };
  phone = { id: "phone", business_id: "business", phone_number: "+12025550101", telnyx_phone_number_id: "123456789123456789" };
  row = { phone_number_id: "phone", business_id: "business", requested_by: "owner", requested_mode: "flag_calls", confirmed_mode: "disabled", revision: 1, sync_status: "pending", lease_token: "lease", verified_at: "2026-11-01T00:00:00Z" };
  m.from.mockImplementation((table: string) => {
    const log = { table, filters: [] as [string, unknown][] }; queries.push(log);
    const q: Record<string, unknown> = {};
    q.select = () => q;
    for (const method of ["eq", "is"]) q[method] = (key: string, value: unknown) => { log.filters.push([key, value]); return q; };
    q.maybeSingle = async () => ({ data: table === "businesses" ? owner : table === "phone_numbers" ? phone : row, error: null });
    return q;
  });
  m.rpc.mockImplementation(async name => ({ data: name === "claim_call_screening_sync" ? row : true, error: null }));
  m.rollout.mockReturnValue(true); m.allowed.mockReturnValue(true); m.entitlements.mockResolvedValue({});
  m.retrieve.mockResolvedValue({ data: { phone_number: phone.phone_number, customer_reference: "business" } });
  m.readVoice.mockResolvedValueOnce({ data: { inbound_call_screening: "disabled" } }).mockResolvedValue({ data: { inbound_call_screening: "flag_calls" } });
  m.updateVoice.mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());
describe("owner-scoped provider settings", () => {
  it("verifies decimal resource ownership, changes only screening, then reads back", async () => {
    await syncCallScreening("phone");
    expect(m.retrieve).toHaveBeenCalledWith("123456789123456789", expect.objectContaining({ maxRetries: 0 }));
    expect(m.updateVoice).toHaveBeenCalledExactlyOnceWith("123456789123456789", { inbound_call_screening: "flag_calls" }, expect.any(Object));
    expect(m.readVoice).toHaveBeenCalledTimes(2);
    expect(m.rpc).toHaveBeenLastCalledWith("finish_call_screening_sync", { p_number: "phone", p_lease: "lease", p_actual: "flag_calls", p_error: null });
    expect(queries.filter(q => q.table === "businesses").every(q => q.filters.some(([k,v]) => k === "owner_id" && v === "owner"))).toBe(true);
  });
  it("refuses a provider resource owned by a different business", async () => {
    m.retrieve.mockResolvedValue({ data: { phone_number: phone!.phone_number, customer_reference: "other" } });
    await syncCallScreening("phone");
    expect(m.updateVoice).not.toHaveBeenCalled(); expect(m.readVoice).not.toHaveBeenCalled();
    expect(m.rpc).toHaveBeenLastCalledWith("finish_call_screening_sync", expect.objectContaining({ p_actual: "unknown", p_error: "screening_number_unavailable" }));
  });
  it("does not use a changed owner or inactive number for a queued setting", async () => {
    owner = null;
    await syncCallScreening("phone");
    expect(m.retrieve).not.toHaveBeenCalled(); expect(m.updateVoice).not.toHaveBeenCalled();
  });
  it("recovers a legacy order-line ID through exact owned-number lookup and guarded persistence", async () => {
    phone!.telnyx_phone_number_id = "00000000-0000-4000-8000-000000000001";
    m.recoverId.mockResolvedValue("987654321987654321");
    await syncCallScreening("phone");
    expect(m.recoverId).toHaveBeenCalledWith("+12025550101", "business", expect.any(Object));
    expect(m.rpc).toHaveBeenCalledWith("repair_telnyx_phone_number_resource_id", expect.objectContaining({ p_expected_legacy_id: phone!.telnyx_phone_number_id, p_resolved_resource_id: "987654321987654321" }));
    expect(m.updateVoice).toHaveBeenCalledWith("987654321987654321", expect.any(Object), expect.any(Object));
  });
  it("never claims enabled after an uncertain update or failed readback", async () => {
    m.readVoice.mockReset().mockResolvedValueOnce({ data: { inbound_call_screening: "disabled" } }).mockRejectedValue(new Error("readback timeout"));
    await syncCallScreening("phone");
    expect(m.updateVoice).toHaveBeenCalledOnce();
    expect(m.rpc).toHaveBeenLastCalledWith("finish_call_screening_sync", expect.objectContaining({ p_actual: "unknown", p_error: "screening_sync_unconfirmed" }));
  });
  it("resolves a crash after successful mutation by reading back without repeating the write", async () => {
    m.readVoice.mockReset().mockResolvedValue({ data: { inbound_call_screening: "flag_calls" } });
    await syncCallScreening("phone");
    expect(m.updateVoice).not.toHaveBeenCalled();
    expect(m.rpc).toHaveBeenLastCalledWith("finish_call_screening_sync", expect.objectContaining({ p_actual: "flag_calls", p_error: null }));
  });
  it("keeps existing settings accessible for Off when rollout and paid access close", async () => {
    m.rollout.mockReturnValue(false); m.allowed.mockReturnValue(false);
    row!.requested_mode = "disabled";
    await updateCallScreening("business", "owner", "disabled", 1);
    expect(m.rpc).toHaveBeenCalledWith("request_call_screening", expect.objectContaining({ p_mode: "disabled", p_owner: "owner" }));
    expect(await getCallScreeningSettings("business", "owner")).toMatchObject({ available: true, canEnable: false });
    m.rpc.mockClear();
    await expect(updateCallScreening("business", "owner", "flag_calls", 1)).rejects.toThrow("screening_access_denied");
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("does not treat a refused durable request as authorization to touch Telnyx", async () => {
    m.rpc.mockResolvedValue({ error: { message: "screening_revision_conflict" } });
    await expect(updateCallScreening("business", "owner", "flag_calls", 0)).rejects.toThrow("screening_revision_conflict");
    expect(m.retrieve).not.toHaveBeenCalled(); expect(m.updateVoice).not.toHaveBeenCalled();
  });
  it("shows unknown as unknown, and verifies external Reject accurately without requesting it", async () => {
    row = null;
    expect(await getCallScreeningSettings("business", "owner")).toMatchObject({ confirmedMode: "unknown", requestedMode: "disabled" });
    m.readVoice.mockReset().mockResolvedValue({ data: { inbound_call_screening: "reject_calls" } });
    await getCallScreeningSettings("business", "owner", true);
    expect(m.rpc).toHaveBeenCalledWith("observe_call_screening_setting", expect.objectContaining({ p_actual: "reject_calls", p_revision: 0 }));
    expect(m.updateVoice).not.toHaveBeenCalled();
  });
});
