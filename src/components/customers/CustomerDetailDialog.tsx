"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import {
  CalendarClock,
  CheckCircle2,
  ExternalLink,
  Mail,
  MapPin,
  MessageSquare,
  Pencil,
  Phone,
  Star,
  Trash2,
} from "lucide-react";
import type {
  CustomerDetailResponse,
  CustomerRecord,
} from "@/lib/customers/types";
import {
  body,
  btnPrimaryInline,
  btnSecondaryCompact,
  btnSecondaryInline,
  fieldLabel,
  ink,
  inlineLink,
  inputField,
  statusDanger,
  statusNeutral,
  statusSuccess,
  tile,
} from "@/lib/theme-v2/theme";
import CustomerDialog from "./CustomerDialog";
import CustomerForm, { type CustomerFormValues } from "./CustomerForm";
import {
  customerName,
  customerPhone,
  customerRequest,
  dateLabel,
  requestError,
  SOURCE_LABELS,
} from "./customerUi";

const CustomerReviewPermission = dynamic(
  () => import("@/components/reviews/CustomerReviewPermission"),
);

export default function CustomerDetailDialog({
  customerId,
  onClose,
  onChanged,
  reviewsEnabled = false,
}: {
  customerId: string;
  onClose: () => void;
  onChanged: () => void;
  reviewsEnabled?: boolean;
}) {
  const [detail, setDetail] = useState<CustomerDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const [serviceDescription, setServiceDescription] = useState("");
  const [serviceDate, setServiceDate] = useState("");
  const serviceKey = useRef<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    customerRequest<CustomerDetailResponse>(
      `/api/customers/${encodeURIComponent(customerId)}`,
      { signal: controller.signal },
    )
      .then((next) => {
        if (!controller.signal.aborted) {
          setDetail(next);
          setHistoryPage(1);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(requestError(cause));
      });
    return () => controller.abort();
  }, [customerId, refresh]);

  async function loadOlderHistory() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await customerRequest<CustomerDetailResponse>(
        `/api/customers/${encodeURIComponent(customerId)}?historyPage=${historyPage + 1}`,
      );
      setDetail((current) =>
        current
          ? {
              ...next,
              conversations: Array.from(
                new Map(
                  [...current.conversations, ...next.conversations].map(
                    (item) => [item.id, item],
                  ),
                ).values(),
              ),
              serviceEvents: Array.from(
                new Map(
                  [...current.serviceEvents, ...next.serviceEvents].map(
                    (item) => [item.id, item],
                  ),
                ).values(),
              ),
            }
          : next,
      );
      setHistoryPage((value) => value + 1);
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function save(values: CustomerFormValues) {
    const response = await customerRequest<{ customer: CustomerRecord }>(
      `/api/customers/${encodeURIComponent(customerId)}`,
      { method: "PATCH", body: JSON.stringify(values) },
    );
    setDetail((current) =>
      current ? { ...current, customer: response.customer } : current,
    );
    setEditing(false);
    onChanged();
  }
  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await customerRequest(
        `/api/customers/${encodeURIComponent(customerId)}`,
        { method: "DELETE" },
      );
      onChanged();
      onClose();
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function completeService() {
    setBusy(true);
    setError(null);
    serviceKey.current ||= crypto.randomUUID();
    try {
      await customerRequest(
        `/api/customers/${encodeURIComponent(customerId)}/service-events`,
        {
          method: "POST",
          body: JSON.stringify({
            idempotencyKey: serviceKey.current,
            description: serviceDescription.trim() || undefined,
            serviceDate: serviceDate || undefined,
          }),
        },
      );
      serviceKey.current = null;
      setServiceDescription("");
      setServiceDate("");
      setRefresh((value) => value + 1);
      onChanged();
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function changeService(id: string, status: "open" | "completed") {
    setBusy(true);
    setError(null);
    try {
      await customerRequest(
        `/api/customers/${encodeURIComponent(customerId)}/service-events/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify({ status }) },
      );
      setRefresh((value) => value + 1);
      onChanged();
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
    }
  }
  const customer = detail?.customer;
  return (
    <CustomerDialog
      title={
        editing
          ? "Edit customer"
          : customer
            ? customerName(customer)
            : "Customer details"
      }
      description={
        editing
          ? "Keep contact information and follow-ups up to date."
          : customer?.company || undefined
      }
      onClose={onClose}
      busy={busy}
    >
      {!detail && !error ? (
        <p role="status" className={`py-8 text-center ${body}`}>
          Loading customer history…
        </p>
      ) : null}
      {error ? (
        <div
          role="alert"
          className={`mb-5 rounded-2xl p-3 text-sm ${statusDanger}`}
        >
          {error}
          {!detail ? (
            <button
              onClick={() => setRefresh((value) => value + 1)}
              className="ml-3 underline"
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
      {customer && detail ? (
        editing ? (
          <CustomerForm
            customer={customer}
            onSave={save}
            onCancel={() => setEditing(false)}
            onBusyChange={setBusy}
          />
        ) : (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                <span
                  className={`rounded-full px-3 py-1 text-xs capitalize ${statusNeutral}`}
                >
                  {customer.customer_stage}
                </span>
                <span
                  className={`rounded-full px-3 py-1 text-xs capitalize ${customer.owner_warmth_override === "hot" || (!customer.owner_warmth_override && customer.lead_status === "hot") ? statusSuccess : statusNeutral}`}
                >
                  {customer.owner_warmth_override || customer.lead_status}{" "}
                  interest
                </span>
                {customer.is_priority ? (
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs ${statusNeutral}`}
                  >
                    <Star className="h-3 w-3" />
                    Priority
                  </span>
                ) : null}
              </div>
              <button
                onClick={() => setEditing(true)}
                className={btnSecondaryCompact}
              >
                <Pencil className="h-3.5 w-3.5" />
                Edit
              </button>
            </div>
            <dl className={`space-y-4 text-sm ${body}`}>
              <div className="flex gap-3">
                <Mail className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0">
                  <dt className="text-xs">Email</dt>
                  <dd className={`mt-1 break-all ${ink}`}>
                    {customer.email ? (
                      <a
                        href={`mailto:${customer.email}`}
                        className={inlineLink}
                      >
                        {customer.email}
                      </a>
                    ) : (
                      "No email added"
                    )}
                  </dd>
                </div>
              </div>
              <div className="flex gap-3">
                <Phone className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <dt className="text-xs">Phone</dt>
                  <dd className={`mt-1 ${ink}`}>
                    {customerPhone(customer) ? (
                      <a
                        href={`tel:${customerPhone(customer)}`}
                        className={inlineLink}
                      >
                        {customerPhone(customer)}
                      </a>
                    ) : (
                      "No phone added"
                    )}
                  </dd>
                </div>
              </div>
              <div className="flex gap-3">
                <MapPin className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <dt className="text-xs">Service address</dt>
                  <dd className={`mt-1 whitespace-pre-line ${ink}`}>
                    {customer.service_address ? (
                      <a
                        href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(customer.service_address)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={inlineLink}
                      >
                        {customer.service_address}
                        <ExternalLink className="ml-1 inline h-3 w-3" />
                        <span className="sr-only">
                          {" "}
                          (opens Google Maps in a new tab)
                        </span>
                      </a>
                    ) : (
                      "No address added"
                    )}
                  </dd>
                </div>
              </div>
              <div className="flex gap-3">
                <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <dt className="text-xs">Next follow-up</dt>
                  <dd className={`mt-1 ${ink}`}>
                    {customer.next_follow_up_at
                      ? new Date(customer.next_follow_up_at).toLocaleString()
                      : "No follow-up scheduled"}
                  </dd>
                </div>
              </div>
            </dl>
            {customer.tags.length ? (
              <div className="flex flex-wrap gap-2" aria-label="Tags">
                {customer.tags.map((tag) => (
                  <span
                    key={tag}
                    className={`rounded-full px-3 py-1 text-xs ${statusNeutral}`}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            ) : null}
            {customer.notes ? (
              <section>
                <h3 className={`text-sm font-semibold ${ink}`}>Notes</h3>
                <p
                  className={`mt-2 whitespace-pre-wrap break-words text-sm ${body}`}
                >
                  {customer.notes}
                </p>
              </section>
            ) : null}
            <section className={`${tile} p-4`}>
              <h3
                className={`flex items-center gap-2 text-sm font-semibold ${ink}`}
              >
                <CheckCircle2 className="h-4 w-4" />
                Completed work
              </h3>
              <p className={`mt-1 text-xs ${body}`}>
                Record a finished job or service. This keeps completed work
                separate from new leads.
              </p>
              <form
                className="mt-4 space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!busy) void completeService();
                }}
              >
                <label
                  htmlFor="customer-service-description"
                  className={fieldLabel}
                >
                  Job or service description{" "}
                  <span className="font-normal">(optional)</span>
                </label>
                <input
                  id="customer-service-description"
                  maxLength={1000}
                  disabled={busy}
                  value={serviceDescription}
                  onChange={(event) => {
                    setServiceDescription(event.target.value);
                    serviceKey.current = null;
                  }}
                  placeholder="For example, website build"
                  className={inputField}
                />
                <label htmlFor="customer-service-date" className={fieldLabel}>
                  Service date <span className="font-normal">(optional)</span>
                </label>
                <input
                  id="customer-service-date"
                  type="date"
                  disabled={busy}
                  value={serviceDate}
                  onChange={(event) => {
                    setServiceDate(event.target.value);
                    serviceKey.current = null;
                  }}
                  className={inputField}
                />
                <button
                  type="submit"
                  disabled={busy}
                  className={`${btnSecondaryInline} disabled:opacity-50`}
                >
                  {busy ? "Saving…" : "Mark service completed"}
                </button>
              </form>
              {detail.serviceEvents.length ? (
                <ul className="mt-5 space-y-3">
                  {detail.serviceEvents.map((event) => (
                    <li
                      key={event.id}
                      className="flex items-start justify-between gap-3 border-t border-[#e7e0d4] pt-3 dark:border-white/10"
                    >
                      <div>
                        <p className={`text-sm font-medium ${ink}`}>
                          {event.description || "Service completed"}
                        </p>
                        <p className={`mt-1 text-xs ${body}`}>
                          {event.status === "completed"
                            ? `Completed ${dateLabel(event.completed_at)}`
                            : "Reopened"}
                        </p>
                      </div>
                      <button
                        disabled={busy}
                        onClick={() =>
                          changeService(
                            event.id,
                            event.status === "completed" ? "open" : "completed",
                          )
                        }
                        className={`${btnSecondaryCompact} shrink-0 disabled:opacity-50`}
                      >
                        {event.status === "completed" ? "Reopen" : "Complete"}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
            {reviewsEnabled ? (
              <>
                <Link
                  href={`/reviews?customer=${encodeURIComponent(customerId)}`}
                  className={btnPrimaryInline}
                >
                  Request a review
                </Link>
                <CustomerReviewPermission
                  customerId={customerId}
                  onBusyChange={setBusy}
                />
              </>
            ) : null}
            <section>
              <h3
                className={`flex items-center gap-2 text-sm font-semibold ${ink}`}
              >
                <MessageSquare className="h-4 w-4" />
                Conversation history
              </h3>
              {detail.conversations.length ? (
                <ul className="mt-3 space-y-2">
                  {detail.conversations.map((conversation) => (
                    <li key={conversation.id}>
                      <Link
                        href={`/conversations?conversation=${encodeURIComponent(conversation.id)}`}
                        className={`flex items-center justify-between gap-3 rounded-2xl border border-[#ece4d8] p-3 text-sm hover:bg-[#faf7f2] dark:border-white/10 dark:hover:bg-white/5 ${body}`}
                      >
                        <span>
                          {SOURCE_LABELS[conversation.channel] ||
                            conversation.channel}
                        </span>
                        <span className="flex items-center gap-2 text-xs">
                          {dateLabel(conversation.last_message_at)}
                          <ExternalLink className="h-3 w-3" />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={`mt-2 text-sm ${body}`}>
                  No conversations yet. You can still organize this customer and
                  record completed work.
                </p>
              )}
            </section>
            <p className={`text-xs ${body}`}>
              {SOURCE_LABELS[customer.source_channel || ""] || "Customer"} ·
              Added {dateLabel(customer.created_at)}
            </p>
            {detail.historyHasMore ? (
              <button
                type="button"
                disabled={busy}
                onClick={loadOlderHistory}
                className={`${btnSecondaryInline} disabled:opacity-50`}
              >
                {busy ? "Loading…" : "Load older history"}
              </button>
            ) : null}
            <div className="border-t border-[#ece4d8] pt-4 dark:border-white/10">
              {deleting ? (
                <div className="space-y-3">
                  <p className={`text-sm ${body}`}>
                    Delete this customer? This cannot be undone. Customers with
                    protected history may need to be marked inactive instead.
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <button
                      disabled={busy}
                      onClick={remove}
                      className={`${btnSecondaryInline} text-red-700 dark:text-red-300`}
                    >
                      {busy ? "Deleting…" : "Delete customer"}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => setDeleting(false)}
                      className={btnSecondaryInline}
                    >
                      Keep customer
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setDeleting(true)}
                  className={`inline-flex items-center gap-2 rounded-lg px-2 py-1 text-xs ${body}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete customer
                </button>
              )}
            </div>
          </div>
        )
      ) : null}
    </CustomerDialog>
  );
}
