import "server-only";

import { z } from "zod";
import { subscriptionPlanSchema } from "@/lib/billing/planSchema";
import {
  EntitlementResolutionError,
  resolveBusinessEntitlementsFromSnapshot,
  type BusinessEntitlements,
} from "@/lib/billing/entitlements";
import { reduceSmsReadinessSnapshot } from "@/lib/messaging/lookup";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type {
  A2pRiskReviewStatus,
  BillingMode,
  OnboardingRegistrationStatus,
  OnboardingStep,
  RegistrationStatus,
  SubscriptionPlan,
  SubscriptionStatus,
} from "@/types/database";
import { getAdminBusinessLifecycle } from "./accountLifecycle";
import {
  normalizeAdminAccountHealth,
  type AdminAccountHealth,
  type AdminFailedSetupReasonCode,
} from "./accountHealth";

export const ADMIN_BUSINESS_HEALTH_RPC = "list_admin_business_health_v2";

export type AdminLifecycleHealthFilter =
  | "live"
  | "onboarding"
  | "past_due"
  | "suspended"
  | "pending_deletion"
  | "failed_setup";
export type AdminOwnershipHealthFilter = "direct" | "partner";

export interface AdminAccountHealthFilters {
  lifecycle?: AdminLifecycleHealthFilter | null;
  ownership?: AdminOwnershipHealthFilter | null;
  partnerId?: string | null;
  plan?: SubscriptionPlan | null;
  query?: string | null;
}

export interface AdminAccountHealthRecord {
  business: {
    id: string;
    name: string;
    website_url: string | null;
    business_type: string | null;
    a2p_risk_review_status: A2pRiskReviewStatus | null;
    a2p_risk_review_message: string | null;
    onboarding_registration_status: OnboardingRegistrationStatus | null;
    brand_status: RegistrationStatus | null;
    campaign_status: RegistrationStatus | null;
    partner_id: string | null;
    billing_mode: BillingMode;
    partner_plan: SubscriptionPlan | null;
    partner: { name: string; slug: string } | null;
    billing_pilot: boolean;
    billing_comped: boolean;
    billing_exempt: boolean;
    telnyx_submission_disabled: boolean;
    sms_overage_opt_in: boolean;
    deleted_at: string | null;
    deletion_scheduled_for: string | null;
    created_at: string | null;
  };
  subscription:
    | {
        business_id: string;
        plan: SubscriptionPlan;
        status: SubscriptionStatus;
      }
    | undefined;
  usage:
    | {
        business_id: string;
        included_sms_parts: number;
        inbound_sms_parts: number;
        outbound_sms_parts: number;
        inbound_mms_events: number;
        outbound_mms_events: number;
        period_start: string;
      }
    | undefined;
  health: AdminAccountHealth | null;
}

export class AdminAccountHealthReadError extends Error {
  readonly code: "query_failed" | "invalid_response" | "inconsistent_response";
  override readonly cause?: unknown;

