import type {
  A2pRiskChecklistAnswer,
  A2pRiskFinding,
  A2pRiskReviewStatus,
  A2pBrandTier,
  AITone,
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
  RegistrationHoldReason,
  RegistrationStatus,
  SmsBlockReason,
  SubscriptionPlan,
  SubscriptionStatus,
  BillingMode,
} from "@/types/database";

export type { OnboardingStep } from "@/types/database";

export const LEGACY_SMS_ONBOARDING_STEPS: OnboardingStep[] = [
  "business_info",
  "business_hours",
  "services_faqs",
  "ai_settings",
  "legal_verification",
  "sms_use_case",
  "phone_number",
  "review_submit",
  "carrier_review",
];

export const DIRECT_CHAT_ONBOARDING_STEPS: OnboardingStep[] = [
  "plan_selection",
  "business_info",
  "business_hours",
  "services_faqs",
  "ai_settings",
  "review_submit",
];

export const ONBOARDING_STEPS: OnboardingStep[] = [
  "plan_selection",
  "business_info",
  "business_hours",
  "services_faqs",
  "ai_settings",
  "legal_verification",
  "sms_use_case",
  "phone_number",
  "review_submit",
  "carrier_review",
];

export const ONBOARDING_STEP_LABELS: Record<OnboardingStep, string> = {
  business_info: "Business Info",
  business_hours: "Business Hours",
  services_faqs: "Assistant Knowledge",
  plan_selection: "Choose Plan",
  ai_settings: "AI Settings",
  legal_verification: "Business Verification",
  sms_use_case: "SMS Use Case",
  phone_number: "Phone Number",
  review_submit: "Review & Pay",
  carrier_review: "Carrier Review",
  complete: "Complete",
};

export interface OnboardingBusinessInfo {
  name: string;
  business_type: BusinessType;
  business_type_other?: string;
  website?: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  state: string;
  zip: string;
}

export interface OnboardingHours {
  day: string;
  is_closed: boolean;
  open_time: string;
  close_time: string;
}

export interface OnboardingService {
  name: string;
  description?: string;
  price?: string;
  source: KnowledgeSource;
}

export interface OnboardingFaq {
  question: string;
  answer: string;
  source: KnowledgeSource;
}

export interface OnboardingServicesAndFaqs {
  services: OnboardingService[];
  faqs: OnboardingFaq[];
}

export interface OnboardingAiSettings {
  tone: AITone;
  business_voice: BusinessVoice;
  language: Language;
  response_delay_seconds: number;
  web_greeting: string;
  guardrails?: string;
  booking_enabled: boolean;
  booking_mode?: "collect_info" | "schedule_direct";
}

export interface OnboardingBrandVerification {
  has_ein?: boolean | null;
  a2p_brand_tier?: A2pBrandTier | null;
  no_ein_hold_status?: NoEinHoldStatus;
  no_ein_waitlist_requested_at?: string | null;
  legal_business_name?: string;
  business_entity_type?: BusinessEntityType | null;
  business_registration_state?: string;
  ein?: string;
  authorized_rep_name?: string;
  authorized_rep_title?: string;
  authorized_rep_email?: string;
  authorized_rep_phone?: string;
  use_case_description?: string;
  estimated_monthly_volume?: string;
  sample_messages?: string[];
  opt_in_description?: string;
}

export interface OnboardingRegistrationSnapshot {
  status: OnboardingRegistrationStatus;
  holdReason: RegistrationHoldReason | null;
  startedAt: string | null;
  submittedAt: string | null;
  error: string | null;
  brandStatus: RegistrationStatus | null;
  brandStatusUpdatedAt: string | null;
  brandRejectionReason: string | null;
  campaignStatus: RegistrationStatus | null;
  campaignStatusUpdatedAt: string | null;
  campaignRejectionReason: string | null;
  assignmentStatus: CampaignAssignmentStatus | null;
  assignmentFailureReason: string | null;
  smsReady: boolean;
  smsBlockReason: SmsBlockReason | null;
  riskReview: OnboardingRiskReviewSnapshot;
}

