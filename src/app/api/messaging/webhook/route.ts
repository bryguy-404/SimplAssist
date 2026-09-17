import { acknowledgeBookingSummary } from '@/lib/booking/drafts.server';
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { telnyx } from "@/lib/messaging/client";
import { getOutboundSendContext } from "@/lib/messaging/lookup";
import {
  insertPausedSystemMessageIfNeeded,
  type PausedReason,
} from "@/lib/messaging/pausedNotice";
import {
  isOutboundSmsOperationalBlockReason,
  resolveOutboundSmsOperationalAccess,
  type OutboundSmsPurpose,
} from "@/lib/messaging/outboundSmsOperational.server";
import {
  claimMessagingWebhookEvent,
  completeMessagingWebhookEvent,
  releaseMessagingWebhookClaim,
} from "@/lib/messaging/idempotency";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  AIProcessingBlockedError,
  processIncomingMessageDetailed,
} from "@/lib/ai/engine";
import { finalizeGoalLinkEvent } from "@/lib/ai/goalEvents";
import { recordKnowledgeGap } from "@/lib/ai/knowledgeGaps";
import { findOrCreateContact } from "@/lib/ai/contacts";
import {
  addInboundMessageOnce,
  addMessage,
  getConversationAiState,
  getOrCreateConversation,
  isAiHandlingActive,
} from "@/lib/ai/conversations";
import {
  canUseFeature,
  resolveBusinessEntitlements,
} from "@/lib/billing/entitlements";
import type {
  Contact,
  Conversation,
  SmsBlockReason,
} from "@/types/database";
import {
  preflightOutboundSms,
  recordInboundMessagingUsage,
  recordOutboundSmsUsage,
  type UsageBlockReason,
} from "@/lib/billing/usage";
import { buildAiConversationSourceKey } from "@/lib/metrics/sourceKeys.server";
import { recordBusinessMetricEventBestEffort } from "@/lib/metrics/recording.server";

const MMS_FALLBACK_MESSAGE =
  "I can't process images yet — please describe what you need in text and I'll help.";

interface TelnyxMessagePayload {
  from?: { phone_number?: string };
  to?: Array<{ phone_number?: string }>;
  text?: string;
  media?: unknown[];
}

interface PersistedInboundContext {
  businessId: string;
  from: string;
  to: string;
  text: string;
  mediaCount: number;
  appendAiOptOut: boolean;
  sourceMessageId: string;
  contact: Contact;
  conversation: Conversation;
}

