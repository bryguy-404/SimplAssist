import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  anthropicCreate: vi.fn(),
  from: vi.fn(),
  resolveBusinessEntitlements: vi.fn(),
  canUseFeature: vi.fn(),
  getOutboundSendContext: vi.fn(),
  findOrCreateContact: vi.fn(),
  getOrCreateConversation: vi.fn(),
  addMessage: vi.fn(),
  insertPausedSystemMessageIfNeeded: vi.fn(),
  resolveOutboundSmsOperationalAccess: vi.fn(),
  preflightOutboundSms: vi.fn(),
  recordOutboundSmsUsage: vi.fn(),
  buildMissedCallSourceKey: vi.fn(),
  recordBusinessMetricEventBestEffort: vi.fn(),
}));

vi.mock("./client", () => ({
  telnyx: { messages: { send: mocks.send } },
}));
vi.mock("@/lib/anthropic/client", () => ({
  anthropic: { messages: { create: mocks.anthropicCreate } },
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mocks.from },
}));
vi.mock("@/lib/billing/entitlements", () => ({
  resolveBusinessEntitlements: mocks.resolveBusinessEntitlements,
  canUseFeature: mocks.canUseFeature,
}));
vi.mock("./lookup", () => ({
  getOutboundSendContext: mocks.getOutboundSendContext,
}));
vi.mock("@/lib/ai/contacts", () => ({
  findOrCreateContact: mocks.findOrCreateContact,
}));
vi.mock("@/lib/ai/conversations", () => ({
  getOrCreateConversation: mocks.getOrCreateConversation,
  addMessage: mocks.addMessage,
}));
vi.mock("./pausedNotice", () => ({
  insertPausedSystemMessageIfNeeded: mocks.insertPausedSystemMessageIfNeeded,
}));
vi.mock("./outboundSmsOperational.server", () => ({
  resolveOutboundSmsOperationalAccess:
    mocks.resolveOutboundSmsOperationalAccess,
  isOutboundSmsOperationalBlockReason: (reason: string) =>
    ["account_suspended", "texting_paused", "ai_replies_paused"].includes(
      reason
    ),
}));
vi.mock("@/lib/billing/usage", () => ({
  preflightOutboundSms: mocks.preflightOutboundSms,
  recordOutboundSmsUsage: mocks.recordOutboundSmsUsage,
}));
vi.mock("@/lib/metrics/sourceKeys.server", () => ({
  buildMissedCallSourceKey: mocks.buildMissedCallSourceKey,
}));
vi.mock("@/lib/metrics/recording.server", () => ({
  recordBusinessMetricEventBestEffort:
    mocks.recordBusinessMetricEventBestEffort,
}));

import { sendMissedCallSMS } from "./missed-call";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000001";
const CALLER = "+15745550100";
const BUSINESS_NUMBER = "+15745550200";
const CALL_SESSION_ID = "call-session-private-1";
const MISSED_CALL_SOURCE_KEY = `missed-call:${"a".repeat(64)}`;
const STARTER = {
  businessId: BUSINESS_ID,
  plan: "sms_only",
  status: "active",
  source: "subscription",
  active: true,
  cancelAtPeriodEnd: false,
};

const tableResults = new Map<string, unknown>();