  constructor(
    code: AdminAccountHealthReadError["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "AdminAccountHealthReadError";
    this.code = code;
    this.cause = cause;
  }
}

const timestampSchema = z.string().refine(
  (value) => value.length > 0 && Number.isFinite(Date.parse(value)),
  "Invalid timestamp",
);
const nullableTimestampSchema = timestampSchema.nullable();
const subscriptionStatusSchema = z.enum([
  "active",
  "past_due",
  "canceled",
  "trialing",
]);
const registrationStatusSchema = z.enum(["pending", "approved", "rejected"]);
const onboardingRegistrationStatusSchema = z.enum([
  "not_started",
  "submitting",
  "failed",
  "submitted",
]);
const riskStatusSchema = z.enum([
  "not_started",
  "pending_review",
  "blocked",
  "passed",
  "admin_approved",
]);
const assignmentStatusSchema = z.enum([
  "unassigned",
  "pending",
  "assigned",
  "failed",
]);
const onboardingStepSchema = z.enum([
  "business_info",
  "business_hours",
  "services_faqs",
  "plan_selection",
  "ai_settings",
  "legal_verification",
  "sms_use_case",
  "phone_number",
  "review_submit",
  "carrier_review",
  "complete",
]);
const failedReasonSchema = z.enum([
  "registration_failed",
  "registration_submission_stale",
  "risk_review_blocked",
  "brand_rejected",
  "campaign_rejected",
  "phone_assignment_failed",
  "pending_phone_failed",
  "provisioning_needs_attention",
  "provisioning_invite_failed",
  "provisioning_lease_expired",
]);
const provisioningStatusSchema = z.enum([
  "pending",
  "admin_setup",
  "auth_created",
  "business_prepared",
  "assigned",
  "invite_pending",
  "setup_email_sent",
  "needs_attention",
  "dismissed",
]);

const rpcRowSchema = z
  .object({
    business_id: z.string().uuid(),
    business_name: z.string(),
    business_email: z.string().nullable(),
    website_url: z.string().nullable(),
    business_type: z.string().nullable(),
    business_created_at: nullableTimestampSchema,
    snapshot_at: timestampSchema,
    deleted_at: nullableTimestampSchema,
    deletion_scheduled_for: nullableTimestampSchema,
    operations_suspended_at: nullableTimestampSchema,
    ai_replies_paused_at: nullableTimestampSchema,
    texting_paused_at: nullableTimestampSchema,
    bookings_paused_at: nullableTimestampSchema,
    onboarding_completed_at: nullableTimestampSchema,
    onboarding_step: onboardingStepSchema,
    partner_id: z.string().uuid().nullable(),
    partner_name: z.string().nullable(),
    partner_slug: z.string().nullable(),
    billing_mode: z.enum(["stripe", "invoiced", "comped"]),
    partner_plan: subscriptionPlanSchema.nullable(),
    billing_pilot: z.boolean(),
    billing_comped: z.boolean(),
    billing_exempt: z.boolean(),
    telnyx_submission_disabled: z.boolean(),
    sms_overage_opt_in: z.boolean(),
    subscription_plan: subscriptionPlanSchema.nullable(),
    subscription_status: subscriptionStatusSchema.nullable(),
    subscription_cancel_at_period_end: z.boolean().nullable(),
    effective_plan: subscriptionPlanSchema.nullable(),
    usage_period_start: nullableTimestampSchema,
    usage_period_end: nullableTimestampSchema,
    usage_included_sms_parts: z.number().int().nonnegative().nullable(),
    usage_inbound_sms_parts: z.number().int().nonnegative().nullable(),
    usage_outbound_sms_parts: z.number().int().nonnegative().nullable(),
    usage_inbound_mms_events: z.number().int().nonnegative().nullable(),
    usage_outbound_mms_events: z.number().int().nonnegative().nullable(),
    a2p_risk_review_status: riskStatusSchema.nullable(),
    a2p_risk_review_message: z.string().nullable(),
    onboarding_registration_status:
      onboardingRegistrationStatusSchema.nullable(),
    onboarding_registration_started_at: nullableTimestampSchema,
    brand_status: registrationStatusSchema.nullable(),
    campaign_status: registrationStatusSchema.nullable(),
    telnyx_messaging_profile_id: z.string().nullable(),
    telnyx_campaign_id: z.string().nullable(),
    messaging_profile_configured: z.boolean(),
    campaign_configured: z.boolean(),
    pending_phone_number_present: z.boolean(),
    pending_phone_number_failed: z.boolean(),
    active_phone_count: z.number().int().nonnegative(),
    active_phone_number: z.string().nullable(),
    active_phone_assignment_status: assignmentStatusSchema.nullable(),
    active_phone_assignment_campaign_id: z.string().nullable(),
    active_phone_assignment_matches_campaign: z.boolean(),
    active_phone_assignment_failed: z.boolean(),
    ai_configured: z.boolean(),
    ai_booking_enabled: z.boolean().nullable(),
    ai_booking_mode: z.enum(["collect_info", "schedule_direct"]).nullable(),
    web_chat_enabled: z.boolean(),
    calendar_connected: z.boolean(),
    provisioning_job_count: z.number().int().nonnegative(),
    provisioning_status: provisioningStatusSchema.nullable(),
    provisioning_needs_attention: z.boolean(),
    provisioning_invite_failed: z.boolean(),
    provisioning_lease_expired: z.boolean(),
    failed_setup: z.boolean(),
    failed_setup_reasons: z.array(failedReasonSchema),
    last_activity_at: nullableTimestampSchema,
  })
  .strict()
  .superRefine((row, context) => {
    const subscriptionValues = [
      row.subscription_plan,
      row.subscription_status,
      row.subscription_cancel_at_period_end,
    ];
    const hasSubscription = subscriptionValues.every((value) => value !== null);
    if (!hasSubscription && subscriptionValues.some((value) => value !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Subscription snapshot is incomplete",
      });
    }

    const usageValues = [
      row.usage_period_start,
      row.usage_period_end,
      row.usage_included_sms_parts,
      row.usage_inbound_sms_parts,
      row.usage_outbound_sms_parts,
      row.usage_inbound_mms_events,
      row.usage_outbound_mms_events,
    ];
    const hasUsage = usageValues.every((value) => value !== null);
    if (!hasUsage && usageValues.some((value) => value !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Usage snapshot is incomplete",
      });
    }

