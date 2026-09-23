import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  attemptPaidLaunch: vi.fn(),
  getBusinessContentQuality: vi.fn(),
  getOnboardingStateForBusinessId: vi.fn(),
  getOnboardingCheckoutContextForBusinessIdReadOnly: vi.fn(),
  createCheckoutSession: vi.fn(),
  finalizePaidCheckout: vi.fn(),
  getExistingTelnyxBrandLinkState: vi.fn(),
  resolveAssignedPartnerName: vi.fn(),
  requireWorkspaceRouteAccess: vi.fn(),
  isPlanAvailable: vi.fn(),
  hasValidChatOnlyStripePrice: vi.fn(),
  isChatOnlyDirectAcquisitionEnabledForBusiness: vi.fn(),
  stripePriceIdForPlan: vi.fn(),
  stripeSetupFeePriceId: vi.fn(),
  ChatOnlyStripePriceConfigurationError: class extends Error {
    constructor() {
      super("chat_only_stripe_price_invalid");
    }
  },
  ChatOnlyCheckoutAttemptConflictError: class extends Error {},
  ChatOnlyCheckoutAttemptRecoveryRequiredError: class extends Error {},
  ChatOnlyCheckoutAttemptUnavailableError: class extends Error {},
  ChatOnlyCheckoutInProgressError: class extends Error {
    retryAfterSeconds: number;
    constructor(retryAfterSeconds: number) {
      super("chat_only_checkout_in_progress");
      this.retryAfterSeconds = retryAfterSeconds;
    }
  },
  ChatOnlyCheckoutSessionExpiredError: class extends Error {},
  ChatOnlyCheckoutRecoveredCompletionError: class extends Error {
    synced: {
      businessId: string;
      customerId: string;
      subscriptionId: string;
      plan: "chat_only";
    };
    constructor(synced: {
      businessId: string;
      customerId: string;
      subscriptionId: string;
      plan: "chat_only";
    }) {
      super("chat_only_checkout_recovered_completion");
      this.synced = synced;
    }
  },
  PlanFamilyTransitionNotSupportedError: class extends Error {
    constructor() {
      super("plan_family_transition_not_supported");
    }
  },
  DirectCheckoutPlanClaimUnavailableError: class extends Error {
    constructor() {
      super("direct_checkout_plan_claim_unavailable");
    }
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
  })),
}));
vi.mock("@/lib/billing/launch", () => ({
  attemptPaidLaunch: mocks.attemptPaidLaunch,
  SERVICES_FAQS_REQUIRED_MESSAGE:
    "Add at least 3 distinct services and 3 answered FAQs so your AI has enough accurate information to help customers.",
}));
vi.mock("@/lib/billing/finalizePaidCheckout.server", () => ({
  finalizePaidCheckout: mocks.finalizePaidCheckout,
}));
vi.mock("@/lib/onboarding/contentQuality.server", () => ({
  getBusinessContentQuality: mocks.getBusinessContentQuality,
}));
vi.mock("@/lib/onboarding/state", () => ({
  getOnboardingStateForBusinessId: mocks.getOnboardingStateForBusinessId,
  getOnboardingCheckoutContextForBusinessIdReadOnly:
    mocks.getOnboardingCheckoutContextForBusinessIdReadOnly,
}));
vi.mock("@/lib/stripe/checkout", () => ({
  createCheckoutSession: mocks.createCheckoutSession,
  ChatOnlyStripePriceConfigurationError:
    mocks.ChatOnlyStripePriceConfigurationError,
  ChatOnlyCheckoutAttemptConflictError:
    mocks.ChatOnlyCheckoutAttemptConflictError,
  ChatOnlyCheckoutAttemptRecoveryRequiredError:
    mocks.ChatOnlyCheckoutAttemptRecoveryRequiredError,
  ChatOnlyCheckoutAttemptUnavailableError:
    mocks.ChatOnlyCheckoutAttemptUnavailableError,
  ChatOnlyCheckoutInProgressError: mocks.ChatOnlyCheckoutInProgressError,
  ChatOnlyCheckoutSessionExpiredError:
    mocks.ChatOnlyCheckoutSessionExpiredError,
  ChatOnlyCheckoutRecoveredCompletionError:
    mocks.ChatOnlyCheckoutRecoveredCompletionError,
}));
vi.mock("@/lib/stripe/config", () => ({
  hasValidChatOnlyStripePrice: mocks.hasValidChatOnlyStripePrice,
  stripePriceIdForPlan: mocks.stripePriceIdForPlan,
  stripeSetupFeePriceId: mocks.stripeSetupFeePriceId,
}));
vi.mock("@/lib/billing/chatOnlyRollout.server", () => ({
  isChatOnlyDirectAcquisitionEnabledForBusiness:
    mocks.isChatOnlyDirectAcquisitionEnabledForBusiness,
}));
vi.mock("@/lib/billing/planAvailability", () => ({
  isPlanAvailable: mocks.isPlanAvailable,
}));
vi.mock("@/lib/billing/planFamilyLock.server", () => ({
  PlanFamilyTransitionNotSupportedError:
    mocks.PlanFamilyTransitionNotSupportedError,
  DirectCheckoutPlanClaimUnavailableError:
    mocks.DirectCheckoutPlanClaimUnavailableError,
}));
vi.mock("@/lib/messaging/registration/existingBrand", () => ({
  getExistingTelnyxBrandLinkState: mocks.getExistingTelnyxBrandLinkState,
}));
vi.mock("@/lib/billing/partnerManagedBilling.server", () => ({
  resolveAssignedPartnerName: mocks.resolveAssignedPartnerName,
  partnerManagedBillingMessage: (partnerName: string | null) =>
    partnerName
      ? `Billing is handled by ${partnerName}.`
      : "Billing is managed externally.",
}));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({
  requireWorkspaceRouteAccess: mocks.requireWorkspaceRouteAccess,
}));

