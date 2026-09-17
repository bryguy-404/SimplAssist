import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn(),
  requireWorkspacePageAccess: vi.fn(),
  getDashboardEntitledContext: vi.fn(),
  getSmsReadinessForBusiness: vi.fn(),
  canUseFeature: vi.fn(),
  planRequiresSmsProvisioning: vi.fn(),
  inboxLayout: vi.fn(),
  from: vi.fn(),
  conversationSelect: vi.fn(),
  conversationEq: vi.fn(),
  conversationOrder: vi.fn(),
  messageSelect: vi.fn(),
  messageEq: vi.fn(),
  messageOrder: vi.fn(),
  messageLimit: vi.fn(),
  messageSingle: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));

vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({
  requireWorkspacePageAccess: mocks.requireWorkspacePageAccess,
}));

vi.mock("@/lib/dashboard/context", () => ({
  getDashboardEntitledContext: mocks.getDashboardEntitledContext,
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

vi.mock("@/components/conversations/InboxLayout", () => ({
  InboxLayout: (props: unknown) => {
    mocks.inboxLayout(props);
    return <div>Inbox layout</div>;
  },
}));

import ConversationsPage from "./page";

const BUSINESS_ID = "business-1";
const CONVERSATION_ID = "conversation-1";
const CONVERSATION = {
  id: CONVERSATION_ID,
  business_id: BUSINESS_ID,
  contact: {
    id: "contact-1",
    name: "Alex",
    phone_number: "+13175550123",
    email: "alex@example.test",
  },
};

beforeEach(() => {
  vi.clearAllMocks();

  const conversationQuery = {
    select: mocks.conversationSelect,
    eq: mocks.conversationEq,
    order: mocks.conversationOrder,
  };
  mocks.conversationSelect.mockReturnValue(conversationQuery);
  mocks.conversationEq.mockReturnValue(conversationQuery);
  mocks.conversationOrder.mockResolvedValue({
    data: [CONVERSATION],
    error: null,
  });

  const messageQuery = {
    select: mocks.messageSelect,
    eq: mocks.messageEq,
    order: mocks.messageOrder,
    limit: mocks.messageLimit,
    single: mocks.messageSingle,
  };
  mocks.messageSelect.mockReturnValue(messageQuery);
  mocks.messageEq.mockReturnValue(messageQuery);
  mocks.messageOrder.mockReturnValue(messageQuery);
  mocks.messageLimit.mockReturnValue(messageQuery);
  mocks.messageSingle.mockResolvedValue({
    data: { content: "Latest message" },
    error: null,
  });

  mocks.from.mockImplementation((table: string) => {
    if (table === "conversations") return conversationQuery;
    if (table === "messages") return messageQuery;
    throw new Error(`Unexpected table: ${table}`);
  });
  mocks.requireWorkspacePageAccess.mockResolvedValue(undefined);
  mocks.getDashboardEntitledContext.mockResolvedValue({
    status: "resolved",
    supabase: { from: mocks.from },
    user: { id: "owner-1" },
    business: { id: BUSINESS_ID },
    entitlements: { plan: "sms_and_chat", active: true },
  });
  mocks.getSmsReadinessForBusiness.mockResolvedValue({
    smsReady: true,
    blockReason: null,
  });
  mocks.canUseFeature.mockImplementation(
    (_entitlements: unknown, feature: string) => feature !== "web_chat",
  );
  mocks.planRequiresSmsProvisioning.mockReturnValue(true);
  mocks.redirect.mockImplementation((path: string) => {
    throw new Error(`redirect:${path}`);
  });
});

describe("ConversationsPage deep links", () => {
  it("uses a voice transcript preview without fetching fragments while preserving both text-channel previews", async () => {
    const voice = { ...CONVERSATION, id: "voice-call", channel: "voice" };
    const sms = { ...CONVERSATION, id: "sms-conversation", channel: "sms" };
    const web = { ...CONVERSATION, id: "web-conversation", channel: "web_chat" };
    mocks.conversationOrder.mockResolvedValue({ data: [voice, sms, web], error: null });
    renderToStaticMarkup(await ConversationsPage({}));
    expect(mocks.messageEq.mock.calls).toEqual([
      ["conversation_id", sms.id], ["conversation_id", web.id],
    ]);
    expect(mocks.messageSingle).toHaveBeenCalledTimes(2);
    expect(mocks.inboxLayout).toHaveBeenCalledWith(expect.objectContaining({ conversations: [
      { ...voice, last_message_preview: "View call transcript" },
      { ...sms, last_message_preview: "Latest message" },
      { ...web, last_message_preview: "Latest message" },
    ] }));
  });
  const parameterCases: Array<
    [
      string,
      { conversation?: string | string[] } | undefined,
      string | undefined,
    ]
  > = [
    [
      "a single nonempty value",
      { conversation: CONVERSATION_ID },
      CONVERSATION_ID,
    ],
    ["a missing value", undefined, undefined],
    ["an empty value", { conversation: "" }, undefined],
    ["a one-item array", { conversation: [CONVERSATION_ID] }, undefined],
    [
      "a repeated value",
      { conversation: [CONVERSATION_ID, "conversation-2"] },
      undefined,
    ],
  ];

  it.each(parameterCases)(
    "passes %s as initialSelectedId",
    async (_label, searchParams, expected) => {
      const markup = renderToStaticMarkup(
        await ConversationsPage({ searchParams }),
      );

      expect(markup).toContain("Inbox layout");
      expect(mocks.inboxLayout).toHaveBeenCalledWith(
        expect.objectContaining({ initialSelectedId: expected }),
      );
    },
  );

  it("keeps the existing owner-business query and Inbox props unchanged", async () => {
    renderToStaticMarkup(
      await ConversationsPage({
        searchParams: { conversation: CONVERSATION_ID },
      }),
    );

    expect(mocks.from.mock.calls.map(([table]) => table)).toEqual([
      "conversations",
      "messages",
    ]);
    expect(mocks.conversationEq.mock.calls).toEqual([
      ["business_id", BUSINESS_ID],
    ]);
    expect(mocks.conversationOrder).toHaveBeenCalledWith("last_message_at", {
      ascending: false,
    });
    expect(mocks.messageEq.mock.calls).toEqual([
      ["conversation_id", CONVERSATION_ID],
    ]);
    expect(mocks.inboxLayout).toHaveBeenCalledWith({
      conversations: [
        {
          ...CONVERSATION,
          last_message_preview: "Latest message",
        },
      ],
      businessId: BUSINESS_ID,
      smsIncluded: true,
      smsReady: true,
      smsBlockReason: null,
      canUseManualSms: true,
      canUseAiSms: true,
      canUseWebChat: false,
      initialSelectedId: CONVERSATION_ID,
    });
  });

  it("keeps Chat Only web conversations available without touching SMS readiness", async () => {
    mocks.getDashboardEntitledContext.mockResolvedValue({
      status: "resolved",
      supabase: { from: mocks.from },
      user: { id: "owner-1" },
      business: { id: BUSINESS_ID },
      entitlements: { plan: "chat_only", active: true },
    });
    mocks.planRequiresSmsProvisioning.mockReturnValue(false);
    mocks.canUseFeature.mockImplementation(
      (_entitlements: unknown, feature: string) => feature === "web_chat",
    );

    renderToStaticMarkup(await ConversationsPage({}));

    expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
    expect(mocks.inboxLayout).toHaveBeenCalledWith(
      expect.objectContaining({
        smsIncluded: false,
        smsReady: false,
        smsBlockReason: null,
        canUseManualSms: false,
        canUseAiSms: false,
        canUseWebChat: true,
      }),
    );
  });
});
