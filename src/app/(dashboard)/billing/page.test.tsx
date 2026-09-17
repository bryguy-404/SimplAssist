import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const BILLING_ROUTE_CTA_SOURCES = [
  [
    "paused-feature Manage plan",
    "../../../components/entitlements/FeatureStatusBanners.tsx",
  ],
  [
    "locked-feature Manage plan",
    "../../../components/entitlements/LockedFeatureCard.tsx",
  ],
  [
    "conversation plan and billing notices",
    "../../../components/conversations/MessageThread.tsx",
  ],
  [
    "inactive-subscription Billing notice",
    "../../../components/settings/AISettingsForm.tsx",
  ],
] as const;

const BILLING_URL_STATES = [
  ["plain deep link or dashboard CTA", undefined],
  [
    "successful Stripe Checkout callback",
    { success: "true", session_id: "cs_stale" },
  ],
  ["canceled Stripe Checkout callback", { canceled: "true" }],
  [
    "stale checkout tab-state parameter",
    { checkout: "success", session_id: "cs_stale" },
  ],
] as const;

const mocks = vi.hoisted(() => ({
  getOwnerVoiceSettings: vi.fn(),
  redirect: vi.fn(),
  requireWorkspacePageAccess: vi.fn(),
  getDashboardBusinessContext: vi.fn(),
  from: vi.fn(),
  resolveAssignedPartnerName: vi.fn(),
  getRequestBrand: vi.fn(),
  isPlanAvailable: vi.fn(),
  getCurrentAIReplyUsage: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({
  requireWorkspacePageAccess: mocks.requireWorkspacePageAccess,
}));
vi.mock("@/lib/dashboard/context", () => ({
  getDashboardBusinessContext: mocks.getDashboardBusinessContext,
}));
vi.mock("@/lib/branding/requestBrand.server", () => ({
  getRequestBrand: mocks.getRequestBrand,
}));
vi.mock("@/lib/billing/planAvailability", () => ({
  CUSTOMER_VISIBLE_PLAN_ORDER: ["sms_only", "sms_and_chat", "full"],
  isPlanAvailable: mocks.isPlanAvailable,
}));
vi.mock("@/lib/billing/aiReplyMeter.server", () => ({
  getCurrentAIReplyUsage: mocks.getCurrentAIReplyUsage,
}));
vi.mock("./billing-actions", () => ({
  BillingActions: ({ mode }: { mode: string }) => (
    <div>Stripe billing action: {mode}</div>
  ),
}));
vi.mock("@/lib/billing/partnerManagedBilling.server", () => ({
  resolveAssignedPartnerName: mocks.resolveAssignedPartnerName,
  partnerManagedBillingMessage: (partnerName: string | null) =>
    partnerName
      ? `Billing is handled by ${partnerName}.`
      : "Billing is managed externally.",
}));

vi.mock("@/lib/voice/access.server", () => ({
  getOwnerVoiceSettings: mocks.getOwnerVoiceSettings,
}));

import BillingPage from "./page";

const CHAT_ONLY_USAGE = {
  outcome: "no_period" as const,
  usagePeriodId: null,
  billingSource: "subscription" as const,
  plan: "chat_only" as const,
  allowance: 200,
  completedReplies: 0,
  activeReservations: 0,
  remainingReplies: 200,
  periodStart: "2026-08-01T00:00:00.000Z",
  periodEnd: "2026-09-01T00:00:00.000Z",
  allowanceRenewal: "scheduled" as const,
  resetAt: "2026-09-01T00:00:00.000Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function queryThenable(result: Promise<unknown>) {
  const query: Record<string, unknown> = {};
  for (const method of [
    "select",
    "eq",
    "order",
    "limit",
    "single",
    "maybeSingle",
  ]) {
    query[method] = vi.fn(() => query);
  }
  query.then = result.then.bind(result);
  query.catch = result.catch.bind(result);
  return query;
}

function setDirectActiveChatOnlyBilling(
  subscriptionStatus: "active" | "past_due" = "active",
) {
  mocks.from.mockImplementation((table: string) =>
    queryThenable(
      Promise.resolve(
        table === "subscriptions"
          ? {
              data: {
                plan: "chat_only",
                status: subscriptionStatus,
                current_period_end: "2026-09-01T12:00:00.000Z",
              },
            }
          : {
              data: {
                inbound_sms_parts: 500,
                outbound_sms_parts: 500,
                included_sms_parts: 1_000,
              },
            },
      ),
    ),
  );
  mocks.getDashboardBusinessContext.mockResolvedValue({
    status: "resolved",
    supabase: { from: mocks.from },
    user: { id: "user-1" },
    business: {
      id: "business-1",
      partner_id: null,
      billing_mode: "stripe",
      operations_suspended_at: null,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOwnerVoiceSettings.mockResolvedValue(null);
  mocks.redirect.mockImplementation((path: string) => {
    throw new Error(`redirect:${path}`);
  });
  mocks.requireWorkspacePageAccess.mockResolvedValue(undefined);
  mocks.resolveAssignedPartnerName.mockResolvedValue(null);
  mocks.getRequestBrand.mockResolvedValue({
    source: "default",
    isPreview: false,
    brand: { name: "SimplAssist" },
  });
  mocks.isPlanAvailable.mockImplementation((plan: string) => plan !== "full");
  mocks.getCurrentAIReplyUsage.mockResolvedValue(CHAT_ONLY_USAGE);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("BillingPage", () => {
  it("starts subscription and usage reads together", async () => {
    const subscription = deferred<{ data: null }>();
    const usage = deferred<{ data: null }>();
    mocks.from.mockImplementation((table: string) =>
      queryThenable(
        table === "subscriptions" ? subscription.promise : usage.promise,
      ),
    );
    mocks.getDashboardBusinessContext.mockResolvedValue({
      status: "resolved",
      supabase: { from: mocks.from },
      user: { id: "user-1" },
      business: {
        id: "business-1",
        partner_id: null,
        billing_mode: "stripe",
        operations_suspended_at: null,
      },
    });

    const page = BillingPage({});

    await vi.waitFor(() => {
      expect(mocks.from).toHaveBeenCalledWith("subscriptions");
      expect(mocks.from).toHaveBeenCalledWith("billing_usage_periods");
    });

    subscription.resolve({ data: null });
    usage.resolve({ data: null });
    await expect(page).resolves.toBeDefined();
    expect(mocks.resolveAssignedPartnerName).not.toHaveBeenCalled();
  });

  it("uses request-brand plan copy without changing Stripe plan behavior", async () => {
    mocks.from.mockImplementation(() =>
      queryThenable(Promise.resolve({ data: null })),
    );
    mocks.getDashboardBusinessContext.mockResolvedValue({
      status: "resolved",
      supabase: { from: mocks.from },
      user: { id: "user-1" },
      business: {
        id: "business-1",
        partner_id: null,
        billing_mode: "stripe",
        operations_suspended_at: null,
      },
    });
    mocks.getRequestBrand.mockResolvedValue({
      source: "admin_preview",
      isPreview: true,
      brand: { name: "Alpha Dog Agency" },
    });

    const html = renderToStaticMarkup(await BillingPage({}));

    expect(html).toContain("One local Alpha Dog Agency number");
    expect(html).not.toContain("One local SimplAssist number");
    expect(html).toContain("$25");
    expect(html).toContain("Stripe billing action");
    expect(html).not.toContain("Billing during suspension");
    expect(html).not.toContain("billing continues");
  });

  it.each(BILLING_URL_STATES)(
    "keeps the direct missing-subscription checkout paywall unchanged for a %s",
    async (_urlState, searchParams) => {
      mocks.from.mockImplementation(() =>
        queryThenable(Promise.resolve({ data: null })),
      );
      mocks.getDashboardBusinessContext.mockResolvedValue({
        status: "resolved",
        supabase: { from: mocks.from },
        user: { id: "user-1" },
        business: {
          id: "business-1",
          partner_id: null,
          billing_mode: "stripe",
          operations_suspended_at: null,
        },
      });

      const html = renderToStaticMarkup(await BillingPage({ searchParams }));

      expect(mocks.redirect).not.toHaveBeenCalled();
      expect(html).toContain("Billing");
      expect(html).toContain("Choose a plan to get started");
      expect(html).toContain("Starter / SMS Only");
      expect(html).toContain("Growth / SMS + Web Chat");
      expect(html).not.toContain("Chat Only");
      expect(html).not.toContain("200 AI replies/month");
      expect(html).not.toContain("Pro / Full Suite");
      expect(html).not.toContain("Notify Me When It Launches");
      expect(html.match(/Stripe billing action: checkout/g)).toHaveLength(2);
      expect(mocks.isPlanAvailable).toHaveBeenCalledWith("full");
      expect(mocks.getCurrentAIReplyUsage).not.toHaveBeenCalled();
    },
  );

  it("restores the Full choice and checkout when Full becomes available", async () => {
    mocks.isPlanAvailable.mockReturnValue(true);
    mocks.from.mockImplementation(() =>
      queryThenable(Promise.resolve({ data: null })),
    );
    mocks.getDashboardBusinessContext.mockResolvedValue({
      status: "resolved",
      supabase: { from: mocks.from },
      user: { id: "user-1" },
      business: {
        id: "business-1",
        partner_id: null,
        billing_mode: "stripe",
        operations_suspended_at: null,
      },
    });

    const html = renderToStaticMarkup(await BillingPage({}));

    expect(html).toContain("Pro / Full Suite");
    expect(html).toContain("$65");
    expect(html).not.toContain("Coming Soon");
    expect(html).not.toContain("Notify Me When It Launches");
    expect(html.match(/Stripe billing action: checkout/g)).toHaveLength(3);
  });

  it("keeps an existing active Full subscription and portal visible while Full is unavailable", async () => {
    mocks.from.mockImplementation((table: string) =>
      queryThenable(
        Promise.resolve(
          table === "subscriptions"
            ? {
                data: {
                  plan: "full",
                  status: "active",
                  current_period_end: "2026-09-01T12:00:00.000Z",
                },
              }
            : {
                data: {
                  inbound_sms_parts: 20,
                  outbound_sms_parts: 30,
                  included_sms_parts: 2_500,
                },
              },
        ),
      ),
    );
    mocks.getDashboardBusinessContext.mockResolvedValue({
      status: "resolved",
      supabase: { from: mocks.from },
      user: { id: "user-1" },
      business: {
        id: "business-1",
        partner_id: null,
        billing_mode: "stripe",
        operations_suspended_at: null,
      },
    });

    const html = renderToStaticMarkup(await BillingPage({}));

    expect(html).toContain("Pro / Full Suite");
    expect(html).toContain("Stripe billing action: portal");
    expect(html).toContain("50 / 2,500 parts");
    expect(html).not.toContain("Stripe billing action: checkout");
    expect(html).not.toContain("Choose a plan to get started");
    expect(mocks.isPlanAvailable).not.toHaveBeenCalled();
    expect(mocks.getCurrentAIReplyUsage).not.toHaveBeenCalled();
  });

  it("shows authoritative 0 / 200 Chat Only usage without SMS or acquisition actions", async () => {
    setDirectActiveChatOnlyBilling();

    const html = renderToStaticMarkup(await BillingPage({}));

    expect(html).toContain("Chat Only");
    expect(html).toContain("AI reply usage");
    expect(html).toContain("0 / 200 replies");
    expect(html).toContain("200 replies remaining");
    expect(html).toContain("Resets Sep 1, 2026 (UTC)");
    expect(html).toContain("bg-green-500");
    expect(html).toContain(
      "Your AI reply usage is within the included amount.",
    );
    expect(html).toContain("Stripe billing action: portal");
    expect(html.match(/Stripe billing action: portal/g)).toHaveLength(1);
    expect(html).not.toContain("SMS usage");
    expect(html).not.toContain("parts");
    expect(html).not.toContain("Stripe billing action: checkout");
    expect(html).not.toContain("Choose a plan to get started");
    expect(html).not.toContain("Review your available plan options");
    expect(html).not.toContain(
      "Contact support if you need more reply capacity",
    );
    expect(mocks.getCurrentAIReplyUsage).toHaveBeenCalledOnce();
    expect(mocks.getCurrentAIReplyUsage).toHaveBeenCalledWith("business-1");
    expect(mocks.isPlanAvailable).not.toHaveBeenCalled();
  });

  it("shows the Chat Only 80% warning with an honest support action", async () => {
    setDirectActiveChatOnlyBilling();
    mocks.getCurrentAIReplyUsage.mockResolvedValue({
      ...CHAT_ONLY_USAGE,
      outcome: "current",
      usagePeriodId: "00000000-0000-4000-8000-000000000010",
      completedReplies: 160,
      remainingReplies: 40,
    });

    const html = renderToStaticMarkup(await BillingPage({}));

    expect(html).toContain("160 / 200 replies");
    expect(html).toContain("40 replies remaining");
    expect(html).toContain("bg-amber-500");
    expect(html).toContain("You are close to your monthly AI reply allowance.");
    expect(html).toContain("Contact support if you need more reply capacity.");
    expect(html).toContain('href="/support"');
    expect(html.match(/Stripe billing action: portal/g)).toHaveLength(1);
    expect(html).not.toContain("SMS usage");
    expect(html).not.toContain("Stripe billing action: checkout");
  });

  it("counts only completed assistants as used while active replies reduce remaining capacity", async () => {
    setDirectActiveChatOnlyBilling();
    mocks.getCurrentAIReplyUsage.mockResolvedValue({
      ...CHAT_ONLY_USAGE,
      outcome: "current",
      usagePeriodId: "00000000-0000-4000-8000-000000000010",
      completedReplies: 159,
      activeReservations: 1,
      remainingReplies: 40,
    });

    const html = renderToStaticMarkup(await BillingPage({}));

    expect(html).toContain("159 / 200 replies");
    expect(html).not.toContain("160 / 200 replies");
    expect(html).toContain("40 replies remaining");
    expect(html).toContain("1 reply is being prepared.");
    expect(html).toContain("This is not counted as used");
    expect(html).toContain('aria-valuenow="160"');
    expect(html).toContain("bg-amber-500");
    expect(html).toContain("Contact support if you need more reply capacity.");
  });

  it("shows the exhausted Chat Only state while keeping lead capture and billing management available", async () => {
    setDirectActiveChatOnlyBilling();
    mocks.getCurrentAIReplyUsage.mockResolvedValue({
      ...CHAT_ONLY_USAGE,
      outcome: "current",
      usagePeriodId: "00000000-0000-4000-8000-000000000010",
      completedReplies: 200,
      remainingReplies: 0,
    });

    const html = renderToStaticMarkup(await BillingPage({}));

    expect(html).toContain("200 / 200 replies");
    expect(html).toContain("0 replies remaining");
    expect(html).toContain("bg-red-500");
    expect(html).toContain("No AI reply capacity is currently available.");
    expect(html).toContain(
      "The widget remains available to collect follow-up details.",
    );
    expect(html).toContain("Contact support if you need more reply capacity.");
    expect(html).toContain('href="/support"');
    expect(html.match(/Stripe billing action: portal/g)).toHaveLength(1);
    expect(html).not.toContain("SMS usage");
    expect(html).not.toContain("Stripe billing action: checkout");
  });

  it("shows frozen past-due capacity without inventing a reset date", async () => {
    setDirectActiveChatOnlyBilling("past_due");
    mocks.getCurrentAIReplyUsage.mockResolvedValue({
      ...CHAT_ONLY_USAGE,
      outcome: "current",
      usagePeriodId: "00000000-0000-4000-8000-000000000010",
      completedReplies: 35,
      remainingReplies: 165,
      allowanceRenewal: "frozen_past_due",
      resetAt: null,
    });

    const html = renderToStaticMarkup(await BillingPage({}));

    expect(html).toContain("35 / 200 replies");
    expect(html).toContain("165 replies remaining");
    expect(html).toContain(
      "Allowance renewal is paused while payment is past due.",
    );
    expect(html).toContain("It will resume after payment recovery");
    expect(html).toContain("manage billing above to update payment details");
    expect(html).not.toContain("Resets ");
    expect(html).not.toContain("Jan 1, 1970");
    expect(html.match(/Stripe billing action: portal/g)).toHaveLength(1);
    expect(html).not.toContain("SMS usage");
  });

  it("fails Chat Only usage reads closed without fabricating counts or hiding plan management", async () => {
    setDirectActiveChatOnlyBilling();
    mocks.getCurrentAIReplyUsage.mockRejectedValue(
      new Error("private usage database failure"),
    );

    const html = renderToStaticMarkup(await BillingPage({}));

    expect(html).toContain("AI reply usage is temporarily unavailable.");
    expect(html).toContain(
      "No usage estimate is shown until current billing data can be verified.",
    );
    expect(html).not.toMatch(/\d+ \/ 200 replies/);
    expect(html).not.toContain("replies remaining");
    expect(html).not.toContain("Resets Sep");
    expect(html.match(/Stripe billing action: portal/g)).toHaveLength(1);
    expect(html).not.toContain("SMS usage");
    expect(html).not.toContain("Stripe billing action: checkout");
    expect(console.error).toHaveBeenCalledWith(
      "Billing AI reply usage lookup failed:",
      expect.any(Error),
    );
  });

  it("shows Stripe billing truth during suspension without hiding subscription details or portal access", async () => {
    mocks.from.mockImplementation((table: string) =>
      queryThenable(
        Promise.resolve(
          table === "subscriptions"
            ? {
                data: {
                  plan: "sms_and_chat",
                  status: "active",
                  current_period_end: "2026-09-01T12:00:00.000Z",
                },
              }
            : {
                data: {
                  inbound_sms_parts: 12,
                  outbound_sms_parts: 18,
                  included_sms_parts: 1_500,
                },
              },
        ),
      ),
    );
    mocks.getDashboardBusinessContext.mockResolvedValue({
      status: "resolved",
      supabase: { from: mocks.from },
      user: { id: "user-1" },
      business: {
        id: "business-1",
        partner_id: null,
        billing_mode: "stripe",
        operations_suspended_at: "2026-08-04T12:00:00.000Z",
      },
    });

    const html = renderToStaticMarkup(await BillingPage({}));

    expect(html).toContain("Billing during suspension");
    expect(html).toContain(
      "Suspension does not pause your Stripe subscription; billing continues.",
    );
    expect(html).toContain("Growth / SMS + Web Chat");
    expect(html).toContain(">active<");
    expect(html).toContain("Next billing date:");
    expect(html).toContain("Stripe billing action: portal");
    expect(html).toContain("SMS usage");
    expect(html).toContain("30 / 1,500 parts");
    expect(html).not.toContain(
      "Billing remains managed by your partner; this suspension has not changed it.",
    );
    expect(mocks.resolveAssignedPartnerName).not.toHaveBeenCalled();
  });

  it.each(BILLING_URL_STATES)(
    "redirects partner-owned Stripe billing for a %s before billing reads",
    async (_urlState, searchParams) => {
      mocks.getDashboardBusinessContext.mockResolvedValue({
        status: "resolved",
        supabase: { from: mocks.from },
        user: { id: "user-1" },
        business: {
          id: "business-1",
          partner_id: "partner-1",
          billing_mode: "stripe",
          operations_suspended_at: null,
        },
      });

      await expect(BillingPage({ searchParams })).rejects.toThrow(
        "redirect:/dashboard",
      );

      expect(mocks.redirect).toHaveBeenCalledOnce();
      expect(mocks.redirect).toHaveBeenCalledWith("/dashboard");
      expect(mocks.from).not.toHaveBeenCalled();
      expect(mocks.getRequestBrand).not.toHaveBeenCalled();
      expect(mocks.resolveAssignedPartnerName).not.toHaveBeenCalled();
      expect(mocks.isPlanAvailable).not.toHaveBeenCalled();
      expect(mocks.getCurrentAIReplyUsage).not.toHaveBeenCalled();
    },
  );

  it.each(["invoiced", "comped"] as const)(
    "redirects partner-owned %s billing before billing reads",
    async (billingMode) => {
      mocks.getDashboardBusinessContext.mockResolvedValue({
        status: "resolved",
        supabase: { from: mocks.from },
        user: { id: "user-1" },
        business: {
          id: "business-1",
          partner_id: "partner-1",
          billing_mode: billingMode,
          operations_suspended_at: null,
        },
      });

      await expect(BillingPage({})).rejects.toThrow("redirect:/dashboard");

      expect(mocks.redirect).toHaveBeenCalledOnce();
      expect(mocks.redirect).toHaveBeenCalledWith("/dashboard");
      expect(mocks.from).not.toHaveBeenCalled();
      expect(mocks.getRequestBrand).not.toHaveBeenCalled();
      expect(mocks.resolveAssignedPartnerName).not.toHaveBeenCalled();
      expect(mocks.isPlanAvailable).not.toHaveBeenCalled();
      expect(mocks.getCurrentAIReplyUsage).not.toHaveBeenCalled();
    },
  );

  it.each(BILLING_ROUTE_CTA_SOURCES)(
    "%s continues to target the centrally guarded Billing route",
    (_entryPoint, relativePath) => {
      const source = readFileSync(
        new URL(relativePath, import.meta.url),
        "utf8",
      );

      expect(source).toContain('href="/billing"');
    },
  );

  it.each(["invoiced", "comped"] as const)(
    "keeps the direct %s external-billing page unchanged",
    async (billingMode) => {
      mocks.getDashboardBusinessContext.mockResolvedValue({
        status: "resolved",
        supabase: { from: mocks.from },
        user: { id: "user-1" },
        business: {
          id: "business-1",
          partner_id: null,
          billing_mode: billingMode,
          operations_suspended_at: null,
        },
      });

      const html = renderToStaticMarkup(await BillingPage({}));

      expect(mocks.redirect).not.toHaveBeenCalled();
      expect(mocks.resolveAssignedPartnerName).toHaveBeenCalledWith(null);
      expect(mocks.from).not.toHaveBeenCalled();
      expect(html).toContain("Billing is managed externally.");
      expect(html).not.toContain("Billing is handled by");
      expect(html).toContain("Partner-managed billing");
      expect(html).not.toContain("Stripe billing action");
      expect(html).not.toContain("Choose a plan");
      expect(html).not.toContain("Recommended");
      expect(html).not.toContain("Manage your subscription");
      expect(html).not.toContain("SMS usage");
      expect(html).not.toContain("Billing during suspension");
      expect(html).not.toContain("Pro / Full Suite");
      expect(html).not.toContain("Notify Me When It Launches");
      expect(mocks.getRequestBrand).not.toHaveBeenCalled();
      expect(mocks.isPlanAvailable).not.toHaveBeenCalled();
      expect(mocks.getCurrentAIReplyUsage).not.toHaveBeenCalled();
    },
  );

  it.each(["invoiced", "comped"] as const)(
    "keeps the direct %s suspension edge on its generic external page",
    async (billingMode) => {
      mocks.getDashboardBusinessContext.mockResolvedValue({
        status: "resolved",
        supabase: { from: mocks.from },
        user: { id: "user-1" },
        business: {
          id: "business-1",
          partner_id: null,
          billing_mode: billingMode,
          operations_suspended_at: "2026-08-04T12:00:00.000Z",
        },
      });

      const html = renderToStaticMarkup(await BillingPage({}));

      expect(html).toContain("Billing during suspension");
      expect(html).toContain(
        "Billing remains managed by your partner; this suspension has not changed it.",
      );
      expect(html).toContain("Partner-managed billing");
      expect(html).toContain("Billing is managed externally.");
      expect(html).not.toContain("Billing is handled by");
      expect(mocks.redirect).not.toHaveBeenCalled();
      expect(mocks.resolveAssignedPartnerName).toHaveBeenCalledWith(null);
      expect(mocks.from).not.toHaveBeenCalled();
      expect(mocks.getRequestBrand).not.toHaveBeenCalled();
      expect(html).not.toContain("Stripe billing action");
      expect(html).not.toContain("Manage your subscription");
      expect(html).not.toContain("SMS usage");
      expect(html).not.toContain("billing continues");
      expect(html).not.toContain("SimplAssist");
    },
  );
});

const VOICE_USAGE = {
  visible: true, accessSource: "commercial", canEditPreferences: false, canEnableVoice: false,
  status: "plan_required", timezone: "America/New_York",
  preferences: { mode: "text", textFallbackEnabled: false, revision: 2 },
  usage: { kind: "monthly", periodState: "current", includedSeconds: 6000, usedSeconds: 1200, heldSeconds: 0,
    availableSeconds: 4800, resetsAt: "2026-10-01T00:00:00Z", reconciling: false },
};

describe("Billing voice integration", () => {
  it("shows separate voice usage and history without opening Full Suite purchases", async () => {
    setDirectActiveChatOnlyBilling();
    mocks.getOwnerVoiceSettings.mockResolvedValue(VOICE_USAGE);
    const html = renderToStaticMarkup(await BillingPage({}));
    expect(mocks.getOwnerVoiceSettings).toHaveBeenCalledWith("business-1");
    expect(html).toContain("Voice usage");
    expect(html).toContain("AI reply usage");
    expect(html).toContain("100");
    expect(html).toContain("current plan does not include voice");
    expect(html).toContain('href="/conversations"');
    expect(html).not.toContain("Save call settings");
  });
  it("hides ordinary closed rollout and survives a failed optional voice lookup", async () => {
    setDirectActiveChatOnlyBilling();
    mocks.getOwnerVoiceSettings.mockResolvedValue({ ...VOICE_USAGE, visible: false });
    expect(renderToStaticMarkup(await BillingPage({}))).not.toContain("Voice usage");
    mocks.getOwnerVoiceSettings.mockRejectedValue(new Error("schema temporarily unavailable"));
    const html = renderToStaticMarkup(await BillingPage({}));
    expect(html).toContain("Billing");
    expect(html).not.toContain("Voice usage");
  });
  it("keeps the pilot lifetime budget separate from monthly billing", async () => {
    setDirectActiveChatOnlyBilling();
    mocks.getOwnerVoiceSettings.mockResolvedValue({ ...VOICE_USAGE, accessSource: "pilot", status: "ready",
      usage: { ...VOICE_USAGE.usage, kind: "pilot_lifetime", includedSeconds: 12000, resetsAt: null } });
    const html = renderToStaticMarkup(await BillingPage({}));
    expect(html).toContain("Private pilot · lifetime minutes");
    expect(html).toContain("does not reset each month");
    expect(html).not.toContain("Voice minutes this billing period");
  });
});