    if (
      row.messaging_profile_configured !==
        (row.telnyx_messaging_profile_id !== null) ||
      row.campaign_configured !== (row.telnyx_campaign_id !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Messaging configuration flags are inconsistent",
      });
    }

    if (
      row.partner_id === null
        ? row.partner_name !== null || row.partner_slug !== null
        : row.partner_name === null || row.partner_slug === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Partner snapshot is inconsistent",
      });
    }

    const exactPhoneValues = [
      row.active_phone_number,
      row.active_phone_assignment_status,
    ];
    if (
      row.active_phone_count === 1
        ? exactPhoneValues.some((value) => value === null)
        : [
            ...exactPhoneValues,
            row.active_phone_assignment_campaign_id,
          ].some((value) => value !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Active phone snapshot is inconsistent",
      });
    }

    const assignmentMatchesCampaign =
      row.active_phone_count === 1 &&
      row.active_phone_assignment_status === "assigned" &&
      row.telnyx_campaign_id !== null &&
      row.active_phone_assignment_campaign_id === row.telnyx_campaign_id;
    if (
      row.active_phone_assignment_matches_campaign !==
        assignmentMatchesCampaign ||
      (row.active_phone_count <= 1 &&
        row.active_phone_assignment_failed !==
          (row.active_phone_count === 1 &&
            row.active_phone_assignment_status === "failed"))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Phone assignment flags are inconsistent",
      });
    }

    if (
      row.provisioning_job_count === 1
        ? row.provisioning_status === null
        : row.provisioning_status !== null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provisioning snapshot is inconsistent",
      });
    }

    if (
      row.failed_setup !== (row.failed_setup_reasons.length > 0) ||
      (!row.ai_configured &&
        (row.ai_booking_enabled !== null || row.ai_booking_mode !== null))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Health flags are inconsistent",
      });
    }
  });

type AdminBusinessHealthRpcRow = z.infer<typeof rpcRowSchema>;

export async function loadAdminAccountHealthList(
  filters: AdminAccountHealthFilters = {},
): Promise<AdminAccountHealthRecord[]> {
  const rows = await readHealthRows({
    p_business_id: null,
    p_lifecycle: filters.lifecycle ?? null,
    p_ownership: filters.ownership ?? null,
    p_partner: filters.partnerId ?? null,
    p_plan: filters.plan ?? null,
    p_query: filters.query ?? null,
  });
  return rows.map(normalizeRecord);
}

