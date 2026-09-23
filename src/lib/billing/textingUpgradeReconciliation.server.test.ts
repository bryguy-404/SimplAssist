import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TextingUpgradeRecord } from "./textingUpgrade";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(), upgrade: vi.fn(), state: vi.fn(), canContinue: vi.fn(), activate: vi.fn(),
  recoverPayment: vi.fn(), reconcilePayment: vi.fn(), sync: vi.fn(), carrier: vi.fn(),
  launch: vi.fn(), assign: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock("./textingUpgrade.server", async () => {
  const { parseTextingUpgrade } = await import("./textingUpgradeStore.server");
  return { getTextingUpgrade: mocks.upgrade, getTextingUpgradeState: mocks.state, parseTextingUpgrade };
});
vi.mock("./textingUpgradeActivation.server", () => ({
  canContinueTextingUpgradeProvisioning: mocks.canContinue,
  reconcileTextingUpgradeActivation: mocks.activate,
}));
vi.mock("@/lib/stripe/textingUpgrade.server", () => ({
  recoverTextingUpgradePayment: mocks.recoverPayment,
  reconcileTextingUpgradePayment: mocks.reconcilePayment,
}));
vi.mock("@/lib/stripe/subscriptionSync", () => ({ syncStripeSubscription: mocks.sync }));
vi.mock("./textingUpgradeCarrierStatus.server", () => ({ refreshTextingUpgradeCarrierStatus: mocks.carrier }));
vi.mock("./launch", () => ({ attemptPaidLaunch: mocks.launch }));
vi.mock("@/lib/messaging/registration/phoneNumberAssignment", () => ({ ensureCampaignAssignmentForBusiness: mocks.assign }));

import { continueTextingUpgradeRegistration, reconcilePendingTextingUpgrades, refreshTextingUpgrade } from "./textingUpgradeReconciliation.server";

const BUSINESS_ID = "10000000-0000-4000-8000-000000000001";
const OWNER_ID = "20000000-0000-4000-8000-000000000001";
const UPGRADE_ID = "30000000-0000-4000-8000-000000000001";
const NOW = "2026-09-23T12:00:00.000Z";
const subscription = { id: "sub_original", metadata: { business_id: BUSINESS_ID } };
let upgrade: TextingUpgradeRecord;

