import type { SubscriptionPlan } from "@/types/database";

/** Stable display/recommendation order; never an authorization hierarchy. */
export const SUBSCRIPTION_PLAN_ORDER = [
  "chat_only",
  "sms_only",
  "sms_and_chat",
  "full",
] as const satisfies readonly SubscriptionPlan[];

export const ALL_FEATURES = [
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
] as const;

export type FeatureKey = (typeof ALL_FEATURES)[number];

type PlanCapabilityVector = Readonly<Record<FeatureKey, boolean>>;

/**
 * The single source of truth for product feature authorization.
 *
 * Every plan has an explicit answer for every feature. In particular,
 * `chat_only` and `sms_only` are intentionally incomparable: neither plan is
 * treated as being "above" the other. Adding a plan or feature therefore
 * requires a deliberate capability decision instead of inheriting access from
 * a numeric rank.
 *
 * Future Full features intentionally live in this matrix before their product
 * implementations exist. That keeps pricing language and later runtime gates
 * anchored to stable identifiers without exposing placeholder functionality.
 */
export const PLAN_CAPABILITY_MATRIX = {
  chat_only: {
    missed_call_sms: false,
    manual_sms: false,
    contacts_inbox: true,
    ai_sms_conversations: false,
    web_chat: true,
    widget_branding: true,
    ai_customization: true,
    calendar: true,
    direct_booking: true,
    advanced_guardrails: false,
    advanced_analytics: false,
    conversion_reporting: false,
    weekly_summary: false,
    lead_alerts: false,
    review_requests: false,
    follow_up_automation: false,
    priority_support: false,
    ai_voice_answering: false,
  },
  sms_only: {
    missed_call_sms: true,
    manual_sms: true,
    contacts_inbox: true,
    ai_sms_conversations: false,
    web_chat: false,
    widget_branding: false,
    ai_customization: false,
    calendar: false,
    direct_booking: false,
    advanced_guardrails: false,
    advanced_analytics: false,
    conversion_reporting: false,
    weekly_summary: false,
    lead_alerts: false,
    review_requests: false,
    follow_up_automation: false,
    priority_support: false,
    ai_voice_answering: false,
  },
  sms_and_chat: {
    missed_call_sms: true,
    manual_sms: true,
    contacts_inbox: true,
    ai_sms_conversations: true,
    web_chat: true,
    widget_branding: true,
    ai_customization: true,
    calendar: true,
    direct_booking: true,
    advanced_guardrails: false,
    advanced_analytics: false,
    conversion_reporting: false,
    weekly_summary: false,
    lead_alerts: false,
    review_requests: false,
    follow_up_automation: false,
    priority_support: false,
    ai_voice_answering: false,
  },
  full: {
    missed_call_sms: true,
    manual_sms: true,
    contacts_inbox: true,
    ai_sms_conversations: true,
    web_chat: true,
    widget_branding: true,
    ai_customization: true,
    calendar: true,
    direct_booking: true,
    advanced_guardrails: true,
    advanced_analytics: true,
    conversion_reporting: true,
    weekly_summary: true,
    lead_alerts: true,
    review_requests: true,
    follow_up_automation: true,
    priority_support: true,
    ai_voice_answering: true,
  },
} as const satisfies Readonly<Record<SubscriptionPlan, PlanCapabilityVector>>;

/**
 * Backward-compatible display recommendation used by existing API responses.
 *
 * Despite its historical name, this map is not an authorization source. The
 * values intentionally remain unchanged for the three existing plans so
 * current locked-feature messaging does not change during the capability
 * migration. Use `PLAN_CAPABILITY_MATRIX`/`canPlanUseFeature` for access and
 * `recommendedUpgradePlan` for a recommendation that considers the current
 * plan.
 */
export const FEATURE_MINIMUM_PLAN = {
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
} as const satisfies Readonly<Record<FeatureKey, SubscriptionPlan>>;

const EMPTY_ELIGIBLE_PLANS = Object.freeze([]) as readonly SubscriptionPlan[];

const SMS_PROVISIONING_FEATURES = [
  "missed_call_sms",
  "manual_sms",
  "ai_sms_conversations",
] as const satisfies readonly FeatureKey[];

const FEATURE_ELIGIBLE_PLANS = Object.freeze(
  Object.fromEntries(
    ALL_FEATURES.map((feature) => [
      feature,
      Object.freeze(
        SUBSCRIPTION_PLAN_ORDER.filter(
          (plan) => PLAN_CAPABILITY_MATRIX[plan][feature]
        )
      ),
    ])
  )
) as Readonly<Record<FeatureKey, readonly SubscriptionPlan[]>>;

export function isSubscriptionPlan(value: unknown): value is SubscriptionPlan {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_PLAN_ORDER as readonly string[]).includes(value)
  );
}

export function isFeatureKey(value: unknown): value is FeatureKey {
  return (
    typeof value === "string" &&
    (ALL_FEATURES as readonly string[]).includes(value)
  );
}

export function requiredPlanForFeature(feature: FeatureKey): SubscriptionPlan {
  return FEATURE_MINIMUM_PLAN[feature];
}

/** Return every plan that explicitly grants a feature, in display order. */
export function eligiblePlansForFeature(
  feature: FeatureKey
): readonly SubscriptionPlan[] {
  return isFeatureKey(feature)
    ? FEATURE_ELIGIBLE_PLANS[feature]
    : EMPTY_ELIGIBLE_PLANS;
}

/**
 * Capability containment retained for compatibility with the old helper.
 * This is a set comparison, not a plan-rank comparison.
 */
export function planIncludesPlan(
  plan: SubscriptionPlan,
  requiredPlan: SubscriptionPlan
): boolean {
  if (!isSubscriptionPlan(plan) || !isSubscriptionPlan(requiredPlan)) {
    return false;
  }

  return ALL_FEATURES.every(
    (feature) =>
      !PLAN_CAPABILITY_MATRIX[requiredPlan][feature] ||
      PLAN_CAPABILITY_MATRIX[plan][feature]
  );
}

export function canPlanUseFeature(
  plan: SubscriptionPlan,
  feature: FeatureKey
): boolean {
  return (
    isSubscriptionPlan(plan) &&
    isFeatureKey(feature) &&
    PLAN_CAPABILITY_MATRIX[plan][feature]
  );
}

/** Whether activating a plan requires phone/carrier provisioning. */
export function planRequiresSmsProvisioning(plan: SubscriptionPlan): boolean {
  return (
    isSubscriptionPlan(plan) &&
    SMS_PROVISIONING_FEATURES.some(
      (feature) => PLAN_CAPABILITY_MATRIX[plan][feature]
    )
  );
}

/**
 * Recommend a plan that adds a denied feature without dropping the current
 * plan's capabilities. Returns null when access already exists or no safe
 * recommendation is available.
 */
export function recommendedUpgradePlan(
  currentPlan: SubscriptionPlan,
  feature: FeatureKey
): SubscriptionPlan | null {
  if (
    !isSubscriptionPlan(currentPlan) ||
    !isFeatureKey(feature) ||
    canPlanUseFeature(currentPlan, feature)
  ) {
    return null;
  }

  return (
    eligiblePlansForFeature(feature).find((candidate) =>
      planIncludesPlan(candidate, currentPlan)
    ) ?? null
  );
}
