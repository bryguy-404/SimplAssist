import "server-only";
import { createHash } from "node:crypto";
import type { ReviewSmsAccount } from "@/lib/billing/reviewSms";
import type { SharedRegistrationContext } from "@/lib/messaging/sharedBusinessRegistrations.server";
import { resolveLegalUrls, type LegalUrlsBusiness } from "@/lib/messaging/registration/legalUrls";
import { reviewOrigin } from "./domain";
import { reviewConsentConfirmation } from "./consentCopy";
import { reviewSmsKeywordProgram } from "./smsKeywords.server";

export function buildReviewCampaignFiling(a: ReviewSmsAccount,
  b: LegalUrlsBusiness & {name: string; telnyx_brand_id: string; authorized_rep_email: string},
  shared: SharedRegistrationContext | null, referenceId = `reviews:${a.id}`) {
  const links = resolveLegalUrls(b);
  const phone = String(a.draft.phoneNumber);
  const label = String(b.name).slice(0, 70);
  const keywords = reviewSmsKeywordProgram(label, b.authorized_rep_email);
  return {
    brandId: b.telnyx_brand_id,
    usecase: "MARKETING",
    description: shared
      ? `${label} is operated by ${shared.registration.legal_business_name}. The registered SimplAssist brand belongs to the same legal entity. ${label} sends marketing review requests to its own customers after completed services, with their permission. One invitation and at most one reminder; human staff handle replies.`
      : `${label} requests honest Google reviews after completed services. One invitation and at most one reminder are sent only with the customer's permission. Human staff handle replies.`,
    sample1: `${label}: Thank you for choosing us. Please share an honest review: ${reviewOrigin()}/r/example Reply STOP to opt out.`,
    sample2: `${label}: A quick reminder: you can share your experience at ${reviewOrigin()}/r/example Reply STOP to opt out.`,
    sample3: `${label}: Thank you for your feedback. Our team will help with your question. Reply STOP to opt out.`,
    messageFlow: `${a.draft.consentDescription} Evidence: ${a.draft.consentEvidenceUrl}. Customers consent to review requests from ${label} using ${phone}. Up to 2 messages per completed service; message and data rates may apply. Consent is not required to purchase. Reply STOP to opt out or HELP for help. Privacy: ${links.privacyUrl}. Terms: ${links.termsUrl}.`,
    subscriberOptin: true,
    optinKeywords: a.draft.consentMode === "hosted_keyword" ? "REVIEWS" : keywords.start.keywords.join(","),
    optinMessage: a.draft.consentMode === "hosted_keyword" ? reviewConsentConfirmation(label) : keywords.start.resp_text,
    subscriberOptout: true,
    optoutKeywords: keywords.stop.keywords.join(","),
    optoutMessage: keywords.stop.resp_text,
    subscriberHelp: true,
    helpKeywords: keywords.info.keywords.join(","),
    helpMessage: keywords.info.resp_text,
    termsAndConditions: true,
    privacyPolicyLink: links.privacyUrl,
    termsAndConditionsLink: links.termsUrl,
    autoRenewal: true,
    embeddedLink: true,
    embeddedPhone: false,
    numberPool: false,
    directLending: false,
    ageGated: false,
    referenceId,
    webhookURL: `${reviewOrigin()}/api/messaging/registration/status`,
    webhookFailoverURL: `${reviewOrigin()}/api/messaging/registration/status`,
  };
}

export function reviewCampaignFilingHash(filing: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(filing)).digest("hex");
}

/** Callback URLs are not returned by Telnyx campaign reads. */
export function reviewSmsCampaignMatches(candidate: Record<string, unknown>, filing: Record<string, unknown>) {
  return Object.entries(filing).filter(([key]) => !["webhookURL", "webhookFailoverURL"].includes(key))
    .every(([key, value]) => candidate[key] === value);
}
