import "server-only";

import { SUPPORT_EMAIL } from "@/lib/support/constants";
import { resend, RESEND_FROM } from "./client";
import type { RenderedGiftCodeEmail } from "./giftCodeTemplate";

/**
 * Sends one already-rendered coupon email through the existing Resend setup.
 * This is a SimplAssist-to-prospect email, so it always uses SimplAssist's own
 * sender; replies go to Bryan. Throws when Resend does not accept it.
 */
export async function sendGiftCodeEmail(args: {
  recipient: string;
  email: RenderedGiftCodeEmail;
  /** Makes a retried request a single delivery. */
  idempotencyKey: string;
}): Promise<{ id: string | null }> {
  const result = await resend.emails.send(
    {
      from: RESEND_FROM,
      to: [args.recipient],
      replyTo: SUPPORT_EMAIL,
      subject: args.email.subject,
      html: args.email.html,
      text: args.email.text,
    },
    { idempotencyKey: args.idempotencyKey },
  );

  if (result.error) {
    console.error("[email:giftCode] send failed", { name: result.error.name });
    throw new Error("gift_code_email_send_failed");
  }
  return { id: result.data?.id ?? null };
}
