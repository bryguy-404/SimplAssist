import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: mocks.from } }));
import { loadVoiceCallTranscript } from "./callTranscript.server";

interface Query {
  table: string;
  columns: string;
  filters: [string, string, unknown][];
  orders: [string, unknown][];
  limit: number;
}
interface FragmentRow {
  id: string; event_id: string; role: string; content: string;
  start_ms: number; end_ms: number; received_at: string;
}
const cutoff = "2026-09-17T12:00:00.000Z";
const queries: Query[] = [];
let conversation: Record<string, unknown> | null;
let session: Record<string, unknown> | null;
let fragments: FragmentRow[];
let errorAt: string | null;
let anchor: string | null;
let onPage: ((page: number) => void) | null;
let pageCount: number;
let providerPageSize: number;

function row(index: number, overrides: Partial<FragmentRow> = {}): FragmentRow {
  return { id: String(index).padStart(8, "0"), event_id: `event-${index}`, role: "customer", content: ` word${index}`,
    start_ms: index * 100, end_ms: index * 100 + 100, received_at: cutoff, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks(); queries.length = 0; pageCount = 0; providerPageSize = 1000; errorAt = null; anchor = cutoff; onPage = null;
  conversation = { id: "voice", business_id: "business", channel: "voice" };
  session = { id: "session", business_id: "business", conversation_id: "voice", status: "closed", ended_at: cutoff, phone_ended_at: cutoff };
  fragments = [row(0), row(1)];
  mocks.from.mockImplementation((table: string) => {
    const q: Query = { table, columns: "", filters: [], orders: [], limit: 0 };
    queries.push(q);
    const query: Record<string, unknown> = {};
    query.select = (columns: string) => { q.columns = columns; return query; };
    for (const method of ["eq", "gt", "lte"]) query[method] = (field: string, value: unknown) => { q.filters.push([method, field, value]); return query; };
    query.order = (field: string, options: unknown) => { q.orders.push([field, options]); return query; };
    query.limit = (limit: number) => { q.limit = limit; return query; };
    const result = () => {
      const stage = table !== "voice_transcript_fragments" ? table : q.columns === "received_at" ? "anchor" : "page";
      if (stage === "page") { pageCount++; onPage?.(pageCount); }
      if (stage === errorAt || `${stage}-${pageCount}` === errorAt) return Promise.resolve({ data: null, error: new Error("private query data") });
      let data: unknown;
      if (stage === "conversations") data = conversation;
      else if (stage === "voice_sessions") data = session;
      else if (stage === "anchor") data = anchor === null ? null : { received_at: anchor };
      else {
        const after = q.filters.find(([op, field]) => op === "gt" && field === "id")?.[2] as string | undefined;
        const through = q.filters.find(([op, field]) => op === "lte" && field === "received_at")?.[2] as string;
        data = fragments.filter((fragment) => (!after || fragment.id > after) && fragment.received_at <= through)
          .sort((a, b) => a.id.localeCompare(b.id)).slice(0, Math.min(q.limit, providerPageSize));
      }
      return Promise.resolve({ data, error: null });
    };
    query.maybeSingle = result;
    query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => result().then(resolve, reject);
    return query;
  });
});

