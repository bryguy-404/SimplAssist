import { z } from "zod";
import {
  actionDecision,
  voiceActionPayload,
  type ActionContext,
  type ActionDecision,
} from "./actions";
import { buildModelTranscript } from "./modelTranscript";
import { VoiceEvidenceError } from "./evidenceError";

const segments = z.array(z.number().int().positive()).min(1).max(100);
// The model selects proposal evidence, but confirmation always covers the whole
// current reply. Provider IDs and confirmation bookkeeping stay in the app.
export const modelVoiceDecision = z.discriminatedUnion("intent", [
  z
    .object({ intent: z.literal("answer"), text: z.string().min(1).max(2000) })
    .strict(),
  z
    .object({
      intent: z.literal("availability"),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .strict(),
  z
    .object({
      intent: z.literal("propose"),
      payload: voiceActionPayload,
      requestSegments: segments,
    })
    .strict(),
  z
    .object({
      intent: z.literal("readback"),
      actionId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      intent: z.literal("confirm"),
      actionId: z.string().uuid(),
    })
    .strict(),
]);

type ModelTranscript = ReturnType<typeof buildModelTranscript>;

function confirmationEvidence(
  action: ActionContext["actions"][number],
  transcript: ModelTranscript,
) {
  if (action.status !== "awaiting_confirmation")
    throw new VoiceEvidenceError("action_not_pending");
  if (!action.playback_event_id || !action.playback_at)
    throw new VoiceEvidenceError("playback_not_acknowledged");
  if (
    action.playback_caller_end_ms === null ||
    !Number.isSafeInteger(action.playback_caller_end_ms) ||
    action.playback_caller_end_ms < 0
  )
    throw new VoiceEvidenceError("invalid_playback_cutoff");
  if (transcript.playbackSegment(action.playback_event_id) === undefined)
    throw new VoiceEvidenceError("playback_not_visible");
  return transcript.currentCallerResponse(action.playback_caller_end_ms);
}

export function modelActionContext(
  context: ActionContext,
  transcript: ModelTranscript,
) {
  return {
    capabilities: context.capabilities,
    goal: context.goal,
    bookingMode: context.bookingMode,
    timezone: context.timezone,
    callerPhone: context.callerPhone,
    actions: context.actions.map((a) => {
      let confirmationReplySegments: number[] | null = null;
      let confirmationUnavailableReason: string | null = null;
      if (a.status === "awaiting_confirmation") {
        try {
          confirmationReplySegments = confirmationEvidence(
            a,
            transcript,
          ).segments;
        } catch (error) {
          if (!(error instanceof VoiceEvidenceError)) throw error;
          confirmationUnavailableReason = error.reason;
        }
      }
      return {
        id: a.id,
        kind: a.kind,
        payload: a.payload,
        readback: a.readback,
        status: a.status,
        result: a.result?.summary ?? null,
        // A marker locates playback; full spoken content still needs verification.
        playbackSegment: a.playback_event_id
          ? (transcript.playbackSegment(a.playback_event_id) ?? null)
          : null,
        playbackCallerEndMs: a.playback_caller_end_ms,
        confirmationReplySegments,
        confirmationUnavailableReason,
      };
    }),
  };
}

export function resolveModelDecision(
  input: unknown,
  context: ActionContext,
  transcript: ModelTranscript,
): ActionDecision {
  const decision = modelVoiceDecision.parse(input);
  if (decision.intent === "propose") {
    return actionDecision.parse({
      intent: decision.intent,
      payload: decision.payload,
      requestEventIds: transcript.resolveCallerSegments(
        decision.requestSegments,
      ),
    });
  }
  if (decision.intent === "confirm") {
    const action = context.actions.find((a) => a.id === decision.actionId);
    if (!action) throw new VoiceEvidenceError("action_missing");
    const evidence = confirmationEvidence(action, transcript);
    return actionDecision.parse({
      intent: decision.intent,
      actionId: action.id,
      readbackEventIds: [action.playback_event_id],
      confirmationEventIds: evidence.eventIds,
    });
  }
  if (decision.intent === "readback") {
    const action = context.actions.find((a) => a.id === decision.actionId);
    if (!action) throw new VoiceEvidenceError("action_missing");
    if (action.status !== "awaiting_confirmation")
      throw new VoiceEvidenceError("action_not_pending");
  }
  return decision;
}
