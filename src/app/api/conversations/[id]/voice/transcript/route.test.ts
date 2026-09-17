import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), load: vi.fn() }));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({ requireFreshWorkspaceRouteAccess: mocks.access }));
vi.mock("@/lib/voice/callTranscript.server", () => ({ loadVoiceCallTranscript: mocks.load }));
import { GET } from "./route";

const request = new NextRequest("https://simplassist.com/api/conversations/voice/voice/transcript?business_id=foreign");
beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue({ ok: true, access: { business: { id: "current-business" } } });
});

describe("owner transcript route", () => {
  it.each([401, 403, 503])("honors fresh unauthenticated, removed-owner and unavailable-workspace denial (%s)", async (status) => {
    mocks.access.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "access" }, { status }) });
    expect((await GET(request, { params: { id: "voice" } })).status).toBe(status);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("uses the current workspace, ignores caller-supplied business and returns explicit private data", async () => {
    const transcript = { conversationId: "voice", callInProgress: false, turns: [], truncated: false };
    mocks.load.mockResolvedValue(transcript);
    const response = await GET(request, { params: { id: "voice" } });
    expect(mocks.access).toHaveBeenCalledOnce();
    expect(mocks.load).toHaveBeenCalledWith("current-business", "voice");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(await response.json()).toEqual({ transcript });
  });

  it("does not reveal whether a missing or other-business voice conversation exists", async () => {
    mocks.load.mockResolvedValue(null);
    const response = await GET(request, { params: { id: "foreign" } });
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ error: "Call not found" });
  });

  it("reports retryable read failure without leaking fragments or provider details", async () => {
    mocks.load.mockRejectedValue(new Error("private caller and provider data"));
    const response = await GET(request, { params: { id: "voice" } });
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ error: "Call transcript is temporarily unavailable", retryable: true });
  });
});
