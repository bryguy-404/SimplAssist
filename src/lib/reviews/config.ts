import {
  customerReviewsBusinessExcluded,
  customerReviewsPilotIncludes,
} from "@/lib/billing/customerReviewsRollout";

/** An explicit all-account rollout still honors existing-account exclusions. */
export function isEmailReviewsEnabledForBusiness(
  businessId: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (
    environment.REVIEWS_EMAIL_ENABLED === "1" &&
    !customerReviewsBusinessExcluded(businessId, environment) &&
    customerReviewsPilotIncludes(
      businessId,
      environment.REVIEWS_EMAIL_PILOT_BUSINESS_IDS,
      true,
    )
  );
}
export function isReviewEmailSendingEnabled(): boolean {
  return process.env.REVIEWS_EMAIL_SENDING_ENABLED === "1";
}
export const REVIEW_TEMPLATES = {
  subject: "How was your experience with {{business_name}}?",
  body: "Hi {{customer_name}}, thank you for choosing {{business_name}}. We would appreciate your honest feedback on Google. Please share your experience using the link below.",
  reminderSubject: "A quick reminder from {{business_name}}",
  reminderBody:
    "Hi {{customer_name}}, thank you again for choosing {{business_name}}. If you have a moment, we would appreciate an honest Google review. Thank you!",
};
