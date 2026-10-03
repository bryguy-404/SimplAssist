/**
 * Per-business privacy + terms templates (Phase 6).
 *
 * Single source of truth for both:
 *   1. The rendered JSX at /c/[slug]/privacy and /c/[slug]/terms.
 *   2. The "View generated copy" plain-text view in the dashboard Compliance
 *      panel (mode = self_hosted), which customers paste into their own CMS.
 *
 * The privacy template intentionally hits all four carrier-required clauses
 * called out in the Compliance panel's "existing mode" self-check:
 *   1. Explicit mention of SMS/text messaging (Section 3 + 4)
 *   2. "We will not share mobile information with third parties for promotional
 *      or marketing purposes" (Section 4, last paragraph — verbatim)
 *   3. Instructions to opt out via STOP (Section 4)
 *   4. Message frequency varies + msg & data rates may apply (Section 4)
 *
 * If any of these clauses is removed or weakened during edits, the campaign
 * registrations that reference these URLs may be rejected by MNO review.
 */

import {
  buildSmsComplianceCopy,
  MOBILE_INFORMATION_SHARING_DISCLOSURE,
} from "@/lib/messaging/complianceCopy";
import type { Language } from "@/types/database";
import { reviewConsentDescription } from "@/lib/reviews/consentCopy";

export interface LegalSection {
  title: string;
  paragraphs: string[];
}

export interface LegalDoc {
  sections: LegalSection[];
  lastUpdated: string; // YYYY-MM-DD
}

/**
 * The fields this template needs from a `businesses` row.
 *
 * IMPORTANT — PII boundary: this interface deliberately does NOT include
 * authorized_rep_*, ein, last_4_ssn, or registrant_mobile. Those are
 * registration-only fields not safe to render on a public page. The public
 * page projections (src/app/(public)/c/[slug]/*) and the dashboard preview
 * must select only fields listed here.
 */
export interface LegalTemplateBusiness {
  name: string;
  phone_number: string | null;
  sms_phone_number?: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  opt_in_description: string | null;
  language?: Language | null;
  review_sms_signup_enabled?: boolean;
  review_sms_only?: boolean;
  review_consent_url?: string;
}

const LAST_UPDATED = "2026-07-22";

function contactEmail(b: LegalTemplateBusiness): string {
  // business.email is required in onboarding Step 1 (BusinessInfoForm), so it
  // is guaranteed non-null by the time the slug is finalized and this page is
  // reachable. The fallback string is defensive only.
  return b.email ?? "our customer service email";
}

function postalAddress(b: LegalTemplateBusiness): string | null {
  const parts = [b.address, [b.city, b.state].filter(Boolean).join(", "), b.zip]
    .filter((p) => p && p.trim().length > 0)
    .map((p) => p!.trim());
  if (parts.length === 0) return null;
  return parts.join(", ");
}

function smsNumber(b: LegalTemplateBusiness): string {
  return b.sms_phone_number ?? "the number you texted or called";
}

function phoneClause(b: LegalTemplateBusiness): string {
  return `at ${smsNumber(b)}`;
}

function legalOptInDescription(b: LegalTemplateBusiness): string {
  return buildSmsComplianceCopy({
    business: {
      name: b.name,
      email: b.email,
      phone_number: b.phone_number,
    },
    smsPhoneNumber: smsNumber(b),
    privacyUrl: "this Privacy Policy",
    language: b.language,
  }).legalOptInDescription;
}

function addReviewProgram(doc: LegalDoc, b: LegalTemplateBusiness): LegalDoc {
  if (!b.review_sms_signup_enabled && !b.review_sms_only) return doc;
  const consent = reviewConsentDescription(b.name, smsNumber(b), b.review_consent_url ?? "our review-text permission page");
  const reviewPurpose = `Our review-text program sends an automated request for an honest Google review and at most one reminder after completed work. You may leave any rating or decline to review. It does not include offers or unrelated advertising.`;
  const stop = `Reply STOP to stop texts. Reply HELP for help or contact ${contactEmail(b)}. START restores messaging availability but does not restore review-text permission; after START, read the permission page and text REVIEWS again to subscribe to review requests.`;
  const sections = doc.sections.map((section) => {
    if (b.review_sms_only && /^(1\.|3\.|4\.)/.test(section.title)) {
      return { ...section, paragraphs: section.title.startsWith("1.")
        ? [`${b.name} operates this voluntary review-request SMS program. These disclosures explain the service and how your mobile number and consent records are used. SimplAssist provides the technology and Telnyx provides messaging delivery.`]
        : section.title.startsWith("3.") ? [reviewPurpose, "We use your phone number, message history, delivery information, and consent records to run this program. We do not sell your information."]
        : [consent, stop, MOBILE_INFORMATION_SHARING_DISCLOSURE] };
    }
    if (section.title.startsWith("3.")) return { ...section, paragraphs: [...section.paragraphs, reviewPurpose] };
    if (section.title.startsWith("4.")) return { ...section, paragraphs: [...section.paragraphs, consent, stop] };
    return section;
  });
  return { ...doc, lastUpdated: "2026-10-03", sections };
}