import { POST } from "./route";
import { REJECTION_SUPPORT_MESSAGE } from "@/lib/onboarding/rejectionGuidance";

const BUSINESS = {
  id: "business-1",
  partner_id: null,
  billing_mode: "stripe",
  has_ein: true,
  billing_pilot: false,
  billing_comped: false,
  billing_exempt: true,
  onboarding_completed_at: null,
  onboarding_selected_plan: null,
};

const NEUTRAL_LAUNCH_ERRORS = [
  [
    "submission_disabled",
    "SMS registration is disabled for this account. Contact support if this looks wrong.",
  ],
  [
    "existing_brand_review_required",
    "Your existing Telnyx brand link needs review before SMS registration can continue. Contact support.",
  ],
  [
    "linked_brand_needs_support",
    "Your linked Telnyx brand needs support before SMS registration can continue. Its existing Telnyx resources were not replaced.",
  ],
  [
    "failed",
    "We could not recheck your existing Telnyx brand right now. No new Telnyx resources were created; please try again shortly.",
  ],
  [
    "missing_phone_number",
    "Choose your business number before submitting SMS registration.",
  ],
] as const;

function queueResults(...results: unknown[]) {
  const queue = [...results];
  mocks.from.mockImplementation((table: string) => {
    const result =
      queue.shift() ??
      (table === "subscriptions"
        ? { data: null, error: null }
        : {
            data: null,
            error: { message: "Unexpected database query" },
          });
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ["select", "eq", "single", "maybeSingle"]) {
      chain[method] = vi.fn(() => chain);
    }
    const promise = Promise.resolve(result);
    (chain as Record<string, unknown>).then = promise.then.bind(promise);
    (chain as Record<string, unknown>).catch = promise.catch.bind(promise);
    return chain;
  });
}

function request(
  mode: "onboarding" | "billing" = "onboarding",
  plan: "chat_only" | "sms_only" | "sms_and_chat" | "full" = "sms_and_chat",
) {
  return new NextRequest("http://localhost:8080/api/billing/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ plan, mode }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://simplassist.com/");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.getUser.mockResolvedValue({
    data: { user: { id: "owner-1" } },
    error: null,
  });
  mocks.attemptPaidLaunch.mockResolvedValue({ status: "submitted" });
  mocks.getBusinessContentQuality.mockResolvedValue({ ready: true });
  mocks.getOnboardingStateForBusinessId.mockResolvedValue({ step: "complete" });
  mocks.getOnboardingCheckoutContextForBusinessIdReadOnly.mockResolvedValue({
    state: { currentStep: "review_submit" },
    freshInitialDirectAcquisition: false,
  });
  mocks.createCheckoutSession.mockResolvedValue(
    "https://checkout.test/session",
  );
  mocks.finalizePaidCheckout.mockResolvedValue({ status: "completed" });
  mocks.getExistingTelnyxBrandLinkState.mockResolvedValue(null);
  mocks.isPlanAvailable.mockImplementation(
    (plan: string) => plan === "sms_only" || plan === "sms_and_chat",
  );
  mocks.hasValidChatOnlyStripePrice.mockReturnValue(false);
  mocks.isChatOnlyDirectAcquisitionEnabledForBusiness.mockImplementation(
    (businessId: string) =>
      process.env.CHAT_ONLY_DIRECT_SALES_ENABLED === "1" ||
      process.env.CHAT_ONLY_DIRECT_CANARY_BUSINESS_ID?.toLowerCase() ===
        businessId.toLowerCase(),
  );
  mocks.resolveAssignedPartnerName.mockResolvedValue(null);
  mocks.stripePriceIdForPlan.mockImplementation(
    (plan: string) =>
      ({
        chat_only: "price_chat_only",
        sms_only: "price_starter",
        sms_and_chat: "price_growth",
        full: "price_full",
      })[plan],
  );
  mocks.stripeSetupFeePriceId.mockReturnValue("price_setup");
  mocks.requireWorkspaceRouteAccess.mockResolvedValue({
    ok: true,
    access: {
      status: "resolved",
      user: { id: "owner-1" },
      business: { id: BUSINESS.id, partner_id: null },
      hostKind: "canonical",
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("first checkout requires completed onboarding", () => {
  function configureFresh(
    plan: "chat_only" | "sms_only" | "sms_and_chat" | "full" = "sms_and_chat",
    currentStep = "review_submit",
  ) {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "1");
    mocks.hasValidChatOnlyStripePrice.mockReturnValue(true);
    mocks.isPlanAvailable.mockReturnValue(true);
    queueResults(
      { data: { ...BUSINESS, billing_exempt: false, onboarding_selected_plan: plan }, error: null },
      { data: null, error: null },
    );
    const state = {
      currentStep,
      planSelection: { position: "start", effectivePlan: plan },
    };
    mocks.getOnboardingCheckoutContextForBusinessIdReadOnly.mockResolvedValue({
      state,
      freshInitialDirectAcquisition: true,
    });
    return state;
  }

  it.each([
    "plan_selection", "business_info", "business_hours", "services_faqs",
    "ai_settings", "legal_verification", "sms_use_case", "phone_number",
  ])("blocks missing %s before any payable or provider work", async (step) => {
    const state = configureFresh("sms_and_chat", step);
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "onboarding_incomplete", state });
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
    expect(mocks.stripePriceIdForPlan).not.toHaveBeenCalled();
    expect(mocks.attemptPaidLaunch).not.toHaveBeenCalled();
    expect(mocks.getExistingTelnyxBrandLinkState).not.toHaveBeenCalled();
    expect(mocks.getOnboardingStateForBusinessId).not.toHaveBeenCalled();
  });

  it.each(["chat_only", "sms_only", "sms_and_chat", "full"] as const)(
    "opens checkout only after %s setup is ready",
    async (plan) => {
      configureFresh(plan);
      const response = await POST(request("onboarding", plan));
      expect(response.status).toBe(200);
      expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
        BUSINESS.id, plan, expect.any(String), plan === "chat_only" ? null : "price_setup",
        expect.stringContaining("/onboarding?checkout=success"),
        expect.stringContaining("/onboarding?checkout=canceled"), "onboarding", true,
      );
    },
  );

  it.each(["chat_only", "sms_and_chat"] as const)(
    "does not let %s use billing mode to bypass initial onboarding",
    async (plan) => {
      const state = configureFresh(plan, "business_info");
      const response = await POST(request("billing", plan));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "onboarding_checkout_required", state });
      expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
    },
  );

  it("treats an omitted mode as billing and rejects it for a first checkout", async () => {
    configureFresh();
    const response = await POST(new NextRequest("http://localhost/api/billing/checkout", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: "sms_and_chat" }),
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "onboarding_checkout_required" });
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("rejects a different plan even when saved setup is otherwise complete", async () => {
    configureFresh("chat_only");
    const response = await POST(request("onboarding", "sms_and_chat"));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "onboarding_plan_mismatch" });
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("fails closed when read-only setup cannot be resolved", async () => {
    configureFresh();
    mocks.getOnboardingCheckoutContextForBusinessIdReadOnly.mockResolvedValue(null);
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "onboarding_state_unavailable" });
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("preserves existing locked billing-mode checkout identity and recovery", async () => {
    configureFresh();
    mocks.getOnboardingCheckoutContextForBusinessIdReadOnly.mockResolvedValue({
      freshInitialDirectAcquisition: false,
      state: { currentStep: "business_info" },
    });
    const response = await POST(request("billing"));
    expect(response.status).toBe(200);
    expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
      BUSINESS.id, "sms_and_chat", "price_growth", "price_setup",
      expect.stringContaining("/billing?success=true"),
      expect.stringContaining("/billing?canceled=true"), "billing", false,
    );
  });

  it("requires completed legacy SMS setup even when Chat Only sales are off", async () => {
    configureFresh("sms_only", "business_hours");
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "0");
    mocks.hasValidChatOnlyStripePrice.mockReturnValue(false);
    const response = await POST(request("onboarding", "sms_only"));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "onboarding_incomplete" });
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });
});

