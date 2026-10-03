"use client";

import { useId, useState, type FormEvent } from "react";
import type { CustomerRecord } from "@/lib/customers/types";
import {
  body,
  btnPrimaryInline,
  btnSecondaryInline,
  fieldLabel,
  inputField,
  statusDanger,
} from "@/lib/theme-v2/theme";
import { customerPhone, localDateTime, requestError } from "./customerUi";

export type CustomerFormValues = Pick<
  CustomerRecord,
  | "name"
  | "company"
  | "email"
  | "phone_number"
  | "service_address"
  | "notes"
  | "customer_stage"
  | "is_priority"
  | "owner_warmth_override"
  | "next_follow_up_at"
  | "tags"
>;

export default function CustomerForm({
  customer,
  onSave,
  onCancel,
  onBusyChange,
}: {
  customer?: CustomerRecord;
  onSave: (values: CustomerFormValues) => Promise<void>;
  onCancel: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const id = useId();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) || "").trim() || null;
    const followUp = value("next_follow_up_at");
    setSaving(true);
    onBusyChange?.(true);
    setError(null);
    try {
      await onSave({
        name: value("name"),
        company: value("company"),
        email: value("email"),
        phone_number: value("phone_number"),
        service_address: value("service_address"),
        notes: value("notes"),
        customer_stage: value(
          "customer_stage",
        ) as CustomerRecord["customer_stage"],
        is_priority: form.get("is_priority") === "on",
        owner_warmth_override: value(
          "owner_warmth_override",
        ) as CustomerRecord["owner_warmth_override"],
        next_follow_up_at: followUp ? new Date(followUp).toISOString() : null,
        tags: Array.from(
          new Set(
            (value("tags") || "")
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean),
          ),
        ),
      });
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setSaving(false);
      onBusyChange?.(false);
    }
  }
  const fields = [
    {
      key: "name",
      label: "Name",
      type: "text",
      autoComplete: "name",
      max: 200,
    },
    {
      key: "company",
      label: "Company",
      type: "text",
      autoComplete: "organization",
      max: 200,
    },
    {
      key: "email",
      label: "Email",
      type: "email",
      autoComplete: "email",
      max: 254,
    },
    {
      key: "phone_number",
      label: "Phone",
      type: "tel",
      autoComplete: "tel",
      max: 40,
    },
  ] as const;
  return (
    <form onSubmit={submit} className="space-y-5">
      <fieldset disabled={saving} className="space-y-5 disabled:opacity-60">
        <div className="grid gap-4 sm:grid-cols-2">
          {fields.map((field) => (
            <div key={field.key}>
              <label htmlFor={`${id}-${field.key}`} className={fieldLabel}>
                {field.label}
              </label>
              <input
                id={`${id}-${field.key}`}
                name={field.key}
                type={field.type}
                autoComplete={field.autoComplete}
                maxLength={field.max}
                defaultValue={
                  customer
                    ? (field.key === "phone_number"
                        ? customerPhone(customer)
                        : customer[field.key]) || ""
                    : ""
                }
                className={inputField}
              />
            </div>
          ))}
        </div>
        <p className={`text-xs ${body}`}>
          Add at least a name, company, email, or phone number. Adding a
          customer doesn’t send a message.
        </p>
        <div>
          <label htmlFor={`${id}-address`} className={fieldLabel}>
            Service address
          </label>
          <textarea
            id={`${id}-address`}
            name="service_address"
            autoComplete="street-address"
            maxLength={1000}
            rows={2}
            defaultValue={customer?.service_address || ""}
            className={inputField}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`${id}-stage`} className={fieldLabel}>
              Relationship
            </label>
            <select
              id={`${id}-stage`}
              name="customer_stage"
              defaultValue={customer?.customer_stage || "customer"}
              className={inputField}
            >
              <option value="lead">Lead</option>
              <option value="customer">Customer</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-warmth`} className={fieldLabel}>
              Lead interest
            </label>
            <select
              id={`${id}-warmth`}
              name="owner_warmth_override"
              defaultValue={customer?.owner_warmth_override || ""}
              className={inputField}
            >
              <option value="">Use automatic classification</option>
              <option value="normal">Normal</option>
              <option value="warm">Warm</option>
              <option value="hot">Hot</option>
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-followup`} className={fieldLabel}>
              Next follow-up
            </label>
            <input
              id={`${id}-followup`}
              name="next_follow_up_at"
              type="datetime-local"
              defaultValue={localDateTime(customer?.next_follow_up_at)}
              className={inputField}
            />
            <p className={`mt-1 text-xs ${body}`}>
              Shown in your current time zone.
            </p>
          </div>
          <div>
            <label htmlFor={`${id}-tags`} className={fieldLabel}>
              Tags
            </label>
            <input
              id={`${id}-tags`}
              name="tags"
              defaultValue={customer?.tags.join(", ") || ""}
              placeholder="Website build, repeat customer"
              maxLength={1000}
              className={inputField}
            />
            <p className={`mt-1 text-xs ${body}`}>Separate tags with commas.</p>
          </div>
        </div>
        <label className={`flex items-center gap-3 text-sm ${body}`}>
          <input
            type="checkbox"
            name="is_priority"
            defaultChecked={customer?.is_priority || false}
            className="h-4 w-4 accent-[var(--brand-primary)]"
          />
          Mark as a priority
        </label>
        <div>
          <label htmlFor={`${id}-notes`} className={fieldLabel}>
            Notes
          </label>
          <textarea
            id={`${id}-notes`}
            name="notes"
            rows={4}
            maxLength={10000}
            defaultValue={customer?.notes || ""}
            className={inputField}
          />
        </div>
      </fieldset>
      {error ? (
        <p role="alert" className={`rounded-2xl p-3 text-sm ${statusDanger}`}>
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-3 border-t border-[#ece4d8] pt-5 dark:border-white/10">
        <button
          type="button"
          disabled={saving}
          onClick={onCancel}
          className={`${btnSecondaryInline} disabled:opacity-50`}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className={`${btnPrimaryInline} disabled:opacity-50`}
        >
          {saving ? "Saving…" : customer ? "Save changes" : "Add customer"}
        </button>
      </div>
    </form>
  );
}
