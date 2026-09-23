"use client";

import { Check } from "lucide-react";
import { FullSuiteWaitlistButton } from "@/components/waitlist/FullSuiteWaitlistButton";
import { secondaryCtaClass } from "@/lib/glass";
import {
  isPlanAvailable,
  isPlanVisible,
} from "@/lib/billing/planAvailability";
import { SETUP_FEE_CENTS, SUBSCRIPTION_PLANS } from "@/lib/stripe/config";
import { cn } from "@/lib/utils";
import type { SubscriptionPlan } from "@/types/database";

interface PlanSelectionOptionProps {
  inputName: string;
  planKey: SubscriptionPlan;
  plan: (typeof SUBSCRIPTION_PLANS)[SubscriptionPlan];
  selected: boolean;
  recommended: boolean;
  onSelect: (plan: SubscriptionPlan) => void;
  /**
   * A server-authorized acquisition surface can opt a catalog-hidden plan in
   * without changing the global catalog. Omit this everywhere else so the
   * established public visibility rules remain authoritative.
   */
  availabilityOverride?: "available" | "coming_soon" | "hidden";
  setupFeeCents?: number;
  paymentTiming?: "today" | "at checkout";
  disabled?: boolean;
}

export function PlanSelectionOption({
  inputName,
  planKey,
  plan,
  selected,
  recommended,
  onSelect,
  availabilityOverride,
  setupFeeCents = SETUP_FEE_CENTS,
  paymentTiming = "today",
  disabled = false,
}: PlanSelectionOptionProps) {
  const visible = availabilityOverride
    ? availabilityOverride !== "hidden"
    : isPlanVisible(planKey);
  if (!visible) return null;

  const available = availabilityOverride
    ? availabilityOverride === "available"
    : isPlanAvailable(planKey);
  const firstPaymentTotal = plan.price + setupFeeCents / 100;
  const includedAllowance =
    plan.includedSmsParts > 0
      ? `${plan.includedSmsParts.toLocaleString()} SMS parts/month`
      : plan.includedAiReplies !== null
        ? `${plan.includedAiReplies.toLocaleString()} AI replies/month`
        : "no metered allowance";

  const content = (
    <>
      <span className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-stone-900 dark:text-[#f5f5f5]">
              {plan.name}
            </span>
            {recommended && (
              <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--brand-primary)] px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.08em] text-white dark:bg-[var(--brand-primary-dark)] dark:text-[#16100b]">
                Recommended
              </span>
            )}
            {!available && (
              <span className="inline-flex shrink-0 items-center rounded-full border border-[var(--brand-accent-soft-border)] bg-[var(--brand-accent-soft)] px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-[0.08em] text-[var(--brand-accent)] dark:border-[rgb(var(--brand-primary-dark-rgb)/.30)] dark:bg-[rgb(var(--brand-primary-dark-rgb)/.10)] dark:text-[var(--brand-accent-soft-dark)]">
                Coming Soon
              </span>
            )}
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-stone-500 dark:text-[#bdbdbf]">
            {available && setupFeeCents > 0 ? "Then " : ""}
            ${plan.price}/month. Includes {includedAllowance}.
          </span>
        </span>

        <span className="flex items-center gap-3">
          <span className="whitespace-nowrap font-medium text-stone-700 dark:text-[#d8d8d8]">
            {available ? `$${firstPaymentTotal} ${paymentTiming}` : `$${plan.price}/mo`}
          </span>
          {available && (
            <span
              aria-hidden="true"
              className={cn(
                "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors duration-150",
                selected
                  ? "border-[var(--brand-primary)] bg-[var(--brand-primary)] text-white dark:border-[var(--brand-primary-dark)] dark:bg-[var(--brand-primary-dark)] dark:text-[#16100b]"
                  : recommended
                    ? "border-[var(--brand-selection-border)] bg-white/80 text-transparent dark:border-[rgb(var(--brand-primary-dark-rgb)/.50)] dark:bg-white/[0.05]"
                    : "border-stone-300 bg-white/80 text-transparent dark:border-white/[0.20] dark:bg-white/[0.05]"
              )}
            >
              <Check className="h-4 w-4" strokeWidth={3} />
            </span>
          )}
        </span>
      </span>

      {!available && (
        <FullSuiteWaitlistButton
          className={`${secondaryCtaClass} mt-4 w-full py-2.5 text-sm sm:w-auto`}
        />
      )}
    </>
  );

  if (!available) {
    return (
      <div
        aria-label={`${plan.name}, coming soon`}
        className="relative block rounded-[18px] border border-[var(--brand-accent-soft-border)] bg-[var(--brand-wash-faint)] px-4 py-4 text-sm dark:border-[rgb(var(--brand-primary-dark-rgb)/.30)] dark:bg-[rgb(var(--brand-primary-dark-rgb)/.055)]"
      >
        {content}
      </div>
    );
  }

  return (
    <label
      className={cn(
        "group relative block cursor-pointer rounded-[18px] border px-4 py-4 text-sm",
        "transition-[border-color,background-color,box-shadow] duration-150 motion-reduce:transition-none",
        "has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[rgb(var(--brand-primary-rgb)/.60)]",
        "has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-[#faf7f2]",
        "dark:has-[:focus-visible]:ring-[rgb(var(--brand-primary-dark-rgb)/.60)] dark:has-[:focus-visible]:ring-offset-[#11100f]",
        selected
          ? "border-[var(--brand-primary)] bg-[var(--brand-wash)] ring-2 ring-[rgb(var(--brand-primary-rgb)/.20)] shadow-[0_10px_28px_-22px_rgb(var(--brand-primary-active-rgb)/.75)] dark:border-[var(--brand-primary-dark)] dark:bg-[rgb(var(--brand-primary-dark-rgb)/.11)] dark:ring-[rgb(var(--brand-primary-dark-rgb)/.20)]"
          : recommended
            ? "border-[var(--brand-border-soft)] bg-[var(--brand-wash-faint)] hover:border-[var(--brand-border-strong)] dark:border-[rgb(var(--brand-primary-dark-rgb)/.35)] dark:bg-[rgb(var(--brand-primary-dark-rgb)/.055)] dark:hover:border-[rgb(var(--brand-primary-dark-rgb)/.55)]"
            : "border-[#e9e0d4] bg-white/70 hover:border-[#d8ccbc] hover:bg-white dark:border-white/[0.10] dark:bg-white/[0.035] dark:hover:border-white/[0.17] dark:hover:bg-white/[0.055]"
      )}
    >
      <input
        type="radio"
        name={inputName}
        value={planKey}
        checked={selected}
        disabled={disabled}
        onChange={() => onSelect(planKey)}
        className="sr-only"
      />
      {content}
    </label>
  );
}
