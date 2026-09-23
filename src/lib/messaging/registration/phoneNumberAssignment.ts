import { randomUUID } from "node:crypto";
import { telnyx } from "@/lib/messaging/client";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { CampaignAssignmentStatus } from "@/types/database";
import { appendRegistrationEvent, serializeError } from "./audit";
import {
  assertTextingUpgradeProvisioningAllowed,
  canContinueTextingUpgradeProvisioning,
  reconcileTextingUpgradeActivationForBusiness,
} from "@/lib/billing/textingUpgradeActivation.server";

const PENDING_REFRESH_COOLDOWN_MS = 60_000;
const FAILED_RETRY_COOLDOWN_MS = 5 * 60_000;
const ASSIGNMENT_INTENT_LEASE_MS = 60_000;
const ASSIGNMENT_PROVIDER_TIMEOUT_MS = 10_000;
const DIFFERENT_CAMPAIGN_MARKER = "different campaign";
const ASSIGNMENT_BUSINESS_SELECT =
  "id, updated_at, deleted_at, operations_suspended_at, telnyx_unique_claims_released_at, active_telnyx_release_run_id, telnyx_resource_state, telnyx_submission_disabled, telnyx_brand_id, telnyx_campaign_id, telnyx_messaging_profile_id, brand_status, campaign_status, telnyx_campaign_assignment_claim_token, telnyx_campaign_assignment_claimed_at, telnyx_campaign_assignment_claim_campaign_id, telnyx_campaign_assignment_claim_profile_id";

interface AssignmentBusinessRow {
  id: string;
  updated_at: string;
  deleted_at: string | null;
  operations_suspended_at: string | null;
  telnyx_unique_claims_released_at: string | null;
  active_telnyx_release_run_id: string | null;
  telnyx_resource_state: string;
  telnyx_submission_disabled: boolean;
  telnyx_brand_id: string | null;
  telnyx_campaign_id: string | null;
  telnyx_messaging_profile_id: string | null;
  brand_status: string | null;
  campaign_status: string | null;
  telnyx_campaign_assignment_claim_token: string | null;
  telnyx_campaign_assignment_claimed_at: string | null;
  telnyx_campaign_assignment_claim_campaign_id: string | null;
  telnyx_campaign_assignment_claim_profile_id: string | null;
}

interface AssignmentPhoneNumberRow {
  id: string;
  business_id: string;
  phone_number: string;
  resource_status: string;
  telnyx_campaign_assignment_status: CampaignAssignmentStatus;
  telnyx_campaign_assignment_task_id: string | null;
  telnyx_campaign_assignment_campaign_id: string | null;
  telnyx_campaign_assignment_failure_reason: string | null;
  telnyx_campaign_assignment_updated_at: string | null;
  telnyx_campaign_assigned_at: string | null;
}

interface EnsureAssignmentOptions {
  force?: boolean;
  reason?: string;
}

interface AssignmentLease {
  business: AssignmentBusinessRow & {
    telnyx_campaign_id: string;
    telnyx_messaging_profile_id: string;
    telnyx_campaign_assignment_claim_token: string;
  };
}

interface PhoneAssignmentClaim {
  row: AssignmentPhoneNumberRow;
  claimedAt: string;
  campaignId: string;
}

type InspectResult =
  | { action: "assigned"; rawPayload: unknown }
  | { action: "pending"; rawPayload: unknown }
  | { action: "needs_assignment"; rawPayload?: unknown }
  | { action: "failed"; failureReason: string; rawPayload: unknown };

