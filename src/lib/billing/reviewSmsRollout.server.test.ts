import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { isReviewSmsEnabled, reviewSmsSignupScope } from "./reviewSmsRollout.server";

const businessId = "10000000-0000-4000-8000-00000000000a";
const otherId = "10000000-0000-4000-8000-00000000000b";
const enabled = {
  REVIEWS_SMS_ENABLED: "1",
  REVIEWS_SMS_PILOT_BUSINESS_IDS: "*",
};

describe("review SMS rollout", () => {
  it("bounds the signup scan to the same validated pilot and exclusions", () => {
    expect(reviewSmsSignupScope(enabled)).toEqual({businessIds: null, excludedBusinessIds: []});
    expect(reviewSmsSignupScope({...enabled, REVIEWS_SMS_PILOT_BUSINESS_IDS: `${businessId},${otherId}`, CUSTOMER_REVIEWS_EXCLUDED_BUSINESS_IDS: businessId})).toEqual({businessIds: [otherId], excludedBusinessIds: [businessId]});
    expect(reviewSmsSignupScope({...enabled, REVIEWS_SMS_PILOT_BUSINESS_IDS: ""})).toBeNull();
    expect(reviewSmsSignupScope({...enabled, REVIEWS_SMS_PILOT_BUSINESS_IDS: "*,typo"})).toBeNull();
    expect(reviewSmsSignupScope({...enabled, CUSTOMER_REVIEWS_EXCLUDED_BUSINESS_IDS: "typo"})).toBeNull();
    expect(reviewSmsSignupScope({})).toBeNull();
  });
  it("requires both the explicit feature flag and an admitted business", () => {
    expect(isReviewSmsEnabled(businessId, {})).toBe(false);
    expect(isReviewSmsEnabled(businessId, { REVIEWS_SMS_ENABLED: "1" })).toBe(
      false,
    );
    expect(
      isReviewSmsEnabled(businessId, {
        ...enabled,
        REVIEWS_SMS_ENABLED: "true",
      }),
    ).toBe(false);
    expect(isReviewSmsEnabled(businessId, enabled)).toBe(true);
    expect(isReviewSmsEnabled("invalid", enabled)).toBe(false);
  });

  it("keeps excluded businesses off even under a global or exact pilot launch", () => {
    for (const pilots of ["*", businessId]) {
      expect(
        isReviewSmsEnabled(businessId, {
          ...enabled,
          REVIEWS_SMS_PILOT_BUSINESS_IDS: pilots,
          CUSTOMER_REVIEWS_EXCLUDED_BUSINESS_IDS: ` ${businessId.toUpperCase()} `,
        }),
      ).toBe(false);
    }
    expect(
      isReviewSmsEnabled(otherId, {
        ...enabled,
        CUSTOMER_REVIEWS_EXCLUDED_BUSINESS_IDS: businessId,
      }),
    ).toBe(true);
  });

  it("accepts exact case-insensitive UUIDs and fails closed on malformed lists", () => {
    expect(
      isReviewSmsEnabled(businessId, {
        ...enabled,
        REVIEWS_SMS_PILOT_BUSINESS_IDS: ` ${businessId.toUpperCase()} `,
      }),
    ).toBe(true);
    expect(
      isReviewSmsEnabled(otherId, {
        ...enabled,
        REVIEWS_SMS_PILOT_BUSINESS_IDS: businessId,
      }),
    ).toBe(false);
    expect(
      isReviewSmsEnabled(businessId, {
        ...enabled,
        REVIEWS_SMS_PILOT_BUSINESS_IDS: "*,typo",
      }),
    ).toBe(false);
    expect(
      isReviewSmsEnabled(businessId, {
        ...enabled,
        CUSTOMER_REVIEWS_EXCLUDED_BUSINESS_IDS: "typo",
      }),
    ).toBe(false);
  });
});
