import "server-only";

import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  getSmsReadinessForBusiness,
  getSmsReadinessForBusinessReadOnly,
  type SmsReadiness,
} from "@/lib/messaging/lookup";
import type {
  A2pRiskChecklistAnswer,
  A2pRiskFinding,
  A2pRiskReviewStatus,
  A2pBrandTier,
  AITone,
  BillingMode,
  BusinessEntityType,
  BusinessType,
  BusinessVoice,
  CampaignAssignmentStatus,
  KnowledgeSource,
  Language,
  NoEinHoldStatus,
  OnboardingRegistrationStatus,
  OnboardingStep,
  PrimaryGoal,
  PrivacyTermsMode,
  RegistrationStatus,
  SubscriptionPlan,
  SubscriptionStatus,
} from "@/types/database";
import { resolveAssignedPartnerName } from "@/lib/billing/partnerManagedBilling.server";
import { isChatOnlyDirectAcquisitionEnabledForBusiness } from "@/lib/billing/chatOnlyRollout.server";
import { hasValidChatOnlyStripePrice } from "@/lib/stripe/config";
import {
  hashA2pRiskInput,
  registrationHasStartedForRisk,
} from "@/lib/messaging/registration/riskScreening";
import { evaluateContentQuality } from "@/lib/contentQuality";
import { isRicherWebsiteScanEnabledForBusiness } from "@/lib/website-scans/rollout.server";
import { hasSmsProviderProvenance } from "./acquisitionPolicy";
import {
  onboardingStepsForPlan,
  onboardingStepNumber,
  type OnboardingAiSettings,
  type OnboardingBrandVerification,
  type OnboardingBusinessInfo,
  type OnboardingFaq,
  type OnboardingHours,
  type OnboardingPlanSelectionPosition,
  type OnboardingService,
  type OnboardingState,
} from "./types";

const DAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const CHAT_ONLY_SMS_READINESS = {
  smsReady: false,
  blockReason: null,
  campaignStatus: null,
  assignmentStatus: null,
  assignmentFailureReason: null,
  phoneNumber: null,
  messagingProfileId: null,
} satisfies SmsReadiness;

type BusinessRow = {
  id: string;
  owner_id: string;
  partner_id: string | null;
  billing_mode: BillingMode;
  partner_plan: SubscriptionPlan | null;
  onboarding_selected_plan: SubscriptionPlan | null;
  deleted_at: string | null;
  operations_suspended_at: string | null;
  billing_pilot: boolean;
  billing_comped: boolean;
  billing_exempt: boolean;
  primary_goal: PrimaryGoal | null;
  goal_url: string | null;
  name: string | null;
  business_type: BusinessType | null;
  business_type_other: string | null;
  website_url: string | null;
  phone_number: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  sms_consent_agreed: boolean | null;
  legal_business_name: string | null;
  business_entity_type: BusinessEntityType | null;
  business_registration_state: string | null;
  tax_id_type: string | null;
  has_ein: boolean | null;
  a2p_brand_tier: A2pBrandTier | null;
  no_ein_hold_status: NoEinHoldStatus | null;
  no_ein_waitlist_requested_at: string | null;
  ein: string | null;
  authorized_rep_name: string | null;
  authorized_rep_title: string | null;
  authorized_rep_email: string | null;
  authorized_rep_phone: string | null;
  use_case_description: string | null;
  sample_messages: string[] | null;
  estimated_monthly_volume: string | null;
  opt_in_description: string | null;
  compliance_info_completed_at: string | null;
  pending_phone_number: string | null;
  pending_phone_number_area_code: string | null;
  pending_phone_number_selected_at: string | null;
  pending_phone_number_failure_reason: string | null;
  telnyx_submission_disabled: boolean | null;
  onboarding_step: OnboardingStep | null;
  onboarding_completed_at: string | null;
  onboarding_last_saved_at: string | null;
  onboarding_registration_status: OnboardingRegistrationStatus | null;
  onboarding_registration_started_at: string | null;
  onboarding_registration_submitted_at: string | null;
  onboarding_registration_error: string | null;
  a2p_risk_review_status: A2pRiskReviewStatus | null;
  a2p_risk_review_input_hash: string | null;
  a2p_risk_review_message: string | null;
  a2p_risk_review_reason: string | null;
  a2p_risk_review_findings: A2pRiskFinding[] | null;
  a2p_risk_review_customer_answer: A2pRiskChecklistAnswer | null;
  a2p_risk_review_customer_selections: string[] | null;
  a2p_risk_review_scanned_at: string | null;
  a2p_risk_review_notified_at: string | null;
  a2p_risk_review_reviewed_at: string | null;
  a2p_risk_review_reviewed_by: string | null;
  a2p_risk_review_override_note: string | null;
  privacy_terms_mode: PrivacyTermsMode;
  telnyx_brand_id: string | null;
  telnyx_campaign_id: string | null;
  telnyx_messaging_profile_id: string | null;
  telnyx_voice_application_id: string | null;
  active_telnyx_release_run_id: string | null;
  telnyx_resource_state: string | null;
  brand_status: RegistrationStatus | null;
  brand_status_updated_at: string | null;
  brand_rejection_reason: string | null;
  campaign_status: RegistrationStatus | null;
  campaign_status_updated_at: string | null;
  campaign_rejection_reason: string | null;
};

