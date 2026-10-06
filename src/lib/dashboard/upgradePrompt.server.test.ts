import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ from: vi.fn(), reviewEnabled: vi.fn(), emailEnabled: vi.fn(), excluded: vi.fn(), reviewUpgradeEnabled: vi.fn(), upgradeState: vi.fn(), smsReadiness: vi.fn(), planAvailable: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("@/lib/billing/reviewSmsRollout.server", () => ({ isReviewSmsEnabled: mocks.reviewEnabled }));
vi.mock("@/lib/reviews/config", () => ({ isEmailReviewsEnabledForBusiness: mocks.emailEnabled }));
vi.mock("@/lib/billing/customerReviewsRollout", () => ({ customerReviewsBusinessExcluded: mocks.excluded }));
vi.mock("@/lib/billing/textingUpgradeRollout.server", () => ({ isReviewTextingUpgradeEnabled: mocks.reviewUpgradeEnabled }));
vi.mock("@/lib/billing/textingUpgrade.server", () => ({ getTextingUpgradeState: mocks.upgradeState }));
vi.mock("@/lib/messaging/lookup", () => ({ getSmsReadinessForBusinessReadOnly: mocks.smsReadiness }));
vi.mock("@/lib/billing/planAvailability", () => ({ isPlanAvailable: mocks.planAvailable }));
import { getDashboardUpgradePrompt } from "./upgradePrompt.server";
const businessId = "10000000-0000-4000-a115-000000000001", ownerId = "owner";
const now = Date.parse("2026-10-10T12:00:00Z");
let rows: Record<string, unknown>;
let failedTable: string | null;
let calls: { table: string; filters: unknown[][] }[];
function setupQueries() {
  mocks.from.mockImplementation((table: string) => {
    const filters: unknown[][] = [];
    calls.push({ table, filters });
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "not", "neq", "in", "limit", "order", "maybeSingle"]) chain[method] = (...args: unknown[]) => { filters.push([method, ...args]); return chain; };
    chain.then = (resolve: (value: unknown) => void) => {
      const completed = filters.some(f => f[0] === "eq" && f[1] === "state" && f[2] === "completed");
      const applied = filters.some(f => f[0] === "eq" && f[1] === "state" && f[2] === "applied");
      return Promise.resolve({ data: rows[completed ? "review_activation" : applied ? "growth_activation" : table], error: table === failedTable ? { message: "unavailable" } : null }).then(resolve);
    };
    return chain;
  });
}
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv("DASHBOARD_UPGRADE_PROMPTS_ENABLED", "1");
  mocks.excluded.mockReturnValue(false); mocks.reviewEnabled.mockReturnValue(true); mocks.emailEnabled.mockReturnValue(true); mocks.reviewUpgradeEnabled.mockReturnValue(true); mocks.planAvailable.mockReturnValue(true);
  mocks.upgradeState.mockResolvedValue({ sourceMode: "review_sms", eligible: true, enabled: true }); mocks.smsReadiness.mockResolvedValue({ smsReady: true });
  failedTable = null; calls = [];
  rows = {
    businesses: { id: businessId, owner_id: ownerId, billing_mode: "stripe", partner_id: null, partner_plan: null, billing_pilot: false, billing_comped: false, billing_exempt: false, deleted_at: null, operations_suspended_at: null, texting_paused_at: null, onboarding_completed_at: "2026-09-01T12:00:00Z", telnyx_submission_disabled: false, active_telnyx_release_run_id: null },
    subscriptions: { plan: "chat_only", status: "active", stripe_subscription_id: "sub", stripe_customer_id: "customer", current_period_start: "2026-10-01T12:00:00Z", current_period_end: "2026-11-01T12:00:00Z", cancel_at_period_end: false, pending_plan: null, created_at: "2026-09-01T12:00:00Z" },
    dashboard_upgrade_preferences: [], review_settings: { google_review_url: "https://g.page/r/test/review", reply_to_verified_at: "2026-09-01T12:00:00Z", paused: false },
    review_sms_accounts: null, chat_texting_upgrades: null,
    sms_billing_operations: [], review_sms_billing_operations: [], review_activation: { completed_at: "2026-09-10T12:00:00Z" }, growth_activation: null,
  };
  setupQueries();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
