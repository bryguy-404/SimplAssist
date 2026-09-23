import "server-only";

import { supabaseAdmin } from "@/lib/supabase/admin";
import { isChatOnlyDirectAcquisitionEnabledForBusiness } from "@/lib/billing/chatOnlyRollout.server";
import { hasValidChatOnlyStripePrice } from "@/lib/stripe/config";
import { canContinueTextingUpgradeProvisioning } from "./textingUpgradeActivation.server";
import type {
  BillingMode,
  SubscriptionPlan,
  SubscriptionStatus,
} from "@/types/database";
import {
  canPlanUseFeature,
  eligiblePlansForFeature,
  isSubscriptionPlan,
  planRequiresSmsProvisioning,
  recommendedUpgradePlan,
  requiredPlanForFeature,
  type FeatureKey,
} from "./features";

export type EntitlementSource =
  | "subscription"
  | "partner_billing"
  | "billing_override";
export type EntitlementStatus =
  | SubscriptionStatus
  | "partner_billing"
  | "billing_override";

export interface BusinessEntitlements {
  businessId: string;
  plan: SubscriptionPlan;
  status: EntitlementStatus;
  source: EntitlementSource;
  active: boolean;
  cancelAtPeriodEnd: boolean;
  /** Exact paid cross-family upgrade; usable services remain Chat until activation. */
  textingUpgradePending?: true;
}

export type SmsProvisioningAccessDecision =
  | {
      allowed: true;
      source: EntitlementSource | "direct_precheckout";
      plan: SubscriptionPlan | null;
    }
  | {
      allowed: false;
      reason: "plan_not_entitled";
      source: EntitlementSource | "direct_precheckout";
      plan: SubscriptionPlan;
    }
  | {
      allowed: false;
      reason: "billing_state_unavailable";
    };

/**
 * Durable billing facts needed to resolve entitlements without performing any
 * database reads. Unknown field types are deliberate: the resolver validates
 * service-role/RPC snapshots with the same fail-closed rules as direct reads.
 */
export interface BusinessEntitlementSnapshot {
  business: {
    id: unknown;
    billing_mode: unknown;
    partner_plan: unknown;
    /** Advisory only; consulted solely to narrow the legacy SMS pre-checkout exception. */
    onboarding_selected_plan?: unknown;
    billing_pilot: unknown;
    billing_comped: unknown;
    billing_exempt: unknown;
  } | null;
  subscription: {
    plan: unknown;
    status: unknown;
    cancel_at_period_end: unknown;
  } | null;
}

export type EntitlementResolutionErrorCode =
  | "invalid_business_id"
  | "business_lookup_failed"
  | "business_not_found"
  | "subscription_lookup_failed"
  | "subscription_missing"
  | "malformed_business"
  | "malformed_subscription";

/**
 * An indeterminate entitlement result. Callers at provider webhook boundaries
 * should convert this error to a retryable 5xx, never to a known plan denial.
 */
export class EntitlementResolutionError extends Error {
  readonly code: EntitlementResolutionErrorCode;
  readonly businessId: string;
  readonly retryable = true;
  override readonly cause?: unknown;

  constructor(args: {
    code: EntitlementResolutionErrorCode;
    businessId: string;
    message: string;
    cause?: unknown;
  }) {
    super(args.message);
    this.name = "EntitlementResolutionError";
    this.code = args.code;
    this.businessId = args.businessId;
    this.cause = args.cause;
  }
}

export type FeatureAccessDecision =
  | {
      outcome: "resolved";
      allowed: true;
      feature: FeatureKey;
      requiredPlan: SubscriptionPlan;
      eligiblePlans: readonly SubscriptionPlan[];
      recommendedUpgradePlan: null;
      currentPlan: SubscriptionPlan;
      status: EntitlementStatus;
    }
  | {
      outcome: "not_entitled";
      allowed: false;
      reason: "inactive_subscription" | "plan";
      feature: FeatureKey;
      requiredPlan: SubscriptionPlan;
      eligiblePlans: readonly SubscriptionPlan[];
      recommendedUpgradePlan: SubscriptionPlan | null;
      currentPlan: SubscriptionPlan;
      status: EntitlementStatus;
    };

