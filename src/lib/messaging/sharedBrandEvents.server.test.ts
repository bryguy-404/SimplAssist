import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), retrieve: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: m.from, rpc: m.rpc } }));
vi.mock("@/lib/messaging/client", () => ({ telnyx: { messaging10dlc: { brand: { retrieve: m.retrieve } } } }));
import { handleSharedBrandEvent, sharedBrandObservedStatus, reconcileSharedBrandStatuses } from "./sharedBrandEvents.server";
const brand = "4b20019d-e93e-d697-b8ee-c6233e9bf533";
const identity = { ein: "12-3456789", legal_business_name: "Example LLC", business_entity_type: "llc", address: "123 Private Street", city: "South Bend", state: "IN", zip: "46601" };
const group = { id: "registration", telnyx_brand_id: brand, tcr_brand_id: "BTCR", legal_identity: identity, brand_status: "approved" };
function event(status = "REGISTRATION_FAILED") { return { data: { id: "event", occurred_at: "2026-10-01T12:00:00Z", payload: { brandId: brand, status, identityStatus: "VERIFIED" } } }; }
beforeEach(() => {
  vi.clearAllMocks();
  const q = { select: () => q, eq: () => q, or: () => q, order: () => q, limit: async () => ({ data: [group], error: null }), maybeSingle: async () => ({ data: group, error: null }) };
  m.from.mockReturnValue(q); m.rpc.mockResolvedValue({ data: { applied: true }, error: null });
  m.retrieve.mockResolvedValue({ brandId: brand, tcrBrandId: "BTCR", status: "OK", identityStatus: "VERIFIED", mock: false, country: "US", ein: identity.ein, companyName: identity.legal_business_name, entityType: "PRIVATE_PROFIT", street: identity.address, city: identity.city, state: "IN", postalCode: "46601" });
});
describe("ordered shared-brand events", () => {
  it("prioritizes suspension over an old verified identity", () => {
    expect(sharedBrandObservedStatus({ status: "SUSPENDED", identityStatus: "VERIFIED" })).toBe("rejected");
    expect(sharedBrandObservedStatus({ status: "OK", identityStatus: "UNVERIFIED" })).toBe("pending");
  });
  it("commits rejection and fan-out via a single receipt transaction", async () => {
    expect(await handleSharedBrandEvent(event())).toBe(true);
    expect(m.rpc).toHaveBeenCalledExactlyOnceWith("apply_shared_brand_event", expect.objectContaining({ p_brand_id: brand, p_event_id: "event", p_status: "rejected", p_occurred_at: "2026-10-01T12:00:00.000Z" }));
    expect(m.retrieve).not.toHaveBeenCalled();
  });
  it("leaves campaign callbacks on their exclusive account path", async () => {
    expect(await handleSharedBrandEvent({ data: { payload: { brandId: brand, campaignId: "campaign" } } })).toBe(false);
    expect(m.from).not.toHaveBeenCalled();
  });
  it("propagates commit failure so Telnyx retries", async () => {
    m.rpc.mockResolvedValue({ data: null, error: { message: "failure" } });
    await expect(handleSharedBrandEvent(event())).rejects.toThrow("shared_brand_event_not_committed");
    m.rpc.mockResolvedValue({ data: { applied: true }, error: null });
    expect(await handleSharedBrandEvent(event())).toBe(true);
    expect(m.rpc).toHaveBeenCalledTimes(2);
  });
  it("does not reopen from an approval when current provider status is rejected", async () => {
    const before = Date.now();
    m.retrieve.mockResolvedValue({ brandId: brand, status: "REGISTRATION_FAILED", identityStatus: "VERIFIED", mock: false });
    await handleSharedBrandEvent(event("OK"));
    expect(m.rpc).toHaveBeenCalledWith("apply_shared_brand_event", expect.objectContaining({ p_status: "rejected" }));
    const observed = m.rpc.mock.calls[0][1].p_occurred_at;
    expect(Date.parse(observed)).toBeGreaterThanOrEqual(before);
    expect(observed).not.toBe("2026-10-01T12:00:00.000Z");
  });
  it("does not apply unordered or future approval events", async () => {
    const e = event("OK"); e.data.occurred_at = "invalid";
    await expect(handleSharedBrandEvent(e)).rejects.toThrow("shared_brand_event_time_invalid");
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("recognizes actual webhook identity aliases", async () => {
    const e = event("OK");
    e.data.payload = { brandId: brand, status: "OK", brandIdentityStatus: "VERIFIED" } as unknown as typeof e.data.payload;
    await handleSharedBrandEvent(e);
    expect(m.rpc).toHaveBeenCalledWith("apply_shared_brand_event", expect.objectContaining({ p_status: "approved" }));
  });
  it("uses current provider evidence for a heartbeat instead of disabling the accounts", async () => {
    expect(sharedBrandObservedStatus({ status: "OK" })).toBeNull();
    await handleSharedBrandEvent({ data: { id: "heartbeat", occurred_at: "2026-10-01T12:00:00Z", payload: { brandId: brand, status: "OK" } } });
    expect(m.rpc).toHaveBeenCalledWith("apply_shared_brand_event", expect.objectContaining({ p_status: "approved" }));
  });
  it("does not reopen when provider identity has changed", async () => {
    const original = await m.retrieve();
    m.retrieve.mockResolvedValue({ ...original, ein: "98-7654321" });
    await expect(handleSharedBrandEvent(event("OK"))).rejects.toThrow("shared_brand_identity_changed");
    expect(m.rpc).toHaveBeenCalledExactlyOnceWith("hold_shared_brand_identity", expect.objectContaining({ p_brand_id: brand }));
  });
  it.each([{ brandId: "4b20019d-e93e-d697-b8ee-c6233e9bf534" }, { mock: true }])("holds a complete mismatched provider response %j", async mismatch => {
    const original = await m.retrieve();
    m.retrieve.mockResolvedValue({ ...original, ...mismatch });
    await expect(handleSharedBrandEvent(event("OK"))).rejects.toThrow("shared_brand_identity_changed");
    expect(m.rpc).toHaveBeenCalledExactlyOnceWith("hold_shared_brand_identity", expect.objectContaining({ p_brand_id: brand }));
  });
  it("rejects incomplete evidence without persisting an identity hold", async () => {
    m.retrieve.mockResolvedValue({ brandId: brand, status: "OK", identityStatus: "VERIFIED", mock: false });
    await expect(handleSharedBrandEvent(event("OK"))).rejects.toThrow("shared_brand_observation_incomplete");
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("reconciles a missed callback without any provider mutations", async () => {
    expect(await reconcileSharedBrandStatuses()).toBe(1);
    expect(m.retrieve).toHaveBeenCalledWith(brand, { maxRetries: 0, timeout: 10000 });
    expect(m.rpc).toHaveBeenCalledWith("apply_shared_brand_event", expect.objectContaining({ p_status: "approved", p_event_id: expect.stringMatching(/^reconcile:/) }));
  });
});
