import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn(),
  getDashboardBusinessContext: vi.fn(),
  getDashboardPageEntitlements: vi.fn(),
  getSmsReadinessForBusiness: vi.fn(),
  getOnboardingStateForOwnerReadOnly: vi.fn(),
  canUseFeature: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  workspacePageRedirectTarget: vi.fn(),
  sidebar: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));
vi.mock("@/lib/dashboard/context", () => ({
  getDashboardBusinessContext: mocks.getDashboardBusinessContext,
  getDashboardPageEntitlements: mocks.getDashboardPageEntitlements,
}));
vi.mock("@/lib/messaging/lookup", () => ({
  getSmsReadinessForBusiness: mocks.getSmsReadinessForBusiness,
}));
vi.mock("@/lib/onboarding/state", () => ({
  getOnboardingStateForOwnerReadOnly:
    mocks.getOnboardingStateForOwnerReadOnly,
}));
vi.mock("@/lib/billing/entitlements", () => ({
  canUseFeature: mocks.canUseFeature,
}));
vi.mock("@/lib/customer/workspaceAccess.server", () => ({
  getWorkspaceAccess: mocks.getWorkspaceAccess,
}));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({
  workspacePageRedirectTarget: mocks.workspacePageRedirectTarget,
}));
vi.mock("./_components/sidebar", () => ({
  default: (props: unknown) => {
    mocks.sidebar(props);
    return null;
  },
}));

import DashboardLayout from "./layout";

const BUSINESS = {
  id: "business-1",
  website_url: "https://example.com",
  primary_goal: "book",
  deleted_at: null,
  operations_suspended_at: null,
  ai_replies_paused_at: null,
  texting_paused_at: null,
  bookings_paused_at: null,
  partner_id: null,
  billing_mode: "stripe",
};
const ENTITLEMENTS = {
  businessId: BUSINESS.id,
  plan: "sms_and_chat",
  status: "active",
  source: "subscription",
  active: true,
  cancelAtPeriodEnd: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.redirect.mockImplementation((path: string) => {
    throw new Error(`redirect:${path}`);
  });
  mocks.getDashboardBusinessContext.mockResolvedValue({
    status: "resolved",
    supabase: {},
    user: { id: "user-1", email: "owner@example.com" },
    business: BUSINESS,
  });
  mocks.getSmsReadinessForBusiness.mockResolvedValue({ smsReady: true });
  mocks.getDashboardPageEntitlements.mockResolvedValue({
    status: "resolved",
    entitlements: ENTITLEMENTS,
  });
  mocks.getOnboardingStateForOwnerReadOnly.mockResolvedValue(null);
  mocks.canUseFeature.mockReturnValue(true);
  mocks.getWorkspaceAccess.mockResolvedValue({
    status: "resolved",
    user: { id: "user-1", email: "owner@example.com" },
    business: { id: BUSINESS.id, partner_id: null },
    hostKind: "canonical",
  });
  mocks.workspacePageRedirectTarget.mockReturnValue(null);
});

