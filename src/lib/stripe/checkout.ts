import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { stripe } from "./client";
import { claimCheckoutPlanFamily } from "@/lib/billing/planFamilyLock.server";
import { createSmsCheckout } from "./smsBilling.server";
import type { SubscriptionPlan } from "@/types/database";
import {
  assertApprovedChatOnlyStripePrice,
  ChatOnlyStripePriceConfigurationError,
} from "./chatOnlyPrice";
import {
  acquireChatOnlyCheckoutAttempt,
  ChatOnlyCheckoutAttemptUnavailableError,
  expireChatOnlyCheckoutAttempt,
  recordChatOnlyCheckoutSession,
  releaseChatOnlyCheckoutAttemptClaim,
} from "./chatOnlyCheckoutAttempt.server";
import {
  syncCheckoutSession,
  type SyncedCheckout,
} from "./subscriptionSync";

export { ChatOnlyStripePriceConfigurationError } from "./chatOnlyPrice";
export {
  ChatOnlyCheckoutAttemptConflictError,
  ChatOnlyCheckoutAttemptRecoveryRequiredError,
  ChatOnlyCheckoutAttemptUnavailableError,
} from "./chatOnlyCheckoutAttempt.server";

export class ChatOnlyCheckoutInProgressError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("chat_only_checkout_in_progress");
    this.name = "ChatOnlyCheckoutInProgressError";
  }
}

export class ChatOnlyCheckoutSessionExpiredError extends Error {
  constructor() {
    super("chat_only_checkout_session_expired");
    this.name = "ChatOnlyCheckoutSessionExpiredError";
  }
}

export class ChatOnlyCheckoutRecoveredCompletionError extends Error {
  constructor(readonly synced: SyncedCheckout) {
    super("chat_only_checkout_recovered_completion");
    this.name = "ChatOnlyCheckoutRecoveredCompletionError";
  }
}

const BILLING_PORTAL_CONFIGURATION_ENV =
  "STRIPE_BILLING_PORTAL_CONFIGURATION_ID";
const BILLING_PORTAL_CONFIGURATION_ID_PATTERN = /^bpc_[A-Za-z0-9]+$/;

function billingPortalConfigurationId(): string {
  const configurationId = process.env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID;

  if (!configurationId) {
    throw new Error(`${BILLING_PORTAL_CONFIGURATION_ENV} is required`);
  }

  if (!BILLING_PORTAL_CONFIGURATION_ID_PATTERN.test(configurationId)) {
    throw new Error(
      `${BILLING_PORTAL_CONFIGURATION_ENV} must be a Stripe Billing Portal configuration ID (bpc_...)`,
    );
  }

  return configurationId;
}

export async function createCheckoutSession(
  businessId: string,
  plan: SubscriptionPlan,
  planPriceId: string,
  setupFeePriceId: string | null,
  successUrl: string,
  cancelUrl: string,
  mode: "onboarding" | "billing" = "billing",
  requireOnboardingIntent = false,
): Promise<string | null> {
  if (plan === "chat_only") {
    if (setupFeePriceId !== null) {
      throw new ChatOnlyStripePriceConfigurationError();
    }
    await assertChatOnlyStripePrice(planPriceId);
  }

  if (plan === "chat_only") {
    // Migration 064 atomically validates direct authority, claims the Chat
    // family, and creates/recovers the durable attempt under one business-row
    // lock. A separate 059 claim would leave a race that could strand a family
    // lock without any attempt when authority changes between transactions.
    return createSingleFlightChatOnlyCheckout({
      businessId,
      planPriceId,
      successUrl,
      cancelUrl,
      mode,
    });
  }

  // Keep onboarding/family authorization; payable SMS work uses durable identity.
  await claimCheckoutPlanFamily(businessId, plan, requireOnboardingIntent);
  return createSmsCheckout({ businessId, plan, priceId: planPriceId, setupFeePriceId, successUrl, cancelUrl, mode });
}

