vi.mock("@/lib/billing/reviewTextingHandoff.server",()=>({reconcileReviewTextingCampaignEvent:vi.fn().mockResolvedValue(false)}));
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  unwrap: vi.fn(),
  markProcessedOnce: vi.fn(),
  releaseProcessedEvent: vi.fn(),
  from: vi.fn(),
  appendRegistrationEvent: vi.fn(),
  serializeError: vi.fn(),
  applyObservedCampaignStatus: vi.fn(),
  ensureCampaignAssignmentForBusiness: vi.fn(),
  mapBrandStatus: vi.fn(),
  mapCampaignStatus: vi.fn(),
  extractRejectionReason: vi.fn(),
  dedupeRecipients: vi.fn(),
  sendBrandApprovedEmail: vi.fn(),
  sendBrandRejectedEmail: vi.fn(),
  sendCampaignApprovedEmail: vi.fn(),
  sendCampaignRejectedEmail: vi.fn(),
}));

vi.mock("@/lib/messaging/client", () => ({
  telnyx: { webhooks: { unwrap: mocks.unwrap } },
}));
vi.mock("@/lib/messaging/idempotency", () => ({
  markProcessedOnce: mocks.markProcessedOnce,
  releaseProcessedEvent: mocks.releaseProcessedEvent,
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: mocks.from,
    auth: { admin: { getUserById: vi.fn().mockResolvedValue({ data: { user: { email: "owner@test.dev" } }, error: null }) } },
  },
}));
vi.mock("@/lib/messaging/registration/audit", () => ({
  appendRegistrationEvent: mocks.appendRegistrationEvent,
  serializeError: mocks.serializeError,
}));
vi.mock(
  "@/lib/messaging/registration/campaignStatusTransition",
  () => ({
    applyObservedCampaignStatus: mocks.applyObservedCampaignStatus,
  })
);
vi.mock("@/lib/messaging/registration/phoneNumberAssignment", () => ({
  ensureCampaignAssignmentForBusiness: mocks.ensureCampaignAssignmentForBusiness,
}));
vi.mock("@/lib/messaging/registration/statusMapper", () => ({
  mapBrandStatus: mocks.mapBrandStatus,
  mapCampaignStatus: mocks.mapCampaignStatus,
  extractRejectionReason: mocks.extractRejectionReason,
}));
vi.mock("@/lib/email/registrationStatus", () => ({
  dedupeRecipients: mocks.dedupeRecipients,
  sendBrandApprovedEmail: mocks.sendBrandApprovedEmail,
  sendBrandRejectedEmail: mocks.sendBrandRejectedEmail,
  sendCampaignApprovedEmail: mocks.sendCampaignApprovedEmail,
  sendCampaignRejectedEmail: mocks.sendCampaignRejectedEmail,
}));

import { POST as statusWebhook } from "./route";

const CAMPAIGN_ID = "4b30019f-8814-cb6c-1e77-950fa70e0410";
const BRAND_ID = "4b20019d-e93e-d697-b8ee-c6233e9bf533";
const MESSAGING_PROFILE_ID = "40019f88-14ce-429f-a024-17fd89a4fe92";
const VERIFIED_OCCURRED_AT = "2026-07-27T20:39:22.993+00:00";
const VERIFIED_OBSERVED_AT = "2026-07-27T20:39:22.993Z";

const CAMPAIGN_SNAPSHOT = {
  id: "00000000-0000-4000-8000-00000000b1z1",
  owner_id: "00000000-0000-4000-8000-00000000own1",
  updated_at: "2026-07-27T20:38:00.000Z",
  deleted_at: null,
  telnyx_unique_claims_released_at: null,
  active_telnyx_release_run_id: null,
  telnyx_resource_state: "active",
  telnyx_submission_disabled: false,
  telnyx_brand_id: BRAND_ID,
  telnyx_campaign_id: CAMPAIGN_ID,
  telnyx_messaging_profile_id: MESSAGING_PROFILE_ID,
  brand_status: "approved",
  campaign_status: "rejected",
  campaign_status_updated_at: "2026-07-22T19:34:14.666+00:00",
  campaign_rejection_reason: "Carrier rejection",
  onboarding_registration_status: "failed",
  onboarding_registration_submitted_at: null,
  onboarding_registration_error: "Carrier rejection",
} as const;

