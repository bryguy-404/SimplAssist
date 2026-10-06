"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { CheckCircle2, MessageSquare, RefreshCw } from "lucide-react";
import { useHashTarget } from "@/lib/ui/useHashTarget";
import type {
  ReviewSmsOverview,
  ReviewSmsQuote,
  ReviewSmsState,
} from "@/lib/billing/reviewSms";
import PhoneNumberSelector from "@/components/phone/PhoneNumberSelector";
import CustomerDialog from "@/components/customers/CustomerDialog";
import { requestError } from "@/components/customers/customerUi";
import {
  body,
  btnPrimaryInline,
  btnSecondaryCompact,
  btnSecondaryInline,
  card,
  ink,
  statusDanger,
  statusSuccess,
  statusWarning,
  tile,
} from "@/lib/theme-v2/theme";
import { reviewReason, reviewRequest, reviewTime } from "./reviewUi";
import { LEGAL_FIELDS, REPRESENTATIVE_FIELDS, ReviewSmsRegistrationFields, ReviewSmsRegistrationNotice } from "./ReviewSmsRegistration";

const ENDPOINT = "/api/reviews/sms";
const STATES: Record<ReviewSmsState, string> = {
  draft: "Setup saved",
  activation_pending: "Activation payment pending",
  carrier_pending: "Carrier approval in progress",
  ready_unpaid: "Approved — finish activation",
  active: "Text review requests active",
  cancel_pending: "Cancellation scheduled",
  support_required: "Approval needs attention",
  release_pending: "Closing review texting",
  released: "Review texting closed",
};
const amount = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );

export function smsPriceSummary(overview: ReviewSmsOverview): string {
  if (overview.eligibleSource === "included")
    return "Included with your texting plan after review-request approval";
  if (overview.eligibleSource === "grant")
    return "Texting access is managed by your account provider";
  if (overview.price.ownerDiscountApplied)
    return "$0/month with your verified owner discount after approval and activation";
  return `${amount(overview.price.monthlyCents)}/month added to your current plan after approval and activation`;
}

