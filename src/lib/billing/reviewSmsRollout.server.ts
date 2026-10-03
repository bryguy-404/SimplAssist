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

/** Database scan scope; malformed rollout settings must not expand access. */
export function reviewSmsSignupScope(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): { businessIds: string[] | null; excludedBusinessIds: string[] } | null {
  const parse = (value: string | undefined) =>
    (value ?? "")
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean);
  const pilots = parse(environment.REVIEWS_SMS_PILOT_BUSINESS_IDS);
  const excludedBusinessIds = parse(
    environment.CUSTOMER_REVIEWS_EXCLUDED_BUSINESS_IDS,
  );
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    environment.REVIEWS_SMS_ENABLED !== "1" ||
    !pilots.length ||
    pilots.some((id) => id !== "*" && !uuid.test(id)) ||
    excludedBusinessIds.some((id) => !uuid.test(id))
  )
    return null;
  return {
    businessIds: pilots.includes("*")
      ? null
      : pilots.filter((id) => !excludedBusinessIds.includes(id)),
    excludedBusinessIds,
  };
}
