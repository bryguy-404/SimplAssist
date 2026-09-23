import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn(),
  getWorkspaceAccess: vi.fn(),
  workspacePageRedirectTarget: vi.fn(),
  createClient: vi.fn(),
  getUser: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  single: vi.fn(),
  getOnboardingStateForOwner: vi.fn(),
  resolveBusinessEntitlements: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/billing/entitlements", () => ({ resolveBusinessEntitlements: mocks.resolveBusinessEntitlements }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/customer/workspaceAccess.server", () => ({
  getWorkspaceAccess: mocks.getWorkspaceAccess,
}));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({
  workspacePageRedirectTarget: mocks.workspacePageRedirectTarget,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));
vi.mock("@/lib/onboarding/state", () => ({
  getOnboardingStateForOwner: mocks.getOnboardingStateForOwner,
}));
vi.mock("@/components/onboarding/OnboardingSignOut", () => ({
  default: () => <span>Sign out</span>,
}));
vi.mock("@/components/onboarding/OnboardingDeleteAccount", () => ({
  default: () => <span>Delete account</span>,
}));
vi.mock("@/lib/theme-v2/ui", () => ({ ThemeToggleV2: () => null }));

import OnboardingLayout from "./layout";

const USER = { id: "user-1", email: "owner@example.com" };
const BUSINESS = {
  id: "business-1",
  partner_id: null,
  deleted_at: null,
  operations_suspended_at: null,
  ai_replies_paused_at: null,
  texting_paused_at: null,
  bookings_paused_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveBusinessEntitlements.mockResolvedValue({ active: true, plan: "chat_only" });
  mocks.redirect.mockImplementation((path: string) => {
    throw new Error(`redirect:${path}`);
  });
  mocks.getWorkspaceAccess.mockResolvedValue({
    status: "resolved",
    user: USER,
    business: {
      id: BUSINESS.id,
      partner_id: null,
      billing_mode: "stripe",
    },
    hostKind: "canonical",
  });
  mocks.workspacePageRedirectTarget.mockReturnValue(null);
  mocks.getUser.mockResolvedValue({ data: { user: USER } });
  const businessQuery = {
    select: mocks.select,
    eq: mocks.eq,
    single: mocks.single,
  };
  mocks.select.mockReturnValue(businessQuery);
  mocks.eq.mockReturnValue(businessQuery);
  mocks.single.mockResolvedValue({ data: BUSINESS, error: null });
  mocks.from.mockReturnValue(businessQuery);
  mocks.createClient.mockResolvedValue({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
  });
  mocks.getOnboardingStateForOwner.mockResolvedValue({ dashboardReady: false });
});