// Telnyx posts all messaging event types to this endpoint. For an inbound
// message we synchronously establish entitlement state and durably persist the
// usage + transcript before acknowledging. Known plan/manual denials are
// successful no-op automation decisions (200); indeterminate DB/persistence
// failures release the claim and return 500 so Telnyx can redeliver the lead.
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  let event: unknown;
  try {
    event = await telnyx.webhooks.unwrap(rawBody, { headers });
  } catch (error) {
    console.warn("[messaging:webhook] Signature verification failed:", error);
    return new NextResponse("Forbidden", { status: 403 });
  }

  const eventData = (
    event as {
      data?: { id?: string; event_type?: string; payload?: unknown };
    }
  ).data;
  const eventType = eventData?.event_type;
  const providerEventId = eventData?.id;

  console.log(
    `[messaging:webhook] event_type=${eventType} event_id=${providerEventId}`
  );

  if (eventType !== "message.received") {
    console.log(`[messaging:webhook] Ignoring non-inbound event: ${eventType}`);
    return new NextResponse("OK", { status: 200 });
  }

  const eventKey = messageEventKey(providerEventId, rawBody);
  let claimToken: string | null = null;
  try {
    const claim = await claimMessagingWebhookEvent(eventKey);
    if (claim.outcome === "completed") {
      console.log(
        `[messaging:webhook] Idempotency: event ${eventKey} already completed, skipping`
      );
      return new NextResponse("OK", { status: 200 });
    }
    if (claim.outcome === "in_progress") {
      // Do not acknowledge a duplicate while its holder is still working. If
      // that holder fails, this delivery's retry can acquire the released (or
      // stale) claim instead of silently losing the lead.
      console.warn(
        `[messaging:webhook] Event ${eventKey} is still in progress; requesting retry`
      );
      return new NextResponse("Retry", { status: 500 });
    }
    claimToken = claim.claimToken;
  } catch (error) {
    console.error(
      `[messaging:webhook] Failed to claim event ${eventKey}:`,
      error
    );
    return new NextResponse("Retry", { status: 500 });
  }

  if (!claimToken) {
    console.error(
      `[messaging:webhook] Claim RPC did not provide an owner token for ${eventKey}`
    );
    return new NextResponse("Retry", { status: 500 });
  }
  const ownedClaimToken = claimToken;

  try {
    const payload = eventData?.payload as TelnyxMessagePayload | undefined;
    if (!payload) {
      console.warn("[messaging:webhook] Missing message.received payload");
      await completeMessagingWebhookEvent(eventKey, ownedClaimToken);
      return new NextResponse("OK", { status: 200 });
    }

    const from = payload.from?.phone_number;
    const to = payload.to?.[0]?.phone_number;
    const text = payload.text ?? "";
    const mediaCount = payload.media?.length ?? 0;

    if (!from || !to) {
      console.warn(
        `[messaging:webhook] Missing from or to: from=${from} to=${to}`
      );
      await completeMessagingWebhookEvent(eventKey, ownedClaimToken);
      return new NextResponse("OK", { status: 200 });
    }

    console.log(
      `[messaging:webhook] message.received from=${from} to=${to} text.length=${text.length} media.count=${mediaCount}`
    );

    const { data: phoneNumberRow, error: lookupError } = await supabaseAdmin
      .from("phone_numbers")
      .select("business_id")
      .eq("phone_number", to)
      .eq("is_active", true)
      .maybeSingle<{ business_id: string }>();

    if (lookupError) {
      throw new Error(
        `[messaging:webhook] Phone lookup failed for ${to}: ${lookupError.message}`
      );
    }
    if (!phoneNumberRow) {
      // This destination is not ours. A retry cannot make the payload valid.
      console.warn(`[messaging:webhook] No active business found for to=${to}`);
      await completeMessagingWebhookEvent(eventKey, ownedClaimToken);
      return new NextResponse("OK", { status: 200 });
    }

    const businessId = phoneNumberRow.business_id;
    const entitlements = await resolveBusinessEntitlements(businessId);
    const canUseAi = canUseFeature(entitlements, "ai_sms_conversations");

    const contact = await findOrCreateContact(
      businessId,
      from,
      null,
      "sms"
    );
    const conversation = await getOrCreateConversation(
      businessId,
      contact.id,
      "sms",
      { defaultAiHandling: canUseAi }
    );

    // These writes are independently idempotent by the same deterministic
    // key. If either succeeds and the other fails, release+retry heals the
    // missing side without double-counting or duplicating the transcript.
    await recordInboundMessagingUsage({
      businessId,
      text,
      mediaCount,
      source: "telnyx_message_received",
      providerEventId: eventKey,
      metadata: { from, to, telnyxEventId: providerEventId ?? null },
    });
    const inboundMessage = await addInboundMessageOnce(
      conversation.id,
      businessId,
      text,
      "sms",
      eventKey
    );

    const automatedReplyPurpose: Extract<
      OutboundSmsPurpose,
      "ai_reply" | "mms_fallback"
    > =
      mediaCount > 0 && text.trim().length < 5
        ? "mms_fallback"
        : "ai_reply";
    if (
      !(await canSendOutboundSmsOperationally(
        { businessId, conversation },
        automatedReplyPurpose
      ))
    ) {
      // The inbound usage + transcript are durable, and a known pause cannot
      // be healed by provider redelivery. Complete the claim so reactivation
      // applies only to newly delivered inbound events.
      await completeMessagingWebhookEvent(eventKey, ownedClaimToken);
      return new NextResponse("OK", { status: 200 });
    }

    if (!canUseAi) {
      console.log(
        `[messaging:webhook] Inbound message saved; AI SMS is not entitled for business ${businessId}`
      );
      await completeMessagingWebhookEvent(eventKey, ownedClaimToken);
      return new NextResponse("OK", { status: 200 });
    }

    if (!isAiHandlingActive(conversation)) {
      console.log(
        `[messaging:webhook] Inbound message saved in Human mode for conversation ${conversation.id}`
      );
      await completeMessagingWebhookEvent(eventKey, ownedClaimToken);
      return new NextResponse("OK", { status: 200 });
    }

    // Contact creation is not a retry-stable proxy for the first outbound
    // message: a failed attempt may have created the contact but not sent a
    // reply. Base compliance copy on the durable transcript instead.
    const appendAiOptOut = await shouldAppendAiOptOut(conversation.id);
    const context: PersistedInboundContext = {
      businessId,
      from,
      to,
      text,
      mediaCount,
      appendAiOptOut,
      sourceMessageId: inboundMessage.id,
      contact,
      conversation,
    };

    // The durable inbound work is complete. Mark the claim finished before
    // launching any best-effort automated reply so a claim database failure
    // can never coexist with an outbound AI message.
    await completeMessagingWebhookEvent(eventKey, ownedClaimToken);

    if (mediaCount > 0 && text.trim().length < 5) {
      dispatchInBackground(
        sendFallbackReply(context),
        "MMS fallback processing"
      );
    } else {
      dispatchInBackground(processAndReply(context), "AI reply processing");
    }

    return new NextResponse("OK", { status: 200 });
  } catch (error) {
    console.error(
      `[messaging:webhook] Retryable processing failure for ${eventKey}:`,
      error
    );
    try {
      await releaseMessagingWebhookClaim(eventKey, ownedClaimToken);
    } catch (releaseError) {
      console.error(
        `[messaging:webhook] Failed to release event ${eventKey}:`,
        releaseError
      );
    }
    return new NextResponse("Retry", { status: 500 });
  }
}