const BUSINESS = {
  ...CAMPAIGN_SNAPSHOT,
  name: "Test Biz",
  authorized_rep_email: "rep@test.dev",
};
const TOMBSTONED_BUSINESS = {
  ...BUSINESS,
  deleted_at: "2026-07-22T12:00:00.000Z",
  telnyx_unique_claims_released_at: null,
};

// Chainable, awaitable supabase query mock: every method returns the chain,
// awaiting it resolves the queued result. from() consumes results FIFO.
type QueryChain = Record<string, ReturnType<typeof vi.fn>>;
const chains: QueryChain[] = [];

function applyIsFiltersToRow(row: Record<string, unknown>) {
  return (chain: QueryChain) => {
    const matches = chain.is.mock.calls.every(
      ([column, value]) => row[String(column)] === value
    );
    return { data: matches ? row : null, error: null };
  };
}

function queueResults(...results: unknown[]) {
  const queue = [...results];
  chains.length = 0;
  mocks.from.mockImplementation(() => {
    const result = queue.shift() ?? { data: null, error: null };
    const chain: QueryChain = {};
    for (const m of [
      "select",
      "update",
      "eq",
      "is",
      "or",
      "maybeSingle",
      "single",
    ]) {
      chain[m] = vi.fn(() => chain);
    }
    const promise = Promise.resolve().then(() =>
      typeof result === "function"
        ? (result as (query: QueryChain) => unknown)(chain)
        : result
    );
    (chain as Record<string, unknown>).then = promise.then.bind(promise);
    (chain as Record<string, unknown>).catch = promise.catch.bind(promise);
    chains.push(chain);
    return chain;
  });
}

function request() {
  return new NextRequest("http://localhost/api/messaging/registration/status", {
    method: "POST",
    body: "{}",
  });
}

