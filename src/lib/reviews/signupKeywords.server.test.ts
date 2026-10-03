import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), retrieve: vi.fn(), ensure: vi.fn(), enabled: vi.fn(), program: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: mocks.from, rpc: mocks.rpc } }));
vi.mock("@/lib/messaging/client", () => ({ telnyx: { messagingProfiles: { retrieve: mocks.retrieve } } }));
vi.mock("@/lib/billing/reviewSmsRollout.server", () => ({ isReviewSmsEnabled: mocks.enabled }));
vi.mock("./smsKeywords.server", () => ({ ensureReviewSmsKeywords: mocks.ensure, keywordProgramFromCampaign: mocks.program }));
import { ensureSignupReviewSmsKeywords } from "./signupKeywords.server";

const businessId = "10000000-0000-4000-a105-000000000001";
const profileId = "40000000-0000-4000-a105-000000000001";
const copy = { optinKeywords: "REVIEWS", optinMessage: "Review consent confirmed", optoutKeywords: "STOP", optoutMessage: "Stopped", helpKeywords: "HELP", helpMessage: "Contact the business" };
let business: Record<string, unknown>;
let event: unknown;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("REVIEWS_SMS_PROVISIONING_ENABLED", "1");
  vi.stubEnv("TELNYX_PROTECTED_MESSAGING_PROFILE_ID", "platform-profile");
  business = { id: businessId, owner_id: "owner", name: "Northstar", created_at: "2026-10-03T10:00:00Z", review_sms_signup_enabled: true, telnyx_campaign_id: null, telnyx_messaging_profile_id: profileId, deleted_at: null, operations_suspended_at: null, telnyx_submission_disabled: false };
  event = { id: "audit-event" };
  mocks.enabled.mockReturnValue(true);
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  mocks.from.mockImplementation((table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "gte", "limit"]) query[method] = vi.fn(() => query);
    const finish = async () => ({ data: table === "businesses" ? { ...business } : table === "phone_numbers" ? { phone_number: "+15745550111" } : event, error: null });
    query.single = vi.fn(finish); query.maybeSingle = vi.fn(finish);
    return query;
  });
  mocks.retrieve.mockResolvedValue({ data: { id: profileId, name: `Northstar (${businessId})`, created_at: "2026-10-03T10:05:00Z" } });
  mocks.program.mockReturnValue({ program: "isolated" });
  mocks.ensure.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("new signup keyword resource ownership", () => {
  it("authorizes only the new tenant profile and rechecks before every mutation", async () => {
    await ensureSignupReviewSmsKeywords(businessId, copy);
    expect(mocks.program).toHaveBeenCalledWith(copy, "Northstar");
    const options = mocks.ensure.mock.calls[0][0];
    expect(options).toMatchObject({ businessId, profileId });
    await options.authorizeMutation();
    expect(mocks.retrieve).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenCalledWith("review_sms_resource_scope_safe", expect.objectContaining({ p_campaign: null, p_profile: profileId, p_forbidden_profiles: ["platform-profile"] }));
  });

  it.each([{ telnyx_campaign_id: "existing-campaign" }, { review_sms_signup_enabled: false }, { operations_suspended_at: "2026-10-03T11:00:00Z" }])("does not rewrite an existing or unavailable program %j", async (patch) => {
    Object.assign(business, patch);
    await expect(ensureSignupReviewSmsKeywords(businessId, copy)).rejects.toMatchObject({ code: "review_sms_keyword_profile_not_owned" });
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("rejects a newly written recovery audit for an older provider profile", async () => {
    mocks.retrieve.mockResolvedValue({ data: { id: profileId, name: `Northstar (${businessId})`, created_at: "2026-10-02T10:00:00Z" } });
    await expect(ensureSignupReviewSmsKeywords(businessId, copy)).rejects.toMatchObject({ code: "review_sms_keyword_profile_not_owned" });
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("fails closed without the creation audit or resource isolation proof", async () => {
    event = null;
    await expect(ensureSignupReviewSmsKeywords(businessId, copy)).rejects.toMatchObject({ code: "review_sms_keyword_profile_not_owned" });
    event = { id: "audit" };
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    await expect(ensureSignupReviewSmsKeywords(businessId, copy)).rejects.toMatchObject({ code: "review_sms_resource_scope_denied" });
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("stops a mutation after an owner or campaign changes", async () => {
    await ensureSignupReviewSmsKeywords(businessId, copy);
    const options = mocks.ensure.mock.calls[0][0];
    business.owner_id = "another-owner";
    await expect(options.authorizeMutation()).rejects.toMatchObject({ code: "review_sms_keyword_profile_not_owned" });
    business.owner_id = "owner";
    business.telnyx_campaign_id = "concurrent-campaign";
    await expect(options.authorizeMutation()).rejects.toMatchObject({ code: "review_sms_keyword_profile_not_owned" });
  });

  it("honors rollback switches before provider access", async () => {
    vi.stubEnv("REVIEWS_SMS_PROVISIONING_ENABLED", "0");
    await expect(ensureSignupReviewSmsKeywords(businessId, copy)).rejects.toMatchObject({ code: "review_sms_provisioning_stopped" });
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
});