type HoursRow = {
  day_of_week: number;
  open_time: string;
  close_time: string;
  is_closed: boolean | null;
};

type ServiceRow = {
  name: string;
  description: string | null;
  price: string | null;
  source: KnowledgeSource;
};

type FaqRow = {
  question: string;
  answer: string;
  source: KnowledgeSource | null;
};

type AiSettingsRow = {
  tone: AITone | null;
  business_voice: BusinessVoice | null;
  language: Language | null;
  sms_response_delay_seconds: number | null;
  guardrails: string[] | null;
  booking_enabled: boolean | null;
  booking_mode: "collect_info" | "schedule_direct" | null;
};

type WidgetConfigRow = {
  welcome_message: string | null;
};

type PhoneNumberRow = {
  phone_number: string;
  telnyx_campaign_assignment_status: CampaignAssignmentStatus;
  telnyx_campaign_assignment_failure_reason: string | null;
};

type SubscriptionRow = {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  setup_fee_paid_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
};

type PlanFamilyLockRow = {
  family: string;
  claimed_by: string;
};

export interface OnboardingCheckoutContext {
  state: OnboardingState;
  freshInitialDirectAcquisition: boolean;
}

export async function getOnboardingStateForOwner(
  ownerId: string
): Promise<OnboardingState | null> {
  return getOnboardingStateForOwnerInternal(ownerId, true);
}

export async function getOnboardingStateForOwnerReadOnly(
  ownerId: string
): Promise<OnboardingState | null> {
  return getOnboardingStateForOwnerInternal(ownerId, false);
}

async function getOnboardingStateForOwnerInternal(
  ownerId: string,
  allowSideEffects: boolean
): Promise<OnboardingState | null> {
  const { data: business, error } = await supabaseAdmin
    .from("businesses")
    .select(
      [
        "id",
        "owner_id",
        "partner_id",
        "billing_mode",
        "partner_plan",
        "onboarding_selected_plan",
        "deleted_at",
        "operations_suspended_at",
        "billing_pilot",
        "billing_comped",
        "billing_exempt",
        "primary_goal",
        "goal_url",
        "name",
        "business_type",
        "business_type_other",
        "website_url",
        "phone_number",
        "email",
        "address",
        "city",
        "state",
        "zip",
        "sms_consent_agreed",
        "legal_business_name",
        "business_entity_type",
        "business_registration_state",
        "tax_id_type",
        "has_ein",
        "a2p_brand_tier",
        "no_ein_hold_status",
        "no_ein_waitlist_requested_at",
        "ein",
        "authorized_rep_name",
        "authorized_rep_title",
        "authorized_rep_email",
        "authorized_rep_phone",
        "use_case_description",
        "sample_messages",
        "estimated_monthly_volume",
        "opt_in_description",
        "compliance_info_completed_at",
        "pending_phone_number",
        "pending_phone_number_area_code",
        "pending_phone_number_selected_at",
        "pending_phone_number_failure_reason",
        "telnyx_submission_disabled",
        "onboarding_step",
        "onboarding_completed_at",
        "onboarding_last_saved_at",
        "onboarding_registration_status",
        "onboarding_registration_started_at",
        "onboarding_registration_submitted_at",
        "onboarding_registration_error",
        "a2p_risk_review_status",
        "a2p_risk_review_input_hash",
        "a2p_risk_review_message",
        "a2p_risk_review_reason",
        "a2p_risk_review_findings",
        "a2p_risk_review_customer_answer",
        "a2p_risk_review_customer_selections",
        "a2p_risk_review_scanned_at",
        "a2p_risk_review_notified_at",
        "a2p_risk_review_reviewed_at",
        "a2p_risk_review_reviewed_by",
        "a2p_risk_review_override_note",
        "privacy_terms_mode",
        "telnyx_brand_id",
        "telnyx_campaign_id",
        "telnyx_messaging_profile_id",
        "telnyx_voice_application_id",
        "active_telnyx_release_run_id",
        "telnyx_resource_state",
        "brand_status",
        "brand_status_updated_at",
        "brand_rejection_reason",
        "campaign_status",
        "campaign_status_updated_at",
        "campaign_rejection_reason",
      ].join(", ")
    )
    .eq("owner_id", ownerId)
    .single<BusinessRow>();

  if (error || !business || business.deleted_at !== null) {
    return null;
  }

  return getOnboardingStateForBusiness(business, allowSideEffects);
}

export async function getOnboardingStateForBusinessId(
  businessId: string
): Promise<OnboardingState | null> {
  const context = await getOnboardingContextForBusinessId(businessId, true);
  return context?.state ?? null;
}

