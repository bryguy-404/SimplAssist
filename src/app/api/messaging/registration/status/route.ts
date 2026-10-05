import { NextRequest, NextResponse } from "next/server";
import { telnyx } from "@/lib/messaging/client";
import {
  markProcessedOnce,
  releaseProcessedEvent,
} from "@/lib/messaging/idempotency";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  appendRegistrationEvent,
  serializeError,
} from "@/lib/messaging/registration/audit";
import { ensureCampaignAssignmentForBusiness } from "@/lib/messaging/registration/phoneNumberAssignment";
import {
  applyObservedCampaignStatus,
  type CampaignTransitionOutcome,
  type CampaignStatusSnapshot,
} from "@/lib/messaging/registration/campaignStatusTransition";
import {
  extractRejectionReason,
  mapBrandStatus,
  mapCampaignStatus,
  type MappedStatus,
} from "@/lib/messaging/registration/statusMapper";
import {
  dedupeRecipients,
  sendBrandApprovedEmail,
  sendBrandRejectedEmail,
  sendCampaignApprovedEmail,
  sendCampaignRejectedEmail,
} from "@/lib/email/registrationStatus";
import { REJECTION_SUPPORT_MESSAGE } from "@/lib/onboarding/rejectionGuidance";
import type { RegistrationStatus } from "@/types/database";
import { handleSharedBrandEvent } from "@/lib/messaging/sharedBrandEvents.server";

// Telnyx 10DLC brand/campaign status webhook receiver. Phase 3 wires this URL
// into every brand and campaign it creates; Phase 4 (this file) updates the
// businesses row and emails the owner on terminal state changes.
//
// Invariants (mirror the messaging webhook):
// - Verify Ed25519 signature first; 403 on failure.
// - Deliberate-ack paths (duplicate, no resource id, genuine not-found —
//   the archived/foreign-resource zombie guard) return 200 and keep the
//   idempotency claim: a retry could never succeed for them.
// - PROCESSING FAILURES (DB errors in lookup or transition) release the
//   idempotency claim and return 500 so Telnyx's retry redelivers
//   (record-and-let-retry). Recovery holds UNLESS a timeout-triggered
//   duplicate already acked the event during the failing attempt's window —
//   see the honest-limits note in @/lib/messaging/idempotency. Loss shrinks
//   from "every failure" to that race; the §5 schema extension closes it.
// - Status-transition guard via conditional UPDATE: race-safe against
//   simultaneous webhook deliveries (no SELECT-then-UPDATE TOCTOU window),
//   and it makes retries idempotent: a retry after a mid-flight failure
//   no-ops the already-applied transition. Approval retries still run the
//   idempotent assignment helper so a crash after the status write cannot
//   strand an unassigned number; emails remain status-change-only.
// - Email is fire-and-forget; never blocks the response, never throws.
// - Once business is resolved, every code path audits — including
//   BRAND_OTP_VERIFIED (Phase 11 placeholder) and post-lookup errors.
//
// Audit coverage gap (irreducible without schema change):
// Events without a resource ID (brandId/campaignId) cannot be audited due to
// the NOT NULL business_id constraint on telnyx_registration_events. These
// get console.warn only. Consider a separate orphaned_webhook_events table or
// nullable business_id in a future phase if this becomes a debugging blocker.
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => {
    headers[k] = v;
  });

  let event: unknown;
  try {
    event = await telnyx.webhooks.unwrap(rawBody, { headers });
  } catch (err) {
    console.warn("[registration:webhook] Signature verification failed:", err);
    return new NextResponse("Forbidden", { status: 403 });
  }

  try {
    await handleEvent(event);
  } catch (err) {
    // The claim was released inside handleEvent (or its release threw, in
    // which case the row dead-letters until the reaper — same residual as
    // a crash). Non-2xx makes Telnyx redeliver and reprocess.
    console.error("[registration:webhook] Handler error:", err);
    return new NextResponse("Handler Error", { status: 500 });
  }
  return new NextResponse("OK", { status: 200 });
}

