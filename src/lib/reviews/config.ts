/** Server-side rollout; an empty pilot list never enables a tenant. */
export function isEmailReviewsEnabledForBusiness(businessId: string): boolean {
  const pilots = (process.env.REVIEWS_EMAIL_PILOT_BUSINESS_IDS ?? "")
    .split(",")
    .map((v) => v.trim());
  return (
    process.env.REVIEWS_EMAIL_ENABLED === "1" &&
    (pilots.includes(businessId) || pilots.includes("*"))
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