function SmsSetupForm({
  overview,
  onSaved,
}: {
  overview: ReviewSmsOverview;
  onSaved: () => Promise<void>;
}) {
  const id = useId();
  const initialPhone =
    typeof overview.account?.draft.phoneNumber === "string"
      ? overview.account.draft.phoneNumber
      : String(overview.setup?.fields.phoneNumber || "");
  const [phone, setPhone] = useState(initialPhone);
  const [consented, setConsented] = useState(Boolean(initialPhone));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields = overview.setup?.fields || {};
  const included = overview.eligibleSource === "included";
  const sharedRegistration = overview.sharedRegistration;
  const onConsentChange = useCallback(
    (value: boolean) => setConsented(value),
    [],
  );
  const phoneRequest: typeof fetch = async (input, init) => {
    if (!init?.method || init.method === "GET") {
      const url = new URL(String(input), window.location.origin);
      return fetch(
        `${ENDPOINT}/numbers?areaCode=${encodeURIComponent(url.searchParams.get("areaCode") || "")}`,
        { cache: "no-store" },
      );
    }
    const value = JSON.parse(String(init.body || "{}")) as {
      phoneNumber?: string;
    };
    if (!value.phoneNumber)
      return Response.json(
        { error: "Choose a phone number." },
        { status: 400 },
      );
    setPhone(value.phoneNumber);
    return Response.json({
      number: { phone_number: value.phoneNumber, pending: true },
    });
  };
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const draft: Record<string, string> = {
      phoneNumber: phone,
      consentMode: "hosted_keyword",
    };
    const editableFields = sharedRegistration
      ? sharedRegistration.status === "approved" && fields.representativeEditable === true ? REPRESENTATIVE_FIELDS : []
      : [
        ...LEGAL_FIELDS.map(([name]) => name),
        "entityType",
        "ein",
        "state",
      ];
    for (const key of editableFields) {
      const value = String(form.get(key) || "").trim();
      if (value) draft[key] = value;
    }
    setBusy(true);
    setError(null);
    try {
      await reviewRequest(ENDPOINT, {
        method: "POST",
        body: JSON.stringify({ action: "draft", draft }),
      });
      await onSaved();
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={save} className="mt-6 space-y-5">
      <fieldset disabled={busy} className="space-y-4 disabled:opacity-60">
        <legend className={`mb-4 text-sm font-semibold ${ink}`}>
          Business registration
        </legend>
        <ReviewSmsRegistrationFields overview={overview} id={id} />
        <div className={`${tile} p-4`}>
          <p className={`font-semibold ${ink}`}>Customer permission page included</p>
          <p className={`mt-2 text-sm ${body}`}>
            We create a page for your business that explains review texts.
            Customers opt in by texting REVIEWS from their own phone to your
            business number. We save that permission automatically. Adding or
            importing a phone number does not sign anyone up.
          </p>
          {fields.consentUrl && overview.account ? <a href={String(fields.consentUrl)} target="_blank" rel="noreferrer" className="mt-3 inline-block text-sm underline">View your permission page</a> : <p className={`mt-2 text-xs ${body}`}>Your page will be available after you save these details.</p>}
        </div>
      </fieldset>
      {included ? (
        <div className={`${tile} p-4`}>
          <p className={`text-sm font-semibold ${ink}`}>
            Your existing texting number
          </p>
          <p className={`mt-2 text-sm ${body}`}>
            {phone ||
              "Your number needs to be confirmed before approval. Contact support."}
          </p>
        </div>
      ) : (
        <PhoneNumberSelector
          selectionBusyLabel="Selecting…"
          initialPhoneNumber={initialPhone || undefined}
          initialPhoneNumberPending
          initialConsentAgreed={Boolean(initialPhone)}
          request={phoneRequest}
          onConsentChange={onConsentChange}
          onNumberPurchased={setPhone}
          onReplacementModeChange={(replacing) => {
            if (replacing) setPhone("");
          }}
          pendingDescription="This is a preferred number, not a purchase or reservation. Save your details, then complete paid registration. Texting starts after approval and activation."
          consentDescription="I authorize registration of this number for my business’s automated review requests to customers who have agreed to receive them. I will keep permission records and honor opt-outs. Customers may reply STOP at any time."
        />
      )}
      {error ? (
        <p role="alert" className={`rounded-2xl p-3 text-sm ${statusDanger}`}>
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy || !phone || (!included && !consented)}
        className={`${btnPrimaryInline} disabled:opacity-50`}
      >
        {busy ? "Saving…" : "Save approval details"}
      </button>
    </form>
  );
}

export default function ReviewSmsPanel({
  onStatusChanged,
  active = true,
}: {
  onStatusChanged: (canSend: boolean) => void;
  active?: boolean;
}) {
  const [overview, setOverview] = useState<ReviewSmsOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const section = useHashTarget<HTMLElement>("review-sms", active && Boolean(overview || error));
  const [notice, setNotice] = useState<string | null>(null);
  const [quote, setQuote] = useState<ReviewSmsQuote | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [feeAgreed, setFeeAgreed] = useState(false);
  const load = useCallback(async () => {
    const value = await reviewRequest<ReviewSmsOverview>(ENDPOINT);
    setOverview(value);
    onStatusChanged(value.enabled && value.canSend);
  }, [onStatusChanged]);
  useEffect(() => {
    let current = true;
    reviewRequest<ReviewSmsOverview>(ENDPOINT)
      .then((value) => {
        if (current) {
          setOverview(value);
          onStatusChanged(value.enabled && value.canSend);
        }
      })
      .catch((cause) => {
        if (current) setError(requestError(cause));
      });
    return () => {
      current = false;
    };
  }, [onStatusChanged]);
  async function perform(action: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (action === "quote") {
        setQuote(
          await reviewRequest<ReviewSmsQuote>(ENDPOINT, {
            method: "POST",
            body: JSON.stringify({ action }),
          }),
        );
        return;
      }
      const result = await reviewRequest<{
        url?: string;
        paymentUrl?: string;
        active?: boolean;
        refunded?: boolean;
        cancelAt?: string;
      }>(ENDPOINT, {
        method: "POST",
        body: JSON.stringify({
          action,
          ...(action === "activate" && quote
            ? { operationId: quote.operationId, fingerprint: quote.fingerprint }
            : {}),
        }),
      });
      const destination = result.url || result.paymentUrl;
      if (destination) {
        const url = new URL(destination);
        if (
          url.protocol !== "https:" ||
          ![
            "checkout.stripe.com",
            "invoice.stripe.com",
            "billing.stripe.com",
          ].includes(url.hostname)
        )
          throw new Error(
            "The payment link could not be verified. Refresh and try again.",
          );
        window.location.assign(url.toString());
        return;
      }
      setQuote(null);
      setCancelOpen(false);
      await load();
      if (action === "refund")
        setNotice(
          "Your unsubmitted activation was canceled and the refund was requested.",
        );
      if (action === "cancel")
        setNotice(
          `Review texting will end ${result.cancelAt ? reviewTime(result.cancelAt) : "at the end of the paid period"}.`,
        );
      if (action === "activate")
        setNotice(
          result.active
            ? "Text review requests are active."
            : "Payment is being confirmed. Refresh to check activation.",
        );
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
    }
  }
  const account = overview?.account;
  const direct = overview?.eligibleSource === "direct";
  const state = account?.state;
  const registrationUnavailable = overview?.sharedRegistration?.status === "revoked";
  const activationRecovery = !account?.activation_paid_at && overview?.sharedRegistration?.activationRecoveryAvailable === true;
  const newActivationAllowed = !overview?.sharedRegistration || overview.sharedRegistration.newPaidStartsAllowed === true;
  return (
    <section
      className={`${card} p-5 sm:p-7`}
      id="review-sms"
      ref={section}
      tabIndex={-1}
      aria-labelledby="review-sms-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="review-sms-title"
            className={`flex items-center gap-2 text-lg font-semibold ${ink}`}
          >
            <MessageSquare className="h-5 w-5" />
            Text review requests
          </h2>
          <p className={`mt-1 text-sm ${body}`}>
            {direct && !account
              ? "Give customers an easy way to open your Google review link, right from a text message."
              : "Add text invitations after your business and review-request use case are approved."}
          </p>
        </div>
        {account || registrationUnavailable ? <button
          type="button"
          disabled={busy || !overview?.enabled}
          onClick={() => perform("refresh")}
          className={`${btnSecondaryCompact} disabled:opacity-50`}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Check status
        </button> : null}
      </div>
      {error && !quote && !cancelOpen ? (
        <p
          role="alert"
          className={`mt-4 rounded-2xl p-3 text-sm ${statusDanger}`}
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          className={`mt-4 rounded-2xl p-3 text-sm ${statusSuccess}`}
        >
          {notice}
        </p>
      ) : null}
      {!overview && !error ? (
        <p role="status" className={`mt-4 text-sm ${body}`}>
          Loading texting setup…
        </p>
      ) : null}
      {overview ? (
        !overview.enabled ? (
          <p className={`mt-4 text-sm ${body}`}>
            Review texting is not available for this account yet. Email reviews
            remain available.
          </p>
        ) : (
          <div className="mt-5 space-y-5">
            <ReviewSmsRegistrationNotice overview={overview} />
            <div className={`${tile} p-4`}>
              <p className={`font-semibold ${ink}`}>
                {smsPriceSummary(overview)}
              </p>
              {direct ? <p className={`mt-2 text-sm ${body}`}>
                {overview.price.ownerDiscountApplied
                  ? "Your owner discount covers Chat and the monthly review-texting add-on. The one-time activation fee still applies."
                  : "With the standard $15 Chat plan, that makes $35/month in total. The monthly add-on begins only after approval and your payment confirmation."}
              </p> : null}
              <p className={`mt-2 text-sm ${body}`}>
                {overview.price.includedParts} total SMS parts per full billing
                period. Inbound texts, invitations, replies, and reminders share
                this allowance. Longer messages can use several parts.
              </p>
              {direct ? (
                <p className={`mt-2 text-sm ${body}`}>
                  {amount(overview.price.activationCents)} one-time activation
                  covers one submitted application. It is refundable before
                  submission; after submission it covers that attempt. Further
                  paid attempts require a separate quote. SimplAssist covers
                  corrections caused by its own mistakes.
                </p>
              ) : null}
            </div>
            {overview.setup?.fields.consentUrl && (account || overview.setup?.fields.reviewSignupEnabled) ? (
              <div className={`${tile} p-4`}>
                <p className={`font-semibold ${ink}`}>Collect permission for review texts</p>
                <p className={`mt-2 text-sm ${body}`}>Share this page on your website or after a completed job. Customers text REVIEWS to your business number to opt in. Permission is saved in Customers; sending a review request is a separate step.</p>
                <a href={String(overview.setup.fields.consentUrl)} target="_blank" rel="noreferrer" className="mt-3 inline-block break-all text-sm underline">{String(overview.setup.fields.consentUrl)}</a>
              </div>
            ) : null}
            {account ? (
              <div>
                <p className={`flex items-center gap-2 font-semibold ${ink}`}>
                  {overview.canSend ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : null}
                  {STATES[account.state]}
                </p>
                {account.last_error ? (
                  <p className={`mt-2 text-sm ${body}`}>
                    {reviewReason(account.last_error)}
                  </p>
                ) : null}
              </div>
            ) : null}
            {direct && !account && !registrationUnavailable ? (
              <div className="space-y-3">
                <h3 className={`text-sm font-semibold ${ink}`}>Before your first text</h3>
                <p className={`text-sm ${body}`}>
                  We’ll help you choose a texting number and submit your business
                  and review-text program for carrier approval. Once approved
                  and your number is ready, you’ll confirm the prorated monthly
                  price before texting is activated. Your renewal date stays the same.
                </p>
                <p className={`text-sm ${body}`}>
                  Customers need to agree to receive review texts. Your setup
                  includes a permission page and opt-out handling. You can keep
                  using web chat and email reviews while approval is pending.
                </p>
                <button
                  type="button"
                  aria-expanded={editing}
                  aria-controls={editing ? "review-sms-registration" : undefined}
                  onClick={() => setEditing(!editing)}
                  className={editing ? btnSecondaryInline : btnPrimaryInline}
                >
                  {editing ? "Back to overview" : "Start texting setup"}
                </button>
                {!editing ? <p className={`text-xs ${body}`}>
                  Explore the setup first. Nothing is charged or submitted for
                  carrier approval until you confirm the activation payment.
                </p> : null}
              </div>
            ) : null}
            {!registrationUnavailable && (editing || (!account && !direct)) && overview.eligibleSource !== "grant" ? (
              <div id="review-sms-registration">
                <SmsSetupForm
                  key={`${editing ? "edit" : "new"}-${overview.sharedRegistration?.identityVersion ?? "standalone"}`}
                  overview={overview}
                  onSaved={async () => {
                    await load();
                    setEditing(false);
                    setNotice(
                      "Approval details saved. No registration charge has been made.",
                    );
                  }}
                />
              </div>
            ) : null}
            {overview.eligibleSource === "grant" ? (
              <p className={`text-sm ${body}`}>
                Contact your account provider to arrange review texting and
                confirm the included allowance. This screen does not charge your
                card.
              </p>
            ) : null}
            {account &&
            ["draft", "activation_pending"].includes(account.state) &&
            !editing && (!registrationUnavailable || activationRecovery) ? (
              <div className="space-y-4">
                <p className={`text-sm ${body}`}>
                  Preferred number:{" "}
                  {String(account.draft.phoneNumber || "Not selected")}
                </p>
                {!registrationUnavailable ? <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className={btnSecondaryCompact}
                >
                  Edit approval details
                </button> : null}
                {direct ? (
                  account.activation_paid_at ? (
                    <p className={`text-sm ${body}`}>Your activation payment was received. Check status to follow the approval process.</p>
                  ) : activationRecovery ? (
                    <button type="button" disabled={busy} onClick={() => perform("checkout")} className={`${btnPrimaryInline} disabled:opacity-50`}>
                      Continue activation
                    </button>
                  ) : newActivationAllowed ? <>
                    <label className={`flex items-start gap-3 text-sm ${body}`}>
                      <input
                        type="checkbox"
                        checked={feeAgreed}
                        onChange={(event) => setFeeAgreed(event.target.checked)}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand-primary)]"
                      />
                      I understand the activation charge covers one submitted
                      application and approval is required before review texts
                      can be sent.
                    </label>
                    <button
                      type="button"
                      disabled={busy || !feeAgreed}
                      onClick={() => perform("checkout")}
                      className={`${btnPrimaryInline} disabled:opacity-50`}
                    >
                      Pay {amount(overview.price.activationCents)} and request
                      approval
                    </button>
                  </> : (
                    <p className={`text-sm ${body}`}>New text review activations are not available for this account yet. Your approval details are saved.</p>
                  )
                ) : (
                  <p className={`rounded-2xl p-3 text-sm ${statusWarning}`}>
                    Your current registration does not include review requests.
                    Contact support to update an existing texting registration.
                    New accounts can include review texts during texting setup.
                  </p>
                )}
              </div>
            ) : null}
            {state === "support_required" || state === "released" ? (
              <p className={`text-sm ${body}`}>
                Contact support before starting another application. Any
                additional paid attempt will be quoted separately; you will not
                be charged automatically.
              </p>
            ) : null}
            {state === "carrier_pending" ? (
              <p className={`text-sm ${body}`}>
                Your business registration is being reviewed. Email reviews
                remain available. {direct ? "The monthly review-texting add-on starts only after approval and successful payment." : "Review texts activate automatically after approval and number assignment, using your plan’s existing SMS allowance."}
              </p>
            ) : null}
            {state === "ready_unpaid" && !registrationUnavailable ? (
              <div className="space-y-3">
                <p className={`text-sm ${body}`}>
                  Your number is ready. Review the prorated charge and
                  first-period SMS allowance before activating.
                  {account?.ready_expires_at
                    ? ` Complete payment by ${reviewTime(account.ready_expires_at)} to keep this setup.`
                    : ""}
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => perform("quote")}
                  className={`${btnPrimaryInline} disabled:opacity-50`}
                >
                  Review activation price
                </button>
              </div>
            ) : null}
            {state === "active" || state === "cancel_pending" ? (
              <div className="space-y-3">
                <p className={`text-sm ${body}`}>
                  {overview.eligibleSource === "included"
                    ? overview.price.includedParts
                    : (account?.period_allowance ??
                      overview.price.includedParts)}{" "}
                  parts in the current period
                  {account?.paid_period_end
                    ? `, ending ${reviewTime(account.paid_period_end)}`
                    : ""}
                  .{" "}
                  {overview.canSend
                    ? "Text is now available when creating a review request."
                    : "Sending is currently unavailable. Check billing or refresh the approval status."}
                </p>
                {direct && state === "active" ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setCancelOpen(true);
                      setError(null);
                    }}
                    className={btnSecondaryInline}
                  >
                    Cancel review texting
                  </button>
                ) : null}
              </div>
            ) : null}
            {state === "cancel_pending" && account?.cancel_at ? (
              <p className={`rounded-2xl p-3 text-sm ${statusWarning}`}>
                Review texting ends {reviewTime(account.cancel_at)}. Complete
                any number transfer before then; your base plan remains active.
                Contact support about your review number.
              </p>
            ) : null}
            {account?.activation_paid_at &&
            !account.provider_started_at &&
            !account.provider_submitted_at &&
            !account.activation_refunded_at &&
            direct ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => perform("refund")}
                className={`${btnSecondaryInline} disabled:opacity-50`}
              >
                Cancel before submission and refund activation
              </button>
            ) : null}
          </div>
        )
      ) : null}
      {quote && !registrationUnavailable ? (
        <CustomerDialog
          title="Activate review texting"
          onClose={() => setQuote(null)}
          busy={busy}
        >
          <div className="space-y-4">
            <p className={`text-2xl font-semibold ${ink}`}>
              {amount(quote.amountDueCents)} due today
            </p>
            <p className={`text-sm ${body}`}>
              Includes {quote.includedParts} SMS parts through{" "}
              {reviewTime(quote.periodEnd)}. This first allowance and charge are
              prorated to your existing billing cycle.
            </p>
            <p className={`text-sm ${body}`}>
              {quote.ownerDiscountApplied
                ? "Your verified owner discount keeps Chat and review texting at $0 per month, with 250 total SMS parts per full period. "
                : `Then ${amount(quote.monthlyPriceCents)} per month in addition to your current base plan, with 250 total SMS parts per full period. `}
              Review texting does not add missed-call or AI texting features.
            </p>
            <p className={`text-xs ${body}`}>
              Quote expires {reviewTime(quote.expiresAt)}.
            </p>
            {error ? (
              <p
                role="alert"
                className={`rounded-2xl p-3 text-sm ${statusDanger}`}
              >
                {error}
              </p>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={() => perform("activate")}
              className={`${btnPrimaryInline} disabled:opacity-50`}
            >
              {busy
                ? "Confirming payment…"
                : `Activate for ${amount(quote.amountDueCents)}`}
            </button>
          </div>
        </CustomerDialog>
      ) : null}
      {cancelOpen ? (
        <CustomerDialog
          title="Cancel review texting"
          onClose={() => setCancelOpen(false)}
          busy={busy}
        >
          <div className="space-y-4">
            <p className={`text-sm ${body}`}>
              Review texting will remain available until{" "}
              {account?.paid_period_end
                ? reviewTime(account.paid_period_end)
                : "the end of your paid term"}
              . Your base plan and email reviews stay active.
            </p>
            <p className={`rounded-2xl p-3 text-sm ${statusWarning}`}>
              If you want to keep your review number, complete its transfer
              before the paid term ends. Contact support about your review
              number.
            </p>
            {error ? (
              <p
                role="alert"
                className={`rounded-2xl p-3 text-sm ${statusDanger}`}
              >
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-3">
              <button
                disabled={busy}
                onClick={() => perform("cancel")}
                className={`${btnPrimaryInline} disabled:opacity-50`}
              >
                {busy ? "Scheduling cancellation…" : "Cancel at term end"}
              </button>
              <button
                disabled={busy}
                onClick={() => setCancelOpen(false)}
                className={btnSecondaryInline}
              >
                Keep review texting
              </button>
            </div>
          </div>
        </CustomerDialog>
      ) : null}
    </section>
  );
}