function campaignEvent(
  id = "04b94a66-d98b-46b1-a3da-299c2ac18241",
  overrides: {
    eventType?: string;
    occurredAt?: string;
    payload?: Record<string, unknown>;
  } = {}
) {
  return {
    data: {
      id,
      event_type: overrides.eventType ?? "10dlc.campaign.update",
      occurred_at: overrides.occurredAt ?? VERIFIED_OCCURRED_AT,
      payload:
        overrides.payload ??
        ({
          type: "VERIFIED",
          cspId: "TNX",
          status: "ACCEPTED",
          brandId: BRAND_ID,
          campaignId: CAMPAIGN_ID,
          createDate: "2026-07-22T04:30:38.000Z",
          description: "Campaign is now provisioned",
          isTMobileRegistered: true,
        } satisfies Record<string, unknown>),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  mocks.markProcessedOnce.mockResolvedValue(true);
  mocks.releaseProcessedEvent.mockResolvedValue(undefined);
  mocks.appendRegistrationEvent.mockResolvedValue(undefined);
  mocks.serializeError.mockReturnValue({ error: "serialized" });
  mocks.applyObservedCampaignStatus.mockResolvedValue({
    outcome: "applied",
    statusChanged: true,
    repairedRejectedOnboarding: true,
  });
  mocks.ensureCampaignAssignmentForBusiness.mockResolvedValue(undefined);
  mocks.mapCampaignStatus.mockReturnValue({
    dbStatus: "approved",
    isTerminal: true,
  });
  mocks.extractRejectionReason.mockReturnValue(null);
  mocks.dedupeRecipients.mockReturnValue(["rep@test.dev"]);
  mocks.sendCampaignApprovedEmail.mockResolvedValue(undefined);
  queueResults();
});

describe("POST /api/messaging/registration/status", () => {
  it("forwards a full snapshot and provider ordering time, then awaits exactly one assignment for an applied VERIFIED approval", async () => {
    const event = campaignEvent();
    mocks.unwrap.mockResolvedValue(event);
    queueResults({ data: BUSINESS, error: null });

    let finishAssignment!: () => void;
    mocks.ensureCampaignAssignmentForBusiness.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishAssignment = resolve;
      })
    );

    let responseSettled = false;
    const responsePromise = statusWebhook(request()).then((response) => {
      responseSettled = true;
      return response;
    });

    await vi.waitFor(() => {
      expect(mocks.ensureCampaignAssignmentForBusiness).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    expect(responseSettled).toBe(false);

    finishAssignment();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(mocks.mapCampaignStatus).toHaveBeenCalledWith({
      campaignStatus: null,
      submissionStatus: null,
      status: "ACCEPTED",
      notificationType: "VERIFIED",
    });
    expect(mocks.applyObservedCampaignStatus).toHaveBeenCalledWith({
      snapshot: expect.objectContaining(CAMPAIGN_SNAPSHOT),
      newStatus: "approved",
      rejectionReason: null,
      observedAt: VERIFIED_OBSERVED_AT,
      touchIfUnchanged: true,
    });
    expect(mocks.ensureCampaignAssignmentForBusiness).toHaveBeenCalledWith(
      BUSINESS.id,
      {
        force: true,
        reason: "campaign_approved_webhook",
      }
    );
    expect(mocks.appendRegistrationEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS.id,
        resourceId: CAMPAIGN_ID,
        status: "approved",
        rawPayload: event,
      })
    );
    expect(chains[0].is).toHaveBeenNthCalledWith(1, "deleted_at", null);
    expect(chains[0].is).toHaveBeenNthCalledWith(
      2,
      "telnyx_unique_claims_released_at",
      null
    );
    await vi.waitFor(() => {
      expect(mocks.sendCampaignApprovedEmail).toHaveBeenCalledTimes(1);
    });
    expect(mocks.sendCampaignApprovedEmail).toHaveBeenCalledWith({
      businessId: BUSINESS.id,
      businessName: BUSINESS.name,
      recipients: ["rep@test.dev"],
    });
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
  });

  it("audits a campaign-shaped event with the wrong outer event type without mapping or transitioning it", async () => {
    const event = campaignEvent("evt_wrong_outer_type", {
      eventType: "campaign.status.update",
    });
    mocks.unwrap.mockResolvedValue(event);
    queueResults({ data: BUSINESS, error: null });

    const response = await statusWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.mapCampaignStatus).not.toHaveBeenCalled();
    expect(mocks.applyObservedCampaignStatus).not.toHaveBeenCalled();
    expect(mocks.ensureCampaignAssignmentForBusiness).not.toHaveBeenCalled();
    expect(mocks.sendCampaignApprovedEmail).not.toHaveBeenCalled();
    expect(mocks.appendRegistrationEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS.id,
        eventType: "campaign_status_changed",
        resourceType: "campaign",
        resourceId: CAMPAIGN_ID,
        rawPayload: event,
      })
    );
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["mismatched", "4b20019d-ffff-ffff-ffff-c6233e9bf533"],
  ])(
    "keeps a VERIFIED event with a %s brand identity audit-only",
    async (_label, eventBrandId) => {
      const event = campaignEvent("evt_brand_identity");
      const payload = event.data.payload as Record<string, unknown>;
      if (eventBrandId) {
        payload.brandId = eventBrandId;
      } else {
        delete payload.brandId;
      }
      mocks.unwrap.mockResolvedValue(event);
      queueResults({ data: BUSINESS, error: null });

      const response = await statusWebhook(request());

      expect(response.status).toBe(200);
      expect(mocks.appendRegistrationEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: BUSINESS.id,
          status: "audit_only_identity_mismatch",
          rawPayload: event,
        })
      );
      expect(mocks.mapCampaignStatus).not.toHaveBeenCalled();
      expect(mocks.applyObservedCampaignStatus).not.toHaveBeenCalled();
      expect(mocks.ensureCampaignAssignmentForBusiness).not.toHaveBeenCalled();
      expect(mocks.sendCampaignApprovedEmail).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["missing", null],
    ["invalid", "not-a-time"],
  ])(
    "keeps a VERIFIED event with %s occurred_at audit-only",
    async (_label, occurredAt) => {
      const event = campaignEvent("evt_invalid_time");
      const eventData = event.data as Record<string, unknown>;
      if (occurredAt) {
        eventData.occurred_at = occurredAt;
      } else {
        delete eventData.occurred_at;
      }
      mocks.unwrap.mockResolvedValue(event);
      queueResults({ data: BUSINESS, error: null });

      const response = await statusWebhook(request());

      expect(response.status).toBe(200);
      expect(mocks.appendRegistrationEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          businessId: BUSINESS.id,
          status: "audit_only_invalid_occurred_at",
          rawPayload: event,
        })
      );
      expect(mocks.mapCampaignStatus).not.toHaveBeenCalled();
      expect(mocks.applyObservedCampaignStatus).not.toHaveBeenCalled();
      expect(mocks.ensureCampaignAssignmentForBusiness).not.toHaveBeenCalled();
      expect(mocks.sendCampaignApprovedEmail).not.toHaveBeenCalled();
    }
  );

  it("keeps a stale/CAS-missed VERIFIED observation audit-only", async () => {
    const event = campaignEvent("fdf7d442-8be4-49ef-8470-e01ade0e8807", {
      occurredAt: "2026-07-27T20:39:25.476+00:00",
    });
    mocks.unwrap.mockResolvedValue(event);
    mocks.applyObservedCampaignStatus.mockResolvedValueOnce({
      outcome: "stale",
      statusChanged: false,
      repairedRejectedOnboarding: false,
    });
    queueResults({ data: BUSINESS, error: null });

    const response = await statusWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.applyObservedCampaignStatus).toHaveBeenCalledWith({
      snapshot: expect.objectContaining(CAMPAIGN_SNAPSHOT),
      newStatus: "approved",
      rejectionReason: null,
      observedAt: "2026-07-27T20:39:25.476Z",
      touchIfUnchanged: true,
    });
    expect(mocks.appendRegistrationEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS.id,
        resourceId: CAMPAIGN_ID,
        rawPayload: event,
      })
    );
    expect(mocks.ensureCampaignAssignmentForBusiness).not.toHaveBeenCalled();
    expect(mocks.sendCampaignApprovedEmail).not.toHaveBeenCalled();
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
  });

  it("processes both production VERIFIED event IDs, rechecks assignment idempotently, and emails only once", async () => {
    const firstEvent = campaignEvent(
      "04b94a66-d98b-46b1-a3da-299c2ac18241"
    );
    const secondEvent = campaignEvent(
      "fdf7d442-8be4-49ef-8470-e01ade0e8807",
      { occurredAt: "2026-07-27T20:39:25.476+00:00" }
    );
    mocks.unwrap
      .mockResolvedValueOnce(firstEvent)
      .mockResolvedValueOnce(secondEvent);
    mocks.applyObservedCampaignStatus
      .mockResolvedValueOnce({
        outcome: "applied",
        statusChanged: true,
        repairedRejectedOnboarding: true,
      })
      .mockResolvedValueOnce({
        outcome: "applied",
        statusChanged: false,
        repairedRejectedOnboarding: false,
      });
    queueResults(
      { data: BUSINESS, error: null },
      { data: BUSINESS, error: null }
    );

    const firstResponse = await statusWebhook(request());
    const secondResponse = await statusWebhook(request());

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(mocks.markProcessedOnce).toHaveBeenNthCalledWith(
      1,
      "04b94a66-d98b-46b1-a3da-299c2ac18241"
    );
    expect(mocks.markProcessedOnce).toHaveBeenNthCalledWith(
      2,
      "fdf7d442-8be4-49ef-8470-e01ade0e8807"
    );
    expect(mocks.applyObservedCampaignStatus).toHaveBeenCalledTimes(2);
    expect(mocks.appendRegistrationEvent).toHaveBeenCalledTimes(2);
    expect(mocks.ensureCampaignAssignmentForBusiness).toHaveBeenCalledTimes(2);
    expect(mocks.ensureCampaignAssignmentForBusiness).toHaveBeenNthCalledWith(
      1,
      BUSINESS.id,
      {
        force: true,
        reason: "campaign_approved_webhook",
      }
    );
    expect(mocks.ensureCampaignAssignmentForBusiness).toHaveBeenNthCalledWith(
      2,
      BUSINESS.id,
      {
        force: false,
        reason: "campaign_approved_webhook",
      }
    );
    await vi.waitFor(() => {
      expect(mocks.sendCampaignApprovedEmail).toHaveBeenCalledTimes(1);
    });
  });

  it("heals assignment without emailing when a shared transition applies only an onboarding repair", async () => {
    mocks.unwrap.mockResolvedValue(campaignEvent("evt_repair_only"));
    mocks.applyObservedCampaignStatus.mockResolvedValueOnce({
      outcome: "applied",
      statusChanged: false,
      repairedRejectedOnboarding: true,
    });
    queueResults({ data: BUSINESS, error: null });

    const response = await statusWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.applyObservedCampaignStatus).toHaveBeenCalledTimes(1);
    expect(mocks.ensureCampaignAssignmentForBusiness).toHaveBeenCalledWith(
      BUSINESS.id,
      {
        force: false,
        reason: "campaign_approved_webhook",
      }
    );
    expect(mocks.sendCampaignApprovedEmail).not.toHaveBeenCalled();
  });

  it("rechecks assignment on an unchanged approved replay after a prior post-CAS crash", async () => {
    mocks.unwrap.mockResolvedValue(
      campaignEvent("evt_unchanged_approved_replay")
    );
    mocks.applyObservedCampaignStatus.mockResolvedValueOnce({
      outcome: "unchanged",
      statusChanged: false,
      repairedRejectedOnboarding: false,
    });
    queueResults({
      data: { ...BUSINESS, campaign_status: "approved" },
      error: null,
    });

    const response = await statusWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.ensureCampaignAssignmentForBusiness).toHaveBeenCalledWith(
      BUSINESS.id,
      {
        force: false,
        reason: "campaign_approved_webhook",
      }
    );
    expect(mocks.sendCampaignApprovedEmail).not.toHaveBeenCalled();
  });

  it("releases the claim when an exact-row campaign CAS conflicts so Telnyx can retry", async () => {
    mocks.unwrap.mockResolvedValue(campaignEvent("evt_cas_conflict"));
    mocks.applyObservedCampaignStatus.mockResolvedValueOnce({
      outcome: "conflict",
      statusChanged: false,
      repairedRejectedOnboarding: false,
    });
    queueResults({ data: BUSINESS, error: null });

    const response = await statusWebhook(request());

    expect(response.status).toBe(500);
    expect(mocks.appendRegistrationEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS.id,
        status: "error",
      })
    );
    expect(mocks.releaseProcessedEvent).toHaveBeenCalledWith(
      "evt_cas_conflict"
    );
    expect(mocks.ensureCampaignAssignmentForBusiness).not.toHaveBeenCalled();
    expect(mocks.sendCampaignApprovedEmail).not.toHaveBeenCalled();
  });

  it("dedups duplicate deliveries without touching the database", async () => {
    mocks.unwrap.mockResolvedValue(campaignEvent("evt_status_1"));
    mocks.markProcessedOnce.mockResolvedValue(false);

    const response = await statusWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
  });

  it("releases the claim and 500s when the business lookup hits a DB error", async () => {
    mocks.unwrap.mockResolvedValue(campaignEvent("evt_status_1"));
    queueResults({ data: null, error: { message: "connection reset" } });

    const response = await statusWebhook(request());

    expect(response.status).toBe(500);
    expect(mocks.releaseProcessedEvent).toHaveBeenCalledWith("evt_status_1");
  });

  it("acks a genuine not-found (archived/foreign resource) without releasing", async () => {
    mocks.unwrap.mockResolvedValue(campaignEvent("evt_status_1"));
    queueResults({ data: null, error: null });

    const response = await statusWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
  });

  it("acks a late event for a tombstoned business without resolving or mutating it", async () => {
    mocks.unwrap.mockResolvedValue(campaignEvent("evt_status_1"));
    queueResults(
      applyIsFiltersToRow(TOMBSTONED_BUSINESS),
      { data: [{ id: BUSINESS.id }], error: null }
    );

    const response = await statusWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(chains).toHaveLength(1);
    expect(chains[0].update).not.toHaveBeenCalled();
    expect(mocks.mapCampaignStatus).not.toHaveBeenCalled();
    expect(mocks.applyObservedCampaignStatus).not.toHaveBeenCalled();
    expect(mocks.appendRegistrationEvent).not.toHaveBeenCalled();
    expect(mocks.ensureCampaignAssignmentForBusiness).not.toHaveBeenCalled();
    expect(mocks.dedupeRecipients).not.toHaveBeenCalled();
    expect(mocks.sendCampaignApprovedEmail).not.toHaveBeenCalled();
    expect(mocks.releaseProcessedEvent).not.toHaveBeenCalled();
  });

  it("audits, releases, and 500s when the shared transition fails", async () => {
    mocks.unwrap.mockResolvedValue(campaignEvent("evt_status_1"));
    mocks.applyObservedCampaignStatus.mockRejectedValueOnce(
      new Error("serialization failure")
    );
    queueResults({ data: BUSINESS, error: null });

    const response = await statusWebhook(request());

    expect(response.status).toBe(500);
    // The error-audit path still records the failure before rethrowing.
    expect(mocks.appendRegistrationEvent).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS.id, status: "error" })
    );
    expect(mocks.releaseProcessedEvent).toHaveBeenCalledWith("evt_status_1");
  });

  it("releases the webhook claim when assignment setup fails so a retry can heal it", async () => {
    mocks.unwrap.mockResolvedValue(campaignEvent("evt_assignment_failure"));
    mocks.ensureCampaignAssignmentForBusiness.mockRejectedValueOnce(
      new Error("database unavailable")
    );
    queueResults({ data: BUSINESS, error: null });

    const response = await statusWebhook(request());

    expect(response.status).toBe(500);
    expect(mocks.ensureCampaignAssignmentForBusiness).toHaveBeenCalledOnce();
    expect(mocks.appendRegistrationEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS.id,
        status: "error",
      })
    );
    expect(mocks.releaseProcessedEvent).toHaveBeenCalledWith(
      "evt_assignment_failure"
    );
  });

  // NOTE deliberately absent: an "audit append fails → 500" test would be
  // theater — the real appendRegistrationEvent swallows its own DB errors
  // and never rejects (src/lib/messaging/registration/audit.ts), so that
  // branch is unreachable in production. Audit writes are best-effort.

  it("returns 403 before any claim when the signature fails", async () => {
    mocks.unwrap.mockRejectedValue(new Error("bad signature"));

    const response = await statusWebhook(request());

    expect(response.status).toBe(403);
    expect(mocks.markProcessedOnce).not.toHaveBeenCalled();
  });
});
