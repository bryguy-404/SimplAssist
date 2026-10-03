import "server-only";
import {
  customerReviewsBusinessExcluded,
  customerReviewsPilotIncludes,
} from "./customerReviewsRollout";

/** Workspace access never changes purchase or messaging entitlements. */
export function customerWorkspaceEnabled(
  businessId: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (customerReviewsBusinessExcluded(businessId, environment)) return false;
  if (environment.CUSTOMERS_WORKSPACE_ENABLED === "1") return true;
  return customerReviewsPilotIncludes(
    businessId,
    environment.CUSTOMERS_WORKSPACE_BUSINESS_IDS,
  );
}
