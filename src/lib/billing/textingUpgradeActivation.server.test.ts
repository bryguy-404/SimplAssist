import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: mocks }));

import {
  assertTextingUpgradeProvisioningAllowed,
  canContinueTextingUpgradeProvisioning,
  readPendingPaidTextingUpgrade,
  reconcileTextingUpgradeActivation,
  reconcileTextingUpgradeActivationForBusiness,
} from "./textingUpgradeActivation.server";

const businessId = "business-a";
const upgrade = {
  id: "upgrade-a", business_id: businessId,
  source_subscription_id: "sub_a", source_customer_id: "cus_a",
  target_plan: "sms_only", state: "carrier_pending", billing_operation_id: "operation-a",
  paid_at: "2026-09-23T10:00:00Z", activated_at: null,
};
const subscription = {
  stripe_subscription_id: "sub_a", stripe_customer_id: "cus_a",
  plan: "sms_only", status: "active", cancel_at_period_end: false,
  setup_fee_paid_at: "2026-09-23T10:00:00Z",
  current_period_start: new Date(Date.now() - 86_400_000).toISOString(),
  current_period_end: new Date(Date.now() + 86_400_000).toISOString(),
};
const account = {
  id: businessId, deleted_at: null, operations_suspended_at: null,
  telnyx_submission_disabled: false, active_telnyx_release_run_id: null,
  telnyx_unique_claims_released_at: null, telnyx_resource_state: "provisioning",
};
let rows: Record<string, { data: unknown; error: unknown }>;

beforeEach(() => {
  vi.clearAllMocks();
  rows = {
    chat_texting_upgrades: { data: { ...upgrade }, error: null },
    subscriptions: { data: { ...subscription }, error: null },
    businesses: { data: { ...account }, error: null },
  };
  mocks.from.mockImplementation((table) => {
    const query = {
      select: vi.fn(), eq: vi.fn(), in: vi.fn(),
      maybeSingle: vi.fn(async () => rows[table]),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.in.mockReturnValue(query);
    return query;
  });
  mocks.rpc.mockResolvedValue({ data: true, error: null });
});

describe("texting upgrade provider authority", () => {
  it("permits the exact paid upgrade and preserves established SMS when no upgrade exists", async () => {
    expect(await canContinueTextingUpgradeProvisioning(businessId)).toBe(true);
    rows.chat_texting_upgrades.data = null;
    expect(await canContinueTextingUpgradeProvisioning(businessId)).toBe(true);
  });

  it.each([
    { cancel_at_period_end: true }, { status: "canceled" }, { status: "past_due" },
    { status: "trialing" }, { stripe_subscription_id: "sub_other" },
    { stripe_customer_id: "cus_other" }, { plan: "chat_only" }, { setup_fee_paid_at: null },
    { current_period_end: "2020-01-01T00:00:00Z" }, { current_period_start: "invalid" },
  ])("blocks provider work for changed billing %j", async (change) => {
    rows.subscriptions.data = { ...subscription, ...change };
    expect(await canContinueTextingUpgradeProvisioning(businessId)).toBe(false);
    await expect(assertTextingUpgradeProvisioningAllowed(businessId)).rejects.toMatchObject({
      name: "TextingUpgradeProvisioningStoppedError",
    });
  });

  it.each([
    { deleted_at: "2026-09-23" }, { operations_suspended_at: "2026-09-23" },
    { telnyx_submission_disabled: true }, { active_telnyx_release_run_id: "run-a" },
    { telnyx_unique_claims_released_at: "2026-09-23" }, { telnyx_resource_state: "parked" },
  ])("blocks pending-upgrade provider work for operational changes %j", async (change) => {
    rows.businesses.data = { ...account, ...change };
    expect(await canContinueTextingUpgradeProvisioning(businessId)).toBe(false);
  });

  it("keeps carrier rejection/support holds blocked even with active billing", async () => {
    rows.chat_texting_upgrades.data = { ...upgrade, state: "support_required" };
    expect(await canContinueTextingUpgradeProvisioning(businessId)).toBe(false);
    expect(mocks.from).not.toHaveBeenCalledWith("subscriptions");
  });

  it.each([
    { paid_at: null }, { paid_at: "invalid" }, { billing_operation_id: null },
    { business_id: "other" }, { target_plan: "chat_only" }, { activated_at: "2026-09-24" },
  ])("rejects incomplete or contradictory service-owned proof %j", async (change) => {
    rows.chat_texting_upgrades.data = { ...upgrade, ...change };
    await expect(readPendingPaidTextingUpgrade(businessId)).rejects.toThrow("texting_upgrade_state_invalid");
  });

  it("surfaces read failures instead of treating an unknown upgrade as legacy SMS", async () => {
    rows.chat_texting_upgrades = { data: null, error: { message: "db unavailable" } };
    await expect(canContinueTextingUpgradeProvisioning(businessId)).rejects.toThrow("texting_upgrade_state_unavailable");
  });
});

describe("texting upgrade readiness activation", () => {
  it("uses the exact durable upgrade identity and tolerates an already-activated RPC result", async () => {
    expect(await reconcileTextingUpgradeActivationForBusiness(businessId)).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith("activate_chat_texting_upgrade", { p_upgrade_id: upgrade.id });
    expect(await reconcileTextingUpgradeActivation(upgrade.id)).toBe(true);
  });

  it("does not infer activation from campaign approval or an absent upgrade", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    expect(await reconcileTextingUpgradeActivationForBusiness(businessId)).toBe(false);
    rows.chat_texting_upgrades.data = null;
    mocks.rpc.mockClear();
    expect(await reconcileTextingUpgradeActivationForBusiness(businessId)).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("keeps database activation failures retryable", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "unavailable" } });
    await expect(reconcileTextingUpgradeActivation(upgrade.id)).rejects.toThrow("texting_upgrade_activation_unavailable");
    mocks.rpc.mockResolvedValue({ data: "true", error: null });
    await expect(reconcileTextingUpgradeActivation(upgrade.id)).rejects.toThrow("texting_upgrade_activation_invalid");
  });
});