beforeEach(() => {
  vi.clearAllMocks();
  upgrade = {
    id: UPGRADE_ID, business_id: BUSINESS_ID, owner_id: OWNER_ID,
    source_subscription_id: "sub_original", source_customer_id: "cus_original",
    target_plan: "sms_and_chat", state: "carrier_pending",
    billing_operation_id: "40000000-0000-4000-8000-000000000001",
    business_confirmed_at: NOW, phone_confirmed_at: NOW, starter_acknowledged_at: null,
    paid_at: NOW, activated_at: null, created_at: NOW, updated_at: NOW,
  };
  mocks.rpc.mockImplementation(async () => ({ data: [upgrade], error: null }));
  mocks.upgrade.mockImplementation(async () => upgrade);
  mocks.state.mockImplementation(async (businessId: string) => ({ businessId, quote: null }));
  mocks.canContinue.mockResolvedValue(true);
  mocks.activate.mockResolvedValue(false);
  mocks.recoverPayment.mockResolvedValue(null);
  mocks.reconcilePayment.mockResolvedValue(subscription);
  mocks.sync.mockResolvedValue(null);
  mocks.carrier.mockResolvedValue({ refreshed: true });
  mocks.launch.mockResolvedValue({ status: "submitted" });
  mocks.assign.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function expectNoProviderWork() {
  expect(mocks.launch).not.toHaveBeenCalled();
  expect(mocks.carrier).not.toHaveBeenCalled();
  expect(mocks.assign).not.toHaveBeenCalled();
  expect(mocks.activate).not.toHaveBeenCalled();
}

describe("continueTextingUpgradeRegistration", () => {
  it.each(["missing", "draft", "payment_pending", "unpaid", "activated", "support_required"])(
    "never touches provider resources for %s upgrades", async (state) => {
      if (state === "missing") mocks.upgrade.mockResolvedValue(null);
      else if (state === "unpaid") upgrade.paid_at = null;
      else if (state === "activated") { upgrade.state = "activated"; upgrade.activated_at = NOW; }
      else upgrade.state = state as TextingUpgradeRecord["state"];

      await continueTextingUpgradeRegistration(BUSINESS_ID);

      expectNoProviderWork();
      expect(mocks.canContinue).not.toHaveBeenCalled();
    },
  );

  it("requires the fresh paid subscription and operational gate before resource work", async () => {
    mocks.canContinue.mockResolvedValue(false);

    await continueTextingUpgradeRegistration(BUSINESS_ID);

    expect(mocks.canContinue).toHaveBeenCalledWith(BUSINESS_ID);
    expectNoProviderWork();
  });

  it("fails closed when current payment binding cannot be read", async () => {
    mocks.canContinue.mockRejectedValue(new Error("texting_upgrade_billing_unavailable"));
    await expect(continueTextingUpgradeRegistration(BUSINESS_ID)).rejects.toThrow("billing_unavailable");
    expectNoProviderWork();
  });

  it("moves carrier rejection through the support-state RPC without polling or assignment", async () => {
    mocks.launch.mockResolvedValue({ status: "rejection_support_required" });

    await continueTextingUpgradeRegistration(BUSINESS_ID);

    expect(mocks.activate).toHaveBeenCalledExactlyOnceWith(UPGRADE_ID);
    expect(mocks.carrier).not.toHaveBeenCalled();
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  it("reconciles carrier proof and assignment before requesting atomic activation", async () => {
    await continueTextingUpgradeRegistration(BUSINESS_ID);

    expect(mocks.launch).toHaveBeenCalledExactlyOnceWith(BUSINESS_ID, "texting_upgrade");
    expect(mocks.assign).toHaveBeenCalledExactlyOnceWith(BUSINESS_ID, { reason: "texting_upgrade_reconciliation" });
    expect(mocks.launch.mock.invocationCallOrder[0]).toBeLessThan(mocks.carrier.mock.invocationCallOrder[0]);
    expect(mocks.carrier.mock.invocationCallOrder[0]).toBeLessThan(mocks.assign.mock.invocationCallOrder[0]);
    expect(mocks.assign.mock.invocationCallOrder[0]).toBeLessThan(mocks.activate.mock.invocationCallOrder[0]);
  });

  it("leaves activation retryable when carrier reconciliation fails", async () => {
    mocks.carrier.mockRejectedValue(new Error("carrier unavailable"));
    await expect(continueTextingUpgradeRegistration(BUSINESS_ID)).rejects.toThrow("carrier unavailable");
    expect(mocks.assign).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
  });
});

describe("refreshTextingUpgrade", () => {
  it("synchronizes payment once and explicitly launches once after fresh billing", async () => {
    await refreshTextingUpgrade(BUSINESS_ID, OWNER_ID);

    expect(mocks.recoverPayment).toHaveBeenCalledExactlyOnceWith(BUSINESS_ID, OWNER_ID);
    expect(mocks.sync).toHaveBeenCalledExactlyOnceWith(subscription, { deferTextingUpgradeRegistration: true });
    expect(mocks.sync.mock.invocationCallOrder[0]).toBeLessThan(mocks.launch.mock.invocationCallOrder[0]);
    expect(mocks.launch).toHaveBeenCalledTimes(1);
    expect(mocks.state).toHaveBeenCalledExactlyOnceWith(BUSINESS_ID, OWNER_ID);
  });

  it("applies a freshly observed cancellation before any registration continuation", async () => {
    mocks.sync.mockImplementation(async () => { mocks.canContinue.mockResolvedValue(false); });
    await refreshTextingUpgrade(BUSINESS_ID, OWNER_ID);
    expectNoProviderWork();
    expect(mocks.state).toHaveBeenCalledOnce();
  });

  it("never provisions while an unpaid invoice needs customer action", async () => {
    upgrade.state = "payment_pending"; upgrade.paid_at = null;
    const paymentUrl = "https://invoice.stripe.com/recover";
    mocks.recoverPayment.mockResolvedValue(paymentUrl);
    mocks.state.mockResolvedValue({ quote: { operationId: upgrade.billing_operation_id } });

    expect(await refreshTextingUpgrade(BUSINESS_ID, OWNER_ID)).toEqual({
      quote: { operationId: upgrade.billing_operation_id, paymentUrl },
    });
    expectNoProviderWork();
  });

  it("does not attach an obsolete payment URL when recovery removed the quote", async () => {
    mocks.recoverPayment.mockResolvedValue("https://invoice.stripe.com/old");
    expect(await refreshTextingUpgrade(BUSINESS_ID, OWNER_ID)).toEqual({ businessId: BUSINESS_ID, quote: null });
  });

  it("does no resource work after uncertain payment recovery", async () => {
    mocks.recoverPayment.mockRejectedValue(new Error("texting_upgrade_payment_unresolved"));
    await expect(refreshTextingUpgrade(BUSINESS_ID, OWNER_ID)).rejects.toThrow("payment_unresolved");
    expect(mocks.sync).not.toHaveBeenCalled();
    expectNoProviderWork();
  });

  it("continues already-paid recovery when acquisition is disabled", async () => {
    vi.stubEnv("CHAT_TEXTING_UPGRADES_ENABLED", "0");
    vi.stubEnv("CHAT_TEXTING_UPGRADE_CANARY_BUSINESS_ID", "");
    await refreshTextingUpgrade(BUSINESS_ID, OWNER_ID);
    expect(mocks.launch).toHaveBeenCalledOnce();
    expect(mocks.activate).toHaveBeenCalledOnce();
  });
});

describe("reconcilePendingTextingUpgrades", () => {
  it("claims a bounded lease and reports successful work", async () => {
    expect(await reconcilePendingTextingUpgrades()).toEqual({ attempted: 1, failed: 0, deferred: 0 });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("claim_chat_texting_upgrade_reconciliation", { p_limit: 3, p_lease_seconds: 300 });
  });

  it.each([{ limit: 99, expected: 5 }, { limit: 0, expected: 1 }])("bounds the requested batch size $limit", async ({ limit, expected }) => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    await reconcilePendingTextingUpgrades({ limit });
    expect(mocks.rpc).toHaveBeenCalledWith("claim_chat_texting_upgrade_reconciliation", { p_limit: expected, p_lease_seconds: 300 });
  });

  it("does no duplicate work when an overlapping worker receives no lease", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [upgrade], error: null }).mockResolvedValueOnce({ data: [], error: null });
    const results = await Promise.all([reconcilePendingTextingUpgrades(), reconcilePendingTextingUpgrades()]);
    expect(results).toEqual([{ attempted: 1, failed: 0, deferred: 0 }, { attempted: 0, failed: 0, deferred: 0 }]);
    expect(mocks.recoverPayment).toHaveBeenCalledOnce();
    expect(mocks.launch).toHaveBeenCalledOnce();
  });

  it("contains one failed recovery and continues the next leased business", async () => {
    const next = { ...upgrade, id: "30000000-0000-4000-8000-000000000002", business_id: "10000000-0000-4000-8000-000000000002" };
    mocks.rpc.mockResolvedValue({ data: [upgrade, next], error: null });
    mocks.upgrade.mockImplementation(async (businessId: string) => businessId === next.business_id ? next : upgrade);
    mocks.recoverPayment.mockRejectedValueOnce(new Error("provider unavailable")).mockResolvedValue(null);

    expect(await reconcilePendingTextingUpgrades()).toEqual({ attempted: 2, failed: 1, deferred: 0 });
    expect(mocks.launch).toHaveBeenCalledExactlyOnceWith(next.business_id, "texting_upgrade");
  });

  it("stops waiting at the budget and defers remaining leases without new work", async () => {
    vi.useFakeTimers();
    mocks.rpc.mockResolvedValue({ data: [upgrade, { ...upgrade }, { ...upgrade }], error: null });
    mocks.recoverPayment.mockImplementation(() => new Promise(() => {}));

    const batch = reconcilePendingTextingUpgrades({ budgetMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await batch).toEqual({ attempted: 1, failed: 0, deferred: 3 });
    expect(mocks.recoverPayment).toHaveBeenCalledOnce();
    expectNoProviderWork();
  });

  it("does not start another account after completed work exhausts the budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.rpc.mockResolvedValue({ data: [upgrade, { ...upgrade }], error: null });
    mocks.state.mockImplementation(async () => { vi.setSystemTime(Date.parse(NOW) + 1_001); return { quote: null }; });

    expect(await reconcilePendingTextingUpgrades({ budgetMs: 1_000 })).toEqual({ attempted: 1, failed: 0, deferred: 1 });
    expect(mocks.recoverPayment).toHaveBeenCalledOnce();
  });

  it.each([{ data: null, error: null }, { data: [], error: { message: "unavailable" } }])("fails closed when leasing is unavailable", async (result) => {
    mocks.rpc.mockResolvedValue(result);
    await expect(reconcilePendingTextingUpgrades()).rejects.toThrow("texting_upgrade_reconciliation_unavailable");
    expect(mocks.recoverPayment).not.toHaveBeenCalled();
    expectNoProviderWork();
  });
});
