import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class ExistingBrandLinkError extends Error {
    readonly code: string;
    readonly kind: "transient" | "permanent";
    readonly launchDisposition?: "review_required" | "support_required";

    constructor(options: {
      code: string;
      kind: "transient" | "permanent";
      launchDisposition?: "review_required" | "support_required";
      message?: string;
    }) {
      super(options.message ?? "safe existing-brand error");
      this.code = options.code;
      this.kind = options.kind;
      this.launchDisposition = options.launchDisposition;
    }
  }

  class LinkedExistingBrandSupportRequiredError extends Error {
    readonly code = "linked_brand_needs_support";
  }

  class CampaignRegistrationError extends Error {
    readonly code: string;
    readonly kind: "transient" | "permanent";

    constructor(options: {
      code: string;
      kind: "transient" | "permanent";
      message: string;
    }) {
      super(options.message);
      this.code = options.code;
      this.kind = options.kind;
    }
  }

  return {
    ExistingBrandLinkError,
    LinkedExistingBrandSupportRequiredError,
    CampaignRegistrationError,
    from: vi.fn(),
    prepareExistingBrand: vi.fn(),
    archiveBrand: vi.fn(),
    registerBrand: vi.fn(),
    archiveCampaign: vi.fn(),
    registerCampaign: vi.fn(),
    createMessagingProfile: vi.fn(),
    createVoiceApplication: vi.fn(),
    attachOwnedNumber: vi.fn(),
    purchaseNumber: vi.fn(),
    findOwnedNumberId: vi.fn(),
    ensureCampaignAssignment: vi.fn(),
    riskClearance: vi.fn(),
    screenRisk: vi.fn(),
    claim: vi.fn(),
    markFailed: vi.fn(),
    markSubmitted: vi.fn(),
    getActiveSmsNumber: vi.fn(),
    verifyPublishedCompliancePage: vi.fn(),
    getBusinessContentQuality: vi.fn(),
    resolveBusinessOperationalControls: vi.fn(),
    resolveSmsProvisioningAccess: vi.fn(),
    claimSmsLaunchPlanFamily: vi.fn(),
    resolveProviderCreateIntent: vi.fn(),
    readProviderCreateIntentForPayload: vi.fn(),
    assertNoCarrierRejectionForBusiness: vi.fn(),
    assertTextingUpgradeProvisioningAllowed: vi.fn(),
    reconcileTextingUpgradeActivationForBusiness: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/billing/textingUpgradeActivation.server", () => ({
  assertTextingUpgradeProvisioningAllowed: mocks.assertTextingUpgradeProvisioningAllowed,
  reconcileTextingUpgradeActivationForBusiness: mocks.reconcileTextingUpgradeActivationForBusiness,
  TextingUpgradeProvisioningStoppedError: class extends Error {},
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mocks.from },
}));
vi.mock("@/lib/account/operationalControls.server", () => ({
  resolveBusinessOperationalControls: mocks.resolveBusinessOperationalControls,
}));
vi.mock("@/lib/billing/entitlements", () => ({
  resolveSmsProvisioningAccess: mocks.resolveSmsProvisioningAccess,
}));
vi.mock("@/lib/billing/smsLaunchFamily.server", () => ({
  claimSmsLaunchPlanFamily: mocks.claimSmsLaunchPlanFamily,
}));
vi.mock("@/lib/messaging/phoneNumberLookup", () => ({
  getActiveSmsNumberForBusiness: mocks.getActiveSmsNumber,
}));
vi.mock("@/lib/messaging/registration/publicCompliancePage", () => ({
  verifyPublishedCompliancePage: mocks.verifyPublishedCompliancePage,
}));
vi.mock("@/lib/messaging/numbers", () => ({
  NUMBER_ORDER_CREATE_INTENT_SPEC: {
    eventType: "phone_number_order_create_intent",
    resourceType: "phone_number",
  },
  NumberTakenError: class extends Error {},
  NumberUnavailableError: class extends Error {},
  PurchasedNumberResolutionError: class extends Error {},
  PurchasedNumberSaveError: class extends Error {},
  TollFreeNumberUnsupportedError: class extends Error {},
  normalizeTelnyxPhoneNumberResourceId: (value: unknown) => {
    if (typeof value !== "string" || !/^[0-9]+$/.test(value.trim())) {
      throw new Error("invalid managed phone-number resource id");
    }
    return value.trim();
  },
  attachOwnedNumberToCustomerProfile: mocks.attachOwnedNumber,
  purchaseNumber: mocks.purchaseNumber,
  findOwnedNumberId: mocks.findOwnedNumberId,
}));
vi.mock("@/lib/messaging/registration/providerCreateIntent", () => ({
  resolveProviderCreateIntent: mocks.resolveProviderCreateIntent,
  readProviderCreateIntentForPayload:
    mocks.readProviderCreateIntentForPayload,
}));
vi.mock("@/lib/messaging/registration", () => ({
  registerBrand: mocks.registerBrand,
  registerCampaign: mocks.registerCampaign,
  createMessagingProfile: mocks.createMessagingProfile,
  createVoiceApplication: mocks.createVoiceApplication,
}));
vi.mock("@/lib/messaging/registration/brand", () => ({
  archiveAndClearRejectedBrand: mocks.archiveBrand,
  LinkedExistingBrandSupportRequiredError:
    mocks.LinkedExistingBrandSupportRequiredError,
}));
vi.mock("@/lib/messaging/registration/campaign", () => ({
  archiveAndClearRejectedCampaign: mocks.archiveCampaign,
  CampaignRegistrationError: mocks.CampaignRegistrationError,
}));
vi.mock("@/lib/messaging/registration/existingBrand", () => ({
  ExistingBrandLinkError: mocks.ExistingBrandLinkError,
  prepareExistingTelnyxBrandLinkForLaunch: mocks.prepareExistingBrand,
}));
vi.mock("@/lib/messaging/registration/riskScreening", () => ({
  getA2pRiskClearanceForBusiness: mocks.riskClearance,
  screenA2pRiskForBusiness: mocks.screenRisk,
}));
vi.mock("@/lib/messaging/registration/phoneNumberAssignment", () => ({
  ensureCampaignAssignmentForBusiness: mocks.ensureCampaignAssignment,
}));
vi.mock("@/lib/onboarding/registrationAttempt", () => ({
  claimRegistrationAttempt: mocks.claim,
  markRegistrationFailed: mocks.markFailed,
  markRegistrationSubmitted: mocks.markSubmitted,
}));
vi.mock("@/lib/onboarding/rejectionGuard.server", () => ({
  assertNoCarrierRejectionForBusiness:
    mocks.assertNoCarrierRejectionForBusiness,
}));
vi.mock("@/lib/onboarding/contentQuality.server", () => ({
  getBusinessContentQuality: mocks.getBusinessContentQuality,
}));

