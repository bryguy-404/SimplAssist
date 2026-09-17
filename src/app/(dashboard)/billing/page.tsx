import OwnerVoiceSettings from '@/components/settings/OwnerVoiceSettings';
import { getOwnerVoiceSettings } from '@/lib/voice/access.server';
import { redirect } from "next/navigation";
import { SUBSCRIPTION_PLANS } from "@/lib/stripe/config";
import type { SubscriptionPlan } from "@/types/database";
import { BillingActions } from "./billing-actions";
import { FullSuiteWaitlistButton } from "@/components/waitlist/FullSuiteWaitlistButton";
import {
  CUSTOMER_VISIBLE_PLAN_ORDER,
  isPlanAvailable,
} from "@/lib/billing/planAvailability";
import { getPlanPresentation } from "@/lib/billing/planPresentation";
import { getRequestBrand } from "@/lib/branding/requestBrand.server";
import { secondaryCtaClass } from "@/lib/glass";
import { getDashboardBusinessContext } from "@/lib/dashboard/context";
import { requireWorkspacePageAccess } from "@/lib/customer/workspaceRouteResponse.server";
import {
  partnerManagedBillingMessage,
  resolveAssignedPartnerName,
} from "@/lib/billing/partnerManagedBilling.server";
import {
  getCurrentAIReplyUsage,
  type AIReplyUsageDecision,
} from "@/lib/billing/aiReplyMeter.server";
import {
  card,
  cardRecommended,
  statusSuccess,
  statusWarning,
  statusDanger,
} from "@/lib/theme-v2/theme";

type BillingPageProps = {
  searchParams?: Record<string, string | string[] | undefined>;
};

type ChatOnlyAIReplyUsage =
  | {
      status: "available";
      allowance: number;
      usedReplies: number;
      capacityInUse: number;
      activeReservations: number;
      remainingReplies: number;
      usagePercent: number;
      allowanceRenewal: "scheduled" | "frozen_past_due";
      resetDate: string | null;
      level: "normal" | "warning" | "exhausted";
    }
  | { status: "unavailable" };

