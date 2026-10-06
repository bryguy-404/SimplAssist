import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validate: vi.fn(), shared: vi.fn(), reservation: vi.fn(), attempts: vi.fn(), account: vi.fn(),
  filing: vi.fn(), inventory: vi.fn(), rpc: vi.fn(), submit: vi.fn(), retrieve: vi.fn(), qualify: vi.fn(),
  from: vi.fn(), update: vi.fn(), eq: vi.fn(), release: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { rpc: mocks.rpc, from: mocks.from } }));
vi.mock("@/lib/messaging/client", () => ({ telnyx: { messaging10dlc: {
  campaign: { retrieve: mocks.retrieve },
  campaignBuilder: { submit: mocks.submit, brand: { qualifyByUsecase: mocks.qualify } },
} } }));
vi.mock("@/lib/reviews/smsProvisioning.server", () => ({ validateReviewSmsSetup: mocks.validate }));
vi.mock("@/lib/messaging/sharedBusinessRegistrations.server", () => ({
  inspectSharedCampaignRetry: mocks.shared, readSharedCampaignReservation: mocks.reservation,
}));
// Only account reads are supplied. An accidental billing mutation cannot silently succeed.
vi.mock("@/lib/stripe/reviewSms.server", () => ({ readReviewSmsAccount: mocks.account }));
vi.mock("./campaignAttempts.server", async (original) => ({
  ...await original<typeof import("./campaignAttempts.server")>(), readReviewCampaignAttempts: mocks.attempts,
}));
vi.mock("./campaignFiling.server", async (original) => ({
  ...await original<typeof import("./campaignFiling.server")>(), buildReviewCampaignFiling: mocks.filing,
}));
vi.mock("./campaignInventory.server", () => ({ readReviewCampaignInventory: mocks.inventory }));

import { ReviewSmsError, type ReviewSmsAccount } from "@/lib/billing/reviewSms";
import { serializeCampaignError } from "./campaignDiagnostics.server";
import {
  executeReviewCampaignRetry, inspectReviewCampaignRetry, prepareReviewCampaignRetry,
  reauthorizeReviewCampaignRetry,
  reconcileReviewCampaignAttempts, reviewCampaignRetryEnabled,
  normalizeReviewCampaignAuthorizationTimestamp,
} from "./campaignRetry.server";

const businessId = "0e2bf188-ab53-4d3b-8e1a-7aac49125811";
const accountId = "10000000-0000-4000-a100-000000000001";
const ownerId = "20000000-0000-4000-a100-000000000001";
const originalId = "30000000-0000-4000-a100-000000000001";
const attemptId = "40000000-0000-4000-a100-000000000001";
const reservationId = "50000000-0000-4000-a100-000000000001";
const token = "60000000-0000-4000-a100-000000000001";
const claim = "70000000-0000-4000-a100-000000000001";
const brandId = "80000000-0000-4000-a100-000000000001";
const referenceId = `reviews:${accountId}`;
const originalFiling = { brandId, usecase: "MARKETING", description: "A review request program for consenting customers.", referenceId, embeddedLink: true };
const retryFiling = { ...originalFiling, referenceId: `${referenceId}:r1` };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
let account: ReviewSmsAccount;
let business: Record<string, unknown>;
let original: Record<string, unknown>;
let attempt: Record<string, unknown>;
let proof: { context: { membership: { revision: number } }; inventory: { records: Array<{ campaignId: string; referenceId?: string }> }; verifiedAt: string };
const execute = () => executeReviewCampaignRetry({ businessId, attemptId, token });
const prepareInput = () => ({ businessId, ownerId, accountId, originalReservationId: reservationId,
  originalPayloadHash: hash(originalFiling), membershipRevision: 2, actorId: ownerId });
