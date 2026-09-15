import type { Conversation } from "@/types/database";

export interface ConversationAccessState {
  webChatLocked: boolean;
  smsPlanLocked: boolean;
  effectiveIsAiHandling: boolean;
  canToggleAi: boolean;
  canWrite: boolean;
}

export function smsPlanLockedMessage(smsIncluded: boolean): string {
  return smsIncluded
    ? "SMS sending is paused because this plan is inactive."
    : "SMS is not included in your current plan.";
}

/**
 * Keep the inbox presentation aligned with the server-side runtime walls.
 * Stored AI state is deliberately ignored when the current plan cannot use it.
 */
export function getConversationAccessState(args: {
  channel: Conversation["channel"];
  storedIsAiHandling: boolean;
  canUseManualSms: boolean;
  canUseAiSms: boolean;
  canUseWebChat: boolean;
}): ConversationAccessState {
  if (args.channel === "voice") {
    return { webChatLocked: false, smsPlanLocked: false, effectiveIsAiHandling: false, canToggleAi: false, canWrite: false };
  }
  const webChatLocked = args.channel === "web_chat" && !args.canUseWebChat;
  const smsPlanLocked = args.channel === "sms" && !args.canUseManualSms;
  // Web chat has no agent-to-visitor transport today, so an entitled widget
  // remains AI-handled in the dashboard regardless of stale stored takeover
  // state. Human takeover is an SMS capability only.
  const effectiveIsAiHandling = args.channel === "web_chat"
    ? !webChatLocked
    : !smsPlanLocked && args.canUseAiSms && args.storedIsAiHandling;
  const canToggleAi =
    args.channel === "sms" &&
    !smsPlanLocked &&
    args.canUseAiSms;

  return {
    webChatLocked,
    smsPlanLocked,
    effectiveIsAiHandling,
    canToggleAi,
    canWrite: !webChatLocked && !smsPlanLocked && !effectiveIsAiHandling,
  };
}
