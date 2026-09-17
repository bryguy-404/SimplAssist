vi.mock('server-only', () => ({}));
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  OperationalControlsResolutionError: class OperationalControlsResolutionError extends Error {
    readonly retryable = true;
    readonly code: string;
    readonly businessId: string;

    constructor(args: {
      code: string;
      businessId: string;
      message: string;
    }) {
      super(args.message);
      this.name = "OperationalControlsResolutionError";
      this.code = args.code;
      this.businessId = args.businessId;
    }
  },
  BookingOperationalBlockedError: class BookingOperationalBlockedError extends Error {
    readonly businessId: string;
    readonly reason: "account_suspended" | "bookings_paused";

    constructor(
      businessId: string,
      reason: "account_suspended" | "bookings_paused"
    ) {
      super("Booking is currently unavailable.");
      this.name = "BookingOperationalBlockedError";
      this.businessId = businessId;
      this.reason = reason;
    }
  },
  BookingOperationalStateError: class BookingOperationalStateError extends Error {
    readonly retryable = true;
    readonly businessId: string;
    readonly code = "booking_cleanup_failed";

    constructor(args: { businessId: string; message: string }) {
      super(args.message);
      this.name = "BookingOperationalStateError";
      this.businessId = args.businessId;
    }
  },
  AIReplyIdempotencyConflictError: class AIReplyIdempotencyConflictError extends Error {},
  AIReplyMeteringStateError: class AIReplyMeteringStateError extends Error {},
  WebChatMessageIdempotencyConflictError: class WebChatMessageIdempotencyConflictError extends Error {},
  bookingContext: vi.fn(), prepareDraft: vi.fn(), confirmDraft: vi.fn(), acknowledgeDraft: vi.fn(),
  anthropicCreate: vi.fn(),
  from: vi.fn(),
  resolveBusinessOperationalControls: vi.fn(),
  resolveBusinessEntitlements: vi.fn(),
  canUseFeature: vi.fn(),
  findOrCreateContact: vi.fn(),
  incrementLeadScore: vi.fn(),
  updateContactName: vi.fn(),
  updateContactEmail: vi.fn(),
  getOrCreateConversation: vi.fn(),
  addMessage: vi.fn(),
  addWebChatInboundMessageOnce: vi.fn(),
  getConversationById: vi.fn(),
  getConversationAiState: vi.fn(),
  getConversationHistory: vi.fn(),
  buildSystemPrompt: vi.fn(),
  buildConversationMessages: vi.fn(),
  parseKnowledgeGapSignal: vi.fn(),
  recordBookingRequest: vi.fn(),
  shouldIncludeBookingRequestTools: vi.fn(),
  shouldIncludeCalendarTools: vi.fn(),
  checkAvailability: vi.fn(),
  createBooking: vi.fn(),
  getCompletedAIReply: vi.fn(),
  reserveAIReplyUnit: vi.fn(),
  finalizeAIReplyUnit: vi.fn(),
  releaseAIReplyUnit: vi.fn(),
  recordAnthropicProviderCall: vi.fn(),
}));

vi.mock('@/lib/booking/modelContext.server', () => ({ getBookingModelContext: mocks.bookingContext }));
vi.mock('@/lib/booking/drafts.server', () => ({ prepareBookingDraft: mocks.prepareDraft, confirmBookingDraft: mocks.confirmDraft, acknowledgeBookingSummary: mocks.acknowledgeDraft, BookingInputError: class extends Error {} }));
vi.mock("@/lib/anthropic/client", () => ({
  meteredAnthropic: { messages: { create: mocks.anthropicCreate } },
}));
vi.mock("@/lib/account/operationalControls.server", () => ({
  OperationalControlsResolutionError:
    mocks.OperationalControlsResolutionError,
  resolveBusinessOperationalControls: mocks.resolveBusinessOperationalControls,
  resolveOperationalBlockReason: (
    controls: {
      operationsSuspendedAt: string | null;
      aiRepliesPausedAt: string | null;
      textingPausedAt: string | null;
      bookingsPausedAt: string | null;
    },
    requiredServices: string[] = []
  ) => {
    if (controls.operationsSuspendedAt !== null) return "account_suspended";
    for (const service of requiredServices) {
      if (service === "ai_replies" && controls.aiRepliesPausedAt !== null) {
        return "ai_replies_paused";
      }
      if (service === "texting" && controls.textingPausedAt !== null) {
        return "texting_paused";
      }
      if (service === "bookings" && controls.bookingsPausedAt !== null) {
        return "bookings_paused";
      }
    }
    return null;
  },
  isOperationalControlsResolutionError: (error: unknown) =>
    error instanceof mocks.OperationalControlsResolutionError,
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mocks.from },
}));
vi.mock("@/lib/billing/entitlements", () => ({
  EntitlementResolutionError: class EntitlementResolutionError extends Error {},
  resolveBusinessEntitlements: mocks.resolveBusinessEntitlements,
  canUseFeature: mocks.canUseFeature,
}));
vi.mock("@/lib/billing/aiReplyMeter.server", () => ({
  AIReplyIdempotencyConflictError: mocks.AIReplyIdempotencyConflictError,
  AIReplyMeteringStateError: mocks.AIReplyMeteringStateError,
  getCompletedAIReply: mocks.getCompletedAIReply,
  reserveAIReplyUnit: mocks.reserveAIReplyUnit,
  finalizeAIReplyUnit: mocks.finalizeAIReplyUnit,
  releaseAIReplyUnit: mocks.releaseAIReplyUnit,
  recordAnthropicProviderCall: mocks.recordAnthropicProviderCall,
}));
vi.mock("./contacts", () => ({
  findOrCreateContact: mocks.findOrCreateContact,
  incrementLeadScore: mocks.incrementLeadScore,
  updateContactName: mocks.updateContactName,
  updateContactEmail: mocks.updateContactEmail,
}));
vi.mock("./conversations", () => ({
  getOrCreateConversation: mocks.getOrCreateConversation,
  addMessage: mocks.addMessage,
  addWebChatInboundMessageOnce: mocks.addWebChatInboundMessageOnce,
  getConversationById: mocks.getConversationById,
  getConversationAiState: mocks.getConversationAiState,
  getConversationHistory: mocks.getConversationHistory,
  WebChatMessageIdempotencyConflictError:
    mocks.WebChatMessageIdempotencyConflictError,
  isAiHandlingActive: (conversation: {
    status: string;
    is_ai_handling: boolean;
  }) => conversation.status === "active" && conversation.is_ai_handling,
}));
vi.mock("./prompt", () => ({
  buildSystemPrompt: mocks.buildSystemPrompt,
  buildConversationMessages: mocks.buildConversationMessages,
}));
vi.mock("./knowledgeGapSignal", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./knowledgeGapSignal")>();
  mocks.parseKnowledgeGapSignal.mockImplementation(
    actual.parseKnowledgeGapSignal
  );
  return {
    ...actual,
    parseKnowledgeGapSignal: mocks.parseKnowledgeGapSignal,
  };
});
vi.mock("./bookingRequests", () => ({
  recordBookingRequest: mocks.recordBookingRequest,
}));
vi.mock("./tools", () => ({
  signupGoalTools: [
    {
      name: "offer_goal_link",
      description: "signup",
      input_schema: { type: "object", properties: {}, required: [] },
    },
  ],
  bookingRequestTools: [
    {
      name: "record_booking_request",
      description: "request",
      input_schema: {
        type: "object",
        properties: {
          requested_service: { type: "string" },
          requested_time_text: { type: "string" },
          customer_name: { type: "string" },
          customer_phone: { type: "string" },
          customer_email: { type: "string" },
        },
        required: ["requested_service", "requested_time_text"],
      },
    },
  ],
  calendarTools: [
    {
      name: "check_availability",
      description: "calendar",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "create_booking",
      description: "calendar",
      input_schema: { type: "object", properties: {} },
    },
  ],
  shouldIncludeBookingRequestTools:
    mocks.shouldIncludeBookingRequestTools,
  shouldIncludeCalendarTools: mocks.shouldIncludeCalendarTools,
}));
vi.mock("@/lib/google/calendar", () => ({
  checkAvailability: mocks.checkAvailability,
  createBooking: mocks.createBooking,
}));
vi.mock("@/lib/google/bookingOperational.server", () => ({
  BookingOperationalBlockedError: mocks.BookingOperationalBlockedError,
  BookingOperationalStateError: mocks.BookingOperationalStateError,
  isBookingOperationalBlockedError: (error: unknown) =>
    error instanceof mocks.BookingOperationalBlockedError,
  isBookingOperationalStateError: (error: unknown) =>
    error instanceof mocks.BookingOperationalStateError,
}));

import {
  AIProcessingBlockedError,
  AIProcessingIdempotencyConflictError,
  AIProcessingInProgressError,
  AIProcessingStateError,
  processIncomingMessage,
  processIncomingMessageDetailed,
} from "./engine";
import { OperationalControlsResolutionError } from "@/lib/account/operationalControls.server";
import {
  BookingOperationalBlockedError,
  BookingOperationalStateError,
} from "@/lib/google/bookingOperational.server";
import { KNOWLEDGE_GAP_SIGNAL } from "./knowledgeGapSignal";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000001";
const BOOKING_UNAVAILABLE_TOOL_RESULT_FOR_TEST =
  "Booking is currently unavailable. Do not check availability, create an appointment, or collect booking details. Let the customer know booking is unavailable.";
const BOOKING_REQUEST_RECORDED_TOOL_RESULT_FOR_TEST =
  "Appointment request recorded for owner review. It is not a booked or confirmed appointment.";
const BOOKING_REQUEST_PREVIEW_TOOL_RESULT_FOR_TEST =
  "Preview only: no appointment request was created. Do not say it was recorded, booked, or confirmed.";
const BOOKING_REQUEST_UNAVAILABLE_TOOL_RESULT_FOR_TEST =
  "Appointment-request recording is not enabled for this business right now. Do not say a request was recorded, booked, or confirmed.";
const CONTACT = {
  id: "00000000-0000-4000-8000-000000000002",
  business_id: BUSINESS_ID,
  phone_number: "+15745550100",
};
const CONVERSATION = {
  id: "00000000-0000-4000-8000-000000000003",
  business_id: BUSINESS_ID,
  contact_id: CONTACT.id,
  channel: "sms",
  status: "active",
  is_ai_handling: true,
};
const WEB_CONTACT = {
  ...CONTACT,
  name: null,
  phone_number: null,
  email: "pat@example.com",
  session_id: "00000000-0000-4000-8000-000000000004",
  source_channel: "web_chat",
};
const WEB_CONVERSATION = {
  ...CONVERSATION,
  id: "00000000-0000-4000-8000-000000000005",
  contact_id: WEB_CONTACT.id,
  channel: "web_chat",
};
const WEB_SOURCE_MESSAGE_ID = "00000000-0000-4000-8000-000000000010";
const WEB_RESERVATION_ID = "00000000-0000-4000-8000-000000000020";
const WEB_ATTEMPT_TOKEN = "00000000-0000-4000-8000-000000000022";
const WEB_USAGE_PERIOD_ID = "00000000-0000-4000-8000-000000000021";
const GROWTH = {
  businessId: BUSINESS_ID,
  plan: "sms_and_chat",
  status: "active",
  source: "subscription",
  active: true,
  cancelAtPeriodEnd: false,
};
const STARTER = { ...GROWTH, plan: "sms_only" };
const FULL = { ...GROWTH, plan: "full" };
const ACTIVE_CONTROLS = {
  businessId: BUSINESS_ID,
  operationsSuspendedAt: null,
  aiRepliesPausedAt: null,
  textingPausedAt: null,
  bookingsPausedAt: null,
};
const EXPECTED_CONTACT_TOOLS = [
  {
    name: "save_contact_name",
    description:
      "Save the customer's name to their contact record. Call this when the customer tells you their name.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The customer's name",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "save_contact_email",
    description:
      "Save the customer's email to their contact record. Call this when the customer provides their email address.",
    input_schema: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description: "The customer's email address",
        },
      },
      required: ["email"],
    },
  },
] as const;
const EXPECTED_BOOKING_REQUEST_TOOL = {
  name: "record_booking_request",
  description: "request",
  input_schema: {
    type: "object",
    properties: {
      requested_service: { type: "string" },
      requested_time_text: { type: "string" },
      customer_name: { type: "string" },
      customer_phone: { type: "string" },
      customer_email: { type: "string" },
    },
    required: ["requested_service", "requested_time_text"],
  },
} as const;
const EXPECTED_ANTHROPIC_CALL_OPTIONS = {
  maxRetries: 0,
  timeout: 60_000,
} as const;
const EXPECTED_ANTHROPIC_ACCOUNTING_WAIT_MS = 2_000;

function operationalControls(
  overrides: Partial<{
    operationsSuspendedAt: string | null;
    aiRepliesPausedAt: string | null;
    textingPausedAt: string | null;
    bookingsPausedAt: string | null;
  }> = {}
) {
  return { ...ACTIVE_CONTROLS, ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const tableResults = new Map<string, unknown>();

function setAiData() {
  tableResults.set("businesses", {
    data: { id: BUSINESS_ID, name: "Test Biz", timezone: "America/New_York" },
    error: null,
  });
  tableResults.set("ai_settings", {
    data: {
      id: "settings_1",
      business_id: BUSINESS_ID,
      tone: "friendly",
      business_voice: "we",
      language: "en",
      sms_response_delay_seconds: 0,
      guardrails: ["promise a price"],
      booking_enabled: true,
      booking_mode: "schedule_direct",
    },
    error: null,
  });
  tableResults.set("services", { data: [], error: null });
  tableResults.set("faqs", { data: [], error: null });
  tableResults.set("business_hours", { data: [], error: null });
  tableResults.set("business_knowledge_items", { data: [], error: null });
  tableResults.set("google_calendar_tokens", {
    data: { id: "calendar_1" },
    error: null,
  });
  tableResults.set("contacts", {
    data: {
      id: CONTACT.id,
      business_id: BUSINESS_ID,
      name: "Stored Pat",
      phone_number: "+15745550100",
      provided_phone_number: "+15745550199",
      email: "stored@example.com",
    },
    error: null,
  });
}

function setBusinessGoal(
  primaryGoal: "book" | "signup" | "quote" | "callback" | null | undefined,
  goalUrl: string | null = null
) {
  const current = tableResults.get("businesses") as {
    data: Record<string, unknown>;
    error: null;
  };
  const data: Record<string, unknown> = {
    ...current.data,
    goal_url: goalUrl,
  };
  if (primaryGoal !== undefined) {
    data.primary_goal = primaryGoal;
  }
  tableResults.set("businesses", { data, error: null });
}

function setAiSettings(overrides: Record<string, unknown>) {
  const current = tableResults.get("ai_settings") as {
    data: Record<string, unknown>;
    error: null;
  };
  const data = { ...current.data, ...overrides };
  tableResults.set("ai_settings", { data, error: null });
  return data;
}

function legacyGoldenHash(
  result: Awaited<ReturnType<typeof processIncomingMessageDetailed>>
) {
  const legacyResult = {
    text: result.text,
    knowledgeGapDetected: result.knowledgeGapDetected,
    conversationId: result.conversationId,
    sourceMessageId: result.sourceMessageId,
  };
  const projection = JSON.stringify({
    apiParams: mocks.anthropicCreate.mock.calls[0]?.[0],
    result: legacyResult,
    persistedMessages: mocks.addMessage.mock.calls,
  });
  return createHash("sha256").update(projection).digest("hex");
}

function expectedGoalLinkIdempotencyKey(sourceMessageId: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "goal-link-offered:v1",
        BUSINESS_ID,
        sourceMessageId,
      ]),
      "utf8"
    )
    .digest("base64url");
}

