import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { RESEND_FROM } from "@/lib/email/client";
import { getCanonicalAppOrigin } from "@/lib/branding/defaultBrand";
import { accountAlertMessageSchema, renderAccountAlert } from "./message";
import { sendAccountAlert } from "./sender.server";

const claimSchema = z.object({
  id: z.string().uuid(), business_id: z.string().uuid(), owner_id: z.string().uuid(),
  payload: z.unknown(), message: z.unknown().nullable(),
  first_attempt_at: z.string().datetime({ offset: true }),
  attempt_count: z.number().int().positive(),
});

export async function runAccountSignupAlerts() {
  const summary = { enabled: process.env.ACCOUNT_SIGNUP_ALERTS_ENABLED === "true", captured: 0, accepted: 0, retry: 0, needsReview: 0 };
  if (!summary.enabled) return summary;
  if (!process.env.RESEND_API_KEY?.trim()) throw new Error("account_alert_sender_unconfigured");
  const captured = await supabaseAdmin.rpc("reconcile_account_signup_alerts");
  if (captured.error || !Number.isInteger(captured.data)) throw new Error("account_alert_capture_failed");
  summary.captured = captured.data;
  // Bounded independently from registration continuation (at most 3 x 8s sends).
  for (let index = 0; index < 3; index++) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 550));
    const token = randomUUID();
    const claim = await supabaseAdmin.rpc("claim_account_signup_alert", { p_claim_token: token });
    if (claim.error || !Array.isArray(claim.data)) throw new Error("account_alert_claim_failed");
    if (claim.data.length === 0) break;
    const row = claimSchema.parse(claim.data[0]);
    const update = (values: Record<string, unknown>) => supabaseAdmin.from("account_signup_alerts")
      .update(values).eq("id", row.id).eq("claim_token", token).eq("status", "sending")
      .gt("claimed_until", new Date().toISOString()).select("id").maybeSingle();
    let message;
    try {
      message = row.message === null
        ? renderAccountAlert(row.payload, RESEND_FROM, getCanonicalAppOrigin())
        : accountAlertMessageSchema.parse(row.message);
    } catch {
      const failed = await update({ status: "needs_review", error_code: "invalid_message", claim_token: null, claimed_until: null });
      if (failed.error || !failed.data) throw new Error("account_alert_state_save_failed");
      summary.needsReview++;
      continue;
    }
    // Persist the exact provider request before any attempt, including sender and links.
    const saved = await update({ message });
    if (saved.error || !saved.data) throw new Error("account_alert_message_save_failed");
    if (Date.now() - Date.parse(row.first_attempt_at) >= 23 * 60 * 60 * 1000) {
      const expired = await update({ status: "needs_review", error_code: "retry_window_expired", claim_token: null, claimed_until: null });
      if (expired.error || !expired.data) throw new Error("account_alert_state_save_failed");
      summary.needsReview++;
      continue;
    }
    // Deletion or reassignment after queue capture must suppress this delivery.
    const business = await supabaseAdmin.from("businesses").select("id")
      .eq("id", row.business_id).eq("owner_id", row.owner_id).is("deleted_at", null)
      .is("partner_id", null).eq("billing_mode", "stripe").maybeSingle();
    if (business.error) throw new Error("account_alert_account_lookup_failed");
    if (!business.data) {
      const canceled = await update({ status: "canceled", message: null, payload: {}, claim_token: null, claimed_until: null });
      if (canceled.error) throw new Error("account_alert_state_save_failed");
      continue;
    }
    const result = await sendAccountAlert(row.id, message);
    const nextAttempt = new Date(Date.now() + Math.min(3600, 60 * 2 ** Math.min(row.attempt_count - 1, 6)) * 1000).toISOString();
    const finished = await update(result.kind === "accepted" ? {
      status: "sent", provider_message_id: result.providerId, accepted_at: new Date().toISOString(), error_code: null,
      claim_token: null, claimed_until: null,
    } : {
      status: result.kind === "retry" ? "pending" : "needs_review", error_code: result.code,
      next_attempt_at: nextAttempt, claim_token: null, claimed_until: null,
    });
    if (finished.error || !finished.data) throw new Error("account_alert_result_save_failed");
    if (result.kind === "accepted") summary.accepted++;
    else if (result.kind === "retry") summary.retry++;
    else summary.needsReview++;
  }
  const health = await supabaseAdmin.from("account_signup_alerts")
    .select("id", { count: "exact", head: true }).eq("status", "needs_review");
  if (health.error) throw new Error("account_alert_health_lookup_failed");
  summary.needsReview = Math.max(summary.needsReview, health.count ?? 0);
  return summary;
}