export default async function BillingPage(_props: BillingPageProps) {
  void _props;
  await requireWorkspacePageAccess();
  const context = await getDashboardBusinessContext();
  if (context.status === "unauthenticated") redirect("/login");
  if (context.status !== "resolved") redirect("/onboarding");

  const { supabase, business } = context;
  const isPartnerManagedBilling = business.partner_id !== null;
  if (isPartnerManagedBilling) redirect("/dashboard");

  const suspensionBillingNotice =
    business.operations_suspended_at !== null ? (
      <section
        className={`mt-6 rounded-2xl px-4 py-3 ${statusWarning}`}
        aria-labelledby="billing-during-suspension"
      >
        <h2 id="billing-during-suspension" className="font-semibold">
          Billing during suspension
        </h2>
        <p className="mt-1 text-sm">
          {business.billing_mode === "stripe"
            ? "Suspension does not pause your Stripe subscription; billing continues."
            : "Billing remains managed by your partner; this suspension has not changed it."}
        </p>
      </section>
    ) : null;

  const voiceSettingsPromise = getOwnerVoiceSettings(business.id).catch(() => null);

  if (business.billing_mode !== "stripe") {
    const [partnerName, voiceSettings] = await Promise.all([
      resolveAssignedPartnerName(business.partner_id),
      voiceSettingsPromise,
    ]);

    return (
      <div className="max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold text-stone-900 dark:text-[#f5f5f5]">
          Billing
        </h1>
        {suspensionBillingNotice}
        <div className={`mt-8 p-6 ${card}`}>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-[#f5f5f5]">
            Partner-managed billing
          </h2>
          <p className="mt-2 text-stone-500 dark:text-[#bdbdbf]">
            {partnerManagedBillingMessage(partnerName)}
          </p>
        </div>
        {voiceSettings?.visible ? <div className="mt-6"><OwnerVoiceSettings initialSettings={voiceSettings} variant="usage" /></div> : null}
      </div>
    );
  }

  const [{ data: subscription }, { data: usagePeriod }] = await Promise.all([
    supabase
      .from("subscriptions")
      .select("*")
      .eq("business_id", business.id)
      .single(),
    supabase
      .from("billing_usage_periods")
      .select("*")
      .eq("business_id", business.id)
      .order("period_start", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const hasActiveSubscription =
    subscription && subscription.status !== "canceled";
  const usedSmsParts = usagePeriod
    ? usagePeriod.inbound_sms_parts + usagePeriod.outbound_sms_parts
    : 0;
  const includedSmsParts = usagePeriod?.included_sms_parts ?? 0;
  const usagePercent =
    includedSmsParts > 0
      ? Math.min(100, Math.round((usedSmsParts / includedSmsParts) * 100))
      : 0;
  const activePlan = subscription?.plan as SubscriptionPlan | undefined;
  const [{ brand }, chatOnlyAIReplyUsage, voiceSettings] = await Promise.all([
    getRequestBrand(),
    hasActiveSubscription && activePlan === "chat_only"
      ? loadChatOnlyAIReplyUsage(business.id)
      : Promise.resolve(null),
    voiceSettingsPromise,
  ]);

  return (
    <div className="max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold text-stone-900 dark:text-[#f5f5f5]">
        Billing
      </h1>
      <p className="mt-2 text-stone-500 dark:text-[#bdbdbf]">
        {hasActiveSubscription
          ? "Manage your subscription"
          : "Choose a plan to get started"}
      </p>
      {suspensionBillingNotice}

      {hasActiveSubscription ? (
        <div className={`mt-8 p-6 ${card}`}>
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-stone-900 dark:text-[#f5f5f5]">
                {SUBSCRIPTION_PLANS[subscription.plan as SubscriptionPlan]
                  ?.name ?? subscription.plan}
              </h2>
              <div className="mt-2 flex items-center gap-3">
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    subscription.status === "active" ||
                    subscription.status === "trialing"
                      ? statusSuccess
                      : subscription.status === "past_due"
                        ? statusWarning
                        : statusDanger
                  }`}
                >
                  {subscription.status.replace("_", " ")}
                </span>
                <span className="text-sm text-stone-500 dark:text-[#bdbdbf]">
                  Next billing date:{" "}
                  {new Date(
                    subscription.current_period_end,
                  ).toLocaleDateString()}
                </span>
              </div>
            </div>
            <BillingActions mode="portal" />
          </div>
        </div>
      ) : (
        <div className="mt-8 grid gap-6 md:grid-cols-3">
          {CUSTOMER_VISIBLE_PLAN_ORDER.map((key) => {
            const plan = SUBSCRIPTION_PLANS[key];
            const available = isPlanAvailable(key);
            const presentedPlan = getPlanPresentation(key, brand.name);

            if (key === "full" && !available) return null;

            return (
              <div
                key={key}
                className={`relative p-6 rounded-[28px] ${
                  key === "sms_and_chat" ? cardRecommended : card
                }`}
              >
                {key === "sms_and_chat" && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-[var(--brand-primary)] dark:bg-[var(--brand-primary-dark)] px-3 py-0.5 text-xs font-medium text-white dark:text-[#16100b]">
                    Recommended
                  </span>
                )}
                {!available && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-[var(--brand-accent-soft-border)] bg-[var(--brand-accent-soft)] px-3 py-0.5 text-xs font-semibold text-[var(--brand-accent)] dark:border-[rgb(var(--brand-primary-dark-rgb)/.30)] dark:bg-[var(--brand-surface-dark)] dark:text-[var(--brand-accent-soft-dark)]">
                    Coming Soon
                  </span>
                )}
                <h3 className="text-lg font-semibold text-stone-900 dark:text-[#f5f5f5]">
                  {presentedPlan.name}
                </h3>
                <p className="mt-2">
                  <span className="text-3xl font-bold text-stone-900 dark:text-[#f5f5f5]">
                    ${plan.price}
                  </span>
                  <span className="text-stone-500 dark:text-[#bdbdbf]">
                    /mo
                  </span>
                </p>
                <ul className="mt-6 space-y-3">
                  {presentedPlan.features.map((feature) => (
                    <li
                      key={feature}
                      className="flex items-start gap-2 text-sm text-stone-500 dark:text-[#bdbdbf]"
                    >
                      <svg
                        className="mt-0.5 h-4 w-4 shrink-0 text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)]"
                        fill="none"
                        viewBox="0 0 24 24"
                        strokeWidth={2}
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M4.5 12.75l6 6 9-13.5"
                        />
                      </svg>
                      {feature}
                    </li>
                  ))}
                </ul>
                <div className="mt-6">
                  {available ? (
                    <BillingActions mode="checkout" plan={key} />
                  ) : (
                    <FullSuiteWaitlistButton
                      className={`${secondaryCtaClass} w-full text-sm`}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {voiceSettings?.visible ? <div className="mt-6"><OwnerVoiceSettings initialSettings={voiceSettings} variant="usage" /></div> : null}

      {hasActiveSubscription && activePlan !== "chat_only" && (
        <div className={`mt-6 p-6 ${card}`}>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-stone-900 dark:text-[#f5f5f5]">
                SMS usage
              </h2>
              <p className="mt-1 text-sm text-stone-500 dark:text-[#bdbdbf]">
                Current billing period usage counts inbound and outbound SMS
                parts.
              </p>
            </div>
            <div className="text-sm font-medium text-stone-700 dark:text-[#d8d8d8]">
              {usedSmsParts.toLocaleString()} /{" "}
              {includedSmsParts.toLocaleString()} parts
            </div>
          </div>
          <div className="mt-4 h-3 overflow-hidden rounded-full bg-stone-200 dark:bg-white/[0.10]">
            <div
              className={`h-full rounded-full ${
                usagePercent >= 100
                  ? "bg-red-500"
                  : usagePercent >= 80
                    ? "bg-amber-500"
                    : "bg-green-500"
              }`}
              style={{ width: `${usagePercent}%` }}
            />
          </div>
          <p className="mt-3 text-sm text-stone-500 dark:text-[#bdbdbf]">
            {usagePercent >= 100
              ? "Outbound SMS is paused until you upgrade or enable overages."
              : usagePercent >= 80
                ? "You are close to your included SMS parts for this period."
                : "Your SMS usage is within the included amount."}
          </p>
        </div>
      )}

      {hasActiveSubscription &&
        activePlan === "chat_only" &&
        chatOnlyAIReplyUsage && (
          <section
            className={`mt-6 p-6 ${card}`}
            aria-labelledby="ai-reply-usage-heading"
          >
            <h2
              id="ai-reply-usage-heading"
              className="text-lg font-semibold text-stone-900 dark:text-[#f5f5f5]"
            >
              AI reply usage
            </h2>
            {chatOnlyAIReplyUsage.status === "unavailable" ? (
              <p
                role="status"
                className={`mt-4 rounded-xl px-4 py-3 text-sm ${statusWarning}`}
              >
                AI reply usage is temporarily unavailable. No usage estimate is
                shown until current billing data can be verified.
              </p>
            ) : (
              <>
                <div className="mt-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                  <p className="text-sm text-stone-500 dark:text-[#bdbdbf]">
                    Monthly included AI replies
                  </p>
                  <p className="text-sm font-semibold text-stone-700 dark:text-[#d8d8d8]">
                    {chatOnlyAIReplyUsage.usedReplies.toLocaleString()} /{" "}
                    {chatOnlyAIReplyUsage.allowance.toLocaleString()} replies
                  </p>
                </div>
                <div className="mt-4 h-3 overflow-hidden rounded-full bg-stone-200 dark:bg-white/[0.10]">
                  <div
                    role="progressbar"
                    aria-label="Monthly AI reply capacity in use"
                    aria-valuemin={0}
                    aria-valuemax={chatOnlyAIReplyUsage.allowance}
                    aria-valuenow={chatOnlyAIReplyUsage.capacityInUse}
                    className={`h-full rounded-full ${
                      chatOnlyAIReplyUsage.level === "exhausted"
                        ? "bg-red-500"
                        : chatOnlyAIReplyUsage.level === "warning"
                          ? "bg-amber-500"
                          : "bg-green-500"
                    }`}
                    style={{ width: `${chatOnlyAIReplyUsage.usagePercent}%` }}
                  />
                </div>
                <p className="mt-3 text-sm font-medium text-stone-700 dark:text-[#d8d8d8]">
                  {chatOnlyAIReplyUsage.remainingReplies.toLocaleString()}{" "}
                  replies remaining
                  {chatOnlyAIReplyUsage.allowanceRenewal === "scheduled" &&
                    chatOnlyAIReplyUsage.resetDate && (
                      <>
                        {" "}
                        · Resets {chatOnlyAIReplyUsage.resetDate} (UTC)
                      </>
                    )}
                </p>
                {chatOnlyAIReplyUsage.allowanceRenewal ===
                  "frozen_past_due" && (
                  <p
                    role="status"
                    className={`mt-3 rounded-xl px-4 py-3 text-sm ${statusWarning}`}
                  >
                    Allowance renewal is paused while payment is past due. It
                    will resume after payment recovery; manage billing above
                    to update payment details.
                  </p>
                )}
                {chatOnlyAIReplyUsage.activeReservations > 0 && (
                  <p className="mt-2 text-sm text-stone-500 dark:text-[#bdbdbf]">
                    {`${chatOnlyAIReplyUsage.activeReservations.toLocaleString()} ${
                      chatOnlyAIReplyUsage.activeReservations === 1
                        ? "reply is"
                        : "replies are"
                    } being prepared. This is not counted as used, but it temporarily reduces remaining capacity.`}
                  </p>
                )}
                <p
                  className={`mt-3 text-sm ${
                    chatOnlyAIReplyUsage.level === "exhausted"
                      ? `rounded-xl px-4 py-3 ${statusDanger}`
                      : chatOnlyAIReplyUsage.level === "warning"
                        ? `rounded-xl px-4 py-3 ${statusWarning}`
                        : "text-stone-500 dark:text-[#bdbdbf]"
                  }`}
                >
                  {chatOnlyAIReplyUsage.level === "exhausted"
                    ? "No AI reply capacity is currently available. The widget remains available to collect follow-up details."
                    : chatOnlyAIReplyUsage.level === "warning"
                      ? "You are close to your monthly AI reply allowance."
                      : "Your AI reply usage is within the included amount."}
                </p>
                {chatOnlyAIReplyUsage.level !== "normal" && (
                  <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm text-stone-500 dark:text-[#bdbdbf]">
                      Contact support if you need more reply capacity.
                    </p>
                    <a
                      href="/support"
                      className={`${secondaryCtaClass} text-sm`}
                    >
                      Contact support
                    </a>
                  </div>
                )}
              </>
            )}
          </section>
        )}
    </div>
  );
}

async function loadChatOnlyAIReplyUsage(
  businessId: string,
): Promise<ChatOnlyAIReplyUsage> {
  let usage: AIReplyUsageDecision;
  try {
    usage = await getCurrentAIReplyUsage(businessId);
  } catch (error) {
    console.error("Billing AI reply usage lookup failed:", error);
    return { status: "unavailable" };
  }

  if (
    usage.outcome === "not_entitled" ||
    usage.billingSource !== "subscription" ||
    usage.plan !== "chat_only" ||
    usage.allowance !== 200 ||
    usage.remainingReplies === null ||
    (usage.allowanceRenewal !== "scheduled" &&
      usage.allowanceRenewal !== "frozen_past_due") ||
    (usage.allowanceRenewal === "scheduled" &&
      typeof usage.resetAt !== "string") ||
    (usage.allowanceRenewal === "frozen_past_due" &&
      usage.resetAt !== null) ||
    !Number.isInteger(usage.completedReplies) ||
    usage.completedReplies < 0 ||
    !Number.isInteger(usage.activeReservations) ||
    usage.activeReservations < 0 ||
    !Number.isInteger(usage.remainingReplies) ||
    usage.remainingReplies < 0 ||
    usage.remainingReplies > usage.allowance ||
    usage.completedReplies + usage.activeReservations > usage.allowance ||
    usage.completedReplies +
      usage.activeReservations +
      usage.remainingReplies !==
      usage.allowance
  ) {
    console.error("Billing AI reply usage lookup returned incompatible state");
    return { status: "unavailable" };
  }

  const usedReplies = usage.completedReplies;
  const capacityInUse = Math.min(
    usage.allowance,
    usage.completedReplies + usage.activeReservations,
  );
  const resetAt = usage.resetAt === null ? null : new Date(usage.resetAt);
  if (resetAt && Number.isNaN(resetAt.getTime())) {
    console.error("Billing AI reply usage lookup returned an invalid reset date");
    return { status: "unavailable" };
  }
  const usagePercent = Math.min(100, (capacityInUse / usage.allowance) * 100);
  return {
    status: "available",
    allowance: usage.allowance,
    usedReplies,
    capacityInUse,
    activeReservations: usage.activeReservations,
    remainingReplies: usage.remainingReplies,
    usagePercent,
    allowanceRenewal: usage.allowanceRenewal,
    resetDate: resetAt
      ? new Intl.DateTimeFormat("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        }).format(resetAt)
      : null,
    level:
      capacityInUse >= usage.allowance
        ? "exhausted"
        : capacityInUse / usage.allowance >= 0.8
          ? "warning"
          : "normal",
  };
}
