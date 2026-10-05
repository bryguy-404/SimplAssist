import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), prompt: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({ requireFreshWorkspaceRouteAccess: mocks.access }));
vi.mock("@/lib/dashboard/upgradePrompt.server", () => ({ getDashboardUpgradePrompt: mocks.prompt }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
import { GET, POST } from "./route";
const body = { offerKey: "review_texting", action: "snooze", expectedRevision: 0 };
const post = (value: unknown = body) => POST(new Request("http://localhost/api/dashboard/upgrade-prompt", { method: "POST", body: JSON.stringify(value) }));
beforeEach(() => {
  vi.clearAllMocks(); mocks.access.mockResolvedValue({ ok: true, access: { user: { id: "owner" }, business: { id: "business" } } });
  mocks.prompt.mockResolvedValue({ kind: "offer", offerKey: "review_texting", revision: 0 }); mocks.rpc.mockResolvedValue({ error: null });
});
describe("upgrade prompt route", () => {
  it("GET is read-only and never caches tenant-specific suggestions", async () => {
    const response = await GET(); expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.prompt).toHaveBeenCalledWith("business", "owner"); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("requires workspace access for both reads and writes", async () => {
    mocks.access.mockResolvedValue({ ok: false, response: Response.json({}, { status: 403 }) });
    expect((await GET()).status).toBe(403); expect((await post()).status).toBe(403); expect(mocks.prompt).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("saves only the authenticated business with the observed revision", async () => {
    expect((await post()).status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("save_dashboard_upgrade_preference", { p_business_id: "business", p_owner_id: "owner", p_offer_key: "review_texting", p_action: "snooze", p_expected_revision: 0 });
  });
  it.each([{ ...body, businessId: "other" }, { ...body, action: "purchase" }, { ...body, offerKey: "unsupported" }, { ...body, expectedRevision: -1 }, { ...body, expectedRevision: 0.5 }])("rejects invalid or tenant-supplied input", async value => {
    expect((await post(value)).status).toBe(400); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([null, { kind: "progress", offerKey: "review_texting", revision: 0 }, { kind: "offer", offerKey: "growth", revision: 0 }, { kind: "offer", offerKey: "review_texting", revision: 1 }])("does not dismiss a stale or ineligible suggestion", async value => {
    mocks.prompt.mockResolvedValue(value); expect((await post()).status).toBe(409); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not treat an uncertain write as saved", async () => {
    mocks.rpc.mockResolvedValue({ error: { code: "XX000" } }); expect((await post()).status).toBe(503);
    mocks.rpc.mockResolvedValue({ error: { code: "40001" } }); expect((await post()).status).toBe(409);
  });
});
