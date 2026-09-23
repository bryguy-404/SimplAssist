import type { OnboardingState } from "@/lib/onboarding/types";
import type { SubscriptionPlan } from "@/types/database";
import type { BillingChangeView, SmsPlan } from "@/lib/stripe/smsBilling";

export const TEXTING_UPGRADE_STEPS = ["plan", "business", "verification", "use_case", "phone", "review", "status"] as const;
export type TextingUpgradeStep = (typeof TEXTING_UPGRADE_STEPS)[number];
export type TextingUpgradeStatus = "draft" | "payment_pending" | "carrier_pending" | "support_required" | "activated" | "abandoned";
export type TextingUpgradeRecord = {
  id: string; business_id: string; owner_id: string;
  source_subscription_id: string; source_customer_id: string;
  target_plan: SmsPlan; state: TextingUpgradeStatus;
  billing_operation_id: string | null; business_confirmed_at: string | null; phone_confirmed_at: string | null;
  starter_acknowledged_at: string | null; paid_at: string | null; activated_at: string | null;
  created_at: string; updated_at: string;
};
export type TextingUpgradeQuote = BillingChangeView & { quoteFingerprint: string; setupFeeCents: number };
export type TextingUpgradeState = Pick<OnboardingState,
  "businessId" | "businessInfo" | "businessHours" | "brandVerification" | "servicesAndFaqs" | "aiSettings" |
  "registration" | "phoneNumber" | "activePhoneNumber" | "pendingPhoneNumber" | "pendingPhoneNumberFailureReason" | "smsConsentAgreed"
> & {
  upgrade: { id: string; targetPlan: SmsPlan; state: TextingUpgradeStatus; starterAcknowledged: boolean; paidAt: string | null; activatedAt: string | null } | null;
  eligible: boolean; enabled: boolean; message: string | null;
  currentStep: TextingUpgradeStep; steps: readonly TextingUpgradeStep[];
  availablePlans: SmsPlan[]; selectedPlan: SmsPlan | null;
  paidPlan: SubscriptionPlan | null; availableServicePlan: SubscriptionPlan | null;
  paymentStatus: "not_started" | "prepared" | "confirming" | "pending" | "paid" | "expired";
  quote: TextingUpgradeQuote | null;
  actions: { canSelect: boolean; canSave: boolean; canQuote: boolean; canConfirm: boolean; canCancel: boolean; canRefresh: boolean; canReplacePhone: boolean };
};

export class TextingUpgradeError extends Error {
  constructor(readonly code: string, readonly httpStatus = 409) { super(code); this.name = "TextingUpgradeError"; }
}
