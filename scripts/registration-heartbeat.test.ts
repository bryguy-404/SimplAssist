import { describe, expect, it, vi } from "vitest";
import { createRegistrationHeartbeat } from "./registration-heartbeat";

describe("registration heartbeat", () => {
  it("keeps only one request in flight and can stop without affecting voice maintenance", async () => {
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise((done) => { resolve = done; }));
    const heartbeat = createRegistrationHeartbeat(new URL("https://app.example"), "private-token", fetcher);
    const request = heartbeat.run();
    await heartbeat.run(); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe("https://app.example/api/internal/onboarding/reconcile");
    heartbeat.stop();
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    resolve(new Response(null, { status: 200 })); await request;
    await heartbeat.run(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("recovers from a failed request on the next tick", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(new Response());
    const heartbeat = createRegistrationHeartbeat(new URL("https://app.example"), "token", fetcher);
    await expect(heartbeat.run()).resolves.toBeUndefined();
    await expect(heartbeat.run()).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
