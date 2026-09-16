import "server-only";

import {
  OperationalControlsResolutionError,
  resolveBusinessOperationalControlsFromSnapshot,
} from "@/lib/account/operationalControls.server";
import {
  decideOutboundSmsOperationalAccess,
  outboundSmsOperationalBlockMessage,
  type OutboundSmsPurpose,
} from "@/lib/messaging/outboundSmsOperational.server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { SUBSCRIPTION_PLANS } from "@/lib/stripe/config";
import {
  canPlanUseFeature,
  isSubscriptionPlan,
  type FeatureKey,
} from "./features";
import { countSmsParts } from "./smsParts";
import type {
  BillingMode,
  SubscriptionPlan,
  SubscriptionStatus,
} from "@/types/database";

const USAGE_BLOCK_MESSAGES = {
  account_suspended: outboundSmsOperationalBlockMessage("account_suspended"),
  texting_paused: outboundSmsOperationalBlockMessage("texting_paused"),
  ai_replies_paused: outboundSmsOperationalBlockMessage("ai_replies_paused"),
  telnyx_submission_disabled:
    "SMS sending is disabled for this account. Contact support if this looks wrong.",
  billing_required:
    "Choose an active plan before sending SMS.",
  canceled:
    "Choose an active plan before SMS sending can continue.",
  plan_not_entitled:
    "Your current plan does not include this type of SMS sending.",
  usage_limit_reached:
    "You have used all included SMS parts for this billing period. Upgrade or enable overages to keep sending.",
};

export type UsageBlockReason = keyof typeof USAGE_BLOCK_MESSAGES;

export type UsagePreflight =
  | {
      allowed: true;
      businessId: string;
      periodId: string;
      smsParts: number;
      warningThresholdReached: boolean;
    }
  | {
      allowed: false;
      reason: UsageBlockReason;
      message: string;
      smsParts: number;
    };

interface BusinessBillingRow {
  id: string;
  operations_suspended_at: unknown;
  ai_replies_paused_at: unknown;
  texting_paused_at: unknown;
  bookings_paused_at: unknown;
  billing_mode: unknown;
  partner_plan: unknown;
  billing_pilot: boolean;
  billing_comped: boolean;
  billing_exempt: boolean;
  telnyx_submission_disabled: boolean;
  sms_overage_opt_in: boolean;
}

interface SubscriptionBillingRow {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  current_period_start: string | null;
  current_period_end: string | null;
}

interface UsagePeriodRow {
  id: string;
  plan: unknown;
  included_sms_parts: number;
  inbound_sms_parts: number;
  outbound_sms_parts: number;
  warning_80_sent_at: string | null;
  hard_limit_reached_at: string | null;
}

type UsageBillingSource =
  | "subscription"
  | "partner_billing"
  | "billing_override"
  | "missing";

interface UsageContext {
  business: BusinessBillingRow;
  subscription: SubscriptionBillingRow | null;
  source: UsageBillingSource;
  plan: SubscriptionPlan;
  periodStart: string;
  periodEnd: string;
}

export async function preflightOutboundSms(args: {
  businessId: string;
  text: string;
  purpose: OutboundSmsPurpose;
}): Promise<UsagePreflight> {
  const smsParts = countSmsParts(args.text);
  const context = await resolveUsageContext(args.businessId);

  const operationalAccess = decideOutboundSmsOperationalAccess(
    resolveBusinessOperationalControlsFromSnapshot(args.businessId, {
      business: context.business,
    }),
    args.purpose,
  );
  if (!operationalAccess.allowed) {
    return blocked(operationalAccess.reason, smsParts);
  }

  if (context.business.telnyx_submission_disabled) {
    return blocked("telnyx_submission_disabled", smsParts);
  }

  if (context.source === "missing") {
    return blocked("billing_required", smsParts);
  }
  if (
    context.source === "subscription" &&
    context.subscription?.status === "canceled"
  ) {
    return blocked("canceled", smsParts);
  }
  if (!canPlanUseFeature(context.plan, smsFeatureForPurpose(args.purpose))) {
    return blocked("plan_not_entitled", smsParts);
  }

  const period = await ensureUsagePeriod(context);
  const used = period.inbound_sms_parts + period.outbound_sms_parts;
  const nextUsed = used + smsParts;
  const included = period.included_sms_parts;
  // Partner plans are fixed allowances. Legacy override flags and an old
  // overage opt-in must never turn invoiced/comped partner billing into an
  // unlimited plan. Stripe subscriptions and Stripe-mode legacy overrides
  // retain their existing overage behavior.
  const overageAllowed =
    context.source !== "partner_billing" &&
    (context.business.sms_overage_opt_in ||
      context.source === "billing_override");

  if (included > 0 && nextUsed > included && !overageAllowed) {
    await markHardLimitReached(period.id);
    return blocked("usage_limit_reached", smsParts);
  }

  const warningThresholdReached = included > 0 && nextUsed >= included * 0.8;
  if (warningThresholdReached && !period.warning_80_sent_at) {
    await markWarningSent(period.id);
  }

  return {
    allowed: true,
    businessId: args.businessId,
    periodId: period.id,
    smsParts,
    warningThresholdReached,
  };
}