export async function ensureCampaignAssignmentForBusiness(
  businessId: string,
  options: EnsureAssignmentOptions = {}
): Promise<void> {
  const reason = options.reason ?? "lazy_refresh";

  const { data: business, error: businessError } = await supabaseAdmin
    .from("businesses")
    .select(ASSIGNMENT_BUSINESS_SELECT)
    .eq("id", businessId)
    .single<AssignmentBusinessRow>();

  if (businessError || !business) {
    throw new Error(
      `[assignment] Business ${businessId} not found: ${businessError?.message ?? "not found"}`
    );
  }

  if (!isAssignmentBusinessSafe(business)) {
    return;
  }
  if (!(await canContinueTextingUpgradeProvisioning(businessId))) return;
  if (hasFreshBusinessAssignmentClaim(business)) {
    return;
  }

  const claimedBusiness = await claimBusinessProfileAssignment(business);
  if (!claimedBusiness) return;
  const lease: AssignmentLease = {
    business: claimedBusiness as AssignmentLease["business"],
  };

  try {
    const { data: numbers, error: numbersError } = await supabaseAdmin
      .from("phone_numbers")
      .select(
        "id, business_id, phone_number, resource_status, telnyx_campaign_assignment_status, telnyx_campaign_assignment_task_id, telnyx_campaign_assignment_campaign_id, telnyx_campaign_assignment_failure_reason, telnyx_campaign_assignment_updated_at, telnyx_campaign_assigned_at"
      )
      .eq("business_id", businessId)
      .eq("is_active", true)
      .eq("resource_status", "active")
      .returns<AssignmentPhoneNumberRow[]>();

    if (numbersError) {
      throw new Error(
        `[assignment] Failed to read phone numbers for business ${businessId}: ${numbersError.message}`
      );
    }

    const activeNumbers = numbers ?? [];
    const hasFreshAssignmentIntent = activeNumbers.some(
      (row) =>
        row.telnyx_campaign_assignment_status === "pending" &&
        !row.telnyx_campaign_assignment_task_id &&
        row.telnyx_campaign_assignment_campaign_id ===
          lease.business.telnyx_campaign_id &&
        Boolean(row.telnyx_campaign_assignment_updated_at) &&
        !isOlderThan(
          row.telnyx_campaign_assignment_updated_at!,
          PENDING_REFRESH_COOLDOWN_MS
        )
    );
    if (hasFreshAssignmentIntent) return;

    if (
      !options.force &&
      activeNumbers.some(
        (row) =>
          row.telnyx_campaign_assignment_status === "pending" &&
          row.telnyx_campaign_assignment_campaign_id ===
            lease.business.telnyx_campaign_id &&
          Boolean(row.telnyx_campaign_assignment_updated_at) &&
          !isOlderThan(
            row.telnyx_campaign_assignment_updated_at!,
            PENDING_REFRESH_COOLDOWN_MS
          )
      )
    ) {
      return;
    }

    const candidates = activeNumbers.filter((row) =>
      shouldInspectAssignment(
        row,
        options.force ?? false,
        lease.business.telnyx_campaign_id
      )
    );

    for (const row of candidates) {
      await processPhoneAssignmentCandidate({
        lease,
        row,
        reason,
      });
    }
  } finally {
    await releaseBusinessProfileAssignmentClaim(lease.business);
  }
  await reconcileTextingUpgradeActivationForBusiness(businessId);
}

function isAssignmentBusinessSafe(
  business: AssignmentBusinessRow
): business is AssignmentBusinessRow & {
  telnyx_brand_id: string;
  telnyx_campaign_id: string;
  telnyx_messaging_profile_id: string;
} {
  return (
    business.campaign_status === "approved" &&
    business.brand_status === "approved" &&
    Boolean(business.telnyx_brand_id?.trim()) &&
    Boolean(business.telnyx_campaign_id?.trim()) &&
    Boolean(business.telnyx_messaging_profile_id?.trim()) &&
    !business.deleted_at &&
    !business.operations_suspended_at &&
    !business.telnyx_unique_claims_released_at &&
    !business.active_telnyx_release_run_id &&
    !business.telnyx_submission_disabled &&
    (business.telnyx_resource_state === "provisioning" ||
      business.telnyx_resource_state === "active")
  );
}

