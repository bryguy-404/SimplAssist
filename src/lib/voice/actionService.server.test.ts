import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  send: vi.fn(),
  optouts: vi.fn(),
  readiness: vi.fn(),
  usage: vi.fn(),
  operational: vi.fn(),
  bookkeeping: vi.fn(),
  calendar: vi.fn(),
  book: vi.fn(),
  requestBooking: vi.fn(),
  buildDraft: vi.fn(), prepareDraft: vi.fn(), confirmDraft: vi.fn(), bookingSettings: vi.fn(), notificationDraft: vi.fn(), notificationSend: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: m.from, rpc: m.rpc },
}));
vi.mock("@/lib/messaging/client", () => ({
  telnyx: { messages: { send: m.send }, messagingOptouts: { list: m.optouts } },
}));
vi.mock("@/lib/messaging/lookup", () => ({
  getOutboundSendContext: m.readiness,
}));
vi.mock("@/lib/billing/usage", () => ({ preflightOutboundSms: m.usage }));
vi.mock("@/lib/messaging/outboundSmsOperational.server", () => ({
  resolveOutboundSmsOperationalAccess: m.operational,
}));
vi.mock("./actionRecovery.server", () => ({
  persistVoiceSmsBookkeeping: m.bookkeeping,
}));
vi.mock("@/lib/google/calendar", () => ({
  checkAvailability: m.calendar,
  createBooking: m.book,
}));
vi.mock("@/lib/ai/bookingRequests", () => ({ recordBookingRequest: m.requestBooking }));
vi.mock('@/lib/booking/drafts.server', () => ({ buildBookingDraft: m.buildDraft, prepareBookingDraft: m.prepareDraft, confirmBookingDraft: m.confirmDraft }));
vi.mock('@/lib/booking/settings.server', () => ({ getBookingSettings: m.bookingSettings }));
vi.mock('@/lib/booking/notifications.server', () => ({ getBookingNotificationDraft: m.notificationDraft, sendBookingNotification: m.notificationSend }));
import { runVoiceDecision } from "./actionService.server";
import { VoiceBookingNotSubmittedError } from "./bookingAccess.server";
import type { ActionDecision } from "./actions";
type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
const sid = "11111111-1111-4111-8111-111111111111",
  aid = "22222222-2222-4222-8222-222222222222";
