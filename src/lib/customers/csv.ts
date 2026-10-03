import { customerPhoneValue } from "./domain";
import {
  CUSTOMER_FIELDS,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  customerPatchSchema,
  hasCustomerIdentity,
} from "./domain";
import type { CustomerImportRow, CustomerRecord } from "./types";

/** Bounded RFC 4180 parser. No raw input is retained by the import service. */
export function parseCsv(csv: string): string[][] {
  if (new TextEncoder().encode(csv).length > MAX_IMPORT_BYTES)
    throw new Error("CSV files must be 5 MB or smaller.");
  const input = csv.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  const pushField = () => {
    row.push(field);
    field = "";
    closed = false;
    if (row.length > 100)
      throw new Error("CSV files may have at most 100 columns.");
  };
  const pushRow = () => {
    pushField();
    if (row.some((v) => v.trim())) rows.push(row);
    row = [];
    if (rows.length > MAX_IMPORT_ROWS + 1)
      throw new Error("Import at most 5,000 customers at a time.");
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += ch;
    } else if (ch === ",") pushField();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      pushRow();
    } else if (ch === '"' && !field && !closed) quoted = true;
    else if (closed || ch === '"') throw new Error("Invalid CSV quoting.");
    else field += ch;
  }
  if (quoted) throw new Error("A quoted CSV field is incomplete.");
  if (field || row.length || closed) pushRow();
  return rows;
}

const aliases: Record<string, string[]> = {
  name: ["name", "customer name", "full name"],
  company: ["company", "company name"],
  email: ["email", "email address"],
  phone_number: ["phone_number", "phone", "phone number", "mobile"],
  service_address: ["service_address", "service address", "address"],
  notes: ["notes"],
  customer_stage: ["customer_stage", "stage", "customer stage"],
  is_priority: ["is_priority", "priority"],
  owner_warmth_override: ["owner_warmth_override", "warmth"],
  next_follow_up_at: ["next_follow_up_at", "follow up", "follow-up"],
  tags: ["tags"],
};
export function prepareCsv(
  csv: string,
  suppliedMapping?: Record<string, string>,
): {
  headers: string[];
  mapping: Record<string, string>;
  rows: CustomerImportRow[];
} {
  const parsed = parseCsv(csv);
  const headers = (parsed.shift() ?? []).map((h) => h.trim());
  if (
    !headers.length ||
    new Set(headers).size !== headers.length ||
    headers.some((h) => !h || h.length > 200)
  )
    throw new Error("Use unique, nonempty CSV column headers.");
  const mapping: Record<string, string> = suppliedMapping
    ? { ...suppliedMapping }
    : {};
  if (!suppliedMapping)
    for (const key of CUSTOMER_FIELDS) {
      const found = headers.find((h) => aliases[key].includes(h.toLowerCase()));
      if (found) mapping[key] = found;
    }
  const selected = Object.entries(mapping).filter(([, value]) => value !== "");
  if (
    selected.some(
      ([key, header]) =>
        !CUSTOMER_FIELDS.includes(key as (typeof CUSTOMER_FIELDS)[number]) ||
        !headers.includes(header),
    )
  )
    throw new Error("Column mapping contains an unknown field or header.");
  if (new Set(selected.map(([, h]) => h)).size !== selected.length)
    throw new Error("Map each CSV column only once.");
  const rows = parsed.map((cells, index): CustomerImportRow => {
    const values: Record<string, unknown> = {};
    const rowNumber = index + 2;
    if (cells.length !== headers.length)
      return {
        rowNumber,
        values: {},
        action: "conflict",
        errors: ["Column count does not match the header."],
      };
    for (const [key, header] of selected) {
      const raw = cells[headers.indexOf(header)].trim();
      if (!raw) continue;
      if (key === "tags")
        values[key] = raw
          .split(/[;|]/)
          .map((v) => v.trim())
          .filter(Boolean);
      else if (key === "is_priority")
        values[key] = ["true", "yes", "1"].includes(raw.toLowerCase())
          ? true
          : ["false", "no", "0"].includes(raw.toLowerCase())
            ? false
            : raw;
      else if (
        key === "owner_warmth_override" &&
        raw.toLowerCase() === "automatic"
      )
        values[key] = null;
      else values[key] = raw;
    }
    const result = customerPatchSchema.safeParse(values);
    if (!result.success)
      return {
        rowNumber,
        values: {},
        action: "conflict",
        errors: result.error.issues.map(
          (i) => `${i.path.join(".")}: ${i.message}`,
        ),
      };
    if (!hasCustomerIdentity(result.data))
      return {
        rowNumber,
        values: result.data,
        action: "conflict",
        errors: ["Include a name, company, email or phone."],
      };
    return { rowNumber, values: result.data, action: "create", errors: [] };
  });
  if (!rows.length) throw new Error("CSV contains no customers.");
  return { headers, mapping: Object.fromEntries(selected), rows };
}

export function safeCsvCell(value: unknown): string {
  let s =
    value == null
      ? ""
      : Array.isArray(value)
        ? value.join("; ")
        : String(value);
  // Spreadsheet consumers can execute formulae even when the CSV field is quoted.
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(s) || /^[\t\r\n]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
export const CUSTOMER_EXPORT_HEADERS = [
  ...CUSTOMER_FIELDS,
  "source_channel",
  "lead_status",
  "created_at",
] as const;
export function exportCustomersCsv(
  customers: CustomerRecord[],
  includeHeader = true,
): string {
  const lines = includeHeader
    ? [CUSTOMER_EXPORT_HEADERS.map(safeCsvCell).join(",")]
    : [];
  for (const c of customers)
    lines.push(
      CUSTOMER_EXPORT_HEADERS.map((key) =>
        safeCsvCell(key === "phone_number" ? customerPhoneValue(c) : c[key]),
      ).join(","),
    );
  return lines.join("\r\n") + (lines.length ? "\r\n" : "");
}
