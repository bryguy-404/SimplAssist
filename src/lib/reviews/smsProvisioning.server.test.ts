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
  business: {} as Record<string, unknown>,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    rpc: mocks.rpc,
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "update", "eq", "is"])
        chain[method] = () => chain;
      chain.maybeSingle = chain.single = async () => ({
        data:
          table === "businesses"
            ? mocks.business
            : table === "phone_numbers"
              ? { id: "phone-id", phone_number: "+15745550111" }
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
vi.mock("@/lib/messaging/client", () => ({
  telnyx: {
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
  mocks.business = {
    id: businessId,
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
