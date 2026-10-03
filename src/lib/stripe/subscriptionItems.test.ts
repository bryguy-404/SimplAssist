import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  baseFirstSubscription,
  classifySubscriptionItems,
} from "./subscriptionItems";

const item = (id: string, priceId: string, amount: number) => ({
  id,
  quantity: 1,
  current_period_start: 100,
  current_period_end: 200,
  price: {
    id: priceId,
    type: "recurring",
    currency: "usd",
    unit_amount: amount,
    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
  },
});
const subscription = (...items: ReturnType<typeof item>[]) =>
  ({ items: { data: items, has_more: false } }) as Stripe.Subscription;
beforeEach(() => {
  vi.stubEnv("STRIPE_PRICE_REVIEW_SMS", "price_review");
  vi.stubEnv("STRIPE_PRICE_CHAT_ONLY", "price_chat");
  vi.stubEnv("STRIPE_PRICE_SMS_ONLY", "price_starter");
  vi.stubEnv("STRIPE_PRICE_SMS_AND_CHAT", "price_growth");
  vi.stubEnv("STRIPE_PRICE_FULL", "price_full");
});
afterEach(() => vi.unstubAllEnvs());

describe("base and review-SMS subscription items", () => {
  it("finds the base independently of Stripe item order without mutating the event", () => {
    const sub = subscription(
      item("si_review", "price_review", 2000),
      item("si_chat", "price_chat", 1500),
    );
    expect(classifySubscriptionItems(sub).base.id).toBe("si_chat");
    expect(baseFirstSubscription(sub).items.data.map((i) => i.id)).toEqual([
      "si_chat",
      "si_review",
    ]);
    expect(sub.items.data[0].id).toBe("si_review");
  });
  it("allows the existing single-base binding path", () => {
    expect(
      classifySubscriptionItems(
        subscription(item("si_chat", "price_attempt", 1000)),
      ).reviewSms,
    ).toBeNull();
  });
  it.each([
    "duplicate",
    "unknown",
    "wrong_plan",
    "wrong_amount",
    "quantity",
    "period",
    "pagination",
  ])("refuses %s add-on state", (bad) => {
    const base = item("si_chat", "price_chat", 1500),
      addon = item("si_review", "price_review", 2000);
    if (bad === "wrong_plan") base.price.id = "price_growth";
    if (bad === "wrong_amount") addon.price.unit_amount = 100;
    if (bad === "quantity") addon.quantity = 2;
    if (bad === "period") addon.current_period_end = 201;
    if (bad === "unknown") addon.price.id = "price_unknown";
    const sub =
      bad === "duplicate"
        ? subscription(addon, addon)
        : subscription(base, addon);
    if (bad === "pagination") sub.items.has_more = true;
    expect(() => classifySubscriptionItems(sub)).toThrow();
  });
});
