import type Stripe from "stripe";
import { REVIEW_SMS_ADDON_CENTS, planFromStripePriceId } from "./config";

export type ClassifiedSubscriptionItems = {
  base: Stripe.SubscriptionItem;
  reviewSms: Stripe.SubscriptionItem | null;
};

/** Multi-item subscriptions are admitted only for the explicit Chat review add-on. */
export function classifySubscriptionItems(
  subscription: Stripe.Subscription,
): ClassifiedSubscriptionItems {
  const items = subscription.items;
  if (items.has_more || items.data.length < 1 || items.data.length > 2) {
    throw new Error("subscription_items_unsupported");
  }
  const addonPrice = process.env.STRIPE_PRICE_REVIEW_SMS;
  const addonItems = items.data.filter(
    (item) => Boolean(addonPrice) && item.price.id === addonPrice,
  );
  const baseItems = items.data.filter((item) => !addonItems.includes(item));
  if (baseItems.length !== 1 || addonItems.length > 1)
    throw new Error("subscription_items_unsupported");
  const base = baseItems[0];
  const reviewSms = addonItems[0] ?? null;
  if (reviewSms) {
    const price = reviewSms.price;
    if (
      base.quantity !== 1 ||
      planFromStripePriceId(base.price.id) !== "chat_only" ||
      reviewSms.quantity !== 1 ||
      price.type !== "recurring" ||
      price.currency !== "usd" ||
      price.unit_amount !== REVIEW_SMS_ADDON_CENTS ||
      price.recurring?.interval !== "month" ||
      price.recurring.interval_count !== 1 ||
      price.recurring.usage_type !== "licensed" ||
      reviewSms.current_period_start < base.current_period_start ||
      reviewSms.current_period_start >= base.current_period_end ||
      reviewSms.current_period_end !== base.current_period_end
    ) {
      throw new Error("review_sms_subscription_items_invalid");
    }
  }
  return { base, reviewSms };
}

export function baseFirstSubscription(
  subscription: Stripe.Subscription,
): Stripe.Subscription {
  const { base, reviewSms } = classifySubscriptionItems(subscription);
  return {
    ...subscription,
    items: {
      ...subscription.items,
      data: reviewSms ? [base, reviewSms] : [base],
    },
  };
}
