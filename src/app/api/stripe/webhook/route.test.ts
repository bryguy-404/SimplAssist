import { NextRequest } from "next/server";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  constructEvent: vi.fn(),
  retrieve: vi.fn(),
  from: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  is: vi.fn(),
  not: vi.fn(),
  select: vi.fn(),
  rpc: vi.fn(),
  syncCheckoutSession: vi.fn(),
  syncExpiredCheckoutSession: vi.fn(),
  syncStripeSubscription: vi.fn(),
  finalizePaidCheckout: vi.fn(),
}));

vi.mock("@/lib/stripe/client", () => ({
  stripe: {
    webhooks: { constructEvent: mocks.constructEvent },
    subscriptions: { retrieve: mocks.retrieve },
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("@/lib/stripe/subscriptionSync", () => ({
  syncCheckoutSession: mocks.syncCheckoutSession,
  syncExpiredCheckoutSession: mocks.syncExpiredCheckoutSession,
  syncStripeSubscription: mocks.syncStripeSubscription,
}));
vi.mock("@/lib/billing/finalizePaidCheckout.server", () => ({
  finalizePaidCheckout: mocks.finalizePaidCheckout,
}));

import { POST as stripeWebhook } from "./route";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000001";
const CUSTOMER_ID = "cus_test_webhook";
const SUBSCRIPTION_ID = "sub_test_webhook";

function event(
  type: Stripe.Event.Type,
  object: Record<string, unknown>,
  id = `evt_test_${type.replaceAll(".", "_")}`,
  provenance: Partial<
    Pick<Stripe.Event, "livemode" | "account" | "context">
  > = {},
): Stripe.Event {
  return {
    id,
    type,
    livemode: false,
    ...provenance,
    data: { object },
  } as unknown as Stripe.Event;
}

function request(withSignature = true) {
  const headers = new Headers();
  if (withSignature) headers.set("stripe-signature", "test-signature");
  return new NextRequest("http://localhost/api/stripe/webhook", {
    method: "POST",
    headers,
    body: "{}",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_unit_only");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test_only");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.insert.mockResolvedValue({ error: null });
  // The builder is both awaited mid-chain and chained onward, matching the
  // real thenable query builder: markStripeEventProcessed awaits
  // .update().eq(); markStripeEventFailed awaits .update().eq().is(); the
  // re-claim chains .update().eq().is().not().select(). So eq and is each
  // return a thenable that also carries the next chain step.
  mocks.select.mockResolvedValue({ data: [], error: null });
  mocks.not.mockImplementation(() => ({ select: mocks.select }));
  mocks.is.mockImplementation(() => {
    const result = Promise.resolve({ error: null });
    return {
      not: mocks.not,
      then: result.then.bind(result),
      catch: result.catch.bind(result),
    };
  });
  mocks.eq.mockImplementation(() => {
    const result = Promise.resolve({ error: null });
    return {
      is: mocks.is,
      then: result.then.bind(result),
      catch: result.catch.bind(result),
    };
  });
  mocks.update.mockImplementation(() => ({ eq: mocks.eq }));
  mocks.from.mockReturnValue({
    insert: mocks.insert,
    update: mocks.update,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/stripe/webhook", () => {
  it("requires a Stripe signature before claiming an event", async () => {
    const response = await stripeWebhook(request(false));

    expect(response.status).toBe(400);
    expect(mocks.constructEvent).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it.each([
    {
      caseName: "a live event under a test key",
      secretKey: "sk_test_unit_only",
      livemode: true,
    },
    {
      caseName: "a test event under a live key",
      secretKey: "sk_live_unit_only",
      livemode: false,
    },
  ])("rejects $caseName before claiming or processing", async (testCase) => {
    vi.stubEnv("STRIPE_SECRET_KEY", testCase.secretKey);
    mocks.constructEvent.mockReturnValue(
      event(
        "customer.subscription.updated",
        { id: SUBSCRIPTION_ID },
        "evt_wrong_mode",
        { livemode: testCase.livemode },
      ),
    );

    const response = await stripeWebhook(request());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid event provenance",
    });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.syncStripeSubscription).not.toHaveBeenCalled();
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    {
      caseName: "a connected-account origin",
      provenance: { account: "acct_connected" },
    },
    {
      caseName: "an organization context",
      provenance: { context: "acct_organization_context" },
    },
  ])("rejects $caseName before claiming or processing", async (testCase) => {
    mocks.constructEvent.mockReturnValue(
      event(
        "customer.subscription.updated",
        { id: SUBSCRIPTION_ID },
        "evt_non_direct",
        testCase.provenance,
      ),
    );

    const response = await stripeWebhook(request());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid event provenance",
    });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.syncStripeSubscription).not.toHaveBeenCalled();
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each(["", "rk_test_unit_only", "not_a_stripe_key"])(
    "rejects an unrecognized configured key mode (%s) before claiming",
    async (secretKey) => {
      vi.stubEnv("STRIPE_SECRET_KEY", secretKey);
      mocks.constructEvent.mockReturnValue(
        event("customer.subscription.updated", { id: SUBSCRIPTION_ID }),
      );

      const response = await stripeWebhook(request());

      expect(response.status).toBe(400);
      expect(mocks.insert).not.toHaveBeenCalled();
      expect(mocks.syncStripeSubscription).not.toHaveBeenCalled();
    },
  );

  it("acknowledges a guarded stale partner-assignment Checkout skip without attempting paid launch", async () => {
    const checkoutEvent = event("checkout.session.completed", {
      id: "cs_test_deleted_business",
    });
    mocks.constructEvent.mockReturnValue(checkoutEvent);
    mocks.syncCheckoutSession.mockResolvedValue(null);

    const response = await stripeWebhook(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.syncCheckoutSession).toHaveBeenCalled();
    expect(mocks.finalizePaidCheckout).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        processed_at: expect.any(String),
        processing_error: null,
      }),
    );
  });

  it("processes a direct live-mode checkout under a live key", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_unit_only");
    const checkoutEvent = event(
      "checkout.session.completed",
      { id: "cs_live_real_customer" },
      "evt_live_checkout",
      { livemode: true },
    );
    mocks.constructEvent.mockReturnValue(checkoutEvent);
    mocks.syncCheckoutSession.mockResolvedValue({
      businessId: BUSINESS_ID,
      customerId: CUSTOMER_ID,
      subscriptionId: SUBSCRIPTION_ID,
      plan: "sms_only",
    });

    const response = await stripeWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.syncCheckoutSession).toHaveBeenCalled();
    expect(mocks.finalizePaidCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        plan: "sms_only",
      }),
      "stripe_webhook",
    );
  });

  it("dispatches Chat Only completion from the synchronized plan", async () => {
    const checkoutEvent = event("checkout.session.completed", {
      id: "cs_test_chat_only",
      metadata: { plan: "sms_only" },
    });
    const synced = {
      businessId: BUSINESS_ID,
      customerId: CUSTOMER_ID,
      subscriptionId: SUBSCRIPTION_ID,
      plan: "chat_only",
    };
    mocks.constructEvent.mockReturnValue(checkoutEvent);
    mocks.syncCheckoutSession.mockResolvedValue(synced);
    mocks.finalizePaidCheckout.mockResolvedValue({ status: "completed" });

    const response = await stripeWebhook(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    // Session metadata is intentionally not used for dispatch; the Price
    // resolved by synchronization is authoritative.
    expect(mocks.finalizePaidCheckout).toHaveBeenCalledWith(
      synced,
      "stripe_webhook",
    );
  });

  it("records a retryable Chat Only completion failure and succeeds on redelivery", async () => {
    const checkoutEvent = event(
      "checkout.session.completed",
      { id: "cs_test_chat_retry" },
      "evt_test_chat_retry",
    );
    const synced = {
      businessId: BUSINESS_ID,
      customerId: CUSTOMER_ID,
      subscriptionId: SUBSCRIPTION_ID,
      plan: "chat_only",
    };
    mocks.constructEvent.mockReturnValue(checkoutEvent);
    mocks.syncCheckoutSession.mockResolvedValue(synced);
    mocks.finalizePaidCheckout
      .mockRejectedValueOnce(new Error("serialization failure"))
      .mockResolvedValueOnce({ status: "completed" });

    const failed = await stripeWebhook(request());

    expect(failed.status).toBe(500);
    expect(mocks.update).toHaveBeenCalledWith({
      processing_error: expect.stringContaining("serialization failure"),
    });

    mocks.insert.mockResolvedValue({
      error: { code: "23505", message: "duplicate key" },
    });
    mocks.select.mockResolvedValue({
      data: [{ id: checkoutEvent.id }],
      error: null,
    });

    const retried = await stripeWebhook(request());

    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toEqual({ received: true });
    expect(mocks.finalizePaidCheckout).toHaveBeenCalledTimes(2);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ processed_at: expect.any(String) }),
    );
  });

  it("records exact Chat Checkout expiry before acknowledging the event", async () => {
    const expiredSession = {
      id: "cs_test_chat_expired",
      status: "expired",
      metadata: { plan: "chat_only" },
    };
    mocks.constructEvent.mockReturnValue(
      event("checkout.session.expired", expiredSession),
    );
    mocks.syncExpiredCheckoutSession.mockResolvedValue(true);

    const response = await stripeWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.syncExpiredCheckoutSession).toHaveBeenCalledWith(expiredSession);
    expect(mocks.finalizePaidCheckout).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        processed_at: expect.any(String),
        processing_error: null,
      }),
    );
  });

  it("keeps a failed Chat Checkout expiry retryable", async () => {
    mocks.constructEvent.mockReturnValue(
      event("checkout.session.expired", {
        id: "cs_test_chat_expiry_retry",
        status: "expired",
        metadata: { plan: "chat_only" },
      }),
    );
    mocks.syncExpiredCheckoutSession.mockRejectedValue(
      new Error("attempt evidence mismatch"),
    );

    const response = await stripeWebhook(request());

    expect(response.status).toBe(500);
    expect(mocks.update).toHaveBeenCalledWith({
      processing_error: expect.stringContaining("attempt evidence mismatch"),
    });
  });

  it("propagates a 3+3 launch hold without failing the Stripe event", async () => {
    const checkoutEvent = event("checkout.session.completed", {
      id: "cs_test_missing_ai_knowledge",
    });
    mocks.constructEvent.mockReturnValue(checkoutEvent);
    mocks.syncCheckoutSession.mockResolvedValue({
      businessId: BUSINESS_ID,
      customerId: CUSTOMER_ID,
      subscriptionId: SUBSCRIPTION_ID,
      plan: "sms_only",
    });
    mocks.finalizePaidCheckout.mockResolvedValue({
      status: "services_faqs_required",
      message: "Add 3+3 content.",
    });

    const response = await stripeWebhook(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      code: "services_faqs_required",
    });
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        processed_at: expect.any(String),
        processing_error: null,
      }),
    );
  });

  it("acknowledges a support-only carrier rejection and marks the event processed", async () => {
    const checkoutEvent = event("checkout.session.completed", {
      id: "cs_test_carrier_rejected",
    });
    mocks.constructEvent.mockReturnValue(checkoutEvent);
    mocks.syncCheckoutSession.mockResolvedValue({
      businessId: BUSINESS_ID,
      customerId: CUSTOMER_ID,
      subscriptionId: SUBSCRIPTION_ID,
      plan: "sms_only",
    });
    mocks.finalizePaidCheckout.mockResolvedValue({
      status: "rejection_support_required",
      message: "Contact support.",
    });

    const response = await stripeWebhook(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      code: "rejection_support_required",
    });
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        processed_at: expect.any(String),
        processing_error: null,
      }),
    );
    expect(mocks.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ processing_error: expect.any(String) }),
    );
  });

  it("keeps Checkout synchronization ahead of a suspended provisioning no-op", async () => {
    const checkoutEvent = event("checkout.session.completed", {
      id: "cs_test_suspended_operations",
    });
    mocks.constructEvent.mockReturnValue(checkoutEvent);
    mocks.syncCheckoutSession.mockResolvedValue({
      businessId: BUSINESS_ID,
      customerId: CUSTOMER_ID,
      subscriptionId: SUBSCRIPTION_ID,
      plan: "sms_only",
    });
    mocks.finalizePaidCheckout.mockResolvedValue({
      status: "operations_suspended",
      message: "Account operations are suspended.",
    });

    const response = await stripeWebhook(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.syncCheckoutSession).toHaveBeenCalledOnce();
    expect(mocks.finalizePaidCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS_ID, plan: "sms_only" }),
      "stripe_webhook",
    );
    expect(mocks.syncCheckoutSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.finalizePaidCheckout.mock.invocationCallOrder[0],
    );
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        processed_at: expect.any(String),
        processing_error: null,
      }),
    );
  });

  it("processes a 100%-off checkout ($0 invoice, no payment_intent) like any other", async () => {
    // A fully-discounted promotion code completes checkout with
    // payment_status "no_payment_required" and no payment_intent at all.
    // The route must pass the session through untouched — it never inspects
    // amounts or dereferences payment_intent — and launch normally.
    const checkoutEvent = event("checkout.session.completed", {
      id: "cs_test_promo_zero",
      payment_status: "no_payment_required",
      payment_intent: null,
      amount_total: 0,
    });
    mocks.constructEvent.mockReturnValue(checkoutEvent);
    mocks.syncCheckoutSession.mockResolvedValue({
      businessId: BUSINESS_ID,
      customerId: CUSTOMER_ID,
      subscriptionId: SUBSCRIPTION_ID,
      plan: "sms_only",
    });

    const response = await stripeWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.syncCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "cs_test_promo_zero",
        payment_status: "no_payment_required",
      }),
    );
    expect(mocks.finalizePaidCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS_ID, plan: "sms_only" }),
      "stripe_webhook",
    );
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        processed_at: expect.any(String),
        processing_error: null,
      }),
    );
  });

  it("attempts paid launch only when checkout synchronization returns an active business", async () => {
    const checkoutEvent = event("checkout.session.completed", {
      id: "cs_test_active_business",
    });
    mocks.constructEvent.mockReturnValue(checkoutEvent);
    mocks.syncCheckoutSession.mockResolvedValue({
      businessId: BUSINESS_ID,
      customerId: CUSTOMER_ID,
      subscriptionId: SUBSCRIPTION_ID,
      plan: "sms_only",
    });

    const response = await stripeWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.finalizePaidCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS_ID, plan: "sms_only" }),
      "stripe_webhook",
    );
  });

  it("acknowledges a guarded invoice-failure skip for a deleted or partner-managed business", async () => {
    mocks.constructEvent.mockReturnValue(
      event("invoice.payment_failed", { customer: CUSTOMER_ID }),
    );
    mocks.rpc.mockResolvedValue({ data: false, error: null });

    const response = await stripeWebhook(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "mark_stripe_subscription_past_due_if_business_active",
      expect.objectContaining({ p_stripe_customer_id: CUSTOMER_ID }),
    );
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ processed_at: expect.any(String) }),
    );
  });

  it("returns 500 and records failure when guarded invoice persistence errors", async () => {
    mocks.constructEvent.mockReturnValue(
      event("invoice.payment_failed", { customer: CUSTOMER_ID }),
    );
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: "serialization failure" },
    });

    const response = await stripeWebhook(request());

    expect(response.status).toBe(500);
    expect(mocks.update).toHaveBeenCalledWith({
      processing_error: expect.stringContaining("serialization failure"),
    });
  });

  it.each([null, 1, "true", { updated: true }])(
    "returns 500 for malformed invoice guard response %#",
    async (data) => {
      mocks.constructEvent.mockReturnValue(
        event("invoice.payment_failed", { customer: CUSTOMER_ID }),
      );
      mocks.rpc.mockResolvedValue({ data, error: null });

      const response = await stripeWebhook(request());

      expect(response.status).toBe(500);
      expect(mocks.update).toHaveBeenCalledWith({
        processing_error: expect.stringContaining(
          "Guarded past-due update returned an invalid response",
        ),
      });
    },
  );

  it("acknowledges subscription sync null so partner-mode events do not gain local authority or retry forever", async () => {
    const subscription = { id: SUBSCRIPTION_ID };
    mocks.constructEvent.mockReturnValue(
      event("customer.subscription.updated", subscription),
    );
    mocks.syncStripeSubscription.mockResolvedValue(null);

    const response = await stripeWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.syncStripeSubscription).toHaveBeenCalledWith(subscription);
    expect(mocks.finalizePaidCheckout).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ processed_at: expect.any(String) }),
    );
  });

  it("acknowledges duplicate event claims without running business logic", async () => {
    const subscriptionEvent = event("customer.subscription.updated", {
      id: SUBSCRIPTION_ID,
    });
    mocks.constructEvent.mockReturnValue(subscriptionEvent);
    mocks.insert.mockResolvedValue({
      error: { code: "23505", message: "duplicate key" },
    });

    const response = await stripeWebhook(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      duplicate: true,
    });
    expect(mocks.syncStripeSubscription).not.toHaveBeenCalled();
    // The re-claim probe runs (update with a cleared error) but no
    // processed marker is ever written for a suppressed duplicate.
    expect(mocks.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ processed_at: expect.any(String) }),
    );
  });

  it("ignores invoice failures without a string customer id", async () => {
    mocks.constructEvent.mockReturnValue(
      event("invoice.payment_failed", { customer: null }),
    );

    const response = await stripeWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("ignores payment successes without a resolvable subscription id", async () => {
    mocks.constructEvent.mockReturnValue(
      event("invoice.payment_succeeded", { customer: CUSTOMER_ID }),
    );

    const response = await stripeWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.syncStripeSubscription).not.toHaveBeenCalled();
  });

  it("recovers payment success by retrieving the subscription and writing its real status", async () => {
    mocks.constructEvent.mockReturnValue(
      event("invoice.payment_succeeded", {
        customer: CUSTOMER_ID,
        // Legacy invoice shape: subscription id on the invoice root.
        subscription: SUBSCRIPTION_ID,
      }),
    );
    // Payment success alone never fabricates a status — whatever Stripe
    // reports (here still past_due) is what gets written.
    const retrieved = { id: SUBSCRIPTION_ID, status: "past_due" };
    mocks.retrieve.mockResolvedValue(retrieved);
    mocks.syncStripeSubscription.mockResolvedValue({
      businessId: BUSINESS_ID,
      customerId: CUSTOMER_ID,
      subscriptionId: SUBSCRIPTION_ID,
      plan: "sms_only",
    });

    const response = await stripeWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.retrieve).toHaveBeenCalledWith(SUBSCRIPTION_ID);
    expect(mocks.syncStripeSubscription).toHaveBeenCalledWith(retrieved);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ processed_at: expect.any(String) }),
    );
  });

  it("writes active when the retrieved subscription is active (modern invoice shape)", async () => {
    mocks.constructEvent.mockReturnValue(
      event("invoice.payment_succeeded", {
        customer: CUSTOMER_ID,
        parent: { subscription_details: { subscription: SUBSCRIPTION_ID } },
      }),
    );
    const retrieved = { id: SUBSCRIPTION_ID, status: "active" };
    mocks.retrieve.mockResolvedValue(retrieved);
    mocks.syncStripeSubscription.mockResolvedValue({
      businessId: BUSINESS_ID,
      customerId: CUSTOMER_ID,
      subscriptionId: SUBSCRIPTION_ID,
      plan: "sms_only",
    });

    const response = await stripeWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.retrieve).toHaveBeenCalledWith(SUBSCRIPTION_ID);
    expect(mocks.syncStripeSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active" }),
    );
  });

  it("returns 500 when the recovery retrieve fails so Stripe retries", async () => {
    mocks.constructEvent.mockReturnValue(
      event("invoice.payment_succeeded", {
        customer: CUSTOMER_ID,
        subscription: SUBSCRIPTION_ID,
      }),
    );
    mocks.retrieve.mockRejectedValue(new Error("stripe unreachable"));

    const response = await stripeWebhook(request());

    expect(response.status).toBe(500);
    expect(mocks.syncStripeSubscription).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith({
      processing_error: expect.stringContaining("stripe unreachable"),
    });
  });

  it("restores active after the past_due then paid production sequence", async () => {
    // 1. invoice.payment_failed marks the business past_due via the guard.
    mocks.constructEvent.mockReturnValueOnce(
      event("invoice.payment_failed", { customer: CUSTOMER_ID }),
    );
    mocks.rpc.mockResolvedValue({ data: true, error: null });

    const failed = await stripeWebhook(request());

    expect(failed.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "mark_stripe_subscription_past_due_if_business_active",
      expect.objectContaining({ p_stripe_customer_id: CUSTOMER_ID }),
    );

    // 2. The customer fixes their card; invoice.payment_succeeded restores
    //    the real Stripe status (active) through the guarded sync.
    mocks.constructEvent.mockReturnValueOnce(
      event("invoice.payment_succeeded", {
        customer: CUSTOMER_ID,
        parent: { subscription_details: { subscription: SUBSCRIPTION_ID } },
      }),
    );
    const retrieved = { id: SUBSCRIPTION_ID, status: "active" };
    mocks.retrieve.mockResolvedValue(retrieved);
    mocks.syncStripeSubscription.mockResolvedValue({
      businessId: BUSINESS_ID,
      customerId: CUSTOMER_ID,
      subscriptionId: SUBSCRIPTION_ID,
      plan: "sms_only",
    });

    const paid = await stripeWebhook(request());

    expect(paid.status).toBe(200);
    expect(mocks.syncStripeSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ status: "active" }),
    );
  });

  it("passes a lapsed subscription through the guarded sync for an active business", async () => {
    const subscription = { id: SUBSCRIPTION_ID, status: "canceled" };
    mocks.constructEvent.mockReturnValue(
      event("customer.subscription.deleted", subscription),
    );
    mocks.syncStripeSubscription.mockResolvedValue({
      businessId: BUSINESS_ID,
      customerId: CUSTOMER_ID,
      subscriptionId: SUBSCRIPTION_ID,
      plan: "sms_only",
    });

    const response = await stripeWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.syncStripeSubscription).toHaveBeenCalledWith(subscription);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ processed_at: expect.any(String) }),
    );
  });

  it("acknowledges a deleted-business lapse skip so the deletion flow keeps terminal ownership", async () => {
    const subscription = { id: SUBSCRIPTION_ID, status: "canceled" };
    mocks.constructEvent.mockReturnValue(
      event("customer.subscription.deleted", subscription),
    );
    mocks.syncStripeSubscription.mockResolvedValue(null);

    const response = await stripeWebhook(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.syncStripeSubscription).toHaveBeenCalledWith(subscription);
  });

  it("re-claims a finished-failed event on Stripe redelivery and reprocesses it", async () => {
    const subscription = { id: SUBSCRIPTION_ID, status: "canceled" };
    mocks.constructEvent.mockReturnValue(
      event("customer.subscription.deleted", subscription),
    );
    mocks.insert.mockResolvedValue({
      error: { code: "23505", message: "duplicate key" },
    });
    // Prior attempt finished-failed: the CAS re-claim wins a row.
    mocks.select.mockResolvedValue({
      data: [{ id: "evt_test_reclaim" }],
      error: null,
    });
    mocks.syncStripeSubscription.mockResolvedValue({
      businessId: BUSINESS_ID,
      customerId: CUSTOMER_ID,
      subscriptionId: SUBSCRIPTION_ID,
      plan: "sms_only",
    });

    const response = await stripeWebhook(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    expect(mocks.syncStripeSubscription).toHaveBeenCalledWith(subscription);
    // The claim was taken by clearing the error, then the retry succeeded
    // and wrote the processed marker.
    expect(mocks.update).toHaveBeenCalledWith({ processing_error: null });
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ processed_at: expect.any(String) }),
    );
  });

  it("keeps acking duplicates while the first attempt is in flight", async () => {
    mocks.constructEvent.mockReturnValue(
      event("customer.subscription.updated", { id: SUBSCRIPTION_ID }),
    );
    mocks.insert.mockResolvedValue({
      error: { code: "23505", message: "duplicate key" },
    });
    // In-flight rows have processing_error NULL, so the CAS matches nothing.
    mocks.select.mockResolvedValue({ data: [], error: null });

    const response = await stripeWebhook(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      duplicate: true,
    });
    expect(mocks.syncStripeSubscription).not.toHaveBeenCalled();
  });

  it("re-claims only finished-failed rows: the CAS predicate excludes processed and in-flight events", async () => {
    mocks.constructEvent.mockReturnValue(
      event("customer.subscription.updated", { id: SUBSCRIPTION_ID }),
    );
    mocks.insert.mockResolvedValue({
      error: { code: "23505", message: "duplicate key" },
    });
    mocks.select.mockResolvedValue({ data: [], error: null });

    const response = await stripeWebhook(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      duplicate: true,
    });
    // The claimability predicate itself: only rows that finished AND failed.
    expect(mocks.update).toHaveBeenCalledWith({ processing_error: null });
    expect(mocks.eq).toHaveBeenCalledWith("id", expect.any(String));
    expect(mocks.is).toHaveBeenCalledWith("processed_at", null);
    expect(mocks.not).toHaveBeenCalledWith("processing_error", "is", null);
  });

  it("lets exactly one of two simultaneous retries win the re-claim", async () => {
    // The real serialization is Postgres single-statement atomicity (the
    // loser's WHERE re-evaluates after the row lock); this pins the route's
    // handling of the two outcomes.
    const subscription = { id: SUBSCRIPTION_ID, status: "canceled" };
    mocks.constructEvent.mockReturnValue(
      event("customer.subscription.deleted", subscription),
    );
    mocks.insert.mockResolvedValue({
      error: { code: "23505", message: "duplicate key" },
    });
    mocks.select
      .mockResolvedValueOnce({ data: [{ id: "evt_race" }], error: null })
      .mockResolvedValueOnce({ data: [], error: null });
    mocks.syncStripeSubscription.mockResolvedValue({
      businessId: BUSINESS_ID,
      customerId: CUSTOMER_ID,
      subscriptionId: SUBSCRIPTION_ID,
      plan: "sms_only",
    });

    const [first, second] = await Promise.all([
      stripeWebhook(request()),
      stripeWebhook(request()),
    ]);
    const bodies = await Promise.all([first.json(), second.json()]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mocks.syncStripeSubscription).toHaveBeenCalledTimes(1);
    expect(bodies.filter((body) => body.duplicate === true)).toHaveLength(1);
  });

  it("throws without processing when the re-claim query errors, so no event runs unclaimed", async () => {
    mocks.constructEvent.mockReturnValue(
      event("customer.subscription.updated", { id: SUBSCRIPTION_ID }),
    );
    mocks.insert.mockResolvedValue({
      error: { code: "23505", message: "duplicate key" },
    });
    mocks.select.mockResolvedValue({
      data: null,
      error: { message: "connection reset" },
    });

    // claimStripeEvent runs before the processing try/catch, so an unknown
    // claim state propagates (Next.js turns it into a 500 → Stripe retries).
    await expect(stripeWebhook(request())).rejects.toThrow(
      /Failed to evaluate re-claim/,
    );
    expect(mocks.syncStripeSubscription).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ processed_at: expect.any(String) }),
    );
  });

  it.each(["active", "unpaid"])(
    "syncs the live state instead of blind-marking past_due (live %s)",
    async (status) => {
      mocks.constructEvent.mockReturnValue(
        event("invoice.payment_failed", {
          customer: CUSTOMER_ID,
          subscription: SUBSCRIPTION_ID,
        }),
      );
      const live = { id: SUBSCRIPTION_ID, status };
      mocks.retrieve.mockResolvedValue(live);
      mocks.syncStripeSubscription.mockResolvedValue({
        businessId: BUSINESS_ID,
        customerId: CUSTOMER_ID,
        subscriptionId: SUBSCRIPTION_ID,
        plan: "sms_only",
      });

      const response = await stripeWebhook(request());

      expect(response.status).toBe(200);
      // Linked invoices use the authoritative synchronizer, including recovery.
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.syncStripeSubscription).toHaveBeenCalledWith(live);
    },
  );

  it("synchronizes live past_due through the same versioned subscription authority", async () => {
    mocks.constructEvent.mockReturnValue(
      event("invoice.payment_failed", {
        customer: CUSTOMER_ID,
        subscription: SUBSCRIPTION_ID,
      }),
    );
    mocks.retrieve.mockResolvedValue({
      id: SUBSCRIPTION_ID,
      status: "past_due",
    });
    mocks.rpc.mockResolvedValue({ data: true, error: null });

    const response = await stripeWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.syncStripeSubscription).toHaveBeenCalledWith({ id: SUBSCRIPTION_ID, status: "past_due" });
  });

  it("marks past_due directly when the invoice has no subscription", async () => {
    mocks.constructEvent.mockReturnValue(
      event("invoice.payment_failed", { customer: CUSTOMER_ID }),
    );
    mocks.rpc.mockResolvedValue({ data: true, error: null });

    const response = await stripeWebhook(request());

    expect(response.status).toBe(200);
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith(
      "mark_stripe_subscription_past_due_if_business_active",
      expect.objectContaining({ p_stripe_customer_id: CUSTOMER_ID }),
    );
  });

  it("returns 500 when the payment-failed freshness check cannot read Stripe", async () => {
    mocks.constructEvent.mockReturnValue(
      event("invoice.payment_failed", {
        customer: CUSTOMER_ID,
        subscription: SUBSCRIPTION_ID,
      }),
    );
    mocks.retrieve.mockRejectedValue(new Error("stripe unreachable"));

    const response = await stripeWebhook(request());

    expect(response.status).toBe(500);
    // Never guess in either direction: no blind past_due mark, no sync.
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.syncStripeSubscription).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith({
      processing_error: expect.stringContaining("stripe unreachable"),
    });
  });

  it("returns 500 and records the failure when the processed marker cannot be written", async () => {
    const subscription = { id: SUBSCRIPTION_ID, status: "canceled" };
    mocks.constructEvent.mockReturnValue(
      event("customer.subscription.deleted", subscription),
    );
    mocks.syncStripeSubscription.mockResolvedValue({
      businessId: BUSINESS_ID,
      customerId: CUSTOMER_ID,
      subscriptionId: SUBSCRIPTION_ID,
      plan: "sms_only",
    });
    // First .eq() call is markStripeEventProcessed's terminal await; make
    // that write fail while later chain calls keep the default behavior.
    mocks.eq.mockImplementationOnce(() => {
      const result = Promise.resolve({
        error: { message: "marker write failed" },
      });
      return {
        is: mocks.is,
        then: result.then.bind(result),
        catch: result.catch.bind(result),
      };
    });

    const response = await stripeWebhook(request());

    // A phantom 200 would end Stripe's retries with the row in-flight; the
    // marker failure must surface as a recorded failure + 500 instead.
    expect(response.status).toBe(500);
    expect(mocks.update).toHaveBeenCalledWith({
      processing_error: expect.stringContaining("marker write failed"),
    });
  });

  it("guards the failure marker so it never stamps a processed row", async () => {
    mocks.constructEvent.mockReturnValue(
      event("invoice.payment_failed", { customer: CUSTOMER_ID }),
    );
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: "serialization failure" },
    });

    const response = await stripeWebhook(request());

    expect(response.status).toBe(500);
    // markStripeEventFailed's WHERE includes processed_at IS NULL.
    expect(mocks.is).toHaveBeenCalledWith("processed_at", null);
  });
});
