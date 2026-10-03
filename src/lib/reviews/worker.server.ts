import "server-only";
import { resend } from "@/lib/email/client";
import {
  isEmailReviewsEnabledForBusiness,
  isReviewEmailSendingEnabled,
} from "./config";
import { reviewRpc } from "./service.server";

type Outbox = {
  id: string;
  business_id: string;
  claim_token: string;
  idempotency_key: string;
  payload: Parameters<typeof resend.emails.send>[0];
};
export function classifyResendResult(
  error: unknown,
): "definite_failure" | "ambiguous" | "deferred" {
  const name =
    error && typeof error === "object" && "name" in error
      ? String(error.name)
      : "";
  // Only documented pre-send rejections release a quota reservation. Timeout,
  // transport failures and 5xx are ambiguous and retain the original payload/key.
  if (
    [
      "rate_limit_exceeded",
      "daily_quota_exceeded",
      "monthly_quota_exceeded",
      "invalid_api_key",
      "missing_api_key",
      "restricted_api_key",
      "invalid_access",
    ].includes(name)
  )
    return "deferred";
  return [
    "validation_error",
    "missing_required_field",
    "invalid_parameter",
    "invalid_idempotency_key",
    "method_not_allowed",
    "not_found",
  ].includes(name)
    ? "definite_failure"
    : "ambiguous";
}
export async function runReviewEmailWorker() {
  const applied = await reviewRpc<number>("review_apply_email_events");
  if (!isReviewEmailSendingEnabled())
    return { sent: 0, applied, disabled: true };
  const jobs = await reviewRpc<Outbox[]>("review_claim_emails", { p_limit: 2 });
  let sent = 0;
  for (const job of jobs) {
    if (
      !isEmailReviewsEnabledForBusiness(job.business_id) ||
      !isReviewEmailSendingEnabled()
    )
      continue;
    const ready = await reviewRpc<Outbox | null>("review_begin_email", {
      p_id: job.id,
      p_claim: job.claim_token,
    });
    if (!ready?.id) continue;
    // Deterministic delivery tag resolves callbacks that arrive before the API
    // response and distinguishes an initial request from its reminder.
    const payload = {
      ...ready.payload,
      tags: [
        ...(ready.payload.tags ?? []),
        { name: "review_delivery", value: ready.id },
      ],
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let outcome = "ambiguous",
      providerId: string | null = null,
      reason: string | null = null;
    try {
      const result = await Promise.race([
        resend.emails.send(payload, {
          idempotencyKey: ready.idempotency_key,
          signal: controller.signal,
        } as Parameters<typeof resend.emails.send>[1]),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener(
            "abort",
            () => reject(new Error("provider_timeout")),
            { once: true },
          ),
        ),
      ]);
      if (result.data?.id) {
        outcome = "accepted";
        providerId = result.data.id;
        sent++;
      } else {
        outcome = classifyResendResult(result.error);
        reason = result.error?.name ?? "provider_missing_id";
      }
    } catch {
      reason = "provider_transport_ambiguous";
    } finally {
      clearTimeout(timeout);
    }
    await reviewRpc("review_finish_email", {
      p_id: ready.id,
      p_claim: ready.claim_token,
      p_outcome: outcome,
      p_provider_id: providerId,
      p_error: reason,
    });
    await reviewRpc("review_apply_email_events");
  }
  return { sent, applied, disabled: false };
}