export async function loadAdminAccountHealth(
  businessId: string,
): Promise<AdminAccountHealth | null> {
  if (!z.string().uuid().safeParse(businessId).success) return null;
  const rows = await readHealthRows({
    p_business_id: businessId,
    p_lifecycle: null,
    p_ownership: null,
    p_partner: null,
    p_plan: null,
    p_query: null,
  });
  if (rows.length > 1) {
    throw new AdminAccountHealthReadError(
      "inconsistent_response",
      `Admin health lookup returned multiple rows for business ${businessId}.`,
    );
  }
  return rows[0] ? normalizeRecord(rows[0]).health : null;
}

async function readHealthRows(args: {
  p_business_id: string | null;
  p_lifecycle: AdminLifecycleHealthFilter | null;
  p_ownership: AdminOwnershipHealthFilter | null;
  p_partner: string | null;
  p_plan: SubscriptionPlan | null;
  p_query: string | null;
}): Promise<AdminBusinessHealthRpcRow[]> {
  const { data, error } = await supabaseAdmin.rpc(
    ADMIN_BUSINESS_HEALTH_RPC,
    args,
  );
  if (error) {
    throw new AdminAccountHealthReadError(
      "query_failed",
      "Could not load admin account health.",
      error,
    );
  }

  const parsed = z.array(rpcRowSchema).safeParse(data);
  if (!parsed.success) {
    throw new AdminAccountHealthReadError(
      "invalid_response",
      "Admin account health returned an invalid snapshot.",
      parsed.error,
    );
  }
  return parsed.data;
}

function normalizeRecord(
  row: AdminBusinessHealthRpcRow,
): AdminAccountHealthRecord {
  const subscription = row.subscription_plan
    ? {
        business_id: row.business_id,
        plan: row.subscription_plan,
        status: row.subscription_status!,
      }
    : undefined;
  const usage = row.usage_period_start
    ? {
        business_id: row.business_id,
        included_sms_parts: row.usage_included_sms_parts!,
        inbound_sms_parts: row.usage_inbound_sms_parts!,
        outbound_sms_parts: row.usage_outbound_sms_parts!,
        inbound_mms_events: row.usage_inbound_mms_events!,
        outbound_mms_events: row.usage_outbound_mms_events!,
        period_start: row.usage_period_start,
      }
    : undefined;
  const lifecycle = getAdminBusinessLifecycle({
    deletedAt: row.deleted_at,
    deletionScheduledFor: row.deletion_scheduled_for,
  });

  return {
    business: {
      id: row.business_id,
      name: row.business_name,
      website_url: row.website_url,
      business_type: row.business_type,
      a2p_risk_review_status: row.a2p_risk_review_status,
      a2p_risk_review_message: row.a2p_risk_review_message,
      onboarding_registration_status: row.onboarding_registration_status,
      brand_status: row.brand_status,
      campaign_status: row.campaign_status,
      partner_id: row.partner_id,
      billing_mode: row.billing_mode,
      partner_plan: row.partner_plan,
      partner:
        row.partner_name !== null && row.partner_slug !== null
          ? { name: row.partner_name, slug: row.partner_slug }
          : null,
      billing_pilot: row.billing_pilot,
      billing_comped: row.billing_comped,
      billing_exempt: row.billing_exempt,
      telnyx_submission_disabled: row.telnyx_submission_disabled,
      sms_overage_opt_in: row.sms_overage_opt_in,
      deleted_at: row.deleted_at,
      deletion_scheduled_for: row.deletion_scheduled_for,
      created_at: row.business_created_at,
    },
    subscription,
    usage,
    health: lifecycle === "terminal" ? null : normalizeHealth(row),
  };
}

