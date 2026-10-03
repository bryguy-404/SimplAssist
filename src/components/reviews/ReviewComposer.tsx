"use client";

import { useEffect, useId, useState } from "react";
import { ChevronLeft, ChevronRight, Mail, Search } from "lucide-react";
import type {
  CustomerDetailResponse,
  CustomerListResponse,
  CustomerRecord,
} from "@/lib/customers/types";
import type { ReviewOverview, ReviewPreview } from "@/lib/reviews/types";
import {
  body,
  btnPrimaryInline,
  btnSecondaryCompact,
  btnSecondaryInline,
  fieldLabel,
  ink,
  inputField,
  statusDanger,
  statusNeutral,
  statusWarning,
  tile,
} from "@/lib/theme-v2/theme";
import CustomerDialog from "@/components/customers/CustomerDialog";
import {
  customerName,
  customerPhone,
  customerRequest,
  requestError,
} from "@/components/customers/customerUi";
import {
  reviewReason,
  reviewRequest,
  reviewSchedule,
  reviewTime,
} from "./reviewUi";

/** Render tracking URLs as inert text so opening a preview cannot register a click. */
export function ReviewEmailPreview({
  sample,
  channel = "email",
}: {
  sample: ReviewPreview["sample"];
  channel?: "email" | "sms";
}) {
  return (
    <div className={`${tile} p-5`}>
      <h3 className={`text-sm font-semibold ${ink}`}>
        {channel === "sms" ? "Text preview" : "Email preview"}
      </h3>
      {sample ? (
        <>
          <p className={`mt-3 font-semibold ${ink}`}>{sample.subject}</p>
          <pre
            className={`mt-3 whitespace-pre-wrap break-words font-sans text-sm [overflow-wrap:anywhere] ${body}`}
          >
            {sample.text}
          </pre>
        </>
      ) : (
        <p className={`mt-3 text-sm ${body}`}>
          No eligible recipients. Go back to update your selection.
        </p>
      )}
    </div>
  );
}

export function previewSendingEnabled(
  preview: ReviewPreview,
  emailEnabled: boolean,
): boolean {
  return preview.channel === "sms"
    ? preview.sendingEnabled === true
    : (preview.sendingEnabled ?? emailEnabled);
}

