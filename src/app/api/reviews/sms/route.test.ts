import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewSmsError } from "@/lib/billing/reviewSms";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  origin: vi.fn(),
  overview: vi.fn(),
  setupOverview: vi.fn(),
  initializeSignup: vi.fn(),
  saveDraft: vi.fn(),
  checkout: vi.fn(),
  quote: vi.fn(),
  activate: vi.fn(),
  cancel: vi.fn(),
  refund: vi.fn(),
  readAccount: vi.fn(),
  synchronizeCheckout: vi.fn(),
  provision: vi.fn(),
  refreshReadiness: vi.fn(),
  reconcileSubscription: vi.fn(),
  retrieveCheckout: vi.fn(),
  retrieveSubscription: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  maybeSingle: vi.fn(),
}));

vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({
  requireFreshWorkspaceRouteAccess: mocks.access,
}));
vi.mock("@/lib/reviews/domain", () => ({ reviewOrigin: mocks.origin }));
vi.mock("@/lib/stripe/reviewSms.server", () => ({
  reviewSmsOverview: mocks.overview,
  createReviewSmsActivationCheckout: mocks.checkout,
  quoteReviewSmsRecurring: mocks.quote,
  confirmReviewSmsRecurring: mocks.activate,
  cancelReviewSmsAtPeriodEnd: mocks.cancel,
  refundUnsubmittedReviewSmsActivation: mocks.refund,
  readReviewSmsAccount: mocks.readAccount,
  synchronizeReviewSmsCheckout: mocks.synchronizeCheckout,
  reconcileReviewSmsSubscription: mocks.reconcileSubscription,
}));
vi.mock("@/lib/reviews/smsProvisioning.server", () => ({
  continueReviewSmsProvisioning: mocks.provision,
  refreshReviewSmsProviderReadiness: mocks.refreshReadiness,
  reviewSmsSetupOverview: mocks.setupOverview,
  saveReviewSmsSetup: mocks.saveDraft,
  initializeIncludedReviewSmsSignup: mocks.initializeSignup,
}));
vi.mock("@/lib/stripe/client", () => ({
  stripe: {
    checkout: { sessions: { retrieve: mocks.retrieveCheckout } },
    subscriptions: { retrieve: mocks.retrieveSubscription },
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mocks.from },
}));

import { GET, POST } from "./route";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000001";
const OWNER_ID = "00000000-0000-4000-8000-000000000002";
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000003";
const ORIGIN = "https://simplassist.example";
const overview = { account: { state: "draft" }, canPurchase: true };
const setup = { ready: false, missingFields: ["website"] };
const downstream = [
  mocks.overview,
  mocks.setupOverview,
  mocks.saveDraft,
  mocks.checkout,
  mocks.quote,
  mocks.activate,
  mocks.cancel,
  mocks.refund,
  mocks.readAccount,
  mocks.synchronizeCheckout,
  mocks.provision,
  mocks.refreshReadiness,
  mocks.reconcileSubscription,
  mocks.retrieveCheckout,
  mocks.retrieveSubscription,
  mocks.from,
];

function post(body: unknown) {
  return POST(
    new Request("https://untrusted.example/api/reviews/sms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function expectNoDownstreamCalls() {
  for (const service of downstream) expect(service).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockResolvedValue({
    ok: true,
    access: { business: { id: BUSINESS_ID }, user: { id: OWNER_ID } },
  });
  mocks.origin.mockReturnValue(ORIGIN);
  mocks.overview.mockResolvedValue(overview);
  mocks.setupOverview.mockResolvedValue(setup);
  for (const service of [
    mocks.saveDraft,
    mocks.checkout,
    mocks.quote,
    mocks.activate,
    mocks.cancel,
    mocks.refund,
  ]) {
    service.mockResolvedValue({ accepted: true });
  }
  mocks.readAccount.mockResolvedValue(null);
  const query = {
    select: mocks.select,
    eq: mocks.eq,
    maybeSingle: mocks.maybeSingle,
  };
  mocks.from.mockReturnValue(query);
  mocks.select.mockReturnValue(query);
  mocks.eq.mockReturnValue(query);
  mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
});

describe("/api/reviews/sms workspace authorization", () => {
  it.each([401, 403, 503])(
    "returns the fresh workspace gate's %i response before any action",
    async (status) => {
      const denied = NextResponse.json(
        { error: "workspace_unavailable" },
        { status },
      );
      mocks.access.mockResolvedValue({ ok: false, response: denied });
      const request = new Request("https://simplassist.example/api/reviews/sms", {
        method: "POST",
        body: JSON.stringify({ action: "checkout" }),
      });
      const readBody = vi.spyOn(request, "text");

      expect(await GET()).toBe(denied);
      expect(await POST(request)).toBe(denied);
      expect(mocks.access).toHaveBeenCalledTimes(2);
      expect(readBody).not.toHaveBeenCalled();
      expectNoDownstreamCalls();
    },
  );

  it("returns a private overview for the resolved workspace without provisioning", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ ...overview, setup });
    expect(mocks.overview).toHaveBeenCalledExactlyOnceWith(BUSINESS_ID, OWNER_ID);
    expect(mocks.setupOverview).toHaveBeenCalledExactlyOnceWith(BUSINESS_ID);
    for (const service of downstream.filter(
      (service) => service !== mocks.overview && service !== mocks.setupOverview,
    )) {
      expect(service).not.toHaveBeenCalled();
    }
  });
});

