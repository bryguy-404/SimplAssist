import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), retrieve: vi.fn(), list: vi.fn(), campaign: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: m.from, rpc: m.rpc } }));
vi.mock("@/lib/messaging/client", () => ({ telnyx: { messaging10dlc: { brand: { retrieve: m.retrieve }, campaign: { list: m.list, retrieve: m.campaign } } } }));
import {
  sharedRegistrationPilotEnabled, validateSharedRegistrationProof, assertSharedRegistrationForNewStart,
  consumeSharedReviewRegistration, approveSharedRegistration, inspectSharedRegistration, reserveSharedCampaignSubmission, settleSharedCampaignSubmission,
} from "./sharedBusinessRegistrations.server";
const source = "ea848911-ef72-44a6-8cf3-c47b3959be26", target = "10000000-0000-4000-8000-000000000116", owner = "20000000-0000-4000-8000-000000000116";
const brand = "4b20019d-e93e-d697-b8ee-c6233e9bf533";
const identity = { ein: "12-3456789", legal_business_name: "Example LLC", business_entity_type: "llc", business_registration_state: "IN", address: "123 Private Street", city: "South Bend", state: "IN", zip: "46601" };
const proof = { registrationId: "registration", identityVersion: 1, membershipRevision: 1, brandId: brand };
const input = { sourceBusinessId: source, targetBusinessId: target, sourceOwnerId: owner, targetOwnerId: owner };
const providerBrand = { brandId: brand, tcrBrandId: "BTCR", ein: identity.ein, companyName: identity.legal_business_name, entityType: "PRIVATE_PROFIT", street: identity.address, city: identity.city, state: "IN", postalCode: "46601", country: "US", status: "OK", identityStatus: "VERIFIED", mock: false, assignedCampaignsCount: 2 };
let rows: Record<string, unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SHARED_REGISTRATION_ADMISSIONS_ENABLED", "true");
  vi.stubEnv("SHARED_REGISTRATION_PAID_STARTS_ENABLED", "true");
  vi.stubEnv("SHARED_REGISTRATION_PILOT_BUSINESS_IDS", `${source},${target}`);
  rows = {
    shared_business_registration_members: { business_id: target, registration_id: "registration", owner_id: owner, identity_version: 1, revision: 1, state: "approved" },
    shared_business_registrations: { id: "registration", legal_identity: identity, identity_version: 1, telnyx_brand_id: brand, tcr_brand_id: "BTCR", status: "active", brand_status: "approved" },
    shared_brand_campaign_reservations: [],
  };
  m.from.mockImplementation((table: string) => {
    const filters: Record<string, unknown> = {};
    const q = {
      select: () => q, eq: (k: string, v: unknown) => { filters[k] = v; return q; },
      maybeSingle: async () => result(), single: async () => result(),
      then: (resolve: (value: unknown) => void) => Promise.resolve(result()).then(resolve),
    };
    function result() {
      const data = table === "businesses" ? { ...identity, id: filters.id, owner_id: owner, name: "Example", has_ein: true, shared_registration_id: rows.ordinary ? null : "registration", telnyx_brand_id: brand, deleted_at: null, operations_suspended_at: null, telnyx_submission_disabled: false } : rows[table];
      return { data, error: null };
    }
    return q;
  });
  m.retrieve.mockResolvedValue(providerBrand);
  m.list.mockImplementation(() => ({ async *[Symbol.asyncIterator]() { yield { campaignId: "one", brandId: brand }; yield { campaignId: "two", brandId: brand }; } }));
  m.rpc.mockResolvedValue({ data: true, error: null });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
