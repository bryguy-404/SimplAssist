import "server-only";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A narrow pilot grant never changes purchase or messaging entitlements. */
export function customerWorkspaceEnabled(
  businessId: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (!UUID.test(businessId)) return false;
  if (environment.CUSTOMERS_WORKSPACE_ENABLED === "1") return true;
  const pilots = (environment.CUSTOMERS_WORKSPACE_BUSINESS_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return (
    pilots.length > 0 &&
    pilots.every((value) => UUID.test(value)) &&
    pilots.some((value) => value.toLowerCase() === businessId.toLowerCase())
  );
}
