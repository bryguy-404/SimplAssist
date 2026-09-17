import "server-only";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { checkVoiceWorkerReady } from "./routing";
import type { OwnerVoiceSettings } from "./ownerSettings";

const seconds = z.number().finite().nonnegative();
const summarySchema = z.object({
  visible: z.boolean(),
  access_source: z.enum(["pilot", "commercial"]),
  eligible: z.boolean(),
  reason: z.string().nullable(),
  primary_response: z.enum(["text", "voice"]),
  text_fallback_enabled: z.boolean(),
  revision: z.number().int().nonnegative(),
  period_end: z.string().datetime({ offset: true }).nullable(),
  included_seconds: seconds.nullable(),
  used_seconds: seconds.nullable(),
  held_seconds: seconds.nullable(),
  available_seconds: seconds.nullable(),
  reconciling: z.boolean(),
});

export class VoiceSettingsError extends Error {
  constructor(public readonly code: "forbidden" | "conflict" | "unavailable") {
    super(`voice_settings_${code}`);
  }
}

/** Cheap routing preflight only. Atomic admission repeats this and every other guard. */
export async function hasCustomerVoiceRoutingConfiguration(businessId: string): Promise<boolean> {
  const settings = await supabaseAdmin.from("voice_commercial_settings").select("primary_response").eq("business_id", businessId).maybeSingle();
  if (settings.error) throw new VoiceSettingsError("unavailable");
  // A closed rollout stops voice admissions, not the owner's saved fallback
  // preference. Existing voice accounts still need one persisted denial route.
  return settings.data?.primary_response === "voice";
}

export async function isCustomerVoiceRolloutEnabledForBusiness(businessId: string): Promise<boolean> {
  const [control, business] = await Promise.all([
    supabaseAdmin.from("voice_rollout_control").select("enabled,emergency_stop").eq("singleton", true).maybeSingle(),
    supabaseAdmin.from("voice_rollout_businesses").select("emergency_stop").eq("business_id", businessId).maybeSingle(),
  ]);
  if (control.error || business.error) throw new VoiceSettingsError("unavailable");
  // Public paid accounts do not need a membership row. Per-business rows only
  // provide an emergency stop; SQL repeats this plus payment/period checks.
  return control.data?.enabled === true && control.data.emergency_stop === false &&
    (business.data === null || business.data?.emergency_stop === false);
}

/** Caller resolves current workspace access. No provider identities or raw rows leave this projection. */
export async function getOwnerVoiceSettings(businessId: string): Promise<OwnerVoiceSettings> {
  const [result, business] = await Promise.all([
    supabaseAdmin.rpc("get_voice_commercial_summary", { p_business_id: businessId }),
    supabaseAdmin.from("businesses").select("timezone").eq("id", businessId).is("deleted_at", null).maybeSingle(),
  ]);
  if (result.error || business.error || !business.data) throw new VoiceSettingsError("unavailable");
  const parsed = summarySchema.safeParse(result.data);
  if (!parsed.success) throw new VoiceSettingsError("unavailable");
  const s = parsed.data;
  const pilot = s.access_source === "pilot";
  const knownUsage = [s.included_seconds, s.used_seconds, s.held_seconds, s.available_seconds].every((v) => v !== null);
  const hasPeriod = pilot || s.period_end !== null;
  const reasons: Record<string, OwnerVoiceSettings["status"]> = {
    rollout_closed: "rollout_closed", plan_required: "plan_required", payment_required: "payment_required",
    exhausted: "exhausted", temporarily_unavailable: "temporarily_unavailable", billing_pending: "temporarily_unavailable",
  };
  let status: OwnerVoiceSettings["status"] = s.eligible ? "ready" : reasons[s.reason ?? ""] ?? "temporarily_unavailable";
  if (!pilot && s.eligible && !(await checkVoiceWorkerReady(process.env.VOICE_SERVICE_URL || "", process.env.VOICE_INTERNAL_TOKEN || "", true))) {
    status = "temporarily_unavailable";
  }
  let timezone = "UTC";
  try {
    if (typeof business.data.timezone === "string") {
      new Intl.DateTimeFormat("en-US", { timeZone: business.data.timezone });
      timezone = business.data.timezone;
    }
  } catch { /* Invalid old data must not turn an allowance into a false reset date. */ }
  return {
    visible: s.visible, accessSource: s.visible ? s.access_source : null,
    canEditPreferences: s.visible && !pilot,
    canEnableVoice: s.visible && !pilot && knownUsage && hasPeriod && Date.parse(s.period_end!) > Date.now() && s.available_seconds! >= 60 && status === "ready",
    status, timezone,
    preferences: { mode: s.primary_response, textFallbackEnabled: s.text_fallback_enabled, revision: s.revision },
    usage: s.visible && knownUsage && hasPeriod ? {
      kind: pilot ? "pilot_lifetime" : "monthly", includedSeconds: s.included_seconds!, usedSeconds: s.used_seconds!,
      periodState: pilot || Date.parse(s.period_end!) > Date.now() ? "current" : "ended",
      heldSeconds: s.held_seconds!, availableSeconds: s.available_seconds!, resetsAt: pilot ? null : s.period_end,
      reconciling: s.reconciling,
    } : null,
  };
}

export async function updateOwnerVoiceSettings(businessId: string, ownerId: string, input: {
  mode: "text" | "voice"; textFallbackEnabled: boolean; expectedRevision: number;
}): Promise<OwnerVoiceSettings> {
  // Turning voice on also checks worker protocol readiness; SQL repeats all durable access checks.
  if (input.mode === "voice") {
    const current = await getOwnerVoiceSettings(businessId);
    if (!current.canEditPreferences || (current.preferences.mode !== "voice" && !current.canEnableVoice))
      throw new VoiceSettingsError("forbidden");
  }
  const { data, error } = await supabaseAdmin.rpc("configure_voice_commercial", {
    p_business_id: businessId, p_primary_response: input.mode, p_text_fallback_enabled: input.textFallbackEnabled,
    p_expected_revision: input.expectedRevision, p_owner_id: ownerId,
  });
  if (error) {
    if (error.code === "40001") throw new VoiceSettingsError("conflict");
    if (error.code === "42501") throw new VoiceSettingsError("forbidden");
    throw new VoiceSettingsError("unavailable");
  }
  if (!data || data.business_id !== businessId || data.primary_response !== input.mode ||
      data.text_fallback_enabled !== input.textFallbackEnabled || data.revision !== input.expectedRevision + 1) {
    throw new VoiceSettingsError("unavailable");
  }
  return getOwnerVoiceSettings(businessId);
}