/** Checkout validation must not synchronize progress or start provider work. */
export async function getOnboardingCheckoutContextForBusinessIdReadOnly(
  businessId: string,
): Promise<OnboardingCheckoutContext | null> {
  return getOnboardingContextForBusinessId(businessId, false);
}

async function getOnboardingContextForBusinessId(
  businessId: string,
  allowSideEffects: boolean,
): Promise<OnboardingCheckoutContext | null> {
  const { data: business, error } = await supabaseAdmin
    .from("businesses")
    .select(
      [
        "id",
        "owner_id",
        "partner_id",
        "billing_mode",
        "partner_plan",
        "onboarding_selected_plan",
        "deleted_at",
        "operations_suspended_at",
        "billing_pilot",
        "billing_comped",
        "billing_exempt",
        "primary_goal",
        "goal_url",
        "name",
        "business_type",
        "business_type_other",
        "website_url",
        "phone_number",
        "email",
        "address",
        "city",
        "state",
        "zip",
        "sms_consent_agreed",
        "legal_business_name",
        "business_entity_type",
        "business_registration_state",
        "tax_id_type",
        "has_ein",
        "a2p_brand_tier",
        "no_ein_hold_status",
        "no_ein_waitlist_requested_at",
        "ein",
        "authorized_rep_name",
        "authorized_rep_title",
        "authorized_rep_email",
        "authorized_rep_phone",
        "use_case_description",
        "sample_messages",
        "estimated_monthly_volume",
        "opt_in_description",
        "compliance_info_completed_at",
        "pending_phone_number",
        "pending_phone_number_area_code",
        "pending_phone_number_selected_at",
        "pending_phone_number_failure_reason",
        "telnyx_submission_disabled",
        "onboarding_step",
        "onboarding_completed_at",
        "onboarding_last_saved_at",
        "onboarding_registration_status",
        "onboarding_registration_started_at",
        "onboarding_registration_submitted_at",
        "onboarding_registration_error",
        "a2p_risk_review_status",
        "a2p_risk_review_input_hash",
        "a2p_risk_review_message",
        "a2p_risk_review_reason",
        "a2p_risk_review_findings",
        "a2p_risk_review_customer_answer",
        "a2p_risk_review_customer_selections",
        "a2p_risk_review_scanned_at",
        "a2p_risk_review_notified_at",
        "a2p_risk_review_reviewed_at",
        "a2p_risk_review_reviewed_by",
        "a2p_risk_review_override_note",
        "privacy_terms_mode",
        "telnyx_brand_id",
        "telnyx_campaign_id",
        "telnyx_messaging_profile_id",
        "telnyx_voice_application_id",
        "active_telnyx_release_run_id",
        "telnyx_resource_state",
        "brand_status",
        "brand_status_updated_at",
        "brand_rejection_reason",
        "campaign_status",
        "campaign_status_updated_at",
        "campaign_rejection_reason",
      ].join(", ")
    )
    .eq("id", businessId)
    .single<BusinessRow>();

  if (error || !business || business.deleted_at !== null) {
    return null;
  }

  return getOnboardingContextForBusiness(business, allowSideEffects);
}

async function getOnboardingStateForBusiness(
  business: BusinessRow,
  allowSideEffects = true
): Promise<OnboardingState> {
  return (await getOnboardingContextForBusiness(business, allowSideEffects)).state;
}