type BusinessEntitlementRow = NonNullable<
  BusinessEntitlementSnapshot["business"]
>;
type SubscriptionEntitlementRow = NonNullable<
  BusinessEntitlementSnapshot["subscription"]
>;
type BusinessPlanFamilyLock = "sms" | "chat_only";
type BusinessPlanFamilyLockRow = { family: unknown };

const ACTIVE_SUBSCRIPTION_STATUSES = new Set<SubscriptionStatus>([
  "active",
  "trialing",
  "past_due",
]);

/**
 * Resolve a business's authoritative local billing state.
 *
 * This intentionally never calls Stripe. Stripe webhooks own synchronization;
 * feature execution reads that durable local state and fails retryably when it
 * cannot determine an answer.
 */
export async function resolveBusinessEntitlements(
  businessId: string
): Promise<BusinessEntitlements> {
  const snapshot = await loadBusinessEntitlementSnapshot(businessId);
  const billed = resolveBusinessEntitlementsFromSnapshot(businessId, snapshot);
  if (billed.source !== "subscription" || billed.plan === "chat_only") return billed;

  // This service-role SQL read shares the payment/binding policy with metering,
  // widget and calendar admission. Ordinary billing provenance stays unchanged.
  const { data, error } = await supabaseAdmin.rpc("get_business_effective_service_plan", {
    p_business_id: businessId,
    p_billed_plan: billed.plan,
  });
  if (error || (data !== billed.plan && data !== "chat_only")) {
    throw new EntitlementResolutionError({
      code: "subscription_lookup_failed",
      businessId,
      message: "Unable to resolve the effective texting-upgrade service plan.",
      cause: error,
    });
  }
  return data === "chat_only"
    ? { ...billed, plan: "chat_only", textingUpgradePending: true }
    : billed;
}

/**
 * Authorize entry into SMS/Telnyx provisioning flows.
 *
 * Direct onboarding intentionally selects a number before checkout creates a
 * subscription, so callers must opt into that one narrow legacy exception.
 * Every other missing or malformed billing state fails closed. A recognized
 * chat-only plan is always denied regardless of whether Stripe or partner
 * billing supplied it.
 */
export async function resolveSmsProvisioningAccess(
  businessId: string,
  options: { allowDirectPrecheckout: boolean },
): Promise<SmsProvisioningAccessDecision> {
  let snapshot: BusinessEntitlementSnapshot;
  let familyLock: BusinessPlanFamilyLock | null;
  let entitlements: BusinessEntitlements;
  try {
    [snapshot, familyLock] = await Promise.all([
      loadBusinessEntitlementSnapshot(businessId),
      loadBusinessPlanFamilyLock(businessId),
    ]);
    entitlements = resolveBusinessEntitlementsFromSnapshot(
      businessId,
      snapshot,
    );
  } catch (error) {
    if (
      error instanceof EntitlementResolutionError &&
      error.code === "subscription_missing" &&
      options.allowDirectPrecheckout
    ) {
      return directPrecheckoutSmsAccess(businessId, snapshot!, familyLock!);
    }

    if (error instanceof EntitlementResolutionError) {
      return { allowed: false, reason: "billing_state_unavailable" };
    }
    throw error;
  }

  // A durable Chat family claim can outlive a canceled Checkout Session or a
  // cleared subscription. It is service-owned transition authority, so an
  // advisory SMS intent or even contradictory local SMS authority must never
  // reopen Telnyx provisioning around it.
  if (
    familyLock === "chat_only" &&
    planRequiresSmsProvisioning(entitlements.plan)
  ) {
    return { allowed: false, reason: "billing_state_unavailable" };
  }

  if (!planRequiresSmsProvisioning(entitlements.plan)) {
    return {
      allowed: false,
      reason: "plan_not_entitled",
      source: entitlements.source,
      plan: entitlements.plan,
    };
  }

  // Provisioning deliberately uses the billed plan, not the temporary Chat
  // service overlay. A paid upgrade still cannot provision after cancellation
  // has been requested or while support must resolve its registration.
  try {
    if (!(await canContinueTextingUpgradeProvisioning(businessId))) {
      return {
        allowed: false,
        reason: "plan_not_entitled",
        source: entitlements.source,
        plan: entitlements.plan,
      };
    }
  } catch {
    return { allowed: false, reason: "billing_state_unavailable" };
  }

  return {
    allowed: true,
    source: entitlements.source,
    plan: entitlements.plan,
  };
}

