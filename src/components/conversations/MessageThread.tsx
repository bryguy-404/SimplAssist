"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { Send, Bot, User, ArrowLeftRight, Phone, MessageCircle, Info, Lock } from "lucide-react";
import { createBrowserClient } from "@/lib/supabase/client";
import { cn, formatPhoneNumber } from "@/lib/utils";
import {
  statusSuccess,
  statusWarning,
  statusNeutral,
  statusInfo,
} from "@/lib/theme-v2/theme";
import type { Message, SmsBlockReason } from "@/types/database";
import type { ConversationWithContact } from "@/app/(dashboard)/conversations/page";
import {
  getConversationAccessState,
  smsPlanLockedMessage,
} from "./accessState";
import { BookingReviewPanel } from "./BookingReview";
import { VoiceCallReviewPanel } from "./VoiceCallReview";
import { VoiceTranscriptPanel } from "./VoiceTranscript";

interface MessageThreadProps {
  conversation: ConversationWithContact;
  businessId: string;
  smsIncluded?: boolean;
  smsReady: boolean;
  smsBlockReason: SmsBlockReason | null;
  canUseManualSms: boolean;
  canUseAiSms: boolean;
  canUseWebChat: boolean;
  /** Dev-only demo mode (/demo routes): seed messages and disable all
   *  Supabase I/O. Real dashboard callers never pass this. */
  demoMessages?: Message[];
}

