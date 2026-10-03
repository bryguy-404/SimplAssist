import { describe, expect, it } from "vitest";
import { isEmailReviewsEnabledForBusiness } from "./config";

const pilot = "10000000-0000-4000-a096-000000000001";
const existing = "10000000-0000-4000-a096-000000000002";
const newSignup = "10000000-0000-4000-a096-000000000003";
const launch = {
  REVIEWS_EMAIL_ENABLED: "1",
  REVIEWS_EMAIL_PILOT_BUSINESS_IDS: "*",
  CUSTOMER_REVIEWS_EXCLUDED_BUSINESS_IDS: existing,
};

describe("email review rollout", () => {
  it("admits a new signup without adding its UUID to a pilot list", () => {
    expect(isEmailReviewsEnabledForBusiness(newSignup, launch)).toBe(true);
    expect(isEmailReviewsEnabledForBusiness(pilot, launch)).toBe(true);
    expect(isEmailReviewsEnabledForBusiness(existing, launch)).toBe(false);
  });
  it("exclusions override an explicit pilot as well as the wildcard", () => {
    expect(
      isEmailReviewsEnabledForBusiness(existing, {
        ...launch,
        REVIEWS_EMAIL_PILOT_BUSINESS_IDS: existing,
      }),
    ).toBe(false);
  });
  it.each([undefined, "0", "true"])(
    "requires the feature switch even for wildcard admission (%s)",
    (enabled) => {
      expect(
        isEmailReviewsEnabledForBusiness(newSignup, {
          ...launch,
          REVIEWS_EMAIL_ENABLED: enabled,
        }),
      ).toBe(false);
    },
  );
  it("preserves pilot-only behavior and accepts normalized UUID casing", () => {
    const pilotOnly = {
      ...launch,
      REVIEWS_EMAIL_PILOT_BUSINESS_IDS: ` ${pilot.toUpperCase()} `,
    };
    expect(isEmailReviewsEnabledForBusiness(pilot, pilotOnly)).toBe(true);
    expect(isEmailReviewsEnabledForBusiness(newSignup, pilotOnly)).toBe(false);
  });
  it.each(["typo", `${existing},typo`, "*"])(
    "fails closed when exclusions are malformed (%s)",
    (exclusions) => {
      expect(
        isEmailReviewsEnabledForBusiness(newSignup, {
          ...launch,
          CUSTOMER_REVIEWS_EXCLUDED_BUSINESS_IDS: exclusions,
        }),
      ).toBe(false);
    },
  );
  it("rejects invalid business IDs and malformed pilot lists", () => {
    expect(isEmailReviewsEnabledForBusiness("bad-id", launch)).toBe(false);
    expect(
      isEmailReviewsEnabledForBusiness(newSignup, {
        ...launch,
        REVIEWS_EMAIL_PILOT_BUSINESS_IDS: "*,typo",
      }),
    ).toBe(false);
  });
});