/**
 * Preserve the legacy direct-number picker only for an unselected account or
 * a durable SMS-plan intent. While the guarded early-selection flow is live,
 * choosing Chat Only makes the advisory intent a denial signal for this
 * narrow exception; it still never grants runtime entitlements.
 */
function directPrecheckoutSmsAccess(
  businessId: string,
  snapshot: BusinessEntitlementSnapshot,
  familyLock: BusinessPlanFamilyLock | null,
): SmsProvisioningAccessDecision {
  const intent = snapshot.business?.onboarding_selected_plan;

  // Checkout claims this durable family before Stripe mutation. Unlike the
  // owner-writable intent, the lock survives cancellation and remains
  // authoritative even when acquisition flags are later rolled back.
  if (familyLock === "chat_only") {
    return {
      allowed: false,
      reason: "plan_not_entitled",
      source: "direct_precheckout",
      plan: "chat_only",
    };
  }

  // Existing rows were intentionally not backfilled by migration 058. Treat
  // an absent/null intent as the established pre-Phase-2 SMS onboarding path.
  if (intent === null || intent === undefined) {
    return {
      allowed: true,
      source: "direct_precheckout",
      plan: null,
    };
  }

  if (!isSubscriptionPlan(intent)) {
    return { allowed: false, reason: "billing_state_unavailable" };
  }

  // A Chat choice written through the guarded server route is a durable denial
  // signal for SMS/Telnyx work. Acquisition rollback pauses Chat Checkout; it
  // must never silently reinterpret that saved choice as legacy SMS setup.
  if (intent === "chat_only") {
    return {
      allowed: false,
      reason: "plan_not_entitled",
      source: "direct_precheckout",
      plan: intent,
    };
  }

  // Current acquisition authority is still consulted for valid SMS-family
  // advisory intents, but rollback leaves their established SMS onboarding
  // behavior unchanged. Authoritative subscription and partner plans were
  // resolved before this narrow reducer.
  if (
    !isChatOnlyDirectAcquisitionEnabledForBusiness(businessId) ||
    !hasValidChatOnlyStripePrice()
  ) {
    return {
      allowed: true,
      source: "direct_precheckout",
      plan: null,
    };
  }

  if (!planRequiresSmsProvisioning(intent)) {
    return {
      allowed: false,
      reason: "plan_not_entitled",
      source: "direct_precheckout",
      plan: intent,
    };
  }

  return {
    allowed: true,
    source: "direct_precheckout",
    // The intent narrowed this exception but is never returned as if it were
    // authoritative billing provenance.
    plan: null,
  };
}

async function loadBusinessPlanFamilyLock(
  businessId: string,
): Promise<BusinessPlanFamilyLock | null> {
  if (typeof businessId !== "string" || businessId.trim() === "") {
    throw new EntitlementResolutionError({
      code: "invalid_business_id",
      businessId,
      message: "Cannot resolve a plan-family lock without a business ID.",
    });
  }

  const { data, error } = await supabaseAdmin
    .from("business_plan_family_locks")
    .select("family")
    .eq("business_id", businessId)
    .maybeSingle<BusinessPlanFamilyLockRow>();

  if (error) {
    throw new EntitlementResolutionError({
      code: "business_lookup_failed",
      businessId,
      message: `Failed to read the plan-family lock for business ${businessId}: ${errorMessage(error)}`,
      cause: error,
    });
  }

  if (!data) return null;
  if (data.family !== "sms" && data.family !== "chat_only") {
    throw new EntitlementResolutionError({
      code: "malformed_business",
      businessId,
      message: `Business ${businessId} has a malformed plan-family lock.`,
    });
  }

  return data.family;
}

