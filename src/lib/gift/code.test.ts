import { describe, expect, it } from "vitest";
import {
  carriedGiftCodes,
  describeGiftOffer,
  formatGiftExpiry,
  giftCodeFromCookieHeader,
  giftHeadline,
  giftPagePath,
  normalizeGiftCode,
  type GiftOffer,
} from "./code";

const freeMonth: GiftOffer = { kind: "percent", percentOff: 100, duration: "once", months: null };

describe("normalizeGiftCode", () => {
  it.each([
    ["FREEMONTH", "FREEMONTH"],
    ["  rosa-free-2026  ", "rosa-free-2026"],
    ["abc", "abc"],
  ])("accepts %j", (input, expected) => {
    expect(normalizeGiftCode(input)).toBe(expected);
  });

  it.each([
    "", "ab", "has space", "semi;colon", "<script>", "../admin", "a".repeat(65),
    "percent%20", null, undefined, 42, {}, ["FREEMONTH"],
  ])("rejects %j", (input) => {
    expect(normalizeGiftCode(input)).toBeNull();
  });
});

describe("carriedGiftCodes", () => {
  it("prefers the cookie, then the code saved on the account", () => {
    expect(carriedGiftCodes("FROM-COOKIE", { gift_code: "FROM-ACCOUNT" })).toEqual([
      "FROM-COOKIE",
      "FROM-ACCOUNT",
    ]);
  });

  it("drops duplicates regardless of case", () => {
    expect(carriedGiftCodes("FreeMonth", { gift_code: "FREEMONTH" })).toEqual(["FreeMonth"]);
  });

  it("is empty for a customer without a code, and for junk", () => {
    expect(carriedGiftCodes(undefined, undefined)).toEqual([]);
    expect(carriedGiftCodes(undefined, { full_name: "Rosa" })).toEqual([]);
    expect(carriedGiftCodes("not a code!", { gift_code: { nested: true } })).toEqual([]);
    expect(carriedGiftCodes(undefined, "FREEMONTH")).toEqual([]);
  });
});

describe("giftCodeFromCookieHeader", () => {
  it("finds the gift cookie among others", () => {
    expect(giftCodeFromCookieHeader("theme=dark; sa_gift_code=ROSA-FREE; other=1")).toBe("ROSA-FREE");
  });

  it("returns null when it is missing or not a code", () => {
    expect(giftCodeFromCookieHeader(null)).toBeNull();
    expect(giftCodeFromCookieHeader("theme=dark")).toBeNull();
    expect(giftCodeFromCookieHeader("sa_gift_code=%3Cscript%3E")).toBeNull();
    expect(giftCodeFromCookieHeader("sa_gift_code=%E0%A4%A")).toBeNull();
    expect(giftCodeFromCookieHeader("not_sa_gift_code=FREEMONTH")).toBeNull();
  });
});

describe("describing what a code gives", () => {
  it.each<[GiftOffer, string, string]>([
    [freeMonth, "your first month free", "Your first month is on us"],
    [
      { kind: "percent", percentOff: 100, duration: "repeating", months: 3 },
      "your first 3 months free",
      "Your first 3 months are on us",
    ],
    [
      { kind: "percent", percentOff: 50, duration: "once", months: null },
      "50% off your first month",
      "A gift for you: 50% off your first month",
    ],
    [
      { kind: "percent", percentOff: 12.5, duration: "forever", months: null },
      "12.5% off every month",
      "A gift for you: 12.5% off every month",
    ],
    [
      { kind: "amount", amountOff: 2000, currency: "usd", duration: "repeating", months: 2 },
      "$20 off your first 2 months",
      "A gift for you: $20 off your first 2 months",
    ],
    [
      { kind: "amount", amountOff: 1550, currency: "usd", duration: "once", months: null },
      "$15.50 off your first month",
      "A gift for you: $15.50 off your first month",
    ],
  ])("%j", (offer, described, headline) => {
    expect(describeGiftOffer(offer)).toBe(described);
    expect(giftHeadline(offer)).toBe(headline);
  });
});

describe("formatGiftExpiry", () => {
  it("formats a date in UTC and tolerates none", () => {
    expect(formatGiftExpiry("2027-01-31T23:59:59.000Z")).toBe("January 31, 2027");
    expect(formatGiftExpiry(null)).toBeNull();
    expect(formatGiftExpiry("not a date")).toBeNull();
  });
});

describe("giftPagePath", () => {
  it("builds the coupon page path", () => {
    expect(giftPagePath("ROSA-FREE")).toBe("/gift/ROSA-FREE");
  });
});
