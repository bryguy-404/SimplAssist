import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), context: vi.fn(), enabled: vi.fn(), smsEnabled: vi.fn(), workspace: vi.fn(() => null), notFound: vi.fn(), redirect: vi.fn() }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({ requireWorkspacePageAccess: mocks.access }));
vi.mock("@/lib/dashboard/context", () => ({ getDashboardBusinessContext: mocks.context }));
vi.mock("@/lib/reviews/config", () => ({ isEmailReviewsEnabledForBusiness: mocks.enabled }));
vi.mock("@/lib/billing/reviewSmsRollout.server", () => ({ isReviewSmsEnabled: mocks.smsEnabled }));
vi.mock("@/components/reviews/ReviewsWorkspace", () => ({ default: mocks.workspace }));
import ReviewsPage from "./page";
beforeEach(() => { vi.clearAllMocks(); mocks.access.mockResolvedValue(undefined); mocks.enabled.mockReturnValue(true); mocks.smsEnabled.mockReturnValue(false); mocks.context.mockResolvedValue({ status: "resolved", business: { id: "business" }, user: { email: "owner@example.com" } }); mocks.notFound.mockImplementation(() => { throw new Error("not-found"); }); mocks.redirect.mockImplementation((path) => { throw new Error(path); }); });
describe("reviews page access", () => {
  it("does not expose the workspace when the business review gate is off", async () => {
    mocks.enabled.mockReturnValue(false);
    await expect(ReviewsPage({})).rejects.toThrow("not-found");
    expect(mocks.access).toHaveBeenCalledOnce(); expect(mocks.workspace).not.toHaveBeenCalled();
  });
  it("preserves a customer deep link without accepting a query-supplied business", async () => {
    renderToStaticMarkup(await ReviewsPage({ searchParams: { customer: "customer-id" } }));
    expect(mocks.enabled).toHaveBeenCalledWith("business");
    expect(mocks.workspace).toHaveBeenCalledWith(expect.objectContaining({ ownerEmail: "owner@example.com", initialCustomerId: "customer-id", smsEnabled: false }), expect.anything());
  });
  it("applies workspace access before reading business review settings", async () => {
    mocks.access.mockRejectedValue(new Error("workspace denied"));
    await expect(ReviewsPage({})).rejects.toThrow("workspace denied");
    expect(mocks.context).not.toHaveBeenCalled();
  });
});
