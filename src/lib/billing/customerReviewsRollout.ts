const BUSINESS_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const businessIds = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);

/** Preserve explicitly excluded existing accounts when new signups launch. */
export function customerReviewsBusinessExcluded(
  businessId: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (!BUSINESS_UUID.test(businessId)) return true;
  const excluded = businessIds(
    environment.CUSTOMER_REVIEWS_EXCLUDED_BUSINESS_IDS,
  );
  // A malformed exclusion must never accidentally expand access.
  return (
    excluded.some((id) => !BUSINESS_UUID.test(id)) ||
    excluded.includes(businessId.toLowerCase())
  );
}

export function customerReviewsPilotIncludes(
  businessId: string,
  configuredIds: string | undefined,
  allowAll = false,
): boolean {
  const pilots = businessIds(configuredIds);
  return (
    BUSINESS_UUID.test(businessId) &&
    pilots.length > 0 &&
    pilots.every((id) => BUSINESS_UUID.test(id) || (allowAll && id === "*")) &&
    (pilots.includes(businessId.toLowerCase()) ||
      (allowAll && pilots.includes("*")))
  );
}
