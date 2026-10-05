import type { SubscriptionPlan } from "@/types/database";

// Public package copy and checkout validation must switch together in a build.
// This is a release flag, not a tenant entitlement or a subscription migration.
export const CUSTOMER_REVIEWS_PRICING_ENABLED =
  process.env.NEXT_PUBLIC_CUSTOMER_REVIEWS_PRICING_ENABLED === "1";
export const LEGACY_PLAN_PRICES: Record<SubscriptionPlan, number> = {
  chat_only: 10,
  sms_only: 25,
  sms_and_chat: 45,
  full: 65,
};
export const CUSTOMER_REVIEW_PLAN_PRICES: Record<SubscriptionPlan, number> = {
  chat_only: 15,
  sms_only: 29,
  sms_and_chat: 49,
  full: 79,
};
export const REVIEW_EMAIL_ALLOWANCES: Record<SubscriptionPlan, number> = {
  chat_only: 500,
  sms_only: 500,
  sms_and_chat: 1000,
  full: 2000,
};
export const REVIEW_SMS_ADDON_CENTS = 2000;
export const REVIEW_SMS_INCLUDED_PARTS = 250;
export const REVIEW_SMS_ACTIVATION_CENTS = 2500;
export const SETUP_FEE_CENTS = CUSTOMER_REVIEWS_PRICING_ENABLED
  ? REVIEW_SMS_ACTIVATION_CENTS
  : 2500;
export const SMS_OVERAGE_CENTS = 3;

const packagePrices = CUSTOMER_REVIEWS_PRICING_ENABLED
  ? CUSTOMER_REVIEW_PLAN_PRICES
  : LEGACY_PLAN_PRICES;
export const customerFeatures = (plan: SubscriptionPlan): string[] =>
  CUSTOMER_REVIEWS_PRICING_ENABLED
    ? [
        "Customer workspace with CSV import and export",
        `${REVIEW_EMAIL_ALLOWANCES[plan].toLocaleString("en-US")} review emails/billing month`,
        "Scheduled review requests and one optional reminder",
      ]
    : [];

export const SUBSCRIPTION_PLANS: Record<
  SubscriptionPlan,
  {
    name: string;
    price: number;
    includedSmsParts: number;
    includedVoiceMinutes: number;
    includedAiReplies: number | null;
    features: string[];
  }
> = {
  chat_only: {
    name: "Chat Only",
    price: packagePrices.chat_only,
    includedSmsParts: 0,
    includedVoiceMinutes: 0,
    includedAiReplies: 200,
    features: [
      "Website chat widget",
      "200 AI replies/month",
      "Custom widget branding",
      "Lead capture from web chat",
      "Conversation inbox",
      "AI answer, tone, FAQ, and service customization",
      "Google Calendar connection",
      "AI appointment scheduling",
      ...customerFeatures("chat_only"),
    ],
  },
  sms_only: {
    name: "Starter / SMS Only",
    price: packagePrices.sms_only,
    includedSmsParts: 500,
    includedVoiceMinutes: 0,
    includedAiReplies: null,
    features: [
      "One local SimplAssist number",
      "Automatic missed-call text",
      "Manual SMS inbox and replies",
      "500 included SMS parts/month",
      "Contact management",
      "Conversation inbox",
      ...customerFeatures("sms_only"),
    ],
  },
  sms_and_chat: {
    name: "Growth / SMS + Web Chat",
    price: packagePrices.sms_and_chat,
    includedSmsParts: 1500,
    includedVoiceMinutes: 0,
    includedAiReplies: null,
    features: [
      "Everything in SMS Only",
      "Full AI SMS conversations",
      "Website chat widget",
      "Custom widget branding",
      "Lead capture from web chat",
      "AI answer, tone, FAQ, and service customization",
      "Google Calendar connection",
      "AI appointment scheduling",
      "1,500 included SMS parts/month",
      ...customerFeatures("sms_and_chat"),
    ],
  },
  full: {
    name: "Pro / Full Suite",
    price: packagePrices.full,
    includedSmsParts: 2500,
    includedVoiceMinutes: 100,
    includedAiReplies: null,
    features: [
      "Everything in SMS + Web Chat",
      "AI voice answering in English",
      "100 included voice minutes/billing month",
      "Voice contact capture, signup texts, and calendar booking",
      "Call transcripts and recordings",
      "Custom AI rules and guardrails",
      "2,500 included SMS parts/month",
      ...customerFeatures("full"),
    ],
  },
};