const reauthorizeInput = () => ({ ...prepareInput(), attemptId, authorizationRevision: 1 });
const calls = (name: string) => mocks.rpc.mock.calls.filter(([rpc]) => rpc === name);

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubEnv("REVIEWS_SMS_CAMPAIGN_RETRY_BUSINESS_IDS", businessId);
  vi.stubEnv("REVIEWS_SMS_ENABLED", "1");
  vi.stubEnv("REVIEWS_SMS_PILOT_BUSINESS_IDS", businessId);
  vi.stubEnv("CUSTOMER_REVIEWS_EXCLUDED_BUSINESS_IDS", "");
  vi.stubEnv("REVIEWS_SMS_PROVISIONING_ENABLED", "1");
  vi.stubEnv("TELNYX_PROTECTED_MESSAGING_PROFILE_ID", "protected-profile");
  vi.stubEnv("TELNYX_MESSAGING_PROFILE_ID", "protected-profile");
  vi.stubEnv("TELNYX_API_KEY", "KEY_TEST_PRIVATE_CREDENTIAL");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "PRIVATE_DB_CREDENTIAL");
  account = { id: accountId, business_id: businessId, owner_id: ownerId, state: "carrier_pending",
    provider_attempt_count: 1, campaign_id: null, provider_submitted_at: null, activation_paid_at: "2026-10-06T03:00:00Z",
    activation_refunded_at: null, cancel_at: null, draft: { phoneNumber: "+12125551234" },
    billing_source: "direct", source_subscription_id: "sub_source", source_customer_id: "cus_source",
    activation_payment_intent_id: "pi_paid", provider_started_at: "2026-10-06T03:12:21Z",
    review_usecase_approved_at: null, approval_evidence: null, phone_number_id: token,
    messaging_profile_id: "dedicated-profile", exclusive_resources: true, ready_at: null, ready_expires_at: null,
    stripe_item_id: null, stripe_price_id: null, stripe_schedule_id: null, paid_period_start: null,
    paid_period_end: null, paid_invoice_id: null, period_allowance: 0, release_at: null, grant_expires_at: null,
    last_error: "review_sms_setup_needs_attention", created_at: "2026-10-06T03:00:00Z",
  };
  business = { id: businessId, owner_id: ownerId, telnyx_brand_id: brandId, telnyx_campaign_id: null,
    telnyx_messaging_profile_id: "dedicated-profile", ein: "12-3456789", address: "42 Private Lane",
    authorized_rep_email: "private@example.com", legal_business_name: "Private Company LLC" };
  original = { id: originalId, account_id: accountId, owner_id: ownerId, business_id: businessId, attempt_number: 1,
    reference_id: referenceId, payload_hash: hash(originalFiling), filing: { ...originalFiling }, state: "unknown",
    reservation_id: reservationId, diagnostics: { historical: true }, started_at: "2026-10-06T03:12:21Z" };
  attempt = { id: attemptId, business_id: businessId, account_id: accountId, owner_id: ownerId, attempt_number: 2,
    reference_id: retryFiling.referenceId, payload_hash: hash(retryFiling), filing: { ...retryFiling }, state: "prepared",
    original_reservation_id: reservationId, diagnostics: null, started_at: null, authorization_revision: 1 };
  proof = { context: { membership: { revision: 2 } }, inventory: { records: [] }, verifiedAt: "2026-10-06T04:00:00Z" };
  mocks.validate.mockImplementation(async () => ({ account, business }));
  mocks.account.mockImplementation(async () => account);
  mocks.shared.mockImplementation(async () => structuredClone(proof));
  mocks.reservation.mockResolvedValue({ id: reservationId, referenceId, payloadHash: hash(originalFiling) });
  mocks.attempts.mockImplementation(async () => [original, attempt]);
  mocks.filing.mockImplementation(() => ({ ...originalFiling }));
  mocks.inventory.mockResolvedValue({ records: [] });
  mocks.qualify.mockResolvedValue({ usecase: "MARKETING" });
  mocks.submit.mockResolvedValue({ campaignId: "created-campaign" });
  mocks.retrieve.mockResolvedValue({ ...retryFiling, campaignId: "created-campaign" });
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === "review_sms_resource_scope_safe") return { data: true, error: null };
    if (name === "review_sms_claim_provisioning") return { data: claim, error: null };
    if (name === "review_sms_begin_campaign_retry") return { data: { submit: true }, error: null };
    if (name === "review_sms_finish_campaign_attempt") return { data: { state: "accepted", attached: true }, error: null };
    if (name === "review_sms_authorize_campaign_retry") return { data: { attempt_id: attemptId, token, expires_at: "2026-10-06T04:15:00Z" }, error: null };
    if (name === "review_sms_refresh_campaign_retry_authorization") return { data: { attempt_id: attemptId, token, expires_at: "2026-10-06T04:15:00.123456+00:00" }, error: null };
    throw new Error(`Unexpected mutating RPC ${name}`);
  });
  const chain = { eq: mocks.eq, then: (resolve: (value: unknown) => unknown) => mocks.release().then(resolve) };
  mocks.from.mockReturnValue({ update: mocks.update });
  mocks.update.mockReturnValue(chain);
  mocks.eq.mockReturnValue(chain);
  mocks.release.mockResolvedValue({ error: null });
});

