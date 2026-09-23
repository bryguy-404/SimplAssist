"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import BusinessInfoForm from "@/components/onboarding/BusinessInfoForm";
import BrandVerificationForm from "@/components/onboarding/BrandVerificationForm";
import SmsUseCaseForm from "@/components/onboarding/SmsUseCaseForm";
import PhoneNumberSelector, { shouldDisablePhoneNumberNext } from "@/components/phone/PhoneNumberSelector";
import { evaluateContentQuality } from "@/lib/contentQuality";
import { SUBSCRIPTION_PLANS } from "@/lib/stripe/config";
import type { SmsPlan } from "@/lib/stripe/smsBilling";
import { TEXTING_UPGRADE_STEPS, type TextingUpgradeQuote, type TextingUpgradeState, type TextingUpgradeStep } from "@/lib/billing/textingUpgrade";
import { primaryCtaInlineClass, secondaryCtaClass } from "@/lib/glass";
import { card, statusWarning } from "@/lib/theme-v2/theme";
import { supportHref } from "@/lib/support/constants";

const ENDPOINT = "/api/billing/texting-upgrade";
const labels: Record<TextingUpgradeStep, string> = { plan: "Choose plan", business: "Business details", verification: "Business verification", use_case: "Texting details", phone: "Phone number", review: "Review and pay", status: "Texting status" };
const errorMessages: Record<string, string> = {
  ein_already_connected: "This EIN is already connected to an account. Contact support for help.",
  registration_locked: "Your carrier registration has started. Contact support to change these details.",
  rejection_support_required: "Your carrier registration needs support. Contact support for help with registration.",
  texting_upgrade_invalid_business: "Check your business contact information and address, then try again.",
  texting_upgrade_invalid_verification: "Check your EIN and authorized representative details, then try again.",
  texting_upgrade_invalid_use_case: "Check your texting descriptions, sample messages, opt-in wording, and eligibility answers.",
  texting_upgrade_locked: "Your upgrade has moved forward. Refresh its status before making another change.",
  texting_upgrade_source_changed: "Your subscription or setup changed. Refresh and review the current details.",
  texting_upgrade_incomplete: "Finish all texting setup steps before reviewing payment.",
  texting_upgrade_verification_required: "Finish business verification before texting details.",
  texting_upgrade_use_case_required: "Finish texting details and eligibility review before choosing a number.",
  texting_upgrade_legal_urls_required: "Check your privacy and terms settings before continuing.",
  invalid_phone_number: "Choose a local U.S. number and agree to the texting terms.",
  sms_billing_quote_expired: "Your price quote expired. Review the updated amount before confirming.",
  texting_upgrade_quote_expired: "Your price quote expired. Review the updated amount before confirming.",
};
export function textingUpgradeErrorMessage(code: unknown): string {
  return typeof code === "string" && errorMessages[code] ? errorMessages[code] : "We couldn't finish that request. Your saved setup is retained. Refresh the status before trying another payment.";
}
export function nextTextingUpgradeStep(step: TextingUpgradeStep): TextingUpgradeStep {
  return TEXTING_UPGRADE_STEPS[Math.min(TEXTING_UPGRADE_STEPS.indexOf(step) + 1, TEXTING_UPGRADE_STEPS.length - 1)];
}
export const STARTER_LOSS_COPY = "Starter / SMS Only does not include website chat, AI chat and customization, calendar access, or appointment scheduling. These features stop when texting activates. Your saved data stays in your account.";

async function requestState(path = "", body?: unknown): Promise<TextingUpgradeState> {
  const response = await fetch(`${ENDPOINT}${path}`, body === undefined ? { cache: "no-store" } : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.state) throw new Error(textingUpgradeErrorMessage(result.code ?? result.error));
  return result.state;
}

