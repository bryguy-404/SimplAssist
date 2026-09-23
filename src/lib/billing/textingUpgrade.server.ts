import "server-only";
import { getTextingUpgrade, parseTextingUpgrade, textingUpgradeRpc } from "./textingUpgradeStore.server";
export { getTextingUpgrade, parseTextingUpgrade, textingUpgradeRpc } from "./textingUpgradeStore.server";
import { resolveBusinessEntitlements } from "./entitlements";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getOnboardingCheckoutContextForBusinessIdReadOnly } from "@/lib/onboarding/state";
import { evaluateContentQuality } from "@/lib/contentQuality";
import { hasSmsProviderProvenance } from "@/lib/onboarding/acquisitionPolicy";
import { isPlanAvailable } from "@/lib/billing/planAvailability";
import { isTextingUpgradeEnabled } from "./textingUpgradeRollout.server";
import { TextingUpgradeError, TEXTING_UPGRADE_STEPS, type TextingUpgradeRecord, type TextingUpgradeState, type TextingUpgradeStep } from "./textingUpgrade";
import { operationSchema, view } from "@/lib/stripe/smsBilling.server";
import type { SmsBillingOperation } from "@/lib/stripe/smsBilling.server";
import type { SmsPlan } from "@/lib/stripe/smsBilling";
import type { OnboardingState } from "@/lib/onboarding/types";

export function textingUpgradeQuote(op: SmsBillingOperation) {
  return { ...view(op), quoteFingerprint: op.source_fingerprint, setupFeeCents: 2500 };
}

/** Actual requirements, never the completed signup timestamp or its saved step. */
export function textingUpgradeResumeStep(state: OnboardingState, upgrade: TextingUpgradeRecord | null, complianceComplete: boolean): TextingUpgradeStep {
  if (!upgrade || upgrade.state === "abandoned") return "plan";
  if (upgrade.paid_at || upgrade.state === "payment_pending") return "status";
  const b = state.businessInfo;
  if (!upgrade.business_confirmed_at || !b.name || b.name === "My Business" || !b.business_type || !b.phone || !b.email || !b.address || !b.city || !b.state || !b.zip ||
      state.businessHours.length < 7 || !evaluateContentQuality(state.servicesAndFaqs.services, state.servicesAndFaqs.faqs).ready || !state.aiSettings)
    return "business";
  const v = state.brandVerification;
  if (!v?.has_ein || !v.legal_business_name || !v.business_entity_type || !v.business_registration_state || !/^\d{2}-?\d{7}$/.test(v.ein ?? "") ||
      !v.authorized_rep_name || !v.authorized_rep_title || !v.authorized_rep_email || !v.authorized_rep_phone) return "verification";
  if (!complianceComplete || !["passed", "admin_approved"].includes(state.registration.riskReview.status) ||
      !v.use_case_description || !v.opt_in_description || !v.estimated_monthly_volume || !v.sample_messages || v.sample_messages.length < 3)
    return "use_case";
  if (!upgrade.phone_confirmed_at || !state.smsConsentAgreed || !state.phoneNumber || state.pendingPhoneNumberFailureReason) return "phone";
  return "review";
}

