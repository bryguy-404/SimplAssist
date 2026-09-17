import { describe, expect, it } from "vitest";

import type { SubscriptionPlan } from "@/types/database";
import {
  ALL_FEATURES,
  canPlanUseFeature,
  eligiblePlansForFeature,
  FEATURE_MINIMUM_PLAN,
  isFeatureKey,
  isSubscriptionPlan,
  PLAN_CAPABILITY_MATRIX,
  planIncludesPlan,
  planRequiresSmsProvisioning,
  recommendedUpgradePlan,
  requiredPlanForFeature,
  SUBSCRIPTION_PLAN_ORDER,
  type FeatureKey,
} from "./features";

const EXPECTED_FEATURES = {
  chat_only: [
    "contacts_inbox",
    "web_chat",
    "widget_branding",
    "ai_customization",
    "calendar",
    "direct_booking",
  ],
  sms_only: ["missed_call_sms", "manual_sms", "contacts_inbox"],
  sms_and_chat: [
    "missed_call_sms",
    "manual_sms",
    "contacts_inbox",
    "ai_sms_conversations",
    "web_chat",
    "widget_branding",
    "ai_customization",
    "calendar",
    "direct_booking",
  ],
  full: [
    "missed_call_sms",
    "manual_sms",
    "contacts_inbox",
    "ai_sms_conversations",
    "web_chat",
    "widget_branding",
    "ai_customization",
    "calendar",
    "direct_booking",
    "advanced_guardrails",
    "advanced_analytics",
    "conversion_reporting",
    "weekly_summary",
    "lead_alerts",
    "review_requests",
    "follow_up_automation",
    "priority_support",
    "ai_voice_answering",
  ],
} as const satisfies Record<SubscriptionPlan, readonly FeatureKey[]>;

const EXPECTED_DISPLAY_REQUIRED_PLAN = {
  missed_call_sms: "sms_only",
  manual_sms: "sms_only",
  contacts_inbox: "sms_only",
  ai_sms_conversations: "sms_and_chat",
  web_chat: "sms_and_chat",
  widget_branding: "sms_and_chat",
  ai_customization: "sms_and_chat",
  calendar: "sms_and_chat",
  direct_booking: "sms_and_chat",
  advanced_guardrails: "full",
  advanced_analytics: "full",
  conversion_reporting: "full",
  weekly_summary: "full",
  lead_alerts: "full",
  review_requests: "full",
  follow_up_automation: "full",
  priority_support: "full",
  ai_voice_answering: "full",
} as const satisfies Record<FeatureKey, SubscriptionPlan>;

