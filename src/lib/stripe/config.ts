import type { SubscriptionPlan } from "@/types/database";

export const SETUP_FEE_CENTS = 2500;
export const SMS_OVERAGE_CENTS = 3;

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
    price: 10,
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
    ],
  },
  sms_only: {
    name: "Starter / SMS Only",
    price: 25,
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
    ],
  },
  sms_and_chat: {
    name: "Growth / SMS + Web Chat",
    price: 45,
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
    ],
  },
  full: {
    name: "Pro / Full Suite",
    price: 65,
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
const NON_CHAT_PRICE_ENV = [
  ...Object.values(PLAN_PRICE_ENV),
  "STRIPE_PRICE_SETUP_FEE",
  "STRIPE_PRICE_SMS_OVERAGE_PART",
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
  if (plan === "chat_only") {
    const chatOnlyPriceId = readPriceId(CHAT_ONLY_PRICE_ENV);
    if (collidesWithConfiguredNonChatPrice(chatOnlyPriceId, process.env)) {
      throw new Error(
        `${CHAT_ONLY_PRICE_ENV} must not match another configured Stripe Price ID`,
      );
    }
    return chatOnlyPriceId;
  }

  return readPriceId(PLAN_PRICE_ENV[plan]);
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
