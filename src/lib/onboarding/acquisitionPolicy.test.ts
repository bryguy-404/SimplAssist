import { describe, expect, it } from "vitest";
import { hasSmsProviderProvenance } from "./acquisitionPolicy";

describe("onboarding provider provenance", () => {
  it("does not treat a fresh registration marker or released lifecycle as provider ownership", () => {
    expect(hasSmsProviderProvenance({
      business: { onboarding_registration_status: "not_started", telnyx_resource_state: "released" },
      hasActivePhoneNumber: false,
    })).toBe(false);
  });

  it("retains provider history even when a resource lifecycle is marked released", () => {
    expect(hasSmsProviderProvenance({
      business: { telnyx_resource_state: "released", telnyx_campaign_id: "campaign-1" },
      hasActivePhoneNumber: false,
    })).toBe(true);
  });

  it.each(["active", "parked", "release_pending", "releasing", "blocked", "protected_hold"])(
    "protects the %s provider lifecycle", (telnyx_resource_state) => {
      expect(hasSmsProviderProvenance({
        business: { telnyx_resource_state },
        hasActivePhoneNumber: false,
      })).toBe(true);
    },
  );

  it("recognizes a registration attempt even when current provider identifiers are absent", () => {
    expect(hasSmsProviderProvenance({
      business: { onboarding_registration_status: "failed", onboarding_registration_started_at: "2026-09-23T00:00:00Z" },
      hasActivePhoneNumber: false,
    })).toBe(true);
  });
});
