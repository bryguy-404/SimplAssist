import "server-only";

import { publicAppOrigin } from "@/lib/billing/publicAppOrigin";
import { FULL_SUITE_PACKAGE_SUMMARY } from "@/lib/billing/fullSuitePresentation";
import { createWaitlistUnsubscribeToken } from "@/lib/waitlist/unsubscribeToken";
import { resend, RESEND_FROM } from "./client";

interface FullSuiteWaitlistConfirmationInput {
  signupId: string;
  email: string;
  requestOrigin: string;
  signal?: AbortSignal;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendFullSuiteWaitlistConfirmation(
  input: FullSuiteWaitlistConfirmationInput
): Promise<boolean> {
  try {
    const origin = publicAppOrigin(input.requestOrigin);
    const token = createWaitlistUnsubscribeToken(input.signupId);
    const unsubscribeUrl =
      `${origin}/waitlist/unsubscribe?token=${encodeURIComponent(token)}`;
    const safeUnsubscribeUrl = escapeHtml(unsubscribeUrl);

    const requestOptions = {
      idempotencyKey:
        `full-suite-waitlist-confirmation-v1/${input.signupId}`,
      ...(input.signal ? { signal: input.signal } : {}),
    } as Parameters<typeof resend.emails.send>[1] & {
      signal?: AbortSignal;
    };

    const result = await resend.emails.send(
      {
        from: RESEND_FROM,
        to: [input.email],
        subject: "You’re on the Full Suite waitlist",
        text: [
          "You’re on the Full Suite waitlist.",
          "",
          FULL_SUITE_PACKAGE_SUMMARY,
          "",
          "We’ll email you when Full Suite launches.",
          "",
          `Unsubscribe: ${unsubscribeUrl}`,
        ].join("\n"),
        html: [
          "<p>You’re on the Full Suite waitlist.</p>",
          `<p>${escapeHtml(FULL_SUITE_PACKAGE_SUMMARY)}</p>`,
          "<p>We’ll email you when Full Suite launches.</p>",
          `<p><a href="${safeUnsubscribeUrl}">Unsubscribe from Full Suite updates</a></p>`,
        ].join(""),
      },
      requestOptions
    );

    if (result.error || !result.data?.id) {
      console.error(
        "[email:fullSuiteWaitlist] confirmation send was not accepted"
      );
      return false;
    }

    return true;
  } catch {
    // Do not include the provider error, recipient, or signed URL in logs.
    console.error("[email:fullSuiteWaitlist] confirmation send failed");
    return false;
  }
}
