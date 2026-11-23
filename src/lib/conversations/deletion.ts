import type { Conversation } from "@/types/database";

export const MAX_CONVERSATION_DELETE_BATCH = 100;

export function canDeleteConversation(
  conversation: Pick<Conversation, "channel" | "status"> & { has_bookings?: boolean },
  access: { canUseManualSms: boolean; canUseWebChat: boolean },
): boolean {
  if (conversation.has_bookings) return false;
  if (conversation.channel === "voice") return conversation.status === "closed";
  return conversation.channel === "web_chat"
    ? access.canUseWebChat
    : access.canUseManualSms;
}