describe("POST /api/billing/checkout onboarding precedence", () => {
  it("rejects an unknown plan without disclosing the hidden catalog", async () => {
    const response = await POST(
      new NextRequest("http://localhost:8080/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan: "enterprise", mode: "onboarding" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid plan." });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each(["", "0", "true", "yes", "01", " 1", "1 "])(
    "rejects new crafted chat-only checkout with fail-closed direct flag %j before Stripe work",
    async (flag) => {
      vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", flag);
      queueResults(
        {
          data: {
            ...BUSINESS,
            billing_exempt: false,
            onboarding_selected_plan: "chat_only",
          },
          error: null,
        },
        { data: null, error: null },
      );

      const response = await POST(request("onboarding", "chat_only"));

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "Chat-only is not available yet.",
        code: "chat_only_not_available",
      });
      expect(mocks.from).toHaveBeenCalledTimes(2);
      expect(mocks.isPlanAvailable).not.toHaveBeenCalled();
      expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["campaign-only", { brand_status: "approved", campaign_status: "rejected" }],
    ["brand-only", { brand_status: "rejected", campaign_status: null }],
    ["dual", { brand_status: "rejected", campaign_status: "rejected" }],
  ])(
    "blocks an SMS Checkout for a %s rejection before subscription or Stripe work",
    async (_label, statuses) => {
      queueResults({ data: { ...BUSINESS, ...statuses }, error: null });

      const response = await POST(request());

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: REJECTION_SUPPORT_MESSAGE,
        code: "rejection_support_required",
        state: { step: "complete" },
      });
      expect(mocks.from).toHaveBeenCalledTimes(1);
      expect(mocks.getBusinessContentQuality).not.toHaveBeenCalled();
      expect(mocks.getExistingTelnyxBrandLinkState).not.toHaveBeenCalled();
      expect(mocks.attemptPaidLaunch).not.toHaveBeenCalled();
      expect(mocks.finalizePaidCheckout).not.toHaveBeenCalled();
      expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
    },
  );

  it("keeps Chat Only Checkout independent from an obsolete SMS rejection", async () => {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "1");
    mocks.hasValidChatOnlyStripePrice.mockReturnValue(true);
    queueResults(
      {
        data: {
          ...BUSINESS,
          billing_exempt: false,
          onboarding_selected_plan: "chat_only",
          brand_status: "rejected",
          campaign_status: "rejected",
        },
        error: null,
      },
      { data: null, error: null },
    );

    const response = await POST(request("onboarding", "chat_only"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: "https://checkout.test/session",
    });
    expect(mocks.createCheckoutSession).toHaveBeenCalledTimes(1);
    expect(mocks.attemptPaidLaunch).not.toHaveBeenCalled();
  });

  it("fails closed before Stripe when the selected Chat Only Price is missing for new acquisition", async () => {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "1");
    mocks.hasValidChatOnlyStripePrice.mockReturnValue(false);
    queueResults(
      {
        data: {
          ...BUSINESS,
          billing_exempt: false,
          onboarding_selected_plan: "chat_only",
        },
        error: null,
      },
      { data: null, error: null },
    );

    const response = await POST(request("onboarding", "chat_only"));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Chat-only is not available yet.",
      code: "chat_only_not_available",
    });
    expect(mocks.from).toHaveBeenCalledTimes(2);
    expect(mocks.stripePriceIdForPlan).not.toHaveBeenCalled();
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("creates exact-flag Chat Only onboarding checkout while the global catalog remains hidden", async () => {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "1");
    mocks.hasValidChatOnlyStripePrice.mockReturnValue(true);
    mocks.isPlanAvailable.mockReturnValue(false);
    queueResults(
      {
        data: {
          ...BUSINESS,
          billing_exempt: false,
          has_ein: false,
          onboarding_selected_plan: "chat_only",
        },
        error: null,
      },
      { data: null, error: null },
    );

    const response = await POST(request("onboarding", "chat_only"));

    const payload = await response.json();
    expect(payload).toEqual({
      url: "https://checkout.test/session",
    });
    expect(response.status).toBe(200);
    expect(mocks.isPlanAvailable).not.toHaveBeenCalledWith("chat_only");
    expect(mocks.stripePriceIdForPlan).toHaveBeenCalledWith("chat_only");
    expect(mocks.stripeSetupFeePriceId).not.toHaveBeenCalled();
    expect(mocks.getExistingTelnyxBrandLinkState).not.toHaveBeenCalled();
    expect(mocks.attemptPaidLaunch).not.toHaveBeenCalled();
    expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
      BUSINESS.id,
      "chat_only",
      "price_chat_only",
      null,
      "https://simplassist.com/onboarding?checkout=success&session_id={CHECKOUT_SESSION_ID}",
      "https://simplassist.com/onboarding?checkout=canceled",
      "onboarding",
      true,
    );
  });

  it("preserves the content-quality gate for Chat Only before billing", async () => {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "1");
    mocks.hasValidChatOnlyStripePrice.mockReturnValue(true);
    mocks.getBusinessContentQuality.mockResolvedValue({
      ready: false,
      validServiceCount: 2,
      validFaqCount: 3,
    });
    queueResults({
      data: {
        ...BUSINESS,
        billing_exempt: false,
        has_ein: false,
        onboarding_selected_plan: "chat_only",
      },
      error: null,
    });

    const response = await POST(request("onboarding", "chat_only"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "services_faqs_required",
    });
    expect(mocks.getExistingTelnyxBrandLinkState).not.toHaveBeenCalled();
    expect(mocks.stripePriceIdForPlan).not.toHaveBeenCalled();
  });

  it("requires Chat Only checkout to match durable onboarding intent", async () => {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "1");
    mocks.hasValidChatOnlyStripePrice.mockReturnValue(true);
    queueResults({
      data: {
        ...BUSINESS,
        billing_exempt: false,
        onboarding_selected_plan: "sms_and_chat",
      },
      error: null,
    });

    const response = await POST(request("onboarding", "chat_only"));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Your saved onboarding plan does not match this checkout.",
      code: "onboarding_plan_mismatch",
    });
    expect(mocks.getBusinessContentQuality).not.toHaveBeenCalled();
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("requires exact persisted SMS intent while the early-flow flag is enabled", async () => {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "1");
    mocks.hasValidChatOnlyStripePrice.mockReturnValue(true);
    queueResults({
      data: {
        ...BUSINESS,
        billing_exempt: false,
        onboarding_selected_plan: "sms_only",
      },
      error: null,
    });

    const response = await POST(request("onboarding", "sms_and_chat"));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "onboarding_plan_mismatch",
    });
    expect(mocks.getBusinessContentQuality).not.toHaveBeenCalled();
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it(
    "preserves legacy SMS checkout after rollback when the stored intent is already SMS",
    async () => {
      vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "0");
      queueResults(
        {
          data: {
            ...BUSINESS,
            billing_exempt: false,
            onboarding_selected_plan: "sms_only",
          },
          error: null,
        },
        { data: null, error: null },
      );

      const response = await POST(request("onboarding", "sms_and_chat"));

      expect(response.status).toBe(200);
      expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
        BUSINESS.id,
        "sms_and_chat",
        "price_growth",
        "price_setup",
        expect.any(String),
        expect.any(String),
        "onboarding",
        false,
      );
    },
  );

  it("rejects crafted SMS checkout when a saved Chat intent survives flag rollback", async () => {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "0");
    queueResults(
      {
        data: {
          ...BUSINESS,
          billing_exempt: false,
          onboarding_selected_plan: "chat_only",
        },
        error: null,
      },
      { data: null, error: null },
    );

    const response = await POST(request("onboarding", "sms_and_chat"));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "onboarding_plan_mismatch",
    });
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("rejects crafted SMS checkout when saved Chat intent survives invalid Price readiness", async () => {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "1");
    mocks.hasValidChatOnlyStripePrice.mockReturnValue(false);
    queueResults(
      {
        data: {
          ...BUSINESS,
          billing_exempt: false,
          onboarding_selected_plan: "chat_only",
        },
        error: null,
      },
      { data: null, error: null },
    );

    const response = await POST(request("onboarding", "sms_and_chat"));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "onboarding_plan_mismatch",
    });
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("keeps Chat acquisition blocked after rollback even when stale Chat intent remains", async () => {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "0");
    queueResults(
      {
        data: {
          ...BUSINESS,
          billing_exempt: false,
          onboarding_selected_plan: "chat_only",
        },
        error: null,
      },
      { data: null, error: null },
    );

    const response = await POST(request("onboarding", "chat_only"));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "chat_only_not_available",
    });
    expect(mocks.from).toHaveBeenCalledTimes(2);
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("rejects partner-owned Stripe-mode Chat acquisition before content, Telnyx, subscription, or Stripe work", async () => {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "1");
    mocks.hasValidChatOnlyStripePrice.mockReturnValue(true);
    mocks.resolveAssignedPartnerName.mockResolvedValue("Alpha Dog Agency");
    queueResults({
      data: {
        ...BUSINESS,
        partner_id: "partner-alpha-dog",
        onboarding_selected_plan: "chat_only",
      },
      error: null,
    });

    const response = await POST(request("onboarding", "chat_only"));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "billing_managed_by_partner",
      message: "Billing is handled by Alpha Dog Agency.",
    });
    expect(mocks.resolveAssignedPartnerName).toHaveBeenCalledWith(
      "partner-alpha-dog",
    );
    expect(mocks.getBusinessContentQuality).not.toHaveBeenCalled();
    expect(mocks.getExistingTelnyxBrandLinkState).not.toHaveBeenCalled();
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it("preserves legacy SMS checkout for a partner-linked Stripe-mode business", async () => {
    queueResults(
      {
        data: {
          ...BUSINESS,
          partner_id: "partner-repair-window",
          billing_exempt: false,
          onboarding_selected_plan: "sms_and_chat",
        },
        error: null,
      },
      { data: null, error: null },
    );

    const response = await POST(request("onboarding", "sms_and_chat"));

    expect(response.status).toBe(200);
    expect(mocks.resolveAssignedPartnerName).not.toHaveBeenCalled();
    expect(mocks.createCheckoutSession).toHaveBeenCalledOnce();
  });

  it("rejects billing-mode Chat Only acquisition even without an existing subscription", async () => {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "1");
    mocks.hasValidChatOnlyStripePrice.mockReturnValue(true);
    queueResults(
      {
        data: {
          ...BUSINESS,
          onboarding_completed_at: "2026-08-18T12:00:00.000Z",
        },
        error: null,
      },
      { data: null, error: null },
    );

    const response = await POST(request("billing", "chat_only"));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "chat_only_onboarding_only",
    });
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("requires payment recovery instead of creating a duplicate for a past-due Chat subscription", async () => {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "1");
    mocks.hasValidChatOnlyStripePrice.mockReturnValue(true);
    queueResults(
      {
        data: {
          ...BUSINESS,
          billing_exempt: false,
          onboarding_selected_plan: "chat_only",
        },
        error: null,
      },
      {
        data: {
          plan: "chat_only",
          status: "past_due",
          setup_fee_paid_at: null,
          stripe_customer_id: "cus_past_due",
          stripe_subscription_id: "sub_past_due",
        },
        error: null,
      },
    );

    const response = await POST(request("onboarding", "chat_only"));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "subscription_payment_recovery_required",
    });
    expect(mocks.stripePriceIdForPlan).not.toHaveBeenCalled();
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
    expect(mocks.attemptPaidLaunch).not.toHaveBeenCalled();
  });

  it("finalizes an already-paid Chat onboarding retry when acquisition rollout and Price readiness are off", async () => {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "0");
    mocks.hasValidChatOnlyStripePrice.mockReturnValue(false);
    queueResults(
      {
        data: {
          ...BUSINESS,
          billing_exempt: false,
          onboarding_selected_plan: null,
        },
        error: null,
      },
      {
        data: {
          plan: "chat_only",
          status: "active",
          setup_fee_paid_at: null,
          stripe_customer_id: "cus_paid_chat",
          stripe_subscription_id: "sub_paid_chat",
        },
        error: null,
      },
    );

    const response = await POST(request("onboarding", "chat_only"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
    expect(mocks.finalizePaidCheckout).toHaveBeenCalledWith(
      {
        businessId: BUSINESS.id,
        customerId: "cus_paid_chat",
        subscriptionId: "sub_paid_chat",
        plan: "chat_only",
      },
      "stripe_finalize",
    );
    expect(mocks.getBusinessContentQuality).not.toHaveBeenCalled();
    expect(mocks.stripePriceIdForPlan).not.toHaveBeenCalled();
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("never creates a duplicate Checkout when paid Chat finalization cannot reverify authority", async () => {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "0");
    mocks.hasValidChatOnlyStripePrice.mockReturnValue(false);
    mocks.finalizePaidCheckout.mockResolvedValue({
      status: "billing_required",
    });
    queueResults(
      {
        data: {
          ...BUSINESS,
          billing_exempt: false,
          onboarding_selected_plan: null,
        },
        error: null,
      },
      {
        data: {
          plan: "chat_only",
          status: "trialing",
          setup_fee_paid_at: null,
          stripe_customer_id: "cus_trialing_chat",
          stripe_subscription_id: "sub_trialing_chat",
        },
        error: null,
      },
    );

    const response = await POST(request("onboarding", "chat_only"));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "subscription_payment_sync_required",
    });
    expect(mocks.finalizePaidCheckout).toHaveBeenCalledOnce();
    expect(mocks.stripePriceIdForPlan).not.toHaveBeenCalled();
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("does not reacquire a canceled Chat subscription while rollout is off", async () => {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "0");
    mocks.hasValidChatOnlyStripePrice.mockReturnValue(false);
    queueResults(
      {
        data: {
          ...BUSINESS,
          billing_exempt: false,
          onboarding_selected_plan: "chat_only",
        },
        error: null,
      },
      {
        data: {
          plan: "chat_only",
          status: "canceled",
          setup_fee_paid_at: null,
          stripe_customer_id: "cus_canceled_chat",
          stripe_subscription_id: "sub_canceled_chat",
        },
        error: null,
      },
    );

    const response = await POST(request("onboarding", "chat_only"));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "chat_only_reacquisition_not_supported",
    });
    expect(mocks.finalizePaidCheckout).not.toHaveBeenCalled();
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("rejects a new Chat Checkout when the workspace is suspended", async () => {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "1");
    mocks.hasValidChatOnlyStripePrice.mockReturnValue(true);
    queueResults(
      {
        data: {
          ...BUSINESS,
          billing_exempt: false,
          operations_suspended_at: "2026-08-19T12:00:00.000Z",
          onboarding_selected_plan: "chat_only",
        },
        error: null,
      },
      { data: null, error: null },
    );

    const response = await POST(request("onboarding", "chat_only"));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This workspace is temporarily unavailable.",
      code: "account_suspended",
    });
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("lets a suspended paid Chat account finish exact local finalization without new Checkout", async () => {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "0");
    mocks.hasValidChatOnlyStripePrice.mockReturnValue(false);
    queueResults(
      {
        data: {
          ...BUSINESS,
          billing_exempt: false,
          operations_suspended_at: "2026-08-19T12:00:00.000Z",
          onboarding_selected_plan: "chat_only",
        },
        error: null,
      },
      {
        data: {
          plan: "chat_only",
          status: "active",
          setup_fee_paid_at: null,
          stripe_customer_id: "cus_paid_suspended",
          stripe_subscription_id: "sub_paid_suspended",
        },
        error: null,
      },
    );

    const response = await POST(request("onboarding", "chat_only"));

    expect(response.status).toBe(200);
    expect(mocks.finalizePaidCheckout).toHaveBeenCalledWith(
      {
        businessId: BUSINESS.id,
        customerId: "cus_paid_suspended",
        subscriptionId: "sub_paid_suspended",
        plan: "chat_only",
      },
      "stripe_finalize",
    );
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("preserves a paid SMS onboarding retry without advisory intent while early flow is enabled", async () => {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "1");
    mocks.hasValidChatOnlyStripePrice.mockReturnValue(true);
    queueResults(
      {
        data: {
          ...BUSINESS,
          billing_exempt: false,
          onboarding_selected_plan: null,
        },
        error: null,
      },
      {
        data: {
          plan: "sms_and_chat",
          status: "active",
          setup_fee_paid_at: "2026-08-18T12:00:00.000Z",
          stripe_customer_id: "cus_paid_sms",
          stripe_subscription_id: "sub_paid_sms",
        },
        error: null,
      },
    );

    const response = await POST(request("onboarding", "sms_and_chat"));

    expect(response.status).toBe(200);
    expect(mocks.attemptPaidLaunch).toHaveBeenCalledWith(
      BUSINESS.id,
      "onboarding_retry",
    );
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("maps an authoritative family-claim conflict to 409", async () => {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "1");
    mocks.hasValidChatOnlyStripePrice.mockReturnValue(true);
    queueResults(
      {
        data: {
          ...BUSINESS,
          billing_exempt: false,
          onboarding_selected_plan: "chat_only",
        },
        error: null,
      },
      { data: null, error: null },
    );
    mocks.createCheckoutSession.mockRejectedValue(
      new mocks.PlanFamilyTransitionNotSupportedError(),
    );

    const response = await POST(request("onboarding", "chat_only"));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "plan_family_transition_not_supported",
    });
  });

  it("maps an atomic exact-plan claim race to a refreshable 409", async () => {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "1");
    mocks.hasValidChatOnlyStripePrice.mockReturnValue(true);
    queueResults(
      {
        data: {
          ...BUSINESS,
          billing_exempt: false,
          onboarding_selected_plan: "chat_only",
        },
        error: null,
      },
      { data: null, error: null },
    );
    mocks.createCheckoutSession.mockRejectedValue(
      new mocks.DirectCheckoutPlanClaimUnavailableError(),
    );

    const response = await POST(request("onboarding", "chat_only"));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Your setup changed. Refresh and choose your plan again.",
      code: "checkout_plan_state_changed",
    });
  });

  it("keeps an aged ambiguous Chat Checkout support-only", async () => {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "1");
    mocks.hasValidChatOnlyStripePrice.mockReturnValue(true);
    queueResults(
      {
        data: {
          ...BUSINESS,
          billing_exempt: false,
          onboarding_selected_plan: "chat_only",
        },
        error: null,
      },
      { data: null, error: null },
    );
    mocks.createCheckoutSession.mockRejectedValue(
      new mocks.ChatOnlyCheckoutAttemptRecoveryRequiredError(),
    );

    const response = await POST(request("onboarding", "chat_only"));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "We could not safely recover the previous Chat Checkout. Contact support before trying again.",
      code: "chat_only_checkout_recovery_required",
    });
  });

  it("surfaces an invalid runtime Chat Price as unavailable instead of creating Checkout", async () => {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "1");
    mocks.hasValidChatOnlyStripePrice.mockReturnValue(true);
    queueResults(
      {
        data: {
          ...BUSINESS,
          billing_exempt: false,
          onboarding_selected_plan: "chat_only",
        },
        error: null,
      },
      { data: null, error: null },
    );
    mocks.createCheckoutSession.mockRejectedValue(
      new mocks.ChatOnlyStripePriceConfigurationError(),
    );

    const response = await POST(request("onboarding", "chat_only"));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "chat_only_price_configuration_invalid",
    });
  });

  it("logs only bounded error metadata for an unexpected Checkout failure", async () => {
    const sentinel = "customer@example.com sk_test_do_not_log";
    queueResults(
      { data: { ...BUSINESS, billing_exempt: false }, error: null },
      { data: null, error: null },
    );
    mocks.createCheckoutSession.mockRejectedValue(new Error(sentinel));

    const response = await POST(request("onboarding", "sms_and_chat"));

    expect(response.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith("Checkout failed", {
      error: { name: "Error", status: null },
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      sentinel,
    );
  });

  it.each([
    ["sms_and_chat", "chat_only"],
    ["chat_only", "sms_and_chat"],
  ] as const)(
    "blocks unsupported existing %s to %s family transitions",
    async (existingPlan, selectedPlan) => {
      if (selectedPlan === "chat_only") {
        vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "1");
        mocks.hasValidChatOnlyStripePrice.mockReturnValue(true);
      }
      queueResults(
        {
          data: {
            ...BUSINESS,
            billing_exempt: false,
            onboarding_completed_at: "2026-08-18T12:00:00.000Z",
          },
          error: null,
        },
        {
          data: {
            plan: existingPlan,
            status: "active",
            setup_fee_paid_at:
              existingPlan === "chat_only" ? null : "2026-08-18T12:00:00.000Z",
            stripe_customer_id: "cus_existing",
            stripe_subscription_id: "sub_existing",
          },
          error: null,
        },
      );

      const response = await POST(request("billing", selectedPlan));

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "plan_family_transition_not_supported",
      });
      expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    [401, { error: "Unauthorized" }],
    [403, { error: "workspace_access_denied" }],
    [503, { error: "workspace_access_unavailable", retryable: true }],
  ])(
    "returns workspace %i before parsing or billing work",
    async (status, body) => {
      mocks.requireWorkspaceRouteAccess.mockResolvedValue({
        ok: false,
        response: NextResponse.json(body, { status }),
      });
      const guardedRequest = request();
      const json = vi.spyOn(guardedRequest, "json");

      const response = await POST(guardedRequest);

      expect(response.status).toBe(status);
      expect(json).not.toHaveBeenCalled();
      expect(mocks.from).not.toHaveBeenCalled();
      expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
      expect(mocks.attemptPaidLaunch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["partner-1", "Alpha Dog Agency"],
    ["partner-2", "Second Partner"],
  ])(
    "rejects partner-managed checkout with the assigned %s name before any Stripe or onboarding work",
    async (partnerId, partnerName) => {
      queueResults({
        data: {
          ...BUSINESS,
          partner_id: partnerId,
          billing_mode: "invoiced",
          has_ein: false,
        },
        error: null,
      });
      mocks.resolveAssignedPartnerName.mockResolvedValue(partnerName);

      const response = await POST(request());

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "billing_managed_by_partner",
        message: `Billing is handled by ${partnerName}.`,
      });
      expect(mocks.resolveAssignedPartnerName).toHaveBeenCalledWith(partnerId);
      expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
      expect(mocks.getBusinessContentQuality).not.toHaveBeenCalled();
      expect(mocks.getOnboardingStateForBusinessId).not.toHaveBeenCalled();
      expect(mocks.getExistingTelnyxBrandLinkState).not.toHaveBeenCalled();
      expect(mocks.attemptPaidLaunch).not.toHaveBeenCalled();
      expect(mocks.from).toHaveBeenCalledTimes(1);
    },
  );

  it("uses the exact external-billing fallback for an orphaned comped business", async () => {
    queueResults({
      data: {
        ...BUSINESS,
        partner_id: null,
        billing_mode: "comped",
        has_ein: false,
      },
      error: null,
    });

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "billing_managed_by_partner",
      message: "Billing is managed externally.",
    });
    expect(mocks.resolveAssignedPartnerName).toHaveBeenCalledWith(null);
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
    expect(mocks.getBusinessContentQuality).not.toHaveBeenCalled();
    expect(mocks.getExistingTelnyxBrandLinkState).not.toHaveBeenCalled();
    expect(mocks.attemptPaidLaunch).not.toHaveBeenCalled();
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it("blocks a new crafted Full Suite checkout before Stripe", async () => {
    queueResults({
      data: {
        ...BUSINESS,
        billing_exempt: false,
        onboarding_completed_at: "2026-07-01T00:00:00.000Z",
      },
      error: null,
    });

    const response = await POST(request("billing", "full"));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "Full Suite is coming soon. Join the waitlist to be notified when it launches.",
      code: "full_suite_coming_soon",
    });
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("preserves an already-paid Full Suite onboarding retry", async () => {
    queueResults(
      { data: { ...BUSINESS, billing_exempt: false }, error: null },
      {
        data: {
          plan: "full",
          status: "active",
          setup_fee_paid_at: "2026-07-01T00:00:00.000Z",
          stripe_customer_id: "cus_full",
          stripe_subscription_id: "sub_full",
        },
        error: null,
      },
    );

    const response = await POST(request("onboarding", "full"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
    expect(mocks.attemptPaidLaunch).toHaveBeenCalledWith(
      BUSINESS.id,
      "onboarding_retry",
    );
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns the 3+3 quality gate before creating a Stripe session", async () => {
    queueResults({ data: BUSINESS, error: null });
    mocks.getBusinessContentQuality.mockResolvedValue({
      ready: false,
      validServiceCount: 2,
      validFaqCount: 3,
    });
    mocks.getOnboardingStateForBusinessId.mockResolvedValue({
      currentStep: "services_faqs",
    });

    const response = await POST(request());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "services_faqs_required",
      state: { currentStep: "services_faqs" },
    });
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
    expect(mocks.attemptPaidLaunch).not.toHaveBeenCalled();
    expect(mocks.getExistingTelnyxBrandLinkState).not.toHaveBeenCalled();
  });

  it.each(["past_due", "canceled"])(
    "does not let a protected override bypass an existing %s subscription",
    async (status) => {
      queueResults(
        { data: BUSINESS, error: null },
        {
          data: {
            plan: "sms_and_chat",
            status,
            setup_fee_paid_at: "2026-07-01T00:00:00.000Z",
            stripe_customer_id: "cus_growth",
            stripe_subscription_id: "sub_growth",
          },
          error: null,
        },
      );

      const response = await POST(request());

      expect(response.status).toBe(200);
      expect(mocks.attemptPaidLaunch).not.toHaveBeenCalled();
      expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
        BUSINESS.id,
        "sms_and_chat",
        "price_growth",
        "price_setup",
        "https://simplassist.com/onboarding?checkout=success&session_id={CHECKOUT_SESSION_ID}",
        "https://simplassist.com/onboarding?checkout=canceled",
        "onboarding",
        false,
      );
      expect(await response.json()).toEqual({
        url: "https://checkout.test/session",
      });
    },
  );

  it("uses a protected override only when no subscription row exists", async () => {
    queueResults({ data: BUSINESS, error: null }, { data: null, error: null });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.attemptPaidLaunch).toHaveBeenCalledWith(
      BUSINESS.id,
      "onboarding_retry",
    );
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ success: true });
  });

  it.each(NEUTRAL_LAUNCH_ERRORS)(
    "returns raw neutral %s launch copy without a product name",
    async (status, message) => {
      queueResults(
        { data: BUSINESS, error: null },
        { data: null, error: null },
      );
      mocks.attemptPaidLaunch.mockResolvedValue({ status, message });

      const response = await POST(request());
      const text = await response.text();

      expect(response.status).toBe(400);
      expect(JSON.parse(text)).toEqual({
        error: message,
        code: status,
        state: { step: "complete" },
      });
      expect(text).not.toContain("SimplAssist");
      expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
    },
  );

  it("maps a paid-launch rejection race to a 409 without creating Checkout", async () => {
    queueResults({ data: BUSINESS, error: null }, { data: null, error: null });
    mocks.attemptPaidLaunch.mockResolvedValue({
      status: "rejection_support_required",
      message: REJECTION_SUPPORT_MESSAGE,
    });

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: REJECTION_SUPPORT_MESSAGE,
      code: "rejection_support_required",
      state: { step: "complete" },
    });
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });

  it.each(["pending_admin", "blocked"])(
    "blocks checkout while an existing-brand link is %s",
    async (status) => {
      queueResults({ data: BUSINESS, error: null });
      mocks.getExistingTelnyxBrandLinkState.mockResolvedValue({
        status,
        tcrBrandId: "BL69PDP",
      });

      const response = await POST(request());
      const text = await response.text();

      expect(response.status).toBe(409);
      expect(JSON.parse(text)).toEqual({
        code: "existing_brand_review_required",
        error:
          "Your existing Telnyx brand link needs review before checkout can continue. Contact support.",
        state: { step: "complete" },
      });
      expect(text).not.toContain("SimplAssist");
      expect(mocks.attemptPaidLaunch).not.toHaveBeenCalled();
      expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
      expect(mocks.from).toHaveBeenCalledTimes(2);
    },
  );

  it("allows an approved existing-brand link to continue to checkout", async () => {
    queueResults(
      { data: { ...BUSINESS, billing_exempt: false }, error: null },
      { data: null, error: null },
    );
    mocks.getExistingTelnyxBrandLinkState.mockResolvedValue({
      status: "approved",
      tcrBrandId: "BL69PDP",
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.createCheckoutSession).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/billing/checkout redirect URLs", () => {
  it("uses the configured public origin instead of Railway's localhost origin", async () => {
    queueResults(
      { data: { ...BUSINESS, billing_exempt: false }, error: null },
      { data: null, error: null },
    );

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
      BUSINESS.id,
      "sms_and_chat",
      "price_growth",
      "price_setup",
      "https://simplassist.com/onboarding?checkout=success&session_id={CHECKOUT_SESSION_ID}",
      "https://simplassist.com/onboarding?checkout=canceled",
      "onboarding",
      false,
    );
  });

  it("uses the configured public origin for billing success and cancel URLs", async () => {
    queueResults({
      data: {
        ...BUSINESS,
        onboarding_completed_at: "2026-07-01T00:00:00.000Z",
      },
      error: null,
    });

    const response = await POST(request("billing"));

    expect(response.status).toBe(200);
    expect(mocks.createCheckoutSession).toHaveBeenCalledWith(
      BUSINESS.id,
      "sms_and_chat",
      "price_growth",
      "price_setup",
      "https://simplassist.com/billing?success=true&session_id={CHECKOUT_SESSION_ID}",
      "https://simplassist.com/billing?canceled=true",
      "billing",
      false,
    );
    expect(mocks.getBusinessContentQuality).not.toHaveBeenCalled();
  });

  it("fails before creating a Stripe session when production has no public URL", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    queueResults({ data: BUSINESS, error: null });

    const response = await POST(request("billing"));

    expect(response.status).toBe(500);
    expect(mocks.createCheckoutSession).not.toHaveBeenCalled();
  });
});
