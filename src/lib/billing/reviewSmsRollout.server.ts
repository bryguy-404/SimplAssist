import "server-only";
import {
  customerReviewsBusinessExcluded,
  customerReviewsPilotIncludes,
} from "./customerReviewsRollout";

/** A review-SMS pilot does not grant any base-plan messaging capability. */
export function isReviewSmsEnabled(
  businessId: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (
    !customerReviewsBusinessExcluded(businessId, environment) &&
    environment.REVIEWS_SMS_ENABLED === "1" &&
    customerReviewsPilotIncludes(
      businessId,
      environment.REVIEWS_SMS_PILOT_BUSINESS_IDS,
      true,
    )
  );
}
