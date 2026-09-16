import { beforeEach, describe, expect, it, vi } from "vitest";
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
  createBooking: vi.fn(),
}));
vi.mock("@/lib/ai/bookingRequests", () => ({ recordBookingRequest: vi.fn() }));
import { runVoiceDecision } from "./actionService.server";
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
    eq: (k: string, v: unknown) => {
      filters.push((r) => r[k] === v);
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
        const a = {
          id: aid,
          session_id: sid,
          business_id: "business",
          kind: args.p_kind,
          payload: args.p_payload,
          readback: args.p_readback,
          status: "awaiting_confirmation",
          playback_at: new Date().toISOString(),
          execution_started_at: null,
        };
        tables.voice_actions.push(a);
        return { data: a, error: null };
      }
      if (name === "claim_voice_action") {
        const a = tables.voice_actions[0];
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
  it("does not send on a correction", async () => {
    await runVoiceDecision(sid, propose);
    tables.voice_transcript_fragments[0].content = "Yes but another number";
    expect((await runVoiceDecision(sid, confirm)).text).toContain(
      "not an unambiguous",
    );
    expect(m.send).not.toHaveBeenCalled();
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
    await runVoiceDecision(sid, confirm);
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
  it("rearms playback tracking when genuine ambiguity needs a new permission question", async () => {
    await runVoiceDecision(sid, propose);
    tables.voice_transcript_fragments[0].content = "Yes, but to another number";
    const result = await runVoiceDecision(sid, confirm);
    expect(result.confirmationActionId).toBe(aid);
    expect(result.text).toContain("ending in 0101");
    expect(m.send).not.toHaveBeenCalled();
  });
});