function setRows(language: "en" | "es" | "both") {
  tableResults.set("businesses", {
    data: {
      name: "Green Leaf Landscaping",
      email: "hello@example.com",
      phone_number: "+15745550300",
    },
    error: null,
  });
  tableResults.set("ai_settings", { data: { language }, error: null });
  tableResults.set("phone_numbers", {
    data: { phone_number: BUSINESS_NUMBER },
    error: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  tableResults.clear();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);

  mocks.from.mockImplementation((table: string) => {
    const result = tableResults.get(table) ?? {
      data: null,
      error: { message: `Unexpected ${table} query` },
    };
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ["select", "eq", "single", "maybeSingle"]) {
      chain[method] = vi.fn(() => chain);
    }
    const promise = Promise.resolve(result);
    (chain as Record<string, unknown>).then = promise.then.bind(promise);
    (chain as Record<string, unknown>).catch = promise.catch.bind(promise);
    return chain;
  });

  mocks.resolveBusinessEntitlements.mockResolvedValue(STARTER);
  mocks.canUseFeature.mockImplementation(
    (_entitlements: unknown, feature: string) => feature === "missed_call_sms"
  );
  mocks.getOutboundSendContext.mockResolvedValue({
    businessId: BUSINESS_ID,
    smsReady: true,
    blockReason: null,
    campaignStatus: "approved",
    assignmentStatus: "assigned",
    messagingProfileId: "profile_1",
  });
  mocks.findOrCreateContact.mockResolvedValue({ id: "contact_1" });
  mocks.getOrCreateConversation.mockResolvedValue({ id: "conversation_1" });
  mocks.preflightOutboundSms.mockResolvedValue({ allowed: true });
  mocks.resolveOutboundSmsOperationalAccess.mockResolvedValue({
    allowed: true,
  });
  mocks.send.mockResolvedValue({ data: { id: "telnyx_message_1" } });
  mocks.addMessage.mockResolvedValue({ id: "message_1" });
  mocks.recordOutboundSmsUsage.mockResolvedValue(undefined);
  mocks.buildMissedCallSourceKey.mockReturnValue(MISSED_CALL_SOURCE_KEY);
  mocks.recordBusinessMetricEventBestEffort.mockReturnValue(undefined);
});

