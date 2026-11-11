import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
const reconcile = vi.hoisted(() => vi.fn());
vi.mock("@/lib/onboarding/continueRegistration.server", () => ({ reconcilePendingBrandRegistrations: reconcile }));
import { POST } from "./route";
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
describe("registration reconciliation authentication", () => {
  it.each([undefined, "Bearer wrong"])("rejects %s before any account/provider work", async (authorization) => {
    vi.stubEnv("VOICE_INTERNAL_TOKEN", "x".repeat(32));
    const response = await POST(new NextRequest("https://app.example/api/internal/onboarding/reconcile", {
      method: "POST", headers: authorization ? { authorization } : {},
    }));
    expect(response.status).toBe(404); expect(reconcile).not.toHaveBeenCalled();
  });
  it("runs an authorized sweep and reports partial failure for retry", async () => {
    vi.stubEnv("VOICE_INTERNAL_TOKEN", "x".repeat(32));
    reconcile.mockResolvedValue({ checked: 3, failed: 1 });
    const response = await POST(new NextRequest("https://app.example/api/internal/onboarding/reconcile", {
      method: "POST", headers: { authorization: "Bearer " + "x".repeat(32) },
    }));
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ checked: 3, failed: 1 });
  });
});
