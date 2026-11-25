import { resolveBusinessEmailBrand } from "./businessEmailBrand.server";
import { sendBusinessEmail } from "./sender";
import {
  SUPPORT_EMAIL,
  supportCategoryLabel,
  type SupportCategory,
} from "@/lib/support/constants";

/**
 * Owner notification for a new support ticket (see /api/support).
 *
 * Differences from the sibling a2pRiskReview sender, both deliberate:
 * - Returns whether the send succeeded — the route records it in
 *   support_requests.notified so silently-failed notifications are visible
 *   on the admin tickets page. Still never throws.
 * - Sets replyTo to the submitter, so replying from the inbox goes straight
 *   to the customer instead of the notifications@ sender address.
 */

interface SupportTicketEmailInput {
  requestId: string;
  category: SupportCategory;
  message: string;
  name: string;
  email: string;
  userId: string | null;
  businessId: string | null;
  businessName: string | null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlFromLines(lines: string[]): string {
  return lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
}

export async function sendSupportTicketEmail(
  input: SupportTicketEmailInput
): Promise<boolean> {
  try {
    const brand = await resolveBusinessEmailBrand(input.businessId);
    const categoryLabel = supportCategoryLabel(input.category);
    const business = input.businessId
      ? `${input.businessName ?? "unknown"} (${input.businessId})`
      : "none — logged out";
    const lines = [
      `New support request ${input.requestId}`,
      `Workspace brand: ${brand.name}`,
      `Email sender: ${brand.from}`,
      `Workspace URL: ${brand.publicOrigin}`,
      `Category: ${categoryLabel}`,
      `From: ${input.name} <${input.email}>`,
      `Business: ${business}`,
      `User ID: ${input.userId ?? "none"}`,
      "",
      // Preserve the submitter's line breaks as separate paragraphs.
      ...input.message.split("\n"),
    ];

    await sendBusinessEmail({
      brand,
      context: "supportTicket",
      internal: true,
      message: {
        to: [SUPPORT_EMAIL],
        replyTo: input.email,
        subject: `Support request — ${brand.name} — ${categoryLabel} — ${input.name}`,
        text: lines.join("\n"),
        html: htmlFromLines(lines),
      },
    });
    return true;
  } catch (err) {
    console.error("[email:supportTicket] send failed:", err);
    return false;
  }
}
