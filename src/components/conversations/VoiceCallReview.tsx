"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { body, ink, statusNeutral, statusSuccess, statusWarning } from "@/lib/theme-v2/theme";
import { formatPhoneNumber } from "@/lib/utils";
import type { ReviewStatus, VoiceCallReview } from "@/lib/voice/callReview";

type LoadState = { conversationId: string; call?: VoiceCallReview; error?: string };

export function VoiceCallReviewPanel({ conversationId }: { conversationId: string }) {
  const [state, setState] = useState<LoadState>({ conversationId });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ conversationId });
    async function load() {
      try {
        const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/voice`, {
          signal: controller.signal, cache: "no-store",
        });
        if (!response.ok) throw new Error(response.status === 404 ? "This call is no longer available." : "Call review could not be loaded. Please try again.");
        const result = await response.json();
        if (!result.call || result.call.conversationId !== conversationId) throw new Error("Call review could not be loaded. Please try again.");
        if (!controller.signal.aborted) setState({ conversationId, call: result.call });
      } catch (error) {
        if (!controller.signal.aborted) setState({ conversationId, error: error instanceof Error ? error.message : "Call review could not be loaded. Please try again." });
      }
    }
    void load();
    return () => controller.abort();
  }, [conversationId, revision]);
  const current = state.conversationId === conversationId ? state : null;
  return (
    <section aria-label="Voice call review" className="min-w-0 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className={`text-base font-semibold ${ink}`}>Call review</h3>
        <button type="button" onClick={() => setRevision((value) => value + 1)} className="shrink-0 text-sm font-medium text-[var(--brand-accent)] underline dark:text-[var(--brand-accent-dark)]">Refresh</button>
      </div>
      {current?.error ? <p role="alert" className={`rounded-lg p-3 text-sm ${statusWarning}`}>{current.error}</p>
        : current?.call ? <VoiceCallReviewContent call={current.call} />
          : <p role="status" className={`text-sm ${body}`}>Loading call review…</p>}
    </section>
  );
}

function Status({ status }: { status: ReviewStatus }) {
  const style = status.tone === "success" ? statusSuccess : status.tone === "warning" ? statusWarning : statusNeutral;
  return <><p className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${style}`}>{status.label}</p><p className={`mt-2 text-xs ${body}`}>{status.detail}</p></>;
}

function timestamp(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "Time unavailable";
}

function offset(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function Recording({ recording }: { recording: VoiceCallReview["recordings"][number] }) {
  const [failed, setFailed] = useState(false);
  if (recording.state === "expired") return <p className={`text-sm ${body}`}>Audio expired under the 30-day retention policy.</p>;
  if (recording.state !== "available" || !recording.url) return <p className={`text-sm ${body}`}>Recording unavailable.</p>;
  return <div className="space-y-2">
    <audio controls preload="none" className="w-full min-w-0 max-w-full" src={recording.url} onError={() => setFailed(true)} aria-label="Call recording" />
    {failed ? <p role="alert" className={`text-sm ${body}`}>The recording could not be played. It may have expired or be temporarily unavailable. Refresh to check again.</p> : null}
    <p className={`text-xs ${body}`}>Audio expires {timestamp(recording.expiresAt)}.</p>
  </div>;
}

export function VoiceCallReviewContent({ call }: { call: VoiceCallReview }) {
  const confirmed = call.confirmedContact;
  const contact = call.contact;
  return <div className="min-w-0 space-y-6 [overflow-wrap:anywhere]">
    <section className="rounded-xl border border-[#ece4d8] p-4 dark:border-white/10" aria-label="Call summary">
      <Status status={call.call} />
      <p className={`mt-3 flex flex-wrap gap-x-1 gap-y-1 text-sm ${body}`}><span>Received <time dateTime={call.receivedAt}>{timestamp(call.receivedAt)}</time></span>{call.durationSeconds !== null ? <span>· {offset(call.durationSeconds)} conversation</span> : null}</p>
    </section>
    <section aria-labelledby="call-contact-heading" className="space-y-2">
      <h4 id="call-contact-heading" className={`text-sm font-semibold ${ink}`}>Caller details</h4>
      {confirmed ? <div className={`space-y-1 break-words text-sm ${body}`}>
        <p className={`font-medium ${ink}`}>Confirmed during this call</p>
        <p>{confirmed.name}</p><p>{formatPhoneNumber(confirmed.phone)}</p><p>{confirmed.email || "No email confirmed during this call."}</p>
        {confirmed.conflicts.length ? <div className={`mt-3 rounded-lg p-3 ${statusWarning}`}>
          <p className="font-medium">Stored contact differs</p>
          <p className="mt-1 text-xs">Existing contact details were kept. Review the confirmed call details before changing the contact.</p>
          <p className="mt-2">Stored name: {contact?.name || "Not set"}</p><p>Stored email: {contact?.email || "Not set"}</p>
        </div> : null}
      </div> : <div className={`space-y-1 break-words text-sm ${body}`}>
        <p>No confirmed contact details were saved during this call.</p>
        {contact ? <><p className="pt-1 font-medium">Stored contact</p><p>{contact.name || "Name not set"}</p><p>{contact.phone ? formatPhoneNumber(contact.phone) : "Phone not set"}</p><p>{contact.email || "Email not set"}</p></> : null}
      </div>}
      {contact ? <Link href={`/contacts?contact=${encodeURIComponent(contact.id)}`} className="inline-flex text-sm font-medium text-[var(--brand-accent)] underline dark:text-[var(--brand-accent-dark)]">View contact</Link> : null}
    </section>
    <section aria-labelledby="call-actions-heading" className="space-y-3">
      <h4 id="call-actions-heading" className={`text-sm font-semibold ${ink}`}>Call outcomes</h4>
      {call.actions.length ? call.actions.map((action) => <article key={action.id} className="rounded-xl border border-[#ece4d8] p-4 dark:border-white/10">
        <h5 className={`mb-2 text-sm font-medium ${ink}`}>{action.title}</h5><Status status={action} />
        {action.confirmedAt ? <p className={`mt-2 text-xs ${body}`}>Caller confirmed {timestamp(action.confirmedAt)}.</p> : null}
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm font-medium text-[var(--brand-accent)] underline dark:text-[var(--brand-accent-dark)]">
          {action.smsConversationId ? <Link href={`/conversations?conversation=${encodeURIComponent(action.smsConversationId)}`}>View text conversation</Link> : null}
          {action.leadId ? <Link href={`/leads?lead=${encodeURIComponent(action.leadId)}#lead-${encodeURIComponent(action.leadId)}`}>View lead</Link> : null}
        </div>
      </article>) : <p className={`text-sm ${body}`}>No actions recorded for this call.</p>}
    </section>
    <section aria-labelledby="call-recording-heading" className="space-y-3">
      <h4 id="call-recording-heading" className={`text-sm font-semibold ${ink}`}>Recording</h4>
      {call.recordings.length ? call.recordings.map((recording) => <Recording key={recording.id} recording={recording} />) : <p className={`text-sm ${body}`}>Recording not yet available. Refresh to check again.</p>}
    </section>
  </div>;
}
