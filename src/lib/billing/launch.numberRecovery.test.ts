import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  purchaseNumber: vi.fn(),
  findOwnedNumberId: vi.fn(),
  attachOwnedNumberToCustomerProfile: vi.fn(),
  registerBrand: vi.fn(),
  registerCampaign: vi.fn(),
  createMessagingProfile: vi.fn(),
  createVoiceApplication: vi.fn(),
  archiveAndClearRejectedBrand: vi.fn(),
  archiveAndClearRejectedCampaign: vi.fn(),
  prepareExistingTelnyxBrandLinkForLaunch: vi.fn(),
  getA2pRiskClearanceForBusiness: vi.fn(),
  screenA2pRiskForBusiness: vi.fn(),
  ensureCampaignAssignmentForBusiness: vi.fn(),
  claimRegistrationAttempt: vi.fn(),
  markRegistrationFailed: vi.fn(),
  markRegistrationSubmitted: vi.fn(),
  getActiveSmsNumber: vi.fn(),
  verifyPublishedCompliancePage: vi.fn(),
  getBusinessContentQuality: vi.fn(),
  resolveBusinessOperationalControls: vi.fn(),
  resolveSmsProvisioningAccess: vi.fn(),
  claimSmsLaunchPlanFamily: vi.fn(),
  buildProviderResourceName: vi.fn(),
  resolveProviderCreateIntent: vi.fn(),
  readProviderCreateIntentForPayload: vi.fn(),
  assertNoCarrierRejectionForBusiness: vi.fn(),
  assertTextingUpgradeProvisioningAllowed: vi.fn(),
  reconcileTextingUpgradeActivationForBusiness: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/billing/textingUpgradeActivation.server", () => ({
  assertTextingUpgradeProvisioningAllowed: mocks.assertTextingUpgradeProvisioningAllowed,
  reconcileTextingUpgradeActivationForBusiness: mocks.reconcileTextingUpgradeActivationForBusiness,
  TextingUpgradeProvisioningStoppedError: class extends Error {},
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
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
vi.mock("@/lib/messaging/numbers", async (importOriginal) => {
  // Keep the REAL PurchasedNumberSaveError class — launch.ts classifies by
  // instanceof against the same constructor.
  const actual =
    await importOriginal<typeof import("@/lib/messaging/numbers")>();
  return {
    ...actual,
    purchaseNumber: mocks.purchaseNumber,
    findOwnedNumberId: mocks.findOwnedNumberId,
    attachOwnedNumberToCustomerProfile: mocks.attachOwnedNumberToCustomerProfile,
  };
});
vi.mock("@/lib/messaging/registration", () => ({
  registerBrand: mocks.registerBrand,
  registerCampaign: mocks.registerCampaign,
  createMessagingProfile: mocks.createMessagingProfile,
  createVoiceApplication: mocks.createVoiceApplication,
}));
vi.mock("@/lib/messaging/registration/brand", () => ({
  archiveAndClearRejectedBrand: mocks.archiveAndClearRejectedBrand,
  LinkedExistingBrandSupportRequiredError: class extends Error {},
}));
vi.mock("@/lib/messaging/registration/campaign", () => ({
  archiveAndClearRejectedCampaign: mocks.archiveAndClearRejectedCampaign,
  CampaignRegistrationError: class extends Error {},
}));
vi.mock("@/lib/messaging/registration/existingBrand", () => ({
  ExistingBrandLinkError: class extends Error {},
  prepareExistingTelnyxBrandLinkForLaunch:
    mocks.prepareExistingTelnyxBrandLinkForLaunch,
}));
vi.mock("@/lib/messaging/registration/riskScreening", () => ({
  getA2pRiskClearanceForBusiness: mocks.getA2pRiskClearanceForBusiness,
  screenA2pRiskForBusiness: mocks.screenA2pRiskForBusiness,
}));
vi.mock("@/lib/messaging/registration/phoneNumberAssignment", () => ({
  ensureCampaignAssignmentForBusiness: mocks.ensureCampaignAssignmentForBusiness,
}));
vi.mock("@/lib/messaging/registration/providerResourceName", () => ({
  buildProviderResourceName: mocks.buildProviderResourceName,
}));
vi.mock("@/lib/messaging/registration/providerCreateIntent", () => ({
  resolveProviderCreateIntent: mocks.resolveProviderCreateIntent,
  readProviderCreateIntentForPayload:
    mocks.readProviderCreateIntentForPayload,
}));
vi.mock("@/lib/onboarding/registrationAttempt", () => ({
  claimRegistrationAttempt: mocks.claimRegistrationAttempt,
  markRegistrationFailed: mocks.markRegistrationFailed,
  markRegistrationSubmitted: mocks.markRegistrationSubmitted,
}));
vi.mock("@/lib/onboarding/rejectionGuard.server", () => ({
  assertNoCarrierRejectionForBusiness:
    mocks.assertNoCarrierRejectionForBusiness,
}));
vi.mock("@/lib/onboarding/contentQuality.server", () => ({
  getBusinessContentQuality: mocks.getBusinessContentQuality,
}));

import { attemptPaidLaunch } from "./launch";
import { TextingUpgradeProvisioningStoppedError } from "./textingUpgradeActivation.server";
import {
  CarrierRejectionSupportRequiredError,
  REJECTION_SUPPORT_MESSAGE,
} from "@/lib/onboarding/rejectionGuidance";
import {
  NumberUnavailableError,
  PurchasedNumberResolutionError,
  TollFreeNumberUnsupportedError,
} from "@/lib/messaging/numbers";

const BUSINESS_ID = "00000000-0000-4000-8000-00000000b1z1";
const PENDING_NUMBER = "+15745550300";
const TELNYX_NUMBER_ID = "3026446889630303742";
const LEGACY_NUMBER_ORDER_PHONE_NUMBER_ID =
  "5ace1547-124f-475a-95fe-ea5e374325e9";
const NUMBER_ORDER_ID = "1e91cdc9-a293-431d-a4a8-20ead763ac0b";