async function createSingleFlightChatOnlyCheckout(args: {
  businessId: string;
  planPriceId: string;
  successUrl: string;
  cancelUrl: string;
  mode: "onboarding" | "billing";
}): Promise<string> {
  if (args.mode !== "onboarding") {
    throw new ChatOnlyCheckoutAttemptUnavailableError();
  }

  const requestFingerprint = chatOnlyCheckoutRequestFingerprint(args);
  const decision = await acquireChatOnlyCheckoutAttempt({
    businessId: args.businessId,
    stripePriceId: args.planPriceId,
    requestFingerprint,
    claimToken: randomUUID(),
  });

  if (decision.outcome === "in_progress") {
    throw new ChatOnlyCheckoutInProgressError(decision.retryAfterSeconds);
  }

  if (decision.outcome === "open") {
    const session = await stripe.checkout.sessions.retrieve(decision.sessionId);
    assertAttemptSessionBinding(session, {
      businessId: args.businessId,
      attemptId: decision.attemptId,
      requestFingerprint,
      expectedSessionId: decision.sessionId,
      expectedCustomerId: decision.customerId,
      sessionExpiresAt: decision.sessionExpiresAt,
    });
    return resolveKnownChatOnlySession(session, {
      businessId: args.businessId,
      attemptId: decision.attemptId,
      requestFingerprint,
      sessionExpiresAt: decision.sessionExpiresAt,
    });
  }

  const expiresAtSeconds = timestampSeconds(decision.sessionExpiresAt);
  const metadata = {
    business_id: args.businessId,
    plan: "chat_only",
    mode: "onboarding",
    checkout_attempt_id: decision.attemptId,
    checkout_request_fingerprint: requestFingerprint,
    checkout_session_expires_at: decision.sessionExpiresAt,
  };

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        client_reference_id: args.businessId,
        mode: "subscription",
        payment_method_types: ["card"],
        allow_promotion_codes: true,
        line_items: [{ price: args.planPriceId, quantity: 1 }],
        success_url: args.successUrl,
        cancel_url: args.cancelUrl,
        expires_at: expiresAtSeconds,
        subscription_data: { metadata },
        metadata,
      },
      {
        idempotencyKey: `chat-checkout-session-v1:${decision.attemptId}`,
      },
    );
  } catch (error) {
    if (isStripeIdempotencyInUseError(error)) {
      throw new ChatOnlyCheckoutInProgressError(5);
    }
    await releaseAttemptClaimBestEffort(
      decision.attemptId,
      decision.claimToken,
    );
    throw error;
  }

  // Once Stripe returned an object, malformed or contradictory evidence is an
  // ambiguous provider outcome. Keep the durable attempt claimed; never open
  // another generation merely because validation or persistence failed.
  assertAttemptSessionBinding(session, {
    businessId: args.businessId,
    attemptId: decision.attemptId,
    requestFingerprint,
    expectedSessionId: null,
    expectedCustomerId: decision.customerId,
    sessionExpiresAt: decision.sessionExpiresAt,
  });

  if (session.status !== "open") {
    return resolveKnownChatOnlySession(session, {
      businessId: args.businessId,
      attemptId: decision.attemptId,
      requestFingerprint,
      sessionExpiresAt: decision.sessionExpiresAt,
    });
  }
  if (!session.url) {
    throw new Error("chat_only_checkout_session_url_missing");
  }

  await recordChatOnlyCheckoutSession({
    attemptId: decision.attemptId,
    claimToken: decision.claimToken,
    sessionId: session.id,
    customerId: stripeObjectId(session.customer),
    checkoutUrl: session.url,
    sessionExpiresAt: decision.sessionExpiresAt,
  });

  return session.url;
}

