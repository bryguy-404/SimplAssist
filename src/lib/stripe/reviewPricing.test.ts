import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Customers and Reviews package release", () => {
  it("keeps existing prices until the public release build is explicitly enabled", async () => {
    vi.stubEnv("NEXT_PUBLIC_CUSTOMER_REVIEWS_PRICING_ENABLED", "");
    vi.resetModules();
    const { SUBSCRIPTION_PLANS, SETUP_FEE_CENTS } = await import("./config");
    expect(Object.values(SUBSCRIPTION_PLANS).map((plan) => plan.price)).toEqual(
      [10, 25, 45, 65],
    );
    expect(SETUP_FEE_CENTS).toBe(2500);
  });

  it("switches the catalog, setup fee, and checkout validation together", async () => {
    vi.stubEnv("NEXT_PUBLIC_CUSTOMER_REVIEWS_PRICING_ENABLED", "1");
    vi.stubEnv("STRIPE_PRICE_CHAT_ONLY", "price_newchat");
    vi.stubEnv("STRIPE_LEGACY_PRICE_CHAT_ONLY", "price_originalchat");
    vi.resetModules();
    const catalog = await import("./config");
    const { assertApprovedChatOnlyStripePrice } =
      await import("./chatOnlyPrice");
    expect(
      Object.values(catalog.SUBSCRIPTION_PLANS).map((plan) => plan.price),
    ).toEqual([15, 29, 49, 79]);
    expect(catalog.SETUP_FEE_CENTS).toBe(4900);
    expect(catalog.REVIEW_EMAIL_ALLOWANCES).toEqual({
      chat_only: 500,
      sms_only: 500,
      sms_and_chat: 1000,
      full: 2000,
    });
    const price = {
      id: "price_newchat",
      active: true,
      type: "recurring",
      currency: "usd",
      unit_amount: 1500,
      recurring: {
        interval: "month",
        interval_count: 1,
        usage_type: "licensed",
      },
    };
    expect(() =>
      assertApprovedChatOnlyStripePrice(price as never),
    ).not.toThrow();
    expect(() =>
      assertApprovedChatOnlyStripePrice({
        ...price,
        unit_amount: 1000,
      } as never),
    ).toThrow();
    expect(() =>
      assertApprovedChatOnlyStripePrice({
        ...price,
        id: "price_originalchat",
        unit_amount: 1000,
      } as never),
    ).not.toThrow();
  });

  it("recognizes retained legacy subscriptions without requiring every acquisition price", async () => {
    vi.stubEnv("STRIPE_LEGACY_PRICE_FULL", "price_originalfull");
    vi.stubEnv("STRIPE_PRICE_FULL", "");
    vi.stubEnv("STRIPE_PRICE_SMS_ONLY", "");
    vi.stubEnv("STRIPE_PRICE_SMS_AND_CHAT", "");
    vi.resetModules();
    const { planFromStripePriceId, approvedBasePriceCents } =
      await import("./config");
    expect(planFromStripePriceId("price_originalfull")).toBe("full");
    expect(approvedBasePriceCents("full", "price_originalfull")).toBe(6500);
    expect(() =>
      approvedBasePriceCents("chat_only", "price_originalfull"),
    ).toThrow();
  });

  it("cannot sell a retained legacy Price as the new package", async () => {
    vi.stubEnv("NEXT_PUBLIC_CUSTOMER_REVIEWS_PRICING_ENABLED", "1");
    vi.stubEnv("STRIPE_PRICE_CHAT_ONLY", "price_legacy");
    vi.stubEnv("STRIPE_LEGACY_PRICE_CHAT_ONLY", "price_legacy");
    vi.resetModules();
    const { stripePriceIdForPlan, approvedBasePriceCents } =
      await import("./config");
    expect(() => stripePriceIdForPlan("chat_only")).toThrow(
      "distinct Stripe Price IDs",
    );
    expect(() => approvedBasePriceCents("chat_only", "price_legacy")).toThrow(
      "distinct Stripe Price IDs",
    );
  });

  it("rejects a legacy Price accidentally assigned to another current plan", async () => {
    vi.stubEnv("STRIPE_LEGACY_PRICE_CHAT_ONLY", "price_collision");
    vi.stubEnv("STRIPE_PRICE_SMS_ONLY", "price_collision");
    vi.resetModules();
    const { planFromStripePriceId } = await import("./config");
    expect(() => planFromStripePriceId("price_collision")).toThrow(
      "Stripe Price plan mismatch",
    );
  });
});