export default function ReviewComposer({
  overview,
  initialCustomerId,
  smsReady = false,
  onClose,
  onCreated,
}: {
  overview: ReviewOverview;
  initialCustomerId?: string;
  smsReady?: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const id = useId();
  const [customers, setCustomers] = useState<CustomerListResponse | null>(null);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Record<string, CustomerRecord>>({});
  const [subject, setSubject] = useState(overview.settings.subject);
  const [channel, setChannel] = useState<"email" | "sms">("email");
  const [emailMessage, setEmailMessage] = useState(overview.settings.body);
  const [smsMessage, setSmsMessage] = useState(
    "Thank you for choosing {{business_name}}. Would you share an honest Google review?",
  );
  const message = channel === "sms" ? smsMessage : emailMessage;
  const setMessage = channel === "sms" ? setSmsMessage : setEmailMessage;
  const destination = (customer: CustomerRecord) =>
    channel === "sms" ? customerPhone(customer) : customer.email;
  const [scheduleMode, setScheduleMode] = useState("now");
  const [scheduledAt, setScheduledAt] = useState("");
  const [reminder, setReminder] = useState(overview.settings.reminder_enabled);
  const [completed, setCompleted] = useState(false);
  const [permission, setPermission] = useState(false);
  const [preview, setPreview] = useState<ReviewPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deviceZone, setDeviceZone] = useState("your current time zone");
  const selection = Object.values(selected);

  useEffect(() => {
    setDeviceZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(search);
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const parameters = new URLSearchParams({
      q: query,
      page: String(page),
      pageSize: "25",
    });
    customerRequest<CustomerListResponse>(`/api/customers?${parameters}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setCustomers(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(requestError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [query, page]);
  useEffect(() => {
    if (!initialCustomerId) return;
    const controller = new AbortController();
    customerRequest<CustomerDetailResponse>(
      `/api/customers/${encodeURIComponent(initialCustomerId)}`,
      { signal: controller.signal },
    )
      .then(({ customer }) => {
        if (!controller.signal.aborted)
          setSelected((current) => ({ ...current, [customer.id]: customer }));
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(requestError(cause));
      });
    return () => controller.abort();
  }, [initialCustomerId]);
  function toggle(customer: CustomerRecord) {
    setSelected((current) => {
      const next = { ...current };
      if (next[customer.id]) delete next[customer.id];
      else if (Object.keys(next).length < 500) next[customer.id] = customer;
      return next;
    });
  }
  async function createPreview() {
    setBusy(true);
    setError(null);
    try {
      const value = await reviewRequest<ReviewPreview>("/api/reviews/preview", {
        method: "POST",
        body: JSON.stringify({
          contactIds: Object.keys(selected),
          ...(channel === "email" ? { subject } : {}),
          body: message,
          channel,
          ...(scheduleMode === "later"
            ? { scheduledAt: reviewSchedule(scheduledAt) }
            : {}),
          reminderEnabled: reminder,
          completedServiceConfirmed: completed,
          permissionConfirmed: permission,
        }),
      });
      setPreview(value);
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (
      !preview ||
      busy ||
      !previewSendingEnabled(preview, overview.eligibility.sendingEnabled) ||
      preview.summary.eligible === 0
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await reviewRequest("/api/reviews/campaigns", {
        method: "POST",
        body: JSON.stringify({ previewToken: preview.previewToken }),
      });
      onCreated();
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <CustomerDialog
      title={preview ? "Confirm review requests" : "Request Google reviews"}
      description={
        preview
          ? "Check the recipients, message, and send times before scheduling."
          : "Choose customers whose work is complete, then preview the exact message."
      }
      onClose={onClose}
      busy={busy}
      wide
    >
      <div className="space-y-6">
        {preview ? (
          <>
            <div className="grid grid-cols-3 gap-3">
              {[
                [preview.summary.selected, "Selected"],
                [preview.summary.eligible, "Ready to send"],
                [preview.summary.excluded, "Excluded"],
              ].map(([count, label]) => (
                <div key={label} className={`${tile} p-4`}>
                  <p className={`text-2xl font-semibold ${ink}`}>{count}</p>
                  <p className={`mt-1 text-xs ${body}`}>{label}</p>
                </div>
              ))}
            </div>
            <ReviewEmailPreview
              sample={preview.sample}
              channel={preview.channel}
            />
            <section>
              <h3 className={`text-sm font-semibold ${ink}`}>
                Recipients and scheduled times
              </h3>
              <div className="mt-3 max-h-64 overflow-auto rounded-2xl border border-[#ece4d8] dark:border-white/10">
                <table className={`w-full text-left text-sm ${body}`}>
                  <thead className="sticky top-0 bg-[#faf7f2] dark:bg-[#202023]">
                    <tr>
                      <th className="p-3">Customer</th>
                      <th className="p-3">Send time</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100 dark:divide-white/5">
                    {preview.recipients.map((recipient) => (
                      <tr key={recipient.contactId}>
                        <td className="p-3">
                          <span className={ink}>{recipient.name}</span>
                          <span className="mt-1 block text-xs">
                            {preview.channel === "sms"
                              ? recipient.phone
                              : recipient.email}
                          </span>
                        </td>
                        <td className="p-3 text-xs">
                          {reviewTime(
                            recipient.scheduledAt,
                            recipient.timezone,
                          )}
                          <span className="mt-1 block">
                            {recipient.timezone}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            {preview.excluded.length ? (
              <details className={`${tile} p-4`}>
                <summary
                  className={`cursor-pointer text-sm font-semibold ${ink}`}
                >
                  Why {preview.excluded.length}{" "}
                  {preview.excluded.length === 1
                    ? "customer is"
                    : "customers are"}{" "}
                  excluded
                </summary>
                <ul className={`mt-3 space-y-2 text-sm ${body}`}>
                  {preview.excluded.map((item) => (
                    <li key={item.contactId}>
                      {selected[item.contactId]
                        ? customerName(selected[item.contactId])
                        : "Customer"}
                      : {reviewReason(item.reason)}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <div className={`space-y-2 text-sm ${body}`}>
              <p>
                {preview.reminderEnabled
                  ? "One reminder is scheduled four days after the first invitation is accepted, unless the customer clicks the Google link or requests stop."
                  : "No reminder will be sent."}
              </p>
              <p>
                {preview.channel === "sms"
                  ? `Up to ${preview.estimatedSmsParts || 0} SMS parts including reminders. ${preview.usage.remaining} parts remain in the shared texting allowance.`
                  : `Up to ${preview.estimatedEmails} emails including reminders. ${preview.usage.remaining} emails remain in this billing period.`}
              </p>
              {preview.channel === "sms" ? (
                <p className="text-xs">
                  Inbound messages, other texts, and reminders use the same
                  allowance. Longer messages can use several parts.
                </p>
              ) : null}
              <p className="text-xs">
                Preview expires {reviewTime(preview.expiresAt)}. No message has
                been scheduled yet.
              </p>
            </div>
            {(preview.channel === "sms"
              ? preview.estimatedSmsParts || 0
              : preview.estimatedEmails) > preview.usage.remaining ? (
              <p className={`rounded-2xl p-3 text-sm ${statusWarning}`}>
                This selection may exceed your current allowance. Review
                requests pause at the limit without review overage charges.
                Reduce your selection to keep the whole request within this
                period’s allowance.
              </p>
            ) : null}
            {!previewSendingEnabled(
              preview,
              overview.eligibility.sendingEnabled,
            ) ? (
              <p className={`rounded-2xl p-3 text-sm ${statusWarning}`}>
                {preview.channel === "sms" ? "Text" : "Email"} sending is not
                active yet. Your preview is ready, but requests cannot be sent
                yet.
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-3 border-t border-[#ece4d8] pt-5 dark:border-white/10">
              <button
                disabled={busy}
                onClick={() => {
                  setPreview(null);
                  setError(null);
                }}
                className={btnSecondaryInline}
              >
                Back to edit
              </button>
              <button
                disabled={
                  busy ||
                  !previewSendingEnabled(
                    preview,
                    overview.eligibility.sendingEnabled,
                  ) ||
                  preview.summary.eligible === 0
                }
                onClick={confirm}
                className={`${btnPrimaryInline} disabled:opacity-50`}
              >
                <Mail className="h-4 w-4" />
                {busy
                  ? "Scheduling…"
                  : `Schedule ${preview.summary.eligible} ${preview.summary.eligible === 1 ? "request" : "requests"}`}
              </button>
            </div>
          </>
        ) : (
          <>
            <fieldset
              disabled={busy}
              className={`${tile} flex flex-wrap gap-5 p-4 text-sm ${body}`}
            >
              <legend className="sr-only">Request channel</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`${id}-channel`}
                  checked={channel === "email"}
                  onChange={() => {
                    setChannel("email");
                    setPermission(false);
                  }}
                />
                Email
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`${id}-channel`}
                  checked={channel === "sms"}
                  disabled={!smsReady}
                  onChange={() => {
                    setChannel("sms");
                    setPermission(false);
                  }}
                />
                Text{!smsReady ? " — approval and activation required" : ""}
              </label>
            </fieldset>
            <section>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className={`font-semibold ${ink}`}>1. Choose customers</h3>
                <span
                  className={`rounded-full px-3 py-1 text-xs ${statusNeutral}`}
                >
                  {selection.length} / 500 selected
                </span>
              </div>
              <div className="relative mt-3">
                <label className="sr-only" htmlFor={`${id}-search`}>
                  Find customers for review requests
                </label>
                <Search
                  className={`absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 ${body}`}
                />
                <input
                  id={`${id}-search`}
                  type="search"
                  maxLength={200}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Find a customer by name or email"
                  className={`${inputField} pl-11`}
                />
              </div>
              <div
                aria-busy={loading}
                className="mt-3 max-h-60 overflow-y-auto rounded-2xl border border-[#ece4d8] dark:border-white/10"
              >
                {loading ? (
                  <p role="status" className={`p-5 text-sm ${body}`}>
                    Loading customers…
                  </p>
                ) : customers?.customers.length ? (
                  <ul className="divide-y divide-stone-100 dark:divide-white/5">
                    {customers.customers.map((customer) => (
                      <li key={customer.id}>
                        <label
                          className={`flex cursor-pointer items-center gap-3 p-3 text-sm ${body}`}
                        >
                          <input
                            type="checkbox"
                            checked={Boolean(selected[customer.id])}
                            disabled={
                              busy ||
                              !destination(customer) ||
                              (!selected[customer.id] &&
                                selection.length >= 500)
                            }
                            onChange={() => toggle(customer)}
                            className="h-4 w-4 accent-[var(--brand-primary)]"
                          />
                          <span className="min-w-0 flex-1">
                            <span
                              className={`block truncate font-medium ${ink}`}
                            >
                              {customerName(customer)}
                            </span>
                            <span className="block truncate text-xs">
                              {destination(customer) ||
                                (channel === "sms"
                                  ? "Add a phone number before requesting a review"
                                  : "Add an email before requesting a review")}
                            </span>
                          </span>
                          <span className="text-xs capitalize">
                            {customer.customer_stage}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className={`p-5 text-sm ${body}`}>
                    No matching customers. Add or import customers from the
                    Customers page first.
                  </p>
                )}
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={loading || !customers?.customers.length || busy}
                    onClick={() =>
                      setSelected((current) => {
                        const next = { ...current };
                        for (const customer of customers?.customers || [])
                          if (
                            destination(customer) &&
                            Object.keys(next).length < 500
                          )
                            next[customer.id] = customer;
                        return next;
                      })
                    }
                    className={btnSecondaryCompact}
                  >
                    Select this page
                  </button>
                  {selection.length ? (
                    <button
                      type="button"
                      onClick={() => setSelected({})}
                      className={btnSecondaryCompact}
                    >
                      Clear selection
                    </button>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label="Previous customer results"
                    disabled={page <= 1 || loading}
                    onClick={() => setPage((value) => value - 1)}
                    className={`${btnSecondaryCompact} disabled:opacity-40`}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className={`text-xs ${body}`}>Page {page}</span>
                  <button
                    type="button"
                    aria-label="Next customer results"
                    disabled={
                      !customers ||
                      page >= customers.pagination.totalPages ||
                      loading
                    }
                    onClick={() => setPage((value) => value + 1)}
                    className={`${btnSecondaryCompact} disabled:opacity-40`}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
              {selection.length ? (
                <details className="mt-3">
                  <summary className={`cursor-pointer text-xs ${body}`}>
                    See all {selection.length} selected customers
                  </summary>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {selection.map((customer) => (
                      <button
                        type="button"
                        key={customer.id}
                        onClick={() => toggle(customer)}
                        aria-label={`Remove ${customerName(customer)} from selection`}
                        className={`rounded-full px-3 py-1 text-xs ${statusNeutral}`}
                      >
                        {customerName(customer)} ×
                      </button>
                    ))}
                  </div>
                </details>
              ) : null}
            </section>
            <section className="space-y-3">
              <h3 className={`font-semibold ${ink}`}>2. Write your request</h3>
              {channel === "email" ? (
                <div>
                  <label htmlFor={`${id}-subject`} className={fieldLabel}>
                    Subject
                  </label>
                  <input
                    id={`${id}-subject`}
                    maxLength={200}
                    required
                    value={subject}
                    onChange={(event) => setSubject(event.target.value)}
                    className={inputField}
                  />
                </div>
              ) : null}
              <div>
                <label htmlFor={`${id}-message`} className={fieldLabel}>
                  Message
                </label>
                <textarea
                  id={`${id}-message`}
                  maxLength={channel === "sms" ? 600 : 4000}
                  required
                  rows={5}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  className={inputField}
                />
              </div>
              <p className={`text-xs ${body}`}>
                Use {"{{customer_name}}"} and {"{{business_name}}"} to
                personalize the message.{" "}
                {channel === "sms"
                  ? "Your business name, review link, and STOP instructions are added for you."
                  : "The review and unsubscribe links are added for you."}
              </p>
            </section>
            <section className="space-y-3">
              <h3 className={`font-semibold ${ink}`}>3. Choose timing</h3>
              <div className={`flex flex-wrap gap-5 text-sm ${body}`}>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`${id}-timing`}
                    value="now"
                    checked={scheduleMode === "now"}
                    onChange={() => setScheduleMode("now")}
                  />
                  As soon as possible
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={`${id}-timing`}
                    value="later"
                    checked={scheduleMode === "later"}
                    onChange={() => setScheduleMode("later")}
                  />
                  Schedule for later
                </label>
              </div>
              {scheduleMode === "later" ? (
                <div>
                  <label htmlFor={`${id}-scheduled`} className={fieldLabel}>
                    Send date and time ({deviceZone})
                  </label>
                  <input
                    id={`${id}-scheduled`}
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={(event) => setScheduledAt(event.target.value)}
                    className={inputField}
                  />
                </div>
              ) : null}
              <p className={`text-xs ${body}`}>
                Delivery is adjusted to 9 AM–6 PM in each saved customer time
                zone, or {overview.settings.timezone} when none is saved.
                Preview the exact times before confirming.
              </p>
              <label className={`flex items-start gap-3 text-sm ${body}`}>
                <input
                  type="checkbox"
                  checked={reminder}
                  onChange={(event) => setReminder(event.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand-primary)]"
                />
                Send one reminder after four days if the Google link hasn’t been
                clicked.
              </label>
            </section>
            <fieldset className={`${tile} space-y-3 p-4`}>
              <legend className={`sr-only ${ink}`}>
                Confirm customer eligibility
              </legend>
              <label className={`flex items-start gap-3 text-sm ${body}`}>
                <input
                  type="checkbox"
                  checked={completed}
                  onChange={(event) => setCompleted(event.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand-primary)]"
                />
                These customers received a completed job or service from my
                business.
              </label>
              <label className={`flex items-start gap-3 text-sm ${body}`}>
                <input
                  type="checkbox"
                  checked={permission}
                  onChange={(event) => setPermission(event.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand-primary)]"
                />
                I have permission to send these customers{" "}
                {channel === "sms"
                  ? "automated review-request texts"
                  : "review-request emails"}
                . This is not a purchased or scraped list.
              </label>
            </fieldset>
            <div className="flex justify-end">
              <button
                type="button"
                disabled={
                  busy ||
                  !selection.length ||
                  !completed ||
                  !permission ||
                  (channel === "email" && !subject.trim()) ||
                  (channel === "sms" && !smsReady) ||
                  !message.trim() ||
                  (scheduleMode === "later" && !scheduledAt)
                }
                onClick={createPreview}
                className={`${btnPrimaryInline} disabled:opacity-50`}
              >
                {busy ? "Preparing preview…" : "Preview requests"}
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </>
        )}
        {error ? (
          <p role="alert" className={`rounded-2xl p-3 text-sm ${statusDanger}`}>
            {error}
          </p>
        ) : null}
      </div>
    </CustomerDialog>
  );
}