async function getOnboardingContextForBusiness(
  business: BusinessRow,
  allowSideEffects: boolean,
): Promise<OnboardingCheckoutContext> {
  const assignedPartnerNamePromise = resolveAssignedPartnerName(
    business.partner_id
  );

  const [
    { data: hours },
    { data: services },
    { data: faqs },
    { data: aiSettings },
    { data: widgetConfig },
    phoneNumberResult,
    subscriptionResult,
    familyLockResult,
    handledByName,
  ] = await Promise.all([
    supabaseAdmin
      .from("business_hours")
      .select("day_of_week, open_time, close_time, is_closed")
      .eq("business_id", business.id)
      .order("day_of_week", { ascending: true })
      .returns<HoursRow[]>(),
    supabaseAdmin
      .from("services")
      .select("name, description, price, source")
      .eq("business_id", business.id)
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .returns<ServiceRow[]>(),
    supabaseAdmin
      .from("faqs")
      .select("question, answer, source")
      .eq("business_id", business.id)
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .returns<FaqRow[]>(),
    supabaseAdmin
      .from("ai_settings")
      .select(
        "tone, business_voice, language, sms_response_delay_seconds, guardrails, booking_enabled, booking_mode"
      )
      .eq("business_id", business.id)
      .maybeSingle<AiSettingsRow>(),
    supabaseAdmin
      .from("widget_configs")
      .select("welcome_message")
      .eq("business_id", business.id)
      .maybeSingle<WidgetConfigRow>(),
    supabaseAdmin
      .from("phone_numbers")
      .select(
        "phone_number, telnyx_campaign_assignment_status, telnyx_campaign_assignment_failure_reason"
      )
      .eq("business_id", business.id)
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<PhoneNumberRow>(),
    supabaseAdmin
      .from("subscriptions")
      .select("plan, status, setup_fee_paid_at, current_period_start, current_period_end")
      .eq("business_id", business.id)
      .maybeSingle<SubscriptionRow>(),
    supabaseAdmin
      .from("business_plan_family_locks")
      .select("family, claimed_by")
      .eq("business_id", business.id)
      .maybeSingle<PlanFamilyLockRow>(),
    assignedPartnerNamePromise,
  ]);

  if (subscriptionResult.error) {
    throw new Error(
      `[onboarding:state] Failed to read subscription for ${business.id}: ${subscriptionResult.error.message}`,
    );
  }
  const subscription = subscriptionResult.data;
  if (phoneNumberResult.error) {
    throw new Error(
      `[onboarding:state] Failed to read phone-number ownership for ${business.id}: ${phoneNumberResult.error.message}`,
    );
  }
  const phoneNumber = phoneNumberResult.data;
  if (familyLockResult.error) {
    throw new Error(
      `[onboarding:state] Failed to read plan-family lock for ${business.id}: ${familyLockResult.error.message}`,
    );
  }
  const familyLock = familyLockResult.data;
  if (
    familyLock &&
    ((familyLock.family !== "sms" && familyLock.family !== "chat_only") ||
      typeof familyLock.claimed_by !== "string" ||
      familyLock.claimed_by.trim() === "")
  ) {
    throw new Error(
      `[onboarding:state] Malformed plan-family lock for ${business.id}`,
    );
  }

  // Resolve the plan before consulting SMS readiness. The side-effectful
  // readiness helper can lazily assign a phone number to a Telnyx campaign;
  // Chat Only must never enter that provider lifecycle, even when legacy SMS
  // rows are still attached to the business.
  const directBillingFlow =
    business.billing_mode === "stripe" &&
    business.partner_id === null &&
    business.partner_plan === null;
  const partnerAuthorityPlan =
    business.partner_id !== null &&
    (business.billing_mode === "invoiced" || business.billing_mode === "comped")
      ? business.partner_plan
      : null;
  const hasProtectedBillingOverride =
    business.billing_pilot !== false ||
    business.billing_comped !== false ||
    business.billing_exempt !== false;
  const directAcquisitionBusinessEligible =
    directBillingFlow &&
    business.deleted_at === null &&
    business.operations_suspended_at === null &&
    !hasProtectedBillingOverride;
  const directAcquisitionAvailable =
    directAcquisitionBusinessEligible &&
    isChatOnlyDirectAcquisitionEnabledForBusiness(business.id) &&
    hasValidChatOnlyStripePrice();
  const hasDurableDirectChatIntent =
    directBillingFlow &&
    !hasProtectedBillingOverride &&
    business.onboarding_selected_plan === "chat_only";
  const gatedDirectIntent =
    hasDurableDirectChatIntent
      ? "chat_only"
      : directAcquisitionAvailable
        ? business.onboarding_selected_plan
        : null;
  const authoritativePlan = subscription?.plan ?? partnerAuthorityPlan;
  if (
    familyLock &&
    authoritativePlan &&
    (authoritativePlan === "chat_only" ? "chat_only" : "sms") !==
      familyLock.family
  ) {
    throw new Error(
      `[onboarding:state] Plan-family authority conflict for ${business.id}`,
    );
  }
  const directIntent =
    gatedDirectIntent &&
    (!familyLock ||
      (gatedDirectIntent === "chat_only" ? "chat_only" : "sms") ===
        familyLock.family)
      ? gatedDirectIntent
      : null;
  const hasDurableChatFamilyLock = familyLock?.family === "chat_only";
  const effectivePlan =
    authoritativePlan ??
    (hasDurableChatFamilyLock ? "chat_only" : null) ??
    directIntent ??
    null;
  const planSource = subscription
    ? "subscription"
    : partnerAuthorityPlan
      ? "partner_plan"
      : hasDurableChatFamilyLock
        ? "family_lock"
        : directIntent
          ? "direct_intent"
          : null;
  const smsReadiness =
    effectivePlan === "chat_only"
      ? CHAT_ONLY_SMS_READINESS
      : !allowSideEffects
        ? await getSmsReadinessForBusinessReadOnly(business.id)
        : await getSmsReadinessForBusiness(business.id);
  const normalizedHours = normalizeHours(hours ?? []);
  const normalizedServices = normalizeServices(services ?? []);
  const normalizedFaqs = normalizeFaqs(faqs ?? []);
  const normalizedAiSettings = normalizeAiSettings(
    aiSettings ?? null,
    widgetConfig ?? null,
    business.name ?? "Your Business"
  );
  const brandVerification = normalizeBrandVerification(business);
  const registrationStarted = registrationHasStarted(business);
  const riskReview = normalizeRiskReview({
    business,
    services: normalizedServices,
    faqs: normalizedFaqs,
    registrationStarted,
  });
  const activePhone =
    effectivePlan === "chat_only"
      ? null
      : smsReadiness.phoneNumber ?? phoneNumber?.phone_number ?? null;
  const phone =
    effectivePlan === "chat_only"
      ? null
      : activePhone ?? business.pending_phone_number ?? null;
  const canChooseDirectPlan =
    directAcquisitionAvailable &&
    !subscription &&
    !hasDurableChatFamilyLock;
  const smsProviderProvenance =
    smsReadiness.smsReady ||
    hasSmsProviderProvenance({
      business,
      hasActivePhoneNumber: Boolean(
        phoneNumber?.phone_number || smsReadiness.phoneNumber,
      ),
    });
  const freshInitialDirectAcquisition =
    directAcquisitionBusinessEligible &&
    !subscription &&
    !familyLock &&
    !smsProviderProvenance &&
    !business.onboarding_completed_at;
  const planSelectionPosition: OnboardingPlanSelectionPosition =
    !canChooseDirectPlan
      ? null
      : freshInitialDirectAcquisition
        ? "start"
        : "after_knowledge";
  const chatOnlySubscriptionStatus =
    subscription?.plan === "chat_only" ? subscription.status : null;
  const chatOnlyCheckoutAvailable =
    effectivePlan === "chat_only" &&
    directBillingFlow &&
    (chatOnlySubscriptionStatus === "active" ||
      chatOnlySubscriptionStatus === "trialing" ||
      (subscription === null &&
        directAcquisitionAvailable));
  const chatOnlyCheckoutPaused =
    effectivePlan === "chat_only" &&
    !chatOnlyCheckoutAvailable &&
    chatOnlySubscriptionStatus !== "past_due" &&
    planSource !== "partner_plan" &&
    (hasDurableChatFamilyLock ||
      hasDurableDirectChatIntent ||
      chatOnlySubscriptionStatus === "canceled");
  const chatOnlyAuthorityActive =
    effectivePlan === "chat_only" &&
    (planSource === "partner_plan" ||
      (planSource === "subscription" &&
        canResumeChatOnlyOnboarding(
          subscription?.status ?? null,
          business.onboarding_completed_at,
        )));
  const includePlanSelection = canChooseDirectPlan;
  const steps = onboardingStepsForPlan({
    includePlanSelection,
    effectivePlan,
    planSelectionPosition,
  });
  const derivedStep = deriveOnboardingStep({
    business,
    hours: normalizedHours,
    services: normalizedServices,
    faqs: normalizedFaqs,
    aiSettings: normalizedAiSettings,
    phoneNumber: phone,
    activePhoneNumber: activePhone,
    smsReady: smsReadiness.smsReady,
    riskCleared:
      riskReview.status === "passed" || riskReview.status === "admin_approved",
    effectivePlan,
    requiresDirectPlanSelection: canChooseDirectPlan,
    planSelectionPosition,
    chatOnlyAuthorityActive,
  });
  const coreOnboardingComplete = hasCoreOnboardingFacts({
    business,
    hours: normalizedHours,
    services: normalizedServices,
    faqs: normalizedFaqs,
    aiSettings: normalizedAiSettings,
  });
  const chatOnlyReady =
    chatOnlyAuthorityActive &&
    coreOnboardingComplete &&
    business.onboarding_completed_at !== null;
  const onboardingReady =
    effectivePlan === "chat_only" ? chatOnlyReady : smsReadiness.smsReady;
  const completedAt =
    allowSideEffects &&
    smsReadiness.smsReady &&
    !business.onboarding_completed_at
      ? new Date().toISOString()
      : business.onboarding_completed_at;

  if (allowSideEffects) {
    await syncStoredProgress({
      business,
      derivedStep,
      completedAt,
      onboardingReady,
      syncSmsRegistrationState: effectivePlan !== "chat_only",
    });
  }

  const state: OnboardingState = {
    businessId: business.id,
    capabilities: {
      richerWebsiteScanEnabled:
        isRicherWebsiteScanEnabledForBusiness(business.id),
    },
    primaryGoal: business.primary_goal,
    goalUrl: business.goal_url,
    currentStep: derivedStep,
    currentStepNumber: onboardingStepNumber(derivedStep, steps),
    totalSteps: steps.length,
    steps,
    dashboardReady: onboardingReady && business.primary_goal !== null,
    completedAt,
    lastSavedAt: business.onboarding_last_saved_at,
    businessInfo: normalizeBusinessInfo(business),
    businessHours: normalizedHours,
    servicesAndFaqs: {
      services: normalizedServices,
      faqs: normalizedFaqs,
    },
    aiSettings: normalizedAiSettings,
    brandVerification,
    phoneNumber: phone,
    activePhoneNumber: activePhone,
    pendingPhoneNumber: business.pending_phone_number,
    pendingPhoneNumberFailureReason: business.pending_phone_number_failure_reason,
    smsConsentAgreed: Boolean(business.sms_consent_agreed),
    billing: {
      mode: business.billing_mode,
      handledByName,
      plan: subscription?.plan ?? null,
      status: subscription?.status ?? null,
      setupFeePaidAt: subscription?.setup_fee_paid_at ?? null,
      currentPeriodStart: subscription?.current_period_start ?? null,
      currentPeriodEnd: subscription?.current_period_end ?? null,
    },
    planSelection: {
      position: planSelectionPosition,
      familyChangeRequiresSupport:
        directBillingFlow && Boolean(familyLock || smsProviderProvenance),
      effectivePlan,
      source: planSource,
      directIntent,
      canChooseDirectPlan,
      chatOnlyDirectSalesAvailable:
        canChooseDirectPlan &&
        directAcquisitionAvailable &&
        familyLock?.family !== "sms" &&
        !smsProviderProvenance,
      chatOnlyCheckoutAvailable,
      chatOnlyCheckoutPaused,
    },
    registration: {
      status: normalizeRegistrationStatus(business),
      holdReason: business.has_ein === true ? null : "held_no_ein",
      startedAt: business.onboarding_registration_started_at,
      submittedAt: business.onboarding_registration_submitted_at,
      error: business.onboarding_registration_error,
      brandStatus: business.brand_status,
      brandStatusUpdatedAt: business.brand_status_updated_at,
      brandRejectionReason: business.brand_rejection_reason,
      campaignStatus: business.campaign_status,
      campaignStatusUpdatedAt: business.campaign_status_updated_at,
      campaignRejectionReason: business.campaign_rejection_reason,
      assignmentStatus:
        effectivePlan === "chat_only"
          ? null
          : smsReadiness.assignmentStatus ??
            phoneNumber?.telnyx_campaign_assignment_status ??
            null,
      assignmentFailureReason:
        effectivePlan === "chat_only"
          ? null
          : smsReadiness.assignmentFailureReason ??
            phoneNumber?.telnyx_campaign_assignment_failure_reason ??
            null,
      smsReady: smsReadiness.smsReady,
      smsBlockReason: smsReadiness.blockReason,
      riskReview,
    },
  };
  return { state, freshInitialDirectAcquisition };
}

