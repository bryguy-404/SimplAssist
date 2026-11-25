import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/stripe/client", () => ({
  stripe: { promotionCodes: { list: mocks.list } },
}));

import {
  lookupGiftCode,
  lookupGiftCodeForPublicPage,
  resetPublicGiftLookupsForTests,
  resolveCarriedPromotionCodeId,
} from "./lookup.server";

const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const nowSeconds = NOW / 1000;

function promotionCode(overrides: Record<string, unknown> = {}, coupon: Record<string, unknown> = {}) {
  return {
    id: "promo_1AbCdEf",
    object: "promotion_code",
    active: true,
    code: "FREEMONTH",
    customer: null,
    customer_account: null,
    expires_at: null,
    max_redemptions: null,
    times_redeemed: 4,
    metadata: { note: "internal: for the Rosa deal" },
    restrictions: { first_time_transaction: true, minimum_amount: null },
    promotion: {
      type: "coupon",
      coupon: {
        id: "coupon_internal",
        name: "Founder friends (internal name)",
        valid: true,
        percent_off: 100,
        amount_off: null,
        currency: null,
        duration: "once",
        duration_in_months: null,
        ...coupon,
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  resetPublicGiftLookupsForTests();
  mocks.list.mockResolvedValue({ data: [promotionCode()] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("lookupGiftCode", () => {
  it("returns only what is safe to show for a working code", async () => {
    const result = await lookupGiftCode("  freemonth ");

    expect(result).toEqual({
      status: "available",
      code: "FREEMONTH",
      promotionCodeId: "promo_1AbCdEf",
      offer: { kind: "percent", percentOff: 100, duration: "once", months: null },
      expiresAt: null,
    });
    expect(mocks.list).toHaveBeenCalledWith({
      code: "freemonth",
      active: true,
      limit: 10,
      expand: ["data.promotion.coupon"],
    });
    // Redemption counts, limits, internal names and metadata stay on the server.
    const leaked = JSON.stringify(result);
    for (const secret of ["times_redeemed", "internal", "coupon_internal", "restrictions", "metadata"]) {
      expect(leaked).not.toContain(secret);
    }
  });

  it("reports the expiry date and an amount-off, multi-month offer", async () => {
    mocks.list.mockResolvedValue({
      data: [
        promotionCode(
          { expires_at: nowSeconds + 86_400 },
          { percent_off: null, amount_off: 2000, currency: "usd", duration: "repeating", duration_in_months: 3 },
        ),
      ],
    });

    expect(await lookupGiftCode("FREEMONTH")).toMatchObject({
      status: "available",
      offer: { kind: "amount", amountOff: 2000, currency: "usd", duration: "repeating", months: 3 },
      expiresAt: new Date((nowSeconds + 86_400) * 1000).toISOString(),
    });
  });

  it.each([
    ["unknown to Stripe", []],
    ["switched off", [promotionCode({ active: false })]],
    ["expired", [promotionCode({ expires_at: nowSeconds - 1 })]],
    ["used up", [promotionCode({ max_redemptions: 5, times_redeemed: 5 })]],
    ["limited to one Stripe customer", [promotionCode({ customer: "cus_someone" })]],
    ["backed by a coupon that is no longer valid", [promotionCode({}, { valid: false })]],
    ["backed by a coupon that was not expanded", [promotionCode({ promotion: { type: "coupon", coupon: "coupon_internal" } })]],
    ["worth nothing", [promotionCode({}, { percent_off: null, amount_off: null })]],
    ["a different code returned by the search", [promotionCode({ code: "FREEMONTH2" })]],
  ])("answers the same plain 'unavailable' when the code is %s", async (_label, data) => {
    mocks.list.mockResolvedValue({ data });
    expect(await lookupGiftCode("FREEMONTH")).toEqual({ status: "unavailable" });
  });

  it.each(["", "ab", "has space", "<script>", null, undefined, 12345])(
    "never asks Stripe about something that cannot be a code (%j)",
    async (value) => {
      expect(await lookupGiftCode(value)).toEqual({ status: "unavailable" });
      expect(mocks.list).not.toHaveBeenCalled();
    },
  );

  it("picks the usable code when Stripe returns a customer-only twin first", async () => {
    mocks.list.mockResolvedValue({
      data: [promotionCode({ id: "promo_private", customer: "cus_someone" }), promotionCode({ id: "promo_public" })],
    });
    expect(await lookupGiftCode("FREEMONTH")).toMatchObject({ status: "available", promotionCodeId: "promo_public" });
  });

  it("says so, without throwing, when Stripe cannot be reached", async () => {
    mocks.list.mockRejectedValue(new Error("network down"));
    expect(await lookupGiftCode("FREEMONTH")).toEqual({ status: "error" });
  });
});

describe("resolveCarriedPromotionCodeId", () => {
  it("returns the Stripe id of the first carried code that works", async () => {
    mocks.list
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [promotionCode({ id: "promo_second", code: "SECOND" })] });
    expect(await resolveCarriedPromotionCodeId(["STALE", "SECOND"])).toBe("promo_second");
  });

  it("returns null, never an error, for stale codes and Stripe outages", async () => {
    mocks.list.mockResolvedValue({ data: [] });
    expect(await resolveCarriedPromotionCodeId(["STALE"])).toBeNull();
    mocks.list.mockRejectedValue(new Error("network down"));
    expect(await resolveCarriedPromotionCodeId(["FREEMONTH"])).toBeNull();
    expect(await resolveCarriedPromotionCodeId([])).toBeNull();
  });
});

describe("lookupGiftCodeForPublicPage", () => {
  it("remembers an answer briefly instead of asking Stripe on every view", async () => {
    await lookupGiftCodeForPublicPage("FREEMONTH");
    await lookupGiftCodeForPublicPage("freemonth");
    expect(mocks.list).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + 61_000);
    await lookupGiftCodeForPublicPage("FREEMONTH");
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("does not remember a Stripe outage", async () => {
    mocks.list.mockRejectedValueOnce(new Error("network down"));
    expect(await lookupGiftCodeForPublicPage("FREEMONTH")).toEqual({ status: "error" });
    expect(await lookupGiftCodeForPublicPage("FREEMONTH")).toMatchObject({ status: "available" });
  });

  it("stops asking Stripe when someone hammers the page with guesses", async () => {
    mocks.list.mockResolvedValue({ data: [] });
    for (let guess = 0; guess < 40; guess += 1) {
      expect(await lookupGiftCodeForPublicPage(`GUESS-${guess}`)).toEqual({ status: "unavailable" });
    }
    expect(await lookupGiftCodeForPublicPage("GUESS-NEXT")).toEqual({ status: "error" });
    expect(mocks.list).toHaveBeenCalledTimes(40);

    vi.setSystemTime(NOW + 61_000);
    expect(await lookupGiftCodeForPublicPage("GUESS-NEXT")).toEqual({ status: "unavailable" });
  });
});