async function loadBusinessEntitlementSnapshot(
  businessId: string,
): Promise<BusinessEntitlementSnapshot> {
  if (typeof businessId !== "string" || businessId.trim() === "") {
    throw new EntitlementResolutionError({
      code: "invalid_business_id",
      businessId,
      message: "Cannot resolve entitlements without a business ID.",
    });
  }

  const [businessQuery, subscriptionQuery] = await Promise.allSettled([
    supabaseAdmin
      .from("businesses")
      .select(
        "id, billing_mode, partner_plan, onboarding_selected_plan, billing_pilot, billing_comped, billing_exempt"
      )
      .eq("id", businessId)
      .maybeSingle<BusinessEntitlementRow>(),
    supabaseAdmin
      .from("subscriptions")
      .select("plan, status, cancel_at_period_end")
      .eq("business_id", businessId)
      .maybeSingle<SubscriptionEntitlementRow>(),
  ]);

  if (businessQuery.status === "rejected") {
    throw new EntitlementResolutionError({
      code: "business_lookup_failed",
      businessId,
      message: `Failed to read billing flags for business ${businessId}: ${errorMessage(businessQuery.reason)}`,
      cause: businessQuery.reason,
    });
  }
  if (subscriptionQuery.status === "rejected") {
    throw new EntitlementResolutionError({
      code: "subscription_lookup_failed",
      businessId,
      message: `Failed to read the subscription for business ${businessId}: ${errorMessage(subscriptionQuery.reason)}`,
      cause: subscriptionQuery.reason,
    });
  }

  const businessResult = businessQuery.value;
  const subscriptionResult = subscriptionQuery.value;

  if (businessResult.error) {
    throw new EntitlementResolutionError({
      code: "business_lookup_failed",
      businessId,
      message: `Failed to read billing flags for business ${businessId}: ${errorMessage(businessResult.error)}`,
      cause: businessResult.error,
    });
  }
  // Preserve the existing lookup precedence: an absent or mismatched business
  // is authoritative even when the parallel subscription read also errored.
  if (!businessResult.data || businessResult.data.id !== businessId) {
    return { business: businessResult.data, subscription: null };
  }
  if (subscriptionResult.error) {
    throw new EntitlementResolutionError({
      code: "subscription_lookup_failed",
      businessId,
      message: `Failed to read the subscription for business ${businessId}: ${errorMessage(subscriptionResult.error)}`,
      cause: subscriptionResult.error,
    });
  }

  return {
    business: businessResult.data,
    subscription: subscriptionResult.data,
  };
}

/**
 * Resolve authoritative entitlements from already-loaded durable facts.
 *
 * A synchronized subscription has precedence over business billing fields,
 * matching `resolveBusinessEntitlements`. Any indeterminate or malformed state
 * throws a retryable EntitlementResolutionError instead of fabricating access.
 */
