import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  createSmsCheckout: vi.fn(),
  createCustomer: vi.fn(),
  createCheckoutSession: vi.fn(),
  retrieveCheckoutSession: vi.fn(),
  createBillingPortalSession: vi.fn(),
  retrievePrice: vi.fn(),
  claimCheckoutPlanFamily: vi.fn(),
  acquireChatOnlyCheckoutAttempt: vi.fn(),
  recordChatOnlyCheckoutSession: vi.fn(),
  releaseChatOnlyCheckoutAttemptClaim: vi.fn(),
  expireChatOnlyCheckoutAttempt: vi.fn(),
  syncCheckoutSession: vi.fn(),
  ChatOnlyCheckoutAttemptRecoveryRequiredError: class extends Error {},
}));

vi.mock("server-only", () => ({}));
vi.mock("./smsBilling.server", () => ({ createSmsCheckout: mocks.createSmsCheckout }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ from: mocks.from })),
}));
vi.mock("@/lib/billing/planFamilyLock.server", () => ({
  claimCheckoutPlanFamily: mocks.claimCheckoutPlanFamily,
}));
vi.mock("./chatOnlyCheckoutAttempt.server", () => ({
  acquireChatOnlyCheckoutAttempt: mocks.acquireChatOnlyCheckoutAttempt,
  recordChatOnlyCheckoutSession: mocks.recordChatOnlyCheckoutSession,
  releaseChatOnlyCheckoutAttemptClaim:
    mocks.releaseChatOnlyCheckoutAttemptClaim,
  expireChatOnlyCheckoutAttempt: mocks.expireChatOnlyCheckoutAttempt,
  ChatOnlyCheckoutAttemptConflictError: class extends Error {},
  ChatOnlyCheckoutAttemptRecoveryRequiredError:
    mocks.ChatOnlyCheckoutAttemptRecoveryRequiredError,
  ChatOnlyCheckoutAttemptUnavailableError: class extends Error {},
}));
vi.mock("./subscriptionSync", () => ({
  syncCheckoutSession: mocks.syncCheckoutSession,
}));
vi.mock("./client", () => ({
  stripe: {
    prices: { retrieve: mocks.retrievePrice },
    customers: { create: mocks.createCustomer },
    checkout: {
      sessions: {
        create: mocks.createCheckoutSession,
        retrieve: mocks.retrieveCheckoutSession,
      },
    },
    billingPortal: {
      sessions: { create: mocks.createBillingPortalSession },
    },
  },
}));

import {
  ChatOnlyCheckoutAttemptRecoveryRequiredError,
  ChatOnlyCheckoutInProgressError,
  ChatOnlyCheckoutSessionExpiredError,
  createBillingPortalSession,
  createCheckoutSession,
} from "./checkout";

const BUSINESS_ID = "10000000-0000-4000-a000-000000000001";
const SUCCESS_URL =
  "https://simplassist.com/onboarding?checkout=success&session_id={CHECKOUT_SESSION_ID}";
