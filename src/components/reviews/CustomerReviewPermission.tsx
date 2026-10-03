"use client";

import { useId, useState, type FormEvent } from "react";
import {
  body,
  btnSecondaryInline,
  fieldLabel,
  ink,
  inputField,
  statusDanger,
  statusSuccess,
  tile,
} from "@/lib/theme-v2/theme";
import { requestError } from "@/components/customers/customerUi";
import { REVIEW_TIMEZONES, reviewRequest } from "./reviewUi";

/** Records the owner's evidence, never substitutes a phone number for consent. */
export default function CustomerReviewPermission({
  customerId,
  onBusyChange,
}: {
  customerId: string;
  onBusyChange?: (busy: boolean) => void;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const granted = form.get("decision") === "granted";
    const timezone = String(form.get("timezone") || "");
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    setNotice(null);
    try {
      await reviewRequest("/api/reviews/permissions", {
        method: "POST",
        body: JSON.stringify({
          contactId: customerId,
          channel: form.get("channel"),
          granted,
          evidence: String(form.get("evidence") || "").trim(),
          ...(timezone ? { timezone } : {}),
        }),
      });
      setNotice(
        granted
          ? "Permission evidence saved. Existing opt-outs remain in place. Future eligible service completions can use this permission when automation is enabled."
          : "Permission withdrawn for this channel. New automatic requests will not use it.",
      );
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  return (
    <details className={`${tile} p-4`}>
      <summary className={`cursor-pointer text-sm font-semibold ${ink}`}>
        Review-request permission
      </summary>
      <p className={`mt-3 text-xs ${body}`}>
        Record what this customer agreed to before using automatic requests
        after completed work. Saving contact information alone does not grant
        permission.
      </p>
      <form onSubmit={save} className="mt-4 space-y-4">
        <fieldset disabled={busy} className="space-y-4 disabled:opacity-60">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${id}-channel`} className={fieldLabel}>
                Channel
              </label>
              <select
                id={`${id}-channel`}
                name="channel"
                className={inputField}
              >
                <option value="email">Email review requests</option>
                <option value="sms">Automated text review requests</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${id}-decision`} className={fieldLabel}>
                Permission update
              </label>
              <select
                id={`${id}-decision`}
                name="decision"
                required
                defaultValue=""
                className={inputField}
              >
                <option value="" disabled>
                  Choose an update
                </option>
                <option value="granted">Customer gave permission</option>
                <option value="withdrawn">Customer withdrew permission</option>
              </select>
            </div>
          </div>
          <div>
            <label htmlFor={`${id}-evidence`} className={fieldLabel}>
              Permission details
            </label>
            <textarea
              id={`${id}-evidence`}
              name="evidence"
              required
              minLength={10}
              maxLength={1000}
              rows={3}
              placeholder="When, where, and how the customer gave or withdrew permission."
              className={inputField}
            />
          </div>
          <div>
            <label htmlFor={`${id}-timezone`} className={fieldLabel}>
              Customer time zone <span className="font-normal">(optional)</span>
            </label>
            <select
              id={`${id}-timezone`}
              name="timezone"
              className={inputField}
            >
              <option value="">Use the business time zone</option>
              {REVIEW_TIMEZONES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <p className={`text-xs ${body}`}>
            This does not override an unsubscribe or STOP request. It does not
            send a message or enroll the customer by itself.
          </p>
        </fieldset>
        {error ? (
          <p role="alert" className={`rounded-2xl p-3 text-sm ${statusDanger}`}>
            {error}
          </p>
        ) : null}
        {notice ? (
          <p
            role="status"
            className={`rounded-2xl p-3 text-sm ${statusSuccess}`}
          >
            {notice}
          </p>
        ) : null}
        <button
          disabled={busy}
          type="submit"
          className={`${btnSecondaryInline} disabled:opacity-50`}
        >
          {busy ? "Saving…" : "Save permission update"}
        </button>
      </form>
    </details>
  );
}
