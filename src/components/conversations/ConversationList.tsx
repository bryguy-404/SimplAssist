"use client";

import { useState, useMemo, useEffect } from "react";
import { Phone, MessageCircle, Search, Bot, User, Trash2, Loader2, Lock } from "lucide-react";
import { cn, formatPhoneNumber } from "@/lib/utils";
import { Modal } from "@/components/ui/Modal";
import { statusInfo, statusWarning, statusNeutral } from "@/lib/theme-v2/theme";
import type { ConversationWithContact } from "@/app/(dashboard)/conversations/page";
import { getConversationAccessState } from "./accessState";
import { canDeleteConversation, MAX_CONVERSATION_DELETE_BATCH } from "@/lib/conversations/deletion";
import type { InboxQuery } from "@/lib/conversations/inbox";
import { spamLabel } from "@/lib/call-screening/domain";
import { phoneMatchesSearch } from "@/lib/phone/display";

interface ConversationListProps {
  conversations: ConversationWithContact[];
  activeId: string | null;
  onSelect: (conversation: ConversationWithContact) => void;
  onDelete: (ids: string[]) => void;
  demoMode?: boolean;
  canUseManualSms: boolean;
  canUseAiSms: boolean;
  canUseWebChat: boolean;
  query?: InboxQuery;
  onQueryChange?: (query: InboxQuery) => void;
  paging?: {
    total: number; counts: { inbox: number; spam: number }; page: number;
    hasNext: boolean; loading: boolean; error: string | null;
    onNext: () => void; onPrevious: () => void; onRefresh: () => void;
  };
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay === 1) return "Yesterday";
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

type FilterTab = "all" | "sms" | "web_chat" | "voice";