async function sendFallbackReply(
  context: PersistedInboundContext
): Promise<void> {
  if (!(await canStillSendAutomatedReply(context, "mms_fallback"))) return;

  const fallbackReply = context.appendAiOptOut
    ? `${MMS_FALLBACK_MESSAGE}\n\nReply STOP to opt out.`
    : MMS_FALLBACK_MESSAGE;

  const sendContext = await getOutboundSendContext(context.to);
  assertSendContextBusiness(sendContext.businessId, context.businessId);

  if (!sendContext.smsReady) {
    console.warn(
      `[messaging:webhook] MMS fallback blocked: reason=${sendContext.blockReason} campaign_status=${sendContext.campaignStatus} assignment_status=${sendContext.assignmentStatus} for business ${context.businessId}`
    );
    await insertPausedSystemMessageIfNeeded({
      conversationId: context.conversation.id,
      businessId: context.businessId,
      channel: "sms",
      context: "mms_fallback",
      reason: toPausedReason(sendContext.blockReason),
    });
    return;
  }

  const usage = await preflightOutboundSms({
    businessId: context.businessId,
    text: fallbackReply,
    purpose: "mms_fallback",
  });
  if (!usage.allowed) {
    console.warn(
      `[messaging:webhook] MMS fallback blocked by usage gate: reason=${usage.reason} for business ${context.businessId}`
    );
    await insertPausedSystemMessageIfNeeded({
      conversationId: context.conversation.id,
      businessId: context.businessId,
      channel: "sms",
      context: "mms_fallback",
      reason: usageToPausedReason(usage.reason),
    });
    return;
  }

  if (!sendContext.messagingProfileId) {
    throw new Error(
      `[messaging:webhook] Missing messaging profile for ${context.to}`
    );
  }

  // Human takeover or a downgrade may have happened while preflight ran.
  if (!(await canStillSendAutomatedReply(context, "mms_fallback"))) return;

  const result = await telnyx.messages.send({
    from: context.to,
    to: context.from,
    text: fallbackReply,
    messaging_profile_id: sendContext.messagingProfileId,
    type: "SMS",
  });
  await addMessage(
    context.conversation.id,
    context.businessId,
    "assistant",
    fallbackReply,
    "sms"
  );
  await recordOutboundSmsUsage({
    businessId: context.businessId,
    text: fallbackReply,
    source: "mms_fallback",
    providerMessageId: result.data?.id ?? null,
    idempotencyKey: result.data?.id
      ? `outbound:mms_fallback:${result.data.id}`
      : undefined,
    metadata: { from: context.to, to: context.from },
  });
}

