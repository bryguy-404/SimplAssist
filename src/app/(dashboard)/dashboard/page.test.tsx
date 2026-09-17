import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrimaryGoal } from "@/types/database";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn(),
  requireWorkspacePageAccess: vi.fn(async () => undefined),
  getDashboardBusinessContext: vi.fn(),
  getDashboardPageEntitlements: vi.fn(),
  getSmsReadinessForBusiness: vi.fn(),
  canUseFeature: vi.fn(),
  planRequiresSmsProvisioning: vi.fn(),
  isPlanAvailable: vi.fn(),
  getFirstNameFromAuthMetadata: vi.fn(),
  shouldShowCallForwardingNudge: vi.fn(),
  dashboardOverview: vi.fn((props: unknown) => {
    void props;
    return null;
  }),
  featureStatusBanners: vi.fn((props: unknown) => {
    void props;
    return null;
  }),
  from: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({
  requireWorkspacePageAccess: mocks.requireWorkspacePageAccess,
}));
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));
vi.mock("@/lib/dashboard/context", () => ({
  getDashboardBusinessContext: mocks.getDashboardBusinessContext,
  getDashboardPageEntitlements: mocks.getDashboardPageEntitlements,
}));
vi.mock("@/lib/messaging/lookup", () => ({
  getSmsReadinessForBusiness: mocks.getSmsReadinessForBusiness,
}));
vi.mock("@/lib/billing/entitlements", () => ({
  canUseFeature: mocks.canUseFeature,
}));
vi.mock("@/lib/billing/features", () => ({
  planRequiresSmsProvisioning: mocks.planRequiresSmsProvisioning,
}));
vi.mock("@/lib/billing/planAvailability", () => ({
  isPlanAvailable: mocks.isPlanAvailable,
}));
vi.mock("@/lib/utils", () => ({
  getFirstNameFromAuthMetadata: mocks.getFirstNameFromAuthMetadata,
}));
vi.mock("@/components/dashboard/callForwardingNudgeEligibility", () => ({
  shouldShowCallForwardingNudge: mocks.shouldShowCallForwardingNudge,
}));
vi.mock("@/components/dashboard/DashboardOverview", () => ({
  default: mocks.dashboardOverview,
}));
vi.mock("@/components/entitlements/FeatureStatusBanners", () => ({
  FeatureStatusBanners: mocks.featureStatusBanners,
}));

import DashboardPage from "./page";

const BUSINESS_ID = "business-1";
const ENTITLEMENTS = {
  businessId: BUSINESS_ID,
  plan: "sms_and_chat",
  status: "active",
  source: "subscription",
  active: true,
  cancelAtPeriodEnd: false,
} as const;

interface FeatureStatusBannerProps {
  businessId: string;
  plan: string;
  status: string;
  pausedFeatures: string[];
}

