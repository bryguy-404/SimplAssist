"use client";

import { useEffect, useMemo, useState } from "react";
import { useBrand } from "@/components/branding/BrandProvider";
import { PlanSelectionOption } from "@/components/onboarding/PlanSelectionOption";
import { PulsingDot } from "@/components/ui/pulsing-dot";
import {
  CUSTOMER_VISIBLE_PLAN_ORDER,
  isPlanAvailable,
} from "@/lib/billing/planAvailability";
import { getPlanPresentation } from "@/lib/billing/planPresentation";
import { primaryCtaInlineClass, secondaryCtaClass } from "@/lib/glass";
import { SETUP_FEE_CENTS } from "@/lib/stripe/config";
import { statusDanger, statusNeutral } from "@/lib/theme-v2/theme";
import { cn } from "@/lib/utils";
import type { SubscriptionPlan } from "@/types/database";

const RECOMMENDED_PLAN: SubscriptionPlan = "sms_and_chat";

export function reconcileDirectPlanSelection(args: {
  currentPlan: SubscriptionPlan | null;
  initialPlan: SubscriptionPlan | null;
  selectablePlans: readonly SubscriptionPlan[];
}): SubscriptionPlan | null {
  if (
    args.initialPlan &&
    args.selectablePlans.includes(args.initialPlan)
  ) {
    return args.initialPlan;
  }
  if (args.currentPlan && args.selectablePlans.includes(args.currentPlan)) {
    return args.currentPlan;
  }
  return null;
}

type DirectPlanSelectionProps = {
  initialPlan: SubscriptionPlan | null;
  chatOnlyAvailable: boolean;
  onBack?: () => void;
  onNext: (plan: SubscriptionPlan) => void | Promise<void>;
};

export default function DirectPlanSelection({
  initialPlan,
  chatOnlyAvailable,
  onBack,
  onNext,
}: DirectPlanSelectionProps) {
  const { name: brandName } = useBrand();
  const visiblePlans = useMemo<readonly SubscriptionPlan[]>(
    () =>
      chatOnlyAvailable
        ? (["chat_only", ...CUSTOMER_VISIBLE_PLAN_ORDER] as const)
        : CUSTOMER_VISIBLE_PLAN_ORDER,
    [chatOnlyAvailable],
  );
  const selectablePlans = useMemo(
    () => visiblePlans.filter((plan) => plan === "chat_only" || isPlanAvailable(plan)),
    [visiblePlans],
  );
  const safeInitialPlan =
    initialPlan && selectablePlans.includes(initialPlan)
      ? initialPlan
      : null;
  const [selectedPlan, setSelectedPlan] =
    useState<SubscriptionPlan | null>(safeInitialPlan);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedPlan((currentPlan) =>
      reconcileDirectPlanSelection({
        currentPlan,
        initialPlan,
        selectablePlans,
      }),
    );
  }, [initialPlan, selectablePlans]);

  async function saveSelection() {
    if (saving || !selectedPlan || !selectablePlans.includes(selectedPlan)) return;
    setSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/onboarding/plan-selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: selectedPlan }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };

      if (!response.ok) {
        setError(payload.error ?? "Could not save your plan choice.");
        return;
      }

      await onNext(selectedPlan);
    } catch {
      setError("Could not save your plan choice. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const chatOnlySelected = selectedPlan === "chat_only";
  const savedPlanUnavailable = Boolean(
    initialPlan && !selectablePlans.includes(initialPlan),
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-stone-900 dark:text-[#f5f5f5]">
          Choose how customers reach your AI
        </h2>
        <p className="mt-1 text-sm text-stone-500 dark:text-[#bdbdbf]">
          Choose your plan now. Payment comes after you finish setup.
        </p>
        <p className="mt-2 text-sm text-stone-500 dark:text-[#bdbdbf]">
          Your choice determines whether setup includes business texting and
          carrier registration or just the website chat widget.
        </p>
      </div>

      {savedPlanUnavailable && (
        <p role="status" className={cn("rounded-[16px] p-3 text-sm", statusNeutral)}>
          Your saved plan is temporarily unavailable. It remains saved until you
          choose another plan. You can also return later to continue.
        </p>
      )}

      <fieldset className="space-y-3">
        <legend className="sr-only">Choose your {brandName} plan</legend>
        {visiblePlans.map((planKey) => (
          <PlanSelectionOption
            key={planKey}
            inputName="onboarding-plan"
            planKey={planKey}
            plan={getPlanPresentation(planKey, brandName)}
            selected={selectedPlan === planKey}
            recommended={planKey === RECOMMENDED_PLAN}
            onSelect={setSelectedPlan}
            availabilityOverride={
              planKey === "chat_only" ? "available" : undefined
            }
            setupFeeCents={planKey === "chat_only" ? 0 : SETUP_FEE_CENTS}
            paymentTiming="at checkout"
            disabled={saving}
          />
        ))}
      </fieldset>

      {selectedPlan && (
        <div className={cn("rounded-[16px] p-3 text-xs", statusNeutral)}>
          {chatOnlySelected ? (
            <>
              <p className="font-medium text-stone-800 dark:text-[#f5f5f5]">
                No setup or SMS activation fee
              </p>
              <p className="mt-1 leading-relaxed">
                Chat Only uses your website widget, conversation inbox, and
                Google Calendar. It does not include a phone number or texting.
              </p>
            </>
          ) : (
            <>
              <p className="font-medium text-stone-800 dark:text-[#f5f5f5]">
                ${SETUP_FEE_CENTS / 100} one-time setup and SMS activation fee
              </p>
              <p className="mt-1 leading-relaxed">
                Texting plans include carrier registration, phone-number
                activation, and the compliance setup needed for reliable SMS.
              </p>
            </>
          )}
        </div>
      )}

      {error && (
        <div role="alert" className={cn("rounded-lg px-4 py-3 text-sm", statusDanger)}>
          {error}
        </div>
      )}

      <div className={cn("flex pt-4", onBack ? "justify-between" : "justify-end")}>
        {onBack && (
          <button type="button" onClick={onBack} disabled={saving} className={secondaryCtaClass}>
            Back
          </button>
        )}
        <button
          type="button"
          onClick={saveSelection}
          disabled={saving || !selectedPlan || !selectablePlans.includes(selectedPlan)}
          className={primaryCtaInlineClass}
        >
          {saving ? (
            <>
              <PulsingDot inline /> Saving...
            </>
          ) : (
            "Continue setup"
          )}
        </button>
      </div>
    </div>
  );
}
