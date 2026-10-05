import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), state: vi.fn(), prepare: vi.fn(), move: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({ requireFreshWorkspaceRouteAccess: mocks.access }));
vi.mock("@/lib/billing/reviewTextingProvider.server", () => ({ getReviewTextingProviderState: mocks.state, prepareReviewTextingProvider: mocks.prepare, moveReviewTextingProvider: mocks.move, refreshReviewTextingProvider: mocks.refresh }));
import { GET, POST } from "./route";
import { TextingUpgradeError } from "@/lib/billing/textingUpgrade";
const post = (value: unknown) => POST(new NextRequest("http://localhost/api/billing/texting-upgrade/review-provider", { method: "POST", body: JSON.stringify(value) }));
beforeEach(() => { vi.clearAllMocks(); mocks.access.mockResolvedValue({ ok: true, access: { business: { id: "owned-business" }, user: { id: "owner" } } }); mocks.state.mockResolvedValue({ stage: "not_started", canPrepare: true }); });
describe("review-texting provider routes", () => {
  it("GET only reads owner-scoped status and does not submit or move anything", async () => {
    const response = await GET(); expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.state).toHaveBeenCalledWith("owned-business", "owner"); expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.move).not.toHaveBeenCalled(); expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("checks workspace access before reads and provider work", async () => {
    mocks.access.mockResolvedValue({ ok: false, response: Response.json({}, { status: 403 }) });
    expect((await GET()).status).toBe(403); expect((await post({ action: "prepare", acknowledge: true })).status).toBe(403); expect(mocks.state).not.toHaveBeenCalled(); expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it.each([{ action: "prepare" }, { action: "move" }, { action: "prepare", acknowledge: false }, { action: "prepare", acknowledge: true, businessId: "other" }, { action: "move", acknowledge: true, campaignId: "other" }, { action: "refresh", acknowledge: true }, { action: "purchase" }])("rejects missing acknowledgement and unsafe extra fields", async input => {
    expect((await post(input)).status).toBe(400); expect(mocks.prepare).not.toHaveBeenCalled(); expect(mocks.move).not.toHaveBeenCalled(); expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it.each(["prepare", "move", "refresh"] as const)("%s uses only authenticated identity and returns the next status", async action => {
    const response = await post(action === "refresh" ? { action } : { action, acknowledge: true });
    expect(response.status).toBe(200); expect(mocks[action]).toHaveBeenCalledExactlyOnceWith("owned-business", "owner"); expect(mocks.state).toHaveBeenCalledWith("owned-business", "owner");
  });
  it("reports a pending/unsafe provider state without starting another operation", async () => {
    mocks.prepare.mockRejectedValueOnce(new TextingUpgradeError("review_upgrade_source_changed", 409));
    const response = await post({ action: "prepare", acknowledge: true });
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "review_upgrade_source_changed" }); expect(mocks.move).not.toHaveBeenCalled(); expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
