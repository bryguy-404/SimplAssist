import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APIConnectionTimeoutError } from "@anthropic-ai/sdk/core/error";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VoiceSession } from "./types";
import { CallTranscript } from "./transcript";
import type { ActionContext, VoiceAction } from "./actions";
const m = vi.hoisted(() => ({ create: vi.fn(), knowledge: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: m.create };
  },
}));
vi.mock("./knowledge", () => ({ loadVoiceKnowledge: m.knowledge }));
import { createVoiceAnswerer } from "./answer";
const session = {
  id: "test-call",
  business_id: "test-business",
} as VoiceSession;
function snapshot(text = "Test Caller, test@example.test") {
  const t = new CallTranscript();
  t.add({
    eventId: "event_test",
    role: "customer",
    text,
    startMs: 0,
    endMs: 1000,
  });
  return t.capture();
}
function fixture() {
  const updates: unknown[] = [];
  const q = {
    eq: () => q,
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ error: null }).then(resolve),
  };
  const db = {
    from: () => ({
      insert: async () => ({ error: null }),
      update: (v: unknown) => {
        updates.push(v);
        return q;
      },
    }),
  } as unknown as SupabaseClient;
  const actions = {
    context: vi.fn().mockResolvedValue({
      capabilities: { contacts: true, signup: true, booking: false },
      actions: [],
    }),
    decision: vi.fn().mockResolvedValue({
      text: "May I save these details?",
      confirmationActionId: "stored-action",
    }),
    playback: vi.fn(),
  };
  return {
    answer: createVoiceAnswerer(db, "local-test", actions),
    updates,
    actions,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => {});
  m.knowledge.mockResolvedValue("Approved business information.");
  m.create.mockResolvedValue({
    id: "response",
    usage: { input_tokens: 10, output_tokens: 5 },
    content: [
      {
        type: "tool_use",
        name: "voice_decision",
        input: {
          decision: {
            intent: "propose",
            payload: {
              kind: "contact",
              name: "Test Caller",
              phone: "+15555550101",
              email: "test@example.test",
            },
            requestSegments: [1],
          },
        },
      },
    ],
  });
});
afterEach(() => vi.restoreAllMocks());
describe("delegated voice decisions", () => {
  it("passes a validated contact proposal to the backend and retains confirmation identity", async () => {
    const f = fixture();
    const result = await f.answer(
      session,
      "d",
      snapshot(),
      new AbortController().signal,
    );
    expect(f.actions.decision).toHaveBeenCalledWith(
      "test-call",
      expect.objectContaining({
        intent: "propose",
        requestEventIds: ["event_test"],
      }),
      expect.any(AbortSignal),
    );
    expect(result).toHaveProperty("confirmationActionId", "stored-action");
  });
  it.each([[[999]], [[1, 1]], [[0]], [[1.5]]])(
    "rejects invalid segment references %j before the action API",
    async (reference) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const f = fixture();
      const response = await m.create();
      response.content[0].input.decision.requestSegments = Array.isArray(
        reference,
      )
        ? reference
        : [reference];
      m.create.mockResolvedValue(response);
      await expect(
        f.answer(session, "d", snapshot(), new AbortController().signal),
      ).rejects.toThrow();
      expect(f.actions.decision).not.toHaveBeenCalled();
      warn.mockRestore();
    },
  );
  it("sends compact speech and the new segment contract without raw provider IDs", async () => {
    const f = fixture();
    await f.answer(session, "d", snapshot(), new AbortController().signal);
    const request = m.create.mock.calls[0][0];
    expect(request.messages[0].content).toContain("[segment 1]");
    expect(JSON.stringify(request)).not.toContain("event_test");
    expect(JSON.stringify(request.tools[0].input_schema)).toContain(
      "requestSegments",
    );
    expect(JSON.stringify(request.tools[0].input_schema)).not.toContain(
      "requestEventIds",
    );
  });
  it("records the decision path without logging caller details or backend text", async () => {
    const f = fixture();
    await f.answer(
      session,
      "d",
      snapshot("private email and name"),
      new AbortController().signal,
    );
    expect(console.info).toHaveBeenCalledWith(
      "[voice-answer] decision_selected",
      expect.objectContaining({ intent: "propose", actionKind: "contact" }),
    );
    expect(console.info).toHaveBeenCalledWith(
      "[voice-answer] decision_result_received",
      expect.objectContaining({ intent: "propose", hasConfirmation: true }),
    );
    const logs = JSON.stringify(vi.mocked(console.info).mock.calls);
    expect(logs).not.toContain("Test Caller");
    expect(logs).not.toContain("test@example.test");
    expect(logs).not.toContain("private email");
    expect(logs).not.toContain("May I save");
  });
  it("keeps an action request bounded and propagates its cancellation signal", async () => {
    const f = fixture();
    const abort = new AbortController();
    await f.answer(session, "d", snapshot(), abort.signal);
    expect(m.create.mock.calls[0][1]).toEqual({
      signal: abort.signal,
      timeout: 12000,
    });
  });
  it("attaches the whole captured confirmation without model-copied segment references", async () => {
    const f = fixture();
    const actionId = "00000000-0000-4000-8000-000000000001";
    const t = new CallTranscript();
    t.add({
      eventId: "details",
      role: "customer",
      text: "Test Caller",
      startMs: 0,
      endMs: 100,
    });
    t.add({
      eventId: "readback",
      role: "assistant",
      text: "May I save Test Caller, phone +15555550101?",
      startMs: 200,
      endMs: 1000,
    });
    t.add({
      eventId: "yes",
      role: "customer",
      text: "Yes",
      startMs: 1500,
      endMs: 1700,
    });
    t.add({
      eventId: "rest",
      role: "customer",
      text: ", that's fine.",
      startMs: 1700,
      endMs: 2000,
    });
    t.add({
      eventId: "breath",
      role: "customer",
      text: "[breathing]",
      startMs: 2200,
      endMs: 2300,
    });
    f.actions.context.mockResolvedValue({
      capabilities: { contacts: true, signup: true, booking: false },
      actions: [
        {
          id: actionId,
          kind: "contact",
          status: "awaiting_confirmation",
          playback_event_id: "readback",
          playback_at: "2026-09-16T00:00:00Z",
          playback_caller_end_ms: 100,
        } as VoiceAction,
      ],
    } as ActionContext);
    const response = await m.create();
    response.content[0].input.decision = { intent: "confirm", actionId };
    m.create.mockClear().mockResolvedValue(response);
    await f.answer(session, "d", t.capture(), new AbortController().signal);
    expect(f.actions.decision).toHaveBeenCalledExactlyOnceWith(
      session.id,
      {
        intent: "confirm",
        actionId,
        readbackEventIds: ["readback"],
        confirmationEventIds: ["yes", "rest", "breath"],
      },
      expect.any(AbortSignal),
    );
    expect(m.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(m.create.mock.calls[0][0].tools)).not.toContain(
      "confirmationSegments",
    );
  });
  it.each([
    ["missing_action", "action_missing"],
    ["missing_playback", "playback_not_acknowledged"],
    ["missing_visible_playback", "playback_not_visible"],
  ])(
    "diagnoses %s without logging evidence contents or executing",
    async (mode, evidenceReason) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const f = fixture();
      const actionId = "00000000-0000-4000-8000-000000000001";
      f.actions.context.mockResolvedValue({
        capabilities: { contacts: true, signup: true, booking: false },
        actions:
          mode === "missing_action"
            ? []
            : [
                {
                  id: actionId,
                  kind: "contact",
                  status: "awaiting_confirmation",
                  playback_event_id:
                    mode === "missing_playback" ? null : "missing-marker",
                  playback_at: "2026-09-16T00:00:00Z",
                  playback_caller_end_ms: 0,
                } as VoiceAction,
              ],
      } as ActionContext);
      const response = await m.create();
      response.content[0].input.decision = { intent: "confirm", actionId };
      m.create.mockResolvedValue(response);
      await expect(
        f.answer(
          session,
          "d",
          snapshot("private reply"),
          new AbortController().signal,
        ),
      ).rejects.toThrow("invalid_transcript_evidence");
      expect(f.actions.decision).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith("[voice-answer] request_failed", {
        sessionId: session.id,
        delegationId: "d",
        stage: "decision_validation",
        category: "invalid_transcript_evidence",
        evidenceReason,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("private reply");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("missing-marker");
    },
  );
  it("does not execute truncated model output even if part of it parses", async () => {
    const f = fixture();
    const response = await m.create();
    m.create.mockResolvedValue({ ...response, stop_reason: "max_tokens" });
    await expect(
      f.answer(session, "d", snapshot(), new AbortController().signal),
    ).rejects.toThrow("backend_output_incomplete");
    expect(f.actions.decision).not.toHaveBeenCalled();
    expect(f.updates[0]).toMatchObject({ status: "confirmed" });
  });
  it("categorizes an actual SDK timeout without logging its body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture();
    m.create.mockRejectedValue(new APIConnectionTimeoutError());
    await expect(
      f.answer(session, "d", snapshot(), new AbortController().signal),
    ).rejects.toThrow();
    expect(warn).toHaveBeenCalledWith(
      "[voice-answer] request_failed",
      expect.objectContaining({ stage: "model", category: "model_timeout" }),
    );
    warn.mockRestore();
  });
  it("rejects invented action IDs without executing and records only nonpersonal diagnostics", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture();
    m.create.mockResolvedValue({
      id: "response",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [
        {
          type: "tool_use",
          name: "voice_decision",
          input: {
            decision: {
              intent: "confirm",
              actionId: "invented",
            },
          },
        },
      ],
    });
    await expect(
      f.answer(
        session,
        "d",
        snapshot("private transcript"),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(f.actions.decision).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[voice-answer] request_failed", {
      sessionId: "test-call",
      delegationId: "d",
      stage: "decision_validation",
      category: "invalid_decision_schema",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private transcript");
    expect(f.updates[0]).toMatchObject({
      status: "confirmed",
      input_tokens: 10,
    });
    warn.mockRestore();
  });
  it("awaits action failures so they are diagnosed without logging provider response bodies", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture();
    f.actions.decision.mockRejectedValue(
      new Error("sensitive provider response"),
    );
    await expect(
      f.answer(
        session,
        "d",
        snapshot("private transcript"),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(warn).toHaveBeenCalledWith(
      "[voice-answer] request_failed",
      expect.objectContaining({ stage: "decision_execution" }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("sensitive");
    warn.mockRestore();
  });
});
