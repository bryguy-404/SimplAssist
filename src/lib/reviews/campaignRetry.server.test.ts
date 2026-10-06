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
  prepareCorrectedReviewCampaignRetry,
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

describe("one corrected keyword submission", () => {
  const correctedAttemptId = "40000000-0000-4000-a100-000000000003";
  const historical = { ...originalFiling, optoutKeywords: "STOP,STOPALL,STOP ALL,UNSUBSCRIBE,CANCEL,END,QUIT,REVOKE,OPT OUT" };
  const corrected = { ...originalFiling, optoutKeywords: "STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT,REVOKE" };
  const correctedFiling = { ...corrected, referenceId: `${referenceId}:r2` };
  const diagnostic = {
    phase: "submit", status: 400, requestId: "req_keyword_10015",
    providerErrors: [{ code: "10015", title: "Bad Request", detail: "Keywords must be alphanumeric comma(,) separated without space." }],
  };
  const input = () => ({ ...prepareInput(), originalPayloadHash: hash(historical) });
  let correction: Record<string, unknown>;
  beforeEach(() => {
    account.provider_attempt_count = 2;
    Object.assign(original, { filing: { ...historical }, payload_hash: hash(historical) });
    Object.assign(attempt, {
      filing: { ...historical, referenceId: `${referenceId}:r1` }, payload_hash: hash({ ...historical, referenceId: `${referenceId}:r1` }),
      state: "unknown", diagnostics: structuredClone(diagnostic), authorization_consumed_at: "2026-10-06T04:00:00Z",
      started_at: "2026-10-06T04:00:00Z", finished_at: "2026-10-06T04:00:01Z", reservation_id: "retry-reservation",
    });
    correction = {
      id: correctedAttemptId, business_id: businessId, account_id: accountId, owner_id: ownerId, attempt_number: 3,
      reference_id: `${referenceId}:r2`, payload_hash: hash(correctedFiling), filing: { ...correctedFiling }, state: "prepared",
      original_reservation_id: reservationId, predecessor_attempt_id: attemptId, authorization_revision: 1,
    };
    mocks.filing.mockReturnValue({ ...corrected });
    mocks.reservation.mockResolvedValue({ id: reservationId, referenceId, payloadHash: hash(historical) });
    const normalRpc = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name, args) => name === "review_sms_authorize_corrected_campaign_retry" || name === "review_sms_refresh_campaign_retry_authorization"
      ? { data: { attempt_id: correctedAttemptId, token, expires_at: "2026-10-06T04:15:00.123456+00:00" }, error: null }
      : normalRpc(name, args));
  });
  const withPreparedCorrection = () => mocks.attempts.mockImplementation(async () => [original, attempt, correction]);

  it("advertises an exact known keyword correction without provider or database mutations", async () => {
    const state = await inspectReviewCampaignRetry(businessId);
    expect(state).toMatchObject({ eligible: false, correctedEligible: true, preparedRetry: null, originalPayloadHash: hash(historical) });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("authorizes only the keyword-corrected third reference while preserving both frozen attempts and payment", async () => {
    const before = structuredClone([original, attempt, account]);
    await expect(prepareCorrectedReviewCampaignRetry(input())).resolves.toEqual({ attemptId: correctedAttemptId, token, expiresAt: "2026-10-06T04:15:00.123Z" });
    expect(mocks.rpc.mock.calls).toEqual([
      ["review_sms_resource_scope_safe", expect.any(Object)],
      ["review_sms_authorize_corrected_campaign_retry", {
        p_business: businessId, p_account: accountId, p_owner: ownerId, p_actor: ownerId,
        p_prior_attempt: attemptId, p_expected_membership_revision: 2,
        p_corrected_filing: correctedFiling, p_corrected_payload_hash: hash(correctedFiling),
      }],
    ]);
    expect([original, attempt, account]).toEqual(before);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(calls("review_sms_authorize_campaign_retry")).toHaveLength(0);
  });

  it("compares frozen JSONB filings structurally regardless of property order", async () => {
    original.filing = Object.fromEntries(Object.entries(historical).reverse());
    attempt.filing = Object.fromEntries(Object.entries({ ...historical, referenceId: `${referenceId}:r1` }).reverse());
    await expect(prepareCorrectedReviewCampaignRetry(input())).resolves.toMatchObject({ attemptId: correctedAttemptId });
  });

  it.each([
    { status: 503 }, { status: "400" }, { phase: "verify_and_attach" }, { requestId: "" },
    { providerErrors: [{ ...diagnostic.providerErrors[0], code: "10016" }] },
    { providerErrors: [{ ...diagnostic.providerErrors[0], title: "Other error" }] },
    { providerErrors: [{ ...diagnostic.providerErrors[0], detail: "Different validation failure" }] },
    { providerErrors: [...diagnostic.providerErrors, { code: "other" }] },
  ])("refuses any diagnostic outside the exact observed HTTP400 keyword failure %#", async changed => {
    attempt.diagnostics = { ...diagnostic, ...changed };
    await expect(prepareCorrectedReviewCampaignRetry(input())).rejects.toMatchObject({ code: "review_sms_campaign_retry_changed" });
    expect((await inspectReviewCampaignRetry(businessId)).correctedEligible).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it.each([
    { state: "accepted" }, { state: "submitting" }, { authorization_consumed_at: null },
    { started_at: null }, { finished_at: null }, { provider_campaign_id: "campaign" }, { response_campaign_id: "campaign" },
    { payload_hash: "changed" }, { original_reservation_id: "other" }, { owner_id: "other" },
    { filing: { ...historical, referenceId: `${referenceId}:r1`, description: "Changed message" } },
  ])("refuses changed or uncertain predecessor evidence %#", async changed => {
    Object.assign(attempt, changed);
    await expect(prepareCorrectedReviewCampaignRetry(input())).rejects.toMatchObject({ code: "review_sms_campaign_retry_changed" });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it.each([
    { description: "New marketing copy" }, { optoutKeywords: "STOP,END" }, { brandId: "other" },
    { webhookURL: "https://different.example/callback" },
  ])("rejects any current filing change beyond the selected keyword correction %#", async changed => {
    mocks.filing.mockReturnValue({ ...corrected, ...changed });
    await expect(prepareCorrectedReviewCampaignRetry(input())).rejects.toMatchObject({ code: "review_sms_campaign_retry_changed" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([referenceId, `${referenceId}:r1`, `${referenceId}:r2`])("refuses a matching existing campaign for %s", async match => {
    proof.inventory.records.push({ campaignId: "existing", referenceId: match });
    await expect(prepareCorrectedReviewCampaignRetry(input())).rejects.toMatchObject({ code: "review_sms_campaign_retry_changed" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([1, 3, 4])("cannot authorize with provider attempt count %i", async count => {
    account.provider_attempt_count = count;
    await expect(prepareCorrectedReviewCampaignRetry(input())).rejects.toMatchObject({ code: "review_sms_campaign_retry_changed" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    { ownerId: token }, { accountId: token }, { originalReservationId: token },
    { originalPayloadHash: "f".repeat(64) }, { membershipRevision: 3 },
  ])("rejects changed corrected-preparation bindings before mutation %#", async changed => {
    await expect(prepareCorrectedReviewCampaignRetry({ ...input(), ...changed })).rejects.toMatchObject({ code: "review_sms_campaign_retry_changed" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    { state: "cancel_pending" }, { activation_paid_at: null }, { activation_refunded_at: "2026-10-06T04:00:00Z" },
    { cancel_at: "2026-10-06T04:00:00Z" }, { campaign_id: "existing" }, { provider_submitted_at: "2026-10-06T04:00:00Z" },
  ])("does not revive canceled, refunded, unpaid, or already-submitted service %#", async changed => {
    Object.assign(account, changed);
    await expect(prepareCorrectedReviewCampaignRetry(input())).rejects.toMatchObject({ code: "review_sms_campaign_retry_changed" });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("cannot create another authorization once ordinal3 exists; it exposes only unused same-attempt recovery", async () => {
    withPreparedCorrection();
    await expect(prepareCorrectedReviewCampaignRetry(input())).rejects.toMatchObject({ code: "review_sms_campaign_retry_changed" });
    expect(await inspectReviewCampaignRetry(businessId)).toMatchObject({ correctedEligible: false, preparedRetry: { attemptId: correctedAttemptId, revision: 1 } });
    expect(mocks.rpc).not.toHaveBeenCalled();
    await expect(reauthorizeReviewCampaignRetry({ ...input(), attemptId: correctedAttemptId, authorizationRevision: 1 }))
      .resolves.toMatchObject({ attemptId: correctedAttemptId });
    expect(calls("review_sms_refresh_campaign_retry_authorization")).toHaveLength(1);
    expect(calls("review_sms_authorize_corrected_campaign_retry")).toHaveLength(0);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("executes only the frozen corrected filing through the separately authorized database fence", async () => {
    withPreparedCorrection();
    mocks.retrieve.mockResolvedValue({ ...correctedFiling, campaignId: "created-campaign" });
    const before = structuredClone([original, attempt, account]);
    await executeReviewCampaignRetry({ businessId, attemptId: correctedAttemptId, token });
    expect(calls("review_sms_begin_campaign_retry")[0][1]).toMatchObject({ p_attempt: correctedAttemptId, p_token: token });
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(correctedFiling, { maxRetries: 0, timeout: 10000 });
    expect(calls("review_sms_finish_campaign_attempt")[0][1]).toMatchObject({ p_attempt: correctedAttemptId, p_outcome: "accepted", p_provider_campaign_id: "created-campaign" });
    expect([original, attempt, account]).toEqual(before);
  });

  it("rejects tampered prepared correction filing before scope, claim, or submission", async () => {
    withPreparedCorrection();
    correction.filing = { ...correctedFiling, optoutKeywords: "STOP" };
    await expect(executeReviewCampaignRetry({ businessId, attemptId: correctedAttemptId, token })).rejects.toMatchObject({ code: "review_sms_campaign_retry_changed" });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.qualify).not.toHaveBeenCalled();
  });

  it("does not POST when the corrected one-use database fence declines submission", async () => {
    withPreparedCorrection();
    const normalRpc = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name, args) => name === "review_sms_begin_campaign_retry" ? { data: { submit: false }, error: null } : normalRpc(name, args));
    await executeReviewCampaignRetry({ businessId, attemptId: correctedAttemptId, token });
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it.each([referenceId, `${referenceId}:r1`, `${referenceId}:r2`])("blocks late inventory evidence for %s before consuming the corrected capability", async match => {
    withPreparedCorrection();
    mocks.shared.mockResolvedValueOnce(proof).mockResolvedValueOnce({ ...proof, inventory: { records: [{ campaignId: "late", referenceId: match }] } });
    await expect(executeReviewCampaignRetry({ businessId, attemptId: correctedAttemptId, token })).rejects.toMatchObject({ code: "review_sms_campaign_recovery_required" });
    expect(calls("review_sms_begin_campaign_retry")).toHaveLength(0);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it.each(["submitting", "unknown", "accepted", "rejected"])("replaying a %s correction only inspects", async state => {
    withPreparedCorrection();
    correction.state = state;
    account.provider_attempt_count = 3;
    expect(await executeReviewCampaignRetry({ businessId, attemptId: correctedAttemptId, token })).toMatchObject({ eligible: false, correctedEligible: false, preparedRetry: null });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("recovers the accepted corrected campaign with starts disabled and no paid call", async () => {
    withPreparedCorrection();
    vi.stubEnv("REVIEWS_SMS_CAMPAIGN_RETRY_BUSINESS_IDS", "");
    correction.state = "unknown";
    account.provider_attempt_count = 3;
    mocks.inventory.mockResolvedValue({ records: [{ campaignId: "corrected-campaign", referenceId: `${referenceId}:r2` }] });
    mocks.retrieve.mockResolvedValue({ ...correctedFiling, campaignId: "corrected-campaign" });
    await expect(reconcileReviewCampaignAttempts(account, claim)).resolves.toBe(true);
    expect(calls("review_sms_finish_campaign_attempt")[0][1]).toMatchObject({ p_attempt: correctedAttemptId, p_outcome: "accepted" });
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  function bindAcceptedCorrection() {
    withPreparedCorrection();
    Object.assign(correction, { state: "accepted", provider_campaign_id: "corrected-campaign" });
    Object.assign(account, { campaign_id: "corrected-campaign", provider_submitted_at: "2026-10-06T05:00:00Z", provider_attempt_count: 3 });
    mocks.inventory.mockResolvedValue({ records: [{ campaignId: "corrected-campaign", referenceId: `${referenceId}:r2` }] });
    mocks.retrieve.mockResolvedValue({ ...correctedFiling, campaignId: "corrected-campaign", campaignStatus: "TCR_PENDING", submissionStatus: "PENDING" });
    mocks.validate.mockRejectedValue(new Error("The new-submission setup preflight no longer permits a bound campaign"));
  }

  it("inspects a bound accepted submission without requiring new-submission eligibility", async () => {
    bindAcceptedCorrection();
    const before = structuredClone([original, attempt, correction, account]);
    const state = await inspectReviewCampaignRetry(businessId);
    expect(state).toMatchObject({
      eligible: false, correctedEligible: false, preparedRetry: null,
      ownerId, accountId, originalReservationId: reservationId, originalPayloadHash: hash(historical),
      state: "carrier_pending", providerMatchCount: 1,
    });
    expect(state.reason).toContain("submission is recorded and matches Telnyx");
    expect(state.reason).toContain("Carrier approval and number readiness are checked separately");
    expect(state.attempts[2]).toMatchObject({ id: correctedAttemptId, state: "accepted" });
    expect([original, attempt, correction, account]).toEqual(before);
    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("returns confirmed account identity after successful execution even when the post-bind setup preflight would reject", async () => {
    withPreparedCorrection();
    mocks.retrieve.mockResolvedValue({ ...correctedFiling, campaignId: "created-campaign", campaignStatus: "MNO_PENDING" });
    const normalRpc = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name, args) => {
      if (name === "review_sms_finish_campaign_attempt" && args.p_outcome === "accepted") {
        Object.assign(correction, { state: "accepted", provider_campaign_id: "created-campaign" });
        Object.assign(account, { campaign_id: "created-campaign", provider_submitted_at: "2026-10-06T05:00:00Z", provider_attempt_count: 3 });
        mocks.inventory.mockResolvedValue({ records: [{ campaignId: "created-campaign", referenceId: `${referenceId}:r2` }] });
        mocks.validate.mockRejectedValue(new Error("already bound"));
      }
      return normalRpc(name, args);
    });
    await expect(executeReviewCampaignRetry({ businessId, attemptId: correctedAttemptId, token })).resolves.toMatchObject({
      eligible: false, correctedEligible: false, preparedRetry: null, ownerId, accountId,
      originalReservationId: reservationId, originalPayloadHash: hash(historical), providerMatchCount: 1,
    });
    expect(mocks.submit).toHaveBeenCalledOnce();
    expect(mocks.validate).toHaveBeenCalledOnce();
  });

  it.each(["inventory", "candidate"])("retains recorded acceptance and durable identity if the current provider %s read fails", async stage => {
    bindAcceptedCorrection();
    if (stage === "inventory") mocks.inventory.mockRejectedValue(new Error("temporary provider failure"));
    else mocks.retrieve.mockRejectedValue(new Error("temporary provider failure"));
    const state = await inspectReviewCampaignRetry(businessId);
    expect(state).toMatchObject({ eligible: false, correctedEligible: false, preparedRetry: null,
      originalReservationId: reservationId, originalPayloadHash: hash(historical), providerMatchCount: stage === "inventory" ? 0 : 1 });
    expect(state.reason).toContain("submission is recorded");
    expect(state.reason).toContain("Current carrier status could not be verified");
    expect(state.attempts[2].state).toBe("accepted");
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it.each(["cancel_pending", "release_pending", "released", "support_required"])("inspecting accepted submission preserves %s restrictions", async state => {
    bindAcceptedCorrection();
    account.state = state as ReviewSmsAccount["state"];
    const result = await inspectReviewCampaignRetry(businessId);
    expect(result).toMatchObject({ state, eligible: false, correctedEligible: false, preparedRetry: null });
    expect(result.reason).toContain("Existing account restrictions remain in place");
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it.each(["MNO_REJECTED", "TCR_SUSPENDED", "TCR_EXPIRED"])("reports current carrier %s without erasing recorded submission or granting approval", async campaignStatus => {
    bindAcceptedCorrection();
    mocks.retrieve.mockResolvedValue({ ...correctedFiling, campaignId: "corrected-campaign", campaignStatus });
    const result = await inspectReviewCampaignRetry(businessId);
    expect(result).toMatchObject({ eligible: false, correctedEligible: false, preparedRetry: null });
    expect(result.reason).toContain("rejected, suspended, or expired");
    expect(result.attempts[2].state).toBe("accepted");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("reports exact-filing mismatch without accepting changed provider details", async () => {
    bindAcceptedCorrection();
    mocks.retrieve.mockResolvedValue({ ...correctedFiling, campaignId: "corrected-campaign", description: "Changed details" });
    const result = await inspectReviewCampaignRetry(businessId);
    expect(result.reason).toContain("do not match its saved application");
    expect(result).toMatchObject({ eligible: false, correctedEligible: false, preparedRetry: null, providerMatchCount: 1 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("reports all observed original/retry matches instead of hiding a duplicate", async () => {
    bindAcceptedCorrection();
    mocks.inventory.mockResolvedValue({ records: [
      { campaignId: "old-campaign", referenceId }, { campaignId: "corrected-campaign", referenceId: `${referenceId}:r2` },
    ] });
    const result = await inspectReviewCampaignRetry(businessId);
    expect(result).toMatchObject({ providerMatchCount: 2, eligible: false, correctedEligible: false, preparedRetry: null });
    expect(result.reason).toContain("Multiple or conflicting campaigns");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([{ owner_id: token }, { account_id: token }, { provider_campaign_id: "other-campaign" }, { original_reservation_id: token }])(
    "does not use a substituted accepted journal binding for success identity %#", async changed => {
      bindAcceptedCorrection();
      Object.assign(correction, changed);
      const result = await inspectReviewCampaignRetry(businessId);
      expect(result).toMatchObject({ eligible: false, correctedEligible: false, preparedRetry: null, originalReservationId: null });
      expect(result.reason).toContain("Current registration could not be verified");
      expect(mocks.retrieve).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );
});