export const STRIPE_PRICED_PLAN_IDS = [
  "sms_only",
  "sms_and_chat",
  "full",
] as const satisfies readonly SubscriptionPlan[];

export type StripePricedSubscriptionPlan =
  (typeof STRIPE_PRICED_PLAN_IDS)[number];

const PLAN_PRICE_ENV: Record<StripePricedSubscriptionPlan, string> = {
  sms_only: "STRIPE_PRICE_SMS_ONLY",
  sms_and_chat: "STRIPE_PRICE_SMS_AND_CHAT",
  full: "STRIPE_PRICE_FULL",
};

const CHAT_ONLY_PRICE_ENV = "STRIPE_PRICE_CHAT_ONLY";
const LEGACY_PRICE_ENV: Record<SubscriptionPlan, string> = {
  chat_only: "STRIPE_LEGACY_PRICE_CHAT_ONLY",
  sms_only: "STRIPE_LEGACY_PRICE_SMS_ONLY",
  sms_and_chat: "STRIPE_LEGACY_PRICE_SMS_AND_CHAT",
  full: "STRIPE_LEGACY_PRICE_FULL",
};

/** Only the explicitly retained subscriptions need old-Price compatibility. */
export function legacyPlanFromStripePriceId(
  priceId: string | null | undefined,
): SubscriptionPlan | null {
  if (!priceId) return null;
  const matches = (
    Object.entries(LEGACY_PRICE_ENV) as [SubscriptionPlan, string][]
  ).filter(([, key]) => process.env[key] === priceId);
  if (matches.length > 1)
    throw new Error("A legacy Stripe Price cannot belong to multiple plans");
  return matches[0]?.[0] ?? null;
}

export function approvedBasePriceCents(
  plan: SubscriptionPlan,
  priceId: string,
): number {
  const legacy = legacyPlanFromStripePriceId(priceId);
  if (legacy && legacy !== plan) throw new Error("Stripe Price plan mismatch");
  if (
    legacy &&
    CUSTOMER_REVIEWS_PRICING_ENABLED &&
    process.env[
      plan === "chat_only" ? CHAT_ONLY_PRICE_ENV : PLAN_PRICE_ENV[plan]
    ] === priceId
  ) {
    throw new Error("New package prices must use distinct Stripe Price IDs");
  }
  return (
    (legacy ? LEGACY_PLAN_PRICES[plan] : SUBSCRIPTION_PLANS[plan].price) * 100
  );
}
const NON_CHAT_PRICE_ENV = [
  ...Object.values(PLAN_PRICE_ENV),
  "STRIPE_PRICE_SETUP_FEE",
  "STRIPE_PRICE_SMS_OVERAGE_PART",
  "STRIPE_PRICE_REVIEW_SMS",
  "STRIPE_PRICE_REVIEW_SMS_ACTIVATION",
] as const;

type StripePriceEnvironment = Readonly<Record<string, string | undefined>>;

export function stripePriceIds(): Record<StripePricedSubscriptionPlan, string> {
  return {
    sms_only: readPriceId(PLAN_PRICE_ENV.sms_only),
    sms_and_chat: readPriceId(PLAN_PRICE_ENV.sms_and_chat),
    full: readPriceId(PLAN_PRICE_ENV.full),
  };
}

export function isStripePricedSubscriptionPlan(
  plan: SubscriptionPlan,
): plan is StripePricedSubscriptionPlan {
  return (STRIPE_PRICED_PLAN_IDS as readonly SubscriptionPlan[]).includes(plan);
}

/**
 * Resolve only the selected plan's recurring Price.
 *
 * Chat Only is deliberately excluded from `stripePriceIds()`: existing SMS
 * webhook/configuration paths must keep working while its rollout flag is off
 * and STRIPE_PRICE_CHAT_ONLY is unset. The new environment variable is read
 * only after a caller has selected and authorized Chat Only.
 */
