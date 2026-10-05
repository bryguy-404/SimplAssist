import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class TestEntitlementResolutionError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  }

  return {
    createClient: vi.fn(),
    getUser: vi.fn(),
    from: vi.fn(),
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
    resolveBusinessEntitlements: vi.fn(),
    requestCacheStores: [] as Map<string, unknown>[],
    TestEntitlementResolutionError,
  };
});

vi.mock("server-only", () => ({}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: <Args extends unknown[], Result>(
    fn: (...args: Args) => Result
  ) => {
    const store = new Map<string, unknown>();
    mocks.requestCacheStores.push(store);
    return (...args: Args): Result => {
      const key = JSON.stringify(args);
      if (!store.has(key)) store.set(key, fn(...args));
      return store.get(key) as Result;
    };
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));
vi.mock("@/lib/billing/entitlements", () => ({
  EntitlementResolutionError: mocks.TestEntitlementResolutionError,
  resolveBusinessEntitlements: mocks.resolveBusinessEntitlements,
}));

import {
  getDashboardBusinessContext,
  getDashboardEntitledContext,
} from "./context";

const USER = { id: "user-1", email: "owner@example.com" };
const BUSINESS = {
  id: "business-1",
  name: "Example Business",
  primary_goal: "book",
  goal_url: "https://example.com/retained",
  telnyx_brand_id: null,
  brand_status: null,
  campaign_status: null,
  onboarding_registration_status: "not_started",
  deleted_at: null,
  operations_suspended_at: null,
  ai_replies_paused_at: null,
  texting_paused_at: null,
  bookings_paused_at: null,
};
const ENTITLEMENTS = {
  businessId: BUSINESS.id,
  plan: "sms_and_chat",
  status: "active",
  source: "subscription",
  active: true,
  cancelAtPeriodEnd: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestCacheStores.forEach((store) => store.clear());

  const businessQuery = {
    select: mocks.select,
    eq: mocks.eq,
    maybeSingle: mocks.maybeSingle,
  };
  mocks.select.mockReturnValue(businessQuery);
  mocks.eq.mockReturnValue(businessQuery);
  mocks.from.mockReturnValue(businessQuery);
  mocks.getUser.mockResolvedValue({ data: { user: USER } });
  mocks.maybeSingle.mockResolvedValue({ data: BUSINESS, error: null });
  mocks.resolveBusinessEntitlements.mockResolvedValue(ENTITLEMENTS);
  mocks.createClient.mockResolvedValue({
    auth: { getUser: mocks.getUser },
    from: mocks.from,
  });
});

describe("dashboard request context", () => {
  it("stops before the business and entitlement reads when unauthenticated", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });

    await expect(getDashboardEntitledContext()).resolves.toMatchObject({
      status: "unauthenticated",
      user: null,
    });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.resolveBusinessEntitlements).not.toHaveBeenCalled();
  });

  it("keeps a failed business lookup distinct from a missing business", async () => {
    const error = { message: "database unavailable" };
    mocks.maybeSingle.mockResolvedValue({ data: null, error });

    await expect(getDashboardBusinessContext()).resolves.toMatchObject({
      status: "business_lookup_failed",
      error,
    });
    expect(mocks.resolveBusinessEntitlements).not.toHaveBeenCalled();
  });

  it("returns business_not_found without resolving entitlements", async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });

    await expect(getDashboardEntitledContext()).resolves.toMatchObject({
      status: "business_not_found",
      user: USER,
    });
    expect(mocks.resolveBusinessEntitlements).not.toHaveBeenCalled();
  });

  it("resolves the owner business and its entitlements through the shared layers", async () => {
    const first = getDashboardEntitledContext();
    const second = getDashboardEntitledContext();

    await expect(first).resolves.toMatchObject({
      status: "resolved",
      user: USER,
      business: BUSINESS,
      entitlements: ENTITLEMENTS,
    });
    await expect(second).resolves.toBe(await first);
    expect(mocks.createClient).toHaveBeenCalledOnce();
    expect(mocks.getUser).toHaveBeenCalledOnce();
    expect(mocks.from).toHaveBeenCalledOnce();
    expect(mocks.maybeSingle).toHaveBeenCalledOnce();
    expect(mocks.eq).toHaveBeenCalledWith("owner_id", USER.id);
    const projection = mocks.select.mock.calls[0]?.[0] as string;
    expect(projection).toContain("primary_goal");
    expect(projection).toContain("goal_url");
    expect(projection.replace(", goal_url", "")).toBe(
      [
        "id",
        "name",
        "primary_goal",
        "website_url",
        "deleted_at",
        "call_forwarding_enabled",
        "forward_to_number",
        "call_forwarding_nudge_resolved_at",
        "operations_suspended_at",
        "ai_replies_paused_at",
        "texting_paused_at",
        "bookings_paused_at",
        "telnyx_brand_id",
        "brand_status",
        "brand_status_updated_at",
        "brand_rejection_reason",
        "campaign_status",
        "campaign_status_updated_at",
        "campaign_rejection_reason",
        "onboarding_registration_status",
        "slug",
        "phone_number",
        "email",
        "address",
        "city",
        "state",
        "zip",
        "public_address_visibility",
        "shared_registration_id",
        "legal_business_name",
        "opt_in_description",
  "review_sms_signup_enabled",
        "privacy_terms_mode",
        "privacy_url_override",
        "terms_url_override",
        "timezone",
        "partner_id",
        "billing_mode",
      ].join(", ")
    );
    expect(projection).toContain("website_url");
    expect(projection).toContain("operations_suspended_at");
    expect(projection).toContain("ai_replies_paused_at");
    expect(projection).toContain("texting_paused_at");
    expect(projection).toContain("bookings_paused_at");
    expect(projection).not.toContain("last_4_ssn");
    expect(projection).not.toContain("billing_admin_notes");
    expect(mocks.resolveBusinessEntitlements).toHaveBeenCalledOnce();
    expect(mocks.resolveBusinessEntitlements).toHaveBeenCalledWith(BUSINESS.id);
  });

  it("turns only a missing direct subscription into the onboarding page state", async () => {
    mocks.resolveBusinessEntitlements.mockRejectedValue(
      new mocks.TestEntitlementResolutionError("subscription_missing"),
    );

    await expect(getDashboardEntitledContext()).resolves.toMatchObject({
      status: "subscription_missing",
      user: USER,
      business: BUSINESS,
    });
  });

  it("keeps entitlement lookup outages as errors instead of treating them as onboarding", async () => {
    const failure = new mocks.TestEntitlementResolutionError(
      "subscription_lookup_failed",
    );
    mocks.resolveBusinessEntitlements.mockRejectedValue(failure);

    await expect(getDashboardEntitledContext()).rejects.toBe(failure);
  });
});