function normalizeBusinessInfo(business: BusinessRow): OnboardingBusinessInfo {
  return {
    name: business.name ?? "",
    business_type: business.business_type ?? "general",
    business_type_other: business.business_type_other ?? "",
    website: business.website_url ?? "",
    phone: business.phone_number ?? "",
    email: business.email ?? "",
    address: business.address ?? "",
    city: business.city ?? "",
    state: business.state ?? "",
    zip: business.zip ?? "",
  };
}

function normalizeHours(rows: HoursRow[]): OnboardingHours[] {
  if (rows.length === 0) return [];

  return rows
    .filter((row) => row.day_of_week >= 0 && row.day_of_week <= 6)
    .map((row) => ({
      day: DAYS[row.day_of_week] ?? "monday",
      is_closed: Boolean(row.is_closed),
      open_time: toTimeInput(row.open_time),
      close_time: toTimeInput(row.close_time),
    }));
}

function normalizeServices(rows: ServiceRow[]): OnboardingService[] {
  return rows.map((row) => ({
    name: row.name,
    description: row.description ?? "",
    price: row.price ?? "",
    source: row.source,
  }));
}

function normalizeFaqs(rows: FaqRow[]): OnboardingFaq[] {
  return rows.map((row) => ({
    question: row.question,
    answer: row.answer,
    source: row.source ?? "manual",
  }));
}

