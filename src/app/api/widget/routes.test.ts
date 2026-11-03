import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class AIProcessingBlockedError extends Error {
    constructor(
      readonly reason:
        | "feature_not_entitled"
        | "conversation_in_manual_mode"
        | "account_suspended"
        | "ai_replies_paused"
        | "texting_paused",
    ) {
      super(reason);
    }
  }
  class AIProcessingStateError extends Error {}
  class AIProcessingIdempotencyConflictError extends Error {}
  class AIProcessingInProgressError extends Error {
    readonly retryAfterSeconds = 2;
  }
  class AIReplyLimitReachedError extends Error {
    constructor(
      readonly resetAt: string | null,
      readonly allowanceRenewal: "scheduled" | "frozen_past_due" =
        resetAt === null ? "frozen_past_due" : "scheduled",
    ) {
      super("assistant unavailable");
    }
  }
  class BusinessPartnerResolutionError extends Error {}
  return {
    from: vi.fn(),
    serverFrom: vi.fn(),
    getUser: vi.fn(),
    resolveBusinessEntitlements: vi.fn(),
    canUseFeature: vi.fn(),
    processIncomingMessageDetailed: vi.fn(),
    buildWidgetChatRequestFingerprint: vi.fn(),
    finalizeGoalLinkEvent: vi.fn(),
    recordKnowledgeGap: vi.fn(),
    buildAiConversationSourceKey: vi.fn(),
    buildWebChatSessionSourceKey: vi.fn(),
    recordBusinessMetricEventBestEffort: vi.fn(),
    resolveWidgetAttribution: vi.fn(),
    resolveBusinessOperationalControls: vi.fn(),
    AIProcessingBlockedError,
    AIProcessingIdempotencyConflictError,
    AIProcessingInProgressError,
    AIProcessingStateError,
    AIReplyLimitReachedError,
    BusinessPartnerResolutionError,
    requireWorkspaceRouteAccess: vi.fn(),
    mintWidgetToken: vi.fn(),
    verifyWidgetToken: vi.fn(),
    readWidgetBearerToken: vi.fn(),
    acquireWidgetIngressTraffic: vi.fn(),
    acquireWidgetTraffic: vi.fn(),
    releaseWidgetTraffic: vi.fn(),
    deriveWidgetNetworkKey: vi.fn(),
    deriveWidgetRequestKey: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mocks.from },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mocks.getUser },
    from: mocks.serverFrom,
  })),
}));
vi.mock("@/lib/billing/entitlements", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/billing/entitlements")>();
  return {
    ...actual,
    resolveBusinessEntitlements: mocks.resolveBusinessEntitlements,
    canUseFeature: mocks.canUseFeature,
  };
});
vi.mock("@/lib/ai/engine", () => ({
  processIncomingMessageDetailed: mocks.processIncomingMessageDetailed,
  AIProcessingBlockedError: mocks.AIProcessingBlockedError,
  AIProcessingIdempotencyConflictError:
    mocks.AIProcessingIdempotencyConflictError,
  AIProcessingInProgressError: mocks.AIProcessingInProgressError,
  AIProcessingStateError: mocks.AIProcessingStateError,
  AIReplyLimitReachedError: mocks.AIReplyLimitReachedError,
}));
vi.mock("@/lib/widget/idempotency.server", () => ({
  buildWidgetChatRequestFingerprint: mocks.buildWidgetChatRequestFingerprint,
}));
vi.mock("@/lib/ai/goalEvents", () => ({
  finalizeGoalLinkEvent: mocks.finalizeGoalLinkEvent,
}));
vi.mock("@/lib/ai/knowledgeGaps", () => ({
  recordKnowledgeGap: mocks.recordKnowledgeGap,
}));
vi.mock("@/lib/metrics/sourceKeys.server", () => ({
  buildAiConversationSourceKey: mocks.buildAiConversationSourceKey,
  buildWebChatSessionSourceKey: mocks.buildWebChatSessionSourceKey,
}));
vi.mock("@/lib/metrics/recording.server", () => ({
  recordBusinessMetricEventBestEffort:
    mocks.recordBusinessMetricEventBestEffort,
}));
vi.mock("@/lib/branding/businessPartner.server", () => ({
  resolveWidgetAttribution: mocks.resolveWidgetAttribution,
  BusinessPartnerResolutionError: mocks.BusinessPartnerResolutionError,
}));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({
  requireWorkspaceRouteAccess: mocks.requireWorkspaceRouteAccess,
}));
vi.mock("@/lib/widget/token.server", () => ({
  mintWidgetToken: mocks.mintWidgetToken,
  verifyWidgetToken: mocks.verifyWidgetToken,
  readWidgetBearerToken: mocks.readWidgetBearerToken,
}));
vi.mock("@/lib/widget/ingressTraffic.server", () => ({
  acquireWidgetIngressTraffic: mocks.acquireWidgetIngressTraffic,
}));
vi.mock("@/lib/widget/traffic.server", () => ({
  acquireWidgetTraffic: mocks.acquireWidgetTraffic,
  releaseWidgetTraffic: mocks.releaseWidgetTraffic,
  deriveWidgetNetworkKey: mocks.deriveWidgetNetworkKey,
  deriveWidgetRequestKey: mocks.deriveWidgetRequestKey,
}));
vi.mock("@/lib/account/operationalControls.server", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/account/operationalControls.server")
    >();
  return {
    ...actual,
    resolveBusinessOperationalControls:
      mocks.resolveBusinessOperationalControls,
  };
});

import { EntitlementResolutionError } from "@/lib/billing/entitlements";
import { OperationalControlsResolutionError } from "@/lib/account/operationalControls.server";
import { WIDGET_EDGE_ORIGIN_HEADER } from "@/lib/widget/edgeOrigin.server";
import { OPTIONS as optionsChat, POST as postChat } from "./chat/route";
import {
  GET as getConfig,
  OPTIONS as optionsConfig,
  PATCH as patchConfig,
} from "./config/route";
import { OPTIONS as optionsEnd, POST as postEnd } from "./end/route";
import { GET as getPreviewConfig } from "./preview-config/route";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000001";
const EDGE_SECRET = "e".repeat(64);
const PAUSED_AT = "2026-08-04T12:00:00.000Z";
const WEB_CHAT_SOURCE_KEY = `web-chat-session:${"a".repeat(64)}`;
const AI_CONVERSATION_SOURCE_KEY =
  "ai-conversation:00000000-0000-4000-8000-000000000010:2026-08";
const WEB_CHAT_GOAL_ACTION = {
  kind: "goal_link_offered",
  goalAtEvent: "signup",
  channel: "web_chat",
  contactId: "contact-1",
  conversationId: "conversation-1",
  sourceMessageId: "customer-message-1",
  idempotencyKey: "opaque-web-chat-goal-key",
} as const;
const ENTITLEMENTS = {
  businessId: BUSINESS_ID,
  plan: "sms_and_chat",
  status: "active",
  source: "subscription",
  active: true,
  cancelAtPeriodEnd: false,
} as const;
const ACTIVE_OPERATIONAL_CONTROLS = {
  businessId: BUSINESS_ID,
  operationsSuspendedAt: null,
  aiRepliesPausedAt: null,
  textingPausedAt: null,
  bookingsPausedAt: null,
} as const;

type QueryResult = { data?: unknown; error?: unknown };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function queueDatabaseResults(...results: QueryResult[]) {
  const queue = [...results];
  mocks.from.mockImplementation(() => {
    const queued = queue.shift() ?? { data: null, error: null };
    const result =
      queued.data &&
      typeof queued.data === "object" &&
      !Array.isArray(queued.data) &&
      "id" in queued.data &&
      String((queued.data as { id?: unknown }).id).startsWith("widget-")
        ? {
            ...queued,
            data: {
              allowed_hostnames: ["localhost"],
              is_active: true,
              ...queued.data,
            },
          }
        : queued;
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ["select", "eq", "maybeSingle", "update"]) {
      chain[method] = vi.fn(() => chain);
    }
    const promise = Promise.resolve({ data: null, error: null, ...result });
    (chain as Record<string, unknown>).then = promise.then.bind(promise);
    (chain as Record<string, unknown>).catch = promise.catch.bind(promise);
    return chain;
  });
}

function configRequest(headers?: HeadersInit) {
  return new NextRequest(
    `http://localhost/api/widget/config?businessId=${BUSINESS_ID}&sessionId=session-1`,
    {
      headers: {
        Origin: "http://localhost",
        [WIDGET_EDGE_ORIGIN_HEADER]: EDGE_SECRET,
        ...headers,
      },
    },
  );
}

function sameOriginConfigRequest(headers: Record<string, string> = {}) {
  return new NextRequest(
    `http://localhost/api/widget/config?businessId=${BUSINESS_ID}&sessionId=session-1`,
    {
      headers: {
        Host: "localhost",
        "Sec-Fetch-Site": "same-origin",
        [WIDGET_EDGE_ORIGIN_HEADER]: EDGE_SECRET,
        ...headers,
      },
    },
  );
}

function previewConfigRequest(headers?: HeadersInit) {
  return new NextRequest(
    `http://localhost/api/widget/preview-config?businessId=${BUSINESS_ID}`,
    { headers },
  );
}

const WIDGET_CONFIG_PATCH = {
  brand_color: "#123456",
  position: "bottom_right",
  show_logo: false,
  logo_url: null,
  welcome_message: "Welcome",
  proactive_invitation_enabled: true,
  lead_capture_enabled: true,
  lead_capture_timing: "start",
  quick_replies: ["Pricing"],
  is_active: true,
  allowed_hostnames: ["localhost"],
} as const;

function configPatchRequest(body: unknown = WIDGET_CONFIG_PATCH) {
  return new NextRequest("http://localhost/api/widget/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function setServerBusinessResult(result: QueryResult) {
  mocks.serverFrom.mockImplementation(() => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ["select", "eq", "maybeSingle"]) {
      chain[method] = vi.fn(() => chain);
    }
    chain.maybeSingle.mockResolvedValue({ data: null, error: null, ...result });
    return chain;
  });
}

