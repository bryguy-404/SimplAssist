import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  workspace: vi.fn(),
  from: vi.fn(),
  proxy: vi.fn(),
}));
vi.mock("@/lib/admin/auth", () => ({ getAdminUser: mocks.admin }));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({
  requireFreshWorkspaceRouteAccess: mocks.workspace,
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mocks.from },
}));
vi.mock("@/lib/messaging/client", () => ({ telnyx: {} }));
vi.mock("@/lib/voice/recording", () => ({ proxyVoiceRecording: mocks.proxy }));
import { GET } from "./route";
const request = () =>
  new NextRequest("https://simplassist.com/api/voice/recordings/recording");
beforeEach(() => {
  vi.clearAllMocks();
  mocks.admin.mockResolvedValue(null);
});
describe("recording account access", () => {
  it("requires sign-in before reading a recording ID", async () => {
    mocks.workspace.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Sign in" }, { status: 401 }),
    });
    expect((await GET(request(), { params: { id: "recording" } })).status).toBe(
      401,
    );
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it("scopes customer lookups to their current business", async () => {
    mocks.workspace.mockResolvedValue({
      ok: true,
      access: { business: { id: "current-business" } },
    });
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    mocks.from.mockReturnValue(query);
    expect(
      (await GET(request(), { params: { id: "other-business-recording" } }))
        .status,
    ).toBe(404);
    expect(query.eq).toHaveBeenCalledWith("business_id", "current-business");
    expect(mocks.proxy).not.toHaveBeenCalled();
  });
  it("denies expired audio even while provider deletion is retrying", async () => {
    mocks.admin.mockResolvedValue({ id: "admin" });
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: {
          recording_id: "recording",
          delete_after: "2020-01-01",
          deleted_at: null,
        },
        error: null,
      }),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    mocks.from.mockReturnValue(query);
    expect((await GET(request(), { params: { id: "recording" } })).status).toBe(
      404,
    );
    expect(mocks.proxy).not.toHaveBeenCalled();
  });
});