function normalizeHealth(row: AdminBusinessHealthRpcRow): AdminAccountHealth {
  const entitlements = resolveEntitlements(row);
  if ((entitlements?.plan ?? null) !== row.effective_plan) {
    throw new AdminAccountHealthReadError(
      "inconsistent_response",
      `Admin health billing facts disagree for business ${row.business_id}.`,
    );
  }

  const smsReadiness =
    row.active_phone_count > 1
      ? null
      : reduceSmsReadinessSnapshot({
          hasActivePhone: row.active_phone_count === 1,
          phoneNumber: row.active_phone_number,
          messagingProfileId: row.telnyx_messaging_profile_id,
          campaignStatus: row.campaign_status,
          expectedCampaignId: row.telnyx_campaign_id,
          assignmentStatus: row.active_phone_assignment_status,
          assignedCampaignId: row.active_phone_assignment_campaign_id,
          assignmentFailureReason: null,
        });
  const health = normalizeAdminAccountHealth({
    businessId: row.business_id,
    now: row.snapshot_at,
    deletedAt: row.deleted_at,
    deletionScheduledFor: row.deletion_scheduled_for,
    operationsSuspendedAt: row.operations_suspended_at,
    aiRepliesPausedAt: row.ai_replies_paused_at,
    textingPausedAt: row.texting_paused_at,
    bookingsPausedAt: row.bookings_paused_at,
    onboardingCompletedAt: row.onboarding_completed_at,
    onboardingStep: row.onboarding_step as OnboardingStep,
    billingMode: row.billing_mode,
    subscriptionPresent: row.subscription_plan !== null,
    entitlements,
    activePhoneCount: row.active_phone_count,
    anyActivePhoneAssignmentFailed: row.active_phone_assignment_failed,
    smsReadiness,
    onboardingRegistrationStatus: row.onboarding_registration_status,
    onboardingRegistrationStartedAt: row.onboarding_registration_started_at,
    riskReviewStatus: row.a2p_risk_review_status,
    brandStatus: row.brand_status,
    campaignStatus: row.campaign_status,
    pendingPhoneFailed: row.pending_phone_number_failed,
    provisioning: {
      needsAttention: row.provisioning_needs_attention,
      inviteFailed: row.provisioning_invite_failed,
      expiredLease: row.provisioning_lease_expired,
    },
    calendarConnected: row.calendar_connected,
    aiConfigured: row.ai_configured,
    aiBookingEnabled: row.ai_booking_enabled ?? false,
    aiBookingMode: row.ai_booking_mode,
    webChatEnabled: row.web_chat_enabled,
    lastActivityAt: row.last_activity_at,
  });

  const normalizedReasons = health.failedSetup.reasons.map(
    (reason) => reason.code,
  );
  if (
    health.failedSetup.failed !== row.failed_setup ||
    !sameReasonCodes(normalizedReasons, row.failed_setup_reasons)
  ) {
    throw new AdminAccountHealthReadError(
      "inconsistent_response",
      `Admin health failure facts disagree for business ${row.business_id}.`,
    );
  }
  return health;
}

function resolveEntitlements(
  row: AdminBusinessHealthRpcRow,
): BusinessEntitlements | null {
  try {
    return resolveBusinessEntitlementsFromSnapshot(row.business_id, {
      business: {
        id: row.business_id,
        billing_mode: row.billing_mode,
        partner_plan: row.partner_plan,
        billing_pilot: row.billing_pilot,
        billing_comped: row.billing_comped,
        billing_exempt: row.billing_exempt,
      },
      subscription: row.subscription_plan
        ? {
            plan: row.subscription_plan,
            status: row.subscription_status,
            cancel_at_period_end: row.subscription_cancel_at_period_end,
          }
        : null,
    });
  } catch (error) {
    if (error instanceof EntitlementResolutionError) return null;
    throw error;
  }
}

function sameReasonCodes(
  left: readonly AdminFailedSetupReasonCode[],
  right: readonly AdminFailedSetupReasonCode[],
): boolean {
  return (
    left.length === right.length && left.every((code, index) => code === right[index])
  );
}