describe("OnboardingLayout workspace access", () => {
  it("returns paid pending upgrades to Add Texting without syncing initial onboarding", async () => {
    mocks.single.mockResolvedValue({ data: { ...BUSINESS, onboarding_completed_at: "2026-09-01T00:00:00Z" }, error: null });
    mocks.resolveBusinessEntitlements.mockResolvedValue({ active: true, plan: "chat_only", textingUpgradePending: true });
    await expect(OnboardingLayout({ children: <main>Setup</main> })).rejects.toThrow("redirect:/billing/add-texting");
    expect(mocks.getOnboardingStateForOwner).not.toHaveBeenCalled();
  });
  it("renders incomplete onboarding only after the shared workspace decision resolves", async () => {
    const layout = await OnboardingLayout({
      children: <main>Onboarding</main>,
    });
    const html = renderToStaticMarkup(layout);

    expect(mocks.getWorkspaceAccess).toHaveBeenCalledOnce();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.getUser).toHaveBeenCalledOnce();
    expect(mocks.getOnboardingStateForOwner).toHaveBeenCalledWith(USER.id);
    expect(html).toContain("Delete account");
    expect(html).toContain("Sign out");
    const projection = mocks.select.mock.calls[0]?.[0] as string;
    expect(projection).toContain("operations_suspended_at");
    expect(projection).toContain("ai_replies_paused_at");
    expect(projection).toContain("texting_paused_at");
    expect(projection).toContain("bookings_paused_at");
  });

  it("redirects a completed onboarding account to the dashboard instead of rendering the wizard", async () => {
    mocks.getOnboardingStateForOwner.mockResolvedValue({
      dashboardReady: true,
    });

    await expect(
      OnboardingLayout({ children: <main>Onboarding wizard</main> }),
    ).rejects.toThrow("redirect:/dashboard");

    expect(mocks.getOnboardingStateForOwner).toHaveBeenCalledWith(USER.id);
    expect(mocks.redirect).toHaveBeenCalledWith("/dashboard");
  });

  it("renders deletion on an exact resolved partner workspace", async () => {
    mocks.getWorkspaceAccess.mockResolvedValue({
      status: "resolved",
      user: USER,
      business: {
        id: BUSINESS.id,
        partner_id: "partner-1",
        billing_mode: "invoiced",
      },
      hostKind: "partner",
    });

    const layout = await OnboardingLayout({
      children: <main>Partner onboarding</main>,
    });

    expect(renderToStaticMarkup(layout)).toContain("Delete account");
  });

  it("redirects a scheduled onboarding account before rendering controls", async () => {
    mocks.single.mockResolvedValue({
      data: {
        ...BUSINESS,
        deleted_at: "2026-08-03T16:00:00.000Z",
        operations_suspended_at: "2026-08-03T15:00:00.000Z",
      },
      error: null,
    });

    await expect(
      OnboardingLayout({ children: <main>Onboarding</main> }),
    ).rejects.toThrow("redirect:/account-deleted");
    expect(mocks.getOnboardingStateForOwner).not.toHaveBeenCalled();
  });

  it("keeps suspended mid-onboarding configuration accessible and places the notice above the card", async () => {
    mocks.single.mockResolvedValue({
      data: {
        ...BUSINESS,
        operations_suspended_at: "2026-08-04T12:00:00.000Z",
        bookings_paused_at: "2026-08-04T12:01:00.000Z",
      },
      error: null,
    });
    mocks.getOnboardingStateForOwner.mockResolvedValue({
      dashboardReady: false,
    });

    const layout = await OnboardingLayout({
      children: <main>Business configuration</main>,
    });
    const html = renderToStaticMarkup(layout);

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(html).toContain("Delete account");
    expect(html).toContain("Account services are suspended");
    expect(html).toContain(
      "After reactivation, bookings will remain paused",
    );
    expect(html.indexOf("Delete account")).toBeLessThan(
      html.indexOf("Account services are suspended"),
    );
    expect(html.indexOf("Account services are suspended")).toBeLessThan(
      html.indexOf("Business configuration"),
    );
  });

  it("redirects unauthenticated users before onboarding reads", async () => {
    mocks.getWorkspaceAccess.mockResolvedValue({ status: "unauthenticated" });
    mocks.workspacePageRedirectTarget.mockReturnValue("/login");

    await expect(
      OnboardingLayout({ children: <main>Onboarding</main> }),
    ).rejects.toThrow("redirect:/login");

    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.getOnboardingStateForOwner).not.toHaveBeenCalled();
  });

  it.each([
    "business_not_found",
    "mismatch",
    "unknown_host",
    "partner_unavailable",
    "lookup_failed",
  ])("redirects %s decisions before onboarding reads", async (status) => {
    mocks.getWorkspaceAccess.mockResolvedValue({ status });
    mocks.workspacePageRedirectTarget.mockReturnValue("/workspace-access");

    await expect(
      OnboardingLayout({ children: <main>Onboarding</main> }),
    ).rejects.toThrow("redirect:/workspace-access");

    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.getOnboardingStateForOwner).not.toHaveBeenCalled();
  });
});
