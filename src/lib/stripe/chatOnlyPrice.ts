import "server-only";

import type Stripe from "stripe";
import { approvedBasePriceCents } from "./config";

export class ChatOnlyStripePriceConfigurationError extends Error {
  constructor() {
    super("chat_only_stripe_price_invalid");
    this.name = "ChatOnlyStripePriceConfigurationError";
  }
}

type ChatOnlyStripePriceRequirements = {
  expectedPriceId?: string;
  requireActive?: boolean;
  subscriptionItemCount?: number;
  quantity?: number | null;
};

/**
 * Authoritative product check for the selected flat monthly Chat package.
 * Environment-variable shape alone cannot establish amount or recurrence, so
 * both Checkout creation and webhook synchronization use this same boundary.
 */
export function assertApprovedChatOnlyStripePrice(
  price: Stripe.Price,
  requirements: ChatOnlyStripePriceRequirements = {},
): void {
  const recurring = price.recurring;
  const isApproved =
    (requirements.expectedPriceId === undefined ||
      price.id === requirements.expectedPriceId) &&
    (requirements.subscriptionItemCount === undefined ||
      requirements.subscriptionItemCount === 1) &&
    (requirements.quantity === undefined || requirements.quantity === 1) &&
    (requirements.requireActive !== true || price.active === true) &&
    price.type === "recurring" &&
    price.currency.toLowerCase() === "usd" &&
    price.unit_amount === approvedBasePriceCents("chat_only", price.id) &&
    recurring?.interval === "month" &&
    recurring.interval_count === 1 &&
    recurring.usage_type === "licensed";

  if (!isApproved) {
    throw new ChatOnlyStripePriceConfigurationError();
  }
}