describe("POST /api/reviews/sms actions", () => {
  const actions = [
    {
      action: "draft",
      service: "saveDraft",
      extra: { draft: { website: "https://business.example" } },
    },
    { action: "checkout", service: "checkout", extra: {} },
    { action: "quote", service: "quote", extra: {} },
    {
      action: "activate",
      service: "activate",
      extra: {
        operationId: "operation_own",
        fingerprint: "quote_fingerprint",
      },
    },
    { action: "cancel", service: "cancel", extra: {} },
    { action: "refund", service: "refund", extra: {} },
  ] as const;

  it.each(actions)(
    "dispatches $action using server identity and ignores forged ownership",
    async ({ action, service, extra }) => {
      const response = await post({
        action,
        ...extra,
        businessId: "business_other_tenant",
        ownerId: "owner_other_tenant",
        origin: "https://untrusted.example",
        subscriptionId: "sub_other_tenant",
        checkoutSessionId: "cs_other_tenant",
      });
      const expectedArguments: unknown[] = [BUSINESS_ID, OWNER_ID];
      if (action === "draft") expectedArguments.push(extra.draft);
      if (action === "checkout") expectedArguments.push(ORIGIN);
      if (action === "activate")
        expectedArguments.push(extra.operationId, extra.fingerprint);

      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ accepted: true });
      expect(mocks[service]).toHaveBeenCalledExactlyOnceWith(
        ...expectedArguments,
      );
      for (const other of downstream.filter((call) => call !== mocks[service]))
        expect(other).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: "malformed JSON", raw: "{" },
    { label: "null", raw: "null" },
    { label: "an array", raw: "[]" },
    { label: "a string", raw: '"checkout"' },
    { label: "a number", raw: "1" },
  ])("rejects $label before dispatch", async ({ raw }) => {
    const response = await POST(
      new Request("https://simplassist.example/api/reviews/sms", {
        method: "POST",
        body: raw,
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "review_sms_invalid_request",
    });
    expectNoDownstreamCalls();
  });

  it("rejects an oversized body before dispatch", async () => {
    const response = await post({
      action: "draft",
      draft: { notes: "x".repeat(10001) },
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "review_sms_request_too_large",
    });
    expectNoDownstreamCalls();
  });

  it.each([undefined, null, [], "draft", 1])(
    "rejects a non-object draft (%j)",
    async (draft) => {
      const response = await post({ action: "draft", draft });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "review_sms_invalid_request",
      });
      expectNoDownstreamCalls();
    },
  );

  it("rejects an unknown action without dispatching", async () => {
    const response = await post({ action: "submit_campaign_directly" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "review_sms_invalid_action",
    });
    expectNoDownstreamCalls();
  });

  it("preserves a service's billing or approval refusal", async () => {
    mocks.activate.mockRejectedValueOnce(
      new ReviewSmsError("review_sms_not_approved", 409),
    );

    const response = await post({
      action: "activate",
      operationId: "operation_own",
      fingerprint: "fingerprint",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "review_sms_not_approved",
    });
    expect(mocks.provision).not.toHaveBeenCalled();
  });

  it("does not expose unexpected provider details to the caller", async () => {
    mocks.checkout.mockRejectedValueOnce(
      new Error("private provider account details"),
    );

    const response = await post({ action: "checkout" });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "review_sms_request_failed",
    });
  });
});