function expectConsoleErrorsNotToContain(...sentinels: string[]): void {
  const serializedCalls = JSON.stringify(
    vi.mocked(console.error).mock.calls,
  );
  for (const sentinel of sentinels) {
    expect(serializedCalls).not.toContain(sentinel);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  tableResults.clear();
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  mocks.from.mockImplementation((table: string) => {
    const result = tableResults.get(table) ?? {
      data: null,
      error: { message: `Unexpected ${table} query` },
    };
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of [
      "select",
      "eq",
      "in",
      "order",
      "limit",
      "single",
      "maybeSingle",
    ]) {
      chain[method] = vi.fn(() => chain);
    }
    const promise = Promise.resolve(result);
    (chain as Record<string, unknown>).then = promise.then.bind(promise);
    (chain as Record<string, unknown>).catch = promise.catch.bind(promise);
    return chain;
  });

  mocks.resolveBusinessEntitlements.mockResolvedValue(GROWTH);
  mocks.resolveBusinessOperationalControls.mockResolvedValue(ACTIVE_CONTROLS);
  mocks.canUseFeature.mockImplementation(
    (entitlements: { active: boolean; plan: string }, feature: string) => {
      if (!entitlements.active) return false;
      if (feature === "advanced_guardrails") {
        return entitlements.plan === "full";
      }
      if (
        feature === "ai_sms_conversations" ||
        feature === "web_chat" ||
        feature === "direct_booking"
      ) {
        return entitlements.plan === "sms_and_chat" || entitlements.plan === "full";
      }
      return true;
    }
  );
  mocks.findOrCreateContact.mockResolvedValue(CONTACT);
  mocks.getOrCreateConversation.mockResolvedValue(CONVERSATION);
  mocks.getConversationById.mockResolvedValue(CONVERSATION);
  mocks.getConversationAiState.mockResolvedValue(CONVERSATION);
  mocks.addMessage.mockResolvedValue({ id: "message_1" });
  mocks.addWebChatInboundMessageOnce.mockResolvedValue({
    id: "00000000-0000-4000-8000-000000000010",
    conversation_id: CONVERSATION.id,
  });
  mocks.getConversationHistory.mockResolvedValue([
    { role: "customer", content: "Can I book?" },
  ]);
  mocks.buildSystemPrompt.mockReturnValue("SYSTEM PROMPT");
  mocks.buildConversationMessages.mockReturnValue([
    { role: "user", content: "Can I book?" },
  ]);
  mocks.shouldIncludeCalendarTools.mockImplementation(
    (
      _settings: unknown,
      hasCalendar: boolean,
      bookingOperationallyAvailable: boolean = true
    ) => hasCalendar && bookingOperationallyAvailable
  );
  mocks.shouldIncludeBookingRequestTools.mockImplementation(
    (
      settings: { booking_enabled: boolean; booking_mode: string },
      bookingOperationallyAvailable: boolean = true
    ) =>
      bookingOperationallyAvailable &&
      settings.booking_enabled &&
      settings.booking_mode === "collect_info"
  );
  mocks.anthropicCreate.mockResolvedValue({
    stop_reason: "end_turn",
    content: [{ type: "text", text: "Absolutely." }],
  });
  mocks.createBooking.mockResolvedValue({
    eventId: "google_event_1",
    summary: "Estimate - Pat",
    startTime: "2026-08-01T10:00:00",
    endTime: "2026-08-01T10:30:00",
  });
  mocks.incrementLeadScore.mockResolvedValue(undefined);
  mocks.recordBookingRequest.mockResolvedValue("inserted");
  mocks.getCompletedAIReply.mockResolvedValue({ outcome: "not_found" });
  mocks.finalizeAIReplyUnit.mockResolvedValue({
    outcome: "completed",
    reservationId: "00000000-0000-4000-8000-000000000020",
    sourceMessageId: "00000000-0000-4000-8000-000000000010",
    assistantMessageId: "message_1",
    conversationId: CONVERSATION.id,
    usagePeriodId: "00000000-0000-4000-8000-000000000021",
    completedAt: "2026-08-18T12:00:00.000Z",
  });
  mocks.releaseAIReplyUnit.mockResolvedValue({
    outcome: "released",
    reservationId: "00000000-0000-4000-8000-000000000020",
  });
  mocks.recordAnthropicProviderCall.mockResolvedValue(
    "00000000-0000-4000-8000-000000000030",
  );
  setAiData();
});

