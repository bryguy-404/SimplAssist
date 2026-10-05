import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: mocks.from } }));
import { loadPublicBusiness, PUBLIC_BUSINESS_PROJECTION } from "./publicBusiness.server";

const row = {
  id: "business", slug: "example", name: "Example Studio", business_type: "other",
  email: "help@example.test", phone_number: null, city: "South Bend", state: "IN",
  public_address_visibility: "city_state", legal_business_name: "Example Operator LLC",
  shared_registration_id: "private-registration-id", review_sms_signup_enabled: true,
  ai_settings: { language: "en", private_setting: "PRIVATE_AI_SETTING" },
  // A broad mock result must not accidentally turn into a public projection.
  address: "PRIVATE_STREET_SENTINEL", zip: "PRIVATE_ZIP_SENTINEL", ein: "PRIVATE_EIN_SENTINEL",
  authorized_rep_name: "PRIVATE_REP_SENTINEL", owner_id: "PRIVATE_OWNER_SENTINEL",
};

let results: Array<{ data: unknown; error: { message: string } | null }>;
let queries: Array<Record<string, ReturnType<typeof vi.fn>>>;
beforeEach(() => {
  vi.clearAllMocks();
  results = [{ data: row, error: null }];
  queries = [];
  mocks.from.mockImplementation(() => {
    const result = results.shift();
    if (!result) throw new Error("Unexpected public business query");
    const q: Record<string, ReturnType<typeof vi.fn>> = {};
    q.select = vi.fn(() => q);
    q.eq = vi.fn(() => q);
    q.maybeSingle = vi.fn(async () => result);
    queries.push(q);
    return q;
  });
});

describe("anonymous public business boundary", () => {
  it("never fetches street or ZIP for city/state visibility and returns only public fields", async () => {
    const business = await loadPublicBusiness("example");
    expect(queries).toHaveLength(1);
    expect(queries[0].select).toHaveBeenCalledWith(PUBLIC_BUSINESS_PROJECTION);
    expect(PUBLIC_BUSINESS_PROJECTION.split(", ")).not.toContain("address");
    expect(PUBLIC_BUSINESS_PROJECTION.split(", ")).not.toContain("zip");
    expect(business).toMatchObject({ city: "South Bend", state: "IN", address: null, zip: null,
      legal_operator_name: "Example Operator LLC", ai_settings: { language: "en" } });
    expect(JSON.stringify(business)).not.toMatch(/PRIVATE_|private-registration-id|shared_registration_id/);
  });

  it("preserves full-address publication only with a second visibility-guarded query", async () => {
    results = [
      { data: { ...row, public_address_visibility: "full", shared_registration_id: null }, error: null },
      { data: { address: "100 Public Street", zip: "46601" }, error: null },
    ];
    expect(await loadPublicBusiness("example")).toMatchObject({ address: "100 Public Street", zip: "46601", legal_operator_name: null });
    expect(queries[1].select).toHaveBeenCalledWith("address, zip");
    expect(queries[1].eq).toHaveBeenCalledWith("id", "business");
    expect(queries[1].eq).toHaveBeenCalledWith("public_address_visibility", "full");
  });

  it("does not expose a stale address if visibility changed between the two reads", async () => {
    results = [{ data: { ...row, public_address_visibility: "full" }, error: null }, { data: null, error: null }];
    expect(await loadPublicBusiness("example")).toMatchObject({ address: null, zip: null });
  });

  it.each([null, undefined, "unknown"])("fails private for unrecognized visibility %s", async (visibility) => {
    results = [{ data: { ...row, public_address_visibility: visibility }, error: null }];
    expect(await loadPublicBusiness("example")).toMatchObject({ address: null, zip: null });
    expect(queries).toHaveLength(1);
  });

  it("does not query pending slugs", async () => {
    expect(await loadPublicBusiness("pending-12345678")).toBeNull();
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
