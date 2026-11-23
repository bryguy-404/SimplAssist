import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ redirect: vi.fn(), workspace: vi.fn(), context: vi.fn(), readiness: vi.fn(), feature: vi.fn(), smsPlan: vi.fn(), layout: vi.fn(), readPage: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: m.redirect }));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({ requireWorkspacePageAccess: m.workspace }));
vi.mock("@/lib/dashboard/context", () => ({ getDashboardEntitledContext: m.context }));
vi.mock("@/lib/messaging/lookup", () => ({ getSmsReadinessForBusiness: m.readiness }));
vi.mock("@/lib/billing/entitlements", () => ({ canUseFeature: m.feature }));
vi.mock("@/lib/billing/features", () => ({ planRequiresSmsProvisioning: m.smsPlan }));
vi.mock("@/lib/conversations/inbox.server", () => ({ readInboxPage: m.readPage }));
vi.mock("@/components/conversations/InboxLayout", () => ({ InboxLayout: (props: unknown) => { m.layout(props); return <div>Inbox</div>; } }));
import ConversationsPage from "./page";
const callId = "00000000-0000-4000-8000-000000000001";
const call = { id: callId, channel: "voice", spam_state: "suspected", has_bookings: true, last_message_preview: "View call transcript" };
beforeEach(() => {
  vi.resetAllMocks();
  m.workspace.mockResolvedValue({});
  m.context.mockResolvedValue({ status: "resolved", business: { id: "business" }, user: { id: "owner" }, entitlements: { plan: "sms_and_chat" } });
  m.readiness.mockResolvedValue({ smsReady: true, blockReason: null });
  m.feature.mockReturnValue(true); m.smsPlan.mockReturnValue(true);
  m.readPage.mockImplementation(async (_b, _o, query) => ({ folder: query.focus ? "spam" : query.folder, conversations: [], selected: query.focus ? call : null, counts: { inbox: 120, spam: 200 }, total: 120, next: "next" }));
});
describe("server-paginated inbox page", () => {
  it.each([
    ["spam", "spam"],
    ["inbox", "inbox"],
    ["unknown", "inbox"],
    [["spam", "inbox"], "inbox"],
  ] as const)("opens the requested folder for %j", async (value, expected) => {
    const folder = typeof value === "string" ? value : [...value];
    renderToStaticMarkup(await ConversationsPage({ searchParams: { folder } }));
    expect(m.readPage).toHaveBeenCalledWith("business", "owner", expect.objectContaining({ folder: expected }));
    expect(m.layout).toHaveBeenCalledWith(expect.objectContaining({ initialPage: expect.objectContaining({ folder: expected }) }));
  });
  it("opens an authorized deep link in the correct folder even outside the loaded page", async () => {
    renderToStaticMarkup(await ConversationsPage({ searchParams: { conversation: callId } }));
    expect(m.readPage).toHaveBeenCalledWith("business", "owner", { folder: "inbox", channel: "all", search: "", focus: callId });
    expect(m.layout).toHaveBeenCalledWith(expect.objectContaining({ initialSelectedId: callId, initialPage: expect.objectContaining({ folder: "spam", selected: call }) }));
  });
  it.each([undefined, "", "invalid", [callId]])("ignores invalid/repeated focus %s", async conversation => {
    renderToStaticMarkup(await ConversationsPage({ searchParams: { conversation } }));
    expect(m.readPage).toHaveBeenCalledWith("business", "owner", expect.objectContaining({ focus: undefined }));
    expect(m.layout).toHaveBeenCalledWith(expect.objectContaining({ initialSelectedId: undefined }));
  });
  it("does not read privileged history before workspace authorization", async () => {
    m.workspace.mockRejectedValueOnce(new Error("access denied"));
    await expect(ConversationsPage({})).rejects.toThrow("access denied");
    expect(m.readPage).not.toHaveBeenCalled();
  });
  it("fails visibly instead of presenting partial history when server paging fails", async () => {
    m.readPage.mockRejectedValue(new Error("inbox_unavailable"));
    await expect(ConversationsPage({})).rejects.toThrow("inbox_unavailable");
    expect(m.layout).not.toHaveBeenCalled();
  });
  it("keeps Chat Only working without SMS readiness calls", async () => {
    m.smsPlan.mockReturnValue(false); m.feature.mockImplementation((_e, feature) => feature === "web_chat");
    renderToStaticMarkup(await ConversationsPage({}));
    expect(m.readiness).not.toHaveBeenCalled();
    expect(m.layout).toHaveBeenCalledWith(expect.objectContaining({ smsIncluded: false, smsReady: false, canUseManualSms: false, canUseWebChat: true }));
  });
});
