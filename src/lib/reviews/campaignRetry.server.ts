import "server-only";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { supabaseAdmin as db } from "@/lib/supabase/admin";
import { telnyx } from "@/lib/messaging/client";
import { ReviewSmsError, type ReviewSmsAccount } from "@/lib/billing/reviewSms";
import { isReviewSmsEnabled } from "@/lib/billing/reviewSmsRollout.server";
import { inspectSharedCampaignRetry, readSharedCampaignReservation } from "@/lib/messaging/sharedBusinessRegistrations.server";
import { readReviewSmsAccount } from "@/lib/stripe/reviewSms.server";
import { campaignAttemptRpc, captureReviewCampaignFailure, readReviewCampaignAttempts, type ReviewCampaignAttempt } from "./campaignAttempts.server";
import { buildReviewCampaignFiling, reviewCampaignFilingHash, reviewSmsCampaignMatches } from "./campaignFiling.server";
import { readReviewCampaignInventory } from "./campaignInventory.server";
import { validateReviewSmsSetup } from "./smsProvisioning.server";

const PILOT = "0e2bf188-ab53-4d3b-8e1a-7aac49125811";
export function reviewCampaignRetryEnabled(businessId: string) {
  return businessId === PILOT && process.env.REVIEWS_SMS_CAMPAIGN_RETRY_BUSINESS_IDS?.trim() === PILOT &&
    isReviewSmsEnabled(businessId) && process.env.REVIEWS_SMS_PROVISIONING_ENABLED === "1";
}
function assertEnabled(businessId: string) {
  if (!reviewCampaignRetryEnabled(businessId)) throw new ReviewSmsError("review_sms_campaign_retry_disabled", 404);
}
function forbiddenProfiles() {
  const ids = [process.env.TELNYX_PROTECTED_MESSAGING_PROFILE_ID, process.env.TELNYX_MESSAGING_PROFILE_ID].filter((x): x is string => !!x?.trim());
  if (!ids.length) throw new ReviewSmsError("review_sms_resource_protection_unconfigured", 503);
  return ids;
}
export function campaignPrivateValues(b: Record<string, unknown>) {
  return ["name", "ein", "address", "city", "zip", "authorized_rep_name", "authorized_rep_email", "authorized_rep_phone", "legal_business_name"]
    .map(key => b[key]).filter((x): x is string => typeof x === "string")
    .concat([process.env.TELNYX_API_KEY ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""]);
}
async function scope(a: ReviewSmsAccount, b: Record<string, unknown>) {
  const allowed = await campaignAttemptRpc<boolean>("review_sms_resource_scope_safe", {
    p_business: a.business_id, p_profile: b.telnyx_messaging_profile_id,
    p_sender: String(a.draft.phoneNumber), p_campaign: null, p_forbidden_profiles: forbiddenProfiles(),
  });
  if (!allowed) throw new ReviewSmsError("review_sms_resource_scope_denied");
}
async function context(businessId: string) {
  const { account, business } = await validateReviewSmsSetup(businessId);
  const proof = await inspectSharedCampaignRetry(businessId, account.owner_id);
  const original = await readSharedCampaignReservation(businessId, account.id);
  const attempts = await readReviewCampaignAttempts(businessId);
  const filing = buildReviewCampaignFiling(account, business, proof.context);
  const matches = proof.inventory.records.filter(c =>
    [filing.referenceId, `${filing.referenceId}:r1`, `${filing.referenceId}:r2`].includes(c.referenceId ?? ""));
  return { account, business, proof, original, attempts, filing, matches };
}