import { attemptPaidLaunch } from "./launch";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000091";
const SIGNUP_GOAL_URL_INVALID_MESSAGE =
  "Add a valid HTTPS signup link for your primary goal before retrying SMS registration.";
const ACTIVE_NUMBER = {
  id: "number-row-1",
  phone_number: "+15745550191",
  telnyx_phone_number_id: "3026446889630303191",
};
const BUSINESS = {
  id: BUSINESS_ID,
  slug: "test-business",
  name: "Test Business",
  has_ein: true,
  pending_phone_number: null,
  telnyx_submission_disabled: false,
  telnyx_brand_id: null,
  telnyx_campaign_id: null,
  billing_pilot: false,
  billing_comped: false,
  billing_exempt: true,
  billing_mode: "stripe",
  partner_plan: null,
  ai_settings: { language: "en" },
};

function queueResults(...results: unknown[]) {
  const queue = [...results];
  mocks.from.mockImplementation(() => {
    const result = queue.shift() ?? { data: null, error: null };
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of [
      "select",
      "insert",
      "update",
      "eq",
      "or",
      "order",
      "limit",
      "maybeSingle",
      "single",
    ]) {
      chain[method] = vi.fn(() => chain);
    }
    const promise = Promise.resolve(result);
    (chain as Record<string, unknown>).then = promise.then.bind(promise);
    (chain as Record<string, unknown>).catch = promise.catch.bind(promise);
    return chain;
  });
}

function queueThroughClaim() {
  queueResults(
    { data: BUSINESS, error: null },
    { data: null, error: null },
    { data: ACTIVE_NUMBER, error: null }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.riskClearance.mockResolvedValue({
    cleared: true,
    hashMatches: true,
    status: "passed",
    message: null,
  });
  mocks.getBusinessContentQuality.mockResolvedValue({ ready: true });
  mocks.resolveBusinessOperationalControls.mockResolvedValue({
    businessId: BUSINESS_ID,
    operationsSuspendedAt: null,
    aiRepliesPausedAt: null,
    textingPausedAt: null,
    bookingsPausedAt: null,
  });
  mocks.resolveSmsProvisioningAccess.mockResolvedValue({
    allowed: true,
    source: "billing_override",
    plan: "full",
  });
  mocks.claimSmsLaunchPlanFamily.mockResolvedValue(true);
  mocks.assertTextingUpgradeProvisioningAllowed.mockResolvedValue(undefined);
  mocks.reconcileTextingUpgradeActivationForBusiness.mockResolvedValue(false);
  mocks.claim.mockResolvedValue({
    claimed: true,
    claimedFrom: "not_started",
    startedAt: "2026-07-21T13:00:00.000Z",
  });
  mocks.prepareExistingBrand.mockResolvedValue({ status: "not_requested" });
  mocks.getActiveSmsNumber.mockResolvedValue(ACTIVE_NUMBER.phone_number);
  mocks.verifyPublishedCompliancePage.mockResolvedValue(undefined);
  for (const fn of [
    mocks.archiveBrand,
    mocks.registerBrand,
    mocks.archiveCampaign,
    mocks.registerCampaign,
    mocks.createMessagingProfile,
    mocks.createVoiceApplication,
    mocks.attachOwnedNumber,
    mocks.resolveProviderCreateIntent,
    mocks.readProviderCreateIntentForPayload,
    mocks.ensureCampaignAssignment,
    mocks.markFailed,
  ]) {
    fn.mockResolvedValue(undefined);
  }
  mocks.assertNoCarrierRejectionForBusiness.mockResolvedValue(undefined);
  mocks.markSubmitted.mockResolvedValue({ completed: true });
});

