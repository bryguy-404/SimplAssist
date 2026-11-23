import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ workspace: vi.fn(), allowed: vi.fn(), entitlements: vi.fn(), rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({ requireFreshWorkspaceRouteAccess: m.workspace }));
vi.mock("@/lib/billing/entitlements", () => ({ canUseFeature: m.allowed, resolveBusinessEntitlements: m.entitlements }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { rpc: m.rpc } }));
import { PATCH } from "./route";
const id = "00000000-0000-4000-8000-000000000001";
const req = (body: unknown = { decision: "spam", revision: 0 }) => new NextRequest(`http://localhost/api/conversations/${id}/spam`, { method: "PATCH", body: JSON.stringify(body) });
beforeEach(() => { vi.resetAllMocks(); m.workspace.mockResolvedValue({ ok: true, access: { business: { id: "business" }, user: { id: "owner" } } }); m.allowed.mockReturnValue(true); m.entitlements.mockResolvedValue({}); m.rpc.mockResolvedValue({ data: { id, spamState: "spam", revision: 1 }, error: null }); });
describe("per-call review API", () => {
  it("passes only the owned workspace and reviewed call version to the atomic mutation", async () => {
    expect((await PATCH(req({ decision: "not_spam", revision: 2, businessId: "foreign" }), { params: { id } })).status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("review_inbox_call_spam", { p_business: "business", p_owner: "owner", p_conversation: id, p_decision: "not_spam", p_revision: 2 });
  });
  it("refuses inactive workspace and unentitled mutations before privileged reads", async () => {
    m.allowed.mockReturnValue(false);
    expect((await PATCH(req(), { params: { id } })).status).toBe(403);
    m.workspace.mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 403 }) });
    expect((await PATCH(req(), { params: { id } })).status).toBe(403);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it.each(["screening_revision_conflict", "screening_call_active", "screening_call_not_found"])("reports review conflict %s without success", async message => {
    m.rpc.mockResolvedValue({ error: { message } });
    expect((await PATCH(req(), { params: { id } })).status).toBe(409);
  });
  it("rejects phone-wide or incomplete decisions", async () => {
    for (const body of [{ decision: "trust_number", revision: 0 }, { decision: "spam" }, { decision: "spam", revision: -1 }]) expect((await PATCH(req(body), { params: { id } })).status).toBe(400);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
