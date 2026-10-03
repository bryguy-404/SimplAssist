import "server-only";
import { createHash } from "node:crypto";
import { supabaseAdmin as db } from "@/lib/supabase/admin";
import { telnyx } from "./client";
import { preflightOutboundSms } from "@/lib/billing/usage";
import type { OutboundSmsPurpose } from "./outboundSmsOperational.server";

export interface TenantSmsInput {
  businessId: string;
  from: string;
  to: string;
  text: string;
  messagingProfileId: string;
  purpose: OutboundSmsPurpose;
  idempotencyKey: string;
  reviewEnrollmentId?: string | null;
  conversationId?: string | null;
}
interface Reservation {
  id: string;
  business_id: string;
  status: "submitting" | "accepted" | "uncertain" | "not_sent";
  fingerprint: string;
  purpose: OutboundSmsPurpose;
  provider_message_id: string | null;
  sender: string;
  destination: string;
  messaging_profile_id: string;
  review_enrollment_id: string | null;
  conversation_id: string | null;
  created_at: string;
  failure_reason: string | null;
}
export class TenantSmsSendError extends Error {
  constructor(
    public readonly reason: string,
    public readonly outcome: "not_sent" | "uncertain",
    message?: string,
  ) {
    super(
      message ??
        (outcome === "uncertain"
          ? "The text result is still being checked. Do not send another copy."
          : "The text could not be sent."),
    );
    this.name = "TenantSmsSendError";
  }
}
export function tenantSmsFingerprint(
  args: Pick<
    TenantSmsInput,
    | "from"
    | "to"
    | "text"
    | "messagingProfileId"
    | "purpose"
    | "reviewEnrollmentId"
  >,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        args.from,
        args.to,
        args.text,
        args.messagingProfileId,
        args.purpose,
        args.reviewEnrollmentId ?? null,
      ]),
    )
    .digest("hex");
}
function result(r: Reservation, replayed: boolean) {
  if (r.status !== "accepted" || !r.provider_message_id)
    throw new TenantSmsSendError(
      r.failure_reason ?? "sms_acceptance_unknown",
      r.status === "not_sent" ? "not_sent" : "uncertain",
    );
  return {
    data: { id: r.provider_message_id },
    reservationId: r.id,
    replayed,
    conversationId: r.conversation_id,
  };
}
async function settle(
  id: string,
  outcome: "accepted" | "not_sent" | "uncertain",
  providerId: string | null,
  reason: string | null = null,
  deliveryStatus: string | null = null,
) {
  const saved = await db.rpc("settle_tenant_sms", {
    p_id: id,
    p_outcome: outcome,
    p_provider_id: providerId,
    p_reason: reason,
    p_delivery_status: deliveryStatus,
  });
  if (saved.error || !saved.data)
    throw new TenantSmsSendError("sms_receipt_save_failed", "uncertain");
  return saved.data as Reservation;
}
/** A received validation/auth/rate-limit response is a definite no-send. A
 * timeout, connection failure, 5xx, or malformed success can have been accepted. */
export function tenantSmsFailureOutcome(
  error: unknown,
): "not_sent" | "uncertain" {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number(error.status)
      : 0;
  return [400, 401, 402, 403, 404, 405, 413, 415, 422, 429].includes(status)
    ? "not_sent"
    : "uncertain";
}
export async function sendTenantSms(args: TenantSmsInput) {
  if (
    !/^\+[1-9]\d{7,14}$/.test(args.from) ||
    !/^\+[1-9]\d{7,14}$/.test(args.to) ||
    !args.text.trim() ||
    args.text.length > 16000 ||
    !args.messagingProfileId ||
    !args.idempotencyKey ||
    args.idempotencyKey.length > 200
  )
    throw new TenantSmsSendError("sms_payload_invalid", "not_sent");
  const fingerprint = tenantSmsFingerprint(args);
  // A completed request remains retryable after quota/plan state changes, but
  // only as a receipt lookup. It can never contact the provider a second time.
  const existing = await db
    .from("tenant_sms_sends")
    .select("*")
    .eq("business_id", args.businessId)
    .eq("idempotency_key", args.idempotencyKey)
    .maybeSingle();
  if (existing.error)
    throw new TenantSmsSendError("sms_reservation_unavailable", "not_sent");
  if (existing.data) {
    if (existing.data.fingerprint !== fingerprint)
      throw new TenantSmsSendError("sms_idempotency_conflict", "not_sent");
    return result(existing.data as Reservation, true);
  }
  let usage: Awaited<ReturnType<typeof preflightOutboundSms>>;
  try {
    usage = await preflightOutboundSms({
      businessId: args.businessId,
      text: args.text,
      purpose: args.purpose,
    });
  } catch {
    // No reservation or provider request exists yet. Workers may retry this
    // admission failure, but must never reinterpret later uncertainty this way.
    throw new TenantSmsSendError("sms_preflight_unavailable", "not_sent");
  }
  if (!usage.allowed)
    throw new TenantSmsSendError(usage.reason, "not_sent", usage.message);
  const reserved = await db.rpc("reserve_tenant_sms", {
    p_business: args.businessId,
    p_period: usage.periodId,
    p_key: args.idempotencyKey,
    p_fingerprint: fingerprint,
    p_purpose: args.purpose,
    p_profile: args.messagingProfileId,
    p_from: args.from,
    p_to: args.to,
    p_parts: usage.smsParts,
    p_conversation: args.conversationId ?? null,
    p_enrollment: args.reviewEnrollmentId ?? null,
  });
  if (reserved.error || !reserved.data) {
    const reason =
      typeof reserved.error?.message === "string" &&
      /^sms_[a-z_]+$/.test(reserved.error.message)
        ? reserved.error.message
        : "sms_reservation_unavailable";
    throw new TenantSmsSendError(reason, "not_sent");
  }
  const reservation = reserved.data.reservation as Reservation;
  if (!reserved.data.send) return result(reservation, true);
  let providerId: string | null = null;
  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    const webhook = appUrl ? new URL("/api/messaging/webhook", appUrl) : null;
    webhook?.searchParams.set("smsReservation", reservation.id);
    const response = await telnyx.messages.send(
      {
        from: args.from,
        to: args.to,
        text: args.text,
        messaging_profile_id: args.messagingProfileId,
        type: "SMS",
        ...(webhook
          ? { webhook_url: webhook.toString(), use_profile_webhooks: true }
          : {}),
      },
      { maxRetries: 0, timeout: 10000 },
    );
    providerId = response.data?.id ?? null;
    if (!providerId)
      throw new TenantSmsSendError("sms_acceptance_unknown", "uncertain");
  } catch (error) {
    const outcome = tenantSmsFailureOutcome(error);
    await settle(
      reservation.id,
      outcome,
      null,
      outcome === "not_sent"
        ? "sms_provider_rejected"
        : "sms_acceptance_unknown",
    );
    throw new TenantSmsSendError(
      outcome === "not_sent"
        ? "sms_provider_rejected"
        : "sms_acceptance_unknown",
      outcome,
    );
  }
  return result(await settle(reservation.id, "accepted", providerId), false);
}

