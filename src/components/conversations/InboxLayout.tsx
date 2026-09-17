"use client";

import { useState } from "react";
import { ArrowLeft, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { ConversationList } from "./ConversationList";
import { MessageThread } from "./MessageThread";
import type { ConversationWithContact } from "@/app/(dashboard)/conversations/page";
import { card } from "@/lib/theme-v2/theme";
import type { Message, SmsBlockReason } from "@/types/database";

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
}: InboxLayoutProps) {
  const [conversations, setConversations] = useState(initialConversations);
  const [selected, setSelected] = useState<ConversationWithContact | null>(
    initialConversations.find((c) => c.id === initialSelectedId) ?? null
  );

  function handleDelete(id: string) {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (selected?.id === id) {
      setSelected(null);
    }
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
          conversations={conversations}
          activeId={selected?.id ?? null}
          onSelect={setSelected}
          onDelete={handleDelete}
          canUseManualSms={canUseManualSms}
          canUseAiSms={canUseAiSms}
          canUseWebChat={canUseWebChat}
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