async function handleEvent(event: unknown): Promise<void> {
  if (await handleSharedBrandEvent(event)) return;
  const eventData = (event as {
    data?: {
      id?: string;
      event_type?: string;
      occurred_at?: string;
      payload?: unknown;
    };
  }).data;
  const eventId = eventData?.id;
  const eventType = eventData?.event_type;
  console.log(
    `[registration:webhook] event_type=${eventType} event_id=${eventId}`
  );

  if (eventId) {
    const isFirstTime = await markProcessedOnce(eventId);
    if (!isFirstTime) {
      console.log(
        `[registration:webhook] Idempotency: event ${eventId} already processed, skipping`
      );
      return;
    }
  } else {
    console.warn(
      "[registration:webhook] Missing event.data.id, skipping idempotency check"
    );
  }

  try {
    await processClaimedEvent(event, eventData);
  } catch (err) {
    // Release our claim so Telnyx's retry re-inserts and reprocesses. If the
    // release itself throws, the row stays claimed (dead-letter until the
    // reaper follow-up) and we still propagate for the 500.
    if (eventId) {
      await releaseProcessedEvent(eventId);
    }
    throw err;
  }
}

async function processClaimedEvent(
  event: unknown,
  eventData:
    | {
        id?: string;
        event_type?: string;
        occurred_at?: string;
        payload?: unknown;
      }
    | undefined
): Promise<void> {
  const eventType = eventData?.event_type;
  const payload = (eventData?.payload ?? {}) as Record<string, unknown>;
  const innerEventType = pickString(payload, ["eventType", "event_type"]);
  const isOtpEvent =
    eventType === "BRAND_OTP_VERIFIED" || innerEventType === "BRAND_OTP_VERIFIED";

  const brandId = pickString(payload, ["brandId", "brand_id", "tcrBrandId"]);
  const campaignId = pickString(payload, [
    "campaignId",
    "campaign_id",
    "tcrCampaignId",
  ]);

  let kind: "brand" | "campaign";
  let resourceId: string;
  if (campaignId) {
    kind = "campaign";
    resourceId = campaignId;
  } else if (brandId) {
    kind = "brand";
    resourceId = brandId;
  } else {
    // Irreducible audit gap: no resource id means we have no way to find a
    // business_id, and the audit table requires one. See top-of-file comment.
    console.warn(
      "[registration:webhook] cannot identify resource; payload keys=",
      Object.keys(payload)
    );
    return;
  }

  if (kind === "campaign" && await reconcileReviewTextingCampaignEvent(resourceId)) return;
  const business = await lookupBusiness(kind, resourceId);
  if (!business) {
    // Same constraint as above: no business_id → cannot audit.
    console.warn(
      `[registration:webhook] no business found for ${kind} id=${resourceId}`
    );
    return;
  }

  const auditEventType =
    kind === "brand" ? "brand_status_changed" : "campaign_status_changed";

  // From here on, every exit path audits.
  try {
    if (isOtpEvent) {
      // Phase 11 territory (Sole Proprietor SMS OTP). Audit + return so the
      // event isn't lost to console-only logging.
      console.log(
        "[registration:webhook] BRAND_OTP_VERIFIED — Phase 11 will own this; auditing and skipping"
      );
      await appendRegistrationEvent({
        businessId: business.id,
        eventType: auditEventType,
        resourceType: kind,
        resourceId,
        status: "audit_only_phase_11_otp",
        rawPayload: event as Record<string, unknown>,
      });
      return;
    }

    if (kind === "campaign" && eventType !== "10dlc.campaign.update") {
      await appendRegistrationEvent({
        businessId: business.id,
        eventType: auditEventType,
        resourceType: kind,
        resourceId,
        status: "audit_only_unexpected_event_type",
        rawPayload: event as Record<string, unknown>,
      });
      return;
    }

    if (
      kind === "campaign" &&
      (!brandId || brandId !== business.telnyx_brand_id)
    ) {
      await appendRegistrationEvent({
        businessId: business.id,
        eventType: auditEventType,
        resourceType: kind,
        resourceId,
        status: "audit_only_identity_mismatch",
        rawPayload: event as Record<string, unknown>,
      });
      return;
    }

    const campaignObservedAt =
      kind === "campaign"
        ? eventOccurredAt(eventData?.occurred_at)
        : null;
    if (kind === "campaign" && !campaignObservedAt) {
      await appendRegistrationEvent({
        businessId: business.id,
        eventType: auditEventType,
        resourceType: kind,
        resourceId,
        status: "audit_only_invalid_occurred_at",
        rawPayload: event as Record<string, unknown>,
      });
      return;
    }

    const mapped: MappedStatus =
      kind === "brand"
        ? mapBrandStatus({
            identityStatus: pickString(payload, [
              "brandIdentityStatus",
              "brand_identity_status",
              "identityStatus",
              "identity_status",
            ]),
            status: pickString(payload, ["status"]),
          })
        : mapCampaignStatus({
            campaignStatus: pickString(payload, [
              "campaignStatus",
              "campaign_status",
            ]),
            submissionStatus: pickString(payload, [
              "submissionStatus",
              "submission_status",
            ]),
            status: pickString(payload, ["status"]),
            notificationType: pickString(payload, ["type"]),
          });

    const rejectionReason =
      mapped.dbStatus === "rejected" ? extractRejectionReason(payload) : null;

    let statusChanged = false;
    let campaignTransition: CampaignTransitionOutcome | null = null;
    if (mapped.dbStatus !== null) {
      if (kind === "campaign") {
        campaignTransition = await applyObservedCampaignStatus({
          snapshot: business,
          newStatus: mapped.dbStatus,
          rejectionReason,
          observedAt: campaignObservedAt!,
          touchIfUnchanged: true,
        });
        if (campaignTransition.outcome === "conflict") {
          throw new Error(
            `[registration:webhook] Campaign transition conflicted for business ${business.id}`
          );
        }
        statusChanged =
          campaignTransition.outcome === "applied" &&
          campaignTransition.statusChanged;
      } else {
        statusChanged = await applyBrandStatusTransition({
          businessId: business.id,
          newStatus: mapped.dbStatus,
          rejectionReason,
        });
      }
    }

    await appendRegistrationEvent({
      businessId: business.id,
      eventType: auditEventType,
      resourceType: kind,
      resourceId,
      status:
        mapped.dbStatus ?? pickString(payload, ["status", "campaignStatus"]),
      rejectionReason,
      rawPayload: event as Record<string, unknown>,
    });

    if (
      kind === "campaign" &&
      mapped.dbStatus === "approved" &&
      campaignTransition !== null &&
      campaignTransition.outcome !== "stale"
    ) {
      try {
        await ensureCampaignAssignmentForBusiness(business.id, {
          force: statusChanged,
          reason: "campaign_approved_webhook",
        });
      } catch (err) {
        console.error(
          `[registration:webhook] campaign assignment start failed for business ${business.id}:`,
          err
        );
        throw err;
      }
    }

    if (mapped.isTerminal && statusChanged) {
      dispatchStatusEmail({
        kind,
        newStatus: mapped.dbStatus!,
        businessId: business.id,
        businessName: business.name,
        authorizedRepEmail: business.authorized_rep_email,
        ownerId: business.owner_id,
        rejectionReason,
      }).catch((err) =>
        console.error("[registration:webhook] email dispatch error:", err)
      );
    }
  } catch (err) {
    console.error(
      `[registration:webhook] post-lookup error for business ${business.id}:`,
      err
    );
    try {
      await appendRegistrationEvent({
        businessId: business.id,
        eventType: auditEventType,
        resourceType: kind,
        resourceId,
        status: "error",
        rawPayload: serializeError(err),
      });
    } catch (auditErr) {
      console.error(
        "[registration:webhook] error-audit append failed:",
        auditErr
      );
    }
    // Rethrow so the claim is released and the response is 500; the retry
    // performs the work. (The error-audit above is BEST-EFFORT only —
    // appendRegistrationEvent swallows its own DB errors by design and
    // never throws, so an audit-write failure cannot itself trigger this
    // path.)
    throw err;
  }
}

