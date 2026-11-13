import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
const mocks = vi.hoisted(() => ({ access: vi.fn(), preview: vi.fn(), confirm: vi.fn(), read: vi.fn(), cancel: vi.fn() }));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({ requireWorkspaceRouteAccess: mocks.access }));
vi.mock("@/lib/stripe/smsBilling.server", async () => ({ ...(await import("@/lib/stripe/smsBilling")),
  previewSmsPlanChange: mocks.preview, confirmSmsPlanChange: mocks.confirm, readSmsBillingChange: mocks.read, cancelSmsBillingOperation: mocks.cancel }));
import { GET, POST, PATCH, DELETE } from "./route";
const operationId = "30000000-0000-4000-8000-000000000003";
const request = (method: string, body?: unknown) => new NextRequest("https://simplassist.com/api/billing/plan-change", { method, ...(body ? { body: JSON.stringify(body) } : {}) });
beforeEach(() => { vi.clearAllMocks(); mocks.access.mockResolvedValue({ ok: true, access: { business: { id: "owned-business" }, user: { id: "owner" } } }); mocks.preview.mockResolvedValue({ operationId }); });
describe("owned billing plan changes", () => {
  it.each([GET, POST, PATCH, DELETE])("rejects unauthenticated requests before billing access %#", async (handler) => {
    mocks.access.mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 401 }) });
    expect((await handler(request(handler === GET ? "GET" : "POST", handler === GET ? undefined : { plan: "full" }))).status).toBe(401);
    expect(mocks.preview).not.toHaveBeenCalled(); expect(mocks.confirm).not.toHaveBeenCalled(); expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it.each([{ plan: "full", priceId: "price_evil" }, { plan: "full", businessId: "other" }, { plan: "chat_only" }])("rejects client supplied billing authority %#", async (body) => {
    expect((await POST(request("POST", body))).status).toBe(400); expect(mocks.preview).not.toHaveBeenCalled();
  });
  it("uses authenticated workspace identity for preview", async () => {
    expect((await POST(request("POST", { plan: "full" }))).status).toBe(200);
    expect(mocks.preview).toHaveBeenCalledWith("owned-business", "owner", "full");
  });
  it("confirms only a stored operation, with no mutable price or amount", async () => {
    expect((await PATCH(request("PATCH", { operationId, amountDueCents: 0 }))).status).toBe(400);
    expect((await PATCH(request("PATCH", { operationId }))).status).toBe(200);
    expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith("owned-business", "owner", operationId, undefined);
  });
  it("keeps provider details out of unexpected errors", async () => {
    mocks.preview.mockRejectedValue(new Error("private provider payload"));
    const response = await POST(request("POST", { plan: "full" }));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("private");
  });
});


// Existing billing cases represent subscribers with a saved current agreement.
// The agreement module and rejected-payment boundaries have dedicated tests.
const agreementChecks = vi.hoisted(() => ({ require: vi.fn(), link: vi.fn() }));
vi.mock("@/lib/agreements/service.server", () => ({
  requireServiceAgreement: async (...args: unknown[]) => (await agreementChecks.require(...args)) ?? "12100000-0000-4000-8000-000000000001",
  linkServiceAgreementReference: async (...args: unknown[]) => agreementChecks.link(...args),
  ServiceAgreementError: class extends Error {
    constructor(readonly code: string, readonly status = 503) { super(code); }
  },
}));

vi.mock("server-only", () => ({}));
