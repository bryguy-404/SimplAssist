import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), load: vi.fn() }));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({ requireFreshWorkspaceRouteAccess: mocks.access }));
vi.mock("@/lib/voice/callReview.server", () => ({ loadVoiceCallReview: mocks.load }));
import { GET } from "./route";
const request = new NextRequest("https://simplassist.com/api/conversations/call/voice");
beforeEach(() => { vi.clearAllMocks(); mocks.access.mockResolvedValue({ ok: true, access: { business: { id: "current-business" } } }); });
describe("owner call review route", () => {
  it.each([401, 403, 503])("preserves fresh workspace denial %s without history reads", async (status) => {
    mocks.access.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "access" }, { status }) });
    expect((await GET(request, { params: { id: "call" } })).status).toBe(status);
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("uses the authorized business and returns a private uncached projection", async () => {
    mocks.load.mockResolvedValue({ conversationId: "call", actions: [] });
    const response = await GET(request, { params: { id: "call" } });
    expect(mocks.load).toHaveBeenCalledWith("current-business", "call");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ call: { conversationId: "call", actions: [] } });
  });
  it("does not reveal whether another business owns a call", async () => {
    mocks.load.mockResolvedValue(null);
    expect((await GET(request, { params: { id: "foreign-call" } })).status).toBe(404);
  });
  it("hides internal lookup errors and offers a retry", async () => {
    mocks.load.mockRejectedValue(new Error("secret provider data"));
    const response = await GET(request, { params: { id: "call" } });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret");
  });
});
