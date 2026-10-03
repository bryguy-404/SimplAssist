"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Clock3 } from "lucide-react";
import type { ReviewCampaign, ReviewEnrollment } from "@/lib/reviews/types";
import {
  body,
  btnPrimaryInline,
  btnSecondaryCompact,
  btnSecondaryInline,
  card,
  fieldLabel,
  ink,
  inputField,
  statusDanger,
  statusNeutral,
  statusSuccess,
  tile,
} from "@/lib/theme-v2/theme";
import CustomerDialog from "@/components/customers/CustomerDialog";
import { requestError } from "@/components/customers/customerUi";
import {
  reviewReason,
  reviewRequest,
  reviewSchedule,
  reviewTime,
} from "./reviewUi";

export function enrollmentLabel(enrollment: ReviewEnrollment): string {
  if (enrollment.status === "reviewed") return "Marked reviewed by you";
  if (enrollment.status === "clicked") return "Google link clicked";
  if (enrollment.status === "cancelled")
    return enrollment.stop_reason === "unsubscribe"
      ? "Unsubscribed"
      : "Stopped";
  if (enrollment.status === "needs_reschedule") return "Needs a new send time";
  const initial = [
    ...enrollment.review_email_outbox,
    ...(enrollment.review_sms_outbox || []),
  ].find((item) => item.kind === "initial");
  if (initial?.status === "delivered")
    return enrollment.review_sms_outbox?.some(
      (item) => item.kind === "initial" && item.status === "delivered",
    )
      ? "Text delivered"
      : "Email delivered";
  if (initial?.status === "accepted") return "Sent";
  if (initial?.status === "unknown") return "Delivery needs checking";
  if (initial?.status === "failed") return "Delivery failed";
  return enrollment.status === "active"
    ? "Scheduled"
    : reviewReason(enrollment.status);
}

export function campaignHeading(
  campaign: Pick<ReviewCampaign, "channel" | "subject"> & {
    displaySubject?: string;
  },
): string {
  if (campaign.channel === "sms") return "Text review request";
  if (campaign.displaySubject?.trim()) return campaign.displaySubject;
  return campaign.subject && !campaign.subject.includes("{{")
    ? campaign.subject
    : "Email review request";
}