interface BusinessRow extends CampaignStatusSnapshot {
  name: string;
  authorized_rep_email: string | null;
}

async function lookupBusiness(
  kind: "brand" | "campaign",
  resourceId: string
): Promise<BusinessRow | null> {
  const column = kind === "brand" ? "telnyx_brand_id" : "telnyx_campaign_id";
  const { data, error } = await supabaseAdmin
    .from("businesses")
    .select(
      [
        "id",
        "name",
        "owner_id",
        "authorized_rep_email",
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
      ].join(", ")
    )
    .eq(column, resourceId)
    // Terminal-cleanup tombstones may retain provider IDs for audit while
    // relinquishing their uniqueness claims. Late carrier events must never
    // resolve either a deleted account or a tombstone whose claims were
    // explicitly released.
    .is("deleted_at", null)
    .is("telnyx_unique_claims_released_at", null)
    .maybeSingle();

  if (error) {
    // Throw — never return null on a DB error: null means "genuinely no
    // business for this resource id" (the archived/foreign-resource zombie
    // guard, acked 200). Collapsing a transient error into not-found would
    // permanently drop a terminal transition; throwing releases the claim
    // and 500s so Telnyx retries.
    throw new Error(
      `[registration:webhook] lookup failed for ${column}=${resourceId}: ${error.message}`
    );
  }
  return data as BusinessRow | null;
}

