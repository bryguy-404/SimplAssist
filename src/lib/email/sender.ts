import "server-only";

import { resend } from "./client";
import type { BusinessEmailBrand } from "./businessEmailBrand.server";
import { appendLegalFooter } from "./legalFooter";

export type BusinessEmailMessage = Omit<
  Parameters<typeof resend.emails.send>[0],
  "from"
>;

export type SendBusinessEmailInput = {
  brand: BusinessEmailBrand;
  context: string;
  message: BusinessEmailMessage;
  /**
   * Suppress provider details and sender/message fields from failure logs.
   * Recovery links and other bearer secrets can be echoed by provider errors.
   */
  sensitive?: boolean;
  /**
   * A notification only SimplAssist staff receive (support tickets, review
   * alerts). Customer emails sent under SimplAssist's own brand end with the
   * company's legal line; internal ones and partner-branded ones do not.
   */
  internal?: boolean;
};

export async function sendBusinessEmail({
  brand,
  context,
  message,
  sensitive = false,
  internal = false,
}: SendBusinessEmailInput): Promise<
  Awaited<ReturnType<typeof resend.emails.send>>
> {
  const outgoing =
    brand.partnerId === null && !internal ? appendLegalFooter(message) : message;

  try {
    const result = await resend.emails.send({
      ...outgoing,
      from: brand.from,
    } as Parameters<typeof resend.emails.send>[0]);

    if (result.error) throw result.error;
    return result;
  } catch (error) {
    if (sensitive) {
      console.error(`[email:business] ${context}: sensitive send failed`, {
        partnerId: brand.partnerId,
      });
      throw error;
    }

    if (brand.partnerId !== null && !brand.usedFallbackSender) {
      console.error(
        `[email:business] ${context}: verified partner sender rejected`,
        { partnerId: brand.partnerId, from: brand.from },
        error,
      );
    } else {
      console.error(`[email:business] ${context}: send failed`, error);
    }
    throw error;
  }
}