interface DashboardOverviewProps {
  stats: { messagesThisWeek: number };
  recentConversations: Array<{ id: string; lastMessage?: string }>;
  billingMode: "stripe" | "invoiced" | "comped";
  isPartnerManagedBilling: boolean;
  hotLeads: Array<Record<string, unknown>>;
  smsEnabled: boolean;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.redirect.mockImplementation((path: string) => {
    throw new Error(`redirect:${path}`);
  });
  mocks.isPlanAvailable.mockReturnValue(true);
  mocks.planRequiresSmsProvisioning.mockReturnValue(true);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function queryThenable(result: Promise<unknown>) {
  const query: Record<string, unknown> = {};
  for (const method of [
    "select",
    "eq",
    "in",
    "gte",
    "order",
    "limit",
    "single",
    "maybeSingle",
  ]) {
    query[method] = vi.fn(() => query);
  }
  query.then = result.then.bind(result);
  query.catch = result.catch.bind(result);
  return query;
}

function statusAwareContactsQuery(rows: Array<Record<string, unknown>>) {
  const filters: Array<[string, unknown]> = [];
  let order: [string, { ascending: boolean }] | null = null;
  let limit: number | null = null;
  const query: Record<string, unknown> = {};

  query.select = vi.fn(() => query);
  query.eq = vi.fn((column: string, value: unknown) => {
    filters.push([column, value]);
    return query;
  });
  query.gte = vi.fn(() => query);
  query.order = vi.fn(
    (column: string, options: { ascending: boolean }) => {
      order = [column, options];
      return query;
    },
  );
  query.limit = vi.fn((value: number) => {
    limit = value;
    return query;
  });

  const resolveResult = () => {
    let data = rows.filter((row) =>
      filters.every(([column, value]) => row[column] === value),
    );
    if (order) {
      const [column, options] = order;
      data = [...data].sort((left, right) => {
        const comparison = String(left[column]).localeCompare(
          String(right[column]),
        );
        return options.ascending ? comparison : -comparison;
      });
    }
    if (limit !== null) data = data.slice(0, limit);
    return Promise.resolve({ data });
  };

  query.then = (
    onFulfilled: (value: { data: Array<Record<string, unknown>> }) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => resolveResult().then(onFulfilled, onRejected);
  query.catch = (onRejected: (reason: unknown) => unknown) =>
    resolveResult().catch(onRejected);

  return query;
}

function outgoingMessageCountQuery(rows: Array<Record<string, unknown>>) {
  const filters: Array<(row: Record<string, unknown>) => boolean> = [];
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn((column: string, value: unknown) => {
      filters.push((row) => row[column] === value);
      return query;
    }),
    in: vi.fn((column: string, values: unknown[]) => {
      filters.push((row) => values.includes(row[column]));
      return query;
    }),
    gte: vi.fn((column: string, value: string) => {
      filters.push((row) => String(row[column]) >= value);
      return query;
    }),
    then: (resolve: (result: { count: number }) => unknown) =>
      Promise.resolve({ count: rows.filter((row) => filters.every((filter) => filter(row))).length }).then(resolve),
  };
  return query;
}

function configureResolvedDashboardWithSavedGuardrails({
  partnerId = null,
  billingMode = "stripe",
  primaryGoal = null,
  calendarConnected = false,
  bookingEnabled = false,
  canUseCalendar = true,
  hotLeadRows = [],
  messageRows = [],
  recentConversationRows = [],
}: {
  partnerId?: string | null;
  billingMode?: "stripe" | "invoiced" | "comped";
  primaryGoal?: PrimaryGoal | null;
  calendarConnected?: boolean;
  bookingEnabled?: boolean;
  canUseCalendar?: boolean;
  hotLeadRows?: Array<Record<string, unknown>>;
  messageRows?: Array<Record<string, unknown>>;
  recentConversationRows?: Array<Record<string, unknown>>;
} = {}) {
  const tableCalls = new Map<string, number>();
  const queries: Array<{
    table: string;
    call: number;
    query: Record<string, unknown>;
  }> = [];

  mocks.from.mockImplementation((table: string) => {
    const call = (tableCalls.get(table) ?? 0) + 1;
    tableCalls.set(table, call);

    let result: Promise<unknown>;
    if (table === "conversations" && call <= 2) {
      result = Promise.resolve({ count: 0 });
    } else if (table === "conversations") {
      result = Promise.resolve({ data: recentConversationRows });
    } else if (table === "contacts" && call === 1) {
      result = Promise.resolve({ count: 0 });
    } else if (table === "contacts") {
      result = Promise.resolve({ data: [] });
    } else if (table === "messages") {
      result = Promise.resolve(call === 1 ? { count: 0 } : { data: [{ content: "Latest text preview" }] });
    } else if (table === "ai_settings") {
      result = Promise.resolve({
        data: {
          booking_enabled: bookingEnabled,
          booking_mode: "collect_info",
          guardrails: ["Never promise a fixed price"],
        },
      });
    } else if (table === "google_calendar_tokens") {
      result = Promise.resolve({
        data: calendarConnected ? { id: "calendar-token-1" } : null,
      });
    } else {
      result = Promise.resolve({ data: null });
    }

    const query =
      table === "contacts" && call === 2
        ? statusAwareContactsQuery(hotLeadRows)
        : table === "messages" && call === 1
          ? outgoingMessageCountQuery(messageRows)
          : queryThenable(result);
    queries.push({ table, call, query });
    return query;
  });

  mocks.getDashboardBusinessContext.mockResolvedValue({
    status: "resolved",
    supabase: { from: mocks.from },
    user: { id: "user-1", user_metadata: {} },
    business: {
      id: BUSINESS_ID,
      call_forwarding_enabled: false,
      call_forwarding_nudge_resolved_at: null,
      partner_id: partnerId,
      billing_mode: billingMode,
      primary_goal: primaryGoal,
    },
  });
  mocks.getDashboardPageEntitlements.mockResolvedValue({
    status: "resolved",
    entitlements: ENTITLEMENTS,
  });
  mocks.getSmsReadinessForBusiness.mockResolvedValue({
    smsReady: true,
    blockReason: null,
    assignmentStatus: "assigned",
    assignmentFailureReason: null,
    phoneNumber: "+13175550123",
  });
  mocks.canUseFeature.mockImplementation(
    (_entitlements: unknown, feature: string) => {
      if (feature === "calendar") return canUseCalendar;
      return feature !== "advanced_guardrails";
    },
  );
  mocks.getFirstNameFromAuthMetadata.mockReturnValue("Owner");
  mocks.shouldShowCallForwardingNudge.mockReturnValue(false);

  return queries;
}

async function renderedFeatureStatusBannerProps() {
  renderToStaticMarkup(await DashboardPage());
  return mocks.featureStatusBanners.mock.calls.at(-1)?.[0] as
    | FeatureStatusBannerProps
    | undefined;
}

async function renderedDashboardOverviewProps() {
  renderToStaticMarkup(await DashboardPage());
  return mocks.dashboardOverview.mock.calls.at(-1)?.[0] as
    | DashboardOverviewProps
    | undefined;
}

describe("DashboardPage query scheduling", () => {
  it("redirects a direct pre-checkout business before child page reads", async () => {
    configureResolvedDashboardWithSavedGuardrails({ primaryGoal: "book" });
    mocks.getDashboardPageEntitlements.mockResolvedValue({
      status: "subscription_missing",
    });

    await expect(DashboardPage()).rejects.toThrow("redirect:/onboarding");
    expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("resolves plan authority before starting SMS page data and readiness", async () => {
    const entitlements = deferred<{
      status: "resolved";
      entitlements: typeof ENTITLEMENTS;
    }>();
    const preview = deferred<{ data: { content: string }[] }>();
    const tableCalls = new Map<string, number>();

    mocks.from.mockImplementation((table: string) => {
      const call = (tableCalls.get(table) ?? 0) + 1;
      tableCalls.set(table, call);

      let result: Promise<unknown>;
      if (table === "conversations" && call === 1) {
        result = Promise.resolve({ count: 4 });
      } else if (table === "conversations" && call === 2) {
        result = Promise.resolve({ count: 2 });
      } else if (table === "conversations") {
        result = Promise.resolve({
          data: [{ id: "conversation-1", contact: null }],
        });
      } else if (table === "contacts" && call === 1) {
        result = Promise.resolve({ count: 3 });
      } else if (table === "contacts") {
        result = Promise.resolve({ data: [] });
      } else if (table === "messages" && call === 1) {
        result = Promise.resolve({ count: 8 });
      } else if (table === "messages") {
        result = preview.promise;
      } else if (table === "phone_numbers") {
        result = Promise.resolve({
          data: { phone_number: "+13175550123", is_active: true },
        });
      } else {
        result = Promise.resolve({ data: null });
      }

      return queryThenable(result);
    });

    mocks.getDashboardBusinessContext.mockResolvedValue({
      status: "resolved",
      supabase: { from: mocks.from },
      user: { id: "user-1", user_metadata: {} },
      business: {
        id: BUSINESS_ID,
        call_forwarding_enabled: false,
        call_forwarding_nudge_resolved_at: null,
        partner_id: null,
        billing_mode: "stripe",
        primary_goal: null,
      },
    });
    mocks.getDashboardPageEntitlements.mockReturnValue(entitlements.promise);
    mocks.getSmsReadinessForBusiness.mockResolvedValue({
      smsReady: true,
      blockReason: null,
      assignmentStatus: "assigned",
      assignmentFailureReason: null,
      phoneNumber: "+13175550123",
    });
    mocks.canUseFeature.mockReturnValue(true);
    mocks.getFirstNameFromAuthMetadata.mockReturnValue("Owner");
    mocks.shouldShowCallForwardingNudge.mockReturnValue(false);

    const page = DashboardPage();

    await vi.waitFor(() => {
      expect(mocks.getDashboardPageEntitlements).toHaveBeenCalledWith(BUSINESS_ID);
    });
    expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();

    entitlements.resolve({ status: "resolved", entitlements: ENTITLEMENTS });
    await vi.waitFor(() => {
      expect(mocks.getSmsReadinessForBusiness).toHaveBeenCalledWith(BUSINESS_ID);
      expect(mocks.from).toHaveBeenCalledTimes(11);
    });

    preview.resolve({ data: [{ content: "Latest message" }] });
    await expect(page).resolves.toBeDefined();
  });
});

describe("DashboardPage outgoing-message count", () => {
  it("counts only this business's outgoing SMS and website-chat messages in the last seven days", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-18T12:00:00.000Z"));
    try {
      const base = { business_id: BUSINESS_ID, created_at: "2026-09-17T12:00:00.000Z" };
      const included = ["sms", "web_chat"].flatMap((channel) =>
        ["assistant", "human_agent"].map((role) => ({ ...base, role, channel })));
      const excluded = [
        ...["sms", "web_chat"].flatMap((channel) => ["customer", "system"].map((role) => ({ ...base, role, channel }))),
        ...Array.from({ length: 1200 }, (_, i) => ({ ...base, role: i % 2 ? "assistant" : "customer", channel: "voice" })),
        { ...base, role: "human_agent", channel: "voice" },
        { ...base, role: "assistant", channel: "sms", business_id: "other-business" },
        { ...base, role: "assistant", channel: "web_chat", created_at: "2026-09-11T11:59:59.999Z" },
      ];
      const queries = configureResolvedDashboardWithSavedGuardrails({ messageRows: [...included, ...excluded] });
      const overview = await renderedDashboardOverviewProps();
      const query = queries.find(({ table }) => table === "messages")!.query as Record<string, ReturnType<typeof vi.fn>>;
      expect(query.select).toHaveBeenCalledExactlyOnceWith("*", { count: "exact", head: true });
      expect(query.eq).toHaveBeenCalledExactlyOnceWith("business_id", BUSINESS_ID);
      expect(query.in.mock.calls).toEqual([["role", ["assistant", "human_agent"]], ["channel", ["sms", "web_chat"]]]);
      expect(query.gte).toHaveBeenCalledExactlyOnceWith("created_at", "2026-09-11T12:00:00.000Z");
      expect(overview?.stats.messagesThisWeek).toBe(4);
    } finally { vi.useRealTimers(); }
  });
});

describe("DashboardPage recent conversation previews", () => {
  it("uses a truthful voice preview without fetching fragments and preserves SMS and website-chat previews", async () => {
    const queries = configureResolvedDashboardWithSavedGuardrails({ recentConversationRows: [
      { id: "voice-call", channel: "voice" },
      { id: "sms-conversation", channel: "sms" },
      { id: "web-conversation", channel: "web_chat" },
    ] });
    const overview = await renderedDashboardOverviewProps();
    expect(overview?.recentConversations).toEqual([
      { id: "voice-call", channel: "voice", lastMessage: "View call transcript" },
      { id: "sms-conversation", channel: "sms", lastMessage: "Latest text preview" },
      { id: "web-conversation", channel: "web_chat", lastMessage: "Latest text preview" },
    ]);
    const previewQueries = queries.filter(({ table, call }) => table === "messages" && call > 1);
    expect(previewQueries).toHaveLength(2);
    expect(previewQueries.map(({ query }) => (query.eq as ReturnType<typeof vi.fn>).mock.calls)).toEqual([
      [["conversation_id", "sms-conversation"]], [["conversation_id", "web-conversation"]],
    ]);
  });
});

describe("DashboardPage Chat Only projection", () => {
  it("does not read phone or side-effectful SMS readiness and marks the overview no-SMS", async () => {
    configureResolvedDashboardWithSavedGuardrails({ primaryGoal: "book" });
    mocks.getDashboardPageEntitlements.mockResolvedValue({
      status: "resolved",
      entitlements: {
        ...ENTITLEMENTS,
        plan: "chat_only",
      },
    });
    mocks.planRequiresSmsProvisioning.mockReturnValue(false);

    const overviewProps = await renderedDashboardOverviewProps();

    expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
    expect(mocks.from.mock.calls.map(([table]) => table)).not.toContain(
      "phone_numbers",
    );
    expect(overviewProps).toMatchObject({
      phoneNumber: null,
      showCallForwardingNudge: false,
      smsEnabled: false,
    });
  });
});

describe("DashboardPage hot-lead classification", () => {
  it("queries the authoritative hot status and ignores legacy numeric-score divergence", async () => {
    const statusHotScoreZero = {
      id: "contact-hot",
      business_id: BUSINESS_ID,
      name: "Status Hot",
      phone_number: "+13175550101",
      email: null,
      session_id: null,
      source_channel: "sms",
      lead_score: 0,
      lead_status: "hot",
      lead_status_updated_at: "2026-08-11T15:00:00.000Z",
      notes: null,
      created_at: "2026-08-10T15:00:00.000Z",
      last_contacted_at: "2026-08-11T15:00:00.000Z",
    };
    const statusNormalScoreNine = {
      ...statusHotScoreZero,
      id: "contact-normal",
      name: "Legacy Score Nine",
      lead_score: 9,
      lead_status: "normal",
      lead_status_updated_at: "2026-08-11T16:00:00.000Z",
    };
    const queries = configureResolvedDashboardWithSavedGuardrails({
      hotLeadRows: [statusNormalScoreNine, statusHotScoreZero],
    });

    const overviewProps = await renderedDashboardOverviewProps();
    const hotLeadQuery = queries.find(
      ({ table, call }) => table === "contacts" && call === 2,
    )?.query as Record<string, ReturnType<typeof vi.fn>>;

    expect(hotLeadQuery.select).toHaveBeenCalledOnce();
    expect(hotLeadQuery.select).toHaveBeenCalledWith("*");
    expect(hotLeadQuery.eq.mock.calls).toEqual([
      ["business_id", BUSINESS_ID],
      ["lead_status", "hot"],
    ]);
    expect(hotLeadQuery.gte).not.toHaveBeenCalled();
    expect(hotLeadQuery.order.mock.calls).toEqual([
      ["lead_status_updated_at", { ascending: false }],
    ]);
    expect(hotLeadQuery.limit.mock.calls).toEqual([[10]]);
    expect(overviewProps?.hotLeads).toEqual([statusHotScoreZero]);
    expect(overviewProps?.hotLeads).not.toContainEqual(statusNormalScoreNine);
  });
});

describe("DashboardPage partner-managed billing presentation", () => {
  it.each([
    [null, "stripe", false],
    [null, "comped", false],
    ["partner-1", "stripe", true],
    ["partner-1", "invoiced", true],
  ] as const)(
    "maps partner_id %s with %s billing to visibility %s",
    async (partnerId, billingMode, expected) => {
      configureResolvedDashboardWithSavedGuardrails({
        partnerId,
        billingMode,
      });

      const overviewProps = await renderedDashboardOverviewProps();

      expect(overviewProps).toMatchObject({
        billingMode,
        isPartnerManagedBilling: expected,
      });
    }
  );
});

describe("DashboardPage goal-aware Calendar presentation", () => {
  it.each([
    [null, true],
    ["book", true],
    ["quote", true],
    ["callback", true],
    ["signup", false],
  ] as const)(
    "renders the existing Calendar invitation for primary_goal=%s: %s",
    async (primaryGoal, shouldRenderInvitation) => {
      configureResolvedDashboardWithSavedGuardrails({ primaryGoal });

      const html = renderToStaticMarkup(await DashboardPage());
      const invitationCopy = [
        "Google Calendar not connected",
        "Connect your Google Calendar to let your AI check availability and book appointments for customers automatically.",
        "Connect Now",
      ];

      for (const copy of invitationCopy) {
        if (shouldRenderInvitation) expect(html).toContain(copy);
        else expect(html).not.toContain(copy);
      }
      expect(mocks.canUseFeature).toHaveBeenCalledWith(
        ENTITLEMENTS,
        "calendar",
      );
      expect(mocks.from).toHaveBeenCalledWith("google_calendar_tokens");
      expect(mocks.from).toHaveBeenCalledTimes(10);
    },
  );

  it.each([
    [null, true],
    ["book", true],
    ["quote", true],
    ["callback", true],
    ["signup", false],
  ] as const)(
    "keeps Calendar paused-feature wording for primary_goal=%s: %s",
    async (primaryGoal, shouldIncludeCalendarWording) => {
      configureResolvedDashboardWithSavedGuardrails({
        primaryGoal,
        calendarConnected: true,
        bookingEnabled: true,
        canUseCalendar: false,
      });

      const bannerProps = await renderedFeatureStatusBannerProps();

      expect(bannerProps?.pausedFeatures).toEqual(
        shouldIncludeCalendarWording
          ? ["Google Calendar and AI booking", "Advanced AI guardrails"]
          : ["Advanced AI guardrails"],
      );
      expect(mocks.canUseFeature).toHaveBeenCalledWith(
        ENTITLEMENTS,
        "calendar",
      );
      expect(mocks.from).toHaveBeenCalledWith("google_calendar_tokens");
      expect(mocks.from).toHaveBeenCalledTimes(10);
    },
  );
});

describe("DashboardPage paused Full Suite features", () => {
  it("suppresses saved Advanced AI guardrails while Full Suite is unavailable", async () => {
    configureResolvedDashboardWithSavedGuardrails();
    mocks.isPlanAvailable.mockReturnValue(false);

    const bannerProps = await renderedFeatureStatusBannerProps();

    expect(mocks.isPlanAvailable).toHaveBeenCalledWith("full");
    expect(bannerProps).toMatchObject({
      businessId: BUSINESS_ID,
      plan: "sms_and_chat",
      status: "active",
      pausedFeatures: [],
    });
  });

  it("restores the saved Advanced AI guardrails entry when Full Suite is available", async () => {
    configureResolvedDashboardWithSavedGuardrails();
    mocks.isPlanAvailable.mockReturnValue(true);

    const bannerProps = await renderedFeatureStatusBannerProps();

    expect(mocks.isPlanAvailable).toHaveBeenCalledWith("full");
    expect(bannerProps).toMatchObject({
      businessId: BUSINESS_ID,
      plan: "sms_and_chat",
      status: "active",
      pausedFeatures: ["Advanced AI guardrails"],
    });
  });
});