export interface OnboardingBillingSnapshot {
  mode: BillingMode;
  handledByName: string | null;
  plan: SubscriptionPlan | null;
  status: SubscriptionStatus | null;
  setupFeePaidAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
}

export type OnboardingPlanSource =
  | "subscription"
  | "partner_plan"
  | "direct_intent"
  | "family_lock";

export type OnboardingPlanSelectionPosition = "start" | "after_knowledge" | null;

export interface OnboardingPlanSelectionSnapshot {
  position: OnboardingPlanSelectionPosition;
  familyChangeRequiresSupport: boolean;
  effectivePlan: SubscriptionPlan | null;
  source: OnboardingPlanSource | null;
  directIntent: SubscriptionPlan | null;
  canChooseDirectPlan: boolean;
  chatOnlyDirectSalesAvailable: boolean;
  chatOnlyCheckoutAvailable: boolean;
  chatOnlyCheckoutPaused: boolean;
}

export interface OnboardingRiskReviewSnapshot {
  status: A2pRiskReviewStatus;
  storedStatus: A2pRiskReviewStatus | null;
  inputHash: string | null;
  currentInputHash: string | null;
  message: string | null;
  reason: string | null;
  findings: A2pRiskFinding[];
  checklistAnswer: A2pRiskChecklistAnswer | null;
  checklistSelections: string[];
  scannedAt: string | null;
  notifiedAt: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  overrideNote: string | null;
  registrationStarted: boolean;
}

export interface OnboardingState {
  businessId: string;
  capabilities?: {
    richerWebsiteScanEnabled: boolean;
  };
  primaryGoal: PrimaryGoal | null;
  goalUrl: string | null;
  currentStep: OnboardingStep;
  currentStepNumber: number;
  totalSteps: number;
  steps: OnboardingStep[];
  dashboardReady: boolean;
  completedAt: string | null;
  lastSavedAt: string | null;
  businessInfo: OnboardingBusinessInfo;
  businessHours: OnboardingHours[];
  servicesAndFaqs: OnboardingServicesAndFaqs;
  aiSettings: OnboardingAiSettings | null;
  brandVerification: OnboardingBrandVerification | null;
  phoneNumber: string | null;
  activePhoneNumber: string | null;
  pendingPhoneNumber: string | null;
  pendingPhoneNumberFailureReason: string | null;
  smsConsentAgreed: boolean;
  billing: OnboardingBillingSnapshot;
  planSelection: OnboardingPlanSelectionSnapshot;
  registration: OnboardingRegistrationSnapshot;
}

export function onboardingStepsForPlan(args: {
  includePlanSelection: boolean;
  effectivePlan: SubscriptionPlan | null;
  planSelectionPosition?: OnboardingPlanSelectionPosition;
}): OnboardingStep[] {
  if (!args.includePlanSelection) {
    return args.effectivePlan === "chat_only"
      ? DIRECT_CHAT_ONBOARDING_STEPS.filter(
          (step) => step !== "plan_selection",
        )
      : LEGACY_SMS_ONBOARDING_STEPS;
  }

  const steps = args.effectivePlan === "chat_only"
    ? DIRECT_CHAT_ONBOARDING_STEPS
    : ONBOARDING_STEPS;
  if (args.planSelectionPosition === "start" && !args.effectivePlan) {
    return ["plan_selection"];
  }
  if (args.planSelectionPosition === "after_knowledge") {
    const legacyOrder: OnboardingStep[] = steps.filter(
      (step) => step !== "plan_selection",
    );
    legacyOrder.splice(legacyOrder.indexOf("services_faqs") + 1, 0, "plan_selection");
    return legacyOrder;
  }
  return steps;
}

export function onboardingStepNumber(
  step: OnboardingStep,
  steps: readonly OnboardingStep[] = ONBOARDING_STEPS,
): number {
  if (step === "complete") return steps.length;
  const index = steps.indexOf(step);
  return index === -1 ? 1 : index + 1;
}
