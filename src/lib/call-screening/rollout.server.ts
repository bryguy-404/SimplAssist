import "server-only";

export function canEnableCallScreening(businessId: string) {
  return process.env.CALL_SCREENING_ENABLED === "1" || (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(businessId) &&
    process.env.CALL_SCREENING_PILOT_BUSINESS_ID === businessId
  );
}
