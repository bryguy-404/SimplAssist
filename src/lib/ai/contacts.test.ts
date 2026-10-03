import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mocks.from },
}));

import {
  findOrCreateContact,
  updateContactEmail,
  updateContactName,
} from "./contacts";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000001";
const CONTACT_ID = "00000000-0000-4000-8000-000000000002";

const chains: Array<Record<string, ReturnType<typeof vi.fn>>> = [];

function queueResults(...results: unknown[]) {
  const queue = [...results];
  chains.length = 0;
  mocks.from.mockImplementation(() => {
    const result = queue.shift() ?? {
      data: null,
      error: { message: "Unexpected query" },
    };
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of [
      "select",
      "eq",
      "order",
      "limit",
      "maybeSingle",
      "single",
      "insert",
      "update",
    ]) {
      chain[method] = vi.fn(() => chain);
    }
    const promise = Promise.resolve(result);
    (chain as Record<string, unknown>).then = promise.then.bind(promise);
    (chain as Record<string, unknown>).catch = promise.catch.bind(promise);
    chains.push(chain);
    return chain;
  });
}

function contact(overrides: Record<string, unknown> = {}) {
  return {
    id: CONTACT_ID,
    business_id: BUSINESS_ID,
    name: null,
    phone_number: null,
    email: "visitor@example.com",
    session_id: "session-1",
    source_channel: "web_chat",
    lead_score: 0,
    notes: null,
    created_at: "2026-07-18T12:00:00.000Z",
    last_contacted_at: "2026-07-18T12:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  queueResults();
});

describe("findOrCreateContact", () => {
  it("uses the stable widget session before an optional email address", async () => {
    const existing = contact();
    const refreshed = contact({ last_contacted_at: "2026-07-18T12:01:00.000Z" });
    queueResults(
      { data: existing, error: null },
      { data: refreshed, error: null }
    );

    await expect(
      findOrCreateContact(
        BUSINESS_ID,
        null,
        "visitor@example.com",
        "web_chat",
        "session-1"
      )
    ).resolves.toEqual(refreshed);

    expect(chains[0].eq.mock.calls).toEqual([
      ["business_id", BUSINESS_ID],
      ["session_id", "session-1"],
    ]);
    expect(mocks.from).toHaveBeenCalledTimes(2);
  });

  it("creates an isolated session even when the visitor supplies an existing customer's email", async () => {
    const created = contact({ session_id: "session-2" });
    queueResults(
      { data: null, error: null },
      { data: created, error: null }
    );

    await expect(
      findOrCreateContact(
        BUSINESS_ID,
        null,
        "visitor@example.com",
        "web_chat",
        "session-2"
      )
    ).resolves.toEqual(created);

    expect(chains[0].eq).toHaveBeenCalledWith("session_id", "session-2");
    expect(chains[1].insert).toHaveBeenCalledWith(expect.objectContaining({
      session_id: "session-2", email: "visitor@example.com", business_id: BUSINESS_ID,
    }));
    for (const chain of chains) {
      expect(chain.eq).not.toHaveBeenCalledWith("email", "visitor@example.com");
    }
  });

  it("rejects a sessionless visitor before querying customer records", async () => {
    await expect(findOrCreateContact(BUSINESS_ID, null, "visitor@example.com", "web_chat"))
      .rejects.toThrow("widget session is required");
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("converges parallel find-or-create callers on the contact that wins the unique insert", async () => {
    const created = contact({
      phone_number: "+13175550100",
      email: null,
      session_id: null,
      source_channel: "sms",
    });
    const refreshed = contact({
      phone_number: "+13175550100",
      email: null,
      session_id: null,
      source_channel: "sms",
      last_contacted_at: "2026-07-18T12:01:00.000Z",
    });
    queueResults(
      { data: null, error: null },
      { data: null, error: null },
      { data: created, error: null },
      { data: null, error: { code: "23505", message: "duplicate" } },
      { data: created, error: null },
      { data: refreshed, error: null }
    );

    const [first, second] = await Promise.all([
      findOrCreateContact(
        BUSINESS_ID,
        "+13175550100",
        null,
        "sms"
      ),
      findOrCreateContact(
        BUSINESS_ID,
        "+13175550100",
        null,
        "sms"
      ),
    ]);

    expect(first.id).toBe(CONTACT_ID);
    expect(second.id).toBe(CONTACT_ID);
    expect(chains[4].eq).toHaveBeenCalledWith(
      "phone_number",
      "+13175550100"
    );
    expect(mocks.from).toHaveBeenCalledTimes(6);
  });
});

describe("contact updates", () => {
  it("rejects when saving a contact name returns a Supabase error", async () => {
    const error = { code: "42501", message: "name update denied" };
    queueResults({ data: null, error });

    await expect(updateContactName(CONTACT_ID, "Avery")).rejects.toBe(error);

    expect(chains[0].update).toHaveBeenCalledWith({ name: "Avery" });
    expect(chains[0].eq).toHaveBeenCalledWith("id", CONTACT_ID);
  });

  it("rejects when saving a contact email returns a Supabase error", async () => {
    const error = { code: "23505", message: "email already exists" };
    queueResults({ data: null, error });

    await expect(
      updateContactEmail(CONTACT_ID, "avery@example.com")
    ).rejects.toBe(error);

    expect(chains[0].update).toHaveBeenCalledWith({
      email: "avery@example.com",
    });
    expect(chains[0].eq).toHaveBeenCalledWith("id", CONTACT_ID);
  });
});