function hasFreshBusinessAssignmentClaim(
  business: AssignmentBusinessRow
): boolean {
  if (
    !business.telnyx_campaign_assignment_claim_token
  ) {
    return false;
  }
  if (!business.telnyx_campaign_assignment_claimed_at) return true;
  return !isOlderThan(
    business.telnyx_campaign_assignment_claimed_at,
    ASSIGNMENT_INTENT_LEASE_MS
  );
}

function shouldInspectAssignment(
  row: AssignmentPhoneNumberRow,
  force: boolean,
  currentCampaignId: string
): boolean {
  if (force) return true;
  // Assignment state referencing a DIFFERENT campaign than the business's
  // current one is stale (e.g. a rejected campaign was replaced) — always
  // re-inspect, even if it reads 'assigned' or previously failed with the
  // different-campaign marker.
  if (
    row.telnyx_campaign_assignment_campaign_id &&
    row.telnyx_campaign_assignment_campaign_id !== currentCampaignId
  ) {
    return true;
  }
  if (row.telnyx_campaign_assignment_status === "assigned") return false;
  if (isDifferentCampaignFailure(row.telnyx_campaign_assignment_failure_reason)) {
    // Cooldown rather than a permanent skip: after a campaign replacement
    // whose Telnyx-side deactivation failed, the number can be stamped
    // different-campaign against the NEW id; once the old campaign finally
    // dies, re-inspection self-heals the assignment.
    const updatedAt = row.telnyx_campaign_assignment_updated_at;
    if (!updatedAt) return true;
    return isOlderThan(updatedAt, FAILED_RETRY_COOLDOWN_MS);
  }

  const updatedAt = row.telnyx_campaign_assignment_updated_at;
  if (!updatedAt) return true;

  if (row.telnyx_campaign_assignment_status === "failed") {
    return isOlderThan(updatedAt, FAILED_RETRY_COOLDOWN_MS);
  }

  return isOlderThan(updatedAt, PENDING_REFRESH_COOLDOWN_MS);
}

function isOlderThan(iso: string, ms: number): boolean {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return true;
  return Date.now() - time >= ms;
}

function isDifferentCampaignFailure(reason: string | null): boolean {
  return reason?.toLowerCase().includes(DIFFERENT_CAMPAIGN_MARKER) ?? false;
}

