import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  requireWorkspaceRouteAccess: vi.fn(),
  directAcquisition: vi.fn(),
  validChatPrice: vi.fn(),
  isPlanAvailable: vi.fn(),
  getCheckoutContext: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({
  requireWorkspaceRouteAccess: mocks.requireWorkspaceRouteAccess,
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("@/lib/billing/chatOnlyRollout.server", () => ({
  isChatOnlyDirectAcquisitionEnabledForBusiness: mocks.directAcquisition,
}));
vi.mock("@/lib/stripe/config", () => ({
  hasValidChatOnlyStripePrice: mocks.validChatPrice,
}));
vi.mock("@/lib/onboarding/state", () => ({
  getOnboardingCheckoutContextForBusinessIdReadOnly: mocks.getCheckoutContext,
}));
vi.mock("@/lib/billing/planAvailability", () => ({
  isPlanAvailable: mocks.isPlanAvailable,
}));

import { POST } from "./route";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const BUSINESS_ID = "00000000-0000-4000-8000-000000000002";

type Result = { data: unknown; error: unknown };
type Chain = Record<string, ReturnType<typeof vi.fn>>;

const chains: Chain[] = [];

function queueResults(...results: Result[]) {
  const queue = [...results];
  chains.length = 0;
  mocks.from.mockImplementation(() => {
    const result = queue.shift() ?? {
      data: null,
      error: { message: "unexpected query" },
    };
    const chain = {} as Chain;
    for (const method of ["select", "update", "eq", "is"]) {
      chain[method] = vi.fn(() => chain);
    }
    chain.maybeSingle = vi.fn(async () => result);
    chains.push(chain);
    return chain;
  });
}

function business(
  overrides: Partial<{
    partner_id: string | null;
    billing_mode: "stripe" | "invoiced" | "comped";
    partner_plan: "sms_only" | "sms_and_chat" | "full" | "chat_only" | null;
    onboarding_selected_plan:
      | "sms_only"
      | "sms_and_chat"
      | "full"
      | "chat_only"
      | null;
    deleted_at: string | null;
    operations_suspended_at: string | null;
    billing_pilot: boolean;
    billing_comped: boolean;
    billing_exempt: boolean;
  }> = {},
) {
  return {
    id: BUSINESS_ID,
    owner_id: USER_ID,
    partner_id: null,
    billing_mode: "stripe" as const,
    partner_plan: null,
    onboarding_selected_plan: null,
    deleted_at: null,
    operations_suspended_at: null,
    billing_pilot: false,
    billing_comped: false,
    billing_exempt: false,
    ...overrides,
  };
}

function request(body: unknown) {
  return new NextRequest("http://localhost/api/onboarding/plan-selection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.requireWorkspaceRouteAccess.mockResolvedValue({
    ok: true,
    access: {
      user: { id: USER_ID },
      business: { id: BUSINESS_ID },
    },
  });
  mocks.directAcquisition.mockReturnValue(false);
  mocks.validChatPrice.mockReturnValue(false);
  mocks.isPlanAvailable.mockImplementation(
    (plan: string) => plan === "sms_only" || plan === "sms_and_chat",
  );
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  mocks.getCheckoutContext.mockResolvedValue({
    state: {
      planSelection: {
        chatOnlyDirectSalesAvailable: true,
        familyChangeRequiresSupport: false,
      },
    },
    freshInitialDirectAcquisition: true,
  });
  queueResults();
});