export function resolveBusinessEntitlementsFromSnapshot(
  businessId: string,
  snapshot: BusinessEntitlementSnapshot
): BusinessEntitlements {
  if (typeof businessId !== "string" || businessId.trim() === "") {
    throw new EntitlementResolutionError({
      code: "invalid_business_id",
      businessId,
      message: "Cannot resolve entitlements without a business ID.",
    });
  }

  const business = snapshot.business;
  if (!business) {
    throw new EntitlementResolutionError({
      code: "business_not_found",
      businessId,
      message: `Business ${businessId} was not found while resolving entitlements.`,
    });
  }
  if (business.id !== businessId) {
    throw new EntitlementResolutionError({
      code: "malformed_business",
      businessId,
      message: `Business entitlement lookup returned an unexpected row for ${businessId}.`,
    });
  }

  if (snapshot.subscription) {
    return entitlementsFromSubscription(businessId, snapshot.subscription);
  }

  if (
    !isBillingMode(business.billing_mode) ||
    typeof business.billing_pilot !== "boolean" ||
    typeof business.billing_comped !== "boolean" ||
    typeof business.billing_exempt !== "boolean"
  ) {
    throw new EntitlementResolutionError({
      code: "malformed_business",
      businessId,
      message: `Business ${businessId} has malformed billing authority fields.`,
    });
  }

  if (
    business.billing_mode === "invoiced" ||
    business.billing_mode === "comped"
  ) {
    if (!isSubscriptionPlan(business.partner_plan)) {
      throw new EntitlementResolutionError({
        code: "malformed_business",
        businessId,
        message: `Business ${businessId} has malformed partner billing state.`,
      });
    }

    return {
      businessId,
      plan: business.partner_plan,
      status: "partner_billing",
      source: "partner_billing",
      active: true,
      cancelAtPeriodEnd: false,
    };
  }

  if (business.partner_plan !== null) {
    throw new EntitlementResolutionError({
      code: "malformed_business",
      businessId,
      message: `Business ${businessId} has malformed Stripe billing state.`,
    });
  }

  if (
    business.billing_pilot ||
    business.billing_comped ||
    business.billing_exempt
  ) {
    return {
      businessId,
      plan: "full",
      status: "billing_override",
      source: "billing_override",
      active: true,
      cancelAtPeriodEnd: false,
    };
  }

  throw new EntitlementResolutionError({
    code: "subscription_missing",
    businessId,
    message: `Business ${businessId} has no synchronized subscription or billing override.`,
  });
}

export function canUseFeature(
  entitlements: BusinessEntitlements,
  feature: FeatureKey
): boolean {
  return (
    entitlements.active && canPlanUseFeature(entitlements.plan, feature)
  );
}

export function decideFeatureAccess(
  entitlements: BusinessEntitlements,
  feature: FeatureKey
): FeatureAccessDecision {
  const requiredPlan = requiredPlanForFeature(feature);
  const base = {
    feature,
    requiredPlan,
    eligiblePlans: eligiblePlansForFeature(feature),
    recommendedUpgradePlan: null,
    currentPlan: entitlements.plan,
    status: entitlements.status,
  };

  if (!entitlements.active) {
    return {
      ...base,
      outcome: "not_entitled",
      allowed: false,
      reason: "inactive_subscription",
    };
  }

  if (!canPlanUseFeature(entitlements.plan, feature)) {
    const upgradePlan = recommendedUpgradePlan(entitlements.plan, feature);

    return {
      ...base,
      recommendedUpgradePlan: upgradePlan,
      outcome: "not_entitled",
      allowed: false,
      reason: "plan",
    };
  }

  return { ...base, outcome: "resolved", allowed: true };
}

export function isEntitlementResolutionError(
  error: unknown
): error is EntitlementResolutionError {
  return error instanceof EntitlementResolutionError;
}

export {
  eligiblePlansForFeature,
  planRequiresSmsProvisioning,
  recommendedUpgradePlan,
  requiredPlanForFeature,
} from "./features";
export type { FeatureKey } from "./features";

function entitlementsFromSubscription(
  businessId: string,
  subscription: SubscriptionEntitlementRow
): BusinessEntitlements {
  if (
    !isSubscriptionPlan(subscription.plan) ||
    !isSubscriptionStatus(subscription.status) ||
    typeof subscription.cancel_at_period_end !== "boolean"
  ) {
    throw new EntitlementResolutionError({
      code: "malformed_subscription",
      businessId,
      message: `Business ${businessId} has a malformed synchronized subscription.`,
    });
  }

  return {
    businessId,
    plan: subscription.plan,
    status: subscription.status,
    source: "subscription",
    active: ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  };
}

function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return (
    value === "active" ||
    value === "trialing" ||
    value === "past_due" ||
    value === "canceled"
  );
}

function isBillingMode(value: unknown): value is BillingMode {
  return value === "stripe" || value === "invoiced" || value === "comped";
}

function errorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "unknown database error";
}
