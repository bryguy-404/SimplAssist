import { loadBusinessContextResults } from "./businessContext";
import { createHash, randomUUID } from "node:crypto";
import { meteredAnthropic as anthropic } from "@/lib/anthropic/client";
import {
  isOperationalControlsResolutionError,
  resolveBusinessOperationalControls,
  resolveOperationalBlockReason,
} from "@/lib/account/operationalControls.server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  canUseFeature,
  EntitlementResolutionError,
  resolveBusinessEntitlements,
} from "@/lib/billing/entitlements";
import {
  AIReplyIdempotencyConflictError,
  AIReplyMeteringStateError,
  finalizeAIReplyUnit,
  getCompletedAIReply,
  recordAnthropicProviderCall,
  releaseAIReplyUnit,
  reserveAIReplyUnit,
  type AIReplyReservationDecision,
} from "@/lib/billing/aiReplyMeter.server";
import { findOrCreateContact, incrementLeadScore, updateContactName, updateContactEmail } from "./contacts";
import {
  getOrCreateConversation,
  addMessage,
  addWebChatInboundMessageOnce,
  getConversationById,
  getConversationAiState,
  getConversationHistory,
  isAiHandlingActive,
  WebChatMessageIdempotencyConflictError,
} from "./conversations";
import {
  parseKnowledgeGapSignal,
  stripExactKnowledgeGapSignal,
} from "./knowledgeGapSignal";
import type { ParsedKnowledgeGapSignal } from "./knowledgeGapSignal";
import { buildSystemPrompt, buildConversationMessages } from "./prompt";
import { recordBookingRequest } from "./bookingRequests";
import {
  bookingRequestTools,
  calendarTools,
  shouldIncludeBookingRequestTools,
  shouldIncludeCalendarTools,
  signupGoalTools,
} from "./tools";
import { checkAvailability, createBooking } from "@/lib/google/calendar";
import {
  isBookingOperationalBlockedError,
  isBookingOperationalStateError,
} from "@/lib/google/bookingOperational.server";
import type {
  Business,
  AISettings,
  Service,
  FAQ,
  BusinessHours,
  BusinessKnowledgeItem,
  Channel,
  Contact,
  Conversation,
} from "@/types/database";
import type Anthropic from "@anthropic-ai/sdk";

const FALLBACK_MESSAGE =
  "Thanks for reaching out! We're having a brief technical issue. Please try again in a moment or call us directly.";
const WEB_CHAT_FALLBACK_MESSAGE =
  "Thanks for reaching out! We're having a brief technical issue. Please try again in a moment.";

const BOOKING_UNAVAILABLE_TOOL_RESULT =
  "Booking is currently unavailable. Do not check availability, create an appointment, or collect booking details. Let the customer know booking is unavailable.";

const BOOKING_REQUEST_RECORDED_TOOL_RESULT =
  "Appointment request recorded for owner review. It is not a booked or confirmed appointment.";

const BOOKING_REQUEST_PREVIEW_TOOL_RESULT =
  "Preview only: no appointment request was created. Do not say it was recorded, booked, or confirmed.";

const BOOKING_REQUEST_UNAVAILABLE_TOOL_RESULT =
  "Appointment-request recording is not enabled for this business right now. Do not say a request was recorded, booked, or confirmed.";

const GOAL_LINK_IDEMPOTENCY_NAMESPACE = "goal-link-offered:v1";
const MAX_TOOL_EXECUTIONS_PER_TURN = 6;
// Keep all model/tool-loop work inside the public widget's five-minute claim
// lease and well inside the ten-minute reply reservation. Each provider call
// is a single separately-accounted HTTP attempt; the SDK may not retry it.
const AI_TURN_DEADLINE_MS = 4 * 60_000;
const ANTHROPIC_CALL_TIMEOUT_MS = 60_000;
const ANTHROPIC_ACCOUNTING_WAIT_MS = 2_000;
const MAX_EXPLICIT_ANTHROPIC_RETRIES = 2;
const ANTHROPIC_RETRY_BASE_DELAY_MS = 250;
const REPEATED_CALENDAR_TOOL_RESULT =
  "That calendar action was already attempted for this message. Do not repeat it; continue using the result already returned.";
const TOOL_EXECUTION_LIMIT_RESULT =
  "No more tool actions are available for this message. Continue with the information already returned.";
const MAX_CONTACT_NAME_LENGTH = 100;
const MAX_CONTACT_EMAIL_LENGTH = 254;
const MAX_CONTACT_PHONE_LENGTH = 32;
const MAX_REQUESTED_SERVICE_LENGTH = 160;
const MAX_REQUESTED_TIME_LENGTH = 500;
const SIMPLE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type AIProcessingBlockedReason =
  | "feature_not_entitled"
  | "conversation_in_manual_mode"
  | "account_suspended"
  | "ai_replies_paused"
  | "texting_paused";

const AI_PROCESSING_BLOCKED_MESSAGES: Record<
  AIProcessingBlockedReason,
  string
> = {
  feature_not_entitled:
    "AI processing is not included in this business's current plan.",
  conversation_in_manual_mode:
    "AI processing is disabled while this conversation is in Human mode.",
  account_suspended: "AI processing is unavailable for this account.",
  ai_replies_paused: "AI replies are currently paused for this account.",
  texting_paused: "AI SMS replies are currently paused for this account.",
};

export class AIProcessingBlockedError extends Error {
  constructor(readonly reason: AIProcessingBlockedReason) {
    super(AI_PROCESSING_BLOCKED_MESSAGES[reason]);
    this.name = "AIProcessingBlockedError";
  }
}

export class AIProcessingStateError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AIProcessingStateError";
  }
}

export class AIProcessingIdempotencyConflictError extends Error {
  constructor() {
    super("This web chat message id was already used for another request.");
    this.name = "AIProcessingIdempotencyConflictError";
  }
}

export class AIProcessingInProgressError extends Error {
  readonly retryAfterSeconds = 2;

  constructor() {
    super("This web chat reply is already being prepared.");
    this.name = "AIProcessingInProgressError";
  }
}

export class AIReplyLimitReachedError extends Error {
  constructor(
    readonly resetAt: string | null,
    readonly allowanceRenewal: "scheduled" | "frozen_past_due",
  ) {
    super("The web chat assistant is temporarily unavailable.");
    this.name = "AIReplyLimitReachedError";
  }
}

function rethrowTypedAIProcessingError(error: unknown): void {
  if (isBookingOperationalBlockedError(error)) {
    if (error.reason === "account_suspended") {
      throw new AIProcessingBlockedError("account_suspended");
    }
    throw error;
  }
  if (isBookingOperationalStateError(error)) {
    throw new AIProcessingStateError(
      `Could not determine booking state for business ${error.businessId}.`,
      { cause: error }
    );
  }
  if (
    error instanceof AIProcessingBlockedError ||
    error instanceof AIProcessingStateError ||
    error instanceof AIProcessingIdempotencyConflictError ||
    error instanceof AIProcessingInProgressError ||
    error instanceof AIReplyLimitReachedError ||
    isOperationalControlsResolutionError(error)
  ) {
    throw error;
  }
}

