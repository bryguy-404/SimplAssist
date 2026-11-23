"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { isE164PhoneNumber } from "@/lib/phone/e164";
import { conversationFolder } from "@/lib/conversations/inbox";
import { ArrowLeft, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { ConversationList } from "./ConversationList";
import { MessageThread } from "./MessageThread";
import type { ConversationWithContact } from "@/app/(dashboard)/conversations/page";
import { card } from "@/lib/theme-v2/theme";
import type { Message, SmsBlockReason } from "@/types/database";
import type { InboxPage, InboxQuery } from "@/lib/conversations/inbox";
import { spamLabel } from "@/lib/call-screening/domain";

interface InboxLayoutProps {
  conversations: ConversationWithContact[];
  businessId: string;
  smsIncluded?: boolean;
  smsReady: boolean;
  smsBlockReason: SmsBlockReason | null;
  canUseManualSms?: boolean;
  canUseAiSms?: boolean;
  canUseWebChat?: boolean;
  /** Dev-only demo mode (/demo routes): pre-select a conversation and serve
   *  each thread's messages from fixtures. Real callers never pass these. */
  initialSelectedId?: string;
  demoMessagesById?: Record<string, Message[]>;
  initialPage?: InboxPage;
}

export function InboxLayout({
  conversations: initialConversations,
  businessId,
  smsIncluded = true,
  smsReady,
  smsBlockReason,
  canUseManualSms = true,
  canUseAiSms = true,
  canUseWebChat = true,
  initialSelectedId,
  demoMessagesById,
  initialPage,
}: InboxLayoutProps) {
  const [conversations, setConversations] = useState(initialConversations);
  const [selected, setSelected] = useState<ConversationWithContact | null>(
    initialPage?.selected ?? initialConversations.find((c) => c.id === initialSelectedId) ?? null
  );
  const [page, setPage] = useState(initialPage);
  const [query, setQuery] = useState<InboxQuery>({ folder: initialPage?.folder ?? "inbox", channel: "all", search: "" });
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const firstLoad = useRef(true);
  const listedIds = useRef(new Set(initialConversations.map(c => c.id)));
  const cursor = cursors[cursors.length - 1];
  const serverMode = !!initialPage && demoMessagesById === undefined;

  useEffect(() => {
    if (!serverMode) return;
    const controller = new AbortController();
    let pending = false;
    async function fetchPage(background: boolean) {
      if (pending || controller.signal.aborted) return;
      pending = true;
      if (!background) { setLoading(true); setError(null); }
      try {
        const params = new URLSearchParams({ ...query, ...(cursor ? { cursor } : {}) });
        const res = await fetch(`/api/conversations?${params}`, { signal: controller.signal, cache: "no-store" });
        const data = await res.json();
        if (!res.ok) {
          if (!controller.signal.aborted && (res.status === 401 || res.status === 403)) setSelected(null);
          throw new Error(data.error || "Unable to load conversations.");
        }
        if (controller.signal.aborted) return;
        const rows: ConversationWithContact[] = data.conversations;
        const previousIds = listedIds.current;
        listedIds.current = new Set(rows.map(row => row.id));
        setError(null); setPage(data); setConversations(rows);
        setSelected(current => {
          if (!current) return null;
          const updated = rows.find(row => row.id === current.id);
          if (updated) return updated;
          return query.folder === "no_reply" && previousIds.has(current.id) ? null : current;
        });
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Unable to load conversations.");
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    const initial = firstLoad.current;
    firstLoad.current = false;
    const timer = initial ? undefined : setTimeout(() => void fetchPage(false), 180);
    const refreshVisible = () => { if (document.visibilityState === "visible") void fetchPage(true); };
    const interval = setInterval(refreshVisible, 30000);
    window.addEventListener("focus", refreshVisible);
    return () => {
      clearTimeout(timer); clearInterval(interval); controller.abort();
      window.removeEventListener("focus", refreshVisible);
    };
  }, [serverMode, query, cursor, reload]);

  function changeQuery(next: InboxQuery) {
    if (serverMode && next.folder !== query.folder) {
      const url = new URL(window.location.href);
      url.searchParams.delete("conversation");
      if (next.folder === "inbox") url.searchParams.delete("folder");
      else url.searchParams.set("folder", next.folder);
      window.history.replaceState(window.history.state, "", url);
    }
    setQuery(next); setCursors([null]); setSelected(null); setReviewError(null);
    if (serverMode) setLoading(true);
  }

  async function reviewCall() {
    if (!selected || reviewing) return;
    const decision = selected.spam_state && selected.spam_state !== "inbox" ? "not_spam" : "spam";
    setReviewing(true); setReviewError(null);
    try {
      if (demoMessagesById === undefined) {
        const res = await fetch(`/api/conversations/${selected.id}/spam`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision, revision: selected.spam_revision ?? 0 }) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Unable to save this review.");
      }
      setConversations(prev => prev.map(c => c.id === selected.id ? { ...c, spam_state: decision === "spam" ? "spam" : "inbox", inbox_folder: decision === "spam" ? "spam" : "inbox", spam_revision: (c.spam_revision ?? 0) + 1 } : c));
      setSelected(null); setCursors([null]); setReload(n => n + 1);
      if (serverMode) setLoading(true);
    } catch (e) { setReviewError(e instanceof Error ? e.message : "Unable to save this review."); }
    finally { setReviewing(false); }
  }

  async function keepInInbox() {
    if (!selected || reviewing) return;
    setReviewing(true); setReviewError(null);
    try {
      if (serverMode) {
        const res = await fetch(`/api/conversations/${selected.id}/keep`, { method: "PATCH" });
        if (!res.ok) throw new Error((await res.json()).error || "Unable to move this conversation.");
      }
      setConversations(prev => prev.map(c => c.id === selected.id ? { ...c, inbox_folder: "inbox", inbox_reason: "kept" } : c));
      changeQuery({ folder: "inbox", channel: "all", search: "" });
    } catch (e) { setReviewError(e instanceof Error ? e.message : "Unable to move this conversation."); }
    finally { setReviewing(false); }
  }

  function handleDelete(ids: string[]) {
    const deleted = new Set(ids);
    setConversations((prev) => prev.filter((c) => !deleted.has(c.id)));
    setSelected((prev) => prev && deleted.has(prev.id) ? null : prev);
    if (serverMode) { setCursors([null]); setReload(n => n + 1); setLoading(true); }
  }

  return (
    <div className={`flex h-full overflow-hidden ${card}`}>
      {/* Conversation list - left panel */}
      <div
        className={cn(
          "h-full w-full flex-shrink-0 md:w-[350px] md:block",
          selected ? "hidden" : "block"
        )}
      >
        <ConversationList
          conversations={loading || error ? [] : conversations}
          activeId={selected?.id ?? null}
          onSelect={setSelected}
          onDelete={handleDelete}
          demoMode={demoMessagesById !== undefined}
          canUseManualSms={canUseManualSms}
          canUseAiSms={canUseAiSms}
          canUseWebChat={canUseWebChat}
          query={query} onQueryChange={changeQuery}
          paging={serverMode ? { total: page?.total ?? 0, counts: page?.counts ?? { inbox: 0, no_reply: 0, spam: 0 }, page: cursors.length, hasNext: !!page?.next, loading, error,
            onNext: () => { if (page?.next) { setCursors(prev => [...prev, page.next]); setLoading(true); } },
            onPrevious: () => { setCursors(prev => prev.slice(0, -1)); setLoading(true); },
            onRefresh: () => { setSelected(null); setReviewError(null); setReload(n => n + 1); setLoading(true); },
          } : undefined}
        />
      </div>

      {/* Message thread - right panel */}
      <div
        className={cn(
          "h-full min-w-0 flex-1 md:block",
          selected ? "block" : "hidden"
        )}
      >
        {selected ? (
          <div className="flex h-full min-w-0 flex-col">
            {(conversationFolder(selected) === "no_reply" || !!selected.missed_calls?.length || (selected.inbox_item_id && selected.inbox_item_id !== selected.id)) && (
              <div className="border-b border-[#ece4d8] px-4 py-3 text-sm dark:border-white/10">
                {conversationFolder(selected) === "no_reply" && (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>No reply yet</span>
                    <div className="flex items-center gap-3">
                      {selected.contact?.phone_number && isE164PhoneNumber(selected.contact.phone_number) && (
                        <a className="underline" href={`tel:${selected.contact.phone_number}`}>Call back</a>
                      )}
                      <button type="button" disabled={reviewing} onClick={keepInInbox}
                        className="rounded-full border px-3 py-1.5 font-medium text-[var(--brand-accent)]">
                        {reviewing ? "Saving…" : "Move to Inbox"}
                      </button>
                    </div>
                  </div>
                )}
                {!!selected.missed_calls?.length && (
                  <details className="mt-1">
                    <summary className="cursor-pointer">Missed call history ({selected.missed_calls.length})</summary>
                    <ul className="mt-2 max-h-36 space-y-1 overflow-y-auto">
                      {selected.missed_calls.map((call, index) => (
                        <li key={`${call.at}-${index}`}>
                          {new Date(call.at).toLocaleString()} · {call.origin === "voicemail" ? "Voicemail received" : call.origin === "delivery_issue" ? "Text delivery needs review" : "Follow-up text sent"}
                          {call.conversation_id && <Link className="ml-2 underline" href={`/conversations?conversation=${call.conversation_id}`}>Call details</Link>}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {selected.inbox_item_id && selected.inbox_item_id !== selected.id && (
                  <Link className="underline" href={`/conversations?conversation=${selected.inbox_item_id}`}>Open follow-up text thread</Link>
                )}
                {reviewError && selected.channel !== "voice" && <p role="alert" className="text-red-600">{reviewError}</p>}
              </div>
            )}
            {selected.channel === "voice" && (
              <div className="border-b border-[#ece4d8] px-4 py-3 text-sm dark:border-white/10">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-stone-600 dark:text-stone-300">{spamLabel(selected.spam_state) ?? (selected.inbox_reason === "needs_review" ? "Call needs review" : "Call details")}</span>
                  <button type="button" onClick={reviewCall} disabled={reviewing || selected.status !== "closed"} className="rounded-full border border-[#e3dacc] px-3 py-1.5 font-medium text-[var(--brand-accent)] disabled:opacity-40">
                    {reviewing ? "Saving…" : selected.spam_state && selected.spam_state !== "inbox" ? "Not spam" : "Mark as spam"}
                  </button>
                </div>
                <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{selected.spam_state === "suspected" ? "The carrier flagged this call. Review it before deleting; flags can be mistaken." : selected.spam_state === "spam" ? "You marked this call as spam." : "Review completed calls individually. Other calls and texts from this number stay unchanged."}</p>
                {selected.spam_state && selected.spam_state !== "inbox" && <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">Not spam restores this call only and does not send a follow-up text.</p>}
                {reviewError && <p role="alert" className="mt-2 text-xs text-red-600">{reviewError}</p>}
              </div>
            )}
            {/* Mobile back button */}
            <div className="flex items-center border-b border-[#ece4d8] dark:border-white/[0.10] px-3 py-2 md:hidden">
              <button
                onClick={() => setSelected(null)}
                className="flex items-center gap-1 text-sm text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)]"
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </button>
            </div>
            <div className="min-w-0 flex-1 overflow-hidden">
              <MessageThread
                conversation={selected}
                businessId={businessId}
                smsIncluded={smsIncluded}
                smsReady={smsReady}
                smsBlockReason={smsBlockReason}
                canUseManualSms={canUseManualSms}
                canUseAiSms={canUseAiSms}
                canUseWebChat={canUseWebChat}
                demoMessages={demoMessagesById?.[selected.id]}
              />
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center text-stone-400 dark:text-[#bdbdbf]">
            <MessageSquare className="mb-3 h-12 w-12" />
            <p className="text-sm">Select a conversation to view messages</p>
          </div>
        )}
      </div>
    </div>
  );
}