export async function loadTextingUpgradeContext(businessId: string, ownerId: string) {
  const [businessResult, subscriptionResult, upgrade, onboarding, phoneResult, providerHistory] = await Promise.all([
    supabaseAdmin.from("businesses").select("*").eq("id", businessId).maybeSingle(),
    supabaseAdmin.from("subscriptions").select("*").eq("business_id", businessId).maybeSingle(),
    getTextingUpgrade(businessId), getOnboardingCheckoutContextForBusinessIdReadOnly(businessId),
    supabaseAdmin.from("phone_numbers").select("phone_number,is_active,resource_status,telnyx_phone_number_id").eq("business_id", businessId).neq("resource_status", "released"),
    supabaseAdmin.from("telnyx_managed_resources").select("resource_type").eq("business_id", businessId).eq("local_claim_active", true).neq("ownership_state", "released"),
  ]);
  if (businessResult.error || subscriptionResult.error || phoneResult.error || providerHistory.error) throw new TextingUpgradeError("texting_upgrade_unavailable", 503);
  const b = businessResult.data;
  if (!b || b.owner_id !== ownerId || b.deleted_at || !onboarding) throw new TextingUpgradeError("texting_upgrade_forbidden", 403);
  if (upgrade && upgrade.owner_id !== ownerId) throw new TextingUpgradeError("texting_upgrade_forbidden", 403);
  // Initial Chat onboarding hides SMS fields by design. Upgrade setup reads its
  // own saved preference and ownership without invoking provider readiness.
  const activePhoneNumber = phoneResult.data?.find((phone) => phone.is_active)?.phone_number ?? null;
  const upgradeOnboarding: OnboardingState = { ...onboarding.state, activePhoneNumber,
    phoneNumber: activePhoneNumber ?? onboarding.state.pendingPhoneNumber };
  const s = subscriptionResult.data;
  let op: SmsBillingOperation | null = null;
  if (upgrade?.billing_operation_id) {
    const r = await supabaseAdmin.from("sms_billing_operations").select("*").eq("id", upgrade.billing_operation_id).eq("business_id", businessId).maybeSingle();
    if (r.error || !r.data) throw new TextingUpgradeError("texting_upgrade_unavailable", 503);
    op = operationSchema.parse(r.data);
  }
  const direct = b.billing_mode === "stripe" && !b.partner_id && !b.partner_plan && !b.operations_suspended_at && !b.billing_pilot && !b.billing_comped && !b.billing_exempt;
  const active = s?.status === "active" && !s.cancel_at_period_end && !s.pending_plan && Date.parse(s.current_period_end) > Date.now();
  const bound = !upgrade || (s?.stripe_subscription_id === upgrade.source_subscription_id && s?.stripe_customer_id === upgrade.source_customer_id);
  const draft = !upgrade || upgrade.state === "draft" || upgrade.state === "abandoned";
  let eligible = Boolean(direct && active && bound && b.onboarding_completed_at && s?.stripe_subscription_id && s?.stripe_customer_id &&
    (upgrade?.paid_at ? s.plan === upgrade.target_plan : s.plan === "chat_only"));
  if (draft && !upgrade?.paid_at) {
    const [history, conflicts, usageHistory, billingAccount, familyLock] = await Promise.all([
      supabaseAdmin.from("chat_only_checkout_attempts").select("state,stripe_subscription_id,stripe_customer_id").eq("business_id", businessId),
      supabaseAdmin.from("sms_billing_operations").select("id,state").eq("business_id", businessId).in("state", ["prepared", "confirming", "pending", "scheduled"]),
      supabaseAdmin.from("billing_usage_periods").select("id").eq("business_id", businessId).neq("plan", "chat_only").limit(1),
      supabaseAdmin.from("sms_billing_accounts").select("stripe_customer_id,setup_fee_paid_at").eq("business_id", businessId).maybeSingle(),
      supabaseAdmin.from("business_plan_family_locks").select("family").eq("business_id", businessId).maybeSingle(),
    ]);
    if (history.error || conflicts.error || providerHistory.error || usageHistory.error || billingAccount.error || familyLock.error) throw new TextingUpgradeError("texting_upgrade_unavailable", 503);
    eligible = eligible && familyLock.data?.family === "chat_only" && !(phoneResult.data ?? []).length && !(providerHistory.data ?? []).length && !(usageHistory.data ?? []).length &&
      !billingAccount.data?.setup_fee_paid_at && (!billingAccount.data?.stripe_customer_id || billingAccount.data.stripe_customer_id === s?.stripe_customer_id) && !hasSmsProviderProvenance({ business: b, hasActivePhoneNumber: Boolean(activePhoneNumber) }) &&
      !(history.data ?? []).some(a => !["completed", "expired"].includes(a.state)) &&
      (history.data ?? []).some(a => a.state === "completed" && a.stripe_subscription_id === s?.stripe_subscription_id && a.stripe_customer_id === s?.stripe_customer_id) &&
      !(conflicts.data ?? []).some(o => o.id !== upgrade?.billing_operation_id);
  }
  const hasOwnedPhoneResource = Boolean(phoneResult.data?.some((phone) => phone.is_active || phone.telnyx_phone_number_id) || providerHistory.data?.some((resource) => resource.resource_type === "phone_number"));
  return { hasOwnedPhoneResource, business: b, subscription: s, upgrade, operation: op, onboarding: upgradeOnboarding, eligible };
}

