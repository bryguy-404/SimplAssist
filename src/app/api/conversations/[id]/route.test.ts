import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  from: vi.fn(), adminFrom: vi.fn(), rpc: vi.fn(), access: vi.fn(),
  resolve: vi.fn(), decide: vi.fn(),
}));
class EntitlementError extends Error {}
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: mocks.from }) }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: mocks.adminFrom, rpc: mocks.rpc } }));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({ requireFreshWorkspaceRouteAccess: mocks.access }));
vi.mock("@/lib/billing/entitlements", () => ({
  resolveBusinessEntitlements: mocks.resolve,
  decideFeatureAccess: mocks.decide,
  isEntitlementResolutionError: (error: unknown) => error instanceof EntitlementError,
}));

import { DELETE as singleDelete } from "./route";
import { DELETE as bulkDelete } from "../route";

const BUSINESS = "10000000-0000-4000-a000-000000000041";
const SMS = "30000000-0000-4000-a000-000000000041";
const VOICE = "30000000-0000-4000-a000-000000000042";
const CHAT = "30000000-0000-4000-a000-000000000043";
type Row = { id: string; channel: string; status: string };
const sms: Row = { id: SMS, channel: "sms", status: "active" };
const voice: Row = { id: VOICE, channel: "voice", status: "closed" };
const chat: Row = { id: CHAT, channel: "web_chat", status: "closed" };

