import "server-only";
import { supabaseAdmin as db } from "@/lib/supabase/admin";
import { telnyx } from "@/lib/messaging/client";
import { recordOutboundSmsUsage } from "@/lib/billing/usage";
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
  // The database validates the stored acceptance and finalizes the message,
  // cross-channel lead and links atomically. No provider send happens here.
  const { data, error } = await db.rpc("finalize_voice_signup_bookkeeping", {
    p_action_id: a.id,
  });
  if (error || !Array.isArray(data) || data.length !== 1)
    throw new Error("voice_sms_bookkeeping_finalize_failed");
  if (a.sms_logged_at) return;

  // Usage has its own stable key. A failure here is retried independently of
  // both lead finalization and the provider's delivery status.
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
    .eq("id", a.id)
    .eq("business_id", a.business_id)
    .is("sms_logged_at", null);
  if (updated.error) throw new Error("voice_sms_usage_finalize_failed");
}

export async function recoverVoiceSignupBookkeeping() {
  // Legacy sends without a recorded acceptance time require the explicit,
  // reviewed historical restoration. Never give them a new event timestamp.
  const { data: rows, error } = await db
    .from("voice_actions")
    .select("*")
    .eq("kind", "signup")
    .eq("status", "succeeded")
    .not("sms_accepted_at", "is", null)
    .or("goal_event_recorded_at.is.null,sms_logged_at.is.null")
    .order("bookkeeping_attempted_at", { nullsFirst: true })
    .order("created_at")
    .limit(8);
  if (error) throw new Error("voice_signup_bookkeeping_lookup_failed");
  for (const row of rows || []) {
    if (
      row.bookkeeping_attempted_at &&
      Date.now() - Date.parse(row.bookkeeping_attempted_at) < 60000
    ) continue;
    const a = row as VoiceAction;
    try {
      await persistVoiceSmsBookkeeping(a, a.result || {});
    } catch {
      // Durable acceptance remains successful. Never replay the send.
    } finally {
      const attempted = await db.from("voice_actions")
        .update({ bookkeeping_attempted_at: new Date().toISOString() })
        .eq("id", a.id)
        .eq("business_id", a.business_id);
      if (attempted.error) throw new Error("voice_signup_bookkeeping_rotation_failed");
    }
  }
}

export async function recoverVoiceActions() {
  // Bookkeeping and delivery each make progress even if the other lookup fails.
  const results = await Promise.allSettled([
    recoverVoiceSignupBookkeeping(),
    recoverVoiceProviderResults(),
  ]);
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

async function recoverVoiceProviderResults() {
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
