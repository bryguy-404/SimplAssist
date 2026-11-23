import { describe, expect, it } from "vitest";
import {
  formatPhoneForDisplay,
  normalizePhoneSearch,
  parsePhoneInputToE164,
  phoneMatchesSearch,
} from "./display";

describe("formatPhoneForDisplay", () => {
  it.each([
    ["+15742638634", "(574) 263-8634"],
    ["15742638634", "(574) 263-8634"],
    ["5742638634", "(574) 263-8634"],
    ["574-263-8634", "(574) 263-8634"],
    [" +1 (574) 263-8634 ", "(574) 263-8634"],
  ])("formats %s as %s", (input, expected) => {
    expect(formatPhoneForDisplay(input)).toBe(expected);
  });

  it.each(["+442071838750", "+525512345678", "12345", "not a number"])(
    "leaves %s unchanged instead of guessing",
    (input) => {
      expect(formatPhoneForDisplay(input)).toBe(input);
    }
  );

  it("returns an empty string for a missing number", () => {
    expect(formatPhoneForDisplay(null)).toBe("");
    expect(formatPhoneForDisplay(undefined)).toBe("");
    expect(formatPhoneForDisplay("  ")).toBe("");
  });
});

describe("parsePhoneInputToE164", () => {
  it.each([
    ["(317) 555-1234", "+13175551234"],
    ["317-555-1234", "+13175551234"],
    ["317.555.1234", "+13175551234"],
    ["3175551234", "+13175551234"],
    ["1 317 555 1234", "+13175551234"],
    ["+13175551234", "+13175551234"],
    ["+1 (317) 555-1234", "+13175551234"],
    ["+44 20 7183 8750", "+442071838750"],
  ])("reads %s as %s", (input, expected) => {
    expect(parsePhoneInputToE164(input)).toBe(expected);
  });

  it.each(["", "   ", "555-1234", "317555123", "23175551234", "call me", "+", "317-555-1234 ext 5"])(
    "rejects %j",
    (input) => {
      expect(parsePhoneInputToE164(input)).toBeNull();
    }
  );

  it("round-trips a displayed number back to its stored value", () => {
    expect(parsePhoneInputToE164(formatPhoneForDisplay("+15742638634"))).toBe(
      "+15742638634"
    );
  });
});

describe("phoneMatchesSearch", () => {
  it.each(["(574) 263-8634", "574-263", "(574)", "5742638634", "+1574", "8634"])(
    "finds a stored +1 number from %j",
    (query) => {
      expect(phoneMatchesSearch("+15742638634", query)).toBe(true);
    }
  );

  it.each(["", "  ", "(317)", "maria", "574 main", "(9)"])(
    "does not match %j",
    (query) => {
      expect(phoneMatchesSearch("+15742638634", query)).toBe(false);
    }
  );

  it("never matches a missing number", () => {
    expect(phoneMatchesSearch(null, "574")).toBe(false);
  });
});

describe("normalizePhoneSearch", () => {
  it.each([
    ["(574) 263-8634", "5742638634"],
    ["574-263", "574263"],
    ["+1 574", "1574"],
  ])("reduces the phone-shaped query %j to %j", (query, expected) => {
    expect(normalizePhoneSearch(query)).toBe(expected);
  });

  it.each(["maria", "574 main st", "5742638634", "", "(5)", "a-b"])(
    "leaves %j unchanged",
    (query) => {
      expect(normalizePhoneSearch(query)).toBe(query);
    }
  );
});