function query(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let patch: Row | null = null,
    single = false;
  const q = {
    select: () => q,
    order: () => q,
    limit: () => q,
    eq: (k: string, v: unknown) => {
      filters.push((r) => r[k] === v);
      return q;
    },
    gte: (k: string, v: number) => {
      filters.push((r) => Number(r[k]) >= v);
      return q;
    },
    gt: (k: string, v: string) => {
      filters.push((r) => String(r[k] ?? "") > v);
      return q;
    },
    is: (k: string, v: unknown) => {
      filters.push((r) => (r[k] ?? null) === v);
      return q;
    },
    in: (k: string, v: unknown[]) => {
      filters.push((r) => v.includes(r[k]));
      return q;
    },
    update: (p: Row) => {
      patch = p;
      return q;
    },
    single: () => {
      single = true;
      return q;
    },
    maybeSingle: () => {
      single = true;
      return q;
    },
    then: (
      resolve: (v: unknown) => unknown,
      reject?: (e: unknown) => unknown,
    ) =>
      Promise.resolve()
        .then(() => {
          const rows = (tables[table] || []).filter((r) =>
            filters.every((f) => f(r)),
          );
          if (patch) rows.forEach((r) => Object.assign(r, patch));
          return { data: single ? (rows[0] ?? null) : rows, error: null };
        })
        .then(resolve, reject),
  };
  return q;
}
beforeEach(() => {
  vi.clearAllMocks();
  tables = {
    voice_sessions: [
      {
        id: sid,
        business_id: "business",
        action_business_id: "business",
        conversation_id: "conversation",
        status: "active",
        response_mode: "voice",
        caller_phone: "+15555550101",
        called_phone: "+15555550102",
      },
    ],
    businesses: [
      {
        id: "business",
        name: "SimplAssist",
        timezone: "America/Indiana/Indianapolis",
        primary_goal: "signup",
        goal_url: "https://simplassist.com/signup",
      },
    ],
    ai_settings: [
      {
        business_id: "business",
        booking_enabled: false,
        booking_mode: "collect_info",
      },
    ],
    voice_actions: [],
    conversations: [
      { id: "conversation", business_id: "business", contact_id: "contact" },
    ],
    voice_transcript_fragments: [
      {
        session_id: sid,
        event_id: "yes",
        content: "Yes please.",
        role: "customer",
        start_ms: 500,
        received_at: "2026-09-15T12:00:02.000Z",
      },
    ],
  };
  m.from.mockImplementation(query);
  m.rpc.mockImplementation(
    async (name: string, args: Record<string, unknown>) => {
      if (
        name === "voice_action_allowed" ||
        name === "voice_action_execution_current"
      )
        return { data: true, error: null };
      if (name === "save_voice_action_contact")
        return {
          data: {
            contactId: "contact",
            conversationId: "conversation",
            conflicts: [],
          },
          error: null,
        };
      if (name === "propose_voice_action") {
        const existing = tables.voice_actions.find(
          (a) => a.kind === args.p_kind && a.fingerprint === args.p_fingerprint,
        );
        if (existing) return { data: existing, error: null };
        for (const pending of tables.voice_actions)
          if (pending.status === "awaiting_confirmation")
            pending.status = "superseded";
        const a = {
          id: tables.voice_actions.length
            ? `22222222-2222-4222-8222-${String(tables.voice_actions.length + 1).padStart(12, "0")}`
            : aid,
          session_id: sid,
          business_id: "business",
          kind: args.p_kind,
          payload: args.p_payload,
          readback: args.p_readback,
          fingerprint: args.p_fingerprint,
          request_event_ids: args.p_event_ids,
          revision:
            Math.max(
              0,
              ...tables.voice_actions.map((a) => Number(a.revision)),
            ) + 1,
          status: "awaiting_confirmation",
          playback_at: "2026-09-15T12:00:01.000Z",
          playback_caller_end_ms: 200,
          execution_started_at: null,
        };
        tables.voice_actions.push(a);
        return { data: a, error: null };
      }
      if (name === "prepare_voice_signup_after_contact") {
        const contact = tables.voice_actions.find(
          (a) => a.id === args.p_contact_action_id,
        );
        if (contact?.kind !== "contact" || contact.status !== "succeeded")
          throw new Error("Contact success must be persisted first");
        const previous = tables.voice_actions.find((a) => a.kind === "signup");
        if (previous) {
          if (
            previous.status === "superseded" &&
            Number(previous.revision) < Number(contact.revision) &&
            previous.fingerprint === args.p_fingerprint &&
            !previous.confirmed_at &&
            !previous.source_message_id &&
            !previous.execution_started_at &&
            !previous.result &&
            !previous.error_code
          )
            Object.assign(previous, {
              status: "awaiting_confirmation",
              revision: Number(contact.revision) + 1,
              request_event_ids: contact.request_event_ids,
              readback: args.p_readback,
              playback_at: null,
              playback_event_id: null,
              playback_caller_end_ms: null,
              readback_event_ids: null,
              confirmation_event_ids: null,
            });
          return {
            data:
              previous.status === "awaiting_confirmation" &&
              previous.fingerprint === args.p_fingerprint
                ? previous
                : null,
            error: null,
          };
        }
        const next = {
          id: "33333333-3333-4333-8333-333333333333",
          session_id: sid,
          business_id: "business",
          kind: "signup",
          payload: args.p_payload,
          fingerprint: args.p_fingerprint,
          readback: args.p_readback,
          request_event_ids: contact.request_event_ids,
          revision: Number(contact.revision) + 1,
          status: "awaiting_confirmation",
          playback_at: null,
          playback_event_id: null,
          playback_caller_end_ms: null,
          confirmation_event_ids: null,
          execution_started_at: null,
        };
        tables.voice_actions.push(next);
        return { data: next, error: null };
      }
      if (name === "claim_voice_action") {
        const a = tables.voice_actions.find((a) => a.id === args.p_action_id)!;
        a.status = "executing";
        a.source_message_id = "source";
        return { data: { ...a }, error: null };
      }
      throw new Error("Unexpected RPC");
    },
  );
  m.readiness.mockResolvedValue({
    smsReady: true,
    businessId: "business",
    messagingProfileId: "profile",
  });
  m.usage.mockResolvedValue({ allowed: true });
  m.operational.mockResolvedValue({ allowed: true });
  m.send.mockResolvedValue({ data: { id: "message-1" } });
  m.bookkeeping.mockResolvedValue(undefined);
  m.book.mockResolvedValue({ eventId: "event", summary: "Estimate", startTime: "2026-10-01T14:00:00Z" });
  m.requestBooking.mockResolvedValue(undefined);
  m.optouts.mockImplementation(async function* () {});
});
const propose: ActionDecision = {
  intent: "propose",
  payload: { kind: "signup" },
  requestEventIds: ["request"],
};
const confirm: ActionDecision = {
  intent: "confirm",
  actionId: aid,
  readbackEventIds: ["readback"],
  confirmationEventIds: ["yes"],
};
describe("voice signup execution", () => {
  it("proposes without sending, then sends once only to the calling number", async () => {
    expect((await runVoiceDecision(sid, propose)).confirmationActionId).toBe(
      aid,
    );
    expect(m.send).not.toHaveBeenCalled();
    const result = await runVoiceDecision(sid, confirm);
    expect(result.text).toContain("not yet confirmed");
    expect(m.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+15555550101",
        from: "+15555550102",
        text: expect.stringContaining("https://simplassist.com/signup"),
      }),
      expect.objectContaining({ maxRetries: 0 }),
    );
    await runVoiceDecision(sid, confirm);
    expect(m.send).toHaveBeenCalledTimes(1);
  });
  it("does not execute when the semantic decision asks to clarify a correction", async () => {
    await runVoiceDecision(sid, propose);
    const result = await runVoiceDecision(sid, {
      intent: "answer",
      text: "I can only send to the number calling. Would you like that?",
    });
    expect(result.text).toContain("number calling");
    expect(m.send).not.toHaveBeenCalled();
    expect(tables.voice_actions[0].status).toBe("awaiting_confirmation");
  });
  it("refuses changed signup links after permission", async () => {
    await runVoiceDecision(sid, propose);
    tables.businesses[0].goal_url = "https://simplassist.com/other";
    await runVoiceDecision(sid, confirm);
    expect(m.send).not.toHaveBeenCalled();
    expect(tables.voice_actions[0].status).toBe("failed");
  });
  it("respects opt-out even after verbal permission", async () => {
    await runVoiceDecision(sid, propose);
    m.optouts.mockImplementation(async function* () {
      yield { to: "+15555550101" };
    });
    await runVoiceDecision(sid, confirm);
    expect(m.send).not.toHaveBeenCalled();
  });
  it("preserves uncertainty and does not retry a lost send response", async () => {
    await runVoiceDecision(sid, propose);
    m.send.mockRejectedValue(new Error("timeout"));
    expect((await runVoiceDecision(sid, confirm)).text).toContain(
      "couldn't verify",
    );
    expect(tables.voice_actions[0].status).toBe("uncertain");
    await runVoiceDecision(sid, confirm);
    expect(m.send).toHaveBeenCalledTimes(1);
  });
  it("does not resend after successful provider acceptance but failed bookkeeping", async () => {
    await runVoiceDecision(sid, propose);
    m.bookkeeping.mockRejectedValue(new Error("db lost"));
    await runVoiceDecision(sid, confirm);
    expect(tables.voice_actions[0].status).toBe("succeeded");
    expect(tables.voice_actions[0].sms_provider_message_id).toBeTruthy();
    expect(tables.voice_actions[0].sms_accepted_at).toEqual(expect.any(String));
    const acceptedAt = tables.voice_actions[0].sms_accepted_at;
    await runVoiceDecision(sid, confirm);
    expect(tables.voice_actions[0].sms_accepted_at).toBe(acceptedAt);
    expect(m.send).toHaveBeenCalledTimes(1);
  });
  it("stops before sending if the caller changes details after confirmation", async () => {
    await runVoiceDecision(sid, propose);
    const original = m.rpc.getMockImplementation()!;
    let checks = 0;
    m.rpc.mockImplementation(async (name, args) => {
      if (name === "voice_action_execution_current" && ++checks === 2)
        return { data: false, error: null };
      return original(name, args);
    });
    await runVoiceDecision(sid, confirm);
    expect(m.send).not.toHaveBeenCalled();
    expect(tables.voice_actions[0].status).toBe("failed");
  });
  it("does not offer signup when configured for booking", async () => {
    tables.businesses[0].primary_goal = "book";
    await expect(runVoiceDecision(sid, propose)).rejects.toThrow("disabled");
    expect(m.send).not.toHaveBeenCalled();
  });
});

