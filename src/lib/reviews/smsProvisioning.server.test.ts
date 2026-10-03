import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  account: vi.fn(),
  campaign: vi.fn(),
  brand: vi.fn(),
  register: vi.fn(),
  profile: vi.fn(),
  voice: vi.fn(),
  phone: vi.fn(),
  inspectKeywords: vi.fn(),
  ensureKeywords: vi.fn(),
  keywordProgram: vi.fn(),
  providerProfile: vi.fn(),
  profileOwnership: true,
  business: {} as Record<string, unknown>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    rpc: mocks.rpc,
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "update", "eq", "is", "gte", "limit"])
        chain[method] = () => chain;
      chain.maybeSingle = chain.single = async () => ({
        data:
          table === "businesses"
            ? mocks.business
            : table === "phone_numbers"
              ? { id: "phone-id", phone_number: "+15745550111" }
              : table === "telnyx_registration_events" && mocks.profileOwnership
                ? { id: "profile-created-event" }
                : null,
        error: null,
      });
      return chain;
    },
  },
}));
vi.mock("@/lib/stripe/reviewSms.server", () => ({
  readReviewSmsAccount: mocks.account,
}));
vi.mock("./smsKeywords.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./smsKeywords.server")>()),
  inspectReviewSmsKeywords: mocks.inspectKeywords,
  ensureReviewSmsKeywords: mocks.ensureKeywords,
  keywordProgramFromCampaign: mocks.keywordProgram,
}));
vi.mock("@/lib/messaging/client", () => ({
  telnyx: {
    messagingProfiles: { retrieve: mocks.providerProfile },
    messaging10dlc: {
      brand: { retrieve: mocks.brand },
      campaign: { retrieve: mocks.campaign },
    },
  },
}));
vi.mock("@/lib/messaging/registration", () => ({
  registerBrand: mocks.register,
  createMessagingProfile: mocks.profile,
  createVoiceApplication: mocks.voice,
}));
vi.mock("@/lib/messaging/numbers", () => ({
  purchaseNumber: mocks.phone,
  findOwnedNumberId: vi.fn(),
  attachOwnedNumberToCustomerProfile: vi.fn(),
  isNanpTollFreeNumber: () => false,
}));
vi.mock("@/lib/messaging/registration/providerCreateIntent", () => ({
  resolveProviderCreateIntents: vi.fn(),
}));
vi.mock("@/lib/messaging/registration/riskScreening", () => ({
  getA2pRiskClearanceForBusiness: async () => ({ cleared: true }),
  screenA2pRiskForBusiness: vi.fn(),
}));
vi.mock("@/lib/onboarding/rejectionGuard.server", () => ({
  assertNoCarrierRejectionForBusiness: vi.fn(),
}));
vi.mock("@/lib/messaging/registration/phoneNumberAssignment", () => ({
  ensureCampaignAssignmentForBusiness: vi.fn(),
}));
vi.mock("@/lib/messaging/lookup", () => ({
  getSmsReadinessForBusiness: async () => ({ smsReady: true }),
}));
vi.mock("@/lib/messaging/registration/legalUrls", () => ({
  resolveLegalUrls: () => ({
    privacyUrl: "https://example.test/privacy",
    termsUrl: "https://example.test/terms",
  }),
}));
import {
  approveExistingReviewSmsUsecase,
  continueReviewSmsProvisioning,
  refreshReviewSmsProviderReadiness,
} from "./smsProvisioning.server";
const businessId = "10000000-0000-4000-a100-000000000001",
  adminId = "00000000-0000-4000-a100-000000000002";
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SIMPLASSIST_ADMIN_USER_IDS", adminId);
  vi.stubEnv("REVIEWS_SMS_ENABLED", "1");
  vi.stubEnv("REVIEWS_SMS_PILOT_BUSINESS_IDS", businessId);
  vi.stubEnv("REVIEWS_SMS_PROVISIONING_ENABLED", "1");
  vi.stubEnv("TELNYX_PROTECTED_MESSAGING_PROFILE_ID", "protected-profile");
  mocks.profileOwnership = true;
  mocks.inspectKeywords.mockResolvedValue({ ready: true, issues: [] });
  mocks.ensureKeywords.mockResolvedValue(undefined);
  mocks.providerProfile.mockResolvedValue({
    data: {
      id: "tenant-profile",
      name: `Example LLC (${businessId})`,
      created_at: "2026-01-02T00:00:00Z",
    },
  });
  mocks.business = {
    id: businessId,
    name: "Example LLC",
    owner_id: "owner",
    telnyx_brand_id: "brand",
    telnyx_campaign_id: "campaign",
    telnyx_messaging_profile_id: "tenant-profile",
    legal_business_name: "Example LLC",
    business_entity_type: "llc",
    ein: "123456789",
    address: "123 Main Street",
    city: "Chicago",
    state: "IL",
    zip: "60601",
    authorized_rep_name: "Owner Name",
    authorized_rep_email: "owner@example.test",
    authorized_rep_phone: "+15745550111",
    has_ein: true,
    compliance_info_completed_at: "2026-01-01",
  };
  mocks.account.mockResolvedValue({
    id: "account",
    business_id: businessId,
    owner_id: "owner",
    state: "draft",
    billing_source: "included",
    draft: {
      phoneNumber: "+15745550111",
      consentDescription: "Customer provided permission for review texts",
      consentEvidenceUrl: "https://example.test/consent",
    },
  });
  mocks.campaign.mockResolvedValue({
    brandId: "brand",
    usecase: "MARKETING",
    embeddedLink: true,
    campaignStatus: "MNO_PROVISIONED",
  });
  mocks.rpc.mockResolvedValue({ data: true, error: null });
});
afterEach(() => vi.unstubAllEnvs());
describe("review SMS provider authority", () => {
  it("does not poll or assign carrier readiness when provisioning is stopped", async () => {
    vi.stubEnv("REVIEWS_SMS_PROVISIONING_ENABLED", "0");
    await refreshReviewSmsProviderReadiness(businessId);
    expect(mocks.account).not.toHaveBeenCalled();
    expect(mocks.campaign).not.toHaveBeenCalled();
  });
  it("rejects non-admin approval before any provider lookup", async () => {
    await expect(
      approveExistingReviewSmsUsecase(
        businessId,
        "other",
        "Carrier approved this exact review program",
      ),
    ).rejects.toMatchObject({ code: "review_sms_approval_forbidden" });
    expect(mocks.campaign).not.toHaveBeenCalled();
  });
  it("does not invent review marketing approval from generic customer-care approval", async () => {
    mocks.campaign.mockResolvedValue({
      brandId: "brand",
      usecase: "CUSTOMER_CARE",
      campaignStatus: "MNO_PROVISIONED",
    });
    await expect(
      approveExistingReviewSmsUsecase(
        businessId,
        adminId,
        "Carrier approved this exact review program",
      ),
    ).rejects.toMatchObject({ code: "review_sms_carrier_approval_required" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("cannot turn a paid active item into an unbilled grant", async () => {
    mocks.account.mockResolvedValue({
      billing_source: "direct",
      state: "active",
      stripe_item_id: "si_paid",
    });
    await expect(
      approveExistingReviewSmsUsecase(
        businessId,
        adminId,
        "Carrier approved this exact review program",
        "2099-01-01T00:00:00Z",
      ),
    ).rejects.toMatchObject({
      code: "review_sms_paid_account_cannot_be_granted",
    });
    expect(mocks.campaign).not.toHaveBeenCalled();
  });
  it("accepts an actually approved mixed campaign with explicit marketing coverage", async () => {
    mocks.campaign.mockResolvedValue({
      brandId: "brand",
      usecase: "MIXED",
      subUsecases: ["CUSTOMER_CARE", "MARKETING"],
      embeddedLink: true,
      campaignStatus: "MNO_PROVISIONED",
    });
    await approveExistingReviewSmsUsecase(
      businessId,
      adminId,
      "Carrier approved this exact review program",
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "review_sms_record_existing_approval",
      expect.anything(),
    );
  });
  it.each([undefined, ["CUSTOMER_CARE", "ACCOUNT_NOTIFICATION"]])(
    "rejects mixed campaigns without explicit marketing sub-usecase: %s",
    async (subUsecases) => {
      mocks.campaign.mockResolvedValue({
        brandId: "brand",
        usecase: "MIXED",
        subUsecases,
        campaignStatus: "MNO_PROVISIONED",
      });
      await expect(
        approveExistingReviewSmsUsecase(
          businessId,
          adminId,
          "Carrier approved this exact review program",
        ),
      ).rejects.toMatchObject({ code: "review_sms_carrier_approval_required" });
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );
  it("requires atomic protected-resource approval after provider proof", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: "review_sms_approval_not_authorized" },
    });
    await expect(
      approveExistingReviewSmsUsecase(
        businessId,
        adminId,
        "Carrier approved this exact review program",
      ),
    ).rejects.toMatchObject({ code: "review_sms_approval_not_authorized" });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "review_sms_record_existing_approval",
      expect.objectContaining({
        p_campaign: "campaign",
        p_forbidden_profiles: ["protected-profile"],
      }),
    );
  });
  it("does not approve existing campaign until runtime keywords are verified", async () => {
    mocks.inspectKeywords.mockResolvedValue({
      ready: false,
      issues: ["missing_info"],
    });
    await expect(
      approveExistingReviewSmsUsecase(
        businessId,
        adminId,
        "Carrier approved this exact review program",
      ),
    ).rejects.toMatchObject({ code: "review_sms_keywords_not_ready" });
    expect(mocks.ensureKeywords).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([false, undefined])(
    "does not approve a campaign without declared embedded links: %s",
    async (embeddedLink) => {
      mocks.campaign.mockResolvedValue({
        brandId: "brand",
        usecase: "MARKETING",
        campaignStatus: "MNO_PROVISIONED",
        embeddedLink,
      });
      await expect(
        approveExistingReviewSmsUsecase(
          businessId,
          adminId,
          "Carrier approved this exact review program",
        ),
      ).rejects.toMatchObject({ code: "review_sms_carrier_approval_required" });
      expect(mocks.inspectKeywords).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );
  it("cannot mark a review-owned sender ready without approved embedded links", async () => {
    mocks.account.mockResolvedValue({
      id: "account",
      campaign_id: "campaign",
      provider_submitted_at: "2026-01-01T00:00:00Z",
      state: "carrier_pending",
    });
    mocks.campaign.mockResolvedValue({
      brandId: "brand",
      usecase: "MARKETING",
      referenceId: "reviews:account",
      campaignStatus: "MNO_PROVISIONED",
      embeddedLink: false,
    });
    await expect(
      refreshReviewSmsProviderReadiness(businessId),
    ).rejects.toMatchObject({ code: "review_sms_campaign_mismatch" });
    expect(mocks.inspectKeywords).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "never rewrites a profile without both exclusive resources and a creation event (exclusive=%s)",
    async (exclusive) => {
      mocks.profileOwnership = false;
      mocks.account.mockResolvedValue({
        id: "account",
        business_id: businessId,
        owner_id: "owner",
        state: "carrier_pending",
        billing_source: "direct",
        exclusive_resources: exclusive,
        created_at: "2026-01-01T00:00:00Z",
        draft: {
          phoneNumber: "+15745550111",
          consentDescription: "Customer permission",
          consentEvidenceUrl: "https://example.test/consent",
        },
      });
      mocks.rpc.mockImplementation(async (name: string) => ({
        data: name === "review_sms_claim_provisioning" ? "claim" : true,
        error: null,
      }));
      mocks.brand.mockResolvedValue({
        identityStatus: "VERIFIED",
        status: "OK",
      });
      await expect(
        continueReviewSmsProvisioning(businessId),
      ).rejects.toMatchObject({
        code: "review_sms_keyword_profile_not_owned",
      });
      expect(mocks.ensureKeywords).not.toHaveBeenCalled();
      expect(mocks.phone).not.toHaveBeenCalled();
    },
  );
  it("does not treat recovery of an older provider profile as review ownership", async () => {
    mocks.account.mockResolvedValue({
      id: "account",
      business_id: businessId,
      owner_id: "owner",
      state: "carrier_pending",
      billing_source: "direct",
      exclusive_resources: true,
      created_at: "2026-01-01T00:00:00Z",
      draft: {
        phoneNumber: "+15745550111",
        consentDescription: "Customer permission",
        consentEvidenceUrl: "https://example.test/consent",
      },
    });
    mocks.rpc.mockImplementation(async (name: string) => ({
      data: name === "review_sms_claim_provisioning" ? "claim" : true,
      error: null,
    }));
    mocks.brand.mockResolvedValue({ identityStatus: "VERIFIED", status: "OK" });
    mocks.providerProfile.mockResolvedValue({
      data: {
        id: "tenant-profile",
        name: `Example LLC (${businessId})`,
        created_at: "2025-01-01T00:00:00Z",
      },
    });
    await expect(
      continueReviewSmsProvisioning(businessId),
    ).rejects.toMatchObject({
      code: "review_sms_keyword_profile_not_owned",
    });
    expect(mocks.ensureKeywords).not.toHaveBeenCalled();
    expect(mocks.phone).not.toHaveBeenCalled();
  });
  it("waits for verified brand identity before number purchase or campaign work", async () => {
    mocks.account.mockResolvedValue({
      id: "account",
      business_id: businessId,
      owner_id: "owner",
      state: "carrier_pending",
      billing_source: "direct",
      draft: {
        phoneNumber: "+15745550111",
        consentDescription: "Customer provided permission for review texts",
        consentEvidenceUrl: "https://example.test/consent",
      },
    });
    mocks.rpc.mockImplementation(async (name: string) => ({
      data: name === "review_sms_claim_provisioning" ? "claim" : true,
      error: null,
    }));
    mocks.brand.mockResolvedValue({
      identityStatus: "UNVERIFIED",
      status: "REGISTRATION_PENDING",
    });
    await continueReviewSmsProvisioning(businessId);
    expect(mocks.register).toHaveBeenCalledOnce();
    expect(mocks.profile).not.toHaveBeenCalled();
    expect(mocks.phone).not.toHaveBeenCalled();
  });
});