const LAUNCH_BUSINESS = {
  id: BUSINESS_ID,
  slug: "test-business",
  name: "Test Business",
  legal_business_name: "Test Business LLC",
  has_ein: true,
  pending_phone_number: PENDING_NUMBER,
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

// Chainable, awaitable supabase mock; from() consumes queued results FIFO
// and records chains for argument assertions.
const chains: Array<Record<string, ReturnType<typeof vi.fn>>> = [];
function queueResults(...results: unknown[]) {
  const queue = [...results];
  chains.length = 0;
  mocks.from.mockImplementation(() => {
    const result = queue.shift() ?? { data: null, error: null };
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const m of [
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
      chain[m] = vi.fn(() => chain);
    }
    const promise = Promise.resolve(result);
    (chain as Record<string, unknown>).then = promise.then.bind(promise);
    (chain as Record<string, unknown>).catch = promise.catch.bind(promise);
    chains.push(chain);
    return chain;
  });
}

// Query order for the fresh-purchase flow (billing-exempt business with no
// synchronized subscription): 1 businesses launch-row read; 2 subscriptions;
// 3 phone_numbers readActiveNumber (pre-claim); 4 phone_numbers
// readActiveNumber (after routing resources); 5 phone_numbers step-1 collision
// check; 6 phone_numbers insert; 7 businesses clearPending.
function queueHappyPathThrough(...tail: unknown[]) {
  queueResults(
    { data: LAUNCH_BUSINESS, error: null },
    { data: null, error: null },
    { data: null, error: null },
    { data: null, error: null },
    ...tail
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  mocks.getA2pRiskClearanceForBusiness.mockResolvedValue({
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
  mocks.claimRegistrationAttempt.mockResolvedValue({
    claimed: true,
    claimedFrom: "not_started",
    startedAt: "2026-07-15T00:00:00.000Z",
  });
  mocks.assertNoCarrierRejectionForBusiness.mockResolvedValue(undefined);
  for (const fn of [
    mocks.registerBrand,
    mocks.registerCampaign,
    mocks.createMessagingProfile,
    mocks.createVoiceApplication,
    mocks.archiveAndClearRejectedBrand,
    mocks.archiveAndClearRejectedCampaign,
    mocks.ensureCampaignAssignmentForBusiness,
    mocks.markRegistrationFailed,
    mocks.attachOwnedNumberToCustomerProfile,
    mocks.resolveProviderCreateIntent,
    mocks.readProviderCreateIntentForPayload,
  ]) {
    fn.mockResolvedValue(undefined);
  }
  mocks.markRegistrationSubmitted.mockResolvedValue({ completed: true });
  mocks.findOwnedNumberId.mockResolvedValue(null);
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  mocks.getActiveSmsNumber.mockResolvedValue(PENDING_NUMBER);
  mocks.verifyPublishedCompliancePage.mockResolvedValue(undefined);
  mocks.buildProviderResourceName.mockImplementation(
    (leadingName: string, businessId: string) =>
      `${leadingName} (${businessId})`
  );
  mocks.prepareExistingTelnyxBrandLinkForLaunch.mockResolvedValue({
    status: "not_requested",
  });
  mocks.purchaseNumber.mockResolvedValue({
    phoneNumber: PENDING_NUMBER,
    phoneNumberId: TELNYX_NUMBER_ID,
    numberOrderPhoneNumberId: LEGACY_NUMBER_ORDER_PHONE_NUMBER_ID,
    numberOrderId: NUMBER_ORDER_ID,
    providerCreateIntentId: "c0000000-0000-4000-8000-00000000b1c1",
    status: "success",
  });
});

describe("attemptPaidLaunch carrier rejection guard", () => {
  it.each([
    ["brand-only", { brand_status: "rejected", campaign_status: null }],
    ["campaign-only", { brand_status: "approved", campaign_status: "rejected" }],
    ["dual", { brand_status: "rejected", campaign_status: "rejected" }],
  ])(
    "routes a %s rejection to support before any launch side effect",
    async (_label, statuses) => {
      queueResults({
        data: { ...LAUNCH_BUSINESS, ...statuses },
        error: null,
      });

      const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

      expect(result).toEqual({
        status: "rejection_support_required",
        message: REJECTION_SUPPORT_MESSAGE,
      });
      // The launch-row read is the only database interaction. In particular,
      // no billing/registration claim or provider helper is reachable.
      expect(mocks.from).toHaveBeenCalledTimes(1);
      for (const sideEffect of [
        mocks.resolveBusinessOperationalControls,
        mocks.resolveSmsProvisioningAccess,
        mocks.claimSmsLaunchPlanFamily,
        mocks.getBusinessContentQuality,
        mocks.getA2pRiskClearanceForBusiness,
        mocks.screenA2pRiskForBusiness,
        mocks.claimRegistrationAttempt,
        mocks.prepareExistingTelnyxBrandLinkForLaunch,
        mocks.archiveAndClearRejectedBrand,
        mocks.registerBrand,
        mocks.createMessagingProfile,
        mocks.createVoiceApplication,
        mocks.findOwnedNumberId,
        mocks.attachOwnedNumberToCustomerProfile,
        mocks.purchaseNumber,
        mocks.getActiveSmsNumber,
        mocks.verifyPublishedCompliancePage,
        mocks.archiveAndClearRejectedCampaign,
        mocks.registerCampaign,
        mocks.ensureCampaignAssignmentForBusiness,
        mocks.markRegistrationFailed,
        mocks.markRegistrationSubmitted,
      ]) {
        expect(sideEffect).not.toHaveBeenCalled();
      }
    }
  );

  it("keeps a non-rejection technical failure eligible for launch recovery", async () => {
    queueResults(
      {
        data: {
          ...LAUNCH_BUSINESS,
          onboarding_registration_status: "failed",
          brand_status: "pending",
          campaign_status: null,
        },
        error: null,
      },
      { data: null, error: null },
      { data: null, error: null }
    );
    mocks.claimRegistrationAttempt.mockResolvedValueOnce({
      claimed: true,
      claimedFrom: "failed",
      startedAt: "2026-07-15T00:00:00.000Z",
    });
    mocks.buildProviderResourceName.mockImplementationOnce(() => {
      throw new Error("provider resource-name invariant failed");
    });

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("failed");
    expect(mocks.claimRegistrationAttempt).toHaveBeenCalledWith(BUSINESS_ID);
    expect(mocks.buildProviderResourceName).toHaveBeenCalled();
    expect(mocks.markRegistrationFailed).toHaveBeenCalled();
  });

  it("rechecks after claiming a failed row and stops before provider work", async () => {
    const carrierReason = "Carrier rejected while the retry was being claimed";
    queueResults(
      {
        data: {
          ...LAUNCH_BUSINESS,
          onboarding_registration_status: "failed",
          brand_status: "pending",
          campaign_status: null,
        },
        error: null,
      },
      { data: null, error: null },
      { data: null, error: null },
      { error: null },
    );
    mocks.claimRegistrationAttempt.mockResolvedValueOnce({
      claimed: true,
      claimedFrom: "failed",
      startedAt: "2026-07-15T00:00:00.000Z",
    });
    mocks.assertNoCarrierRejectionForBusiness.mockRejectedValueOnce(
      new CarrierRejectionSupportRequiredError({
        carrierReason,
        rejectedResource: "brand",
      }),
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result).toEqual({
      status: "rejection_support_required",
      message: REJECTION_SUPPORT_MESSAGE,
    });
    expect(mocks.prepareExistingTelnyxBrandLinkForLaunch).not.toHaveBeenCalled();
    expect(mocks.registerBrand).not.toHaveBeenCalled();
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
    expect(mocks.registerCampaign).not.toHaveBeenCalled();
    expect(mocks.markRegistrationSubmitted).not.toHaveBeenCalled();
  });

  it.each([
    ["messaging-profile", 2, 0],
    ["voice-application", 3, 1],
  ] as const)(
    "stops at the %s boundary when rejection lands between provider steps",
    async (_boundary, clearGuardCount, expectedProfileCalls) => {
      queueResults(
        { data: LAUNCH_BUSINESS, error: null },
        { data: null, error: null },
        { data: null, error: null },
        { error: null },
      );
      for (let index = 0; index < clearGuardCount; index += 1) {
        mocks.assertNoCarrierRejectionForBusiness.mockResolvedValueOnce(
          undefined,
        );
      }
      mocks.assertNoCarrierRejectionForBusiness.mockRejectedValueOnce(
        new CarrierRejectionSupportRequiredError({
          carrierReason: "Carrier rejected between provider steps",
          rejectedResource: "brand",
        }),
      );

      const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

      expect(result).toEqual({
        status: "rejection_support_required",
        message: REJECTION_SUPPORT_MESSAGE,
      });
      expect(mocks.registerBrand).toHaveBeenCalledTimes(1);
      expect(mocks.createMessagingProfile).toHaveBeenCalledTimes(
        expectedProfileCalls,
      );
      expect(mocks.createVoiceApplication).not.toHaveBeenCalled();
      expect(mocks.purchaseNumber).not.toHaveBeenCalled();
      expect(mocks.registerCampaign).not.toHaveBeenCalled();
    },
  );

  it("maps a campaign-boundary rejection race to support and releases only its claim", async () => {
    const activeNumber = {
      id: "phone-row-race",
      phone_number: PENDING_NUMBER,
      telnyx_phone_number_id: TELNYX_NUMBER_ID,
    };
    const carrierReason = "Exact carrier reason from the rejection webhook";
    queueResults(
      {
        data: {
          ...LAUNCH_BUSINESS,
          brand_status: "approved",
          campaign_status: null,
        },
        error: null,
      },
      { data: null, error: null },
      { data: activeNumber, error: null },
      { data: activeNumber, error: null },
      { error: null },
      { error: null }
    );
    mocks.registerCampaign.mockRejectedValueOnce(
      new CarrierRejectionSupportRequiredError({
        carrierReason,
        rejectedResource: "campaign",
      })
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result).toEqual({
      status: "rejection_support_required",
      message: REJECTION_SUPPORT_MESSAGE,
    });
    expect(chains[5].update).toHaveBeenCalledWith(
      expect.objectContaining({
        onboarding_registration_status: "failed",
        onboarding_registration_error: carrierReason,
        onboarding_registration_submitted_at: null,
        onboarding_step: "carrier_review",
      })
    );
    expect(chains[5].eq).toHaveBeenCalledWith(
      "onboarding_registration_status",
      "submitting"
    );
    expect(chains[5].eq).toHaveBeenCalledWith(
      "onboarding_registration_started_at",
      "2026-07-15T00:00:00.000Z"
    );
    expect(chains[5].or).toHaveBeenCalledWith(
      "brand_status.eq.rejected,campaign_status.eq.rejected"
    );
    expect(mocks.ensureCampaignAssignmentForBusiness).not.toHaveBeenCalled();
    expect(mocks.markRegistrationSubmitted).not.toHaveBeenCalled();
    expect(mocks.markRegistrationFailed).not.toHaveBeenCalled();
  });

  it("maps a rejection that wins exact-claim completion to support", async () => {
    const activeNumber = {
      id: "phone-row-completion-race",
      phone_number: PENDING_NUMBER,
      telnyx_phone_number_id: TELNYX_NUMBER_ID,
    };
    const carrierReason = "Carrier rejected before completion committed";
    queueResults(
      { data: LAUNCH_BUSINESS, error: null },
      { data: null, error: null },
      { data: activeNumber, error: null },
      { data: activeNumber, error: null },
      { error: null },
      { error: null },
    );
    mocks.markRegistrationSubmitted.mockResolvedValueOnce({
      completed: false,
      current: {
        id: BUSINESS_ID,
        onboarding_registration_status: "failed",
        onboarding_registration_started_at: "2026-07-15T00:00:00.000Z",
        onboarding_registration_submitted_at: null,
        onboarding_registration_error: carrierReason,
      },
    });
    mocks.assertNoCarrierRejectionForBusiness
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new CarrierRejectionSupportRequiredError({
          carrierReason,
          rejectedResource: "campaign",
        }),
      );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result).toEqual({
      status: "rejection_support_required",
      message: REJECTION_SUPPORT_MESSAGE,
    });
    expect(mocks.markRegistrationSubmitted).toHaveBeenCalledWith(
      BUSINESS_ID,
      "2026-07-15T00:00:00.000Z",
    );
    expect(mocks.markRegistrationFailed).not.toHaveBeenCalled();
  });
});

describe("attemptPaidLaunch number purchase recovery", () => {
  it("stops a canceled paid upgrade at the final provider boundary without creating a brand", async () => {
    queueResults({ data: LAUNCH_BUSINESS, error: null });
    mocks.assertTextingUpgradeProvisioningAllowed.mockRejectedValue(new TextingUpgradeProvisioningStoppedError());
    const result = await attemptPaidLaunch(BUSINESS_ID, "texting_upgrade");
    expect(result.status).toBe("billing_required");
    expect(mocks.registerBrand).not.toHaveBeenCalled();
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
    expect(mocks.markRegistrationFailed).not.toHaveBeenCalled();
  });

  it("reconciles activation after an already-submitted upgrade without recreating registration", async () => {
    queueResults({ data: LAUNCH_BUSINESS, error: null });
    mocks.claimRegistrationAttempt.mockResolvedValue({ claimed: false, reason: "already_submitted" });
    await expect(attemptPaidLaunch(BUSINESS_ID, "texting_upgrade")).resolves.toEqual({ status: "already_submitted" });
    expect(mocks.reconcileTextingUpgradeActivationForBusiness).toHaveBeenCalledWith(BUSINESS_ID);
    expect(mocks.registerBrand).not.toHaveBeenCalled();
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
  });
  it.each([
    [
      "a canceled Chat Checkout family lock",
      {
        allowed: false,
        reason: "plan_not_entitled",
        source: "direct_precheckout",
        plan: "chat_only",
      },
    ],
    [
      "contradictory billing and family state",
      { allowed: false, reason: "billing_state_unavailable" },
    ],
  ] as const)(
    "stops %s before content, risk, registration claims, or Telnyx",
    async (_label, decision) => {
      mocks.resolveSmsProvisioningAccess.mockResolvedValue(decision);
      queueResults({ data: LAUNCH_BUSINESS, error: null });

      const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

      expect(result).toEqual({
        status: "billing_required",
        message: "Finish checkout before submitting SMS registration.",
      });
      expect(mocks.getBusinessContentQuality).not.toHaveBeenCalled();
      expect(mocks.getA2pRiskClearanceForBusiness).not.toHaveBeenCalled();
      expect(mocks.claimRegistrationAttempt).not.toHaveBeenCalled();
      expect(mocks.registerBrand).not.toHaveBeenCalled();
      expect(mocks.createMessagingProfile).not.toHaveBeenCalled();
      expect(mocks.purchaseNumber).not.toHaveBeenCalled();
    },
  );

  it("loses an opposing Chat Checkout race before risk, registration claims, or Telnyx", async () => {
    mocks.claimSmsLaunchPlanFamily.mockResolvedValue(false);
    queueResults(
      { data: LAUNCH_BUSINESS, error: null },
      { data: null, error: null },
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result).toEqual({
      status: "billing_required",
      message: "Finish checkout before submitting SMS registration.",
    });
    expect(mocks.claimSmsLaunchPlanFamily).toHaveBeenCalledWith(BUSINESS_ID);
    expect(mocks.getA2pRiskClearanceForBusiness).not.toHaveBeenCalled();
    expect(mocks.claimRegistrationAttempt).not.toHaveBeenCalled();
    expect(mocks.registerBrand).not.toHaveBeenCalled();
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
  });

  it("returns neutral copy when registration is administratively disabled", async () => {
    queueResults({
      data: { ...LAUNCH_BUSINESS, telnyx_submission_disabled: true },
      error: null,
    });

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result).toEqual({
      status: "submission_disabled",
      message:
        "SMS registration is disabled for this account. Contact support if this looks wrong.",
    });
    expect(mocks.markRegistrationFailed).toHaveBeenCalledWith(
      BUSINESS_ID,
      "SMS registration is disabled for this account. Contact support if this looks wrong."
    );
    expect(mocks.getA2pRiskClearanceForBusiness).not.toHaveBeenCalled();
    expect(mocks.claimRegistrationAttempt).not.toHaveBeenCalled();
  });

  it("returns neutral copy when no business number has been selected", async () => {
    queueResults(
      {
        data: { ...LAUNCH_BUSINESS, pending_phone_number: null },
        error: null,
      },
      { data: null, error: null },
      { data: null, error: null }
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result).toEqual({
      status: "missing_phone_number",
      message: "Choose your business number before submitting SMS registration.",
    });
    expect(mocks.claimRegistrationAttempt).not.toHaveBeenCalled();
    expect(mocks.registerBrand).not.toHaveBeenCalled();
  });

  it("returns a typed suspension before billing, claims, or provider work", async () => {
    queueResults({ data: LAUNCH_BUSINESS, error: null });
    mocks.resolveBusinessOperationalControls.mockResolvedValue({
      businessId: BUSINESS_ID,
      operationsSuspendedAt: "2026-07-28T10:00:00.000Z",
      aiRepliesPausedAt: null,
      textingPausedAt: null,
      bookingsPausedAt: null,
    });

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result).toEqual({
      status: "operations_suspended",
      message:
        "Account operations are suspended. Reactivate the account before SMS registration can continue.",
    });
    expect(chains).toHaveLength(1);
    expect(mocks.getBusinessContentQuality).not.toHaveBeenCalled();
    expect(mocks.getA2pRiskClearanceForBusiness).not.toHaveBeenCalled();
    expect(mocks.claimRegistrationAttempt).not.toHaveBeenCalled();
    expect(mocks.prepareExistingTelnyxBrandLinkForLaunch).not.toHaveBeenCalled();
    expect(mocks.registerBrand).not.toHaveBeenCalled();
    expect(mocks.createMessagingProfile).not.toHaveBeenCalled();
    expect(mocks.createVoiceApplication).not.toHaveBeenCalled();
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
    expect(mocks.registerCampaign).not.toHaveBeenCalled();
    expect(mocks.ensureCampaignAssignmentForBusiness).not.toHaveBeenCalled();
    expect(mocks.markRegistrationFailed).not.toHaveBeenCalled();
  });

  it("fails closed before billing or provider work when suspension state is indeterminate", async () => {
    queueResults({ data: LAUNCH_BUSINESS, error: null });
    mocks.resolveBusinessOperationalControls.mockRejectedValue(
      new Error("operational state unavailable")
    );

    await expect(
      attemptPaidLaunch(BUSINESS_ID, "onboarding_retry")
    ).rejects.toThrow("operational state unavailable");

    expect(chains).toHaveLength(1);
    expect(mocks.claimRegistrationAttempt).not.toHaveBeenCalled();
    expect(mocks.registerBrand).not.toHaveBeenCalled();
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
    expect(mocks.markRegistrationFailed).not.toHaveBeenCalled();
  });

  it("keeps provisioning available when only texting is paused", async () => {
    mocks.resolveBusinessOperationalControls.mockResolvedValue({
      businessId: BUSINESS_ID,
      operationsSuspendedAt: null,
      aiRepliesPausedAt: null,
      textingPausedAt: "2026-07-28T10:00:00.000Z",
      bookingsPausedAt: null,
    });
    queueHappyPathThrough(
      { data: null, error: null },
      { error: null },
      { error: null }
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("submitted");
    expect(mocks.registerBrand).toHaveBeenCalledOnce();
    expect(mocks.createMessagingProfile).toHaveBeenCalledOnce();
    expect(mocks.createVoiceApplication).toHaveBeenCalledOnce();
    expect(mocks.purchaseNumber).toHaveBeenCalledOnce();
    expect(mocks.registerCampaign).toHaveBeenCalledOnce();
    expect(mocks.ensureCampaignAssignmentForBusiness).toHaveBeenCalledOnce();
  });

  it("stops a deficient initial launch before billing, risk, claims, or provider work", async () => {
    queueResults({ data: LAUNCH_BUSINESS, error: null });
    mocks.getBusinessContentQuality.mockResolvedValue({
      ready: false,
      validServiceCount: 3,
      validFaqCount: 2,
    });

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result).toMatchObject({ status: "services_faqs_required" });
    expect(mocks.getA2pRiskClearanceForBusiness).not.toHaveBeenCalled();
    expect(mocks.claimRegistrationAttempt).not.toHaveBeenCalled();
    expect(mocks.registerBrand).not.toHaveBeenCalled();
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
    expect(mocks.markRegistrationFailed).not.toHaveBeenCalled();
  });

  it.each(["past_due", "canceled"])(
    "does not let a billing override bypass an existing %s subscription",
    async (status) => {
      queueResults(
        { data: LAUNCH_BUSINESS, error: null },
        {
          data: {
            status,
            setup_fee_paid_at: "2026-07-01T00:00:00.000Z",
          },
          error: null,
        }
      );

      const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

      expect(result.status).toBe("billing_required");
      expect(mocks.registerBrand).not.toHaveBeenCalled();
      expect(mocks.purchaseNumber).not.toHaveBeenCalled();
      expect(mocks.claimRegistrationAttempt).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["invoiced", "sms_only"],
    ["invoiced", "sms_and_chat"],
    ["invoiced", "full"],
    ["comped", "sms_only"],
    ["comped", "sms_and_chat"],
    ["comped", "full"],
  ] as const)(
    "launches a valid %s/%s partner plan without a subscription, setup fee, or legacy override",
    async (billingMode, partnerPlan) => {
      queueResults(
        {
          data: {
            ...LAUNCH_BUSINESS,
            billing_mode: billingMode,
            partner_plan: partnerPlan,
            billing_exempt: false,
          },
          error: null,
        },
        { data: null, error: null },
        { data: null, error: null },
        { data: null, error: null },
        { data: null, error: null },
        { error: null },
        { error: null }
      );

      const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

      expect(result.status).toBe("submitted");
      expect(mocks.purchaseNumber).toHaveBeenCalledWith(
        PENDING_NUMBER,
        BUSINESS_ID
      );
      expect(mocks.markRegistrationSubmitted).toHaveBeenCalledWith(
        BUSINESS_ID,
        "2026-07-15T00:00:00.000Z",
      );
    }
  );

  it.each([null, "enterprise"])(
    "rejects malformed native partner plan %# before risk, claims, or Telnyx work",
    async (partnerPlan) => {
      queueResults(
        {
          data: {
            ...LAUNCH_BUSINESS,
            billing_mode: "invoiced",
            partner_plan: partnerPlan,
            billing_pilot: true,
            billing_comped: true,
            billing_exempt: true,
          },
          error: null,
        },
        { data: null, error: null }
      );

      const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

      expect(result.status).toBe("billing_required");
      expect(mocks.getA2pRiskClearanceForBusiness).not.toHaveBeenCalled();
      expect(mocks.claimRegistrationAttempt).not.toHaveBeenCalled();
      expect(
        mocks.prepareExistingTelnyxBrandLinkForLaunch
      ).not.toHaveBeenCalled();
      expect(mocks.registerBrand).not.toHaveBeenCalled();
      expect(mocks.createMessagingProfile).not.toHaveBeenCalled();
      expect(mocks.createVoiceApplication).not.toHaveBeenCalled();
      expect(mocks.purchaseNumber).not.toHaveBeenCalled();
      expect(mocks.registerCampaign).not.toHaveBeenCalled();
    }
  );

  it("recognizes chat-only partner billing without allowing SMS/Telnyx launch", async () => {
    queueResults(
      {
        data: {
          ...LAUNCH_BUSINESS,
          billing_mode: "invoiced",
          partner_plan: "chat_only",
          billing_pilot: true,
          billing_comped: true,
          billing_exempt: true,
        },
        error: null,
      },
      { data: null, error: null },
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("billing_required");
    expect(mocks.getA2pRiskClearanceForBusiness).not.toHaveBeenCalled();
    expect(mocks.claimRegistrationAttempt).not.toHaveBeenCalled();
    expect(mocks.registerBrand).not.toHaveBeenCalled();
    expect(mocks.createMessagingProfile).not.toHaveBeenCalled();
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
    expect(mocks.registerCampaign).not.toHaveBeenCalled();
  });

  it("does not let a direct chat-only subscription enter SMS/Telnyx launch", async () => {
    queueResults(
      { data: LAUNCH_BUSINESS, error: null },
      {
        data: {
          plan: "chat_only",
          status: "active",
          setup_fee_paid_at: "2026-07-01T00:00:00.000Z",
        },
        error: null,
      },
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "stripe_finalize");

    expect(result.status).toBe("billing_required");
    expect(mocks.getA2pRiskClearanceForBusiness).not.toHaveBeenCalled();
    expect(mocks.claimRegistrationAttempt).not.toHaveBeenCalled();
    expect(mocks.registerBrand).not.toHaveBeenCalled();
    expect(mocks.createMessagingProfile).not.toHaveBeenCalled();
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
    expect(mocks.registerCampaign).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "enterprise"])(
    "fails closed for malformed direct subscription plan %# before SMS/Telnyx launch",
    async (plan) => {
      queueResults(
        { data: LAUNCH_BUSINESS, error: null },
        {
          data: {
            plan,
            status: "active",
            setup_fee_paid_at: "2026-07-01T00:00:00.000Z",
          },
          error: null,
        },
      );

      const result = await attemptPaidLaunch(BUSINESS_ID, "stripe_finalize");

      expect(result.status).toBe("billing_required");
      expect(mocks.getA2pRiskClearanceForBusiness).not.toHaveBeenCalled();
      expect(mocks.claimRegistrationAttempt).not.toHaveBeenCalled();
      expect(mocks.registerBrand).not.toHaveBeenCalled();
      expect(mocks.createMessagingProfile).not.toHaveBeenCalled();
      expect(mocks.purchaseNumber).not.toHaveBeenCalled();
      expect(mocks.registerCampaign).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, "external"])(
    "rejects malformed billing mode %# even when every legacy override is set",
    async (billingMode) => {
      queueResults(
        {
          data: {
            ...LAUNCH_BUSINESS,
            billing_mode: billingMode,
            partner_plan: null,
            billing_pilot: true,
            billing_comped: true,
            billing_exempt: true,
          },
          error: null,
        },
        { data: null, error: null }
      );

      const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

      expect(result.status).toBe("billing_required");
      expect(mocks.getA2pRiskClearanceForBusiness).not.toHaveBeenCalled();
      expect(mocks.claimRegistrationAttempt).not.toHaveBeenCalled();
      expect(mocks.registerBrand).not.toHaveBeenCalled();
      expect(mocks.purchaseNumber).not.toHaveBeenCalled();
      expect(mocks.registerCampaign).not.toHaveBeenCalled();
    }
  );

  it("rejects a Stripe business carrying a partner plan before provider work", async () => {
    queueResults(
      {
        data: {
          ...LAUNCH_BUSINESS,
          partner_plan: "full",
          billing_exempt: true,
        },
        error: null,
      },
      { data: null, error: null }
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("billing_required");
    expect(mocks.getA2pRiskClearanceForBusiness).not.toHaveBeenCalled();
    expect(mocks.claimRegistrationAttempt).not.toHaveBeenCalled();
    expect(mocks.registerBrand).not.toHaveBeenCalled();
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
  });

  it.each(["billing_pilot", "billing_comped", "billing_exempt"] as const)(
    "preserves Stripe-mode legacy %s launch authorization",
    async (flag) => {
      queueResults(
        {
          data: {
            ...LAUNCH_BUSINESS,
            billing_pilot: false,
            billing_comped: false,
            billing_exempt: false,
            [flag]: true,
          },
          error: null,
        },
        { data: null, error: null },
        {
          data: {
            id: "number-row-legacy-override",
            phone_number: PENDING_NUMBER,
            telnyx_phone_number_id: TELNYX_NUMBER_ID,
          },
          error: null,
        }
      );
      mocks.claimRegistrationAttempt.mockResolvedValue({
        claimed: false,
        reason: "already_submitted",
      });

      const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

      expect(result.status).toBe("already_submitted");
      expect(mocks.claimRegistrationAttempt).toHaveBeenCalledWith(BUSINESS_ID);
      expect(mocks.registerBrand).not.toHaveBeenCalled();
      expect(mocks.purchaseNumber).not.toHaveBeenCalled();
    }
  );

  it("submits on the fresh-purchase happy path", async () => {
    queueHappyPathThrough(
      { data: null, error: null }, // step-1 collision check
      { error: null }, // insert
      { error: null } // clearPending
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("submitted");
    expect(mocks.purchaseNumber).toHaveBeenCalledWith(
      PENDING_NUMBER,
      BUSINESS_ID
    );
    expect(chains[5].insert).toHaveBeenCalledWith({
      business_id: BUSINESS_ID,
      phone_number: PENDING_NUMBER,
      telnyx_phone_number_id: TELNYX_NUMBER_ID,
      telnyx_number_order_phone_number_id:
        LEGACY_NUMBER_ORDER_PHONE_NUMBER_ID,
      telnyx_number_order_id: NUMBER_ORDER_ID,
      is_active: true,
    });
    expect(chains[0].select).toHaveBeenCalledWith(
      expect.stringContaining("ai_settings(language)")
    );
    expect(chains[0].select).toHaveBeenCalledWith(
      expect.stringContaining("legal_business_name")
    );
    expect(mocks.buildProviderResourceName).toHaveBeenCalledWith(
      LAUNCH_BUSINESS.legal_business_name,
      BUSINESS_ID
    );
    expect(
      mocks.buildProviderResourceName.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mocks.prepareExistingTelnyxBrandLinkForLaunch.mock.invocationCallOrder[0]
    );
    expect(
      mocks.prepareExistingTelnyxBrandLinkForLaunch.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.registerBrand.mock.invocationCallOrder[0]);
    expect(mocks.registerBrand.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createMessagingProfile.mock.invocationCallOrder[0]
    );
    expect(
      mocks.createMessagingProfile.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.createVoiceApplication.mock.invocationCallOrder[0]);
    expect(
      mocks.createVoiceApplication.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.purchaseNumber.mock.invocationCallOrder[0]);
    expect(mocks.purchaseNumber.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getActiveSmsNumber.mock.invocationCallOrder[0]
    );
    expect(
      mocks.getActiveSmsNumber.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.verifyPublishedCompliancePage.mock.invocationCallOrder[0]);
    expect(
      mocks.verifyPublishedCompliancePage.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.registerCampaign.mock.invocationCallOrder[0]);
    expect(mocks.verifyPublishedCompliancePage).toHaveBeenCalledWith({
      slug: LAUNCH_BUSINESS.slug,
      businessName: LAUNCH_BUSINESS.name,
      smsPhoneNumber: PENDING_NUMBER,
      language: "en",
    });
    expect(mocks.markRegistrationSubmitted).toHaveBeenCalledWith(
      BUSINESS_ID,
      "2026-07-15T00:00:00.000Z",
    );
  });

  it("fails before every provider mutation when the name preflight fails", async () => {
    queueHappyPathThrough();
    mocks.buildProviderResourceName.mockImplementationOnce(() => {
      throw new Error("provider resource-name invariant failed");
    });

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("failed");
    expect(mocks.buildProviderResourceName).toHaveBeenCalledWith(
      LAUNCH_BUSINESS.legal_business_name,
      BUSINESS_ID
    );
    expect(mocks.markRegistrationFailed).toHaveBeenCalledWith(
      BUSINESS_ID,
      expect.stringContaining("Couldn't submit your SMS registration")
    );
    expect(
      mocks.prepareExistingTelnyxBrandLinkForLaunch
    ).not.toHaveBeenCalled();
    expect(mocks.archiveAndClearRejectedBrand).not.toHaveBeenCalled();
    expect(mocks.registerBrand).not.toHaveBeenCalled();
    expect(mocks.createMessagingProfile).not.toHaveBeenCalled();
    expect(mocks.createVoiceApplication).not.toHaveBeenCalled();
    expect(mocks.attachOwnedNumberToCustomerProfile).not.toHaveBeenCalled();
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
    expect(mocks.verifyPublishedCompliancePage).not.toHaveBeenCalled();
    expect(mocks.archiveAndClearRejectedCampaign).not.toHaveBeenCalled();
    expect(mocks.registerCampaign).not.toHaveBeenCalled();
    expect(mocks.ensureCampaignAssignmentForBusiness).not.toHaveBeenCalled();
    expect(mocks.markRegistrationSubmitted).not.toHaveBeenCalled();
  });

  it("falls back to the business name during provider-name preflight", async () => {
    queueResults(
      {
        data: { ...LAUNCH_BUSINESS, legal_business_name: null },
        error: null,
      },
      { data: null, error: null },
      { data: null, error: null }
    );
    mocks.buildProviderResourceName.mockImplementationOnce(() => {
      throw new Error("provider resource-name invariant failed");
    });

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("failed");
    expect(mocks.buildProviderResourceName).toHaveBeenCalledWith(
      LAUNCH_BUSINESS.name,
      BUSINESS_ID
    );
    expect(mocks.registerBrand).not.toHaveBeenCalled();
  });

  it("fails before campaign cleanup or submission when the strict active number disappears", async () => {
    queueHappyPathThrough(
      { data: null, error: null },
      { error: null },
      { error: null }
    );
    mocks.getActiveSmsNumber.mockResolvedValue(null);

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("failed");
    expect(mocks.verifyPublishedCompliancePage).not.toHaveBeenCalled();
    expect(mocks.archiveAndClearRejectedCampaign).not.toHaveBeenCalled();
    expect(mocks.registerCampaign).not.toHaveBeenCalled();
    expect(mocks.ensureCampaignAssignmentForBusiness).not.toHaveBeenCalled();
  });

  it("keeps the campaign-fee path closed until deployed raw HTML passes", async () => {
    queueHappyPathThrough(
      { data: null, error: null },
      { error: null },
      { error: null }
    );
    mocks.verifyPublishedCompliancePage.mockRejectedValue(
      new Error("raw HTML missing SMS disclosures")
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("failed");
    expect(mocks.archiveAndClearRejectedCampaign).not.toHaveBeenCalled();
    expect(mocks.registerCampaign).not.toHaveBeenCalled();
    expect(mocks.ensureCampaignAssignmentForBusiness).not.toHaveBeenCalled();
    expect(mocks.markRegistrationSubmitted).not.toHaveBeenCalled();
  });

  it("keeps launch closed after a messaging-profile provider-list failure", async () => {
    queueHappyPathThrough();
    mocks.createMessagingProfile.mockRejectedValue(
      new Error("Could not check Telnyx for an existing profile")
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("failed");
    expect(mocks.createVoiceApplication).not.toHaveBeenCalled();
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
    expect(mocks.verifyPublishedCompliancePage).not.toHaveBeenCalled();
    expect(mocks.archiveAndClearRejectedCampaign).not.toHaveBeenCalled();
    expect(mocks.registerCampaign).not.toHaveBeenCalled();
    expect(mocks.ensureCampaignAssignmentForBusiness).not.toHaveBeenCalled();
    expect(mocks.markRegistrationSubmitted).not.toHaveBeenCalled();
    expect(mocks.markRegistrationFailed).toHaveBeenCalled();
  });

  it("stops before number, page, and campaign work when voice setup fails", async () => {
    queueHappyPathThrough();
    mocks.createVoiceApplication.mockRejectedValue(
      new Error("voice application reconciliation required")
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("failed");
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
    expect(mocks.verifyPublishedCompliancePage).not.toHaveBeenCalled();
    expect(mocks.archiveAndClearRejectedCampaign).not.toHaveBeenCalled();
    expect(mocks.registerCampaign).not.toHaveBeenCalled();
  });

  it("classifies a save failure as retryable with truthful copy, keeping the pending number", async () => {
    queueHappyPathThrough(
      { data: null, error: null }, // step-1 collision check
      {
        error: {
          message:
            'duplicate key value violates unique constraint "phone_numbers_phone_number_key"',
        },
      } // insert fails — message contains the relation name that fooled the old regex
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    // NOT number_unavailable: the customer was charged, so no re-pick and
    // no false "you will not be charged again for a fresh number" routing.
    expect(result.status).toBe("failed");
    expect(result.message).toContain("Retry to complete setup");
    expect(mocks.markRegistrationFailed).toHaveBeenCalledWith(
      BUSINESS_ID,
      expect.stringContaining("we couldn't finish saving it")
    );
    // pending_phone_number kept: no update carrying pending_phone_number null
    // (persistNumberFailure would also write a failure_reason — must not run).
    for (const chain of chains) {
      for (const call of chain.update.mock.calls) {
        expect(call[0]).not.toHaveProperty("pending_phone_number_failure_reason");
      }
    }
  });

  it("recovers an owned-but-unsaved number without purchasing again", async () => {
    mocks.findOwnedNumberId.mockResolvedValue(TELNYX_NUMBER_ID);
    queueHappyPathThrough(
      { data: null, error: null }, // step-1 collision check
      { error: null }, // insert (recovery save)
      { error: null } // clearPending
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("submitted");
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
    // The scoping pin: recovery must be customer_reference-scoped to THIS
    // business — an unscoped lookup lets one business seize another's paid
    // number on a single Telnyx account.
    expect(mocks.findOwnedNumberId).toHaveBeenCalledWith(
      PENDING_NUMBER,
      BUSINESS_ID
    );
    expect(mocks.attachOwnedNumberToCustomerProfile).toHaveBeenCalledWith(
      BUSINESS_ID,
      TELNYX_NUMBER_ID
    );
  });

  it("repairs a legacy order-line UUID before reattaching an active number", async () => {
    const legacyActiveNumber = {
      id: "phone-row-legacy-order-id",
      phone_number: PENDING_NUMBER,
      telnyx_phone_number_id: LEGACY_NUMBER_ORDER_PHONE_NUMBER_ID,
    };
    const providerCreateIntentId =
      "c0000000-0000-4000-8000-00000000b1c2";
    mocks.readProviderCreateIntentForPayload.mockResolvedValueOnce(
      providerCreateIntentId
    );
    mocks.findOwnedNumberId.mockResolvedValue(TELNYX_NUMBER_ID);
    queueResults(
      {
        data: { ...LAUNCH_BUSINESS, pending_phone_number: null },
        error: null,
      },
      { data: null, error: null },
      { data: legacyActiveNumber, error: null },
      { data: legacyActiveNumber, error: null },
      { error: null }
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("submitted");
    expect(mocks.findOwnedNumberId).toHaveBeenCalledWith(
      PENDING_NUMBER,
      BUSINESS_ID
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "repair_telnyx_phone_number_resource_id",
      {
        p_business_id: BUSINESS_ID,
        p_phone_number_id: legacyActiveNumber.id,
        p_phone_number: PENDING_NUMBER,
        p_expected_legacy_id: LEGACY_NUMBER_ORDER_PHONE_NUMBER_ID,
        p_resolved_resource_id: TELNYX_NUMBER_ID,
      }
    );
    expect(mocks.attachOwnedNumberToCustomerProfile).toHaveBeenCalledWith(
      BUSINESS_ID,
      TELNYX_NUMBER_ID
    );
    expect(
      mocks.readProviderCreateIntentForPayload.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.rpc.mock.invocationCallOrder[0]);
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.attachOwnedNumberToCustomerProfile.mock.invocationCallOrder[0]
    );
    expect(mocks.resolveProviderCreateIntent).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      spec: {
        eventType: "phone_number_order_create_intent",
        resourceType: "phone_number",
      },
      intentId: providerCreateIntentId,
    });
    expect(
      mocks.attachOwnedNumberToCustomerProfile.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.resolveProviderCreateIntent.mock.invocationCallOrder[0]);
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
  });

  it("rejects an intent mismatch before legacy repair or routing mutations", async () => {
    const legacyActiveNumber = {
      id: "phone-row-intent-mismatch",
      phone_number: PENDING_NUMBER,
      telnyx_phone_number_id: LEGACY_NUMBER_ORDER_PHONE_NUMBER_ID,
    };
    mocks.readProviderCreateIntentForPayload.mockRejectedValueOnce(
      new Error("provider intent belongs to a different phone number")
    );
    queueResults(
      {
        data: { ...LAUNCH_BUSINESS, pending_phone_number: null },
        error: null,
      },
      { data: null, error: null },
      { data: legacyActiveNumber, error: null },
      { data: legacyActiveNumber, error: null }
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("failed");
    expect(mocks.findOwnedNumberId).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.attachOwnedNumberToCustomerProfile).not.toHaveBeenCalled();
    expect(mocks.resolveProviderCreateIntent).not.toHaveBeenCalled();
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
    expect(mocks.verifyPublishedCompliancePage).not.toHaveBeenCalled();
    expect(mocks.registerCampaign).not.toHaveBeenCalled();
  });

  it("fails closed without a provider lookup for an unknown stored ID shape", async () => {
    const corruptActiveNumber = {
      id: "phone-row-corrupt-provider-id",
      phone_number: PENDING_NUMBER,
      telnyx_phone_number_id: "not-an-endpoint-provenance-id",
    };
    queueResults(
      {
        data: { ...LAUNCH_BUSINESS, pending_phone_number: null },
        error: null,
      },
      { data: null, error: null },
      { data: corruptActiveNumber, error: null },
      { data: corruptActiveNumber, error: null }
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("failed");
    expect(mocks.findOwnedNumberId).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.attachOwnedNumberToCustomerProfile).not.toHaveBeenCalled();
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
    expect(mocks.verifyPublishedCompliancePage).not.toHaveBeenCalled();
    expect(mocks.registerCampaign).not.toHaveBeenCalled();
  });

  it("repairs a same-business legacy row found in the purchase race window", async () => {
    const legacyExistingRow = {
      id: "phone-row-race-window",
      business_id: BUSINESS_ID,
      phone_number: PENDING_NUMBER,
      telnyx_phone_number_id: LEGACY_NUMBER_ORDER_PHONE_NUMBER_ID,
    };
    mocks.findOwnedNumberId.mockResolvedValue(TELNYX_NUMBER_ID);
    queueHappyPathThrough(
      { data: legacyExistingRow, error: null },
      { error: null }
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("submitted");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "repair_telnyx_phone_number_resource_id",
      expect.objectContaining({
        p_phone_number_id: legacyExistingRow.id,
        p_expected_legacy_id: LEGACY_NUMBER_ORDER_PHONE_NUMBER_ID,
        p_resolved_resource_id: TELNYX_NUMBER_ID,
      })
    );
    expect(mocks.attachOwnedNumberToCustomerProfile).toHaveBeenCalledWith(
      BUSINESS_ID,
      TELNYX_NUMBER_ID
    );
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
  });

  it("fails closed when a legacy active number cannot be resolved completely", async () => {
    const legacyActiveNumber = {
      id: "phone-row-unresolved",
      phone_number: PENDING_NUMBER,
      telnyx_phone_number_id: LEGACY_NUMBER_ORDER_PHONE_NUMBER_ID,
    };
    mocks.findOwnedNumberId.mockResolvedValue(null);
    queueResults(
      {
        data: { ...LAUNCH_BUSINESS, pending_phone_number: null },
        error: null,
      },
      { data: null, error: null },
      { data: legacyActiveNumber, error: null },
      { data: legacyActiveNumber, error: null }
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("failed");
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.attachOwnedNumberToCustomerProfile).not.toHaveBeenCalled();
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
    expect(mocks.verifyPublishedCompliancePage).not.toHaveBeenCalled();
    expect(mocks.registerCampaign).not.toHaveBeenCalled();
  });

  it("fails closed when the guarded legacy-ID repair is rejected", async () => {
    const legacyActiveNumber = {
      id: "phone-row-repair-race",
      phone_number: PENDING_NUMBER,
      telnyx_phone_number_id: LEGACY_NUMBER_ORDER_PHONE_NUMBER_ID,
    };
    mocks.findOwnedNumberId.mockResolvedValue(TELNYX_NUMBER_ID);
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "repair precondition changed" },
    });
    queueResults(
      {
        data: { ...LAUNCH_BUSINESS, pending_phone_number: null },
        error: null,
      },
      { data: null, error: null },
      { data: legacyActiveNumber, error: null },
      { data: legacyActiveNumber, error: null }
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("failed");
    expect(mocks.attachOwnedNumberToCustomerProfile).not.toHaveBeenCalled();
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
    expect(mocks.verifyPublishedCompliancePage).not.toHaveBeenCalled();
    expect(mocks.registerCampaign).not.toHaveBeenCalled();
  });

  it("retries a purchase-save failure by recovering ownership and never orders twice", async () => {
    mocks.findOwnedNumberId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(TELNYX_NUMBER_ID);
    queueResults(
      { data: LAUNCH_BUSINESS, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { error: { message: "database unavailable after provider success" } },
      { data: LAUNCH_BUSINESS, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { error: null },
      { error: null }
    );

    const first = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");
    const second = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(first.status).toBe("failed");
    expect(second.status).toBe("submitted");
    expect(mocks.purchaseNumber).toHaveBeenCalledTimes(1);
    expect(mocks.findOwnedNumberId).toHaveBeenCalledTimes(2);
    expect(mocks.attachOwnedNumberToCustomerProfile).toHaveBeenCalledWith(
      BUSINESS_ID,
      TELNYX_NUMBER_ID
    );
    expect(mocks.registerCampaign).toHaveBeenCalledTimes(1);
  });

  it("fences an accepted order with delayed resource visibility and never orders twice", async () => {
    const resolutionError = new PurchasedNumberResolutionError({
      phoneNumber: PENDING_NUMBER,
      numberOrderId: NUMBER_ORDER_ID,
      numberOrderPhoneNumberId: LEGACY_NUMBER_ORDER_PHONE_NUMBER_ID,
      status: "success",
      providerCreateIntentId: "c0000000-0000-4000-8000-00000000b1c1",
      cause: new Error("owned number not visible yet"),
    });
    const fencedActiveNumber = {
      id: "phone-row-resolution-fence",
      phone_number: PENDING_NUMBER,
      telnyx_phone_number_id: LEGACY_NUMBER_ORDER_PHONE_NUMBER_ID,
    };
    mocks.purchaseNumber.mockRejectedValueOnce(resolutionError);
    mocks.findOwnedNumberId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(TELNYX_NUMBER_ID);
    queueResults(
      { data: LAUNCH_BUSINESS, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { error: null },
      { data: LAUNCH_BUSINESS, error: null },
      { data: null, error: null },
      { data: fencedActiveNumber, error: null },
      { data: fencedActiveNumber, error: null },
      { error: null }
    );

    const first = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(first.status).toBe("failed");
    expect(first.message).toContain("number was reserved");
    expect(chains[5].insert).toHaveBeenCalledWith({
      business_id: BUSINESS_ID,
      phone_number: PENDING_NUMBER,
      telnyx_phone_number_id: LEGACY_NUMBER_ORDER_PHONE_NUMBER_ID,
      telnyx_number_order_phone_number_id:
        LEGACY_NUMBER_ORDER_PHONE_NUMBER_ID,
      telnyx_number_order_id: NUMBER_ORDER_ID,
      is_active: true,
    });
    expect(mocks.verifyPublishedCompliancePage).not.toHaveBeenCalled();
    expect(mocks.registerCampaign).not.toHaveBeenCalled();

    const second = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(second.status).toBe("submitted");
    expect(mocks.purchaseNumber).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "repair_telnyx_phone_number_resource_id",
      expect.objectContaining({
        p_phone_number_id: fencedActiveNumber.id,
        p_expected_legacy_id: LEGACY_NUMBER_ORDER_PHONE_NUMBER_ID,
        p_resolved_resource_id: TELNYX_NUMBER_ID,
      })
    );
    expect(mocks.attachOwnedNumberToCustomerProfile).toHaveBeenCalledWith(
      BUSINESS_ID,
      TELNYX_NUMBER_ID
    );
    expect(mocks.registerCampaign).toHaveBeenCalledTimes(1);
  });

  it("uses only the provider intent when an accepted order has no UUID provenance", async () => {
    const resolutionError = new PurchasedNumberResolutionError({
      phoneNumber: PENDING_NUMBER,
      status: "success",
      providerCreateIntentId: "c0000000-0000-4000-8000-00000000b1c1",
      cause: new Error("owned number not visible yet"),
    });
    mocks.purchaseNumber.mockRejectedValueOnce(resolutionError);
    queueHappyPathThrough({ data: null, error: null });

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("failed");
    expect(result.message).toContain("number was reserved");
    expect(chains).toHaveLength(5);
    expect(chains.every((chain) => chain.insert.mock.calls.length === 0)).toBe(
      true
    );
    expect(mocks.resolveProviderCreateIntent).not.toHaveBeenCalled();
    expect(mocks.verifyPublishedCompliancePage).not.toHaveBeenCalled();
    expect(mocks.registerCampaign).not.toHaveBeenCalled();
  });

  it("retries a failed page check using the saved active number without re-purchasing or early campaign cleanup", async () => {
    const activeNumber = {
      id: "phone-row-1",
      phone_number: PENDING_NUMBER,
      telnyx_phone_number_id: TELNYX_NUMBER_ID,
    };
    queueResults(
      { data: LAUNCH_BUSINESS, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { error: null },
      { error: null },
      {
        data: { ...LAUNCH_BUSINESS, pending_phone_number: null },
        error: null,
      },
      { data: null, error: null },
      { data: activeNumber, error: null },
      { data: activeNumber, error: null },
      { error: null }
    );
    mocks.verifyPublishedCompliancePage
      .mockRejectedValueOnce(new Error("deployment not visible yet"))
      .mockResolvedValueOnce(undefined);

    const first = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(first.status).toBe("failed");
    expect(mocks.archiveAndClearRejectedCampaign).not.toHaveBeenCalled();
    expect(mocks.registerCampaign).not.toHaveBeenCalled();

    const second = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(second.status).toBe("submitted");
    const expectedVerification = {
      slug: LAUNCH_BUSINESS.slug,
      businessName: LAUNCH_BUSINESS.name,
      smsPhoneNumber: PENDING_NUMBER,
      language: "en",
    };
    expect(mocks.verifyPublishedCompliancePage).toHaveBeenCalledTimes(2);
    expect(mocks.verifyPublishedCompliancePage).toHaveBeenNthCalledWith(
      1,
      expectedVerification
    );
    expect(mocks.verifyPublishedCompliancePage).toHaveBeenNthCalledWith(
      2,
      expectedVerification
    );
    expect(mocks.purchaseNumber).toHaveBeenCalledTimes(1);
    expect(mocks.attachOwnedNumberToCustomerProfile).toHaveBeenCalledWith(
      BUSINESS_ID,
      TELNYX_NUMBER_ID
    );
    expect(mocks.archiveAndClearRejectedCampaign).not.toHaveBeenCalled();
    expect(mocks.registerCampaign).toHaveBeenCalledTimes(1);
  });

  it("re-asserts routing on an already-completed prior attempt (idempotent completion)", async () => {
    queueHappyPathThrough(
      {
        data: {
          business_id: BUSINESS_ID,
          telnyx_phone_number_id: TELNYX_NUMBER_ID,
        },
        error: null,
      }, // our own row exists
      { error: null } // clearPending
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("submitted");
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
    expect(mocks.findOwnedNumberId).not.toHaveBeenCalled();
    // A crash between a prior insert and attach leaves a saved-but-unrouted
    // number; idempotent completion must re-assert routing, not just clear.
    expect(mocks.attachOwnedNumberToCustomerProfile).toHaveBeenCalledWith(
      BUSINESS_ID,
      TELNYX_NUMBER_ID
    );
  });

  it("treats another business holding the number as genuinely unavailable", async () => {
    queueHappyPathThrough(
      { data: { business_id: "other-business" }, error: null }, // collision
      { error: null } // persistNumberFailure update
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("number_unavailable");
    expect(mocks.purchaseNumber).not.toHaveBeenCalled();
  });

  it("no longer misclassifies Postgres relation-name errors as unavailable", async () => {
    // A non-typed error whose text contains 'phone_number' (the old regex's
    // false trigger) must fall through to the generic failed path, not the
    // re-pick path.
    mocks.registerBrand.mockRejectedValue(
      new Error('permission denied for table phone_numbers')
    );
    queueHappyPathThrough();

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("failed");
    expect(result.message).toContain("try again or contact support");
  });

  it("classifies only a typed, reconciled Telnyx rejection as unavailable", async () => {
    mocks.purchaseNumber.mockRejectedValue(
      new NumberUnavailableError(PENDING_NUMBER, {
        status: 422,
        error: { errors: [{ code: "10027" }] },
      })
    );
    queueHappyPathThrough(
      { data: null, error: null }, // step-1 collision check
      { error: null } // persistNumberFailure update
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("number_unavailable");
    expect(mocks.registerCampaign).not.toHaveBeenCalled();
    expect(
      chains.some((chain) =>
        chain.update.mock.calls.some(([value]) =>
          expect.objectContaining({
            onboarding_registration_status: "failed",
            onboarding_registration_error: expect.any(String),
            pending_phone_number_failure_reason: expect.any(String),
            onboarding_step: "phone_number",
          }).asymmetricMatch(value)
        )
      )
    ).toBe(true);
    expect(mocks.markRegistrationFailed).not.toHaveBeenCalled();
  });

  it("does not report a recoverable picker state when persisting the number failure fails", async () => {
    mocks.purchaseNumber.mockRejectedValue(
      new NumberUnavailableError(PENDING_NUMBER, {
        status: 422,
        error: { errors: [{ code: "10027" }] },
      })
    );
    queueHappyPathThrough(
      { data: null, error: null }, // step-1 collision check
      { error: { message: "database unavailable" } } // atomic failure-state update
    );

    await expect(
      attemptPaidLaunch(BUSINESS_ID, "onboarding_retry")
    ).rejects.toThrow("Failed to persist number failure");

    expect(mocks.markRegistrationFailed).not.toHaveBeenCalled();
    expect(mocks.registerCampaign).not.toHaveBeenCalled();
  });

  it("routes a typed toll-free defense back to number selection", async () => {
    mocks.purchaseNumber.mockRejectedValue(
      new TollFreeNumberUnsupportedError("+18885550300")
    );
    queueHappyPathThrough(
      { data: null, error: null }, // step-1 collision check
      { error: null } // persistNumberFailure update
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("number_unavailable");
    expect(mocks.registerCampaign).not.toHaveBeenCalled();
  });

  it("keeps an explicit provider order failure generic after its intent is safely resolved", async () => {
    mocks.purchaseNumber.mockRejectedValue(
      new Error(`Telnyx number order failed for ${PENDING_NUMBER}: {"status":"failure"}`)
    );
    queueHappyPathThrough(
      { data: null, error: null } // step-1 collision check
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("failed");
    expect(result.message).toContain("try again or contact support");
    expect(
      chains.some((chain) =>
        chain.update.mock.calls.some(([value]) =>
          Object.prototype.hasOwnProperty.call(
            value as Record<string, unknown>,
            "pending_phone_number_failure_reason"
          )
        )
      )
    ).toBe(false);
  });

  it("does not classify a raw or unrelated 10027 response by code or message text", async () => {
    mocks.purchaseNumber.mockRejectedValue({
      status: 422,
      error: {
        errors: [
          {
            code: "10027",
            detail: "Different validation failure: number unavailable",
            source: { pointer: "/phone_numbers" },
          },
        ],
      },
    });
    queueHappyPathThrough(
      { data: null, error: null } // step-1 collision check
    );

    const result = await attemptPaidLaunch(BUSINESS_ID, "onboarding_retry");

    expect(result.status).toBe("failed");
    expect(result.message).toContain("try again or contact support");
  });
});