async function processPhoneAssignmentCandidate(args: {
  lease: AssignmentLease;
  row: AssignmentPhoneNumberRow;
  reason: string;
}): Promise<void> {
  const { lease, row, reason } = args;
  const campaignId = lease.business.telnyx_campaign_id;
  const claim = await claimPhoneAssignment(row, campaignId);
  if (!claim) return;

  let providerMutationAttempted = false;
  let preProviderFailureStatus = "assignment_failed";
  try {
    if (!(await renewBusinessProfileAssignmentClaim(lease))) {
      await releasePhoneAssignmentClaim(claim);
      return;
    }

    if (
      row.telnyx_campaign_assignment_status === "pending" &&
      row.telnyx_campaign_assignment_task_id &&
      row.telnyx_campaign_assignment_campaign_id === campaignId
    ) {
      let task: Awaited<
        ReturnType<
          typeof telnyx.messaging10dlc.phoneNumberAssignmentByProfile.retrieveStatus
        >
      >;
      try {
        task =
          await telnyx.messaging10dlc.phoneNumberAssignmentByProfile.retrieveStatus(
            row.telnyx_campaign_assignment_task_id,
            {
              maxRetries: 0,
              timeout: ASSIGNMENT_PROVIDER_TIMEOUT_MS,
            }
          );
      } catch (err) {
        console.warn(
          `[assignment] Failed to refresh task ${row.telnyx_campaign_assignment_task_id}:`,
          err
        );
        if (!(await renewBusinessProfileAssignmentClaim(lease))) {
          await releasePhoneAssignmentClaim(claim);
          return;
        }
        await finalizeClaimedNumberAssignment(claim, {
          status: "pending",
          campaignId,
          taskId: row.telnyx_campaign_assignment_task_id,
          failureReason: null,
        });
        await auditAssignmentFailure({
          businessId: lease.business.id,
          phoneNumber: row.phone_number,
          status: "task_status_unavailable",
          reason,
          rawPayload: serializeError(err),
          failureReason:
            "Telnyx assignment task status could not be confirmed",
        });
        return;
      }

      if (!(await renewBusinessProfileAssignmentClaim(lease))) {
        await releasePhoneAssignmentClaim(claim);
        return;
      }

      await auditAssignmentStatus({
        businessId: lease.business.id,
        phoneNumber: row.phone_number,
        status: `task_${task.status}`,
        reason,
        rawPayload: task,
      });

      if (task.status === "failed") {
        await finalizeClaimedNumberAssignment(claim, {
          status: "failed",
          campaignId,
          taskId: row.telnyx_campaign_assignment_task_id,
          failureReason: "Telnyx assignment task failed",
        });
        return;
      }

      if (task.status === "pending" || task.status === "processing") {
        await finalizeClaimedNumberAssignment(claim, {
          status: "pending",
          campaignId,
          taskId: row.telnyx_campaign_assignment_task_id,
          failureReason: null,
        });
        return;
      }

      if (task.status !== "completed") {
        await finalizeClaimedNumberAssignment(claim, {
          status: "pending",
          campaignId,
          taskId: row.telnyx_campaign_assignment_task_id,
          failureReason: null,
        });
        await auditAssignmentFailure({
          businessId: lease.business.id,
          phoneNumber: row.phone_number,
          status: "task_status_unknown",
          reason,
          rawPayload: task,
          failureReason: `Unexpected Telnyx assignment task status: ${String(task.status)}`,
        });
        return;
      }
    }

    if (!(await renewBusinessProfileAssignmentClaim(lease))) {
      await releasePhoneAssignmentClaim(claim);
      return;
    }

    let inspected: InspectResult;
    try {
      inspected = await inspectNumberAssignment(row, campaignId);
    } catch (err) {
      preProviderFailureStatus = "inspection_unavailable";
      throw err;
    }

    if (!(await renewBusinessProfileAssignmentClaim(lease))) {
      await releasePhoneAssignmentClaim(claim);
      return;
    }

    if (inspected.action === "assigned") {
      await finalizeClaimedNumberAssignment(claim, {
        status: "assigned",
        campaignId,
        taskId: null,
        failureReason: null,
      });
      await auditAssignmentStatus({
        businessId: lease.business.id,
        phoneNumber: row.phone_number,
        status: "assigned",
        reason,
        rawPayload: inspected.rawPayload,
      });
      return;
    }

    if (inspected.action === "pending") {
      await finalizeClaimedNumberAssignment(claim, {
        status: "pending",
        campaignId,
        taskId: null,
        failureReason: null,
      });
      await auditAssignmentStatus({
        businessId: lease.business.id,
        phoneNumber: row.phone_number,
        status: "pending",
        reason,
        rawPayload: inspected.rawPayload,
      });
      return;
    }

    if (inspected.action === "failed") {
      await finalizeClaimedNumberAssignment(claim, {
        status: "failed",
        campaignId,
        taskId: null,
        failureReason: inspected.failureReason,
      });
      await auditAssignmentFailure({
        businessId: lease.business.id,
        phoneNumber: row.phone_number,
        status: "failed",
        reason,
        rawPayload: inspected.rawPayload,
        failureReason: inspected.failureReason,
      });
      return;
    }

    if (!(await renewBusinessProfileAssignmentClaim(lease))) {
      await releasePhoneAssignmentClaim(claim);
      return;
    }

    await assertTextingUpgradeProvisioningAllowed(lease.business.id);
    providerMutationAttempted = true;
    const response =
      await telnyx.messaging10dlc.phoneNumberCampaigns.create(
        {
          phoneNumber: row.phone_number,
          campaignId,
        },
        {
          maxRetries: 0,
          timeout: ASSIGNMENT_PROVIDER_TIMEOUT_MS,
        }
      );

    if (
      response.phoneNumber !== row.phone_number ||
      !assignmentCampaignIds(response).includes(campaignId)
    ) {
      throw new Error(
        "Telnyx assignment response did not match the claimed phone number and campaign"
      );
    }

    if (!(await renewBusinessProfileAssignmentClaim(lease))) {
      await auditAssignmentFailure({
        businessId: lease.business.id,
        phoneNumber: row.phone_number,
        status: "intent_lost",
        reason,
        rawPayload: response,
        failureReason:
          "Assignment intent lost lifecycle authorization before local finalization",
      });
      return;
    }

    const responseStatus =
      response.assignmentStatus === "ASSIGNED"
        ? "assigned"
        : response.assignmentStatus === "FAILED_ASSIGNMENT"
          ? "failed"
          : "pending";
    const responseFailureReason =
      responseStatus === "failed"
        ? response.failureReasons || "Telnyx reported failed assignment"
        : null;
    await finalizeClaimedNumberAssignment(claim, {
      status: responseStatus,
      campaignId,
      taskId: null,
      failureReason: responseFailureReason,
    });

    await appendRegistrationEvent({
      businessId: lease.business.id,
      eventType:
        responseStatus === "failed"
          ? "phone_number_assignment_failed"
          : "phone_number_assignment_started",
      resourceType: "phone_number_assignment",
      resourceId: row.phone_number,
      status: responseStatus,
      rejectionReason: responseFailureReason,
      rawPayload: {
        reason,
        phoneNumber: row.phone_number,
        response,
      },
    });
  } catch (err) {
    const failureReason = errorMessage(err);
    if (!providerMutationAttempted) {
      await releasePhoneAssignmentClaim(claim);
    }
    await auditAssignmentFailure({
      businessId: lease.business.id,
      phoneNumber: row.phone_number,
      status: providerMutationAttempted
        ? "provider_outcome_unknown"
        : preProviderFailureStatus,
      reason,
      rawPayload: serializeError(err),
      failureReason,
    });
    if (!providerMutationAttempted) {
      throw err;
    }
  }
}

