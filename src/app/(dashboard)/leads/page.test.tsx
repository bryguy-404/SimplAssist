import { renderToStaticMarkup } from "react-dom/server";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn(),
  requireWorkspacePageAccess: vi.fn(),
  getDashboardBusinessContext: vi.fn(),
  from: vi.fn(),
  consoleError: vi.fn(),
  loadVoiceLeadReviews: vi.fn(),
}));

vi.mock("@/lib/voice/leadReview.server", () => ({ loadVoiceLeadReviews: mocks.loadVoiceLeadReviews }));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({
  requireWorkspacePageAccess: mocks.requireWorkspacePageAccess,
}));
vi.mock("@/lib/dashboard/context", () => ({
  getDashboardBusinessContext: mocks.getDashboardBusinessContext,
}));

import LeadsPage from "./page";

const LEAD_EVENT_LIST_LIMIT = 200;

const BUSINESS = {
  id: "business-1",
  primary_goal: "signup",
  timezone: "America/Indiana/Indianapolis",
};

interface QueryResult {
  data?: unknown;
  count?: number | null;
  error: unknown;
}

interface QueryRecorder {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  gte: ReturnType<typeof vi.fn>;
  lt: ReturnType<typeof vi.fn>;
  then: Promise<QueryResult>["then"];
  catch: Promise<QueryResult>["catch"];
}

function query(result: Promise<QueryResult>): QueryRecorder {
  const recorder = {} as QueryRecorder;
  recorder.select = vi.fn(() => recorder);
  recorder.eq = vi.fn(() => recorder);
  recorder.order = vi.fn(() => recorder);
  recorder.limit = vi.fn(() => recorder);
  recorder.gte = vi.fn(() => recorder);
  recorder.lt = vi.fn(() => recorder);
  recorder.then = result.then.bind(result);
  recorder.catch = result.catch.bind(result);
  return recorder;
}

function event({
  id,
  occurredAt = "2026-08-10T17:30:00.000Z",
  conversationId = `conversation-${id}`,
  contact = {
    name: `Contact ${id}`,
    phone_number: null,
    email: null,
  },
}: {
  id: string;
  occurredAt?: string;
  conversationId?: string | null;
  contact?: {
    name: string | null;
    phone_number: string | null;
    email: string | null;
  } | null;
}) {
  return {
    id,
    occurred_at: occurredAt,
    event_type: "link_sent",
    conversation_id: conversationId,
    contact_id: null as string | null,
    origin_kind: "conversation" as string,
    voice_action_id: null as string | null,
    source_conversation_id: null as string | null,
    contact,
  };
}

