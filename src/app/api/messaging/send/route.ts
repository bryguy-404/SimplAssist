import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as db } from "@/lib/supabase/admin";
import {
  getOutboundSendContext,
  smsBlockCode,
  smsBlockMessage,
} from "@/lib/messaging/lookup";
import {
  sendTenantSms,
  TenantSmsSendError,
} from "@/lib/messaging/tenantSmsSend.server";
import {
  decideFeatureAccess,
  resolveBusinessEntitlements,
} from "@/lib/billing/entitlements";
import {
  requireFreshWorkspaceRouteAccess,
  requireWorkspaceRouteAccess,
} from "@/lib/customer/workspaceRouteResponse.server";
import { customerWorkspaceEnabled } from "@/lib/billing/customerReviewsRollout.server";
import { normalizePhone } from "@/lib/customers/domain";

function normalizedPhone(value: string | null | undefined) {
  try {
    return normalizePhone(value ?? "");
  } catch {
    return null;
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function reviewReplyDestination(
  businessId: string,
  conversationId: string,
) {
  if (!customerWorkspaceEnabled(businessId)) return null;
  const [access, hold] = await Promise.all([
    db.rpc("has_review_sms_access", { p_business_id: businessId }),
    db
      .from("tenant_sms_human_holds")
      .select("destination")
      .eq("business_id", businessId)
      .eq("conversation_id", conversationId)
      .is("released_at", null)
      .maybeSingle(),
  ]);
  if (access.error || hold.error)
    throw new Error("SMS reply eligibility unavailable");
  const destination = hold.data?.destination;
  return access.data === true &&
    typeof destination === "string" &&
    /^\+[1-9]\d{7,14}$/.test(destination)
    ? destination
    : null;
}
export async function GET(request: NextRequest) {
  const gate = await requireWorkspaceRouteAccess();
  if (!gate.ok) return gate.response;
  const id = request.nextUrl.searchParams.get("conversationId") ?? "";
  if (!UUID.test(id)) return NextResponse.json({ reviewReplyAllowed: false });
  try {
    const destination = await reviewReplyDestination(
      gate.access.business.id,
      id,
    );
    return NextResponse.json(
      {
        reviewReplyAllowed: destination !== null,
        destination,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Reply access unavailable" },
      { status: 503 },
    );
  }
}
export async function POST(request: NextRequest) {
  const gate = await requireFreshWorkspaceRouteAccess();
  if (!gate.ok) return gate.response;
  try {
    const raw = await request.text();
    if (raw.length > 20000)
      return NextResponse.json({ error: "Message too long" }, { status: 400 });
    const body = JSON.parse(raw) as Record<string, unknown>;
    const { to, message, conversationId, requestId } = body;
    const businessId = gate.access.business.id;
    if (
      typeof to !== "string" ||
      !/^\+[1-9]\d{7,14}$/.test(to) ||
      typeof message !== "string" ||
      !message.trim() ||
      message.length > 16000 ||
      typeof conversationId !== "string" ||
      !UUID.test(conversationId) ||
      typeof requestId !== "string" ||
      !UUID.test(requestId) ||
      (body.businessId && body.businessId !== businessId)
    )
      return NextResponse.json(
        { error: "Invalid message request" },
        { status: 400 },
      );
    const conversation = await db
      .from("conversations")
      .select(
        "id,is_ai_handling,channel,contact:contacts(phone_number,provided_phone_number)",
      )
      .eq("id", conversationId)
      .eq("business_id", businessId)
      .maybeSingle();
    if (conversation.error) throw new Error("Conversation lookup failed");
    const contact = conversation.data?.contact as unknown as {
      phone_number: string | null;
      provided_phone_number: string | null;
    } | null;
    if (
      !conversation.data ||
      conversation.data.channel !== "sms" ||
      !contact ||
      ![contact.phone_number, contact.provided_phone_number]
        .map(normalizedPhone)
        .includes(to)
    )
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 },
      );
    if (conversation.data.is_ai_handling)
      return NextResponse.json(
        { error: "Switch this conversation to Human before replying." },
        { status: 409 },
      );
    const reviewDestination = await reviewReplyDestination(
      businessId,
      conversationId,
    );
    const review = reviewDestination !== null;
    if (review && reviewDestination !== to)
      return NextResponse.json(
        { error: "Review reply destination changed" },
        { status: 409 },
      );
    const access = decideFeatureAccess(
      await resolveBusinessEntitlements(businessId),
      "manual_sms",
    );
    if (!review && !access.allowed)
      return NextResponse.json(
        { error: "SMS sending is not available on the current plan" },
        { status: 403 },
      );
    const phone = await db
      .from("phone_numbers")
      .select("phone_number")
      .eq("business_id", businessId)
      .eq("is_active", true)
      .maybeSingle();
    if (phone.error) throw new Error("Sender lookup failed");
    if (!phone.data)
      return NextResponse.json(
        { error: "No active phone number found" },
        { status: 404 },
      );
    const send = await getOutboundSendContext(phone.data.phone_number);
    if (
      !send.smsReady ||
      !send.messagingProfileId ||
      send.businessId !== businessId
    )
      return NextResponse.json(
        {
          error: smsBlockCode(send.blockReason),
          message: smsBlockMessage(send.blockReason),
        },
        { status: 403 },
      );
    const accepted = await sendTenantSms({
      businessId,
      from: phone.data.phone_number,
      to,
      text: message,
      messagingProfileId: send.messagingProfileId,
      purpose: review ? "review_reply" : "manual_dashboard_send",
      idempotencyKey: `dashboard:${requestId}`,
      conversationId,
    });
    // The server owns a retry-stable transcript key. Browser retries cannot
    // produce a second provider send or a duplicate message bubble.
    const key = `tenant-sms:${accepted.reservationId}`;
    const saved = await db.from("messages").insert({
      conversation_id: conversationId,
      business_id: businessId,
      role: "human_agent",
      content: message,
      channel: "sms",
      provider_event_id: key,
    });
    const transcript = await db
      .from("messages")
      .select("*")
      .eq("business_id", businessId)
      .eq("provider_event_id", key)
      .maybeSingle();
    if (
      (saved.error && saved.error.code !== "23505") ||
      transcript.error ||
      !transcript.data
    )
      return NextResponse.json({
        success: true,
        id: accepted.data.id,
        transcriptPending: true,
        message:
          "The text was accepted, but its transcript is still being saved. Do not resend it.",
      });
    await db
      .from("conversations")
      .update({ last_message_at: transcript.data.created_at })
      .eq("id", conversationId)
      .eq("business_id", businessId);
    return NextResponse.json({
      success: true,
      id: accepted.data.id,
      messageRecord: transcript.data,
    });
  } catch (error) {
    if (error instanceof TenantSmsSendError)
      return NextResponse.json(
        { error: error.reason, message: error.message, outcome: error.outcome },
        { status: error.outcome === "uncertain" ? 409 : 403 },
      );
    if (error instanceof SyntaxError)
      return NextResponse.json(
        { error: "Invalid message request" },
        { status: 400 },
      );
    console.error("[messaging/send] SMS request failed", error);
    return NextResponse.json(
      {
        error: "service_state_unavailable",
        message:
          "SMS status is unavailable. Retry this same request to check its status.",
      },
      { status: 503 },
    );
  }
}