function normalizeAiSettings(
  ai: AiSettingsRow | null,
  widget: WidgetConfigRow | null,
  businessName: string
): OnboardingAiSettings | null {
  if (!ai) return null;

  return {
    tone: ai.tone ?? "balanced",
    business_voice: ai.business_voice ?? "we",
    language: ai.language ?? "en",
    response_delay_seconds: ai.sms_response_delay_seconds ?? 5,
    web_greeting:
      widget?.welcome_message ??
      `Hi! I'm ${businessName}'s assistant. Ask me anything about our services.`,
    guardrails: (ai.guardrails ?? []).join("\n"),
    booking_enabled: Boolean(ai.booking_enabled),
    booking_mode: ai.booking_mode ?? "collect_info",
  };
}

function normalizeBrandVerification(
  business: BusinessRow
): OnboardingBrandVerification | null {
  if (
    business.has_ein === null &&
    !business.legal_business_name &&
    !business.ein &&
    !business.authorized_rep_name &&
    !business.use_case_description
  ) {
    return null;
  }

  return {
    has_ein: business.has_ein,
    a2p_brand_tier: business.a2p_brand_tier,
    no_ein_hold_status: business.no_ein_hold_status ?? "none",
    no_ein_waitlist_requested_at: business.no_ein_waitlist_requested_at,
    legal_business_name: business.legal_business_name ?? "",
    business_entity_type: business.business_entity_type,
    business_registration_state: business.business_registration_state ?? "",
    ein: business.ein ?? "",
    authorized_rep_name: business.authorized_rep_name ?? "",
    authorized_rep_title: business.authorized_rep_title ?? "",
    authorized_rep_email: business.authorized_rep_email ?? "",
    authorized_rep_phone: business.authorized_rep_phone ?? "",
    use_case_description: business.use_case_description ?? "",
    estimated_monthly_volume: business.estimated_monthly_volume ?? "",
    sample_messages: business.sample_messages ?? [],
    opt_in_description: business.opt_in_description ?? "",
  };
}

