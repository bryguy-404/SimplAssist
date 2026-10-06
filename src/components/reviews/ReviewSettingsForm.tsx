"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Mail } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import type { ReviewOverview } from "@/lib/reviews/types";
import {
  body,
  btnPrimaryInline,
  btnSecondaryInline,
  card,
  fieldLabel,
  ink,
  inputField,
  statusDanger,
  statusSuccess,
  statusWarning,
} from "@/lib/theme-v2/theme";
import { requestError } from "@/components/customers/customerUi";
import { REVIEW_TIMEZONES, reviewRequest } from "./reviewUi";

export default function ReviewSettingsForm({
  overview,
  ownerEmail,
  smsReady = false,
  onSaved,
}: {
  overview: ReviewOverview;
  ownerEmail: string;
  smsReady?: boolean;
  onSaved: (value: ReviewOverview) => void;
}) {
  const id = useId();
  const router = useRouter();
  const { showToast } = useToast();
  const settings = overview.settings;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) || "").trim();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await reviewRequest<ReviewOverview>(
        "/api/reviews/settings",
        {
          method: "PATCH",
          body: JSON.stringify({
            googleReviewUrl: value("googleReviewUrl"),
            timezone: value("timezone"),
            replyTo: value("replyTo"),
            notificationEmail: value("notificationEmail"),
            subject: value("subject"),
            body: value("body"),
            reminderEnabled: form.get("reminderEnabled") === "on",
            automationEnabled: form.get("automationEnabled") === "on",
            automationChannel: value("automationChannel") || "email",
          }),
        },
      );
      onSaved(next);
      const message = next.settings.pending_reply_to
        ? "Settings saved. Check the new Reply-To inbox to verify that address."
        : "Review settings saved.";
      setNotice(message);
      showToast(message, "success");
      // Refresh the router cache so returning to Dashboard reflects saved setup.
      router.refresh();
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
    }
  }
  async function testEmail() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await reviewRequest<{ queued: boolean; to: string }>(
        "/api/reviews/test",
        { method: "POST" },
      );
      setNotice(
        `Test email queued for ${result.to}. It uses your saved settings and does not contact customers.`,
      );
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
    }
  }
  const notificationEmails = Array.from(
    new Set([ownerEmail, settings.reply_to].filter(Boolean)),
  );
  return (
    <section className={`${card} p-5 sm:p-7`} aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className={`text-lg font-semibold ${ink}`}>
        Google review settings
      </h2>
      <p className={`mt-1 text-sm ${body}`}>
        Add your Google review link and choose how invitations and reminders are sent.
      </p>
      <form onSubmit={save} className="mt-6 space-y-6">
        <fieldset disabled={busy} className="space-y-5 disabled:opacity-60">
          <div>
            <label htmlFor={`${id}-google`} className={fieldLabel}>
              Google review link
            </label>
            <input
              id={`${id}-google`}
              name="googleReviewUrl"
              type="url"
              required
              maxLength={2048}
              defaultValue={settings.google_review_url || ""}
              placeholder="https://g.page/r/…/review"
              className={inputField}
            />
            <p className={`mt-2 text-xs ${body}`}>
              Paste the review link from your Google Business Profile’s “Ask for
              reviews” option. Every customer receives the same opportunity to
              leave an honest review.
            </p>
          </div>
          <div>
            <label htmlFor={`${id}-timezone`} className={fieldLabel}>
              Business time zone
            </label>
            <select
              id={`${id}-timezone`}
              name="timezone"
              defaultValue={settings.timezone}
              className={inputField}
            >
              {REVIEW_TIMEZONES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <p className={`mt-2 text-xs ${body}`}>
              Requests are sent between 9 AM and 6 PM in this time zone. The
              final preview shows any adjusted send time.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={`${id}-reply`} className={fieldLabel}>
                Reply-To email
              </label>
              <input
                id={`${id}-reply`}
                name="replyTo"
                type="email"
                required
                maxLength={254}
                defaultValue={settings.pending_reply_to || settings.reply_to}
                className={inputField}
              />
            </div>
            <div>
              <label htmlFor={`${id}-notify`} className={fieldLabel}>
                Notification email
              </label>
              <select
                id={`${id}-notify`}
                name="notificationEmail"
                defaultValue={settings.notification_email}
                className={inputField}
              >
                {notificationEmails.map((email) => (
                  <option key={email} value={email}>
                    {email}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div
            className={`rounded-2xl p-3 text-sm ${settings.pending_reply_to ? statusWarning : statusSuccess}`}
          >
            <p className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" />
              Verified Reply-To: {settings.reply_to}
            </p>
            {settings.pending_reply_to ? (
              <p className="mt-2">
                Waiting for verification: {settings.pending_reply_to}. We’ll
                keep using your verified address until the new one is confirmed.
              </p>
            ) : null}
          </div>
          <p className={`text-xs ${body}`}>
            Customer replies arrive in your email inbox. SimplAssist cannot read
            those replies or automatically stop a reminder when someone replies.
            You can stop it from Requests.
          </p>
          <div>
            <label htmlFor={`${id}-subject`} className={fieldLabel}>
              Default email subject
            </label>
            <input
              id={`${id}-subject`}
              name="subject"
              required
              maxLength={200}
              defaultValue={settings.subject}
              className={inputField}
            />
          </div>
          <div>
            <label htmlFor={`${id}-body`} className={fieldLabel}>
              Default message
            </label>
            <textarea
              id={`${id}-body`}
              name="body"
              required
              rows={6}
              maxLength={4000}
              defaultValue={settings.body}
              className={inputField}
            />
            <p className={`mt-2 text-xs ${body}`}>
              Available placeholders: <code>{"{{customer_name}}"}</code> and{" "}
              <code>{"{{business_name}}"}</code>. The Google review button,
              business name, and unsubscribe link are added automatically.
            </p>
          </div>
          <label className={`flex items-start gap-3 text-sm ${body}`}>
            <input
              type="checkbox"
              name="reminderEnabled"
              defaultChecked={settings.reminder_enabled}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand-primary)]"
            />
            <span>
              Send one reminder after four days if the customer hasn’t clicked
              the Google review link.
              <span className="mt-1 block text-xs">
                Clicks stop reminders; they do not confirm a review was posted.
                Unsubscribes and permanent delivery failures also stop requests.
              </span>
            </span>
          </label>
          <div className="space-y-3 border-t border-[#ece4d8] pt-5 dark:border-white/10">
            <h3 className={`text-sm font-semibold ${ink}`}>
              After completed work
            </h3>
            <label className={`flex items-start gap-3 text-sm ${body}`}>
              <input
                type="checkbox"
                name="automationEnabled"
                defaultChecked={settings.automation_enabled === true}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand-primary)]"
              />
              <span>
                Automatically request a review when I mark a service completed.
              </span>
            </label>
            <div>
              <label
                htmlFor={`${id}-automation-channel`}
                className={fieldLabel}
              >
                Automatic request channel
              </label>
              <select
                id={`${id}-automation-channel`}
                name="automationChannel"
                defaultValue={settings.automation_channel || "email"}
                className={inputField}
              >
                <option value="email">Email</option>
                <option value="sms" disabled={!smsReady}>
                  Text{!smsReady ? " — approval and activation required" : ""}
                </option>
              </select>
            </div>
            <p className={`text-xs ${body}`}>
              Applies to future service completions for customers with saved
              permission for that channel. Requests are scheduled for 10 AM the
              next day in the customer’s saved time zone or your business time
              zone. Existing jobs and imports do not trigger requests. Save
              permission in the customer’s record before completing their
              service.
            </p>
            <p className={`text-xs ${body}`}>
              Automatic email requests use your saved message. Automatic texts
              use: “Thank you for choosing [your business]. Would you share an
              honest Google review?” Both use your reminder setting and respect
              opt-outs, review history, pauses, and your allowance.
            </p>
          </div>
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
        <div className="flex flex-wrap gap-3 border-t border-[#ece4d8] pt-5 dark:border-white/10">
          <button
            type="submit"
            disabled={busy}
            className={`${btnPrimaryInline} disabled:opacity-50`}
          >
            {busy ? "Working…" : "Save settings"}
          </button>
          <button
            type="button"
            disabled={busy || !overview.eligibility.sendingEnabled}
            onClick={testEmail}
            className={`${btnSecondaryInline} disabled:opacity-50`}
          >
            <Mail className="h-4 w-4" />
            Send test to my email
          </button>
        </div>
      </form>
    </section>
  );
}
