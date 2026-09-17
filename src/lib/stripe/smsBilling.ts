export type SmsPlan = "sms_only" | "sms_and_chat" | "full";
export class SmsBillingError extends Error {
  constructor(readonly code: string, readonly httpStatus = 409) { super(code); this.name = "SmsBillingError"; }
}
export type BillingChangeView = {
  operationId: string;
  kind: "checkout" | "upgrade" | "downgrade";
  state: "prepared" | "confirming" | "pending" | "scheduled" | "applied" | "expired";
  targetPlan: SmsPlan;
  amountDueCents: number;
  currency: string;
  monthlyPriceCents: number;
  effectiveAt: string;
  renewalAt: string | null;
  voiceSeconds: number;
  expiresAt: string;
  paymentUrl?: string;
};
