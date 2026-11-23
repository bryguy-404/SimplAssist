import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
const m = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: m }));
import { inboxQuerySchema, readInboxPage, decodeInboxCursor } from "./inbox.server";
beforeEach(() => vi.resetAllMocks());
describe("server inbox filtering", () => {
  it("finds literal names and formatted phone matches, keeps timestamp precision, and deduplicates", async () => {
    const named = { id: "00000000-0000-4000-8000-000000000003", last_message_at: "2026-11-01T00:00:00.000001Z" };
    const phone = { id: "00000000-0000-4000-8000-000000000001", last_message_at: "2026-11-01T00:00:00.000005Z" };
    const both = { id: "00000000-0000-4000-8000-000000000002", last_message_at: phone.last_message_at };
    m.rpc.mockImplementation(async (_rpc, args) => {
      const conversations = args.p_search === "7-11" ? [both, named] : [both, phone];
      return { data: { folder: "inbox", conversations, total: 2, next: null }, error: null };
    });
    const result = await readInboxPage("business", "owner", { folder: "inbox", channel: "all", search: "7-11" });
    expect(m.rpc.mock.calls.map(([, args]) => args.p_search)).toEqual(["7-11", "711"]);
    expect(result).toMatchObject({ conversations: [both, phone, named], total: 3, next: null });
    expect(m.from).not.toHaveBeenCalled();
  });

  it("preserves the page boundary and scoped total when both searches have more results", async () => {
    const time = "2026-11-01T00:00:00.123456Z";
    const rows = Array.from({ length: 201 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(201 - i).padStart(12, "0")}`, last_message_at: time,
    }));
    m.rpc.mockImplementation(async (_rpc, args) => {
      const matches = args.p_search === "(574)" ? rows.filter((_, i) => i % 2 === 0) : rows.filter((_, i) => i % 2 === 1 || i === 0);
      const page = matches.filter(row => !args.p_cursor_id || row.id < args.p_cursor_id);
      return { data: { folder: "spam", total: matches.length, conversations: page.slice(0, 100),
        next: page.length > 100 ? { time, id: page[99].id } : null }, error: null };
    });
    const fetchCount = vi.fn(async () => new Response(null, { status: 200, headers: { "content-range": "0-0/201" } }));
    const db = createClient("https://example.test", "test", { global: { fetch: fetchCount } });
    m.from.mockImplementation((table: string) => db.from(table));
    const query = { folder: "spam" as const, channel: "voice" as const, search: "(574)" };
    const first = await readInboxPage("business", "owner", query);
    const second = await readInboxPage("business", "owner", { ...query, cursor: first.next! });
    const third = await readInboxPage("business", "owner", { ...query, cursor: second.next! });
    expect([first.total, second.total, third.total]).toEqual([201, 201, 201]);
    expect([first, second, third].flatMap(page => page.conversations)).toEqual(rows);
    expect(third.next).toBeNull();
    expect(fetchCount).toHaveBeenCalled();
    const [url, options] = vi.mocked(fetchCount).mock.calls[0] as unknown as [string, RequestInit];
    const params = new URL(url).searchParams;
    expect(options.method).toBe("HEAD");
    expect(Object.fromEntries(params)).toMatchObject({
      business_id: "eq.business", "contact.business_id": "eq.business", "business.owner_id": "eq.owner",
      "business.deleted_at": "is.null", spam_state: "neq.inbox", channel: "eq.voice",
    });
    expect(params.get("contact.or")).toContain('name.ilike."*(574)*"');
    expect(params.get("contact.or")).toContain('phone_number.like."*574*"');
  });

  it("binds every query and cursor to the fresh owner/business and returns a bounded cursor", async () => {
    const cursor = { time: "2026-11-22T00:00:00+00:00", id: "00000000-0000-4000-8000-000000000001" };
    m.rpc.mockResolvedValue({ data: { folder: "spam", conversations: [], selected: null, total: 1200, counts: { inbox: 30, spam: 1200 }, next: cursor }, error: null });
    const page = await readInboxPage("business", "owner", { folder: "spam", channel: "voice", search: "Google", cursor: Buffer.from(JSON.stringify(cursor)).toString("base64url") });
    expect(m.rpc).toHaveBeenCalledWith("read_inbox_page", { p_business: "business", p_owner: "owner", p_folder: "spam", p_channel: "voice", p_search: "Google", p_cursor_time: cursor.time, p_cursor_id: cursor.id, p_focus: null });
    expect(decodeInboxCursor(page.next!)).toEqual(cursor);
  });
  it("refuses arbitrary SQL-like or malformed cursor/filter input", () => {
    for (const value of ["oops", Buffer.from(JSON.stringify({ time: "not-a-date", id: "other" })).toString("base64url")]) expect(() => decodeInboxCursor(value)).toThrow("inbox_invalid_cursor");
    expect(inboxQuerySchema.safeParse({ folder: "all" }).success).toBe(false);
    expect(inboxQuerySchema.safeParse({ search: "a".repeat(121) }).success).toBe(false);
  });
  it("never returns cached or empty success after an ownership or database failure", async () => {
    m.rpc.mockResolvedValueOnce({ data: null, error: { code: "42501" } }).mockResolvedValueOnce({ data: null, error: { code: "500" } });
    const query = { folder: "inbox" as const, channel: "all" as const, search: "" };
    await expect(readInboxPage("business", "former-owner", query)).rejects.toThrow("inbox_access_denied");
    await expect(readInboxPage("business", "owner", query)).rejects.toThrow("inbox_unavailable");
  });
});
