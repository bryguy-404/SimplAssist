export const SERVICE_AGREEMENT_WORDING =
  "I agree to the Terms of Service and acknowledge the Privacy Policy.";
export const SERVICE_TERMS_URL = "https://simplassist.com/terms";
export const SERVICE_PRIVACY_URL = "https://simplassist.com/privacy";
export const SERVICE_AGREEMENTS_PATH = "/settings/billing/agreements";

export type ServiceAgreementConfirmation = { accepted: true; termsVersion: string };
export type ServiceAgreementSummary = {
  id: string;
  subscriber_email: string;
  business_name: string;
  accepted_at: string;
  terms_version: string;
  source: string;
};
export type ServiceAgreementStatus = {
  termsVersion: string;
  accepted: boolean;
  records: ServiceAgreementSummary[];
};

export const SERVICE_AGREEMENT_ERRORS: Record<string, string> = {
  service_agreement_required: "Please agree to the Terms of Service before continuing.",
  service_agreement_changed: "The Terms have changed. Reload this page and review them before continuing.",
  service_agreement_unavailable: "We couldn’t verify your agreement. Please try again before continuing to payment.",
};
