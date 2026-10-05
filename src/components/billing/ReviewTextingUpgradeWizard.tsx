"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TextingUpgradeState } from "@/lib/billing/textingUpgrade";
import { primaryCtaInlineClass, secondaryCtaClass } from "@/lib/glass";
import { card, statusWarning } from "@/lib/theme-v2/theme";
import { supportHref } from "@/lib/support/constants";

export type ReviewUpgradeProviderState = {
  stage: "not_started" | "prepared" | "submitting" | "carrier_pending" | "approved" | "moving" | "review_ready" | "support_required";
  canPrepare: boolean; canMove: boolean; paused: boolean; error: string | null;
  submissionPreview: { description: string; samples: (string | undefined)[]; messageFlow: string; privacyUrl: string; termsUrl: string };
};
const endpoint = "/api/billing/texting-upgrade";
const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const stageCopy: Record<ReviewUpgradeProviderState["stage"], string> = {
  not_started: "Review your expanded texting application",
  prepared: "Application saved",
  submitting: "Confirming your application submission",
  carrier_pending: "Waiting for carrier approval",
  approved: "Your expanded texting application is approved",
  moving: "Your number is moving to the approved application",
  review_ready: "Your number is ready",
  support_required: "Your number transition needs support",
};
async function read(path = "", body?: unknown) {
  const response = await fetch(endpoint + path, body === undefined ? { cache: "no-store" } : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("We couldn’t complete this step. Your saved progress is retained. Refresh the status before trying again, or contact support.");
  return data;
}

export default function ReviewTextingUpgradeWizard({ state, onState, initialProvider }: {
  state: TextingUpgradeState; onState: (state: TextingUpgradeState) => void; initialProvider?: ReviewUpgradeProviderState;
}) {
  const [provider, setProvider] = useState<ReviewUpgradeProviderState | null>(initialProvider ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filingAgreed, setFilingAgreed] = useState(false);
  const [moveAgreed, setMoveAgreed] = useState(false);
  const inFlight = useRef(false);
  const upgradeId = state.upgrade?.state !== "abandoned" ? state.upgrade?.id : null;
  const loadProvider = useCallback(async () => {
    if (!upgradeId) { setProvider(null); return; }
    const data = await read("/review-provider");
    if (!data.provider) throw new Error("Your number transition status could not be loaded.");
    setProvider(data.provider);
  }, [upgradeId]);
  useEffect(() => {
    let disposed = false;
    if (upgradeId) read("/review-provider").then(data => {
      if (!disposed && data.provider) setProvider(data.provider);
    }).catch((cause: Error) => { if (!disposed) setError(cause.message); });
    return () => { disposed = true; };
  }, [upgradeId]);
  async function act(path: string, body: unknown) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const data = await read(path, body);
      if (data.provider) setProvider(data.provider);
      const next = data.state ?? (await read()).state;
      if (!next) throw new Error("Your upgrade status could not be loaded.");
      onState(next);
      if (next.upgrade?.state === "abandoned") setProvider(null);
      else if (path !== "/review-provider") await loadProvider();
      setFilingAgreed(false); setMoveAgreed(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Please refresh your saved upgrade status."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const paid = state.paymentStatus === "paid" || state.upgrade?.state === "activated";
  const active = paid && state.availableServicePlan === "sms_and_chat" && state.eligible;
  const quote = state.quote;
  const missingBusinessDetails = provider?.error === "review_upgrade_business_details_required";
  return <div className="mx-auto max-w-3xl space-y-5">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-bold">Add missed-call follow-up</h1>
      <Link className={secondaryCtaClass} href="/dashboard">Return to dashboard</Link>
    </header>
    <section className={`${card} space-y-3 p-5 sm:p-7`} aria-labelledby="growth-price">
      <h2 id="growth-price" className="text-lg font-semibold">SMS + Web Chat · $49/month</h2>
      <p>Keep your customer workspace, email and text review requests, website chat, and existing number. Add missed-call follow-up and AI text conversations.</p>
      <p><strong>1,500 SMS parts per billing period</strong>, shared by review requests, replies, and other texting. Your existing usage counts toward this allowance. Longer messages can use several parts.</p>
      <p><strong>No additional activation fee.</strong> Your $35 package stays in place during carrier review. After your number moves, you can review the exact prorated payment for the $14/month difference. Your renewal date stays the same.</p>
      <p className="text-sm">Carrier approval is required. Review permission stays limited to review requests; other messages still need the appropriate customer permission.</p>
    </section>
    {error && <div role="alert" className={`rounded-xl p-4 ${statusWarning}`}>{error}</div>}
    {state.message && <p role="status">{state.message}</p>}
    {paid ? <section className={`${card} space-y-3 p-5`}><h2 className="text-xl font-semibold">{active ? "Your Growth plan is active" : "Your upgrade payment is recorded"}</h2><p>{active ? "Your number and customer records stay with your account. Reviews now use your plan’s shared texting allowance." : "Your account’s current billing and service status still applies. Visit Billing or contact support to review any suspension or cancellation."}</p><Link className={primaryCtaInlineClass} href="/dashboard">Open dashboard</Link></section>
      : !upgradeId ? <section className={`${card} space-y-4 p-5`}><h2 className="text-xl font-semibold">Start with your saved business details</h2><p>We’ll show you the expanded application before submitting it. Your number will move only after approval and your confirmation.</p><button className={primaryCtaInlineClass} disabled={busy || !state.actions.canSelect} onClick={() => act("", { action: "select", plan: "sms_and_chat" })}>Review upgrade setup</button></section>
        : <section className={`${card} space-y-4 p-5 sm:p-7`} aria-busy={busy}>
          {!provider ? <p role="status">Loading your number transition…</p> : <>
            <h2 className="text-xl font-semibold">{provider.paused && provider.error ? "Your number transition needs support" : stageCopy[provider.stage]}</h2>
            {provider.paused && provider.error ? <p role="alert">We could not verify that the carrier completed your number switch. Contact support to inspect the saved result. SMS stays paused until the assignment is verified.</p> : null}
            {provider.paused ? <p role="status" className={`rounded-xl p-4 ${statusWarning}`}>SMS sending and SMS AI are paused while the carrier moves your number. This can take minutes to days. Website chat and email reviews continue. Incoming messages and opt-outs are retained.</p>
              : provider.stage !== "review_ready" && <p>Your existing review texting continues while approval is pending. You choose when the number switch starts.</p>}
            {provider.stage === "not_started" && <>
              {missingBusinessDetails ? <p role="alert">Your saved business details need an update before we can prepare the application. <Link href="/settings" className="underline">Check your business settings</Link> or contact support, then refresh this page. Your current review service stays available.</p> : <>
              <p>We reuse your saved business, brand, messaging profile, and number. Check the customer-care and review-request disclosures below.</p>
              <details open className="space-y-3 rounded-xl border p-4"><summary className="cursor-pointer font-semibold">Application and customer permission wording</summary>
                <p className="whitespace-pre-wrap break-words">{provider.submissionPreview.description}</p>
                <ul className="list-disc space-y-2 pl-5">{provider.submissionPreview.samples.filter(Boolean).map((sample, index) => <li className="break-words" key={index}>{sample}</li>)}</ul>
                <p className="whitespace-pre-wrap break-words">{provider.submissionPreview.messageFlow}</p>
                <div className="flex gap-4"><a className="underline" href={provider.submissionPreview.privacyUrl} target="_blank" rel="noreferrer">Privacy policy</a><a className="underline" href={provider.submissionPreview.termsUrl} target="_blank" rel="noreferrer">Texting terms</a></div>
              </details>
              <label className="flex items-start gap-3"><input type="checkbox" className="mt-1" checked={filingAgreed} onChange={event => setFilingAgreed(event.target.checked)} /><span>These details describe my business and how I will obtain permission for customer-care messages and review requests.</span></label>
              <button className={primaryCtaInlineClass} disabled={busy || !provider.canPrepare || !filingAgreed} onClick={() => act("/review-provider", { action: "prepare", acknowledge: true })}>Submit expanded application</button>
              </>}
            </>}
            {provider.stage === "approved" && <>
              <p>Choose a time when a pause in texting is acceptable. The carrier switch may take minutes to days. Your website chat and email review requests will stay available.</p>
              <label className="flex items-start gap-3"><input type="checkbox" className="mt-1" checked={moveAgreed} onChange={event => setMoveAgreed(event.target.checked)} /><span>I understand SMS will pause, and I’m ready to move my existing number now.</span></label>
              <button className={primaryCtaInlineClass} disabled={busy || !provider.canMove || !moveAgreed} onClick={() => act("/review-provider", { action: "move", acknowledge: true })}>Move my number</button>
            </>}
            {provider.stage === "review_ready" && <>
              <p>Your review texting is available again on the new approved application. Your $35 package continues until the Growth payment succeeds. You can also keep your current package.</p>
              {quote && quote.state !== "expired" ? <div className="space-y-2 rounded-xl border p-4"><p className="font-semibold">{money(quote.amountDueCents)} due now</p><p>The prorated subscription change has no activation fee. {money(quote.monthlyPriceCents)}/month at renewal{quote.renewalAt ? ` on ${new Date(quote.renewalAt).toLocaleDateString()}` : ""}.</p><p className="text-sm">Quote expires {new Date(quote.expiresAt).toLocaleString()}.</p></div> : <p>Review a fresh payment quote before accepting the upgrade.</p>}
              {state.actions.canQuote && <button className={secondaryCtaClass} disabled={busy} onClick={() => act("/quote", {})}>{quote ? "Refresh price" : "Review exact price"}</button>}
              {quote && state.actions.canConfirm && <button className={primaryCtaInlineClass} disabled={busy || Date.parse(quote.expiresAt) <= Date.now()} onClick={() => act("/confirm", { operationId: quote.operationId, quoteFingerprint: quote.quoteFingerprint, starterAcknowledged: false })}>Confirm upgrade and pay {money(quote.amountDueCents)}</button>}
            </>}
            {provider.stage === "support_required" && <p>Your saved resources and payment history are retained. Contact support to inspect the carrier result before another attempt.</p>}
          </>}
          {state.paymentStatus === "pending" || state.paymentStatus === "confirming" ? <p role="status">Payment is still being confirmed. Your current package stays in place. Use the existing payment below or refresh its status.</p> : null}
          {quote?.paymentUrl && <a className={primaryCtaInlineClass} href={quote.paymentUrl}>Complete existing payment</a>}
          <div className="flex flex-wrap gap-3"><button className={secondaryCtaClass} disabled={busy} onClick={() => act("/review-provider", { action: "refresh" })}>Refresh number status</button><button className={secondaryCtaClass} disabled={busy} onClick={() => act("/refresh", {})}>Refresh payment status</button><Link className={secondaryCtaClass} href={supportHref("number_registration")}>Contact support</Link></div>
        </section>}
    {!paid && upgradeId && state.actions.canCancel && <button className={secondaryCtaClass} disabled={busy || Boolean(provider?.paused)} onClick={() => act("/cancel", {})}>Keep my current package and cancel this upgrade</button>}
  </div>;
}