function configureQueries(options: {
  events?: ReturnType<typeof event>[];
  listError?: unknown;
  count?: number | null;
  countError?: unknown;
} = {}) {
  const {
    events = [],
    listError = null,
    countError = null,
  } = options;
  const count = Object.prototype.hasOwnProperty.call(options, "count")
    ? options.count
    : 0;
  const list = query(
    Promise.resolve({ data: events, error: listError })
  );
  const monthlyCount = query(
    Promise.resolve({ count, error: countError })
  );
  mocks.from.mockReturnValueOnce(list).mockReturnValueOnce(monthlyCount);
  return { list, monthlyCount };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-10T12:00:00.000Z"));
  mocks.requireWorkspacePageAccess.mockResolvedValue(undefined);
  mocks.loadVoiceLeadReviews.mockResolvedValue(new Map());
  mocks.redirect.mockImplementation((path: string) => {
    throw new Error(`redirect:${path}`);
  });
  mocks.getDashboardBusinessContext.mockResolvedValue({
    status: "resolved",
    supabase: { from: mocks.from },
    user: { id: "user-1" },
    business: BUSINESS,
  });
  vi.spyOn(console, "error").mockImplementation(mocks.consoleError);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("LeadsPage", () => {
  it("checks workspace access and redirects unauthenticated owners before ledger reads", async () => {
    mocks.getDashboardBusinessContext.mockResolvedValue({
      status: "unauthenticated",
      supabase: { from: mocks.from },
      user: null,
    });

    await expect(LeadsPage({})).rejects.toThrow("redirect:/login");

    expect(mocks.requireWorkspacePageAccess).toHaveBeenCalledOnce();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("redirects unresolved business state before ledger reads", async () => {
    mocks.getDashboardBusinessContext.mockResolvedValue({
      status: "business_not_found",
      supabase: { from: mocks.from },
      user: { id: "user-1" },
    });

    await expect(LeadsPage({})).rejects.toThrow("redirect:/onboarding");
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each([null, "book", "quote", "callback"])(
    "redirects primary_goal=%s before ledger reads",
    async (primaryGoal) => {
      mocks.getDashboardBusinessContext.mockResolvedValue({
        status: "resolved",
        supabase: { from: mocks.from },
        user: { id: "user-1" },
        business: { ...BUSINESS, primary_goal: primaryGoal },
      });

      await expect(LeadsPage({})).rejects.toThrow("redirect:/dashboard");
      expect(mocks.from).not.toHaveBeenCalled();
    }
  );

  it("uses only the owner client for a capped newest-first list and an exact business-month count", async () => {
    const { list, monthlyCount } = configureQueries();

    await LeadsPage({});

    expect(mocks.from).toHaveBeenCalledTimes(2);
    expect(mocks.from).toHaveBeenNthCalledWith(1, "goal_events");
    expect(mocks.from).toHaveBeenNthCalledWith(2, "goal_events");
    expect(
      String(list.select.mock.calls[0]?.[0]).replace(/\s+/g, " ").trim()
    ).toBe(
      "id, occurred_at, event_type, conversation_id, contact_id, origin_kind, voice_action_id, source_conversation_id, contact:contacts!goal_events_contact_id_fkey ( name, phone_number, email )"
    );
    expect(list.eq.mock.calls).toEqual([
      ["business_id", BUSINESS.id],
      ["goal_at_event", "signup"],
      ["event_type", "link_sent"],
    ]);
    expect(list.order.mock.calls).toEqual([
      ["occurred_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
    expect(list.limit).toHaveBeenCalledOnce();
    expect(list.limit).toHaveBeenCalledWith(LEAD_EVENT_LIST_LIMIT);

    expect(monthlyCount.select).toHaveBeenCalledWith("id", {
      count: "exact",
      head: true,
    });
    expect(monthlyCount.eq.mock.calls).toEqual([
      ["business_id", BUSINESS.id],
      ["goal_at_event", "signup"],
      ["event_type", "link_sent"],
    ]);
    expect(monthlyCount.gte).toHaveBeenCalledWith(
      "occurred_at",
      "2026-08-01T04:00:00.000Z"
    );
    expect(monthlyCount.lt).toHaveBeenCalledWith(
      "occurred_at",
      "2026-09-01T04:00:00.000Z"
    );
    expect(monthlyCount.order).not.toHaveBeenCalled();
    expect(monthlyCount.limit).not.toHaveBeenCalled();
  });

  it("distinguishes voice-origin delivery and confirmed call identity while linking the call, SMS and stored contact", async () => {
    const row = { ...event({ id: "voice-lead", conversationId: "text-conversation" }), origin_kind: "voice_action", voice_action_id: "signup-action", source_conversation_id: "voice-conversation", contact_id: "contact-id", contact: { name: "Stored identity", email: "stored@example.test", phone_number: "+15555550101" } };
    configureQueries({ events: [row as ReturnType<typeof event>], count: 1 });
    mocks.loadVoiceLeadReviews.mockResolvedValue(new Map([[row.id, {
      confirmedContact: { name: "Confirmed identity", email: "confirmed@example.test", phone: "+15555550101", conflicts: ["name", "email"] },
      sourceConversationId: "voice-conversation",
      status: { label: "Signup text delivered", detail: "This does not confirm a completed signup.", tone: "success" },
    }]]));
    const html = renderToStaticMarkup(await LeadsPage({}));
    expect(html).toContain("Voice call → SMS");
    expect(html).toContain("Confirmed identity"); expect(html).toContain("Stored identity");
    expect(html).toContain("Signup text delivered"); expect(html).toContain("does not confirm a completed signup");
    expect(html).toContain('href="/conversations?conversation=voice-conversation"');
    expect(html).toContain('href="/conversations?conversation=text-conversation"');
    expect(html).toContain('href="/contacts?contact=contact-id"');
    expect(html).toContain('id="lead-voice-lead"');
  });

  it("keeps historical leads visible when call metadata is unavailable without claiming delivery", async () => {
    const row = { ...event({ id: "voice-lead" }), origin_kind: "voice_action", voice_action_id: "signup-action", source_conversation_id: "voice-conversation" };
    configureQueries({ events: [row as ReturnType<typeof event>], count: 1 });
    mocks.loadVoiceLeadReviews.mockRejectedValue(new Error("lookup unavailable"));
    const html = renderToStaticMarkup(await LeadsPage({}));
    expect(html).toContain("Call details temporarily unavailable");
    expect(html).toContain("Signup link sent");
    expect(html).not.toContain("Signup text delivered");
  });

  it("renders the contact fallbacks, local date/time, event copy, and conversation linkage", async () => {
    configureQueries({
      count: 4,
      events: [
        event({
          id: "name",
          contact: {
            name: "  Ada Lovelace  ",
            phone_number: "+13175550101",
            email: "ada@example.test",
          },
        }),
        event({
          id: "phone",
          contact: {
            name: "  ",
            phone_number: "3175550102",
            email: "phone@example.test",
          },
        }),
        event({
          id: "email",
          contact: {
            name: null,
            phone_number: null,
            email: "  email@example.test  ",
          },
        }),
        event({ id: "deleted", conversationId: null, contact: null }),
      ],
    });

    const markup = renderToStaticMarkup(await LeadsPage({}));

    expect(markup).toContain("Leads");
    expect(markup).toContain("Signup links sent");
    expect(markup).toContain(">4</p>");
    expect(markup).toContain("This month");
    expect(markup).toContain("Aug 10, 2026");
    expect(markup).toContain("1:30 PM");
    expect(markup).toContain("Ada Lovelace");
    expect(markup).toContain("(317) 555-0102");
    expect(markup).toContain("email@example.test");
    expect(markup).toContain("Contact unavailable");
    expect(markup.match(/Signup link sent/g)).toHaveLength(4);
    expect(markup).toContain(
      'href="/conversations?conversation=conversation-name"'
    );
    expect(markup).toContain("Conversation unavailable");
    expect(markup).not.toMatch(/\bsignups\b/i);
  });

  it("shows a true-zero empty state without a table", async () => {
    configureQueries({ events: [], count: 0 });

    const markup = renderToStaticMarkup(await LeadsPage({}));

    expect(markup).toContain(">0</p>");
    expect(markup).toContain("No signup links sent yet.");
    expect(markup).not.toContain("<table");
    expect(markup).not.toContain("Leads could not be loaded.");
  });

  it("keeps the exact monthly counter honest when the visible list reaches its cap", async () => {
    configureQueries({
      count: 237,
      events: Array.from({ length: LEAD_EVENT_LIST_LIMIT }, (_, index) =>
        event({ id: `event-${index}` })
      ),
    });

    const markup = renderToStaticMarkup(await LeadsPage({}));

    expect(markup).toContain(">237</p>");
    expect(markup.match(/<tbody[^>]*>[\s\S]*<\/tbody>/)?.[0].match(/<tr/g)).toHaveLength(
      LEAD_EVENT_LIST_LIMIT
    );
  });

  it.each([null, undefined])(
    "uses an em dash rather than claiming zero when exact count is %s",
    async (count) => {
      configureQueries({ count: count as null });

      const markup = renderToStaticMarkup(await LeadsPage({}));

      expect(markup).toContain(">—</p>");
      expect(markup).not.toContain(">0</p>");
    }
  );

  it("separates list failure from the empty state and count failure from zero", async () => {
    const listError = { message: "list unavailable" };
    const countError = { message: "count unavailable" };
    configureQueries({ listError, count: null, countError });

    const markup = renderToStaticMarkup(await LeadsPage({}));

    expect(markup).toContain("Leads could not be loaded.");
    expect(markup).not.toContain("No signup links sent yet.");
    expect(markup).toContain(">—</p>");
    expect(markup).not.toContain(">0</p>");
    expect(mocks.consoleError).toHaveBeenCalledWith(
      `[leads:page] Could not load goal events for business=${BUSINESS.id}:`,
      listError
    );
    expect(mocks.consoleError).toHaveBeenCalledWith(
      `[leads:page] Could not count current-month goal events for business=${BUSINESS.id}:`,
      countError
    );
  });

  it("falls back to UTC month boundaries and display for an invalid legacy timezone", async () => {
    mocks.getDashboardBusinessContext.mockResolvedValue({
      status: "resolved",
      supabase: { from: mocks.from },
      user: { id: "user-1" },
      business: { ...BUSINESS, timezone: "Legacy/Invalid" },
    });
    const { monthlyCount } = configureQueries({
      events: [
        event({
          id: "utc",
          occurredAt: "2026-08-10T17:30:00.000Z",
        }),
      ],
      count: 1,
    });

    const markup = renderToStaticMarkup(await LeadsPage({}));

    expect(monthlyCount.gte).toHaveBeenCalledWith(
      "occurred_at",
      "2026-08-01T00:00:00.000Z"
    );
    expect(monthlyCount.lt).toHaveBeenCalledWith(
      "occurred_at",
      "2026-09-01T00:00:00.000Z"
    );
    expect(markup).toContain("Aug 10, 2026");
    expect(markup).toContain("5:30 PM");
  });
});
