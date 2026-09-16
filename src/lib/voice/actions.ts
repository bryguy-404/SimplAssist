import { createHash } from "node:crypto";
import { z } from "zod";

const text = z.string().trim().min(1).max(200);
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
const identity = { name: text, phone, email: z.string().trim().email().max(254).optional() };
export const voiceActionPayload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("contact"), ...identity }).strict(),
  z.object({ kind: z.literal("booking"), ...identity, service: text,
    startTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/) }).strict(),
  z.object({ kind: z.literal("booking_request"), ...identity, service: text, requestedTime: text }).strict(),
  // Destination and URL are server-derived. They cannot be supplied by a model.
  z.object({ kind: z.literal("signup") }).strict(),
]);
export type VoiceActionPayload = z.infer<typeof voiceActionPayload>;
export type VoiceActionKind = VoiceActionPayload["kind"];
export interface VoiceAction {
  id: string; session_id: string; business_id: string; kind: VoiceActionKind;
  revision: number; fingerprint: string; payload: VoiceActionPayload;
  readback: string; created_at: string; playback_at: string | null;
  playback_event_id: string | null; source_message_id: string | null;
  status: "awaiting_confirmation" | "executing" | "succeeded" | "failed" | "superseded" | "uncertain";
  result: { summary: string; [key: string]: unknown } | null;
}
export interface VoiceAnswer {
  text: string;
  confirmationActionId?: string;
}
export interface ActionContext {
  sessionId: string; actionBusinessId: string; demo: boolean;
  capabilities: { contacts: boolean; booking: boolean; signup: boolean };
  goal: string; bookingMode: string; timezone: string; callerPhone: string;
  actions: VoiceAction[];
}
export const actionDecision = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("answer"), text: z.string().min(1).max(2000) }).strict(),
  z.object({ intent: z.literal("availability"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
  z.object({ intent: z.literal("propose"), payload: voiceActionPayload,
    requestEventIds: z.array(z.string().min(1)).min(1).max(100) }).strict(),
  z.object({ intent: z.literal("confirm"), actionId: z.string().uuid(),
    readbackEventIds: z.array(z.string().min(1)).min(1).max(100),
    confirmationEventIds: z.array(z.string().min(1)).min(1).max(100) }).strict(),
]);
export type ActionDecision = z.infer<typeof actionDecision>;
export function actionFingerprint(payload: VoiceActionPayload, signupUrl?: string): string {
  const normalized = voiceActionPayload.parse(payload);
  if ("email" in normalized && normalized.email) normalized.email = normalized.email.toLowerCase();
  return createHash("sha256").update(JSON.stringify({ ...normalized, ...(signupUrl ? { signupUrl } : {}) })).digest("hex");
}
export function buildActionReadback(payload: VoiceActionPayload, callerPhone: string, timezone: string): string {
  if (payload.kind === "signup") return `May I text the signup link to the number you're calling from, ending in ${callerPhone.slice(-4)}?`;
  const details = `${payload.name}, phone ${payload.phone}${payload.email ? `, email ${payload.email}` : ", without an email invitation"}`;
  if (payload.kind === "contact") return `May I save these contact details: ${details}?`;
  if (payload.kind === "booking_request") return `May I save a request for ${payload.service}, ${payload.requestedTime}, for ${details}? This is for owner review, not a confirmed appointment.`;
  return `May I book ${payload.service} on ${payload.startTime.replace("T", " at ")} (${timezone}) for ${details}?`;
}
export function safeConfirmation(text: string): boolean {
  // Only a clear, standalone assent can authorize a pending action. Changes,
  // questions, conditional answers and quoted instructions require a new readback.
  return /^(yes|yeah|yep|correct|that's correct|that is correct|that's right|that is right|sounds good|go ahead|please do|okay|ok|yes please|yes that's correct|yes that is correct|yes go ahead)[.! ,]*$/i.test(text.trim());
}
