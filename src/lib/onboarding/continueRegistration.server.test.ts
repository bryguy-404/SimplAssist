import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ from: vi.fn(), retrieve: vi.fn(), launch: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("@/lib/messaging/client", () => ({ telnyx: { messaging10dlc: { brand: { retrieve: mocks.retrieve } } } }));
vi.mock("@/lib/billing/launch", () => ({ attemptPaidLaunch: mocks.launch }));
import { continuePendingBrandRegistration, reconcilePendingBrandRegistrations } from "./continueRegistration.server";

const row = { id: "business", telnyx_brand_id: "brand", brand_status: "pending", onboarding_last_saved_at: "2026-01-01T00:00:00Z", onboarding_registration_status: "submitted" };
const chains: Record<string, ReturnType<typeof vi.fn>>[] = [];
function queue(...results: unknown[]) {
  mocks.from.mockImplementation(() => {
    const result = results.shift();
    if (result === undefined) throw new Error("Unexpected database query");
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const key of ["select", "update", "eq", "is", "not", "in", "or", "order", "limit", "maybeSingle"])
      chain[key] = vi.fn(() => chain);
    Object.assign(chain, { then: Promise.resolve(result).then.bind(Promise.resolve(result)) });
    chains.push(chain); return chain;
  });
}
const ok = (data: unknown) => ({ data, error: null });
beforeEach(() => { vi.resetAllMocks(); chains.length = 0; mocks.launch.mockResolvedValue({ status: "submitted" }); });

describe("automatic brand continuation", () => {
  it("resumes an approved unfinished registration through all existing paid-launch gates", async () => {
    queue(ok({ ...row, brand_status: "approved" }));
    await continuePendingBrandRegistration(row.id);
    expect(mocks.launch).toHaveBeenCalledWith(row.id, "registration_continuation");
    expect(chains[0].or).toHaveBeenCalledWith(expect.stringContaining("onboarding_registration_status.eq.submitted"));
    expect(chains[0].or).toHaveBeenCalledWith(expect.stringContaining("onboarding_registration_started_at.lt."));
    expect(chains[0].is).toHaveBeenCalledWith("telnyx_campaign_id", null);
    expect(chains[0].is).toHaveBeenCalledWith("onboarding_registration_error", null);
    expect(chains[0].is).toHaveBeenCalledWith("deleted_at", null);
    expect(chains[0].is).toHaveBeenCalledWith("operations_suspended_at", null);
  });
  it.each([null, row])("does not resume a missing, active, rejected, or unapproved candidate", async (data) => {
    queue(ok(data)); await continuePendingBrandRegistration(row.id);
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it("recovers a missed approval webhook after verifying provider identity", async () => {
    queue(ok([row]), ok({ id: row.id }), ok({ id: row.id }), ok({ ...row, brand_status: "approved" }));
    mocks.retrieve.mockResolvedValue({ brandId: "brand", status: "OK", identityStatus: "VERIFIED" });
    expect(await reconcilePendingBrandRegistrations()).toEqual({ checked: 1, failed: 0 });
    expect(mocks.launch).toHaveBeenCalledTimes(1);
    expect(chains[2].eq).toHaveBeenCalledWith("brand_status", "pending");
    expect(chains[2].is).toHaveBeenCalledWith("telnyx_campaign_id", null);
  });
  it("resumes an interrupted approved registration through the existing stale-claim guard", async () => {
    const interrupted = { ...row, brand_status: "approved", onboarding_registration_status: "submitting" };
    queue(ok([interrupted]), ok({ id: row.id }), ok(interrupted));
    expect(await reconcilePendingBrandRegistrations()).toEqual({ checked: 1, failed: 0 });
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.launch).toHaveBeenCalledWith(row.id, "registration_continuation");
    expect(chains[1].eq).toHaveBeenCalledWith("onboarding_registration_status", "submitting");
  });
  it("keeps a provider prerequisite wait pending without a launch or failure write", async () => {
    queue(ok([row]), ok({ id: row.id }));
    mocks.retrieve.mockResolvedValue({ brandId: "brand", status: "REGISTRATION_PENDING", identityStatus: "UNVERIFIED" });
    expect(await reconcilePendingBrandRegistrations()).toEqual({ checked: 1, failed: 0 });
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(chains).toHaveLength(2);
  });
  it("does not overwrite a rejection that wins the provider-read race", async () => {
    queue(ok([row]), ok({ id: row.id }), ok(null));
    mocks.retrieve.mockResolvedValue({ brandId: "brand", identityStatus: "VERIFIED" });
    await reconcilePendingBrandRegistrations();
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it("does not contact providers when another sweep won the inspection claim", async () => {
    queue(ok([row]), ok(null)); await reconcilePendingBrandRegistrations();
    expect(mocks.retrieve).not.toHaveBeenCalled(); expect(mocks.launch).not.toHaveBeenCalled();
  });
  it("preserves a real rejection and stops automatic continuation", async () => {
    queue(ok([row]), ok({ id: row.id }), ok({ id: row.id }));
    mocks.retrieve.mockResolvedValue({ brandId: "brand", identityStatus: "UNVERIFIED", status: "REGISTRATION_FAILED", failureReasons: "Carrier rejected" });
    await reconcilePendingBrandRegistrations();
    expect(chains[2].update).toHaveBeenCalledWith(expect.objectContaining({ brand_status: "rejected", onboarding_registration_status: "failed" }));
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it("rejects a mismatched provider response and continues inspecting the next account", async () => {
    queue(ok([row, { ...row, id: "next" }]), ok({ id: row.id }), ok({ id: "next" }));
    mocks.retrieve.mockResolvedValueOnce({ brandId: "foreign", identityStatus: "VERIFIED" })
      .mockResolvedValueOnce({ brandId: "brand", status: "REGISTRATION_PENDING", identityStatus: "UNVERIFIED" });
    expect(await reconcilePendingBrandRegistrations()).toEqual({ checked: 2, failed: 1 });
    expect(mocks.launch).not.toHaveBeenCalled();
  });
});