function normalizeRiskReview(args: {
  business: BusinessRow;
  services: OnboardingService[];
  faqs: OnboardingFaq[];
  registrationStarted: boolean;
}) {
  const { business, services, faqs, registrationStarted } = args;
  const currentInputHash = hashA2pRiskInput({
    businessId: business.id,
    businessName: business.name ?? "Your Business",
    businessType: business.business_type,
    businessTypeOther: business.business_type_other,
    websiteUrl: business.website_url,
    services: services.map((service) => ({
      name: service.name,
      description: service.description ?? null,
    })),
    faqs: faqs.map((faq) => ({
      question: faq.question,
      answer: faq.answer,
    })),
    useCaseDescription: business.use_case_description ?? "",
    sampleMessages: business.sample_messages ?? [],
    optInDescription: business.opt_in_description ?? "",
    checklistAnswer: business.a2p_risk_review_customer_answer,
    checklistSelections: business.a2p_risk_review_customer_selections ?? [],
  });
  const storedStatus = business.a2p_risk_review_status;
  const hashMatches =
    Boolean(business.a2p_risk_review_input_hash) &&
    business.a2p_risk_review_input_hash === currentInputHash;
  const effectiveStatus: A2pRiskReviewStatus = registrationStarted
    ? (storedStatus ?? "not_started")
    : hashMatches
      ? (storedStatus ?? "not_started")
      : "not_started";

  return {
    status: effectiveStatus,
    storedStatus,
    inputHash: business.a2p_risk_review_input_hash,
    currentInputHash,
    message: hashMatches ? business.a2p_risk_review_message : null,
    reason: hashMatches ? business.a2p_risk_review_reason : null,
    findings: hashMatches ? business.a2p_risk_review_findings ?? [] : [],
    checklistAnswer: business.a2p_risk_review_customer_answer,
    checklistSelections: business.a2p_risk_review_customer_selections ?? [],
    scannedAt: hashMatches ? business.a2p_risk_review_scanned_at : null,
    notifiedAt: hashMatches ? business.a2p_risk_review_notified_at : null,
    reviewedAt: hashMatches ? business.a2p_risk_review_reviewed_at : null,
    reviewedBy: hashMatches ? business.a2p_risk_review_reviewed_by : null,
    overrideNote: hashMatches ? business.a2p_risk_review_override_note : null,
    registrationStarted,
  };
}

export function deriveOnboardingStep(args: {
  business: BusinessRow;
  hours: OnboardingHours[];
  services: OnboardingService[];
  faqs: OnboardingFaq[];
  aiSettings: OnboardingAiSettings | null;
  phoneNumber: string | null;
  activePhoneNumber: string | null;
  smsReady: boolean;
  riskCleared: boolean;
  effectivePlan?: SubscriptionPlan | null;
  requiresDirectPlanSelection?: boolean;
  planSelectionPosition?: OnboardingPlanSelectionPosition;
  chatOnlyAuthorityActive?: boolean;
}): OnboardingStep {
  const {
    business,
    hours,
    services,
    faqs,
    aiSettings,
    phoneNumber,
    activePhoneNumber,
    smsReady,
    riskCleared,
    effectivePlan = null,
    requiresDirectPlanSelection = false,
    planSelectionPosition = "after_knowledge",
    chatOnlyAuthorityActive = false,
  } = args;

  if (
    planSelectionPosition === "start" &&
    requiresDirectPlanSelection &&
    !effectivePlan
  ) {
    return "plan_selection";
  }

  if (business.primary_goal === null) {
    if (!hasBusinessInfo(business)) return "business_info";
    if (hours.length < 7) return "business_hours";
    if (!evaluateContentQuality(services, faqs).ready) return "services_faqs";
    if (requiresDirectPlanSelection && !effectivePlan) return "plan_selection";
    return "ai_settings";
  }

  if (effectivePlan === "chat_only") {
    if (!hasBusinessInfo(business)) return "business_info";
    if (hours.length < 7) return "business_hours";
    if (!evaluateContentQuality(services, faqs).ready) return "services_faqs";
    if (!aiSettings) return "ai_settings";
    return chatOnlyAuthorityActive && business.onboarding_completed_at
      ? "complete"
      : "review_submit";
  }

  if (smsReady || business.onboarding_completed_at) return "complete";

  // A failed pre-purchase selection must route back to the number picker even
  // when an earlier launch attempt already saved/approved the brand. Without
  // this exception, the saved brand makes registrationHasStarted true and the
  // carrier-review shortcut hides the only corrective action. An active owned
  // number is different: its lifecycle is already provider-managed, so a stale
  // pending-number failure must never pull it back into the pre-purchase picker.
  const hasPendingNumberFailure = Boolean(
    !activePhoneNumber &&
      business.onboarding_registration_status === "failed" &&
      business.pending_phone_number_failure_reason
  );

  if (registrationHasStarted(business) && !hasPendingNumberFailure) {
    return "carrier_review";
  }

  if (!hasBusinessInfo(business)) return "business_info";
  if (hours.length < 7) return "business_hours";
  if (!evaluateContentQuality(services, faqs).ready) return "services_faqs";
  if (requiresDirectPlanSelection && !effectivePlan) return "plan_selection";
  if (hasPendingNumberFailure) {
    return "phone_number";
  }
  if (!aiSettings) return "ai_settings";
  if (!hasLegalVerification(business)) return "legal_verification";
  if (!hasCompletedComplianceInfo(business, riskCleared)) return "sms_use_case";
  if (!phoneNumber) return "phone_number";

  return "review_submit";
}