describe("POST /api/onboarding/plan-selection", () => {
  it("rejects Chat Only when read-only policy finds SMS history or a family lock", async () => {
    mocks.directAcquisition.mockReturnValue(true);
    mocks.validChatPrice.mockReturnValue(true);
    queueResults({ data: business(), error: null }, { data: null, error: null });
    mocks.getCheckoutContext.mockResolvedValue({
      state: { planSelection: { chatOnlyDirectSalesAvailable: false, familyChangeRequiresSupport: true } },
      freshInitialDirectAcquisition: false,
    });
    const response = await POST(request({ plan: "chat_only" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "plan_family_transition_not_supported" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each(["missing", "failed"])("fails closed on %s read-only policy", async (failure) => {
    mocks.directAcquisition.mockReturnValue(true);
    mocks.validChatPrice.mockReturnValue(true);
    queueResults({ data: business(), error: null }, { data: null, error: null });
    if (failure === "missing") mocks.getCheckoutContext.mockResolvedValue(null);
    else mocks.getCheckoutContext.mockRejectedValue(new Error("unavailable"));
    const response = await POST(request({ plan: "chat_only" }));
    expect(response.status).toBe(503);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("keeps same-family legacy SMS intent repair independent of Chat policy", async () => {
    mocks.directAcquisition.mockReturnValue(true);
    mocks.validChatPrice.mockReturnValue(true);
    queueResults({ data: business(), error: null }, { data: null, error: null });
    const response = await POST(request({ plan: "sms_only" }));
    expect(response.status).toBe(200);
    expect(mocks.getCheckoutContext).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith("save_direct_onboarding_plan_intent", expect.objectContaining({
      p_requested_plan: "sms_only", p_expected_plan: null,
    }));
  });

  it("applies the workspace gate before parsing input", async () => {
    mocks.requireWorkspaceRouteAccess.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "denied" }, { status: 403 }),
    });
    const input = request({ plan: "chat_only" });
    const jsonSpy = vi.spyOn(input, "json");

    const response = await POST(input);

    expect(response.status).toBe(403);
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { plan: "enterprise" },
    { plan: "chat_only", businessId: BUSINESS_ID },
  ])("rejects malformed selection %j without a database read", async (body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid plan selection" });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each([
    [false, true],
    [true, false],
  ])(
    "keeps Chat Only unavailable with flag=%s validPrice=%s",
    async (flag, price) => {
      mocks.directAcquisition.mockReturnValue(flag);
      mocks.validChatPrice.mockReturnValue(price);
      queueResults(
        { data: business(), error: null },
        { data: null, error: null },
      );

      const response = await POST(request({ plan: "chat_only" }));

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "That plan is not available for selection",
      });
      expect(mocks.from).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    business({ partner_id: "partner-1", billing_mode: "invoiced" }),
    business({ partner_plan: "chat_only" }),
  ])("rejects partner or malformed partner authority", async (row) => {
    queueResults({ data: row, error: null }, { data: null, error: null });

    const response = await POST(request({ plan: "sms_and_chat" }));

    expect(response.status).toBe(403);
    expect(chains).toHaveLength(2);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["deleted", { deleted_at: "2026-08-19T12:00:00.000Z" }],
    [
      "operations-suspended",
      { operations_suspended_at: "2026-08-19T12:00:00.000Z" },
    ],
    ["billing-pilot", { billing_pilot: true }],
    ["billing-comped", { billing_comped: true }],
    ["billing-exempt", { billing_exempt: true }],
  ] as const)("rejects an otherwise matching %s business", async (_label, overrides) => {
    mocks.directAcquisition.mockReturnValue(true);
    mocks.validChatPrice.mockReturnValue(true);
    queueResults(
      { data: business(overrides), error: null },
      { data: null, error: null },
    );

    const response = await POST(request({ plan: "chat_only" }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "That plan is not available for selection",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.directAcquisition).not.toHaveBeenCalled();
  });

  it("never lets advisory intent outrank an existing subscription", async () => {
    queueResults(
      { data: business(), error: null },
      { data: { plan: "sms_only", status: "canceled" }, error: null },
    );

    const response = await POST(request({ plan: "sms_and_chat" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ plan: "sms_only" });
    expect(mocks.from).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("keeps the entire new selection route inert while rollout is off", async () => {
    queueResults(
      { data: business(), error: null },
      { data: null, error: null },
    );

    const response = await POST(request({ plan: "sms_and_chat" }));

    expect(response.status).toBe(403);
    expect(mocks.from).toHaveBeenCalledTimes(2);
  });

  it("preserves selectable SMS plans when the new direct flow is enabled", async () => {
    mocks.directAcquisition.mockReturnValue(true);
    mocks.validChatPrice.mockReturnValue(true);
    queueResults(
      { data: business(), error: null },
      { data: null, error: null },
    );

    const response = await POST(request({ plan: "sms_and_chat" }));

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "save_direct_onboarding_plan_intent",
      {
        p_business_id: BUSINESS_ID,
        p_owner_id: USER_ID,
        p_expected_plan: null,
        p_requested_plan: "sms_and_chat",
      },
    );
  });

  it("persists Chat Only only when both server acquisition gates pass", async () => {
    mocks.directAcquisition.mockReturnValue(true);
    mocks.validChatPrice.mockReturnValue(true);
    queueResults(
      {
        data: business({ onboarding_selected_plan: "sms_and_chat" }),
        error: null,
      },
      { data: null, error: null },
    );

    const response = await POST(request({ plan: "chat_only" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      plan: "chat_only",
    });
    expect(mocks.directAcquisition).toHaveBeenCalledWith(BUSINESS_ID);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "save_direct_onboarding_plan_intent",
      {
        p_business_id: BUSINESS_ID,
        p_owner_id: USER_ID,
        p_expected_plan: "sms_and_chat",
        p_requested_plan: "chat_only",
      },
    );
  });

  it("fails a missed compare-and-swap instead of overwriting new state", async () => {
    mocks.directAcquisition.mockReturnValue(true);
    mocks.validChatPrice.mockReturnValue(true);
    queueResults(
      { data: business(), error: null },
      { data: null, error: null },
    );
    mocks.rpc.mockResolvedValue({ data: false, error: null });

    const response = await POST(request({ plan: "sms_only" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Your setup changed. Refresh and choose again.",
    });
  });

  it("surfaces an opposing durable plan-family claim as a stable conflict", async () => {
    mocks.directAcquisition.mockReturnValue(true);
    mocks.validChatPrice.mockReturnValue(true);
    queueResults(
      {
        data: business({ onboarding_selected_plan: "chat_only" }),
        error: null,
      },
      { data: null, error: null },
    );
    mocks.rpc.mockResolvedValue({
      data: null,
      error: {
        code: "55000",
        message: "plan_family_transition_not_supported",
      },
    });

    const response = await POST(request({ plan: "sms_only" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "That plan conflicts with billing setup already started for this account.",
      code: "plan_family_transition_not_supported",
    });
  });

  it("fails closed when the atomic intent writer cannot run", async () => {
    mocks.directAcquisition.mockReturnValue(true);
    mocks.validChatPrice.mockReturnValue(true);
    queueResults(
      { data: business(), error: null },
      { data: null, error: null },
    );
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: "XX000", message: "database unavailable" },
    });

    const response = await POST(request({ plan: "chat_only" }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Could not save your plan choice",
    });
  });
});