describe("processIncomingMessage operational controls", () => {
  it.each([
    ["account_suspended", { operationsSuspendedAt: "2026-08-04T12:00:00Z" }],
    ["ai_replies_paused", { aiRepliesPausedAt: "2026-08-04T12:00:00Z" }],
    ["texting_paused", { textingPausedAt: "2026-08-04T12:00:00Z" }],
  ] as const)(
    "throws the typed %s entry block before contact, persistence, or Anthropic",
    async (reason, controls) => {
      mocks.resolveBusinessOperationalControls.mockResolvedValue(
        operationalControls(controls)
      );

      const promise = processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "What is the price?",
        "sms"
      );

      await expect(promise).rejects.toMatchObject({
        name: "AIProcessingBlockedError",
        reason,
      });
      await expect(promise).rejects.toBeInstanceOf(AIProcessingBlockedError);
      expect(mocks.findOrCreateContact).not.toHaveBeenCalled();
      expect(mocks.getOrCreateConversation).not.toHaveBeenCalled();
      expect(mocks.addMessage).not.toHaveBeenCalled();
      expect(mocks.anthropicCreate).not.toHaveBeenCalled();
      expect(mocks.incrementLeadScore).not.toHaveBeenCalled();
    }
  );

  it("uses suspension, then texting, then AI precedence for SMS", async () => {
    mocks.resolveBusinessOperationalControls.mockResolvedValue(
      operationalControls({
        operationsSuspendedAt: "2026-08-04T12:00:00Z",
        textingPausedAt: "2026-08-04T12:01:00Z",
        aiRepliesPausedAt: "2026-08-04T12:02:00Z",
      })
    );

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Hello",
        "sms"
      )
    ).rejects.toMatchObject({ reason: "account_suspended" });

    mocks.resolveBusinessOperationalControls.mockResolvedValue(
      operationalControls({
        textingPausedAt: "2026-08-04T12:01:00Z",
        aiRepliesPausedAt: "2026-08-04T12:02:00Z",
      })
    );

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Hello",
        "sms"
      )
    ).rejects.toMatchObject({ reason: "texting_paused" });
  });

  it("blocks every post-Anthropic side effect when AI pauses while the request is pending", async () => {
    const pendingAnthropic = deferred<{
      stop_reason: "tool_use";
      content: Array<{
        type: "tool_use";
        id: string;
        name: string;
        input: { name: string };
      }>;
    }>();
    mocks.anthropicCreate.mockReturnValueOnce(pendingAnthropic.promise);

    const processing = processIncomingMessage(
      BUSINESS_ID,
      "+15745550100",
      null,
      "My name is Pat and I need a price.",
      "sms"
    );

    await vi.waitFor(() => {
      expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
    });
    mocks.resolveBusinessOperationalControls.mockResolvedValue(
      operationalControls({
        aiRepliesPausedAt: "2026-08-04T12:00:00Z",
      })
    );
    pendingAnthropic.resolve({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool_1",
          name: "save_contact_name",
          input: { name: "Pat" },
        },
      ],
    });

    await expect(processing).rejects.toMatchObject({
      reason: "ai_replies_paused",
    });
    expect(mocks.updateContactName).not.toHaveBeenCalled();
    expect(mocks.updateContactEmail).not.toHaveBeenCalled();
    expect(mocks.checkAvailability).not.toHaveBeenCalled();
    expect(mocks.createBooking).not.toHaveBeenCalled();
    expect(mocks.addMessage).toHaveBeenCalledTimes(1);
    expect(mocks.addMessage).toHaveBeenCalledWith(
      CONVERSATION.id,
      BUSINESS_ID,
      "customer",
      "My name is Pat and I need a price.",
      "sms"
    );
    expect(mocks.incrementLeadScore).not.toHaveBeenCalled();
    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
  });

  it("rechecks a pause that lands before a pending Anthropic failure instead of returning fallback text", async () => {
    const pendingAnthropic = deferred<never>();
    const anthropicError = new Error("Anthropic unavailable");
    mocks.anthropicCreate.mockReturnValueOnce(pendingAnthropic.promise);

    const processing = processIncomingMessage(
      BUSINESS_ID,
      "+15745550100",
      null,
      "What is the price?",
      "sms"
    );

    await vi.waitFor(() => {
      expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
    });
    mocks.resolveBusinessOperationalControls.mockResolvedValue(
      operationalControls({
        aiRepliesPausedAt: "2026-08-04T12:00:00Z",
      })
    );
    pendingAnthropic.reject(anthropicError);

    await expect(processing).rejects.toMatchObject({
      name: "AIProcessingBlockedError",
      reason: "ai_replies_paused",
    });
    expect(console.error).toHaveBeenCalledWith(
      "[ai-engine] Operation failed",
      {
        category: "incoming_message_processing",
        name: "Error",
        status: null,
      },
    );
    expect(mocks.addMessage).toHaveBeenCalledTimes(1);
    expect(mocks.updateContactName).not.toHaveBeenCalled();
    expect(mocks.checkAvailability).not.toHaveBeenCalled();
    expect(mocks.incrementLeadScore).not.toHaveBeenCalled();
  });

  it("rethrows indeterminate state at the fallback boundary after a pending Anthropic failure", async () => {
    const pendingAnthropic = deferred<never>();
    const anthropicError = new Error("Anthropic unavailable");
    const resolutionError = new OperationalControlsResolutionError({
      code: "business_lookup_failed",
      businessId: BUSINESS_ID,
      message: "operational state unavailable",
    });
    mocks.anthropicCreate.mockReturnValueOnce(pendingAnthropic.promise);

    const processing = processIncomingMessage(
      BUSINESS_ID,
      "+15745550100",
      null,
      "What is the price?",
      "sms"
    );

    await vi.waitFor(() => {
      expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
    });
    mocks.resolveBusinessOperationalControls.mockRejectedValue(resolutionError);
    pendingAnthropic.reject(anthropicError);

    await expect(processing).rejects.toBe(resolutionError);
    expect(console.error).toHaveBeenCalledWith(
      "[ai-engine] Operation failed",
      {
        category: "incoming_message_processing",
        name: "Error",
        status: null,
      },
    );
    expect(mocks.addMessage).toHaveBeenCalledTimes(1);
    expect(mocks.incrementLeadScore).not.toHaveBeenCalled();
  });

  it("keeps the generic fallback only when the fresh fallback-boundary check is active", async () => {
    const sentinel = "pat@example.com bearer-provider-secret";
    const nameSentinel = "PatExampleComBearerProviderSecret";
    const anthropicError = Object.assign(
      new Error(`Anthropic unavailable for ${sentinel}`),
      {
        name: nameSentinel,
        status: 400,
        request: { headers: { authorization: sentinel } },
        response: { prompt: sentinel },
        cause: new Error(sentinel),
      },
    );
    mocks.anthropicCreate.mockRejectedValueOnce(anthropicError);

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "What is the price?",
        "sms"
      )
    ).resolves.toContain("We're having a brief technical issue.");

    expect(mocks.resolveBusinessOperationalControls).toHaveBeenCalledTimes(3);
    expect(mocks.addMessage).toHaveBeenCalledTimes(1);
    expect(mocks.incrementLeadScore).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "[ai-engine] Operation failed",
      {
        category: "incoming_message_processing",
        name: "unknown_error",
        status: 400,
      },
    );
    expectConsoleErrorsNotToContain(sentinel, nameSentinel);
  });

  it("freshly checks each contact tool execution in a multi-tool response", async () => {
    mocks.anthropicCreate.mockResolvedValueOnce({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool_1",
          name: "save_contact_name",
          input: { name: "Pat" },
        },
        {
          type: "tool_use",
          id: "tool_2",
          name: "save_contact_email",
          input: { email: "pat@example.com" },
        },
      ],
    });
    mocks.resolveBusinessOperationalControls
      .mockResolvedValueOnce(ACTIVE_CONTROLS) // engine entry
      .mockResolvedValueOnce(ACTIVE_CONTROLS) // first Anthropic request
      .mockResolvedValueOnce(ACTIVE_CONTROLS) // first contact tool
      .mockResolvedValueOnce(
        operationalControls({
          aiRepliesPausedAt: "2026-08-04T12:00:00Z",
        })
      ); // second contact tool

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "I'm Pat; use pat@example.com.",
        "sms"
      )
    ).rejects.toMatchObject({ reason: "ai_replies_paused" });

    expect(mocks.updateContactName).toHaveBeenCalledWith(CONTACT.id, "Pat");
    expect(mocks.updateContactEmail).not.toHaveBeenCalled();
    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
    expect(mocks.addMessage).toHaveBeenCalledTimes(1);
    expect(mocks.incrementLeadScore).not.toHaveBeenCalled();
  });

  it("freshly checks a calendar tool before any calendar mutation", async () => {
    mocks.anthropicCreate.mockResolvedValueOnce({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool_1",
          name: "create_booking",
          input: {
            customer_name: "Pat",
            service_name: "Estimate",
            start_time: "2026-08-05T10:00:00-04:00",
          },
        },
      ],
    });
    mocks.resolveBusinessOperationalControls
      .mockResolvedValueOnce(ACTIVE_CONTROLS) // engine entry
      .mockResolvedValueOnce(ACTIVE_CONTROLS) // Anthropic request
      .mockResolvedValueOnce(
        operationalControls({
          aiRepliesPausedAt: "2026-08-04T12:00:00Z",
        })
      ); // calendar tool

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Book that appointment.",
        "sms"
      )
    ).rejects.toMatchObject({ reason: "ai_replies_paused" });

    expect(mocks.checkAvailability).not.toHaveBeenCalled();
    expect(mocks.createBooking).not.toHaveBeenCalled();
    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
  });

  it("returns one deterministic unavailable result when bookings pause after tool selection", async () => {
    mocks.buildSystemPrompt.mockImplementation(
      (...args: unknown[]) =>
        args[7] === false
          ? "BOOKING UNAVAILABLE PROMPT"
          : "BOOKING AVAILABLE PROMPT"
    );
    mocks.anthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "create_booking",
            input: {
              customer_name: "Pat",
              customer_email: "pat@example.com",
              service_name: "Estimate",
              start_time: "2026-08-05T10:00:00-04:00",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Booking is unavailable right now." }],
      });
    mocks.resolveBusinessOperationalControls
      .mockResolvedValueOnce(ACTIVE_CONTROLS) // engine entry
      .mockResolvedValueOnce(ACTIVE_CONTROLS) // first model request
      .mockResolvedValueOnce(
        operationalControls({
          bookingsPausedAt: "2026-08-04T12:00:00Z",
        })
      ) // selected calendar tool
      .mockResolvedValueOnce(
        operationalControls({
          bookingsPausedAt: "2026-08-04T12:00:00Z",
        })
      ); // follow-up model request

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Book that appointment.",
        "sms"
      )
    ).resolves.toBe("Booking is unavailable right now.");

    expect(mocks.checkAvailability).not.toHaveBeenCalled();
    expect(mocks.createBooking).not.toHaveBeenCalled();
    expect(mocks.updateContactEmail).not.toHaveBeenCalled();
    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(2);
    expect(mocks.anthropicCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        system: "BOOKING UNAVAILABLE PROMPT",
        tools: expect.not.arrayContaining([
          expect.objectContaining({ name: "check_availability" }),
          expect.objectContaining({ name: "create_booking" }),
        ]),
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: [
              expect.objectContaining({
                tool_use_id: "tool_1",
                content:
                  "Booking is currently unavailable. Do not check availability, create an appointment, or collect booking details. Let the customer know booking is unavailable.",
              }),
            ],
          }),
        ]),
      }),
      EXPECTED_ANTHROPIC_CALL_OPTIONS,
    );
  });

  it("keeps repeated stale calendar tools unavailable across follow-up model iterations", async () => {
    mocks.buildSystemPrompt.mockImplementation(
      (...args: unknown[]) =>
        args[7] === false
          ? "BOOKING UNAVAILABLE PROMPT"
          : "BOOKING AVAILABLE PROMPT"
    );
    mocks.anthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "check_availability",
            input: { date: "2026-08-05" },
          },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tool_2",
            name: "create_booking",
            input: {
              customer_name: "Pat",
              service_name: "Estimate",
              start_time: "2026-08-05T10:00:00-04:00",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Booking is unavailable right now." }],
      });
    mocks.resolveBusinessOperationalControls
      .mockResolvedValueOnce(ACTIVE_CONTROLS) // engine entry
      .mockResolvedValueOnce(ACTIVE_CONTROLS) // first model request
      .mockResolvedValue(
        operationalControls({
          bookingsPausedAt: "2026-08-04T12:00:00Z",
        })
      );

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Please book an estimate.",
        "sms"
      )
    ).resolves.toBe("Booking is unavailable right now.");

    expect(mocks.checkAvailability).not.toHaveBeenCalled();
    expect(mocks.createBooking).not.toHaveBeenCalled();
    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(3);
    for (const callNumber of [2, 3]) {
      expect(mocks.anthropicCreate).toHaveBeenNthCalledWith(
        callNumber,
        expect.objectContaining({
          system: "BOOKING UNAVAILABLE PROMPT",
          tools: expect.arrayContaining([
            expect.objectContaining({ name: "save_contact_name" }),
            expect.objectContaining({ name: "save_contact_email" }),
          ]),
        }),
        EXPECTED_ANTHROPIC_CALL_OPTIONS,
      );
      const request = mocks.anthropicCreate.mock.calls[callNumber - 1]?.[0] as {
        tools: Array<{ name: string }>;
      };
      expect(request.tools.map((tool) => tool.name)).not.toContain(
        "check_availability"
      );
      expect(request.tools.map((tool) => tool.name)).not.toContain(
        "create_booking"
      );
    }
    expect(mocks.anthropicCreate.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: [
              expect.objectContaining({
                tool_use_id: "tool_1",
                content: BOOKING_UNAVAILABLE_TOOL_RESULT_FOR_TEST,
              }),
            ],
          }),
        ]),
      }),
    );
    expect(mocks.anthropicCreate.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: [
              expect.objectContaining({
                tool_use_id: "tool_2",
                content: BOOKING_UNAVAILABLE_TOOL_RESULT_FOR_TEST,
              }),
            ],
          }),
        ]),
      }),
    );
  });

  it("converts a helper booking-pause race into the deterministic unavailable tool result", async () => {
    mocks.anthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "create_booking",
            input: {
              customer_name: "Pat",
              customer_email: "pat@example.com",
              service_name: "Estimate",
              start_time: "2026-08-05T10:00:00-04:00",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Booking is unavailable." }],
      });
    mocks.createBooking.mockRejectedValueOnce(
      new BookingOperationalBlockedError(BUSINESS_ID, "bookings_paused")
    );

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Can I book?",
        "sms"
      )
    ).resolves.toBe("Booking is unavailable.");

    expect(mocks.createBooking).toHaveBeenCalledOnce();
    expect(mocks.updateContactEmail).not.toHaveBeenCalled();
    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(2);
    expect(mocks.anthropicCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: [
              expect.objectContaining({
                content:
                  "Booking is currently unavailable. Do not check availability, create an appointment, or collect booking details. Let the customer know booking is unavailable.",
              }),
            ],
          }),
        ]),
      }),
      EXPECTED_ANTHROPIC_CALL_OPTIONS,
    );
    expect(console.error).not.toHaveBeenCalledWith(
      "[ai-engine] Operation failed",
      expect.objectContaining({ category: "calendar_tool_create_booking" }),
    );
  });

  it("maps a helper suspension race to the typed account-suspended AI path", async () => {
    const suspended = new BookingOperationalBlockedError(
      BUSINESS_ID,
      "account_suspended"
    );
    mocks.anthropicCreate.mockResolvedValueOnce({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool_1",
          name: "check_availability",
          input: { date: "2026-08-05" },
        },
      ],
    });
    mocks.checkAvailability.mockRejectedValueOnce(suspended);

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Can I book?",
        "sms"
      )
    ).rejects.toMatchObject({
      name: "AIProcessingBlockedError",
      reason: "account_suspended",
    });

    expect(mocks.checkAvailability).toHaveBeenCalledOnce();
    expect(mocks.anthropicCreate).toHaveBeenCalledOnce();
    expect(mocks.addMessage).toHaveBeenCalledTimes(1);
  });

  it("maps retryable booking-state uncertainty to AIProcessingStateError", async () => {
    const stateError = new BookingOperationalStateError({
      businessId: BUSINESS_ID,
      code: "booking_cleanup_failed",
      message: "reservation cleanup could not be proven",
    });
    mocks.anthropicCreate.mockResolvedValueOnce({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool_1",
          name: "create_booking",
          input: {
            customer_name: "Pat",
            service_name: "Estimate",
            start_time: "2026-08-05T10:00:00-04:00",
          },
        },
      ],
    });
    mocks.createBooking.mockRejectedValueOnce(stateError);

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Book that appointment.",
        "sms"
      )
    ).rejects.toMatchObject({
      name: "AIProcessingStateError",
      cause: stateError,
    });

    expect(mocks.createBooking).toHaveBeenCalledOnce();
    expect(mocks.anthropicCreate).toHaveBeenCalledOnce();
    expect(mocks.updateContactEmail).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalledWith(
      "[ai-engine] Operation failed",
      expect.objectContaining({ category: "calendar_tool_create_booking" }),
    );
  });

  it.each([
    [
      "AIProcessingBlockedError",
      () => new AIProcessingBlockedError("ai_replies_paused"),
    ],
    [
      "AIProcessingStateError",
      () => new AIProcessingStateError("contact state unavailable"),
    ],
    [
      "OperationalControlsResolutionError",
      () =>
        new OperationalControlsResolutionError({
          code: "business_lookup_failed",
          businessId: BUSINESS_ID,
          message: "operational state unavailable",
        }),
    ],
  ])(
    "rethrows %s from a contact mutation without continuing the model loop",
    async (_label, createError) => {
      const typedError = createError();
      mocks.anthropicCreate.mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "save_contact_name",
            input: { name: "Pat" },
          },
        ],
      });
      mocks.updateContactName.mockRejectedValueOnce(typedError);

      await expect(
        processIncomingMessage(
          BUSINESS_ID,
          "+15745550100",
          null,
          "I'm Pat and need a price.",
          "sms"
        )
      ).rejects.toBe(typedError);

      expect(mocks.updateContactName).toHaveBeenCalledOnce();
      expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
      expect(mocks.addMessage).toHaveBeenCalledTimes(1);
      expect(mocks.incrementLeadScore).not.toHaveBeenCalled();
      expect(mocks.parseKnowledgeGapSignal).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalledWith(
        "[ai-engine] Operation failed",
        expect.objectContaining({ category: "contact_tool_save_name" }),
      );
    }
  );

  it.each([
    [
      "AIProcessingBlockedError",
      () => new AIProcessingBlockedError("account_suspended"),
    ],
    [
      "OperationalControlsResolutionError",
      () =>
        new OperationalControlsResolutionError({
          code: "business_lookup_failed",
          businessId: BUSINESS_ID,
          message: "operational state unavailable",
        }),
    ],
  ])(
    "rethrows %s from a calendar helper without continuing the model loop",
    async (_label, createError) => {
      const typedError = createError();
      mocks.anthropicCreate.mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "check_availability",
            input: { date: "2026-08-05" },
          },
        ],
      });
      mocks.checkAvailability.mockRejectedValueOnce(typedError);

      await expect(
        processIncomingMessage(
          BUSINESS_ID,
          "+15745550100",
          null,
          "Can I book and get a price?",
          "sms"
        )
      ).rejects.toBe(typedError);

      expect(mocks.checkAvailability).toHaveBeenCalledOnce();
      expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
      expect(mocks.addMessage).toHaveBeenCalledTimes(1);
      expect(mocks.incrementLeadScore).not.toHaveBeenCalled();
      expect(mocks.parseKnowledgeGapSignal).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalledWith(
        "[ai-engine] Operation failed",
        expect.objectContaining({
          category: "calendar_tool_check_availability",
        }),
      );
    }
  );

  it.each([
    {
      toolName: "save_contact_name",
      input: { name: "Pat" },
      updateMock: mocks.updateContactName,
      failureResult:
        "Contact name could not be saved. Do not say it was saved; continue helping the customer.",
    },
    {
      toolName: "save_contact_email",
      input: { email: "pat@example.com" },
      updateMock: mocks.updateContactEmail,
      failureResult:
        "Contact email could not be saved. Do not say it was saved; continue helping the customer.",
    },
  ])(
    "feeds an honest $toolName failure result back to the model",
    async ({ toolName, input, updateMock, failureResult }) => {
      const sentinel = "pat@example.com contact-provider-secret";
      const contactError = Object.assign(
        new Error(`contact provider unavailable for ${sentinel}`),
        {
          status: 503,
          request: { contact: sentinel },
          cause: new Error(sentinel),
        },
      );
      mocks.anthropicCreate
        .mockResolvedValueOnce({
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: toolName,
              input,
            },
          ],
        })
        .mockResolvedValueOnce({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Thanks, Pat." }],
        });
      updateMock.mockRejectedValueOnce(contactError);

      await expect(
        processIncomingMessage(
          BUSINESS_ID,
          "+15745550100",
          null,
          "I'm Pat.",
          "sms"
        )
      ).resolves.toBe("Thanks, Pat.");

      expect(mocks.anthropicCreate).toHaveBeenCalledTimes(2);
      expect(mocks.anthropicCreate).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: "user",
              content: [expect.objectContaining({ content: failureResult })],
            }),
          ]),
        }),
        EXPECTED_ANTHROPIC_CALL_OPTIONS,
      );
      expect(mocks.addMessage).toHaveBeenCalledTimes(2);
      expect(console.error).toHaveBeenCalledWith(
        "[ai-engine] Operation failed",
        {
          category:
            toolName === "save_contact_name"
              ? "contact_tool_save_name"
              : "contact_tool_save_email",
          name: "Error",
          status: 503,
        },
      );
      expectConsoleErrorsNotToContain(sentinel);
    }
  );

  it("retains friendly calendar fallback text for an ordinary provider failure", async () => {
    const sentinel = "customer@example.com google-oauth-token";
    const calendarError = Object.assign(
      new Error(`calendar provider unavailable for ${sentinel}`),
      {
        status: 503,
        config: { headers: { authorization: sentinel } },
        response: { event: sentinel },
        cause: new Error(sentinel),
      },
    );
    mocks.anthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "check_availability",
            input: { date: "2026-08-05" },
          },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "I can collect your details." }],
      });
    mocks.checkAvailability.mockRejectedValueOnce(calendarError);

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Can I book?",
        "sms"
      )
    ).resolves.toBe("I can collect your details.");

    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(2);
    expect(mocks.anthropicCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: [
              expect.objectContaining({
                content:
                  "Calendar is temporarily unavailable. Please collect the customer's booking details instead and let them know someone will confirm.",
              }),
            ],
          }),
        ]),
      }),
      EXPECTED_ANTHROPIC_CALL_OPTIONS,
    );
    expect(mocks.addMessage).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(
      "[ai-engine] Operation failed",
      {
        category: "calendar_tool_check_availability",
        name: "Error",
        status: 503,
      },
    );
    expectConsoleErrorsNotToContain(sentinel);
  });

  it("freshly checks before every Anthropic request in the tool loop", async () => {
    mocks.anthropicCreate.mockResolvedValueOnce({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool_1",
          name: "save_contact_name",
          input: { name: "Pat" },
        },
      ],
    });
    mocks.resolveBusinessOperationalControls
      .mockResolvedValueOnce(ACTIVE_CONTROLS) // engine entry
      .mockResolvedValueOnce(ACTIVE_CONTROLS) // first Anthropic request
      .mockResolvedValueOnce(ACTIVE_CONTROLS) // contact tool
      .mockResolvedValueOnce(
        operationalControls({
          aiRepliesPausedAt: "2026-08-04T12:00:00Z",
        })
      ); // second Anthropic request

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "I'm Pat.",
        "sms"
      )
    ).rejects.toMatchObject({ reason: "ai_replies_paused" });

    expect(mocks.updateContactName).toHaveBeenCalledOnce();
    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
    expect(mocks.addMessage).toHaveBeenCalledTimes(1);
  });

  it("checks immediately before assistant persistence", async () => {
    mocks.resolveBusinessOperationalControls
      .mockResolvedValueOnce(ACTIVE_CONTROLS) // engine entry
      .mockResolvedValueOnce(ACTIVE_CONTROLS) // Anthropic request
      .mockResolvedValueOnce(
        operationalControls({
          aiRepliesPausedAt: "2026-08-04T12:00:00Z",
        })
      ); // assistant persistence

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Hello",
        "sms"
      )
    ).rejects.toMatchObject({ reason: "ai_replies_paused" });

    expect(mocks.addMessage).toHaveBeenCalledTimes(1);
    expect(mocks.incrementLeadScore).not.toHaveBeenCalled();
  });

  it("checks immediately before lead-score mutation", async () => {
    mocks.resolveBusinessOperationalControls
      .mockResolvedValueOnce(ACTIVE_CONTROLS) // engine entry
      .mockResolvedValueOnce(ACTIVE_CONTROLS) // Anthropic request
      .mockResolvedValueOnce(
        operationalControls({
          aiRepliesPausedAt: "2026-08-04T12:00:00Z",
        })
      ); // lead-score mutation

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "What is the price?",
        "sms",
        null,
        { persistAssistant: false }
      )
    ).rejects.toMatchObject({ reason: "ai_replies_paused" });

    expect(mocks.incrementLeadScore).not.toHaveBeenCalled();
    expect(mocks.addMessage).toHaveBeenCalledTimes(1);
  });

  it("checks again before returning a generated response", async () => {
    mocks.resolveBusinessOperationalControls
      .mockResolvedValueOnce(ACTIVE_CONTROLS) // engine entry
      .mockResolvedValueOnce(ACTIVE_CONTROLS) // Anthropic request
      .mockResolvedValueOnce(
        operationalControls({
          aiRepliesPausedAt: "2026-08-04T12:00:00Z",
        })
      ); // final return

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Hello",
        "sms",
        null,
        { persistAssistant: false }
      )
    ).rejects.toMatchObject({ reason: "ai_replies_paused" });

    expect(mocks.incrementLeadScore).not.toHaveBeenCalled();
  });

  it("rethrows resolver uncertainty at engine entry without creating a fallback", async () => {
    const resolutionError = new OperationalControlsResolutionError({
      code: "business_lookup_failed",
      businessId: BUSINESS_ID,
      message: "operational state unavailable",
    });
    mocks.resolveBusinessOperationalControls.mockRejectedValue(resolutionError);

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Hello",
        "sms"
      )
    ).rejects.toBe(resolutionError);

    expect(mocks.findOrCreateContact).not.toHaveBeenCalled();
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });

  it("fails closed when the operational resolver throws an untyped error", async () => {
    mocks.resolveBusinessOperationalControls.mockRejectedValue(
      new Error("unexpected resolver failure")
    );

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Hello",
        "sms"
      )
    ).rejects.toBeInstanceOf(AIProcessingStateError);

    expect(mocks.findOrCreateContact).not.toHaveBeenCalled();
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });

  it("rethrows resolver uncertainty after generation without persisting or returning fallback text", async () => {
    const resolutionError = new OperationalControlsResolutionError({
      code: "business_lookup_failed",
      businessId: BUSINESS_ID,
      message: "operational state unavailable",
    });
    mocks.resolveBusinessOperationalControls
      .mockResolvedValueOnce(ACTIVE_CONTROLS) // engine entry
      .mockResolvedValueOnce(ACTIVE_CONTROLS) // Anthropic request
      .mockRejectedValueOnce(resolutionError); // assistant persistence

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Hello",
        "sms"
      )
    ).rejects.toBe(resolutionError);

    expect(mocks.anthropicCreate).toHaveBeenCalledOnce();
    expect(mocks.addMessage).toHaveBeenCalledTimes(1);
    expect(mocks.incrementLeadScore).not.toHaveBeenCalled();
  });

  it("blocks texting-paused SMS while allowing web chat", async () => {
    mocks.resolveBusinessOperationalControls.mockResolvedValue(
      operationalControls({
        textingPausedAt: "2026-08-04T12:00:00Z",
      })
    );

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Hello",
        "sms"
      )
    ).rejects.toMatchObject({ reason: "texting_paused" });

    mocks.getOrCreateConversation.mockResolvedValue({
      ...CONVERSATION,
      channel: "web_chat",
    });
    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        null,
        "pat@example.com",
        "Hello",
        "web_chat",
        "session-1"
      )
    ).resolves.toBe("Absolutely.");

    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
  });

  it.each(["schedule_direct", "collect_info"] as const)(
    "keeps ordinary AI available but makes %s booking inert while bookings are paused",
    async (bookingMode) => {
      const settingsResult = tableResults.get("ai_settings") as {
        data: { booking_enabled: boolean; booking_mode: string };
      };
      settingsResult.data.booking_mode = bookingMode;
      const storedSettingsBefore = { ...settingsResult.data };

      mocks.resolveBusinessOperationalControls.mockResolvedValue(
        operationalControls({
          bookingsPausedAt: "2026-08-04T12:00:00Z",
        })
      );

      await expect(
        processIncomingMessage(
          BUSINESS_ID,
          "+15745550100",
          null,
          "Hello",
          "sms"
        )
      ).resolves.toBe("Absolutely.");

      expect(mocks.anthropicCreate).toHaveBeenCalledOnce();
      expect(mocks.anthropicCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: expect.not.arrayContaining([
            expect.objectContaining({ name: "record_booking_request" }),
            expect.objectContaining({ name: "check_availability" }),
            expect.objectContaining({ name: "create_booking" }),
          ]),
        }),
        EXPECTED_ANTHROPIC_CALL_OPTIONS,
      );
      expect(mocks.shouldIncludeCalendarTools).toHaveBeenCalledWith(
        expect.objectContaining({
          booking_enabled: true,
          booking_mode: bookingMode,
        }),
        true,
        false
      );
      expect(mocks.buildSystemPrompt).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          booking_enabled: true,
          booking_mode: bookingMode,
        }),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        true,
        "sms",
        false
      );
      expect(settingsResult.data).toEqual(storedSettingsBefore);
    }
  );

  it("turns a suspension at the pre-model booking snapshot into a typed AI block", async () => {
    mocks.resolveBusinessOperationalControls
      .mockResolvedValueOnce(ACTIVE_CONTROLS)
      .mockResolvedValueOnce(
        operationalControls({
          operationsSuspendedAt: "2026-08-04T12:00:00Z",
        })
      );

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Can I book?",
        "sms"
      )
    ).rejects.toMatchObject({
      name: "AIProcessingBlockedError",
      reason: "account_suspended",
    });

    expect(mocks.buildSystemPrompt).not.toHaveBeenCalled();
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });

  it("applies a booking pause that lands during history loading to the first model request", async () => {
    const pendingHistory = deferred<Array<{ role: string; content: string }>>();
    mocks.getConversationHistory.mockReturnValueOnce(pendingHistory.promise);
    mocks.resolveBusinessOperationalControls.mockResolvedValueOnce(
      ACTIVE_CONTROLS
    ); // engine entry

    const processing = processIncomingMessage(
      BUSINESS_ID,
      "+15745550100",
      null,
      "Can I book?",
      "sms"
    );

    await vi.waitFor(() => {
      expect(mocks.getConversationHistory).toHaveBeenCalledOnce();
    });
    mocks.resolveBusinessOperationalControls.mockResolvedValue(
      operationalControls({
        bookingsPausedAt: "2026-08-04T12:00:00Z",
      })
    );
    pendingHistory.resolve([{ role: "customer", content: "Can I book?" }]);

    await expect(processing).resolves.toBe("Absolutely.");

    expect(mocks.resolveBusinessOperationalControls).toHaveBeenCalledTimes(5);
    expect(mocks.buildSystemPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ booking_enabled: true }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      true,
      "sms",
      false
    );
    expect(mocks.anthropicCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.not.arrayContaining([
          expect.objectContaining({ name: "check_availability" }),
          expect.objectContaining({ name: "create_booking" }),
        ]),
      }),
      EXPECTED_ANTHROPIC_CALL_OPTIONS,
    );
    expect(
      mocks.getConversationHistory.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mocks.resolveBusinessOperationalControls.mock.invocationCallOrder[1]
    );
    expect(
      mocks.resolveBusinessOperationalControls.mock.invocationCallOrder[1]
    ).toBeLessThan(mocks.anthropicCreate.mock.invocationCallOrder[0]);
  });
});