const get = () => getDashboardUpgradePrompt(businessId, ownerId);
const patch = (table: string, values: object) => { rows[table] = { ...(rows[table] as object), ...values }; };
describe("read-only upgrade discovery", () => {
  it("does no reads when disabled or excluded", async () => {
    vi.stubEnv("DASHBOARD_UPGRADE_PROMPTS_ENABLED", "0"); expect(await get()).toBeNull(); expect(mocks.from).not.toHaveBeenCalled();
    vi.stubEnv("DASHBOARD_UPGRADE_PROMPTS_ENABLED", "1"); mocks.excluded.mockReturnValue(true); expect(await get()).toBeNull(); expect(mocks.from).not.toHaveBeenCalled();
  });
  it("offers texting after review setup without reading email history or starting setup", async () => {
    expect(await get()).toMatchObject({ offerKey: "review_texting" });
    expect(calls.some(call => call.table === "review_email_outbox")).toBe(false);
    expect(calls.every(call => !call.filters.some(f => ["insert", "update", "delete", "upsert"].includes(String(f[0]))))).toBe(true);
    expect(mocks.upgradeState).not.toHaveBeenCalled(); expect(mocks.smsReadiness).not.toHaveBeenCalled();
  });
  it.each([{ google_review_url: null }, { google_review_url: "" }, { reply_to_verified_at: null }])("waits for a saved review link and verified reply-to address", async values => {
    patch("review_settings", values); expect(await get()).toBeNull();
  });
  it.each([{ owner_id: "other" }, { billing_mode: "comped" }, { partner_id: "partner" }, { partner_plan: "full" }, { billing_pilot: true }, { billing_comped: true }, { billing_exempt: true }, { operations_suspended_at: "now" }, { deleted_at: "now" }, { onboarding_completed_at: null }])("suppresses unsafe or managed businesses", async values => {
    patch("businesses", values); expect(await get()).toBeNull(); expect(mocks.from).toHaveBeenCalledTimes(2);
  });
  it.each([{ status: "past_due" }, { cancel_at_period_end: true }, { current_period_end: "2026-10-01T00:00:00Z" }, { stripe_customer_id: null }, { plan: "full" }])("suppresses ineligible subscriptions", async values => {
    patch("subscriptions", values); expect(await get()).toBeNull();
  });
  it("checks authoritative conversion eligibility only for an active paid review add-on", async () => {
    rows.review_sms_accounts = { state: "active", billing_source: "direct" };
    expect(await get()).toMatchObject({ offerKey: "growth" }); expect(mocks.upgradeState).toHaveBeenCalledWith(businessId, ownerId);
    mocks.upgradeState.mockResolvedValue({ sourceMode: "review_sms", eligible: false, enabled: true }); expect(await get()).toBeNull();
  });
  it("does not advertise an upgrade whose rollout is disabled", async () => {
    rows.review_sms_accounts = { state: "active", billing_source: "direct" }; mocks.reviewUpgradeEnabled.mockReturnValue(false);
    expect(await get()).toBeNull(); expect(mocks.upgradeState).not.toHaveBeenCalled();
  });
  it("uses actual paid Growth activation instead of the current billing period", async () => {
    patch("subscriptions", { plan: "sms_and_chat", current_period_start: "2026-10-09T12:00:00Z" });
    rows.growth_activation = { applied_at: "2026-09-01T12:00:00Z" };
    expect(await get()).toMatchObject({ offerKey: "voice" }); expect(mocks.smsReadiness).toHaveBeenCalledWith(businessId);
    rows.chat_texting_upgrades = { state: "activated", activated_at: "2026-09-01T12:00:00Z" };
    rows.growth_activation = { applied_at: "2026-10-09T12:00:00Z" }; expect(await get()).toBeNull();
  });
  it("does not infer Growth activation from the older Chat subscription creation", async () => {
    patch("subscriptions", { plan: "sms_and_chat", created_at: "2026-09-01T12:00:00Z" });
    expect(await get()).toBeNull();
    rows.chat_texting_upgrades = { state: "activated", activated_at: "2026-10-09T12:00:00Z" };
    expect(await get()).toBeNull();
  });
  it("shows setup status ahead of a new offer without starting provider reconciliation", async () => {
    rows.chat_texting_upgrades = { state: "carrier_pending" }; rows.sms_billing_operations = [{ id: "pending" }];
    expect(await get()).toMatchObject({ kind: "progress", offerKey: "growth" }); expect(mocks.upgradeState).not.toHaveBeenCalled();
  });
  it("hides the optional invitation on database failure or malformed state", async () => {
    failedTable = "dashboard_upgrade_preferences"; expect(await get()).toBeNull();
    failedTable = null; mocks.from.mockImplementation(() => { throw new Error("offline"); }); expect(await get()).toBeNull();
  });
});
