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
  it.each([403, 503])("preserves a wrong-host/removed-owner or indeterminate workspace rejection (%s)", async (status) => {
    mocks.workspace.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "workspace_access_denied" }, { status }) });
    expect((await GET(request(), { params: { id: "recording" } })).status).toBe(status);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.proxy).not.toHaveBeenCalled();
  });
  it.each([false, true])("serves an unexpired recording to the authorized owner or staff (admin=%s)", async (admin) => {
    mocks.admin.mockResolvedValue(admin ? { id: "staff" } : null);
    mocks.workspace.mockResolvedValue({ ok: true, access: { business: { id: "business" } } });
    const recording = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: { recording_id: "recording", session_id: "call", business_id: "business", delete_after: "2099-01-01", deleted_at: null }, error: null }) };
    recording.select.mockReturnValue(recording); recording.eq.mockReturnValue(recording);
    const session = { select: vi.fn(), eq: vi.fn(), single: vi.fn().mockResolvedValue({ data: { call_control_id: "control", call_session_id: "provider-session" }, error: null }) };
    session.select.mockReturnValue(session); session.eq.mockReturnValue(session);
    mocks.from.mockReturnValueOnce(recording).mockReturnValueOnce(session);
    mocks.proxy.mockResolvedValue(new Response("audio", { status: 200 }));
    expect((await GET(request(), { params: { id: "recording" } })).status).toBe(200);
    expect(session.eq).toHaveBeenCalledWith("business_id", "business");
    if (admin) expect(mocks.workspace).not.toHaveBeenCalled();
    else expect(recording.eq).toHaveBeenCalledWith("business_id", "business");
  });
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