describe("processIncomingMessage live web-chat metering", () => {
  const webRequest = {
    clientMessageId: "00000000-0000-4000-8000-000000000011",
    requestFingerprint: "a".repeat(64),
  };
  const reserved = {
    outcome: "reserved" as const,
    reservationId: WEB_RESERVATION_ID,
    attemptToken: WEB_ATTEMPT_TOKEN,
    attemptCount: 1,
    sourceMessageId: WEB_SOURCE_MESSAGE_ID,
    usagePeriodId: WEB_USAGE_PERIOD_ID,
    periodStart: "2026-08-01T00:00:00.000Z",
    periodEnd: "2026-09-01T00:00:00.000Z",
    plan: "chat_only" as const,
    allowance: 200,
    completedReplies: 199,
    activeReservations: 1,
    remainingReplies: 0,
    allowanceRenewal: "scheduled" as const,
    resetAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-08-18T12:10:00.000Z",
  };

  function runWebTurn(
    overrides: Partial<Parameters<typeof processIncomingMessageDetailed>[6]> = {},
  ) {
    return processIncomingMessageDetailed(
      BUSINESS_ID,
      null,
      "pat@example.com",
      "Can I book tomorrow?",
      "web_chat",
      WEB_CONTACT.session_id,
      {
        contact: WEB_CONTACT as never,
        conversation: WEB_CONVERSATION as never,
        webChatRequest: webRequest,
        ...overrides,
      },
    );
  }

  beforeEach(() => {
    mocks.addWebChatInboundMessageOnce.mockResolvedValue({
      id: WEB_SOURCE_MESSAGE_ID,
      conversation_id: WEB_CONVERSATION.id,
    });
    mocks.addMessage.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000023",
    });
    mocks.reserveAIReplyUnit.mockResolvedValue(reserved);
    mocks.finalizeAIReplyUnit.mockResolvedValue({
      outcome: "completed",
      reservationId: WEB_RESERVATION_ID,
      sourceMessageId: WEB_SOURCE_MESSAGE_ID,
      assistantMessageId: "00000000-0000-4000-8000-000000000023",
      conversationId: WEB_CONVERSATION.id,
      usagePeriodId: WEB_USAGE_PERIOD_ID,
      completedAt: "2026-08-18T12:00:00.000Z",
    });
    mocks.anthropicCreate.mockResolvedValue({
      id: "msg_provider_1",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 120,
        output_tokens: 24,
        cache_creation_input_tokens: 4,
        cache_read_input_tokens: 10,
      },
      content: [{ type: "text", text: "Absolutely." }],
    });
  });

  it("persists once, reserves before Anthropic, proves the assistant, and finalizes one unit", async () => {
    await expect(runWebTurn({ contactName: "Pat" })).resolves.toMatchObject({
      text: "Absolutely.",
      sourceMessageId: WEB_SOURCE_MESSAGE_ID,
      assistantMessageId: "00000000-0000-4000-8000-000000000023",
    });

    expect(mocks.updateContactName).toHaveBeenCalledWith(WEB_CONTACT.id, "Pat");
    expect(mocks.addWebChatInboundMessageOnce).toHaveBeenCalledWith(
      WEB_CONVERSATION.id,
      BUSINESS_ID,
      "Can I book tomorrow?",
      webRequest.clientMessageId,
    );
    expect(mocks.reserveAIReplyUnit).toHaveBeenCalledWith({
      mode: "live",
      businessId: BUSINESS_ID,
      clientMessageId: webRequest.clientMessageId,
      requestFingerprint: webRequest.requestFingerprint,
      sourceMessageId: WEB_SOURCE_MESSAGE_ID,
    });
    expect(mocks.addMessage).toHaveBeenLastCalledWith(
      WEB_CONVERSATION.id,
      BUSINESS_ID,
      "assistant",
      "Absolutely.",
      "web_chat",
      {
        aiReplyReservationId: WEB_RESERVATION_ID,
        aiReplyReservationAttemptToken: WEB_ATTEMPT_TOKEN,
      },
    );
    expect(mocks.finalizeAIReplyUnit).toHaveBeenCalledWith({
      reservationId: WEB_RESERVATION_ID,
      attemptToken: WEB_ATTEMPT_TOKEN,
      assistantMessageId: "00000000-0000-4000-8000-000000000023",
    });
    expect(mocks.releaseAIReplyUnit).not.toHaveBeenCalled();
    expect(
      mocks.reserveAIReplyUnit.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.anthropicCreate.mock.invocationCallOrder[0]);
    expect(mocks.recordAnthropicProviderCall).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        reservationId: WEB_RESERVATION_ID,
        attemptToken: WEB_ATTEMPT_TOKEN,
        providerRequestId: "msg_provider_1",
        inputTokens: 120,
        outputTokens: 24,
        cacheCreationInputTokens: 4,
        cacheReadInputTokens: 10,
        succeeded: true,
      }),
    );
    expect(mocks.anthropicCreate.mock.calls[0]?.[1]).toEqual(
      EXPECTED_ANTHROPIC_CALL_OPTIONS,
    );
  });

  it("recovers the exact committed reply before a later pause or cancellation gate", async () => {
    mocks.getCompletedAIReply.mockResolvedValue({
      outcome: "completed",
      reservationId: WEB_RESERVATION_ID,
      sourceMessageId: WEB_SOURCE_MESSAGE_ID,
      assistantMessageId: "00000000-0000-4000-8000-000000000023",
      conversationId: WEB_CONVERSATION.id,
      usagePeriodId: WEB_USAGE_PERIOD_ID,
      completedAt: "2026-08-18T12:00:00.000Z",
    });
    mocks.resolveBusinessOperationalControls.mockResolvedValue(
      operationalControls({ aiRepliesPausedAt: "2026-08-18T12:01:00.000Z" }),
    );
    mocks.resolveBusinessEntitlements.mockResolvedValue({
      ...GROWTH,
      status: "canceled",
      active: false,
    });
    tableResults.set("messages", {
      data: {
        id: "00000000-0000-4000-8000-000000000023",
        business_id: BUSINESS_ID,
        conversation_id: WEB_CONVERSATION.id,
        role: "assistant",
        channel: "web_chat",
        content: "The reply committed before the pause.",
      },
      error: null,
    });

    await expect(runWebTurn()).resolves.toMatchObject({
      text: "The reply committed before the pause.",
      sourceMessageId: WEB_SOURCE_MESSAGE_ID,
      assistantMessageId: "00000000-0000-4000-8000-000000000023",
    });

    expect(mocks.getCompletedAIReply).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      clientMessageId: webRequest.clientMessageId,
      requestFingerprint: webRequest.requestFingerprint,
    });
    expect(mocks.resolveBusinessOperationalControls).not.toHaveBeenCalled();
    expect(mocks.resolveBusinessEntitlements).not.toHaveBeenCalled();
    expect(mocks.addWebChatInboundMessageOnce).not.toHaveBeenCalled();
    expect(mocks.reserveAIReplyUnit).not.toHaveBeenCalled();
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });

  it("returns a finalized reply when operations pause at the post-commit boundary", async () => {
    mocks.resolveBusinessOperationalControls.mockImplementation(async () =>
      mocks.finalizeAIReplyUnit.mock.calls.length > 0
        ? operationalControls({
            aiRepliesPausedAt: "2026-08-18T12:01:00.000Z",
          })
        : ACTIVE_CONTROLS,
    );

    await expect(runWebTurn()).resolves.toMatchObject({
      text: "Absolutely.",
      assistantMessageId: "00000000-0000-4000-8000-000000000023",
    });

    expect(mocks.finalizeAIReplyUnit).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(mocks.resolveBusinessOperationalControls).toHaveBeenCalled();
    });
    expect(mocks.incrementLeadScore).not.toHaveBeenCalled();
    expect(mocks.releaseAIReplyUnit).not.toHaveBeenCalled();
  });

  it("contains post-commit lead-score failures without suppressing the reply", async () => {
    mocks.incrementLeadScore.mockRejectedValueOnce(
      new Error("lead score storage unavailable"),
    );

    await expect(runWebTurn()).resolves.toMatchObject({
      text: "Absolutely.",
      assistantMessageId: "00000000-0000-4000-8000-000000000023",
    });

    await vi.waitFor(() => {
      expect(mocks.incrementLeadScore).toHaveBeenCalledOnce();
    });
    expect(console.error).toHaveBeenCalledWith(
      "[ai-engine] Post-commit lead score enrichment failed",
      expect.objectContaining({
        businessId: BUSINESS_ID,
        contactId: WEB_CONTACT.id,
        error: "Error",
      }),
    );
    expect(mocks.releaseAIReplyUnit).not.toHaveBeenCalled();
  });

  it("returns an already completed durable reply without another provider call", async () => {
    mocks.reserveAIReplyUnit.mockResolvedValue({
      outcome: "completed",
      reservationId: WEB_RESERVATION_ID,
      sourceMessageId: WEB_SOURCE_MESSAGE_ID,
      assistantMessageId: "00000000-0000-4000-8000-000000000023",
      conversationId: WEB_CONVERSATION.id,
      usagePeriodId: WEB_USAGE_PERIOD_ID,
      completedAt: "2026-08-18T12:00:00.000Z",
    });
    tableResults.set("messages", {
      data: {
        id: "00000000-0000-4000-8000-000000000023",
        business_id: BUSINESS_ID,
        conversation_id: WEB_CONVERSATION.id,
        role: "assistant",
        channel: "web_chat",
        content: "The original durable reply.",
      },
      error: null,
    });

    await expect(runWebTurn()).resolves.toMatchObject({
      text: "The original durable reply.",
      assistantMessageId: "00000000-0000-4000-8000-000000000023",
    });
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.finalizeAIReplyUnit).not.toHaveBeenCalled();
  });

  it("rejects an in-flight duplicate without another provider call", async () => {
    mocks.reserveAIReplyUnit.mockResolvedValue({
      outcome: "in_progress",
      reservationId: WEB_RESERVATION_ID,
      sourceMessageId: WEB_SOURCE_MESSAGE_ID,
      usagePeriodId: WEB_USAGE_PERIOD_ID,
      expiresAt: "2026-08-18T12:10:00.000Z",
      attemptCount: 1,
    });

    await expect(runWebTurn()).rejects.toBeInstanceOf(
      AIProcessingInProgressError,
    );
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
    expect(mocks.releaseAIReplyUnit).not.toHaveBeenCalled();
  });

  it("returns the typed allowance boundary before Anthropic", async () => {
    mocks.reserveAIReplyUnit.mockResolvedValue({
      outcome: "limit_reached",
      usagePeriodId: WEB_USAGE_PERIOD_ID,
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-09-01T00:00:00.000Z",
      plan: "chat_only",
      allowance: 200,
      completedReplies: 200,
      activeReservations: 0,
      remainingReplies: 0,
      allowanceRenewal: "scheduled",
      resetAt: "2026-09-01T00:00:00.000Z",
    });

    await expect(runWebTurn()).rejects.toMatchObject({
      name: "AIReplyLimitReachedError",
      resetAt: "2026-09-01T00:00:00.000Z",
      allowanceRenewal: "scheduled",
    });
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
    expect(mocks.addMessage).not.toHaveBeenCalled();
  });

  it("releases a provider failure and never returns the unpersisted fallback", async () => {
    mocks.anthropicCreate.mockRejectedValueOnce(
      Object.assign(new Error("provider rejected request"), { status: 400 }),
    );

    await expect(runWebTurn()).rejects.toBeInstanceOf(AIProcessingStateError);
    expect(mocks.releaseAIReplyUnit).toHaveBeenCalledWith({
      reservationId: WEB_RESERVATION_ID,
      attemptToken: WEB_ATTEMPT_TOKEN,
      reason: "processing_failed",
    });
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.recordAnthropicProviderCall).toHaveBeenCalledWith(
      expect.objectContaining({
        succeeded: false,
        errorCode: "Error_400",
      }),
    );
    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
  });

  it("returns a provider success after a bounded accounting wait and safely drains a late failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T12:00:00.000Z"));
    const startedAt = Date.now();
    const pendingAccounting = deferred<string>();
    mocks.recordAnthropicProviderCall.mockReturnValueOnce(
      pendingAccounting.promise,
    );

    try {
      const processing = runWebTurn();
      let turnSettled = false;
      void processing.then(
        () => {
          turnSettled = true;
        },
        () => {
          turnSettled = true;
        },
      );

      await vi.waitFor(() => {
        expect(mocks.recordAnthropicProviderCall).toHaveBeenCalledOnce();
      });
      expect(turnSettled).toBe(false);
      expect(mocks.anthropicCreate).toHaveBeenCalledOnce();

      const accountingCall =
        mocks.recordAnthropicProviderCall.mock.calls[0]?.[0];
      expect(accountingCall).toMatchObject({
        callIdempotencyKey: `ai:${WEB_RESERVATION_ID}:${WEB_ATTEMPT_TOKEN}:0`,
        succeeded: true,
      });
      await vi.advanceTimersByTimeAsync(EXPECTED_ANTHROPIC_ACCOUNTING_WAIT_MS);

      await expect(processing).resolves.toMatchObject({
        text: "Absolutely.",
        assistantMessageId: "00000000-0000-4000-8000-000000000023",
      });
      expect(turnSettled).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(4 * 60_000);
      expect(mocks.anthropicCreate).toHaveBeenCalledOnce();
      expect(mocks.recordAnthropicProviderCall).toHaveBeenCalledOnce();
      expect(mocks.finalizeAIReplyUnit).toHaveBeenCalledOnce();
      expect(console.error).toHaveBeenCalledWith(
        "[ai-engine] Anthropic call accounting timed out",
        expect.objectContaining({
          businessId: BUSINESS_ID,
          callIdempotencyKey: accountingCall?.callIdempotencyKey,
          waitMs: EXPECTED_ANTHROPIC_ACCOUNTING_WAIT_MS,
        }),
      );

      pendingAccounting.reject(new Error("late accounting failure"));
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(console.error).toHaveBeenCalledWith(
        "[ai-engine] Anthropic call accounting failed",
        expect.objectContaining({
          businessId: BUSINESS_ID,
          callIdempotencyKey: accountingCall?.callIdempotencyKey,
          error: "Error",
        }),
      );
      expect(mocks.anthropicCreate).toHaveBeenCalledOnce();
      expect(mocks.recordAnthropicProviderCall).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a provider failure after bounded accounting without a duplicate attempt or ledger key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T12:00:00.000Z"));
    const startedAt = Date.now();
    const pendingAccounting = deferred<string>();
    mocks.recordAnthropicProviderCall.mockReturnValueOnce(
      pendingAccounting.promise,
    );
    mocks.anthropicCreate.mockRejectedValueOnce(
      Object.assign(new Error("provider rejected request"), { status: 400 }),
    );

    try {
      const processing = runWebTurn();
      const rejected = expect(processing).rejects.toBeInstanceOf(
        AIProcessingStateError,
      );

      await vi.waitFor(() => {
        expect(mocks.recordAnthropicProviderCall).toHaveBeenCalledOnce();
      });
      expect(mocks.anthropicCreate).toHaveBeenCalledOnce();

      const accountingCall =
        mocks.recordAnthropicProviderCall.mock.calls[0]?.[0];
      await vi.advanceTimersByTimeAsync(EXPECTED_ANTHROPIC_ACCOUNTING_WAIT_MS);
      await rejected;

      expect(Date.now() - startedAt).toBeLessThan(4 * 60_000);
      expect(mocks.anthropicCreate).toHaveBeenCalledOnce();
      expect(mocks.recordAnthropicProviderCall).toHaveBeenCalledOnce();
      expect(accountingCall).toMatchObject({
        callIdempotencyKey: `ai:${WEB_RESERVATION_ID}:${WEB_ATTEMPT_TOKEN}:0`,
        succeeded: false,
        errorCode: "Error_400",
      });
      expect(console.error).toHaveBeenCalledWith(
        "[ai-engine] Anthropic call accounting timed out",
        expect.objectContaining({
          businessId: BUSINESS_ID,
          callIdempotencyKey: accountingCall?.callIdempotencyKey,
          waitMs: EXPECTED_ANTHROPIC_ACCOUNTING_WAIT_MS,
        }),
      );
      expect(mocks.releaseAIReplyUnit).toHaveBeenCalledOnce();

      pendingAccounting.resolve("00000000-0000-4000-8000-000000000030");
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(mocks.anthropicCreate).toHaveBeenCalledOnce();
      expect(mocks.recordAnthropicProviderCall).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records and bounds all three attempts before releasing on repeated timeouts", async () => {
    const timeoutError = Object.assign(new Error("request timed out"), {
      name: "APIConnectionTimeoutError",
    });
    mocks.anthropicCreate.mockRejectedValue(timeoutError);

    await expect(runWebTurn()).rejects.toBeInstanceOf(AIProcessingStateError);

    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(3);
    expect(mocks.anthropicCreate.mock.calls.map((call) => call[1])).toEqual(
      Array(3).fill(EXPECTED_ANTHROPIC_CALL_OPTIONS),
    );
    expect(mocks.recordAnthropicProviderCall).toHaveBeenCalledTimes(3);
    const accountingCalls = mocks.recordAnthropicProviderCall.mock.calls.map(
      ([call]) => call,
    );
    expect(accountingCalls).toEqual(
      Array(3).fill(
        expect.objectContaining({
          succeeded: false,
          errorCode: "APIConnectionTimeoutError",
        }),
      ),
    );
    expect(
      new Set(accountingCalls.map((call) => call.callIdempotencyKey)).size,
    ).toBe(3);
    expect(mocks.releaseAIReplyUnit).toHaveBeenCalledOnce();
  });

  it("retries a transient failure for existing Growth SMS and accounts every HTTP attempt", async () => {
    mocks.anthropicCreate
      .mockRejectedValueOnce(
        Object.assign(new Error("provider unavailable"), { status: 503 }),
      )
      .mockResolvedValueOnce({
        id: "msg_provider_sms_retry",
        stop_reason: "end_turn",
        usage: { input_tokens: 40, output_tokens: 12 },
        content: [{ type: "text", text: "Recovered after retry." }],
      });

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Hello",
        "sms",
      ),
    ).resolves.toBe("Recovered after retry.");

    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(2);
    const accountingCalls = mocks.recordAnthropicProviderCall.mock.calls.map(
      ([call]) => call,
    );
    expect(accountingCalls).toHaveLength(2);
    expect(accountingCalls[0]).toMatchObject({
      reservationId: null,
      succeeded: false,
      errorCode: "Error_503",
    });
    expect(accountingCalls[1]).toMatchObject({
      reservationId: null,
      succeeded: true,
      providerRequestId: "msg_provider_sms_retry",
    });
    expect(accountingCalls[0]?.callIdempotencyKey).not.toBe(
      accountingCalls[1]?.callIdempotencyKey,
    );
  });

  it("does not continue a tool loop after the whole-turn deadline", async () => {
    let now = Date.parse("2026-08-18T12:00:00.000Z");
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.anthropicCreate.mockImplementationOnce(async () => {
      now += 4 * 60_000 + 1;
      return {
        id: "msg_provider_late",
        stop_reason: "tool_use",
        usage: { input_tokens: 20, output_tokens: 5 },
        content: [
          {
            type: "tool_use",
            id: "late_contact_tool",
            name: "save_contact_name",
            input: { name: "Too Late" },
          },
        ],
      };
    });

    try {
      await expect(runWebTurn()).rejects.toMatchObject({
        name: "AIProcessingStateError",
        message: "AI processing exceeded its bounded turn deadline.",
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
    expect(mocks.updateContactName).not.toHaveBeenCalled();
    expect(mocks.finalizeAIReplyUnit).not.toHaveBeenCalled();
    expect(mocks.releaseAIReplyUnit).toHaveBeenCalledOnce();
  });

  it("stops awaiting a hung tool before the shared lease and ignores its late resolution", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T12:00:00.000Z"));
    const startedAt = Date.now();
    const pendingBookingRequest = deferred<"inserted">();
    setAiSettings({ booking_mode: "collect_info" });
    mocks.recordBookingRequest.mockReturnValueOnce(pendingBookingRequest.promise);
    mocks.anthropicCreate.mockResolvedValueOnce({
      id: "msg_provider_hung_tool",
      stop_reason: "tool_use",
      usage: { input_tokens: 40, output_tokens: 8 },
      content: [
        {
          type: "tool_use",
          id: "hung_booking_request",
          name: "record_booking_request",
          input: {
            requested_service: "Estimate",
            requested_time_text: "Tomorrow morning",
          },
        },
      ],
    });

    try {
      const processing = runWebTurn();
      await vi.waitFor(() => {
        expect(mocks.recordBookingRequest).toHaveBeenCalledOnce();
      });

      const rejectedAtDeadline = expect(processing).rejects.toMatchObject({
        name: "AIProcessingStateError",
        message: "AI processing exceeded its bounded turn deadline.",
      });
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      await rejectedAtDeadline;

      expect(Date.now() - startedAt).toBeLessThan(5 * 60_000);
      expect(mocks.releaseAIReplyUnit).toHaveBeenCalledOnce();
      expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
      expect(mocks.finalizeAIReplyUnit).not.toHaveBeenCalled();
      expect(mocks.addMessage).not.toHaveBeenCalled();

      pendingBookingRequest.resolve("inserted");
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
      expect(mocks.addMessage).not.toHaveBeenCalled();
      expect(mocks.finalizeAIReplyUnit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases an empty model result instead of consuming a reply", async () => {
    mocks.anthropicCreate.mockResolvedValueOnce({
      id: "msg_provider_empty",
      stop_reason: "end_turn",
      usage: { input_tokens: 50, output_tokens: 0 },
      content: [],
    });

    await expect(runWebTurn()).rejects.toBeInstanceOf(AIProcessingStateError);
    expect(mocks.releaseAIReplyUnit).toHaveBeenCalledOnce();
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.finalizeAIReplyUnit).not.toHaveBeenCalled();
  });

  it("maps a reused client id conflict to the route-safe typed error", async () => {
    mocks.reserveAIReplyUnit.mockRejectedValueOnce(
      new mocks.AIReplyIdempotencyConflictError(),
    );

    await expect(runWebTurn()).rejects.toBeInstanceOf(
      AIProcessingIdempotencyConflictError,
    );
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });
});

describe("processIncomingMessage entitlement and takeover defenses", () => {
  it("rejects Starter SMS before creating a contact or calling Anthropic", async () => {
    mocks.resolveBusinessEntitlements.mockResolvedValue(STARTER);

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Hello",
        "sms"
      )
    ).rejects.toMatchObject({
      reason: "feature_not_entitled",
    });

    expect(mocks.findOrCreateContact).not.toHaveBeenCalled();
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });

  it("rejects a manual SMS conversation before persistence or Anthropic", async () => {
    mocks.getConversationAiState.mockResolvedValue({
      ...CONVERSATION,
      status: "handed_off",
      is_ai_handling: false,
    });

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Hello",
        "sms"
      )
    ).rejects.toMatchObject({
      reason: "conversation_in_manual_mode",
    });

    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });

  it("fails safely when the current Human/AI state cannot be read", async () => {
    mocks.getConversationAiState.mockRejectedValue(
      new Error("connection reset")
    );

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Hello",
        "sms"
      )
    ).rejects.toBeInstanceOf(AIProcessingStateError);

    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });

  it("surfaces contact persistence uncertainty instead of composing a fallback reply", async () => {
    mocks.findOrCreateContact.mockRejectedValue(
      new Error("contacts database unavailable")
    );

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Hello",
        "sms"
      )
    ).rejects.toBeInstanceOf(AIProcessingStateError);

    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });

  it("surfaces AI context query errors before calling Anthropic", async () => {
    tableResults.set("ai_settings", {
      data: null,
      error: { message: "connection reset" },
    });

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Hello",
        "sms"
      )
    ).rejects.toBeInstanceOf(AIProcessingStateError);

    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });

  it("strips advanced guardrails for Growth while retaining entitled booking tools", async () => {
    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Can I book?",
        "sms"
      )
    ).resolves.toBe("Absolutely.");

    expect(mocks.buildSystemPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ guardrails: [] }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      true,
      "sms",
      true
    );
    expect(mocks.anthropicCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "check_availability" }),
        ]),
      }),
      EXPECTED_ANTHROPIC_CALL_OPTIONS,
    );
    expect(mocks.buildConversationMessages).toHaveBeenCalledWith(
      expect.any(Array)
    );
  });

  it("applies saved advanced guardrails for Full", async () => {
    mocks.resolveBusinessEntitlements.mockResolvedValue(FULL);

    await processIncomingMessage(
      BUSINESS_ID,
      "+15745550100",
      null,
      "Can I book?",
      "sms"
    );

    expect(mocks.buildSystemPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ guardrails: ["promise a price"] }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      true,
      "sms",
      true
    );
  });

  it("loads active approved richer knowledge into the prompt without changing legacy accounts", async () => {
    const approvedKnowledge = [
      {
        id: "knowledge-1",
        business_id: BUSINESS_ID,
        kind: "overview",
        category: "general",
        title: "Business overview",
        content: "A locally owned plumbing business.",
        source: "website_scan",
        is_active: true,
        sort_order: 0,
        verified_at: "2026-08-28T00:00:00.000Z",
        created_at: "2026-08-28T00:00:00.000Z",
        updated_at: "2026-08-28T00:00:00.000Z",
      },
    ];
    tableResults.set("business_knowledge_items", {
      data: approvedKnowledge,
      error: null,
    });

    await processIncomingMessage(
      BUSINESS_ID,
      "+15745550100",
      null,
      "What should I know about you?",
      "sms"
    );

    expect(mocks.buildSystemPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      true,
      "sms",
      true,
      approvedKnowledge
    );
  });

  it("falls back to the legacy prompt when approved knowledge cannot be loaded", async () => {
    tableResults.set("business_knowledge_items", {
      data: null,
      error: { message: "temporary knowledge read failure" },
    });

    await processIncomingMessage(
      BUSINESS_ID,
      "+15745550100",
      null,
      "Are you open?",
      "sms"
    );

    expect(mocks.buildSystemPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      true,
      "sms",
      true
    );
  });

  it("omits Calendar context and tools when direct booking is not entitled", async () => {
    mocks.canUseFeature.mockImplementation(
      (_entitlements: unknown, feature: string) =>
        feature === "ai_sms_conversations"
    );

    await processIncomingMessage(
      BUSINESS_ID,
      "+15745550100",
      null,
      "Can I book?",
      "sms"
    );

    expect(mocks.buildSystemPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      false,
      "sms",
      true
    );
    expect(mocks.anthropicCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.not.arrayContaining([
          expect.objectContaining({ name: "check_availability" }),
        ]),
      }),
      EXPECTED_ANTHROPIC_CALL_OPTIONS,
    );
  });

  it("refuses a create_booking tool call when direct booking tools are disabled", async () => {
    mocks.shouldIncludeCalendarTools.mockReturnValue(false);
    mocks.anthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "create_booking",
            input: {
              customer_name: "Pat",
              service_name: "Estimate",
              start_time: "2026-08-01T10:00:00",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "I can collect your details." }],
      });

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Please book that.",
        "sms"
      )
    ).resolves.toBe("I can collect your details.");

    expect(mocks.createBooking).not.toHaveBeenCalled();
  });

  it("does not insert the inbound message twice when the webhook already persisted it", async () => {
    await processIncomingMessage(
      BUSINESS_ID,
      "+15745550100",
      null,
      "Can I book?",
      "sms",
      null,
      {
        persistCustomer: false,
        persistAssistant: false,
        contact: CONTACT as never,
        conversation: CONVERSATION as never,
      }
    );

    expect(mocks.resolveBusinessEntitlements).toHaveBeenCalledWith(BUSINESS_ID);
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.getConversationHistory).toHaveBeenCalledWith(CONVERSATION.id);
    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
  });

  it("links a direct booking to the customer message persisted by the engine", async () => {
    mocks.anthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "create_booking",
            input: {
              customer_name: "Pat",
              service_name: "Estimate",
              start_time: "2026-08-01T10:00:00",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Booked." }],
      });

    await processIncomingMessage(
      BUSINESS_ID,
      "+15745550100",
      null,
      "Please book that.",
      "sms"
    );

    expect(mocks.createBooking).toHaveBeenCalledWith(
      BUSINESS_ID,
      expect.objectContaining({
        customerName: "Pat",
        serviceName: "Estimate",
      }),
      "America/New_York",
      {
        contactId: CONTACT.id,
        conversationId: CONVERSATION.id,
        sourceMessageId: "message_1",
      }
    );
  });

  it("passes normalized booking email and explicit invalid duration to the authoritative calendar validator", async () => {
    mocks.anthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "create_booking",
            input: {
              customer_name: "Pat",
              customer_email: "  PAT@EXAMPLE.COM  ",
              service_name: "Estimate",
              start_time: "2026-08-01T10:00:00",
              duration_minutes: 0,
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Booked." }],
      });

    await processIncomingMessage(
      BUSINESS_ID,
      "+15745550100",
      null,
      "Please book that.",
      "sms",
    );

    expect(mocks.createBooking).toHaveBeenCalledWith(
      BUSINESS_ID,
      expect.objectContaining({
        customerEmail: "pat@example.com",
        durationMinutes: 0,
      }),
      "America/New_York",
      expect.anything(),
    );
    expect(mocks.updateContactEmail).not.toHaveBeenCalled();
  });

  it("permits at most one availability lookup and one booking attempt per inbound message", async () => {
    mocks.checkAvailability.mockResolvedValue(["10:00 AM"]);
    mocks.anthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "availability_1",
            name: "check_availability",
            input: { date: "2026-08-20" },
          },
          {
            type: "tool_use",
            id: "availability_2",
            name: "check_availability",
            input: { date: "2026-08-21" },
          },
          {
            type: "tool_use",
            id: "booking_1",
            name: "create_booking",
            input: {
              customer_name: "Pat",
              service_name: "Estimate",
              start_time: "2026-08-20T10:00:00-04:00",
            },
          },
          {
            type: "tool_use",
            id: "booking_2",
            name: "create_booking",
            input: {
              customer_name: "Pat",
              service_name: "Estimate",
              start_time: "2026-08-20T11:00:00-04:00",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Your appointment is set." }],
      });

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Please find a time and book it.",
        "sms",
      ),
    ).resolves.toBe("Your appointment is set.");

    expect(mocks.checkAvailability).toHaveBeenCalledOnce();
    expect(mocks.createBooking).toHaveBeenCalledOnce();
    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(2);
    expect(mocks.anthropicCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.arrayContaining([
              expect.objectContaining({
                tool_use_id: "availability_2",
                content:
                  "That calendar action was already attempted for this message. Do not repeat it; continue using the result already returned.",
              }),
              expect.objectContaining({
                tool_use_id: "booking_2",
                content:
                  "That calendar action was already attempted for this message. Do not repeat it; continue using the result already returned.",
              }),
            ]),
          }),
        ]),
      }),
      EXPECTED_ANTHROPIC_CALL_OPTIONS,
    );
  });

  it("uses a webhook-persisted source message for retry-stable direct booking", async () => {
    mocks.anthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "create_booking",
            input: {
              customer_name: "Pat",
              service_name: "Estimate",
              start_time: "2026-08-01T10:00:00",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Booked." }],
      });

    await processIncomingMessage(
      BUSINESS_ID,
      "+15745550100",
      null,
      "Please book that.",
      "sms",
      null,
      {
        persistCustomer: false,
        persistAssistant: false,
        sourceMessageId: "provider_message_1",
        contact: CONTACT as never,
        conversation: CONVERSATION as never,
      }
    );

    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.createBooking).toHaveBeenCalledWith(
      BUSINESS_ID,
      expect.anything(),
      "America/New_York",
      expect.objectContaining({ sourceMessageId: "provider_message_1" })
    );
  });

  it("surfaces unlinked direct booking state instead of feeding it back to Anthropic", async () => {
    mocks.anthropicCreate.mockResolvedValueOnce({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool_1",
          name: "create_booking",
          input: {
            customer_name: "Pat",
            service_name: "Estimate",
            start_time: "2026-08-01T10:00:00",
          },
        },
      ],
    });

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Please book that.",
        "sms",
        null,
        {
          persistCustomer: false,
          persistAssistant: false,
          contact: CONTACT as never,
          conversation: CONVERSATION as never,
        }
      )
    ).rejects.toBeInstanceOf(AIProcessingStateError);

    expect(mocks.createBooking).not.toHaveBeenCalled();
    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.incrementLeadScore).not.toHaveBeenCalled();
  });
});