export async function getTextingUpgradeState(businessId: string, ownerId: string): Promise<TextingUpgradeState> {
  const context = await loadTextingUpgradeContext(businessId, ownerId);
  const { business, subscription, upgrade, operation: op, onboarding: o, eligible } = context;
  const entitlements = await resolveBusinessEntitlements(businessId);
  const enabled = isTextingUpgradeEnabled(businessId);
  const mutable = eligible && (!upgrade || ["draft", "abandoned"].includes(upgrade.state)) && (!op || ["prepared", "expired"].includes(op.state));
  const step = textingUpgradeResumeStep(o, upgrade, Boolean(business.compliance_info_completed_at));
  return {
    businessId, businessInfo: o.businessInfo, businessHours: o.businessHours, brandVerification: o.brandVerification,
    servicesAndFaqs: o.servicesAndFaqs, aiSettings: o.aiSettings, registration: o.registration, phoneNumber: o.phoneNumber,
    activePhoneNumber: o.activePhoneNumber, pendingPhoneNumber: o.pendingPhoneNumber, pendingPhoneNumberFailureReason: o.pendingPhoneNumberFailureReason,
    smsConsentAgreed: Boolean(upgrade?.phone_confirmed_at && o.smsConsentAgreed),
    upgrade: upgrade ? { id: upgrade.id, targetPlan: upgrade.target_plan, state: upgrade.state, starterAcknowledged: Boolean(upgrade.starter_acknowledged_at), paidAt: upgrade.paid_at, activatedAt: upgrade.activated_at } : null,
    eligible, enabled, message: !eligible ? "Contact support to help with this account’s texting upgrade." : !enabled ? "New texting upgrades are not available yet. Your saved setup and any payment already in progress are preserved." : null,
    currentStep: step, steps: TEXTING_UPGRADE_STEPS, availablePlans: (["sms_only", "sms_and_chat", "full"] as const).filter(isPlanAvailable),
    selectedPlan: upgrade?.target_plan ?? null, paidPlan: subscription?.plan ?? null,
    availableServicePlan: entitlements.active ? entitlements.plan : null,
    paymentStatus: upgrade?.paid_at ? "paid" : op?.state === "applied" ? "paid" : op?.state === "scheduled" ? "pending" : op?.state ?? "not_started",
    quote: op ? textingUpgradeQuote(op) : null,
    actions: { canSelect: mutable && (enabled || Boolean(upgrade && upgrade.state !== "abandoned")), canSave: mutable && Boolean(upgrade && upgrade.state === "draft"),
      canQuote: mutable && enabled && step === "review", canConfirm: eligible && enabled && step === "review" && op?.state === "prepared",
      canCancel: Boolean(upgrade && !upgrade.paid_at && !["abandoned", "activated"].includes(upgrade.state)),
      canRefresh: Boolean(upgrade), canReplacePhone: Boolean(eligible && upgrade?.paid_at && !upgrade.activated_at && !context.hasOwnedPhoneResource && !o.activePhoneNumber && o.pendingPhoneNumberFailureReason && !["rejected"].includes(o.registration.brandStatus ?? "") && o.registration.campaignStatus !== "rejected") },
  };
}
export async function selectTextingUpgrade(businessId: string, ownerId: string, plan: SmsPlan, starterAcknowledged = false) {
  const c = await loadTextingUpgradeContext(businessId, ownerId);
  if (!c.eligible) throw new TextingUpgradeError("texting_upgrade_support_required");
  if (!isPlanAvailable(plan)) throw new TextingUpgradeError("texting_upgrade_plan_unavailable");
  if ((!c.upgrade || c.upgrade.state === "abandoned") && !isTextingUpgradeEnabled(businessId)) throw new TextingUpgradeError("texting_upgrade_disabled");
  return parseTextingUpgrade(await textingUpgradeRpc("save_chat_texting_upgrade", { p_business_id: businessId, p_owner_id: ownerId, p_target_plan: plan, p_starter_acknowledged: starterAcknowledged }));
}
export async function requireTextingUpgradeReady(businessId: string, ownerId: string) {
  const c = await loadTextingUpgradeContext(businessId, ownerId);
  if (!c.eligible || !c.upgrade) throw new TextingUpgradeError("texting_upgrade_support_required");
  // Re-evaluate the forms even after claiming payment; the RPC freezes the same facts.
  const step = textingUpgradeResumeStep(c.onboarding, { ...c.upgrade, paid_at: null, state: "draft" }, Boolean(c.business.compliance_info_completed_at));
  if (step !== "review") throw new TextingUpgradeError("texting_upgrade_setup_incomplete");
  return c as typeof c & { upgrade: TextingUpgradeRecord };
}
