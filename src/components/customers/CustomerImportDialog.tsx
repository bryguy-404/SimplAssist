"use client";

import { useId, useState } from "react";
import { CheckCircle2, FileSpreadsheet, Upload } from "lucide-react";
import type {
  CustomerImportPreview,
  CustomerImportResult,
} from "@/lib/customers/types";
import {
  body,
  btnPrimaryInline,
  btnSecondaryInline,
  fieldLabel,
  ink,
  inputField,
  statusDanger,
  statusSuccess,
  statusWarning,
  tile,
} from "@/lib/theme-v2/theme";
import CustomerDialog from "./CustomerDialog";
import { customerRequest, requestError } from "./customerUi";

const IMPORT_FIELDS = [
  ["name", "Name"],
  ["company", "Company"],
  ["email", "Email"],
  ["phone_number", "Phone"],
  ["service_address", "Service address"],
  ["notes", "Notes"],
  ["tags", "Tags"],
  ["customer_stage", "Relationship"],
  ["is_priority", "Priority"],
  ["owner_warmth_override", "Lead interest"],
  ["next_follow_up_at", "Next follow-up"],
] as const;

export default function CustomerImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const id = useId();
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<CustomerImportPreview | null>(null);
  const [result, setResult] = useState<CustomerImportResult | null>(null);
  const [mappingDirty, setMappingDirty] = useState(false);
  const [previewPage, setPreviewPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadFile(file: File) {
    setError(null);
    setResult(null);
    setPreview(null);
    if (file.size > 5 * 1024 * 1024) {
      setError(
        "Choose a CSV smaller than 5 MB. Split larger lists into smaller files.",
      );
      return;
    }
    setBusy(true);
    try {
      const content = await file.text();
      setCsv(content);
      setFileName(file.name);
      const next = await customerRequest<CustomerImportPreview>(
        "/api/customers/import/preview",
        { method: "POST", body: JSON.stringify({ csv: content }) },
      );
      setPreview(next);
      setMapping(next.mapping);
      setMappingDirty(false);
      setPreviewPage(0);
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function refreshPreview() {
    setBusy(true);
    setError(null);
    try {
      const next = await customerRequest<CustomerImportPreview>(
        "/api/customers/import/preview",
        { method: "POST", body: JSON.stringify({ csv, mapping }) },
      );
      setPreview(next);
      setMapping(next.mapping);
      setMappingDirty(false);
      setPreviewPage(0);
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (!preview || mappingDirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      const imported = await customerRequest<CustomerImportResult>(
        "/api/customers/import/commit",
        {
          method: "POST",
          body: JSON.stringify({ previewToken: preview.previewToken }),
        },
      );
      setResult(imported);
      setCsv("");
      onImported();
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <CustomerDialog
      title={result ? "Import complete" : "Import customers"}
      description="Bring your existing customers into one place. Importing never sends a message."
      onClose={onClose}
      busy={busy}
      wide
    >
      <div className="space-y-6">
        {result ? (
          <>
            <div
              className={`flex items-start gap-3 rounded-2xl p-4 ${statusSuccess}`}
            >
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
              <div>
                <p className="font-semibold">Your customer list is updated.</p>
                <p className="mt-1 text-sm">
                  {result.created} added · {result.updated} updated ·{" "}
                  {result.skipped} skipped · {result.conflicts} need attention
                </p>
              </div>
            </div>
            {result.rows.some((row) => row.status === "conflict") ? (
              <div className="space-y-2">
                <h3 className={`font-medium ${ink}`}>
                  Rows that need attention
                </h3>
                <ul
                  className={`max-h-60 overflow-y-auto space-y-2 text-sm ${body}`}
                >
                  {result.rows
                    .filter((row) => row.status === "conflict")
                    .map((row) => (
                      <li key={row.rowNumber}>
                        Row {row.rowNumber}:{" "}
                        {row.error ||
                          "Resolve the matching customer before importing this row again."}
                      </li>
                    ))}
                </ul>
              </div>
            ) : null}
            <button onClick={onClose} className={btnPrimaryInline}>
              Done
            </button>
          </>
        ) : (
          <>
            <div className={`${tile} p-5`}>
              <label
                htmlFor={`${id}-file`}
                className={`${fieldLabel} flex items-center gap-2`}
              >
                <FileSpreadsheet className="h-5 w-5" />
                Choose a CSV file
              </label>
              <p className={`mb-3 text-sm ${body}`}>
                Use a header row, then one customer per row (up to 5,000 rows
                and 5 MB). Existing matches only fill empty fields; conflicting
                matches are left for you to resolve.
              </p>
              <input
                id={`${id}-file`}
                type="file"
                accept=".csv,text/csv"
                disabled={busy}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) void loadFile(file);
                }}
                className={`block w-full text-sm file:mr-4 file:rounded-full file:border-0 file:bg-stone-200 file:px-4 file:py-2 file:text-stone-800 dark:file:bg-white/10 dark:file:text-white ${body}`}
              />
              {busy && !preview ? (
                <p role="status" className={`mt-3 text-sm ${body}`}>
                  Checking your file…
                </p>
              ) : null}
            </div>
            {preview ? (
              <>
                <section aria-labelledby={`${id}-mapping`}>
                  <h3 id={`${id}-mapping`} className={`font-semibold ${ink}`}>
                    Match your columns
                  </h3>
                  <p className={`mt-1 text-sm ${body}`}>
                    {fileName} · Choose which column supplies each field. Leave
                    unused fields unmapped.
                  </p>
                  <fieldset
                    disabled={busy}
                    className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
                  >
                    {IMPORT_FIELDS.map(([field, label]) => (
                      <div key={field}>
                        <label
                          htmlFor={`${id}-${field}`}
                          className={fieldLabel}
                        >
                          {label}
                        </label>
                        <select
                          id={`${id}-${field}`}
                          value={mapping[field] || ""}
                          onChange={(event) => {
                            setMapping((current) => ({
                              ...current,
                              [field]: event.target.value,
                            }));
                            setMappingDirty(true);
                          }}
                          className={inputField}
                        >
                          <option value="">Don’t import</option>
                          {preview.headers.map((header) => (
                            <option value={header} key={header}>
                              {header}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </fieldset>
                  <p className={`mt-3 text-xs ${body}`}>
                    Relationships: lead, customer, inactive. Lead interest:
                    normal, warm, hot. Separate tags with semicolons. Use an ISO
                    date with a time zone for follow-ups.
                  </p>
                  {mappingDirty ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={refreshPreview}
                      className={`mt-4 ${btnSecondaryInline} disabled:opacity-50`}
                    >
                      {busy ? "Updating…" : "Update preview"}
                    </button>
                  ) : null}
                </section>
                <section aria-labelledby={`${id}-preview`} aria-busy={busy}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 id={`${id}-preview`} className={`font-semibold ${ink}`}>
                      Review before importing
                    </h3>
                    <p className={`text-sm ${body}`}>
                      {preview.summary.total} rows
                    </p>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {[
                      [preview.summary.create, "New customers"],
                      [preview.summary.fill_blanks, "Fill empty fields"],
                      [preview.summary.skip, "Unchanged"],
                      [preview.summary.conflict, "Need attention"],
                    ].map(([count, label]) => (
                      <div key={label} className={`${tile} p-3`}>
                        <p className={`text-xl font-semibold ${ink}`}>
                          {count}
                        </p>
                        <p className={`text-xs ${body}`}>{label}</p>
                      </div>
                    ))}
                  </div>
                  {mappingDirty ? (
                    <p
                      className={`mt-3 rounded-2xl p-3 text-sm ${statusWarning}`}
                    >
                      Update the preview to apply your new column choices.
                    </p>
                  ) : null}
                  <div className="mt-4 max-h-72 overflow-auto rounded-2xl border border-[#ece4d8] dark:border-white/10">
                    <table className={`w-full text-left text-sm ${body}`}>
                      <thead className="sticky top-0 bg-[#faf7f2] dark:bg-[#202023]">
                        <tr>
                          <th className="p-3">Row</th>
                          <th className="p-3">Customer</th>
                          <th className="p-3">Result</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-stone-100 dark:divide-white/5">
                        {preview.rows
                          .slice(previewPage * 50, (previewPage + 1) * 50)
                          .map((row) => (
                            <tr key={row.rowNumber}>
                              <td className="p-3 align-top">{row.rowNumber}</td>
                              <td className="p-3 align-top">
                                <span className={ink}>
                                  {String(
                                    row.values.name ||
                                      row.values.company ||
                                      row.values.email ||
                                      row.values.phone_number ||
                                      "Unnamed",
                                  )}
                                </span>
                                {row.values.email ? (
                                  <span className="mt-1 block text-xs">
                                    {String(row.values.email)}
                                  </span>
                                ) : null}
                              </td>
                              <td className="p-3 align-top">
                                <span>
                                  {row.action === "create"
                                    ? "Add"
                                    : row.action === "fill_blanks"
                                      ? "Fill empty fields"
                                      : row.action === "skip"
                                        ? "Skip"
                                        : "Needs attention"}
                                </span>
                                {row.errors.length ? (
                                  <p className="mt-1 text-xs">
                                    {row.errors.join(" ")}
                                  </p>
                                ) : null}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                  {preview.rows.length > 50 ? (
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <p className={`text-xs ${body}`}>
                        Preview page {previewPage + 1} of{" "}
                        {Math.ceil(preview.rows.length / 50)}
                      </p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={previewPage === 0 || busy}
                          onClick={() => setPreviewPage((value) => value - 1)}
                          className={`${btnSecondaryInline} disabled:opacity-40`}
                        >
                          Previous rows
                        </button>
                        <button
                          type="button"
                          disabled={
                            (previewPage + 1) * 50 >= preview.rows.length ||
                            busy
                          }
                          onClick={() => setPreviewPage((value) => value + 1)}
                          className={`${btnSecondaryInline} disabled:opacity-40`}
                        >
                          Next rows
                        </button>
                      </div>
                    </div>
                  ) : null}
                </section>
                <div className="flex flex-wrap items-center justify-between gap-4 border-t border-[#ece4d8] pt-5 dark:border-white/10">
                  <p className={`max-w-md text-xs ${body}`}>
                    Only import customers you have a legitimate relationship
                    with. Contact details alone are not permission to send
                    texts.
                  </p>
                  <button
                    type="button"
                    disabled={
                      busy ||
                      mappingDirty ||
                      preview.summary.create + preview.summary.fill_blanks === 0
                    }
                    onClick={commit}
                    className={`${btnPrimaryInline} disabled:opacity-50`}
                  >
                    <Upload className="h-4 w-4" />
                    {busy ? "Importing…" : "Import customers"}
                  </button>
                </div>
              </>
            ) : null}
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