function postRequest(
  path: "chat" | "end",
  body: unknown,
  headers: HeadersInit = {},
) {
  const original = body as Record<string, unknown>;
  const normalized: Record<string, unknown> = {
    ...original,
    ...(path === "chat" && original.clientMessageId === undefined
      ? { clientMessageId: "00000000-0000-4000-8000-000000000003" }
      : {}),
    ...(original.preview === true || original.sessionNonce !== undefined
      ? {}
      : { sessionNonce: "abcdefghijklmnopqrstuvwx" }),
  };
  const businessId = String(normalized.businessId ?? BUSINESS_ID);
  const sessionId = String(normalized.sessionId ?? "missing-session");
  return new NextRequest(
    `http://localhost/api/widget/${path}?businessId=${encodeURIComponent(businessId)}&sessionId=${encodeURIComponent(sessionId)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: "localhost",
        Origin: "http://localhost",
        Authorization: "Bearer test-token",
        [WIDGET_EDGE_ORIGIN_HEADER]: EDGE_SECRET,
        ...headers,
      },
      body: JSON.stringify(normalized),
    },
  );
}

function preflightRequest(
  path: "config" | "chat" | "end",
  origin = "http://localhost",
) {
  return new NextRequest(
    `http://localhost/api/widget/${path}?businessId=${BUSINESS_ID}&sessionId=session-1`,
    {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        [WIDGET_EDGE_ORIGIN_HEADER]: EDGE_SECRET,
      },
    },
  );
}

function withoutEdgeMarker(request: NextRequest) {
  request.headers.delete(WIDGET_EDGE_ORIGIN_HEADER);
  return request;
}

function withEdgeMarker(request: NextRequest, marker: string | null) {
  if (marker === null) {
    request.headers.delete(WIDGET_EDGE_ORIGIN_HEADER);
  } else {
    request.headers.set(WIDGET_EDGE_ORIGIN_HEADER, marker);
  }
  return request;
}

