import { NextRequest } from "next/server";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  rpc: vi.fn(),
  ready: vi.fn(),
  from: vi.fn(),
}));
vi.mock("@/lib/admin/auth", () => ({ getAdminUser: mocks.admin }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { rpc: mocks.rpc, from: mocks.from },
}));
vi.mock("@/lib/voice/routing.server", () => ({
  pilotRoutingDependencies: () => ({ workerReady: mocks.ready }),
}));
import { POST } from "./route";
function request(body: unknown, origin = "https://simplassist.com") {
  return new NextRequest("https://simplassist.com/api/admin/voice-pilot", {
    method: "POST",
    headers: {
      host: "simplassist.com",
      origin,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
const settings = {
  action: "settings",
  revision: 1,
  enabled: false,
  budgetMinutes: 200,
  testers: [{ phone: "+15555550101", label: "Tester" }],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://simplassist.com");
  vi.stubEnv("VOICE_PILOT_ROLLOUT", "true");
  mocks.admin.mockResolvedValue({ id: "admin-id" });
  mocks.rpc.mockResolvedValue({ error: null });
  mocks.ready.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());
describe("admin-only pilot controls", () => {
  it("rejects non-admins without reading or changing pilot data", async () => {
    mocks.admin.mockResolvedValue(null);
    expect((await POST(request(settings))).status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects cross-origin requests", async () => {
    expect(
      (await POST(request(settings, "https://attacker.example"))).status,
    ).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("records an explicit budget change with session-derived admin attribution", async () => {
    expect(
      (
        await POST(
          request({ ...settings, budgetMinutes: 250, adminId: "forged" }),
        )
      ).status,
    ).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "configure_voice_pilot",
      expect.objectContaining({
        p_budget_seconds: 15000,
        p_admin: "admin-id",
        p_revision: 1,
      }),
    );
  });
  it("refuses enablement while readiness is unconfirmed", async () => {
    mocks.ready.mockResolvedValue(false);
    expect((await POST(request({ ...settings, enabled: true }))).status).toBe(
      409,
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects duplicate tester numbers", async () => {
    expect(
      (
        await POST(
          request({
            ...settings,
            testers: [...settings.testers, ...settings.testers],
          }),
        )
      ).status,
    ).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("can stop immediately even when provider readiness is unavailable", async () => {
    mocks.ready.mockResolvedValue(false);
    expect((await POST(request({ action: "stop" }))).status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("stop_voice_pilot", {
      p_admin: "admin-id",
    });
    expect(mocks.ready).not.toHaveBeenCalled();
  });
  it("does not confirm usage without provider evidence", async () => {
    expect(
      (
        await POST(
          request({
            action: "reconcile",
            sessionId: "40000000-0000-4000-a070-000000000001",
            seconds: 12,
            reference: "",
          }),
        )
      ).status,
    ).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
