import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/feedback/delivery.server", () => ({ deliverFeedbackEmail: vi.fn() }));
const reconcile = vi.hoisted(() => vi.fn());
const alerts = vi.hoisted(() => vi.fn());
vi.mock("@/lib/onboarding/continueRegistration.server", () => ({ reconcilePendingBrandRegistrations: reconcile }));
vi.mock("@/lib/account-alerts/runner.server", () => ({ runAccountSignupAlerts: alerts }));
import { POST } from "./route";
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
describe("registration reconciliation authentication", () => {
  it.each([undefined, "Bearer wrong"])("rejects %s before any account/provider work", async (authorization) => {
    vi.stubEnv("VOICE_INTERNAL_TOKEN", "x".repeat(32));
    const response = await POST(new NextRequest("https://app.example/api/internal/onboarding/reconcile", {
      method: "POST", headers: authorization ? { authorization } : {},
    }));
    expect(response.status).toBe(404); expect(reconcile).not.toHaveBeenCalled();
    expect(alerts).not.toHaveBeenCalled();
  });
  it("runs an authorized sweep and reports partial failure for retry", async () => {
    vi.stubEnv("VOICE_INTERNAL_TOKEN", "x".repeat(32));
    reconcile.mockResolvedValue({ checked: 3, failed: 1 });
    alerts.mockResolvedValue({ enabled: false, retry: 0, needsReview: 0 });
    const response = await POST(new NextRequest("https://app.example/api/internal/onboarding/reconcile", {
      method: "POST", headers: { authorization: "Bearer " + "x".repeat(32) },
    }));
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ checked: 3, failed: 1 });
  });
  it("continues registration even when email fails", async () => {
    vi.stubEnv("VOICE_INTERNAL_TOKEN", "x".repeat(32));
    reconcile.mockResolvedValue({ checked: 2, failed: 0 }); alerts.mockRejectedValue(new Error("private details"));
    const response = await POST(new NextRequest("https://app.example/api/internal/onboarding/reconcile", {
      method: "POST", headers: { authorization: "Bearer " + "x".repeat(32) },
    }));
    expect(reconcile).toHaveBeenCalledOnce(); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ checked: 2, failed: 0, accountAlerts: { error: "Account alerts need retry" } });
  });
  it("processes email even when registration fails", async () => {
    vi.stubEnv("VOICE_INTERNAL_TOKEN", "x".repeat(32));
    reconcile.mockRejectedValue(new Error("provider unavailable")); alerts.mockResolvedValue({ retry: 0, needsReview: 0 });
    const response = await POST(new NextRequest("https://app.example/api/internal/onboarding/reconcile", {
      method: "POST", headers: { authorization: "Bearer " + "x".repeat(32) },
    }));
    expect(alerts).toHaveBeenCalledOnce(); expect(response.status).toBe(503);
  });
});
