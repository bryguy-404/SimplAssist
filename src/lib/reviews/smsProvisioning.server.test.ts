import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  sharedContext: vi.fn(), sharedNewStart: vi.fn(), sharedValidate: vi.fn(), sharedConsume: vi.fn(), sharedReserve: vi.fn(), sharedSettle: vi.fn(), sharedReservation: vi.fn(), sharedPaidProof: vi.fn(),
  rpc: vi.fn(),
  account: vi.fn(),
  campaign: vi.fn(), campaignList: vi.fn(), campaignSubmit: vi.fn(),
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
vi.mock("./campaignAttempts.server", async original => ({
  ...await original<object>(),
  readReviewCampaignAttempts: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/messaging/sharedBusinessRegistrations.server", async importOriginal => ({
  ...await importOriginal<object>(),
  readSharedRegistrationContext: mocks.sharedContext,
  assertSharedRegistrationForNewStart: mocks.sharedNewStart,
  validateSharedRegistrationProof: mocks.sharedValidate,
  consumeSharedReviewRegistration: mocks.sharedConsume,
  reserveSharedCampaignSubmission: mocks.sharedReserve,
  settleSharedCampaignSubmission: mocks.sharedSettle,
  readSharedCampaignReservation: mocks.sharedReservation,
}));
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
  readPaidReviewSmsSharedRegistrationProof: mocks.sharedPaidProof,
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
      campaign: { retrieve: mocks.campaign, list: mocks.campaignList },
      campaignBuilder: { submit: mocks.campaignSubmit },
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
  initializeIncludedReviewSmsSignup,
  saveReviewSmsSetup, reviewSmsSetupOverview, reviewSmsCampaignMatches,
} from "./smsProvisioning.server";
const businessId = "10000000-0000-4000-a100-000000000001",
  adminId = "00000000-0000-4000-a100-000000000002";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.sharedContext.mockResolvedValue(null);
  mocks.sharedNewStart.mockResolvedValue(null);
  mocks.sharedValidate.mockResolvedValue(null);
  mocks.sharedConsume.mockResolvedValue(undefined);
  mocks.sharedReserve.mockResolvedValue(null);
  mocks.sharedSettle.mockResolvedValue(undefined);
  mocks.sharedReservation.mockResolvedValue(null);
  mocks.sharedPaidProof.mockResolvedValue(null);

  vi.stubEnv("SIMPLASSIST_ADMIN_USER_IDS", adminId);
  vi.stubEnv("REVIEWS_SMS_ENABLED", "1");
  vi.stubEnv("REVIEWS_SMS_PILOT_BUSINESS_IDS", businessId);
  vi.stubEnv("REVIEWS_SMS_PROVISIONING_ENABLED", "1");
  vi.stubEnv("TELNYX_PROTECTED_MESSAGING_PROFILE_ID", "protected-profile");
  mocks.profileOwnership = true;
  mocks.campaignList.mockResolvedValue({page:1,totalRecords:0,records:[]});
  mocks.campaignSubmit.mockResolvedValue({ campaignId: "created-campaign" });
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
  it("assigns the new Chat account a public consent URL before saving its hosted setup", async () => {
    mocks.business.slug = "pending-new-chat";
    mocks.business.telnyx_brand_id = null;
    mocks.rpc.mockImplementation(async (name: string) => ({data:name === "review_sms_prepare_hosted_slug" ? "example-llc-unique" : true,error:null}));
    await saveReviewSmsSetup(businessId,"owner",{phoneNumber:"+15745550111",consentMode:"hosted_keyword"});
    expect(mocks.rpc).toHaveBeenCalledWith("review_sms_prepare_hosted_slug",{p_business:businessId,p_owner:"owner",p_base:"example-llc"});
    expect(mocks.rpc).toHaveBeenCalledWith("review_sms_save_setup",expect.objectContaining({p_draft:expect.objectContaining({consentEvidenceUrl:expect.stringContaining("/c/example-llc-unique/review-texts")})}));
  });
  it("does not persist a pending consent URL when slug allocation fails", async () => {
    mocks.business.slug = "pending-new-chat";
    mocks.rpc.mockResolvedValue({data:null,error:{message:"unavailable"}});
    await expect(saveReviewSmsSetup(businessId,"owner",{phoneNumber:"+15745550111",consentMode:"hosted_keyword"})).rejects.toMatchObject({code:"review_sms_setup_unavailable"});
    expect(mocks.rpc).not.toHaveBeenCalledWith("review_sms_save_setup",expect.anything());
  });
  it("never invokes paid add-on provisioning for an included texting plan", async () => {
    mocks.account.mockResolvedValue({state:"carrier_pending",billing_source:"included"});
    await continueReviewSmsProvisioning(businessId);
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("initializes an opted-in signup from its own assigned number without buying resources", async () => {
    mocks.business.review_sms_signup_enabled = true;
    mocks.business.slug = "example-services";
    await initializeIncludedReviewSmsSignup(businessId, "owner");
    expect(mocks.rpc).toHaveBeenCalledWith("review_sms_initialize_signup", expect.objectContaining({p_business:businessId,p_owner:"owner",p_draft:expect.objectContaining({consentMode:"hosted_keyword",phoneNumber:"+15745550111"})}));
    expect(mocks.register).not.toHaveBeenCalled();
  });
  it("does not initialize a legacy business that never opted in during signup", async () => {
    await initializeIncludedReviewSmsSignup(businessId,"owner");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("activates included reviews only after exact mixed-purpose provider readiness", async () => {
    mocks.business.review_sms_signup_enabled = true;
    mocks.account.mockResolvedValue({state:"carrier_pending",billing_source:"included"});
    mocks.campaign.mockResolvedValue({brandId:"brand",referenceId:businessId,usecase:"MIXED",subUsecases:["CUSTOMER_CARE","MARKETING"],embeddedLink:true,optinKeywords:"REVIEWS",campaignStatus:"MNO_PROVISIONED"});
    await refreshReviewSmsProviderReadiness(businessId);
    expect(mocks.rpc).toHaveBeenCalledWith("review_sms_activate_signup", expect.objectContaining({p_business:businessId,p_owner:"owner",p_campaign:"campaign",p_phone:"phone-id"}));
    expect(mocks.register).not.toHaveBeenCalled();
  });
  it.each([{referenceId:"different-business"},{subUsecases:["CUSTOMER_CARE"]},{optinKeywords:"START"},{embeddedLink:false}])("does not grant automatic access for a mismatched registration %j", async (patch) => {
    mocks.business.review_sms_signup_enabled=true;
    mocks.account.mockResolvedValue({state:"carrier_pending",billing_source:"included"});
    mocks.campaign.mockResolvedValue({brandId:"brand",referenceId:businessId,usecase:"MIXED",subUsecases:["CUSTOMER_CARE","MARKETING"],embeddedLink:true,optinKeywords:"REVIEWS",campaignStatus:"MNO_PROVISIONED",...patch});
    await expect(refreshReviewSmsProviderReadiness(businessId)).rejects.toMatchObject({code:"review_sms_campaign_mismatch"});
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("leaves an included application pending while its carrier approval is pending", async () => {
    mocks.business.review_sms_signup_enabled=true;
    mocks.account.mockResolvedValue({state:"carrier_pending",billing_source:"included"});
    mocks.campaign.mockResolvedValue({brandId:"brand",referenceId:businessId,usecase:"MIXED",subUsecases:["CUSTOMER_CARE","MARKETING"],embeddedLink:true,optinKeywords:"REVIEWS",campaignStatus:"MNO_PENDING"});
    await refreshReviewSmsProviderReadiness(businessId);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
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

const sharedProof = { registrationId: "50000000-0000-4000-a100-000000000001", identityVersion: 1, membershipRevision: 2, brandId: "brand" };
const sharedContext = { registration: { id: sharedProof.registrationId, brand_id: "brand", identity_version: 1, legal_business_name: "Example LLC" }, membership: { status: "approved", revision: 2, owner_id: "owner" } };
async function sharedProvisioningFixture() {
  const a = { ...(await mocks.account()), id: "account", business_id: businessId, owner_id: "owner", state: "carrier_pending", billing_source: "direct", exclusive_resources: true,
    campaign_id: null, created_at: "2026-01-01T00:00:00Z", activation_paid_at: "2026-01-01T00:00:00Z", activation_refunded_at: null, provider_started_at: null };
  mocks.account.mockResolvedValue(a); mocks.business.telnyx_campaign_id = null;
  mocks.sharedContext.mockResolvedValue(sharedContext); mocks.sharedValidate.mockResolvedValue(sharedContext);
  mocks.sharedPaidProof.mockResolvedValue(sharedProof);
  mocks.brand.mockResolvedValue({ identityStatus: "VERIFIED" });
  mocks.rpc.mockImplementation(async (name: string) => ({ data: name === "review_sms_claim_provisioning" ? "claim" : name === "review_sms_begin_campaign_attempt" ? {attempt_id:"attempt",submit:true} : name === "review_sms_finish_campaign_attempt" ? {attached:true,state:"accepted"} : true, error: null }));
  mocks.campaign.mockImplementation(async () => ({ ...mocks.campaignSubmit.mock.calls[0]?.[0], campaignId: "created-campaign" }));
  return a;
}
describe("approved shared-brand provisioning", () => {
  it("lets an approved unbound account supply its own representative without changing legal identity", async () => {
    mocks.business.telnyx_brand_id = null;
    mocks.sharedContext.mockResolvedValue(sharedContext); mocks.sharedValidate.mockResolvedValue(sharedContext);
    await saveReviewSmsSetup(businessId, "owner", { phoneNumber: "+15745550111", consentMode: "custom",
      consentDescription: "Customers give optional permission for marketing review texts.", consentEvidenceUrl: "https://example.test/consent",
      authorizedRepName: "Account Representative", authorizedRepEmail: "representative@example.test", authorizedRepPhone: "+13175550123" });
    expect(mocks.rpc).toHaveBeenCalledWith("review_sms_save_setup", expect.objectContaining({ p_patch: expect.objectContaining({ authorized_rep_name: "Account Representative", authorized_rep_email: "representative@example.test", authorized_rep_phone: "+13175550123" }) }));
  });
  it("keeps representative changes locked after shared membership is active", async () => {
    mocks.sharedValidate.mockResolvedValue({ ...sharedContext, membership: { ...sharedContext.membership, status: "active" } });
    await expect(saveReviewSmsSetup(businessId, "owner", { phoneNumber: "+15745550111", consentMode: "custom", consentDescription: "Customers provide review permission", consentEvidenceUrl: "https://example.test/consent", authorizedRepEmail: "changed@example.test" }))
      .rejects.toMatchObject({ code: "review_sms_existing_brand_identity_locked" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("locks staged canonical fields before a provider brand is bound and keeps private-address visibility explicit", async () => {
    mocks.business.telnyx_brand_id = null; mocks.business.public_address_visibility = "city_state";
    mocks.sharedContext.mockResolvedValue(sharedContext); mocks.sharedValidate.mockResolvedValue(sharedContext);
    expect((await reviewSmsSetupOverview(businessId)).fields).toMatchObject({ identityLocked: true, representativeEditable: true, publicAddressVisibility: "city_state", hasEin: true });
    expect((await reviewSmsSetupOverview(businessId)).fields).not.toHaveProperty("ein");
    await expect(saveReviewSmsSetup(businessId, "owner", { phoneNumber: "+15745550111", consentMode: "hosted_keyword", legalBusinessName: "Changed LLC" }))
      .rejects.toMatchObject({ code: "review_sms_existing_brand_identity_locked" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("binds paid approval before brand reuse without inventing a paid brand create", async () => {
    await sharedProvisioningFixture(); mocks.brand.mockResolvedValue({ identityStatus: "UNVERIFIED" });
    await continueReviewSmsProvisioning(businessId);
    expect(mocks.sharedConsume).toHaveBeenCalledWith({ businessId, ownerId: "owner", reviewAccountId: "account", claimToken: "claim", proof: sharedProof });
    expect(mocks.sharedConsume.mock.invocationCallOrder[0]).toBeLessThan(mocks.register.mock.invocationCallOrder[0]);
    expect(mocks.rpc).not.toHaveBeenCalledWith("review_sms_begin_paid_provider_step", expect.anything());
    expect(mocks.campaignSubmit).not.toHaveBeenCalled(); expect(mocks.phone).not.toHaveBeenCalled();
  });
  it("never reaches brand registration after a concurrent refund wins consume", async () => {
    await sharedProvisioningFixture(); mocks.sharedConsume.mockRejectedValue(new Error("refund won"));
    await expect(continueReviewSmsProvisioning(businessId)).rejects.toThrow("refund won");
    expect(mocks.register).not.toHaveBeenCalled(); expect(mocks.campaignSubmit).not.toHaveBeenCalled();
  });
  it("will not provision a shared member using an unrelated historical standalone receipt", async () => {
    await sharedProvisioningFixture(); mocks.sharedPaidProof.mockResolvedValue(null);
    await expect(continueReviewSmsProvisioning(businessId)).rejects.toMatchObject({ code: "review_sms_shared_registration_required" });
    expect(mocks.sharedConsume).not.toHaveBeenCalled(); expect(mocks.register).not.toHaveBeenCalled();
  });
  it("reserves shared-brand capacity before the one charged campaign submission", async () => {
    await sharedProvisioningFixture(); mocks.sharedReserve.mockResolvedValue({ id: "reservation", submit: true, providerCampaignId: null });
    await continueReviewSmsProvisioning(businessId);
    expect(mocks.sharedReserve).toHaveBeenCalledWith(expect.objectContaining({ businessId, operationId: "account", purpose: "review_initial", claimToken: "claim", referenceId: "reviews:account" }));
    expect(mocks.sharedReserve.mock.invocationCallOrder[0]).toBeLessThan(mocks.campaignSubmit.mock.invocationCallOrder[0]);
    expect(mocks.campaignSubmit.mock.calls[0][0].description).toContain("is operated by Example LLC");
    expect(mocks.campaignSubmit.mock.calls[0][0].description).toContain("marketing review requests");
    expect(mocks.rpc).toHaveBeenCalledWith("review_sms_finish_campaign_attempt", expect.objectContaining({p_attempt:"attempt",p_outcome:"accepted",p_provider_campaign_id:"created-campaign"}));
  });
  it("holds an uncertain shared submission and never sends a second paid request", async () => {
    await sharedProvisioningFixture(); mocks.sharedReserve.mockResolvedValue({ id: "reservation", submit: true, providerCampaignId: null });
    mocks.campaignSubmit.mockRejectedValueOnce(new Error("provider timeout"));
    await expect(continueReviewSmsProvisioning(businessId)).rejects.toThrow("provider timeout");
    expect(mocks.sharedSettle).toHaveBeenCalledWith(expect.objectContaining({ outcome: "uncertain" }));
    mocks.sharedReserve.mockResolvedValue({ id: "reservation", submit: false, providerCampaignId: null });
    await expect(continueReviewSmsProvisioning(businessId)).rejects.toMatchObject({ code: "review_sms_campaign_recovery_required" });
    expect(mocks.campaignSubmit).toHaveBeenCalledTimes(1);
  });
  it("recovers an exact previous provider filing without resubmitting", async () => {
    await sharedProvisioningFixture(); mocks.sharedReserve.mockResolvedValue({ id: "reservation", submit: true, providerCampaignId: null });
    mocks.campaignSubmit.mockRejectedValueOnce(new Error("response lost"));
    await expect(continueReviewSmsProvisioning(businessId)).rejects.toThrow("response lost");
    const filing = mocks.campaignSubmit.mock.calls[0][0], payloadHash = mocks.sharedReserve.mock.calls[0][0].payloadHash;
    mocks.sharedReservation.mockResolvedValue({ id: "reservation", payloadHash, referenceId: "reviews:account", providerCampaignId: null });
    mocks.campaignList.mockResolvedValue({page:1,totalRecords:1,records:[{ ...filing, campaignId: "created-campaign" }]});
    await continueReviewSmsProvisioning(businessId);
    expect(mocks.campaignSubmit).toHaveBeenCalledTimes(1);
    expect(mocks.sharedSettle).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "accepted", providerCampaignId: "created-campaign" }));
  });
  it.each(["brandId", "referenceId", "description", "messageFlow", "optinKeywords", "privacyPolicyLink"])("does not accept altered %s in recovery proof", key => {
    const filing = { brandId: "shared-brand", referenceId: "reviews:account", description: "DBA relationship", messageFlow: "Optional marketing consent", optinKeywords: "REVIEWS", privacyPolicyLink: "https://example.test/privacy", webhookURL: "https://example.test/callback" };
    expect(reviewSmsCampaignMatches({ ...filing, [key]: "wrong" }, filing)).toBe(false);
    const { webhookURL: _ignored, ...provider } = filing;
    expect(_ignored).toBe("https://example.test/callback");
    expect(reviewSmsCampaignMatches(provider, filing)).toBe(true);
  });
});