describe("voice booking execution", () => {
  const booking: ActionDecision = {
    intent: "propose",
    payload: { kind: "booking", name: "Caller", phone: "+15555550101", email: "caller@example.test", service: "Estimate", startTime: "2026-10-01T10:00:00" },
    requestEventIds: ["request"],
  };
  beforeEach(() => {
    tables.businesses[0].primary_goal = "book";
    Object.assign(tables.ai_settings[0], { booking_enabled: true, booking_mode: "schedule_direct" });
    tables.voice_availability = [{ session_id: sid, date: "2026-10-01", slots: ["10:00 AM"], checked_at: new Date().toISOString() }];
  });

  it.each(["Yes, please", "Sure", "Yeah, that's fine"])("books exactly once after the complete interpreted confirmation: %s", async (reply) => {
    expect((await runVoiceDecision(sid, booking)).confirmationActionId).toBe(aid);
    expect(m.book).not.toHaveBeenCalled();
    tables.voice_transcript_fragments[0].content = reply;
    const result = await runVoiceDecision(sid, confirm);
    expect(result.text).toContain("appointment is confirmed");
    expect(m.book).toHaveBeenCalledWith("business", {
      customerName: "Caller", customerPhone: "+15555550101", customerEmail: "caller@example.test",
      serviceName: "Estimate", startTime: "2026-10-01T10:00:00",
    }, "America/Indiana/Indianapolis", {
      contactId: "contact", conversationId: "conversation", sourceMessageId: "source",
    }, { sessionId: sid, actionId: aid });
    await runVoiceDecision(sid, confirm);
    expect(m.book).toHaveBeenCalledOnce();
    expect(m.send).not.toHaveBeenCalled();
  });

  it("requires fresh offered availability before proposing an appointment", async () => {
    tables.voice_availability[0].checked_at = new Date(Date.now() - 301_000).toISOString();
    expect((await runVoiceDecision(sid, booking)).text).toContain("Check current availability");
    expect(tables.voice_actions).toHaveLength(0);
    expect(m.book).not.toHaveBeenCalled();
  });

  it("does not execute a yes that omits a later caller correction", async () => {
    await runVoiceDecision(sid, booking);
    tables.voice_transcript_fragments.push({ ...tables.voice_transcript_fragments[0], event_id: "correction", start_ms: 700, content: ", wait, use another day" });
    expect((await runVoiceDecision(sid, confirm)).confirmationActionId).toBe(aid);
    expect(m.book).not.toHaveBeenCalled();
  });

  it("reports proven pre-submission refusal as failed and does not retry it", async () => {
    await runVoiceDecision(sid, booking);
    m.book.mockRejectedValue(new VoiceBookingNotSubmittedError());
    expect((await runVoiceDecision(sid, confirm)).text).toContain("could not be completed");
    expect(tables.voice_actions[0].status).toBe("failed");
    await runVoiceDecision(sid, confirm);
    expect(m.book).toHaveBeenCalledOnce();
  });

  it("does not claim success or submit again after an uncertain calendar result", async () => {
    await runVoiceDecision(sid, booking);
    m.book.mockRejectedValue(new Error("provider timeout"));
    expect((await runVoiceDecision(sid, confirm)).text).toContain("couldn't verify");
    expect(tables.voice_actions[0].status).toBe("uncertain");
    await runVoiceDecision(sid, confirm);
    expect(m.book).toHaveBeenCalledOnce();
  });

  it("saves a request in collect-info mode without claiming an appointment or inviting anyone", async () => {
    tables.ai_settings[0].booking_mode = "collect_info";
    await runVoiceDecision(sid, { intent: "propose", payload: {
      kind: "booking_request", name: "Caller", phone: "+15555550101", email: "caller@example.test",
      service: "Estimate", requestedTime: "Next week in the morning",
    }, requestEventIds: ["request"] });
    expect((await runVoiceDecision(sid, confirm)).text).toContain("not a confirmed appointment");
    expect(m.requestBooking).toHaveBeenCalledWith(expect.objectContaining({
      businessId: "business", requestedTimeText: "Next week in the morning", customerEmail: "caller@example.test",
    }));
    await runVoiceDecision(sid, confirm);
    expect(m.requestBooking).toHaveBeenCalledOnce();
    expect(m.book).not.toHaveBeenCalled();
  });
});

