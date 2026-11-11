import { resolveBusinessEmailBrand } from "./businessEmailBrand.server";
import { sendBusinessEmail } from "./sender";
import { supportHref } from "@/lib/support/constants";

interface ApprovedInput {
  businessId: string;
  businessName: string;
  recipients: string[];
}

interface RejectedInput {
  businessId: string;
  businessName: string;
  rejectionReason: string | null;
  recipients: string[];
}

export function dedupeRecipients(
  emails: (string | null | undefined)[]
): string[] {
  const seen = new Set<string>();
  for (const e of emails) {
    if (!e) continue;
    const normalized = e.trim().toLowerCase();
    if (!normalized) continue;
    seen.add(normalized);
  }
  return Array.from(seen);
}

function htmlFromParagraphs(
  paragraphs: string[],
  linkUrls: string[] = [],
): string {
  return paragraphs
    .map((paragraph) => {
      let html = escapeHtml(paragraph);
      for (const url of linkUrls) {
        const escapedUrl = escapeHtml(url);
        html = html.replace(
          escapedUrl,
          `<a href="${escapedUrl}">${escapedUrl}</a>`,
        );
      }
      return `<p>${html}</p>`;
    })
    .join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendSafe(args: {
  businessId: string;
  to: string[];
  context: string;
  content: (
    brand: Awaited<ReturnType<typeof resolveBusinessEmailBrand>>,
  ) => { subject: string; paragraphs: string[]; linkUrls?: string[] };
}): Promise<void> {
  if (args.to.length === 0) {
    console.warn(
      `[email:registrationStatus] ${args.context}: no recipients, skipping`
    );
    return;
  }
  try {
    const brand = await resolveBusinessEmailBrand(args.businessId);
    const content = args.content(brand);
    await sendBusinessEmail({
      brand,
      context: `registrationStatus:${args.context}`,
      message: {
        to: args.to,
        subject: content.subject,
        text: content.paragraphs.join("\n\n"),
        html: htmlFromParagraphs(content.paragraphs, content.linkUrls),
      },
    });
  } catch (err) {
    console.error(
      `[email:registrationStatus] ${args.context} send failed:`,
      err
    );
  }
}

export async function sendBrandApprovedEmail(
  input: ApprovedInput
): Promise<void> {
  await sendSafe({
    businessId: input.businessId,
    to: input.recipients,
    context: "brand_approved",
    content: (brand) => ({
      subject: `Your ${brand.name} business verification is approved`,
      paragraphs: [
        "Hi,",
        `Good news — business verification for ${input.businessName} is complete.`,
        "SMS campaign review and phone number setup are the next steps. Texting becomes available after those steps finish; business verification alone does not activate it.",
        "You can check progress and any next steps in your account. If you have questions, reply to this email.",
        `— The ${brand.name} Team`,
      ],
    }),
  });
}

export async function sendBrandRejectedEmail(
  input: RejectedInput
): Promise<void> {
  const reasonLine = input.rejectionReason
    ? `Reason from the carrier: ${input.rejectionReason}`
    : "The carrier did not provide a specific reason.";
  await sendSafe({
    businessId: input.businessId,
    to: input.recipients,
    context: "brand_rejected",
    content: (brand) => {
      const supportUrl = new URL(
        supportHref("number_registration"),
        brand.publicOrigin
      ).toString();
      return {
        subject: `Your ${brand.name} business registration needs support`,
        paragraphs: [
          "Hi,",
          `The carrier review for ${input.businessName} came back without approval.`,
          reasonLine,
          `Please contact the ${brand.name} support team at ${supportUrl}. We'll review the existing registration and carrier feedback before taking the next step.`,
          `— The ${brand.name} Team`,
        ],
        linkUrls: [supportUrl],
      };
    },
  });
}

export async function sendCampaignApprovedEmail(
  input: ApprovedInput
): Promise<void> {
  await sendSafe({
    businessId: input.businessId,
    to: input.recipients,
    context: "campaign_approved",
    content: (brand) => ({
      subject: `Your ${brand.name} SMS campaign is live`,
      paragraphs: [
        "Hi,",
        `Carriers have approved the SMS campaign for ${input.businessName}. Your AI assistant is now live and will reply to incoming text messages from your customers.`,
        `You can manage messages, contacts, and AI settings from your ${brand.name} dashboard: ${new URL("/dashboard", brand.publicOrigin)}`,
        `— The ${brand.name} Team`,
      ],
    }),
  });
}

export async function sendCampaignRejectedEmail(
  input: RejectedInput
): Promise<void> {
  const reasonLine = input.rejectionReason
    ? `Reason from the carrier: ${input.rejectionReason}`
    : "The carrier did not provide a specific reason.";
  await sendSafe({
    businessId: input.businessId,
    to: input.recipients,
    context: "campaign_rejected",
    content: (brand) => {
      const supportUrl = new URL(
        supportHref("number_registration"),
        brand.publicOrigin
      ).toString();
      return {
        subject: `Your ${brand.name} SMS campaign needs support`,
        paragraphs: [
          "Hi,",
          `The carrier review for the SMS campaign on ${input.businessName} came back without approval.`,
          reasonLine,
          `Please contact the ${brand.name} support team at ${supportUrl}. We'll review the existing campaign and carrier feedback before taking the next step.`,
          `— The ${brand.name} Team`,
        ],
        linkUrls: [supportUrl],
      };
    },
  });
}