function hasBusinessInfo(business: BusinessRow): boolean {
  return Boolean(
    business.name &&
      business.name !== "My Business" &&
      business.business_type &&
      business.phone_number &&
      business.email &&
      business.address &&
      business.city &&
      business.state &&
      business.zip
  );
}

function hasLegalVerification(business: BusinessRow): boolean {
  return Boolean(
    business.has_ein === true &&
      business.legal_business_name &&
      business.business_entity_type &&
      business.business_registration_state &&
      business.ein &&
      business.authorized_rep_name &&
      business.authorized_rep_title &&
      business.authorized_rep_email &&
      business.authorized_rep_phone
  );
}

function hasCompletedComplianceInfo(
  business: BusinessRow,
  riskCleared: boolean
): boolean {
  return Boolean(
    riskCleared &&
      business.compliance_info_completed_at &&
      business.use_case_description &&
      business.estimated_monthly_volume &&
      business.opt_in_description &&
      business.sample_messages &&
      business.sample_messages.length >= 3
  );
}

function registrationHasStarted(business: BusinessRow): boolean {
  return registrationHasStartedForRisk(business);
}

function normalizeRegistrationStatus(
  business: BusinessRow
): OnboardingRegistrationStatus {
  if (business.onboarding_registration_status) {
    return business.onboarding_registration_status;
  }
  return business.telnyx_brand_id ? "submitted" : "not_started";
}

async function syncStoredProgress(args: {
  business: BusinessRow;
  derivedStep: OnboardingStep;
  completedAt: string | null;
  onboardingReady: boolean;
  syncSmsRegistrationState: boolean;
}): Promise<void> {
  const {
    business,
    derivedStep,
    completedAt,
    onboardingReady,
    syncSmsRegistrationState,
  } = args;
  const update: Record<string, unknown> = {};

  if (business.onboarding_step !== derivedStep) {
    update.onboarding_step = derivedStep;
  }

  if (onboardingReady && !business.onboarding_completed_at && completedAt) {
    update.onboarding_completed_at = completedAt;
    update.onboarding_last_saved_at = completedAt;
  }

  const shouldMarkSubmittedFromExistingTelnyxId =
    syncSmsRegistrationState &&
    Boolean(business.telnyx_brand_id) &&
    (business.onboarding_registration_status == null ||
      (business.onboarding_registration_status === "not_started" &&
        !business.onboarding_registration_started_at &&
        !business.onboarding_registration_error));

  if (shouldMarkSubmittedFromExistingTelnyxId) {
    update.onboarding_registration_status = "submitted";
    update.onboarding_registration_submitted_at =
      business.onboarding_registration_submitted_at ??
      business.campaign_status_updated_at ??
      business.brand_status_updated_at ??
      new Date().toISOString();
    update.onboarding_registration_error = null;
  }

  if (Object.keys(update).length === 0) return;

  const { error } = await supabaseAdmin
    .from("businesses")
    .update(update)
    .eq("id", business.id);

  if (error) {
    console.error(
      `[onboarding:state] Failed to sync progress for business ${business.id}:`,
      error
    );
  }
}

function hasCoreOnboardingFacts(args: {
  business: BusinessRow;
  hours: OnboardingHours[];
  services: OnboardingService[];
  faqs: OnboardingFaq[];
  aiSettings: OnboardingAiSettings | null;
}): boolean {
  return Boolean(
    args.business.primary_goal !== null &&
      hasBusinessInfo(args.business) &&
      args.hours.length >= 7 &&
      evaluateContentQuality(args.services, args.faqs).ready &&
      args.aiSettings,
  );
}

function canResumeChatOnlyOnboarding(
  status: SubscriptionStatus | null,
  completedAt: string | null,
): boolean {
  return (
    status === "active" ||
    status === "trialing" ||
    (status === "past_due" && completedAt !== null)
  );
}

function toTimeInput(value: string): string {
  return value.slice(0, 5);
}
