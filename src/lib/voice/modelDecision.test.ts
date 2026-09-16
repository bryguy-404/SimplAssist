import { describe, expect, it } from "vitest";
import type { ActionContext, VoiceAction } from "./actions";
import { modelActionContext, resolveModelDecision } from "./modelDecision";
import { buildModelTranscript } from "./modelTranscript";
import type { TranscriptFragment } from "./types";

const id = "00000000-0000-4000-8000-000000000001";
const context: ActionContext = {
  sessionId: "call",
  actionBusinessId: "business",
  demo: false,
  capabilities: { contacts: true, signup: true, booking: false },
  goal: "signup",
  bookingMode: "collect_info",
  timezone: "America/Indiana/Indianapolis",
  callerPhone: "+15555550101",
  actions: [],
};
const payload = {
  kind: "contact" as const,
  name: "Test Caller",
  phone: context.callerPhone,
  email: "test@example.test",
};
const action = {
  id,
  status: "awaiting_confirmation",
  kind: "contact",
  payload,
  readback:
    "May I save Test Caller, phone +15555550101, email test@example.test?",
  playback_event_id: "provider_assistant_readback",
  playback_caller_end_ms: 1000,
  playback_at: "2026-09-16T00:00:00Z",
  fingerprint: "private-fingerprint",
  result: null,
} as VoiceAction;
function fragment(
  eventId: string,
  role: TranscriptFragment["role"],
  text: string,
  startMs: number,
  endMs = startMs + 100,
): TranscriptFragment {
  return { eventId, role, text, startMs, endMs };
}

describe("compact model decision evidence adapter", () => {
  it("expands a small proposal into exact caller evidence without giving provider IDs to the model", () => {
    const fragments = Array.from({ length: 60 }, (_, i) =>
      fragment(
        `provider_long_unique_identifier_${i}`,
        "customer",
        i === 0 ? "Test" : " detail",
        i * 100,
      ),
    );
    const transcript = buildModelTranscript(fragments, context);
    const decision = resolveModelDecision(
      { intent: "propose", payload, requestSegments: [1, 2, 3] },
      context,
      transcript,
    );
    expect(decision).toEqual({
      intent: "propose",
      payload,
      requestEventIds: fragments.map((f) => f.eventId),
    });
    expect(transcript.text).not.toContain("provider_long_unique_identifier");
  });
  it("derives only the selected pending action's current playback anchor and preserves all assent fragments", () => {
    const ctx = { ...context, actions: [action] };
    const fragments = [
      fragment("older_request", "customer", "Test Caller", 0),
      fragment(
        action.playback_event_id!,
        "assistant",
        action.readback,
        1000,
        2000,
      ),
      fragment("yes", "customer", "Uh, yes", 2100),
      fragment("rest", "customer", ", please.", 2200),
    ];
    const transcript = buildModelTranscript(fragments, ctx);
    expect(
      resolveModelDecision(
        { intent: "confirm", actionId: id, confirmationSegments: [3] },
        ctx,
        transcript,
      ),
    ).toEqual({
      intent: "confirm",
      actionId: id,
      readbackEventIds: [action.playback_event_id],
      confirmationEventIds: ["yes", "rest"],
    });
    const visible = JSON.stringify(modelActionContext(ctx, transcript));
    expect(visible).toContain('"playbackSegment":2');
    expect(visible).not.toContain(action.playback_event_id);
    expect(visible).not.toContain("private-fingerprint");
  });
  it.each(["succeeded", "executing", "superseded", "uncertain"] as const)(
    "rejects confirmation of %s actions",
    (status) => {
      const ctx = { ...context, actions: [{ ...action, status }] };
      const transcript = buildModelTranscript(
        [
          fragment(
            action.playback_event_id!,
            "assistant",
            action.readback,
            1000,
          ),
          fragment("yes", "customer", "Yes", 2100),
        ],
        ctx,
      );
      expect(() =>
        resolveModelDecision(
          { intent: "confirm", actionId: id, confirmationSegments: [2] },
          ctx,
          transcript,
        ),
      ).toThrow("invalid_transcript_evidence");
    },
  );
  it("rejects a valid-looking foreign action ID and a missing readback anchor", () => {
    const ctx = { ...context, actions: [action] };
    const transcript = buildModelTranscript(
      [fragment("yes", "customer", "Yes", 2100)],
      ctx,
    );
    for (const actionId of [id, "00000000-0000-4000-8000-000000000002"]) {
      expect(() =>
        resolveModelDecision(
          { intent: "confirm", actionId, confirmationSegments: [1] },
          ctx,
          transcript,
        ),
      ).toThrow("invalid_transcript_evidence");
    }
  });
  it("never accepts raw event IDs or readback overrides from model output", () => {
    const transcript = buildModelTranscript(
      [fragment("caller", "customer", "Test Caller", 0)],
      context,
    );
    expect(() =>
      resolveModelDecision(
        { intent: "propose", payload, requestEventIds: ["caller"] },
        context,
        transcript,
      ),
    ).toThrow();
    expect(() =>
      resolveModelDecision(
        {
          intent: "confirm",
          actionId: id,
          confirmationSegments: [1],
          readbackEventIds: ["fake"],
        },
        context,
        transcript,
      ),
    ).toThrow();
  });
  it("keeps a correction joined to yes for whole-response permission checks", () => {
    const ctx = { ...context, actions: [action] };
    const transcript = buildModelTranscript(
      [
        fragment(
          action.playback_event_id!,
          "assistant",
          action.readback,
          1000,
          2000,
        ),
        fragment("yes", "customer", "Yes", 2100),
        fragment(
          "correction",
          "customer",
          ", but my email is different.",
          2200,
        ),
      ],
      ctx,
    );
    // The model must evaluate this as a correction, not permission. This adapter
    // retains the full response; it does not itself classify natural language.
    expect(
      resolveModelDecision(
        { intent: "confirm", actionId: id, confirmationSegments: [2] },
        ctx,
        transcript,
      ),
    ).toMatchObject({ confirmationEventIds: ["yes", "correction"] });
  });
});
