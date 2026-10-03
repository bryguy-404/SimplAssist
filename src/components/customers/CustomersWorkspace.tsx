"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import dynamic from "next/dynamic";
import {
  ArrowDownToLine,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Flame,
  Plus,
  Search,
  SlidersHorizontal,
  Star,
  Upload,
  UserRound,
  Users,
} from "lucide-react";
import type {
  CustomerListResponse,
  CustomerRecord,
  CustomerSavedView,
} from "@/lib/customers/types";
import {
  body,
  btnPrimaryInline,
  btnSecondaryCompact,
  btnSecondaryInline,
  card,
  fieldLabel,
  ink,
  inputField,
  statusDanger,
  statusNeutral,
  statusSuccess,
  tile,
} from "@/lib/theme-v2/theme";
import CustomerDialog from "./CustomerDialog";
import CustomerForm, { type CustomerFormValues } from "./CustomerForm";
import {
  CUSTOMER_VIEWS,
  DEFAULT_FILTERS,
  SOURCE_LABELS,
  customerName,
  customerPhone,
  customerQuery,
  customerRequest,
  dateLabel,
  requestError,
  type CustomerFilters,
} from "./customerUi";

const CustomerDetailDialog = dynamic(() => import("./CustomerDetailDialog"));
const CustomerImportDialog = dynamic(() => import("./CustomerImportDialog"));

