import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  customerDefaults,
  customerPatchSchema,
  hasCustomerIdentity,
} from "./domain";
import { prepareCsv } from "./csv";
import type { Contact } from "@/types/database";
import type {
  CustomerDetailResponse,
  CustomerFilters,
  CustomerImportPreview,
  CustomerImportResult,
  CustomerListResponse,
  CustomerSavedView,
  CustomerServiceEvent,
} from "./types";

export interface CustomerScope {
  businessId: string;
  ownerId: string;
}
export class CustomerError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export function databaseError(
  error: { code?: string; message?: string } | null,
): never {
  const message = error?.message ?? "";
  if (error?.code === "23505")
    throw new CustomerError("customer_identity_conflict", 409);
  if (error?.code === "P0002")
    throw new CustomerError("customer_not_found", 404);
  if (error?.code === "42501")
    throw new CustomerError("customer_workspace_denied", 403);
  if (message.includes("customer_voice_history_protected"))
    throw new CustomerError("customer_voice_history_protected", 409);
  if (message.includes("customer_import_expired"))
    throw new CustomerError("customer_import_expired", 409);
  if (
    error?.code === "23514" ||
    error?.code === "22023" ||
    error?.code === "22P02"
  )
    throw new CustomerError("customer_invalid_request", 400);
  throw new CustomerError("customer_service_unavailable", 503);
}
async function rpc<T>(
  name: string,
  scope: CustomerScope,
  extra: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabaseAdmin.rpc(name, {
    p_business_id: scope.businessId,
    p_owner_id: scope.ownerId,
    ...extra,
  });
  if (error || data == null) databaseError(error);
  return data as T;
}
export async function ensureCustomerScope(scope: CustomerScope): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("businesses")
    .select("id")
    .eq("id", scope.businessId)
    .eq("owner_id", scope.ownerId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) databaseError(error);
  if (!data) throw new CustomerError("customer_workspace_denied", 403);
}
export async function listCustomers(
  scope: CustomerScope,
  filters: CustomerFilters,
  page: number,
  pageSize: number,
): Promise<CustomerListResponse> {
  const { data, error } = await supabaseAdmin.rpc("customer_workspace_list", {
    p_business_id: scope.businessId,
    p_filters: filters,
    p_page: page,
    p_page_size: pageSize,
  });
  if (error || !data) databaseError(error);
  const result = data as CustomerListResponse;
  return { ...result, customers: result.customers.map(customerDefaults) };
}
export async function getCustomer(
  scope: CustomerScope,
  id: string,
  historyPage = 1,
): Promise<CustomerDetailResponse> {
  const { data: customer, error } = await supabaseAdmin
    .from("contacts")
    .select("*")
    .eq("id", id)
    .eq("business_id", scope.businessId)
    .maybeSingle();
  if (error) databaseError(error);
  if (!customer) throw new CustomerError("customer_not_found", 404);
  const [conversations, events] = await Promise.all([
    supabaseAdmin
      .from("conversations")
      .select("*")
      .eq("business_id", scope.businessId)
      .eq("contact_id", id)
      .order("started_at", { ascending: false })
      .order("id")
      .range((historyPage - 1) * 100, historyPage * 100),
    supabaseAdmin
      .from("customer_service_events")
      .select("*")
      .eq("business_id", scope.businessId)
      .eq("contact_id", id)
      .order("created_at", { ascending: false })
      .order("id")
      .range((historyPage - 1) * 100, historyPage * 100),
  ]);
  if (conversations.error || events.error)
    databaseError(conversations.error ?? events.error);
  return {
    customer: customerDefaults(customer as Contact),
    conversations: (conversations.data ?? []).slice(0, 100),
    serviceEvents: (events.data ?? []).slice(0, 100),
    historyHasMore:
      (conversations.data?.length ?? 0) > 100 ||
      (events.data?.length ?? 0) > 100,
    historyPage,
  };
}
export async function saveCustomer(
  scope: CustomerScope,
  id: string | null,
  payload: unknown,
) {
  const input = customerPatchSchema.parse(payload);
  if (!Object.keys(input).length || (!id && !hasCustomerIdentity(input)))
    throw new CustomerError("customer_identity_required");
  return customerDefaults(
    await rpc<Contact>("customer_workspace_save", scope, {
      p_contact_id: id,
      p_values: input,
    }),
  );
}
export async function deleteCustomer(scope: CustomerScope, id: string) {
  await rpc("customer_workspace_delete", scope, { p_contact_id: id });
}
export async function savedViews(
  scope: CustomerScope,
): Promise<CustomerSavedView[]> {
  const { data, error } = await supabaseAdmin
    .from("customer_saved_views")
    .select("id,name,filters,created_at")
    .eq("business_id", scope.businessId)
    .order("name");
  if (error) databaseError(error);
  return (data ?? []) as CustomerSavedView[];
}
export async function saveView(
  scope: CustomerScope,
  name: string,
  filters: CustomerFilters,
) {
  return rpc<CustomerSavedView>("customer_workspace_saved_view", scope, {
    p_id: null,
    p_name: name,
    p_filters: filters,
  });
}
export async function deleteView(scope: CustomerScope, id: string) {
  await rpc("customer_workspace_saved_view", scope, {
    p_id: id,
    p_name: null,
    p_filters: null,
  });
}
export async function serviceEvent(
  scope: CustomerScope,
  contactId: string,
  eventId: string | null,
  values: Record<string, unknown>,
) {
  return rpc<CustomerServiceEvent>("customer_workspace_service_event", scope, {
    p_contact_id: contactId,
    p_event_id: eventId,
    p_values: values,
  });
}
export async function previewImport(
  scope: CustomerScope,
  csv: string,
  mapping?: Record<string, string>,
): Promise<CustomerImportPreview> {
  let parsed: ReturnType<typeof prepareCsv>;
  try {
    parsed = prepareCsv(csv, mapping);
  } catch (error) {
    throw new CustomerError(
      error instanceof Error ? error.message : "customer_import_invalid",
    );
  }
  const prepared = await rpc<
    Pick<CustomerImportPreview, "rows" | "previewToken">
  >("customer_workspace_import_preview", scope, { p_rows: parsed.rows });
  const summary = {
    create: 0,
    fill_blanks: 0,
    skip: 0,
    conflict: 0,
    total: prepared.rows.length,
  };
  prepared.rows.forEach((row) => summary[row.action]++);
  return {
    ...prepared,
    headers: parsed.headers,
    mapping: parsed.mapping,
    summary,
  };
}
export async function commitImport(scope: CustomerScope, token: string) {
  return rpc<CustomerImportResult>("customer_workspace_import_commit", scope, {
    p_import_id: token,
  });
}

/** Stable keyset pages avoid the API row cap and offset skips while exporting. */
export async function exportCustomerPage(
  scope: CustomerScope,
  filters: CustomerFilters,
  before: string,
  after: { created_at: string; id: string } | null,
) {
  const { data, error } = await supabaseAdmin.rpc(
    "customer_workspace_export_page",
    {
      p_business_id: scope.businessId,
      p_filters: filters,
      p_before: before,
      p_after_created: after?.created_at ?? null,
      p_after_id: after?.id ?? null,
    },
  );
  if (error) databaseError(error);
  return ((data ?? []) as Contact[]).map(customerDefaults);
}