describe("sendMissedCallSMS", () => {
  it.each([
    [
      "en" as const,
      "Hi, this is Green Leaf Landscaping — saw your call come in. Just reply here with what you need and we'll get you taken care of.\n\nMsg frequency varies. Msg & data rates may apply. Reply HELP for help or STOP to opt out.",
    ],
    [
      "es" as const,
      "Hola, somos Green Leaf Landscaping — vimos tu llamada. Solo responde aquí con lo que necesitas y nos encargaremos de ayudarte.\n\nLa frecuencia de mensajes varía. Pueden aplicarse tarifas de mensajes y datos. Responde HELP para recibir ayuda o STOP para dejar de recibir mensajes.",
    ],
    [
      "both" as const,
      "Hi, this is Green Leaf Landscaping — saw your call come in. Just reply here with what you need and we'll get you taken care of.\n\nMsg frequency varies. Msg & data rates may apply. Reply HELP for help or STOP to opt out.",
    ],
  ])("sends the exact static %s template without Anthropic", async (language, expected) => {
    setRows(language);

    await sendMissedCallSMS(CALLER, BUSINESS_ID, CALL_SESSION_ID);

    expect(mocks.send).toHaveBeenCalledWith({
      from: BUSINESS_NUMBER,
      to: CALLER,
      text: expected,
      messaging_profile_id: "profile_1",
      type: "SMS",
    });
    expect(mocks.preflightOutboundSms).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      text: expected,
      purpose: "missed_call",
    });
    expect(mocks.resolveOutboundSmsOperationalAccess).toHaveBeenCalledWith(
      BUSINESS_ID,
      "missed_call"
    );
    expect(
      mocks.preflightOutboundSms.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mocks.resolveOutboundSmsOperationalAccess.mock.invocationCallOrder[0]
    );
    expect(
      mocks.resolveOutboundSmsOperationalAccess.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.send.mock.invocationCallOrder[0]);
    expect(mocks.getOrCreateConversation).toHaveBeenCalledWith(
      BUSINESS_ID,
      "contact_1",
      "sms",
      { defaultAiHandling: false }
    );
    expect(expected).toContain("\n\n");
    expect(expected).not.toContain("\\n\\n");
    expect(expected.split("\n\n")).toHaveLength(2);
    expect(mocks.addMessage).toHaveBeenCalledWith(
      "conversation_1",
      BUSINESS_ID,
      "assistant",
      expected,
      "sms"
    );
    expect(mocks.recordOutboundSmsUsage).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      text: expected,
      source: "missed_call_sms",
      providerMessageId: "telnyx_message_1",
      idempotencyKey: "outbound:missed_call:telnyx_message_1",
      metadata: { to: CALLER, from: BUSINESS_NUMBER },
    });
    expect(mocks.buildMissedCallSourceKey).toHaveBeenCalledWith(
      BUSINESS_ID,
      CALL_SESSION_ID
    );
    expect(mocks.recordBusinessMetricEventBestEffort).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      metricKey: "missed_call_caught",
      quantity: 1,
      occurredAt: expect.any(Date),
      sourceKey: MISSED_CALL_SOURCE_KEY,
      origin: null,
    });
    expect(
      mocks.send.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mocks.recordBusinessMetricEventBestEffort.mock.invocationCallOrder[0]
    );
    expect(
      mocks.recordBusinessMetricEventBestEffort.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.addMessage.mock.invocationCallOrder[0]);

    const telnyxBody = mocks.send.mock.calls[0]?.[0]?.text;
    const preflightBody = mocks.preflightOutboundSms.mock.calls[0]?.[0]?.text;
    const persistedBody = mocks.addMessage.mock.calls[0]?.[3];
    const meteredBody =
      mocks.recordOutboundSmsUsage.mock.calls[0]?.[0]?.text;
    expect([telnyxBody, preflightBody, persistedBody, meteredBody]).toEqual([
      expected,
      expected,
      expected,
      expected,
    ]);
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });

  it("keeps an accepted SMS successful when metric dispatch throws", async () => {
    setRows("en");
    mocks.recordBusinessMetricEventBestEffort.mockImplementationOnce(() => {
      throw new Error("private metric failure");
    });

    await expect(
      sendMissedCallSMS(CALLER, BUSINESS_ID, CALL_SESSION_ID)
    ).resolves.toBeUndefined();

    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.addMessage).toHaveBeenCalledOnce();
    expect(mocks.recordOutboundSmsUsage).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith(
      "[metrics] Metric dispatch failed:",
      {
        businessId: BUSINESS_ID,
        metricKey: "missed_call_caught",
      }
    );
  });

  it("does not record when Telnyx rejects the missed-call SMS", async () => {
    setRows("en");
    mocks.send.mockRejectedValueOnce(new Error("provider rejected"));

    await expect(
      sendMissedCallSMS(CALLER, BUSINESS_ID, CALL_SESSION_ID)
    ).rejects.toThrow("provider rejected");

    expect(mocks.recordBusinessMetricEventBestEffort).not.toHaveBeenCalled();
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.recordOutboundSmsUsage).not.toHaveBeenCalled();
  });

  it("treats a canceled subscription as a known no-send decision", async () => {
    mocks.canUseFeature.mockReturnValue(false);

    await expect(
      sendMissedCallSMS(CALLER, BUSINESS_ID, CALL_SESSION_ID)
    ).resolves.toBeUndefined();

    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.recordBusinessMetricEventBestEffort).not.toHaveBeenCalled();
  });

  it("rethrows indeterminate entitlement failures for the voice webhook retry path", async () => {
    mocks.resolveBusinessEntitlements.mockRejectedValue(
      new Error("subscription lookup failed")
    );

    await expect(
      sendMissedCallSMS(CALLER, BUSINESS_ID, CALL_SESSION_ID)
    ).rejects.toThrow(
      "subscription lookup failed"
    );
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.recordBusinessMetricEventBestEffort).not.toHaveBeenCalled();
  });

  it("rethrows a transient language-setting read error instead of silently defaulting", async () => {
    setRows("en");
    tableResults.set("ai_settings", {
      data: null,
      error: { message: "connection reset" },
    });

    await expect(
      sendMissedCallSMS(CALLER, BUSINESS_ID, CALL_SESSION_ID)
    ).rejects.toThrow(
      "AI language setting read failed"
    );
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.recordBusinessMetricEventBestEffort).not.toHaveBeenCalled();
  });

  it("treats a known operational block at preflight as a successful no-op", async () => {
    setRows("en");
    mocks.preflightOutboundSms.mockResolvedValue({
      allowed: false,
      reason: "account_suspended",
      message: "Account operations are suspended.",
      smsParts: 1,
    });

    await expect(
      sendMissedCallSMS(CALLER, BUSINESS_ID, CALL_SESSION_ID)
    ).resolves.toBeUndefined();

    expect(mocks.insertPausedSystemMessageIfNeeded).toHaveBeenCalledWith({
      conversationId: "conversation_1",
      businessId: BUSINESS_ID,
      channel: "sms",
      context: "missed_call",
      reason: "account_suspended",
    });
    expect(mocks.resolveOutboundSmsOperationalAccess).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.recordOutboundSmsUsage).not.toHaveBeenCalled();
    expect(mocks.recordBusinessMetricEventBestEffort).not.toHaveBeenCalled();
  });

  it("treats a texting pause at the final gate as a successful no-op", async () => {
    setRows("en");
    mocks.resolveOutboundSmsOperationalAccess.mockResolvedValue({
      allowed: false,
      reason: "texting_paused",
    });

    await expect(
      sendMissedCallSMS(CALLER, BUSINESS_ID, CALL_SESSION_ID)
    ).resolves.toBeUndefined();

    expect(mocks.preflightOutboundSms).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "missed_call" })
    );
    expect(mocks.resolveOutboundSmsOperationalAccess).toHaveBeenCalledWith(
      BUSINESS_ID,
      "missed_call"
    );
    expect(mocks.insertPausedSystemMessageIfNeeded).toHaveBeenCalledWith({
      conversationId: "conversation_1",
      businessId: BUSINESS_ID,
      channel: "sms",
      context: "missed_call",
      reason: "texting_paused",
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.recordOutboundSmsUsage).not.toHaveBeenCalled();
    expect(mocks.recordBusinessMetricEventBestEffort).not.toHaveBeenCalled();
  });

  it("rethrows indeterminate final operational state for voice webhook retry", async () => {
    setRows("en");
    mocks.resolveOutboundSmsOperationalAccess.mockRejectedValue(
      new Error("operational state unavailable")
    );

    await expect(
      sendMissedCallSMS(CALLER, BUSINESS_ID, CALL_SESSION_ID)
    ).rejects.toThrow(
      "operational state unavailable"
    );
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.recordOutboundSmsUsage).not.toHaveBeenCalled();
    expect(mocks.recordBusinessMetricEventBestEffort).not.toHaveBeenCalled();
  });
});