type RetryContext = Awaited<ReturnType<typeof context>>;
const originalOptoutKeywords = "STOP,STOPALL,STOP ALL,UNSUBSCRIBE,CANCEL,END,QUIT,REVOKE,OPT OUT";
const correctedOptoutKeywords = "STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT,REVOKE";
const keywordRejectionDetail = "Keywords must be alphanumeric comma(,) separated without space.";
function correctedRetryEvidence(c: RetryContext) {
  const originals = c.attempts.filter(t => t.attempt_number === 1);
  const priors = c.attempts.filter(t => t.attempt_number === 2);
  if (originals.length !== 1 || priors.length !== 1 || c.attempts.filter(t => t.attempt_number === 3).length > 1 ||
    c.attempts.some(t => t.attempt_number < 1 || t.attempt_number > 3)) return null;
  const first = originals[0], prior = priors[0];
  const diagnostics = prior.diagnostics;
  const errors = diagnostics?.providerErrors;
  const exactKeywordRejection = diagnostics?.phase === "submit" && diagnostics.status === 400 && Array.isArray(errors) &&
    typeof diagnostics.requestId === "string" && !!diagnostics.requestId.trim() && errors.length === 1 &&
    errors[0]?.code === "10015" && errors[0]?.title === "Bad Request" && errors[0]?.detail === keywordRejectionDetail;
  const historical = { ...c.filing, optoutKeywords: originalOptoutKeywords };
  const correctedFiling = { ...c.filing, referenceId: `${c.filing.referenceId}:r2` };
  if (!c.original || c.original.referenceId !== c.filing.referenceId || !exactKeywordRejection ||
    c.filing.optoutKeywords !== correctedOptoutKeywords || c.original.payloadHash !== first.payload_hash ||
    c.original.payloadHash !== reviewCampaignFilingHash(historical) || first.reservation_id !== c.original.id ||
    first.reference_id !== c.filing.referenceId || first.state !== "unknown" ||
    prior.reference_id !== `${c.filing.referenceId}:r1` || prior.original_reservation_id !== c.original.id ||
    prior.state !== "unknown" || !prior.authorization_consumed_at || !prior.started_at || !prior.finished_at ||
    !isDeepStrictEqual(first.filing, historical) ||
    !isDeepStrictEqual(prior.filing, { ...historical, referenceId: prior.reference_id }) ||
    prior.payload_hash !== reviewCampaignFilingHash({ ...historical, referenceId: prior.reference_id }) ||
    [first, prior].some(t => t.business_id !== c.account.business_id || t.account_id !== c.account.id || t.owner_id !== c.account.owner_id ||
      t.provider_campaign_id || t.response_campaign_id)) return null;
  return { first, prior, correctedFiling };
}
function unusedPreparedAttempt(attempt: ReviewCampaignAttempt | undefined) {
  return !!attempt && attempt.state === "prepared" && !attempt.authorization_consumed_at &&
    !attempt.started_at && !attempt.finished_at && !attempt.claim_token && !attempt.reservation_id &&
    !attempt.provider_campaign_id && !attempt.response_campaign_id && !!attempt.authorization_revision;
}
function currentAccount(c: RetryContext, count: number) {
  return c.matches.length === 0 && c.account.provider_attempt_count === count && c.account.state === "carrier_pending" &&
    !c.account.campaign_id && !c.business.telnyx_campaign_id && !c.account.provider_submitted_at &&
    !!c.account.activation_paid_at && !c.account.activation_refunded_at && !c.account.cancel_at;
}
function samePreparationIdentity(c: RetryContext, input: PrepareCampaignRetry) {
  return !!c.original && c.account.owner_id === input.ownerId && c.account.id === input.accountId &&
    c.original.id === input.originalReservationId && c.original.payloadHash === input.originalPayloadHash &&
    c.proof.context.membership.revision === input.membershipRevision;
}