describe("same-attempt retry reauthorization", () => {
  it("rotates only the unused attempt capability without preparing or submitting another campaign", async () => {
    const before = structuredClone([original, attempt, account]);
    await expect(reauthorizeReviewCampaignRetry(reauthorizeInput())).resolves.toEqual({
      attemptId, token, expiresAt: "2026-10-06T04:15:00.123Z",
    });
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
      "review_sms_resource_scope_safe", "review_sms_refresh_campaign_retry_authorization",
    ]);
    expect(calls("review_sms_refresh_campaign_retry_authorization")[0][1]).toEqual({
      p_business: businessId, p_attempt: attemptId, p_actor: ownerId, p_expected_revision: 1,
    });
    expect([original, attempt, account]).toEqual(before);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.qualify).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it.each([
    { attemptId: token }, { authorizationRevision: 2 }, { ownerId: token }, { accountId: token },
    { originalReservationId: token }, { originalPayloadHash: "f".repeat(64) }, { membershipRevision: 3 },
  ])("rejects stale or substituted authorization bindings before any mutation %#", async changed => {
    await expect(reauthorizeReviewCampaignRetry({ ...reauthorizeInput(), ...changed }))
      .rejects.toMatchObject({ code: "review_sms_campaign_retry_changed" });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it.each(["submitting", "unknown", "accepted", "rejected"])("cannot reauthorize an attempt already %s", async state => {
    attempt.state = state;
    await expect(reauthorizeReviewCampaignRetry(reauthorizeInput())).rejects.toMatchObject({ code: "review_sms_campaign_retry_changed" });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it.each([
    { authorization_consumed_at: "2026-10-06T04:00:00Z" }, { started_at: "2026-10-06T04:00:00Z" },
    { finished_at: "2026-10-06T04:00:00Z" }, { claim_token: claim }, { reservation_id: reservationId },
    { provider_campaign_id: "created-campaign" }, { response_campaign_id: "uncertain-campaign" },
  ])("rejects any evidence that the prepared capability has been used %#", async changed => {
    Object.assign(attempt, changed);
    await expect(reauthorizeReviewCampaignRetry(reauthorizeInput())).rejects.toMatchObject({ code: "review_sms_campaign_retry_changed" });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it.each([
    { payload_hash: "f".repeat(64) },
    { filing: { ...retryFiling, description: "Changed filing" } },
    { filing: { ...retryFiling, referenceId } },
  ])("rejects altered frozen filing evidence before the refresh RPC %#", async changed => {
    Object.assign(attempt, changed);
    await expect(reauthorizeReviewCampaignRetry(reauthorizeInput())).rejects.toMatchObject({ code: "review_sms_campaign_retry_changed" });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("refuses a refreshed capability when fresh inventory contains either campaign reference", async () => {
    proof.inventory.records.push({ campaignId: "late-campaign", referenceId: retryFiling.referenceId });
    await expect(reauthorizeReviewCampaignRetry(reauthorizeInput())).rejects.toMatchObject({ code: "review_sms_campaign_retry_changed" });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("returns only a revision marker for genuinely unused preparation, with no token", async () => {
    const result = await inspectReviewCampaignRetry(businessId);
    expect(result.eligible).toBe(false);
    expect(result.preparedRetry).toEqual({ attemptId, revision: 1 });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each(["submitting", "unknown", "accepted", "rejected"])("inspection does not advertise a consumed %s attempt for reauthorization", async state => {
    attempt.state = state;
    expect((await inspectReviewCampaignRetry(businessId)).preparedRetry).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("review campaign retry authorization", () => {
  it.each(["", "*", `${businessId},${ownerId}`])("fails closed for invalid retry rollout %s", async (setting) => {
    vi.stubEnv("REVIEWS_SMS_CAMPAIGN_RETRY_BUSINESS_IDS", setting);
    expect(reviewCampaignRetryEnabled(businessId)).toBe(false);
    await expect(inspectReviewCampaignRetry(businessId)).rejects.toMatchObject({ code: "review_sms_campaign_retry_disabled", status: 404 });
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("rejects nonpilot accounts and a disabled provisioning gate before reads or writes", async () => {
    expect(reviewCampaignRetryEnabled(ownerId)).toBe(false);
    await expect(prepareReviewCampaignRetry({ ...prepareInput(), businessId: ownerId })).rejects.toMatchObject({ status: 404 });
    vi.stubEnv("REVIEWS_SMS_PROVISIONING_ENABLED", "0");
    await expect(execute()).rejects.toMatchObject({ status: 404 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("inspection is read-only and projects attempts without private filings or tokens", async () => {
    mocks.attempts.mockResolvedValue([{ ...original, authorization_token_hash: "PRIVATE_HASH" }]);
    const result = await inspectReviewCampaignRetry(businessId);
    expect(result.eligible).toBe(true);
    expect(result.originalPayloadHash).toBe(hash(originalFiling));
    expect(JSON.stringify(result)).not.toContain("PRIVATE_HASH");
    expect(result.attempts[0]).not.toHaveProperty("filing");
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it.each([
    { ownerId: token }, { accountId: token }, { originalReservationId: token },
    { originalPayloadHash: "f".repeat(64) }, { membershipRevision: 3 },
  ])("rejects changed preparation identity or proof %#", async (changed) => {
    await expect(prepareReviewCampaignRetry({ ...prepareInput(), ...changed })).rejects.toMatchObject({ code: "review_sms_campaign_retry_changed" });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("rejects a changed original reservation reference before authorization", async () => {
    mocks.reservation.mockResolvedValue({ id: reservationId, referenceId: "different-reference", payloadHash: hash(originalFiling) });
    await expect(prepareReviewCampaignRetry(prepareInput())).rejects.toMatchObject({ code: "review_sms_campaign_retry_changed" });
    expect(calls("review_sms_authorize_campaign_retry")).toHaveLength(0);
  });

  it("prepares only a new reference while retaining all original filing fields", async () => {
    mocks.attempts.mockResolvedValue([original]);
    const before = structuredClone(original);
    await expect(prepareReviewCampaignRetry(prepareInput())).resolves.toEqual({ attemptId, token, expiresAt: "2026-10-06T04:15:00.000Z" });
    const args = calls("review_sms_authorize_campaign_retry")[0][1];
    expect(args.p_original_filing).toEqual(originalFiling);
    expect(args.p_retry_filing).toEqual(retryFiling);
    expect(args.p_retry_payload_hash).toBe(hash(retryFiling));
    expect(original).toEqual(before);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("normalizes a real PostgreSQL timestamptz offset and fractional seconds in the prepare response", async () => {
    const normalRpc = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name: string, args: unknown) => name === "review_sms_authorize_campaign_retry"
      ? { data: { attempt_id: attemptId, token, expires_at: "2026-10-06T04:15:00.123456+00:00" }, error: null }
      : normalRpc(name, args));
    await expect(prepareReviewCampaignRetry(prepareInput())).resolves.toEqual({ attemptId, token, expiresAt: "2026-10-06T04:15:00.123Z" });
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it.each(["not-a-date", "2026-10-06", "2026-10-06T04:15:00", "2026-99-06T04:15:00+00:00", null, undefined])(
    "rejects an invalid or timezone-free authorization timestamp (%s)", value => {
      expect(() => normalizeReviewCampaignAuthorizationTimestamp(value)).toThrow("review_sms_campaign_authorization_invalid");
    },
  );
});

describe("one controlled provider submission", () => {
  it("stops if fresh inventory discovers either attempt after qualification", async () => {
    mocks.shared.mockResolvedValueOnce(proof).mockResolvedValueOnce({ ...proof, inventory: { records: [{ campaignId: "late-original", referenceId }] } });
    await expect(execute()).rejects.toMatchObject({ code: "review_sms_campaign_recovery_required" });
    expect(mocks.qualify).toHaveBeenCalledOnce();
    expect(calls("review_sms_begin_campaign_retry")).toHaveLength(0);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith({ provisioning_claim: null, provisioning_lease_until: null });
  });

  it.each(["submitting", "unknown", "accepted", "rejected"])("a replay of a %s attempt only inspects", async (state) => {
    attempt.state = state;
    const result = await execute();
    expect(result.eligible).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.qualify).not.toHaveBeenCalled();
  });

  it("does not submit or run qualification when another worker holds the claim", async () => {
    const originalRpc = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name, args) => name === "review_sms_claim_provisioning" ? { data: null, error: null } : originalRpc(name, args));
    await expect(execute()).rejects.toMatchObject({ code: "review_sms_provisioning_busy" });
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.qualify).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not submit when the one-use authorization was already consumed", async () => {
    const originalRpc = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name, args) => name === "review_sms_begin_campaign_retry" ? { data: { submit: false }, error: null } : originalRpc(name, args));
    await execute();
    expect(calls("review_sms_begin_campaign_retry")).toHaveLength(1);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("records the exact sanitized provider failure and never automatically retries", async () => {
    const providerError = Object.assign(new Error("Connection failed for private@example.com at 42 Private Lane"), {
      status: 503, headers: new Headers({ "x-request-id": "req_exact_12345" }),
      error: { errors: [{ code: "590", title: "Temporary provider failure", detail: "Try again later; token=SECRET" }] },
      cause: { name: "Error", code: "ECONNRESET", message: "reset" },
    });
    const before = structuredClone(original);
    mocks.submit.mockRejectedValue(providerError);
    await expect(execute()).rejects.toBe(providerError);
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(retryFiling, { maxRetries: 0, timeout: 10000 });
    const failure = calls("review_sms_finish_campaign_attempt")[0][1];
    expect(failure).toMatchObject({ p_attempt: attemptId, p_claim: claim, p_outcome: "unknown", p_provider_campaign_id: null });
    expect(failure.p_diagnostics).toEqual({ ...serializeCampaignError(providerError, { sensitiveValues: ["42 Private Lane", "private@example.com"] }), phase: "submit" });
    expect(JSON.stringify(failure.p_diagnostics)).not.toContain("42 Private Lane");
    expect(original).toEqual(before);
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("preserves a returned campaign ID when verification fails", async () => {
    mocks.retrieve.mockRejectedValue(new Error("retrieval unavailable"));
    await expect(execute()).rejects.toThrow("retrieval unavailable");
    const failure = calls("review_sms_finish_campaign_attempt")[0][1];
    expect(failure).toMatchObject({ p_outcome: "unknown", p_provider_campaign_id: "created-campaign", p_diagnostics: { phase: "verify_and_attach" } });
    expect(mocks.submit).toHaveBeenCalledOnce();
  });

  it("records a transport failure without inventing an HTTP response or retrying", async () => {
    class APIConnectionError extends Error {}
    const error = Object.assign(new APIConnectionError("Connection error."), {
      cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    });
    mocks.submit.mockRejectedValue(error);
    await expect(execute()).rejects.toBe(error);
    expect(calls("review_sms_finish_campaign_attempt")[0][1].p_diagnostics).toMatchObject({
      name: "APIConnectionError", message: "Connection error.", status: null, requestId: null,
      providerErrors: [], cause: { name: "Error", message: "socket hang up", code: "ECONNRESET" }, phase: "submit",
    });
    expect(mocks.submit).toHaveBeenCalledOnce();
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });

  it("submits once, verifies the full filing, and attaches only the retry attempt", async () => {
    const before = structuredClone(original);
    await execute();
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(retryFiling, { maxRetries: 0, timeout: 10000 });
    expect(mocks.retrieve).toHaveBeenCalledExactlyOnceWith("created-campaign", { maxRetries: 0, timeout: 10000 });
    expect(calls("review_sms_finish_campaign_attempt")).toEqual([["review_sms_finish_campaign_attempt", {
      p_attempt: attemptId, p_claim: claim, p_outcome: "accepted", p_provider_campaign_id: "created-campaign",
      p_provider_filing: { ...retryFiling, campaignId: "created-campaign" }, p_diagnostics: null,
    }]]);
    expect(original).toEqual(before);
    expect(mocks.from.mock.calls.map(([table]) => table)).toEqual(["review_sms_accounts"]);
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ provisioning_claim: null, provisioning_lease_until: null });
    expect(calls("review_sms_authorize_campaign_retry")).toHaveLength(0);
  });

  it("reports recovery required when evidence is retained but attachment is refused", async () => {
    const originalRpc = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name, args) => name === "review_sms_finish_campaign_attempt" ? { data: { state: "accepted", attached: false }, error: null } : originalRpc(name, args));
    await expect(execute()).rejects.toBeInstanceOf(ReviewSmsError);
    expect(mocks.submit).toHaveBeenCalledOnce();
  });
});

describe("reconciliation has no paid endpoint", () => {
  it("adopts a matching observed attempt even after the retry flag is disabled", async () => {
    vi.stubEnv("REVIEWS_SMS_CAMPAIGN_RETRY_BUSINESS_IDS", "");
    attempt.state = "unknown";
    mocks.inventory.mockResolvedValue({ records: [{ campaignId: "created-campaign", referenceId: retryFiling.referenceId }] });
    await expect(reconcileReviewCampaignAttempts(account, claim)).resolves.toBe(true);
    expect(calls("review_sms_finish_campaign_attempt")[0][1].p_outcome).toBe("accepted");
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("leaves two observed campaigns for inspection instead of choosing one", async () => {
    mocks.inventory.mockResolvedValue({ records: [{ campaignId: "first", referenceId }, { campaignId: "second", referenceId: retryFiling.referenceId }] });
    await expect(reconcileReviewCampaignAttempts(account, claim)).rejects.toMatchObject({ code: "review_sms_campaign_recovery_required" });
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("recovers the exact returned campaign ID when the provider list has not caught up", async () => {
    attempt.state = "unknown";
    attempt.response_campaign_id = "created-campaign";
    const originalBefore = structuredClone(original);
    mocks.inventory.mockResolvedValue({ records: [] });
    await expect(reconcileReviewCampaignAttempts(account, claim)).resolves.toBe(true);
    expect(mocks.retrieve).toHaveBeenCalledWith("created-campaign", { maxRetries: 0, timeout: 10000 });
    expect(calls("review_sms_finish_campaign_attempt")).toEqual([["review_sms_finish_campaign_attempt", {
      p_attempt: attemptId, p_claim: claim, p_outcome: "accepted", p_provider_campaign_id: "created-campaign",
      p_provider_filing: { ...retryFiling, campaignId: "created-campaign" }, p_diagnostics: null,
    }]]);
    expect(original).toEqual(originalBefore);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("requires the full frozen filing even for a known returned campaign ID", async () => {
    attempt.state = "unknown";
    attempt.response_campaign_id = "created-campaign";
    mocks.inventory.mockResolvedValue({ records: [] });
    mocks.retrieve.mockResolvedValue({ ...retryFiling, campaignId: "created-campaign", description: "Unrelated campaign content" });
    await expect(reconcileReviewCampaignAttempts(account, claim)).rejects.toMatchObject({ code: "review_sms_campaign_mismatch" });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("holds a missing returned campaign ID without attaching, clearing evidence, or resubmitting", async () => {
    attempt.state = "unknown";
    attempt.response_campaign_id = "created-campaign";
    const before = structuredClone(attempt);
    mocks.inventory.mockResolvedValue({ records: [] });
    const missing = Object.assign(new Error("Campaign not found"), { status: 404 });
    mocks.retrieve.mockRejectedValue(missing);
    await expect(reconcileReviewCampaignAttempts(account, claim)).rejects.toBe(missing);
    expect(mocks.retrieve).toHaveBeenCalledExactlyOnceWith("created-campaign", { maxRetries: 0, timeout: 10000 });
    expect(attempt).toEqual(before);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("refuses attachment when two returned IDs reveal both original and retry campaigns", async () => {
    original.response_campaign_id = "original-campaign";
    attempt.state = "unknown";
    attempt.response_campaign_id = "retry-campaign";
    mocks.inventory.mockResolvedValue({ records: [] });
    mocks.retrieve.mockImplementation(async (id: string) => id === "original-campaign"
      ? { ...originalFiling, campaignId: id }
      : { ...retryFiling, campaignId: id });
    await expect(reconcileReviewCampaignAttempts(account, claim)).rejects.toMatchObject({ code: "review_sms_campaign_recovery_required" });
    expect(mocks.retrieve).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});
