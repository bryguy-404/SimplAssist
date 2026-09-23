import "server-only";

import { supabaseAdmin } from "@/lib/supabase/admin";
import { telnyx } from "@/lib/messaging/client";
import { appendRegistrationEventOrThrow } from "@/lib/messaging/registration/audit";
import {
  applyObservedCampaignStatus,
  getCampaignAssignmentSafetyBlock,
  type CampaignStatusSnapshot,
} from "@/lib/messaging/registration/campaignStatusTransition";
import { mapBrandStatus, mapCampaignStatus, extractRejectionReason } from "@/lib/messaging/registration/statusMapper";
import { hasCarrierRejection, REJECTION_SUPPORT_MESSAGE } from "@/lib/onboarding/rejectionGuidance";
import { canContinueTextingUpgradeProvisioning, readPendingPaidTextingUpgrade } from "./textingUpgradeActivation.server";

const SNAPSHOT_SELECT = [
  "id", "owner_id", "updated_at", "deleted_at", "telnyx_unique_claims_released_at",
  "active_telnyx_release_run_id", "telnyx_resource_state", "telnyx_submission_disabled",
  "telnyx_brand_id", "telnyx_campaign_id", "telnyx_messaging_profile_id", "brand_status",
  "campaign_status", "campaign_status_updated_at", "campaign_rejection_reason",
  "onboarding_registration_status", "onboarding_registration_submitted_at", "onboarding_registration_error",
  "telnyx_campaign_assignment_claim_token", "telnyx_campaign_assignment_claimed_at",
].join(",");
const READ_OPTIONS = { maxRetries: 0, timeout: 10_000 };

async function readSnapshot(businessId: string): Promise<CampaignStatusSnapshot> {
  const { data, error } = await supabaseAdmin.from("businesses")
    .select(SNAPSHOT_SELECT).eq("id", businessId).maybeSingle<CampaignStatusSnapshot>();
  if (error || !data || data.id !== businessId) throw new Error("texting_upgrade_carrier_state_unavailable");
  return data;
}

/** Explicit POST/worker recovery only; never invoked by the upgrade state GET. */
export async function refreshTextingUpgradeCarrierStatus(businessId: string): Promise<{ refreshed: boolean }> {
  const upgrade = await readPendingPaidTextingUpgrade(businessId);
  if (!upgrade || upgrade.state !== "carrier_pending" || !(await canContinueTextingUpgradeProvisioning(businessId))) {
    return { refreshed: false };
  }
  let snapshot = await readSnapshot(businessId);
  if (hasCarrierRejection(snapshot.brand_status, snapshot.campaign_status) ||
      snapshot.onboarding_registration_status === "submitting" || !snapshot.telnyx_brand_id) {
    return { refreshed: false };
  }

  let refreshed = false;
  // A missed brand callback must not strand an otherwise approved campaign.
  // Retrieve only the exact already-owned brand; never create or replace it.
  if (snapshot.brand_status !== "approved") {
    const brand = await telnyx.messaging10dlc.brand.retrieve(snapshot.telnyx_brand_id, READ_OPTIONS);
    if (brand.brandId !== snapshot.telnyx_brand_id) throw new Error("texting_upgrade_brand_identity_mismatch");
    const mapped = mapBrandStatus(brand);
    if (mapped.dbStatus) {
      const reason = mapped.dbStatus === "rejected" ? extractRejectionReason(brand as unknown as Record<string, unknown>) : null;
      const observedAt = new Date().toISOString();
      await appendRegistrationEventOrThrow({
        businessId, eventType: "brand_status_changed", resourceType: "brand",
        resourceId: snapshot.telnyx_brand_id, status: "reconcile_started",
        rawPayload: { source: "texting_upgrade_refresh", observedStatus: mapped.dbStatus },
      });
      let query = supabaseAdmin.from("businesses").update({
        brand_status: mapped.dbStatus, brand_status_updated_at: observedAt, brand_rejection_reason: reason,
        ...(mapped.dbStatus === "rejected" ? {
          onboarding_registration_status: "failed", onboarding_registration_submitted_at: null,
          onboarding_registration_error: reason ?? REJECTION_SUPPORT_MESSAGE,
        } : {}),
      }).eq("id", businessId).eq("owner_id", snapshot.owner_id).eq("updated_at", snapshot.updated_at)
        .eq("telnyx_brand_id", snapshot.telnyx_brand_id).is("deleted_at", null)
        .is("operations_suspended_at", null).is("active_telnyx_release_run_id", null)
        .is("telnyx_unique_claims_released_at", null).eq("telnyx_submission_disabled", false)
        .eq("telnyx_resource_state", snapshot.telnyx_resource_state);
      query = snapshot.brand_status === null ? query.is("brand_status", null) : query.eq("brand_status", snapshot.brand_status);
      const { data, error } = await query.select("id").maybeSingle();
      if (error || !data) throw new Error("texting_upgrade_brand_state_changed");
      refreshed = true;
      await appendRegistrationEventOrThrow({
        businessId, eventType: "brand_status_changed", resourceType: "brand",
        resourceId: snapshot.telnyx_brand_id, status: mapped.dbStatus, rejectionReason: reason,
        rawPayload: { source: "texting_upgrade_refresh" },
      });
      if (mapped.dbStatus === "rejected") return { refreshed };
      snapshot = await readSnapshot(businessId);
    }
  }

  if (getCampaignAssignmentSafetyBlock(snapshot) || hasCarrierRejection(snapshot.brand_status, snapshot.campaign_status)) {
    return { refreshed };
  }
  if (!(await canContinueTextingUpgradeProvisioning(businessId))) return { refreshed };
  const campaign = await telnyx.messaging10dlc.campaign.retrieve(snapshot.telnyx_campaign_id!, READ_OPTIONS);
  if (campaign.campaignId !== snapshot.telnyx_campaign_id || campaign.brandId !== snapshot.telnyx_brand_id) {
    throw new Error("texting_upgrade_campaign_identity_mismatch");
  }
  const mapped = mapCampaignStatus(campaign);
  if (!mapped.dbStatus) return { refreshed };
  const rejectionReason = mapped.dbStatus === "rejected"
    ? extractRejectionReason(campaign as unknown as Record<string, unknown>) : null;
  await appendRegistrationEventOrThrow({
    businessId, eventType: "campaign_status_refreshed", resourceType: "campaign",
    resourceId: snapshot.telnyx_campaign_id, status: "reconcile_started",
    rawPayload: { source: "texting_upgrade_refresh", observedStatus: mapped.dbStatus },
  });
  const transition = await applyObservedCampaignStatus({
    snapshot, newStatus: mapped.dbStatus, rejectionReason,
    observedAt: new Date().toISOString(), enforceAssignmentSafety: true, touchIfUnchanged: true,
  });
  if (transition.outcome === "conflict") throw new Error("texting_upgrade_campaign_state_changed");
  if (transition.outcome === "applied") {
    refreshed = true;
    await appendRegistrationEventOrThrow({
      businessId, eventType: "campaign_status_refreshed", resourceType: "campaign",
      resourceId: snapshot.telnyx_campaign_id, status: mapped.dbStatus, rejectionReason,
      rawPayload: { source: "texting_upgrade_refresh" },
    });
  }
  return { refreshed };
}