describe("feature plan matrix", () => {
  it.each(SUBSCRIPTION_PLAN_ORDER)(
    "exposes the exact explicit feature set for %s",
    (plan) => {
      const enabled = ALL_FEATURES.filter((feature) =>
        canPlanUseFeature(plan, feature)
      );

      expect(enabled).toEqual(EXPECTED_FEATURES[plan]);
    }
  );

  it("requires an explicit boolean decision for every plan-feature pair", () => {
    expect(Object.keys(PLAN_CAPABILITY_MATRIX)).toEqual(
      SUBSCRIPTION_PLAN_ORDER
    );

    for (const plan of SUBSCRIPTION_PLAN_ORDER) {
      expect(Object.keys(PLAN_CAPABILITY_MATRIX[plan])).toEqual(ALL_FEATURES);
      for (const feature of ALL_FEATURES) {
        expect(typeof PLAN_CAPABILITY_MATRIX[plan][feature]).toBe("boolean");
      }
    }
  });

  it("gives chat-only every approved chat capability and no SMS capability", () => {
    expect(EXPECTED_FEATURES.chat_only).toEqual([
      "contacts_inbox",
      "web_chat",
      "widget_branding",
      "ai_customization",
      "calendar",
      "direct_booking",
    ]);
    expect(canPlanUseFeature("chat_only", "missed_call_sms")).toBe(false);
    expect(canPlanUseFeature("chat_only", "manual_sms")).toBe(false);
    expect(canPlanUseFeature("chat_only", "ai_sms_conversations")).toBe(false);
  });

  it("keeps every future product key reserved for Full", () => {
    const reserved: FeatureKey[] = [
      "advanced_analytics",
      "conversion_reporting",
      "weekly_summary",
      "lead_alerts",
      "review_requests",
      "follow_up_automation",
      "priority_support",
      "ai_voice_answering",
    ];

    for (const feature of reserved) {
      expect(requiredPlanForFeature(feature)).toBe("full");
      expect(canPlanUseFeature("sms_and_chat", feature)).toBe(false);
      expect(canPlanUseFeature("full", feature)).toBe(true);
    }
  });

  it("preserves the complete legacy required-plan response lookup", () => {
    expect(FEATURE_MINIMUM_PLAN).toEqual(EXPECTED_DISPLAY_REQUIRED_PLAN);
    expect(ALL_FEATURES).toHaveLength(Object.keys(FEATURE_MINIMUM_PLAN).length);
    for (const feature of ALL_FEATURES) {
      expect(requiredPlanForFeature(feature)).toBe(
        EXPECTED_DISPLAY_REQUIRED_PLAN[feature]
      );
    }
  });

  it("preserves legacy display recommendations without using them for access", () => {
    expect(requiredPlanForFeature("contacts_inbox")).toBe("sms_only");
    expect(requiredPlanForFeature("web_chat")).toBe("sms_and_chat");
    expect(requiredPlanForFeature("calendar")).toBe("sms_and_chat");

    expect(canPlanUseFeature("chat_only", "contacts_inbox")).toBe(true);
    expect(canPlanUseFeature("chat_only", "web_chat")).toBe(true);
    expect(canPlanUseFeature("chat_only", "calendar")).toBe(true);
  });

  it("computes capability containment without treating plans as a linear rank", () => {
    expect(planIncludesPlan("chat_only", "chat_only")).toBe(true);
    expect(planIncludesPlan("sms_only", "sms_only")).toBe(true);
    expect(planIncludesPlan("sms_and_chat", "chat_only")).toBe(true);
    expect(planIncludesPlan("sms_and_chat", "sms_only")).toBe(true);
    expect(planIncludesPlan("full", "chat_only")).toBe(true);
    expect(planIncludesPlan("full", "sms_and_chat")).toBe(true);

    expect(planIncludesPlan("chat_only", "sms_only")).toBe(false);
    expect(planIncludesPlan("sms_only", "chat_only")).toBe(false);
    expect(planIncludesPlan("sms_only", "sms_and_chat")).toBe(false);
    expect(planIncludesPlan("sms_and_chat", "full")).toBe(false);
  });

  it.each([
    ["chat_only", false],
    ["sms_only", true],
    ["sms_and_chat", true],
    ["full", true],
  ] as const)(
    "derives whether %s requires SMS provisioning from its capabilities",
    (plan, expected) => {
      expect(planRequiresSmsProvisioning(plan)).toBe(expected);
    }
  );

  it.each([
    [
      "missed_call_sms",
      ["sms_only", "sms_and_chat", "full"],
    ],
    [
      "contacts_inbox",
      ["chat_only", "sms_only", "sms_and_chat", "full"],
    ],
    ["ai_sms_conversations", ["sms_and_chat", "full"]],
    ["web_chat", ["chat_only", "sms_and_chat", "full"]],
    ["direct_booking", ["chat_only", "sms_and_chat", "full"]],
    ["advanced_guardrails", ["full"]],
  ] as const)("lists the eligible plans for %s", (feature, plans) => {
    expect(eligiblePlansForFeature(feature)).toEqual(plans);
  });

  it("lists eligible plans exhaustively from each exact feature vector", () => {
    for (const feature of ALL_FEATURES) {
      const expected = SUBSCRIPTION_PLAN_ORDER.filter((plan) =>
        (EXPECTED_FEATURES[plan] as readonly FeatureKey[]).includes(feature)
      );

      expect(eligiblePlansForFeature(feature)).toEqual(expected);
    }
  });

  it.each([
    ["sms_only", "web_chat", "sms_and_chat"],
    ["sms_only", "ai_sms_conversations", "sms_and_chat"],
    ["chat_only", "manual_sms", "sms_and_chat"],
    ["chat_only", "ai_sms_conversations", "sms_and_chat"],
    ["chat_only", "advanced_analytics", "full"],
    ["sms_only", "advanced_analytics", "full"],
    ["sms_and_chat", "advanced_analytics", "full"],
    ["chat_only", "web_chat", null],
    ["full", "manual_sms", null],
  ] as const)(
    "recommends %s + %s -> %s without dropping current capabilities",
    (currentPlan, feature, expected) => {
      expect(recommendedUpgradePlan(currentPlan, feature)).toBe(expected);
    }
  );

  it("always recommends a capability superset for a known denial", () => {
    for (const plan of SUBSCRIPTION_PLAN_ORDER) {
      for (const feature of ALL_FEATURES) {
        if (canPlanUseFeature(plan, feature)) continue;

        const recommendation = recommendedUpgradePlan(plan, feature);
        expect(recommendation).not.toBeNull();
        expect(canPlanUseFeature(recommendation!, feature)).toBe(true);
        expect(planIncludesPlan(recommendation!, plan)).toBe(true);
      }
    }
  });

  it.each([
    ["chat_only", true],
    ["sms_only", true],
    ["sms_and_chat", true],
    ["full", true],
    ["starter", false],
    [null, false],
    [undefined, false],
  ])("validates subscription plan %#", (value, expected) => {
    expect(isSubscriptionPlan(value)).toBe(expected);
  });

  it("fails closed for unknown runtime plan and feature values", () => {
    const unknownPlan = "starter" as SubscriptionPlan;
    const unknownFeature = "unknown_feature" as FeatureKey;

    expect(isFeatureKey(unknownFeature)).toBe(false);
    expect(canPlanUseFeature(unknownPlan, "web_chat")).toBe(false);
    expect(canPlanUseFeature("full", unknownFeature)).toBe(false);
    expect(eligiblePlansForFeature(unknownFeature)).toEqual([]);
    expect(planIncludesPlan(unknownPlan, "sms_only")).toBe(false);
    expect(planIncludesPlan("full", unknownPlan)).toBe(false);
    expect(planRequiresSmsProvisioning(unknownPlan)).toBe(false);
    expect(recommendedUpgradePlan(unknownPlan, "web_chat")).toBeNull();
    expect(recommendedUpgradePlan("sms_only", unknownFeature)).toBeNull();
  });
});
