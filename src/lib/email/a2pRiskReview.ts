import { resolveBusinessEmailBrand } from "./businessEmailBrand.server";
import { sendBusinessEmail } from "./sender";
import { SUPPORT_EMAIL } from "@/lib/support/constants";
import type { A2pRiskFinding } from "@/types/database";

interface A2pRiskReviewEmailInput {
  businessId: string;
  businessName: string;
  websiteUrl: string | null;
  inputHash: string;
  findings: A2pRiskFinding[];
  message: string;
}

function reviewRecipients(): string[] {
  const configured =
    process.env.A2P_REVIEW_EMAIL ??
    process.env.SUPPORT_EMAIL ??
    SUPPORT_EMAIL;
  return configured
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
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

export async function sendA2pRiskReviewEmail(
  input: A2pRiskReviewEmailInput
): Promise<void> {
  const recipients = reviewRecipients();
  if (recipients.length === 0) {
    console.warn("[email:a2pRiskReview] no recipients configured, skipping");
    return;
  }

  try {
    const brand = await resolveBusinessEmailBrand(input.businessId);
    const findingLines = input.findings.length
      ? input.findings.map(
          (finding) =>
            `- [${finding.severity}] ${finding.label}: ${finding.evidence.join(" | ")}`
        )
      : ["- No specific finding was captured."];
    const lines = [
      `A2P review needed for ${input.businessName}.`,
      `Workspace brand: ${brand.name}`,
      `Email sender: ${brand.from}`,
      `Workspace URL: ${brand.publicOrigin}`,
      `Business ID: ${input.businessId}`,
      `Website: ${input.websiteUrl ?? "none"}`,
      `Input hash: ${input.inputHash}`,
      `Customer-facing message: ${input.message}`,
      "Findings:",
      ...findingLines,
      "Review before submitting this account to Telnyx/TCR. If approving, acknowledge the review-fee/rejection risk in the admin override endpoint.",
    ];

    await sendBusinessEmail({
      brand,
      context: "a2pRiskReview",
      internal: true,
      message: {
        to: recipients,
        subject: `A2P review needed: ${brand.name} — ${input.businessName}`,
        text: lines.join("\n"),
        html: htmlFromLines(lines),
      },
    });
  } catch (err) {
    console.error("[email:a2pRiskReview] send failed:", err);
  }
}