export function buildPrivacyContent(b: LegalTemplateBusiness): LegalDoc {
  const name = b.name;
  const email = contactEmail(b);
  const address = postalAddress(b);
  const phone = phoneClause(b);
  // opt_in_description is a persisted campaign-submission snapshot and may
  // remain stale during a manual appeal. Public policy copy must be rebuilt
  // from the live shared model and currently active SMS number on every render.
  const optIn = legalOptInDescription(b);

  return addReviewProgram({
    lastUpdated: LAST_UPDATED,
    sections: [
      {
        title: "1. Introduction",
        paragraphs: [
          `${name} operates an SMS text messaging program to communicate with current and prospective customers. This Privacy Policy explains what information we collect when you text or call us ${phone}, how we use it, and the rights you have over that information.`,
          `${name} is the business responsible for this messaging program. SimplAssist provides the underlying technology platform and AI-assisted reply infrastructure on our behalf, and Telnyx is our messaging carrier. References to "we," "our," and "us" in this policy mean ${name}.`,
        ],
      },
      {
        title: "2. Information We Collect",
        paragraphs: [
          `We collect the mobile phone number you use to contact us, along with the contents of any text messages you send to us and the messages we send back. If you provide your name, email address, or other contact information in the course of a conversation, we collect that too.`,
          `We also collect basic technical metadata about your messages — timestamps, delivery status, and the channel you used to reach us (SMS or web chat).`,
        ],
      },
      {
        title: "3. How We Use Your Information",
        paragraphs: [
          `We use your information to respond to your inquiries, schedule appointments, send follow-up messages related to a conversation you started, and provide customer service. ${optIn}`,
          `We do not use your information for unrelated marketing, and we do not sell your information.`,
        ],
      },
      {
        title: "4. SMS / Text Messaging",
        paragraphs: [
          `By providing your phone number to ${name} — whether by texting us ${phone} first, or by calling us ${phone}, hearing our voicemail disclosure, and leaving a message after that disclosure — you consent to receive automated and AI-assisted customer-care text messages from ${name} at the mobile number you provided. These messages may include responses to your questions, missed-call follow-ups, service coordination, and other messages related to a conversation you started with us. Consent is not a condition of any purchase.`,
          `Message frequency varies based on your conversation and our follow-up needs. Message and data rates may apply depending on your mobile plan. You are responsible for any charges from your wireless carrier.`,
          `You can opt out of SMS messages at any time by replying STOP to any message from us. After you opt out, you will receive a single confirmation message and no further messages will be sent unless you opt back in by replying START. For help, reply HELP or contact us at ${email}.`,
          `${MOBILE_INFORMATION_SHARING_DISCLOSURE} We share mobile information only with our messaging service provider (Telnyx), our technology platform provider (SimplAssist), and other service providers strictly necessary to deliver and respond to your messages.`,
        ],
      },
      {
        title: "5. Third-Party Service Providers",
        paragraphs: [
          `We rely on a small number of vendors to deliver this messaging service: Telnyx (carrier and SMS delivery), SimplAssist (technology platform and AI assistance), and Anthropic (the AI model that helps draft responses). Each of these providers processes your information only as necessary to deliver the service, under their own privacy and security commitments.`,
        ],
      },
      {
        title: "6. Data Retention and Deletion",
        paragraphs: [
          `We retain message content and conversation history for as long as it is necessary to provide customer service and meet recordkeeping obligations. You may request deletion of your data at any time by contacting us at ${email}. Once deleted, conversation contents are erased and your phone number is removed from our active records, subject to any obligation to retain records required by law.`,
        ],
      },
      {
        title: "7. Your Rights",
        paragraphs: [
          `Depending on where you live, you may have the right to access, correct, or delete the personal information we hold about you, and to opt out of certain uses of that information. To exercise these rights, contact us at ${email}.`,
        ],
      },
      {
        title: "8. Contact Us",
        paragraphs: [
          address
            ? `${name} — ${address}. Email: ${email}.`
            : `${name}. Email: ${email}.`,
          `If you have questions about this Privacy Policy or our SMS messaging practices, please reach out.`,
        ],
      },
      {
        title: "9. Updates to This Policy",
        paragraphs: [
          `We may update this Privacy Policy from time to time. The "Last updated" date at the top reflects the most recent revision. Material changes will be reflected here; please check this page periodically.`,
        ],
      },
    ],
  }, b);
}

