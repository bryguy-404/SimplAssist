import { NextResponse } from "next/server";
import { telnyx } from "@/lib/messaging/client";
import { resolveSmsProvisioningAccess } from "@/lib/billing/entitlements";
import {
  appendRegistrationEvent,
  appendRegistrationEventOrThrow,
} from "@/lib/messaging/registration/audit";
import {
  applyObservedCampaignStatus,
  getCampaignAssignmentSafetyBlock,
  type CampaignStatusSnapshot,
} from "@/lib/messaging/registration/campaignStatusTransition";
import { ensureCampaignAssignmentForBusiness } from "@/lib/messaging/registration/phoneNumberAssignment";
import { mapCampaignStatus } from "@/lib/messaging/registration/statusMapper";
import {
  hasCarrierRejection,
  REJECTION_SUPPORT_MESSAGE,
} from "@/lib/onboarding/rejectionGuidance";
import { getOnboardingStateForOwnerReadOnly } from "@/lib/onboarding/state";
import { createClient } from "@/lib/supabase/server";
import { requireWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";

const CAMPAIGN_READ_TIMEOUT_MS = 10_000;
const CAMPAIGN_SNAPSHOT_SELECT = [
  "id",
  "owner_id",
  "updated_at",
  "deleted_at",
  "telnyx_unique_claims_released_at",
  "active_telnyx_release_run_id",
  "telnyx_resource_state",
  "telnyx_submission_disabled",
  "telnyx_brand_id",
  "telnyx_campaign_id",
  "telnyx_messaging_profile_id",
  "brand_status",
  "campaign_status",
  "campaign_status_updated_at",
  "campaign_rejection_reason",
  "onboarding_registration_status",
  "onboarding_registration_submitted_at",
  "onboarding_registration_error",
  "telnyx_campaign_assignment_claim_token",
  "telnyx_campaign_assignment_claimed_at",
].join(", ");

export async function POST() {
  const workspaceGate = await requireWorkspaceRouteAccess();
  if (!workspaceGate.ok) return workspaceGate.response;

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error: readError } = await supabase
    .from("businesses")
    .select(CAMPAIGN_SNAPSHOT_SELECT)
    .eq("owner_id", user.id)
    .is("deleted_at", null)
    .is("telnyx_unique_claims_released_at", null)
    .maybeSingle<CampaignStatusSnapshot>();

  if (readError) {
    console.error("[onboarding:refreshStatus] Business read failed", {
      ownerId: user.id,
      code: readError.code,
    });
    return NextResponse.json(
      { error: "Could not refresh carrier status right now." },
      { status: 500 }
    );
  }
  if (!data) {
    return NextResponse.json({ error: "Business not found" }, { status: 404 });
  }

  const snapshot = data;
  if (hasCarrierRejection(snapshot.brand_status, snapshot.campaign_status)) {
    return NextResponse.json(
      {
        code: "rejection_support_required",
        error: REJECTION_SUPPORT_MESSAGE,
      },
      { status: 409 }
    );
  }

  const smsAccess = await resolveSmsProvisioningAccess(snapshot.id, {
    allowDirectPrecheckout: false,
  });
  if (!smsAccess.allowed) {
    if (smsAccess.reason === "billing_state_unavailable") {
      return NextResponse.json(
        { error: "Unable to verify plan access", retryable: true },
        { status: 503 },
      );
    }
    return NextResponse.json(
      {
        code: "sms_provisioning_not_available",
        error: "Carrier status is not available on the current plan.",
      },
      { status: 403 },
    );
  }

  const safetyBlock = getCampaignAssignmentSafetyBlock(snapshot);
  if ((safetyBlock === "brand_not_approved" || safetyBlock === "missing_campaign_id") &&
    snapshot.telnyx_brand_id && !snapshot.telnyx_campaign_id &&
    snapshot.onboarding_registration_status === "submitted" && !snapshot.onboarding_registration_error) {
    const state = await loadReadOnlyState(user.id, snapshot.id);
    return NextResponse.json({ state, reconciled: false,
      message: "Business verification and SMS setup will continue automatically. You do not need to resubmit." });
  }
  if (safetyBlock) {
    await auditRefresh(snapshot, {
      outcome: "blocked",
      safetyBlock,
    });
    return NextResponse.json(
      {
        code: "campaign_refresh_blocked",
        error: "Carrier status refresh is not available for this account.",
      },
      { status: 409 }
    );
  }

  let remoteCampaign: Awaited<
    ReturnType<typeof telnyx.messaging10dlc.campaign.retrieve>
  >;
  try {
    remoteCampaign = await telnyx.messaging10dlc.campaign.retrieve(
      snapshot.telnyx_campaign_id!,
      {
        maxRetries: 0,
        timeout: CAMPAIGN_READ_TIMEOUT_MS,
      }
    );
  } catch (err) {
    const providerStatus = getErrorStatus(err);
    console.error("[onboarding:refreshStatus] Telnyx campaign read failed", {
      businessId: snapshot.id,
      providerStatus,
    });
    await auditRefresh(snapshot, {
      outcome: "provider_error",
      providerStatus,
    });
    return NextResponse.json(
      {
        code: "carrier_status_unavailable",
        error: "Carrier status could not be loaded. Please try again.",
      },
      { status: 502 }
    );
  }

  const remoteCampaignId = cleanString(remoteCampaign.campaignId);
  const remoteBrandId = cleanString(remoteCampaign.brandId);
  if (
    remoteCampaignId !== snapshot.telnyx_campaign_id ||
    remoteBrandId !== snapshot.telnyx_brand_id
  ) {
    await auditRefresh(snapshot, {
      outcome: "identity_mismatch",
      localCampaignId: snapshot.telnyx_campaign_id,
      remoteCampaignId,
      localBrandId: snapshot.telnyx_brand_id,
      remoteBrandId,
    });
    return NextResponse.json(
      {
        code: "carrier_identity_mismatch",
        error:
          "We could not verify the campaign for this registration. No changes were made.",
      },
      { status: 409 }
    );
  }

  const providerCampaignStatus = cleanString(remoteCampaign.campaignStatus);
  const providerSubmissionStatus = cleanString(
    remoteCampaign.submissionStatus
  );
  const providerStatus = cleanString(remoteCampaign.status);
  const mapped = mapCampaignStatus({
    campaignStatus: providerCampaignStatus,
    submissionStatus: providerSubmissionStatus,
    status: providerStatus,
  });

  if (!mapped.dbStatus) {
    await auditRefresh(snapshot, {
      outcome: "no_terminal_change",
      providerCampaignStatus,
      providerSubmissionStatus,
      providerStatus,
    });
    return NextResponse.json({
      reconciled: false,
      providerStatus:
        providerCampaignStatus ?? providerSubmissionStatus ?? providerStatus,
      message: "Your SMS campaign is still under carrier review.",
    });
  }

  const observedAt = new Date().toISOString();
  const rejectionReason =
    mapped.dbStatus === "rejected"
      ? extractRemoteRejectionReason(remoteCampaign)
      : null;

  try {
    await appendRegistrationEventOrThrow({
      businessId: snapshot.id,
      eventType: "campaign_status_refreshed",
      resourceType: "campaign",
      resourceId: snapshot.telnyx_campaign_id,
      status: "reconcile_started",
      rejectionReason,
      rawPayload: {
        source: "customer_refresh",
        outcome: "reconcile_started",
        providerCampaignStatus,
        providerSubmissionStatus,
        providerStatus,
        previousLocalStatus: snapshot.campaign_status,
      },
    });
  } catch (err) {
    console.error("[onboarding:refreshStatus] Reconcile intent audit failed", {
      businessId: snapshot.id,
      message: err instanceof Error ? err.message : "unknown error",
    });
    return NextResponse.json(
      {
        code: "campaign_audit_unavailable",
        error:
          "Carrier status could not be reconciled safely. No changes were made.",
      },
      { status: 500 }
    );
  }

  let transition;
  try {
    transition = await applyObservedCampaignStatus({
      snapshot,
      newStatus: mapped.dbStatus,
      rejectionReason,
      observedAt,
      enforceAssignmentSafety: true,
      touchIfUnchanged: true,
    });
  } catch (err) {
    console.error("[onboarding:refreshStatus] Reconciliation failed", {
      businessId: snapshot.id,
      message: err instanceof Error ? err.message : "unknown error",
    });
    await auditRefresh(snapshot, {
      outcome: "reconcile_error",
      providerCampaignStatus,
      providerSubmissionStatus,
      providerStatus,
    });
    return NextResponse.json(
      {
        code: "campaign_reconcile_failed",
        error: "Carrier status could not be reconciled. Please try again.",
      },
      { status: 500 }
    );
  }

  if (transition.outcome !== "applied") {
    await auditRefresh(snapshot, {
      outcome: "conditional_update_missed",
      providerCampaignStatus,
      providerSubmissionStatus,
      providerStatus,
    });
    return NextResponse.json(
      {
        code: "campaign_state_changed",
        error:
          "Registration state changed while refreshing. Please refresh again.",
      },
      { status: 409 }
    );
  }

  try {
    await appendRegistrationEventOrThrow({
      businessId: snapshot.id,
      eventType: "campaign_status_refreshed",
      resourceType: "campaign",
      resourceId: snapshot.telnyx_campaign_id,
      status: mapped.dbStatus,
      rejectionReason,
      rawPayload: {
        source: "customer_refresh",
        outcome: "reconciled",
        providerCampaignStatus,
        providerSubmissionStatus,
        providerStatus,
        previousLocalStatus: snapshot.campaign_status,
        statusChanged: transition.statusChanged,
        repairedRejectedOnboarding:
          transition.repairedRejectedOnboarding,
      },
    });
  } catch (err) {
    console.error("[onboarding:refreshStatus] Reconcile audit failed", {
      businessId: snapshot.id,
      message: err instanceof Error ? err.message : "unknown error",
    });
    const state = await loadReadOnlyState(user.id, snapshot.id);
    return NextResponse.json(
      {
        ...(state ? { state } : {}),
        synced: true,
        reconciled: transition.statusChanged,
        code: "campaign_audit_failed",
        error:
          "Campaign status was synced, but the follow-up could not be recorded. Please refresh again.",
      },
      { status: 500 }
    );
  }

  if (mapped.dbStatus === "approved") {
    try {
      await ensureCampaignAssignmentForBusiness(snapshot.id, {
        force: transition.statusChanged,
        reason: "customer_status_refresh",
      });
    } catch (err) {
      console.error("[onboarding:refreshStatus] Assignment start failed", {
        businessId: snapshot.id,
        message: err instanceof Error ? err.message : "unknown error",
      });
      const state = await loadReadOnlyState(user.id, snapshot.id);
      return NextResponse.json(
        {
          ...(state ? { state } : {}),
          synced: true,
          reconciled: transition.statusChanged,
          code: "campaign_assignment_start_failed",
          error:
            "Campaign status was synced, but number assignment could not be started. Please refresh again.",
        },
        { status: 502 }
      );
    }
  }

  const state = await loadReadOnlyState(user.id, snapshot.id);
  if (!state) {
    return NextResponse.json(
      {
        synced: true,
        reconciled: transition.statusChanged,
        error: "Campaign status was synced, but the updated state could not be loaded.",
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    state,
    synced: true,
    reconciled: transition.statusChanged,
    repaired: transition.repairedRejectedOnboarding,
    providerStatus:
      providerCampaignStatus ?? providerSubmissionStatus ?? providerStatus,
    message: transition.statusChanged
      ? "Carrier status updated."
      : "Carrier status is already up to date.",
  });
}

async function loadReadOnlyState(ownerId: string, businessId: string) {
  try {
    return await getOnboardingStateForOwnerReadOnly(ownerId);
  } catch (err) {
    console.error("[onboarding:refreshStatus] Updated state read failed", {
      businessId,
      message: err instanceof Error ? err.message : "unknown error",
    });
    return null;
  }
}

async function auditRefresh(
  snapshot: CampaignStatusSnapshot,
  rawPayload: Record<string, unknown>
): Promise<void> {
  try {
    await appendRegistrationEvent({
      businessId: snapshot.id,
      eventType: "campaign_status_refreshed",
      resourceType: "campaign",
      resourceId: snapshot.telnyx_campaign_id,
      status:
        typeof rawPayload.outcome === "string" ? rawPayload.outcome : null,
      rawPayload: {
        source: "customer_refresh",
        ...rawPayload,
      },
    });
  } catch {
    console.error("[onboarding:refreshStatus] Best-effort audit threw", {
      businessId: snapshot.id,
      outcome: rawPayload.outcome,
    });
  }
}

function extractRemoteRejectionReason(
  remoteCampaign: unknown
): string | null {
  if (typeof remoteCampaign !== "object" || remoteCampaign === null) {
    return null;
  }
  const payload = remoteCampaign as Record<string, unknown>;
  const failureReasons = payload.failureReasons;
  if (typeof failureReasons === "string" && failureReasons.trim()) {
    return failureReasons.trim();
  }
  if (Array.isArray(failureReasons)) {
    const reasons = failureReasons
      .filter(
        (reason): reason is string =>
          typeof reason === "string" && reason.trim().length > 0
      )
      .map((reason) => reason.trim());
    if (reasons.length > 0) return reasons.join("; ");
  }

  for (const key of [
    "rejectionReason",
    "rejection_reason",
    "failureReason",
    "failure_reason",
    "reason",
  ]) {
    const reason = cleanString(payload[key]);
    if (reason) return reason;
  }

  const errors = payload.errors;
  if (Array.isArray(errors)) {
    for (const error of errors) {
      if (typeof error === "string" && error.trim()) {
        return error.trim();
      }
      if (typeof error !== "object" || error === null) continue;
      const errorPayload = error as Record<string, unknown>;
      for (const key of ["detail", "message", "title", "description"]) {
        const reason = cleanString(errorPayload[key]);
        if (reason) return reason;
      }
    }
  }
  return null;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function getErrorStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const error = err as {
    status?: number;
    statusCode?: number;
    response?: { status?: number };
  };
  return error.status ?? error.statusCode ?? error.response?.status ?? null;
}