beforeEach(() => {
  vi.stubEnv("WIDGET_EDGE_ORIGIN_SECRET", EDGE_SECRET);
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  setServerBusinessResult({ data: { id: BUSINESS_ID }, error: null });
  mocks.resolveBusinessEntitlements.mockResolvedValue(ENTITLEMENTS);
  mocks.canUseFeature.mockReturnValue(true);
  mocks.resolveBusinessOperationalControls.mockResolvedValue(
    ACTIVE_OPERATIONAL_CONTROLS,
  );
  mocks.processIncomingMessageDetailed.mockResolvedValue({
    text: "How can I help?",
    knowledgeGapDetected: false,
    conversationId: "conversation-1",
    sourceMessageId: "customer-message-1",
    actions: [],
    assistantMessageId: "assistant-message-1",
  });
  mocks.buildWidgetChatRequestFingerprint.mockReturnValue(
    "request-fingerprint",
  );
  mocks.finalizeGoalLinkEvent.mockResolvedValue("inserted");
  mocks.recordKnowledgeGap.mockResolvedValue(undefined);
  mocks.buildWebChatSessionSourceKey.mockReturnValue(WEB_CHAT_SOURCE_KEY);
  mocks.buildAiConversationSourceKey.mockReturnValue(
    AI_CONVERSATION_SOURCE_KEY,
  );
  mocks.recordBusinessMetricEventBestEffort.mockReturnValue(undefined);
  mocks.resolveWidgetAttribution.mockResolvedValue({
    poweredByName: "SimplAssist",
    poweredByUrl: "https://simplassist.com",
  });
  mocks.requireWorkspaceRouteAccess.mockResolvedValue({
    ok: true,
    access: {
      status: "resolved",
      user: { id: "user-1" },
      business: { id: BUSINESS_ID, partner_id: null },
      hostKind: "canonical",
    },
  });
  mocks.mintWidgetToken.mockReturnValue({
    token: "test-token",
    sessionNonce: "abcdefghijklmnopqrstuvwx",
    expiresAt: "2026-08-18T12:05:00.000Z",
  });
  mocks.verifyWidgetToken.mockReturnValue(true);
  mocks.readWidgetBearerToken.mockReturnValue("test-token");
  mocks.acquireWidgetIngressTraffic.mockResolvedValue({ status: "allowed" });
  mocks.acquireWidgetTraffic.mockResolvedValue({
    status: "allowed",
    lease: { sharedLeaseToken: null, localConcurrencyKeys: [] },
  });
  mocks.releaseWidgetTraffic.mockResolvedValue(undefined);
  mocks.deriveWidgetNetworkKey.mockReturnValue("network-key");
  mocks.deriveWidgetRequestKey.mockReturnValue("request-key");
  queueDatabaseResults();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("authenticated widget configuration mutations", () => {
  it.each([
    [401, { error: "Unauthorized" }],
    [403, { error: "workspace_access_denied" }],
    [503, { error: "workspace_access_unavailable", retryable: true }],
  ])(
    "returns workspace %i before parsing, entitlements, or updates",
    async (status, body) => {
      mocks.requireWorkspaceRouteAccess.mockResolvedValue({
        ok: false,
        response: NextResponse.json(body, { status }),
      });
      const guardedRequest = configPatchRequest();
      const json = vi.spyOn(guardedRequest, "json");

      const response = await patchConfig(guardedRequest);

      expect(response.status).toBe(status);
      expect(json).not.toHaveBeenCalled();
      expect(mocks.resolveBusinessEntitlements).not.toHaveBeenCalled();
      expect(mocks.from).not.toHaveBeenCalled();
    },
  );

  it("returns 403 for a known web-chat entitlement denial", async () => {
    mocks.canUseFeature.mockReturnValue(false);

    const response = await patchConfig(configPatchRequest());

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "feature_unavailable",
      feature: "web_chat",
      requiredPlan: "sms_and_chat",
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("returns retryable 503 when entitlement state is indeterminate", async () => {
    mocks.resolveBusinessEntitlements.mockRejectedValue(
      new EntitlementResolutionError({
        code: "subscription_lookup_failed",
        businessId: BUSINESS_ID,
        message: "database unavailable",
      }),
    );

    const response = await patchConfig(configPatchRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Service temporarily unavailable",
      retryable: true,
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("updates an allow-listed configuration through the admin client", async () => {
    vi.stubEnv("WIDGET_EDGE_ORIGIN_SECRET", "");
    queueDatabaseResults({
      data: {
        id: "widget-1",
        business_id: BUSINESS_ID,
        ...WIDGET_CONFIG_PATCH,
      },
      error: null,
    });

    const response = await patchConfig(configPatchRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.config).toMatchObject({
      id: "widget-1",
      business_id: BUSINESS_ID,
      welcome_message: "Welcome",
      proactive_invitation_enabled: true,
    });
    const updateChain = mocks.from.mock.results[0]?.value as {
      update: ReturnType<typeof vi.fn>;
      eq: ReturnType<typeof vi.fn>;
    };
    expect(updateChain.update).toHaveBeenCalledWith(WIDGET_CONFIG_PATCH);
    expect(updateChain.eq).toHaveBeenCalledWith("business_id", BUSINESS_ID);
    expect(mocks.resolveBusinessOperationalControls).not.toHaveBeenCalled();
  });

  it("returns retryable 503 when the admin configuration update fails", async () => {
    queueDatabaseResults({
      data: null,
      error: { message: "connection reset" },
    });

    const response = await patchConfig(configPatchRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Service temporarily unavailable",
      retryable: true,
    });
  });

  it("requires an explicit proactive invitation preference", async () => {
    const payload: Record<string, unknown> = { ...WIDGET_CONFIG_PATCH };
    delete payload.proactive_invitation_enabled;

    const response = await patchConfig(configPatchRequest(payload));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid widget configuration",
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("refuses to activate a widget with an explicitly empty hostname allowlist", async () => {
    const response = await patchConfig(
      configPatchRequest({ ...WIDGET_CONFIG_PATCH, allowed_hostnames: [] }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "An allowed website hostname is required before activation",
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("checks the persisted effective allowlist when activation omits hostnames", async () => {
    const legacyPayload = {
      ...WIDGET_CONFIG_PATCH,
      allowed_hostnames: undefined,
    };
    queueDatabaseResults({ data: { allowed_hostnames: [] }, error: null });

    const response = await patchConfig(configPatchRequest(legacyPayload));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "An allowed website hostname is required before activation",
    });
    expect(mocks.from).toHaveBeenCalledOnce();
  });

  it("allows an inactive widget to retain an empty allowlist", async () => {
    const payload = {
      ...WIDGET_CONFIG_PATCH,
      is_active: false,
      allowed_hostnames: [],
    };
    queueDatabaseResults({ data: { id: "widget-1", ...payload }, error: null });

    const response = await patchConfig(configPatchRequest(payload));

    expect(response.status).toBe(200);
    const updateChain = mocks.from.mock.results[0]?.value as {
      update: ReturnType<typeof vi.fn>;
    };
    expect(updateChain.update).toHaveBeenCalledWith(payload);
  });
});

describe("public widget entitlement boundaries", () => {
  it("returns an authoritative unavailable response for a known plan denial", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.canUseFeature.mockReturnValue(false);

    const response = await getConfig(configRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: false });
    expect(mocks.requireWorkspaceRouteAccess).not.toHaveBeenCalled();
  });

  it("returns retryable 503 when entitlement state cannot be determined", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.resolveBusinessEntitlements.mockRejectedValue(
      new EntitlementResolutionError({
        code: "subscription_lookup_failed",
        businessId: BUSINESS_ID,
        message: "database unavailable",
      }),
    );

    const response = await getConfig(configRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "service_unavailable",
      retryable: true,
    });
  });

  it.each([
    ["account suspension", { operationsSuspendedAt: PAUSED_AT }],
    ["AI pause", { aiRepliesPausedAt: PAUSED_AT }],
  ])(
    "returns the privacy-safe unavailable config for %s",
    async (_label, pausedState) => {
      queueDatabaseResults(
        { data: { id: "widget-1" }, error: null },
        { data: { name: "Acme" }, error: null },
      );
      mocks.resolveBusinessOperationalControls.mockResolvedValue({
        ...ACTIVE_OPERATIONAL_CONTROLS,
        ...pausedState,
      });

      const response = await getConfig(configRequest());

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ available: false });
      expect(mocks.resolveBusinessOperationalControls).toHaveBeenCalledWith(
        BUSINESS_ID,
      );
      expect(mocks.from).toHaveBeenCalledTimes(1);
      expect(mocks.resolveWidgetAttribution).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["texting pause", { textingPausedAt: PAUSED_AT }],
    ["bookings pause", { bookingsPausedAt: PAUSED_AT }],
  ])(
    "keeps public config available during a %s",
    async (_label, pausedState) => {
      queueDatabaseResults(
        {
          data: {
            id: "widget-1",
            brand_color: "#123456",
            position: "bottom_right",
            welcome_message: "Welcome",
            show_logo: false,
            logo_url: null,
            lead_capture_enabled: true,
            lead_capture_timing: "start",
            quick_replies: [],
          },
          error: null,
        },
        { data: { name: "Acme" }, error: null },
      );
      mocks.resolveBusinessOperationalControls.mockResolvedValue({
        ...ACTIVE_OPERATIONAL_CONTROLS,
        ...pausedState,
      });

      const response = await getConfig(configRequest());

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ available: true });
    },
  );

  it("returns a generic retryable response when config operational state is indeterminate", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.resolveBusinessOperationalControls.mockRejectedValue(
      new OperationalControlsResolutionError({
        code: "business_lookup_failed",
        businessId: BUSINESS_ID,
        message: "private database detail",
      }),
    );

    const response = await getConfig(configRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "service_unavailable",
      retryable: true,
    });
    expect(mocks.resolveWidgetAttribution).not.toHaveBeenCalled();
  });

  it("returns configuration only after an active widget and entitlement pass", async () => {
    queueDatabaseResults(
      {
        data: {
          id: "widget-1",
          brand_color: "#123456",
          position: "bottom_right",
          welcome_message: "Welcome",
          proactive_invitation_enabled: true,
          show_logo: false,
          logo_url: null,
          lead_capture_enabled: true,
          lead_capture_timing: "start",
          quick_replies: ["Pricing"],
        },
        error: null,
      },
      { data: { name: "Acme" }, error: null },
    );

    const response = await getConfig(configRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      available: true,
      businessName: "Acme",
      welcomeMessage: "Welcome",
      proactiveInvitationEnabled: false,
      poweredByName: "SimplAssist",
      poweredByUrl: "https://simplassist.com",
      widgetToken: "test-token",
      widgetSessionNonce: "abcdefghijklmnopqrstuvwx",
    });
    expect(mocks.mintWidgetToken).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      origin: "http://localhost",
      sessionId: "session-1",
    });

    const configChain = mocks.from.mock.results[0]?.value as {
      eq: ReturnType<typeof vi.fn>;
    };
    expect(configChain.eq).toHaveBeenCalledWith("business_id", BUSINESS_ID);
  });

  it.each([
    [true, true],
    [false, false],
  ])(
    "combines broad proactive authority with saved preference %s",
    async (preference, expected) => {
      vi.stubEnv("WIDGET_PROACTIVE_INVITATIONS_ENABLED", "1");
      queueDatabaseResults(
        {
          data: {
            id: "widget-1",
            brand_color: "#123456",
            position: "bottom_right",
            welcome_message: "Welcome",
            proactive_invitation_enabled: preference,
            show_logo: false,
            logo_url: null,
            lead_capture_enabled: true,
            lead_capture_timing: "start",
            quick_replies: [],
          },
          error: null,
        },
        { data: { name: "Acme" }, error: null },
      );

      const response = await getConfig(configRequest());
      expect(await response.json()).toMatchObject({
        available: true,
        proactiveInvitationEnabled: expected,
      });
    },
  );

  it("returns unavailable when AI pauses while config attribution is pending", async () => {
    queueDatabaseResults(
      {
        data: {
          id: "widget-1",
          brand_color: "#123456",
          position: "bottom_right",
          welcome_message: "Welcome",
          show_logo: false,
          logo_url: null,
          lead_capture_enabled: true,
          lead_capture_timing: "start",
          quick_replies: ["Pricing"],
        },
        error: null,
      },
      { data: { name: "Acme" }, error: null },
    );
    const attribution = deferred<{
      poweredByName: string;
      poweredByUrl: string;
    }>();
    mocks.resolveWidgetAttribution.mockReturnValue(attribution.promise);
    mocks.resolveBusinessOperationalControls
      .mockResolvedValueOnce(ACTIVE_OPERATIONAL_CONTROLS)
      .mockResolvedValueOnce({
        ...ACTIVE_OPERATIONAL_CONTROLS,
        aiRepliesPausedAt: PAUSED_AT,
      });

    const responsePromise = getConfig(configRequest());
    await vi.waitFor(() =>
      expect(mocks.resolveWidgetAttribution).toHaveBeenCalledOnce(),
    );
    expect(mocks.resolveBusinessOperationalControls).toHaveBeenCalledTimes(1);

    attribution.resolve({
      poweredByName: "Private attribution",
      poweredByUrl: "https://private.example",
    });
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: false });
    expect(mocks.resolveBusinessOperationalControls).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the final config operational read is indeterminate", async () => {
    queueDatabaseResults(
      {
        data: {
          id: "widget-1",
          brand_color: "#123456",
          position: "bottom_right",
          welcome_message: "Welcome",
          show_logo: false,
          logo_url: null,
          lead_capture_enabled: true,
          lead_capture_timing: "start",
          quick_replies: [],
        },
        error: null,
      },
      { data: { name: "Acme" }, error: null },
    );
    mocks.resolveBusinessOperationalControls
      .mockResolvedValueOnce(ACTIVE_OPERATIONAL_CONTROLS)
      .mockRejectedValueOnce(
        new OperationalControlsResolutionError({
          code: "business_lookup_failed",
          businessId: BUSINESS_ID,
          message: "private database detail",
        }),
      );

    const response = await getConfig(configRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "service_unavailable",
      retryable: true,
    });
    expect(mocks.resolveBusinessOperationalControls).toHaveBeenCalledTimes(2);
  });

  it("finalizes a live goal action after the committed engine result without a mutable route recheck", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.processIncomingMessageDetailed.mockResolvedValue({
      text: "Start here: https://example.com/signup",
      knowledgeGapDetected: false,
      conversationId: "conversation-1",
      sourceMessageId: "customer-message-1",
      actions: [WEB_CHAT_GOAL_ACTION],
      assistantMessageId: "assistant-message-1",
    });

    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "I want to sign up.",
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      available: true,
      response: "Start here: https://example.com/signup",
      sessionId: "session-1",
    });
    expect(mocks.finalizeGoalLinkEvent).toHaveBeenCalledOnce();
    const finalizationInput = mocks.finalizeGoalLinkEvent.mock.calls[0]?.[0];
    expect(finalizationInput).toEqual({
      businessId: BUSINESS_ID,
      action: WEB_CHAT_GOAL_ACTION,
      assistantMessageId: "assistant-message-1",
      occurredAt: expect.any(Date),
    });
    expect(
      mocks.processIncomingMessageDetailed.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.finalizeGoalLinkEvent.mock.invocationCallOrder[0]);
    expect(mocks.resolveBusinessEntitlements).not.toHaveBeenCalled();
    expect(mocks.resolveBusinessOperationalControls).not.toHaveBeenCalled();
  });

  it("serves an unauthenticated non-preview chat request without requiring workspace access", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.requireWorkspaceRouteAccess.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Can you help?",
        sessionId: "public-session",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      available: true,
      response: "How can I help?",
      sessionId: "public-session",
    });
    expect(mocks.requireWorkspaceRouteAccess).not.toHaveBeenCalled();
    expect(mocks.processIncomingMessageDetailed).toHaveBeenCalledWith(
      BUSINESS_ID,
      null,
      null,
      "Can you help?",
      "web_chat",
      "public-session",
      {
        persistBookingRequests: true,
        isPreview: false,
        contactName: undefined,
        webChatRequest: {
          clientMessageId: "00000000-0000-4000-8000-000000000003",
          requestFingerprint: "request-fingerprint",
        },
      },
    );
    expect(mocks.buildWidgetChatRequestFingerprint).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      origin: "http://localhost",
      sessionId: "public-session",
      clientMessageId: "00000000-0000-4000-8000-000000000003",
      message: "Can you help?",
      visitorEmail: undefined,
      visitorName: undefined,
    });
  });

  it("awaits and logs a failed live finalizer without retrying or suppressing the persisted reply", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.processIncomingMessageDetailed.mockResolvedValue({
      text: "Start here: https://example.com/signup",
      knowledgeGapDetected: false,
      conversationId: "conversation-1",
      sourceMessageId: "customer-message-1",
      actions: [WEB_CHAT_GOAL_ACTION],
      assistantMessageId: "assistant-message-1",
    });
    const finalization = deferred<"inserted" | "duplicate">();
    mocks.finalizeGoalLinkEvent.mockReturnValue(finalization.promise);
    const finalizationError = new Error("goal event insert failed");

    const responsePromise = postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "I want to sign up.",
        sessionId: "session-1",
      }),
    );

    await vi.waitFor(() =>
      expect(mocks.finalizeGoalLinkEvent).toHaveBeenCalledOnce(),
    );
    expect(mocks.recordBusinessMetricEventBestEffort).not.toHaveBeenCalled();
    finalization.reject(finalizationError);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      available: true,
      response: "Start here: https://example.com/signup",
      sessionId: "session-1",
    });
    expect(mocks.processIncomingMessageDetailed).toHaveBeenCalledOnce();
    expect(mocks.finalizeGoalLinkEvent).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith(
      "[widget:chat] Goal event finalization failed:",
      {
        businessId: BUSINESS_ID,
        conversationId: "conversation-1",
        sourceMessageId: "customer-message-1",
      },
      finalizationError,
    );
  });

  it("keeps a verified same-business preview live while suppressing booking-request persistence and goal-event finalization", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.processIncomingMessageDetailed.mockResolvedValue({
      text: "Start here: https://example.com/signup",
      knowledgeGapDetected: false,
      conversationId: "conversation-1",
      sourceMessageId: "customer-message-1",
      actions: [WEB_CHAT_GOAL_ACTION],
      assistantMessageId: "assistant-message-1",
    });

    const response = await postChat(
      withoutEdgeMarker(postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "I want to sign up.",
        sessionId: "preview-session",
        preview: true,
      })),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      available: true,
      response: "Start here: https://example.com/signup",
    });
    expect(mocks.requireWorkspaceRouteAccess).toHaveBeenCalledOnce();
    expect(mocks.acquireWidgetTraffic).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "preview_chat" }),
    );
    expect(mocks.processIncomingMessageDetailed).toHaveBeenCalledWith(
      BUSINESS_ID,
      null,
      null,
      "I want to sign up.",
      "web_chat",
      "preview-session",
      {
        persistBookingRequests: false,
        isPreview: true,
        contactName: undefined,
        webChatRequest: undefined,
      },
    );
    expect(mocks.buildWidgetChatRequestFingerprint).not.toHaveBeenCalled();
    expect(mocks.resolveBusinessOperationalControls).toHaveBeenCalledTimes(2);
    expect(mocks.recordBusinessMetricEventBestEffort).toHaveBeenCalledTimes(2);
    expect(mocks.finalizeGoalLinkEvent).not.toHaveBeenCalled();
  });

  it.each([
    [401, { error: "unauthorized" }],
    [403, { error: "origin_not_allowed" }],
    [503, { error: "service_unavailable", retryable: true }],
  ])(
    "rejects an unverified preview with workspace %i before any chat read or AI work",
    async (status, body) => {
      mocks.requireWorkspaceRouteAccess.mockResolvedValue({
        ok: false,
        response: NextResponse.json(body, { status }),
      });

      const response = await postChat(
        withoutEdgeMarker(postRequest("chat", {
          businessId: BUSINESS_ID,
          message: "I want to sign up.",
          sessionId: "preview-session",
          preview: true,
        })),
      );

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(body);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "http://localhost",
      );
      expect(mocks.from).not.toHaveBeenCalled();
      expect(mocks.resolveBusinessEntitlements).not.toHaveBeenCalled();
      expect(mocks.resolveBusinessOperationalControls).not.toHaveBeenCalled();
      expect(mocks.processIncomingMessageDetailed).not.toHaveBeenCalled();
      expect(mocks.finalizeGoalLinkEvent).not.toHaveBeenCalled();
      expect(mocks.acquireWidgetIngressTraffic).toHaveBeenCalledOnce();
      expect(
        mocks.acquireWidgetIngressTraffic.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mocks.requireWorkspaceRouteAccess.mock.invocationCallOrder[0],
      );
    },
  );

  it("rejects a same-session preview marker for another workspace business before AI", async () => {
    mocks.requireWorkspaceRouteAccess.mockResolvedValue({
      ok: true,
      access: {
        status: "resolved",
        user: { id: "user-1" },
        business: {
          id: "00000000-0000-4000-8000-000000000099",
          partner_id: null,
        },
        hostKind: "canonical",
      },
    });

    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "I want to sign up.",
        sessionId: "preview-session",
        preview: true,
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "origin_not_allowed",
    });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.processIncomingMessageDetailed).not.toHaveBeenCalled();
    expect(mocks.finalizeGoalLinkEvent).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean preview marker before live work", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.processIncomingMessageDetailed.mockResolvedValue({
      text: "Start here: https://example.com/signup",
      knowledgeGapDetected: false,
      conversationId: "conversation-1",
      sourceMessageId: "customer-message-1",
      actions: [WEB_CHAT_GOAL_ACTION],
      assistantMessageId: "assistant-message-1",
    });

    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "I want to sign up.",
        sessionId: "session-1",
        preview: "true",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(mocks.requireWorkspaceRouteAccess).not.toHaveBeenCalled();
    expect(mocks.processIncomingMessageDetailed).not.toHaveBeenCalled();
    expect(mocks.finalizeGoalLinkEvent).not.toHaveBeenCalled();
  });

  it("logs a missing assistant proof without recording or suppressing the reply", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.processIncomingMessageDetailed.mockResolvedValue({
      text: "Start here: https://example.com/signup",
      knowledgeGapDetected: false,
      conversationId: "conversation-1",
      sourceMessageId: "customer-message-1",
      actions: [WEB_CHAT_GOAL_ACTION],
      assistantMessageId: null,
    });

    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "I want to sign up.",
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      available: true,
      response: "Start here: https://example.com/signup",
    });
    expect(mocks.finalizeGoalLinkEvent).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "[widget:chat] Goal event finalization skipped: missing assistant message proof.",
      {
        businessId: BUSINESS_ID,
        conversationId: "conversation-1",
        sourceMessageId: "customer-message-1",
      },
    );
  });

  it("returns the cleaned chat response while launching gap capture in the background", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.processIncomingMessageDetailed.mockResolvedValue({
      text: "I don't see free trials mentioned. Please call us.",
      knowledgeGapDetected: true,
      conversationId: "conversation-1",
      sourceMessageId: "customer-message-1",
      actions: [],
      assistantMessageId: "assistant-message-1",
    });
    mocks.recordKnowledgeGap.mockReturnValue(new Promise(() => undefined));

    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Do you offer free trials?",
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      available: true,
      response: "I don't see free trials mentioned. Please call us.",
      sessionId: "session-1",
    });
    expect(mocks.recordKnowledgeGap).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      sourceMessageId: "customer-message-1",
      aiResponseText: "I don't see free trials mentioned. Please call us.",
    });
    expect(
      mocks.processIncomingMessageDetailed.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.recordKnowledgeGap.mock.invocationCallOrder[0]);
    expect(mocks.buildWebChatSessionSourceKey).toHaveBeenCalledWith(
      BUSINESS_ID,
      "session-1",
    );
    expect(mocks.buildAiConversationSourceKey).toHaveBeenCalledTimes(1);
    const [, metricOccurredAt] = mocks.buildAiConversationSourceKey.mock
      .calls[0] as [string, Date];
    expect(mocks.buildAiConversationSourceKey).toHaveBeenCalledWith(
      "conversation-1",
      metricOccurredAt,
    );
    expect(mocks.recordBusinessMetricEventBestEffort.mock.calls).toEqual([
      [
        {
          businessId: BUSINESS_ID,
          metricKey: "web_chat_session_engaged",
          quantity: 1,
          occurredAt: metricOccurredAt,
          sourceKey: WEB_CHAT_SOURCE_KEY,
          origin: null,
        },
      ],
      [
        {
          businessId: BUSINESS_ID,
          metricKey: "ai_conversation_engaged",
          quantity: 1,
          occurredAt: metricOccurredAt,
          sourceKey: AI_CONVERSATION_SOURCE_KEY,
          origin: null,
        },
      ],
    ]);
    expect(
      JSON.stringify(mocks.recordBusinessMetricEventBestEffort.mock.calls),
    ).not.toContain("session-1");
  });

  it.each([0, 1])(
    "keeps the widget response successful when metric dispatch %i throws",
    async (failedCallIndex) => {
      queueDatabaseResults({ data: { id: "widget-1" }, error: null });
      let callIndex = 0;
      mocks.recordBusinessMetricEventBestEffort.mockImplementation(() => {
        if (callIndex++ === failedCallIndex) {
          throw new Error("private metric failure");
        }
      });

      const response = await postChat(
        postRequest("chat", {
          businessId: BUSINESS_ID,
          message: "Hello",
          sessionId: "session-private",
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        available: true,
        response: "How can I help?",
        sessionId: "session-private",
      });
      expect(mocks.recordBusinessMetricEventBestEffort).toHaveBeenCalledTimes(
        2,
      );
      expect(console.error).toHaveBeenCalledWith(
        "[widget:chat] Metric recording failed:",
        {
          businessId: BUSINESS_ID,
          metricKey:
            failedCallIndex === 0
              ? "web_chat_session_engaged"
              : "ai_conversation_engaged",
        },
      );
    },
  );

  it("does not wait for unresolved metric work before returning the widget response", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.recordBusinessMetricEventBestEffort.mockReturnValue(
      new Promise(() => undefined),
    );

    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Hello",
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      available: true,
      response: "How can I help?",
    });
    expect(mocks.recordBusinessMetricEventBestEffort).toHaveBeenCalledTimes(2);
  });

  it("does not fabricate metrics for an engine fallback without a conversation ID", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.processIncomingMessageDetailed.mockResolvedValue({
      text: "Please try again later.",
      knowledgeGapDetected: false,
      conversationId: null,
      sourceMessageId: null,
      actions: [],
      assistantMessageId: null,
    });

    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Hello",
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      available: true,
      response: "Please try again later.",
    });
    expect(mocks.buildWebChatSessionSourceKey).not.toHaveBeenCalled();
    expect(mocks.buildAiConversationSourceKey).not.toHaveBeenCalled();
    expect(mocks.recordBusinessMetricEventBestEffort).not.toHaveBeenCalled();
  });

  it("reuses conflict-stable widget and conversation source keys on route retries", async () => {
    queueDatabaseResults(
      { data: { id: "widget-1" }, error: null },
      { data: { id: "widget-1" }, error: null },
    );
    const requestBody = {
      businessId: BUSINESS_ID,
      message: "Hello",
      sessionId: "session-1",
    };

    const firstResponse = await postChat(postRequest("chat", requestBody));
    const secondResponse = await postChat(postRequest("chat", requestBody));

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(
      mocks.recordBusinessMetricEventBestEffort.mock.calls.map(
        ([input]) => input.sourceKey,
      ),
    ).toEqual([
      WEB_CHAT_SOURCE_KEY,
      AI_CONVERSATION_SOURCE_KEY,
      WEB_CHAT_SOURCE_KEY,
      AI_CONVERSATION_SOURCE_KEY,
    ]);
  });

  it("does not capture a widget response without a gap signal", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });

    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Hello",
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      available: true,
      response: "How can I help?",
    });
    expect(mocks.recordKnowledgeGap).not.toHaveBeenCalled();
  });

  it("returns the widget response when background gap capture unexpectedly rejects", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.processIncomingMessageDetailed.mockResolvedValue({
      text: "I don't see free trials mentioned. Please call us.",
      knowledgeGapDetected: true,
      conversationId: "conversation-1",
      sourceMessageId: "customer-message-1",
      actions: [],
      assistantMessageId: "assistant-message-1",
    });
    const captureError = new Error("capture failed");
    mocks.recordKnowledgeGap.mockRejectedValue(captureError);

    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Do you offer free trials?",
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      available: true,
      response: "I don't see free trials mentioned. Please call us.",
    });
    await vi.waitFor(() =>
      expect(console.error).toHaveBeenCalledWith(
        "[widget:chat] Knowledge gap capture failed:",
        {
          businessId: BUSINESS_ID,
          sourceMessageId: "customer-message-1",
        },
        captureError,
      ),
    );
  });

  it.each([
    ["account suspension", "account_suspended"],
    ["AI pause", "ai_replies_paused"],
  ])(
    "maps the engine's live %s gate to privacy-safe unavailable chat",
    async (_label, reason) => {
      queueDatabaseResults({ data: { id: "widget-1" }, error: null });
      mocks.processIncomingMessageDetailed.mockRejectedValue(
        new mocks.AIProcessingBlockedError(
          reason as "account_suspended" | "ai_replies_paused",
        ),
      );

      const response = await postChat(
        postRequest("chat", {
          businessId: BUSINESS_ID,
          message: "Hello",
          sessionId: "session-1",
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        available: false,
        response: null,
      });
      expect(mocks.processIncomingMessageDetailed).toHaveBeenCalledOnce();
      expect(mocks.resolveBusinessEntitlements).not.toHaveBeenCalled();
      expect(mocks.resolveBusinessOperationalControls).not.toHaveBeenCalled();
      expect(mocks.recordBusinessMetricEventBestEffort).not.toHaveBeenCalled();
    },
  );

  it.each([["texting pause"], ["bookings pause"]])(
    "leaves non-AI pause decisions to the live engine for a %s",
    async () => {
      queueDatabaseResults({ data: { id: "widget-1" }, error: null });

      const response = await postChat(
        postRequest("chat", {
          businessId: BUSINESS_ID,
          message: "Hello",
          sessionId: "session-1",
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        available: true,
        response: "How can I help?",
      });
      expect(mocks.processIncomingMessageDetailed).toHaveBeenCalledOnce();
      expect(mocks.resolveBusinessOperationalControls).not.toHaveBeenCalled();
    },
  );

  it("never suppresses a committed live reply with a post-engine route gate", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.resolveBusinessEntitlements.mockRejectedValue(
      new Error("a recovered live reply must precede mutable billing state"),
    );
    mocks.resolveBusinessOperationalControls.mockRejectedValue(
      new Error("a recovered live reply must precede mutable pause state"),
    );
    mocks.processIncomingMessageDetailed.mockResolvedValue({
      text: "Private generated response",
      knowledgeGapDetected: true,
      conversationId: "conversation-1",
      sourceMessageId: "customer-message-1",
      actions: [],
      assistantMessageId: "assistant-message-1",
    });

    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Do you offer free trials?",
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      available: true,
      response: "Private generated response",
      sessionId: "session-1",
    });
    expect(mocks.processIncomingMessageDetailed).toHaveBeenCalledTimes(1);
    expect(mocks.resolveBusinessOperationalControls).not.toHaveBeenCalled();
    expect(mocks.recordKnowledgeGap).toHaveBeenCalledOnce();
    expect(mocks.recordBusinessMetricEventBestEffort).toHaveBeenCalledTimes(2);
    expect(mocks.releaseWidgetTraffic).toHaveBeenCalledOnce();
  });

  it("fails preview closed when its post-generation operational read is indeterminate", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.resolveBusinessOperationalControls
      .mockResolvedValueOnce(ACTIVE_OPERATIONAL_CONTROLS)
      .mockRejectedValueOnce(
        new OperationalControlsResolutionError({
          code: "business_lookup_failed",
          businessId: BUSINESS_ID,
          message: "private database detail",
        }),
      );
    mocks.processIncomingMessageDetailed.mockResolvedValue({
      text: "Private generated response",
      knowledgeGapDetected: true,
      conversationId: "conversation-1",
      sourceMessageId: "customer-message-1",
      actions: [],
      assistantMessageId: "assistant-message-1",
    });

    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Do you offer free trials?",
        sessionId: "preview-session",
        preview: true,
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "service_unavailable",
      retryable: true,
    });
    expect(mocks.processIncomingMessageDetailed).toHaveBeenCalledTimes(1);
    expect(mocks.resolveBusinessOperationalControls).toHaveBeenCalledTimes(2);
    expect(
      mocks.processIncomingMessageDetailed.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.resolveBusinessOperationalControls.mock.invocationCallOrder[1],
    );
    expect(mocks.recordKnowledgeGap).not.toHaveBeenCalled();
    expect(mocks.recordBusinessMetricEventBestEffort).not.toHaveBeenCalled();
  });

  it("fails preview closed before AI when its initial operational read is indeterminate", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.resolveBusinessOperationalControls.mockRejectedValue(
      new OperationalControlsResolutionError({
        code: "business_lookup_failed",
        businessId: BUSINESS_ID,
        message: "private database detail",
      }),
    );

    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Hello",
        sessionId: "preview-session",
        preview: true,
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "service_unavailable",
      retryable: true,
    });
    expect(mocks.processIncomingMessageDetailed).not.toHaveBeenCalled();
    expect(mocks.recordBusinessMetricEventBestEffort).not.toHaveBeenCalled();
    expect(mocks.releaseWidgetTraffic).toHaveBeenCalledOnce();
  });

  it("skips preview AI and acknowledges chat when the plan is not entitled", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.canUseFeature.mockReturnValue(false);

    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Hello",
        sessionId: "preview-session",
        preview: true,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      available: false,
      response: null,
    });
    expect(mocks.processIncomingMessageDetailed).not.toHaveBeenCalled();
    expect(mocks.releaseWidgetTraffic).toHaveBeenCalledOnce();
  });

  it("returns retryable 503 without preview AI when entitlement resolution fails", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.resolveBusinessEntitlements.mockRejectedValue(
      new EntitlementResolutionError({
        code: "subscription_lookup_failed",
        businessId: BUSINESS_ID,
        message: "database unavailable",
      }),
    );

    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Hello",
        sessionId: "preview-session",
        preview: true,
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "service_unavailable",
      retryable: true,
    });
    expect(mocks.processIncomingMessageDetailed).not.toHaveBeenCalled();
    // The sole database call is the required read-only widget availability lookup.
    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.releaseWidgetTraffic).toHaveBeenCalledOnce();
  });

  it("returns unavailable when the AI engine catches a downgrade race", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.processIncomingMessageDetailed.mockRejectedValue(
      new mocks.AIProcessingBlockedError("feature_not_entitled"),
    );

    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Hello",
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      available: false,
      response: null,
    });
  });

  it("switches to lead capture without exposing monthly reply quota state", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.processIncomingMessageDetailed.mockRejectedValue(
      new mocks.AIReplyLimitReachedError("2026-09-01T00:00:00.000Z"),
    );

    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Can someone call me?",
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      available: true,
      response: null,
      mode: "lead_capture",
      reason: "assistant_unavailable",
    });
    expect(JSON.stringify(body)).not.toMatch(
      /allowance|completed|limit|quota|remaining|reset|usage/i,
    );
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost",
    );
    expect(response.headers.get("vary")).toContain("Origin");
    expect(mocks.releaseWidgetTraffic).toHaveBeenCalledOnce();
  });

  it("keeps a frozen past-due allowance denial generic without deriving a reset", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.processIncomingMessageDetailed.mockRejectedValue(
      new mocks.AIReplyLimitReachedError(null, "frozen_past_due"),
    );

    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Can someone call me?",
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      available: true,
      response: null,
      mode: "lead_capture",
      reason: "assistant_unavailable",
    });
    expect(JSON.stringify(body)).not.toMatch(
      /allowance|completed|limit|quota|remaining|reset|usage|payment/i,
    );
    expect(response.headers.get("retry-after")).toBeNull();
    expect(mocks.releaseWidgetTraffic).toHaveBeenCalledOnce();
  });

  it("maps an in-progress duplicate to a generic retryable response", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.processIncomingMessageDetailed.mockRejectedValue(
      new mocks.AIProcessingInProgressError(),
    );

    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Can someone call me?",
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "rate_limited",
      retryable: true,
    });
    expect(response.headers.get("retry-after")).toBe("2");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost",
    );
    expect(mocks.releaseWidgetTraffic).toHaveBeenCalledOnce();
  });

  it("rejects a reused client message id with a non-retryable generic conflict", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.processIncomingMessageDetailed.mockRejectedValue(
      new mocks.AIProcessingIdempotencyConflictError(),
    );

    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "This payload changed.",
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "request_conflict",
      retryable: false,
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost",
    );
    expect(mocks.releaseWidgetTraffic).toHaveBeenCalledOnce();
  });

  it.each(["account_suspended", "ai_replies_paused"] as const)(
    "does not expose the engine's %s block",
    async (reason) => {
      queueDatabaseResults({ data: { id: "widget-1" }, error: null });
      mocks.processIncomingMessageDetailed.mockRejectedValue(
        new mocks.AIProcessingBlockedError(reason),
      );

      const response = await postChat(
        postRequest("chat", {
          businessId: BUSINESS_ID,
          message: "Hello",
          sessionId: "session-1",
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        available: false,
        response: null,
      });
    },
  );

  it("returns retryable 503 for an indeterminate engine operational read", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.processIncomingMessageDetailed.mockRejectedValue(
      new OperationalControlsResolutionError({
        code: "business_lookup_failed",
        businessId: BUSINESS_ID,
        message: "private database detail",
      }),
    );

    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Hello",
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "service_unavailable",
      retryable: true,
    });
  });

  it("returns retryable 503 when AI context persistence or lookup is uncertain", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.processIncomingMessageDetailed.mockRejectedValue(
      new mocks.AIProcessingStateError("database unavailable"),
    );

    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Hello",
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "service_unavailable",
      retryable: true,
    });
  });

  it("skips conversation writes when end-session is not entitled", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.canUseFeature.mockReturnValue(false);

    const response = await postEnd(
      postRequest("end", {
        businessId: BUSINESS_ID,
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      available: false,
    });
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it("returns retryable 503 without conversation writes when end-session entitlement resolution fails", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.resolveBusinessEntitlements.mockRejectedValue(
      new EntitlementResolutionError({
        code: "subscription_lookup_failed",
        businessId: BUSINESS_ID,
        message: "database unavailable",
      }),
    );

    const response = await postEnd(
      postRequest("end", {
        businessId: BUSINESS_ID,
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "service_unavailable",
      retryable: true,
    });
    // The sole database call is the required read-only widget availability lookup.
    expect(mocks.from).toHaveBeenCalledTimes(1);
  });

  it("keeps end-session cleanup available without operational checks", async () => {
    queueDatabaseResults(
      { data: { id: "widget-1" }, error: null },
      { data: { id: "contact-1" }, error: null },
      { data: { id: "conversation-1" }, error: null },
      { data: null, error: null },
    );
    mocks.resolveBusinessOperationalControls.mockRejectedValue(
      new Error("operational controls must not gate cleanup"),
    );

    const response = await postEnd(
      postRequest("end", {
        businessId: BUSINESS_ID,
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      available: true,
    });
    expect(mocks.resolveBusinessOperationalControls).not.toHaveBeenCalled();
  });
});

describe("public widget transport security", () => {
  it.each([
    [
      "config GET",
      (marker: string | null) =>
        getConfig(withEdgeMarker(configRequest(), marker)),
    ],
    [
      "config OPTIONS",
      (marker: string | null) =>
        optionsConfig(withEdgeMarker(preflightRequest("config"), marker)),
    ],
    [
      "chat POST",
      (marker: string | null) =>
        postChat(
          withEdgeMarker(
            postRequest("chat", {
              businessId: BUSINESS_ID,
              message: "Hello",
              sessionId: "session-1",
            }),
            marker,
          ),
        ),
    ],
    [
      "chat OPTIONS",
      (marker: string | null) =>
        optionsChat(withEdgeMarker(preflightRequest("chat"), marker)),
    ],
    [
      "end POST",
      (marker: string | null) =>
        postEnd(
          withEdgeMarker(
            postRequest("end", {
              businessId: BUSINESS_ID,
              sessionId: "session-1",
            }),
            marker,
          ),
        ),
    ],
    [
      "end OPTIONS",
      (marker: string | null) =>
        optionsEnd(withEdgeMarker(preflightRequest("end"), marker)),
    ],
  ] as const)(
    "rejects missing and wrong edge markers on public %s before downstream work",
    async (_label, invoke) => {
      for (const marker of [null, "x".repeat(64)] as const) {
        vi.clearAllMocks();

        const response = await invoke(marker);

        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: "origin_not_allowed",
        });
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("vary")).toContain("Origin");
        expect(mocks.acquireWidgetIngressTraffic).not.toHaveBeenCalled();
        expect(mocks.acquireWidgetTraffic).not.toHaveBeenCalled();
        expect(mocks.requireWorkspaceRouteAccess).not.toHaveBeenCalled();
        expect(mocks.readWidgetBearerToken).not.toHaveBeenCalled();
        expect(mocks.verifyWidgetToken).not.toHaveBeenCalled();
        expect(mocks.from).not.toHaveBeenCalled();
        expect(mocks.processIncomingMessageDetailed).not.toHaveBeenCalled();
      }
    },
  );

  it("fails a public route closed when the edge secret is missing", async () => {
    vi.stubEnv("WIDGET_EDGE_ORIGIN_SECRET", "");

    const response = await getConfig(configRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "service_unavailable",
      retryable: true,
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(mocks.acquireWidgetIngressTraffic).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("does not trust forged proxy, Fetch Metadata, Origin, or Host headers on a direct Railway request", async () => {
    const response = await getConfig(
      new NextRequest(
        `https://simplassist-production.up.railway.app/api/widget/config?businessId=${BUSINESS_ID}&sessionId=session-1`,
        {
          headers: {
            Host: "simplassist.com",
            Origin: "https://simplassist.com",
            "Sec-Fetch-Site": "same-origin",
            "X-Forwarded-Host": "simplassist.com",
            "X-Forwarded-Proto": "https",
            "CF-Ray": "forged",
          },
        },
      ),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "origin_not_allowed" });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(mocks.acquireWidgetIngressTraffic).not.toHaveBeenCalled();
    expect(mocks.acquireWidgetTraffic).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.mintWidgetToken).not.toHaveBeenCalled();
  });

  it.each([
    [
      "chat",
      () =>
        postChat(
          withoutEdgeMarker(
            postRequest("chat", {
              businessId: BUSINESS_ID,
              message: "Hello",
              sessionId: "preview-session",
              preview: true,
            }),
          ),
        ),
    ],
    [
      "end",
      () =>
        postEnd(
          withoutEdgeMarker(
            postRequest("end", {
              businessId: BUSINESS_ID,
              sessionId: "preview-session",
              preview: true,
            }),
          ),
        ),
    ],
  ] as const)(
    "rate-controls an unauthenticated %s preview-shaped request before workspace auth",
    async (_label, invoke) => {
      mocks.requireWorkspaceRouteAccess.mockResolvedValue({
        ok: false,
        response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
      });

      const response = await invoke();

      expect(response.status).toBe(401);
      expect(mocks.acquireWidgetIngressTraffic).toHaveBeenCalledOnce();
      expect(mocks.requireWorkspaceRouteAccess).toHaveBeenCalledOnce();
      expect(
        mocks.acquireWidgetIngressTraffic.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mocks.requireWorkspaceRouteAccess.mock.invocationCallOrder[0],
      );
      expect(mocks.readWidgetBearerToken).not.toHaveBeenCalled();
      expect(mocks.verifyWidgetToken).not.toHaveBeenCalled();
      expect(mocks.acquireWidgetTraffic).not.toHaveBeenCalled();
      expect(mocks.from).not.toHaveBeenCalled();
      expect(mocks.processIncomingMessageDetailed).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["config", optionsConfig],
    ["chat", optionsChat],
    ["end", optionsEnd],
  ] as const)(
    "answers %s preflight without DB work or wildcard CORS",
    async (_path, handler) => {
      const response = await handler(preflightRequest(_path));

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "http://localhost",
      );
      expect(response.headers.get("access-control-allow-origin")).not.toBe("*");
      expect(response.headers.get("access-control-allow-methods")).toBe(
        _path === "config" ? "GET, OPTIONS" : "POST, OPTIONS",
      );
      if (_path === "config") {
        expect(response.headers.get("access-control-allow-headers")).toBeNull();
      } else {
        expect(response.headers.get("access-control-allow-headers")).toContain(
          "Authorization",
        );
      }
      expect(response.headers.get("vary")).toContain("Origin");
      expect(mocks.from).not.toHaveBeenCalled();
      expect(mocks.acquireWidgetIngressTraffic).not.toHaveBeenCalled();
      expect(mocks.acquireWidgetTraffic).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed preflight before DB work", async () => {
    const response = await optionsChat(preflightRequest("chat", "null"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("vary")).toContain("Origin");
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.acquireWidgetIngressTraffic).not.toHaveBeenCalled();
  });

  it("rejects a missing Origin before token, DB, traffic, or AI work", async () => {
    const response = await postChat(
      postRequest(
        "chat",
        {
          businessId: BUSINESS_ID,
          message: "Hello",
          sessionId: "session-1",
        },
        { Origin: "" },
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(mocks.verifyWidgetToken).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.acquireWidgetIngressTraffic).not.toHaveBeenCalled();
    expect(mocks.acquireWidgetTraffic).not.toHaveBeenCalled();
    expect(mocks.processIncomingMessageDetailed).not.toHaveBeenCalled();
  });

  it("accepts an Origin-less browser same-origin config GET through the persisted allowlist", async () => {
    queueDatabaseResults({
      data: {
        id: "widget-1",
        allowed_hostnames: ["localhost"],
        is_active: false,
      },
      error: null,
    });

    const response = await getConfig(sameOriginConfigRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: false });
    expect(mocks.from).toHaveBeenCalledOnce();
    expect(mocks.acquireWidgetIngressTraffic).toHaveBeenCalledWith({
      endpoint: "config",
      networkKey: "network-key",
    });
    expect(mocks.acquireWidgetTraffic).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        sessionId: "session-1",
        originHostname: "localhost",
      }),
    );
  });

  it("derives the public origin from proxy Host and protocol without requiring mode or destination metadata", async () => {
    queueDatabaseResults(
      {
        data: {
          id: "widget-1",
          brand_color: "#123456",
          position: "bottom_right",
          welcome_message: "Welcome",
          show_logo: false,
          logo_url: null,
          lead_capture_enabled: true,
          lead_capture_timing: "start",
          quick_replies: [],
          allowed_hostnames: ["simplassist.com"],
          is_active: true,
        },
        error: null,
      },
      { data: { name: "SimplAssist" }, error: null },
    );
    const response = await getConfig(
      new NextRequest(
        `http://railway.internal:8080/api/widget/config?businessId=${BUSINESS_ID}&sessionId=session-1`,
        {
          headers: {
            Host: "simplassist.com",
            "X-Forwarded-Proto": "https",
            "Sec-Fetch-Site": "same-origin",
            [WIDGET_EDGE_ORIGIN_HEADER]: EDGE_SECRET,
          },
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ available: true });
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://simplassist.com",
    );
    expect(mocks.acquireWidgetTraffic).toHaveBeenCalledWith(
      expect.objectContaining({ originHostname: "simplassist.com" }),
    );
    expect(mocks.mintWidgetToken).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      origin: "https://simplassist.com",
      sessionId: "session-1",
    });
  });

  it("rejects an internal/public host mismatch without a forwarded protocol before DB work", async () => {
    const response = await getConfig(
      new NextRequest(
        `http://railway.internal:8080/api/widget/config?businessId=${BUSINESS_ID}&sessionId=session-1`,
        {
          headers: {
            Host: "simplassist.com",
            "Sec-Fetch-Site": "same-origin",
            [WIDGET_EDGE_ORIGIN_HEADER]: EDGE_SECRET,
          },
        },
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.acquireWidgetIngressTraffic).not.toHaveBeenCalled();
    expect(mocks.acquireWidgetTraffic).not.toHaveBeenCalled();
    expect(mocks.mintWidgetToken).not.toHaveBeenCalled();
  });

  it("keeps an explicit valid Origin authoritative over malformed fallback-only proxy headers", async () => {
    queueDatabaseResults({
      data: {
        id: "widget-1",
        allowed_hostnames: ["simplassist.com"],
        is_active: false,
      },
      error: null,
    });
    const response = await getConfig(
      new NextRequest(
        `http://railway.internal:8080/api/widget/config?businessId=${BUSINESS_ID}&sessionId=session-1`,
        {
          headers: {
            Origin: "https://simplassist.com",
            Host: "https://malformed.example",
            "X-Forwarded-Proto": "https,http",
            "Sec-Fetch-Site": "cross-site",
            [WIDGET_EDGE_ORIGIN_HEADER]: EDGE_SECRET,
          },
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: false });
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://simplassist.com",
    );
    expect(mocks.from).toHaveBeenCalledOnce();
  });

  it("still denies a same-origin config GET when its synthesized hostname is not persisted", async () => {
    queueDatabaseResults({
      data: {
        id: "widget-1",
        allowed_hostnames: ["www.example.com"],
        is_active: true,
      },
      error: null,
    });

    const response = await getConfig(sameOriginConfigRequest());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "origin_not_allowed" });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(mocks.from).toHaveBeenCalledOnce();
    expect(mocks.acquireWidgetTraffic).not.toHaveBeenCalled();
    expect(mocks.mintWidgetToken).not.toHaveBeenCalled();
  });

  it.each([
    ["missing Fetch Metadata", { Host: "localhost" }],
    [
      "a non-same-origin site",
      {
        Host: "localhost",
        "Sec-Fetch-Site": "same-site",
      },
    ],
    [
      "an explicitly empty Origin",
      {
        Host: "localhost",
        Origin: "",
        "Sec-Fetch-Site": "same-origin",
      },
    ],
    [
      "an opaque Origin",
      {
        Host: "localhost",
        Origin: "null",
        "Sec-Fetch-Site": "same-origin",
      },
    ],
    [
      "a missing Host",
      {
        "Sec-Fetch-Site": "same-origin",
      },
    ],
    [
      "a URL-shaped Host",
      {
        Host: "https://simplassist.com",
        "Sec-Fetch-Site": "same-origin",
      },
    ],
    [
      "a list-valued Host",
      {
        Host: "simplassist.com,evil.example",
        "Sec-Fetch-Site": "same-origin",
      },
    ],
    [
      "a list-valued forwarded protocol",
      {
        Host: "simplassist.com",
        "X-Forwarded-Proto": "https,http",
        "Sec-Fetch-Site": "same-origin",
      },
    ],
    [
      "an empty forwarded protocol",
      {
        Host: "simplassist.com",
        "X-Forwarded-Proto": "",
        "Sec-Fetch-Site": "same-origin",
      },
    ],
  ])("rejects a config GET with %s before DB work", async (_label, headers) => {
    const response = await getConfig(
      new NextRequest(
        `http://localhost/api/widget/config?businessId=${BUSINESS_ID}&sessionId=session-1`,
        {
          headers: {
            ...headers,
            [WIDGET_EDGE_ORIGIN_HEADER]: EDGE_SECRET,
          },
        },
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.acquireWidgetIngressTraffic).not.toHaveBeenCalled();
    expect(mocks.acquireWidgetTraffic).not.toHaveBeenCalled();
    expect(mocks.mintWidgetToken).not.toHaveBeenCalled();
  });

  it("denies rotating unknown config identifiers at ingress before widget reads", async () => {
    mocks.acquireWidgetIngressTraffic.mockResolvedValueOnce({
      status: "rate_limited",
      retryAfterSeconds: 19,
    });
    const unknownBusinessId = "00000000-0000-4000-8000-000000000099";
    const response = await getConfig(
      new NextRequest(
        `http://localhost/api/widget/config?businessId=${unknownBusinessId}&sessionId=session-unknown`,
        {
          headers: {
            Origin: "https://untrusted.example",
            [WIDGET_EDGE_ORIGIN_HEADER]: EDGE_SECRET,
          },
        },
      ),
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "rate_limited",
      retryable: true,
    });
    expect(response.headers.get("retry-after")).toBe("19");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(mocks.acquireWidgetIngressTraffic).toHaveBeenCalledWith({
      endpoint: "config",
      networkKey: "network-key",
    });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.acquireWidgetTraffic).not.toHaveBeenCalled();
    expect(mocks.resolveBusinessEntitlements).not.toHaveBeenCalled();
    expect(mocks.resolveWidgetAttribution).not.toHaveBeenCalled();
    expect(mocks.mintWidgetToken).not.toHaveBeenCalled();
  });

  it.each([
    ["chat", postChat],
    ["end", postEnd],
  ] as const)(
    "counts a denied-origin or invalid-bearer %s request before authentication",
    async (path, handler) => {
      mocks.acquireWidgetIngressTraffic.mockResolvedValueOnce({
        status: "rate_limited",
        retryAfterSeconds: 7,
      });
      mocks.readWidgetBearerToken.mockReturnValue(null);
      const response = await handler(
        postRequest(
          path,
          {
            businessId: "00000000-0000-4000-8000-000000000099",
            ...(path === "chat" ? { message: "Hello" } : {}),
            sessionId: "session-rotated",
          },
          { Origin: "https://untrusted.example", Authorization: "bad" },
        ),
      );

      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({
        error: "rate_limited",
        retryable: true,
      });
      expect(response.headers.get("retry-after")).toBe("7");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(mocks.acquireWidgetIngressTraffic).toHaveBeenCalledWith({
        endpoint: path,
        networkKey: "network-key",
      });
      expect(mocks.readWidgetBearerToken).not.toHaveBeenCalled();
      expect(mocks.verifyWidgetToken).not.toHaveBeenCalled();
      expect(mocks.requireWorkspaceRouteAccess).not.toHaveBeenCalled();
      expect(mocks.acquireWidgetTraffic).not.toHaveBeenCalled();
      expect(mocks.from).not.toHaveBeenCalled();
      expect(mocks.processIncomingMessageDetailed).not.toHaveBeenCalled();
    },
  );

  it("fails ingress closed without granting unverified CORS authority", async () => {
    mocks.acquireWidgetIngressTraffic.mockResolvedValueOnce({
      status: "unavailable",
    });
    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Hello",
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "service_unavailable",
      retryable: true,
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(mocks.readWidgetBearerToken).not.toHaveBeenCalled();
    expect(mocks.acquireWidgetTraffic).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.processIncomingMessageDetailed).not.toHaveBeenCalled();
  });

  it("rate-controls an inactive exact-origin config before preserving its unavailable response", async () => {
    queueDatabaseResults({
      data: { id: "widget-1", is_active: false },
      error: null,
    });

    const response = await getConfig(configRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: false });
    expect(mocks.acquireWidgetTraffic).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      originHostname: "localhost",
      sessionId: "session-1",
      endpoint: "config",
      networkKey: "network-key",
      requestKey: "request-key",
    });
    expect(mocks.resolveBusinessEntitlements).not.toHaveBeenCalled();
    expect(mocks.resolveBusinessOperationalControls).not.toHaveBeenCalled();
    expect(mocks.mintWidgetToken).not.toHaveBeenCalled();
  });

  it("returns a generic 429 when inactive config polling exceeds shared capacity", async () => {
    queueDatabaseResults({
      data: { id: "widget-1", is_active: false },
      error: null,
    });
    mocks.acquireWidgetTraffic.mockResolvedValue({
      status: "rate_limited",
      retryAfterSeconds: 13,
    });

    const response = await getConfig(configRequest());

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "rate_limited",
      retryable: true,
    });
    expect(response.headers.get("retry-after")).toBe("13");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost",
    );
    // Only the exact-allowlist read needed to decide CORS may precede traffic.
    expect(mocks.from).toHaveBeenCalledOnce();
    expect(mocks.resolveBusinessEntitlements).not.toHaveBeenCalled();
    expect(mocks.resolveBusinessOperationalControls).not.toHaveBeenCalled();
    expect(mocks.resolveWidgetAttribution).not.toHaveBeenCalled();
    expect(mocks.mintWidgetToken).not.toHaveBeenCalled();
  });

  it("rejects a missing bearer token before DB or AI work", async () => {
    mocks.readWidgetBearerToken.mockReturnValue(null);
    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Hello",
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(mocks.acquireWidgetIngressTraffic).toHaveBeenCalledWith({
      endpoint: "chat",
      networkKey: "network-key",
    });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.processIncomingMessageDetailed).not.toHaveBeenCalled();
  });

  it("rejects a token replay whose complete binding does not verify", async () => {
    mocks.verifyWidgetToken.mockReturnValue(false);
    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Hello",
        sessionId: "session-replayed",
      }),
    );

    expect(response.status).toBe(401);
    expect(mocks.verifyWidgetToken).toHaveBeenCalledWith("test-token", {
      businessId: BUSINESS_ID,
      origin: "http://localhost",
      sessionId: "session-replayed",
      sessionNonce: "abcdefghijklmnopqrstuvwx",
    });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.processIncomingMessageDetailed).not.toHaveBeenCalled();
  });

  it("preserves a shared exact-origin denial without downstream reads", async () => {
    mocks.acquireWidgetTraffic.mockResolvedValue({
      status: "origin_not_allowed",
    });
    const response = await postChat(
      postRequest(
        "chat",
        {
          businessId: BUSINESS_ID,
          message: "Hello",
          sessionId: "session-1",
        },
        { Origin: "https://evil.test" },
      ),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "origin_not_allowed" });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(mocks.acquireWidgetTraffic).toHaveBeenCalledOnce();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.resolveBusinessEntitlements).not.toHaveBeenCalled();
    expect(mocks.processIncomingMessageDetailed).not.toHaveBeenCalled();
    expect(mocks.releaseWidgetTraffic).not.toHaveBeenCalled();
  });

  it("preserves the inactive public-chat response without downstream reads", async () => {
    mocks.acquireWidgetTraffic.mockResolvedValue({
      status: "widget_inactive",
    });
    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Hello",
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: false, response: null });
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost",
    );
    expect(mocks.acquireWidgetTraffic).toHaveBeenCalledOnce();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.resolveBusinessEntitlements).not.toHaveBeenCalled();
    expect(mocks.processIncomingMessageDetailed).not.toHaveBeenCalled();
    expect(mocks.releaseWidgetTraffic).not.toHaveBeenCalled();
  });

  it("returns a generic 429 before downstream reads without quota state or AI", async () => {
    mocks.acquireWidgetTraffic.mockResolvedValue({
      status: "rate_limited",
      retryAfterSeconds: 9,
    });
    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Hello",
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "rate_limited",
      retryable: true,
    });
    expect(response.headers.get("retry-after")).toBe("9");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost",
    );
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.resolveBusinessEntitlements).not.toHaveBeenCalled();
    expect(mocks.resolveBusinessOperationalControls).not.toHaveBeenCalled();
    expect(mocks.processIncomingMessageDetailed).not.toHaveBeenCalled();
    expect(mocks.releaseWidgetTraffic).not.toHaveBeenCalled();
  });

  it("fails closed with a typed 503 when shared traffic state is unavailable", async () => {
    mocks.acquireWidgetTraffic.mockResolvedValue({ status: "unavailable" });
    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Hello",
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "service_unavailable",
      retryable: true,
    });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.resolveBusinessEntitlements).not.toHaveBeenCalled();
    expect(mocks.resolveBusinessOperationalControls).not.toHaveBeenCalled();
    expect(mocks.processIncomingMessageDetailed).not.toHaveBeenCalled();
    expect(mocks.releaseWidgetTraffic).not.toHaveBeenCalled();
  });

  it("rate-limits authenticated preview through the same shared adapter", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.acquireWidgetTraffic.mockResolvedValue({
      status: "concurrency_limited",
      retryAfterSeconds: 2,
    });
    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Hello",
        sessionId: "preview-session",
        preview: true,
      }),
    );

    expect(response.status).toBe(429);
    expect(mocks.requireWorkspaceRouteAccess).toHaveBeenCalledOnce();
    expect(mocks.readWidgetBearerToken).not.toHaveBeenCalled();
    expect(mocks.verifyWidgetToken).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.resolveBusinessEntitlements).not.toHaveBeenCalled();
    expect(mocks.resolveBusinessOperationalControls).not.toHaveBeenCalled();
    expect(mocks.processIncomingMessageDetailed).not.toHaveBeenCalled();
    expect(mocks.releaseWidgetTraffic).not.toHaveBeenCalled();
  });

  it("preserves missing preview configuration semantics from shared traffic", async () => {
    mocks.acquireWidgetTraffic.mockResolvedValue({
      status: "origin_not_allowed",
    });
    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Hello",
        sessionId: "preview-session",
        preview: true,
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "origin_not_allowed" });
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost",
    );
    expect(mocks.requireWorkspaceRouteAccess).toHaveBeenCalledOnce();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.resolveBusinessEntitlements).not.toHaveBeenCalled();
    expect(mocks.processIncomingMessageDetailed).not.toHaveBeenCalled();
    expect(mocks.releaseWidgetTraffic).not.toHaveBeenCalled();
  });

  it("strictly rejects unknown chat fields", async () => {
    const response = await postChat(
      postRequest("chat", {
        businessId: BUSINESS_ID,
        message: "Hello",
        sessionId: "session-1",
        unexpectedAdminOverride: true,
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(mocks.verifyWidgetToken).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.processIncomingMessageDetailed).not.toHaveBeenCalled();
  });

  it("requires the widget token on end-session before conversation reads", async () => {
    mocks.readWidgetBearerToken.mockReturnValue(null);
    const response = await postEnd(
      postRequest("end", {
        businessId: BUSINESS_ID,
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("binds end-session authorization to the token before origin or conversation reads", async () => {
    mocks.verifyWidgetToken.mockReturnValue(false);
    const response = await postEnd(
      postRequest("end", {
        businessId: BUSINESS_ID,
        sessionId: "session-replayed",
      }),
    );

    expect(response.status).toBe(401);
    expect(mocks.verifyWidgetToken).toHaveBeenCalledWith("test-token", {
      businessId: BUSINESS_ID,
      origin: "http://localhost",
      sessionId: "session-replayed",
      sessionNonce: "abcdefghijklmnopqrstuvwx",
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("rejects inactive public end-session before contact writes", async () => {
    queueDatabaseResults({
      data: { id: "widget-1", is_active: false },
      error: null,
    });
    const response = await postEnd(
      postRequest("end", {
        businessId: BUSINESS_ID,
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      available: false,
    });
    expect(mocks.from).toHaveBeenCalledOnce();
    expect(mocks.acquireWidgetTraffic).toHaveBeenCalledOnce();
  });

  it("allows authenticated same-business preview end without a public token", async () => {
    queueDatabaseResults(
      { data: { id: "widget-1", is_active: false }, error: null },
      { data: null, error: null },
    );
    const response = await postEnd(
      withoutEdgeMarker(postRequest("end", {
        businessId: BUSINESS_ID,
        sessionId: "preview-session",
        preview: true,
      })),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      available: true,
    });
    expect(mocks.requireWorkspaceRouteAccess).toHaveBeenCalledOnce();
    expect(mocks.readWidgetBearerToken).not.toHaveBeenCalled();
    expect(mocks.verifyWidgetToken).not.toHaveBeenCalled();
    expect(mocks.acquireWidgetTraffic).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "preview_end" }),
    );
  });

  it("preserves an inactive race from shared end traffic", async () => {
    queueDatabaseResults({ data: { id: "widget-1" }, error: null });
    mocks.acquireWidgetTraffic.mockResolvedValue({
      status: "widget_inactive",
    });

    const response = await postEnd(
      postRequest("end", {
        businessId: BUSINESS_ID,
        sessionId: "session-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      available: false,
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost",
    );
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("fails closed when public config has no configured hostname", async () => {
    queueDatabaseResults({
      data: { id: "widget-1", allowed_hostnames: [], is_active: false },
      error: null,
    });
    const response = await getConfig(configRequest());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "origin_not_allowed" });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(mocks.mintWidgetToken).not.toHaveBeenCalled();
    expect(mocks.acquireWidgetTraffic).not.toHaveBeenCalled();
  });
});

describe("widget attribution responses", () => {
  const widgetConfig = {
    id: "widget-1",
    brand_color: "#123456",
    position: "bottom_right",
    welcome_message: "Welcome",
    proactive_invitation_enabled: true,
    show_logo: false,
    logo_url: null,
    lead_capture_enabled: true,
    lead_capture_timing: "start",
    quick_replies: ["Pricing"],
  };

  it("returns assigned-partner attribution without passing forwarded Host headers", async () => {
    queueDatabaseResults(
      { data: widgetConfig, error: null },
      { data: { name: "Acme" }, error: null },
    );
    mocks.resolveWidgetAttribution.mockResolvedValue({
      poweredByName: "Alpha Dog Agency",
      poweredByUrl: "https://app.alphadogagency.ai",
    });

    const response = await getConfig(
      configRequest({
        Host: "simplassist.com",
        "X-Forwarded-Host": "app.alphadogagency.ai",
        Forwarded: "host=app.alphadogagency.ai",
      }),
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      poweredByName: "Alpha Dog Agency",
      poweredByUrl: "https://app.alphadogagency.ai",
    });
    expect(JSON.stringify(payload)).not.toContain("SimplAssist");
    expect(mocks.resolveWidgetAttribution).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      hostHeader: "simplassist.com",
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost",
    );
  });

  it("returns retryable 503 with CORS when public attribution lookup fails", async () => {
    queueDatabaseResults(
      { data: widgetConfig, error: null },
      { data: { name: "Acme" }, error: null },
    );
    mocks.resolveWidgetAttribution.mockRejectedValue(
      new mocks.BusinessPartnerResolutionError("database unavailable"),
    );

    const response = await getConfig(configRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "service_unavailable",
      retryable: true,
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost",
    );
  });

  it("returns retryable 503 with private cache headers when preview attribution fails", async () => {
    setServerBusinessResult({
      data: { id: BUSINESS_ID, name: "Acme" },
      error: null,
    });
    queueDatabaseResults({ data: widgetConfig, error: null });
    mocks.resolveWidgetAttribution.mockRejectedValue(
      new mocks.BusinessPartnerResolutionError("database unavailable"),
    );

    const response = await getPreviewConfig(
      previewConfigRequest({
        Host: "simplassist.com",
        "X-Forwarded-Host": "app.alphadogagency.ai",
        Forwarded: "host=app.alphadogagency.ai",
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Service temporarily unavailable",
      retryable: true,
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
  });
});

describe("owner-only widget preview", () => {
  function proxiedPreviewRequest(path: "chat" | "end", origin = "https://simplassist.com") {
    return new NextRequest(
      `http://railway.internal:8080/api/widget/${path}?businessId=${BUSINESS_ID}&sessionId=preview-proxy-test`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "simplassist.com",
          "X-Forwarded-Proto": "https",
          Origin: origin,
        },
        body: JSON.stringify({
          businessId: BUSINESS_ID,
          sessionId: "preview-proxy-test",
          preview: true,
          ...(path === "chat" ? {
            message: "What services do you offer?",
            clientMessageId: "00000000-0000-4000-8000-000000000003",
          } : {}),
        }),
      },
    );
  }

  it.each(["chat", "end"] as const)("allows authenticated %s preview behind Railway's proxy", async (path) => {
    queueDatabaseResults({ data: { id: "widget-1", is_active: false }, error: null });
    const response = await (path === "chat" ? postChat : postEnd)(proxiedPreviewRequest(path));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject(path === "chat"
      ? { available: true, response: "How can I help?" }
      : { available: true, success: true });
    expect(mocks.requireWorkspaceRouteAccess).toHaveBeenCalledOnce();
    expect(mocks.acquireWidgetTraffic).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: `preview_${path}`, originHostname: "simplassist.com" }),
    );
    expect(mocks.verifyWidgetToken).not.toHaveBeenCalled();
  });

  it.each(["chat", "end"] as const)("rejects cross-origin %s previews before auth or AI", async (path) => {
    const response = await (path === "chat" ? postChat : postEnd)(
      proxiedPreviewRequest(path, "https://evil.example"),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "origin_not_allowed" });
    expect(mocks.requireWorkspaceRouteAccess).not.toHaveBeenCalled();
    expect(mocks.processIncomingMessageDetailed).not.toHaveBeenCalled();
  });

  it.each(["chat", "end"] as const)("still requires authentication for a proxied %s preview", async (path) => {
    mocks.requireWorkspaceRouteAccess.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });
    const response = await (path === "chat" ? postChat : postEnd)(proxiedPreviewRequest(path));
    expect(response.status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.processIncomingMessageDetailed).not.toHaveBeenCalled();
  });

  it("requires an authenticated owner", async () => {
    mocks.requireWorkspaceRouteAccess.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const response = await getPreviewConfig(previewConfigRequest());

    expect(response.status).toBe(401);
    expect(mocks.serverFrom).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each([
    [403, { error: "workspace_access_denied" }],
    [503, { error: "workspace_access_unavailable", retryable: true }],
  ])(
    "returns workspace %i with private headers before preview reads",
    async (status, body) => {
      mocks.requireWorkspaceRouteAccess.mockResolvedValue({
        ok: false,
        response: NextResponse.json(body, { status }),
      });

      const response = await getPreviewConfig(previewConfigRequest());

      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("vary")).toBe("Cookie");
      expect(mocks.serverFrom).not.toHaveBeenCalled();
      expect(mocks.from).not.toHaveBeenCalled();
      expect(mocks.resolveBusinessEntitlements).not.toHaveBeenCalled();
    },
  );

  it("returns 404 without revealing a widget owned by another user", async () => {
    setServerBusinessResult({ data: null, error: null });

    const response = await getPreviewConfig(previewConfigRequest());

    expect(response.status).toBe(404);
    expect(mocks.resolveBusinessEntitlements).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("enforces the web-chat entitlement", async () => {
    setServerBusinessResult({
      data: { id: BUSINESS_ID, name: "Acme" },
      error: null,
    });
    mocks.canUseFeature.mockReturnValue(false);

    const response = await getPreviewConfig(previewConfigRequest());

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "feature_unavailable",
      feature: "web_chat",
      requiredPlan: "sms_and_chat",
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("returns the saved config even when the widget is inactive", async () => {
    setServerBusinessResult({
      data: { id: BUSINESS_ID, name: "Acme" },
      error: null,
    });
    queueDatabaseResults({
      data: {
        id: "widget-1",
        business_id: BUSINESS_ID,
        is_active: false,
        brand_color: "#123456",
        position: "bottom_left",
        welcome_message: "Preview welcome",
        proactive_invitation_enabled: true,
        show_logo: false,
        logo_url: null,
        lead_capture_enabled: true,
        lead_capture_timing: "after_3_messages",
        quick_replies: ["Pricing"],
      },
      error: null,
    });

    const response = await getPreviewConfig(
      previewConfigRequest({
        Host: "simplassist.com",
        "X-Forwarded-Host": "app.alphadogagency.ai",
        Forwarded: "host=app.alphadogagency.ai",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      available: true,
      businessName: "Acme",
      position: "bottom_left",
      welcomeMessage: "Preview welcome",
      proactiveInvitationEnabled: true,
      poweredByName: "SimplAssist",
      poweredByUrl: "https://simplassist.com",
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.resolveWidgetAttribution).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      hostHeader: "simplassist.com",
    });
    const previewChain = mocks.from.mock.results[0]?.value as {
      eq: ReturnType<typeof vi.fn>;
    };
    expect(previewChain.eq).not.toHaveBeenCalledWith("is_active", true);
    expect(mocks.resolveBusinessOperationalControls).not.toHaveBeenCalled();
  });
});