export async function processTenantSmsInbound(args: {
  businessId: string;
  messagingProfileId: string;
  phone: string;
  text: string;
  conversationId: string;
}) {
  const r = await db.rpc("tenant_sms_inbound", {
    p_business: args.businessId,
    p_profile: args.messagingProfileId,
    p_phone: args.phone,
    p_text: args.text,
    p_conversation: args.conversationId,
  });
  if (r.error || !r.data)
    throw new Error("SMS inbound suppression state unavailable");
  return r.data as {
    reviewHeld: boolean;
    keyword: "stop" | "start" | "help" | null;
  };
}
export interface TenantSmsReceipt {
  id?: string;
  from?: { phone_number?: string };
  to?: Array<{ phone_number?: string; status?: string }>;
  messaging_profile_id?: string;
  text?: string;
  received_at?: string;
}
/** Call only after provider webhook signature verification (or authenticated
 * retrieve). A query-string correlation token alone never authorizes a receipt. */
export async function reconcileTenantSmsReceipt(
  payload: TenantSmsReceipt,
  reservationId?: string | null,
) {
  if (!payload.id) return false;
  const query = db.from("tenant_sms_sends").select("*");
  const found = reservationId
    ? await query.eq("id", reservationId).maybeSingle()
    : await query.eq("provider_message_id", payload.id).maybeSingle();
  if (found.error) throw new Error("SMS receipt lookup unavailable");
  const r = found.data as Reservation | null;
  if (!r) return false;
  if (
    payload.from?.phone_number !== r.sender ||
    payload.to?.[0]?.phone_number !== r.destination ||
    payload.messaging_profile_id !== r.messaging_profile_id
  )
    throw new Error("SMS receipt identity mismatch");
  if (r.provider_message_id && r.provider_message_id !== payload.id)
    throw new Error("SMS receipt provider mismatch");
  if (!r.provider_message_id) {
    if (
      typeof payload.text !== "string" ||
      !payload.received_at ||
      Date.parse(payload.received_at) < Date.parse(r.created_at) - 1000 ||
      tenantSmsFingerprint({
        from: r.sender,
        to: r.destination,
        text: payload.text,
        messagingProfileId: r.messaging_profile_id,
        purpose: r.purpose,
        reviewEnrollmentId: r.review_enrollment_id,
      }) !== r.fingerprint
    )
      throw new Error("SMS receipt correlation mismatch");
  }
  await settle(
    r.id,
    "accepted",
    payload.id,
    null,
    payload.to?.[0]?.status ?? null,
  );
  return true;
}
export async function reconcileTenantSmsSends() {
  const stale = await db
    .from("tenant_sms_sends")
    .update({ status: "uncertain" })
    .eq("status", "submitting")
    .lt("created_at", new Date(Date.now() - 60000).toISOString());
  if (stale.error)
    throw new Error("SMS stale reservation reconciliation failed");
  const pending = await db
    .from("tenant_sms_sends")
    .select("*")
    .not("provider_message_id", "is", null)
    .or("delivery_status.is.null,delivery_status.in.(queued,sending,sent)")
    .order("reconciled_at", { nullsFirst: true })
    .limit(20);
  if (pending.error) throw new Error("SMS reconciliation unavailable");
  for (const r of pending.data ?? []) {
    try {
      const response = await telnyx.messages.retrieve(r.provider_message_id, {
        maxRetries: 0,
        timeout: 5000,
      });
      if (response.data)
        await reconcileTenantSmsReceipt(
          response.data as TenantSmsReceipt,
          r.id,
        );
    } finally {
      await db
        .from("tenant_sms_sends")
        .update({ reconciled_at: new Date().toISOString() })
        .eq("id", r.id);
    }
  }
}