describe("processIncomingMessage collect-mode request persistence", () => {
  const requestInput = {
    requested_service: "  Kitchen estimate  ",
    requested_time_text: "next Tuesday after lunch",
    customer_name: " Tool Pat ",
    customer_phone: "   ",
  };

  function queueRequestTool(
    input: Record<string, unknown> = requestInput,
    finalText = "The owner will review your appointment request."
  ) {
    queueRequestToolOnly(input);
    mocks.anthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: finalText }],
      });
  }

  function queueRequestToolOnly(
    input: Record<string, unknown> = requestInput
  ) {
    mocks.anthropicCreate.mockResolvedValueOnce({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "request_tool_1",
          name: "record_booking_request",
          input,
        },
      ],
    });
  }

  function lastToolResultContent(): string | undefined {
    const followupParams = mocks.anthropicCreate.mock.calls[1]?.[0] as
      | { messages?: Array<{ content?: Array<{ content?: string }> }> }
      | undefined;
    const messages = followupParams?.messages ?? [];
    return messages[messages.length - 1]?.content?.[0]?.content;
  }

  beforeEach(() => {
    setBusinessGoal("book");
    setAiSettings({
      booking_enabled: true,
      booking_mode: "collect_info",
    });
  });

  it("writes at tool time with raw request text and explicit-then-fresh snapshot fallbacks", async () => {
    queueRequestTool();

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Please request a kitchen estimate.",
        "sms"
      )
    ).resolves.toBe("The owner will review your appointment request.");

    expect(mocks.recordBookingRequest).toHaveBeenCalledOnce();
    expect(mocks.recordBookingRequest).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      contactId: CONTACT.id,
      conversationId: CONVERSATION.id,
      sourceMessageId: "message_1",
      requestedService: "Kitchen estimate",
      requestedTimeText: "next Tuesday after lunch",
      customerName: "Tool Pat",
      customerPhone: "+15745550199",
      customerEmail: "stored@example.com",
    });
    expect(lastToolResultContent()).toBe(
      BOOKING_REQUEST_RECORDED_TOOL_RESULT_FOR_TEST
    );
    expect(mocks.anthropicCreate.mock.calls[1]?.[0].tools).toEqual([
      ...EXPECTED_CONTACT_TOOLS,
      EXPECTED_BOOKING_REQUEST_TOOL,
    ]);
    expect(
      mocks.recordBookingRequest.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.anthropicCreate.mock.invocationCallOrder[1]);
    expect(
      mocks.anthropicCreate.mock.invocationCallOrder[1]
    ).toBeLessThan(mocks.addMessage.mock.invocationCallOrder[1]);
  });

  it("uses the caller-owned durable SMS source without reinserting the inbound message", async () => {
    const sourceMessageId = "provider-message-request-1";
    queueRequestTool();

    await processIncomingMessageDetailed(
      BUSINESS_ID,
      "+15745550100",
      null,
      "Please request a kitchen estimate.",
      "sms",
      null,
      {
        persistCustomer: false,
        persistAssistant: false,
        sourceMessageId,
        contact: CONTACT as never,
        conversation: CONVERSATION as never,
      }
    );

    expect(mocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.recordBookingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: CONTACT.id,
        conversationId: CONVERSATION.id,
        sourceMessageId,
      })
    );
  });

  it("uses the web widget message persisted by the engine as request provenance", async () => {
    const webConversation = { ...CONVERSATION, channel: "web_chat" };
    mocks.getOrCreateConversation.mockResolvedValue(webConversation);
    queueRequestTool();

    await processIncomingMessageDetailed(
      BUSINESS_ID,
      null,
      "pat@example.com",
      "Please request a kitchen estimate.",
      "web_chat",
      "widget-session"
    );

    expect(mocks.addMessage).toHaveBeenNthCalledWith(
      1,
      webConversation.id,
      BUSINESS_ID,
      "customer",
      "Please request a kitchen estimate.",
      "web_chat"
    );
    expect(mocks.recordBookingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: CONTACT.id,
        conversationId: webConversation.id,
        sourceMessageId: "message_1",
      })
    );
  });

  it("treats a duplicate writer result as successful without claiming a booking", async () => {
    mocks.recordBookingRequest.mockResolvedValueOnce("duplicate");
    queueRequestTool({
      requested_service: "not specified",
      requested_time_text: "not specified",
    });

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "I still need an appointment.",
        "sms"
      )
    ).resolves.toBe("The owner will review your appointment request.");

    expect(mocks.recordBookingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedService: "not specified",
        requestedTimeText: "not specified",
      })
    );
    expect(lastToolResultContent()).toBe(
      BOOKING_REQUEST_RECORDED_TOOL_RESULT_FOR_TEST
    );
  });

  it("runs the realistic tool in authenticated preview without reading snapshots or writing a row", async () => {
    queueRequestTool();

    await expect(
      processIncomingMessageDetailed(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Please request a kitchen estimate.",
        "sms",
        null,
        { persistBookingRequests: false }
      )
    ).resolves.toMatchObject({
      text: "The owner will review your appointment request.",
      sourceMessageId: "message_1",
    });

    expect(mocks.recordBookingRequest).not.toHaveBeenCalled();
    expect(
      mocks.from.mock.calls.filter(([table]) => table === "contacts")
    ).toHaveLength(0);
    expect(lastToolResultContent()).toBe(
      BOOKING_REQUEST_PREVIEW_TOOL_RESULT_FOR_TEST
    );
  });

  it("rejects a request tool call without durable source-message provenance", async () => {
    queueRequestToolOnly();

    const processing = processIncomingMessageDetailed(
      BUSINESS_ID,
      "+15745550100",
      null,
      "Please request a kitchen estimate.",
      "sms",
      null,
      {
        persistCustomer: false,
        persistAssistant: false,
        contact: CONTACT as never,
        conversation: CONVERSATION as never,
      }
    );

    await expect(processing).rejects.toMatchObject({
      name: "AIProcessingStateError",
      message:
        "Appointment-request recording requires a durably persisted source message.",
    });
    expect(mocks.recordBookingRequest).not.toHaveBeenCalled();
    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
    expect(mocks.addMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "disabled",
      arrange: () =>
        setAiSettings({
          booking_enabled: false,
          booking_mode: "collect_info",
        }),
    },
    {
      label: "schedule-direct",
      arrange: () =>
        setAiSettings({
          booking_enabled: true,
          booking_mode: "schedule_direct",
        }),
    },
    {
      label: "signup",
      arrange: () => setBusinessGoal("signup", "https://example.com/signup"),
    },
    {
      label: "booking-paused",
      arrange: () =>
        mocks.resolveBusinessOperationalControls.mockResolvedValue(
          operationalControls({
            bookingsPausedAt: "2026-08-11T12:00:00.000Z",
          })
        ),
    },
    {
      label: "unexposed",
      arrange: () =>
        mocks.shouldIncludeBookingRequestTools.mockReturnValue(false),
    },
  ])("rejects a forced $label request tool without writing", async ({ arrange }) => {
    arrange();
    queueRequestTool();

    await processIncomingMessage(
      BUSINESS_ID,
      "+15745550100",
      null,
      "Please request an appointment.",
      "sms"
    );

    expect(mocks.recordBookingRequest).not.toHaveBeenCalled();
    expect(
      mocks.from.mock.calls.filter(([table]) => table === "contacts")
    ).toHaveLength(0);
    expect(lastToolResultContent()).toBe(
      BOOKING_REQUEST_UNAVAILABLE_TOOL_RESULT_FOR_TEST
    );
  });

  it.each([
    {
      label: "mode changes",
      mutate: () =>
        setAiSettings({
          booking_enabled: true,
          booking_mode: "schedule_direct",
        }),
    },
    {
      label: "goal changes to signup",
      mutate: () =>
        setBusinessGoal("signup", "https://example.com/signup"),
    },
    {
      label: "bookings pause",
      mutate: () =>
        mocks.resolveBusinessOperationalControls.mockResolvedValue(
          operationalControls({
            bookingsPausedAt: "2026-08-11T12:00:00.000Z",
          })
        ),
    },
  ])("rechecks fresh controls before writing when $label", async ({ mutate }) => {
    mocks.anthropicCreate
      .mockImplementationOnce(async () => {
        mutate();
        return {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "request_tool_1",
              name: "record_booking_request",
              input: requestInput,
            },
          ],
        };
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "I cannot record that request." }],
      });

    await processIncomingMessage(
      BUSINESS_ID,
      "+15745550100",
      null,
      "Please request an appointment.",
      "sms"
    );

    expect(mocks.recordBookingRequest).not.toHaveBeenCalled();
    expect(lastToolResultContent()).toBe(
      BOOKING_REQUEST_UNAVAILABLE_TOOL_RESULT_FOR_TEST
    );
    expect(mocks.anthropicCreate.mock.calls[1]?.[0].tools).toEqual(
      EXPECTED_CONTACT_TOOLS
    );
    expect(mocks.buildSystemPrompt).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      true,
      "sms",
      false
    );
  });

  it("fails closed when the fresh booking configuration cannot be read", async () => {
    mocks.anthropicCreate.mockImplementationOnce(async () => {
      tableResults.set("ai_settings", {
        data: null,
        error: { message: "configuration unavailable" },
      });
      return {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "request_tool_1",
            name: "record_booking_request",
            input: requestInput,
          },
        ],
      };
    });

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Please request an appointment.",
        "sms"
      )
    ).rejects.toMatchObject({
      name: "AIProcessingStateError",
      message: `Could not recheck booking-request configuration for business ${BUSINESS_ID}.`,
    });
    expect(mocks.recordBookingRequest).not.toHaveBeenCalled();
    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
  });

  it("turns tool-time operational uncertainty into a retryable AI state failure", async () => {
    const resolutionError = new OperationalControlsResolutionError({
      code: "business_lookup_failed",
      businessId: BUSINESS_ID,
      message: "operational controls unavailable",
    });
    mocks.resolveBusinessOperationalControls
      .mockResolvedValueOnce(ACTIVE_CONTROLS)
      .mockResolvedValueOnce(ACTIVE_CONTROLS)
      .mockRejectedValueOnce(resolutionError);
    queueRequestToolOnly();

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Please request an appointment.",
        "sms"
      )
    ).rejects.toMatchObject({
      name: "AIProcessingStateError",
      message: `Could not recheck booking-request operational controls for business ${BUSINESS_ID}.`,
      cause: resolutionError,
    });
    expect(mocks.recordBookingRequest).not.toHaveBeenCalled();
    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the freshly linked contact cannot be read", async () => {
    mocks.anthropicCreate.mockImplementationOnce(async () => {
      tableResults.set("contacts", {
        data: null,
        error: { message: "contact unavailable" },
      });
      return {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "request_tool_1",
            name: "record_booking_request",
            input: requestInput,
          },
        ],
      };
    });

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Please request an appointment.",
        "sms"
      )
    ).rejects.toMatchObject({
      name: "AIProcessingStateError",
      message: `Could not load the booking-request contact for business ${BUSINESS_ID}.`,
    });
    expect(mocks.recordBookingRequest).not.toHaveBeenCalled();
    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
  });

  it("turns writer and invariant failures into retryable AI state failures", async () => {
    const collision = new Error("immutable collision");
    mocks.recordBookingRequest.mockRejectedValueOnce(collision);
    queueRequestToolOnly();

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Please request an appointment.",
        "sms"
      )
    ).rejects.toMatchObject({
      name: "AIProcessingStateError",
      message: `Could not record the appointment request for business ${BUSINESS_ID}.`,
      cause: collision,
    });
    expect(mocks.recordBookingRequest).toHaveBeenCalledOnce();
    expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
    expect(mocks.addMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps the tool-time row when the follow-up model call fails", async () => {
    const followupFailure = new Error("follow-up unavailable");
    mocks.anthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "request_tool_1",
            name: "record_booking_request",
            input: requestInput,
          },
        ],
      })
      .mockRejectedValueOnce(followupFailure);

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Please request an appointment.",
        "sms"
      )
    ).resolves.toContain("brief technical issue");

    expect(mocks.recordBookingRequest).toHaveBeenCalledOnce();
    expect(
      mocks.recordBookingRequest.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.anthropicCreate.mock.invocationCallOrder[1]);
    expect(mocks.addMessage).toHaveBeenCalledTimes(1);
  });

  it("keeps the tool-time row when later assistant persistence fails", async () => {
    const assistantWriteFailure = new Error("assistant insert unavailable");
    mocks.addMessage
      .mockResolvedValueOnce({ id: "message_1" })
      .mockRejectedValueOnce(assistantWriteFailure);
    queueRequestTool();

    await expect(
      processIncomingMessage(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Please request an appointment.",
        "sms"
      )
    ).rejects.toMatchObject({
      name: "AIProcessingStateError",
      message: `Could not persist the assistant message for conversation ${CONVERSATION.id}.`,
      cause: assistantWriteFailure,
    });

    expect(mocks.recordBookingRequest).toHaveBeenCalledOnce();
    expect(
      mocks.recordBookingRequest.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.addMessage.mock.invocationCallOrder[1]);
  });
});

