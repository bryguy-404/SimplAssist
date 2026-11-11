import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  retrieveCampaign: vi.fn(),
  appendRegistrationEvent: vi.fn(),
  appendRegistrationEventOrThrow: vi.fn(),
  getCampaignAssignmentSafetyBlock: vi.fn(),
  applyObservedCampaignStatus: vi.fn(),
  ensureCampaignAssignmentForBusiness: vi.fn(),
  mapCampaignStatus: vi.fn(),
  getOnboardingStateForOwnerReadOnly: vi.fn(),
  requireWorkspaceRouteAccess: vi.fn(),
  resolveSmsProvisioningAccess: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
  })),
}));

vi.mock("@/lib/messaging/client", () => ({
  telnyx: {
    messaging10dlc: {
      campaign: {
        retrieve: mocks.retrieveCampaign,
      },
    },
  },
}));

vi.mock("@/lib/messaging/registration/audit", () => ({
  appendRegistrationEvent: mocks.appendRegistrationEvent,
  appendRegistrationEventOrThrow: mocks.appendRegistrationEventOrThrow,
}));

vi.mock("@/lib/messaging/registration/campaignStatusTransition", () => ({
  getCampaignAssignmentSafetyBlock:
    mocks.getCampaignAssignmentSafetyBlock,
  applyObservedCampaignStatus: mocks.applyObservedCampaignStatus,
}));

vi.mock(
  "@/lib/messaging/registration/phoneNumberAssignment",
  () => ({
    ensureCampaignAssignmentForBusiness:
      mocks.ensureCampaignAssignmentForBusiness,
  })
);

vi.mock("@/lib/messaging/registration/statusMapper", () => ({
  mapCampaignStatus: mocks.mapCampaignStatus,
}));

vi.mock("@/lib/onboarding/state", () => ({
  getOnboardingStateForOwnerReadOnly:
    mocks.getOnboardingStateForOwnerReadOnly,
}));

vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({
  requireWorkspaceRouteAccess: mocks.requireWorkspaceRouteAccess,
}));
vi.mock("@/lib/billing/entitlements", () => ({
  resolveSmsProvisioningAccess: mocks.resolveSmsProvisioningAccess,
}));

import { POST } from "./route";
import { REJECTION_SUPPORT_MESSAGE } from "@/lib/onboarding/rejectionGuidance";

const OWNER_ID = "owner-1";
const BUSINESS_ID = "00000000-0000-4000-8000-000000000123";
const CAMPAIGN_ID = "4b30019f-8814-cb6c-1e77-950fa70e0410";
const BRAND_ID = "4b20019d-e93e-d697-b8ee-c6233e9bf533";
const MESSAGING_PROFILE_ID = "40017f09-8660-4c81-8a6b-3f571d1f6d91";

const SNAPSHOT = {
  id: BUSINESS_ID,
  owner_id: OWNER_ID,
  updated_at: "2026-07-28T08:00:00.000Z",
  deleted_at: null,
  telnyx_unique_claims_released_at: null,
  active_telnyx_release_run_id: null,
  telnyx_resource_state: "active",
  telnyx_submission_disabled: false,
  telnyx_brand_id: BRAND_ID,
  telnyx_campaign_id: CAMPAIGN_ID,
  telnyx_messaging_profile_id: MESSAGING_PROFILE_ID,
  brand_status: "approved",
  campaign_status: "pending",
  campaign_status_updated_at: "2026-07-22T04:30:38.000Z",
  campaign_rejection_reason: null,
  onboarding_registration_status: "submitted",
  onboarding_registration_submitted_at: "2026-07-22T04:00:00.000Z",
  onboarding_registration_error: null,
} as const;

const UPDATED_STATE = {
  businessId: BUSINESS_ID,
  currentStep: "carrier_review",
  registration: {
    campaignStatus: "approved",
    assignmentStatus: "assigned",
    smsReady: true,
  },
};

type QueryResult = {
  data: unknown;
  error: { code?: string; message: string } | null;
};

type BusinessQuery = Record<
  "select" | "eq" | "is" | "maybeSingle",
  ReturnType<typeof vi.fn>
>;

let businessQuery: BusinessQuery;

function setBusinessRead(result: QueryResult) {
  const query = {} as BusinessQuery;
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.is = vi.fn(() => query);
  query.maybeSingle = vi.fn(async () => result);
  businessQuery = query;
  mocks.from.mockReturnValue(query);
}