async function inspectNumberAssignment(
  row: AssignmentPhoneNumberRow,
  campaignId: string
): Promise<InspectResult> {
  try {
    const assignment =
      await telnyx.messaging10dlc.phoneNumberCampaigns.retrieve(
        row.phone_number,
        {
          maxRetries: 0,
          timeout: ASSIGNMENT_PROVIDER_TIMEOUT_MS,
        }
      );
    const ids = assignmentCampaignIds(assignment);
    const assignedToSameCampaign = ids.includes(campaignId);

    if (ids.length > 0 && !assignedToSameCampaign) {
      return {
        action: "failed",
        failureReason: `Phone number is assigned to a different campaign (${ids.join(", ")})`,
        rawPayload: assignment,
      };
    }

    if (assignment.assignmentStatus === "ASSIGNED" && assignedToSameCampaign) {
      return { action: "assigned", rawPayload: assignment };
    }

    if (
      assignment.assignmentStatus === "PENDING_ASSIGNMENT" &&
      assignedToSameCampaign
    ) {
      return { action: "pending", rawPayload: assignment };
    }

    if (
      assignment.assignmentStatus === "FAILED_ASSIGNMENT" &&
      assignedToSameCampaign
    ) {
      return {
        action: "failed",
        failureReason:
          assignment.failureReasons || "Telnyx reported failed assignment",
        rawPayload: assignment,
      };
    }

    if (assignedToSameCampaign) {
      return {
        action: "failed",
        failureReason: `Unexpected Telnyx assignment status: ${assignment.assignmentStatus ?? "unknown"}`,
        rawPayload: assignment,
      };
    }

    return { action: "needs_assignment", rawPayload: assignment };
  } catch (err) {
    if (getErrorStatus(err) === 404) {
      return { action: "needs_assignment" };
    }
    throw err;
  }
}

function assignmentCampaignIds(assignment: {
  campaignId?: string;
  telnyxCampaignId?: string;
  tcrCampaignId?: string;
}): string[] {
  return [
    assignment.campaignId,
    assignment.telnyxCampaignId,
    assignment.tcrCampaignId,
  ].filter((id): id is string => Boolean(id));
}

