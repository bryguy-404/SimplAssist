import { describe, expect, it } from "vitest";

import {
  ALL_FEATURES,
  canPlanUseFeature,
  type FeatureKey,
} from "@/lib/billing/features";
import {
  getPlanSalesStatus,
  type PlanSalesStatus,
} from "@/lib/billing/planAvailability";
import {
  SETUP_FEE_CENTS,
  SMS_OVERAGE_CENTS,
  SUBSCRIPTION_PLANS,
} from "@/lib/stripe/config";
import type { SubscriptionPlan } from "@/types/database";

type ExistingSubscriptionPlan = Exclude<SubscriptionPlan, "chat_only">;

const EXISTING_PLAN_BASELINE = {
  sms_only: {
    name: "Starter / SMS Only",
    price: 25,
    includedSmsParts: 500,
    salesStatus: "available",
    capabilities: ["missed_call_sms", "manual_sms", "contacts_inbox"],
  },
  sms_and_chat: {
    name: "Growth / SMS + Web Chat",
    price: 45,
    includedSmsParts: 1500,
    salesStatus: "available",
    capabilities: [
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
  },
  full: {
    name: "Pro / Full Suite",
    price: 65,
    includedSmsParts: 2500,
    salesStatus: "coming_soon",
    capabilities: [
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
      "ai_voice_answering",
    ],
  },
} as const satisfies Record<
  ExistingSubscriptionPlan,
  {
    name: string;
    price: number;
    includedSmsParts: number;
    salesStatus: PlanSalesStatus;
    capabilities: readonly FeatureKey[];
  }
>;

describe("existing-plan migration safety baseline", () => {
  it.each(Object.keys(EXISTING_PLAN_BASELINE) as ExistingSubscriptionPlan[])(
    "preserves the approved %s commercial and capability contract",
    (plan) => {
      const expected = EXISTING_PLAN_BASELINE[plan];
      const actual = SUBSCRIPTION_PLANS[plan];

      expect(actual).toBeDefined();
      expect({
        name: actual.name,
        price: actual.price,
        includedSmsParts: actual.includedSmsParts,
        salesStatus: getPlanSalesStatus(plan),
        capabilities: ALL_FEATURES.filter((feature) =>
          canPlanUseFeature(plan, feature)
        ),
      }).toEqual(expected);
    }
  );

  it("preserves existing SMS activation and overage amounts", () => {
    expect(SETUP_FEE_CENTS).toBe(2500);
    expect(SMS_OVERAGE_CENTS).toBe(3);
  });
});