export async function inspectReviewCampaignRetry(businessId: string) {
  assertEnabled(businessId);
  // Historical diagnostics remain readable if a later carrier rejection makes
  // fresh setup validation fail. Such a read never authorizes another attempt.
  const account = await readReviewSmsAccount(businessId);
  if (!account) throw new ReviewSmsError("review_sms_campaign_retry_changed");
  const attempts = await readReviewCampaignAttempts(businessId);
  let c: Awaited<ReturnType<typeof context>>;
  try { c = await context(businessId); }
  catch {
    return {
      eligible: false, correctedEligible: false, preparedRetry: null, reason: "Current registration could not be verified. Recorded attempts are shown below; no retry is permitted.",
      businessId, ownerId: account.owner_id, accountId: account.id,
      originalReservationId: null, originalPayloadHash: null, membershipRevision: null,
      state: account.state, providerMatchCount: 0,
      attempts: attempts.map(t => ({id: t.id, referenceId: t.reference_id, state: t.state, startedAt: t.started_at, diagnostics: t.diagnostics})),
    };
  }
  const existingRetry = c.attempts.find(a => a.attempt_number === 2);
  const existingCorrection = c.attempts.find(a => a.attempt_number === 3);
  const current = c.matches.length === 0 && !!c.original &&
    c.original.payloadHash === reviewCampaignFilingHash(c.filing) &&
    c.account.provider_attempt_count === 1 && c.account.state === "carrier_pending" &&
    !c.account.campaign_id && !c.business.telnyx_campaign_id && !c.account.provider_submitted_at &&
    !!c.account.activation_paid_at && !c.account.activation_refunded_at && !c.account.cancel_at;
  const eligible = !existingRetry && current;
  const correction = correctedRetryEvidence(c);
  const correctedCurrent = !!correction && currentAccount(c, 2);
  const correctedEligible = correctedCurrent && !existingCorrection;
  const preparedCorrection = correctedCurrent && unusedPreparedAttempt(existingCorrection) &&
    existingCorrection!.payload_hash === reviewCampaignFilingHash(correction!.correctedFiling) &&
    isDeepStrictEqual(existingCorrection!.filing, correction!.correctedFiling);
  const prepared = preparedCorrection ? existingCorrection : current && unusedPreparedAttempt(existingRetry) ? existingRetry : undefined;
  const preparedRetry = prepared ? { attemptId: prepared.id, revision: prepared.authorization_revision! } : null;
  return {
    preparedRetry,
    eligible, correctedEligible, reason: eligible || correctedEligible ? null : c.matches.length ? "An existing campaign was found. Reconcile it before submitting anything else." :
      preparedRetry ? "The existing retry is prepared and has not started. It can be resumed without creating another attempt." :
      existingRetry ? "The one-time retry has already been prepared or used. Inspect its recorded outcome; do not submit again." : "The account no longer matches the approved retry conditions.",
    businessId, ownerId: c.account.owner_id, accountId: c.account.id,
    originalReservationId: c.original?.id ?? null, originalPayloadHash: c.original?.payloadHash ?? null,
    membershipRevision: c.proof.context.membership.revision, state: c.account.state,
    attempts: c.attempts.map(t => ({ id: t.id, referenceId: t.reference_id, state: t.state, startedAt: t.started_at, diagnostics: t.diagnostics })),
    providerMatchCount: c.matches.length,
  };
}
export interface PrepareCampaignRetry {
  businessId: string; ownerId: string; accountId: string; originalReservationId: string;
  originalPayloadHash: string; membershipRevision: number; actorId: string;
}
/** PostgreSQL timestamptz JSON uses offsets; the browser receives canonical UTC. */
export function normalizeReviewCampaignAuthorizationTimestamp(value: unknown): string {
  const parsed = z.string().datetime({ offset: true }).safeParse(value);
  const timestamp = parsed.success ? Date.parse(parsed.data) : NaN;
  if (!Number.isFinite(timestamp)) throw new ReviewSmsError("review_sms_campaign_authorization_invalid", 503);
  return new Date(timestamp).toISOString();
}
export function retryAuthorizationResponse(authorization: { attempt_id: string; token: string; expires_at: string }) {
  return { attemptId: authorization.attempt_id, token: authorization.token,
    expiresAt: normalizeReviewCampaignAuthorizationTimestamp(authorization.expires_at) };
}
export async function prepareReviewCampaignRetry(input: PrepareCampaignRetry) {
  assertEnabled(input.businessId);
  const c = await context(input.businessId);
  if (!c.original || c.matches.length || c.account.owner_id !== input.ownerId || c.account.id !== input.accountId ||
    c.original.id !== input.originalReservationId || c.original.referenceId !== c.filing.referenceId || c.original.payloadHash !== input.originalPayloadHash ||
    reviewCampaignFilingHash(c.filing) !== input.originalPayloadHash ||
    c.proof.context.membership.revision !== input.membershipRevision)
    throw new ReviewSmsError("review_sms_campaign_retry_changed");
  await scope(c.account, c.business);
  const retryFiling = { ...c.filing, referenceId: `${c.filing.referenceId}:r1` };
  const authorization = await campaignAttemptRpc<{attempt_id: string; token: string; expires_at: string}>("review_sms_authorize_campaign_retry", {
    p_business: input.businessId, p_account: input.accountId, p_owner: input.ownerId, p_actor: input.actorId,
    p_original_reservation: input.originalReservationId, p_expected_membership_revision: input.membershipRevision,
    p_original_filing: c.filing, p_retry_filing: retryFiling, p_retry_payload_hash: reviewCampaignFilingHash(retryFiling),
  });
  return retryAuthorizationResponse(authorization);
}

/** One separately authorized correction of the exact recorded keyword rejection. */
export async function prepareCorrectedReviewCampaignRetry(input: PrepareCampaignRetry) {
  assertEnabled(input.businessId);
  const c = await context(input.businessId);
  const correction = correctedRetryEvidence(c);
  if (!correction || !samePreparationIdentity(c, input) || !currentAccount(c, 2) || c.attempts.some(t => t.attempt_number === 3))
    throw new ReviewSmsError("review_sms_campaign_retry_changed");
  await scope(c.account, c.business);
  const authorization = await campaignAttemptRpc<{attempt_id: string; token: string; expires_at: string}>("review_sms_authorize_corrected_campaign_retry", {
    p_business: input.businessId, p_account: input.accountId, p_owner: input.ownerId, p_actor: input.actorId,
    p_prior_attempt: correction.prior.id, p_expected_membership_revision: input.membershipRevision,
    p_corrected_filing: correction.correctedFiling, p_corrected_payload_hash: reviewCampaignFilingHash(correction.correctedFiling),
  });
  return retryAuthorizationResponse(authorization);
}