describe("processIncomingMessageDetailed knowledge-gap signaling", () => {
  it("returns gap metadata and persists only the cleaned response", async () => {
    mocks.anthropicCreate.mockResolvedValue({
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: `I don't see free trials mentioned. Please call us.\n${KNOWLEDGE_GAP_SIGNAL}`,
        },
      ],
    });

    await expect(
      processIncomingMessageDetailed(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Do you offer free trials?",
        "sms"
      )
    ).resolves.toEqual({
      text: "I don't see free trials mentioned. Please call us.",
      knowledgeGapDetected: true,
      conversationId: CONVERSATION.id,
      sourceMessageId: "message_1",
      actions: [],
      assistantMessageId: "message_1",
    });

    expect(mocks.addMessage).toHaveBeenNthCalledWith(
      2,
      CONVERSATION.id,
      BUSINESS_ID,
      "assistant",
      "I don't see free trials mentioned. Please call us.",
      "sms"
    );
  });

  it("classifies the final response after the tool loop", async () => {
    mocks.anthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "save_contact_name",
            input: { name: "Pat" },
          },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text: `Thanks, Pat. I don't see trial details. Please call us.\n${KNOWLEDGE_GAP_SIGNAL}`,
          },
        ],
      });

    const result = await processIncomingMessageDetailed(
      BUSINESS_ID,
      "+15745550100",
      null,
      "I'm Pat. Is there a free trial?",
      "sms"
    );

    expect(result).toMatchObject({
      text: "Thanks, Pat. I don't see trial details. Please call us.",
      knowledgeGapDetected: true,
    });
    expect(mocks.updateContactName).toHaveBeenCalledWith(CONTACT.id, "Pat");
    expect(mocks.parseKnowledgeGapSignal).toHaveBeenCalledTimes(1);
  });

  it("returns caller-owned persistence references without writing messages", async () => {
    const result = await processIncomingMessageDetailed(
      BUSINESS_ID,
      "+15745550100",
      null,
      "Do you offer free trials?",
      "sms",
      null,
      {
        persistCustomer: false,
        persistAssistant: false,
        sourceMessageId: "provider-message-1",
        contact: CONTACT as never,
        conversation: CONVERSATION as never,
      }
    );

    expect(result).toEqual({
      text: "Absolutely.",
      knowledgeGapDetected: false,
      conversationId: CONVERSATION.id,
      sourceMessageId: "provider-message-1",
      actions: [],
      assistantMessageId: null,
    });
    expect(mocks.addMessage).not.toHaveBeenCalled();
  });

  it("uses the fallback when stripping leaves no customer-visible text", async () => {
    mocks.anthropicCreate.mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: KNOWLEDGE_GAP_SIGNAL }],
    });

    const result = await processIncomingMessageDetailed(
      BUSINESS_ID,
      "+15745550100",
      null,
      "Do you offer free trials?",
      "sms"
    );

    expect(result.text).toContain("We're having a brief technical issue.");
    expect(result.knowledgeGapDetected).toBe(true);
    expect(mocks.addMessage).toHaveBeenNthCalledWith(
      2,
      CONVERSATION.id,
      BUSINESS_ID,
      "assistant",
      result.text,
      "sms"
    );
  });

  it("exact-strips the sentinel and disables classification if parsing throws", async () => {
    const sensitiveValue = "pat@example.com prompt-payload";
    const parserError = Object.assign(
      new Error(`parser failure for ${sensitiveValue}`),
      {
        status: 422,
        rawResponse: sensitiveValue,
        cause: new Error(sensitiveValue),
      },
    );
    mocks.parseKnowledgeGapSignal.mockImplementationOnce(() => {
      throw parserError;
    });
    mocks.anthropicCreate.mockResolvedValue({
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: `Please call us.\n${KNOWLEDGE_GAP_SIGNAL}`,
        },
      ],
    });

    const result = await processIncomingMessageDetailed(
      BUSINESS_ID,
      "+15745550100",
      null,
      "Do you offer free trials?",
      "sms"
    );

    expect(result).toMatchObject({
      text: "Please call us.",
      knowledgeGapDetected: false,
    });
    expect(console.error).toHaveBeenCalledWith(
      "[ai-engine] Operation failed",
      {
        category: "knowledge_gap_parser",
        name: "Error",
        status: 422,
      },
    );
    expectConsoleErrorsNotToContain(sensitiveValue);
  });
});

