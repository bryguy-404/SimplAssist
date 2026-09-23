import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), state: vi.fn(), context: vi.fn(), select: vi.fn(), save: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({ requireFreshWorkspaceRouteAccess: mocks.access }));
vi.mock("@/lib/billing/textingUpgrade.server", () => ({ getTextingUpgradeState: mocks.state, loadTextingUpgradeContext: mocks.context, selectTextingUpgrade: mocks.select }));
vi.mock("@/lib/billing/textingUpgradeForms.server", () => ({ saveTextingUpgradeForm: mocks.save }));
import { GET, POST } from "./route";
import { TextingUpgradeError } from "@/lib/billing/textingUpgrade";
const state = { currentStep: "plan", upgrade: null };
const post = (body: unknown) => POST(new NextRequest("http://localhost/api/billing/texting-upgrade", { method: "POST", body: JSON.stringify(body) }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue({ ok: true, access: { user: { id: "owner" }, business: { id: "business" } } });
  mocks.state.mockResolvedValue(state); mocks.context.mockResolvedValue({ eligible: true, upgrade: { id: "upgrade" } });
  mocks.select.mockResolvedValue({ id: "upgrade" }); mocks.save.mockResolvedValue(undefined);
});
describe("texting-upgrade account API", () => {
  it("loads read-only state with no caching or mutations", async () => {
    const response = await GET();
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ state }); expect(mocks.state).toHaveBeenCalledWith("business", "owner");
    expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each([GET, () => post({ action: "select", plan: "full" })])("uses fresh workspace denial before all reads or writes", async (request) => {
    mocks.access.mockResolvedValue({ ok: false, response: Response.json({ error: "workspace_access_denied" }, { status: 403 }) });
    expect((await request()).status).toBe(403); expect(mocks.state).not.toHaveBeenCalled(); expect(mocks.select).not.toHaveBeenCalled();
  });
  it.each(["sms_only", "sms_and_chat", "full"])("saves %s preference without starting a payment", async (plan) => {
    const response = await post({ action: "select", plan, starterAcknowledged: plan === "sms_only" });
    expect(response.status).toBe(200); expect(mocks.select).toHaveBeenCalledWith("business", "owner", plan, plan === "sms_only");
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each([{ action: "select", plan: "chat_only" }, { action: "select", plan: "full", businessId: "victim" }, { action: "save", step: "billing", values: {} }, { action: "save", step: "phone", values: {}, operationId: "another" }])("rejects unsupported actions and injected identity fields", async (body) => {
    expect((await post(body)).status).toBe(400); expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("takes ownership from fresh workspace and operation context", async () => {
    const values = { has_ein: false };
    expect((await post({ action: "save", step: "verification", values })).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith({ upgrade: { id: "upgrade" }, businessId: "business", ownerId: "owner", step: "verification", values });
  });
  it.each([{ eligible: false, upgrade: { id: "upgrade" } }, { eligible: true, upgrade: null }])("never saves an ineligible or absent upgrade", async (context) => {
    mocks.context.mockResolvedValue(context); expect((await post({ action: "save", step: "business", values: {} })).status).toBe(409); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("returns stable save errors without database detail", async () => {
    mocks.save.mockRejectedValue(new TextingUpgradeError("ein_already_connected", 409));
    const response = await post({ action: "save", step: "verification", values: {} });
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "ein_already_connected" });
  });
});
