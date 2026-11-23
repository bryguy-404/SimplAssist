import type { Conversation, Contact } from "@/types/database";
import type { SpamState } from "@/lib/call-screening/domain";

export const inboxFolders = ["inbox", "no_reply", "spam"] as const;
export type InboxFolder = typeof inboxFolders[number];
export const folderLabels: Record<InboxFolder, string> = { inbox: "Inbox", no_reply: "No reply yet", spam: "Spam" };
export const inboxReasonLabels: Record<string, string> = {
  legacy_text: "Missed-call text · No SMS reply",
  text_sent: "Missed call · Follow-up text sent",
  abandoned: "Caller hung up before connecting",
  silent: "AI answered · No caller response",
  greeting: "Greeting sent · No customer reply",
  needs_review: "Needs review",
  voicemail: "Voicemail received",
};
export type MissedCall = { at: string; conversation_id: string | null; origin: "missed" | "legacy" | "unknown" | "voicemail" | "delivery_issue" };
export type ConversationWithContact = Conversation & {
  contact: Pick<Contact, "id" | "name" | "phone_number" | "email"> & Partial<Pick<Contact, "provided_phone_number" | "source_channel">>;
  last_message_preview?: string;
  has_bookings?: boolean;
  spam_state?: SpamState;
  spam_revision?: number;
  call_kind?: "ai" | "phone" | null;
  inbox_folder?: InboxFolder;
  inbox_reason?: string;
  inbox_item_id?: string;
  inbox_sort_time?: string;
  missed_calls?: MissedCall[];
};

export function conversationFolder(row: ConversationWithContact): InboxFolder {
  if (row.spam_state && row.spam_state !== "inbox") return "spam";
  return row.inbox_folder ?? "inbox";
}

export interface InboxQuery {
  folder: InboxFolder;
  channel: "all" | "sms" | "web_chat" | "voice";
  search: string;
}
export interface InboxPage {
  folder: InboxFolder;
  conversations: ConversationWithContact[];
  selected: ConversationWithContact | null;
  total: number;
  counts: Record<InboxFolder, number>;
  next: string | null;
}