export function ConversationList({
  conversations,
  activeId,
  onSelect,
  onDelete,
  demoMode = false,
  canUseManualSms,
  canUseAiSms,
  canUseWebChat,
  query, onQueryChange, paging,
}: ConversationListProps) {
  const [localSearch, setLocalSearch] = useState("");
  const [localFilter, setLocalFilter] = useState<FilterTab>("all");
  const search = query?.search ?? localSearch;
  const filter = query?.channel ?? localFilter;
  const folder = query?.folder ?? "inbox";
  function setSearch(value: string) { if (query && onQueryChange) onQueryChange({ ...query, search: value }); else setLocalSearch(value); }
  function setFilter(value: FilterTab) { if (query && onQueryChange) onQueryChange({ ...query, channel: value }); else setLocalFilter(value); }
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [deleteTargetIds, setDeleteTargetIds] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  useEffect(() => { setSelectedIds(new Set()); setSelecting(false); setDeleteTargetIds([]); setFeedback(null); }, [folder, search, filter, paging?.page]);

  function closeDelete() {
    if (deleting) return;
    setDeleteTargetIds([]);
    setDeleteError(null);
  }

  function confirmDelete(ids: string[]) {
    setDeleteError(null);
    setFeedback(null);
    setDeleteTargetIds(ids);
  }

  function toggleSelected(id: string) {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else if (next.size < MAX_CONVERSATION_DELETE_BATCH) next.add(id);
      return next;
    });
  }

  async function handleConfirmDelete() {
    if (!deleteTargetIds.length || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      let deletedIds = deleteTargetIds;
      if (!demoMode) {
        const res = await fetch("/api/conversations", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: deleteTargetIds }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error || "Unable to delete conversations. Please try again.");
        if (!Array.isArray(data?.deletedIds)) throw new Error("Unable to confirm deletion. Refresh the inbox before trying again.");
        deletedIds = data.deletedIds.filter((id: unknown): id is string =>
          typeof id === "string" && deleteTargetIds.includes(id));
      }
      onDelete(deletedIds);
      const deleted = new Set(deletedIds);
      const remaining = deleteTargetIds.filter((id) => !deleted.has(id));
      setSelectedIds((previous) => new Set(Array.from(previous).filter((id) => !deleted.has(id))));
      if (remaining.length) {
        setDeleteTargetIds(remaining);
        setDeleteError("Some conversations could not be deleted. Refresh the inbox to check their current status.");
        return;
      }
      setFeedback(`${deletedIds.length} conversation${deletedIds.length === 1 ? "" : "s"} deleted.`);
      setDeleteTargetIds([]);
      setSelecting(false);
      setSelectedIds(new Set());
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Unable to delete conversations. Please try again.");
    } finally {
      setDeleting(false);
    }
  }

  const filtered = useMemo(() => {
    if (paging) return conversations;
    let result = conversations.filter(c => folder === "spam" ? c.spam_state && c.spam_state !== "inbox" : !c.spam_state || c.spam_state === "inbox");

    if (filter !== "all") {
      result = result.filter((c) => c.channel === filter);
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone_number ?? "";
        return name.includes(q) || phoneMatchesSearch(phone, q);
      });
    }

    return result;
  }, [conversations, filter, search, folder, paging]);
  const counts = paging?.counts ?? { inbox: conversations.filter(c => !c.spam_state || c.spam_state === "inbox").length, spam: conversations.filter(c => c.spam_state && c.spam_state !== "inbox").length };

  const selectable = filtered.filter((conversation) => canDeleteConversation(conversation, { canUseManualSms, canUseWebChat }));
  const selection = selectable.filter((conversation) => selectedIds.has(conversation.id));
  const selectionLimitReached = selection.length >= MAX_CONVERSATION_DELETE_BATCH;
  const batch = selectable.slice(0, MAX_CONVERSATION_DELETE_BATCH);
  const batchSelected = batch.length > 0 && batch.every((conversation) => selectedIds.has(conversation.id));
  const includesVoice = conversations.some((conversation) => conversation.channel === "voice" && deleteTargetIds.includes(conversation.id));

  const tabs: { label: string; value: FilterTab }[] = [
    { label: "All", value: "all" },
    { label: "SMS", value: "sms" },
    { label: "Chat", value: "web_chat" },
    { label: "Voice", value: "voice" as const },
  ];

  return (
    <div className="flex h-full flex-col border-r border-[#ece4d8] dark:border-white/[0.10] bg-white dark:bg-transparent">
      {query && onQueryChange && <div className="flex gap-1 border-b border-[#ece4d8] p-3 dark:border-white/10" aria-label="Conversation folders">
        {(["inbox", "spam"] as const).map(value => <button type="button" key={value} disabled={deleting} aria-pressed={folder === value} onClick={() => onQueryChange({ folder: value, channel: "all", search: "" })}
          className={cn("flex-1 rounded-lg px-3 py-2 text-sm font-medium", folder === value ? "bg-[var(--brand-accent-soft)] text-[var(--brand-accent)] dark:bg-white/10 dark:text-[var(--brand-accent-dark)]" : "text-stone-500 dark:text-stone-400")}>
          {value === "inbox" ? "Inbox" : "Spam"} <span className="ml-1 text-xs">{counts[value]}</span>
        </button>)}
      </div>}
      {/* Search */}
      <div className="border-b border-[#ece4d8] dark:border-white/[0.10] p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400 dark:text-[#666]" />
          <input
            type="text"
            aria-label="Search conversations"
            placeholder="Search conversations..."
            value={search}
            maxLength={120}
            disabled={deleting}
            onChange={(e) => {
              setSearch(e.target.value);
              setSelectedIds(new Set());
            }}
            className="w-full rounded-lg bg-white dark:bg-white/[0.06] border border-[#e3dacc] dark:border-white/[0.12] py-2 pl-9 pr-3 text-sm text-stone-900 dark:text-[#f5f5f5] placeholder:text-stone-400 dark:placeholder:text-[#666] focus:border-[var(--brand-primary)] dark:focus:border-[var(--brand-primary-dark)] focus:outline-none focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)]"
          />
        </div>
      </div>

      {/* Filter tabs */}
      {folder !== "spam" && <div className="flex border-b border-[#ece4d8] dark:border-white/[0.10]">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            disabled={deleting}
            aria-pressed={filter === tab.value}
            onClick={() => {
              setFilter(tab.value);
              setSelectedIds(new Set());
            }}
            className={cn(
              "flex-1 whitespace-nowrap px-3 py-2 text-sm font-medium transition-colors",
              filter === tab.value
                ? "border-b-2 border-[var(--brand-primary)] text-[var(--brand-accent)] dark:border-[var(--brand-primary-dark)] dark:text-[var(--brand-accent-dark)]"
                : "text-stone-500 dark:text-[#bdbdbf] hover:text-stone-800 dark:hover:text-[#f5f5f5]"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>}
      {folder === "spam" && <p className="border-b border-[#ece4d8] px-4 py-3 text-xs text-stone-500 dark:border-white/10 dark:text-stone-400">Flagged and manually marked calls. Review before deleting. Texts and chats are not automatically screened.</p>}

      <div className="border-b border-[#ece4d8] dark:border-white/[0.10] px-4 py-2">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-stone-500 dark:text-[#bdbdbf]" role="status">
            {selecting ? `${selection.length} selected` : `${paging?.total ?? filtered.length} conversation${(paging?.total ?? filtered.length) === 1 ? "" : "s"}`}
          </span>
          <button
            type="button"
            onClick={() => {
              setSelecting(!selecting);
              setSelectedIds(new Set());
              setFeedback(null);
            }}
            disabled={!selecting && selectable.length === 0}
            className="rounded px-2 py-1.5 font-medium text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)] hover:bg-[#faf6ef] dark:hover:bg-white/[0.04] disabled:opacity-40"
          >
            {selecting ? "Cancel" : "Select"}
          </button>
        </div>
        {selecting && (
          <>
            <div className="mt-1 flex items-center justify-between gap-2">
              <button
                type="button"
                disabled={!batch.length}
                onClick={() => setSelectedIds(batchSelected ? new Set() : new Set(batch.map((conversation) => conversation.id)))}
                className="rounded py-2 text-xs font-medium text-stone-600 dark:text-[#bdbdbf] hover:underline disabled:opacity-40"
              >
                {batchSelected ? "Deselect all" : selectable.length > MAX_CONVERSATION_DELETE_BATCH ? `Select first ${MAX_CONVERSATION_DELETE_BATCH}` : "Select all"}
              </button>
              <button
                type="button"
                disabled={!selection.length}
                onClick={() => confirmDelete(selection.map((conversation) => conversation.id))}
                className="inline-flex items-center gap-1.5 rounded-full bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                Delete{selection.length ? ` (${selection.length})` : ""}
              </button>
            </div>
            <p className="mt-1 text-xs text-stone-500 dark:text-[#bdbdbf]">
              Select up to {MAX_CONVERSATION_DELETE_BATCH} on this page. Changing the page, search, or tab clears your selection.
            </p>
            {selectable.length < filtered.length && (
              <p className="mt-1 text-xs text-stone-500 dark:text-[#bdbdbf]">Conversations with appointments, calls in progress, and read-only threads are protected.</p>
            )}
          </>
        )}
        {feedback && <p role="status" className="mt-1 text-xs text-stone-600 dark:text-[#bdbdbf]">{feedback}</p>}
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto">
        {paging?.loading ? <p role="status" className="p-6 text-center text-sm text-stone-500">Loading conversations…</p> : paging?.error ? <p role="alert" className="p-6 text-sm text-red-600">{paging.error}</p> : filtered.length === 0 ? (
          <div className="p-6 text-center text-sm text-stone-500 dark:text-[#bdbdbf]">
            {folder === "spam" ? "No spam calls in this view." : conversations.length === 0
              ? "No conversations yet. Once customers start texting or chatting, they'll appear here."
              : "No conversations match your search."}
          </div>
        ) : (
          filtered.map((conv) => {
            const {
              webChatLocked,
              smsPlanLocked: smsLocked,
              effectiveIsAiHandling: aiHandling,
            } = getConversationAccessState({
              channel: conv.channel,
              storedIsAiHandling: conv.is_ai_handling,
              canUseManualSms,
              canUseAiSms,
              canUseWebChat,
            });
            const contactName =
              conv.contact?.name ||
              (conv.contact?.phone_number
                ? formatPhoneNumber(conv.contact.phone_number)
                : "Unknown");
            const preview = conv.last_message_preview
              ? conv.last_message_preview.length > 50
                ? conv.last_message_preview.slice(0, 50) + "..."
                : conv.last_message_preview
              : "No messages yet";
            const canDelete = canDeleteConversation(conv, { canUseManualSms, canUseWebChat });
            const checked = selectedIds.has(conv.id);
            const selectionDisabled = !canDelete || (!checked && selectionLimitReached);
            const channelLabel = conv.channel === "web_chat" ? "chat" : conv.channel === "voice" ? "voice call" : "SMS";
            const label = `${contactName}, ${channelLabel}, ${new Date(conv.last_message_at).toLocaleString()}`;

            return (
              <div
                key={conv.id}
                className={cn(
                  "group flex w-full items-start gap-3 border-b border-[#f0e9de] dark:border-white/[0.06] px-4 py-3 text-left transition-colors hover:bg-[#faf6ef] dark:hover:bg-white/[0.04]",
                  (selecting ? checked : activeId === conv.id) && "bg-[var(--brand-accent-soft)] dark:bg-[rgb(var(--brand-primary-dark-rgb)/.08)] hover:bg-[var(--brand-accent-soft)] dark:hover:bg-[rgb(var(--brand-primary-dark-rgb)/.08)]"
                )}
              >
                {selecting && (
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={selectionDisabled}
                    onChange={() => toggleSelected(conv.id)}
                    aria-label={`Select ${label}`}
                    title={!canDelete ? "Conversations with appointments, calls in progress, and read-only threads are protected." : undefined}
                    className="mt-1 h-4 w-4 shrink-0 accent-[var(--brand-primary)] disabled:opacity-40"
                  />
                )}
                <button
                  type="button"
                  aria-label={`${selecting ? "Select" : "Open"} ${label}`}
                  aria-pressed={selecting ? checked : activeId === conv.id}
                  disabled={selecting && selectionDisabled}
                  onClick={() => selecting ? toggleSelected(conv.id) : onSelect(conv)}
                  className="flex min-w-0 flex-1 items-start gap-3 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--brand-primary)] disabled:opacity-50"
                >
                {/* Channel icon */}
                <div className="mt-0.5 flex-shrink-0">
                  {conv.channel === "voice" ? (
                    <Phone aria-label={conv.call_kind === "phone" ? "Phone call" : "AI voice call"} className="h-4 w-4" />
                  ) : conv.channel === "sms" ? (
                    <Phone className="h-5 w-5 text-stone-400 dark:text-[#bdbdbf]" />
                  ) : (
                    <MessageCircle className="h-5 w-5 text-stone-400 dark:text-[#bdbdbf]" />
                  )}
                </div>

                {/* Content */}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-x-2">
                    <span className="truncate text-sm font-medium text-stone-900 dark:text-[#f5f5f5]">
                      {contactName}
                    </span>
                    <span className="flex-shrink-0 text-xs text-stone-500 dark:text-[#bdbdbf]">
                      {timeAgo(conv.last_message_at)}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-sm text-stone-500 dark:text-[#bdbdbf]">
                    {preview}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {/* AI/Human badge */}
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
                        webChatLocked || smsLocked
                          ? statusNeutral
                          : aiHandling
                          ? statusInfo
                          : statusWarning
                      )}
                    >
                      {conv.channel === "voice" ? (
                        <><Phone className="h-3 w-3" /> {conv.call_kind === "phone" ? "Phone call" : "AI voice call"}</>
                      ) : webChatLocked || smsLocked ? (
                        <>
                          <Lock className="h-3 w-3" /> {smsLocked ? "Paused" : "Locked"}
                        </>
                      ) : aiHandling ? (
                        <>
                          <Bot className="h-3 w-3" /> AI
                        </>
                      ) : (
                        <>
                          <User className="h-3 w-3" /> Human
                        </>
                      )}
                    </span>
                    {/* Status badge */}
                    {spamLabel(conv.spam_state) && <span className={cn("rounded-full px-2 py-0.5 text-xs", statusWarning)}>{spamLabel(conv.spam_state)}</span>}
                    {conv.status === "closed" && (
                      <span className={cn("rounded-full px-2 py-0.5 text-xs", statusNeutral)}>
                        Closed
                      </span>
                    )}
                  </div>
                </div>
                </button>

                {/* Delete + Unread indicator */}
                <div className="mt-1 flex flex-col items-center gap-1 flex-shrink-0">
                  {conv.channel !== "voice" && conv.status !== "closed" && !webChatLocked && !smsLocked && !aiHandling && (
                    <div className="h-2.5 w-2.5 rounded-full bg-[var(--brand-primary)] dark:bg-[var(--brand-primary-dark)]" />
                  )}
                  {!selecting && canDelete && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        confirmDelete([conv.id]);
                      }}
                      className="p-1 rounded-lg text-stone-400 dark:text-white/40 hover:text-red-500 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 transition-all"
                      title="Delete conversation"
                      aria-label={`Delete ${label}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {paging && <div className="flex items-center justify-between gap-2 border-t border-[#ece4d8] p-3 text-xs dark:border-white/10">
        <button type="button" disabled={paging.loading || deleting || paging.page <= 1} onClick={paging.onPrevious} className="rounded px-2 py-2 disabled:opacity-40">Previous</button>
        <button type="button" disabled={paging.loading || deleting} onClick={paging.onRefresh} className="rounded px-2 py-2 text-stone-500 disabled:opacity-40">{paging.error ? "Retry" : `Page ${paging.page} · Refresh`}</button>
        <button type="button" disabled={paging.loading || deleting || !paging.hasNext} onClick={paging.onNext} className="rounded px-2 py-2 disabled:opacity-40">Next</button>
      </div>}

      {/* Delete confirmation modal */}
      <Modal
        open={deleteTargetIds.length > 0}
        onClose={closeDelete}
        title={`Delete ${deleteTargetIds.length === 1 ? "conversation" : `${deleteTargetIds.length} conversations`}?`}
        description="This permanently removes the selected conversations from your inbox and deletes their text and chat messages. Contacts and appointments are kept. This cannot be undone."
      >
        {includesVoice && (
          <p className="mb-3 text-sm text-stone-600 dark:text-[#bdbdbf]">
            Selected calls will be removed from your inbox. Call recordings keep their normal expiration schedule, and usage totals stay the same.
          </p>
        )}
        {deleteError && <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">{deleteError}</p>}
        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            onClick={closeDelete}
            disabled={deleting}
            className="flex-1 rounded-full border border-[#e7e0d4] dark:border-white/[0.12] px-4 py-2.5 text-sm font-medium text-stone-700 dark:text-[#bdbdbf] hover:bg-[#faf6ef] dark:hover:bg-white/[0.04] transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirmDelete}
            disabled={deleting}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-full bg-red-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-red-700 transition-colors disabled:opacity-50"
          >
            {deleting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Deleting...
              </>
            ) : (
              deleteTargetIds.length === 1 ? "Delete conversation" : `Delete ${deleteTargetIds.length} conversations`
            )}
          </button>
        </div>
      </Modal>
    </div>
  );
}