/** Replace a lost browser capability only while the SAME paid attempt is unused. */
export async function reauthorizeReviewCampaignRetry(input: PrepareCampaignRetry & { attemptId: string; authorizationRevision: number }) {
  assertEnabled(input.businessId);
  const c = await context(input.businessId);
  const attempt = c.attempts.find(t => t.id === input.attemptId && [2, 3].includes(t.attempt_number));
  const correction = attempt?.attempt_number === 3 ? correctedRetryEvidence(c) : null;
  const retryFiling = correction?.correctedFiling ?? { ...c.filing, referenceId: `${c.filing.referenceId}:r1` };
  const sourceValid = attempt?.attempt_number === 3 ? !!correction && currentAccount(c, 2) : reviewCampaignFilingHash(c.filing) === input.originalPayloadHash;
  if (!attempt || !c.original || c.matches.length || attempt.state !== "prepared" || attempt.authorization_consumed_at ||
    attempt.started_at || attempt.finished_at || attempt.claim_token || attempt.reservation_id || attempt.provider_campaign_id || attempt.response_campaign_id ||
    attempt.authorization_revision !== input.authorizationRevision || c.account.owner_id !== input.ownerId || c.account.id !== input.accountId ||
    c.original.id !== input.originalReservationId || c.original.referenceId !== c.filing.referenceId || c.original.payloadHash !== input.originalPayloadHash ||
    !sourceValid || attempt.payload_hash !== reviewCampaignFilingHash(retryFiling) ||
    !isDeepStrictEqual(attempt.filing, retryFiling) || c.proof.context.membership.revision !== input.membershipRevision)
    throw new ReviewSmsError("review_sms_campaign_retry_changed");
  await scope(c.account, c.business);
  const authorization = await campaignAttemptRpc<{attempt_id: string; token: string; expires_at: string}>("review_sms_refresh_campaign_retry_authorization", {
    p_business: input.businessId, p_attempt: input.attemptId, p_actor: input.actorId, p_expected_revision: input.authorizationRevision,
  });
  return retryAuthorizationResponse(authorization);
}

async function attachObservedAttempt(t: ReviewCampaignAttempt, claim: string, campaignId: string) {
  const candidate = await telnyx.messaging10dlc.campaign.retrieve(campaignId, { maxRetries: 0, timeout: 10000 });
  if (!reviewSmsCampaignMatches(candidate as unknown as Record<string, unknown>, t.filing))
    throw new ReviewSmsError("review_sms_campaign_mismatch");
  return campaignAttemptRpc<{state: string; attached: boolean}>("review_sms_finish_campaign_attempt", {
    p_attempt: t.id, p_claim: claim, p_outcome: "accepted", p_provider_campaign_id: campaignId,
    p_provider_filing: candidate, p_diagnostics: null,
  });
}

/** Recovery never needs the start flag or token and never calls a paid endpoint. */
export async function reconcileReviewCampaignAttempts(a: ReviewSmsAccount, claim: string): Promise<boolean> {
  const attempts = await readReviewCampaignAttempts(a.business_id);
  if (!attempts.length) return false;
  const referenceSet = new Set(attempts.map(t => t.reference_id));
  const { records } = await readReviewCampaignInventory(String(attempts[0].filing.brandId));
  const found = records.filter(c => referenceSet.has(c.referenceId ?? ""));
  // A returned ID is useful even while the list view lags. Inspect that exact
  // candidate; full frozen-filing verification remains required for adoption.
  const knownIds = new Set(attempts.map(t => t.provider_campaign_id ?? t.response_campaign_id).filter((id): id is string => !!id));
  for (const id of Array.from(knownIds)) {
    if (found.some(c => c.campaignId === id)) continue;
    const candidate = await telnyx.messaging10dlc.campaign.retrieve(id, { maxRetries: 0, timeout: 10000 });
    if (candidate.campaignId !== id || !referenceSet.has(candidate.referenceId ?? ""))
      throw new ReviewSmsError("review_sms_campaign_mismatch");
    found.push({campaignId: id, referenceId: candidate.referenceId, brandId: candidate.brandId});
  }
  // With two observable campaigns, choosing either automatically could hide a
  // duplicate recurring provider charge. Leave both for explicit inspection.
  if (found.length > 1) throw new ReviewSmsError("review_sms_campaign_recovery_required");
  if (found.length === 1) {
    const attempt = attempts.find(t => t.reference_id === found[0].referenceId)!;
    if (attempt.state === "prepared") throw new ReviewSmsError("review_sms_campaign_recovery_required");
    const result = await attachObservedAttempt(attempt, claim, found[0].campaignId);
    if (!result.attached) throw new ReviewSmsError("review_sms_campaign_recovery_required");
  }
  return true;
}

