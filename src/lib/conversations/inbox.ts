import type { Conversation, Contact } from "@/types/database";
import type { SpamState } from "@/lib/call-screening/domain";

export type ConversationWithContact = Conversation & {
  contact: Pick<Contact, "id" | "name" | "phone_number" | "email"> & Partial<Pick<Contact, "provided_phone_number" | "source_channel">>;
  last_message_preview?: string;
  has_bookings?: boolean;
  spam_state?: SpamState;
  spam_revision?: number;
  call_kind?: "ai" | "phone" | null;
};
export interface InboxQuery {
  folder: "inbox" | "spam";
  channel: "all" | "sms" | "web_chat" | "voice";
  search: string;
}
export interface InboxPage {
  folder: InboxQuery["folder"];
  conversations: ConversationWithContact[];
  selected: ConversationWithContact | null;
  total: number;
  counts: { inbox: number; spam: number };
  next: string | null;
}
