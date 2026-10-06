export type ReviewSmsState =
  | "draft"
  | "activation_pending"
  | "carrier_pending"
  | "ready_unpaid"
  | "active"
  | "cancel_pending"
  | "support_required"
  | "release_pending"
  | "released";
export type ReviewSmsAccount = {
  id: string;
  business_id: string;
  owner_id: string;
  state: ReviewSmsState;
  billing_source: "direct" | "included" | "grant";
  source_subscription_id: string | null;
  source_customer_id: string | null;
  draft: Record<string, unknown>;
  activation_paid_at: string | null;
  activation_payment_intent_id: string | null;
  activation_refunded_at: string | null;
  provider_started_at: string | null;
  provider_submitted_at: string | null;
  provider_attempt_count: number;
  review_usecase_approved_at: string | null;
  approval_evidence: string | null;
  phone_number_id: string | null;
  campaign_id: string | null;
  messaging_profile_id: string | null;
  exclusive_resources: boolean;
  ready_at: string | null;
  ready_expires_at: string | null;
  stripe_item_id: string | null;
  stripe_price_id: string | null;
  stripe_schedule_id: string | null;
  paid_period_start: string | null;
  paid_period_end: string | null;
  paid_invoice_id: string | null;
  period_allowance: number;
  cancel_at: string | null;
  release_at: string | null;
  grant_expires_at: string | null;
  last_error: string | null;
  created_at: string;
};
export type ReviewSmsQuote = {
  operationId: string;
  fingerprint: string;
  amountDueCents: number;
  monthlyPriceCents: number;
  ownerDiscountApplied?: boolean;
  includedParts: number;
  periodEnd: string;
  expiresAt: string;
};
export type ReviewSmsOverview = {
  enabled: boolean;
  account: ReviewSmsAccount | null;
  canSend: boolean;
  eligibleSource: "direct" | "included" | "grant";
  sharedRegistration?: {
    status: "approved" | "active" | "revoked";
    legalBusinessName: string;
    identityVersion: number;
    newPaidStartsAllowed?: boolean;
    activationRecoveryAvailable?: boolean;
  } | null;
  price: {
    monthlyCents: number;
    ownerDiscountApplied?: boolean;
    activationCents: number;
    includedParts: number;
  };
  quote?: ReviewSmsQuote;
  setup?: { fields: Record<string, string | boolean>; missing: string[] };
};
export class ReviewSmsError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(code);
    this.name = "ReviewSmsError";
  }
}