async function resolveKnownChatOnlySession(
  session: Stripe.Checkout.Session,
  attempt: {
    businessId: string;
    attemptId: string;
    requestFingerprint: string;
    sessionExpiresAt: string;
  },
): Promise<string> {
  if (session.status === "expired") {
    await expireChatOnlyCheckoutAttempt({
      businessId: attempt.businessId,
      attemptId: attempt.attemptId,
      sessionId: session.id,
      requestFingerprint: attempt.requestFingerprint,
      sessionExpiresAt: attempt.sessionExpiresAt,
    });
    // A second HTTP request may now create the reviewed next generation. Keep
    // this request to one recovery/create call and never loop provider calls.
    throw new ChatOnlyCheckoutSessionExpiredError();
  }

  if (session.status === "complete") {
    const synced = await syncCheckoutSession(session);
    if (!synced || synced.plan !== "chat_only") {
      throw new Error("chat_only_checkout_completion_sync_unavailable");
    }
    throw new ChatOnlyCheckoutRecoveredCompletionError(synced);
  }

  if (session.status !== "open" || !session.url) {
    throw new Error("chat_only_checkout_session_state_invalid");
  }
  return session.url;
}

function assertAttemptSessionBinding(
  session: Stripe.Checkout.Session,
  expected: {
    businessId: string;
    attemptId: string;
    requestFingerprint: string;
    expectedSessionId: string | null;
    expectedCustomerId: string | null;
    sessionExpiresAt: string;
  },
): void {
  const customerId = stripeObjectId(session.customer);
  if (
    !/^cs_[A-Za-z0-9_]+$/.test(session.id) ||
    (expected.expectedSessionId !== null &&
      session.id !== expected.expectedSessionId) ||
    session.mode !== "subscription" ||
    session.client_reference_id !== expected.businessId ||
    session.metadata?.business_id !== expected.businessId ||
    session.metadata?.plan !== "chat_only" ||
    session.metadata?.mode !== "onboarding" ||
    session.metadata?.checkout_attempt_id !== expected.attemptId ||
    session.metadata?.checkout_request_fingerprint !==
      expected.requestFingerprint ||
    session.metadata?.checkout_session_expires_at !==
      expected.sessionExpiresAt ||
    !Number.isInteger(session.expires_at) ||
    session.expires_at !== timestampSeconds(expected.sessionExpiresAt) ||
    (expected.expectedCustomerId !== null &&
      customerId !== expected.expectedCustomerId)
  ) {
    throw new Error("chat_only_checkout_session_binding_invalid");
  }
}

function chatOnlyCheckoutRequestFingerprint(args: {
  businessId: string;
  planPriceId: string;
  successUrl: string;
  cancelUrl: string;
  mode: "onboarding" | "billing";
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        businessId: args.businessId,
        plan: "chat_only",
        mode: args.mode,
        planPriceId: args.planPriceId,
        successUrl: args.successUrl,
        cancelUrl: args.cancelUrl,
      }),
      "utf8",
    )
    .digest("hex");
}

function timestampSeconds(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || milliseconds % 1_000 !== 0) {
    throw new Error("chat_only_checkout_session_expiry_invalid");
  }
  return milliseconds / 1_000;
}

function stripeObjectId(
  value: string | { id: string } | null,
): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}

function isStripeIdempotencyInUseError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "idempotency_key_in_use"
  );
}

async function releaseAttemptClaimBestEffort(
  attemptId: string,
  claimToken: string,
): Promise<void> {
  const release = releaseChatOnlyCheckoutAttemptClaim({
    attemptId,
    claimToken,
  }).catch(() => undefined);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    release,
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, 500);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
}

async function assertChatOnlyStripePrice(priceId: string): Promise<void> {
  const price = await stripe.prices.retrieve(priceId);
  assertApprovedChatOnlyStripePrice(price, {
    expectedPriceId: priceId,
    requireActive: true,
  });
}

export async function createBillingPortalSession(
  stripeCustomerId: string,
  returnUrl: string,
): Promise<string> {
  const configurationId = billingPortalConfigurationId();
  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl,
    configuration: configurationId,
  });

  return session.url;
}