describe("spoken signup permission", () => {
  it.each([
    [" Yes", ", that", " works"],
    [" Yes", ", please"],
    [" Ye", "s,", " please"],
  ])(
    "sends once after a clear fragmented spoken confirmation: %j",
    async (...parts) => {
      await runVoiceDecision(sid, propose);
      tables.voice_transcript_fragments = parts.map((content, i) => ({
        session_id: sid,
        event_id: `yes-${i}`,
        content,
        role: "customer",
        start_ms: 500 + i * 200,
        received_at: "2026-09-15T12:00:02.000Z",
      }));
      const decision: ActionDecision = {
        ...confirm,
        confirmationEventIds: parts.map((_, i) => `yes-${i}`),
      };
      const result = await runVoiceDecision(sid, decision);
      expect(result.text).toContain("accepted for sending");
      await runVoiceDecision(sid, decision);
      expect(m.send).toHaveBeenCalledOnce();
    },
  );
  it("rearms playback tracking when the decision omitted part of the reply", async () => {
    await runVoiceDecision(sid, propose);
    tables.voice_transcript_fragments.push({
      ...tables.voice_transcript_fragments[0],
      event_id: "correction",
      content: ", but to another number",
    });
    const result = await runVoiceDecision(sid, confirm);
    expect(result.confirmationActionId).toBe(aid);
    expect(result.text).toContain("ending in 0101");
    expect(m.send).not.toHaveBeenCalled();
  });
});

