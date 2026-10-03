/** Shared carrier submission, public disclosure, and retained consent version. */
export const REVIEW_TEXT_CONSENT_VERSION = "review-texts-v1";
export const REVIEW_TEXT_KEYWORD = "REVIEWS";

export function reviewConsentUrl(
  slug: string,
  origin = "https://simplassist.com",
) {
  return new URL(
    `/c/${encodeURIComponent(slug)}/review-texts`,
    origin,
  ).toString();
}

export function reviewConsentDescription(
  name: string,
  phone: string,
  url: string,
) {
  return `Customers visit ${url}, read ${name}'s review-text disclosures, and text REVIEWS to ${phone}. By sending REVIEWS, they agree to receive automated marketing text messages from ${name} requesting an honest Google review after completed services, with up to 2 review messages per completed service plus an opt-in confirmation. Message and data rates may apply. Consent is voluntary and is not a condition of purchase. Reply STOP to opt out or HELP for help. Customer-care messages, START, phone collection, and purchases do not grant review-text permission.`;
}

export function reviewConsentConfirmation(name: string) {
  const brand = name
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 70);
  return `${brand}: You agreed to automated review-request texts. Up to 2 per completed service. Msg & data rates may apply. Consent is not a condition of purchase. Reply HELP for help or STOP to opt out.`;
}

export function isReviewConsentKeyword(text: string) {
  return text.trim().toUpperCase() === REVIEW_TEXT_KEYWORD;
}
