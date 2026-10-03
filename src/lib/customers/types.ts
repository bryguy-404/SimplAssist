import type { Contact, ContactSource, Conversation } from "@/types/database";

export type CustomerStage = "lead" | "customer" | "inactive";
export type CustomerWarmth = "normal" | "warm" | "hot";
export type CustomerView =
  | "all"
  | "leads"
  | "customers"
  | "inactive"
  | "hot"
  | "priority"
  | "follow_up_due";
export interface CustomerRecord extends Contact {
  company: string | null;
  service_address: string | null;
  customer_stage: CustomerStage;
  is_priority: boolean;
  owner_warmth_override: CustomerWarmth | null;
  next_follow_up_at: string | null;
  tags: string[];
}
export type CustomerInput = Pick<
  CustomerRecord,
  | "name"
  | "email"
  | "phone_number"
  | "notes"
  | "company"
  | "service_address"
  | "customer_stage"
  | "is_priority"
  | "owner_warmth_override"
  | "next_follow_up_at"
  | "tags"
>;
export interface CustomerFilters {
  q?: string;
  view?: CustomerView;
  tag?: string;
  source?: ContactSource;
}
export interface CustomerSavedView {
  id: string;
  name: string;
  filters: CustomerFilters;
  created_at: string;
}
export interface CustomerServiceEvent {
  id: string;
  business_id: string;
  contact_id: string;
  description: string | null;
  status: "open" | "completed";
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  idempotency_key: string;
  service_date: string | null;
  service_address_snapshot: string | null;
  completed_by: string | null;
}
export interface CustomerListResponse {
  customers: CustomerRecord[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  counts: {
    total: number;
    leads: number;
    customers: number;
    hot: number;
    priority: number;
    followUpDue: number;
  };
  savedViews: CustomerSavedView[];
}
export interface CustomerDetailResponse {
  customer: CustomerRecord;
  conversations: Conversation[];
  serviceEvents: CustomerServiceEvent[];
  historyHasMore: boolean;
  historyPage: number;
}
export type ImportAction = "create" | "fill_blanks" | "skip" | "conflict";
export interface CustomerImportRow {
  rowNumber: number;
  values: Partial<CustomerInput>;
  action: ImportAction;
  contactId?: string;
  errors: string[];
}
export interface CustomerImportPreview {
  previewToken: string;
  headers: string[];
  mapping: Record<string, string>;
  rows: CustomerImportRow[];
  summary: Record<ImportAction | "total", number>;
}
export interface CustomerImportResult {
  importId: string;
  created: number;
  updated: number;
  skipped: number;
  conflicts: number;
  rows: {
    rowNumber: number;
    status: "created" | "updated" | "skipped" | "conflict";
    contactId?: string;
    error?: string;
  }[];
}
