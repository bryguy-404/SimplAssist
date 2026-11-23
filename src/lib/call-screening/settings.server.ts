import "server-only";
import { supabaseAdmin as db } from "@/lib/supabase/admin";
import { telnyx } from "@/lib/messaging/client";
import { canUseFeature, resolveBusinessEntitlements } from "@/lib/billing/entitlements";
import { findOwnedNumberId, normalizeTelnyxPhoneNumberResourceId } from "@/lib/messaging/numbers";
import { canEnableCallScreening } from "./rollout.server";
import { providerScreeningMode, type CallScreeningSettings, type ScreeningMode } from "./domain";

type Phone = { id: string; business_id: string; phone_number: string; telnyx_phone_number_id: string | null };
type Setting = {
  phone_number_id: string; business_id: string; requested_by: string; requested_mode: ScreeningMode;
  confirmed_mode: CallScreeningSettings["confirmedMode"]; revision: number;
  sync_status: CallScreeningSettings["syncStatus"]; verified_at: string | null; lease_token: string | null;
};
const requestOptions = () => ({ maxRetries: 0, timeout: 3000, signal: AbortSignal.timeout(8000) });
export class ScreeningSettingsError extends Error {}

async function ownerNumber(businessId: string, ownerId: string): Promise<Phone | null> {
  const owner = await db.from("businesses").select("id").eq("id", businessId).eq("owner_id", ownerId).is("deleted_at", null).maybeSingle();
  if (owner.error || !owner.data) throw new ScreeningSettingsError("screening_access_denied");
  const phone = await db.from("phone_numbers").select("id,business_id,phone_number,telnyx_phone_number_id")
    .eq("business_id", businessId).eq("is_active", true).maybeSingle();
  if (phone.error) throw new ScreeningSettingsError("screening_number_unavailable");
  return phone.data;
}

/** Verify exact provider ownership, including old order-line UUID recovery. */
async function providerId(phone: Phone, options: ReturnType<typeof requestOptions>) {
  let id: string;
  try { id = normalizeTelnyxPhoneNumberResourceId(phone.telnyx_phone_number_id, "call screening"); }
  catch {
    if (!phone.telnyx_phone_number_id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(phone.telnyx_phone_number_id)) throw new ScreeningSettingsError("screening_number_unavailable");
    const found = await findOwnedNumberId(phone.phone_number, phone.business_id, options);
    if (!found) throw new ScreeningSettingsError("screening_number_unavailable");
    const saved = await db.rpc("repair_telnyx_phone_number_resource_id", {
      p_business_id: phone.business_id, p_phone_number_id: phone.id, p_phone_number: phone.phone_number,
      p_expected_legacy_id: phone.telnyx_phone_number_id, p_resolved_resource_id: found,
    });
    if (saved.error || saved.data !== true) throw new ScreeningSettingsError("screening_number_unavailable");
    id = found;
  }
  const owned = await telnyx.phoneNumbers.retrieve(id, options);
  if (owned.data?.phone_number !== phone.phone_number || owned.data?.customer_reference !== phone.business_id) {
    throw new ScreeningSettingsError("screening_number_unavailable");
  }
  return id;
}
async function setting(numberId: string): Promise<Setting | null> {
  const r = await db.from("call_screening_settings").select("*").eq("phone_number_id", numberId).maybeSingle();
  if (r.error) throw new ScreeningSettingsError("screening_settings_unavailable");
  return r.data;
}

export async function getCallScreeningSettings(businessId: string, ownerId: string, refresh = false): Promise<CallScreeningSettings> {
  const phone = await ownerNumber(businessId, ownerId);
  const entitled = canUseFeature(await resolveBusinessEntitlements(businessId), "missed_call_sms");
  let row = phone ? await setting(phone.id) : null;
  const canEnable = entitled && canEnableCallScreening(businessId);
  // Owners retain access to disable a previously activated number after rollout closes.
  const available = !!phone && (canEnable || !!row);
  let refreshError = false;
  if (refresh && phone && available) {
    try {
      const options = requestOptions();
      const id = await providerId(phone, options);
      const actual = providerScreeningMode((await telnyx.phoneNumbers.voice.retrieve(id, options)).data?.inbound_call_screening);
      if (actual === "unknown") throw new Error("unknown_provider_state");
      const saved = await db.rpc("observe_call_screening_setting", {
        p_business: businessId, p_owner: ownerId, p_number: phone.id, p_actual: actual, p_revision: row?.revision ?? 0,
      });
      if (saved.error) throw new Error("screening_readback_save_failed");
      row = await setting(phone.id);
    } catch { refreshError = true; }
  }
  return {
    available, canEnable, phoneNumber: phone?.phone_number ?? null,
    confirmedMode: row?.confirmed_mode ?? "unknown", requestedMode: row?.requested_mode ?? "disabled",
    revision: row?.revision ?? 0, syncStatus: row?.sync_status ?? "idle", verifiedAt: row?.verified_at ?? null,
    error: refreshError ? "Could not verify the current screening setting. Please refresh." : row?.sync_status === "error" ? "The screening change could not be confirmed. Refresh, then try saving again." : null,
  };
}

