import { describe, expect, it, vi } from "vitest";
import {
  reviewWorkerHealthy,
  runReviewWorkerCycle,
} from "./review-worker-runtime";
describe("independent review worker cycles", () => {
  it("runs resource lifecycle even when delivery fails", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("delivery down"))
      .mockResolvedValueOnce(new Response("{}"));
    const state = {
      lastDeliverySuccess: 0,
      lastLifecycleSuccess: 0,
      lastLifecycleAttempt: 0,
    };
    const result = await runReviewWorkerCycle({
      origin: new URL("https://simplassist.com"),
      token: "secret",
      state,
      fetcher,
      now: () => 100000,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1][0])).toMatch(
      /\/api\/reviews\/internal\/lifecycle$/,
    );
    expect(state.lastLifecycleSuccess).toBe(100000);
    expect(result.errors).toEqual(["review_delivery_cycle_failed"]);
  });
  it("throttles failed lifecycle to one attempt per minute", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response("{}")),
      state = {
        lastDeliverySuccess: 0,
        lastLifecycleSuccess: 0,
        lastLifecycleAttempt: 95000,
      };
    await runReviewWorkerCycle({
      origin: new URL("https://simplassist.com"),
      token: "secret",
      state,
      fetcher,
      now: () => 100000,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("requires both cycles for health", () => {
    expect(
      reviewWorkerHealthy(
        {
          lastDeliverySuccess: 200000,
          lastLifecycleSuccess: 0,
          lastLifecycleAttempt: 0,
        },
        200000,
      ),
    ).toBe(false);
    expect(
      reviewWorkerHealthy(
        {
          lastDeliverySuccess: 200000,
          lastLifecycleSuccess: 200000,
          lastLifecycleAttempt: 0,
        },
        200000,
      ),
    ).toBe(true);
  });
});
