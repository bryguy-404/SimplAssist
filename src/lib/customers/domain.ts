import { z } from "zod";
import type { Contact } from "@/types/database";
import type {
  CustomerInput,
  CustomerRecord,
  CustomerFilters,
  CustomerImportRow,
} from "./types";

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;
export const CUSTOMER_FIELDS = [
  "name",
  "company",
  "email",
  "phone_number",
  "service_address",
  "notes",
  "customer_stage",
  "is_priority",
  "owner_warmth_override",
  "next_follow_up_at",
  "tags",
] as const;
const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => v || null)
    .nullable();
export function normalizePhone(value: string): string | null {
  const s = value.trim();
  if (!s) return null;
  const digits = s.replace(/[\s().-]/g, "");
  const candidate = /^\d{10}$/.test(digits)
    ? `+1${digits}`
    : /^1\d{10}$/.test(digits)
      ? `+${digits}`
      : digits;
  if (!/^\+[1-9]\d{7,14}$/.test(candidate))
    throw new Error("Use a valid phone number with country code.");
  return candidate;
}
export const customerPatchSchema = z
  .object({
    name: nullableText(200),
    company: nullableText(200),
    service_address: nullableText(1000),
    notes: nullableText(10000),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .refine(
        (v) => !v || z.string().email().safeParse(v).success,
        "Enter a valid email.",
      )
      .transform((v) => v || null)
      .nullable(),
    phone_number: z
      .string()
      .max(50)
      .transform((v, ctx) => {
        try {
          return normalizePhone(v);
        } catch {
          ctx.addIssue({
            code: "custom",
            message: "Enter a valid phone number.",
          });
          return z.NEVER;
        }
      })
      .nullable(),
    customer_stage: z.enum(["lead", "customer", "inactive"]),
    is_priority: z.boolean(),
    owner_warmth_override: z.enum(["normal", "warm", "hot"]).nullable(),
    next_follow_up_at: z
      .string()
      .datetime({ offset: true })
      .transform((v) => new Date(v).toISOString())
      .nullable(),
    tags: z
      .array(z.string().trim().min(1).max(50))
      .max(30)
      .transform((values) =>
        Array.from(new Set(values.map((v) => v.toLowerCase()))),
      ),
  })
  .partial()
  .strict();
export const customerFiltersSchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    view: z
      .enum([
        "all",
        "leads",
        "customers",
        "inactive",
        "hot",
        "priority",
        "follow_up_due",
      ])
      .optional(),
    tag: z
      .string()
      .trim()
      .max(50)
      .transform((v) => v.toLowerCase())
      .optional(),
    source: z
      .enum(["manual", "csv_import", "sms", "web_chat", "voice"])
      .optional(),
  })
  .strict();
export function customerDefaults(value: Contact): CustomerRecord {
  return {
    ...value,
    company: value.company ?? null,
    service_address: value.service_address ?? null,
    customer_stage: value.customer_stage ?? "lead",
    is_priority: value.is_priority ?? false,
    owner_warmth_override: value.owner_warmth_override ?? null,
    next_follow_up_at: value.next_follow_up_at ?? null,
    tags: value.tags ?? [],
  };
}
/** A captured widget session may have a legacy synthetic routing phone. */
export function customerPhoneValue(
  customer: Pick<Contact, "phone_number"> &
    Partial<Pick<Contact, "provided_phone_number" | "source_channel">>,
): string | null {
  const phones =
    customer.source_channel === "web_chat"
      ? [customer.provided_phone_number, customer.phone_number]
      : [customer.phone_number, customer.provided_phone_number];
  for (const phone of phones) {
    try {
      const normalized = normalizePhone(phone ?? "");
      if (normalized) return normalized;
    } catch {
      /* Synthetic routing identities are not phone destinations. */
    }
  }
  return null;
}
export function effectiveWarmth(
  customer: Pick<CustomerRecord, "owner_warmth_override" | "lead_status">,
) {
  return customer.owner_warmth_override ?? customer.lead_status;
}
export function hasCustomerIdentity(input: Partial<CustomerInput>): boolean {
  return Boolean(
    input.name || input.email || input.phone_number || input.company,
  );
}
export function filtersFromParams(params: URLSearchParams): CustomerFilters {
  return customerFiltersSchema.parse(
    Object.fromEntries(
      ["q", "view", "tag", "source"]
        .filter((k) => params.get(k))
        .map((k) => [k, params.get(k)]),
    ),
  );
}
export function duplicateDecision(
  values: Partial<CustomerInput>,
  existing: CustomerRecord[],
  rowNumber: number,
): CustomerImportRow {
  const email = values.email?.toLowerCase().trim();
  const phone = values.phone_number;
  const matches = existing.filter(
    (c) =>
      (email && c.email?.trim().toLowerCase() === email) ||
      (phone &&
        [c.phone_number, c.provided_phone_number].some((value) => {
          try {
            return normalizePhone(value ?? "") === phone;
          } catch {
            return false;
          }
        })),
  );
  if (matches.length > 1)
    return {
      rowNumber,
      values,
      action: "conflict",
      errors: ["Email or phone matches more than one customer."],
    };
  const match = matches[0];
  if (!match) return { rowNumber, values, action: "create", errors: [] };
  if (
    (email && match.email && email !== match.email.trim().toLowerCase()) ||
    (phone && customerPhoneValue(match) && phone !== customerPhoneValue(match))
  )
    return {
      rowNumber,
      values,
      action: "conflict",
      contactId: match.id,
      errors: ["The email and phone do not identify the same customer."],
    };
  const fill = Object.entries(values).some(([key, value]) => {
    if (
      ["customer_stage", "is_priority", "owner_warmth_override"].includes(key)
    )
      return false;
    const old =
      key === "phone_number"
        ? customerPhoneValue(match)
        : match[key as keyof CustomerInput];
    return (
      value !== null &&
      value !== "" &&
      (!Array.isArray(value) || value.length > 0) &&
      (old == null || old === "" || (Array.isArray(old) && old.length === 0))
    );
  });
  return {
    rowNumber,
    values,
    action: fill ? "fill_blanks" : "skip",
    contactId: match.id,
    errors: [],
  };
}
