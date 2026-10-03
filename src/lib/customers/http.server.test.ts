import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  fresh: vi.fn(),
  enabled: vi.fn(),
  ensure: vi.fn(),
  save: vi.fn(),
  list: vi.fn(),
}));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({
  requireWorkspaceRouteAccess: mocks.access,
  requireFreshWorkspaceRouteAccess: mocks.fresh,
}));
vi.mock("@/lib/billing/customerReviewsRollout.server", () => ({
  customerWorkspaceEnabled: mocks.enabled,
}));
vi.mock("./service.server", () => ({
  CustomerError: class CustomerError extends Error {
    constructor(
      public code: string,
      public status = 400,
    ) {
      super(code);
    }
  },
  ensureCustomerScope: mocks.ensure,
  saveCustomer: mocks.save,
  listCustomers: mocks.list,
}));
import { customerJson, customerRoute } from "./http.server";
import { GET, POST } from "@/app/api/customers/route";
const BUSINESS = "10000000-0000-4000-a095-000000000001";
const OWNER = "00000000-0000-4000-a095-000000000001";
beforeEach(() => {
  vi.clearAllMocks();
  const value = {
    ok: true,
    access: { business: { id: BUSINESS }, user: { id: OWNER } },
  };
  mocks.access.mockResolvedValue(value);
  mocks.fresh.mockResolvedValue(value);
  mocks.enabled.mockReturnValue(true);
  mocks.ensure.mockResolvedValue(undefined);
  mocks.save.mockResolvedValue({ id: "customer" });
  mocks.list.mockResolvedValue({ customers: [] });
});
describe("customer API access boundaries", () => {
  it("uses fresh workspace authority on writes and never accepts a business from the body", async () => {
    const response = await POST(
      new Request("https://example.test/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"name":"Pat"}',
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.fresh).toHaveBeenCalledOnce();
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.save).toHaveBeenCalledWith(
      { businessId: BUSINESS, ownerId: OWNER },
      null,
      { name: "Pat" },
    );
  });
  it("fails closed on workspace lookup failure before touching customer data", async () => {
    mocks.access.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });
    expect(
      (await GET(new Request("https://example.test/api/customers"))).status,
    ).toBe(403);
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("gates all handlers before DB or side effects", async () => {
    mocks.enabled.mockReturnValue(false);
    const run = vi.fn();
    expect((await customerRoute(true, run)).status).toBe(404);
    expect(run).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
  });
  it("enforces pagination bounds and returns private responses", async () => {
    expect(
      (
        await GET(
          new Request("https://example.test/api/customers?pageSize=5000"),
        )
      ).status,
    ).toBe(400);
    const response = await GET(
      new Request("https://example.test/api/customers?view=priority&page=2"),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.list).toHaveBeenCalledWith(
      { businessId: BUSINESS, ownerId: OWNER },
      { view: "priority" },
      2,
      25,
    );
  });
});
describe("bounded request parser", () => {
  it("rejects bodies without JSON content type, invalid JSON and streaming overflow", async () => {
    await expect(
      customerJson(
        new Request("https://example.test", { method: "POST", body: "{}" }),
      ),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      customerJson(
        new Request("https://example.test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "broken",
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      customerJson(
        new Request("https://example.test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"long":"abcdefghij"}',
        }),
        5,
      ),
    ).rejects.toMatchObject({ status: 413 });
  });
});
