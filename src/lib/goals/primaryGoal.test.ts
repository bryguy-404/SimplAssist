import { describe, expect, it, vi } from "vitest";

import {
  PRIMARY_GOAL_COPY,
  PRIMARY_GOAL_OPTIONS,
  buildPrimaryGoalUpdate,
  completeGoalSaveNavigation,
  isEditablePrimaryGoal,
  normalizeHttpsGoalUrl,
} from "./primaryGoal";

const MIGRATION_052_STORED_FORMAT =
  /^https:\/\/[^\s/?#]+(?:[/?#][^\s]*)?$/;

function expectMigration052GoalUrl(value: string): void {
  expect(value).toBe(value.trim());
  expect(value.length).toBeGreaterThanOrEqual(9);
  expect(value.length).toBeLessThanOrEqual(2048);
  expect(value.startsWith("https://")).toBe(true);
  expect(MIGRATION_052_STORED_FORMAT.test(value)).toBe(true);
}

describe("primary goal copy", () => {
  it("keeps the authoritative UI copy byte-identical and ordered", () => {
    expect(PRIMARY_GOAL_COPY).toEqual({
      question: "What should your assistant help customers do?",
      options: {
        book: "Book a time with me — jobs, visits, or appointments",
        signup: "Go to my website — to sign up, order, or learn more",
      },
      helper:
        "Pick the main one. Your AI still handles everything else customers ask — this just sets what it steers toward. You can change it anytime in Settings.",
    });
    expect(PRIMARY_GOAL_OPTIONS).toEqual([
      { value: "book", label: PRIMARY_GOAL_COPY.options.book },
      { value: "signup", label: PRIMARY_GOAL_COPY.options.signup },
    ]);
  });
});

describe("isEditablePrimaryGoal", () => {
  it.each(["book", "signup"])("accepts %s", (value) => {
    expect(isEditablePrimaryGoal(value)).toBe(true);
  });

  it.each(["quote", "callback", "", null, undefined, 1])(
    "rejects %s",
    (value) => {
      expect(isEditablePrimaryGoal(value)).toBe(false);
    }
  );
});

describe("normalizeHttpsGoalUrl", () => {
  it.each([
    undefined,
    null,
    "",
    "   ",
    "http://example.com",
    "HTTP://example.com",
    "HtTp://example.com",
    "https://",
    "https:///path",
    "HTTPS:///path",
    "not a url",
    "https://example.com/a path",
    `https://example.com/${"a".repeat(2030)}`,
  ])("rejects invalid goal URL %s", (value) => {
    expect(normalizeHttpsGoalUrl(value)).toBeNull();
  });

  const boundaryValue = `https://example.com/${"a".repeat(2028)}`;

  it.each([
    ["https://a", "https://a"],
    [
      "https://Example.COM/Path?Camp=Summer#SignUp",
      "https://Example.COM/Path?Camp=Summer#SignUp",
    ],
    [
      "HTTPS://Example.COM/Path?Camp=Summer#SignUp",
      "https://Example.COM/Path?Camp=Summer#SignUp",
    ],
    [
      "HttpS://example.com/Class?Program=Fall#Register",
      "https://example.com/Class?Program=Fall#Register",
    ],
    [
      " \nhttps://example.com/SignUp?Source=AI#Form\t ",
      "https://example.com/SignUp?Source=AI#Form",
    ],
    [boundaryValue, boundaryValue],
  ])(
    "accepts %s and persists migration-compatible %s",
    (input, expected) => {
      const storedValue = normalizeHttpsGoalUrl(input);

      expect(storedValue).toBe(expected);
      if (storedValue === null) throw new Error("expected accepted goal URL");
      expectMigration052GoalUrl(storedValue);
    }
  );

  it("accepts the migration's 2048-character boundary", () => {
    expect(boundaryValue).toHaveLength(2048);
  });
});

describe("buildPrimaryGoalUpdate", () => {
  it("omits goal_url entirely for book", () => {
    const update = buildPrimaryGoalUpdate({
      primary_goal: "book",
      goal_url: "https://example.com/retained",
    });

    expect(update).toEqual({ primary_goal: "book" });
    expect(update).not.toHaveProperty("goal_url");
  });

  it("returns the trimmed, scheme-normalized HTTPS URL for signup", () => {
    expect(
      buildPrimaryGoalUpdate({
        primary_goal: "signup",
        goal_url: "  HttpS://example.com/Summer-Camp?Camp=One#Form  ",
      })
    ).toEqual({
      primary_goal: "signup",
      goal_url: "https://example.com/Summer-Camp?Camp=One#Form",
    });
  });

  it.each([
    { primary_goal: null, goal_url: "https://example.com" },
    { primary_goal: undefined, goal_url: "https://example.com" },
    { primary_goal: "signup" as const, goal_url: null },
    { primary_goal: "signup" as const, goal_url: "http://example.com" },
  ])("returns null for unanswered or invalid input %#", (input) => {
    expect(buildPrimaryGoalUpdate(input)).toBeNull();
  });
});

describe("goal save authoritative round trip", () => {
  it("routes an answered completed SMS-ready gap business directly to the dashboard", async () => {
    const refreshState = vi.fn().mockResolvedValue({
      primaryGoal: "book",
      currentStep: "complete",
      dashboardReady: true,
    });
    const replace = vi.fn();
    const setStep = vi.fn();

    await completeGoalSaveNavigation({
      refreshState,
      replace,
      setStep,
    });

    expect(refreshState).toHaveBeenCalledExactlyOnceWith({ keepStep: true });
    expect(replace).toHaveBeenCalledExactlyOnceWith("/dashboard");
    expect(setStep).not.toHaveBeenCalled();
  });

  it("continues an answered mid-funnel business to its authoritative derived step", async () => {
    const refreshState = vi.fn().mockResolvedValue({
      primaryGoal: "signup",
      currentStep: "sms_use_case",
      dashboardReady: false,
    });
    const replace = vi.fn();
    const setStep = vi.fn();

    await completeGoalSaveNavigation({
      refreshState,
      replace,
      setStep,
    });

    expect(refreshState).toHaveBeenCalledExactlyOnceWith({ keepStep: true });
    expect(setStep).toHaveBeenCalledExactlyOnceWith("sms_use_case");
    expect(replace).not.toHaveBeenCalled();
  });
});
