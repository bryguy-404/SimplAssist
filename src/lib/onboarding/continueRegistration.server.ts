import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { telnyx } from "@/lib/messaging/client";
import { attemptPaidLaunch } from "@/lib/billing/launch";
import { extractRejectionReason, mapBrandStatus } from "@/lib/messaging/registration/statusMapper";
import { REJECTION_SUPPORT_MESSAGE } from "./rejectionGuidance";

const COLUMNS = "id,telnyx_brand_id,brand_status,onboarding_last_saved_at,onboarding_registration_status";
type PendingRegistration = {
  id: string; telnyx_brand_id: string; brand_status: string | null;
  onboarding_last_saved_at: string | null;
  onboarding_registration_status: "submitted" | "submitting";
};

function pendingQuery() {
  const stale = new Date(Date.now() - 15 * 60_000).toISOString();
  return supabaseAdmin.from("businesses").select(COLUMNS)
    .or(`onboarding_registration_status.eq.submitted,and(onboarding_registration_status.eq.submitting,or(onboarding_registration_started_at.is.null,onboarding_registration_started_at.lt.${stale}))`)
    .not("telnyx_brand_id", "is", null).is("telnyx_campaign_id", null)
    .is("onboarding_registration_error", null).is("deleted_at", null)
    .is("operations_suspended_at", null).eq("telnyx_submission_disabled", false)
    .is("telnyx_unique_claims_released_at", null).is("active_telnyx_release_run_id", null)
    .in("telnyx_resource_state", ["provisioning", "active"])
    .or("brand_status.is.null,brand_status.neq.rejected")
    .or("campaign_status.is.null,campaign_status.neq.rejected");
}

/** Webhook retries are safe: paid launch rechecks authorization and claims once. */
export async function continuePendingBrandRegistration(businessId: string) {
  const { data, error } = await pendingQuery().eq("id", businessId).maybeSingle<PendingRegistration>();
  if (error) throw new Error("pending_registration_lookup_failed");
  if (!data || data.brand_status !== "approved") return;
  return attemptPaidLaunch(businessId, "registration_continuation");
}

/** Durable saved IDs are the work queue. Never automatically retry failed rows. */
export async function reconcilePendingBrandRegistrations() {
  const before = new Date(Date.now() - 60_000).toISOString();
  const { data, error } = await pendingQuery()
    .or(`onboarding_last_saved_at.is.null,onboarding_last_saved_at.lt.${before}`)
    .order("onboarding_last_saved_at", { ascending: true, nullsFirst: true }).limit(3);
  if (error) throw new Error("pending_registrations_unavailable");
  let checked = 0;
  let failed = 0;
  for (const row of (data ?? []) as PendingRegistration[]) {
    try {
      // A CAS heartbeat gives concurrent sweeps one inspector and rotates rows
      // fairly, including accounts whose billing/operational gates now block.
      let claim = supabaseAdmin.from("businesses")
        .update({ onboarding_last_saved_at: new Date().toISOString() })
        .eq("id", row.id).eq("telnyx_brand_id", row.telnyx_brand_id)
        .is("telnyx_campaign_id", null).eq("onboarding_registration_status", row.onboarding_registration_status)
        .is("onboarding_registration_error", null).is("deleted_at", null);
      claim = row.onboarding_last_saved_at === null
        ? claim.is("onboarding_last_saved_at", null)
        : claim.eq("onboarding_last_saved_at", row.onboarding_last_saved_at);
      const claimed = await claim.select("id").maybeSingle();
      if (claimed.error) throw new Error("pending_registration_check_claim_failed");
      if (!claimed.data) continue;
      checked++;
      if (row.brand_status !== "approved") {
        const remote = await telnyx.messaging10dlc.brand.retrieve(row.telnyx_brand_id, {
          timeout: 8000, maxRetries: 0,
        });
        if (remote.brandId !== row.telnyx_brand_id) throw new Error("pending_brand_identity_mismatch");
        const status = mapBrandStatus(remote).dbStatus;
        if (status === null) continue;
        const reason = status === "rejected" ? extractRejectionReason(remote as unknown as Record<string, unknown>) : null;
        let transition = supabaseAdmin.from("businesses").update({
          brand_status: status, brand_status_updated_at: new Date().toISOString(),
          brand_rejection_reason: reason,
          ...(status === "rejected" ? {
            onboarding_registration_status: "failed", onboarding_registration_submitted_at: null,
            onboarding_registration_error: reason ?? REJECTION_SUPPORT_MESSAGE,
          } : {}),
        }).eq("id", row.id).eq("telnyx_brand_id", row.telnyx_brand_id)
          .is("telnyx_campaign_id", null).is("deleted_at", null)
          .eq("onboarding_registration_status", row.onboarding_registration_status);
        transition = row.brand_status === null ? transition.is("brand_status", null)
          : transition.eq("brand_status", row.brand_status);
        const applied = await transition.select("id").maybeSingle();
        if (applied.error) throw new Error("pending_brand_transition_failed");
        if (!applied.data || status === "rejected") continue;
      }
      await continuePendingBrandRegistration(row.id);
    } catch {
      // One unavailable provider/account must not starve the remaining queue.
      failed++;
      console.warn("[registration] pending continuation check needs retry", { businessId: row.id });
    }
  }
  return { checked, failed };
}
