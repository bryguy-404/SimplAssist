import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  deactivate: vi.fn(),
  unassign: vi.fn(),
  release: vi.fn(),
  begin: vi.fn(),
  accounts: vi.fn(),
  readAccount: vi.fn(),
  retrieve: vi.fn(),
  reconcile: vi.fn(),
  classify: vi.fn(),
  update: vi.fn(),
  initialize: vi.fn(),
  continueProvisioning: vi.fn(),
  refreshReadiness: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    rpc: mocks.rpc,
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "order"])
        chain[method] = () => chain;
      chain.update = (data: unknown) => {
        mocks.update(data);
        return chain;
      };
      chain.limit = mocks.accounts;
      chain.maybeSingle = mocks.begin;
      return chain;
    },
  },
}));
vi.mock("./smsProvisioning.server", () => ({
  continueReviewSmsProvisioning: mocks.continueProvisioning,
  refreshReviewSmsProviderReadiness: mocks.refreshReadiness,
  initializeIncludedReviewSmsSignup: mocks.initialize,
}));
vi.mock("@/lib/messaging/telnyxDestructive", () => ({
  deactivateTelnyxCampaign: mocks.deactivate,
  unassignTelnyxPhoneNumberCampaign: mocks.unassign,
  releaseTelnyxPhoneNumber: mocks.release,
  TelnyxRemoteMutationAuthorizationError: class extends Error {},
}));
vi.mock("@/lib/stripe/reviewSms.server", () => ({
  reconcileReviewSmsSubscription: mocks.reconcile,
  readReviewSmsAccount: mocks.readAccount,
}));
vi.mock("@/lib/stripe/client", () => ({
  stripe: { subscriptions: { retrieve: mocks.retrieve } },
}));
vi.mock("@/lib/stripe/subscriptionItems", () => ({
  classifySubscriptionItems: mocks.classify,
}));
import { runReviewSmsLifecycle } from "./smsLifecycle.server";
const action = {
  id: "action",
  business_id: "business",
  operation: "deactivate_campaign",
  provider_id: "campaign",
  claim_token: "claim",
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("REVIEWS_SMS_RELEASE_ENABLED", "1");
  vi.stubEnv("TELNYX_REMOTE_RELEASE_ENABLED", "1");
  vi.stubEnv("REVIEWS_SMS_ENABLED", "0");
  vi.stubEnv("REVIEWS_SMS_PILOT_BUSINESS_IDS", "*");
  vi.stubEnv("CUSTOMER_REVIEWS_EXCLUDED_BUSINESS_IDS", "");
  mocks.rpc.mockImplementation(async (name: string) => ({
    data: name === "review_sms_claim_release" ? [action] : true,
    error: null,
  }));
  mocks.begin.mockResolvedValue({ data: { id: "action" }, error: null });
  mocks.accounts.mockResolvedValue({ data: [], error: null });
  mocks.readAccount.mockResolvedValue({
    business_id: "business",
    state: "release_pending",
    billing_source: "grant",
  });
  mocks.reconcile.mockResolvedValue(undefined);
  mocks.classify.mockReturnValue({ reviewSms: null });
  mocks.retrieve.mockResolvedValue({
    id: "sub",
    customer: "cus",
    metadata: { business_id: "business" },
  });
});
afterEach(() => vi.unstubAllEnvs());
describe("review-only resource release", () => {
  it("initializes an opted-in signup and reconciles approval without a dashboard visit", async () => {
    const id = "10000000-0000-4000-8000-000000000001";
    vi.stubEnv("REVIEWS_SMS_ENABLED", "1");
    vi.stubEnv("REVIEWS_SMS_RELEASE_ENABLED", "0");
    mocks.rpc.mockImplementation(async (name: string) => ({
      data: name === "review_sms_signup_candidates" ? [{business_id: id, owner_id: "owner"}] : true,
      error: null,
    }));
    mocks.initialize.mockImplementation(async () => {
      mocks.accounts.mockResolvedValue({data: [{business_id: id, state: "carrier_pending", billing_source: "included"}], error: null});
    });
    expect(await runReviewSmsLifecycle()).toEqual({checked: 1, released: 0});
    expect(mocks.initialize).toHaveBeenCalledWith(id, "owner");
    expect(mocks.rpc).toHaveBeenCalledWith("review_sms_signup_candidates", {
      p_allowed_businesses: null, p_excluded_businesses: [], p_limit: 5,
    });
    expect(mocks.continueProvisioning).toHaveBeenCalledWith(id);
    expect(mocks.refreshReadiness).toHaveBeenCalledWith(id);
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });
  it("keeps rollout exclusions at the initialization boundary and continues after a raced candidate", async () => {
    const excluded = "10000000-0000-4000-8000-000000000001";
    const raced = "10000000-0000-4000-8000-000000000002";
    const ready = "10000000-0000-4000-8000-000000000003";
    vi.stubEnv("REVIEWS_SMS_ENABLED", "1");
    vi.stubEnv("REVIEWS_SMS_RELEASE_ENABLED", "0");
    vi.stubEnv("CUSTOMER_REVIEWS_EXCLUDED_BUSINESS_IDS", excluded);
    mocks.rpc.mockResolvedValue({data: [excluded, raced, ready].map(business_id => ({business_id, owner_id: "owner"})), error: null});
    mocks.initialize.mockImplementation(async (id: string) => { if (id === raced) throw new Error("Ownership changed"); });
    await runReviewSmsLifecycle();
    expect(mocks.initialize.mock.calls).toEqual([[raced, "owner"], [ready, "owner"]]);
    expect(mocks.rpc).toHaveBeenCalledWith("review_sms_signup_candidates", {
      p_allowed_businesses: null, p_excluded_businesses: [excluded], p_limit: 5,
    });
  });
  it("does not scan new signups when SMS rollout is disabled", async () => {
    vi.stubEnv("REVIEWS_SMS_RELEASE_ENABLED", "0");
    await runReviewSmsLifecycle();
    expect(mocks.rpc).not.toHaveBeenCalledWith("review_sms_signup_candidates", expect.anything());
    expect(mocks.initialize).not.toHaveBeenCalled();
  });
  it("keeps existing release cleanup available when candidate reads fail", async () => {
    vi.stubEnv("REVIEWS_SMS_ENABLED", "1");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.rpc.mockImplementation(async (name: string) => name === "review_sms_signup_candidates"
      ? {data: null, error: {message: "unavailable"}}
      : {data: name === "review_sms_claim_release" ? [action] : true, error: null});
    mocks.deactivate.mockResolvedValue("skipped");
    await runReviewSmsLifecycle();
    expect(mocks.rpc).toHaveBeenCalledWith("review_sms_claim_release");
    expect(mocks.deactivate).toHaveBeenCalled();
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });
  it("never completes an action when the provider boundary skips", async () => {
    mocks.deactivate.mockResolvedValue("skipped");
    expect((await runReviewSmsLifecycle()).released).toBe(0);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "review_sms_finish_release",
      expect.anything(),
    );
  });
  it("records completion only after a started successful provider mutation", async () => {
    mocks.deactivate.mockImplementation(
      async (
        _scope: unknown,
        options: { beforeMutation: () => Promise<string> },
      ) => {
        expect(await options.beforeMutation()).toBe("proceed");
        return "deactivated";
      },
    );
    expect((await runReviewSmsLifecycle()).released).toBe(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "review_sms_finish_release",
      expect.objectContaining({ p_success: true }),
    );
  });
  it("quarantines a provider timeout instead of returning the action to pending", async () => {
    mocks.deactivate.mockImplementation(
      async (
        _scope: unknown,
        options: { beforeMutation: () => Promise<string> },
      ) => {
        await options.beforeMutation();
        throw new Error("timeout");
      },
    );
    await runReviewSmsLifecycle();
    expect(mocks.rpc).toHaveBeenCalledWith(
      "review_sms_finish_release",
      expect.objectContaining({
        p_success: false,
        p_error: "provider_release_outcome_unknown",
      }),
    );
  });
  it("does not claim destructive work when release switch is disabled", async () => {
    vi.stubEnv("REVIEWS_SMS_RELEASE_ENABLED", "0");
    await runReviewSmsLifecycle();
    expect(mocks.rpc).not.toHaveBeenCalledWith("review_sms_claim_release");
    expect(mocks.deactivate).not.toHaveBeenCalled();
  });
  it("reconciles fresh Stripe state for ready-unpaid accounts before abandonment cleanup", async () => {
    const account = {
      business_id: "business",
      state: "ready_unpaid",
      billing_source: "direct",
      source_subscription_id: "sub",
      source_customer_id: "cus",
    };
    mocks.accounts.mockResolvedValue({ data: [account], error: null });
    mocks.reconcile.mockImplementation(async () => {
      expect(mocks.rpc).not.toHaveBeenCalledWith(
        "review_sms_prepare_release",
        expect.anything(),
      );
    });
    vi.stubEnv("REVIEWS_SMS_RELEASE_ENABLED", "0");
    expect((await runReviewSmsLifecycle()).checked).toBe(1);
    expect(mocks.retrieve).toHaveBeenCalledWith("sub");
    expect(mocks.reconcile).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith("review_sms_prepare_release", {
      p_business: "business",
    });
  });
  it("does not prepare cleanup or mutate a claimed resource when fresh Stripe reads fail", async () => {
    const account = {
      business_id: "business",
      state: "ready_unpaid",
      billing_source: "direct",
      source_subscription_id: "sub",
      source_customer_id: "cus",
    };
    mocks.accounts.mockResolvedValue({ data: [account], error: null });
    mocks.readAccount.mockResolvedValue({
      ...account,
      state: "release_pending",
    });
    mocks.retrieve.mockRejectedValue(new Error("Stripe unavailable"));
    expect(await runReviewSmsLifecycle()).toEqual({ checked: 0, released: 0 });
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "review_sms_prepare_release",
      expect.anything(),
    );
    expect(mocks.deactivate).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith({
      state: "pending",
      claim_token: null,
      lease_until: null,
    });
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "review_sms_finish_release",
      expect.anything(),
    );
  });
  it("blocks release when a newly discovered payment needs manual state recovery", async () => {
    mocks.readAccount.mockResolvedValue({
      business_id: "business",
      state: "release_pending",
      billing_source: "direct",
      source_subscription_id: "sub",
      source_customer_id: "cus",
    });
    mocks.reconcile.mockRejectedValue(
      new Error("review_sms_paid_period_invalid"),
    );
    expect((await runReviewSmsLifecycle()).released).toBe(0);
    expect(mocks.deactivate).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith({
      state: "pending",
      claim_token: null,
      lease_until: null,
    });
  });
  it.each(["pending payment", "live review item"])(
    "preserves resources while Stripe shows %s even if invoice reconciliation is a no-op",
    async (reason) => {
      const account = {
        business_id: "business",
        state: "ready_unpaid",
        billing_source: "direct",
        source_subscription_id: "sub",
        source_customer_id: "cus",
      };
      mocks.accounts.mockResolvedValue({ data: [account], error: null });
      mocks.readAccount.mockResolvedValue({
        ...account,
        state: "release_pending",
      });
      if (reason === "pending payment")
        mocks.retrieve.mockResolvedValue({
          id: "sub",
          customer: "cus",
          metadata: { business_id: "business" },
          pending_update: {},
        });
      else
        mocks.classify.mockReturnValue({
          reviewSms: {
            current_period_end: Math.floor(Date.now() / 1000) + 3600,
          },
        });
      expect(await runReviewSmsLifecycle()).toEqual({
        checked: 1,
        released: 0,
      });
      expect(mocks.rpc).not.toHaveBeenCalledWith(
        "review_sms_prepare_release",
        expect.anything(),
      );
      expect(mocks.deactivate).not.toHaveBeenCalled();
    },
  );
});
