import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Business } from "@/types/database";
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), enabled: vi.fn(), list: vi.fn(), campaign: vi.fn(), brand: vi.fn(), qualify: vi.fn(), submit: vi.fn(),
  phone: vi.fn(), assignment: vi.fn(), move: vi.fn(), numbers: vi.fn(), keywords: vi.fn(), retire: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: mocks.from, rpc: mocks.rpc } }));
vi.mock("./textingUpgradeRollout.server", () => ({ isReviewTextingUpgradeEnabled: mocks.enabled }));
vi.mock("@/lib/messaging/client", () => ({ telnyx: { messaging10dlc: {
  campaign: { list: mocks.list, retrieve: mocks.campaign }, brand: { retrieve: mocks.brand }, campaignBuilder: { submit: mocks.submit, brand: { qualifyByUsecase: mocks.qualify } },
  phoneNumberCampaigns: { retrieve: mocks.assignment, update: mocks.move, list: mocks.numbers },
}, phoneNumbers: { messaging: { retrieve: mocks.phone } } } }));
vi.mock("@/lib/reviews/smsKeywords.server", async importOriginal => ({ ...await importOriginal<object>(), inspectReviewSmsKeywords: mocks.keywords }));
vi.mock("@/lib/messaging/telnyxDestructive", () => ({ retireReviewUpgradeCampaign: mocks.retire }));
vi.mock("@/lib/messaging/registration/riskScreening", () => ({ getA2pRiskClearanceForBusiness: vi.fn() }));
vi.mock("@/lib/reviews/consent.server", () => ({ processReviewTextConsent: vi.fn() }));
import { buildReviewUpgradeFiling, reconcileReviewTextingProvider } from "./reviewTextingProvider.server";
const upgradeId = "10000000-0000-4000-a115-000000000099", businessId = "business", phone = "+15745550123";
const business = { name: "Acme", business_type: "plumbing", email: "support@example.test", phone_number: phone, slug: "acme-test", privacy_terms_mode: "hosted", authorized_rep_email: "help@example.test", telnyx_brand_id: "brand" } as unknown as Business;
let row: Record<string, unknown>, campaigns: Record<string, unknown>[], numberClaims: Record<string, unknown>[], events: string[], candidate: Record<string, unknown>, assignment: Record<string, unknown>;
const recordEvents = () => mocks.rpc.mock.calls.filter(([name]) => name === "review_texting_provider_record").map(([, args]) => args.p_event);
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://simplassist.com"); vi.stubEnv("TELNYX_PROTECTED_MESSAGING_PROFILE_ID", "protected");
  vi.stubEnv("TELNYX_MESSAGING_PROFILE_ID", "shared-protected");
  const filing = buildReviewUpgradeFiling(business, upgradeId, phone);
  row = { upgrade_id: upgradeId, business_id: businessId, owner_id: "owner", review_account_id: "account", stage: "prepared", source_campaign_id: "old", candidate_campaign_id: null,
    brand_id: "brand", messaging_profile_id: "dedicated", phone_number: phone, phone_number_id: "phone-id", filing, filing_hash: "hash", submission_attempted_at: null,
    assignment_attempted_at: null, handoff_requested_at: null, handoff_completed_at: null, retirement_state: "pending", last_error: null };
  candidate = { ...filing, campaignId: "new", campaignStatus: "MNO_ACCEPTED" }; campaigns = []; numberClaims = []; events = [];
  assignment = { phoneNumber: phone, campaignId: "old", assignmentStatus: "ASSIGNED" };
  mocks.enabled.mockReturnValue(true);
  mocks.from.mockImplementation((table: string) => {
    const q: Record<string, unknown> = {};
    for (const method of ["select", "eq", "is", "neq"]) q[method] = () => q;
    q.maybeSingle = q.single = async () => ({ data: table === "review_texting_provider_upgrades" ? { ...row } : table === "phone_numbers" ? { telnyx_phone_number_id: "provider-phone" } : business, error: null });
    return q;
  });
  mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "review_texting_provider_claim") return { data: "claim", error: null };
    if (name === "review_texting_provider_authorize") {
      events.push("authorize:" + args.p_operation);
      if (args.p_operation === "submit") { row.submission_attempted_at = "2026-10-04T00:00:00Z"; row.stage = "submitting"; }
      if (args.p_operation === "move") row.assignment_attempted_at = "2026-10-04T00:00:00Z";
      return { data: true, error: null };
    }
    if (name === "review_texting_provider_record") {
      events.push(String(args.p_event));
      const evidence = args.p_evidence as Record<string, unknown>;
      if (args.p_event === "submitted") { row.stage = "carrier_pending"; row.candidate_campaign_id = evidence.campaignId; }
      if (args.p_event === "approved") row.stage = "approved";
      if (args.p_event === "bound") { row.stage = "review_ready"; row.handoff_completed_at = "2026-10-04T00:00:00Z"; }
      if (args.p_event === "support") { row.stage = "support_required"; row.last_error = evidence.reason; }
      if (args.p_event === "retired") row.retirement_state = "done";
    }
    return { data: null, error: null };
  });
  mocks.list.mockImplementation(async function* () { yield* campaigns; });
  mocks.numbers.mockImplementation(async function* () { yield* numberClaims; });
  mocks.brand.mockResolvedValue({ identityStatus: "VERIFIED" }); mocks.qualify.mockResolvedValue({ usecase: "MIXED", minSubUsecases: 2, maxSubUsecases: 2 });
  mocks.submit.mockImplementation(async () => { events.push("http:submit"); return candidate; });
  mocks.campaign.mockImplementation(async () => candidate); mocks.keywords.mockResolvedValue({ ready: true });
  mocks.phone.mockResolvedValue({ data: { phone_number: phone, messaging_profile_id: "dedicated" } });
  mocks.assignment.mockImplementation(async () => ({ ...assignment }));
  mocks.move.mockImplementation(async () => { events.push("http:move"); return { phoneNumber: phone, campaignId: "new", assignmentStatus: "ASSIGNED" }; });
  mocks.retire.mockImplementation(async () => { events.push("http:retire"); });
});
afterEach(() => vi.unstubAllEnvs());
const run = () => reconcileReviewTextingProvider(upgradeId);
function moving() { Object.assign(row, { stage: "moving", candidate_campaign_id: "new", submission_attempted_at: "2026-10-03T00:00:00Z", handoff_requested_at: "2026-10-04T00:00:00Z" }); }
function ready() { moving(); Object.assign(row, { stage: "review_ready", handoff_completed_at: "2026-10-04T00:01:00Z" }); assignment.campaignId = "new"; }
describe("review campaign provider reconciliation", () => {
  it("durably authorizes once before paid submission and never silently retries HTTP", async () => {
    await run(); expect(row.stage).toBe("approved"); expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(row.filing, { maxRetries: 0, timeout: 10000 });
    expect(events.indexOf("authorize:submit")).toBeLessThan(events.indexOf("http:submit")); expect(row.submission_attempted_at).toBeTruthy();
    await run(); expect(mocks.submit).toHaveBeenCalledTimes(1); expect(mocks.move).not.toHaveBeenCalled();
    expect(recordEvents().filter(event => event === "release_claim")).toHaveLength(2);
  });
  it("recovers a lost submission response by exact reference without another paid submission", async () => {
    mocks.submit.mockRejectedValueOnce(new Error("response lost"));
    await expect(run()).rejects.toThrow("response lost"); expect(row.submission_attempted_at).toBeTruthy(); expect(row.stage).toBe("submitting");
    campaigns = [candidate]; await run();
    expect(row.stage).toBe("approved"); expect(mocks.submit).toHaveBeenCalledTimes(1); expect(recordEvents()).toContain("release_claim");
  });
  it("holds unknown submission for support when the previously authorized outcome cannot be recovered", async () => {
    Object.assign(row, { stage: "submitting", submission_attempted_at: "2026-10-04T00:00:00Z" });
    await run(); expect(row).toMatchObject({ stage: "support_required", last_error: "review_upgrade_submission_unknown" }); expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("never resubmits when two candidates claim the operation reference", async () => {
    campaigns = [candidate, { ...candidate, campaignId: "duplicate" }]; await run();
    expect(row.last_error).toBe("review_upgrade_duplicate_candidate"); expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("continues recovery of an already-authorized frozen filing after rollout is disabled", async () => {
    mocks.enabled.mockReturnValue(false); Object.assign(row, { stage: "carrier_pending", candidate_campaign_id: "new", submission_attempted_at: "2026-10-03T00:00:00Z" });
    await run(); expect(row.stage).toBe("approved"); expect(mocks.submit).not.toHaveBeenCalled(); expect(mocks.move).not.toHaveBeenCalled();
  });
  it("does not send when the durable provider authorization denies submission", async () => {
    const original = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation((name, args) => name === "review_texting_provider_authorize" ? Promise.resolve({ data: false, error: null }) : original(name, args));
    await run(); expect(mocks.submit).not.toHaveBeenCalled(); expect(recordEvents()).toEqual(["release_claim"]);
  });
  it("requires explicit move state and fresh assignment retrieval instead of trusting PUT", async () => {
    moving(); await run();
    expect(events.indexOf("authorize:move")).toBeLessThan(events.indexOf("http:move"));
    expect(mocks.move).toHaveBeenCalledExactlyOnceWith(phone, { phoneNumber: phone, campaignId: "new" }, { maxRetries: 0, timeout: 10000 });
    expect(row.stage).toBe("moving"); expect(recordEvents()).not.toContain("bound"); expect(mocks.retire).not.toHaveBeenCalled();
    assignment.campaignId = "new"; await run(); expect(row.stage).toBe("review_ready"); expect(mocks.move).toHaveBeenCalledTimes(1);
    expect(events.indexOf("bound")).toBeLessThan(events.indexOf("http:retire"));
  });
  it("does not repeat or roll back a PUT when subsequent reads still report the old ASSIGNED campaign", async () => {
    moving(); await run(); await run();
    expect(row.stage).toBe("moving"); expect(row.assignment_attempted_at).toBeTruthy(); expect(row.handoff_completed_at).toBeNull();
    expect(mocks.move).toHaveBeenCalledTimes(1); expect(recordEvents()).not.toContain("bound"); expect(mocks.retire).not.toHaveBeenCalled();
  });
  it.each([{ subUsecases: null }, { sample5: "unexpected copy" }, { referenceId: "upgrade:other" }])("blocks reassignment for a malformed or unbound candidate", patch => {
    moving(); Object.assign(candidate, patch);
    return run().then(() => { expect(row.last_error).toBe("review_upgrade_campaign_mismatch"); expect(mocks.move).not.toHaveBeenCalled(); expect(mocks.retire).not.toHaveBeenCalled(); });
  });
  it("keeps the pause and requires support after assignment failure", async () => {
    moving(); row.assignment_attempted_at = "2026-10-04T00:00:00Z"; assignment.assignmentStatus = "FAILED_ASSIGNMENT";
    await run(); expect(row.last_error).toBe("review_upgrade_assignment_failed"); expect(row.handoff_completed_at).toBeNull(); expect(mocks.move).not.toHaveBeenCalled(); expect(mocks.retire).not.toHaveBeenCalled();
  });
  it("will not retire the previous campaign until the exact new phone binding is freshly confirmed", async () => {
    ready(); assignment.phoneNumber = "+15745559999"; await run(); expect(mocks.retire).not.toHaveBeenCalled();
  });
  it.each(["campaignId", "telnyxCampaignId"])("retains the previous campaign while any provider number still claims it via %s", async key => {
    ready(); numberClaims = [{ phoneNumber: "+15745559999", [key]: "old" }];
    await run(); expect(mocks.retire).not.toHaveBeenCalled(); expect(row.retirement_state).toBe("pending");
  });
  it("retires only through the scoped permit after exact binding and zero previous campaign number claims", async () => {
    ready(); numberClaims = [{ phoneNumber: phone, campaignId: "new" }]; await run();
    expect(mocks.retire).toHaveBeenCalledExactlyOnceWith({ upgradeId, claimToken: "claim", campaignId: "old" });
    expect(row.retirement_state).toBe("done"); expect(recordEvents()).toContain("retired");
  });
  it("keeps retirement pending when the destructive permit was denied", async () => {
    ready(); mocks.retire.mockRejectedValue(new Error("not authorized")); await run();
    expect(row.retirement_state).toBe("pending"); expect(recordEvents()).not.toContain("retirement_unknown");
  });
  it("does not blindly retry an uncertain retirement outcome", async () => {
    ready(); row.retirement_state = "unknown"; await run(); expect(mocks.retire).not.toHaveBeenCalled();
  });
});
