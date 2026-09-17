vi.mock('server-only', () => ({}));
import { afterEach, describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({
  context: vi.fn(),
  decision: vi.fn(),
  rpc: vi.fn(),
}));
vi.mock("@/lib/voice/actionService.server", () => ({
  loadVoiceActionContext: m.context,
  runVoiceDecision: m.decision,
}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { rpc: m.rpc } }));
import { POST } from "./route";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("voice action internal boundary", () => {
  it("hides unauthenticated endpoint", async () => {
    vi.stubEnv("VOICE_INTERNAL_TOKEN", "x".repeat(32));
    const r = await POST(
      new NextRequest("https://simplassist.com/api/internal/voice/actions", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(r.status).toBe(404);
    expect(m.context).not.toHaveBeenCalled();
    expect(m.decision).not.toHaveBeenCalled();
  });
  it("rejects model-supplied business overrides", async () => {
    vi.stubEnv("VOICE_INTERNAL_TOKEN", "x".repeat(32));
    const r = await POST(
      new NextRequest("https://simplassist.com/api/internal/voice/actions", {
        method: "POST",
        headers: { authorization: `Bearer ${"x".repeat(32)}` },
        body: JSON.stringify({
          operation: "context",
          sessionId: "11111111-1111-4111-8111-111111111111",
          businessId: "other",
        }),
      }),
    );
    expect(r.status).toBe(409);
    expect(m.context).not.toHaveBeenCalled();
  });
});
