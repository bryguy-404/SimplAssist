import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { screeningVerdict } from "./domain";
import { canEnableCallScreening } from "./rollout.server";
afterEach(() => vi.unstubAllEnvs());
describe("screening evidence and rollout", () => {
  it("accepts only the documented verdict, never a configured action or unfamiliar shape", () => {
    expect(screeningVerdict("spam_likely")).toBe("spam_likely");
    for (const value of [undefined, null, "spam", "flag_calls", { action: "flag_calls", reputation: null, shaken_stir_attestation: "A" }, { spam_likely: true }]) expect(screeningVerdict(value)).toBe("unknown");
  });
  it("keeps rollout closed except exact pilot or exact broad opt-in", () => {
    const business = "00000000-0000-4000-8000-000000000001";
    vi.stubEnv("CALL_SCREENING_ENABLED", "0"); vi.stubEnv("CALL_SCREENING_PILOT_BUSINESS_ID", "");
    expect(canEnableCallScreening(business)).toBe(false);
    vi.stubEnv("CALL_SCREENING_PILOT_BUSINESS_ID", business);
    expect(canEnableCallScreening(business)).toBe(true);
    expect(canEnableCallScreening("00000000-0000-4000-8000-000000000002")).toBe(false);
    vi.stubEnv("CALL_SCREENING_PILOT_BUSINESS_ID", `${business} `);
    expect(canEnableCallScreening(business)).toBe(false);
    vi.stubEnv("CALL_SCREENING_ENABLED", "true"); expect(canEnableCallScreening(business)).toBe(false);
    vi.stubEnv("CALL_SCREENING_ENABLED", "1"); expect(canEnableCallScreening(business)).toBe(true);
  });
});
