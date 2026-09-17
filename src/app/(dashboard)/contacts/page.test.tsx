import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Contact, Conversation } from "@/types/database";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn(),
  requireWorkspacePageAccess: vi.fn(),
  getDashboardBusinessContext: vi.fn(),
  contactStats: vi.fn(() => null),
  contactsTable: vi.fn(() => null),
  from: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({
  requireWorkspacePageAccess: mocks.requireWorkspacePageAccess,
}));
vi.mock("@/lib/dashboard/context", () => ({
  getDashboardBusinessContext: mocks.getDashboardBusinessContext,
}));
vi.mock("@/components/contacts/ContactStats", () => ({
  default: mocks.contactStats,
}));
vi.mock("@/components/contacts/ContactsTable", () => ({
  default: mocks.contactsTable,
}));

import ContactsPage from "./page";

const BUSINESS_ID = "business-1";

interface QueryResult {
  data: unknown;
  error: unknown;
}

interface QueryRecorder {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  then: Promise<QueryResult>["then"];
  catch: Promise<QueryResult>["catch"];
}

function query(result: QueryResult): QueryRecorder {
  const recorder = {} as QueryRecorder;
  recorder.select = vi.fn(() => recorder);
  recorder.eq = vi.fn(() => recorder);
  recorder.order = vi.fn(() => recorder);
  recorder.maybeSingle = vi.fn().mockResolvedValue(result);
  const promise = Promise.resolve(result);
  recorder.then = promise.then.bind(promise);
  recorder.catch = promise.catch.bind(promise);
  return recorder;
}

const CONTACT: Contact = {
  id: "contact-1",
  business_id: BUSINESS_ID,
  name: "Ada Lovelace",
  phone_number: null,
  email: "ada@example.com",
  session_id: "session-1",
  source_channel: "web_chat",
  lead_score: 0,
  lead_status: "hot",
  lead_status_updated_at: "2026-08-10T12:00:00.000Z",
  notes: null,
  created_at: "2026-08-09T12:00:00.000Z",
  last_contacted_at: "2026-08-10T12:00:00.000Z",
};

const CONVERSATION: Conversation = {
  id: "conversation-1",
  business_id: BUSINESS_ID,
  contact_id: CONTACT.id,
  channel: "web_chat",
  status: "active",
  is_ai_handling: true,
  started_at: "2026-08-10T11:00:00.000Z",
  last_message_at: "2026-08-10T12:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireWorkspacePageAccess.mockResolvedValue(undefined);
});

describe("ContactsPage", () => {
  it("resolves an omitted deep-linked contact with one bounded owner-scoped lookup", async () => {
    const selected = query({ data: CONTACT, error: null });
    mocks.from.mockReturnValueOnce(query({ data: [], error: null }))
      .mockReturnValueOnce(query({ data: [], error: null })).mockReturnValueOnce(selected);
    mocks.getDashboardBusinessContext.mockResolvedValue({ status: "resolved", supabase: { from: mocks.from }, user: { id: "user-1" }, business: { id: BUSINESS_ID } });
    renderToStaticMarkup(await ContactsPage({ searchParams: { contact: CONTACT.id } }));
    expect(selected.eq.mock.calls).toEqual([["business_id", BUSINESS_ID], ["id", CONTACT.id]]);
    expect(selected.maybeSingle).toHaveBeenCalledOnce();
    expect(mocks.contactsTable).toHaveBeenCalledWith(expect.objectContaining({ contacts: [{ ...CONTACT, conversation_count: 0 }], initialSelectedId: CONTACT.id }), expect.anything());
  });

  it.each([{ data: null, error: null }, { data: null, error: { message: "lookup failed" } }])("does not display a foreign, deleted or unreadable deep-linked contact", async (result) => {
    const selected = query(result);
    mocks.from.mockReturnValueOnce(query({ data: [], error: null }))
      .mockReturnValueOnce(query({ data: [], error: null })).mockReturnValueOnce(selected);
    mocks.getDashboardBusinessContext.mockResolvedValue({ status: "resolved", supabase: { from: mocks.from }, user: { id: "user-1" }, business: { id: BUSINESS_ID } });
    renderToStaticMarkup(await ContactsPage({ searchParams: { contact: "foreign-contact" } }));
    expect(selected.eq).toHaveBeenCalledWith("business_id", BUSINESS_ID);
    expect(mocks.contactsTable).toHaveBeenCalledWith(expect.objectContaining({ contacts: [] }), expect.anything());
  });

  it("does not repeat a contact lookup when the selected contact is already in the list", async () => {
    mocks.from.mockReturnValueOnce(query({ data: [CONTACT], error: null })).mockReturnValueOnce(query({ data: [], error: null }));
    mocks.getDashboardBusinessContext.mockResolvedValue({ status: "resolved", supabase: { from: mocks.from }, user: { id: "user-1" }, business: { id: BUSINESS_ID } });
    renderToStaticMarkup(await ContactsPage({ searchParams: { contact: CONTACT.id } }));
    expect(mocks.from).toHaveBeenCalledTimes(2);
  });
  it("keeps the full-row contact query and supplies authoritative lead columns to both surfaces", async () => {
    const contactsQuery = query({ data: [CONTACT], error: null });
    const conversationsQuery = query({ data: [CONVERSATION], error: null });
    mocks.from
      .mockReturnValueOnce(contactsQuery)
      .mockReturnValueOnce(conversationsQuery);
    mocks.getDashboardBusinessContext.mockResolvedValue({
      status: "resolved",
      supabase: { from: mocks.from },
      user: { id: "user-1" },
      business: { id: BUSINESS_ID },
    });

    renderToStaticMarkup(await ContactsPage());

    expect(mocks.requireWorkspacePageAccess).toHaveBeenCalledOnce();
    expect(mocks.from.mock.calls).toEqual([["contacts"], ["conversations"]]);
    expect(contactsQuery.select).toHaveBeenCalledOnce();
    expect(contactsQuery.select).toHaveBeenCalledWith("*");
    expect(contactsQuery.eq.mock.calls).toEqual([["business_id", BUSINESS_ID]]);
    expect(contactsQuery.order.mock.calls).toEqual([
      ["last_contacted_at", { ascending: false }],
    ]);
    expect(conversationsQuery.select).toHaveBeenCalledWith("*");
    expect(conversationsQuery.eq.mock.calls).toEqual([
      ["business_id", BUSINESS_ID],
    ]);

    expect(mocks.contactStats).toHaveBeenCalledWith(
      expect.objectContaining({ contacts: [CONTACT] }),
      expect.anything()
    );
    expect(mocks.contactsTable).toHaveBeenCalledWith(
      expect.objectContaining({
        contacts: [{ ...CONTACT, conversation_count: 1 }],
        conversations: [CONVERSATION],
      }),
      expect.anything()
    );
  });
});
