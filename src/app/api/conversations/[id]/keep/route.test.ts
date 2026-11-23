import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ workspace: vi.fn(), allowed: vi.fn(), entitlements: vi.fn(), rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({ requireFreshWorkspaceRouteAccess: m.workspace }));
vi.mock("@/lib/billing/entitlements", () => ({ canUseFeature: m.allowed, resolveBusinessEntitlements: m.entitlements }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { rpc: m.rpc } }));
import { PATCH } from "./route";

const id = "00000000-0000-4000-8000-000000000011";
const request = new NextRequest("https://example.test/api/conversations/" + id + "/keep", { method: "PATCH" });
beforeEach(() => {
  vi.resetAllMocks();
  m.workspace.mockResolvedValue({ ok: true, access: { business: { id: "business" }, user: { id: "owner" } } });
  m.allowed.mockReturnValue(true);
  m.rpc.mockResolvedValue({ error: null });
});
describe("Move to Inbox", () => {
  it("keeps only the selected item in the authorized workspace", async () => {
    expect((await PATCH(request, { params: { id } })).status).toBe(200);
    expect(m.rpc).toHaveBeenCalledWith("keep_inbox_conversation", { p_business: "business", p_owner: "owner", p_id: id });
  });
  it("requires a usable plan and a fresh workspace", async () => {
    m.allowed.mockReturnValue(false);
    expect((await PATCH(request, { params: { id } })).status).toBe(403);
    m.workspace.mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 401 }) });
    expect((await PATCH(request, { params: { id } })).status).toBe(401);
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it("allows a safe retry if the database is temporarily unreachable", async () => {
    m.rpc.mockRejectedValue(new Error("unavailable"));
    expect((await PATCH(request, { params: { id } })).status).toBe(503);
  });
  it("refuses malformed IDs and reports stale or screened selections", async () => {
    expect((await PATCH(request, { params: { id: "not-a-uuid" } })).status).toBe(400);
    m.rpc.mockResolvedValue({ error: { message: "conversation_selection_changed" } });
    expect((await PATCH(request, { params: { id } })).status).toBe(409);
  });
});