describe("owner voice transcript loader", () => {
  it("scopes every read and only exposes display fields, independent of current voice eligibility", async () => {
    vi.stubEnv("VOICE_ACTIONS_ROLLOUT", "false");
    const transcript = await loadVoiceCallTranscript("business", "voice");
    expect(transcript).toEqual({ conversationId: "voice", callInProgress: false, turns: [{ id: "00000000", role: "customer", text: " word0 word1", startMs: 0, endMs: 200, overlapsPrevious: false }], truncated: false });
    expect(queries.every((q) => q.filters.some((filter) => JSON.stringify(filter) === JSON.stringify(["eq", "business_id", "business"])))).toBe(true);
    expect(queries[0].filters).toContainEqual(["eq", "channel", "voice"]);
    expect(queries[1].filters).toContainEqual(["eq", "conversation_id", "voice"]);
    expect(queries[1].filters).toContainEqual(["eq", "response_mode", "voice"]);
    expect(queries.filter((q) => q.table === "voice_transcript_fragments").every((q) => q.filters.some((filter) => filter[1] === "session_id" && filter[2] === "session"))).toBe(true);
    expect(JSON.stringify(transcript)).not.toMatch(/business_id|event_id|session_id|provider|received_at/);
    vi.unstubAllEnvs();
  });

  it.each([null, { id: "voice", business_id: "foreign", channel: "voice" }, { id: "voice", business_id: "business", channel: "sms" }])("stops before reading session for inaccessible or nonvoice conversation", async (value) => {
    conversation = value;
    expect(await loadVoiceCallTranscript("business", "voice")).toBeNull();
    expect(queries).toHaveLength(1);
  });

  it.each([null, { id: "other-session", business_id: "foreign", conversation_id: "voice" }, { id: "other-session", business_id: "business", conversation_id: "other" }])("does not read fragments from missing or mismatched call", async (value) => {
    session = value;
    expect(await loadVoiceCallTranscript("business", "voice")).toBeNull();
    expect(queries).toHaveLength(2);
  });

  it("fetches and groups across more than 1000 fragments with stable internal UUID pagination", async () => {
    fragments = Array.from({ length: 1201 }, (_, index) => row(index));
    const transcript = await loadVoiceCallTranscript("business", "voice");
    expect(pageCount).toBe(4);
    expect(transcript?.turns).toHaveLength(1);
    expect(transcript?.turns[0].text).toBe(fragments.map((fragment) => fragment.content).join(""));
    expect(transcript?.truncated).toBe(false);
    const pages = queries.filter((q) => q.columns.includes("event_id"));
    expect(pages.map((q) => q.limit)).toEqual([500, 500, 500, 500]);
    expect(pages[1].filters).toContainEqual(["gt", "id", "00000499"]);
    expect(pages.every((q) => q.filters.some(([op, field, value]) => op === "lte" && field === "received_at" && value === cutoff))).toBe(true);
  });

  it("continues through a lower provider row cap rather than silently stopping on a short page", async () => {
    providerPageSize = 100;
    fragments = Array.from({ length: 1201 }, (_, index) => row(index));
    const transcript = await loadVoiceCallTranscript("business", "voice");
    expect(pageCount).toBe(14);
    expect(transcript?.turns.map((turn) => turn.text).join("")).toBe(fragments.map((fragment) => fragment.content).join(""));
    expect(transcript?.truncated).toBe(false);
  });

  it.each([5000, 5001])("reports the exact cap versus an actual truncated transcript (%s fragments)", async (count) => {
    fragments = Array.from({ length: count }, (_, index) => row(index));
    const transcript = await loadVoiceCallTranscript("business", "voice");
    expect(pageCount).toBe(11);
    expect(transcript?.truncated).toBe(count > 5000);
    expect(transcript?.turns.map((turn) => turn.text).join("")).toBe(fragments.slice(0, 5000).map((fragment) => fragment.content).join(""));
    expect(queries.at(-1)?.limit).toBe(1);
  });

  it("sorts earlier audio received on a later page and leaves newer arrivals for refresh", async () => {
    session = { ...session, status: "active", ended_at: null, phone_ended_at: null };
    fragments = Array.from({ length: 501 }, (_, index) => row(index, index === 500 ? { start_ms: 0, end_ms: 50, content: "Late earlier speech" } : {}));
    onPage = (page) => { if (page === 2) fragments.push(row(502, { content: "Future", received_at: "2026-09-17T12:00:01.000Z" })); };
    const transcript = await loadVoiceCallTranscript("business", "voice");
    expect(transcript?.callInProgress).toBe(true);
    expect(transcript?.turns[0].text.startsWith("Late earlier speech word0")).toBe(true);
    expect(transcript?.turns.map((turn) => turn.text).join("")).not.toContain("Future");
  });

  it("returns an explicit empty live transcript without an unbounded query", async () => {
    anchor = null;
    session = { ...session, status: "notice", ended_at: null, phone_ended_at: null };
    expect(await loadVoiceCallTranscript("business", "voice")).toEqual({ conversationId: "voice", callInProgress: true, turns: [], truncated: false });
    expect(pageCount).toBe(0);
  });

  it("does not call a provider-ended phone leg live while worker finalization is pending", async () => {
    session = { ...session, status: "closing", ended_at: null };
    expect((await loadVoiceCallTranscript("business", "voice"))?.callInProgress).toBe(false);
  });

  it.each(["conversations", "voice_sessions", "anchor", "page-2"])("rejects %s lookup errors without returning an apparently complete partial transcript", async (stage) => {
    errorAt = stage;
    fragments = Array.from({ length: 501 }, (_, index) => row(index));
    await expect(loadVoiceCallTranscript("business", "voice")).rejects.toThrow("voice_transcript_unavailable");
  });

  it.each([{ start_ms: Number.NaN }, { start_ms: -1 }, { end_ms: -1 }, { role: "system" }, { content: "x".repeat(16001) }])("rejects malformed stored fragments rather than silently omitting them", async (overrides) => {
    fragments = [row(0, overrides)];
    await expect(loadVoiceCallTranscript("business", "voice")).rejects.toThrow("voice_transcript_unavailable");
  });
});
