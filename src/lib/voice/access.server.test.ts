import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), ready: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { rpc: mocks.rpc, from: mocks.from } }));
vi.mock("./routing", () => ({ checkVoiceWorkerReady: mocks.ready }));
import { getOwnerVoiceSettings, updateOwnerVoiceSettings, hasCustomerVoiceRoutingConfiguration } from "./access.server";
const summary = {
  visible: true, access_source: "commercial", eligible: true, reason: null, primary_response: "voice", text_fallback_enabled: true,
  revision: 2, period_end: "2026-10-17T00:00:00Z", included_seconds: 6000, used_seconds: 1200, held_seconds: 600,
  available_seconds: 4200, reconciling: false,
};
function setSummary(changes: Record<string, unknown> = {}) { mocks.rpc.mockResolvedValue({ data: { ...summary, ...changes }, error: null }); }
beforeEach(() => {
  vi.clearAllMocks(); setSummary(); mocks.ready.mockResolvedValue(true);
  const query = { select: vi.fn(), eq: vi.fn(), is: vi.fn(), maybeSingle: vi.fn() };
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query); query.is.mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({ data: { timezone: "America/Indiana/Indianapolis" }, error: null }); mocks.from.mockReturnValue(query);
});
describe("safe owner voice projection", () => {
  it.each([null, { primary_response: "text" }])("keeps untouched/text-only routing on the existing path %#", async (data) => {
    const query = mocks.from(); query.maybeSingle.mockResolvedValue({ data, error: null });
    mocks.from.mockClear(); expect(await hasCustomerVoiceRoutingConfiguration("business")).toBe(false);
    expect(mocks.from).toHaveBeenCalledTimes(1); expect(mocks.from).toHaveBeenCalledWith("voice_commercial_settings");
  });
  it("preserves a configured voice account's fallback choice even while rollout is closed", async () => {
    mocks.from().maybeSingle.mockResolvedValue({ data: { primary_response: "voice" }, error: null });
    expect(await hasCustomerVoiceRoutingConfiguration("business")).toBe(true);
  });
  it("does not fabricate a generic text route when saved preferences are unknown", async () => {
    mocks.from().maybeSingle.mockResolvedValue({ data: null, error: { message: "unavailable" } });
    await expect(hasCustomerVoiceRoutingConfiguration("business")).rejects.toThrow("voice_settings_unavailable");
  });
  it("exposes current monthly balances without raw internal rows", async () => {
    const dto = await getOwnerVoiceSettings("business");
    expect(dto).toMatchObject({ canEnableVoice: true, usage: { kind: "monthly", includedSeconds: 6000, usedSeconds: 1200, heldSeconds: 600, availableSeconds: 4200 } });
    expect(dto).not.toHaveProperty("policy_revision"); expect(mocks.rpc).toHaveBeenCalledWith("get_voice_commercial_summary", { p_business_id: "business" });
  });
  it("keeps the private lifetime pool separate and read-only", async () => {
    setSummary({ access_source: "pilot", included_seconds: 12000, period_end: null });
    expect(await getOwnerVoiceSettings("business")).toMatchObject({ canEnableVoice: false, canEditPreferences: false, usage: { kind: "pilot_lifetime", includedSeconds: 12000, resetsAt: null } });
    expect(mocks.ready).not.toHaveBeenCalled();
  });
  it("hides ordinary account activation even when a plan lookup would call it Full", async () => {
    setSummary({ visible: false, eligible: false, reason: "rollout_closed", period_end: null, included_seconds: null, used_seconds: null, held_seconds: null, available_seconds: null });
    expect(await getOwnerVoiceSettings("business")).toMatchObject({ visible: false, accessSource: null, canEditPreferences: false, canEnableVoice: false, usage: null });
    expect(mocks.ready).not.toHaveBeenCalled();
  });
  it("keeps history/settings visible after downgrade while denying voice", async () => {
    setSummary({ eligible: false, reason: "plan_required" });
    expect(await getOwnerVoiceSettings("business")).toMatchObject({ visible: true, canEditPreferences: true, canEnableVoice: false, status: "plan_required" });
  });
  it("reports worker unavailability without inventing a zero balance", async () => {
    mocks.ready.mockResolvedValue(false);
    expect(await getOwnerVoiceSettings("business")).toMatchObject({ canEnableVoice: false, status: "temporarily_unavailable", usage: { availableSeconds: 4200 } });
  });
  it.each([{ included_seconds: -1 }, { used_seconds: "0" }, { held_seconds: NaN }, { period_end: "tomorrow" }, { eligible: null }])("rejects malformed authoritative usage %#", async (changes) => {
    setSummary(changes); await expect(getOwnerVoiceSettings("business")).rejects.toThrow("voice_settings_unavailable");
  });
  it("permits switching to text after lost voice access and binds the current owner", async () => {
    mocks.rpc.mockImplementation(async (name) => name === "configure_voice_commercial"
      ? { data: { business_id: "business", primary_response: "text", text_fallback_enabled: false, revision: 3 }, error: null }
      : { data: { ...summary, eligible: false, reason: "payment_required", primary_response: "text", revision: 3 }, error: null });
    await updateOwnerVoiceSettings("business", "owner", { mode: "text", textFallbackEnabled: false, expectedRevision: 2 });
    expect(mocks.rpc).toHaveBeenCalledWith("configure_voice_commercial", { p_business_id: "business", p_owner_id: "owner", p_primary_response: "text", p_text_fallback_enabled: false, p_expected_revision: 2 });
    expect(mocks.ready).not.toHaveBeenCalled();
  });
  it("rejects enabling while access is denied before mutating settings", async () => {
    setSummary({ eligible: false, reason: "rollout_closed", primary_response: "text" });
    await expect(updateOwnerVoiceSettings("business", "owner", { mode: "voice", textFallbackEnabled: true, expectedRevision: 2 })).rejects.toThrow("voice_settings_forbidden");
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it("allows disabling fallback for an existing voice selection after access is lost", async () => {
    mocks.rpc.mockImplementation(async (name) => name === "configure_voice_commercial"
      ? { data: { business_id: "business", primary_response: "voice", text_fallback_enabled: false, revision: 3 }, error: null }
      : { data: { ...summary, eligible: false, reason: "payment_required" }, error: null });
    await updateOwnerVoiceSettings("business", "owner", { mode: "voice", textFallbackEnabled: false, expectedRevision: 2 });
    expect(mocks.rpc).toHaveBeenCalledWith("configure_voice_commercial", { p_business_id: "business", p_owner_id: "owner", p_primary_response: "voice", p_text_fallback_enabled: false, p_expected_revision: 2 });
    expect(mocks.ready).not.toHaveBeenCalled();
  });
  it.each([["40001", "conflict"], ["42501", "forbidden"], ["P0001", "unavailable"]])("maps %s without leaking database details", async (code, expected) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code, message: "private" } });
    await expect(updateOwnerVoiceSettings("business", "owner", { mode: "text", textFallbackEnabled: false, expectedRevision: 2 })).rejects.toThrow(`voice_settings_${expected}`);
  });
});