function remoteCampaign(overrides: Record<string, unknown> = {}) {
  return {
    campaignId: CAMPAIGN_ID,
    brandId: BRAND_ID,
    campaignStatus: "MNO_PENDING",
    submissionStatus: "PENDING",
    status: "ACCEPTED",
    ...overrides,
  };
}

async function invoke() {
  const response = await POST();
  return {
    response,
    body: (await response.json()) as Record<string, unknown>,
  };
}

function expectNoReconciliation() {
  expect(mocks.applyObservedCampaignStatus).not.toHaveBeenCalled();
  expect(mocks.appendRegistrationEventOrThrow).not.toHaveBeenCalled();
  expect(mocks.ensureCampaignAssignmentForBusiness).not.toHaveBeenCalled();
  expect(mocks.getOnboardingStateForOwnerReadOnly).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireWorkspaceRouteAccess.mockResolvedValue({ ok: true, access: {} });
  vi.spyOn(console, "error").mockImplementation(() => {});

  mocks.getUser.mockResolvedValue({
    data: { user: { id: OWNER_ID } },
    error: null,
  });
  setBusinessRead({ data: SNAPSHOT, error: null });
  mocks.getCampaignAssignmentSafetyBlock.mockReturnValue(null);
  mocks.resolveSmsProvisioningAccess.mockResolvedValue({
    allowed: true,
    source: "subscription",
    plan: "sms_and_chat",
  });
  mocks.retrieveCampaign.mockResolvedValue(remoteCampaign());
  mocks.mapCampaignStatus.mockReturnValue({
    dbStatus: null,
    isTerminal: false,
  });
  mocks.applyObservedCampaignStatus.mockResolvedValue({
    outcome: "applied",
    statusChanged: true,
    repairedRejectedOnboarding: false,
  });
  mocks.appendRegistrationEvent.mockResolvedValue(undefined);
  mocks.appendRegistrationEventOrThrow.mockResolvedValue(undefined);
  mocks.ensureCampaignAssignmentForBusiness.mockResolvedValue(undefined);
  mocks.getOnboardingStateForOwnerReadOnly.mockResolvedValue(UPDATED_STATE);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/onboarding/refresh-status", () => {
  it("returns a normal waiting response for a submitted brand without a campaign", async () => {
    setBusinessRead({ data: { ...SNAPSHOT, brand_status: "pending", telnyx_campaign_id: null }, error: null });
    mocks.getCampaignAssignmentSafetyBlock.mockReturnValue("brand_not_approved");
    const { response, body } = await invoke();
    expect(response.status).toBe(200);
    expect(body.message).toContain("continue automatically");
    expect(mocks.retrieveCampaign).not.toHaveBeenCalled();
  });
  it("returns workspace lookup failures before auth or Telnyx reconciliation", async () => {
    mocks.requireWorkspaceRouteAccess.mockResolvedValue({
      ok: false,
      response: Response.json(
        { error: "workspace_access_unavailable", retryable: true },
        { status: 503 },
      ),
    });

    const { response, body } = await invoke();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: "workspace_access_unavailable",
      retryable: true,
    });
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.retrieveCampaign).not.toHaveBeenCalled();
    expectNoReconciliation();
  });

  it.each([
    [
      "missing user",
      { data: { user: null }, error: null },
    ],
    [
      "authentication error",
      {
        data: { user: null },
        error: { message: "session lookup failed" },
      },
    ],
  ])("returns 401 for %s without reading business state", async (_label, auth) => {
    mocks.getUser.mockResolvedValue(auth);

    const { response, body } = await invoke();

    expect(response.status).toBe(401);
    expect(body).toEqual({ error: "Unauthorized" });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.retrieveCampaign).not.toHaveBeenCalled();
    expectNoReconciliation();
  });

  it("returns 404 when the authenticated owner has no protected business snapshot", async () => {
    setBusinessRead({ data: null, error: null });

    const { response, body } = await invoke();

    expect(response.status).toBe(404);
    expect(body).toEqual({ error: "Business not found" });
    expect(mocks.from).toHaveBeenCalledWith("businesses");
    expect(businessQuery.eq).toHaveBeenCalledWith("owner_id", OWNER_ID);
    expect(businessQuery.is).toHaveBeenCalledWith("deleted_at", null);
    expect(businessQuery.is).toHaveBeenCalledWith(
      "telnyx_unique_claims_released_at",
      null
    );
    expect(mocks.retrieveCampaign).not.toHaveBeenCalled();
    expectNoReconciliation();
  });

  it("fails safely when the protected business read errors", async () => {
    setBusinessRead({
      data: null,
      error: { code: "PGRST500", message: "sensitive database detail" },
    });

    const { response, body } = await invoke();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "Could not refresh carrier status right now.",
    });
    expect(JSON.stringify(body)).not.toContain("sensitive database detail");
    expect(mocks.retrieveCampaign).not.toHaveBeenCalled();
    expectNoReconciliation();
  });

  it.each([
    ["brand", { brand_status: "rejected", campaign_status: "pending" }],
    ["campaign", { brand_status: "approved", campaign_status: "rejected" }],
  ])(
    "returns support-only for an already rejected %s before provider reconciliation",
    async (_label, statuses) => {
      setBusinessRead({
        data: {
          ...SNAPSHOT,
          ...statuses,
          onboarding_registration_status: "failed",
        },
        error: null,
      });

      const { response, body } = await invoke();

      expect(response.status).toBe(409);
      expect(body).toEqual({
        code: "rejection_support_required",
        error: REJECTION_SUPPORT_MESSAGE,
      });
      expect(mocks.resolveSmsProvisioningAccess).not.toHaveBeenCalled();
      expect(mocks.getCampaignAssignmentSafetyBlock).not.toHaveBeenCalled();
      expect(mocks.retrieveCampaign).not.toHaveBeenCalled();
      expect(mocks.appendRegistrationEvent).not.toHaveBeenCalled();
      expectNoReconciliation();
    }
  );

  it("continues refreshing a non-rejected technical failure", async () => {
    setBusinessRead({
      data: {
        ...SNAPSHOT,
        onboarding_registration_status: "failed",
        onboarding_registration_error: "Previous provider timeout",
      },
      error: null,
    });

    const { response } = await invoke();

    expect(response.status).toBe(200);
    expect(mocks.resolveSmsProvisioningAccess).toHaveBeenCalledWith(
      BUSINESS_ID,
      { allowDirectPrecheckout: false },
    );
    expect(mocks.retrieveCampaign).toHaveBeenCalledTimes(1);
  });

  it.each(["subscription", "partner_billing"] as const)(
    "blocks a %s chat-only account before Telnyx reads, audits, or assignment",
    async (source) => {
      mocks.resolveSmsProvisioningAccess.mockResolvedValue({
        allowed: false,
        reason: "plan_not_entitled",
        source,
        plan: "chat_only",
      });

      const { response, body } = await invoke();

      expect(response.status).toBe(403);
      expect(body).toEqual({
        code: "sms_provisioning_not_available",
        error: "Carrier status is not available on the current plan.",
      });
      expect(mocks.resolveSmsProvisioningAccess).toHaveBeenCalledWith(
        BUSINESS_ID,
        { allowDirectPrecheckout: false },
      );
      expect(mocks.retrieveCampaign).not.toHaveBeenCalled();
      expect(mocks.appendRegistrationEvent).not.toHaveBeenCalled();
      expectNoReconciliation();
    },
  );

  it("fails retryably on uncertain billing state before Telnyx reads, audits, or assignment", async () => {
    mocks.resolveSmsProvisioningAccess.mockResolvedValue({
      allowed: false,
      reason: "billing_state_unavailable",
    });

    const { response, body } = await invoke();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: "Unable to verify plan access",
      retryable: true,
    });
    expect(mocks.retrieveCampaign).not.toHaveBeenCalled();
    expect(mocks.appendRegistrationEvent).not.toHaveBeenCalled();
    expectNoReconciliation();
  });

  it("audits and blocks a snapshot that fails assignment-safety protection", async () => {
    mocks.getCampaignAssignmentSafetyBlock.mockReturnValue(
      "release_in_progress"
    );

    const { response, body } = await invoke();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      code: "campaign_refresh_blocked",
      error: "Carrier status refresh is not available for this account.",
    });
    expect(mocks.getCampaignAssignmentSafetyBlock).toHaveBeenCalledWith(
      SNAPSHOT
    );
    expect(mocks.appendRegistrationEvent).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      eventType: "campaign_status_refreshed",
      resourceType: "campaign",
      resourceId: CAMPAIGN_ID,
      status: "blocked",
      rawPayload: {
        source: "customer_refresh",
        outcome: "blocked",
        safetyBlock: "release_in_progress",
      },
    });
    expect(mocks.retrieveCampaign).not.toHaveBeenCalled();
    expectNoReconciliation();
  });

  it("retrieves the exact Telnyx campaign with retries disabled and a 10-second timeout", async () => {
    mocks.retrieveCampaign.mockResolvedValue(
      remoteCampaign({ campaignStatus: "MNO_PENDING" })
    );

    const { response } = await invoke();

    expect(response.status).toBe(200);
    expect(mocks.retrieveCampaign).toHaveBeenCalledTimes(1);
    expect(mocks.retrieveCampaign).toHaveBeenCalledWith(CAMPAIGN_ID, {
      maxRetries: 0,
      timeout: 10_000,
    });
  });

  it.each([
    [
      "campaign ID",
      { campaignId: "different-campaign-id" },
      {
        remoteCampaignId: "different-campaign-id",
        remoteBrandId: BRAND_ID,
      },
    ],
    [
      "brand ID",
      { brandId: "different-brand-id" },
      {
        remoteCampaignId: CAMPAIGN_ID,
        remoteBrandId: "different-brand-id",
      },
    ],
  ])(
    "rejects a remote %s identity mismatch without mapping or changing state",
    async (_label, remoteOverrides, expectedRemoteIdentity) => {
      mocks.retrieveCampaign.mockResolvedValue(
        remoteCampaign(remoteOverrides)
      );

      const { response, body } = await invoke();

      expect(response.status).toBe(409);
      expect(body).toEqual({
        code: "carrier_identity_mismatch",
        error:
          "We could not verify the campaign for this registration. No changes were made.",
      });
      expect(mocks.appendRegistrationEvent).toHaveBeenCalledWith({
        businessId: BUSINESS_ID,
        eventType: "campaign_status_refreshed",
        resourceType: "campaign",
        resourceId: CAMPAIGN_ID,
        status: "identity_mismatch",
        rawPayload: {
          source: "customer_refresh",
          outcome: "identity_mismatch",
          localCampaignId: CAMPAIGN_ID,
          localBrandId: BRAND_ID,
          ...expectedRemoteIdentity,
        },
      });
      expect(mocks.mapCampaignStatus).not.toHaveBeenCalled();
      expectNoReconciliation();
    }
  );

  it("audits an intermediate provider status without applying a business-row write", async () => {
    mocks.retrieveCampaign.mockResolvedValue(
      remoteCampaign({
        campaignStatus: "MNO_PENDING",
        submissionStatus: "PENDING",
        status: "ACCEPTED",
      })
    );
    mocks.mapCampaignStatus.mockReturnValue({
      dbStatus: null,
      isTerminal: false,
    });

    const { response, body } = await invoke();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      reconciled: false,
      providerStatus: "MNO_PENDING",
      message: "Your SMS campaign is still under carrier review.",
    });
    expect(mocks.mapCampaignStatus).toHaveBeenCalledWith({
      campaignStatus: "MNO_PENDING",
      submissionStatus: "PENDING",
      status: "ACCEPTED",
    });
    expect(mocks.appendRegistrationEvent).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      eventType: "campaign_status_refreshed",
      resourceType: "campaign",
      resourceId: CAMPAIGN_ID,
      status: "no_terminal_change",
      rawPayload: {
        source: "customer_refresh",
        outcome: "no_terminal_change",
        providerCampaignStatus: "MNO_PENDING",
        providerSubmissionStatus: "PENDING",
        providerStatus: "ACCEPTED",
      },
    });
    expectNoReconciliation();
  });

  it("keeps an intermediate response sanitized if its best-effort audit unexpectedly throws", async () => {
    mocks.appendRegistrationEvent.mockRejectedValueOnce(
      new Error("audit dependency secret")
    );

    const { response, body } = await invoke();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      reconciled: false,
      providerStatus: "MNO_PENDING",
      message: "Your SMS campaign is still under carrier review.",
    });
    expect(JSON.stringify(body)).not.toContain("audit dependency secret");
    expectNoReconciliation();
  });

  it("reconciles approval, strictly audits, starts assignment, then loads state in that order", async () => {
    mocks.retrieveCampaign.mockResolvedValue(
      remoteCampaign({
        campaignStatus: "MNO_PROVISIONED",
        submissionStatus: "CREATED",
        status: "ACCEPTED",
      })
    );
    mocks.mapCampaignStatus.mockReturnValue({
      dbStatus: "approved",
      isTerminal: true,
    });
    mocks.applyObservedCampaignStatus.mockResolvedValue({
      outcome: "applied",
      statusChanged: true,
      repairedRejectedOnboarding: false,
    });

    const { response, body } = await invoke();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      state: UPDATED_STATE,
      synced: true,
      reconciled: true,
      repaired: false,
      providerStatus: "MNO_PROVISIONED",
      message: "Carrier status updated.",
    });
    expect(mocks.applyObservedCampaignStatus).toHaveBeenCalledTimes(1);
    expect(mocks.applyObservedCampaignStatus).toHaveBeenCalledWith({
      snapshot: SNAPSHOT,
      newStatus: "approved",
      rejectionReason: null,
      observedAt: expect.any(String),
      enforceAssignmentSafety: true,
      touchIfUnchanged: true,
    });
    expect(mocks.appendRegistrationEventOrThrow).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      eventType: "campaign_status_refreshed",
      resourceType: "campaign",
      resourceId: CAMPAIGN_ID,
      status: "approved",
      rejectionReason: null,
      rawPayload: {
        source: "customer_refresh",
        outcome: "reconciled",
        providerCampaignStatus: "MNO_PROVISIONED",
        providerSubmissionStatus: "CREATED",
        providerStatus: "ACCEPTED",
        previousLocalStatus: "pending",
        statusChanged: true,
        repairedRejectedOnboarding: false,
      },
    });
    expect(mocks.ensureCampaignAssignmentForBusiness).toHaveBeenCalledWith(
      BUSINESS_ID,
      {
        force: true,
        reason: "customer_status_refresh",
      }
    );
    expect(mocks.getOnboardingStateForOwnerReadOnly).toHaveBeenCalledWith(
      OWNER_ID
    );

    expect(mocks.appendRegistrationEventOrThrow).toHaveBeenCalledTimes(2);
    const intentAuditOrder =
      mocks.appendRegistrationEventOrThrow.mock.invocationCallOrder[0];
    const transitionOrder =
      mocks.applyObservedCampaignStatus.mock.invocationCallOrder[0];
    const completionAuditOrder =
      mocks.appendRegistrationEventOrThrow.mock.invocationCallOrder[1];
    const assignmentOrder =
      mocks.ensureCampaignAssignmentForBusiness.mock.invocationCallOrder[0];
    const stateOrder =
      mocks.getOnboardingStateForOwnerReadOnly.mock.invocationCallOrder[0];
    expect(intentAuditOrder).toBeLessThan(transitionOrder);
    expect(transitionOrder).toBeLessThan(completionAuditOrder);
    expect(completionAuditOrder).toBeLessThan(assignmentOrder);
    expect(assignmentOrder).toBeLessThan(stateOrder);
    expect(mocks.appendRegistrationEvent).not.toHaveBeenCalled();
  });

  it("returns a conflict after a conditional-update miss and never assigns", async () => {
    mocks.retrieveCampaign.mockResolvedValue(
      remoteCampaign({ campaignStatus: "MNO_PROVISIONED" })
    );
    mocks.mapCampaignStatus.mockReturnValue({
      dbStatus: "approved",
      isTerminal: true,
    });
    mocks.applyObservedCampaignStatus.mockResolvedValue({
      outcome: "conflict",
      statusChanged: false,
      repairedRejectedOnboarding: false,
    });

    const { response, body } = await invoke();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      code: "campaign_state_changed",
      error:
        "Registration state changed while refreshing. Please refresh again.",
    });
    expect(mocks.appendRegistrationEvent).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      eventType: "campaign_status_refreshed",
      resourceType: "campaign",
      resourceId: CAMPAIGN_ID,
      status: "conditional_update_missed",
      rawPayload: {
        source: "customer_refresh",
        outcome: "conditional_update_missed",
        providerCampaignStatus: "MNO_PROVISIONED",
        providerSubmissionStatus: "PENDING",
        providerStatus: "ACCEPTED",
      },
    });
    expect(mocks.appendRegistrationEventOrThrow).toHaveBeenCalledTimes(1);
    expect(mocks.ensureCampaignAssignmentForBusiness).not.toHaveBeenCalled();
    expect(mocks.getOnboardingStateForOwnerReadOnly).not.toHaveBeenCalled();
  });

  it("sanitizes provider failures while retaining only the provider HTTP status in audit data", async () => {
    const providerError = Object.assign(
      new Error("secret Telnyx response body and API key"),
      {
        status: 503,
        response: {
          status: 503,
          data: { apiKey: "KEY_MUST_NOT_LEAK" },
        },
      }
    );
    mocks.retrieveCampaign.mockRejectedValue(providerError);

    const { response, body } = await invoke();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      code: "carrier_status_unavailable",
      error: "Carrier status could not be loaded. Please try again.",
    });
    const serializedBody = JSON.stringify(body);
    expect(serializedBody).not.toContain("secret Telnyx");
    expect(serializedBody).not.toContain("KEY_MUST_NOT_LEAK");
    expect(mocks.appendRegistrationEvent).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      eventType: "campaign_status_refreshed",
      resourceType: "campaign",
      resourceId: CAMPAIGN_ID,
      status: "provider_error",
      rawPayload: {
        source: "customer_refresh",
        outcome: "provider_error",
        providerStatus: 503,
      },
    });
    expect(mocks.mapCampaignStatus).not.toHaveBeenCalled();
    expectNoReconciliation();
  });

  it("reconciles a rejection with normalized reasons but never starts assignment", async () => {
    mocks.retrieveCampaign.mockResolvedValue(
      remoteCampaign({
        campaignStatus: "MNO_REJECTED",
        submissionStatus: "FAILED",
        status: "REJECTED",
        failureReasons: [
          "  Missing compliant opt-in language.  ",
          "",
          "Privacy policy link is required.",
        ],
      })
    );
    mocks.mapCampaignStatus.mockReturnValue({
      dbStatus: "rejected",
      isTerminal: true,
    });
    mocks.applyObservedCampaignStatus.mockResolvedValue({
      outcome: "applied",
      statusChanged: true,
      repairedRejectedOnboarding: false,
    });
    mocks.getOnboardingStateForOwnerReadOnly.mockResolvedValue({
      ...UPDATED_STATE,
      registration: {
        campaignStatus: "rejected",
        assignmentStatus: "unassigned",
        smsReady: false,
      },
    });

    const { response, body } = await invoke();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      reconciled: true,
      repaired: false,
      providerStatus: "MNO_REJECTED",
      message: "Carrier status updated.",
    });
    expect(mocks.applyObservedCampaignStatus).toHaveBeenCalledWith({
      snapshot: SNAPSHOT,
      newStatus: "rejected",
      rejectionReason:
        "Missing compliant opt-in language.; Privacy policy link is required.",
      observedAt: expect.any(String),
      enforceAssignmentSafety: true,
      touchIfUnchanged: true,
    });
    expect(mocks.appendRegistrationEventOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        resourceId: CAMPAIGN_ID,
        status: "rejected",
        rejectionReason:
          "Missing compliant opt-in language.; Privacy policy link is required.",
      })
    );
    expect(mocks.ensureCampaignAssignmentForBusiness).not.toHaveBeenCalled();
    expect(mocks.getOnboardingStateForOwnerReadOnly).toHaveBeenCalledWith(
      OWNER_ID
    );
  });

  it("does not persist ordinary campaign description copy as a rejection reason", async () => {
    mocks.retrieveCampaign.mockResolvedValue(
      remoteCampaign({
        campaignStatus: "MNO_REJECTED",
        submissionStatus: "FAILED",
        status: "REJECTED",
        description: "Customers opt in on the booking form.",
        failureReasons: "",
      })
    );
    mocks.mapCampaignStatus.mockReturnValue({
      dbStatus: "rejected",
      isTerminal: true,
    });

    const { response } = await invoke();

    expect(response.status).toBe(200);
    expect(mocks.applyObservedCampaignStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        newStatus: "rejected",
        rejectionReason: null,
      })
    );
    expect(mocks.appendRegistrationEventOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "rejected",
        rejectionReason: null,
      })
    );
  });

  it("does not change local state when the intent audit fails", async () => {
    mocks.retrieveCampaign.mockResolvedValue(
      remoteCampaign({ campaignStatus: "MNO_PROVISIONED" })
    );
    mocks.mapCampaignStatus.mockReturnValue({
      dbStatus: "approved",
      isTerminal: true,
    });
    mocks.appendRegistrationEventOrThrow.mockRejectedValueOnce(
      new Error("audit insert failed")
    );

    const { response, body } = await invoke();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      code: "campaign_audit_unavailable",
      error:
        "Carrier status could not be reconciled safely. No changes were made.",
    });
    expect(mocks.applyObservedCampaignStatus).not.toHaveBeenCalled();
    expect(mocks.ensureCampaignAssignmentForBusiness).not.toHaveBeenCalled();
    expect(
      mocks.getOnboardingStateForOwnerReadOnly
    ).not.toHaveBeenCalled();
  });

  it("does not start assignment when the completion audit fails", async () => {
    mocks.retrieveCampaign.mockResolvedValue(
      remoteCampaign({ campaignStatus: "MNO_PROVISIONED" })
    );
    mocks.mapCampaignStatus.mockReturnValue({
      dbStatus: "approved",
      isTerminal: true,
    });
    mocks.appendRegistrationEventOrThrow
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("audit insert failed"));

    const { response, body } = await invoke();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      state: UPDATED_STATE,
      synced: true,
      reconciled: true,
      code: "campaign_audit_failed",
      error:
        "Campaign status was synced, but the follow-up could not be recorded. Please refresh again.",
    });
    expect(mocks.ensureCampaignAssignmentForBusiness).not.toHaveBeenCalled();
    expect(mocks.getOnboardingStateForOwnerReadOnly).toHaveBeenCalledWith(
      OWNER_ID
    );
  });

  it("reports assignment-start failure only after reconciliation and strict audit complete", async () => {
    mocks.retrieveCampaign.mockResolvedValue(
      remoteCampaign({ campaignStatus: "MNO_PROVISIONED" })
    );
    mocks.mapCampaignStatus.mockReturnValue({
      dbStatus: "approved",
      isTerminal: true,
    });
    mocks.ensureCampaignAssignmentForBusiness.mockRejectedValue(
      new Error("provider assignment secret")
    );

    const { response, body } = await invoke();

    expect(response.status).toBe(502);
    expect(body).toEqual({
      state: UPDATED_STATE,
      synced: true,
      reconciled: true,
      code: "campaign_assignment_start_failed",
      error:
        "Campaign status was synced, but number assignment could not be started. Please refresh again.",
    });
    expect(JSON.stringify(body)).not.toContain("provider assignment secret");
    expect(mocks.applyObservedCampaignStatus).toHaveBeenCalledTimes(1);
    expect(mocks.appendRegistrationEventOrThrow).toHaveBeenCalledTimes(2);
    expect(mocks.ensureCampaignAssignmentForBusiness).toHaveBeenCalledTimes(1);
    expect(mocks.getOnboardingStateForOwnerReadOnly).toHaveBeenCalledWith(
      OWNER_ID
    );

    expect(
      mocks.appendRegistrationEventOrThrow.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mocks.applyObservedCampaignStatus.mock.invocationCallOrder[0]
    );
    expect(
      mocks.applyObservedCampaignStatus.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mocks.appendRegistrationEventOrThrow.mock.invocationCallOrder[1]
    );
    expect(
      mocks.appendRegistrationEventOrThrow.mock.invocationCallOrder[1]
    ).toBeLessThan(
      mocks.ensureCampaignAssignmentForBusiness.mock.invocationCallOrder[0]
    );
  });

  it("sanitizes a post-reconciliation state-load exception", async () => {
    mocks.retrieveCampaign.mockResolvedValue(
      remoteCampaign({ campaignStatus: "MNO_PROVISIONED" })
    );
    mocks.mapCampaignStatus.mockReturnValue({
      dbStatus: "approved",
      isTerminal: true,
    });
    mocks.getOnboardingStateForOwnerReadOnly.mockRejectedValue(
      new Error("state dependency secret")
    );

    const { response, body } = await invoke();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      synced: true,
      reconciled: true,
      error:
        "Campaign status was synced, but the updated state could not be loaded.",
    });
    expect(JSON.stringify(body)).not.toContain("state dependency secret");
    expect(mocks.ensureCampaignAssignmentForBusiness).toHaveBeenCalledTimes(1);
    expect(mocks.getOnboardingStateForOwnerReadOnly).toHaveBeenCalledWith(
      OWNER_ID
    );
  });
});