function CustomerBadges({ customer }: { customer: CustomerRecord }) {
  const warmth = customer.owner_warmth_override || customer.lead_status;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span
        className={`rounded-full px-2 py-0.5 text-xs capitalize ${statusNeutral}`}
      >
        {customer.customer_stage}
      </span>
      {warmth !== "normal" ? (
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs capitalize ${warmth === "hot" ? statusSuccess : statusNeutral}`}
        >
          {warmth === "hot" ? <Flame className="h-3 w-3" /> : null}
          {warmth}
        </span>
      ) : null}
      {customer.is_priority ? (
        <span title="Priority" className={`rounded-full p-1 ${statusNeutral}`}>
          <Star className="h-3 w-3" />
          <span className="sr-only">Priority</span>
        </span>
      ) : null}
    </div>
  );
}

export default function CustomersWorkspace({
  initialSelectedId,
  reviewsEnabled = false,
}: {
  initialSelectedId?: string;
  reviewsEnabled?: boolean;
}) {
  const id = useId();
  const [data, setData] = useState<CustomerListResponse | null>(null);
  const [filters, setFilters] = useState<CustomerFilters>(DEFAULT_FILTERS);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialSelectedId || null,
  );
  const [creating, setCreating] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [savingView, setSavingView] = useState(false);
  const [viewBusy, setViewBusy] = useState(false);
  const [savedViewId, setSavedViewId] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const query = customerQuery(filters, page);

  useEffect(() => {
    setSelectedId(initialSelectedId || null);
  }, [initialSelectedId]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((current) =>
        current.q === search ? current : { ...current, q: search },
      );
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    customerRequest<CustomerListResponse>(`/api/customers?${query}`, {
      signal: controller.signal,
    })
      .then((next) => {
        if (!controller.signal.aborted) {
          setData(next);
          if (page > Math.max(1, next.pagination.totalPages))
            setPage(Math.max(1, next.pagination.totalPages));
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(requestError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [query, page, refresh]);

  function changeFilters(change: Partial<CustomerFilters>) {
    setFilters((current) => ({ ...current, ...change }));
    setPage(1);
    setSavedViewId("");
  }
  function resetFilters() {
    setFilters(DEFAULT_FILTERS);
    setSearch("");
    setPage(1);
    setSavedViewId("");
  }
  function refreshList() {
    setRefresh((value) => value + 1);
  }
  async function addCustomer(values: CustomerFormValues) {
    const response = await customerRequest<{ customer: CustomerRecord }>(
      "/api/customers",
      { method: "POST", body: JSON.stringify(values) },
    );
    setCreating(false);
    setSelectedId(response.customer.id);
    setNotice("Customer added. No messages were sent.");
    refreshList();
  }
  function selectSavedView(value: string) {
    setSavedViewId(value);
    const saved = data?.savedViews.find((view) => view.id === value);
    if (saved) {
      setFilters({ ...DEFAULT_FILTERS, ...saved.filters });
      setSearch(saved.filters.q || "");
      setPage(1);
    } else resetFilters();
  }
  async function saveView(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (viewBusy) return;
    const name = String(
      new FormData(event.currentTarget).get("name") || "",
    ).trim();
    if (!name) return;
    setViewBusy(true);
    setError(null);
    try {
      const result = await customerRequest<{ savedView: CustomerSavedView }>(
        "/api/customers/saved-views",
        {
          method: "POST",
          body: JSON.stringify({
            name,
            filters: { ...filters, source: filters.source || undefined },
          }),
        },
      );
      setSavedViewId(result.savedView.id);
      setSavingView(false);
      setNotice("View saved.");
      refreshList();
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setViewBusy(false);
    }
  }
  async function deleteSavedView() {
    if (!savedViewId || viewBusy) return;
    setViewBusy(true);
    setError(null);
    try {
      await customerRequest(
        `/api/customers/saved-views/${encodeURIComponent(savedViewId)}`,
        { method: "DELETE" },
      );
      setSavedViewId("");
      setNotice("Saved view removed. Your customers are unchanged.");
      refreshList();
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setViewBusy(false);
    }
  }
  async function exportCustomers() {
    setExporting(true);
    setError(null);
    try {
      const response = await fetch(`/api/customers/export?${query}`, {
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error("We couldn’t export your customers. Please try again.");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "simplassist-customers.csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("Customer export downloaded.");
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setExporting(false);
    }
  }
  const counts = data?.counts;
  const hasFilters = Boolean(
    filters.q || filters.tag || filters.source || filters.view !== "all",
  );
  const stats = [
    { label: "Everyone", count: counts?.total, icon: Users, view: "all" },
    { label: "Leads", count: counts?.leads, icon: UserRound, view: "leads" },
    {
      label: "Customers",
      count: counts?.customers,
      icon: Star,
      view: "customers",
    },
    {
      label: "Follow-up due",
      count: counts?.followUpDue,
      icon: CalendarClock,
      view: "follow_up_due",
    },
  ] as const;
  return (
    <div className="space-y-6">
      <header className="flex flex-col justify-between gap-4 xl:flex-row xl:items-center">
        <div>
          <h1 className={`text-2xl font-bold ${ink}`}>Customers</h1>
          <p className={`mt-1 text-sm ${body}`}>
            Your people, their details, and the next thing to do.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setImporting(true)}
            className={btnSecondaryInline}
          >
            <Upload className="h-4 w-4" />
            Import CSV
          </button>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className={btnPrimaryInline}
          >
            <Plus className="h-4 w-4" />
            Add customer
          </button>
        </div>
      </header>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map(({ label, count, icon: Icon, view }) => (
          <button
            type="button"
            key={label}
            onClick={() => changeFilters({ view })}
            className={`${card} flex items-center gap-3 p-4 text-left transition-colors hover:border-[var(--brand-primary)] sm:p-5`}
          >
            <span
              className={`${tile} flex h-10 w-10 shrink-0 items-center justify-center ${body}`}
            >
              <Icon className="h-4 w-4" />
            </span>
            <span>
              <span className={`block text-xs ${body}`}>{label}</span>
              <span
                className={`mt-1 block text-2xl font-semibold tabular-nums ${ink}`}
              >
                {count ?? "—"}
              </span>
            </span>
          </button>
        ))}
      </div>
      {notice ? (
        <div
          role="status"
          className={`flex items-center justify-between gap-3 rounded-2xl px-4 py-3 text-sm ${statusSuccess}`}
        >
          <span>{notice}</span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => setNotice(null)}
            className="px-2 text-lg"
          >
            ×
          </button>
        </div>
      ) : null}
      <section className={`${card} overflow-hidden`} aria-label="Customer list">
        <div className="space-y-4 p-4 sm:p-5">
          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <div className="relative min-w-0 flex-1">
              <label htmlFor={`${id}-search`} className="sr-only">
                Search customers
              </label>
              <Search
                className={`pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 ${body}`}
              />
              <input
                id={`${id}-search`}
                type="search"
                maxLength={200}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setSavedViewId("");
                }}
                placeholder="Search name, email, phone, or company"
                className={`${inputField} pl-11`}
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-expanded={showFilters}
                aria-controls={`${id}-filters`}
                onClick={() => setShowFilters((value) => !value)}
                className={btnSecondaryInline}
              >
                <SlidersHorizontal className="h-4 w-4" />
                Filters
                {filters.tag || filters.source ? (
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--brand-primary)]" />
                ) : null}
              </button>
              <button
                type="button"
                disabled={exporting || loading || !data?.pagination.total}
                onClick={exportCustomers}
                className={`${btnSecondaryInline} disabled:opacity-50`}
              >
                <ArrowDownToLine className="h-4 w-4" />
                {exporting ? "Exporting…" : "Export"}
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2" aria-label="Customer views">
            {CUSTOMER_VIEWS.map(([value, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={filters.view === value}
                onClick={() => changeFilters({ view: value })}
                className={`rounded-full px-3 py-2 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 ${filters.view === value ? "bg-[var(--brand-primary)] text-white dark:bg-[var(--brand-primary-dark)] dark:text-[#16100b]" : `${body} hover:bg-[#faf7f2] dark:hover:bg-white/5`}`}
              >
                {label}
              </button>
            ))}
          </div>
          {showFilters ? (
            <div
              id={`${id}-filters`}
              className={`${tile} grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3`}
            >
              <div>
                <label htmlFor={`${id}-source`} className={fieldLabel}>
                  Source
                </label>
                <select
                  id={`${id}-source`}
                  value={filters.source}
                  onChange={(event) =>
                    changeFilters({ source: event.target.value })
                  }
                  className={inputField}
                >
                  <option value="">All sources</option>
                  {Object.entries(SOURCE_LABELS).map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`${id}-tag`} className={fieldLabel}>
                  Tag
                </label>
                <input
                  id={`${id}-tag`}
                  value={filters.tag}
                  maxLength={50}
                  onChange={(event) =>
                    changeFilters({ tag: event.target.value })
                  }
                  placeholder="Filter by tag"
                  className={inputField}
                />
              </div>
              <div>
                <label htmlFor={`${id}-saved`} className={fieldLabel}>
                  Saved views
                </label>
                <select
                  id={`${id}-saved`}
                  value={savedViewId}
                  onChange={(event) => selectSavedView(event.target.value)}
                  className={inputField}
                >
                  <option value="">Choose a saved view</option>
                  {data?.savedViews.map((view) => (
                    <option key={view.id} value={view.id}>
                      {view.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:col-span-2 xl:col-span-3">
                <button
                  type="button"
                  onClick={() => setSavingView((value) => !value)}
                  className={btnSecondaryCompact}
                >
                  Save current view
                </button>
                {savedViewId ? (
                  <button
                    type="button"
                    disabled={viewBusy}
                    onClick={deleteSavedView}
                    className={btnSecondaryCompact}
                  >
                    Remove saved view
                  </button>
                ) : null}
                {hasFilters ? (
                  <button
                    type="button"
                    onClick={resetFilters}
                    className={`px-2 text-xs underline ${body}`}
                  >
                    Clear filters
                  </button>
                ) : null}
              </div>
              {savingView ? (
                <form
                  onSubmit={saveView}
                  className="flex flex-col gap-2 sm:col-span-2 sm:flex-row xl:col-span-3"
                >
                  <label htmlFor={`${id}-view-name`} className="sr-only">
                    View name
                  </label>
                  <input
                    id={`${id}-view-name`}
                    name="name"
                    required
                    maxLength={80}
                    placeholder="Name this view"
                    disabled={viewBusy}
                    className={inputField}
                  />
                  <button
                    disabled={viewBusy}
                    className={`${btnPrimaryInline} disabled:opacity-50`}
                  >
                    {viewBusy ? "Saving…" : "Save view"}
                  </button>
                </form>
              ) : null}
            </div>
          ) : null}
        </div>
        {error ? (
          <div
            role="alert"
            className={`mx-5 mb-5 rounded-2xl p-3 text-sm ${statusDanger}`}
          >
            {error}
            <button onClick={refreshList} className="ml-3 underline">
              Try again
            </button>
          </div>
        ) : null}
        <div
          aria-busy={loading}
          className={loading && data ? "pointer-events-none opacity-60" : ""}
        >
          {loading && !data ? (
            <div role="status" className={`py-16 text-center text-sm ${body}`}>
              Loading customers…
            </div>
          ) : data?.customers.length ? (
            <>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr
                      className={`border-y border-[#ece4d8] bg-[#faf7f2] text-xs dark:border-white/10 dark:bg-white/[0.03] ${body}`}
                    >
                      <th className="px-5 py-3 font-medium">Customer</th>
                      <th className="px-5 py-3 font-medium">Contact details</th>
                      <th className="px-5 py-3 font-medium">Relationship</th>
                      <th className="px-5 py-3 font-medium">Next follow-up</th>
                      <th className="px-5 py-3 font-medium">Tags</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#ece4d8] dark:divide-white/[0.06]">
                    {data.customers.map((customer) => (
                      <tr
                        key={customer.id}
                        className="hover:bg-[#faf7f2]/70 dark:hover:bg-white/[0.025]"
                      >
                        <td className="px-5 py-4">
                          <button
                            onClick={() => setSelectedId(customer.id)}
                            className={`rounded-md text-left font-semibold underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 ${ink}`}
                          >
                            {customerName(customer)}
                          </button>
                          {customer.company && customer.name ? (
                            <p className={`mt-1 text-xs ${body}`}>
                              {customer.company}
                            </p>
                          ) : null}
                          <p className={`mt-1 text-xs ${body}`}>
                            {SOURCE_LABELS[customer.source_channel || ""] ||
                              "Customer"}
                          </p>
                        </td>
                        <td
                          className={`max-w-64 break-words px-5 py-4 text-xs ${body}`}
                        >
                          <p>{customer.email || "No email"}</p>
                          <p className="mt-1">
                            {customerPhone(customer) || "No phone"}
                          </p>
                        </td>
                        <td className="px-5 py-4">
                          <CustomerBadges customer={customer} />
                        </td>
                        <td
                          className={`whitespace-nowrap px-5 py-4 text-xs ${body}`}
                        >
                          {customer.next_follow_up_at
                            ? dateLabel(customer.next_follow_up_at)
                            : "—"}
                        </td>
                        <td className="max-w-56 px-5 py-4">
                          <div className="flex flex-wrap gap-1">
                            {customer.tags.slice(0, 2).map((tag) => (
                              <span
                                key={tag}
                                className={`max-w-40 truncate rounded-full px-2 py-1 text-xs ${statusNeutral}`}
                              >
                                {tag}
                              </span>
                            ))}
                            {customer.tags.length > 2 ? (
                              <span className={`text-xs ${body}`}>
                                +{customer.tags.length - 2}
                              </span>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="divide-y divide-[#ece4d8] border-t border-[#ece4d8] dark:divide-white/10 dark:border-white/10 md:hidden">
                {data.customers.map((customer) => (
                  <li key={customer.id}>
                    <button
                      onClick={() => setSelectedId(customer.id)}
                      className="w-full space-y-3 p-5 text-left hover:bg-[#faf7f2] dark:hover:bg-white/5"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className={`truncate font-semibold ${ink}`}>
                            {customerName(customer)}
                          </p>
                          <p className={`mt-1 truncate text-xs ${body}`}>
                            {customer.email ||
                              customerPhone(customer) ||
                              "No contact details yet"}
                          </p>
                        </div>
                        <ChevronRight className={`h-4 w-4 shrink-0 ${body}`} />
                      </div>
                      <CustomerBadges customer={customer} />
                      {customer.next_follow_up_at ? (
                        <p
                          className={`flex items-center gap-2 text-xs ${body}`}
                        >
                          <CalendarClock className="h-3.5 w-3.5" />
                          Follow up {dateLabel(customer.next_follow_up_at)}
                        </p>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : !error ? (
            <div className="px-6 py-14 text-center">
              <Users className={`mx-auto mb-4 h-8 w-8 ${body}`} />
              <h2 className={`font-semibold ${ink}`}>
                {hasFilters
                  ? "No customers match this view"
                  : "A place for every customer"}
              </h2>
              <p className={`mx-auto mt-2 max-w-sm text-sm ${body}`}>
                {hasFilters
                  ? "Try another search or clear your filters."
                  : "Add your first customer or import your existing list. Keep details, notes, and follow-ups together."}
              </p>
              <button
                type="button"
                onClick={hasFilters ? resetFilters : () => setCreating(true)}
                className={`mt-5 ${btnSecondaryInline}`}
              >
                {hasFilters ? "Clear filters" : "Add your first customer"}
              </button>
            </div>
          ) : null}
        </div>
        {data ? (
          <footer
            className={`flex flex-wrap items-center justify-between gap-3 border-t border-[#ece4d8] px-5 py-4 text-xs dark:border-white/10 ${body}`}
          >
            <p role="status">
              {loading
                ? "Updating customers…"
                : `${data.pagination.total} ${data.pagination.total === 1 ? "customer" : "customers"} · Page ${data.pagination.page} of ${Math.max(1, data.pagination.totalPages)}`}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                aria-label="Previous customer page"
                disabled={loading || page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                className={`${btnSecondaryCompact} disabled:opacity-40`}
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </button>
              <button
                type="button"
                aria-label="Next customer page"
                disabled={loading || page >= data.pagination.totalPages}
                onClick={() => setPage((value) => value + 1)}
                className={`${btnSecondaryCompact} disabled:opacity-40`}
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </footer>
        ) : null}
      </section>
      {creating ? (
        <CustomerDialog
          title="Add customer"
          description="Start with what you know. You can fill in the rest later."
          onClose={() => setCreating(false)}
          busy={createBusy}
        >
          <CustomerForm
            onSave={addCustomer}
            onCancel={() => setCreating(false)}
            onBusyChange={setCreateBusy}
          />
        </CustomerDialog>
      ) : null}
      {selectedId ? (
        <CustomerDetailDialog
          key={selectedId}
          customerId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={refreshList}
          reviewsEnabled={reviewsEnabled}
        />
      ) : null}
      {importing ? (
        <CustomerImportDialog
          onClose={() => setImporting(false)}
          onImported={refreshList}
        />
      ) : null}
    </div>
  );
}