async function claimBusinessProfileAssignment(
  business: AssignmentBusinessRow
): Promise<AssignmentBusinessRow | null> {
  const claimToken = randomUUID();
  const claimedAt = new Date().toISOString();
  const staleBefore = new Date(
    Date.now() - ASSIGNMENT_INTENT_LEASE_MS
  ).toISOString();

  const { data, error } = await supabaseAdmin
    .from("businesses")
    .update({
      telnyx_campaign_assignment_claim_token: claimToken,
      telnyx_campaign_assignment_claimed_at: claimedAt,
      telnyx_campaign_assignment_claim_campaign_id:
        business.telnyx_campaign_id,
      telnyx_campaign_assignment_claim_profile_id:
        business.telnyx_messaging_profile_id,
    })
    .eq("id", business.id)
    .eq("updated_at", business.updated_at)
    .eq("telnyx_brand_id", business.telnyx_brand_id)
    .eq("telnyx_campaign_id", business.telnyx_campaign_id)
    .eq("telnyx_messaging_profile_id", business.telnyx_messaging_profile_id)
    .eq("campaign_status", "approved")
    .eq("brand_status", "approved")
    .eq("telnyx_submission_disabled", false)
    .is("deleted_at", null)
    .is("operations_suspended_at", null)
    .is("telnyx_unique_claims_released_at", null)
    .is("active_telnyx_release_run_id", null)
    .eq("telnyx_resource_state", business.telnyx_resource_state)
    .or(
      `telnyx_campaign_assignment_claim_token.is.null,telnyx_campaign_assignment_claimed_at.lt.${staleBefore}`
    )
    .select(ASSIGNMENT_BUSINESS_SELECT)
    .maybeSingle<AssignmentBusinessRow>();

  if (error) {
    throw new Error(
      `[assignment] Failed to claim profile assignment for business ${business.id}: ${error.message}`
    );
  }
  return data ?? null;
}

async function releaseBusinessProfileAssignmentClaim(
  business: AssignmentBusinessRow
): Promise<void> {
  const claimToken = business.telnyx_campaign_assignment_claim_token;
  if (!claimToken) return;

  const { error } = await supabaseAdmin
    .from("businesses")
    .update({
      telnyx_campaign_assignment_claim_token: null,
      telnyx_campaign_assignment_claimed_at: null,
      telnyx_campaign_assignment_claim_campaign_id: null,
      telnyx_campaign_assignment_claim_profile_id: null,
    })
    .eq("id", business.id)
    .eq("telnyx_campaign_assignment_claim_token", claimToken)
    .eq(
      "telnyx_campaign_assignment_claim_campaign_id",
      business.telnyx_campaign_id
    )
    .eq(
      "telnyx_campaign_assignment_claim_profile_id",
      business.telnyx_messaging_profile_id
    );

  if (error) {
    console.error(
      `[assignment] Failed to release profile assignment claim for business ${business.id}:`,
      error
    );
  }
}

