import type { CustomerRecord } from "@/lib/customers/types";

export const CUSTOMER_VIEWS = [
  ["all", "Everyone"],
  ["leads", "Leads"],
  ["customers", "Customers"],
  ["hot", "Hot leads"],
  ["priority", "Priority"],
  ["follow_up_due", "Follow-up due"],
  ["inactive", "Inactive"],
] as const;

export type CustomerView = (typeof CUSTOMER_VIEWS)[number][0];
export interface CustomerFilters {
  q: string;
  view: CustomerView;
  tag: string;
  source: string;
}
export const DEFAULT_FILTERS: CustomerFilters = {
  q: "",
  view: "all",
  tag: "",
  source: "",
};
export const SOURCE_LABELS: Record<string, string> = {
  manual: "Added manually",
  csv_import: "CSV import",
  sms: "Text",
  web_chat: "Web chat",
  voice: "Phone call",
};

export function customerQuery(filters: CustomerFilters, page = 1): string {
  const query = new URLSearchParams({
    page: String(page),
    pageSize: "25",
    view: filters.view,
  });
  if (filters.q.trim()) query.set("q", filters.q.trim());
  if (filters.tag.trim()) query.set("tag", filters.tag.trim());
  if (filters.source) query.set("source", filters.source);
  return query.toString();
}

export function customerPhone(
  customer: Pick<CustomerRecord, "phone_number" | "provided_phone_number"> &
    Partial<Pick<CustomerRecord, "source_channel">>,
): string | null {
  const phones =
    customer.source_channel === "web_chat"
      ? [customer.provided_phone_number, customer.phone_number]
      : [customer.phone_number, customer.provided_phone_number];
  for (const phone of phones) {
    const digits = (phone || "").trim().replace(/[\s().-]/g, "");
    const normalized = /^\d{10}$/.test(digits)
      ? `+1${digits}`
      : /^1\d{10}$/.test(digits)
        ? `+${digits}`
        : digits;
    if (/^\+[1-9]\d{7,14}$/.test(normalized)) return normalized;
  }
  return null;
}

export function customerName(
  customer: Pick<
    CustomerRecord,
    "name" | "company" | "email" | "phone_number" | "provided_phone_number"
  >,
): string {
  return (
    customer.name ||
    customer.company ||
    customer.email ||
    customerPhone(customer) ||
    "Unnamed customer"
  );
}

export function localDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function dateLabel(value: string | null | undefined): string {
  if (!value) return "Not set";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not set";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export async function customerRequest<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof result?.message === "string"
        ? result.message
        : typeof result?.error === "string" && !/^[a-z_]+$/.test(result.error)
          ? result.error
          : null;
    throw new Error(
      message ||
        (response.status === 401
          ? "Your session expired. Sign in again to continue."
          : response.status === 409
            ? "This information changed or matches another customer. Refresh and try again."
            : "We couldn’t complete that request. Please try again."),
    );
  }
  return result as T;
}

export function requestError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
