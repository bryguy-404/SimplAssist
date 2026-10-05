import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ admin: vi.fn(), inspect: vi.fn(), approve: vi.fn(), revoke: vi.fn() }));
vi.mock("@/lib/admin/auth", () => ({ getAdminUser: m.admin }));
vi.mock("@/lib/messaging/sharedBusinessRegistrations.server", () => ({
  inspectSharedRegistration: m.inspect, approveSharedRegistration: m.approve, revokeSharedRegistration: m.revoke,
  SharedRegistrationError: class extends Error {},
}));
import { GET, POST } from "./route";
const input = { sourceBusinessId: "10000000-0000-4000-8000-000000000116", targetBusinessId: "20000000-0000-4000-8000-000000000116", sourceOwnerId: "30000000-0000-4000-8000-000000000116", targetOwnerId: "40000000-0000-4000-8000-000000000116" };
beforeEach(() => { vi.clearAllMocks(); m.admin.mockResolvedValue({ id: "actual-admin" }); m.inspect.mockResolvedValue({ membershipRevision: 0 }); m.approve.mockResolvedValue({ membershipRevision: 1 }); });
describe("shared-registration administrative boundary", () => {
  it("authenticates before parsing or accessing provider/account data", async () => {
    m.admin.mockResolvedValue(null);
    expect((await POST(new NextRequest("https://admin.example/api", { method: "POST", body: "invalid" }))).status).toBe(404);
    expect(m.inspect).not.toHaveBeenCalled(); expect(m.approve).not.toHaveBeenCalled();
  });
  it("GET only inspects and never initializes memberships", async () => {
    const response = await GET(new NextRequest(`https://admin.example/api?${new URLSearchParams(input)}`));
    expect(response.status).toBe(200); expect(m.inspect).toHaveBeenCalledWith(input); expect(m.approve).not.toHaveBeenCalled();
  });
  it("requires exact owners and a revision for approval, using the authenticated actor", async () => {
    const send = (body: unknown) => POST(new NextRequest("https://admin.example/api", { method: "POST", body: JSON.stringify(body) }));
    expect((await send({ ...input, action: "approve" })).status).toBe(400);
    expect((await send({ ...input, action: "approve", expectedRevision: 0, actorId: "forged" })).status).toBe(400);
    expect((await send({ ...input, action: "approve", expectedRevision: 0 })).status).toBe(200);
    expect(m.approve).toHaveBeenCalledWith({ ...input, action: "approve", expectedRevision: 0, actorId: "actual-admin" });
  });
  it("never leaks unexpected provider exceptions", async () => {
    m.inspect.mockRejectedValue(new Error("private address and EIN"));
    const response = await GET(new NextRequest(`https://admin.example/api?${new URLSearchParams(input)}`));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("private address");
  });
});