function expectNoProviderMutation() {
  expect(mocks.archiveBrand).not.toHaveBeenCalled();
  expect(mocks.registerBrand).not.toHaveBeenCalled();
  expect(mocks.archiveCampaign).not.toHaveBeenCalled();
  expect(mocks.registerCampaign).not.toHaveBeenCalled();
  expect(mocks.createMessagingProfile).not.toHaveBeenCalled();
  expect(mocks.createVoiceApplication).not.toHaveBeenCalled();
  expect(mocks.attachOwnedNumber).not.toHaveBeenCalled();
  expect(mocks.purchaseNumber).not.toHaveBeenCalled();
}

function queueThroughCampaignRegistration() {
  queueResults(
    { data: BUSINESS, error: null },
    { data: null, error: null },
    { data: ACTIVE_NUMBER, error: null },
    { data: ACTIVE_NUMBER, error: null },
    { error: null }
  );
}

describe("goal-aware signup campaign filing", () => {
  function rejectInvalidSignupGoalUrl() {
    mocks.registerCampaign.mockRejectedValue(
      new mocks.CampaignRegistrationError({
        code: "campaign_signup_goal_url_invalid",
        kind: "permanent",
        message: SIGNUP_GOAL_URL_INVALID_MESSAGE,
      })
    );
  }

  it("marks a normal signup configuration failure without submitting", async () => {
    queueThroughCampaignRegistration();
    rejectInvalidSignupGoalUrl();

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result).toEqual({
      status: "failed",
      message: SIGNUP_GOAL_URL_INVALID_MESSAGE,
    });
    expect(mocks.markFailed).toHaveBeenCalledWith(
      BUSINESS_ID,
      SIGNUP_GOAL_URL_INVALID_MESSAGE
    );
    expect(mocks.ensureCampaignAssignment).not.toHaveBeenCalled();
    expect(mocks.markSubmitted).not.toHaveBeenCalled();
    expect(mocks.riskClearance.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.claim.mock.invocationCallOrder[0]
    );
    expect(mocks.claim.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.registerCampaign.mock.invocationCallOrder[0]
    );
    expect(mocks.registerCampaign.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.markFailed.mock.invocationCallOrder[0]
    );
  });

  it("keeps a linked-brand signup configuration failure actionable", async () => {
    queueThroughCampaignRegistration();
    mocks.prepareExistingBrand.mockResolvedValue({ status: "consumed" });
    rejectInvalidSignupGoalUrl();

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result).toEqual({
      status: "failed",
      message: SIGNUP_GOAL_URL_INVALID_MESSAGE,
    });
    expect(mocks.markFailed).toHaveBeenCalledWith(
      BUSINESS_ID,
      SIGNUP_GOAL_URL_INVALID_MESSAGE
    );
    expect(mocks.ensureCampaignAssignment).not.toHaveBeenCalled();
    expect(mocks.markSubmitted).not.toHaveBeenCalled();
  });
});

