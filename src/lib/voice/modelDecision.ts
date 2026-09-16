import { z } from "zod";
import {
  actionDecision,
  voiceActionPayload,
  type ActionContext,
  type ActionDecision,
} from "./actions";
import { buildModelTranscript } from "./modelTranscript";

const segments = z.array(z.number().int().positive()).min(1).max(100);
// Provider event IDs remain an application concern. The model selects numbered
// speech segments; this adapter expands them using one immutable call snapshot.
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
      intent: z.literal("confirm"),
      actionId: z.string().uuid(),
      confirmationSegments: segments,
    })
    .strict(),
]);

type ModelTranscript = ReturnType<typeof buildModelTranscript>;

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
    actions: context.actions.map((a) => ({
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
    })),
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
    if (
      !action ||
      action.status !== "awaiting_confirmation" ||
      !action.playback_event_id ||
      !action.playback_at ||
      !Number.isSafeInteger(action.playback_caller_end_ms) ||
      transcript.playbackSegment(action.playback_event_id) === undefined
    )
      throw new Error("invalid_transcript_evidence");
    return actionDecision.parse({
      intent: decision.intent,
      actionId: action.id,
      readbackEventIds: [action.playback_event_id],
      confirmationEventIds: transcript.resolveCallerSegments(
        decision.confirmationSegments,
      ),
    });
  }
  return decision;
}
