import { beforeEach, describe, expect, it, vi } from "vitest";
import { APIConnectionTimeoutError } from "@anthropic-ai/sdk/core/error";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VoiceSession } from "./types";
import { CallTranscript } from "./transcript";
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
  it("keeps an action request bounded and propagates its cancellation signal", async () => {
    const f = fixture();
    const abort = new AbortController();
    await f.answer(session, "d", snapshot(), abort.signal);
    expect(m.create.mock.calls[0][1]).toEqual({
      signal: abort.signal,
      timeout: 12000,
    });
  });
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
              confirmationSegments: [1],
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
