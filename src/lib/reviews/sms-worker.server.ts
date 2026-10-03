import "server-only";
import {
  sendTenantSms,
  TenantSmsSendError,
} from "@/lib/messaging/tenantSmsSend.server";
import { isReviewSmsEnabled } from "@/lib/billing/reviewSmsRollout.server";
import { isEmailReviewsEnabledForBusiness } from "./config";
import { reviewRpc } from "./service.server";
type SmsJob = {
  id: string;
  business_id: string;
  enrollment_id: string;
  claim_token: string;
  kind: "initial" | "reminder";
  destination: string;
  sender: string;
  messaging_profile_id: string;
  body: string;
};
export async function runReviewSmsWorker() {
  const reconciled = await reviewRpc<number>("review_reconcile_sms_receipts");
  if (process.env.REVIEWS_SMS_SENDING_ENABLED !== "1")
    return { sent: 0, reconciled, disabled: true };
  const jobs = await reviewRpc<SmsJob[]>("review_claim_sms", { p_limit: 1 });
  let sent = 0;
  for (const job of jobs) {
    if (
      !isReviewSmsEnabled(job.business_id) ||
      !isEmailReviewsEnabledForBusiness(job.business_id) ||
      process.env.REVIEWS_SMS_SENDING_ENABLED !== "1"
    )
      continue;
    const ready = await reviewRpc<SmsJob | null>("review_begin_sms", {
      p_id: job.id,
      p_claim: job.claim_token,
    });
    if (!ready?.id) continue;
    try {
      const receipt = await sendTenantSms({
        businessId: ready.business_id,
        from: ready.sender,
        to: ready.destination,
        text: ready.body,
        messagingProfileId: ready.messaging_profile_id,
        purpose:
          ready.kind === "initial" ? "review_invitation" : "review_reminder",
        idempotencyKey: `review-sms/v1/${ready.id}`,
        reviewEnrollmentId: ready.enrollment_id,
      });
      await reviewRpc("review_finish_sms", {
        p_id: ready.id,
        p_claim: ready.claim_token,
        p_outcome: "accepted",
        p_provider_id: receipt.data.id,
        p_reservation: receipt.reservationId,
      });
      sent++;
    } catch (error) {
      const temporary =
        error instanceof TenantSmsSendError &&
        error.outcome === "not_sent" &&
        [
          "usage_limit_reached",
          "sms_usage_limit_reached",
          "sms_reservation_unavailable",
          "sms_preflight_unavailable",
          "plan_not_entitled",
          "sms_reviews_paused",
          "billing_required",
          "canceled",
          "texting_paused",
          "account_suspended",
          "sms_operations_paused",
          "sms_reviews_not_entitled",
          "telnyx_submission_disabled",
          "sms_usage_period_unavailable",
        ].includes(error.reason);
      await reviewRpc("review_finish_sms", {
        p_id: ready.id,
        p_claim: ready.claim_token,
        p_outcome: temporary
          ? "deferred"
          : error instanceof TenantSmsSendError
            ? error.outcome
            : "uncertain",
        p_error:
          error instanceof TenantSmsSendError
            ? error.reason
            : "sms_delivery_unknown",
      });
    }
  }
  return { sent, reconciled, disabled: false };
}