function chain(result: { data?: unknown; error?: unknown }) {
  const query = {
    select: vi.fn(), eq: vi.fn(), in: vi.fn(), neq: vi.fn(), limit: vi.fn(),
    then: Promise.resolve(result).then.bind(Promise.resolve(result)),
  };
  for (const method of ["select", "eq", "in", "neq", "limit"] as const) {
    query[method].mockReturnValue(query);
  }
  return query;
}
function setup(rows: Row[] = [sms], options: {
  lookupError?: unknown; statusError?: unknown; deleteError?: unknown;
  activeCalls?: { id: string }[]; deletedIds?: string[];
} = {}) {
  const lookup = chain({ data: rows, error: options.lookupError ?? null });
  const sessions = chain({ data: options.activeCalls ?? [], error: options.statusError ?? null });
  mocks.from.mockImplementation((table) => {
    if (table !== "conversations") throw new Error(`Unexpected table ${table}`);
    return lookup;
  });
  mocks.adminFrom.mockImplementation((table) => {
    if (table !== "voice_sessions") throw new Error(`Unexpected privileged table ${table}`);
    return sessions;
  });
  mocks.rpc.mockResolvedValue({ data: (options.deletedIds ?? rows.map((row) => row.id)).map((deleted_id) => ({ deleted_id })), error: options.deleteError ?? null });
  return { lookup, sessions };
}
function bulk(ids: unknown) {
  return bulkDelete(new NextRequest("http://localhost/api/conversations", {
    method: "DELETE", body: JSON.stringify({ ids }), headers: { "Content-Type": "application/json" },
  }));
}
function single(id: string) {
  return singleDelete(new NextRequest(`http://localhost/api/conversations/${id}`, { method: "DELETE" }), { params: { id } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.access.mockResolvedValue({ ok: true, access: { business: { id: BUSINESS }, user: { id: "owner-id" } } });
  mocks.resolve.mockResolvedValue({ plan: "sms_only" });
  mocks.decide.mockReturnValue({ allowed: true });
  setup();
});

describe.each([
  ["single", (id: string) => single(id)],
  ["bulk", (id: string) => bulk([id])],
] as const)("%s conversation deletion", (_name, request) => {
  it.each([401, 403, 503])("returns workspace %i before database access", async (status) => {
    mocks.access.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "access" }, { status }) });
    expect((await request(SMS)).status).toBe(status);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.adminFrom).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("deletes an entitled SMS thread with explicit tenant and ID restrictions", async () => {
    const { lookup } = setup();
    const response = await request(SMS);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, deletedIds: [SMS] });
    expect(lookup.eq).toHaveBeenCalledWith("business_id", BUSINESS);
    expect(mocks.rpc).toHaveBeenCalledWith("delete_inbox_conversations", { p_business_id: BUSINESS, p_owner_id: "owner-id", p_ids: [SMS] });
    expect(mocks.decide).toHaveBeenCalledWith({ plan: "sms_only" }, "contacts_inbox");
  });
  it("keeps downgraded chat history read-only", async () => {
    setup([chat]);
    mocks.decide.mockReturnValue({ allowed: false });
    expect((await request(CHAT)).status).toBe(403);
    expect(mocks.decide).toHaveBeenCalledWith(expect.anything(), "web_chat");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("fails closed when the plan lookup is unavailable", async () => {
    setup();
    mocks.resolve.mockRejectedValue(new EntitlementError("unavailable"));
    const response = await request(SMS);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ retryable: true });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("allows completed calls through the scoped server path without deleting sessions", async () => {
    const { sessions } = setup([voice]);
    const response = await request(VOICE);
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("delete_inbox_conversations", { p_business_id: BUSINESS, p_owner_id: "owner-id", p_ids: [VOICE] });
    expect(sessions.eq).toHaveBeenCalledWith("business_id", BUSINESS);
    expect(sessions.in).toHaveBeenCalledWith("conversation_id", [VOICE]);
    expect(mocks.from.mock.calls.map(([table]) => table)).toEqual(["conversations"]);
    expect(mocks.adminFrom).toHaveBeenCalledExactlyOnceWith("voice_sessions");
  });
  it("refuses a call still in progress", async () => {
    setup([{ ...voice, status: "active" }]);
    expect((await request(VOICE)).status).toBe(409);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("checks the session even if the inbox says closed", async () => {
    setup([voice], { activeCalls: [{ id: "active-session" }] });
    expect((await request(VOICE)).status).toBe(409);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("fails closed on call-status lookup errors", async () => {
    setup([voice], { statusError: { message: "unavailable" } });
    expect((await request(VOICE)).status).toBe(503);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("bulk deletion boundaries", () => {
  it("deletes a mixed selection in one statement after checking every channel", async () => {
    setup([sms, voice, chat]);
    const response = await bulk([SMS, VOICE, CHAT]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ deletedIds: [SMS, VOICE, CHAT] });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("delete_inbox_conversations", { p_business_id: BUSINESS, p_owner_id: "owner-id", p_ids: [SMS, VOICE, CHAT] });
    expect(mocks.decide).toHaveBeenCalledWith(expect.anything(), "web_chat");
  });
  it.each([[], null, "all", ["bad-id"], Array(101).fill(SMS)])("rejects invalid or oversized selections: %j", async (ids) => {
    expect((await bulk(ids)).status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects malformed JSON", async () => {
    const response = await bulkDelete(new NextRequest("http://localhost/api/conversations", { method: "DELETE", body: "{" }));
    expect(response.status).toBe(400);
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it("normalizes duplicate UUIDs before checking ownership", async () => {
    const { lookup } = setup();
    expect((await bulk([SMS, SMS.toUpperCase()])).status).toBe(200);
    expect(lookup.in).toHaveBeenCalledWith("id", [SMS]);
    expect(mocks.rpc).toHaveBeenCalledWith("delete_inbox_conversations", expect.objectContaining({ p_ids: [SMS] }));
  });
  it("does not delete any owned IDs when the selection includes an unavailable/foreign ID", async () => {
    setup([sms]);
    expect((await bulk([SMS, VOICE])).status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not partially delete when one channel is locked", async () => {
    setup([sms, chat]);
    mocks.decide.mockImplementation((_access, feature) => ({ allowed: feature !== "web_chat" }));
    expect((await bulk([SMS, CHAT])).status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not partially delete when a call is active", async () => {
    setup([sms, { ...voice, status: "active" }]);
    expect((await bulk([SMS, VOICE])).status).toBe(409);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not write after a database lookup failure", async () => {
    setup([], { lookupError: { message: "private internal error" } });
    const response = await bulk([SMS]);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private internal error");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(["conversation_has_appointments", "conversation_call_in_progress", "conversation_selection_changed"])("returns a safe conflict for %s", async (message) => {
    setup([sms], { deleteError: { message } });
    const response = await bulk([SMS]);
    expect(response.status).toBe(409);
    expect(await response.json()).not.toHaveProperty("success");
  });
  it("checks ownership again at the database boundary", async () => {
    setup([sms], { deleteError: { code: "42501", message: "conversation_access_denied" } });
    expect((await bulk([SMS])).status).toBe(403);
  });
  it("reports deletion failures without claiming success", async () => {
    setup([sms], { deleteError: { message: "database error" } });
    const response = await bulk([SMS]);
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty("success");
  });
  it("only reports rows the database actually deleted", async () => {
    setup([sms, chat], { deletedIds: [SMS] });
    expect(await (await bulk([SMS, CHAT])).json()).toEqual({ success: true, deletedIds: [SMS] });
  });
});