describe("POST /api/reviews/sms refresh", () => {
  it("returns the overview without provider calls when no account exists", async () => {
    const response = await post({ action: "refresh" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ...overview, setup });
    expect(mocks.readAccount).toHaveBeenCalledExactlyOnceWith(BUSINESS_ID);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.retrieveCheckout).not.toHaveBeenCalled();
    expect(mocks.provision).not.toHaveBeenCalled();
    expect(mocks.retrieveSubscription).not.toHaveBeenCalled();
  });

  it("refreshes only stored account resources, in payment-before-provider order", async () => {
    const checkout = { id: "cs_stored_activation", payment_status: "paid" };
    const subscription = { id: "sub_stored_source", status: "active" };
    mocks.readAccount.mockResolvedValue({
      id: ACCOUNT_ID,
      billing_source: "direct",
      source_subscription_id: subscription.id,
    });
    mocks.maybeSingle.mockResolvedValue({
      data: { checkout_session_id: checkout.id },
      error: null,
    });
    mocks.retrieveCheckout.mockResolvedValue(checkout);
    mocks.retrieveSubscription.mockResolvedValue(subscription);

    const response = await post({
      action: "refresh",
      businessId: "business_other_tenant",
      checkoutSessionId: "cs_other_tenant",
      subscriptionId: "sub_other_tenant",
    });

    expect(response.status).toBe(200);
    expect(mocks.readAccount).toHaveBeenCalledExactlyOnceWith(BUSINESS_ID);
    expect(mocks.from).toHaveBeenCalledExactlyOnceWith(
      "review_sms_billing_operations",
    );
    expect(mocks.eq.mock.calls).toEqual([
      ["account_id", ACCOUNT_ID],
      ["kind", "activation"],
      ["state", "confirmed"],
    ]);
    expect(mocks.retrieveCheckout).toHaveBeenCalledExactlyOnceWith(checkout.id);
    expect(mocks.synchronizeCheckout).toHaveBeenCalledExactlyOnceWith(checkout);
    expect(mocks.provision).toHaveBeenCalledExactlyOnceWith(BUSINESS_ID);
    expect(mocks.refreshReadiness).toHaveBeenCalledExactlyOnceWith(BUSINESS_ID);
    expect(mocks.retrieveSubscription).toHaveBeenCalledExactlyOnceWith(
      subscription.id,
    );
    expect(mocks.reconcileSubscription).toHaveBeenCalledExactlyOnceWith(
      subscription,
    );
    const orderedCalls = [
      mocks.synchronizeCheckout,
      mocks.provision,
      mocks.refreshReadiness,
      mocks.reconcileSubscription,
      mocks.overview,
    ].map((service) => service.mock.invocationCallOrder[0]);
    expect(orderedCalls).toEqual([...orderedCalls].sort((a, b) => a - b));
    await expect(response.json()).resolves.toEqual({ ...overview, setup });
  });

  it.each(["grant", "included"])(
    "does not fetch a direct Stripe subscription for a %s account",
    async (billingSource) => {
      mocks.readAccount.mockResolvedValue({
        id: ACCOUNT_ID,
        billing_source: billingSource,
        source_subscription_id: "sub_unused",
      });

      const response = await post({ action: "refresh" });

      expect(response.status).toBe(200);
      expect(mocks.retrieveCheckout).not.toHaveBeenCalled();
      expect(mocks.provision).toHaveBeenCalledExactlyOnceWith(BUSINESS_ID);
      expect(mocks.refreshReadiness).toHaveBeenCalledExactlyOnceWith(BUSINESS_ID);
      expect(mocks.retrieveSubscription).not.toHaveBeenCalled();
      expect(mocks.reconcileSubscription).not.toHaveBeenCalled();
    },
  );

  it("stops refresh before provider calls if stored billing state cannot be read", async () => {
    mocks.readAccount.mockResolvedValue({ id: ACCOUNT_ID });
    mocks.maybeSingle.mockResolvedValue({
      data: null,
      error: { message: "query failed" },
    });

    const response = await post({ action: "refresh" });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "review_sms_state_unavailable",
    });
    expect(mocks.retrieveCheckout).not.toHaveBeenCalled();
    expect(mocks.provision).not.toHaveBeenCalled();
    expect(mocks.refreshReadiness).not.toHaveBeenCalled();
    expect(mocks.overview).not.toHaveBeenCalled();
  });

  it("does not continue provisioning when activation reconciliation fails", async () => {
    mocks.readAccount.mockResolvedValue({
      id: ACCOUNT_ID,
      billing_source: "direct",
      source_subscription_id: "sub_stored",
    });
    mocks.maybeSingle.mockResolvedValue({
      data: { checkout_session_id: "cs_stored" },
      error: null,
    });
    mocks.retrieveCheckout.mockResolvedValue({ id: "cs_stored" });
    mocks.synchronizeCheckout.mockRejectedValueOnce(
      new ReviewSmsError("review_sms_checkout_binding_mismatch", 409),
    );

    const response = await post({ action: "refresh" });

    expect(response.status).toBe(409);
    expect(mocks.provision).not.toHaveBeenCalled();
    expect(mocks.refreshReadiness).not.toHaveBeenCalled();
    expect(mocks.retrieveSubscription).not.toHaveBeenCalled();
    expect(mocks.overview).not.toHaveBeenCalled();
  });
});
