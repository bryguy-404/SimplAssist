import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardBusinessContext } from "./context";
import type { BusinessEntitlements } from "@/lib/billing/entitlements";

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: mocks.from } }));
import { getDashboardReviewSetup } from "./reviewSetup.server";

const businessId = "10000000-0000-4000-a115-000000000001";
let context: Extract<DashboardBusinessContext, { status: "resolved" }>;
let entitlements: BusinessEntitlements;
const query = {
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  maybeSingle: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("REVIEWS_EMAIL_ENABLED", "1");
  vi.stubEnv("REVIEWS_EMAIL_PILOT_BUSINESS_IDS", "*");
  vi.stubEnv("CUSTOMER_REVIEWS_EXCLUDED_BUSINESS_IDS", "");
  context = {
    status: "resolved", user: { id: "owner" },
    business: { id: businessId, deleted_at: null, operations_suspended_at: null, partner_id: null },
  } as typeof context;
  entitlements = { businessId, plan: "chat_only", status: "active", source: "subscription", active: true, cancelAtPeriodEnd: false };
  mocks.from.mockReturnValue(query);
  query.maybeSingle.mockResolvedValue({ data: null, error: null });
});
afterEach(() => vi.unstubAllEnvs());
const get = () => getDashboardReviewSetup(context, entitlements);

describe("dashboard review setup invitation", () => {
  it("invites a new account without initializing settings and scopes the read to its owner", async () => {
    expect(await get()).toBe("add_link");
    expect(mocks.from).toHaveBeenCalledExactlyOnceWith("review_settings");
    expect(query.eq.mock.calls).toEqual([["business_id", businessId], ["owner_id", "owner"]]);
  });

  it.each(["chat_only", "sms_only", "sms_and_chat", "full"] as const)("supports included email reviews on %s", async plan => {
    entitlements.plan = plan;
    query.maybeSingle.mockResolvedValue({ data: { google_review_url: null, reply_to_verified_at: "2026-10-05" }, error: null });
    expect(await get()).toBe("add_link");
    query.maybeSingle.mockResolvedValue({ data: { google_review_url: "https://g.page/r/test/review", reply_to_verified_at: "2026-10-05" }, error: null });
    expect(await get()).toBeNull();
  });

  it("keeps unfinished setup visible if a reply email is not verified", async () => {
    query.maybeSingle.mockResolvedValue({ data: { google_review_url: "https://g.page/r/test/review", reply_to_verified_at: null }, error: null });
    expect(await get()).toBe("finish_setup");
  });

  it.each([
    ["REVIEWS_EMAIL_ENABLED", "0"],
    ["REVIEWS_EMAIL_PILOT_BUSINESS_IDS", ""],
    ["CUSTOMER_REVIEWS_EXCLUDED_BUSINESS_IDS", businessId],
  ])("honors rollout setting %s without reading data", async (name, value) => {
    vi.stubEnv(name, value);
    expect(await get()).toBeNull();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each([{ active: false }, { status: "past_due" }, { status: "trialing" }, { cancelAtPeriodEnd: true }, { businessId: "another-business" }])("suppresses unavailable account access: %o", async patch => {
    Object.assign(entitlements, patch);
    expect(await get()).toBeNull();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each([{ deleted_at: "now" }, { operations_suspended_at: "now" }, { partner_id: "partner" }])("suppresses excluded business state: %o", async patch => {
    Object.assign(context.business, patch);
    expect(await get()).toBeNull();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("does not prompt paused reviews or mistake a failed query for missing setup", async () => {
    query.maybeSingle.mockResolvedValue({ data: { paused: true }, error: null });
    expect(await get()).toBeNull();
    query.maybeSingle.mockResolvedValue({ data: null, error: { message: "unavailable" } });
    expect(await get()).toBeNull();
    query.maybeSingle.mockRejectedValue(new Error("offline"));
    expect(await get()).toBeNull();
  });
});