function CampaignCard({
  campaign,
  busy,
  onAction,
  onReschedule,
}: {
  campaign: ReviewCampaign;
  busy: string | null;
  onAction: (
    enrollment: ReviewEnrollment,
    action: "cancel" | "mark_reviewed",
  ) => void;
  onReschedule: (enrollment: ReviewEnrollment) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const recipients = campaign.review_enrollments;
  return (
    <article className={`${card} overflow-hidden`}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={`campaign-${campaign.id}`}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-start justify-between gap-4 p-5 text-left"
      >
        <div>
          <h3 className={`font-semibold ${ink}`}>
            {campaignHeading(campaign)}
          </h3>
          <p className={`mt-1 text-xs ${body}`}>
            {campaign.channel === "sms" ? "Text" : "Email"} ·{" "}
            {campaign.audience_count}{" "}
            {campaign.audience_count === 1 ? "customer" : "customers"} · Created{" "}
            {reviewTime(campaign.created_at)}
          </p>
          <p className={`mt-1 text-xs ${body}`}>
            {campaign.reminder_enabled ? "One reminder enabled" : "No reminder"}
          </p>
        </div>
        {expanded ? (
          <ChevronDown className={`mt-1 h-4 w-4 shrink-0 ${body}`} />
        ) : (
          <ChevronRight className={`mt-1 h-4 w-4 shrink-0 ${body}`} />
        )}
      </button>
      {expanded ? (
        <div
          id={`campaign-${campaign.id}`}
          className="space-y-4 border-t border-[#ece4d8] p-5 dark:border-white/10"
        >
          <p className={`whitespace-pre-wrap text-sm ${body}`}>
            {campaign.body}
          </p>
          <ul className="space-y-3">
            {recipients.slice(page * 20, (page + 1) * 20).map((enrollment) => {
              const initial = [
                ...enrollment.review_email_outbox,
                ...(enrollment.review_sms_outbox || []),
              ].find((delivery) => delivery.kind === "initial");
              const actionable = ["active", "needs_reschedule"].includes(
                enrollment.status,
              );
              const canReschedule =
                actionable &&
                !initial?.accepted_at &&
                ["pending", "needs_reschedule"].includes(initial?.status || "");
              return (
                <li key={enrollment.id} className={`${tile} p-4`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className={`break-all text-sm font-medium ${ink}`}>
                      {enrollment.destination}
                    </p>
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs ${enrollment.status === "reviewed" ? statusSuccess : statusNeutral}`}
                    >
                      {enrollmentLabel(enrollment)}
                    </span>
                  </div>
                  {enrollment.stop_reason ? (
                    <p className={`mt-2 text-xs ${body}`}>
                      {reviewReason(enrollment.stop_reason)}
                    </p>
                  ) : null}
                  <ul className={`mt-3 space-y-1 text-xs ${body}`}>
                    {[
                      ...enrollment.review_email_outbox,
                      ...(enrollment.review_sms_outbox || []),
                    ]
                      .sort((a, b) =>
                        a.kind === b.kind ? 0 : a.kind === "initial" ? -1 : 1,
                      )
                      .map((delivery) => (
                        <li
                          key={delivery.id}
                          className="flex flex-wrap gap-x-2"
                        >
                          <span className="font-medium">
                            {delivery.kind === "initial"
                              ? "Invitation"
                              : "Reminder"}
                            :
                          </span>
                          <span>
                            {reviewReason(delivery.status)} ·{" "}
                            {reviewTime(
                              delivery.delivered_at ||
                                delivery.accepted_at ||
                                delivery.scheduled_at,
                            )}
                          </span>
                          {delivery.last_error ? (
                            <span>({reviewReason(delivery.last_error)})</span>
                          ) : null}
                        </li>
                      ))}
                  </ul>
                  {actionable || enrollment.status === "clicked" ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {actionable ? (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => onAction(enrollment, "cancel")}
                          className={`${btnSecondaryCompact} disabled:opacity-50`}
                        >
                          Stop requests
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => onAction(enrollment, "mark_reviewed")}
                        className={`${btnSecondaryCompact} disabled:opacity-50`}
                      >
                        Mark reviewed
                      </button>
                      {canReschedule ? (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => onReschedule(enrollment)}
                          className={`${btnSecondaryCompact} disabled:opacity-50`}
                        >
                          <Clock3 className="h-3.5 w-3.5" />
                          Reschedule
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {recipients.length > 20 ? (
            <div className="flex items-center justify-between gap-3">
              <span className={`text-xs ${body}`}>
                Recipients {page * 20 + 1}–
                {Math.min((page + 1) * 20, recipients.length)} of{" "}
                {recipients.length}
              </span>
              <div className="flex gap-2">
                <button
                  disabled={page === 0}
                  onClick={() => setPage((value) => value - 1)}
                  className={`${btnSecondaryCompact} disabled:opacity-40`}
                >
                  Previous
                </button>
                <button
                  disabled={(page + 1) * 20 >= recipients.length}
                  onClick={() => setPage((value) => value + 1)}
                  className={`${btnSecondaryCompact} disabled:opacity-40`}
                >
                  Next
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export default function ReviewHistory({
  campaigns,
  onChanged,
}: {
  campaigns: ReviewCampaign[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState<ReviewEnrollment | null>(
    null,
  );
  const [scheduledAt, setScheduledAt] = useState("");
  async function action(
    enrollment: ReviewEnrollment,
    nextAction: "cancel" | "mark_reviewed" | "reschedule",
  ) {
    if (busy) return;
    setBusy(enrollment.id);
    setError(null);
    setNotice(null);
    try {
      const result = await reviewRequest<{ updated: boolean }>(
        `/api/reviews/enrollments/${encodeURIComponent(enrollment.id)}`,
        {
          method: "POST",
          body: JSON.stringify({
            action: nextAction,
            ...(nextAction === "reschedule"
              ? { scheduledAt: reviewSchedule(scheduledAt) }
              : {}),
          }),
        },
      );
      if (!result.updated)
        throw new Error(
          "This request changed before the update. Refresh and check its current status.",
        );
      setNotice(
        nextAction === "mark_reviewed"
          ? "Marked reviewed by you. Further reminders are stopped."
          : nextAction === "cancel"
            ? "Future requests stopped. A message already being delivered cannot be recalled."
            : "Request rescheduled. Check its updated send time below.",
      );
      setRescheduling(null);
      setScheduledAt("");
      onChanged();
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="space-y-4" aria-label="Review request history">
      <div>
        <h2 className={`text-lg font-semibold ${ink}`}>Requests</h2>
        <p className={`mt-1 text-sm ${body}`}>
          Track delivery and manage reminders. Link clicks do not confirm a
          posted Google review.
        </p>
      </div>
      {notice ? (
        <p role="status" className={`rounded-2xl p-3 text-sm ${statusSuccess}`}>
          {notice}
        </p>
      ) : null}
      {error && !rescheduling ? (
        <p role="alert" className={`rounded-2xl p-3 text-sm ${statusDanger}`}>
          {error}
        </p>
      ) : null}
      {campaigns.length ? (
        campaigns.map((campaign) => (
          <CampaignCard
            key={campaign.id}
            campaign={campaign}
            busy={busy}
            onAction={action}
            onReschedule={(enrollment) => {
              setRescheduling(enrollment);
              setError(null);
            }}
          />
        ))
      ) : (
        <div className={`${card} px-6 py-12 text-center`}>
          <h3 className={`font-semibold ${ink}`}>
            Your first review request starts here
          </h3>
          <p className={`mx-auto mt-2 max-w-md text-sm ${body}`}>
            Once your settings are ready, choose customers with completed work
            and preview their request.
          </p>
        </div>
      )}
      {rescheduling ? (
        <CustomerDialog
          title="Reschedule review request"
          description={`Choose a new time for ${rescheduling.destination}.`}
          onClose={() => setRescheduling(null)}
          busy={Boolean(busy)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void action(rescheduling, "reschedule");
            }}
            className="space-y-4"
          >
            <label htmlFor="review-reschedule-at" className={fieldLabel}>
              Date and time in your current time zone
            </label>
            <input
              id="review-reschedule-at"
              type="datetime-local"
              required
              value={scheduledAt}
              onChange={(event) => setScheduledAt(event.target.value)}
              className={inputField}
            />
            <p className={`text-xs ${body}`}>
              The send time is adjusted to the request’s 9 AM–6 PM delivery
              window. This changes the invitation only; it does not create an
              extra request.
            </p>
            {error ? (
              <p
                role="alert"
                className={`rounded-2xl p-3 text-sm ${statusDanger}`}
              >
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-3">
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => setRescheduling(null)}
                className={btnSecondaryInline}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={Boolean(busy)}
                className={`${btnPrimaryInline} disabled:opacity-50`}
              >
                {busy ? "Saving…" : "Reschedule"}
              </button>
            </div>
          </form>
        </CustomerDialog>
      ) : null}
    </section>
  );
}
