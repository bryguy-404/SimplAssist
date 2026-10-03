import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./domain", () => ({ reviewOrigin: () => "https://simplassist.com" }));
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mocks.from },
}));
vi.mock("./service.server", () => ({
  reviewRpc: mocks.rpc,
  ReviewError: class extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  },
}));
import { reviewPermissionStatus } from "./permissionStatus.server";
const contactId = "40000000-0000-4000-a106-000000000001";
const rows: Record<string, unknown>[] = [];
let suppressed: { identity: string }[];
const filters: [string, string, unknown][] = [];
beforeEach(() => {
  vi.clearAllMocks();
  filters.length = 0;
  rows.length = 0;
  suppressed = [];
  mocks.rpc.mockResolvedValue(null);
  mocks.from.mockImplementation((table: string) => {
    const q = {
      select: () => q,
      eq: (key: string, value: unknown) => {
        filters.push([table, key, value]);
        return q;
      },
      in: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: async () => ({
        data: table === "businesses" ? { slug: "example" } : { id: contactId },
        error: null,
      }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data: table === "review_permissions" ? rows : suppressed,
          error: null,
        }).then(resolve),
    };
    return q;
  });
});
describe("owner view of customer permission", () => {
  it("checks fresh ownership before accessing recipient evidence", async () => {
    mocks.rpc.mockRejectedValue(new Error("denied"));
    await expect(
      reviewPermissionStatus("business", "owner", contactId),
    ).rejects.toThrow("denied");
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it("scopes contact and evidence to the same business and handles self-consent actor null", async () => {
    rows.push({
      destination: "+15745550106",
      actor_id: null,
      sms_consent_event_id: "event",
      evidence: "provider message private-technical-id",
      granted_at: "2026-10-03T13:00:00Z",
      revoked_at: null,
    });
    const result = await reviewPermissionStatus("business", "owner", contactId);
    expect(mocks.rpc).toHaveBeenCalledWith("review_assert_owner", {
      p_business: "business",
      p_owner: "owner",
    });
    for (const table of [
      "contacts",
      "review_permissions",
      "review_suppressions",
    ])
      expect(filters).toContainEqual([table, "business_id", "business"]);
    expect(result.permissions[0]).toMatchObject({
      source: "customer_keyword",
      status: "granted",
    });
    expect(JSON.stringify(result)).not.toContain("private-technical-id");
    expect(result.permissions[0]).not.toHaveProperty("actor_id");
  });
  it("shows suppression even if an older evidence row still looks granted", async () => {
    rows.push({
      destination: "+15745550106",
      actor_id: null,
      sms_consent_event_id: "event",
      granted_at: "date",
      revoked_at: null,
    });
    suppressed.push({ identity: "phone:+15745550106" });
    expect(
      (await reviewPermissionStatus("business", "owner", contactId))
        .permissions[0].status,
    ).toBe("suppressed");
  });
  it("keeps a manual permission update attributed to the business", async () => {
    rows.push({
      destination: "customer@example.test",
      actor_id: "owner",
      sms_consent_event_id: null,
      evidence: "Signed service form",
      granted_at: "date",
      revoked_at: null,
    });
    expect(
      (await reviewPermissionStatus("business", "owner", contactId))
        .permissions[0],
    ).toMatchObject({
      channel: "email",
      source: "owner",
      evidence: "Signed service form",
    });
  });
  it("returns an empty list for a customer with no recorded permission", async () => {
    expect(
      await reviewPermissionStatus("business", "owner", contactId),
    ).toEqual({ permissions: [], smsRequiresKeyword: false, consentUrl: null });
  });
  it("marks stale or manually recorded permission as needing the filed keyword opt-in", async () => {
    mocks.rpc.mockImplementation(
      async (name: string) => name === "review_sms_requires_keyword",
    );
    rows.push({
      destination: "+15745550106",
      actor_id: "owner",
      sms_consent_event_id: null,
      evidence: "Owner checked permission",
      granted_at: "date",
      revoked_at: null,
    });
    const result = await reviewPermissionStatus("business", "owner", contactId);
    expect(result.smsRequiresKeyword).toBe(true);
    expect(result.consentUrl).toBe(
      "https://simplassist.com/c/example/review-texts",
    );
    expect(result.permissions[0].status).toBe("keyword_required");
  });
});