describe("DashboardLayout access gate", () => {
  it("keeps paid pending-upgrade Chat accessible without initial-onboarding or carrier reads", async () => {
    mocks.getDashboardPageEntitlements.mockResolvedValue({ status: "resolved", entitlements: {
      ...ENTITLEMENTS, plan: "chat_only", textingUpgradePending: true,
    } });
    await expect(DashboardLayout({ children: <div>Existing chat</div> })).resolves.toBeDefined();
    expect(mocks.getOnboardingStateForOwnerReadOnly).not.toHaveBeenCalled();
    expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
  });

  it("does not let pending-upgrade continuity restore inactive billing", async () => {
    mocks.getDashboardPageEntitlements.mockResolvedValue({ status: "resolved", entitlements: {
      ...ENTITLEMENTS, plan: "chat_only", active: false, textingUpgradePending: true,
    } });
    await expect(DashboardLayout({ children: <div>Existing chat</div> })).rejects.toThrow("redirect:/onboarding");
  });
  it("redirects an unauthenticated workspace before dashboard data reads", async () => {
    mocks.getWorkspaceAccess.mockResolvedValue({ status: "unauthenticated" });
    mocks.workspacePageRedirectTarget.mockReturnValue("/login");

    await expect(
      DashboardLayout({ children: <div>Dashboard child</div> })
    ).rejects.toThrow("redirect:/login");

    expect(mocks.getDashboardBusinessContext).not.toHaveBeenCalled();
    expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
  });

  it.each([
    "business_not_found",
    "mismatch",
    "unknown_host",
    "partner_unavailable",
    "lookup_failed",
  ])(
    "redirects %s workspace decisions to the blocked page before dashboard reads",
    async (status) => {
      mocks.getWorkspaceAccess.mockResolvedValue({ status });
      mocks.workspacePageRedirectTarget.mockReturnValue("/workspace-access");

      await expect(
        DashboardLayout({ children: <div>Dashboard child</div> })
      ).rejects.toThrow("redirect:/workspace-access");

      expect(mocks.getDashboardBusinessContext).not.toHaveBeenCalled();
      expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
    }
  );

  it("uses the narrow SMS readiness lookup before rendering the dashboard", async () => {
    await expect(
      DashboardLayout({ children: <div>Dashboard child</div> })
    ).resolves.toBeDefined();

    expect(mocks.getSmsReadinessForBusiness).toHaveBeenCalledOnce();
    expect(mocks.getSmsReadinessForBusiness).toHaveBeenCalledWith(BUSINESS.id);
    expect(mocks.getDashboardPageEntitlements).toHaveBeenCalledWith(BUSINESS.id);
  });

  it("redirects a direct pre-checkout business when the subscription is missing", async () => {
    mocks.getDashboardPageEntitlements.mockResolvedValue({
      status: "subscription_missing",
    });

    await expect(
      DashboardLayout({ children: <div>Dashboard child</div> }),
    ).rejects.toThrow("redirect:/onboarding");
    expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
    expect(mocks.getOnboardingStateForOwnerReadOnly).not.toHaveBeenCalled();
  });

  it.each([
    ["partner-owned Stripe", "partner-1", "stripe", true],
    ["partner-owned invoiced", "partner-1", "invoiced", true],
    ["direct Stripe", null, "stripe", false],
    ["direct invoiced", null, "invoiced", false],
  ] as const)(
    "derives Billing visibility for %s from partner ownership, not billing mode",
    async (_scenario, partnerId, billingMode, expected) => {
      mocks.getDashboardBusinessContext.mockResolvedValue({
        status: "resolved",
        supabase: {},
        user: { id: "user-1", email: "owner@example.com" },
        business: {
          ...BUSINESS,
          partner_id: partnerId,
          billing_mode: billingMode,
        },
      });

      const layout = await DashboardLayout({
        children: <div>Dashboard child</div>,
      });
      renderToStaticMarkup(layout);

      expect(mocks.sidebar).toHaveBeenCalledWith(
        expect.objectContaining({ isPartnerManagedBilling: expected }),
      );
    },
  );

  it.each(["book", "signup", "quote", "callback"] as const)(
    "passes primary_goal=%s through to the shared navigation",
    async (primaryGoal) => {
      mocks.getDashboardBusinessContext.mockResolvedValue({
        status: "resolved",
        supabase: {},
        user: { id: "user-1", email: "owner@example.com" },
        business: {
          ...BUSINESS,
          primary_goal: primaryGoal,
        },
      });

      const layout = await DashboardLayout({
        children: <div>Dashboard child</div>,
      });
      renderToStaticMarkup(layout);

      expect(mocks.sidebar).toHaveBeenCalledWith(
        expect.objectContaining({ primaryGoal }),
      );
    },
  );

  it.each(["quote", "callback"] as const)(
    "keeps primary_goal=%s dashboard markup byte-identical to book",
    async (primaryGoal) => {
      const renderForGoal = async (
        goal: "book" | "quote" | "callback",
      ) => {
        mocks.getDashboardBusinessContext.mockResolvedValueOnce({
          status: "resolved",
          supabase: {},
          user: { id: "user-1", email: "owner@example.com" },
          business: { ...BUSINESS, primary_goal: goal },
        });

        const layout = await DashboardLayout({
          children: <div>Dashboard child</div>,
        });
        return renderToStaticMarkup(layout);
      };

      const bookMarkup = await renderForGoal("book");
      const legacyMarkup = await renderForGoal(primaryGoal);

      expect(legacyMarkup).toBe(bookMarkup);
    },
  );

  it("redirects a NULL-goal business before readiness and entitlement reads", async () => {
    mocks.getDashboardBusinessContext.mockResolvedValue({
      status: "resolved",
      supabase: {},
      user: { id: "user-1", email: "owner@example.com" },
      business: { ...BUSINESS, primary_goal: null },
    });

    await expect(
      DashboardLayout({ children: <div>Dashboard child</div> })
    ).rejects.toThrow("redirect:/onboarding");

    expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
    expect(mocks.getDashboardPageEntitlements).not.toHaveBeenCalled();
    expect(mocks.sidebar).not.toHaveBeenCalled();
  });

  it("resolves plan authority before starting the SMS-only readiness path", async () => {
    const entitlements = deferred<{
      status: "resolved";
      entitlements: typeof ENTITLEMENTS;
    }>();
    mocks.getDashboardPageEntitlements.mockReturnValue(entitlements.promise);

    const layout = DashboardLayout({
      children: <div>Dashboard child</div>,
    });

    await vi.waitFor(() => {
      expect(mocks.getDashboardPageEntitlements).toHaveBeenCalledOnce();
    });
    expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();

    entitlements.resolve({ status: "resolved", entitlements: ENTITLEMENTS });
    await expect(layout).resolves.toBeDefined();
    expect(mocks.getSmsReadinessForBusiness).toHaveBeenCalledOnce();
  });

  it("redirects when SMS is not ready after resolving the parallel access checks", async () => {
    mocks.getSmsReadinessForBusiness.mockResolvedValue({ smsReady: false });

    await expect(
      DashboardLayout({ children: <div>Dashboard child</div> })
    ).rejects.toThrow("redirect:/onboarding");
    expect(mocks.getDashboardPageEntitlements).toHaveBeenCalledWith(BUSINESS.id);
  });

  it.each(["subscription", "partner_plan"] as const)(
    "unlocks completed Chat Only from authoritative %s without an SMS readiness read",
    async (source) => {
      mocks.getDashboardPageEntitlements.mockResolvedValue({
        status: "resolved",
        entitlements: {
          ...ENTITLEMENTS,
          plan: "chat_only",
          source,
        },
      });
      mocks.getOnboardingStateForOwnerReadOnly.mockResolvedValue({
        dashboardReady: true,
        completedAt: "2026-08-18T12:00:00.000Z",
        planSelection: {
          effectivePlan: "chat_only",
          source,
        },
      });

      await expect(
        DashboardLayout({ children: <div>Dashboard child</div> }),
      ).resolves.toBeDefined();

      expect(mocks.getOnboardingStateForOwnerReadOnly).toHaveBeenCalledWith(
        "user-1",
      );
      expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
    },
  );

  it("keeps previously completed Chat Only accessible during past-due recovery", async () => {
    mocks.getDashboardPageEntitlements.mockResolvedValue({
      status: "resolved",
      entitlements: {
        ...ENTITLEMENTS,
        plan: "chat_only",
        status: "past_due",
        source: "subscription",
        active: true,
      },
    });
    mocks.getOnboardingStateForOwnerReadOnly.mockResolvedValue({
      dashboardReady: true,
      completedAt: "2026-08-18T12:00:00.000Z",
      planSelection: {
        effectivePlan: "chat_only",
        source: "subscription",
      },
    });

    await expect(
      DashboardLayout({ children: <div>Dashboard child</div> }),
    ).resolves.toBeDefined();
    expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "owner intent",
      completedAt: "2026-08-18T12:00:00.000Z",
      dashboardReady: true,
      source: "direct_intent",
    },
    {
      name: "missing durable completion",
      completedAt: null,
      dashboardReady: true,
      source: "subscription",
    },
    {
      name: "past-due/unfinalized state",
      completedAt: "2026-08-18T12:00:00.000Z",
      dashboardReady: false,
      source: "subscription",
    },
  ] as const)(
    "rejects Chat Only from $name without touching SMS lifecycle",
    async ({ completedAt, dashboardReady, source }) => {
      mocks.getDashboardPageEntitlements.mockResolvedValue({
        status: "resolved",
        entitlements: {
          ...ENTITLEMENTS,
          plan: "chat_only",
          active: true,
        },
      });
      mocks.getOnboardingStateForOwnerReadOnly.mockResolvedValue({
        dashboardReady,
        completedAt,
        planSelection: {
          effectivePlan: "chat_only",
          source,
        },
      });

      await expect(
        DashboardLayout({ children: <div>Dashboard child</div> }),
      ).rejects.toThrow("redirect:/onboarding");
      expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
    },
  );

  it("keeps a suspended, SMS-ready account on the dashboard and renders the notice before its children", async () => {
    mocks.getDashboardBusinessContext.mockResolvedValue({
      status: "resolved",
      supabase: {},
      user: { id: "user-1", email: "owner@example.com" },
      business: {
        ...BUSINESS,
        operations_suspended_at: "2026-08-04T12:00:00.000Z",
        texting_paused_at: "2026-08-04T12:01:00.000Z",
      },
    });

    const layout = await DashboardLayout({
      children: <div>Dashboard child</div>,
    });
    const html = renderToStaticMarkup(layout);

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.getSmsReadinessForBusiness).toHaveBeenCalledWith(BUSINESS.id);
    expect(html).toContain("Account services are suspended");
    expect(html).toContain(
      "After reactivation, texting will remain paused",
    );
    expect(html.indexOf("Account services are suspended")).toBeLessThan(
      html.indexOf("Dashboard child"),
    );
  });

  it("renders independent pause state without changing the readiness decision", async () => {
    mocks.getDashboardBusinessContext.mockResolvedValue({
      status: "resolved",
      supabase: {},
      user: { id: "user-1", email: "owner@example.com" },
      business: {
        ...BUSINESS,
        ai_replies_paused_at: "2026-08-04T12:00:00.000Z",
      },
    });

    const layout = await DashboardLayout({
      children: <div>Dashboard child</div>,
    });
    const html = renderToStaticMarkup(layout);

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(html).toContain("Some account services are paused");
    expect(html).toContain("AI replies");
  });

  it("redirects deleted businesses before the readiness lookup", async () => {
    mocks.getDashboardBusinessContext.mockResolvedValue({
      status: "resolved",
      supabase: {},
      user: { id: "user-1", email: "owner@example.com" },
      business: {
        ...BUSINESS,
        primary_goal: null,
        deleted_at: "2026-07-28T00:00:00.000Z",
      },
    });

    await expect(
      DashboardLayout({ children: <div>Dashboard child</div> })
    ).rejects.toThrow("redirect:/account-deleted");
    expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
    expect(mocks.getDashboardPageEntitlements).not.toHaveBeenCalled();
  });
});