// Brand transitions retain the existing status-only conditional update. The
// campaign path uses applyObservedCampaignStatus above because campaign
// approval also repairs stale onboarding rejection state and orders provider
// observations.
async function applyBrandStatusTransition(args: {
  businessId: string;
  newStatus: RegistrationStatus;
  rejectionReason: string | null;
}): Promise<boolean> {
  const now = new Date().toISOString();
  const update = {
    brand_status: args.newStatus,
    brand_status_updated_at: now,
    brand_rejection_reason: args.rejectionReason,
    ...(args.newStatus === "rejected"
      ? {
          onboarding_registration_status: "failed" as const,
          onboarding_registration_submitted_at: null,
          onboarding_registration_error:
            args.rejectionReason ?? REJECTION_SUPPORT_MESSAGE,
        }
      : {}),
  };
  const guard = `brand_status.is.null,brand_status.neq.${args.newStatus}`;

  const { data, error } = await supabaseAdmin
    .from("businesses")
    .update(update)
    .eq("id", args.businessId)
    .or(guard)
    .select("id");

  if (error) {
    // Throw — a swallowed conditional-update error loses the transition
    // while the event is already consumed. False is reserved for "status
    // already equals the new value" (the idempotent-retry no-op).
    throw new Error(
      `[registration:webhook] conditional update failed for business ${args.businessId}: ${error.message}`
    );
  }
  return Array.isArray(data) && data.length > 0;
}

function eventOccurredAt(value: string | null | undefined): string | null {
  if (value && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return null;
}

async function dispatchStatusEmail(args: {
  kind: "brand" | "campaign";
  newStatus: RegistrationStatus;
  businessId: string;
  businessName: string;
  authorizedRepEmail: string | null;
  ownerId: string;
  rejectionReason: string | null;
}): Promise<void> {
  const ownerEmail = await resolveOwnerEmail(args.ownerId);
  const recipients = dedupeRecipients([args.authorizedRepEmail, ownerEmail]);

  if (recipients.length === 0) {
    console.warn(
      `[registration:webhook] no recipients for business ${args.businessId}; skipping email`
    );
    return;
  }

  if (args.kind === "brand" && args.newStatus === "approved") {
    await sendBrandApprovedEmail({
      businessId: args.businessId,
      businessName: args.businessName,
      recipients,
    });
  } else if (args.kind === "brand" && args.newStatus === "rejected") {
    await sendBrandRejectedEmail({
      businessId: args.businessId,
      businessName: args.businessName,
      rejectionReason: args.rejectionReason,
      recipients,
    });
  } else if (args.kind === "campaign" && args.newStatus === "approved") {
    await sendCampaignApprovedEmail({
      businessId: args.businessId,
      businessName: args.businessName,
      recipients,
    });
  } else if (args.kind === "campaign" && args.newStatus === "rejected") {
    await sendCampaignRejectedEmail({
      businessId: args.businessId,
      businessName: args.businessName,
      rejectionReason: args.rejectionReason,
      recipients,
    });
  }
}

async function resolveOwnerEmail(ownerId: string): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(ownerId);
    if (error) {
      console.warn(
        `[registration:webhook] auth.admin.getUserById failed for ${ownerId}:`,
        error
      );
      return null;
    }
    return data.user?.email ?? null;
  } catch (err) {
    console.warn(
      `[registration:webhook] auth.admin.getUserById threw for ${ownerId}:`,
      err
    );
    return null;
  }
}

function pickString(
  obj: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}
import { reconcileReviewTextingCampaignEvent } from "@/lib/billing/reviewTextingHandoff.server";
