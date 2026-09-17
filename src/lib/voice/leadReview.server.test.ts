import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { loadVoiceLeadReviews, type VoiceLeadSource } from "./leadReview.server";
const event: VoiceLeadSource = { id: "lead", origin_kind: "voice_action", voice_action_id: "signup", source_conversation_id: "voice", contact_id: "contact", contact: { name: "Stored", email: "stored@example.test", phone_number: "+15555550101" } };
const signup = { id: "signup", business_id: "business", session_id: "session", kind: "signup", status: "succeeded", confirmed_at: "2026-09-17T12:00:00Z", revision: 3, result: { providerMessageId: "provider-message", deliveryStatus: "delivered" } };
const contact = { id: "contact-action", business_id: "business", session_id: "session", kind: "contact", status: "succeeded", confirmed_at: "2026-09-17T12:00:00Z", revision: 2, payload: { name: "Confirmed", phone: "+15555550101", email: "call@example.test" } };
const session = { id: "session", business_id: "business", conversation_id: "voice", caller_phone: "+15555550101" };
let from: ReturnType<typeof vi.fn>;
let filters: unknown[][];
function client(results: { data: unknown; error?: unknown }[]) {
  filters = [];
  from = vi.fn(() => {
    const result = results.shift();
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "order", "limit"]) query[method] = vi.fn((...args: unknown[]) => { if (method === "eq") filters.push(args); return query; });
    query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
    return query;
  });
  return { from } as unknown as SupabaseClient;
}
beforeEach(() => vi.clearAllMocks());
describe("voice-origin lead projection", () => {
  it("combines only scoped prior confirmed identity with actual signup delivery", async () => {
    const db = client([{ data: [signup] }, { data: [session] }, { data: [contact, { ...contact, revision: 4, payload: { name: "Later", phone: session.caller_phone } }] }]);
    const reviews = await loadVoiceLeadReviews(db, "business", [event]);
    expect(reviews.get("lead")).toMatchObject({ confirmedContact: { name: "Confirmed", conflicts: ["name", "email"] }, status: { label: "Signup text delivered" }, sourceConversationId: "voice" });
    expect(filters.filter(([field, value]) => field === "business_id" && value === "business")).toHaveLength(3);
  });
  it.each([{ business_id: "foreign" }, { conversation_id: "other-call" }])("rejects mismatched call linkage %j", async (change) => {
    const db = client([{ data: [signup] }, { data: [{ ...session, ...change }] }, { data: [contact] }]);
    expect((await loadVoiceLeadReviews(db, "business", [event])).size).toBe(0);
  });
  it("does not use pending, failed or unconfirmed identity", async () => {
    const db = client([{ data: [signup] }, { data: [session] }, { data: [{ ...contact, status: "awaiting_confirmation" }, { ...contact, status: "failed" }, { ...contact, confirmed_at: null }] }]);
    expect((await loadVoiceLeadReviews(db, "business", [event])).get("lead")?.confirmedContact).toBeNull();
  });
  it("does not query voice records for ordinary conversation leads", async () => {
    const db = client([]);
    expect((await loadVoiceLeadReviews(db, "business", [{ ...event, origin_kind: "conversation" }])).size).toBe(0);
    expect(from).not.toHaveBeenCalled();
  });
  it("surfaces lookup failure so the page can preserve the lead with unavailable call metadata", async () => {
    const db = client([{ data: null, error: new Error("db") }]);
    await expect(loadVoiceLeadReviews(db, "business", [event])).rejects.toThrow("voice_lead_review_unavailable");
  });
});