const CANCEL_URL = "https://simplassist.com/onboarding?checkout=canceled";
const ATTEMPT_ID = "20000000-0000-4000-a000-000000000002";
const SESSION_EXPIRES_AT = "2026-08-19T13:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createSmsCheckout.mockResolvedValue("https://checkout.stripe.test/session");
  mocks.from.mockImplementation((table: string) => {
    const result =
      table === "subscriptions"
        ? { data: { stripe_customer_id: "cus_existing" }, error: null }
        : { data: null, error: null };
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ["select", "eq"]) {
      chain[method] = vi.fn(() => chain);
    }
    chain.single = vi.fn(async () => result);
    return chain;
  });
  mocks.createCheckoutSession.mockImplementation(async (params) => ({
    id: "cs_test_chat_singleflight",
    url: "https://checkout.stripe.test/session",
    customer: params.customer ?? null,
    subscription: null,
    client_reference_id: params.client_reference_id ?? null,
    mode: params.mode,
    status: "open",
    payment_status: "unpaid",
    expires_at: params.expires_at,
    metadata: params.metadata,
  }));
  mocks.retrievePrice.mockResolvedValue({
    id: "price_chat_only",
    active: true,
    type: "recurring",
    currency: "usd",
    unit_amount: 1_000,
    recurring: {
      interval: "month",
      interval_count: 1,
      usage_type: "licensed",
    },
  });
  mocks.claimCheckoutPlanFamily.mockResolvedValue(undefined);
  mocks.acquireChatOnlyCheckoutAttempt.mockImplementation(
    async ({ claimToken }) => ({
      outcome: "create",
      attemptId: ATTEMPT_ID,
      claimToken,
      customerId: null,
      sessionExpiresAt: SESSION_EXPIRES_AT,
    }),
  );
  mocks.recordChatOnlyCheckoutSession.mockResolvedValue(undefined);
  mocks.releaseChatOnlyCheckoutAttemptClaim.mockResolvedValue(undefined);
  mocks.expireChatOnlyCheckoutAttempt.mockResolvedValue(undefined);
  mocks.createBillingPortalSession.mockResolvedValue({
    url: "https://billing.stripe.test/session",
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("createCheckoutSession existing SMS-plan contract", () => {
  it.each([
    ["sms_only", "price_starter"],
    ["sms_and_chat", "price_growth"],
    ["full", "price_full"],
  ] as const)(
    "routes %s through durable acquisition after the existing family guard",
    async (plan, planPriceId) => {
      await expect(
        createCheckoutSession(
          BUSINESS_ID,
          plan,
          planPriceId,
          "price_setup",
          SUCCESS_URL,
          CANCEL_URL,
          "onboarding",
          true,
        ),
      ).resolves.toBe("https://checkout.stripe.test/session");

      expect(mocks.createCustomer).not.toHaveBeenCalled();
      expect(mocks.retrievePrice).not.toHaveBeenCalled();
      expect(mocks.claimCheckoutPlanFamily).toHaveBeenCalledWith(
        BUSINESS_ID,
        plan,
        true,
      );
      expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
      expect(mocks.createSmsCheckout).toHaveBeenCalledWith({ businessId: BUSINESS_ID, plan, priceId: planPriceId,
        setupFeePriceId: "price_setup", successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL, mode: "onboarding" });
    },
  );

  it("creates Chat Only with exactly one recurring line and no setup-fee metadata", async () => {
    await expect(
      createCheckoutSession(
        BUSINESS_ID,
        "chat_only",
        "price_chat_only",
        null,
        SUCCESS_URL,
        CANCEL_URL,
        "onboarding",
        true,
      ),
    ).resolves.toBe("https://checkout.stripe.test/session");

    expect(mocks.retrievePrice).toHaveBeenCalledWith("price_chat_only");
    expect(mocks.claimCheckoutPlanFamily).not.toHaveBeenCalled();
    expect(mocks.createCustomer).not.toHaveBeenCalled();
    expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
      {
        client_reference_id: BUSINESS_ID,
        mode: "subscription",
        payment_method_types: ["card"],
        allow_promotion_codes: true,
        line_items: [{ price: "price_chat_only", quantity: 1 }],
        success_url: SUCCESS_URL,
        cancel_url: CANCEL_URL,
        expires_at: Date.parse(SESSION_EXPIRES_AT) / 1_000,
        subscription_data: {
          metadata: {
            business_id: BUSINESS_ID,
            plan: "chat_only",
            mode: "onboarding",
            checkout_attempt_id: ATTEMPT_ID,
            checkout_request_fingerprint: expect.stringMatching(
              /^[0-9a-f]{64}$/,
            ),
            checkout_session_expires_at: SESSION_EXPIRES_AT,
          },
        },
        metadata: {
          business_id: BUSINESS_ID,
          plan: "chat_only",
          mode: "onboarding",
          checkout_attempt_id: ATTEMPT_ID,
          checkout_request_fingerprint: expect.stringMatching(
            /^[0-9a-f]{64}$/,
          ),
          checkout_session_expires_at: SESSION_EXPIRES_AT,
        },
      },
      {
        idempotencyKey: `chat-checkout-session-v1:${ATTEMPT_ID}`,
      },
    );
    expect(mocks.recordChatOnlyCheckoutSession).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      claimToken: expect.any(String),
      sessionId: "cs_test_chat_singleflight",
      customerId: null,
      checkoutUrl: "https://checkout.stripe.test/session",
      sessionExpiresAt: SESSION_EXPIRES_AT,
    });
  });

  it("derives the same immutable fingerprint and Stripe key across HTTP retries", async () => {
    await createCheckoutSession(
      BUSINESS_ID,
      "chat_only",
      "price_chat_only",
      null,
      SUCCESS_URL,
      CANCEL_URL,
      "onboarding",
    );
    await createCheckoutSession(
      BUSINESS_ID,
      "chat_only",
      "price_chat_only",
      null,
      SUCCESS_URL,
      CANCEL_URL,
      "onboarding",
    );

    const firstAcquire = mocks.acquireChatOnlyCheckoutAttempt.mock.calls[0]?.[0];
    const secondAcquire = mocks.acquireChatOnlyCheckoutAttempt.mock.calls[1]?.[0];
    expect(firstAcquire.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(secondAcquire.requestFingerprint).toBe(
      firstAcquire.requestFingerprint,
    );
    expect(mocks.createCheckoutSession.mock.calls[0]?.[1]).toEqual({
      idempotencyKey: `chat-checkout-session-v1:${ATTEMPT_ID}`,
    });
    expect(mocks.createCheckoutSession.mock.calls[1]?.[1]).toEqual({
      idempotencyKey: `chat-checkout-session-v1:${ATTEMPT_ID}`,
    });
  });

  it("returns a bounded retry decision without calling Stripe while another worker owns creation", async () => {
    mocks.acquireChatOnlyCheckoutAttempt.mockResolvedValue({
      outcome: "in_progress",
      attemptId: ATTEMPT_ID,
      customerId: null,
      retryAfterSeconds: 17,
    });

    await expect(
      createCheckoutSession(
        BUSINESS_ID,
        "chat_only",
        "price_chat_only",
        null,
        SUCCESS_URL,
        CANCEL_URL,
        "onboarding",
      ),
    ).rejects.toMatchObject({
      name: "ChatOnlyCheckoutInProgressError",
      retryAfterSeconds: 17,
    });
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
    expect(mocks.retrieveCheckoutSession).not.toHaveBeenCalled();
  });

  it("reuses the exact recorded open Session instead of creating another", async () => {
    mocks.acquireChatOnlyCheckoutAttempt.mockResolvedValue({
      outcome: "open",
      attemptId: ATTEMPT_ID,
      sessionId: "cs_test_recorded_open",
      customerId: null,
      sessionExpiresAt: SESSION_EXPIRES_AT,
    });
    mocks.retrieveCheckoutSession.mockImplementation(async () => {
      const fingerprint =
        mocks.acquireChatOnlyCheckoutAttempt.mock.calls[0]?.[0]
          .requestFingerprint;
      return {
        id: "cs_test_recorded_open",
        url: "https://checkout.stripe.test/existing",
        customer: "cus_checkout_created",
        subscription: null,
        client_reference_id: BUSINESS_ID,
        mode: "subscription",
        status: "open",
        payment_status: "unpaid",
        expires_at: Date.parse(SESSION_EXPIRES_AT) / 1_000,
        metadata: {
          business_id: BUSINESS_ID,
          plan: "chat_only",
          mode: "onboarding",
          checkout_attempt_id: ATTEMPT_ID,
          checkout_request_fingerprint: fingerprint,
          checkout_session_expires_at: SESSION_EXPIRES_AT,
        },
      };
    });

    await expect(
      createCheckoutSession(
        BUSINESS_ID,
        "chat_only",
        "price_chat_only",
        null,
        SUCCESS_URL,
        CANCEL_URL,
        "onboarding",
      ),
    ).resolves.toBe("https://checkout.stripe.test/existing");
    expect(mocks.retrieveCheckoutSession).toHaveBeenCalledWith(
      "cs_test_recorded_open",
    );
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
    expect(mocks.recordChatOnlyCheckoutSession).not.toHaveBeenCalled();
  });

  it("terminalizes exact Stripe expiry before allowing a later generation", async () => {
    mocks.acquireChatOnlyCheckoutAttempt.mockResolvedValue({
      outcome: "open",
      attemptId: ATTEMPT_ID,
      sessionId: "cs_test_recorded_expired",
      customerId: null,
      sessionExpiresAt: SESSION_EXPIRES_AT,
    });
    mocks.retrieveCheckoutSession.mockImplementation(async () => {
      const fingerprint =
        mocks.acquireChatOnlyCheckoutAttempt.mock.calls[0]?.[0]
          .requestFingerprint;
      return {
        id: "cs_test_recorded_expired",
        url: null,
        customer: null,
        subscription: null,
        client_reference_id: BUSINESS_ID,
        mode: "subscription",
        status: "expired",
        payment_status: "unpaid",
        expires_at: Date.parse(SESSION_EXPIRES_AT) / 1_000,
        metadata: {
          business_id: BUSINESS_ID,
          plan: "chat_only",
          mode: "onboarding",
          checkout_attempt_id: ATTEMPT_ID,
          checkout_request_fingerprint: fingerprint,
          checkout_session_expires_at: SESSION_EXPIRES_AT,
        },
      };
    });

    await expect(
      createCheckoutSession(
        BUSINESS_ID,
        "chat_only",
        "price_chat_only",
        null,
        SUCCESS_URL,
        CANCEL_URL,
        "onboarding",
      ),
    ).rejects.toBeInstanceOf(ChatOnlyCheckoutSessionExpiredError);
    expect(mocks.expireChatOnlyCheckoutAttempt).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      attemptId: ATTEMPT_ID,
      sessionId: "cs_test_recorded_expired",
      requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      sessionExpiresAt: SESSION_EXPIRES_AT,
    });
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("recovers exact completed Stripe work instead of opening another Session", async () => {
    const synced = {
      businessId: BUSINESS_ID,
      customerId: "cus_checkout_complete",
      subscriptionId: "sub_checkout_complete",
      plan: "chat_only" as const,
    };
    mocks.acquireChatOnlyCheckoutAttempt.mockResolvedValue({
      outcome: "open",
      attemptId: ATTEMPT_ID,
      sessionId: "cs_test_recorded_complete",
      customerId: "cus_checkout_complete",
      sessionExpiresAt: SESSION_EXPIRES_AT,
    });
    mocks.retrieveCheckoutSession.mockImplementation(async () => {
      const fingerprint =
        mocks.acquireChatOnlyCheckoutAttempt.mock.calls[0]?.[0]
          .requestFingerprint;
      return {
        id: "cs_test_recorded_complete",
        url: null,
        customer: "cus_checkout_complete",
        subscription: "sub_checkout_complete",
        client_reference_id: BUSINESS_ID,
        mode: "subscription",
        status: "complete",
        payment_status: "paid",
        expires_at: Date.parse(SESSION_EXPIRES_AT) / 1_000,
        metadata: {
          business_id: BUSINESS_ID,
          plan: "chat_only",
          mode: "onboarding",
          checkout_attempt_id: ATTEMPT_ID,
          checkout_request_fingerprint: fingerprint,
          checkout_session_expires_at: SESSION_EXPIRES_AT,
        },
      };
    });
    mocks.syncCheckoutSession.mockResolvedValue(synced);

    await expect(
      createCheckoutSession(
        BUSINESS_ID,
        "chat_only",
        "price_chat_only",
        null,
        SUCCESS_URL,
        CANCEL_URL,
        "onboarding",
      ),
    ).rejects.toMatchObject({
      name: "ChatOnlyCheckoutRecoveredCompletionError",
      synced,
    });
    expect(mocks.syncCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cs_test_recorded_complete" }),
    );
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("releases only the worker lease after an ambiguous provider error", async () => {
    mocks.createCheckoutSession.mockRejectedValue(
      new Error("stripe connection lost"),
    );

    await expect(
      createCheckoutSession(
        BUSINESS_ID,
        "chat_only",
        "price_chat_only",
        null,
        SUCCESS_URL,
        CANCEL_URL,
        "onboarding",
      ),
    ).rejects.toThrow("stripe connection lost");
    await vi.waitFor(() =>
      expect(mocks.releaseChatOnlyCheckoutAttemptClaim).toHaveBeenCalledWith({
        attemptId: ATTEMPT_ID,
        claimToken: expect.any(String),
      }),
    );
    expect(mocks.recordChatOnlyCheckoutSession).not.toHaveBeenCalled();
  });

  it("bounds a hung lease release without suppressing the provider error", async () => {
    vi.useFakeTimers();
    mocks.createCheckoutSession.mockRejectedValue(
      new Error("stripe timed out"),
    );
    mocks.releaseChatOnlyCheckoutAttemptClaim.mockReturnValue(
      new Promise(() => undefined),
    );

    const checkout = createCheckoutSession(
      BUSINESS_ID,
      "chat_only",
      "price_chat_only",
      null,
      SUCCESS_URL,
      CANCEL_URL,
      "onboarding",
    );
    const rejection = expect(checkout).rejects.toThrow("stripe timed out");
    await vi.advanceTimersByTimeAsync(500);

    await rejection;
    expect(mocks.releaseChatOnlyCheckoutAttemptClaim).toHaveBeenCalledOnce();
  });

  it("does not release the live claim when Stripe reports the same key in use", async () => {
    mocks.createCheckoutSession.mockRejectedValue({
      code: "idempotency_key_in_use",
    });

    await expect(
      createCheckoutSession(
        BUSINESS_ID,
        "chat_only",
        "price_chat_only",
        null,
        SUCCESS_URL,
        CANCEL_URL,
        "onboarding",
      ),
    ).rejects.toBeInstanceOf(ChatOnlyCheckoutInProgressError);
    expect(mocks.releaseChatOnlyCheckoutAttemptClaim).not.toHaveBeenCalled();
  });

  it("retains ambiguous provider evidence when the returned Session binding is malformed", async () => {
    mocks.createCheckoutSession.mockResolvedValue({
      id: "bad_session_id",
      url: "https://checkout.stripe.test/session",
      customer: null,
      subscription: null,
      client_reference_id: BUSINESS_ID,
      mode: "subscription",
      status: "open",
      payment_status: "unpaid",
      expires_at: Date.parse(SESSION_EXPIRES_AT) / 1_000,
      metadata: {},
    });

    await expect(
      createCheckoutSession(
        BUSINESS_ID,
        "chat_only",
        "price_chat_only",
        null,
        SUCCESS_URL,
        CANCEL_URL,
        "onboarding",
      ),
    ).rejects.toThrow("chat_only_checkout_session_binding_invalid");
    expect(mocks.recordChatOnlyCheckoutSession).not.toHaveBeenCalled();
    expect(mocks.releaseChatOnlyCheckoutAttemptClaim).not.toHaveBeenCalled();
  });

  it.each([
    ["inactive", { active: false }],
    ["wrong currency", { currency: "eur" }],
    ["wrong amount", { unit_amount: 999 }],
    ["one-time", { type: "one_time", recurring: null }],
    [
      "annual",
      {
        recurring: {
          interval: "year",
          interval_count: 1,
          usage_type: "licensed",
        },
      },
    ],
    [
      "multi-month",
      {
        recurring: {
          interval: "month",
          interval_count: 2,
          usage_type: "licensed",
        },
      },
    ],
    [
      "metered",
      {
        recurring: {
          interval: "month",
          interval_count: 1,
          usage_type: "metered",
        },
      },
    ],
  ])(
    "fails closed before the family claim, database, customer, or session for an %s Chat Price",
    async (_label, override) => {
      mocks.retrievePrice.mockResolvedValue({
        id: "price_chat_only",
        active: true,
        type: "recurring",
        currency: "usd",
        unit_amount: 1_000,
        recurring: {
          interval: "month",
          interval_count: 1,
          usage_type: "licensed",
        },
        ...override,
      });

      await expect(
        createCheckoutSession(
          BUSINESS_ID,
          "chat_only",
          "price_chat_only",
          null,
          SUCCESS_URL,
          CANCEL_URL,
          "onboarding",
        ),
      ).rejects.toThrow("chat_only_stripe_price_invalid");

      expect(mocks.claimCheckoutPlanFamily).not.toHaveBeenCalled();
      expect(mocks.from).not.toHaveBeenCalled();
      expect(mocks.createCustomer).not.toHaveBeenCalled();
      expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
    },
  );

  it("fails before customer/session work when the atomic Chat attempt is rejected", async () => {
    mocks.acquireChatOnlyCheckoutAttempt.mockRejectedValue(
      new Error("chat_only_checkout_attempt_unavailable"),
    );

    await expect(
      createCheckoutSession(
        BUSINESS_ID,
        "chat_only",
        "price_chat_only",
        null,
        SUCCESS_URL,
        CANCEL_URL,
        "onboarding",
        true,
      ),
    ).rejects.toThrow("chat_only_checkout_attempt_unavailable");

    expect(mocks.retrievePrice).toHaveBeenCalledOnce();
    expect(mocks.claimCheckoutPlanFamily).not.toHaveBeenCalled();
    expect(mocks.createCustomer).not.toHaveBeenCalled();
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("never calls Stripe for an aged unknown attempt beyond the idempotency replay horizon", async () => {
    mocks.acquireChatOnlyCheckoutAttempt.mockRejectedValue(
      new ChatOnlyCheckoutAttemptRecoveryRequiredError(),
    );

    await expect(
      createCheckoutSession(
        BUSINESS_ID,
        "chat_only",
        "price_chat_only",
        null,
        SUCCESS_URL,
        CANCEL_URL,
        "onboarding",
        true,
      ),
    ).rejects.toBeInstanceOf(ChatOnlyCheckoutAttemptRecoveryRequiredError);

    expect(mocks.retrievePrice).toHaveBeenCalledOnce();
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
    expect(mocks.retrieveCheckoutSession).not.toHaveBeenCalled();
    expect(mocks.recordChatOnlyCheckoutSession).not.toHaveBeenCalled();
  });

  it("keeps an exact lost-response replay customer-free after outcome evidence binds a customer", async () => {
    mocks.acquireChatOnlyCheckoutAttempt.mockImplementation(
      async ({ claimToken }) => ({
        outcome: "create",
        attemptId: ATTEMPT_ID,
        claimToken,
        customerId: "cus_outcome_evidence",
        sessionExpiresAt: SESSION_EXPIRES_AT,
      }),
    );
    mocks.createCheckoutSession.mockImplementation(async (params) => ({
      id: "cs_test_chat_singleflight",
      url: "https://checkout.stripe.test/session",
      customer: "cus_outcome_evidence",
      subscription: null,
      client_reference_id: params.client_reference_id,
      mode: params.mode,
      status: "open",
      payment_status: "unpaid",
      expires_at: params.expires_at,
      metadata: params.metadata,
    }));

    await expect(
      createCheckoutSession(
        BUSINESS_ID,
        "chat_only",
        "price_chat_only",
        null,
        SUCCESS_URL,
        CANCEL_URL,
        "onboarding",
        true,
      ),
    ).resolves.toBe("https://checkout.stripe.test/session");

    const createParams = mocks.createCheckoutSession.mock.calls[0]?.[0];
    expect(createParams).not.toHaveProperty("customer");
    expect(mocks.createCheckoutSession.mock.calls[0]?.[1]).toEqual({
      idempotencyKey: `chat-checkout-session-v1:${ATTEMPT_ID}`,
    });
    expect(mocks.recordChatOnlyCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cus_outcome_evidence" }),
    );
  });

  it("rejects setup-fee metadata for Chat Only before Stripe or the family claim", async () => {
    await expect(
      createCheckoutSession(
        BUSINESS_ID,
        "chat_only",
        "price_chat_only",
        "price_setup",
        SUCCESS_URL,
        CANCEL_URL,
        "onboarding",
      ),
    ).rejects.toThrow("chat_only_stripe_price_invalid");

    expect(mocks.retrievePrice).not.toHaveBeenCalled();
    expect(mocks.claimCheckoutPlanFamily).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

describe("createBillingPortalSession configuration pin", () => {
  it("pins every session to the reviewed Billing Portal configuration", async () => {
    vi.stubEnv(
      "STRIPE_BILLING_PORTAL_CONFIGURATION_ID",
      "bpc_1UnitPortalConfiguration",
    );

    await expect(
      createBillingPortalSession(
        "cus_portal_unit",
        "https://simplassist.com/billing",
      ),
    ).resolves.toBe("https://billing.stripe.test/session");

    expect(mocks.createBillingPortalSession).toHaveBeenCalledOnce();
    expect(mocks.createBillingPortalSession).toHaveBeenCalledWith({
      customer: "cus_portal_unit",
      return_url: "https://simplassist.com/billing",
      configuration: "bpc_1UnitPortalConfiguration",
    });
  });

  it("fails closed before Stripe when the configuration pin is missing", async () => {
    vi.stubEnv("STRIPE_BILLING_PORTAL_CONFIGURATION_ID", "");

    await expect(
      createBillingPortalSession(
        "cus_portal_unit",
        "https://simplassist.com/billing",
      ),
    ).rejects.toThrow("STRIPE_BILLING_PORTAL_CONFIGURATION_ID is required");
    expect(mocks.createBillingPortalSession).not.toHaveBeenCalled();
  });

  it.each([
    "bpc_",
    "pc_wrong_prefix",
    "bpc_contains-hyphen",
    " bpc_1LeadingWhitespace",
  ])(
    "fails closed before Stripe for invalid configuration value %s",
    async (configurationId) => {
      vi.stubEnv("STRIPE_BILLING_PORTAL_CONFIGURATION_ID", configurationId);

      await expect(
        createBillingPortalSession(
          "cus_portal_unit",
          "https://simplassist.com/billing",
        ),
      ).rejects.toThrow(
        "STRIPE_BILLING_PORTAL_CONFIGURATION_ID must be a Stripe Billing Portal configuration ID (bpc_...)",
      );
      expect(mocks.createBillingPortalSession).not.toHaveBeenCalled();
    },
  );
});