function formatTimestamp(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function smsPausedCopy(reason: SmsBlockReason | null): string {
  switch (reason) {
    case "assignment_pending":
      return "Your campaign is approved, and Telnyx is linking your phone number to it. You can reply once assignment finishes.";
    case "assignment_failed":
      return "Your campaign is approved, but phone number assignment needs attention before replies can send.";
    case "missing_phone_number":
      return "Add an active phone number before replying by SMS.";
    case "missing_messaging_profile":
      return "Messaging setup is incomplete. Contact support from the Support page before replying by SMS.";
    case "campaign_not_approved":
    default:
      return "Your campaign is still under carrier review. You can reply once it is approved.";
  }
}

export function MessageThread({
  conversation,
  businessId,
  smsIncluded = true,
  smsReady,
  smsBlockReason,
  canUseManualSms,
  canUseAiSms,
  canUseWebChat,
  demoMessages,
}: MessageThreadProps) {
  const [messages, setMessages] = useState<Message[]>(demoMessages ?? []);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [isAiHandling, setIsAiHandling] = useState(conversation.is_ai_handling);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const supabase = createBrowserClient();
  const smsBlocked = conversation.channel === "sms" && !smsReady;
  const {
    smsPlanLocked,
    webChatLocked,
    effectiveIsAiHandling,
    canToggleAi,
  } = getConversationAccessState({
    channel: conversation.channel,
    storedIsAiHandling: isAiHandling,
    canUseManualSms,
    canUseAiSms,
    canUseWebChat,
  });

  // Fetch messages
  useEffect(() => {
    if (demoMessages) {
      // Demo mode: the setter (not just the useState seed) matters because the
      // component instance persists when another conversation is selected.
      setMessages(demoMessages);
      setIsAiHandling(conversation.is_ai_handling);
      setToggleError(null);
      setSendError(null);
      return;
    }

    let current = true;
    setMessages([]);
    setIsAiHandling(conversation.is_ai_handling);
    setToggleError(null);
    setSendError(null);
    // Voice history uses timestamped speech instead of one bubble per fragment.
    if (conversation.channel === "voice") return;
    async function fetchMessages() {
      const { data } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", conversation.id)
        .order("created_at", { ascending: true });

      if (current && data) setMessages(data as Message[]);
    }

    fetchMessages();
    return () => { current = false; };
  }, [conversation.id, conversation.channel, conversation.is_ai_handling, supabase, demoMessages]);

  // Real-time subscription
  useEffect(() => {
    if (demoMessages || conversation.channel === "voice") return;
    const channel = supabase
      .channel(`messages:${conversation.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversation.id}`,
        },
        (payload) => {
          setMessages((prev) => {
            // Avoid duplicates
            if (prev.some((m) => m.id === (payload.new as Message).id)) return prev;
            return [...prev, payload.new as Message];
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversation.id, conversation.channel, supabase, demoMessages]);

  // Auto-scroll
  useEffect(() => {
    if (conversation.channel === "voice") return;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, conversation.channel]);

  useEffect(() => {
    if (conversation.channel === "voice") messageScrollRef.current?.scrollTo({ top: 0 });
  }, [conversation.id, conversation.channel]);

  async function handleSend() {
    if (
      conversation.channel === "voice" ||
      !input.trim() ||
      sending ||
      effectiveIsAiHandling ||
      smsBlocked ||
      smsPlanLocked ||
      webChatLocked ||
      demoMessages
    ) return;

    setSending(true);
    setSendError(null);
    const content = input.trim();
    setInput("");
    let providerSent = false;

    try {
      if (conversation.channel === "sms" && conversation.contact?.phone_number) {
        const response = await fetch("/api/messaging/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: conversation.contact.phone_number,
            message: content,
            businessId,
          }),
        });
        const responseBody = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            typeof responseBody.message === "string"
              ? responseBody.message
              : "The SMS could not be sent."
          );
        }
        providerSent = true;
      }

      // Only show an agent message as sent after the provider accepted it.
      const { data: newMsg, error: messageError } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversation.id,
          business_id: businessId,
          role: "human_agent",
          content,
          channel: conversation.channel,
        })
        .select("*")
        .single();

      if (messageError || !newMsg) {
        throw messageError ?? new Error("Transcript insert returned no row.");
      }

      setMessages((prev) => {
        if (prev.some((m) => m.id === newMsg.id)) return prev;
        return [...prev, newMsg as Message];
      });

      const { error: conversationError } = await supabase
        .from("conversations")
        .update({ last_message_at: new Date().toISOString() })
        .eq("id", conversation.id);
      if (conversationError) {
        console.error("Error updating conversation timestamp:", conversationError);
      }
    } catch (error) {
      console.error("Error sending message:", error);
      if (!providerSent) {
        setInput(content);
        setSendError(
          error instanceof Error
            ? error.message
            : "The SMS could not be sent. Please try again."
        );
      } else {
        setSendError(
          "The SMS was sent, but the dashboard could not save its transcript. Please do not resend it."
        );
      }
    } finally {
      setSending(false);
    }
  }

  async function toggleAiHandling() {
    if (demoMessages || !canToggleAi) return;
    setToggling(true);
    setToggleError(null);
    const newValue = !isAiHandling;

    try {
      const { data, error } = await supabase
        .from("conversations")
        .update({
          is_ai_handling: newValue,
          status: newValue ? "active" : "handed_off",
        })
        .eq("id", conversation.id)
        .select("is_ai_handling")
        .single();

      if (error || !data) {
        throw error ?? new Error("Conversation update returned no row.");
      }

      setIsAiHandling(data.is_ai_handling);
    } catch (error) {
      console.error("Error toggling AI handling:", error);
      setToggleError(
        "We couldn’t change who is handling this conversation. Please try again."
      );
    } finally {
      setToggling(false);
    }
  }

  const contactName =
    conversation.contact?.name ||
    (conversation.contact?.phone_number
      ? formatPhoneNumber(conversation.contact.phone_number)
      : "Unknown");

  return (
    <div className="flex h-full min-w-0 flex-col bg-white dark:bg-transparent">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#ece4d8] dark:border-white/[0.10] px-4 py-3">
        <div className="flex w-full min-w-0 items-center gap-3 sm:w-auto sm:flex-1">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-stone-100 dark:bg-white/[0.06]">
            {conversation.channel === "sms" || conversation.channel === "voice" ? (
              <Phone className="h-5 w-5 text-stone-500 dark:text-[#bdbdbf]" />
            ) : (
              <MessageCircle className="h-5 w-5 text-stone-500 dark:text-[#bdbdbf]" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-sm font-semibold text-stone-900 dark:text-[#f5f5f5]">{contactName}</h2>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-[#bdbdbf]">
              {conversation.contact?.phone_number && (
                <span className="whitespace-nowrap">{formatPhoneNumber(conversation.contact.phone_number)}</span>
              )}
              {conversation.contact?.email && (
                <span className="min-w-0 break-all">· {conversation.contact.email}</span>
              )}
              <span className="whitespace-nowrap">
                · {conversation.channel === "voice" ? "AI voice call" : conversation.channel === "sms" ? "SMS" : "Web Chat"}
              </span>
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 font-medium",
                  webChatLocked || smsPlanLocked || (conversation.channel === "sms" && !canUseAiSms)
                    ? statusWarning
                    : conversation.status === "active"
                    ? statusSuccess
                    : conversation.status === "handed_off"
                    ? statusWarning
                    : statusNeutral
                )}
              >
                {webChatLocked
                  ? "Locked"
                  : smsPlanLocked
                  ? "Paused"
                  : conversation.channel === "sms" && !canUseAiSms
                  ? "Manual"
                  : conversation.status === "handed_off"
                  ? "Handed Off"
                  : conversation.status.charAt(0).toUpperCase() +
                    conversation.status.slice(1)}
              </span>
            </div>
          </div>
        </div>

        {canToggleAi ? (
          <button
            onClick={toggleAiHandling}
            disabled={toggling}
            className={cn(
              "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              effectiveIsAiHandling
                ? "bg-stone-100 dark:bg-white/[0.08] text-stone-700 dark:text-[#d4d4d8] hover:bg-stone-200 dark:hover:bg-white/[0.12]"
                : "bg-[var(--brand-accent-soft)] dark:bg-[rgb(var(--brand-primary-dark-rgb)/.16)] text-[var(--brand-accent)] dark:text-[var(--brand-text-soft-dark)] hover:bg-[var(--brand-tint-strong)] dark:hover:bg-[rgb(var(--brand-primary-dark-rgb)/.24)]",
              toggling && "opacity-50"
            )}
          >
            <ArrowLeftRight className="h-4 w-4" />
            {effectiveIsAiHandling ? "Take Over" : "Let AI Handle"}
          </button>
        ) : (
          <span className={cn("inline-flex items-center gap-2 rounded-full px-3 py-2 text-xs font-medium", statusWarning)}>
            {webChatLocked || smsPlanLocked ? (
              <Lock className="h-3.5 w-3.5" />
            ) : conversation.channel === "web_chat" ? (
              <Bot className="h-3.5 w-3.5" />
            ) : (
              <User className="h-3.5 w-3.5" />
            )}
            {webChatLocked
              ? "Growth plan"
              : smsPlanLocked
              ? "Plan inactive"
              : conversation.channel === "web_chat"
              ? "AI chat"
              : conversation.channel === "voice" ? "Call transcript" : "Manual replies"}
          </span>
        )}
      </div>

      {toggleError && (
        <div
          role="alert"
          className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs font-medium text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300"
        >
          {toggleError}
        </div>
      )}

      {/* Messages */}
      <div ref={messageScrollRef} className="min-w-0 flex-1 overflow-y-auto px-4 py-4">
        {!demoMessages ? <BookingReviewPanel key={`booking-${conversation.id}`} conversationId={conversation.id} /> : null}
        {conversation.channel === "voice" && !demoMessages ? (
          <div className="space-y-8"><VoiceCallReviewPanel key={conversation.id} conversationId={conversation.id} />
            <VoiceTranscriptPanel key={`transcript-${conversation.id}`} conversationId={conversation.id} />
          </div>
        ) : null}
        {conversation.channel === "voice" && !demoMessages ? null : messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-stone-400 dark:text-[#bdbdbf]">
            No messages in this conversation yet.
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((msg) => {
              const isCustomer = msg.role === "customer";
              const isHumanAgent = msg.role === "human_agent";
              const isSystem = msg.role === "system";

              if (isSystem) {
                return (
                  <div key={msg.id} className="flex justify-center">
                    <div className="max-w-[80%] rounded-full bg-stone-100 dark:bg-white/[0.06] border border-stone-200 dark:border-white/[0.10] px-3 py-1.5 text-center text-xs text-stone-600 dark:text-[#cfcfcf]">
                      <Info className="mr-1 inline-block h-3 w-3 align-[-2px]" />
                      {msg.content}
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={msg.id}
                  className={cn(
                    "flex",
                    isCustomer ? "justify-start" : "justify-end"
                  )}
                >
                  <div className="max-w-[70%]">
                    {/* Role label */}
                    <div
                      className={cn(
                        "mb-1 flex items-center gap-1 text-xs text-stone-400 dark:text-[#bdbdbf]",
                        isCustomer ? "justify-start" : "justify-end"
                      )}
                    >
                      {isCustomer ? (
                        "Customer"
                      ) : isHumanAgent ? (
                        <>
                          <User className="h-3 w-3" /> Agent
                        </>
                      ) : (
                        <>
                          <Bot className="h-3 w-3" /> AI
                        </>
                      )}
                    </div>
                    {/* Bubble */}
                    <div
                      className={cn(
                        "rounded-2xl px-4 py-2 text-sm",
                        isCustomer
                          ? "rounded-bl-md border border-[#ece4d8] dark:border-white/[0.08] bg-[#f3ede3] dark:bg-white/[0.06] text-stone-800 dark:text-[#f0f0f0]"
                          : isHumanAgent
                          ? "rounded-br-md bg-stone-800 text-white dark:bg-white/[0.16] dark:text-[#f5f5f5]"
                          : "rounded-br-md bg-[var(--brand-primary)] text-white dark:bg-[var(--brand-primary-dark)] dark:text-[#16100b]"
                      )}
                    >
                      {msg.content}
                    </div>
                    {/* Timestamp */}
                    <div
                      className={cn(
                        "mt-1 text-xs text-stone-400 dark:text-[#bdbdbf]",
                        isCustomer ? "text-left" : "text-right"
                      )}
                    >
                      {formatTimestamp(msg.created_at)}
                    </div>
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-[#ece4d8] dark:border-white/[0.10] px-4 py-3">
        {sendError && (
          <div
            role="alert"
            className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300"
          >
            {sendError}
          </div>
        )}
        {conversation.channel === "voice" ? (
          <p className="px-4 py-3 text-sm text-stone-500">This voice transcript is read-only. Text sending and live takeover are unavailable.</p>
        ) : webChatLocked ? (
          <div className={cn("flex items-start gap-3 rounded-lg px-4 py-3 text-sm", statusWarning)}>
            <Lock className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">This saved web-chat conversation is read-only.</p>
              <Link href="/billing" className="mt-1 inline-flex text-xs font-semibold underline">
                Manage plan
              </Link>
            </div>
          </div>
        ) : smsPlanLocked ? (
          <div className={cn("flex items-start gap-3 rounded-lg px-4 py-3 text-sm", statusWarning)}>
            <Lock className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">
                {smsPlanLockedMessage(smsIncluded)}
              </p>
              <Link href="/billing" className="mt-1 inline-flex text-xs font-semibold underline">
                Manage billing
              </Link>
            </div>
          </div>
        ) : conversation.channel === "web_chat" ? (
          <div className={cn("flex items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm", statusInfo)}>
            <Bot className="h-4 w-4" />
            Website chat replies are handled automatically by AI.
          </div>
        ) : effectiveIsAiHandling ? (
          <div className={cn("flex items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm", statusInfo)}>
            <Bot className="h-4 w-4" />
            AI is handling this conversation. Click &quot;Take Over&quot; to reply manually.
          </div>
        ) : smsBlocked ? (
          <div className={cn("flex items-start gap-3 rounded-lg px-4 py-3 text-sm", statusWarning)}>
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
            <div>
              <p className="font-medium text-amber-700 dark:text-amber-300">SMS sending paused</p>
              <p className="mt-0.5 text-xs text-amber-600/90 dark:text-amber-300/80">
                {smsPausedCopy(smsBlockReason)}
              </p>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
            className="flex items-center gap-2"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type a message..."
              className="flex-1 rounded-lg bg-white dark:bg-white/[0.06] border border-[#e3dacc] dark:border-white/[0.12] px-4 py-2 text-sm text-stone-900 dark:text-[#f5f5f5] placeholder:text-stone-400 dark:placeholder:text-[#666] focus:border-[var(--brand-primary)] dark:focus:border-[var(--brand-primary-dark)] focus:outline-none focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)]"
              disabled={sending}
            />
            <button
              type="submit"
              disabled={!input.trim() || sending}
              className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--brand-primary)] hover:bg-[var(--brand-primary-hover)] active:bg-[var(--brand-primary-active)] dark:bg-[var(--brand-primary-dark)] dark:text-[#16100b] dark:hover:bg-[var(--brand-primary-hover-dark)] text-white transition-colors disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