describe("attemptPaidLaunch existing-brand authorization boundary", () => {
  it("returns review-required before any provider mutation", async () => {
    queueThroughClaim();
    mocks.prepareExistingBrand.mockRejectedValue(
      new mocks.ExistingBrandLinkError({
        code: "existing_brand_link_not_ready_for_approval",
        kind: "permanent",
        launchDisposition: "review_required",
      })
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "stripe_finalize");

    expect(result).toEqual({
      status: "existing_brand_review_required",
      message:
        "Your existing Telnyx brand link needs review before SMS registration can continue. Contact support.",
    });
    expect(mocks.markFailed).toHaveBeenCalledWith(
      BUSINESS_ID,
      "Your existing Telnyx brand link needs review before SMS registration can continue. Contact support."
    );
    expectNoProviderMutation();
  });

  it("keeps a transient revalidation failure retryable and mutation-free", async () => {
    queueThroughClaim();
    mocks.prepareExistingBrand.mockRejectedValue(
      new mocks.ExistingBrandLinkError({
        code: "existing_brand_provider_unavailable",
        kind: "transient",
      })
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result).toEqual({
      status: "failed",
      message:
        "We could not recheck your existing Telnyx brand right now. No new Telnyx resources were created; please try again shortly.",
    });
    expectNoProviderMutation();
  });

  it("routes consumed deterministic drift to support without mutation", async () => {
    queueThroughClaim();
    mocks.prepareExistingBrand.mockRejectedValue(
      new mocks.ExistingBrandLinkError({
        code: "telnyx_brand_status_not_ok",
        kind: "permanent",
        launchDisposition: "support_required",
      })
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result).toEqual({
      status: "linked_brand_needs_support",
      message:
        "Your linked Telnyx brand needs support before SMS registration can continue. Its existing Telnyx resources were not replaced.",
    });
    expectNoProviderMutation();
  });

  it("consumes the link before every provider write", async () => {
    queueResults(
      { data: BUSINESS, error: null },
      { data: null, error: null },
      { data: ACTIVE_NUMBER, error: null },
      { data: ACTIVE_NUMBER, error: null },
      { error: null }
    );
    mocks.prepareExistingBrand.mockResolvedValue({ status: "consumed" });

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("submitted");
    expect(mocks.prepareExistingBrand).toHaveBeenCalledWith(BUSINESS_ID);
    expect(
      mocks.prepareExistingBrand.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.registerBrand.mock.invocationCallOrder[0]);
    expect(mocks.archiveBrand).not.toHaveBeenCalled();
    expect(mocks.archiveCampaign).not.toHaveBeenCalled();
  });

  it("routes a rejected linked brand to support before link consumption or provider work", async () => {
    queueResults({
      data: {
        ...BUSINESS,
        telnyx_brand_id: "brand-rejected-linked",
        brand_status: "rejected",
        campaign_status: null,
      },
      error: null,
    });

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("rejection_support_required");
    expect(mocks.prepareExistingBrand).not.toHaveBeenCalled();
    expectNoProviderMutation();
  });

  it("routes a permanent linked campaign recovery failure to support", async () => {
    queueResults(
      { data: BUSINESS, error: null },
      { data: null, error: null },
      { data: ACTIVE_NUMBER, error: null },
      { data: ACTIVE_NUMBER, error: null },
      { error: null }
    );
    mocks.prepareExistingBrand.mockResolvedValue({ status: "consumed" });
    mocks.registerCampaign.mockRejectedValue(
      new mocks.CampaignRegistrationError({
        code: "campaign_recovery_multiple_matches",
        kind: "permanent",
        message: "safe campaign support message",
      })
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result).toEqual({
      status: "linked_brand_needs_support",
      message:
        "Your linked Telnyx brand needs support before SMS registration can continue. Its existing Telnyx resources were not replaced.",
    });
    expect(mocks.markFailed).toHaveBeenCalledWith(
      BUSINESS_ID,
      "Your linked Telnyx brand needs support before SMS registration can continue. Its existing Telnyx resources were not replaced."
    );
    expect(mocks.createMessagingProfile).toHaveBeenCalledWith(BUSINESS_ID);
    expect(mocks.createVoiceApplication).toHaveBeenCalledWith(BUSINESS_ID);
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
  });

  it("does not misclassify an early error containing 'already' as a number failure", async () => {
    queueThroughClaim();
    mocks.registerBrand.mockRejectedValue(
      new Error("Brand already exists in a conflicting provider state")
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("failed");
    expect(result.status).not.toBe("number_unavailable");
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
  });

  it("does not misclassify a downstream error after number attachment", async () => {
    queueResults(
      { data: BUSINESS, error: null },
      { data: null, error: null },
      { data: ACTIVE_NUMBER, error: null },
      { data: ACTIVE_NUMBER, error: null },
      { error: null }
    );
    mocks.ensureCampaignAssignment.mockRejectedValue(
      new Error("Campaign assignment already has an unavailable task state")
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("failed");
    expect(result.status).not.toBe("number_unavailable");
    expect(mocks.attachOwnedNumber).toHaveBeenCalledTimes(1);
  });

  it("does not discard an owned number when attachment returns ambiguous text", async () => {
    queueResults(
      { data: BUSINESS, error: null },
      { data: null, error: null },
      { data: ACTIVE_NUMBER, error: null },
      { data: ACTIVE_NUMBER, error: null }
    );
    mocks.attachOwnedNumber.mockRejectedValue(
      new Error("Number is already attached but routing is unavailable")
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("failed");
    expect(result.status).not.toBe("number_unavailable");
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
  });
});
