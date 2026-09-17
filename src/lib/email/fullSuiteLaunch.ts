import "server-only";
import { FULL_SUITE_PACKAGE_SUMMARY } from "@/lib/billing/fullSuitePresentation";

import { randomUUID } from "node:crypto";
import { publicAppOrigin } from "@/lib/billing/publicAppOrigin";
import { createWaitlistUnsubscribeToken } from "@/lib/waitlist/unsubscribeToken";
import { resend, RESEND_FROM } from "./client";
import { scheduleFullSuiteLaunchResend } from "./fullSuiteLaunchRateLimit";

export type FullSuiteLaunchSendOutcome =
  | "accepted"
  | "definite_failure"
  | "ambiguous"
  | "cancelled";

type FullSuiteLaunchRecipient =
  | {
      kind: "launch";
      signupId: string;
      email: string;
      requestOrigin: string;
    }
  | {
      kind: "test";
      email: string;
      requestOrigin: string;
    };

const DEFINITE_NO_SEND_ERRORS = new Set([
  "missing_required_field",
  "invalid_idempotency_key",
  "restricted_api_key",
  "invalid_api_key",
  // Resend 4.8's TypeScript union contains this legacy capitalization.
  "invalid_api_Key",
  "invalid_access",
  "invalid_parameter",
  "invalid_region",
  "rate_limit_exceeded",
  "daily_quota_exceeded",
  "monthly_quota_exceeded",
  "missing_api_key",
  "invalid_from_address",
  "invalid_attachment",
  "validation_error",
  "not_found",
  "method_not_allowed",
  "security_error",
]);

const RESEND_PROVIDER_TIMEOUT_MS = 15_000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendWithProviderTimeout(
  message: Parameters<typeof resend.emails.send>[0],
  idempotencyKey: string
): Promise<
  | {
      timedOut: false;
      result: Awaited<ReturnType<typeof resend.emails.send>>;
    }
  | { timedOut: true }
> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const providerRequest = resend.emails
    .send(message, {
      idempotencyKey,
      // Resend 4.8 forwards request options to fetch at runtime, but its
      // published request-options type does not yet expose AbortSignal.
      signal: controller.signal,
    } as Parameters<typeof resend.emails.send>[1] & {
      signal: AbortSignal;
    })
    .then((result) => ({ timedOut: false, result }) as const);

  const deadline = new Promise<{ timedOut: true }>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve({ timedOut: true });
    }, RESEND_PROVIDER_TIMEOUT_MS);
  });

  try {
    return await Promise.race([providerRequest, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function sendFullSuiteLaunchEmail(
  recipient: FullSuiteLaunchRecipient,
  beforeProviderSend?: () => Promise<boolean>
): Promise<FullSuiteLaunchSendOutcome> {
  let message: Parameters<typeof resend.emails.send>[0];
  let idempotencyKey: string;

  try {
    const origin = publicAppOrigin(recipient.requestOrigin);
    const pricingUrl = `${origin}/#pricing`;
    const unsubscribeUrl =
      recipient.kind === "launch"
        ? `${origin}/waitlist/unsubscribe?token=${encodeURIComponent(
            createWaitlistUnsubscribeToken(recipient.signupId)
          )}`
        : `${origin}/waitlist/unsubscribed?preview=1`;
    const subjectPrefix = recipient.kind === "test" ? "[TEST] " : "";
    idempotencyKey =
      recipient.kind === "launch"
        ? `full-suite-launch-v1/${recipient.signupId}`
        : `full-suite-launch-test-v1/${randomUUID()}`;

    // Launch-day approval required: Bryan must approve the final subject,
    // announcement, teaser, and CTA copy before any bulk send.
    message = {
      from: RESEND_FROM,
      to: [recipient.email],
      subject: `${subjectPrefix}Full Suite is live 🎉`,
      text: [
        "Full Suite is live.",
        "",
        FULL_SUITE_PACKAGE_SUMMARY,
        "",
        `Explore Full Suite: ${pricingUrl}`,
        "",
        `Unsubscribe: ${unsubscribeUrl}`,
      ].join("\n"),
      html: [
        "<p><strong>Full Suite is live.</strong></p>",
        `<p>${escapeHtml(FULL_SUITE_PACKAGE_SUMMARY)}</p>`,
        `<p><a href="${escapeHtml(pricingUrl)}">Explore Full Suite</a></p>`,
        `<p><a href="${escapeHtml(
          unsubscribeUrl
        )}">Unsubscribe from Full Suite updates</a></p>`,
      ].join(""),
    };
  } catch {
    // Configuration and message construction happen before Resend can be
    // called, so these are definite no-send failures and may be retried.
    console.error("[email:fullSuiteLaunch] message construction failed");
    return "definite_failure";
  }

  try {
    const scheduled = await scheduleFullSuiteLaunchResend(
      () => sendWithProviderTimeout(message, idempotencyKey),
      beforeProviderSend
    );

    if (!scheduled.started) return "cancelled";

    if (scheduled.value.timedOut) {
      console.error(
        "[email:fullSuiteLaunch] provider deadline exceeded; acceptance is ambiguous"
      );
      return "ambiguous";
    }

    const result = scheduled.value.result;
    if (result.error) {
      if (DEFINITE_NO_SEND_ERRORS.has(result.error.name)) {
        console.error(
          "[email:fullSuiteLaunch] provider returned a definite failure"
        );
        return "definite_failure";
      }

      console.error(
        "[email:fullSuiteLaunch] provider acceptance is ambiguous"
      );
      return "ambiguous";
    }

    if (
      typeof result.data?.id !== "string" ||
      result.data.id.trim().length === 0
    ) {
      console.error(
        "[email:fullSuiteLaunch] provider acceptance is ambiguous"
      );
      return "ambiguous";
    }

    return "accepted";
  } catch {
    // Provider/configuration errors may contain recipient addresses, signed
    // URLs, or secrets, so only log the outcome classification.
    console.error("[email:fullSuiteLaunch] provider outcome is ambiguous");
    return "ambiguous";
  }
}
