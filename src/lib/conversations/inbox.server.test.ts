import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: m }));
import { inboxQuerySchema, readInboxPage, decodeInboxCursor } from "./inbox.server";
beforeEach(() => vi.resetAllMocks());
describe("server inbox filtering", () => {
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
