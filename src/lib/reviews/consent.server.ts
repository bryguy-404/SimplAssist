import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isReviewSmsEnabled } from "@/lib/billing/reviewSmsRollout.server";
import {
  sendTenantSms,
  TenantSmsSendError,
} from "@/lib/messaging/tenantSmsSend.server";
import {
  isReviewConsentKeyword,
  REVIEW_TEXT_CONSENT_VERSION,
  reviewConsentConfirmation,
} from "./consentCopy";

/** Called only after signature verification and durable inbound persistence.
 * The keyword is always consumed, even when this business cannot accept it. */
export async function processReviewTextConsent(args: {
  businessId: string;
  messagingProfileId: string;
  from: string;
  to: string;
  text: string;
  conversationId: string;
  sourceMessageId: string;
  providerMessageId?: string;
  occurredAt?: string;
}) {
  if (!isReviewConsentKeyword(args.text)) return false;
  if (!isReviewSmsEnabled(args.businessId)) return true;
  // Never infer phone ownership from an unsigned browser form or an event
  // without the actual provider message identity and original timestamp.
  if (
    !args.providerMessageId ||
    !args.occurredAt ||
    !Number.isFinite(Date.parse(args.occurredAt))
  )
    return true;
  const { data, error } = await supabaseAdmin.rpc("review_record_sms_consent", {
    p_business: args.businessId,
    p_profile: args.messagingProfileId,
    p_from: args.from,
    p_to: args.to,
    p_conversation: args.conversationId,
    p_source_message: args.sourceMessageId,
    p_provider_message: args.providerMessageId,
    p_occurred_at: args.occurredAt,
    p_copy_version: REVIEW_TEXT_CONSENT_VERSION,
  });
  if (error || !data)
    throw new Error("Review text consent persistence unavailable");
  if (
    !data.granted ||
    !data.canConfirm ||
    process.env.REVIEWS_SMS_SENDING_ENABLED !== "1"
  )
    return true;
  try {
    await sendTenantSms({
      businessId: args.businessId,
      messagingProfileId: args.messagingProfileId,
      from: args.to,
      to: args.from,
      conversationId: args.conversationId,
      text: reviewConsentConfirmation(data.businessName),
      purpose: "review_consent_confirmation",
      idempotencyKey: `review-consent/v1/${args.providerMessageId}`,
    });
  } catch (error) {
    // Once reserved, the shared send path prevents provider retries after
    // unknown acceptance. Admission failures can be retried by the webhook.
    if (!(error instanceof TenantSmsSendError)) throw error;
    if (
      ["sms_preflight_unavailable", "sms_reservation_unavailable"].includes(
        error.reason,
      )
    )
      throw error;
  }
  return true;
}
