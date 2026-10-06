import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isReviewSmsEnabled } from "@/lib/billing/reviewSmsRollout.server";
import { customerReviewsBusinessExcluded } from "@/lib/billing/customerReviewsRollout";
import { isEmailReviewsEnabledForBusiness } from "@/lib/reviews/config";
import { isPlanAvailable } from "@/lib/billing/planAvailability";
import { isReviewTextingUpgradeEnabled } from "@/lib/billing/textingUpgradeRollout.server";
import { getTextingUpgradeState } from "@/lib/billing/textingUpgrade.server";
import { getSmsReadinessForBusinessReadOnly } from "@/lib/messaging/lookup";
import { chooseDashboardUpgradePrompt, type DashboardUpgradePrompt, type UpgradePromptPreference } from "./upgradePrompt";
import type { SubscriptionPlan } from "@/types/database";

/** Optional discovery fails closed and never blocks the main dashboard. */
export async function getDashboardUpgradePrompt(businessId: string, ownerId: string): Promise<DashboardUpgradePrompt | null> {
  if (process.env.DASHBOARD_UPGRADE_PROMPTS_ENABLED !== "1" || customerReviewsBusinessExcluded(businessId)) return null;
  try {
    const [business, subscription] = await Promise.all([
      supabaseAdmin.from("businesses").select("id,owner_id,billing_mode,partner_id,partner_plan,billing_pilot,billing_comped,billing_exempt,deleted_at,operations_suspended_at,texting_paused_at,onboarding_completed_at,telnyx_submission_disabled,active_telnyx_release_run_id")
        .eq("id", businessId).maybeSingle(),
      supabaseAdmin.from("subscriptions").select("plan,status,stripe_subscription_id,stripe_customer_id,current_period_start,current_period_end,cancel_at_period_end,pending_plan")
        .eq("business_id", businessId).maybeSingle(),
    ]);
    if (business.error || subscription.error) return null;
    const b = business.data, s = subscription.data;
    if (!b || !s || b.owner_id !== ownerId || b.deleted_at || b.operations_suspended_at || b.billing_mode !== "stripe" || b.partner_id || b.partner_plan || b.billing_pilot || b.billing_comped || b.billing_exempt || !b.onboarding_completed_at || s.status !== "active" || s.cancel_at_period_end || !s.stripe_subscription_id || !s.stripe_customer_id || !(Date.parse(s.current_period_start) <= Date.now() && Date.parse(s.current_period_end) > Date.now())) return null;
    if (!["chat_only", "sms_and_chat"].includes(s.plan)) return null;
    const [prefs, settings, review, upgrade, pending, pendingReview, activation, growthActivation] = await Promise.all([
      supabaseAdmin.from("dashboard_upgrade_preferences").select("offer_key,dismissal_count,snoozed_until,hidden_at,revision").eq("business_id", businessId),
      supabaseAdmin.from("review_settings").select("google_review_url,reply_to_verified_at,paused").eq("business_id", businessId).maybeSingle(),
      supabaseAdmin.from("review_sms_accounts").select("id,state,billing_source").eq("business_id", businessId).maybeSingle(),
      supabaseAdmin.from("chat_texting_upgrades").select("state,source_mode,activated_at").eq("business_id", businessId).neq("state", "abandoned").maybeSingle(),
      supabaseAdmin.from("sms_billing_operations").select("id").eq("business_id", businessId).in("state", ["prepared", "confirming", "pending", "scheduled"]).limit(1),
      supabaseAdmin.from("review_sms_billing_operations").select("id").eq("business_id", businessId).in("state", ["prepared", "confirmed", "unknown"]).limit(1),
      supabaseAdmin.from("review_sms_billing_operations").select("completed_at").eq("business_id", businessId).eq("kind", "recurring").eq("state", "completed").not("completed_at", "is", null).order("completed_at", { ascending: true }).limit(1).maybeSingle(),
      supabaseAdmin.from("sms_billing_operations").select("applied_at").eq("business_id", businessId).eq("stripe_subscription_id", s.stripe_subscription_id).eq("target_plan", "sms_and_chat").eq("state", "applied").order("applied_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if ([prefs, settings, review, upgrade, pending, pendingReview, activation, growthActivation].some(result => result.error)) return null;
    const featurePaused = Boolean(b.texting_paused_at || b.telnyx_submission_disabled || b.active_telnyx_release_run_id || settings.data?.paused);
    const hasPending = Boolean(s.pending_plan || pending.data?.length || pendingReview.data?.length);
    let growthEligible = false, voiceEligible = false;
    if (!featurePaused && !hasPending) {
      if (s.plan === "chat_only" && review.data?.state === "active" && review.data.billing_source === "direct" && isReviewTextingUpgradeEnabled(businessId)) {
        const state = await getTextingUpgradeState(businessId, ownerId);
        growthEligible = state.enabled && state.eligible && state.sourceMode === "review_sms";
      } else if (s.plan === "sms_and_chat" && isPlanAvailable("full")) {
        voiceEligible = (await getSmsReadinessForBusinessReadOnly(businessId)).smsReady;
      }
    }
    return chooseDashboardUpgradePrompt({
      plan: s.plan as SubscriptionPlan, eligibleBusiness: true, featurePaused,
      pendingBilling: Boolean(s.pending_plan || pending.data?.length),
      reviewPaymentPending: Boolean(pendingReview.data?.length),
      textingUpgrade: upgrade.data,
      reviewAccount: review.data,
      reviewEnabled: isReviewSmsEnabled(businessId) && isEmailReviewsEnabledForBusiness(businessId),
      reviewSettingsReady: Boolean(settings.data?.google_review_url && settings.data?.reply_to_verified_at),
      reviewActivatedAt: activation.data?.completed_at ?? null,
      growthActivatedAt: [upgrade.data?.activated_at, growthActivation.data?.applied_at]
        .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null,
      growthEligible, voiceEligible,
      preferences: (prefs.data ?? []) as UpgradePromptPreference[],
    });
  } catch {
    return null;
  }
}
