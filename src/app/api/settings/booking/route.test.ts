import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), load: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({ requireFreshWorkspaceRouteAccess: mocks.access }));
vi.mock("@/lib/booking/settings.server", () => ({
  getBookingSettings: mocks.load, updateBookingSettings: mocks.update,
  BookingSettingsError: class extends Error { constructor(public code: string) { super(code); } },
}));
import { GET, PATCH } from "./route";
import { BookingSettingsError } from "@/lib/booking/settings.server";
const body = { defaults: { format: "phone_callback", label: "Estimate", durationMinutes: 60, businessAddress: null }, services: [], expectedRevision: 2 };
function request(value: unknown = body) { return new NextRequest("https://simplassist.com/api/settings/booking", { method: "PATCH", body: JSON.stringify(value) }); }
beforeEach(() => {
  vi.clearAllMocks(); mocks.access.mockResolvedValue({ ok: true, access: { user: { id: "owner" }, business: { id: "business" } } });
  mocks.load.mockResolvedValue({ visible: false }); mocks.update.mockResolvedValue({ visible: true });
});
describe("owner booking settings routes", () => {
  it.each([401, 403, 503])("honors fresh workspace denial %s before all reads and writes", async (status) => {
    mocks.access.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "access" }, { status }) });
    expect((await GET()).status).toBe(status); expect((await PATCH(request())).status).toBe(status);
    expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
  });
  it("returns only the current workspace's uncached projection", async () => {
    const response = await GET(); expect(mocks.load).toHaveBeenCalledWith("business");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ booking: { visible: false } });
  });
  it("passes current owner identity to the atomic update", async () => {
    expect((await PATCH(request())).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith("business", "owner", body);
  });
  it.each([
    { ...body, businessId: "foreign" }, { ...body, ownerId: "foreign" }, { ...body, includedSeconds: 999999 },
    { ...body, rolloutEnabled: true }, { ...body, expectedRevision: -1 }, { ...body, mode: "unlimited" },
    { mode: "text" },
  ])("rejects forged or malformed fields %#", async (invalid) => {
    expect((await PATCH(request(invalid))).status).toBe(400); expect(mocks.update).not.toHaveBeenCalled();
  });
  it("rejects invalid JSON", async () => {
    expect((await PATCH(new NextRequest("https://simplassist.com/api/settings/booking", { method: "PATCH", body: "{" }))).status).toBe(400);
  });
  it.each([["forbidden", 403], ["conflict", 409], ["unavailable", 503]] as const)("reports %s without automatically replaying the update", async (code, status) => {
    mocks.update.mockRejectedValue(new BookingSettingsError(code)); expect((await PATCH(request())).status).toBe(status);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });
  it("does not expose raw database or provider errors", async () => {
    mocks.load.mockRejectedValue(new Error("private credentials")); const response = await GET();
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("private credentials");
  });
});
