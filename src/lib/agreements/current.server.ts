import "server-only";
import { createHash } from "node:crypto";
import { CUSTOMER_REVIEWS_PRICING_ENABLED, SETUP_FEE_CENTS } from "@/lib/stripe/config";
import { SUPPORT_EMAIL } from "@/lib/support/constants";
import { SERVICE_AGREEMENT_WORDING, SERVICE_PRIVACY_URL, SERVICE_TERMS_URL } from "./shared";
import { termsNovember2026 } from "./versions/2026-11-12";

export function currentServiceTerms() {
  const html = termsNovember2026(SETUP_FEE_CENTS, CUSTOMER_REVIEWS_PRICING_ENABLED, SUPPORT_EMAIL);
  const hash = createHash("sha256").update(html).digest("hex");
  return {
    version: `2026-11-12-${hash.slice(0, 16)}`,
    title: "Terms of Service",
    last_updated: "November 12, 2026",
    terms_html: html,
    terms_sha256: hash,
    checkbox_text: SERVICE_AGREEMENT_WORDING,
    terms_url: SERVICE_TERMS_URL,
    privacy_url: SERVICE_PRIVACY_URL,
  };
}
export type ServiceTermsDocument = ReturnType<typeof currentServiceTerms>;
