import "server-only";

import type Stripe from "stripe";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { stripe } from "./client";
import { planFromStripePriceId } from "./config";
import { subscriptionPlanSchema } from "@/lib/billing/planSchema";
import { assertApprovedChatOnlyStripePrice } from "./chatOnlyPrice";
import {
  completeChatOnlyCheckoutAttempt,
  expireChatOnlyCheckoutAttempt,
} from "./chatOnlyCheckoutAttempt.server";
import type { SubscriptionPlan, SubscriptionStatus } from "@/types/database";
import { prepareVoiceSubscription, type VoiceSubscriptionSnapshot } from "./voiceSubscription.server";

export type SyncedCheckout = {
  businessId: string;
  customerId: string;
  subscriptionId: string;
  plan: SubscriptionPlan;
};

export async function syncCheckoutSession(
  session: Stripe.Checkout.Session,
): Promise<SyncedCheckout | null> {
  const isChatOnlyCheckout =
    session.metadata?.plan === "chat_only" ||
    hasChatOnlyCheckoutAttemptMarker(session);
  const chatBinding = isChatOnlyCheckout
    ? requireChatOnlyCheckoutBinding(session, "complete")
    : null;
  const businessId = session.metadata?.business_id;
  const customerId =
    typeof session.customer === "string" ? session.customer : null;
  const subscriptionId =
    typeof session.subscription === "string" ? session.subscription : null;

  if (
    chatBinding &&
    (!customerId ||
      !/^cus_[A-Za-z0-9]+$/.test(customerId) ||
      !subscriptionId ||
      !/^sub_[A-Za-z0-9]+$/.test(subscriptionId))
  ) {
    throw new Error(
      `[stripe:sync] Chat Only Checkout Session ${session.id} has invalid customer or subscription linkage`,
    );
  }

  if (!businessId || !customerId || !subscriptionId) {
    return null;
  }

  const metadataPlan = subscriptionPlanSchema.safeParse(session.metadata?.plan);
  if (!metadataPlan.success) {
    throw new Error(
      `[stripe:sync] Checkout Session ${session.id} has missing or invalid plan metadata`,
    );
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  if (chatBinding) {
    assertChatOnlySubscriptionBinding(
      subscription,
      chatBinding,
      customerId,
      subscriptionId,
    );
  }
  const completedAt =
    session.payment_status === "paid" || session.status === "complete"
      ? new Date().toISOString()
      : null;
  const synced = await syncStripeSubscription(subscription, {
    businessId,
    checkoutSessionId: session.id,
    setupFeePaidAt: completedAt,
    // Absence is authoritative and fail-closed. Every SMS checkout created by
    // this application includes the setup-fee Price in metadata; Chat Only
    // intentionally does not. Never fall back to a global setup-fee Price,
    // because that would stamp a fee onto a no-fee checkout.
    setupFeePriceId: session.metadata?.setup_fee_price_id ?? null,
    expectedPlan: metadataPlan.data,
  });

  if (synced?.plan === "chat_only") {
    await completeChatOnlyCheckoutAttempt({
      businessId: synced.businessId,
      attemptId: chatBinding!.attemptId,
      sessionId: session.id,
      customerId: synced.customerId,
      subscriptionId: synced.subscriptionId,
      requestFingerprint: chatBinding!.requestFingerprint,
      sessionExpiresAt: chatBinding!.sessionExpiresAt,
    });
  }

  return synced;
}

export async function syncExpiredCheckoutSession(
  session: Stripe.Checkout.Session,
): Promise<boolean> {
  if (
    session.metadata?.plan !== "chat_only" &&
    !hasChatOnlyCheckoutAttemptMarker(session)
  ) {
    return false;
  }

  const binding = requireChatOnlyCheckoutBinding(session, "expired");

  await expireChatOnlyCheckoutAttempt({
    businessId: binding.businessId,
    attemptId: binding.attemptId,
    sessionId: session.id,
    requestFingerprint: binding.requestFingerprint,
    sessionExpiresAt: binding.sessionExpiresAt,
  });
  return true;
}

type ChatOnlyCheckoutBinding = {
  businessId: string;
  attemptId: string;
  requestFingerprint: string;
  sessionExpiresAt: string;
};

function requireChatOnlyCheckoutBinding(
  session: Stripe.Checkout.Session,
  expectedStatus: "complete" | "expired",
): ChatOnlyCheckoutBinding {
  const businessId = session.metadata?.business_id;
  const attemptId = session.metadata?.checkout_attempt_id;
  const requestFingerprint =
    session.metadata?.checkout_request_fingerprint;
  const sessionExpiresAt =
    session.metadata?.checkout_session_expires_at;
  if (
    typeof businessId !== "string" ||
    !isUuid(businessId) ||
    typeof attemptId !== "string" ||
    !isUuid(attemptId) ||
    typeof requestFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(requestFingerprint) ||
    typeof sessionExpiresAt !== "string" ||
    !isSecondAlignedTimestamp(sessionExpiresAt) ||
    Date.parse(sessionExpiresAt) !== session.expires_at * 1_000 ||
    !/^cs_[A-Za-z0-9_]+$/.test(session.id) ||
    session.metadata?.mode !== "onboarding" ||
    session.metadata?.plan !== "chat_only" ||
    session.client_reference_id !== businessId ||
    session.mode !== "subscription" ||
    session.status !== expectedStatus ||
    !Number.isInteger(session.expires_at) ||
    session.expires_at <= 0 ||
    (expectedStatus === "complete" &&
      session.payment_status !== "paid" &&
      session.payment_status !== "no_payment_required")
  ) {
    throw new Error(
      `[stripe:sync] Chat Only Checkout Session ${session.id} has invalid single-flight binding`,
    );
  }

  return {
    businessId,
    attemptId,
    requestFingerprint,
    sessionExpiresAt,
  };
}

function hasChatOnlyCheckoutAttemptMarker(
  session: Stripe.Checkout.Session,
): boolean {
  return Boolean(
    session.metadata?.checkout_attempt_id ||
      session.metadata?.checkout_request_fingerprint ||
      session.metadata?.checkout_session_expires_at,
  );
}

function assertChatOnlySubscriptionBinding(
  subscription: Stripe.Subscription,
  checkout: ChatOnlyCheckoutBinding,
  sessionCustomerId: string,
  sessionSubscriptionId: string,
): void {
  const subscriptionCustomerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : null;
  const subscriptionAttempt = requireChatOnlySubscriptionAttemptMetadata(
    subscription,
    checkout.businessId,
  );
  if (
    subscriptionCustomerId !== sessionCustomerId ||
    subscription.id !== sessionSubscriptionId ||
    subscriptionAttempt.attemptId !== checkout.attemptId ||
    subscriptionAttempt.requestFingerprint !== checkout.requestFingerprint ||
    subscriptionAttempt.sessionExpiresAt !== checkout.sessionExpiresAt
  ) {
    throw new Error(
      `[stripe:sync] Chat Only subscription ${subscription.id} does not match Checkout single-flight binding`,
    );
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export async function syncStripeSubscription(
  subscription: Stripe.Subscription,
  options: {
    businessId?: string | null;
    checkoutSessionId?: string | null;
    setupFeePaidAt?: string | null;
    setupFeePriceId?: string | null;
    expectedPlan?: SubscriptionPlan;
  } = {},
): Promise<SyncedCheckout | null> {
  // Preserve unconditional status validation. Commercial voice additionally
  // versions a fresh provider read, so event arrival order cannot mint minutes.
  normalizeStripeSubscriptionStatus(subscription.status);
  const voice = await prepareVoiceSubscription(subscription, options.businessId ?? subscription.metadata?.business_id);
  if (voice.ignored) return null;
  return syncSubscriptionSnapshot(voice.subscription, options, voice);
}

async function syncSubscriptionSnapshot(
  subscription: Stripe.Subscription,
  options: {
    businessId?: string | null;
    checkoutSessionId?: string | null;
    setupFeePaidAt?: string | null;
    setupFeePriceId?: string | null;
    expectedPlan?: SubscriptionPlan;
  },
  voice: VoiceSubscriptionSnapshot,
): Promise<SyncedCheckout | null> {
  const businessId = options.businessId ?? subscription.metadata?.business_id;
  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : null;
  const subscriptionId = subscription.id;
  const primaryItem = subscription.items.data[0];
  const priceId = primaryItem?.price.id ?? null;
  const hasChatOnlyAttemptAuthority =
    subscription.metadata?.plan === "chat_only" ||
    hasChatOnlySubscriptionAttemptMarker(subscription);
  const configuredPlan = hasChatOnlyAttemptAuthority
    ? null
    : planFromStripePriceId(priceId);
  const isChatOnlySubscription =
    hasChatOnlyAttemptAuthority || configuredPlan === "chat_only";
  // Exact attempt metadata remains a recovery authority if the acquisition
  // Price environment value is accidentally removed after Stripe has already
  // created payable work. The embedded Price terms are still validated below,
  // and the service RPC binds its Price ID to the private attempt ledger.
  const plan: SubscriptionPlan | null = isChatOnlySubscription
    ? "chat_only"
    : configuredPlan;
  // Normalize BEFORE the linkage early-return: an absent/unknown status
  // must throw unconditionally (the guarantee the old route-level guard
  // provided), never be silently acked because linkage also failed to
  // resolve. Valid-status events with unresolvable linkage keep their
  // deliberate null-ack below.
  const status = normalizeStripeSubscriptionStatus(subscription.status);

  if (options.expectedPlan && plan !== options.expectedPlan) {
    throw new Error(
      `[stripe:sync] Checkout plan metadata ${options.expectedPlan} does not match subscription Price plan ${String(plan)}`,
    );
  }

  if (plan === "chat_only") {
    if (!primaryItem) {
      throw new Error("[stripe:sync] Chat Only subscription has no item");
    }
    assertApprovedChatOnlyStripePrice(primaryItem.price, {
      expectedPriceId: priceId ?? undefined,
      requireActive: false,
      subscriptionItemCount: subscription.items.has_more
        ? subscription.items.data.length + 1
        : subscription.items.data.length,
      quantity: primaryItem.quantity ?? null,
    });
  }

  const chatAttempt = isChatOnlySubscription
    ? (() => {
        if (
          typeof businessId !== "string" ||
          !isUuid(businessId) ||
          !customerId ||
          !/^cus_[A-Za-z0-9]+$/.test(customerId) ||
          !subscriptionId ||
          !/^sub_[A-Za-z0-9]+$/.test(subscriptionId)
        ) {
          throw new Error(
            `[stripe:sync] Chat Only subscription ${String(subscriptionId)} has invalid business, customer, or subscription linkage`,
          );
        }
        return requireChatOnlySubscriptionAttemptMetadata(
          subscription,
          businessId,
        );
      })()
    : null;

  if (!businessId || !customerId || !subscriptionId || !plan) {
    return null;
  }
  // Plan-family rules prohibit Full -> Chat Only. Do not bypass its dedicated
  // checkout-attempt authority to repair a malformed commercial voice binding.
  if (voice.revision !== null && chatAttempt) throw new Error("voice_billing_plan_family_mismatch");
  if (voice.revision !== null && plan === "full") {
    const price = primaryItem?.price;
    if (price?.currency !== "usd" || price.unit_amount !== 6500 || price.type !== "recurring" ||
        price.recurring?.interval !== "month" || price.recurring.interval_count !== 1 ||
        price.recurring.usage_type !== "licensed" || primaryItem.quantity !== 1) {
      throw new Error("voice_billing_package_mismatch");
    }
  }
  const setupFeePriceId =
    plan === "chat_only" ? null : (options.setupFeePriceId ?? null);
  const setupFeePaidAt =
    setupFeePriceId === null ? null : (options.setupFeePaidAt ?? null);
  const periodStart = primaryItem?.current_period_start
    ? new Date(primaryItem.current_period_start * 1000).toISOString()
    : null;
  const periodEnd = primaryItem?.current_period_end
    ? new Date(primaryItem.current_period_end * 1000).toISOString()
    : null;
  const now = new Date().toISOString();

  const { data: synced, error } = chatAttempt
    ? await supabaseAdmin.rpc("sync_chat_only_subscription_from_attempt", {
        p_business_id: businessId,
        p_attempt_id: chatAttempt.attemptId,
        p_request_fingerprint: chatAttempt.requestFingerprint,
        p_checkout_session_expires_at: chatAttempt.sessionExpiresAt,
        p_stripe_customer_id: customerId,
        p_stripe_subscription_id: subscriptionId,
        p_status: status,
        p_current_period_start: periodStart,
        p_current_period_end: periodEnd,
        p_stripe_price_id: priceId,
        p_stripe_checkout_session_id: options.checkoutSessionId ?? null,
        p_cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
        p_updated_at: now,
      })
    : await supabaseAdmin.rpc(
        voice.revision === null ? "sync_stripe_subscription_if_business_active" : "sync_voice_stripe_subscription",
        {
          p_business_id: businessId,
          p_stripe_customer_id: customerId,
          p_stripe_subscription_id: subscriptionId,
          p_plan: plan,
          p_status: status,
          p_current_period_start: periodStart,
          p_current_period_end: periodEnd,
          p_stripe_price_id: priceId,
          p_stripe_setup_fee_price_id: setupFeePriceId,
          p_stripe_checkout_session_id: options.checkoutSessionId ?? null,
          p_setup_fee_paid_at: setupFeePaidAt,
          p_cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
          p_updated_at: now,
          ...(voice.revision === null ? {} : { p_revision: voice.revision, p_effective_at: voice.observedAt }),
        },
      );

  if (error) {
    throw new Error(
      `[stripe:sync] Failed to sync subscription ${subscriptionId} for business ${businessId}: ${error.message}`,
    );
  }

  if (synced === false) {
    return null;
  }
  if (synced !== true) {
    throw new Error(
      `[stripe:sync] Guarded sync returned an invalid response for subscription ${subscriptionId} and business ${businessId}`,
    );
  }

  return { businessId, customerId, subscriptionId, plan };
}

function requireChatOnlySubscriptionAttemptMetadata(
  subscription: Stripe.Subscription,
  expectedBusinessId: string,
): ChatOnlyCheckoutBinding {
  const businessId = subscription.metadata?.business_id;
  const attemptId = subscription.metadata?.checkout_attempt_id;
  const requestFingerprint =
    subscription.metadata?.checkout_request_fingerprint;
  const sessionExpiresAt =
    subscription.metadata?.checkout_session_expires_at;
  if (
    businessId !== expectedBusinessId ||
    !isUuid(businessId) ||
    subscription.metadata?.plan !== "chat_only" ||
    subscription.metadata?.mode !== "onboarding" ||
    typeof attemptId !== "string" ||
    !isUuid(attemptId) ||
    typeof requestFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(requestFingerprint) ||
    typeof sessionExpiresAt !== "string" ||
    !isSecondAlignedTimestamp(sessionExpiresAt)
  ) {
    throw new Error(
      `[stripe:sync] Chat Only subscription ${subscription.id} has invalid Checkout attempt metadata`,
    );
  }

  return { businessId, attemptId, requestFingerprint, sessionExpiresAt };
}

function hasChatOnlySubscriptionAttemptMarker(
  subscription: Stripe.Subscription,
): boolean {
  return Boolean(
    subscription.metadata?.checkout_attempt_id ||
      subscription.metadata?.checkout_request_fingerprint ||
      subscription.metadata?.checkout_session_expires_at,
  );
}

function isSecondAlignedTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return (
    value.length >= 20 &&
    value.length <= 40 &&
    Number.isFinite(milliseconds) &&
    milliseconds % 1_000 === 0
  );
}

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