async function processAndReply(
  context: PersistedInboundContext
): Promise<void> {
  const sendContext = await getOutboundSendContext(context.to);
  assertSendContextBusiness(sendContext.businessId, context.businessId);

  if (!sendContext.smsReady) {
    console.warn(
      `[messaging:webhook] AI reply blocked: reason=${sendContext.blockReason} campaign_status=${sendContext.campaignStatus} assignment_status=${sendContext.assignmentStatus} for business ${context.businessId}`
    );
    await insertPausedSystemMessageIfNeeded({
      conversationId: context.conversation.id,
      businessId: context.businessId,
      channel: "sms",
      context: "ai_reply",
      reason: toPausedReason(sendContext.blockReason),
    });
    return;
  }

  if (!sendContext.messagingProfileId) {
    throw new Error(
      `[messaging:webhook] Missing messaging profile for ${context.to}`
    );
  }

  console.log(
    `[messaging:webhook] Generating AI reply (appendOptOut=${context.appendAiOptOut})`
  );
  let aiResult;
  try {
    aiResult = await processIncomingMessageDetailed(
      context.businessId,
      context.from,
      null,
      context.text,
      "sms",
      null,
      {
        persistCustomer: false,
        persistAssistant: false,
        sourceMessageId: context.sourceMessageId,
        contact: context.contact,
        conversation: context.conversation,
      }
    );
  } catch (error) {
    if (!isOperationalAiProcessingBlock(error)) throw error;

    console.warn(
      `[messaging:webhook] AI reply suppressed by AI engine operational control: reason=${error.reason} for business ${context.businessId}`
    );
    await insertPausedSystemMessageIfNeeded({
      conversationId: context.conversation.id,
      businessId: context.businessId,
      channel: "sms",
      context: "ai_reply",
      reason: error.reason,
    });
    return;
  }

  const { data: aiSettings, error: settingsError } = await supabaseAdmin
    .from("ai_settings")
    .select("sms_response_delay_seconds")
    .eq("business_id", context.businessId)
    .maybeSingle<{ sms_response_delay_seconds: number }>();
  if (settingsError) {
    throw new Error(
      `[messaging:webhook] AI delay lookup failed: ${settingsError.message}`
    );
  }

  const delayMs = (aiSettings?.sms_response_delay_seconds ?? 0) * 1000;
  if (delayMs > 0) {
    console.log(`[messaging:webhook] Applying delay: ${delayMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  // Re-read both billing and takeover state immediately before billing/send.
  // This prevents a delayed AI response from racing a downgrade or a human
  // agent who took control while Anthropic was working.
  if (!(await canStillSendAutomatedReply(context, "ai_reply"))) return;

  const finalReply = context.appendAiOptOut
    ? `${aiResult.text}\n\nReply STOP to opt out.`
    : aiResult.text;
  const usage = await preflightOutboundSms({
    businessId: context.businessId,
    text: finalReply,
    purpose: "ai_reply",
  });
  if (!usage.allowed) {
    console.warn(
      `[messaging:webhook] AI reply blocked by usage gate: reason=${usage.reason} for business ${context.businessId}`
    );
    await insertPausedSystemMessageIfNeeded({
      conversationId: context.conversation.id,
      businessId: context.businessId,
      channel: "sms",
      context: "ai_reply",
      reason: usageToPausedReason(usage.reason),
    });
    return;
  }

  if (!(await canStillSendAutomatedReply(context, "ai_reply"))) return;

  const result = await telnyx.messages.send({
    from: context.to,
    to: context.from,
    text: finalReply,
    messaging_profile_id: sendContext.messagingProfileId,
    type: "SMS",
  });
  const occurredAt = new Date();
  try {
    recordBusinessMetricEventBestEffort({
      businessId: context.businessId,
      metricKey: "ai_conversation_engaged",
      quantity: 1,
      occurredAt,
      sourceKey: buildAiConversationSourceKey(
        context.conversation.id,
        occurredAt
      ),
      origin: null,
    });
  } catch {
    console.error("[messaging:webhook] Metric recording failed:", {
      businessId: context.businessId,
      metricKey: "ai_conversation_engaged",
    });
  }
  const assistantMessage = await addMessage(
    context.conversation.id,
    context.businessId,
    "assistant",
    finalReply,
    "sms"
  );
  if (aiResult.bookingReview && result.data?.id) {
    await acknowledgeBookingSummary({ businessId: context.businessId, draftId: aiResult.bookingReview.draftId, revision: aiResult.bookingReview.revision, messageId: assistantMessage.id, providerMessageId: result.data.id });
  }
  for (const action of aiResult.actions ?? []) {
    try {
      await finalizeGoalLinkEvent({
        businessId: context.businessId,
        action,
        assistantMessageId: assistantMessage.id,
        occurredAt,
      });
    } catch (error) {
      console.error(
        "[messaging:webhook] Goal event finalization failed:",
        {
          businessId: context.businessId,
          conversationId: context.conversation.id,
          sourceMessageId: action.sourceMessageId,
          assistantMessageId: assistantMessage.id,
        },
        error
      );
    }
  }
  await recordOutboundSmsUsage({
    businessId: context.businessId,
    text: finalReply,
    source: "ai_reply",
    providerMessageId: result.data?.id ?? null,
    idempotencyKey: result.data?.id
      ? `outbound:ai_reply:${result.data.id}`
      : undefined,
    metadata: { from: context.to, to: context.from },
  });
  if (aiResult.knowledgeGapDetected && aiResult.sourceMessageId) {
    const sourceMessageId = aiResult.sourceMessageId;
    try {
      await recordKnowledgeGap({
        businessId: context.businessId,
        sourceMessageId,
        aiResponseText: finalReply,
      });
    } catch (error) {
      console.error(
        "[messaging:webhook] Knowledge gap capture failed:",
        { businessId: context.businessId, sourceMessageId },
        error
      );
    }
  }
}

async function shouldAppendAiOptOut(conversationId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("role", "assistant")
    .eq("channel", "sms")
    .limit(1)
    .maybeSingle<{ id: string }>();

  if (error) {
    throw new Error(
      `[messaging:webhook] Failed to determine prior SMS replies for conversation ${conversationId}: ${error.message}`
    );
  }
  return !data;
}

async function canStillSendAutomatedReply(
  context: Pick<
    PersistedInboundContext,
    "businessId" | "conversation"
  >,
  purpose: Extract<OutboundSmsPurpose, "ai_reply" | "mms_fallback">
): Promise<boolean> {
  const [entitlements, conversation] = await Promise.all([
    resolveBusinessEntitlements(context.businessId),
    getConversationAiState(context.conversation.id),
  ]);
  if (
    !canUseFeature(entitlements, "ai_sms_conversations") ||
    !isAiHandlingActive(conversation)
  ) {
    return false;
  }

  // Keep the uncached operational resolver as the final await in this
  // decision. On the pre-send call, this preserves Diff 3A's narrowest
  // possible state-read-to-Telnyx race window. Resolver uncertainty throws so
  // the background path fails closed rather than treating it as allowed.
  return canSendOutboundSmsOperationally(context, purpose);
}

function isOperationalAiProcessingBlock(
  error: unknown
): error is AIProcessingBlockedError & {
  reason: Extract<
    PausedReason,
    "account_suspended" | "texting_paused" | "ai_replies_paused"
  >;
} {
  return (
    error instanceof AIProcessingBlockedError &&
    (error.reason === "account_suspended" ||
      error.reason === "texting_paused" ||
      error.reason === "ai_replies_paused")
  );
}

async function canSendOutboundSmsOperationally(
  context: Pick<PersistedInboundContext, "businessId" | "conversation">,
  purpose: Extract<OutboundSmsPurpose, "ai_reply" | "mms_fallback">
): Promise<boolean> {
  const access = await resolveOutboundSmsOperationalAccess(
    context.businessId,
    purpose
  );
  if (access.allowed) return true;

  console.warn(
    `[messaging:webhook] ${purpose} blocked by operational controls: reason=${access.reason} for business ${context.businessId}`
  );
  await insertPausedSystemMessageIfNeeded({
    conversationId: context.conversation.id,
    businessId: context.businessId,
    channel: "sms",
    context: purpose,
    reason: access.reason,
  });
  return false;
}

function messageEventKey(eventId: string | undefined, rawBody: string): string {
  const stableId =
    eventId?.trim() || createHash("sha256").update(rawBody).digest("hex");
  return `telnyx:message.received:${stableId}`;
}

function dispatchInBackground(promise: Promise<void>, label: string): void {
  promise.catch((error) => {
    console.error(`[messaging:webhook] ${label} failed:`, error);
  });
}

function assertSendContextBusiness(
  resolvedBusinessId: string,
  expectedBusinessId: string
): void {
  if (resolvedBusinessId !== expectedBusinessId) {
    throw new Error(
      `[messaging:webhook] Outbound number resolved to business ${resolvedBusinessId}, expected ${expectedBusinessId}.`
    );
  }
}

function toPausedReason(
  reason: SmsBlockReason | null
): "campaign_not_approved" | "assignment_pending" | "assignment_failed" {
  if (reason === "assignment_failed") return "assignment_failed";
  if (reason === "assignment_pending") return "assignment_pending";
  return "campaign_not_approved";
}

function usageToPausedReason(
  reason: UsageBlockReason
): PausedReason {
  if (isOutboundSmsOperationalBlockReason(reason)) return reason;
  if (reason === "usage_limit_reached") return "usage_limit_reached";
  if (reason === "telnyx_submission_disabled") {
    return "submission_disabled";
  }
  return "billing_paused";
}
