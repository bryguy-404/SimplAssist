import "server-only";
import { supabaseAdmin as db } from "@/lib/supabase/admin";
import { telnyx } from "@/lib/messaging/client";
import { recordOutboundSmsUsage } from "@/lib/billing/usage";
import { getOrCreateConversation } from "@/lib/ai/conversations";
import type { VoiceAction } from "./actions";

export async function persistVoiceSmsBookkeeping(
  a: VoiceAction,
  result: Record<string, unknown>,
) {
  if (
    typeof result.providerMessageId !== "string" ||
    typeof result.smsBody !== "string"
  )
    throw new Error("voice_sms_bookkeeping_missing");
  const { data: s, error: se } = await db
    .from("voice_sessions")
    .select("conversation_id,action_conversation_id")
    .eq("id", a.session_id)
    .single();
  if (se || !s) throw new Error("voice_sms_call_missing");
  const { data: c, error: ce } = await db
    .from("conversations")
    .select("contact_id")
    .eq("id", s.action_conversation_id || s.conversation_id)
    .eq("business_id", a.business_id)
    .single();
  if (ce || !c) throw new Error("voice_sms_contact_missing");
  const conversation = await getOrCreateConversation(
    a.business_id,
    c.contact_id,
    "sms",
  );
  const message = await db.from("messages").upsert(
    {
      id: a.id,
      business_id: a.business_id,
      conversation_id: conversation.id,
      role: "assistant",
      channel: "sms",
      content: result.smsBody,
    },
    { onConflict: "id", ignoreDuplicates: true },
  );
  if (message.error) throw new Error("voice_sms_message_log_failed");
  await recordOutboundSmsUsage({
    businessId: a.business_id,
    text: result.smsBody,
    source: "voice_followup_sms",
    providerMessageId: result.providerMessageId,
    idempotencyKey: `voice-followup:${a.id}`,
  });
  const updated = await db
    .from("voice_actions")
    .update({ sms_logged_at: new Date().toISOString() })
    .eq("id", a.id);
  if (updated.error) throw new Error("voice_sms_bookkeeping_finalize_failed");
}
export async function recoverVoiceActions() {
  // Provider reads only: uncertain effects are never blindly resubmitted.
  const { data: rows, error } = await db
    .from("voice_actions")
    .select("*")
    .in("status", ["executing", "uncertain", "succeeded"])
    .eq("recovery_complete", false)
    .or(
      `reconciled_at.is.null,reconciled_at.lt.${new Date(Date.now() - 60000).toISOString()}`,
    )
    .order("reconciled_at", { nullsFirst: true })
    .order("updated_at")
    .limit(8);
  if (error) throw new Error("voice_action_recovery_lookup_failed");
  for (const row of rows || []) {
    const a = row as VoiceAction;
    if (
      a.status === "executing" &&
      Date.now() - Date.parse(row.updated_at) < 60000
    )
      continue;
    try {
      if (a.kind === "signup" && a.result?.providerMessageId) {
        if (!row.sms_logged_at) await persistVoiceSmsBookkeeping(a, a.result);
        const message = await telnyx.messages.retrieve(
          String(a.result.providerMessageId),
          { maxRetries: 0, timeout: 5000 },
        );
        const recipient = message.data?.to?.[0];
        const { data: s, error: se } = await db
          .from("voice_sessions")
          .select("caller_phone,called_phone")
          .eq("id", a.session_id)
          .single();
        if (
          se ||
          !s ||
          message.data?.from?.phone_number !== s.called_phone ||
          recipient?.phone_number !== s.caller_phone
        )
          throw new Error("voice_sms_provider_identity_mismatch");
        const status = recipient?.status || "delivery_unconfirmed";
        const result = { ...a.result, deliveryStatus: status };
        await db
          .from("voice_actions")
          .update({
            result,
            reconciled_at: new Date().toISOString(),
            recovery_complete: [
              "delivered",
              "delivery_failed",
              "sending_failed",
              "expired",
              "cancelled",
            ].includes(status),
          })
          .eq("id", a.id);
      } else if (a.kind === "booking" && a.source_message_id) {
        const { data: b, error: be } = await db
          .from("calendar_bookings")
          .select("id,status,google_event_id")
          .eq("business_id", a.business_id)
          .eq("source_message_id", a.source_message_id)
          .maybeSingle();
        if (be) throw new Error("voice_booking_recovery_failed");
        if (b?.status === "confirmed")
          await db
            .from("voice_actions")
            .update({
              status: "succeeded",
              result: {
                summary: "The appointment is confirmed in the calendar.",
                bookingId: b.id,
                eventId: b.google_event_id,
              },
              error_code: null,
              reconciled_at: new Date().toISOString(),
              recovery_complete: true,
            })
            .eq("id", a.id);
        else if (b && ["failed", "cancelled"].includes(b.status))
          await db
            .from("voice_actions")
            .update({
              status: "failed",
              error_code: "booking_not_confirmed",
              reconciled_at: new Date().toISOString(),
              recovery_complete: true,
            })
            .eq("id", a.id);
        else
          await db
            .from("voice_actions")
            .update({
              status: "uncertain",
              error_code: "booking_result_needs_review",
              reconciled_at: new Date().toISOString(),
            })
            .eq("id", a.id);
      } else if (a.kind === "booking_request" && a.source_message_id) {
        const r = await db
          .from("booking_requests")
          .select("id")
          .eq("business_id", a.business_id)
          .eq("source_message_id", a.source_message_id)
          .maybeSingle();
        if (r.error) throw new Error("request_recovery_failed");
        if (r.data)
          await db
            .from("voice_actions")
            .update({
              status: "succeeded",
              result: {
                summary:
                  "Appointment request recorded for owner review, not a confirmed booking.",
                requestId: r.data.id,
              },
              recovery_complete: true,
              reconciled_at: new Date().toISOString(),
              error_code: null,
            })
            .eq("id", a.id);
      } else if (a.status === "executing")
        await db
          .from("voice_actions")
          .update({
            status: "uncertain",
            error_code: "interrupted_action_needs_review",
            reconciled_at: new Date().toISOString(),
          })
          .eq("id", a.id);
    } catch {
      // Durable action stays visible; retry lookup/bookkeeping on next sweep.
    } finally {
      // Rotate every inspected row, including unknown provider results, so one
      // unresolved action cannot starve newer calls in this bounded sweep.
      await db
        .from("voice_actions")
        .update({
          reconciled_at: new Date().toISOString(),
        })
        .eq("id", a.id);
    }
  }
}