export async function recordOutboundSmsUsage(args: {
  businessId: string;
  text: string;
  source: string;
  providerMessageId?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const context = await resolveUsageContext(args.businessId);
  const period = await ensureUsagePeriod(context);
  const smsParts = countSmsParts(args.text);
  await recordUsageEvent({
    businessId: args.businessId,
    periodId: period.id,
    direction: "outbound",
    channel: "sms",
    source: args.source,
    smsParts,
    mmsEvents: 0,
    providerMessageId: args.providerMessageId ?? null,
    idempotencyKey:
      args.idempotencyKey ??
      `outbound:${args.source}:${args.providerMessageId ?? crypto.randomUUID()}`,
    metadata: args.metadata,
  });
}

export async function recordInboundMessagingUsage(args: {
  businessId: string;
  text: string;
  mediaCount: number;
  source: string;
  providerEventId?: string | null;
  providerMessageId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const context = await resolveUsageContext(args.businessId);
  const period = await ensureUsagePeriod(context);
  const smsParts = countSmsParts(args.text);
  const hasMms = args.mediaCount > 0;
  await recordUsageEvent({
    businessId: args.businessId,
    periodId: period.id,
    direction: "inbound",
    channel: hasMms ? "mms" : "sms",
    source: args.source,
    smsParts,
    mmsEvents: hasMms ? 1 : 0,
    providerMessageId: args.providerMessageId ?? null,
    idempotencyKey:
      args.providerEventId ??
      `inbound:${args.source}:${args.providerMessageId ?? crypto.randomUUID()}`,
    metadata: {
      mediaCount: args.mediaCount,
      ...(args.metadata ?? {}),
    },
  });
}

export function usageBlockMessage(reason: UsageBlockReason): string {
  return USAGE_BLOCK_MESSAGES[reason];
}

function blocked(reason: UsageBlockReason, smsParts: number): UsagePreflight {
  return {
    allowed: false,
    reason,
    message: usageBlockMessage(reason),
    smsParts,
  };
}

function smsFeatureForPurpose(purpose: OutboundSmsPurpose): FeatureKey {
  switch (purpose) {
    case "manual_dashboard_send":
      return "manual_sms";
    case "missed_call":
      return "missed_call_sms";
    case "voice_followup":
    case "ai_reply":
    case "mms_fallback":
      return "ai_sms_conversations";
  }
}

async function resolveUsageContext(businessId: string): Promise<UsageContext> {
  const [
    { data: business, error: businessError },
    { data: subscription, error: subscriptionError },
  ] = await Promise.all([
    supabaseAdmin
      .from("businesses")
      .select(
        "id, operations_suspended_at, ai_replies_paused_at, texting_paused_at, bookings_paused_at, billing_mode, partner_plan, billing_pilot, billing_comped, billing_exempt, telnyx_submission_disabled, sms_overage_opt_in"
      )
      .eq("id", businessId)
      .single<BusinessBillingRow>(),
    supabaseAdmin
      .from("subscriptions")
      .select("plan, status, current_period_start, current_period_end")
      .eq("business_id", businessId)
      .maybeSingle<SubscriptionBillingRow>(),
  ]);

  if (businessError || !business) {
    throw new OperationalControlsResolutionError({
      code: businessError ? "business_lookup_failed" : "business_not_found",
      businessId,
      message: `[billing:usage] Failed to read business ${businessId}: ${businessError?.message ?? "not found"}`,
      cause: businessError ?? undefined,
    });
  }

  if (subscriptionError) {
    throw new Error(
      `[billing:usage] Failed to read subscription for ${businessId}: ${subscriptionError.message}`
    );
  }

  if (
    subscription &&
    (!isSubscriptionPlan(subscription.plan) ||
      !isKnownSubscriptionStatus(subscription.status))
  ) {
    throw new Error(
      `[billing:usage] Subscription for ${businessId} has malformed billing values`
    );
  }

  // Match the central billing contract exactly: any synchronized subscription
  // is authoritative, followed by native partner billing, then Stripe-mode
  // legacy overrides. Missing Stripe billing keeps its historical sms_only
  // usage snapshot for inbound accounting, while outbound preflight blocks it.
  let source: UsageBillingSource;
  let plan: SubscriptionPlan;

  if (subscription) {
    source = "subscription";
    plan = subscription.plan;
  } else {
    if (!isBillingMode(business.billing_mode)) {
      throw new Error(
        `[billing:usage] Business ${businessId} has malformed partner billing values`
      );
    }

    if (
      business.billing_mode === "invoiced" ||
      business.billing_mode === "comped"
    ) {
      if (!isSubscriptionPlan(business.partner_plan)) {
        throw new Error(
          `[billing:usage] Business ${businessId} has malformed partner billing values`
        );
      }
      source = "partner_billing";
      plan = business.partner_plan;
    } else {
      if (business.partner_plan !== null) {
        throw new Error(
          `[billing:usage] Business ${businessId} has malformed partner billing values`
        );
      }

      const hasLegacyOverride =
        business.billing_exempt ||
        business.billing_comped ||
        business.billing_pilot;
      source = hasLegacyOverride ? "billing_override" : "missing";
      plan = hasLegacyOverride ? "full" : "sms_only";
    }
  }

  const { start, end } =
    subscription?.current_period_start && subscription.current_period_end
      ? {
          start: subscription.current_period_start,
          end: subscription.current_period_end,
        }
      : currentUtcMonthPeriod();

  return {
    business,
    subscription: subscription ?? null,
    source,
    plan,
    periodStart: start,
    periodEnd: end,
  };
}

async function ensureUsagePeriod(context: UsageContext): Promise<UsagePeriodRow> {
  const included = SUBSCRIPTION_PLANS[context.plan].includedSmsParts;
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("billing_usage_periods")
    .select(
      "id, plan, included_sms_parts, inbound_sms_parts, outbound_sms_parts, warning_80_sent_at, hard_limit_reached_at"
    )
    .eq("business_id", context.business.id)
    .eq("period_start", context.periodStart)
    .maybeSingle<UsagePeriodRow>();

  if (existingError) {
    throw new Error(
      `[billing:usage] Failed to read usage period for ${context.business.id}: ${existingError.message}`
    );
  }

  if (existing) {
    const shouldReconcile =
      context.source === "partner_billing"
        ? existing.plan !== context.plan ||
          existing.included_sms_parts !== included
        : included > existing.included_sms_parts;

    if (shouldReconcile) {
      const { data: reconciled, error: reconcileError } = await supabaseAdmin
        .from("billing_usage_periods")
        .update({
          plan: context.plan,
          included_sms_parts: included,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .select(
          "id, plan, included_sms_parts, inbound_sms_parts, outbound_sms_parts, warning_80_sent_at, hard_limit_reached_at"
        )
        .single<UsagePeriodRow>();

      if (reconcileError || !reconciled) {
        throw new Error(
          `[billing:usage] Failed to reconcile usage period ${existing.id}: ${reconcileError?.message ?? "not found"}`
        );
      }
      return reconciled;
    }
    return existing;
  }

  const { data, error } = await supabaseAdmin
    .from("billing_usage_periods")
    .insert({
      business_id: context.business.id,
      period_start: context.periodStart,
      period_end: context.periodEnd,
      plan: context.plan,
      included_sms_parts: included,
    })
    .select(
      "id, plan, included_sms_parts, inbound_sms_parts, outbound_sms_parts, warning_80_sent_at, hard_limit_reached_at"
    )
    .single<UsagePeriodRow>();

  if (error || !data) {
    throw new Error(
      `[billing:usage] Failed to ensure usage period for ${context.business.id}: ${error?.message ?? "not found"}`
    );
  }
  return data;
}

async function recordUsageEvent(args: {
  businessId: string;
  periodId: string;
  direction: "inbound" | "outbound";
  channel: "sms" | "mms";
  source: string;
  smsParts: number;
  mmsEvents: number;
  providerMessageId: string | null;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc(
    "record_billing_usage_event",
    {
      p_business_id: args.businessId,
      p_usage_period_id: args.periodId,
      p_idempotency_key: args.idempotencyKey,
      p_direction: args.direction,
      p_channel: args.channel,
      p_source: args.source,
      p_sms_parts: args.smsParts,
      p_mms_events: args.mmsEvents,
      p_provider_message_id: args.providerMessageId,
      p_metadata: args.metadata ?? null,
    }
  );

  if (error) {
    throw new Error(
      `[billing:usage] Failed to record usage event ${args.idempotencyKey}: ${error.message}`
    );
  }

  if (typeof data !== "boolean") {
    throw new Error(
      `[billing:usage] Usage RPC returned an invalid response for ${args.idempotencyKey}`
    );
  }
}

async function markWarningSent(periodId: string): Promise<void> {
  await supabaseAdmin
    .from("billing_usage_periods")
    .update({ warning_80_sent_at: new Date().toISOString() })
    .eq("id", periodId)
    .is("warning_80_sent_at", null);
}

async function markHardLimitReached(periodId: string): Promise<void> {
  await supabaseAdmin
    .from("billing_usage_periods")
    .update({ hard_limit_reached_at: new Date().toISOString() })
    .eq("id", periodId)
    .is("hard_limit_reached_at", null);
}

function currentUtcMonthPeriod(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

function isKnownSubscriptionStatus(
  status: unknown
): status is SubscriptionStatus {
  return (
    status === "active" ||
    status === "trialing" ||
    status === "past_due" ||
    status === "canceled"
  );
}

function isBillingMode(value: unknown): value is BillingMode {
  return value === "stripe" || value === "invoiced" || value === "comped";
}
