import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), retrieve: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock("./client", () => ({ stripe: { subscriptions: { retrieve: mocks.retrieve } } }));
import { prepareVoiceSubscription } from "./voiceSubscription.server";
const subscription = { id: "sub_voice", customer: "cus_voice", metadata: { business_id: "business" }, livemode: false, status: "active" } as unknown as Stripe.Subscription;
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fixture"); mocks.rpc.mockResolvedValue({ data: null, error: null }); });
afterEach(() => vi.unstubAllEnvs());
describe("authoritative voice billing snapshots", () => {
  it("leaves unrelated and private-pilot subscriptions on the existing path", async () => {
    expect(await prepareVoiceSubscription(subscription, "business")).toEqual({ subscription, revision: null, observedAt: null });
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });
  it("versions before retrieval and uses fresh state instead of a stale event", async () => {
    mocks.rpc.mockResolvedValue({ data: 7, error: null });
    const fresh = { ...subscription, status: "past_due" };
    mocks.retrieve.mockImplementation(async () => {
      expect(mocks.rpc).toHaveBeenCalledWith("begin_voice_billing_reconciliation", { p_business_id: "business", p_subscription_id: "sub_voice", p_customer_id: "cus_voice" });
      return fresh;
    });
    const result = await prepareVoiceSubscription(subscription, "business");
    expect(result).toMatchObject({ subscription: fresh, revision: 7 });
    expect(Date.parse(result.observedAt!)).toBeGreaterThan(0);
  });
  it.each([
    { id: "sub_foreign" }, { customer: "cus_foreign" }, { metadata: { business_id: "other" } }, { livemode: true },
  ])("rejects cross-account or wrong-mode retrieved state %#", async (overrides) => {
    mocks.rpc.mockResolvedValue({ data: 1, error: null });
    mocks.retrieve.mockResolvedValue({ ...subscription, ...overrides });
    await expect(prepareVoiceSubscription(subscription, "business")).rejects.toThrow(/voice_billing_(source|mode)_mismatch/);
  });
  it("ignores an old or unrelated canonical source without retrieving it", async () => {
    mocks.rpc.mockResolvedValue({ data: -1, error: null });
    expect(await prepareVoiceSubscription(subscription, "business")).toMatchObject({ ignored: true, revision: null });
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });
  it.each([0, -2, true, "2", Number.MAX_SAFE_INTEGER + 1])("rejects malformed version %s", async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(prepareVoiceSubscription(subscription, "business")).rejects.toThrow("voice_billing_revision_invalid");
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });
  it("keeps provider lookup failures retryable without trusting the event", async () => {
    mocks.rpc.mockResolvedValue({ data: 1, error: null }); mocks.retrieve.mockRejectedValue(new Error("provider unavailable"));
    await expect(prepareVoiceSubscription(subscription, "business")).rejects.toThrow("provider unavailable");
  });
  it("refuses indeterminate database state", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "private" } });
    await expect(prepareVoiceSubscription(subscription, "business")).rejects.toThrow("voice_billing_reconciliation_unavailable");
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });
});