describe("semantic permission with complete current evidence", () => {
  it.each([
    "Yes, that-that's correct",
    "Yes, you can save those",
    "Uh yes, please",
    "Go right ahead and save that for me",
  ])(
    "saves contacts once for model-interpreted permission: %s",
    async (reply) => {
      await runVoiceDecision(sid, {
        intent: "propose",
        payload: {
          kind: "contact",
          name: "Test Caller",
          phone: "+15555550101",
          email: "test@example.test",
        },
        requestEventIds: ["request"],
      });
      tables.voice_transcript_fragments[0].content = reply;
      expect((await runVoiceDecision(sid, confirm)).text).toContain(
        "contact details were saved",
      );
      await runVoiceDecision(sid, confirm);
      expect(
        m.rpc.mock.calls.filter(
          ([name]) => name === "save_voice_action_contact",
        ),
      ).toHaveLength(1);
      expect(m.send).not.toHaveBeenCalled();
    },
  );
  it("rejects a selected yes that leaves out a condition, even if it ends the reply", async () => {
    await runVoiceDecision(sid, propose);
    tables.voice_transcript_fragments.unshift({
      ...tables.voice_transcript_fragments[0],
      event_id: "condition",
      start_ms: 300,
      content: "If it is free, ",
    });
    const result = await runVoiceDecision(sid, confirm);
    expect(result.text).toContain("complete current caller response");
    expect(
      m.rpc.mock.calls.some(([name]) => name === "claim_voice_action"),
    ).toBe(false);
    expect(m.send).not.toHaveBeenCalled();
  });
  it("rejects a correction arriving after the model selected its evidence", async () => {
    await runVoiceDecision(sid, propose);
    tables.voice_transcript_fragments.push({
      ...tables.voice_transcript_fragments[0],
      event_id: "later",
      start_ms: 700,
      content: ", wait, don't send it",
    });
    expect((await runVoiceDecision(sid, confirm)).confirmationActionId).toBe(
      aid,
    );
    expect(m.send).not.toHaveBeenCalled();
  });
  it("cannot reuse consent from before the current readback", async () => {
    await runVoiceDecision(sid, propose);
    tables.voice_transcript_fragments[0].received_at =
      "2026-09-15T12:00:00.000Z";
    expect((await runVoiceDecision(sid, confirm)).confirmationActionId).toBe(
      aid,
    );
    expect(m.send).not.toHaveBeenCalled();
  });
  it("ignores a delayed older fragment outside the current spoken response window", async () => {
    await runVoiceDecision(sid, propose);
    tables.voice_transcript_fragments.push({
      ...tables.voice_transcript_fragments[0],
      event_id: "delayed-old",
      start_ms: 100,
      content: "An earlier question",
    });
    expect((await runVoiceDecision(sid, confirm)).text).toContain(
      "accepted for sending",
    );
    expect(m.send).toHaveBeenCalledOnce();
  });
  it("cannot confirm a proposal without recorded playback", async () => {
    await runVoiceDecision(sid, propose);
    tables.voice_actions[0].playback_at = null;
    expect((await runVoiceDecision(sid, confirm)).text).toContain(
      "not been acknowledged as played",
    );
    expect(m.send).not.toHaveBeenCalled();
  });
});

