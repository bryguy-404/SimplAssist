"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { BillingChangeView, SmsPlan } from "@/lib/stripe/smsBilling";
import { SUBSCRIPTION_PLANS } from "@/lib/stripe/config";
import { isPlanAvailable } from "@/lib/billing/planAvailability";
import { card, statusWarning } from "@/lib/theme-v2/theme";
import { primaryCtaInlineClass, secondaryCtaClass } from "@/lib/glass";

const errors: Record<string, string> = {
  sms_billing_quote_expired: "This quote expired. Review the updated amount before confirming.",
  sms_billing_source_changed: "Your subscription changed. Refresh your billing details before continuing.",
  sms_billing_operation_in_progress: "Another billing change is in progress. Refresh its status below.",
  sms_billing_existing_subscription: "Manage your current subscription or resolve its payment before changing plans.",
  sms_billing_recovery_required: "We are still verifying a previous billing request. Contact support before starting another payment.",
  sms_billing_already_applied: "This change has already taken effect. Refresh your billing details.",
  sms_billing_plan_unavailable: "This plan is not available for purchase yet.",
};
export function billingChangeError(code: unknown): string {
  return typeof code === "string" && errors[code] ? errors[code] : "Billing is temporarily unavailable. Your existing plan remains in place until a paid change is confirmed.";
}
export async function requestBillingChange(method: "POST" | "PATCH" | "DELETE", input: { plan: SmsPlan } | { operationId: string }): Promise<BillingChangeView | null> {
  const body = "plan" in input ? { plan: input.plan } : { operationId: input.operationId };
  const response = await fetch("/api/billing/plan-change", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(billingChangeError(result.error));
  return result.change ?? null;
}

export default function BillingPlanChange({ currentPlan, active }: { currentPlan?: string; active: boolean }) {
  const router = useRouter();
  const [change, setChange] = useState<BillingChangeView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let canceled = false;
    fetch("/api/billing/plan-change", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const result = await response.json();
      if (!canceled) setChange(result.change);
    }).catch(() => {}).finally(() => { if (!canceled) setLoaded(true); });
    return () => { canceled = true; };
  }, []);
  const pending = change && ["prepared", "confirming", "pending", "scheduled"].includes(change.state);
  const options = active && currentPlan && currentPlan !== "chat_only"
    ? (["sms_only", "sms_and_chat", "full"] as const).filter((plan) => plan !== currentPlan && isPlanAvailable(plan)) : [];
  if (!pending && !options.length && !error) return null;
  async function perform(action: () => Promise<BillingChangeView | null>) {
    setBusy(true); setError(null);
    try {
      const next = await action(); setChange(next);
      if (!next || next.state === "applied" || next.state === "expired") router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : billingChangeError(null)); }
    finally { setBusy(false); }
  }
  async function refresh() {
    const response = await fetch("/api/billing/plan-change", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(billingChangeError(data.error));
    return data.change as BillingChangeView | null;
  }
  const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: change?.currency ?? "usd" }).format(cents / 100);
  const date = (value: string) => new Date(value).toLocaleDateString();
  return <section className={`mt-6 p-6 ${card}`} aria-labelledby="billing-plan-change-heading">
    <h2 id="billing-plan-change-heading" className="font-semibold">Change your plan</h2>
    {error && <p role="alert" className={`mt-3 rounded-xl p-3 ${statusWarning}`}>{error}</p>}
    {pending && change ? <div className="mt-4 space-y-3" aria-live="polite">
      <h3 className="font-medium">{SUBSCRIPTION_PLANS[change.targetPlan].name}</h3>
      {change.kind === "checkout" ? <p>Your Checkout is awaiting completion.</p> : change.state === "scheduled" ?
        <p>Your plan changes on {date(change.effectiveAt)}. Your current paid access remains available until then.</p> : change.state === "prepared" ? <>
          <p>{change.kind === "upgrade" ? `${money(change.amountDueCents)} due now for the remainder of this billing month.` : `No charge today. Your plan changes on ${date(change.effectiveAt)}.`}</p>
          <p>{money(change.monthlyPriceCents)}/month from {date(change.renewalAt!)}.</p>
          {change.kind === "upgrade" && <>
            <p>The upgrade takes effect after payment. Your renewal date and used SMS parts stay the same.</p>
            {change.targetPlan === "full" && <p>Approximately {Math.floor(change.voiceSeconds / 60)} voice minutes for the remaining month, then 100 each billing month. No voice overage charges.</p>}
          </>}
        </> : <p>Payment or subscription confirmation is still pending. Refresh the status after completing payment.</p>}
      <div className="flex flex-wrap gap-3">
        {change.state === "prepared" && <button className={primaryCtaInlineClass} disabled={busy} onClick={() => perform(() => requestBillingChange("PATCH", { operationId: change.operationId }))}>
          {busy ? "Processing…" : change.kind === "checkout" ? "Continue to Checkout" : change.kind === "upgrade" ? `Confirm and pay ${money(change.amountDueCents)}` : "Confirm change at renewal"}
        </button>}
        {change.state === "confirming" && <button className={primaryCtaInlineClass} disabled={busy}
          onClick={() => perform(() => requestBillingChange("PATCH", { operationId: change.operationId }))}>
          {busy ? "Recovering…" : "Recover this billing request"}
        </button>}
        {change.paymentUrl && <a className={primaryCtaInlineClass} href={change.paymentUrl}>{change.kind === "checkout" ? "Resume Checkout" : "Complete payment"}</a>}
        <button className={secondaryCtaClass} disabled={busy} onClick={() => perform(refresh)}>Refresh status</button>
        <button className={secondaryCtaClass} disabled={busy} onClick={() => perform(() => requestBillingChange("DELETE", { operationId: change.operationId }))}>Cancel this change</button>
      </div>
    </div> : <>
      {change?.state === "applied" && <p role="status" className="mt-3">Your plan change is confirmed.</p>}
      <p className="mt-2 text-sm text-stone-500 dark:text-[#bdbdbf]">Review the price before confirming. Upgrades begin after payment; lower-priced plans begin at renewal.</p>
      <div className="mt-4 flex flex-wrap gap-3">{options.map((plan) => <button key={plan} className={secondaryCtaClass} disabled={busy || !loaded}
        onClick={() => perform(() => requestBillingChange("POST", { plan }))}>Review {SUBSCRIPTION_PLANS[plan].name}</button>)}</div>
    </>}
  </section>;
}
