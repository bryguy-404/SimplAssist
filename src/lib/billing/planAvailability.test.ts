import { describe, expect, it } from "vitest";
import type { SubscriptionPlan } from "@/types/database";
import {
  availablePlanOrFallback,
  CUSTOMER_VISIBLE_PLAN_ORDER,
  getPlanSalesStatus,
  isPlanAvailable,
  isPlanVisible,
  paidPlanForOnboardingRetry,
  PLAN_SALES_STATUS,
} from "./planAvailability";

describe("plan sales availability", () => {
  it("recognizes chat-only without exposing it in customer sales UI", () => {
    expect(PLAN_SALES_STATUS).toEqual({
      chat_only: "hidden",
      sms_only: "available",
      sms_and_chat: "available",
      full: "available",
    });
    expect(CUSTOMER_VISIBLE_PLAN_ORDER).toEqual([
      "sms_only",
      "sms_and_chat",
      "full",
    ]);
  });

  it.each([
    ["chat_only", false, false],
    ["sms_only", true, true],
    ["sms_and_chat", true, true],
    ["full", true, true],
  ] satisfies [SubscriptionPlan, boolean, boolean][])(
    "reports whether %s can start a new sale",
    (plan, expected, visible) => {
      expect(isPlanAvailable(plan)).toBe(expected);
      expect(isPlanVisible(plan)).toBe(visible);
      expect(getPlanSalesStatus(plan)).toBe(
        expected ? "available" : visible ? "coming_soon" : "hidden"
      );
    }
  );

  it("preserves the available Full selection and falls back for hidden plans", () => {
    expect(availablePlanOrFallback("full", "sms_and_chat")).toBe(
      "full"
    );
    expect(availablePlanOrFallback("sms_only", "sms_and_chat")).toBe(
      "sms_only"
    );
    expect(availablePlanOrFallback("chat_only", "sms_and_chat")).toBe(
      "sms_and_chat"
    );
  });

  it("recognizes a paid Full onboarding retry separately from a new purchase", () => {
    expect(paidPlanForOnboardingRetry("full", "active")).toBe("full");
    expect(paidPlanForOnboardingRetry("full", "trialing")).toBe("full");
    expect(paidPlanForOnboardingRetry("full", "past_due")).toBeNull();
    expect(paidPlanForOnboardingRetry("full", "canceled")).toBeNull();
    expect(paidPlanForOnboardingRetry("full", null)).toBeNull();
  });
});
