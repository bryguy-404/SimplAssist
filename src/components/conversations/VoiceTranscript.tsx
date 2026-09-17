"use client";

import { useEffect, useState } from "react";
import { Bot, User } from "lucide-react";
import type { VoiceCallTranscript } from "@/lib/voice/callTranscript";
import { body, ink, statusWarning } from "@/lib/theme-v2/theme";

type TranscriptState = {
  conversationId: string;
  transcript?: VoiceCallTranscript;
  error?: string;
};

export function VoiceTranscriptPanel({ conversationId }: { conversationId: string }) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<TranscriptState | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    setState({ conversationId });
    async function load() {
      try {
        const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/voice/transcript`, {
          signal: controller.signal, cache: "no-store",
        });
        if (!response.ok) throw new Error(response.status === 404
          ? "This call transcript is no longer available."
          : "The transcript could not be loaded. Please try again.");
        const result = await response.json();
        if (result.transcript?.conversationId !== conversationId || !Array.isArray(result.transcript?.turns)) {
          throw new Error("The transcript could not be loaded. Please try again.");
        }
        if (controller.signal.aborted) return;
        setState({ conversationId, transcript: result.transcript });
        if (result.transcript.callInProgress) refreshTimer = setTimeout(() => { void load(); }, 10000);
      } catch (error) {
        if (!controller.signal.aborted) setState({ conversationId,
          error: error instanceof Error && error.message === "This call transcript is no longer available."
            ? error.message : "The transcript could not be loaded. Please try again." });
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(refreshTimer); };
  }, [conversationId, revision]);

  const current = state?.conversationId === conversationId ? state : null;
  return <section aria-label="Call transcript" className="min-w-0 space-y-4">
    <div className="flex items-center justify-between gap-3">
      <h3 className={`text-base font-semibold ${ink}`}>Call transcript</h3>
      <button type="button" aria-label="Refresh call transcript" onClick={() => setRevision((value) => value + 1)}
        className="shrink-0 text-sm font-medium text-[var(--brand-accent)] underline dark:text-[var(--brand-accent-dark)]">Refresh</button>
    </div>
    <p className={`text-xs ${body}`}>Transcripts may contain errors. Use the recording to review interruptions and what was heard.</p>
    {current?.error ? <p role="alert" className={`rounded-lg p-3 text-sm ${statusWarning}`}>{current.error}</p>
      : current?.transcript ? <VoiceTranscriptContent transcript={current.transcript} />
        : <p role="status" className={`text-sm ${body}`}>Loading transcript…</p>}
  </section>;
}

function transcriptTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function transcriptRange(startMs: number, endMs: number): string {
  const start = transcriptTime(startMs);
  const end = transcriptTime(endMs);
  return start === end ? start : `${start}–${end}`;
}

export function VoiceTranscriptContent({ transcript }: { transcript: VoiceCallTranscript }) {
  return <div className="min-w-0 space-y-4">
    {transcript.callInProgress ? <p role="status" className={`text-xs ${body}`}>Call in progress. The transcript updates automatically.</p> : null}
    {transcript.truncated ? <p role="status" className={`rounded-lg p-3 text-sm ${statusWarning}`}>Only part of this transcript is available here. Use the recording to review the full call.</p> : null}
    {transcript.turns.length ? <ol aria-label="Transcript speaking turns" className="space-y-4">
      {transcript.turns.map((turn) => {
        const caller = turn.role === "customer";
        return <li key={turn.id} className={`flex min-w-0 ${caller ? "justify-start" : "justify-end"}`}>
          <div className="min-w-0 max-w-[90%] sm:max-w-[75%]">
            <div className={`mb-1 flex items-center gap-1 text-xs ${body} ${caller ? "justify-start" : "justify-end"}`}>
              {caller ? <User className="h-3 w-3" aria-hidden="true" /> : <Bot className="h-3 w-3" aria-hidden="true" />}
              <span>{caller ? "Caller" : "AI"}</span>
            </div>
            <p className={`whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm [overflow-wrap:anywhere] ${caller
              ? "rounded-bl-md border border-[#ece4d8] bg-[#f3ede3] text-stone-800 dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-[#f0f0f0]"
              : "rounded-br-md bg-[var(--brand-primary)] text-white dark:bg-[var(--brand-primary-dark)] dark:text-[#16100b]"}`}>{turn.text}</p>
            <div className={`mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs ${body} ${caller ? "justify-start" : "justify-end"}`}>
              <span aria-label="Transcript time">{transcriptRange(turn.startMs, turn.endMs)}</span>
              {turn.overlapsPrevious ? <span>Overlapping speech</span> : null}
            </div>
          </div>
        </li>;
      })}
    </ol> : <p className={`py-4 text-sm ${body}`}>{transcript.callInProgress
      ? "No speech has been transcribed yet."
      : "No transcript is available for this call."}</p>}
  </div>;
}