export interface ProcessIncomingMessageOptions {
  persistAssistant?: boolean;
  /** Set false only for an authenticated, same-business widget preview. */
  persistBookingRequests?: boolean;
  /** Set false only when the caller has already durably stored this message. */
  persistCustomer?: boolean;
  /** Required with persistCustomer=false so booking actions remain retry-stable. */
  sourceMessageId?: string;
  /** Set true only for an authenticated, same-business widget preview. */
  isPreview?: boolean;
  /** Validated browser request identity for authoritative live reply metering. */
  webChatRequest?: {
    clientMessageId: string;
    requestFingerprint: string;
  };
  /** Validated lead name supplied by the public widget. */
  contactName?: string;
  contact?: Contact;
  conversation?: Conversation;
}

export interface ProcessIncomingMessageResult {
  text: string;
  knowledgeGapDetected: boolean;
  conversationId: string | null;
  sourceMessageId: string | null;
  actions: GoalLinkOfferedAction[];
  assistantMessageId: string | null;
}

export interface GoalLinkOfferedAction {
  kind: "goal_link_offered";
  goalAtEvent: "signup";
  channel: Channel;
  contactId: string;
  conversationId: string;
  sourceMessageId: string;
  idempotencyKey: string;
}

function buildGoalLinkIdempotencyKey(
  businessId: string,
  sourceMessageId: string
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        GOAL_LINK_IDEMPOTENCY_NAMESPACE,
        businessId,
        sourceMessageId,
      ]),
      "utf8"
    )
    .digest("base64url");
}

type ActiveAIReplyReservation = Extract<
  AIReplyReservationDecision,
  { outcome: "reserved" }
>;

async function loadCompletedAssistantReply(args: {
  businessId: string;
  assistantMessageId: string;
  conversationId: string;
}): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("id,business_id,conversation_id,role,channel,content")
    .eq("id", args.assistantMessageId)
    .eq("business_id", args.businessId)
    .maybeSingle();
  if (
    error ||
    !data ||
    data.conversation_id !== args.conversationId ||
    data.role !== "assistant" ||
    data.channel !== "web_chat" ||
    typeof data.content !== "string"
  ) {
    throw new AIProcessingStateError(
      `Could not load completed AI reply ${args.assistantMessageId}.`,
      { cause: error ?? undefined },
    );
  }
  return data.content;
}

function safeUsageInteger(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : 0;
}

type EngineErrorCategory =
  | "contact_tool_save_name"
  | "contact_tool_save_email"
  | "contact_tool_unknown"
  | "calendar_tool_check_availability"
  | "calendar_tool_create_booking"
  | "calendar_tool_unknown"
  | "knowledge_gap_parser"
  | "incoming_message_processing";

const CONTENT_FREE_ERROR_NAMES = new Set([
  "AbortError",
  "AggregateError",
  "APIConnectionError",
  "APIConnectionTimeoutError",
  "APIError",
  "APIUserAbortError",
  "AuthenticationError",
  "AxiosError",
  "BadRequestError",
  "ConflictError",
  "DOMException",
  "Error",
  "EvalError",
  "GaxiosError",
  "InternalServerError",
  "NotFoundError",
  "PermissionDeniedError",
  "PostgrestError",
  "RangeError",
  "RateLimitError",
  "ReferenceError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "URIError",
  "UnprocessableEntityError",
  "ZodError",
]);

function safeErrorName(error: unknown, fallback: string): string {
  try {
    return error instanceof Error && CONTENT_FREE_ERROR_NAMES.has(error.name)
      ? error.name
      : fallback;
  } catch {
    return fallback;
  }
}

function safeErrorStatus(error: unknown): number | null {
  try {
    if (typeof error !== "object" || error === null || !("status" in error)) {
      return null;
    }
    const status = (error as { status?: unknown }).status;
    return Number.isInteger(status) && (status as number) >= 100 &&
      (status as number) <= 599
      ? (status as number)
      : null;
  } catch {
    return null;
  }
}

function safeEngineErrorMetadata(
  category: EngineErrorCategory,
  error: unknown,
): { category: EngineErrorCategory; name: string; status: number | null } {
  return {
    category,
    name: safeErrorName(error, "unknown_error"),
    status: safeErrorStatus(error),
  };
}

function safeProviderErrorCode(error: unknown): string {
  const name = safeErrorName(error, "provider_error");
  const rawStatus = safeErrorStatus(error);
  const status = rawStatus === null ? null : String(rawStatus);
  return status ? `${name}_${status}` : name;
}

type AnthropicCallAccountingArgs = {
  businessId: string;
  channel: Channel;
  isPreview: boolean;
  reservation: ActiveAIReplyReservation | null;
  callIdempotencyKey: string;
  operation: "message_initial" | "message_tool_followup";
  model: string;
  latencyMs: number;
  toolResultCount: number;
  response: Anthropic.Message | null;
  error: unknown | null;
};

async function recordAnthropicCallBestEffort(
  args: AnthropicCallAccountingArgs,
): Promise<void> {
  const usage = args.response?.usage as unknown as
    | Record<string, unknown>
    | undefined;
  try {
    await recordAnthropicProviderCall({
      businessId: args.businessId,
      reservationId: args.reservation?.reservationId ?? null,
      attemptToken: args.reservation?.attemptToken ?? null,
      callIdempotencyKey: args.callIdempotencyKey,
      operation: args.operation,
      channel: args.channel,
      isPreview: args.isPreview,
      model: args.model,
      providerRequestId: args.response?.id ?? null,
      inputTokens: safeUsageInteger(usage?.input_tokens),
      outputTokens: safeUsageInteger(usage?.output_tokens),
      cacheCreationInputTokens: safeUsageInteger(
        usage?.cache_creation_input_tokens,
      ),
      cacheReadInputTokens: safeUsageInteger(usage?.cache_read_input_tokens),
      latencyMs: args.latencyMs,
      stopReason: args.response?.stop_reason ?? null,
      toolUseCount:
        args.response?.content.filter((block) => block.type === "tool_use")
          .length ?? 0,
      toolResultCount: args.toolResultCount,
      succeeded: args.error === null,
      errorCode: args.error === null ? null : safeProviderErrorCode(args.error),
    });
  } catch (accountingError) {
    // The provider call has already happened. Failing the customer response
    // here would invite another paid call, so accounting degradation is
    // observable but never converted into a duplicate generation attempt.
    console.error("[ai-engine] Anthropic call accounting failed", {
      businessId: args.businessId,
      operation: args.operation,
      callIdempotencyKey: args.callIdempotencyKey,
      error:
        accountingError instanceof Error
          ? accountingError.name
          : "unknown_accounting_error",
    });
  }
}