async function renewBusinessProfileAssignmentClaim(
  lease: AssignmentLease
): Promise<boolean> {
  const business = lease.business;
  const { data, error } = await supabaseAdmin
    .from("businesses")
    .update({
      telnyx_campaign_assignment_claimed_at: new Date().toISOString(),
    })
    .eq("id", business.id)
    .eq("telnyx_brand_id", business.telnyx_brand_id)
    .eq("telnyx_campaign_id", business.telnyx_campaign_id)
    .eq("telnyx_messaging_profile_id", business.telnyx_messaging_profile_id)
    .eq("campaign_status", "approved")
    .eq("brand_status", "approved")
    .eq("telnyx_submission_disabled", false)
    .is("deleted_at", null)
    .is("operations_suspended_at", null)
    .is("telnyx_unique_claims_released_at", null)
    .is("active_telnyx_release_run_id", null)
    .eq("telnyx_resource_state", business.telnyx_resource_state)
    .eq(
      "telnyx_campaign_assignment_claim_token",
      business.telnyx_campaign_assignment_claim_token
    )
    .eq(
      "telnyx_campaign_assignment_claim_campaign_id",
      business.telnyx_campaign_id
    )
    .eq(
      "telnyx_campaign_assignment_claim_profile_id",
      business.telnyx_messaging_profile_id
    )
    .select(ASSIGNMENT_BUSINESS_SELECT)
    .maybeSingle<AssignmentBusinessRow>();

  if (error) {
    throw new Error(
      `[assignment] Failed to renew assignment claim for business ${business.id}: ${error.message}`
    );
  }
  if (
    !data ||
    !data.telnyx_campaign_id ||
    !data.telnyx_messaging_profile_id ||
    !data.telnyx_campaign_assignment_claim_token
  ) {
    return false;
  }

  lease.business = data as AssignmentLease["business"];
  return true;
}

async function claimPhoneAssignment(
  row: AssignmentPhoneNumberRow,
  campaignId: string
): Promise<PhoneAssignmentClaim | null> {
  const claimedAt = new Date().toISOString();
  let query = supabaseAdmin
    .from("phone_numbers")
    .update({
      telnyx_campaign_assignment_status: "pending",
      telnyx_campaign_assignment_task_id:
        row.telnyx_campaign_assignment_task_id,
      telnyx_campaign_assignment_campaign_id: campaignId,
      telnyx_campaign_assignment_failure_reason: null,
      telnyx_campaign_assignment_updated_at: claimedAt,
      telnyx_campaign_assigned_at: null,
    })
    .eq("id", row.id)
    .eq("business_id", row.business_id)
    .eq("phone_number", row.phone_number)
    .eq("is_active", true)
    .eq("resource_status", "active")
    .eq(
      "telnyx_campaign_assignment_status",
      row.telnyx_campaign_assignment_status
    );

  query =
    row.telnyx_campaign_assignment_campaign_id === null
      ? query.is("telnyx_campaign_assignment_campaign_id", null)
      : query.eq(
          "telnyx_campaign_assignment_campaign_id",
          row.telnyx_campaign_assignment_campaign_id
        );
  query =
    row.telnyx_campaign_assignment_task_id === null
      ? query.is("telnyx_campaign_assignment_task_id", null)
      : query.eq(
          "telnyx_campaign_assignment_task_id",
          row.telnyx_campaign_assignment_task_id
        );
  query =
    row.telnyx_campaign_assignment_updated_at === null
      ? query.is("telnyx_campaign_assignment_updated_at", null)
      : query.eq(
          "telnyx_campaign_assignment_updated_at",
          row.telnyx_campaign_assignment_updated_at
        );

  const { data, error } = await query
    .select("id")
    .maybeSingle<{ id: string }>();
  if (error) {
    throw new Error(
      `[assignment] Failed to claim phone number ${row.phone_number}: ${error.message}`
    );
  }
  return data ? { row, claimedAt, campaignId } : null;
}

async function releasePhoneAssignmentClaim(
  claim: PhoneAssignmentClaim
): Promise<void> {
  const row = claim.row;
  let query = supabaseAdmin
    .from("phone_numbers")
    .update({
      telnyx_campaign_assignment_status:
        row.telnyx_campaign_assignment_status,
      telnyx_campaign_assignment_task_id:
        row.telnyx_campaign_assignment_task_id,
      telnyx_campaign_assignment_campaign_id:
        row.telnyx_campaign_assignment_campaign_id,
      telnyx_campaign_assignment_failure_reason:
        row.telnyx_campaign_assignment_failure_reason,
      telnyx_campaign_assignment_updated_at:
        row.telnyx_campaign_assignment_updated_at,
      telnyx_campaign_assigned_at: row.telnyx_campaign_assigned_at,
    })
    .eq("id", row.id)
    .eq("business_id", row.business_id)
    .eq("phone_number", row.phone_number)
    .eq("is_active", true)
    .eq("resource_status", "active")
    .eq("telnyx_campaign_assignment_status", "pending")
    .eq("telnyx_campaign_assignment_campaign_id", claim.campaignId)
    .eq("telnyx_campaign_assignment_updated_at", claim.claimedAt);

  query =
    row.telnyx_campaign_assignment_task_id === null
      ? query.is("telnyx_campaign_assignment_task_id", null)
      : query.eq(
          "telnyx_campaign_assignment_task_id",
          row.telnyx_campaign_assignment_task_id
        );

  const { error } = await query;
  if (error) {
    console.error(
      `[assignment] Failed to release local intent claim for ${row.phone_number}:`,
      error
    );
  }
}

