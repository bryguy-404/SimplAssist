import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VoiceSession } from "./types";
const provider = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: provider.create }; } }));
import { createDisclosureReplyClassifier } from "./disclosure";

function fixture() {
  const writes: unknown[] = [];
  const q = { eq: () => q, then: (resolve: (v: unknown) => void) => Promise.resolve({ error: null }).then(resolve) };
  const db = { from: vi.fn((table: string) => {
    expect(table).toBe("voice_provider_usage");
    return { insert: (value: unknown) => { writes.push(value); return Promise.resolve({ error: null }); },
      update: (value: unknown) => { writes.push(value); return q; } };
  }) } as unknown as SupabaseClient;
  return { writes, run: (reply: string, signal = new AbortController().signal) =>
    createDisclosureReplyClassifier(db, "mock-key")({ id: "call", business_id: "business" } as VoiceSession, "reply-id", reply, signal) };
}
const response = (decision: string) => ({ id: "provider-id", stop_reason: "tool_use", usage: { input_tokens: 20, output_tokens: 5 },
  content: [{ type: "tool_use", id: "tool", name: "opening_reply", input: { decision } }] });
beforeEach(() => provider.create.mockReset());
describe("transient disclosure reply classifier", () => {
  it.each(["refuse", "repeat"])("accepts a bounded structured %s decision while storing only usage metadata", async (decision) => {
    provider.create.mockResolvedValue(response(decision)); const f = fixture();
    const reply = "Please do not record my voice.";
    expect(await f.run(reply)).toBe(decision);
    expect(provider.create).toHaveBeenCalledOnce();
    expect(provider.create.mock.calls[0][0]).toMatchObject({ max_tokens: 80,
      tool_choice: { type: "tool", name: "opening_reply" }, messages: [{ role: "user", content: JSON.stringify({ callerReply: reply }) }] });
    expect(provider.create.mock.calls[0][1]).toMatchObject({ timeout: 3000, signal: expect.any(AbortSignal) });
    expect(JSON.stringify(f.writes)).not.toContain(reply);
    expect(f.writes).toEqual([expect.objectContaining({ status: "pending", session_id: "call", business_id: "business" }),
      expect.objectContaining({ status: "confirmed", input_tokens: 20, output_tokens: 5, provider_request_id: "provider-id" })]);
  });
  it("fails closed on ambiguous, truncated, duplicated or aborted model output", async () => {
    const f = fixture();
    for (const result of [response("maybe"), { ...response("repeat"), stop_reason: "max_tokens" },
      { ...response("repeat"), content: [...response("repeat").content, ...response("refuse").content] }]) {
      provider.create.mockResolvedValue(result); await expect(f.run("Okay")).rejects.toThrow("voice_disclosure_reply_unavailable");
    }
    provider.create.mockResolvedValue(response("repeat"));
    const abort = new AbortController(); abort.abort();
    await expect(f.run("Okay", abort.signal)).rejects.toThrow("voice_disclosure_reply_unavailable");
  });
  it("rejects empty or overlong input before provider usage", async () => {
    const f = fixture(); await expect(f.run(" ")).rejects.toThrow(); await expect(f.run("a".repeat(4001))).rejects.toThrow();
    expect(provider.create).not.toHaveBeenCalled(); expect(f.writes).toEqual([]);
  });
});
