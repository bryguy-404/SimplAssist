import "server-only";

import {
  resolveBusinessOperationalControls,
  resolveOperationalBlockReason,
} from "@/lib/account/operationalControls.server";
import type {
  BusinessOperationalControls,
  OperationalBlockReason,
  OperationalService,
} from "@/types/database";

export type OutboundSmsPurpose =
  | "manual_dashboard_send"
  | "ai_reply"
  | "mms_fallback"
  | "missed_call"
  | "voice_followup";

export type OutboundSmsOperationalBlockReason = Extract<
  OperationalBlockReason,
  "account_suspended" | "texting_paused" | "ai_replies_paused"
>;

export type OutboundSmsOperationalAccess =
  | { allowed: true }
  | { allowed: false; reason: OutboundSmsOperationalBlockReason };

const PURPOSE_SERVICES: Record<
  OutboundSmsPurpose,
  readonly OperationalService[]
> = {
  manual_dashboard_send: ["texting"],
  missed_call: ["texting"],
  voice_followup: ["texting", "ai_replies"],
  ai_reply: ["texting", "ai_replies"],
  mms_fallback: ["texting", "ai_replies"],
};

const BLOCK_MESSAGES: Record<OutboundSmsOperationalBlockReason, string> = {
  account_suspended:
    "Account operations are suspended. SMS sending will remain unavailable until the account is reactivated.",
  texting_paused:
    "Texting is paused for this account. Resume texting before sending SMS.",
  ai_replies_paused:
    "AI replies are paused for this account. Resume AI replies before sending an automated response.",
};

/**
 * Resolves the current business row without caching and applies the precedence
 * for the concrete outbound purpose. Resolution errors intentionally bubble so
 * execution boundaries can fail closed using their retry convention.
 */
export async function resolveOutboundSmsOperationalAccess(
  businessId: string,
  purpose: OutboundSmsPurpose,
): Promise<OutboundSmsOperationalAccess> {
  const controls = await resolveBusinessOperationalControls(businessId);
  return decideOutboundSmsOperationalAccess(controls, purpose);
}

export function decideOutboundSmsOperationalAccess(
  controls: BusinessOperationalControls,
  purpose: OutboundSmsPurpose,
): OutboundSmsOperationalAccess {
  const reason = resolveOperationalBlockReason(
    controls,
    PURPOSE_SERVICES[purpose],
  );
  if (reason === null) return { allowed: true };
  if (reason === "bookings_paused") {
    // No SMS purpose requests booking enforcement. Keep this explicit so a
    // future purpose-map change cannot silently turn an unexpected reason
    // into an allow decision.
    throw new Error(
      `[messaging:operational] Unexpected booking block for ${purpose}`,
    );
  }
  return { allowed: false, reason };
}

export function outboundSmsOperationalBlockMessage(
  reason: OutboundSmsOperationalBlockReason,
): string {
  return BLOCK_MESSAGES[reason];
}

export function isOutboundSmsOperationalBlockReason(
  value: string,
): value is OutboundSmsOperationalBlockReason {
  return Object.prototype.hasOwnProperty.call(BLOCK_MESSAGES, value);
}
