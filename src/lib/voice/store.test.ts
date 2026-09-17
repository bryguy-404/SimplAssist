import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { consumeStreamToken, createVoiceStore } from "./store";
import type { VoiceSession } from "./types";

const session = {
  id: "call", business_id: "business", access_source: "commercial",
  text_fallback_enabled: false,
} as VoiceSession;

function fixture() {
  const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
  const queries: string[] = [];
  const from = vi.fn((table: string) => {
    queries.push(table);
    const q = {
      select: () => q, update: () => q, eq: () => q, in: () => q,
      then: (resolve: (r: unknown) => void) => Promise.resolve({ data: [{ id: "call" }], error: null }).then(resolve),
    };
    return q;
  });
  const db = { rpc, from } as unknown as SupabaseClient;
  return { rpc, queries, db, store: createVoiceStore(db, session) };
}

describe("commercial voice persistence", () => {
  it("activates the recorded natural opening without claiming a notice or starting customer minutes", async () => {
    const f = fixture();
    await f.store.beginDisclosure!("provider");
    await f.store.recordingStarted!();
    await f.store.activateNaturalOpening!("provider", 0);
    expect(f.rpc.mock.calls).toEqual([
      ["begin_voice_disclosure", { p_session_id: "call", p_openai_id: "provider" }],
      ["mark_voice_recording_started", { p_session_id: "call" }],
      ["activate_voice_natural_opening", { p_session_id: "call", p_openai_id: "provider", p_input_start_ms: 0 }],
    ]);
    f.rpc.mockResolvedValue({ data: false, error: null });
    await expect(f.store.activateNaturalOpening!("wrong-provider", 0)).rejects.toThrow("voice_natural_opening_blocked");
  });
  it("uses the admitted continuation grant rather than rechecking a changed preference or subscription", async () => {
    const f = fixture();
    expect(await f.store.heartbeat()).toBe(true);
    expect(f.rpc).toHaveBeenCalledWith("voice_session_continuation_allowed", { p_session_id: "call" });
    expect(f.queries).toEqual(["voice_sessions"]);
    f.rpc.mockResolvedValue({ data: false, error: null });
    expect(await f.store.heartbeat()).toBe(false);
    expect(f.queries).toEqual(["voice_sessions"]);
  });
  it("fails closed when the continuation check is unavailable", async () => {
    const f = fixture();
    f.rpc.mockResolvedValue({ data: null, error: { code: "XX000" } });
    await expect(f.store.heartbeat()).rejects.toThrow("voice_store_voice_session_continuation_allowed_failed");
    expect(f.queries).toEqual([]);
  });
  it("keeps audible-frame evidence, acknowledgment and provider usage independent", async () => {
    const f = fixture();
    await f.store.customerAudioStarted!("start-mark", "2026-09-17T12:00:00Z");
    await f.store.customerPlaybackAcknowledged!("start-mark");
    await f.store.usage(15, true);
    expect(f.rpc.mock.calls).toEqual([
      ["record_voice_customer_start", { p_session_id: "call", p_event_id: "start-mark", p_started_at: "2026-09-17T12:00:00Z" }],
      ["acknowledge_voice_customer_start", { p_session_id: "call", p_event_id: "start-mark" }],
      ["update_voice_usage", { p_session_id: "call", p_seconds: 15, p_confirmed: true }],
    ]);
    await f.store.finish("technical_failure", "audio_failed", true);
    expect(f.rpc).toHaveBeenLastCalledWith("finalize_voice_session", expect.objectContaining({ p_fallback: false }));
  });
  it("persists disclosure, recording and acknowledged handoff as separate guarded steps", async () => {
    const f = fixture();
    await f.store.beginDisclosure!("provider"); await f.store.completeDisclosure!("notice-1-id");
    await f.store.recordingStarted!(); await f.store.handoffStarted!("handoff-id", "2026-09-17T12:00:00Z");
    await f.store.handoffAcknowledged!("handoff-id", 2400);
    expect(f.rpc.mock.calls).toEqual([
      ["begin_voice_disclosure", { p_session_id: "call", p_openai_id: "provider" }],
      ["complete_voice_disclosure", { p_session_id: "call", p_event_id: "notice-1-id" }],
      ["mark_voice_recording_started", { p_session_id: "call" }],
      ["begin_voice_conversation_handoff", { p_session_id: "call", p_event_id: "handoff-id", p_started_at: "2026-09-17T12:00:00Z" }],
      ["acknowledge_voice_conversation_handoff", { p_session_id: "call", p_event_id: "handoff-id", p_input_start_ms: 2400 }],
    ]);
    f.rpc.mockResolvedValue({ data: false, error: null });
    await expect(f.store.completeDisclosure!("notice-1-denied")).rejects.toThrow();
    await expect(f.store.handoffAcknowledged!("handoff-denied", 2400)).rejects.toThrow();
  });
  it("rejects a commercial stream routed to a different action business", async () => {
    const f = fixture();
    f.rpc.mockResolvedValue({ data: { ...session, action_business_id: "other" }, error: null });
    await expect(consumeStreamToken(f.db, "a".repeat(43))).rejects.toThrow("voice_stream_identity_invalid");
  });
});