describe("private shared registration", () => {
  it("requires an exact two-business allowlist and never accepts wildcard/deleted membership", () => {
    expect(sharedRegistrationPilotEnabled(target, "admission")).toBe(true);
    for (const ids of ["*", `${source},*`, `${source},${target},30000000-0000-4000-8000-000000000116`, `${source},aa30a10e-13c1-4c9b-b9d5-6804cf01e6cb`]) {
      vi.stubEnv("SHARED_REGISTRATION_PILOT_BUSINESS_IDS", ids);
      expect(sharedRegistrationPilotEnabled(target, "admission")).toBe(false);
    }
  });
  it("leaves ordinary accounts on the ordinary path", async () => {
    rows.shared_business_registration_members = null;
    rows.ordinary = true;
    expect(await assertSharedRegistrationForNewStart({ businessId: target, ownerId: owner })).toBeNull();
    expect(m.retrieve).not.toHaveBeenCalled();
  });
  it("never treats a missing membership on a shared business as an ordinary paid setup", async () => {
    rows.shared_business_registration_members = null;
    await expect(assertSharedRegistrationForNewStart({ businessId: target, ownerId: owner })).rejects.toMatchObject({ code: "shared_membership_missing" });
    expect(m.retrieve).not.toHaveBeenCalled(); expect(m.rpc).not.toHaveBeenCalled();
  });
  it("separates new paid starts from recovery", async () => {
    vi.stubEnv("SHARED_REGISTRATION_PAID_STARTS_ENABLED", "false");
    await expect(assertSharedRegistrationForNewStart({ businessId: target, ownerId: owner, proof })).rejects.toMatchObject({ code: "shared_paid_starts_disabled" });
    expect(await validateSharedRegistrationProof({ businessId: target, ownerId: owner, proof })).not.toBeNull();
  });
  it("rejects changed approval and owner evidence before provider work", async () => {
    await expect(validateSharedRegistrationProof({ businessId: target, ownerId: owner, proof: { ...proof, membershipRevision: 2 } })).rejects.toMatchObject({ code: "shared_registration_proof_changed" });
    await expect(validateSharedRegistrationProof({ businessId: target, ownerId: "another", proof })).rejects.toMatchObject({ code: "shared_registration_changed" });
    expect(m.retrieve).not.toHaveBeenCalled();
  });
  it("counts unknown campaign attempts before offering a charge", async () => {
    rows.shared_brand_campaign_reservations = [{ provider_campaign_id: null }, { provider_campaign_id: null }, { provider_campaign_id: null }];
    await expect(assertSharedRegistrationForNewStart({ businessId: target, ownerId: owner, proof })).rejects.toMatchObject({ code: "shared_campaign_capacity_exhausted" });
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("does not charge or mutate during inspection and returns no private address or EIN", async () => {
    const inspected = await inspectSharedRegistration(input);
    expect(inspected).toMatchObject({ canApprove: true, membershipRevision: 1, campaignCount: 2 });
    expect(JSON.stringify(inspected)).not.toContain(identity.ein);
    expect(JSON.stringify(inspected)).not.toContain(identity.address);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("requires current expected revision before administrative approval", async () => {
    await expect(approveSharedRegistration({ ...input, actorId: owner, expectedRevision: 0 })).rejects.toMatchObject({ code: "shared_membership_revision_changed" });
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("binds using the exact paid claim without a provider create", async () => {
    await consumeSharedReviewRegistration({ businessId: target, ownerId: owner, reviewAccountId: "review", claimToken: "lease", proof });
    expect(m.rpc).toHaveBeenCalledWith("consume_shared_review_brand_member", expect.objectContaining({ p_review_account: "review", p_claim: "lease", p_expected_registration: "registration", p_expected_membership_revision: 1 }));
  });
  it("preserves the database once-only campaign submission decision", async () => {
    (rows.shared_business_registration_members as Record<string, unknown>).state = "active";
    m.rpc.mockResolvedValue({ data: { id: "reservation", submit: false, provider_campaign_id: null }, error: null });
    expect(await reserveSharedCampaignSubmission({ businessId: target, operationId: "review", referenceId: "reviews:review", purpose: "review_initial", payloadHash: "frozen", claimToken: "lease" })).toEqual({ id: "reservation", submit: false, providerCampaignId: null });
  });
  it("does not bind a campaign recovered from another reference", async () => {
    rows.shared_brand_campaign_reservations = { reference_id: "reviews:review" };
    m.campaign.mockResolvedValue({ campaignId: "candidate", brandId: brand, referenceId: "reviews:another" });
    await expect(settleSharedCampaignSubmission({ businessId: target, reservationId: "reservation", payloadHash: "frozen", outcome: "accepted", providerCampaignId: "candidate" })).rejects.toMatchObject({ code: "shared_campaign_evidence_mismatch" });
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it.each([
    { street: "456 Different Street" },
    { city: "Another City" },
    { companyName: "Different LLC" },
    { ein: "98-7654321" },
    { tcrBrandId: "DIFFERENT" },
    { brandId: "90000000-0000-4000-8000-000000000116" },
    { mock: true },
    { country: "CA" },
  ])("holds the canonical registration after a complete identity mismatch: %j", async mismatch => {
    vi.useFakeTimers();
    const observedAt = "2026-10-05T12:00:00.000Z";
    vi.setSystemTime(observedAt);
    m.retrieve.mockImplementationOnce(async () => {
      vi.setSystemTime("2026-10-05T12:00:08.000Z");
      return { ...providerBrand, ...mismatch };
    });
    await expect(assertSharedRegistrationForNewStart({ businessId: target, ownerId: owner, proof }))
      .rejects.toMatchObject({ code: "shared_provider_identity_not_verified" });
    expect(m.rpc).toHaveBeenCalledExactlyOnceWith("hold_shared_brand_identity", { p_brand_id: brand, p_observed_at: observedAt });
    expect(m.list).not.toHaveBeenCalled();
  });
  it.each([
    { mock: undefined }, { mock: "false" }, { tcrBrandId: undefined },
    { ein: undefined }, { street: undefined }, { entityType: "UNKNOWN" },
  ])("rejects incomplete evidence without persisting an identity hold: %j", async incomplete => {
    m.retrieve.mockResolvedValueOnce({ ...providerBrand, companyName: "Different LLC", ...incomplete });
    await expect(assertSharedRegistrationForNewStart({ businessId: target, ownerId: owner, proof }))
      .rejects.toMatchObject({ code: "shared_provider_identity_not_verified" });
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("does not persist an identity hold when first admission has no canonical registration", async () => {
    rows.ordinary = true;
    rows.shared_business_registration_members = null;
    m.retrieve.mockResolvedValueOnce({ ...providerBrand, companyName: "Different LLC" });
    await expect(inspectSharedRegistration(input)).rejects.toMatchObject({ code: "shared_provider_identity_not_verified" });
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it.each([
    { companyName: "Different LLC" }, { tcrBrandId: "DIFFERENT" }, { status: "SUSPENDED" },
  ])("keeps administrative inspection read-only for an existing canonical registration: %j", async changed => {
    m.retrieve.mockResolvedValueOnce({ ...providerBrand, ...changed });
    await expect(inspectSharedRegistration(input)).rejects.toMatchObject({ code: "shared_provider_identity_not_verified" });
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it.each([
    { status: "REGISTRATION_FAILED", identityStatus: "VERIFIED", expected: "rejected" },
    { status: "SUSPENDED", identityStatus: "VERIFIED", expected: "rejected" },
    { status: "REGISTRATION_PENDING", identityStatus: "UNVERIFIED", expected: "pending" },
  ])("atomically closes the shared gate for an observed $status before a paid claim can bind", async ({ expected, ...status }) => {
    vi.useFakeTimers();
    const observedAt = "2026-10-05T12:00:00.000Z";
    vi.setSystemTime(observedAt);
    m.retrieve.mockImplementationOnce(async () => {
      vi.setSystemTime("2026-10-05T12:00:08.000Z");
      return { ...providerBrand, ...status };
    });
    await expect(consumeSharedReviewRegistration({ businessId: target, ownerId: owner, reviewAccountId: "review", claimToken: "lease", proof }))
      .rejects.toMatchObject({ code: "shared_provider_identity_not_verified" });
    expect(m.rpc).toHaveBeenCalledExactlyOnceWith("apply_shared_brand_event", {
      p_brand_id: brand, p_event_id: expect.stringMatching(/^inspection:registration:/),
      p_occurred_at: observedAt, p_status: expected,
      p_rejection_reason: expected === "rejected" ? "Carrier registration is not approved." : null,
    });
  });
  it("does not interpret an unknown carrier status as a durable rejection", async () => {
    m.retrieve.mockResolvedValueOnce({ ...providerBrand, status: "FUTURE_STATUS" });
    await expect(assertSharedRegistrationForNewStart({ businessId: target, ownerId: owner, proof }))
      .rejects.toMatchObject({ code: "shared_provider_identity_not_verified" });
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("fails closed without changing shared state after a provider outage", async () => {
    m.retrieve.mockRejectedValueOnce(new Error("timeout"));
    await expect(assertSharedRegistrationForNewStart({ businessId: target, ownerId: owner, proof }))
      .rejects.toMatchObject({ code: "shared_provider_unavailable", status: 503 });
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("does not bind a paid claim when the atomic negative-status update fails", async () => {
    m.retrieve.mockResolvedValueOnce({ ...providerBrand, status: "SUSPENDED" });
    m.rpc.mockResolvedValueOnce({ data: null, error: { message: "database unavailable" } });
    await expect(consumeSharedReviewRegistration({ businessId: target, ownerId: owner, reviewAccountId: "review", claimToken: "lease", proof }))
      .rejects.toMatchObject({ code: "shared_registration_unavailable", status: 503 });
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.rpc.mock.calls[0][0]).toBe("apply_shared_brand_event");
  });
  it("never proceeds when a stale mismatch could not establish its identity hold", async () => {
    m.retrieve.mockResolvedValueOnce({ ...providerBrand, companyName: "Different LLC" });
    m.rpc.mockResolvedValueOnce({ data: false, error: null });
    await expect(assertSharedRegistrationForNewStart({ businessId: target, ownerId: owner, proof }))
      .rejects.toMatchObject({ code: "shared_registration_identity_hold_failed", status: 503 });
    expect(m.list).not.toHaveBeenCalled();
  });
});