export default function TextingUpgradeWizard({ initialState }: { initialState?: TextingUpgradeState } = {}) {
  const [state, setState] = useState<TextingUpgradeState | null>(initialState ?? null);
  const [step, setStep] = useState<TextingUpgradeStep>(initialState?.currentStep ?? "plan");
  const [selected, setSelected] = useState<SmsPlan | null>(initialState?.selectedPlan ?? null);
  const [starterAcknowledged, setStarterAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replacingPhone, setReplacingPhone] = useState(false);
  const inFlight = useRef(false);

  const acceptState = useCallback((next: TextingUpgradeState, resume = true) => {
    setState(next);
    setSelected(next.selectedPlan);
    if (resume || next.currentStep === "status") setStep(next.currentStep);
    if (resume && next.currentStep === "review") setStarterAcknowledged(false);
  }, []);
  useEffect(() => {
    let canceled = false;
    requestState().then((next) => { if (!canceled) acceptState(next); })
      .catch((cause: Error) => { if (!canceled) setError(cause.message); });
    return () => { canceled = true; };
  }, [acceptState]);

  async function perform(action: () => Promise<TextingUpgradeState>, resume = true) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try { acceptState(await action(), resume); }
    catch (cause) { setError(cause instanceof Error ? cause.message : textingUpgradeErrorMessage(null)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  function navigate(target: TextingUpgradeStep) { setError(null); if (target === "review") setStarterAcknowledged(false); setStep(target); }

  // Adapters retain the existing forms' inline errors and risk-hold presentation.
  function saveRequest(formStep: "business" | "verification" | "use_case"): typeof fetch {
    return async (_input, init) => {
      const values = JSON.parse(String(init?.body ?? "{}"));
      delete values.businessId;
      const response = await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save", step: formStep, values }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) return Response.json({ error: textingUpgradeErrorMessage(payload.code ?? payload.error) }, { status: response.status });
      const next = payload.state as TextingUpgradeState;
      if (!next) return Response.json({ error: textingUpgradeErrorMessage(null) }, { status: 503 });
      acceptState(next, false);
      const risk = next.registration.riskReview;
      return Response.json(formStep === "use_case" && ["blocked", "pending_review"].includes(risk.status)
        ? { success: false, riskReview: risk }
        : { success: true });
    };
  }
  const phoneRequest: typeof fetch = async (input, init) => {
    if (!state?.upgrade) return Response.json({ error: "Choose a plan before selecting a number." }, { status: 409 });
    if (!init?.method || init.method === "GET") {
      const url = new URL(String(input), window.location.origin);
      url.searchParams.set("textingUpgradeId", state.upgrade.id);
      return fetch(`${url.pathname}${url.search}`);
    }
    const { phoneNumber } = JSON.parse(String(init.body ?? "{}"));
    const response = await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save", step: "phone", values: { phoneNumber, smsConsentAgreed: true } }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return Response.json({ error: textingUpgradeErrorMessage(payload.code ?? payload.error) }, { status: response.status });
    if (!payload.state) return Response.json({ error: textingUpgradeErrorMessage(null) }, { status: 503 });
    acceptState(payload.state, false);
    return Response.json({ number: { phone_number: payload.state.pendingPhoneNumber ?? payload.state.phoneNumber, pending: !payload.state.activePhoneNumber } });
  };

  const commonSetupReady = state ? state.businessHours.length === 7 && evaluateContentQuality(state.servicesAndFaqs).ready && state.aiSettings !== null : false;
  return <div className="mx-auto max-w-3xl space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-bold">Add texting</h1>
      <Link className={secondaryCtaClass} href="/dashboard">Return to dashboard</Link>
    </div>
    {error && <div role="alert" className={`rounded-xl p-4 ${statusWarning}`}><p>{error}</p><button className={`${secondaryCtaClass} mt-3`} disabled={busy} onClick={() => perform(() => requestState())}>Refresh status</button></div>}
    {!state ? <p role="status">{error ? "Your setup could not be loaded." : "Loading your texting setup…"}</p> : <>
      <p className="text-sm">{state.upgrade?.paidAt ? "Your business information and conversations stay in this account. Follow your texting upgrade status here." : "Your existing business information and conversations stay in this account. Setup does not charge you. Payment comes after your final review."}</p>
      {state.availableServicePlan === "chat_only" && state.upgrade?.state !== "activated" && <p className={`rounded-xl p-4 text-sm ${statusWarning}`}>Your current Chat Only service, including the same 200 AI replies per month, stays available while texting is being set up and reviewed. It is not an additional free allowance. After payment, the higher subscription price starts before carrier approval.</p>}
      {state.message && <p role="status">{state.message}</p>}
      {!state.eligible && !state.upgrade ? <p>Adding texting is not available for this account right now. <Link className="underline" href="/support">Contact support</Link> for help.</p> : <section className={`${card} p-5 sm:p-7`}>
        {step !== "status" && <p className="mb-5 text-sm" aria-live="polite">Step {TEXTING_UPGRADE_STEPS.indexOf(step) + 1} of 6 · {labels[step]}</p>}
        {step === "plan" && <div className="space-y-4">
          <h2 className="text-xl font-semibold">Choose your texting plan</h2>
          <p>Choose now, then review the exact upgrade charge and one-time $25 setup fee after setup.</p>
          {state.availablePlans.map((plan) => <label key={plan} className="flex cursor-pointer items-start gap-3 rounded-xl border p-4">
            <input className="mt-1" type="radio" name="texting-upgrade-plan" checked={selected === plan} disabled={busy || !state.actions.canSelect} onChange={() => { setSelected(plan); setStarterAcknowledged(false); }} />
            <span><span className="font-semibold">{SUBSCRIPTION_PLANS[plan].name} · ${SUBSCRIPTION_PLANS[plan].price}/month</span><span className="mt-1 block text-sm">{plan === "sms_only" ? "Manual texting and missed-call texts. Website chat ends when texting activates." : plan === "sms_and_chat" ? "Keep website chat and add AI texting." : "Keep website chat and add AI texting and voice."}</span></span>
          </label>)}
          {selected === "sms_only" && <StarterAcknowledgement checked={starterAcknowledged} onChange={setStarterAcknowledged} />}
          <button className={primaryCtaInlineClass} disabled={busy || !selected || !state.actions.canSelect || (selected === "sms_only" && !starterAcknowledged)} onClick={() => perform(() => requestState("", { action: "select", plan: selected, starterAcknowledged }))}>Continue setup</button>
        </div>}
        {step === "business" && state.actions.canSave && <><CommonSetupRepair state={state} busy={busy} onRefresh={() => perform(() => requestState())} /><BusinessInfoForm businessId={state.businessId} initialData={state.businessInfo} allowWebsiteScan={false} saveRequest={saveRequest("business")} onNext={() => navigate(commonSetupReady ? "verification" : "business")} onBack={() => navigate("plan")} /></>}
        {step === "verification" && state.actions.canSave && <BrandVerificationForm businessId={state.businessId} initialData={state.brandVerification ?? undefined} saveRequest={saveRequest("verification")} onNext={() => navigate("use_case")} onBack={() => navigate("business")} />}
        {step === "use_case" && state.actions.canSave && <SmsUseCaseForm businessId={state.businessId} businessName={state.businessInfo.name} businessType={state.businessInfo.business_type} businessTypeOther={state.businessInfo.business_type_other} language={state.aiSettings?.language ?? "en"} services={state.servicesAndFaqs.services} initialData={state.brandVerification} riskReview={state.registration.riskReview} saveRequest={saveRequest("use_case")} onNext={() => navigate("phone")} onBack={() => navigate("verification")} />}
        {step === "phone" && (state.actions.canSave || state.actions.canReplacePhone) && <div className="space-y-4">
          <h2 className="text-xl font-semibold">Choose your business texting number</h2>
          <PhoneNumberSelector initialPhoneNumber={state.activePhoneNumber ?? state.pendingPhoneNumber} initialPhoneNumberPending={!state.activePhoneNumber} initialConsentAgreed={state.smsConsentAgreed} initialFailureReason={state.pendingPhoneNumberFailureReason} request={phoneRequest} onReplacementModeChange={setReplacingPhone} pendingDescription="This is your preferred number. We secure it after payment, and texting starts after carrier approval. If it becomes unavailable, you can choose another without paying again." />
          <div className="flex flex-wrap gap-3"><button className={secondaryCtaClass} onClick={() => navigate(state.actions.canSave ? "use_case" : "status")}>Back</button><button className={primaryCtaInlineClass} disabled={shouldDisablePhoneNumberNext({ phoneNumber: state.activePhoneNumber ?? state.pendingPhoneNumber, pendingSelection: !state.activePhoneNumber, pendingFailureReason: state.pendingPhoneNumberFailureReason, replacingNumber: replacingPhone })} onClick={() => navigate(state.actions.canSave ? "review" : "status")}>Continue</button></div>
        </div>}
        {step === "review" && <div className="space-y-5">
          <h2 className="text-xl font-semibold">Review your texting upgrade</h2>
          <ReviewRow label="Plan" value={state.selectedPlan ? SUBSCRIPTION_PLANS[state.selectedPlan].name : "No plan selected"} onEdit={state.actions.canSelect ? () => navigate("plan") : undefined} />
          <ReviewRow label="Business" value={`${state.businessInfo.name} · ${state.businessInfo.address}, ${state.businessInfo.city}, ${state.businessInfo.state} ${state.businessInfo.zip}`} onEdit={state.actions.canSave ? () => navigate("business") : undefined} />
          <ReviewRow label="Business verification" value={state.brandVerification?.legal_business_name ? `${state.brandVerification.legal_business_name} · EIN ending ${state.brandVerification.ein?.slice(-4) ?? "not entered"} · ${state.brandVerification.authorized_rep_name ?? ""} (${state.brandVerification.authorized_rep_email ?? ""})` : "Not completed"} onEdit={state.actions.canSave ? () => navigate("verification") : undefined} />
          <ReviewRow label="Texting details" value={state.brandVerification?.use_case_description ?? "Not completed"} onEdit={state.actions.canSave ? () => navigate("use_case") : undefined} />
          {state.brandVerification?.sample_messages?.length ? <div className="text-sm"><h3 className="font-medium">Sample messages</h3><ul className="mt-2 list-disc space-y-2 pl-5">{state.brandVerification.sample_messages.map((message, index) => <li key={index}>{message}</li>)}</ul><p className="mt-3"><strong>Opt-in:</strong> {state.brandVerification.opt_in_description}</p></div> : null}
          <ReviewRow label="Phone number" value={state.activePhoneNumber ?? state.pendingPhoneNumber ?? "Not selected"} onEdit={state.actions.canSave ? () => navigate("phone") : undefined} />
          {state.quote ? <TextingUpgradePrice quote={state.quote} /> : <p>The exact amount is calculated after your saved details are checked. Your current subscription has not changed.</p>}
          {state.selectedPlan === "sms_only" && <StarterAcknowledgement checked={starterAcknowledged} onChange={setStarterAcknowledged} />}
          <p className="text-sm">Payment starts your upgraded subscription and carrier registration. Texting remains unavailable until approval; your existing Chat Only service continues during review. Carrier approval is not guaranteed. Carrier corrections and refund requests go through support under the existing setup-fee policy. The setup fee is non-refundable after registration is submitted. To request subscription cancellation, <Link className="underline" href={supportHref("billing")}>contact billing support</Link>.</p>
          <div className="flex flex-wrap gap-3">
            <button className={secondaryCtaClass} disabled={busy} onClick={() => navigate("phone")}>Back</button>
            {state.actions.canQuote && <button className={state.quote ? secondaryCtaClass : primaryCtaInlineClass} disabled={busy} onClick={() => perform(() => requestState("/quote", {}), false)}>{state.quote ? "Refresh price" : "Review exact price"}</button>}
            {state.quote && state.actions.canConfirm && <button className={primaryCtaInlineClass} disabled={busy || Date.parse(state.quote.expiresAt) <= Date.now() || (state.selectedPlan === "sms_only" && !starterAcknowledged)} onClick={() => perform(() => requestState("/confirm", { operationId: state.quote!.operationId, quoteFingerprint: state.quote!.quoteFingerprint, starterAcknowledged }))}>Confirm upgrade and pay {money(state.quote.amountDueCents, state.quote.currency)}</button>}
          </div>
        </div>}
        {step === "status" && <div className="space-y-4">
          <h2 className="text-xl font-semibold">{state.upgrade?.state === "activated" ? "Your texting plan is active" : state.upgrade?.state === "payment_pending" ? "Payment confirmation" : state.upgrade?.state === "support_required" ? "Registration needs support" : "Carrier review and number activation"}</h2>
          {state.upgrade?.state === "activated" ? <p>{state.selectedPlan === "sms_only" ? "Starter is now active. Website chat and appointment scheduling have ended; your saved data remains in your account." : "Your new plan is active. You can keep using chat and start texting from your dashboard."}</p> : <p>{state.paymentStatus === "paid" ? state.availableServicePlan === "chat_only" ? "Your upgrade payment is confirmed. Texting remains unavailable until carrier and phone-number setup are complete. Your existing chat service remains available." : "Your upgrade payment is recorded. Contact support to resolve your current subscription or registration status." : "If you already paid, refresh the status to recover that payment. Do not start a separate subscription."}</p>}
          {state.quote?.paymentUrl && <a className={primaryCtaInlineClass} href={state.quote.paymentUrl}>Complete payment</a>}
          <div className="flex flex-wrap gap-3">
            {state.actions.canRefresh && <button className={primaryCtaInlineClass} disabled={busy} onClick={() => perform(() => requestState("/refresh", {}))}>Refresh status</button>}
            {state.actions.canReplacePhone && <button className={secondaryCtaClass} disabled={busy} onClick={() => navigate("phone")}>Choose another number</button>}
            <Link className={secondaryCtaClass} href={supportHref("number_registration")}>Contact support</Link>
          </div>
        </div>}
      </section>}
      {state.actions.canCancel && <button className={secondaryCtaClass} disabled={busy} onClick={() => perform(() => requestState("/cancel", {}))}>Cancel this upgrade request</button>}
    </>}
  </div>;
}
function StarterAcknowledgement({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return <div className={`rounded-xl p-4 ${statusWarning}`}><p>{STARTER_LOSS_COPY}</p><label className="mt-3 flex items-start gap-2"><input className="mt-1" type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span>I understand that website chat, AI chat, and appointment scheduling will stop when Starter activates, including AI customization and calendar access.</span></label></div>;
}
function ReviewRow({ label, value, onEdit }: { label: string; value: string; onEdit?: () => void }) {
  return <div className="flex items-start justify-between gap-3 border-b pb-3"><div className="min-w-0"><h3 className="font-medium">{label}</h3><p className="break-words text-sm">{value}</p></div>{onEdit && <button className={secondaryCtaClass} onClick={onEdit} aria-label={`Edit ${label.toLowerCase()}`}>Edit</button>}</div>;
}
function money(cents: number, currency = "usd") { return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100); }
export function TextingUpgradePrice({ quote }: { quote: TextingUpgradeQuote }) {
  return <div className="rounded-xl border p-4 space-y-2"><p className="font-semibold">{money(quote.amountDueCents, quote.currency)} due now</p><p>Includes the one-time {money(quote.setupFeeCents, quote.currency)} setup fee and the prorated subscription change.</p><p>{money(quote.monthlyPriceCents, quote.currency)}/month{quote.renewalAt ? ` from ${new Date(quote.renewalAt).toLocaleDateString()}` : " at renewal"}. Your renewal date stays the same.</p><p className="text-sm">Quote expires {new Date(quote.expiresAt).toLocaleString()}.</p></div>;
}

export function CommonSetupRepair({ state, busy, onRefresh }: { state: TextingUpgradeState; busy: boolean; onRefresh: () => void }) {
  const missingHours = state.businessHours.length !== 7;
  const missingKnowledge = !evaluateContentQuality(state.servicesAndFaqs).ready;
  const missingAi = state.aiSettings === null;
  if (!missingHours && !missingKnowledge && !missingAi) return null;
  return <div role="status" className={`mb-5 rounded-xl p-4 ${statusWarning}`}><p className="font-medium">Finish your existing business setup before continuing.</p><ul className="mt-2 list-disc pl-5">{missingHours && <li>Review all seven days of business hours in <Link className="underline" href="/settings">Settings</Link>.</li>}{missingKnowledge && <li>Add at least three services and three answered FAQs in <Link className="underline" href="/settings/knowledge">Assistant Knowledge</Link>.</li>}{missingAi && <li>Complete your assistant settings in <Link className="underline" href="/settings">Settings</Link>.</li>}</ul><button className={`${secondaryCtaClass} mt-3`} disabled={busy} onClick={onRefresh}>Refresh saved setup</button></div>;
}