describe("processIncomingMessageDetailed goal-aware behavior", () => {
  it.each([undefined, null, "book", "quote", "callback"] as const)(
    "keeps the clean-origin SMS model/output projection for primary_goal=%s",
    async (primaryGoal) => {
      setBusinessGoal(primaryGoal);

      const result = await processIncomingMessageDetailed(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Can I book?",
        "sms"
      );

      expect(legacyGoldenHash(result)).toBe(
        "cfaa3122d6d5fdf4e38521aad0ea1e0e5b85570db3e85d5b4d2bfee9f6f79a27"
      );
      expect(result.actions).toEqual([]);
      expect(result.assistantMessageId).toBe("message_1");
      expect(
        mocks.anthropicCreate.mock.calls[0]?.[0].tools.map(
          (tool: { name: string }) => tool.name
        )
      ).toEqual([
        "save_contact_name",
        "save_contact_email",
        "check_availability",
        "create_booking",
      ]);
    }
  );

  it("keeps the clean-origin web-chat model/output projection", async () => {
    const webConversation = { ...CONVERSATION, channel: "web_chat" };
    mocks.getOrCreateConversation.mockResolvedValue(webConversation);
    setBusinessGoal(null);

    const result = await processIncomingMessageDetailed(
      BUSINESS_ID,
      null,
      null,
      "Can I book?",
      "web_chat"
    );

    expect(legacyGoldenHash(result)).toBe(
      "9760d2489472d9a48d39743f6dd7992a2a044d95e82b78d2a68185218913bbfa"
    );
    expect(result.actions).toEqual([]);
    expect(result.assistantMessageId).toBe("message_1");
  });

  it("adds only the appointment-request tool when collect-info booking is active", async () => {
    setBusinessGoal("book");
    const aiSettings = setAiSettings({
      booking_enabled: true,
      booking_mode: "collect_info",
    });

    const result = await processIncomingMessageDetailed(
      BUSINESS_ID,
      "+15745550100",
      null,
      "Can I book?",
      "sms"
    );

    expect(mocks.shouldIncludeBookingRequestTools).toHaveBeenCalledOnce();
    expect(mocks.shouldIncludeBookingRequestTools).toHaveBeenCalledWith(
      aiSettings,
      true
    );
    expect(mocks.shouldIncludeCalendarTools).not.toHaveBeenCalled();
    expect(mocks.anthropicCreate).toHaveBeenCalledOnce();
    expect(mocks.anthropicCreate.mock.calls[0]?.[0]).toEqual({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system: "SYSTEM PROMPT",
      messages: [{ role: "user", content: "Can I book?" }],
      tools: [...EXPECTED_CONTACT_TOOLS, EXPECTED_BOOKING_REQUEST_TOOL],
    });
    expect(result).toEqual({
      text: "Absolutely.",
      knowledgeGapDetected: false,
      conversationId: CONVERSATION.id,
      sourceMessageId: "message_1",
      actions: [],
      assistantMessageId: "message_1",
    });
  });

  it("keeps disconnected schedule-direct booking on the exact contact-only tool surface", async () => {
    setBusinessGoal("book");
    const aiSettings = setAiSettings({
      booking_enabled: true,
      booking_mode: "schedule_direct",
    });
    tableResults.set("google_calendar_tokens", {
      data: null,
      error: null,
    });

    await processIncomingMessageDetailed(
      BUSINESS_ID,
      "+15745550100",
      null,
      "Can I book?",
      "sms"
    );

    expect(mocks.shouldIncludeBookingRequestTools).toHaveBeenCalledWith(
      aiSettings,
      true
    );
    expect(mocks.shouldIncludeCalendarTools).toHaveBeenCalledWith(
      aiSettings,
      false,
      true
    );
    expect(mocks.anthropicCreate.mock.calls[0]?.[0].tools).toEqual(
      EXPECTED_CONTACT_TOOLS
    );
  });

  it.each([
    {
      label: "booking is disabled with schedule-direct saved",
      settings: {
        booking_enabled: false,
        booking_mode: "schedule_direct",
      },
      controls: ACTIVE_CONTROLS,
      bookingOperationallyAvailable: true,
    },
    {
      label: "booking is disabled with collect-info saved",
      settings: {
        booking_enabled: false,
        booking_mode: "collect_info",
      },
      controls: ACTIVE_CONTROLS,
      bookingOperationallyAvailable: true,
    },
    {
      label: "booking is operationally paused with schedule-direct saved",
      settings: {
        booking_enabled: true,
        booking_mode: "schedule_direct",
      },
      controls: operationalControls({
        bookingsPausedAt: "2026-08-10T12:00:00.000Z",
      }),
      bookingOperationallyAvailable: false,
    },
    {
      label: "booking is operationally paused with collect-info saved",
      settings: {
        booking_enabled: true,
        booking_mode: "collect_info",
      },
      controls: operationalControls({
        bookingsPausedAt: "2026-08-10T12:00:00.000Z",
      }),
      bookingOperationallyAvailable: false,
    },
  ] as const)(
    "assembles the exact legacy non-calendar request when $label",
    async (scenario) => {
      // Exact prompt bytes for these paths are independently frozen in
      // prompt.test.ts. Keep the engine mock fixed so this assertion isolates
      // model parameters, tool order, visible output, and persistence.
      setBusinessGoal("book");
      const aiSettings = setAiSettings(scenario.settings);
      mocks.resolveBusinessOperationalControls.mockResolvedValue(
        scenario.controls
      );
      mocks.shouldIncludeCalendarTools.mockImplementation(
        (
          settings: {
            booking_enabled: boolean;
            booking_mode: string;
          },
          hasCalendar: boolean,
          bookingOperationallyAvailable: boolean
        ) =>
          bookingOperationallyAvailable &&
          settings.booking_enabled &&
          settings.booking_mode === "schedule_direct" &&
          hasCalendar
      );

      const result = await processIncomingMessageDetailed(
        BUSINESS_ID,
        "+15745550100",
        null,
        "Can I book?",
        "sms"
      );

      expect(mocks.shouldIncludeCalendarTools).toHaveBeenCalledOnce();
      expect(mocks.shouldIncludeCalendarTools).toHaveBeenCalledWith(
        aiSettings,
        true,
        scenario.bookingOperationallyAvailable
      );
      expect(mocks.anthropicCreate).toHaveBeenCalledOnce();
      expect(mocks.anthropicCreate.mock.calls[0]?.[0]).toEqual({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system: "SYSTEM PROMPT",
        messages: [{ role: "user", content: "Can I book?" }],
        tools: EXPECTED_CONTACT_TOOLS,
      });
      expect(result).toEqual({
        text: "Absolutely.",
        knowledgeGapDetected: false,
        conversationId: CONVERSATION.id,
        sourceMessageId: "message_1",
        actions: [],
        assistantMessageId: "message_1",
      });
      expect(mocks.addMessage.mock.calls).toEqual([
        [
          CONVERSATION.id,
          BUSINESS_ID,
          "customer",
          "Can I book?",
          "sms",
        ],
        [
          CONVERSATION.id,
          BUSINESS_ID,
          "assistant",
          "Absolutely.",
          "sms",
        ],
      ]);
    }
  );

  it("rejects signup configuration without a goal URL before Anthropic", async () => {
    setBusinessGoal("signup", null);

    await expect(
      processIncomingMessageDetailed(
        BUSINESS_ID,
        "+15745550100",
        null,
        "How do I sign up?",
        "sms"
      )
    ).rejects.toBeInstanceOf(AIProcessingStateError);

    expect(mocks.anthropicCreate).not.toHaveBeenCalled();
  });

  it("offers only the signup tool and emits one linked action after the final reply contains the exact URL", async () => {
    const goalUrl = "https://example.com/start?plan=pro";
    setBusinessGoal("signup", goalUrl);
    mocks.anthropicCreate
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "goal_tool_1",
            name: "offer_goal_link",
            input: {},
          },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: `You can get started at ${goalUrl}` }],
      });

    const result = await processIncomingMessageDetailed(
      BUSINESS_ID,
      "+15745550100",
      null,
      "I'd like to sign up.",
      "sms",
      null,
      {
        persistCustomer: false,
        persistAssistant: false,
        sourceMessageId: "00000000-0000-4000-8000-000000000004",
        contact: CONTACT as never,
        conversation: CONVERSATION as never,
      }
    );

    const initialTools = mocks.anthropicCreate.mock.calls[0]?.[0].tools.map(
      (tool: { name: string }) => tool.name
    );
    expect(initialTools).toEqual([
      "save_contact_name",
      "save_contact_email",
      "offer_goal_link",
    ]);
    expect(mocks.shouldIncludeCalendarTools).not.toHaveBeenCalled();
    expect(mocks.anthropicCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: [
              expect.objectContaining({
                content: expect.stringContaining(goalUrl),
              }),
            ],
          }),
        ]),
      }),
      EXPECTED_ANTHROPIC_CALL_OPTIONS,
    );
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toEqual({
      kind: "goal_link_offered",
      goalAtEvent: "signup",
      channel: "sms",
      contactId: CONTACT.id,
      conversationId: CONVERSATION.id,
      sourceMessageId: "00000000-0000-4000-8000-000000000004",
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(result.assistantMessageId).toBeNull();
  });

  it.each([
    {
      label: "the final reply omits the URL",
      firstResponse: {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "goal_tool_1",
            name: "offer_goal_link",
            input: {},
          },
        ],
      },
      finalText: "I can help you get started.",
      sourceMessageId: "00000000-0000-4000-8000-000000000004",
    },
    {
      label: "the model did not use the structured link tool",
      firstResponse: null,
      finalText: "Start at https://example.com/start",
      sourceMessageId: "00000000-0000-4000-8000-000000000004",
    },
    {
      label: "the inbound source message is not durable",
      firstResponse: {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "goal_tool_1",
            name: "offer_goal_link",
            input: {},
          },
        ],
      },
      finalText: "Start at https://example.com/start",
      sourceMessageId: undefined,
    },
  ])("does not emit an action when $label", async (scenario) => {
    const goalUrl = "https://example.com/start";
    setBusinessGoal("signup", goalUrl);
    if (scenario.firstResponse) {
      mocks.anthropicCreate
        .mockResolvedValueOnce(scenario.firstResponse)
        .mockResolvedValueOnce({
          stop_reason: "end_turn",
          content: [{ type: "text", text: scenario.finalText }],
        });
    } else {
      mocks.anthropicCreate.mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: scenario.finalText }],
      });
    }

    const result = await processIncomingMessageDetailed(
      BUSINESS_ID,
      "+15745550100",
      null,
      "I'd like to sign up.",
      "sms",
      null,
      {
        persistCustomer: false,
        persistAssistant: false,
        sourceMessageId: scenario.sourceMessageId,
        contact: CONTACT as never,
        conversation: CONVERSATION as never,
      }
    );

    expect(result.actions).toEqual([]);
  });

  it("keeps the in-flight signup snapshot stable and applies a new signup URL on the next message", async () => {
    const oldUrl = "https://example.com/old";
    const newUrl = "https://example.com/new";
    const oldSourceMessageId = "00000000-0000-4000-8000-000000000004";
    const newSourceMessageId = "00000000-0000-4000-8000-000000000005";
    const pendingToolRequest = deferred<{
      stop_reason: "tool_use";
      content: Array<{
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, never>;
      }>;
    }>();
    setBusinessGoal("signup", oldUrl);
    mocks.buildConversationMessages.mockImplementation(() => [
      { role: "user", content: "I want to sign up." },
    ]);
    mocks.anthropicCreate
      .mockReturnValueOnce(pendingToolRequest.promise)
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: `Start here: ${oldUrl}` }],
      })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "goal_tool_2",
            name: "offer_goal_link",
            input: {},
          },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: `Start here: ${newUrl}` }],
      });

    const firstTurn = processIncomingMessageDetailed(
      BUSINESS_ID,
      "+15745550100",
      null,
      "I want to sign up.",
      "sms",
      null,
      {
        persistCustomer: false,
        persistAssistant: false,
        sourceMessageId: oldSourceMessageId,
        contact: CONTACT as never,
        conversation: CONVERSATION as never,
      }
    );

    await vi.waitFor(() => {
      expect(mocks.anthropicCreate).toHaveBeenCalledTimes(1);
    });
    setBusinessGoal("signup", newUrl);
    pendingToolRequest.resolve({
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "goal_tool_1",
          name: "offer_goal_link",
          input: {},
        },
      ],
    });

    const firstResult = await firstTurn;
    expect(firstResult).toMatchObject({
      text: `Start here: ${oldUrl}`,
      actions: [
        expect.objectContaining({
          goalAtEvent: "signup",
          sourceMessageId: oldSourceMessageId,
          idempotencyKey:
            expectedGoalLinkIdempotencyKey(oldSourceMessageId),
        }),
      ],
    });
    expect(
      mocks.anthropicCreate.mock.calls[1]?.[0].messages.at(-1)
    ).toEqual(
      expect.objectContaining({
        content: [
          expect.objectContaining({ content: expect.stringContaining(oldUrl) }),
        ],
      })
    );
    expect(
      mocks.anthropicCreate.mock.calls[1]?.[0].messages.at(-1)
    ).not.toEqual(
      expect.objectContaining({
        content: [
          expect.objectContaining({ content: expect.stringContaining(newUrl) }),
        ],
      })
    );

    const secondResult = await processIncomingMessageDetailed(
      BUSINESS_ID,
      "+15745550100",
      null,
      "I want to sign up with the new link.",
      "sms",
      null,
      {
        persistCustomer: false,
        persistAssistant: false,
        sourceMessageId: newSourceMessageId,
        contact: CONTACT as never,
        conversation: CONVERSATION as never,
      }
    );
    expect(secondResult).toMatchObject({
      text: `Start here: ${newUrl}`,
      actions: [
        expect.objectContaining({
          goalAtEvent: "signup",
          sourceMessageId: newSourceMessageId,
          idempotencyKey:
            expectedGoalLinkIdempotencyKey(newSourceMessageId),
        }),
      ],
    });
    expect(firstResult.actions[0]?.idempotencyKey).not.toBe(
      secondResult.actions[0]?.idempotencyKey
    );
    expect(
      mocks.anthropicCreate.mock.calls[2]?.[0].tools.map(
        (tool: { name: string }) => tool.name
      )
    ).toContain("offer_goal_link");
    expect(
      mocks.anthropicCreate.mock.calls[3]?.[0].messages.at(-1)
    ).toEqual(
      expect.objectContaining({
        content: [
          expect.objectContaining({ content: expect.stringContaining(newUrl) }),
        ],
      })
    );
    expect(
      mocks.anthropicCreate.mock.calls[3]?.[0].messages.at(-1)
    ).not.toEqual(
      expect.objectContaining({
        content: [
          expect.objectContaining({ content: expect.stringContaining(oldUrl) }),
        ],
      })
    );
  });

  it("derives a stable opaque key from the business and durable source message only", async () => {
    const goalUrl = "https://example.com/start?email=pat@example.com";
    const sourceMessageId = "00000000-0000-4000-8000-000000000004";
    setBusinessGoal("signup", goalUrl);
    mocks.buildConversationMessages.mockImplementation(() => [
      { role: "user", content: "I want to sign up." },
    ]);
    for (let turn = 0; turn < 2; turn += 1) {
      mocks.anthropicCreate
        .mockResolvedValueOnce({
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: `goal_tool_${turn}`,
              name: "offer_goal_link",
              input: {},
            },
          ],
        })
        .mockResolvedValueOnce({
          stop_reason: "end_turn",
          content: [{ type: "text", text: `Start here: ${goalUrl}` }],
        });
    }

    const runTurn = () =>
      processIncomingMessageDetailed(
        BUSINESS_ID,
        "+15745550100",
        null,
        "I want to sign up.",
        "sms",
        null,
        {
          persistCustomer: false,
          persistAssistant: false,
          sourceMessageId,
          contact: CONTACT as never,
          conversation: CONVERSATION as never,
        }
      );
    const first = await runTurn();
    const second = await runTurn();
    const firstKey = first.actions[0]?.idempotencyKey;
    const secondKey = second.actions[0]?.idempotencyKey;

    expect(firstKey).toBe(secondKey);
    expect(firstKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(firstKey).not.toContain(BUSINESS_ID);
    expect(firstKey).not.toContain(sourceMessageId);
    expect(firstKey).not.toContain("example.com");
    expect(firstKey).not.toContain("pat@example.com");
  });
});