export async function executeReviewCampaignRetry(input: {businessId: string; attemptId: string; token: string}) {
  assertEnabled(input.businessId);
  const a = await readReviewSmsAccount(input.businessId);
  if (!a) throw new ReviewSmsError("review_sms_campaign_retry_changed");
  const attempts = await readReviewCampaignAttempts(input.businessId);
  const attempt = attempts.find(t => t.id === input.attemptId && [2, 3].includes(t.attempt_number) && t.account_id === a.id && t.owner_id === a.owner_id);
  if (!attempt) throw new ReviewSmsError("review_sms_campaign_retry_changed");
  // Replayed POSTs only inspect. They cannot call the carrier again.
  if (attempt.state !== "prepared") return inspectReviewCampaignRetry(input.businessId);
  const c = await context(input.businessId);
  if (c.matches.length) throw new ReviewSmsError("review_sms_campaign_recovery_required");
  if (attempt.attempt_number === 3) {
    const correction = correctedRetryEvidence(c);
    if (!correction || !currentAccount(c, 2) || !isDeepStrictEqual(attempt.filing, correction.correctedFiling) ||
      attempt.payload_hash !== reviewCampaignFilingHash(correction.correctedFiling))
      throw new ReviewSmsError("review_sms_campaign_retry_changed");
  }
  await scope(c.account, c.business);
  const claim = await campaignAttemptRpc<string | null>("review_sms_claim_provisioning", { p_business: input.businessId });
  if (!claim) throw new ReviewSmsError("review_sms_provisioning_busy");
  let started = false;
  let campaignId: string | null = null;
  let phase = "preflight";
  try {
    const qualification = await telnyx.messaging10dlc.campaignBuilder.brand.qualifyByUsecase("MARKETING", { brandId: c.business.telnyx_brand_id }, { maxRetries: 0, timeout: 10000 });
    if (qualification.usecase !== "MARKETING") throw new ReviewSmsError("review_sms_campaign_qualification_changed");
    // Repeat the read immediately before the one-use fence, after any slow preflight.
    const fresh = await inspectSharedCampaignRetry(input.businessId, a.owner_id);
    if (fresh.inventory.records.some(r => [c.filing.referenceId, `${c.filing.referenceId}:r1`, `${c.filing.referenceId}:r2`].includes(r.referenceId ?? "")))
      throw new ReviewSmsError("review_sms_campaign_recovery_required");
    assertEnabled(input.businessId);
    const reserved = await campaignAttemptRpc<{submit: boolean}>("review_sms_begin_campaign_retry", {
      p_business: input.businessId, p_attempt: input.attemptId, p_token: input.token, p_claim: claim,
      p_observed_campaign_ids: fresh.inventory.records.map(r => r.campaignId), p_provider_verified_at: fresh.verifiedAt,
    });
    if (reserved.submit) {
      started = true;
      phase = "submit";
      const response = await telnyx.messaging10dlc.campaignBuilder.submit(
        attempt.filing as ReturnType<typeof buildReviewCampaignFiling>, { maxRetries: 0, timeout: 10000 },
      );
      if (!response || typeof response.campaignId !== "string" || !response.campaignId.trim())
        throw new ReviewSmsError("review_sms_campaign_response_invalid");
      campaignId = response.campaignId;
      phase = "verify_and_attach";
      const result = await attachObservedAttempt(attempt, claim, campaignId);
      if (!result.attached) throw new ReviewSmsError("review_sms_campaign_save_recovery_required", 503);
    }
  } catch (error) {
    if (started) await captureReviewCampaignFailure({ businessId: input.businessId, attemptId: attempt.id, claim, phase, error,
      sensitiveValues: campaignPrivateValues(c.business), responseCampaignId: campaignId });
    throw error;
  } finally {
    const { error } = await db.from("review_sms_accounts").update({ provisioning_claim: null, provisioning_lease_until: null })
      .eq("id", a.id).eq("provisioning_claim", claim);
    if (error) throw new ReviewSmsError("review_sms_state_unavailable", 503);
  }
  return inspectReviewCampaignRetry(input.businessId);
}