export async function syncCallScreening(numberId: string) {
  const claimed = await db.rpc("claim_call_screening_sync", { p_number: numberId });
  if (claimed.error) throw new Error("screening_sync_claim_failed");
  const row = claimed.data as Setting | null;
  if (!row?.lease_token) return;
  let actual: CallScreeningSettings["confirmedMode"] = "unknown";
  let failure: string | null = null;
  try {
    const options = requestOptions();
    const phone = await ownerNumber(row.business_id, row.requested_by);
    if (!phone || phone.id !== numberId) throw new ScreeningSettingsError("screening_number_unavailable");
    if (row.requested_mode === "flag_calls" && (!canEnableCallScreening(row.business_id) ||
      !canUseFeature(await resolveBusinessEntitlements(row.business_id), "missed_call_sms"))) {
      throw new ScreeningSettingsError("screening_number_unavailable");
    }
    const id = await providerId(phone, options);
    actual = providerScreeningMode((await telnyx.phoneNumbers.voice.retrieve(id, options)).data?.inbound_call_screening);
    if (actual !== row.requested_mode) {
      // Recheck the exact active binding immediately before the provider mutation.
      const current = await ownerNumber(row.business_id, row.requested_by);
      if (current?.id !== phone.id || current.phone_number !== phone.phone_number) throw new ScreeningSettingsError("screening_number_unavailable");
      await telnyx.phoneNumbers.voice.update(id, { inbound_call_screening: row.requested_mode }, options);
      actual = "unknown";
      actual = providerScreeningMode((await telnyx.phoneNumbers.voice.retrieve(id, options)).data?.inbound_call_screening);
    }
    if (actual !== row.requested_mode) failure = "screening_sync_unconfirmed";
  } catch (e) {
    actual = "unknown";
    failure = e instanceof ScreeningSettingsError ? e.message : "screening_sync_unconfirmed";
  }
  const saved = await db.rpc("finish_call_screening_sync", { p_number: numberId, p_lease: row.lease_token, p_actual: actual, p_error: failure });
  if (saved.error) throw new Error("screening_sync_finish_failed");
}

export async function updateCallScreening(businessId: string, ownerId: string, mode: ScreeningMode, revision: number) {
  const phone = await ownerNumber(businessId, ownerId);
  if (!phone) throw new ScreeningSettingsError("screening_number_unavailable");
  if (mode === "flag_calls" && (!canEnableCallScreening(businessId) || !canUseFeature(await resolveBusinessEntitlements(businessId), "missed_call_sms"))) {
    throw new ScreeningSettingsError("screening_access_denied");
  }
  const requested = await db.rpc("request_call_screening", { p_business: businessId, p_owner: ownerId, p_number: phone.id, p_mode: mode, p_revision: revision });
  if (requested.error) throw new ScreeningSettingsError(requested.error.message);
  // A durable pending request survives network failure or process termination.
  await syncCallScreening(phone.id).catch(() => undefined);
  return getCallScreeningSettings(businessId, ownerId);
}

export async function reconcileCallScreening() {
  const pending = await db.from("call_screening_settings").select("phone_number_id").eq("sync_status", "pending").order("attempted_at", { nullsFirst: true }).limit(1);
  if (pending.error) throw new Error("screening_reconciliation_unavailable");
  for (const row of pending.data ?? []) await syncCallScreening(row.phone_number_id);
  const stale = await db.from("inbound_call_screening").select("call_control_id,call_session_id")
    .is("ended_at", null).is("deleted_at", null).lt("created_at", new Date(Date.now() - 15 * 60_000).toISOString()).order("status_checked_at", { nullsFirst: true }).limit(1);
  if (stale.error) throw new Error("screening_call_recovery_unavailable");
  for (const call of stale.data ?? []) {
    try {
      const status = (await telnyx.calls.retrieveStatus(call.call_control_id, requestOptions())).data;
      if (status?.is_alive !== false || status.call_control_id !== call.call_control_id || status.call_session_id !== call.call_session_id) continue;
      const exact = typeof status.end_time === "string" && Number.isFinite(Date.parse(status.end_time));
      const done = await db.rpc("finish_inbound_call_screening", { p_control: call.call_control_id, p_ended: exact ? status.end_time : new Date().toISOString(), p_exact_time: exact });
      if (done.error) throw new Error("screening_call_recovery_failed");
    } catch { /* Never infer termination from a timeout or a missing provider record. */ }
    finally { await db.from("inbound_call_screening").update({ status_checked_at: new Date().toISOString() }).eq("call_control_id", call.call_control_id); }
  }
}
