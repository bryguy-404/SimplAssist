import type Stripe from "stripe";
import type { SubscriptionStatus } from "@/types/database";

// Deliberate projection of Stripe's full documented status union onto the
// 4-status local model. Never-successfully-paying states map to 'canceled'
// so consumers route recovery through checkout (the plan cards) — the
// billing portal cannot complete an initial payment. Typed as a complete
// Record over the SDK union: a missing key fails the BUILD when an SDK
// upgrade widens the union, and an absent/unknown runtime status misses
// the lookup and throws below.
const STRIPE_STATUS_PROJECTION: Record<
  Stripe.Subscription.Status,
  SubscriptionStatus
> = {
  active: "active",
  trialing: "trialing",
  past_due: "past_due",
  canceled: "canceled",
  unpaid: "canceled", // dunning exhausted — dead subscription
  incomplete_expired: "canceled", // initial payment never completed
  incomplete: "canceled", // never paid — recovery is checkout, not the portal
  paused: "canceled", // never paid (trial ended without a payment method)
};

export function normalizeStripeSubscriptionStatus(
  status: Stripe.Subscription.Status,
): SubscriptionStatus {
  const mapped = STRIPE_STATUS_PROJECTION[status];
  if (mapped === undefined) {
    // Fail closed on anything outside Stripe's documented union — including
    // an absent status at runtime (types are compile-time only). Webhook
    // callers surface this as a recorded, re-claimable failure.
    throw new Error(
      `[stripe:sync] Unrecognized Stripe subscription status: ${String(status)}`,
    );
  }
  return mapped;
}