describe("voice fallback send boundary", () => {
  it("skips provider delivery when another handler owns the claim", async () => {
    setRows("en");
    const claim = vi.fn().mockResolvedValue(false);
    await sendMissedCallSMS(CALLER, BUSINESS_ID, CALL_SESSION_ID, { claim });
    expect(claim).toHaveBeenCalledOnce();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("claims after eligibility checks and disables ambiguous SDK retries", async () => {
    setRows("en");
    const claim = vi.fn().mockResolvedValue(true);
    await sendMissedCallSMS(CALLER, BUSINESS_ID, CALL_SESSION_ID, { claim });
    expect(claim).toHaveBeenCalledOnce();
    expect(
      mocks.resolveOutboundSmsOperationalAccess.mock.invocationCallOrder[0],
    ).toBeLessThan(claim.mock.invocationCallOrder[0]);
    expect(claim.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.send.mock.invocationCallOrder[0],
    );
    expect(mocks.send).toHaveBeenCalledWith(expect.any(Object), {
      maxRetries: 0,
      timeout: 10000,
    });
  });
  it("does not consume a delivery claim if eligibility blocks texting", async () => {
    setRows("en");
    mocks.resolveOutboundSmsOperationalAccess.mockResolvedValue({
      allowed: false,
      reason: "texting_paused",
    });
    const claim = vi.fn();
    await sendMissedCallSMS(CALLER, BUSINESS_ID, CALL_SESSION_ID, { claim });
    expect(claim).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
