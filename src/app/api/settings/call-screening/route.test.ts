import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ workspace: vi.fn(), get: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({ requireFreshWorkspaceRouteAccess: m.workspace }));
vi.mock("@/lib/call-screening/settings.server", () => ({ getCallScreeningSettings: m.get, updateCallScreening: m.update }));
import { GET, PATCH } from "./route";
beforeEach(() => { vi.resetAllMocks(); m.workspace.mockResolvedValue({ ok: true, access: { business: { id: "owned-business" }, user: { id: "current-owner" } } }); m.get.mockResolvedValue({ available: true, confirmedMode: "unknown" }); m.update.mockResolvedValue({ syncStatus: "pending", confirmedMode: "disabled" }); });
const req = (body: unknown) => new NextRequest("http://localhost/api/settings/call-screening", { method: "PATCH", body: JSON.stringify(body) });
describe("call-screening settings API", () => {
  it("requires fresh workspace access before provider reads or writes", async () => {
    m.workspace.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "denied" }, { status: 403 }) });
    expect((await GET(req({}))).status).toBe(403);
    expect((await PATCH(req({ mode: "flag_calls", revision: 0 }))).status).toBe(403);
    expect(m.get).not.toHaveBeenCalled(); expect(m.update).not.toHaveBeenCalled();
  });
  it("ignores caller-supplied tenant identities and keeps unconfirmed updates pending", async () => {
    const res = await PATCH(req({ mode: "flag_calls", revision: 4, businessId: "foreign", ownerId: "foreign" }));
    expect(m.update).toHaveBeenCalledWith("owned-business", "current-owner", "flag_calls", 4);
    expect(await res.json()).toMatchObject({ syncStatus: "pending", confirmedMode: "disabled" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
  it.each([{ mode: "reject_calls", revision: 0 }, { mode: "flag_calls" }, { mode: "disabled", revision: -1 }])("rejects invalid provider intent %j", async body => {
    expect((await PATCH(req(body))).status).toBe(400); expect(m.update).not.toHaveBeenCalled();
  });
  it("distinguishes stale writes from temporary provider failures", async () => {
    m.update.mockRejectedValueOnce(new Error("screening_revision_conflict")).mockRejectedValueOnce(new Error("timeout"));
    expect((await PATCH(req({ mode: "disabled", revision: 1 }))).status).toBe(409);
    expect((await PATCH(req({ mode: "disabled", revision: 1 }))).status).toBe(503);
  });
  it("refreshes verified carrier state only for the owner", async () => {
    await GET(new NextRequest("http://localhost/api/settings/call-screening?refresh=1&businessId=foreign"));
    expect(m.get).toHaveBeenCalledWith("owned-business", "current-owner", true);
  });
});
