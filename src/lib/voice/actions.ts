import { createHash } from "node:crypto";
import { z } from "zod";

const text = z.string().trim().min(1).max(200);
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
const bookingDetails = { serviceId: z.string().uuid().optional(), customerAddress: z.string().trim().min(1).max(500).optional(), emailAsked: z.boolean().optional(), newAppointment: z.boolean().optional() };
const identity = { name: text, phone, email: z.string().trim().email().max(254).optional() };
export const voiceActionPayload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("contact"), ...identity }).strict(),
  z.object({ kind: z.literal("booking"), ...identity, ...bookingDetails, service: text,
    startTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/) }).strict(),
  z.object({ kind: z.literal("booking_request"), ...identity, name: text.optional(), ...bookingDetails, service: text, requestedTime: text }).strict(),
  z.object({ kind: z.literal("booking_review_text"), draftId: z.string().uuid(), revision: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("booking_confirmation_text"), draftId: z.string().uuid(), revision: z.number().int().positive() }).strict(),
  // Destination and URL are server-derived. They cannot be supplied by a model.
  z.object({ kind: z.literal("signup") }).strict(),
]);
export type VoiceActionPayload = z.infer<typeof voiceActionPayload>;
export type VoiceActionKind = VoiceActionPayload["kind"];
export interface VoiceAction {
  id: string; session_id: string; business_id: string; kind: VoiceActionKind;
  revision: number; fingerprint: string; payload: VoiceActionPayload;
  readback: string; created_at: string; playback_at: string | null;
  playback_caller_end_ms: number | null;
  playback_event_id: string | null; source_message_id: string | null;
  status: "awaiting_confirmation" | "executing" | "succeeded" | "failed" | "superseded" | "uncertain";
  sms_logged_at?: string | null;
  sms_provider_message_id?: string | null;
  sms_accepted_at?: string | null;
  goal_event_recorded_at?: string | null;
  bookkeeping_attempted_at?: string | null;
  result: { summary: string; [key: string]: unknown } | null;
}
export interface VoiceAnswer {
  text: string;
  confirmationActionId?: string;
}
export interface ActionContext {
  bookingContext?: unknown;
  sessionId: string; actionBusinessId: string; demo: boolean;
  capabilities: { contacts: boolean; booking: boolean; signup: boolean };
  goal: string; bookingMode: string; timezone: string; callerPhone: string;
  actions: VoiceAction[];
}
export const actionDecision = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("answer"), text: z.string().min(1).max(2000) }).strict(),
  z.object({ intent: z.literal("availability"), serviceId: z.string().uuid().optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
  z.object({ intent: z.literal("propose"), payload: voiceActionPayload,
    requestEventIds: z.array(z.string().min(1)).min(1).max(100) }).strict(),
  z.object({ intent: z.literal("readback"), actionId: z.string().uuid() }).strict(),
  z.object({ intent: z.literal("confirm"), actionId: z.string().uuid(),
    readbackEventIds: z.array(z.string().min(1)).min(1).max(100),
    confirmationEventIds: z.array(z.string().min(1)).min(1).max(100) }).strict(),
]);
export type ActionDecision = z.infer<typeof actionDecision>;
export function actionFingerprint(payload: VoiceActionPayload, signupUrl?: string, confirmedContext?: string): string {
  const normalized = voiceActionPayload.parse(payload);
  if ("email" in normalized && normalized.email) normalized.email = normalized.email.toLowerCase();
  return createHash("sha256").update(JSON.stringify({ ...normalized, ...(signupUrl ? { signupUrl } : {}), ...(confirmedContext ? { confirmedContext } : {}) })).digest("hex");
}
export function buildActionReadback(payload: VoiceActionPayload, callerPhone: string, timezone: string): string {
  if (payload.kind === "signup") return `May I text the signup link to the number you're calling from, ending in ${callerPhone.slice(-4)}?`;
  if (payload.kind === 'booking_review_text' || payload.kind === 'booking_confirmation_text') return `May I text ${payload.kind === 'booking_review_text' ? 'these details for you to review while we talk' : 'the confirmed appointment or request details'} to the number you are calling from, ending in ${callerPhone.slice(-4)}?`;
  const details = `${payload.name || "name not provided"}, phone ${payload.phone}${payload.email ? `, email ${payload.email}` : ", without an email invitation"}`;
  if (payload.kind === "contact") return `May I save these contact details: ${details}?`;
  if (payload.kind === "booking_request") return `May I save a request for ${payload.service}, ${payload.requestedTime}, for ${details}? This is for owner review, not a confirmed appointment.`;
  return `May I book ${payload.service} on ${payload.startTime.replace("T", " at ")} (${timezone}) for ${details}?`;
}