describe("saved-contact signup continuation", () => {
  const contactProposal: ActionDecision = {
    intent: "propose",
    payload: {
      kind: "contact",
      name: "Test Caller",
      phone: "+15555550101",
      email: "test@example.test",
    },
    requestEventIds: ["request"],
  };
  async function saveContact() {
    await runVoiceDecision(sid, contactProposal);
    return runVoiceDecision(sid, confirm);
  }

  it("persists the contact before returning a prepared signup permission question without sending", async () => {
    const result = await saveContact();
    const next = tables.voice_actions[1];
    expect(tables.voice_actions[0].status).toBe("succeeded");
    expect(result.text).toContain("contact details were saved");
    expect(result.text).toContain(String(next.readback));
    expect(result.text).toContain(
      "If the caller has declined signup or is finished",
    );
    expect(result.text).toContain("Wait for a fresh clear reply");
    expect(result.confirmationActionId).toBe(next.id);
    expect(next).toMatchObject({
      status: "awaiting_confirmation",
      request_event_ids: ["request"],
      confirmation_event_ids: null,
      playback_at: null,
    });
    expect(m.rpc).toHaveBeenCalledWith(
      "prepare_voice_signup_after_contact",
      expect.objectContaining({
        p_contact_action_id: aid,
        p_payload: {
          kind: "signup",
          approvedUrl: "https://simplassist.com/signup",
        },
      }),
    );
    expect(m.send).not.toHaveBeenCalled();
  });

  it("requires the new signup readback and fresh assent rather than reusing contact permission", async () => {
    await saveContact();
    const next = tables.voice_actions[1];
    const signupConfirm: ActionDecision = {
      ...confirm,
      actionId: String(next.id),
      readbackEventIds: ["signup-readback"],
    };
    expect((await runVoiceDecision(sid, signupConfirm)).text).toContain(
      "not been acknowledged as played",
    );
    expect(m.send).not.toHaveBeenCalled();
    Object.assign(next, {
      playback_at: "2026-09-15T12:00:04.000Z",
      playback_event_id: "signup-readback",
      playback_caller_end_ms: 1000,
    });
    tables.voice_transcript_fragments.push({
      session_id: sid,
      event_id: "signup-yes",
      role: "customer",
      content: "Yes, text it to me.",
      start_ms: 1200,
      received_at: "2026-09-15T12:00:05.000Z",
    });
    expect((await runVoiceDecision(sid, signupConfirm)).text).toContain(
      "complete current caller response",
    );
    expect(m.send).not.toHaveBeenCalled();
    const result = await runVoiceDecision(sid, {
      ...signupConfirm,
      confirmationEventIds: ["signup-yes"],
    });
    expect(result.text).toContain("accepted for sending");
    expect(m.send).toHaveBeenCalledOnce();
  });

  it("returns the same pending signup on replayed contact confirmations and proposals", async () => {
    const first = await saveContact();
    const repeatedConfirmation = await runVoiceDecision(sid, confirm);
    const repeatedProposal = await runVoiceDecision(sid, contactProposal);
    expect(repeatedConfirmation.confirmationActionId).toBe(
      first.confirmationActionId,
    );
    expect(repeatedProposal.confirmationActionId).toBe(
      first.confirmationActionId,
    );
    expect(tables.voice_actions).toHaveLength(2);
    expect(
      m.rpc.mock.calls.filter(([name]) => name === "save_voice_action_contact"),
    ).toHaveLength(1);
    expect(m.send).not.toHaveBeenCalled();
  });

  it("rearms a stored signup readback when its first response was suppressed before playback", async () => {
    // Contact save committed, but the worker discarded the returned offer when
    // the caller spoke again. The next delegation must recover the same offer.
    await saveContact();
    const next = tables.voice_actions[1];
    const result = await runVoiceDecision(sid, {
      intent: "readback",
      actionId: String(next.id),
    });
    expect(next.playback_at).toBeNull();
    expect(result.confirmationActionId).toBe(next.id);
    expect(result.text).toContain(String(next.readback));
    expect(result.text).toContain("fresh clear reply");
    expect(tables.voice_actions).toHaveLength(2);
    expect(tables.voice_actions[0].status).toBe("succeeded");
    expect(m.send).not.toHaveBeenCalled();
  });

  it("continues after corrected contact details with new signup playback and new text permission", async () => {
    await saveContact();
    const signup = tables.voice_actions[1];
    Object.assign(signup, {
      playback_at: "2026-09-15T12:00:04.000Z",
      playback_event_id: "old-signup-readback",
      playback_caller_end_ms: 1000,
    });
    tables.voice_transcript_fragments.push(
      {
        session_id: sid,
        event_id: "old-signup-yes",
        role: "customer",
        content: "Yes",
        start_ms: 1200,
        received_at: "2026-09-15T12:00:05.000Z",
      },
      {
        session_id: sid,
        event_id: "corrected-request",
        role: "customer",
        content: "Actually my email is corrected@example.test",
        start_ms: 1400,
        received_at: "2026-09-15T12:00:06.000Z",
      },
    );
    await runVoiceDecision(sid, {
      ...contactProposal,
      payload: {
        kind: "contact",
        name: "Test Caller",
        phone: "+15555550101",
        email: "corrected@example.test",
      },
      requestEventIds: ["corrected-request"],
    });
    const corrected = tables.voice_actions[2];
    expect(signup.status).toBe("superseded");
    Object.assign(corrected, {
      playback_at: "2026-09-15T12:00:07.000Z",
      playback_event_id: "corrected-readback",
      playback_caller_end_ms: 1600,
    });
    tables.voice_transcript_fragments.push({
      session_id: sid,
      event_id: "corrected-save-yes",
      role: "customer",
      content: "Yes, save those",
      start_ms: 1800,
      received_at: "2026-09-15T12:00:08.000Z",
    });
    const result = await runVoiceDecision(sid, {
      ...confirm,
      actionId: String(corrected.id),
      readbackEventIds: ["corrected-readback"],
      confirmationEventIds: ["corrected-save-yes"],
    });
    expect(result.confirmationActionId).toBe(signup.id);
    expect(signup).toMatchObject({
      status: "awaiting_confirmation",
      revision: 4,
      request_event_ids: ["corrected-request"],
      playback_at: null,
      playback_event_id: null,
      confirmation_event_ids: null,
    });
    const staleSignupConfirm: ActionDecision = {
      ...confirm,
      actionId: String(signup.id),
      readbackEventIds: ["old-signup-readback"],
      confirmationEventIds: ["old-signup-yes"],
    };
    expect((await runVoiceDecision(sid, staleSignupConfirm)).text).toContain(
      "not been acknowledged as played",
    );
    expect(m.send).not.toHaveBeenCalled();
    expect(
      (
        await runVoiceDecision(sid, {
          intent: "readback",
          actionId: String(signup.id),
        })
      ).confirmationActionId,
    ).toBe(signup.id);
    Object.assign(signup, {
      playback_at: "2026-09-15T12:00:09.000Z",
      playback_event_id: "fresh-signup-readback",
      playback_caller_end_ms: 2000,
    });
    tables.voice_transcript_fragments.push({
      session_id: sid,
      event_id: "fresh-signup-yes",
      role: "customer",
      content: "Yes, text it",
      start_ms: 2200,
      received_at: "2026-09-15T12:00:10.000Z",
    });
    expect((await runVoiceDecision(sid, staleSignupConfirm)).text).toContain(
      "complete current caller response",
    );
    expect(m.send).not.toHaveBeenCalled();
    expect(
      (
        await runVoiceDecision(sid, {
          ...staleSignupConfirm,
          readbackEventIds: ["fresh-signup-readback"],
          confirmationEventIds: ["fresh-signup-yes"],
        })
      ).text,
    ).toContain("accepted for sending");
    expect(m.send).toHaveBeenCalledOnce();
  });

  it("returns only stored pending details and their action ID when readback needs replay", async () => {
    await runVoiceDecision(sid, contactProposal);
    const pending = tables.voice_actions[0];
    pending.playback_at = null;
    const result = await runVoiceDecision(sid, {
      intent: "readback",
      actionId: aid,
    });
    expect(result.text).toContain(String(pending.readback));
    expect(result.confirmationActionId).toBe(aid);
    expect(pending.status).toBe("awaiting_confirmation");
    expect(
      m.rpc.mock.calls.some(([name]) => name === "claim_voice_action"),
    ).toBe(false);
    expect(m.send).not.toHaveBeenCalled();
  });

  it("cannot rearm an action from a different call", async () => {
    await runVoiceDecision(sid, contactProposal);
    await expect(
      runVoiceDecision(sid, {
        intent: "readback",
        actionId: "44444444-4444-4444-8444-444444444444",
      }),
    ).rejects.toThrow("voice_action_missing");
    expect(m.send).not.toHaveBeenCalled();
  });

  it.each(["succeeded", "failed", "uncertain", "executing", "superseded"])(
    "does not retry an already %s signup when a contact result is replayed",
    async (status) => {
      await saveContact();
      tables.voice_actions[1].status = status;
      const result = await runVoiceDecision(sid, confirm);
      expect(result.confirmationActionId).toBeUndefined();
      expect(result.text).toContain("contact details were saved");
      expect(tables.voice_actions).toHaveLength(2);
      expect(tables.voice_actions[1].status).toBe(status);
      expect(m.send).not.toHaveBeenCalled();
    },
  );

  it("does not prepare signup when the current goal is booking", async () => {
    tables.businesses[0].primary_goal = "book";
    const result = await saveContact();
    expect(result.confirmationActionId).toBeUndefined();
    expect(tables.voice_actions).toHaveLength(1);
    expect(
      m.rpc.mock.calls.some(
        ([name]) => name === "prepare_voice_signup_after_contact",
      ),
    ).toBe(false);
    expect(m.send).not.toHaveBeenCalled();
  });

  it("respects a disabled signup capability while keeping successful contact capture", async () => {
    const original = m.rpc.getMockImplementation()!;
    m.rpc.mockImplementation(async (name, args) => {
      if (name === "voice_action_allowed" && args.p_kind === "signup")
        return { data: false, error: null };
      return original(name, args);
    });
    const result = await saveContact();
    expect(result.confirmationActionId).toBeUndefined();
    expect(tables.voice_actions[0].status).toBe("succeeded");
    expect(tables.voice_actions).toHaveLength(1);
    expect(m.send).not.toHaveBeenCalled();
  });

  it("preserves contact success if the call ends before the continuation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const original = m.rpc.getMockImplementation()!;
    m.rpc.mockImplementation(async (name, args) => {
      const result = await original(name, args);
      if (name === "save_voice_action_contact")
        tables.voice_sessions[0].status = "closed";
      return result;
    });
    const result = await saveContact();
    expect(result.text).toContain("contact details were saved");
    expect(result.confirmationActionId).toBeUndefined();
    expect(tables.voice_actions[0].status).toBe("succeeded");
    expect(tables.voice_actions).toHaveLength(1);
    warn.mockRestore();
  });

  it("preserves saved success and logs no private error body if preparation fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const original = m.rpc.getMockImplementation()!;
    m.rpc.mockImplementation(async (name, args) => {
      if (name === "prepare_voice_signup_after_contact")
        return {
          data: null,
          error: { message: "private customer/provider data" },
        };
      return original(name, args);
    });
    const result = await saveContact();
    expect(result.text).toContain("contact details were saved");
    expect(result.confirmationActionId).toBeUndefined();
    expect(tables.voice_actions[0].status).toBe("succeeded");
    expect(warn).toHaveBeenCalledWith(
      "[voice-actions] signup_continuation_unavailable",
      { sessionId: sid, actionId: aid, category: "preparation_failed" },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
    expect(m.send).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it.each([null, { id: null, session_id: null, kind: null, status: null }])(
    "honors an atomic guard refusal (%j) when a newer action appeared",
    async (emptyResult) => {
      const original = m.rpc.getMockImplementation()!;
      m.rpc.mockImplementation(async (name, args) => {
        if (name === "prepare_voice_signup_after_contact") {
          tables.voice_actions.push({
            id: "newer-correction",
            session_id: sid,
            kind: "contact",
            status: "awaiting_confirmation",
            revision: 2,
          });
          return { data: emptyResult, error: null };
        }
        return original(name, args);
      });
      const result = await saveContact();
      expect(result.confirmationActionId).toBeUndefined();
      expect(tables.voice_actions[0].status).toBe("succeeded");
      expect(tables.voice_actions[1].status).toBe("awaiting_confirmation");
      expect(tables.voice_actions.some((a) => a.kind === "signup")).toBe(false);
      expect(m.send).not.toHaveBeenCalled();
    },
  );
});


describe('revisioned voice booking and separate text permission', () => {
  const draftId='44444444-4444-4444-8444-444444444444';
  const serviceId='55555555-5555-4555-8555-555555555555';
  beforeEach(()=>{
    vi.stubEnv('BOOKING_CONFIRMATION_V2_ENABLED','true');
    tables.businesses[0].primary_goal='book';
    Object.assign(tables.ai_settings[0],{booking_enabled:true,booking_mode:'schedule_direct'});
    tables.voice_availability=[{session_id:sid,date:'2026-10-01',slots:['10:00 AM'],checked_at:new Date().toISOString(),service_id:serviceId,settings_revision:1}];
    tables.booking_drafts=[{id:draftId,business_id:'business',voice_action_id:aid,revision:1,status:'preparing'}];
    m.bookingSettings.mockResolvedValue({revision:1});
    m.buildDraft.mockResolvedValue({snapshot:{offering:{serviceName:'Estimate'}},summary:'May I book the confirmed callback details?'});
    m.prepareDraft.mockResolvedValue({id:draftId,revision:1});
    m.confirmDraft.mockImplementation(async()=>{tables.booking_drafts[0].status='confirmed';return{status:'confirmed',summary:'Your callback appointment is confirmed.'};});
    m.notificationDraft.mockResolvedValue({id:draftId,revision:1,status:'confirmed'});
    m.notificationSend.mockResolvedValue({summary:'Text accepted; let me know when it arrives.',deliveryStatus:'accepted'});
  });
  afterEach(()=>vi.unstubAllEnvs());
  it('books once then prepares, but does not send, the final text offer',async()=>{
    const p:ActionDecision={intent:'propose',payload:{kind:'booking',name:'Caller',phone:'+15555550101',service:'Estimate',serviceId,emailAsked:true,startTime:'2026-10-01T10:00:00'},requestEventIds:['request']};
    await runVoiceDecision(sid,p);
    const result=await runVoiceDecision(sid,confirm);
    expect(m.confirmDraft).toHaveBeenCalledTimes(1);
    expect(result.text).toContain('callback appointment is confirmed');
    expect(tables.voice_actions[1].kind).toBe('booking_confirmation_text');
    expect(result.confirmationActionId).toBe(tables.voice_actions[1].id);
    expect(m.notificationSend).not.toHaveBeenCalled();
    await runVoiceDecision(sid,{...confirm,actionId:String(tables.voice_actions[1].id)});
    expect(m.notificationSend).toHaveBeenCalledTimes(1);
    expect(m.confirmDraft).toHaveBeenCalledTimes(1);
    expect(m.rpc.mock.calls.filter(([name])=>name==='save_voice_action_contact')).toHaveLength(1);
  });
  it('text permission does not execute the pending booking or overwrite caller details',async()=>{
    tables.booking_drafts[0].status='preparing';
    await runVoiceDecision(sid,{intent:'propose',payload:{kind:'booking_review_text',draftId,revision:1},requestEventIds:['request']});
    await runVoiceDecision(sid,confirm);
    expect(m.notificationSend).toHaveBeenCalledTimes(1);
    expect(m.confirmDraft).not.toHaveBeenCalled();
    expect(m.rpc.mock.calls.some(([name])=>name==='save_voice_action_contact')).toBe(false);
  });
});