async function waitForAnthropicAccountingBestEffort(
  args: AnthropicCallAccountingArgs,
  turnDeadlineAt: number,
): Promise<void> {
  // Start exactly one accounting write for this stable provider-attempt key.
  // Attach a terminal handler immediately so a rejection after the bounded
  // wait cannot become unhandled or affect the already-known provider result.
  const drainedAccounting = recordAnthropicCallBestEffort(args).catch(
    (accountingError) => {
      console.error("[ai-engine] Anthropic call accounting drain failed", {
        businessId: args.businessId,
        operation: args.operation,
        callIdempotencyKey: args.callIdempotencyKey,
        error:
          accountingError instanceof Error
            ? accountingError.name
            : "unknown_accounting_error",
      });
    },
  );
  const waitMs = Math.min(
    ANTHROPIC_ACCOUNTING_WAIT_MS,
    Math.max(0, turnDeadlineAt - Date.now()),
  );
  if (waitMs === 0) {
    console.error("[ai-engine] Anthropic call accounting timed out", {
      businessId: args.businessId,
      operation: args.operation,
      callIdempotencyKey: args.callIdempotencyKey,
      waitMs,
    });
    void drainedAccounting;
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    drainedAccounting.then(() => "settled" as const),
    new Promise<"timed_out">((resolve) => {
      timeout = setTimeout(() => resolve("timed_out"), waitMs);
      timeout.unref?.();
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (outcome === "timed_out") {
    console.error("[ai-engine] Anthropic call accounting timed out", {
      businessId: args.businessId,
      operation: args.operation,
      callIdempotencyKey: args.callIdempotencyKey,
      waitMs,
    });
    void drainedAccounting;
  }
}

/**
 * Reads operational controls at an AI execution boundary. SMS generation
 * requires both texting and AI replies, while web chat requires only AI. The
 * resolver is intentionally uncached; uncertainty propagates as its retryable
 * typed error instead of becoming an allow decision or a fallback reply.
 */
async function assertAIProcessingOperationallyAllowed(
  businessId: string,
  channel: Channel
) {
  let controls;
  try {
    controls = await resolveBusinessOperationalControls(businessId);
  } catch (error) {
    if (isOperationalControlsResolutionError(error)) throw error;
    throw new AIProcessingStateError(
      `Could not determine operational controls for business ${businessId}.`,
      { cause: error }
    );
  }
  const reason = resolveOperationalBlockReason(
    controls,
    channel === "sms" ? ["texting", "ai_replies"] : ["ai_replies"]
  );

  if (reason === null) return controls;
  if (reason === "bookings_paused") {
    throw new AIProcessingStateError(
      "AI operational access returned an unexpected booking-only block."
    );
  }
  throw new AIProcessingBlockedError(reason);
}

function scoreMessage(message: string): number {
  const lower = message.toLowerCase();
  let score = 0;

  if (/\b(price|pricing|cost|how much|rate|fee|quote|cheap|cheapest|budget|afford|estimate|pay|payment)\b/.test(lower)) score += 2;
  if (/\b(book|booking|appointment|schedule|reserve|set up a time|consultation|meet|meeting|call|demo)\b/.test(lower)) score += 3;
  if (/\b(service|offer|provide|do you do|available|help me|need|looking for|interested)\b/.test(lower)) score += 1;

  return score;
}

function remainingAITurnMs(deadlineAt: number): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new AIProcessingStateError(
      "AI processing exceeded its bounded turn deadline.",
    );
  }
  return remaining;
}

async function awaitWithinAITurnDeadline<T>(
  operation: () => Promise<T>,
  deadlineAt: number,
): Promise<T> {
  const remaining = remainingAITurnMs(deadlineAt);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(
        new AIProcessingStateError(
          "AI processing exceeded its bounded turn deadline.",
        ),
      );
    }, remaining);
    timeout.unref?.();
  });

  try {
    // Promise.race installs handlers on the underlying operation. If an
    // idempotent booking/provider call settles after the bounded wait ends,
    // it cannot resume this turn or produce an unhandled rejection.
    return await Promise.race([operation(), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isRetriableAnthropicError(error: unknown): boolean {
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    Number.isInteger((error as { status?: unknown }).status)
      ? (error as { status: number }).status
      : null;
  if (status !== null) {
    return (
      status === 408 ||
      status === 409 ||
      status === 429 ||
      (status >= 500 && status <= 599)
    );
  }
  return (
    error instanceof Error &&
    (error.name === "APIConnectionError" ||
      error.name === "APIConnectionTimeoutError")
  );
}

async function waitForAnthropicRetry(
  retryNumber: number,
  deadlineAt: number,
): Promise<void> {
  const delayMs = ANTHROPIC_RETRY_BASE_DELAY_MS * 2 ** (retryNumber - 1);
  await awaitWithinAITurnDeadline(
    () => new Promise((resolve) => setTimeout(resolve, delayMs)),
    deadlineAt,
  );
}

const contactTools: Anthropic.Tool[] = [
  {
    name: "save_contact_name",
    description: "Save the customer's name to their contact record. Call this when the customer tells you their name.",
    input_schema: {
      type: "object" as const,
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
    description: "Save the customer's email to their contact record. Call this when the customer provides their email address.",
    input_schema: {
      type: "object" as const,
      properties: {
        email: {
          type: "string",
          description: "The customer's email address",
        },
      },
      required: ["email"],
    },
  },
];

async function executeContactTool(
  contactId: string,
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<string> {
  try {
    if (toolName === "save_contact_name") {
      const name = boundedToolText(
        toolInput.name,
        "contact name",
        MAX_CONTACT_NAME_LENGTH,
      );
      await updateContactName(contactId, name);
      return `Contact name saved: ${name}`;
    }
    if (toolName === "save_contact_email") {
      const email = boundedEmail(toolInput.email, "contact email");
      await updateContactEmail(contactId, email);
      return `Contact email saved: ${email}`;
    }
    return "Unknown tool.";
  } catch (error) {
    rethrowTypedAIProcessingError(error);
    const category: EngineErrorCategory =
      toolName === "save_contact_name"
        ? "contact_tool_save_name"
        : toolName === "save_contact_email"
          ? "contact_tool_save_email"
          : "contact_tool_unknown";
    console.error(
      "[ai-engine] Operation failed",
      safeEngineErrorMetadata(category, error),
    );
    if (toolName === "save_contact_name") {
      return "Contact name could not be saved. Do not say it was saved; continue helping the customer.";
    }
    if (toolName === "save_contact_email") {
      return "Contact email could not be saved. Do not say it was saved; continue helping the customer.";
    }
    return "Contact info could not be saved. Do not say it was saved; continue helping the customer.";
  }
}

async function executeCalendarTool(
  businessId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  timezone: string,
  contactPhone: string | null,
  contactId: string,
  conversationId: string,
  sourceMessageId: string | null
): Promise<string> {
  try {
    if (toolName === "check_availability") {
      const date = toolInput.date as string;
      const slots = await checkAvailability(businessId, date, timezone);

      if (slots.length === 0) {
        return "No available slots on that date. The business may be closed or fully booked.";
      }

      return `Available times on ${date}: ${slots.join(", ")}`;
    }

    if (toolName === "create_booking") {
      if (!sourceMessageId) {
        throw new AIProcessingStateError(
          "Direct booking requires a durably persisted source message."
        );
      }
      const rawCustomerEmail = toolInput.customer_email;
      const customerEmail =
        rawCustomerEmail === undefined ||
        rawCustomerEmail === null ||
        rawCustomerEmail === ""
          ? undefined
          : boundedEmail(rawCustomerEmail, "booking customer email");
      const durationMinutes =
        toolInput.duration_minutes === undefined
          ? 30
          : (toolInput.duration_minutes as number);
      const result = await createBooking(
        businessId,
        {
          customerName: toolInput.customer_name as string,
          customerPhone: (toolInput.customer_phone as string) || contactPhone || undefined,
          customerEmail,
          serviceName: toolInput.service_name as string,
          startTime: toolInput.start_time as string,
          durationMinutes,
        },
        timezone,
        {
          contactId,
          conversationId,
          sourceMessageId,
        }
      );

      return `Appointment booked successfully! ${result.summary} at ${result.startTime}. Event ID: ${result.eventId}`;
    }

    return "Unknown tool.";
  } catch (error) {
    if (isBookingOperationalBlockedError(error)) {
      if (error.reason === "account_suspended") {
        throw new AIProcessingBlockedError("account_suspended");
      }
      return BOOKING_UNAVAILABLE_TOOL_RESULT;
    }
    if (isBookingOperationalStateError(error)) {
      throw new AIProcessingStateError(
        `Could not determine booking state for business ${error.businessId}.`,
        { cause: error }
      );
    }
    rethrowTypedAIProcessingError(error);
    const category: EngineErrorCategory =
      toolName === "check_availability"
        ? "calendar_tool_check_availability"
        : toolName === "create_booking"
          ? "calendar_tool_create_booking"
          : "calendar_tool_unknown";
    console.error(
      "[ai-engine] Operation failed",
      safeEngineErrorMetadata(category, error),
    );
    return "Calendar is temporarily unavailable. Please collect the customer's booking details instead and let them know someone will confirm.";
  }
}

interface BookingRequestContactSnapshot {
  id: string;
  business_id: string;
  name: string | null;
  phone_number: string | null;
  provided_phone_number: string | null;
  email: string | null;
}

interface BookingRequestToolExecutionResult {
  content: string;
  suppressCollectForFollowup: boolean;
}

function boundedToolText(
  value: unknown,
  fieldName: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw new AIProcessingStateError(
      `Booking request tool returned invalid ${fieldName}.`
    );
  }
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new AIProcessingStateError(
      `Booking request tool returned invalid ${fieldName}.`
    );
  }
  return normalized;
}

function boundedEmail(value: unknown, fieldName: string): string {
  const email = boundedToolText(
    value,
    fieldName,
    MAX_CONTACT_EMAIL_LENGTH,
  ).toLowerCase();
  if (!SIMPLE_EMAIL_PATTERN.test(email)) {
    throw new AIProcessingStateError(
      `Booking request tool returned invalid ${fieldName}.`,
    );
  }
  return email;
}

function optionalBoundedText(
  value: unknown,
  maxLength: number,
): string | null {
  if (typeof value !== "string" || !/\S/.test(value)) return null;
  try {
    return boundedToolText(value, "optional contact field", maxLength);
  } catch {
    return null;
  }
}

function optionalEmail(value: unknown): string | null {
  if (typeof value !== "string" || !/\S/.test(value)) return null;
  try {
    return boundedEmail(value, "customer email");
  } catch {
    return null;
  }
}

async function executeBookingRequestTool(args: {
  businessId: string;
  contactId: string;
  conversationId: string;
  sourceMessageId: string | null;
  toolInput: Record<string, unknown>;
  toolWasExposed: boolean;
  persistBookingRequests: boolean;
  channel: Channel;
}): Promise<BookingRequestToolExecutionResult> {
  const {
    businessId,
    contactId,
    conversationId,
    sourceMessageId,
    toolInput,
    toolWasExposed,
    persistBookingRequests,
    channel,
  } = args;

  let operationalControls;
  try {
    operationalControls = await assertAIProcessingOperationallyAllowed(
      businessId,
      channel
    );
  } catch (error) {
    if (
      error instanceof AIProcessingBlockedError ||
      error instanceof AIProcessingStateError
    ) {
      throw error;
    }
    throw new AIProcessingStateError(
      `Could not recheck booking-request operational controls for business ${businessId}.`,
      { cause: error }
    );
  }

  let businessResult;
  let aiSettingsResult;
  try {
    [businessResult, aiSettingsResult] = await Promise.all([
      supabaseAdmin
        .from("businesses")
        .select("primary_goal")
        .eq("id", businessId)
        .single(),
      supabaseAdmin
        .from("ai_settings")
        .select("booking_enabled,booking_mode")
        .eq("business_id", businessId)
        .single(),
    ]);
  } catch (error) {
    throw new AIProcessingStateError(
      `Could not recheck booking-request configuration for business ${businessId}.`,
      { cause: error }
    );
  }

  if (businessResult.error || aiSettingsResult.error) {
    throw new AIProcessingStateError(
      `Could not recheck booking-request configuration for business ${businessId}.`,
      { cause: businessResult.error ?? aiSettingsResult.error }
    );
  }

  const freshBusiness = businessResult.data as Pick<Business, "primary_goal"> | null;
  const freshAiSettings = aiSettingsResult.data as AISettings | null;
  if (!freshBusiness || !freshAiSettings) {
    throw new AIProcessingStateError(
      `Business ${businessId} is missing booking-request configuration.`
    );
  }

  const bookingRequestOperationallyAvailable =
    operationalControls.bookingsPausedAt === null;
  const freshBookingRequestToolAvailable =
    freshBusiness.primary_goal !== "signup" &&
    shouldIncludeBookingRequestTools(
      freshAiSettings,
      bookingRequestOperationallyAvailable
    );
  if (!toolWasExposed || !freshBookingRequestToolAvailable) {
    return {
      content: BOOKING_REQUEST_UNAVAILABLE_TOOL_RESULT,
      // If this turn really advertised collect-mode recording, do not
      // re-advertise stale collect prompt/tool state after a fresh rejection.
      // The turn-start goal/mode remains authoritative for all other surfaces.
      suppressCollectForFollowup:
        toolWasExposed && !freshBookingRequestToolAvailable,
    };
  }

  if (!sourceMessageId) {
    throw new AIProcessingStateError(
      "Appointment-request recording requires a durably persisted source message."
    );
  }

  const requestedService = boundedToolText(
    toolInput.requested_service,
    "requested_service",
    MAX_REQUESTED_SERVICE_LENGTH,
  );
  const requestedTimeText = boundedToolText(
    toolInput.requested_time_text,
    "requested_time_text",
    MAX_REQUESTED_TIME_LENGTH,
  );

  // Authenticated widget previews exercise the same prompt/tool contract but
  // deliberately stop before reading snapshots or creating a durable row.
  if (!persistBookingRequests) {
    return {
      content: BOOKING_REQUEST_PREVIEW_TOOL_RESULT,
      suppressCollectForFollowup: false,
    };
  }

  let contactResult;
  try {
    contactResult = await supabaseAdmin
      .from("contacts")
      .select(
        "id,business_id,name,phone_number,provided_phone_number,email"
      )
      .eq("id", contactId)
      .eq("business_id", businessId)
      .single();
  } catch (error) {
    throw new AIProcessingStateError(
      `Could not load the booking-request contact for business ${businessId}.`,
      { cause: error }
    );
  }

  const freshContact = contactResult.data as BookingRequestContactSnapshot | null;
  if (
    contactResult.error ||
    !freshContact ||
    freshContact.id !== contactId ||
    freshContact.business_id !== businessId
  ) {
    throw new AIProcessingStateError(
      `Could not load the booking-request contact for business ${businessId}.`,
      { cause: contactResult.error ?? undefined }
    );
  }

  const customerName =
    optionalBoundedText(toolInput.customer_name, MAX_CONTACT_NAME_LENGTH) ??
    optionalBoundedText(freshContact.name, MAX_CONTACT_NAME_LENGTH);
  const customerPhone =
    optionalBoundedText(toolInput.customer_phone, MAX_CONTACT_PHONE_LENGTH) ??
    optionalBoundedText(
      freshContact.provided_phone_number,
      MAX_CONTACT_PHONE_LENGTH,
    ) ??
    optionalBoundedText(freshContact.phone_number, MAX_CONTACT_PHONE_LENGTH);
  const customerEmail =
    optionalEmail(toolInput.customer_email) ??
    optionalEmail(freshContact.email);

  try {
    await recordBookingRequest({
      businessId,
      contactId,
      conversationId,
      sourceMessageId,
      requestedService,
      requestedTimeText,
      customerName,
      customerPhone,
      customerEmail,
    });
  } catch (error) {
    throw new AIProcessingStateError(
      `Could not record the appointment request for business ${businessId}.`,
      { cause: error }
    );
  }

  return {
    content: BOOKING_REQUEST_RECORDED_TOOL_RESULT,
    suppressCollectForFollowup: false,
  };
}

export async function processIncomingMessage(
  businessId: string,
  contactPhone: string | null,
  contactEmail: string | null,
  message: string,
  channel: Channel,
  sessionId: string | null = null,
  options: ProcessIncomingMessageOptions = {}
): Promise<string> {
  const result = await processIncomingMessageDetailed(
    businessId,
    contactPhone,
    contactEmail,
    message,
    channel,
    sessionId,
    options
  );

  return result.text;
}

export async function processIncomingMessageDetailed(
  businessId: string,
  contactPhone: string | null,
  contactEmail: string | null,
  message: string,
  channel: Channel,
  sessionId: string | null = null,
  options: ProcessIncomingMessageOptions = {}
): Promise<ProcessIncomingMessageResult> {
  if (channel === "voice") {
    throw new AIProcessingStateError("Voice must use the call-scoped Q&A engine.");
  }
  let activeReplyReservation: ActiveAIReplyReservation | null = null;
  let replyFinalized = false;
  const providerRequestInstanceId = randomUUID();
  let providerCallIndex = 0;
  const turnDeadlineAt = Date.now() + AI_TURN_DEADLINE_MS;

  try {
    if (
      options.webChatRequest &&
      (channel !== "web_chat" ||
        options.isPreview === true ||
        options.persistCustomer === false ||
        options.persistAssistant === false ||
        !sessionId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          options.webChatRequest.clientMessageId,
        ) ||
        !/^[0-9a-f]{64}$/.test(
          options.webChatRequest.requestFingerprint,
        ))
    ) {
      throw new AIProcessingStateError(
        "Live web chat metering requires a canonical request identity.",
      );
    }
    if (options.isPreview && channel !== "web_chat") {
      throw new AIProcessingStateError(
        "AI preview mode is only valid for authenticated web chat.",
      );
    }

    // A successfully finalized (or durably persisted crash-window) reply is
    // already the customer's committed outcome. Recover that exact response
    // before consulting mutable pause or billing state so a retry cannot hide
    // the reply or spend a second unit after a later operational transition.
    if (options.webChatRequest) {
      let recovery: Awaited<ReturnType<typeof getCompletedAIReply>>;
      try {
        recovery = await getCompletedAIReply({
          businessId,
          clientMessageId: options.webChatRequest.clientMessageId,
          requestFingerprint: options.webChatRequest.requestFingerprint,
        });
      } catch (error) {
        if (error instanceof AIReplyIdempotencyConflictError) {
          throw new AIProcessingIdempotencyConflictError();
        }
        if (error instanceof AIReplyMeteringStateError) {
          throw new AIProcessingStateError(
            `Could not recover a completed AI reply for business ${businessId}.`,
            { cause: error },
          );
        }
        throw error;
      }

      if (recovery.outcome === "completed") {
        const text = await loadCompletedAssistantReply({
          businessId,
          assistantMessageId: recovery.assistantMessageId,
          conversationId: recovery.conversationId,
        });
        return {
          text,
          knowledgeGapDetected: false,
          conversationId: recovery.conversationId,
          sourceMessageId: recovery.sourceMessageId,
          actions: [],
          assistantMessageId: recovery.assistantMessageId,
        };
      }
    }

    await assertAIProcessingOperationallyAllowed(businessId, channel);

    // Resolve at the execution boundary even when an upstream webhook already
    // checked the plan. This closes the downgrade/cancel race before any
    // Anthropic request and avoids trusting a stale long-lived decision.
    const entitlements = await resolveBusinessEntitlements(businessId);
    const requiredFeature =
      channel === "sms" ? "ai_sms_conversations" : "web_chat";

    if (!canUseFeature(entitlements, requiredFeature)) {
      throw new AIProcessingBlockedError("feature_not_entitled");
    }

    let contact: Contact;
    try {
      contact =
        options.contact ??
        (await findOrCreateContact(
          businessId,
          contactPhone,
          contactEmail,
          channel,
          sessionId
        ));
    } catch (error) {
      throw new AIProcessingStateError(
        `Could not resolve a contact for business ${businessId}.`,
        { cause: error }
      );
    }

    if (contact.business_id !== businessId) {
      throw new AIProcessingStateError(
        `Contact ${contact.id} does not belong to business ${businessId}.`
      );
    }

    if (options.contactName && !contact.name) {
      const contactName = boundedToolText(
        options.contactName,
        "widget contact name",
        MAX_CONTACT_NAME_LENGTH,
      );
      try {
        await updateContactName(contact.id, contactName);
        contact = { ...contact, name: contactName };
      } catch (error) {
        throw new AIProcessingStateError(
          `Could not save the widget contact name for ${contact.id}.`,
          { cause: error },
        );
      }
    }

    let conversation: Conversation;
    try {
      conversation =
        options.conversation ??
        (await getOrCreateConversation(businessId, contact.id, channel));
    } catch (error) {
      throw new AIProcessingStateError(
        `Could not resolve a conversation for contact ${contact.id}.`,
        { cause: error }
      );
    }

    if (
      conversation.business_id !== businessId ||
      conversation.contact_id !== contact.id ||
      conversation.channel !== channel
    ) {
      throw new AIProcessingStateError(
        `Conversation ${conversation.id} does not match the AI request context.`
      );
    }

    // Defense in depth: the webhook checks this before dispatching AI, and the
    // engine re-reads it so a human takeover that races processing still wins.
    if (channel === "sms") {
      let currentState: Pick<
        Conversation,
        "id" | "status" | "is_ai_handling"
      >;
      try {
        currentState = await getConversationAiState(conversation.id);
      } catch (error) {
        throw new AIProcessingStateError(
          `Could not determine AI state for conversation ${conversation.id}.`,
          { cause: error }
        );
      }
      if (!isAiHandlingActive(currentState)) {
        throw new AIProcessingBlockedError("conversation_in_manual_mode");
      }
    }

    let sourceMessageId = options.sourceMessageId ?? null;
    if (options.persistCustomer !== false) {
      try {
        const persistedMessage = options.webChatRequest
          ? await addWebChatInboundMessageOnce(
              conversation.id,
              businessId,
              message,
              options.webChatRequest.clientMessageId,
            )
          : await addMessage(
              conversation.id,
              businessId,
              "customer",
              message,
              channel,
            );
        sourceMessageId = persistedMessage.id;
        if (
          options.webChatRequest &&
          persistedMessage.conversation_id !== conversation.id
        ) {
          conversation = await getConversationById(
            persistedMessage.conversation_id,
          );
          if (
            conversation.business_id !== businessId ||
            conversation.contact_id !== contact.id ||
            conversation.channel !== channel
          ) {
            throw new WebChatMessageIdempotencyConflictError();
          }
        }
      } catch (error) {
        if (error instanceof WebChatMessageIdempotencyConflictError) {
          throw new AIProcessingIdempotencyConflictError();
        }
        throw new AIProcessingStateError(
          `Could not persist the customer message for conversation ${conversation.id}.`,
          { cause: error }
        );
      }
    }

    if (options.webChatRequest) {
      if (!sourceMessageId) {
        throw new AIProcessingStateError(
          "Live web chat metering requires a durable source message.",
        );
      }
      let reservation: AIReplyReservationDecision;
      try {
        reservation = await reserveAIReplyUnit({
          mode: "live",
          businessId,
          clientMessageId: options.webChatRequest.clientMessageId,
          requestFingerprint: options.webChatRequest.requestFingerprint,
          sourceMessageId,
        });
      } catch (error) {
        if (error instanceof AIReplyIdempotencyConflictError) {
          throw new AIProcessingIdempotencyConflictError();
        }
        if (error instanceof AIReplyMeteringStateError) {
          throw new AIProcessingStateError(
            `Could not reserve an AI reply for business ${businessId}.`,
            { cause: error },
          );
        }
        throw error;
      }

      if (reservation.outcome === "completed") {
        const text = await loadCompletedAssistantReply({
          businessId,
          assistantMessageId: reservation.assistantMessageId,
          conversationId: reservation.conversationId,
        });
        return {
          text,
          knowledgeGapDetected: false,
          conversationId: reservation.conversationId,
          sourceMessageId: reservation.sourceMessageId,
          actions: [],
          assistantMessageId: reservation.assistantMessageId,
        };
      }
      if (reservation.outcome === "in_progress") {
        throw new AIProcessingInProgressError();
      }
      if (reservation.outcome === "limit_reached") {
        throw new AIReplyLimitReachedError(
          reservation.resetAt,
          reservation.allowanceRenewal,
        );
      }
      if (reservation.outcome === "blocked") {
        throw new AIProcessingBlockedError(
          reservation.reason === "account_suspended"
            ? "account_suspended"
            : "ai_replies_paused",
        );
      }
      if (reservation.outcome === "not_entitled") {
        throw new AIProcessingBlockedError("feature_not_entitled");
      }
      if (reservation.outcome !== "reserved") {
        throw new AIProcessingStateError(
          "Live web chat returned an unexpected metering decision.",
        );
      }
      activeReplyReservation = reservation;
    }

    let stateResults;
    try {
      stateResults = await loadBusinessContextResults(supabaseAdmin, businessId);
    } catch (error) {
      throw new AIProcessingStateError(
        `Could not load AI context for business ${businessId}.`,
        { cause: error }
      );
    }

    const [
      businessResult,
      aiSettingsResult,
      servicesResult,
      faqsResult,
      businessHoursResult,
      businessOverviewResult,
      businessKnowledgeDetailsResult,
      calendarTokenResult,
    ] = stateResults;
    const contextError = [
      businessResult,
      aiSettingsResult,
      servicesResult,
      faqsResult,
      businessHoursResult,
      calendarTokenResult,
    ].find((result) => result.error)?.error;
    if (contextError) {
      throw new AIProcessingStateError(
        `Could not load AI context for business ${businessId}.`,
        { cause: contextError }
      );
    }

    const business = businessResult.data;
    const aiSettings = aiSettingsResult.data;
    const services = servicesResult.data;
    const faqs = faqsResult.data;
    const businessHours = businessHoursResult.data;
    const businessKnowledgeReadFailed = Boolean(
      businessOverviewResult.error || businessKnowledgeDetailsResult.error
    );
    if (businessKnowledgeReadFailed) {
      console.error("[ai-engine] Approved business knowledge lookup failed", {
        businessId,
        overviewError: businessOverviewResult.error?.message,
        detailsError: businessKnowledgeDetailsResult.error?.message,
      });
    }
    // Richer knowledge is additive. A temporary read failure must not take the
    // existing services/FAQ assistant offline; it safely falls back to the
    // legacy prompt for this turn.
    const businessKnowledge = businessKnowledgeReadFailed
      ? []
      : [
          ...((businessOverviewResult.data ?? []) as BusinessKnowledgeItem[]),
          ...((businessKnowledgeDetailsResult.data ?? []) as BusinessKnowledgeItem[]),
        ].filter(
          (item, index, items) =>
            items.findIndex((candidate) => candidate.id === item.id) === index,
        );
    const calendarToken = calendarTokenResult.data;

    if (!business || !aiSettings) {
      throw new AIProcessingStateError(
        `Business ${businessId} is missing required AI configuration.`
      );
    }

    // Snapshot goal configuration from this turn's fresh business read. Never
    // re-read it while carrying an action toward the delivery boundary.
    const primaryGoal = (business as Business).primary_goal;
    const isSignupGoal = primaryGoal === "signup";
    const signupGoalUrl = isSignupGoal
      ? (business as Business).goal_url
      : null;
    if (isSignupGoal && !signupGoalUrl) {
      throw new AIProcessingStateError(
        `Signup goal for business ${businessId} is missing its goal URL.`
      );
    }

    const canBookDirectly = canUseFeature(entitlements, "direct_booking");
    const hasCalendar = canBookDirectly && !!calendarToken;
    let history;
    try {
      history = await getConversationHistory(conversation.id);
    } catch (error) {
      throw new AIProcessingStateError(
        `Could not load conversation history for ${conversation.id}.`,
        { cause: error }
      );
    }

    // This uncached read is the first-model execution fence. Everything from
    // here through the Anthropic call is synchronous, so the same snapshot
    // controls both whether AI may run and whether booking prompt/tools exist.
    const modelOperationalControls =
      await assertAIProcessingOperationallyAllowed(businessId, channel);
    const bookingOperationallyAvailable =
      modelOperationalControls.bookingsPausedAt === null;

    // Stored settings survive downgrades and operational pauses. Effective
    // prompt/tool behavior is derived from a copy and never mutates the row.
    const effectiveAiSettings: AISettings = {
      ...(aiSettings as AISettings),
      guardrails: canUseFeature(entitlements, "advanced_guardrails")
        ? (aiSettings as AISettings).guardrails
        : [],
    };

    const buildModelSurface = (bookingAvailable: boolean) => {
      const approvedKnowledge = businessKnowledge;
      // Preserve the exact legacy prompt call surface when no richer knowledge
      // is approved. This keeps old accounts byte-for-byte stable while the
      // new context is rolled out independently.
      const system = approvedKnowledge.length > 0
        ? buildSystemPrompt(
            business as Business,
            effectiveAiSettings,
            (services ?? []) as Service[],
            (faqs ?? []) as FAQ[],
            (businessHours ?? []) as BusinessHours[],
            hasCalendar,
            channel,
            bookingAvailable,
            approvedKnowledge
          )
        : buildSystemPrompt(
            business as Business,
            effectiveAiSettings,
            (services ?? []) as Service[],
            (faqs ?? []) as FAQ[],
            (businessHours ?? []) as BusinessHours[],
            hasCalendar,
            channel,
            bookingAvailable
          );
      const requestTools: Anthropic.Tool[] = [...contactTools];
      if (isSignupGoal) {
        requestTools.push(...signupGoalTools);
      } else if (
        shouldIncludeBookingRequestTools(
          aiSettings as AISettings,
          bookingAvailable
        )
      ) {
        requestTools.push(...bookingRequestTools);
      } else if (
        shouldIncludeCalendarTools(
          aiSettings as AISettings,
          hasCalendar,
          bookingAvailable
        )
      ) {
        requestTools.push(...calendarTools);
      }
      return { system, tools: requestTools };
    };

    const initialModelSurface = buildModelSurface(
      bookingOperationallyAvailable
    );

    // The current customer message is already in history (either persisted
    // above or by a durable webhook caller), so do not append it a second time.
    const messages: Anthropic.MessageParam[] = buildConversationMessages(history);

    let enabledToolNames = new Set(
      initialModelSurface.tools.map((tool) => tool.name)
    );

    // Build API params
    let apiParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system: initialModelSurface.system,
      messages,
      tools: initialModelSurface.tools,
    };

    const createAnthropicMessage = async (
      operation: "message_initial" | "message_tool_followup",
      toolResultCount: number,
    ): Promise<Anthropic.Message> => {
      let retryCount = 0;
      while (true) {
        const timeout = Math.max(
          1,
          Math.min(
            ANTHROPIC_CALL_TIMEOUT_MS,
            remainingAITurnMs(turnDeadlineAt),
          ),
        );
        const callIndex = providerCallIndex++;
        const callIdempotencyKey = activeReplyReservation
          ? `ai:${activeReplyReservation.reservationId}:${activeReplyReservation.attemptToken}:${callIndex}`
          : `ai:${providerRequestInstanceId}:${callIndex}`;
        const startedAt = Date.now();
        const providerOutcome:
          | { ok: true; response: Anthropic.Message }
          | { ok: false; error: unknown } = await anthropic.messages
          .create(apiParams, {
            maxRetries: 0,
            timeout,
          })
          .then(
            (response) => ({ ok: true as const, response }),
            (error: unknown) => ({ ok: false as const, error }),
          );

        await waitForAnthropicAccountingBestEffort(
          {
            businessId,
            channel,
            isPreview: options.isPreview === true,
            reservation: activeReplyReservation,
            callIdempotencyKey,
            operation,
            model: apiParams.model,
            latencyMs: Math.max(0, Date.now() - startedAt),
            toolResultCount,
            response: providerOutcome.ok ? providerOutcome.response : null,
            error: providerOutcome.ok ? null : providerOutcome.error,
          },
          turnDeadlineAt,
        );

        if (providerOutcome.ok) {
          return providerOutcome.response;
        }
        if (
          retryCount >= MAX_EXPLICIT_ANTHROPIC_RETRIES ||
          !isRetriableAnthropicError(providerOutcome.error)
        ) {
          throw providerOutcome.error;
        }
        retryCount++;
        await waitForAnthropicRetry(retryCount, turnDeadlineAt);
      }
    };

    let response = await createAnthropicMessage("message_initial", 0);
    remainingAITurnMs(turnDeadlineAt);
    let loopCount = 0;
    const maxLoops = 3;
    let goalLinkToolUsed = false;
    let suppressCollectForFollowup = false;
    let toolExecutions = 0;
    let availabilityAttempted = false;
    let bookingAttempted = false;

    // Tool-calling loop
    while (response.stop_reason === "tool_use" && loopCount < maxLoops) {
      remainingAITurnMs(turnDeadlineAt);
      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );

      if (toolUseBlocks.length === 0) break;

      // Execute ALL tool calls and collect results
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUseBlock of toolUseBlocks) {
        remainingAITurnMs(turnDeadlineAt);
        let toolResult: string;
        if (toolExecutions >= MAX_TOOL_EXECUTIONS_PER_TURN) {
          toolResult = TOOL_EXECUTION_LIMIT_RESULT;
        } else if (toolUseBlock.name === "save_contact_name" || toolUseBlock.name === "save_contact_email") {
          toolExecutions++;
          toolResult = await awaitWithinAITurnDeadline(
            async () => {
              await assertAIProcessingOperationallyAllowed(businessId, channel);
              return executeContactTool(
                contact.id,
                toolUseBlock.name,
                toolUseBlock.input as Record<string, unknown>,
              );
            },
            turnDeadlineAt,
          );
        } else if (toolUseBlock.name === "offer_goal_link") {
          toolExecutions++;
          toolResult = await awaitWithinAITurnDeadline(
            async () => {
              await assertAIProcessingOperationallyAllowed(businessId, channel);
              if (
                !isSignupGoal ||
                !signupGoalUrl ||
                !enabledToolNames.has(toolUseBlock.name)
              ) {
                return "That tool is not enabled for this business. Do not perform the action.";
              }
              goalLinkToolUsed = true;
              return (
                `Offer this exact link in your direct reply to the customer's current message: ${signupGoalUrl} ` +
                "Do not promise a callback, booking, follow-up, or any other action beyond providing the link."
              );
            },
            turnDeadlineAt,
          );
        } else if (toolUseBlock.name === "record_booking_request") {
          toolExecutions++;
          const bookingRequestResult = await awaitWithinAITurnDeadline(
            () =>
              executeBookingRequestTool({
                businessId,
                contactId: contact.id,
                conversationId: conversation.id,
                sourceMessageId,
                toolInput: toolUseBlock.input as Record<string, unknown>,
                toolWasExposed: enabledToolNames.has(toolUseBlock.name),
                persistBookingRequests:
                  options.persistBookingRequests !== false,
                channel,
              }),
            turnDeadlineAt,
          );
          toolResult = bookingRequestResult.content;
          suppressCollectForFollowup ||=
            bookingRequestResult.suppressCollectForFollowup;
        } else if (
          toolUseBlock.name === "check_availability" ||
          toolUseBlock.name === "create_booking"
        ) {
          toolResult = await awaitWithinAITurnDeadline(
            async () => {
              const toolOperationalControls =
                await assertAIProcessingOperationallyAllowed(
                  businessId,
                  channel,
                );
              if (toolOperationalControls.bookingsPausedAt !== null) {
                return BOOKING_UNAVAILABLE_TOOL_RESULT;
              }
              if (!enabledToolNames.has(toolUseBlock.name)) {
                return "That tool is not enabled for this business. Do not perform the action.";
              }
              if (
                toolUseBlock.name === "check_availability" &&
                availabilityAttempted
              ) {
                return REPEATED_CALENDAR_TOOL_RESULT;
              }
              if (
                toolUseBlock.name === "create_booking" &&
                bookingAttempted
              ) {
                return REPEATED_CALENDAR_TOOL_RESULT;
              }

              toolExecutions++;
              if (toolUseBlock.name === "check_availability") {
                availabilityAttempted = true;
              } else {
                bookingAttempted = true;
              }
              return executeCalendarTool(
                businessId,
                toolUseBlock.name,
                toolUseBlock.input as Record<string, unknown>,
                (business as Business).timezone,
                contactPhone,
                contact.id,
                conversation.id,
                sourceMessageId,
              );
            },
            turnDeadlineAt,
          );
        } else {
          toolResult =
            "That tool is not enabled for this business. Do not perform the action.";
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUseBlock.id,
          content: toolResult,
        });
        remainingAITurnMs(turnDeadlineAt);
      }

      // Add assistant's response (with tool uses) and ALL tool results
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: toolResults,
      });

      // The same fresh snapshot that gates each follow-up model call also
      // rebuilds its booking prompt and tools. A pause that lands during a
      // tool iteration therefore cannot leave calendar capabilities visible.
      const followupOperationalControls =
        await assertAIProcessingOperationallyAllowed(businessId, channel);
      remainingAITurnMs(turnDeadlineAt);
      const followupModelSurface = buildModelSurface(
        followupOperationalControls.bookingsPausedAt === null &&
          !suppressCollectForFollowup
      );
      enabledToolNames = new Set(
        followupModelSurface.tools.map((tool) => tool.name)
      );
      apiParams = {
        ...apiParams,
        system: followupModelSurface.system,
        messages,
        tools: followupModelSurface.tools,
      };
      response = await createAnthropicMessage(
        "message_tool_followup",
        toolResults.length,
      );
      loopCount++;
    }

    remainingAITurnMs(turnDeadlineAt);

    // Extract the final text response
    const textBlock = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === "text"
    );
    if (activeReplyReservation && !textBlock?.text.trim()) {
      throw new AIProcessingStateError(
        "Anthropic returned no durable web chat reply text.",
      );
    }
    const channelFallback =
      channel === "web_chat" ? WEB_CHAT_FALLBACK_MESSAGE : FALLBACK_MESSAGE;
    const rawResponseText = textBlock?.text || channelFallback;
    let parsedResponse: ParsedKnowledgeGapSignal;
    try {
      parsedResponse = parseKnowledgeGapSignal(rawResponseText);
    } catch (error) {
      console.error(
        "[ai-engine] Operation failed",
        safeEngineErrorMetadata("knowledge_gap_parser", error),
      );
      parsedResponse = {
        text: stripExactKnowledgeGapSignal(rawResponseText),
        knowledgeGapDetected: false,
      };
    }
    if (activeReplyReservation && !parsedResponse.text.trim()) {
      throw new AIProcessingStateError(
        "Anthropic returned no customer-visible web chat reply text.",
      );
    }
    const responseText = parsedResponse.text || channelFallback;
    const actions: GoalLinkOfferedAction[] =
      isSignupGoal &&
      signupGoalUrl &&
      goalLinkToolUsed &&
      sourceMessageId &&
      responseText.includes(signupGoalUrl)
        ? [
            {
              kind: "goal_link_offered",
              goalAtEvent: "signup",
              channel,
              contactId: contact.id,
              conversationId: conversation.id,
              sourceMessageId,
              idempotencyKey: buildGoalLinkIdempotencyKey(
                businessId,
                sourceMessageId
              ),
            },
          ]
        : [];

    let assistantMessageId: string | null = null;
    if (options.persistAssistant !== false) {
      remainingAITurnMs(turnDeadlineAt);
      await assertAIProcessingOperationallyAllowed(businessId, channel);
      try {
        const persistedAssistantMessage = activeReplyReservation
          ? await addMessage(
              conversation.id,
              businessId,
              "assistant",
              responseText,
              channel,
              {
                aiReplyReservationId:
                  activeReplyReservation.reservationId,
                aiReplyReservationAttemptToken:
                  activeReplyReservation.attemptToken,
              },
            )
          : await addMessage(
              conversation.id,
              businessId,
              "assistant",
              responseText,
              channel,
            );
        assistantMessageId = persistedAssistantMessage.id;
      } catch (error) {
        throw new AIProcessingStateError(
          `Could not persist the assistant message for conversation ${conversation.id}.`,
          { cause: error }
        );
      }
    }

    if (activeReplyReservation) {
      if (!assistantMessageId) {
        throw new AIProcessingStateError(
          "A metered web chat reply was not durably persisted.",
        );
      }
      let finalized;
      try {
        finalized = await finalizeAIReplyUnit({
          reservationId: activeReplyReservation.reservationId,
          attemptToken: activeReplyReservation.attemptToken,
          assistantMessageId,
        });
      } catch (error) {
        throw new AIProcessingStateError(
          `Could not finalize AI reply usage for business ${businessId}.`,
          { cause: error },
        );
      }
      if (finalized.outcome !== "completed") {
        throw new AIProcessingStateError(
          `AI reply usage was not ready for business ${businessId}.`,
        );
      }
      replyFinalized = true;
    }

    const leadScoreIncrease = scoreMessage(message);
    if (leadScoreIncrease > 0) {
      if (replyFinalized) {
        // The durable assistant row and allowance unit are now one committed
        // customer outcome. Lead scoring is operational enrichment only: run
        // it without delaying or suppressing the reply, and contain failures.
        void (async () => {
          try {
            await assertAIProcessingOperationallyAllowed(businessId, channel);
            await incrementLeadScore(contact.id, leadScoreIncrease);
          } catch (error) {
            console.error(
              "[ai-engine] Post-commit lead score enrichment failed",
              {
                businessId,
                contactId: contact.id,
                error:
                  error instanceof Error
                    ? error.name
                    : "unknown_lead_score_error",
              },
            );
          }
        })();
      } else {
        await assertAIProcessingOperationallyAllowed(businessId, channel);
        await incrementLeadScore(contact.id, leadScoreIncrease);
      }
    }

    if (!replyFinalized) {
      await assertAIProcessingOperationallyAllowed(businessId, channel);
    }
    return {
      text: responseText,
      knowledgeGapDetected: parsedResponse.knowledgeGapDetected,
      conversationId: conversation.id,
      sourceMessageId,
      actions,
      assistantMessageId,
    };
  } catch (error) {
    if (activeReplyReservation && !replyFinalized) {
      try {
        const release = await releaseAIReplyUnit({
          reservationId: activeReplyReservation.reservationId,
          attemptToken: activeReplyReservation.attemptToken,
          reason: "processing_failed",
        });
        if (release.outcome === "completed") replyFinalized = true;
      } catch (releaseError) {
        console.error("[ai-engine] AI reply reservation release failed", {
          businessId,
          reservationId: activeReplyReservation.reservationId,
          error:
            releaseError instanceof Error
              ? releaseError.name
              : "unknown_release_error",
        });
      }
    }
    if (
      error instanceof AIProcessingBlockedError ||
      error instanceof AIProcessingStateError ||
      error instanceof AIProcessingIdempotencyConflictError ||
      error instanceof AIProcessingInProgressError ||
      error instanceof AIReplyLimitReachedError ||
      error instanceof EntitlementResolutionError ||
      isOperationalControlsResolutionError(error)
    ) {
      throw error;
    }
    console.error(
      "[ai-engine] Operation failed",
      safeEngineErrorMetadata("incoming_message_processing", error),
    );
    await assertAIProcessingOperationallyAllowed(businessId, channel);
    if (options.webChatRequest) {
      throw new AIProcessingStateError(
        `Could not process live web chat for business ${businessId}.`,
        { cause: error },
      );
    }
    return {
      text:
        channel === "web_chat" ? WEB_CHAT_FALLBACK_MESSAGE : FALLBACK_MESSAGE,
      knowledgeGapDetected: false,
      conversationId: null,
      sourceMessageId: null,
      actions: [],
      assistantMessageId: null,
    };
  }
}
