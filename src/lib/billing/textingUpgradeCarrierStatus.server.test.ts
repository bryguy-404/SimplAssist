import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(), brand: vi.fn(), campaign: vi.fn(), audit: vi.fn(), transition: vi.fn(),
  upgrade: vi.fn(), canContinue: vi.fn(), update: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("@/lib/messaging/client", () => ({ telnyx: { messaging10dlc: {
  brand: { retrieve: mocks.brand }, campaign: { retrieve: mocks.campaign },
} } }));
vi.mock("@/lib/messaging/registration/audit", () => ({ appendRegistrationEventOrThrow: mocks.audit }));
vi.mock("@/lib/messaging/registration/campaignStatusTransition", async (original) => ({
  ...await original<typeof import("@/lib/messaging/registration/campaignStatusTransition")>(),
  applyObservedCampaignStatus: mocks.transition,
}));
vi.mock("./textingUpgradeActivation.server", () => ({
  readPendingPaidTextingUpgrade: mocks.upgrade,
  canContinueTextingUpgradeProvisioning: mocks.canContinue,
}));

import { refreshTextingUpgradeCarrierStatus } from "./textingUpgradeCarrierStatus.server";

let snapshot: Record<string, unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  snapshot = {
    id: "business-a", owner_id: "owner-a", updated_at: "2026-09-23T10:00:00Z",
    deleted_at: null, telnyx_unique_claims_released_at: null, active_telnyx_release_run_id: null,
    telnyx_resource_state: "provisioning", telnyx_submission_disabled: false,
    telnyx_brand_id: "brand-a", telnyx_campaign_id: "campaign-a", telnyx_messaging_profile_id: "profile-a",
    brand_status: "approved", campaign_status: "pending", campaign_status_updated_at: null,
    campaign_rejection_reason: null, onboarding_registration_status: "submitted",
    onboarding_registration_submitted_at: "2026-09-23T10:00:00Z", onboarding_registration_error: null,
  };
  mocks.upgrade.mockResolvedValue({ id: "upgrade-a", state: "carrier_pending" });
  mocks.canContinue.mockResolvedValue(true);
  mocks.audit.mockResolvedValue(undefined);
  mocks.transition.mockResolvedValue({ outcome: "applied", statusChanged: true });
  mocks.brand.mockResolvedValue({ brandId: "brand-a", identityStatus: "VERIFIED", status: "OK" });
  mocks.campaign.mockResolvedValue({ campaignId: "campaign-a", brandId: "brand-a", campaignStatus: "MNO_PROVISIONED" });
  mocks.from.mockImplementation(() => {
    let mutation: Record<string, unknown> | null = null;
    const query = {
      select: vi.fn(), eq: vi.fn(), is: vi.fn(),
      update: vi.fn((payload) => { mutation = payload; mocks.update(payload); return query; }),
      maybeSingle: vi.fn(async () => {
        if (mutation) {
          snapshot = { ...snapshot, ...mutation, updated_at: "2026-09-23T10:01:00Z" };
          return { data: { id: snapshot.id }, error: null };
        }
        return { data: { ...snapshot }, error: null };
      }),
    };
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query); query.is.mockReturnValue(query);
    return query;
  });
});

describe("explicit texting upgrade carrier reconciliation", () => {
  it("repairs a missed brand approval before reconciling its exact campaign", async () => {
    snapshot.brand_status = "pending";
    expect(await refreshTextingUpgradeCarrierStatus("business-a")).toEqual({ refreshed: true });
    expect(mocks.brand).toHaveBeenCalledWith("brand-a", { maxRetries: 0, timeout: 10_000 });
    expect(mocks.transition).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: expect.objectContaining({ brand_status: "approved", telnyx_campaign_id: "campaign-a" }),
      newStatus: "approved", enforceAssignmentSafety: true,
    }));
    expect(mocks.audit.mock.invocationCallOrder[0]).toBeLessThan(mocks.update.mock.invocationCallOrder[0]);
  });

  it.each(["brand", "campaign"])("rejects a foreign %s provider response before any status write", async (kind) => {
    if (kind === "brand") {
      snapshot.brand_status = "pending";
      mocks.brand.mockResolvedValue({ brandId: "brand-other", identityStatus: "VERIFIED" });
    } else mocks.campaign.mockResolvedValue({ campaignId: "campaign-a", brandId: "brand-other", campaignStatus: "MNO_PROVISIONED" });
    await expect(refreshTextingUpgradeCarrierStatus("business-a")).rejects.toThrow("identity_mismatch");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it.each(["support_required", "missing", "cancel_requested", "rejected"])("never polls providers for %s", async (state) => {
    if (state === "support_required") mocks.upgrade.mockResolvedValue({ state });
    if (state === "missing") mocks.upgrade.mockResolvedValue(null);
    if (state === "cancel_requested") mocks.canContinue.mockResolvedValue(false);
    if (state === "rejected") snapshot.campaign_status = "rejected";
    expect(await refreshTextingUpgradeCarrierStatus("business-a")).toEqual({ refreshed: false });
    expect(mocks.brand).not.toHaveBeenCalled(); expect(mocks.campaign).not.toHaveBeenCalled();
  });

  it("requires an audit intent before applying provider approval", async () => {
    mocks.audit.mockRejectedValue(new Error("audit unavailable"));
    await expect(refreshTextingUpgradeCarrierStatus("business-a")).rejects.toThrow("audit unavailable");
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it("records brand rejection without polling or replacing the campaign", async () => {
    snapshot.brand_status = "pending";
    mocks.brand.mockResolvedValue({ brandId: "brand-a", identityStatus: "UNVERIFIED", status: "REGISTRATION_FAILED" });
    await refreshTextingUpgradeCarrierStatus("business-a");
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ brand_status: "rejected", onboarding_registration_status: "failed" }));
    expect(mocks.campaign).not.toHaveBeenCalled();
  });
});
