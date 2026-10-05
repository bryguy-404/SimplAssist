import "server-only";
import { createHash } from "node:crypto";
import { supabaseAdmin as db } from "@/lib/supabase/admin";
import { telnyx } from "@/lib/messaging/client";
import { extractRejectionReason } from "./registration/statusMapper";
import { compareExistingBrandIdentity, type ExistingBrandLocalIdentity, type ExistingBrandProviderIdentity } from "./registration/identity";

function string(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) if (typeof record[key] === "string" && record[key]) return record[key] as string;
  return null;
}
export function sharedBrandObservedStatus(payload: Record<string, unknown>): "approved" | "pending" | "rejected" | null {
  const status = string(payload, ["status", "brandStatus", "brand_status"])?.toUpperCase();
  const identity = string(payload, ["identityStatus", "identity_status", "brandIdentityStatus", "brand_identity_status"])?.toUpperCase();
  // Negative carrier status takes precedence over a retained verified identity.
  if (status && /FAILED|REJECTED|SUSPENDED|EXPIRED|DELETED|DEACTIVATED/.test(status)) return "rejected";
  if ((status === "OK" || status === undefined) && ["VERIFIED", "VETTED_VERIFIED"].includes(identity ?? "")) return "approved";
  if (status === "REGISTRATION_PENDING" || identity === "UNVERIFIED" || identity === "SELF_DECLARED") return "pending";
  return null; // Metadata/heartbeat/unknown events are not loss of approval.
}

async function assertProviderIdentity(current: Record<string, unknown>, registration: { telnyx_brand_id: string; tcr_brand_id: string; legal_identity: unknown }, observedAt: string) {
  const identity = registration.legal_identity as ExistingBrandLocalIdentity & { address?: string; city?: string };
  const normalize = (v: unknown) => typeof v === "string" ? v.normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase() : "";
  if (!["brandId", "tcrBrandId", "country", "companyName", "entityType", "street", "city", "state", "postalCode"].every(k => normalize(current[k]))
    || !normalize(current.universalEin ?? current.ein) || typeof current.mock !== "boolean") throw new Error("shared_brand_observation_incomplete");
  if (current.brandId !== registration.telnyx_brand_id || current.mock !== false || current.country !== "US"
    || current.tcrBrandId !== registration.tcr_brand_id || !compareExistingBrandIdentity(current as ExistingBrandProviderIdentity, identity).matches
    || !normalize(current.street) || normalize(current.street) !== normalize(identity.address)
    || !normalize(current.city) || normalize(current.city) !== normalize(identity.city)) {
    const held = await db.rpc("hold_shared_brand_identity", { p_brand_id: registration.telnyx_brand_id, p_observed_at: observedAt });
    if (held.error) throw new Error("shared_brand_identity_hold_unavailable");
    throw new Error("shared_brand_identity_changed");
  }
}

/** Shared events bypass the legacy early 'seen' receipt. The RPC records the
 * event and every membership change in one transaction, so a failed fan-out is
 * retried rather than acknowledged by an overlapping delivery. */
