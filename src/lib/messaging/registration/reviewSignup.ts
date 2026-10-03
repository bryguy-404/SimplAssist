import type { CustomerCareTemplateCopy } from "./customerCareTemplates";

export function reviewSignupDescription(customerCareDescription: string): string {
  if (customerCareDescription.includes("Separately opted-in customers may receive")) return customerCareDescription;
  const care = customerCareDescription.replace(
    "This campaign is limited to one-to-one customer support replies and service coordination.",
    "Customer-care messages respond to customer-initiated conversations.",
  );
  return `${care} Separately opted-in customers may receive an automated Google review request and one reminder after completed work. Review-text permission is collected separately by the customer texting REVIEWS after reading the business's review-text disclosure. Customer-care permission does not authorize review texts.`;
}

export function reviewSignupSamples(businessName: string, origin: string): string[] {
  const name = businessName.trim() || "Your Business";
  return [
    `${name}: Thank you for choosing us. Please share an honest Google review: ${origin}/r/example Reply STOP to opt out.`,
    `${name}: A quick reminder: you can share your experience at ${origin}/r/example Reply STOP to opt out.`,
  ];
}

export function withReviewSignupTemplate(
  care: CustomerCareTemplateCopy,
  businessName: string,
): CustomerCareTemplateCopy {
  return {
    ...care,
    useCaseDescription: reviewSignupDescription(care.useCaseDescription),
    sampleMessages: [...care.sampleMessages.slice(0, 3), ...reviewSignupSamples(businessName, "https://simplassist.com")],
    optInDescription: `${care.optInDescription} Review texts require separate permission: customers read the business's hosted review-text page and text REVIEWS themselves to the assigned business number. Up to 2 messages per completed service. Message and data rates may apply. Consent is not a condition of purchase. Reply HELP for help or STOP to opt out. START restores messaging only and does not grant review-text permission.`,
  };
}
