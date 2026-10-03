"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
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
import type { ReviewPermissionSummary } from "@/lib/reviews/types";
type PermissionResponse = {
  permissions: ReviewPermissionSummary[];
  smsRequiresKeyword: boolean;
  consentUrl: string | null;
};

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
  const [permissions, setPermissions] = useState<
    ReviewPermissionSummary[] | null
  >(null);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [smsSetup, setSmsSetup] = useState<{
    required: boolean;
    url: string | null;
  }>({ required: false, url: null });
  const [channel, setChannel] = useState("email");
  async function loadPermissions() {
    try {
      const result = await reviewRequest<PermissionResponse>(
        `/api/reviews/permissions?contactId=${encodeURIComponent(customerId)}`,
      );
      setPermissions(result.permissions);
      setSmsSetup({
        required: Boolean(result.smsRequiresKeyword),
        url: result.consentUrl ?? null,
      });
      setPermissionError(null);
    } catch (cause) {
      setPermissionError(requestError(cause));
    }
  }
  useEffect(() => {
    let current = true;
    setPermissions(null);
    setPermissionError(null);
    setSmsSetup({ required: false, url: null });
    reviewRequest<PermissionResponse>(
      `/api/reviews/permissions?contactId=${encodeURIComponent(customerId)}`,
    )
      .then((result) => {
        if (current) {
          setPermissions(result.permissions);
          setSmsSetup({
            required: Boolean(result.smsRequiresKeyword),
            url: result.consentUrl ?? null,
          });
        }
      })
      .catch((cause) => {
        if (current) setPermissionError(requestError(cause));
      });
    return () => {
      current = false;
    };
  }, [customerId]);
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
      await loadPermissions();
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
      {smsSetup.required ? (
        <p className={`mt-3 text-xs ${body}`}>
          Text review permission is saved automatically when the customer sends
          REVIEWS from their own phone.{" "}
          {smsSetup.url ? (
            <a
              href={smsSetup.url}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              Share your permission page
            </a>
          ) : null}{" "}
          You can withdraw permission here.
        </p>
      ) : null}
      {permissionError ? (
        <p role="alert" className={`mt-3 text-xs ${statusDanger}`}>
          Could not load existing permission. {permissionError}
        </p>
      ) : permissions === null ? (
        <p className={`mt-3 text-xs ${body}`}>Loading current permission…</p>
      ) : permissions.length ? (
        <ul
          className={`mt-3 space-y-3 text-xs ${body}`}
          aria-label="Current review permissions"
        >
          {permissions.map((permission) => (
            <li
              key={permission.destination}
              className="rounded-xl border border-current/10 p-3"
            >
              <p className={`font-semibold ${ink}`}>
                {permission.channel === "sms"
                  ? "Text reviews"
                  : "Email reviews"}
                :{" "}
                {permission.status === "granted"
                  ? "Permission recorded"
                  : permission.status === "suppressed"
                    ? "Opted out — sending blocked"
                    : permission.status === "keyword_required"
                      ? "Customer must text REVIEWS"
                      : "Permission withdrawn"}
              </p>
              <p className="mt-1">{permission.destination}</p>
              <p className="mt-1">
                {permission.source === "customer_keyword"
                  ? "Customer texted REVIEWS"
                  : "Recorded by your business"}{" "}
                ·{" "}
                {new Date(
                  permission.revokedAt ?? permission.grantedAt,
                ).toLocaleDateString()}
              </p>
              <p className="mt-1">{permission.evidence}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className={`mt-3 text-xs ${body}`}>
          No review permission has been recorded for this customer yet.
        </p>
      )}
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
                value={channel}
                onChange={(event) => setChannel(event.target.value)}
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
                {channel !== "sms" || !smsSetup.required ? (
                  <option value="granted">Customer gave permission</option>
                ) : null}
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
