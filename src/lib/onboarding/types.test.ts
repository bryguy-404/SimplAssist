import { describe, expect, it } from "vitest";
import {
  DIRECT_CHAT_ONBOARDING_STEPS,
  LEGACY_SMS_ONBOARDING_STEPS,
  ONBOARDING_STEPS,
  onboardingStepNumber,
  onboardingStepsForPlan,
} from "./types";

describe("plan-aware onboarding progress", () => {
  it("shows only the plan choice before a new direct customer chooses a branch", () => {
    expect(onboardingStepsForPlan({
      includePlanSelection: true,
      effectivePlan: null,
      planSelectionPosition: "start",
    })).toEqual(["plan_selection"]);
  });

  it("puts plan choice first for either selected direct branch", () => {
    for (const effectivePlan of ["chat_only", "sms_only"] as const) {
      const steps = onboardingStepsForPlan({
        includePlanSelection: true,
        effectivePlan,
        planSelectionPosition: "start",
      });
      expect(steps.slice(0, 5)).toEqual([
        "plan_selection", "business_info", "business_hours", "services_faqs", "ai_settings",
      ]);
    }
  });

  it("retains the late SMS selector for locked legacy recovery", () => {
    const steps = onboardingStepsForPlan({
      includePlanSelection: true,
      effectivePlan: null,
      planSelectionPosition: "after_knowledge",
    });
    expect(steps.slice(0, 5)).toEqual([
      "business_info", "business_hours", "services_faqs", "plan_selection", "ai_settings",
    ]);
    expect(steps.at(-1)).toBe("carrier_review");
  });

  it("keeps existing paid direct and partner SMS progress at nine steps", () => {
    const paidDirect = onboardingStepsForPlan({
      includePlanSelection: false,
      effectivePlan: "sms_and_chat",
    });
    const partner = onboardingStepsForPlan({
      includePlanSelection: false,
      effectivePlan: "sms_only",
    });

    expect(paidDirect).toEqual(LEGACY_SMS_ONBOARDING_STEPS);
    expect(partner).toEqual(LEGACY_SMS_ONBOARDING_STEPS);
    expect(onboardingStepNumber("ai_settings", paidDirect)).toBe(4);
    expect(onboardingStepNumber("carrier_review", paidDirect)).toBe(9);
  });

  it("adds the selection step only to new direct SMS acquisition", () => {
    expect(
      onboardingStepsForPlan({
        includePlanSelection: true,
        effectivePlan: "sms_and_chat",
      }),
    ).toEqual(ONBOARDING_STEPS);
    expect(onboardingStepNumber("ai_settings", ONBOARDING_STEPS)).toBe(5);
  });

  it("uses the compact no-SMS path for Chat Only", () => {
    expect(
      onboardingStepsForPlan({
        includePlanSelection: true,
        effectivePlan: "chat_only",
      }),
    ).toEqual(DIRECT_CHAT_ONBOARDING_STEPS);
    expect(
      onboardingStepsForPlan({
        includePlanSelection: false,
        effectivePlan: "chat_only",
      }),
    ).toEqual(
      DIRECT_CHAT_ONBOARDING_STEPS.filter(
        (step) => step !== "plan_selection",
      ),
    );
  });
});
