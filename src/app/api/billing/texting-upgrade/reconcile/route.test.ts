import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ reconcile: vi.fn() }));
vi.mock("@/lib/billing/textingUpgradeReconciliation.server", () => ({ reconcilePendingTextingUpgrades: mocks.reconcile }));
import { POST } from "./route";

function request(authorization?: string) {
  return new NextRequest("http://localhost/api/billing/texting-upgrade/reconcile", {
    method: "POST", headers: authorization ? { authorization } : {},
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "test-recovery-secret");
  mocks.reconcile.mockResolvedValue({ attempted: 1, failed: 0, deferred: 0 });
});
afterEach(() => vi.unstubAllEnvs());

describe("texting-upgrade scheduled recovery endpoint", () => {
  it.each([undefined, "test-recovery-secret", "Bearer wrong", "Bearer test-recovery-secrex", "bearer test-recovery-secret"])(
    "denies missing or incorrect credentials before touching recovery: %s", async (authorization) => {
      const response = await POST(request(authorization));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Unauthorized" });
      expect(mocks.reconcile).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the server secret is unset", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await POST(request("Bearer test-recovery-secret"))).status).toBe(401);
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it("permits authenticated recovery even when new upgrades are disabled", async () => {
    vi.stubEnv("CHAT_TEXTING_UPGRADES_ENABLED", "0");
    vi.stubEnv("CHAT_TEXTING_UPGRADE_CANARY_BUSINESS_ID", "");
    const response = await POST(request("Bearer test-recovery-secret"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ attempted: 1, failed: 0, deferred: 0 });
    expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([
    { result: { attempted: 3, failed: 0, deferred: 1 }, status: 202 },
    { result: { attempted: 3, failed: 1, deferred: 0 }, status: 503 },
    { result: { attempted: 3, failed: 1, deferred: 1 }, status: 503 },
  ])("returns $status for a retryable incomplete batch", async ({ result, status }) => {
    mocks.reconcile.mockResolvedValue(result);
    const response = await POST(request("Bearer test-recovery-secret"));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(result);
  });

  it("returns a stable retryable error without leaking provider or database details", async () => {
    mocks.reconcile.mockRejectedValue(new Error("private provider response"));
    const response = await POST(request("Bearer test-recovery-secret"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "texting_upgrade_reconciliation_unavailable" });
  });
});