export async function handleSharedBrandEvent(event: unknown): Promise<boolean> {
  const data = (event as { data?: { id?: string; event_type?: string; occurred_at?: string; payload?: unknown } })?.data;
  const payload = data?.payload && typeof data.payload === "object" ? data.payload as Record<string, unknown> : {};
  if (string(payload, ["campaignId", "campaign_id", "tcrCampaignId"])) return false;
  const brandId = string(payload, ["brandId", "brand_id", "tcrBrandId"]);
  if (!brandId || !/^[a-zA-Z0-9_-]{1,64}$/.test(brandId)) return false;
  const field = brandId.includes("-") ? "telnyx_brand_id" : "tcr_brand_id";
  const found = await db.from("shared_business_registrations").select("id,telnyx_brand_id,tcr_brand_id,legal_identity,brand_event_at,brand_status").eq(field, brandId).maybeSingle();
  if (found.error) throw new Error("shared_brand_lookup_unavailable");
  if (!found.data) return false;
  if (data?.event_type === "BRAND_OTP_VERIFIED" || payload.eventType === "BRAND_OTP_VERIFIED") return true;
  const timestamp = data?.occurred_at;
  // A positive event without usable ordering cannot safely reopen a brand.
  if (!timestamp || !Number.isFinite(Date.parse(timestamp)) || Date.parse(timestamp) > Date.now() + 300_000) {
    throw new Error("shared_brand_event_time_invalid");
  }
  let status = sharedBrandObservedStatus(payload);
  let observedAt = new Date(timestamp).toISOString();
  let observedPayload = payload;
  // Verify approvals against current provider state. A delayed positive event
  // cannot revive a brand the carrier has since rejected or suspended.
  if (status === "approved" || status === null) {
    observedAt = new Date().toISOString();
    const current = await telnyx.messaging10dlc.brand.retrieve(found.data.telnyx_brand_id);
    observedPayload = current as unknown as Record<string, unknown>;
    status = sharedBrandObservedStatus(observedPayload);
    if (status === "approved") await assertProviderIdentity(observedPayload, found.data, observedAt);
    else if (current.brandId !== found.data.telnyx_brand_id || current.mock !== false) throw new Error("shared_brand_observation_invalid");
  }
  if (status === null) throw new Error("shared_brand_status_unknown");
  const eventId = data?.id || `shared:${createHash("sha256").update(JSON.stringify(data)).digest("hex")}`;
  const result = await db.rpc("apply_shared_brand_event", {
    // A fresh retrieval is ordered at its own observation time. Keeping an old
    // triggering event's timestamp would discard a newly discovered rejection.
    p_brand_id: found.data.telnyx_brand_id, p_event_id: eventId, p_occurred_at: observedAt,
    p_status: status, p_rejection_reason: extractRejectionReason(observedPayload),
  });
  if (result.error) throw new Error("shared_brand_event_not_committed");
  return true;
}

/** Bounded read-only provider reconciliation recovers missed callbacks. It
 * never submits, edits, or deletes a registration, even when starts are off. */
export async function reconcileSharedBrandStatuses(): Promise<number> {
  const before = new Date(Date.now() - 300_000).toISOString();
  const rows = await db.from("shared_business_registrations").select("id,telnyx_brand_id,tcr_brand_id,legal_identity")
    .eq("status", "active").or(`brand_event_at.is.null,brand_event_at.lt.${before}`)
    .order("brand_event_at", { ascending: true, nullsFirst: true }).limit(3);
  if (rows.error) throw new Error("shared_brand_reconciliation_unavailable");
  let completed = 0;
  for (const row of rows.data ?? []) {
    const observedAt = new Date().toISOString();
    try {
      const current = await telnyx.messaging10dlc.brand.retrieve(row.telnyx_brand_id, { maxRetries: 0, timeout: 10_000 });
      const payload = current as unknown as Record<string, unknown>;
      const status = sharedBrandObservedStatus(payload);
      if (status === null) throw new Error("shared_brand_status_unknown");
      if (status === "approved") await assertProviderIdentity(payload, row, observedAt);
      else if (current.brandId !== row.telnyx_brand_id || current.mock !== false) throw new Error("shared_brand_observation_invalid");
      const result = await db.rpc("apply_shared_brand_event", {
        p_brand_id: row.telnyx_brand_id, p_event_id: `reconcile:${row.id}:${observedAt}`, p_occurred_at: observedAt,
        p_status: status, p_rejection_reason: extractRejectionReason(payload),
      });
      if (result.error) throw new Error("shared_brand_observation_not_saved");
      completed++;
    } catch {
      // A provider outage never converts a known rejection to approval. Leave
      // the failed observation due for the next bounded lifecycle tick.
      console.warn("[shared-registration] Brand status reconciliation will retry.");
    }
  }
  return completed;
}
