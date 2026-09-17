import type {
  SubscriptionPlan,
  SubscriptionStatus,
} from "@/types/database";
import { SUBSCRIPTION_PLAN_IDS } from "@/types/database";

export type PlanSalesStatus = "available" | "coming_soon" | "hidden";

/**
 * Catalog-level sales presentation for new subscriptions. Channel-specific
 * server rollout switches remain an additional authorization boundary.
 * Existing subscriptions keep their plan and entitlements while a plan is
 * unavailable for new purchases.
 */
export const PLAN_SALES_STATUS = {
  chat_only: "hidden",
  sms_only: "available",
  sms_and_chat: "available",
  full: "available",
} as const satisfies Record<SubscriptionPlan, PlanSalesStatus>;

/**
 * Stable presentation order for customer-facing plan selectors. Hidden plans
 * remain readable through the catalog but cannot leak from object iteration.
 */
export const CUSTOMER_VISIBLE_PLAN_ORDER = Object.freeze(
  SUBSCRIPTION_PLAN_IDS.filter(
    (plan) => PLAN_SALES_STATUS[plan] !== "hidden",
  ),
);

export function getPlanSalesStatus(
  plan: SubscriptionPlan
): PlanSalesStatus {
  return PLAN_SALES_STATUS[plan];
}

export function isPlanAvailable(plan: SubscriptionPlan): boolean {
  return getPlanSalesStatus(plan) === "available";
}

export function isPlanVisible(plan: SubscriptionPlan): boolean {
  return getPlanSalesStatus(plan) !== "hidden";
}

export function availablePlanOrFallback(
  plan: SubscriptionPlan | null | undefined,
  fallback: SubscriptionPlan
): SubscriptionPlan {
  if (!isPlanAvailable(fallback)) {
    throw new Error("The fallback subscription plan must be available");
  }
  return plan && isPlanAvailable(plan) ? plan : fallback;
}

/**
 * Paid onboarding retries are not new sales, so an existing Full account must
 * still be allowed to finish provisioning. Canceled and unpaid subscriptions
 * return null and therefore fall back to the user's available selection.
 */
export function paidPlanForOnboardingRetry(
  plan: SubscriptionPlan | null | undefined,
  status: SubscriptionStatus | null | undefined
): SubscriptionPlan | null {
  return plan && (status === "active" || status === "trialing")
    ? plan
    : null;
}