async function finalizeClaimedNumberAssignment(
  claim: PhoneAssignmentClaim,
  updates: {
    status: CampaignAssignmentStatus;
    campaignId: string;
    taskId: string | null;
    failureReason: string | null;
  }
): Promise<void> {
  const row = claim.row;
  const now = new Date().toISOString();
  const update: Record<string, unknown> = {
    telnyx_campaign_assignment_status: updates.status,
    telnyx_campaign_assignment_task_id: updates.taskId,
    telnyx_campaign_assignment_campaign_id: updates.campaignId,
    telnyx_campaign_assignment_failure_reason: updates.failureReason,
    telnyx_campaign_assignment_updated_at: now,
    telnyx_campaign_assigned_at:
      updates.status === "assigned" ? now : null,
  };

  let query = supabaseAdmin
    .from("phone_numbers")
    .update(update)
    .eq("id", row.id)
    .eq("business_id", row.business_id)
    .eq("phone_number", row.phone_number)
    .eq("is_active", true)
    .eq("resource_status", "active")
    .eq("telnyx_campaign_assignment_status", "pending")
    .eq("telnyx_campaign_assignment_campaign_id", claim.campaignId)
    .eq("telnyx_campaign_assignment_updated_at", claim.claimedAt);

  query =
    row.telnyx_campaign_assignment_task_id === null
      ? query.is("telnyx_campaign_assignment_task_id", null)
      : query.eq(
          "telnyx_campaign_assignment_task_id",
          row.telnyx_campaign_assignment_task_id
        );

  const { data, error } = await query
    .select("id")
    .maybeSingle<{ id: string }>();

  if (error) {
    throw new Error(
      `[assignment] Failed to finalize ${row.phone_number}: ${error.message}`
    );
  }
  if (!data) {
    throw new Error(
      `[assignment] Lost intent ownership before finalizing ${row.phone_number}`
    );
  }
}

async function auditAssignmentStatus(args: {
  businessId: string;
  phoneNumber: string;
  status: string;
  reason: string;
  rawPayload: unknown;
}): Promise<void> {
  await appendRegistrationEvent({
    businessId: args.businessId,
    eventType: "phone_number_assignment_status_changed",
    resourceType: "phone_number_assignment",
    resourceId: args.phoneNumber,
    status: args.status,
    rawPayload: {
      reason: args.reason,
      response: args.rawPayload,
    },
  });
}

async function auditAssignmentFailure(args: {
  businessId: string;
  phoneNumber: string;
  status: string;
  reason: string;
  rawPayload: unknown;
  failureReason: string;
}): Promise<void> {
  await appendRegistrationEvent({
    businessId: args.businessId,
    eventType: "phone_number_assignment_failed",
    resourceType: "phone_number_assignment",
    resourceId: args.phoneNumber,
    status: args.status,
    rejectionReason: args.failureReason,
    rawPayload: {
      reason: args.reason,
      response: args.rawPayload,
    },
  });
}

function getErrorStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const obj = err as {
    status?: number;
    statusCode?: number;
    response?: { status?: number };
  };
  return obj.status ?? obj.statusCode ?? obj.response?.status ?? null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  const serialized = serializeError(err);
  const message = serialized.message;
  return typeof message === "string" ? message : String(err);
}
