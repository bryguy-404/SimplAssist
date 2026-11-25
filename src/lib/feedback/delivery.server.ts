import "server-only";
import { resend, RESEND_FROM } from "@/lib/email/client";
import { SUPPORT_EMAIL } from "@/lib/support/constants";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function deliverFeedbackEmail(id: string | null = null) {
  const claim = await supabaseAdmin.rpc("claim_dashboard_feedback_email", { p_id: id });
  if (claim.error) throw new Error("feedback_claim_failed");
  const response = claim.data?.[0];
  if (!response) return;

  const sendOptions = { idempotencyKey: `dashboard-feedback/${response.id}`, signal: AbortSignal.timeout(8000) };
  const { data, error } = await resend.emails.send({
    from: RESEND_FROM,
    to: SUPPORT_EMAIL,
    replyTo: response.reply_email ?? undefined,
    subject: `SimplAssist dashboard feedback · ${response.rating}`,
    text: [
      `Business: ${response.business_name}`,
      `From: ${response.reply_email ?? "No email on file"}`,
      `Rating: ${response.rating}`,
      "",
      response.comment || "(No comment)",
    ].join("\n"),
  }, sendOptions);
  if (error || !data?.id) throw new Error("feedback_email_unconfirmed");

  const saved = await supabaseAdmin.from("dashboard_feedback_responses")
    .update({ sent_at: new Date().toISOString() }).eq("id", response.id);
  if (saved.error) throw new Error("feedback_email_receipt_failed");
}