describe("revisioned booking tools", () => {
  async function turn(tool: string, input: Record<string, unknown>, options = {}) {
    vi.stubEnv('BOOKING_CONFIRMATION_V2_ENABLED', 'true');
    setBusinessGoal('book'); setAiSettings({ booking_enabled: true, booking_mode: 'schedule_direct' });
    mocks.bookingContext.mockResolvedValue({ offerings: [], currentDraft: null });
    mocks.prepareDraft.mockResolvedValue({ id: 'draft', revision: 2, status: 'preparing', summary_text: 'Review the corrected appointment details?' });
    mocks.confirmDraft.mockResolvedValue({ status: 'confirmed', summary: 'Booked.' });
    mocks.anthropicCreate.mockResolvedValueOnce({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'new-booking', name: tool, input }] });
    const preview = (options as { isPreview?: boolean }).isPreview === true;
    if (preview) { mocks.findOrCreateContact.mockResolvedValue(WEB_CONTACT); mocks.getOrCreateConversation.mockResolvedValue(WEB_CONVERSATION); }
    try { return await processIncomingMessageDetailed(BUSINESS_ID, preview ? null : '+15745550100', preview ? WEB_CONTACT.email : null, 'Yes please', preview ? 'web_chat' : 'sms', preview ? WEB_CONTACT.session_id : null, { persistAssistant: false, ...options }); }
    finally { vi.unstubAllEnvs(); }
  }
  it('returns the stored review and its revision for SMS transport acknowledgment', async () => {
    const result = await turn('prepare_booking', { emailAsked: true, name: 'Pat' });
    expect(result.text).toBe('Review the corrected appointment details?');
    expect(result.bookingReview).toEqual({ draftId: 'draft', revision: 2 });
    expect(mocks.acknowledgeDraft).not.toHaveBeenCalled();
    expect(mocks.createBooking).not.toHaveBeenCalled();
  });
  it('uses only the durable current inbound message as confirmation evidence', async () => {
    await turn('confirm_booking', { draftId: 'draft', revision: 2 });
    expect(mocks.confirmDraft).toHaveBeenCalledWith(expect.objectContaining({ businessId: BUSINESS_ID, draftId: 'draft', revision: 2, confirmationMessageId: 'message_1' }));
    expect(mocks.createBooking).not.toHaveBeenCalled();
  });
  it('rejects the legacy direct mutation tool when revisioned booking is enabled', async () => {
    await turn('create_booking', { customer_name: 'Pat', service_name: 'Estimate', start_time: '2026-09-23T10:00:00' });
    expect(mocks.createBooking).not.toHaveBeenCalled(); expect(mocks.confirmDraft).not.toHaveBeenCalled();
  });
  it('does not execute booking tools in previews', async () => {
    await turn('confirm_booking', { draftId: 'draft', revision: 2 }, { isPreview: true, persistBookingRequests: false });
    expect(mocks.confirmDraft).not.toHaveBeenCalled(); expect(mocks.createBooking).not.toHaveBeenCalled();
  });
});
