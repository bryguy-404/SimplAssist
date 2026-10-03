import "server-only";

/** A review-SMS pilot does not grant any base-plan messaging capability. */
export function isReviewSmsEnabled(businessId: string): boolean {
  const pilots = (process.env.REVIEWS_SMS_PILOT_BUSINESS_IDS ?? "")
    .split(",")
    .map((v) => v.trim());
  return (
    process.env.REVIEWS_SMS_ENABLED === "1" &&
    (pilots.includes(businessId) || pilots.includes("*"))
  );
}
