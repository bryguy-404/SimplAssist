import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: mocks.from } }));
import { loadVoiceCallReview } from "./callReview.server";

const calls: { table: string; filters: [string, unknown][] }[] = [];
let rows: Record<string, unknown>;
function fixture() {
  rows = {
    conversations: { id: "voice", contact_id: "contact" },
    voice_sessions: { id: "session", caller_phone: "+15555550101", status: "closed", outcome: "caller_hangup", created_at: "2026-09-17T12:00:00Z", started_at: "2026-09-17T12:00:20Z", ended_at: "2026-09-17T12:01:00Z", openai_session_id: "private-provider" },
    contacts: { id: "contact", name: "Stored", email: "stored@example.test", phone_number: "+15555550101" },
    voice_actions: [{ id: "action", business_id: "business", session_id: "session", kind: "contact", status: "succeeded", confirmed_at: "2026-09-17T12:00:30Z", created_at: "2026-09-17T12:00:25Z", revision: 1, payload: { name: "Confirmed", phone: "+15555550101", email: "confirmed@example.test", private: "excluded" }, result: { providerMessageId: "private-provider", summary: "private-summary" } }],
    voice_recordings: [{ recording_id: "recording", delete_after: "2099-01-01", deleted_at: null }],
    goal_events: [], messages: [], calendar_bookings: [],
  };
}
beforeEach(() => {
  vi.clearAllMocks(); calls.length = 0; fixture();
  mocks.from.mockImplementation((table: string) => {
    const capture = { table, filters: [] as [string, unknown][] }; calls.push(capture);
    const result = () => Promise.resolve({ data: table === "conversations" && capture.filters.some(([field, value]) => field === "channel" && value === "sms") ? rows.sms_conversations : rows[table], error: null });
    const query: Record<string, unknown> = {};
    for (const method of ["select", "order", "in"]) query[method] = vi.fn(() => query);
    query.eq = vi.fn((field, value) => { capture.filters.push([field, value]); return query; });
    query.maybeSingle = result;
    query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => result().then(resolve, reject);
    return query;
  });
});
describe("customer voice read model", () => {
  it("scopes every read and exposes only customer fields independent of rollout flags", async () => {
    vi.stubEnv("VOICE_ACTIONS_ROLLOUT", "false");
    const review = await loadVoiceCallReview("business", "voice");
    expect(review?.durationSeconds).toBe(40);
    expect(review?.call.label).toBe("Call ended");
    expect(review?.confirmedContact).toMatchObject({ name: "Confirmed", conflicts: ["name", "email"] });
    expect(review?.recordings[0].url).toBe("/api/voice/recordings/recording");
    expect(calls.every((query) => query.filters.some(([field, value]) => field === "business_id" && value === "business"))).toBe(true);
    expect(calls[0].filters).toContainEqual(["channel", "voice"]);
    const serialized = JSON.stringify(review);
    expect(serialized).not.toMatch(/private-provider|private-summary|payload|openai_session_id|estimated_cost|excluded/);
    vi.unstubAllEnvs();
  });
  it("stops after an inaccessible or nonvoice conversation", async () => {
    rows.conversations = null;
    expect(await loadVoiceCallReview("business", "foreign")).toBeNull();
    expect(calls).toHaveLength(1);
  });
  it("does not label ringing time as conversation duration", async () => {
    rows.voice_sessions = { ...(rows.voice_sessions as object), started_at: null };
    expect((await loadVoiceCallReview("business", "voice"))?.durationSeconds).toBeNull();
  });
  it("withholds expired or deleted audio URLs", async () => {
    rows.voice_recordings = [{ recording_id: "expired", delete_after: "2000-01-01", deleted_at: null }, { recording_id: "deleted", delete_after: "2099-01-01", deleted_at: "2026-09-17" }];
    expect((await loadVoiceCallReview("business", "voice"))?.recordings.map((r) => r.url)).toEqual([null, null]);
  });
  it("does not call an action a confirmed booking without a calendar record", async () => {
    rows.voice_actions = [{ ...(rows.voice_actions as object[])[0], kind: "booking", source_message_id: "source" }];
    const review = await loadVoiceCallReview("business", "voice");
    expect(review?.actions[0].label).toBe("Booking result needs review");
    expect(calls.find((query) => query.table === "calendar_bookings")?.filters).toContainEqual(["conversation_id", "voice"]);
  });
  it("links the voice outcome to its same-contact SMS conversation and goal event", async () => {
    rows.voice_actions = [{ ...(rows.voice_actions as object[])[0], kind: "signup", result: { providerMessageId: "provider-message", deliveryStatus: "delivered" } }];
    rows.messages = [{ id: "action", conversation_id: "sms" }];
    rows.sms_conversations = [{ id: "sms" }];
    rows.goal_events = [{ id: "lead", voice_action_id: "action", conversation_id: "sms", contact_id: "contact" }];
    expect((await loadVoiceCallReview("business", "voice"))?.actions[0]).toMatchObject({ label: "Signup text delivered", smsConversationId: "sms", leadId: "lead" });
    expect(calls.find((query) => query.table === "conversations" && query.filters.some(([field, value]) => field === "channel" && value === "sms"))?.filters).toContainEqual(["contact_id", "contact"]);
  });
  it("withholds SMS and lead links when the related conversation is inaccessible", async () => {
    rows.voice_actions = [{ ...(rows.voice_actions as object[])[0], kind: "signup" }];
    rows.messages = [{ id: "action", conversation_id: "foreign-sms" }];
    rows.sms_conversations = [];
    rows.goal_events = [{ id: "lead", voice_action_id: "action", conversation_id: "foreign-sms", contact_id: "contact" }];
    expect((await loadVoiceCallReview("business", "voice"))?.actions[0]).toMatchObject({ smsConversationId: null, leadId: null });
  });
});
