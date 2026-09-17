import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasValidChatOnlyStripePrice,
  planFromStripePriceId,
  stripePriceIdForPlan,
  stripePriceIds,
  SUBSCRIPTION_PLANS,
} from "./config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("launch pricing packages", () => {
  it("keeps the approved founding prices and included SMS pools", () => {
    expect(
      Object.fromEntries(
        Object.entries(SUBSCRIPTION_PLANS).map(([key, plan]) => [
          key,
          { price: plan.price, includedSmsParts: plan.includedSmsParts, includedVoiceMinutes: plan.includedVoiceMinutes },
        ]),
      ),
    ).toEqual({
      chat_only: { price: 10, includedSmsParts: 0, includedVoiceMinutes: 0 },
      sms_only: { price: 25, includedSmsParts: 500, includedVoiceMinutes: 0 },
      sms_and_chat: { price: 45, includedSmsParts: 1500, includedVoiceMinutes: 0 },
      full: { price: 65, includedSmsParts: 2500, includedVoiceMinutes: 100 },
    });
  });

  it("records the approved chat-only allowance without inventing AI caps for existing plans", () => {
    expect(SUBSCRIPTION_PLANS.chat_only).toMatchObject({
      name: "Chat Only",
      price: 10,
      includedSmsParts: 0,
      includedAiReplies: 200,
    });
    expect(SUBSCRIPTION_PLANS.chat_only.features).toEqual(
      expect.arrayContaining([
        "Website chat widget",
        "200 AI replies/month",
        "Google Calendar connection",
        "AI appointment scheduling",
      ]),
    );
    expect(SUBSCRIPTION_PLANS.sms_only.includedAiReplies).toBeNull();
    expect(SUBSCRIPTION_PLANS.sms_and_chat.includedAiReplies).toBeNull();
    expect(SUBSCRIPTION_PLANS.full.includedAiReplies).toBeNull();
  });

  it("describes Starter as automatic template texting and manual SMS, not AI", () => {
    const starterCopy = SUBSCRIPTION_PLANS.sms_only.features.join(" ");

    expect(starterCopy).toContain("Automatic missed-call text");
    expect(starterCopy).toContain("Manual SMS inbox and replies");
    expect(starterCopy).toContain("One local SimplAssist number");
    expect(starterCopy).not.toMatch(/\bAI\b/i);
  });

  it("starts full AI conversations and Calendar in Growth", () => {
    expect(SUBSCRIPTION_PLANS.sms_and_chat.features).toEqual(
      expect.arrayContaining([
        "Full AI SMS conversations",
        "Website chat widget",
        "Google Calendar connection",
        "AI appointment scheduling",
      ]),
    );
  });

  it("maps every configured Stripe base-plan Price ID to the correct plan", () => {
    vi.stubEnv("STRIPE_PRICE_SMS_ONLY", "price_test_starter");
    vi.stubEnv("STRIPE_PRICE_SMS_AND_CHAT", "price_test_growth");
    vi.stubEnv("STRIPE_PRICE_FULL", "price_test_full");

    expect(planFromStripePriceId("price_test_starter")).toBe("sms_only");
    expect(planFromStripePriceId("price_test_growth")).toBe("sms_and_chat");
    expect(planFromStripePriceId("price_test_full")).toBe("full");
  });

  it("does not require a Chat Only Stripe price for existing plan mappings", () => {
    vi.stubEnv("STRIPE_PRICE_SMS_ONLY", "price_test_starter");
    vi.stubEnv("STRIPE_PRICE_SMS_AND_CHAT", "price_test_growth");
    vi.stubEnv("STRIPE_PRICE_FULL", "price_test_full");
    vi.stubEnv("STRIPE_PRICE_CHAT_ONLY", "");

    expect(stripePriceIds()).toEqual({
      sms_only: "price_test_starter",
      sms_and_chat: "price_test_growth",
      full: "price_test_full",
    });
    expect(planFromStripePriceId("price_test_chat_only")).toBeNull();
  });

  it("resolves only the selected Chat Only Price without changing the existing map", () => {
    vi.stubEnv("STRIPE_PRICE_SMS_ONLY", "price_test_starter");
    vi.stubEnv("STRIPE_PRICE_SMS_AND_CHAT", "price_test_growth");
    vi.stubEnv("STRIPE_PRICE_FULL", "price_test_full");
    vi.stubEnv("STRIPE_PRICE_CHAT_ONLY", "price_test_chat_only");

    expect(stripePriceIdForPlan("chat_only")).toBe("price_test_chat_only");
    expect(hasValidChatOnlyStripePrice()).toBe(true);
    expect(planFromStripePriceId("price_test_chat_only")).toBe("chat_only");
  });

  it.each([undefined, "", "prod_wrong", "price_"])(
    "reports Chat Only Price readiness without throwing for %j",
    (value) => {
      const environment = {
        STRIPE_PRICE_CHAT_ONLY: value,
      };

      expect(hasValidChatOnlyStripePrice(environment)).toBe(false);
    },
  );

  it("fails only a selected Chat Only lookup when its Price is absent", () => {
    vi.stubEnv("STRIPE_PRICE_CHAT_ONLY", "");

    expect(() => stripePriceIdForPlan("chat_only")).toThrow(
      "STRIPE_PRICE_CHAT_ONLY is required",
    );
  });

  it("maps an existing SMS Price while Chat Only is unset", () => {
    vi.stubEnv("STRIPE_PRICE_SMS_ONLY", "price_test_starter");
    vi.stubEnv("STRIPE_PRICE_SMS_AND_CHAT", "price_test_growth");
    vi.stubEnv("STRIPE_PRICE_FULL", "price_test_full");
    vi.stubEnv("STRIPE_PRICE_CHAT_ONLY", "");

    expect(planFromStripePriceId("price_test_starter")).toBe("sms_only");
    expect(stripePriceIdForPlan("sms_only")).toBe("price_test_starter");
  });

  it("fails readiness, strict lookup, and reverse mapping on an SMS Price collision", () => {
    vi.stubEnv("STRIPE_PRICE_SMS_ONLY", "price_collision");
    vi.stubEnv("STRIPE_PRICE_SMS_AND_CHAT", "price_test_growth");
    vi.stubEnv("STRIPE_PRICE_FULL", "price_test_full");
    vi.stubEnv("STRIPE_PRICE_CHAT_ONLY", "price_collision");

    expect(hasValidChatOnlyStripePrice()).toBe(false);
    expect(() => stripePriceIdForPlan("chat_only")).toThrow(
      "must not match another configured Stripe Price ID",
    );
    expect(() => planFromStripePriceId("price_collision")).toThrow(
      "must not match another configured Stripe Price ID",
    );
  });

  it.each(["STRIPE_PRICE_SETUP_FEE", "STRIPE_PRICE_SMS_OVERAGE_PART"] as const)(
    "fails Chat Only readiness and lookup when it collides with %s",
    (environmentName) => {
      vi.stubEnv("STRIPE_PRICE_SMS_ONLY", "price_test_starter");
      vi.stubEnv("STRIPE_PRICE_SMS_AND_CHAT", "price_test_growth");
      vi.stubEnv("STRIPE_PRICE_FULL", "price_test_full");
      vi.stubEnv("STRIPE_PRICE_CHAT_ONLY", "price_collision");
      vi.stubEnv(environmentName, "price_collision");

      expect(hasValidChatOnlyStripePrice()).toBe(false);
      expect(() => stripePriceIdForPlan("chat_only")).toThrow(
        "must not match another configured Stripe Price ID",
      );
      expect(() => planFromStripePriceId("price_collision")).toThrow(
        "must not match another configured Stripe Price ID",
      );
    },
  );

  it("maps a known SMS Price even when the dormant Chat environment value is malformed", () => {
    vi.stubEnv("STRIPE_PRICE_SMS_ONLY", "price_test_starter");
    vi.stubEnv("STRIPE_PRICE_SMS_AND_CHAT", "price_test_growth");
    vi.stubEnv("STRIPE_PRICE_FULL", "price_test_full");
    vi.stubEnv("STRIPE_PRICE_CHAT_ONLY", "not_a_price");

    expect(planFromStripePriceId("price_test_starter")).toBe("sms_only");
    expect(() => planFromStripePriceId("price_unknown")).toThrow(
      "STRIPE_PRICE_CHAT_ONLY must be a Stripe Price ID",
    );
  });
});