export function buildTermsContent(b: LegalTemplateBusiness): LegalDoc {
  const name = b.name;
  const email = contactEmail(b);
  const phone = phoneClause(b);

  return addReviewProgram({
    lastUpdated: LAST_UPDATED,
    sections: [
      {
        title: "1. Overview",
        paragraphs: [
          `These Terms of Service ("Terms") govern your use of the SMS text messaging program operated by ${name}. By texting us ${phone} first, or by calling us ${phone}, hearing our voicemail disclosure, and leaving a message after that disclosure to request a customer-care text follow-up, you agree to these Terms.`,
          `SimplAssist provides the technology platform and AI-assisted reply infrastructure that powers this messaging program on our behalf. ${name} is the business responsible for the program and these Terms.`,
        ],
      },
      {
        title: "2. Eligibility",
        paragraphs: [
          `You must be at least 18 years old, or the age of majority in your jurisdiction, to participate in our SMS messaging program. By agreeing to these Terms, you represent that you meet this requirement and that the mobile number you provided is one you own or are authorized to use.`,
        ],
      },
      {
        title: "3. The Messaging Program",
        paragraphs: [
          `Our SMS messaging program is intended for customer service and operational communications related to ${name}. Typical messages include responses to your inquiries, missed-call follow-ups, service coordination, and other messages related to a conversation you started with us. Responses may be drafted with the help of AI; a human team member may also reply.`,
          `Message frequency varies based on your conversation and our follow-up needs. Message and data rates may apply depending on your mobile plan.`,
        ],
      },
      {
        title: "4. Opting In and Opting Out",
        paragraphs: [
          `You opt in by texting us ${phone} first to ask a question or request service, or by calling us ${phone}, hearing our voicemail disclosure, and leaving a message after that disclosure to request a customer-care SMS follow-up. Consent is not a condition of any purchase.`,
          `You can opt out at any time by replying STOP to any message from us. You will receive a single confirmation message and no further messages will be sent unless you opt back in by replying START. For help, reply HELP or contact us at ${email}.`,
        ],
      },
      {
        title: "5. Acceptable Use",
        paragraphs: [
          `You agree not to use our messaging program to send unlawful, abusive, harassing, or threatening messages, to impersonate another person, to transmit malware, or to interfere with the operation of the program. We reserve the right to suspend or terminate access for any user who violates these Terms.`,
        ],
      },
      {
        title: "6. Disclaimers",
        paragraphs: [
          `Our SMS messaging program is provided on an "as is" and "as available" basis. AI-assisted replies are intended to be helpful but may not be accurate in every case; for matters that require certainty (medical, legal, financial, or safety-critical questions, for example), please confirm directly with a qualified person at ${name} before relying on a response.`,
          `Carrier delivery of SMS messages is not guaranteed. Neither ${name} nor SimplAssist is responsible for messages that are delayed, undelivered, or misrouted by your wireless carrier.`,
        ],
      },
      {
        title: "7. Limitation of Liability",
        paragraphs: [
          `To the fullest extent permitted by law, ${name} and SimplAssist will not be liable for indirect, incidental, special, consequential, or punitive damages arising out of or in connection with the SMS messaging program, even if advised of the possibility of such damages.`,
        ],
      },
      {
        title: "8. Changes to These Terms",
        paragraphs: [
          `We may update these Terms from time to time. The "Last updated" date at the top reflects the most recent revision. Continued use of our messaging program after a change constitutes acceptance of the updated Terms.`,
        ],
      },
      {
        title: "9. Contact",
        paragraphs: [
          `Questions about these Terms? Email ${email}.`,
        ],
      },
    ],
  }, b);
}

/**
 * Convert a LegalDoc to plain formatted text suitable for a customer to copy
 * into their own CMS (used by Compliance panel's self_hosted mode).
 *
 * Format: each section title in UPPERCASE on its own line, followed by a blank
 * line, then paragraphs separated by blank lines. No HTML, no markdown markers.
 * Customers can paste into a rich-text editor and the visual structure survives.
 */
export function toPlainText(doc: LegalDoc): string {
  const header = `Last updated: ${doc.lastUpdated}`;
  const body = doc.sections
    .map((s) => `${s.title.toUpperCase()}\n\n${s.paragraphs.join("\n\n")}`)
    .join("\n\n\n");
  return `${header}\n\n\n${body}\n`;
}
