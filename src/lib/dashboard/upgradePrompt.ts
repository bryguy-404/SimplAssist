import type { SubscriptionPlan } from "@/types/database";

export const UPGRADE_OFFER_KEYS = ["review_texting", "growth", "voice"] as const;
export type UpgradeOfferKey = (typeof UPGRADE_OFFER_KEYS)[number];
export type UpgradePromptPreference = {
  offer_key: UpgradeOfferKey;
  dismissal_count: number;
  snoozed_until: string | null;
  hidden_at: string | null;
  revision: number;
};
export type DashboardUpgradePrompt = {
  kind: "offer" | "progress";
  offerKey: UpgradeOfferKey;
  title: string;
  description: string;
  actionLabel: string;
  href: string;
  revision: number;
};
export const REVIEW_TEXTING_SETTINGS_HREF = "/reviews?tab=settings#review-sms";
export const REVIEW_TEXTING_UPGRADE_HREF = "/billing/add-texting?plan=sms_and_chat";

const COPY: Record<UpgradeOfferKey, Omit<DashboardUpgradePrompt, "kind" | "offerKey" | "revision">> = {
  review_texting: {
    title: "Make leaving a review easier",
    description: "Send customers a friendly text after a completed job, with a direct link to share their experience.",
    actionLabel: "Explore text reminders", href: REVIEW_TEXTING_SETTINGS_HREF,
  },
  growth: {
    title: "Keep the conversation going after a missed call",
    description: "Follow up when you can’t answer, and let your assistant help with questions and appointment requests.",
    actionLabel: "Explore missed-call follow-up", href: REVIEW_TEXTING_UPGRADE_HREF,
  },
  voice: {
    title: "Give callers an answer when you’re busy",
    description: "Let your assistant answer calls, respond to questions, and help customers take the next step.",
    actionLabel: "Explore voice answering", href: "/billing?upgrade=full#plan-change",
  },
};

export type UpgradePromptSnapshot = {
  plan: SubscriptionPlan;
  eligibleBusiness: boolean;
  featurePaused: boolean;
  pendingBilling: boolean;
  reviewPaymentPending: boolean;
  textingUpgrade: { state: string; source_mode?: string } | null;
  reviewAccount: { state: string; billing_source: string } | null;
  reviewEnabled: boolean;
  reviewSettingsReady: boolean;
  hasAcceptedReviewEmail: boolean;
  reviewActivatedAt: string | null;
  growthActivatedAt: string | null;
  growthEligible: boolean;
  voiceEligible: boolean;
  preferences: UpgradePromptPreference[];
};

function mature(value: string | null, now: number): boolean {
  return Boolean(value && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now - 7 * 86400_000);
}
function progress(offerKey: UpgradeOfferKey, title: string, description: string, href: string): DashboardUpgradePrompt {
  return { kind: "progress", offerKey, title, description, actionLabel: "View setup status", href, revision: 0 };
}
/** Pure decision: no provider, payment, or preference writes while viewing a dashboard. */
export function chooseDashboardUpgradePrompt(s: UpgradePromptSnapshot, now = Date.now()): DashboardUpgradePrompt | null {
  if (!s.eligibleBusiness) return null;
  if (s.textingUpgrade && !["activated", "abandoned"].includes(s.textingUpgrade.state)) {
    return progress("growth", s.textingUpgrade.state === "draft" ? "Continue your texting setup" : "Your texting upgrade is in progress",
      "Review your saved setup and any next steps. Your current plan remains available while we confirm the change.", REVIEW_TEXTING_UPGRADE_HREF);
  }
  if (s.pendingBilling) return progress("voice", "A billing change is in progress", "Check its status before starting another change.", "/billing#plan-change");
  const a = s.reviewAccount;
  if (s.plan === "chat_only" && s.reviewEnabled && a && !["active", "cancel_pending", "release_pending", "released"].includes(a.state)) {
    const draft = a.state === "draft";
    return progress("review_texting", draft ? "Continue setting up text reminders" : "Your review texting setup needs a next step",
      draft ? "Your details are saved. Review the price and finish setup when you’re ready." : "Check business approval and payment status in Reviews.", REVIEW_TEXTING_SETTINGS_HREF);
  }
  if (s.reviewPaymentPending && s.reviewEnabled) return progress("review_texting", "A review texting payment is in progress", "Check its status before starting another change.", REVIEW_TEXTING_SETTINGS_HREF);
  if (s.featurePaused || (a && ["cancel_pending", "release_pending", "released"].includes(a.state))) return null;
  let key: UpgradeOfferKey | null = null;
  if (s.plan === "chat_only" && !a && s.reviewEnabled && s.reviewSettingsReady && s.hasAcceptedReviewEmail) key = "review_texting";
  else if (s.plan === "chat_only" && a?.state === "active" && a.billing_source === "direct" && s.growthEligible && mature(s.reviewActivatedAt, now)) key = "growth";
  else if (s.plan === "sms_and_chat" && s.voiceEligible && mature(s.growthActivatedAt, now)) key = "voice";
  if (!key) return null;
  const pref = s.preferences.find(value => value.offer_key === key);
  if (pref?.hidden_at || (pref?.snoozed_until && Date.parse(pref.snoozed_until) > now)) return null;
  return { kind: "offer", offerKey: key, ...COPY[key], revision: pref?.revision ?? 0 };
}