export function stripePriceIdForPlan(plan: SubscriptionPlan): string {
  const selected = readPriceId(
    plan === "chat_only" ? CHAT_ONLY_PRICE_ENV : PLAN_PRICE_ENV[plan],
  );
  if (
    CUSTOMER_REVIEWS_PRICING_ENABLED &&
    legacyPlanFromStripePriceId(selected)
  ) {
    throw new Error("New package prices must use distinct Stripe Price IDs");
  }
  if (plan === "chat_only") {
    const chatOnlyPriceId = readPriceId(CHAT_ONLY_PRICE_ENV);
    if (collidesWithConfiguredNonChatPrice(chatOnlyPriceId, process.env)) {
      throw new Error(
        `${CHAT_ONLY_PRICE_ENV} must not match another configured Stripe Price ID`,
      );
    }
    return chatOnlyPriceId;
  }

  return selected;
}

/**
 * Non-throwing readiness probe for server-side acquisition presentation.
 * Callers can keep Chat Only hidden until both their channel rollout flag and
 * this selected Price are ready without validating any unrelated SMS Price.
 */
export function hasValidChatOnlyStripePrice(
  environment: StripePriceEnvironment = process.env,
): boolean {
  const value = environment[CHAT_ONLY_PRICE_ENV];
  return Boolean(
    value &&
    value.startsWith("price_") &&
    value.length > 6 &&
    !(
      CUSTOMER_REVIEWS_PRICING_ENABLED &&
      Object.values(LEGACY_PRICE_ENV).some((key) => environment[key] === value)
    ) &&
    !collidesWithConfiguredNonChatPrice(value, environment),
  );
}

export function stripeSetupFeePriceId(): string {
  return readPriceId("STRIPE_PRICE_SETUP_FEE");
}

export function stripeSmsOveragePriceId(): string {
  return readPriceId("STRIPE_PRICE_SMS_OVERAGE_PART");
}

export function planFromStripePriceId(
  priceId: string | null | undefined,
): SubscriptionPlan | null {
  if (!priceId) return null;
  const legacy = legacyPlanFromStripePriceId(priceId);
  if (legacy) {
    for (const [plan, envName] of Object.entries({
      ...PLAN_PRICE_ENV,
      chat_only: CHAT_ONLY_PRICE_ENV,
    })) {
      if (process.env[envName] === priceId && plan !== legacy)
        throw new Error("Stripe Price plan mismatch");
    }
    return legacy;
  }
  const ids = stripePriceIds();
  const rawChatOnlyPriceId = process.env[CHAT_ONLY_PRICE_ENV];
  if (
    rawChatOnlyPriceId &&
    Object.values(ids).some(
      (configuredId) => configuredId === rawChatOnlyPriceId,
    )
  ) {
    throw new Error(
      `${CHAT_ONLY_PRICE_ENV} must not match another configured Stripe Price ID`,
    );
  }
  const match = (
    Object.entries(ids) as [StripePricedSubscriptionPlan, string][]
  ).find(([, id]) => id === priceId);
  if (match) return match[0];

  // Reverse mapping is used by webhook synchronization, which must remain
  // deployable before the Chat Only Price exists. Missing is therefore a
  // supported state. A dormant malformed Chat value must also never break a
  // known SMS mapping, so strict Chat validation happens only after that
  // known-plan return above.
  const chatOnlyPriceId = readOptionalPriceId(CHAT_ONLY_PRICE_ENV);
  if (
    chatOnlyPriceId &&
    collidesWithConfiguredNonChatPrice(chatOnlyPriceId, process.env)
  ) {
    throw new Error(
      `${CHAT_ONLY_PRICE_ENV} must not match another configured Stripe Price ID`,
    );
  }
  return chatOnlyPriceId === priceId ? "chat_only" : null;
}

export function validateStripeEnv(): void {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    throw new Error("STRIPE_SECRET_KEY is required");
  }
}

function readPriceId(envName: string): string {
  const value = process.env[envName];
  if (!value) {
    throw new Error(`${envName} is required`);
  }
  if (!value.startsWith("price_")) {
    throw new Error(`${envName} must be a Stripe Price ID`);
  }
  return value;
}

function readOptionalPriceId(envName: string): string | null {
  const value = process.env[envName];
  if (!value) return null;
  if (!value.startsWith("price_")) {
    throw new Error(`${envName} must be a Stripe Price ID`);
  }
  return value;
}

function collidesWithConfiguredNonChatPrice(
  chatOnlyPriceId: string,
  environment: StripePriceEnvironment,
): boolean {
  return NON_CHAT_PRICE_ENV.some(
    (envName) => environment[envName] === chatOnlyPriceId,
  );
}
