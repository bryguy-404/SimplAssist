"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Image from "next/image";
import { Mail, Pause, Play, Plus, RefreshCw } from "lucide-react";
import type { ReviewCampaignList, ReviewOverview } from "@/lib/reviews/types";
import {
  body,
  btnPrimaryInline,
  btnSecondaryCompact,
  btnSecondaryInline,
  card,
  ink,
  statusDanger,
  statusSuccess,
  statusWarning,
} from "@/lib/theme-v2/theme";
import { dateLabel, requestError } from "@/components/customers/customerUi";
import ReviewSettingsForm from "./ReviewSettingsForm";
import ReviewHistory from "./ReviewHistory";
import { reviewRequest } from "./reviewUi";

const ReviewSmsPanel = dynamic(() => import("./ReviewSmsPanel"));
const ReviewComposer = dynamic(() => import("./ReviewComposer"));

export default function ReviewsWorkspace({
  ownerEmail,
  initialCustomerId,
  smsEnabled = false,
  initialTab = "requests",
}: {
  ownerEmail: string;
  initialCustomerId?: string;
  smsEnabled?: boolean;
  initialTab?: "requests" | "settings";
}) {
  const [smsReady, setSmsReady] = useState(false);
  const onSmsStatusChanged = useCallback(
    (ready: boolean) => setSmsReady(ready),
    [],
  );
  const [overview, setOverview] = useState<ReviewOverview | null>(null);
  const [history, setHistory] = useState<ReviewCampaignList | null>(null);
  const [tab, setTab] = useState<"requests" | "settings">(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  const [composing, setComposing] = useState(Boolean(initialCustomerId));
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all([
      reviewRequest<ReviewOverview>("/api/reviews/settings", {
        signal: controller.signal,
      }),
      reviewRequest<ReviewCampaignList>(
        `/api/reviews/campaigns?page=${page}&pageSize=10`,
        { signal: controller.signal },
      ),
    ])
      .then(([settings, campaigns]) => {
        if (controller.signal.aborted) return;
        setOverview(settings);
        setHistory(campaigns);
        if (!settings.eligibility.ready) setTab("settings");
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(requestError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, refresh]);
  function reload() {
    setRefresh((value) => value + 1);
  }
  async function togglePause() {
    if (!overview || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await reviewRequest<ReviewOverview>(
        "/api/reviews/settings",
        {
          method: "PATCH",
          body: JSON.stringify({ paused: !overview.settings.paused }),
        },
      );
      setOverview(next);
      setNotice(
        next.settings.paused
          ? "Review sending paused. Your customer records are unchanged."
          : "Review sending resumed. Expired requests still need a new send time.",
      );
    } catch (cause) {
      setError(requestError(cause));
    } finally {
      setBusy(false);
    }
  }
  const canCompose = Boolean(
    overview?.eligibility.enabled &&
    overview.eligibility.paid &&
    !overview.settings.paused &&
    overview.eligibility.ready,
  );
  return (
    <div className="space-y-6">
      <header className="flex flex-col justify-between gap-4 xl:flex-row xl:items-center">
        <div>
          <Image
            src="/brands/google-wordmark-transparent.png"
            alt="Google"
            width={108}
            height={37}
            className="mb-5 h-auto w-[108px]"
          />
          <div>
            <h1 className={`text-2xl font-bold ${ink}`}>Reviews</h1>
            <p className={`mt-1 text-sm ${body}`}>
              Invite customers to share their experience.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={reload}
            disabled={loading}
            className={`${btnSecondaryInline} disabled:opacity-50`}
          >
            <RefreshCw
              className={`h-4 w-4 ${loading ? "animate-spin motion-reduce:animate-none" : ""}`}
            />
            Refresh
          </button>
          <button
            type="button"
            disabled={!canCompose}
            onClick={() => setComposing(true)}
            className={`${btnPrimaryInline} disabled:opacity-50`}
          >
            <Plus className="h-4 w-4" />
            Request reviews
          </button>
        </div>
      </header>
      {error ? (
        <p role="alert" className={`rounded-2xl p-4 text-sm ${statusDanger}`}>
          {error}
        </p>
      ) : null}
      {notice ? (
        <div
          role="status"
          className={`flex items-center justify-between gap-3 rounded-2xl p-4 text-sm ${statusSuccess}`}
        >
          <span>{notice}</span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => setNotice(null)}
            className="px-2 text-lg"
          >
            ×
          </button>
        </div>
      ) : null}
      {!overview && loading ? (
        <p role="status" className={`py-14 text-center ${body}`}>
          Loading review requests…
        </p>
      ) : null}
      {overview ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className={`${card} p-5`}>
              <p className={`flex items-center gap-2 text-xs ${body}`}>
                <Mail className="h-4 w-4" />
                Email allowance
              </p>
              <p className={`mt-3 text-2xl font-semibold tabular-nums ${ink}`}>
                {overview.usage.used}
                <span className={`text-sm font-normal ${body}`}>
                  {" "}
                  / {overview.usage.allowance}
                </span>
              </p>
              <p className={`mt-1 text-xs ${body}`}>
                Includes invitations and reminders
              </p>
            </div>
            <div className={`${card} p-5`}>
              <p className={`text-xs ${body}`}>Remaining this period</p>
              <p className={`mt-3 text-2xl font-semibold tabular-nums ${ink}`}>
                {overview.usage.remaining}
              </p>
              <p className={`mt-1 text-xs ${body}`}>
                Resets {dateLabel(overview.usage.periodEnd)}
              </p>
            </div>
            <div className={`${card} p-5`}>
              <p className={`text-xs ${body}`}>Email sending</p>
              <p className={`mt-3 font-semibold ${ink}`}>
                {overview.settings.paused
                  ? "Paused by you"
                  : !overview.eligibility.paid
                    ? "Billing needs attention"
                    : !overview.eligibility.sendingEnabled ||
                        !overview.eligibility.enabled
                      ? "Not active yet"
                      : overview.eligibility.ready
                        ? "Ready"
                        : "Setup needed"}
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={togglePause}
                className={`mt-3 ${btnSecondaryCompact} disabled:opacity-50`}
              >
                {overview.settings.paused ? (
                  <Play className="h-3 w-3" />
                ) : (
                  <Pause className="h-3 w-3" />
                )}
                {overview.settings.paused
                  ? "Resume requests"
                  : "Pause requests"}
              </button>
            </div>
          </div>
          {!overview.eligibility.paid ? (
            <p className={`rounded-2xl p-4 text-sm ${statusWarning}`}>
              Review campaigns are paused until billing is current. Your
              customer information stays available.
            </p>
          ) : overview.settings.paused ? (
            <p className={`rounded-2xl p-4 text-sm ${statusWarning}`}>
              Review sending is paused. Resume when you’re ready to continue
              eligible requests.
            </p>
          ) : !overview.eligibility.ready ? (
            <p className={`rounded-2xl p-4 text-sm ${statusWarning}`}>
              Finish your Google review settings below to start sending requests.
            </p>
          ) : !overview.eligibility.sendingEnabled ||
            !overview.eligibility.enabled ? (
            <p className={`rounded-2xl p-4 text-sm ${statusWarning}`}>
              Email sending is not active yet. You can finish setup and prepare
              your review requests.
            </p>
          ) : null}
          <div className="flex gap-2" aria-label="Review sections">
            <button
              type="button"
              aria-pressed={tab === "requests"}
              onClick={() => setTab("requests")}
              className={
                tab === "requests" ? btnPrimaryInline : btnSecondaryInline
              }
            >
              Requests
            </button>
            <button
              type="button"
              aria-pressed={tab === "settings"}
              onClick={() => setTab("settings")}
              className={
                tab === "settings" ? btnPrimaryInline : btnSecondaryInline
              }
            >
              Settings
            </button>
          </div>
          <div hidden={tab !== "settings"} className="space-y-6">
            <ReviewSettingsForm
              overview={overview}
              ownerEmail={ownerEmail}
              smsReady={smsReady}
              onSaved={setOverview}
            />
            {smsEnabled ? (
              <ReviewSmsPanel active={tab === "settings"} onStatusChanged={onSmsStatusChanged} />
            ) : null}
          </div>
          <div
            hidden={tab !== "requests"}
            className="space-y-4"
            aria-busy={loading}
          >
            <ReviewHistory
              campaigns={history?.campaigns || []}
              onChanged={reload}
            />
            {history?.pagination ? (
              <div
                className={`flex items-center justify-between gap-3 text-xs ${body}`}
              >
                <p>
                  Page {history.pagination.page} of{" "}
                  {Math.max(1, history.pagination.totalPages)}
                </p>
                <div className="flex gap-2">
                  <button
                    disabled={loading || page <= 1}
                    onClick={() => setPage((value) => value - 1)}
                    className={`${btnSecondaryCompact} disabled:opacity-40`}
                  >
                    Previous
                  </button>
                  <button
                    disabled={loading || page >= history.pagination.totalPages}
                    onClick={() => setPage((value) => value + 1)}
                    className={`${btnSecondaryCompact} disabled:opacity-40`}
                  >
                    Next
                  </button>
                </div>
              </div>
            ) : null}
          </div>
          {composing && canCompose ? (
            <ReviewComposer
              overview={overview}
              smsReady={smsReady}
              initialCustomerId={initialCustomerId}
              onClose={() => setComposing(false)}
              onCreated={() => {
                setComposing(false);
                setTab("requests");
                setPage(1);
                setNotice(
                  "Review requests scheduled. You can follow their delivery below.",
                );
                reload();
              }}
            />
          ) : null}
        </>
      ) : null}
      <p className={`text-xs ${body}`}>
        Google and the Google logo are trademarks of Google LLC.
      </p>
    </div>
  );
}
