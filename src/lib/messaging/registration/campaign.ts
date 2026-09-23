import { randomUUID } from "node:crypto";
import { normalizeHttpsGoalUrl } from "@/lib/goals/primaryGoal";
import { telnyx } from "@/lib/messaging/client";
import {
  deactivateTelnyxCampaign,
  TelnyxRemoteMutationAuthorizationError,
} from "@/lib/messaging/telnyxDestructive";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getActiveSmsNumberForBusiness } from "@/lib/messaging/phoneNumberLookup";
import { appendRegistrationEvent, serializeError } from "./audit";
import {
  buildCampaignMessageFlow,
  CampaignMessageFlowError,
} from "./campaignMessageFlow";
import { resolveLegalUrls, type PrivacyTermsMode } from "./legalUrls";
import {
  buildA2pRiskInputForBusiness,
  hashA2pRiskInput,
} from "./riskScreening";
import { mapCampaignStatus } from "./statusMapper";
import type { PrimaryGoal } from "@/types/database";
import {
  CarrierRejectionSupportRequiredError,
  throwIfCarrierRejected,
} from "@/lib/onboarding/rejectionGuidance";

function appBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_APP_URL;
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_APP_URL is not set — required for Telnyx webhook URLs"
    );
  }
  return url.replace(/\/+$/, "");
}

const HELP_KEYWORDS = "HELP,INFO";
const OPTOUT_KEYWORDS = "STOP,END,UNSUBSCRIBE,CANCEL,QUIT";
const OPTIN_KEYWORDS = "START,SUBSCRIBE,YES";
const CAMPAIGN_USECASE = "CUSTOMER_CARE";
const TELNYX_BRAND_CAMPAIGN_CAP = 5;
const TELNYX_CAMPAIGN_SAMPLE_MAX_CHARACTERS = 255;
const TELNYX_BRAND_CAMPAIGN_CAP_MESSAGE =
  "This Telnyx brand is at Telnyx's campaign cap: it already has 5 campaigns, the maximum allowed per brand. SimplAssist cannot create the additional campaign required for this account. Use a different eligible brand or contact Telnyx Support before approving this link.";

export type CampaignRegistrationErrorCode =
  | "campaign_recovery_provider_unavailable"
  | "campaign_recovery_malformed_response"
  | "campaign_recovery_multiple_matches"
  | "campaign_recovery_persist_failed"
  | "campaign_recovery_history_unavailable"
  | "campaign_recovery_history_invalid"
  | "campaign_recovered_rejected"
  | "campaign_submit_malformed_response"
  | "campaign_signup_goal_url_invalid"
  | "campaign_signup_sample_too_long"
  | "campaign_signup_sample_persist_failed"
  | "telnyx_brand_campaign_cap_reached";

export type CampaignRegistrationErrorKind = "transient" | "permanent";

/** Stable, provider-payload-free failures that launch can classify safely. */
export class CampaignRegistrationError extends Error {
  readonly code: CampaignRegistrationErrorCode;
  readonly kind: CampaignRegistrationErrorKind;

  constructor(options: {
    code: CampaignRegistrationErrorCode;
    kind: CampaignRegistrationErrorKind;
    message: string;
  }) {
    super(options.message);
    this.name = "CampaignRegistrationError";
    this.code = options.code;
    this.kind = options.kind;
  }
}

export type CampaignDeactivationStateErrorCode =
  | "campaign_deactivation_fence_unavailable"
  | "campaign_deactivation_reconciliation_required"
  | "campaign_deactivation_outcome_persist_failed";

/**
 * A local durability failure around the at-most-once campaign-deactivation
 * fence. These errors always stop pointer cleanup; Retry may either acquire a
 * never-persisted fence or fail closed on an unresolved prior attempt.
 */
export class CampaignDeactivationStateError extends Error {
  readonly code: CampaignDeactivationStateErrorCode;

  constructor(
    code: CampaignDeactivationStateErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "CampaignDeactivationStateError";
    this.code = code;
  }
}

const CAMPAIGN_DEACTIVATION_ATTEMPT_PREFIX =
  "SIMPLASSIST_CAMPAIGN_DEACTIVATION_ATTEMPT_V1:";
const CAMPAIGN_DEACTIVATION_READY =
  "SIMPLASSIST_CAMPAIGN_DEACTIVATION_READY_V1";
const CAMPAIGN_DEACTIVATION_PROVIDER_ERROR_PREFIX =
  "SIMPLASSIST_CAMPAIGN_DEACTIVATION_PROVIDER_ERROR_V1:";
const CAMPAIGN_DEACTIVATION_SUCCESS_UNCONFIRMED =
  "Telnyx campaign deactivation returned success, but SimplAssist could not persist confirmation. Manual reconciliation is required; automatic deactivation will not be retried.";

interface RejectedCampaignDeactivationState {
  id: string;
  telnyx_deactivated: boolean | null;
  deactivation_error: string | null;
}

type RecoveredCampaignStatus = "pending" | "approved" | "rejected";

interface CampaignListItem {
  brandId?: string | null;
  campaignId?: string | null;
  campaignStatus?: string | null;
  failureReasons?: string | null;
  referenceId?: string | null;
}

const CAMPAIGN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TELNYX_CAMPAIGN_STATUSES = new Set([
  "TCR_PENDING",
  "TCR_SUSPENDED",
  "TCR_EXPIRED",
  "TCR_ACCEPTED",
  "TCR_FAILED",
  "TELNYX_ACCEPTED",
  "TELNYX_FAILED",
  "MNO_PENDING",
  "MNO_ACCEPTED",
  "MNO_REJECTED",
  "MNO_PROVISIONED",
  "MNO_PROVISIONING_FAILED",
]);

function campaignRecoveryError(
  code: CampaignRegistrationErrorCode,
  kind: CampaignRegistrationErrorKind,
  message: string
): CampaignRegistrationError {
  return new CampaignRegistrationError({ code, kind, message });
}

function cleanBusinessName(value: string): string {
  const cleaned = value.trim();
  return cleaned || "Your Business";
}

function buildGoalAwareCampaignFiling(input: {
  businessName: string;
  primaryGoal: PrimaryGoal | null;
  goalUrl: string | null;
  samples: string[];
}): {
  samples: string[];
  embeddedLink: boolean;
  persistSamples: boolean;
} {
  if (input.primaryGoal !== "signup") {
    return {
      samples: input.samples,
      embeddedLink: false,
      persistSamples: false,
    };
  }

  const normalizedGoalUrl = normalizeHttpsGoalUrl(input.goalUrl);
  if (!normalizedGoalUrl) {
    throw campaignRecoveryError(
      "campaign_signup_goal_url_invalid",
      "permanent",
      "Add a valid HTTPS signup link for your primary goal before retrying SMS registration."
    );
  }

  if (
    input.samples
      .slice(0, 5)
      .some((sample) => sample.includes(normalizedGoalUrl))
  ) {
    return {
      samples: input.samples,
      embeddedLink: true,
      persistSamples: false,
    };
  }

  const signupSample = `Thanks for contacting ${cleanBusinessName(input.businessName)}. To sign up, visit ${normalizedGoalUrl}. Reply STOP to opt out.`;
  if (signupSample.length > TELNYX_CAMPAIGN_SAMPLE_MAX_CHARACTERS) {
    throw campaignRecoveryError(
      "campaign_signup_sample_too_long",
      "permanent",
      "The signup link is too long for a carrier campaign sample. Add a shorter direct HTTPS signup link before retrying SMS registration."
    );
  }

  const filingSamples = [...input.samples];
  filingSamples[2] = signupSample;
  return {
    samples: filingSamples,
    embeddedLink: true,
    persistSamples: true,
  };
}

function isValidCampaignId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    CAMPAIGN_ID_PATTERN.test(value.trim())
  );
}

async function readArchivedCampaignIds(businessId: string): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin
    .from("rejected_campaigns")
    .select("telnyx_campaign_id")
    .eq("business_id", businessId);

  if (error) {
    throw campaignRecoveryError(
      "campaign_recovery_history_unavailable",
      "transient",
      "SimplAssist could not verify the prior campaign history. No new campaign was created; try again shortly."
    );
  }

  if (!Array.isArray(data)) {
    throw campaignRecoveryError(
      "campaign_recovery_history_invalid",
      "permanent",
      "SimplAssist found invalid prior campaign history. Contact SimplAssist Support before retrying."
    );
  }

  const archived = new Set<string>();
  for (const row of data ?? []) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw campaignRecoveryError(
        "campaign_recovery_history_invalid",
        "permanent",
        "SimplAssist found invalid prior campaign history. Contact SimplAssist Support before retrying."
      );
    }
    const campaignId = (row as { telnyx_campaign_id?: unknown })
      .telnyx_campaign_id;
    if (!isValidCampaignId(campaignId)) {
      throw campaignRecoveryError(
        "campaign_recovery_history_invalid",
        "permanent",
        "SimplAssist found invalid prior campaign history. Contact SimplAssist Support before retrying."
      );
    }
    archived.add(campaignId.trim());
  }
  return archived;
}

function recoveredCampaignStatus(campaignStatus: string): RecoveredCampaignStatus {
  const mapped = mapCampaignStatus({ campaignStatus });
  return mapped.dbStatus ?? "pending";
}

/**
 * Recover a campaign created by an earlier submit whose local save failed.
 * The caller-supplied referenceId is the business UUID, so an exact match is
 * safe to adopt. This runs on every registration attempt while the local
 * campaign pointer is empty; a failed save therefore relists on the retry.
 */
async function recoverCampaignBeforeCreate(
  businessId: string,
  telnyxBrandId: string
): Promise<boolean> {
  const matches: CampaignListItem[] = [];
  let totalCampaigns = 0;
  const archivedCampaignIds = await readArchivedCampaignIds(businessId);

  try {
    const campaigns = telnyx.messaging10dlc.campaign.list({
      brandId: telnyxBrandId,
      recordsPerPage: 10,
    });

    for await (const listed of campaigns) {
      if (!listed || typeof listed !== "object" || Array.isArray(listed)) {
        throw campaignRecoveryError(
          "campaign_recovery_malformed_response",
          "permanent",
          "Telnyx returned an incomplete campaign list. Contact SimplAssist Support before retrying."
        );
      }
      const campaign = listed as CampaignListItem;
      // campaignId is the stable identity of every list row. Without it we
      // cannot safely distinguish or recover provider resources.
      if (!isValidCampaignId(campaign.campaignId)) {
        throw campaignRecoveryError(
          "campaign_recovery_malformed_response",
          "permanent",
          "Telnyx returned an incomplete campaign list. Contact SimplAssist Support before retrying."
        );
      }

      const campaignId = campaign.campaignId.trim();
      // Historical staff cleanup may archive, deactivate, and clear a
      // campaign pointer. Telnyx keeps terminated records in list results;
      // never re-adopt or count one that this business already archived.
      if (archivedCampaignIds.has(campaignId)) continue;

      totalCampaigns += 1;

      if (
        campaign.referenceId !== undefined &&
        campaign.referenceId !== null &&
        typeof campaign.referenceId !== "string"
      ) {
        throw campaignRecoveryError(
          "campaign_recovery_malformed_response",
          "permanent",
          "Telnyx returned an incomplete campaign list. Contact SimplAssist Support before retrying."
        );
      }

      if (campaign.referenceId !== businessId) continue;

      if (
        typeof campaign.brandId !== "string" ||
        campaign.brandId.length === 0 ||
        campaign.brandId.trim().toLowerCase() !== telnyxBrandId.toLowerCase() ||
        typeof campaign.campaignStatus !== "string" ||
        !TELNYX_CAMPAIGN_STATUSES.has(campaign.campaignStatus)
      ) {
        throw campaignRecoveryError(
          "campaign_recovery_malformed_response",
          "permanent",
          "Telnyx returned an incomplete matching campaign. Contact SimplAssist Support before retrying."
        );
      }
      if (
        campaign.failureReasons !== undefined &&
        campaign.failureReasons !== null &&
        typeof campaign.failureReasons !== "string"
      ) {
        throw campaignRecoveryError(
          "campaign_recovery_malformed_response",
          "permanent",
          "Telnyx returned an incomplete matching campaign. Contact SimplAssist Support before retrying."
        );
      }

      matches.push({
        ...campaign,
        campaignId,
        brandId: campaign.brandId.trim(),
      });
    }
  } catch (error) {
    if (error instanceof CampaignRegistrationError) throw error;
    throw campaignRecoveryError(
      "campaign_recovery_provider_unavailable",
      "transient",
      "Telnyx could not check for an existing campaign. No new campaign was created; try again shortly."
    );
  }

  if (matches.length > 1) {
    throw campaignRecoveryError(
      "campaign_recovery_multiple_matches",
      "permanent",
      "More than one Telnyx campaign matches this SimplAssist business. Contact SimplAssist Support before retrying."
    );
  }

  if (matches.length === 0) {
    if (totalCampaigns >= TELNYX_BRAND_CAMPAIGN_CAP) {
      throw campaignRecoveryError(
        "telnyx_brand_campaign_cap_reached",
        "permanent",
        TELNYX_BRAND_CAMPAIGN_CAP_MESSAGE
      );
    }
    return false;
  }

  // Recovery takes precedence over the cap: this does not create a sixth
  // campaign, so it remains safe even when the brand currently has five.
  const recovered = matches[0];
  const status = recoveredCampaignStatus(recovered.campaignStatus!);
  const rejectionReason =
    status === "rejected"
      ? recovered.failureReasons?.trim() ||
        "Telnyx reported that the recovered campaign was rejected."
      : null;
  const now = new Date().toISOString();

  const { data: persisted, error: updateError } = await supabaseAdmin
    .from("businesses")
    .update({
      telnyx_campaign_id: recovered.campaignId,
      campaign_status: status,
      campaign_status_updated_at: now,
      campaign_rejection_reason: rejectionReason,
    })
    .eq("id", businessId)
    // Never overwrite a campaign another request persisted concurrently.
    .is("telnyx_campaign_id", null)
    .select("id")
    .maybeSingle<{ id: string }>();

  if (updateError || !persisted) {
    throw campaignRecoveryError(
      "campaign_recovery_persist_failed",
      "transient",
      "SimplAssist found the existing Telnyx campaign but could not save it. No new campaign was created; retry shortly."
    );
  }

  await appendRegistrationEvent({
    businessId,
    eventType: "campaign_submitted",
    resourceType: "campaign",
    resourceId: recovered.campaignId,
    status,
    rejectionReason,
    rawPayload: {
      _recovery: {
        source: "telnyx_campaign_list",
        referenceIdMatched: true,
      },
    },
  });

  if (status === "rejected") {
    throw new CarrierRejectionSupportRequiredError({
      carrierReason: rejectionReason,
      rejectedResource: "campaign",
    });
  }

  return true;
}

function isCampaignDeactivationAttempt(value: string | null): boolean {
  return value?.startsWith(CAMPAIGN_DEACTIVATION_ATTEMPT_PREFIX) ?? false;
}

function isCampaignDeactivationReady(value: string | null): boolean {
  return value === CAMPAIGN_DEACTIVATION_READY;
}

async function readCampaignDeactivationState({
  historyId,
  businessId,
  campaignId,
  errorCode,
}: {
  historyId: string;
  businessId: string;
  campaignId: string;
  errorCode: CampaignDeactivationStateErrorCode;
}): Promise<RejectedCampaignDeactivationState> {
  const { data, error } = await supabaseAdmin
    .from("rejected_campaigns")
    .select("id, telnyx_deactivated, deactivation_error")
    .eq("id", historyId)
    .eq("business_id", businessId)
    .eq("telnyx_campaign_id", campaignId)
    .single<RejectedCampaignDeactivationState>();

  if (error || !data) {
    throw new CampaignDeactivationStateError(
      errorCode,
      `[registration:campaign] Could not verify campaign-deactivation state for ${businessId}: ${error?.message ?? "history row not found"}`
    );
  }
  return data;
}

async function claimCampaignDeactivationAttempt({
  historyId,
  businessId,
  campaignId,
}: {
  historyId: string;
  businessId: string;
  campaignId: string;
}): Promise<{ decision: "proceed"; token: string } | { decision: "skip" }> {
  const token = `${CAMPAIGN_DEACTIVATION_ATTEMPT_PREFIX}${new Date().toISOString()}:${randomUUID()}`;
  const { data: claimed, error } = await supabaseAdmin
    .from("rejected_campaigns")
    .update({ deactivation_error: token })
    .eq("id", historyId)
    .eq("business_id", businessId)
    .eq("telnyx_campaign_id", campaignId)
    .eq("telnyx_deactivated", false)
    .eq("deactivation_error", CAMPAIGN_DEACTIVATION_READY)
    .select("id")
    .maybeSingle<{ id: string }>();

  if (error) {
    throw new CampaignDeactivationStateError(
      "campaign_deactivation_fence_unavailable",
      `[registration:campaign] Could not persist the campaign-deactivation fence for ${businessId}: ${error.message}`
    );
  }
  if (claimed) return { decision: "proceed", token };

  // A zero-row CAS is never permission to call Telnyx. Re-read the exact
  // history row: a completed/terminal owner lets local cleanup resume, while
  // an unresolved owner fails closed so a concurrent request cannot race
  // ahead and clear the campaign pointer during its provider call.
  const current = await readCampaignDeactivationState({
    historyId,
    businessId,
    campaignId,
    errorCode: "campaign_deactivation_fence_unavailable",
  });
  if (current.telnyx_deactivated === true) return { decision: "skip" };
  if (current.telnyx_deactivated !== false) {
    throw new CampaignDeactivationStateError(
      "campaign_deactivation_reconciliation_required",
      `[registration:campaign] Campaign-deactivation state is invalid for ${businessId}; reconcile it before retrying`
    );
  }
  if (isCampaignDeactivationAttempt(current.deactivation_error)) {
    throw new CampaignDeactivationStateError(
      "campaign_deactivation_reconciliation_required",
      `[registration:campaign] Campaign deactivation for ${businessId} has an unresolved provider attempt; reconcile it before retrying`
    );
  }
  if (isCampaignDeactivationReady(current.deactivation_error)) {
    throw new CampaignDeactivationStateError(
      "campaign_deactivation_fence_unavailable",
      `[registration:campaign] Campaign-deactivation fence ownership could not be confirmed for ${businessId}`
    );
  }
  if (current.deactivation_error === null) {
    throw new CampaignDeactivationStateError(
      "campaign_deactivation_reconciliation_required",
      `[registration:campaign] Campaign ${campaignId} has legacy ambiguous deactivation state; reconcile it before retrying`
    );
  }
  return { decision: "skip" };
}

async function transitionOwnedCampaignDeactivationAttempt({
  historyId,
  businessId,
  campaignId,
  token,
  values,
  errorCode,
  detail,
}: {
  historyId: string;
  businessId: string;
  campaignId: string;
  token: string;
  values: { telnyx_deactivated?: boolean; deactivation_error: string | null };
  errorCode: CampaignDeactivationStateErrorCode;
  detail: string;
}): Promise<void> {
  const { data: transitioned, error } = await supabaseAdmin
    .from("rejected_campaigns")
    .update(values)
    .eq("id", historyId)
    .eq("business_id", businessId)
    .eq("telnyx_campaign_id", campaignId)
    .eq("telnyx_deactivated", false)
    .eq("deactivation_error", token)
    .select("id")
    .maybeSingle<{ id: string }>();

  if (!error && transitioned) return;

  const current = await readCampaignDeactivationState({
    historyId,
    businessId,
    campaignId,
    errorCode,
  });
  // An ambiguous database response may have committed the requested terminal
  // state. Any state no longer owned by this attempt is durably closed to a
  // second automatic provider call, so the caller can preserve the original
  // operation outcome instead of attempting another transition.
  if (
    current.telnyx_deactivated === true ||
    (current.telnyx_deactivated === false &&
      current.deactivation_error !== null &&
      !isCampaignDeactivationAttempt(current.deactivation_error) &&
      !isCampaignDeactivationReady(current.deactivation_error) &&
      current.deactivation_error !== token)
  ) {
    return;
  }

  throw new CampaignDeactivationStateError(
    errorCode,
    `[registration:campaign] ${detail} for ${businessId}: ${error?.message ?? "state transition affected no row"}`
  );
}

async function releaseCampaignDeactivationAttempt({
  historyId,
  businessId,
  campaignId,
  token,
}: {
  historyId: string;
  businessId: string;
  campaignId: string;
  token: string;
}): Promise<void> {
  const { data: released, error } = await supabaseAdmin
    .from("rejected_campaigns")
    .update({ deactivation_error: CAMPAIGN_DEACTIVATION_READY })
    .eq("id", historyId)
    .eq("business_id", businessId)
    .eq("telnyx_campaign_id", campaignId)
    .eq("telnyx_deactivated", false)
    .eq("deactivation_error", token)
    .select("id")
    .maybeSingle<{ id: string }>();

  if (!error && released) return;

  const current = await readCampaignDeactivationState({
    historyId,
    businessId,
    campaignId,
    errorCode: "campaign_deactivation_fence_unavailable",
  });
  if (current.deactivation_error !== token) return;

  throw new CampaignDeactivationStateError(
    "campaign_deactivation_fence_unavailable",
    `[registration:campaign] Could not release the unused campaign-deactivation fence for ${businessId}: ${error?.message ?? "state transition affected no row"}`
  );
}

/**
 * Why staff tooling archived the campaign. 'campaign_rejected' records direct
 * campaign recovery. 'brand_refile' records brand-level recovery: a
 * campaign is bound to its brandId at TCR and cannot be adopted by the
 * replacement brand, and Telnyx refuses to delete a brand that still has
 * active campaigns — so the brand recovery helper archives the child
 * campaign whatever state it is in.
 */
export type CampaignArchiveCause = "campaign_rejected" | "brand_refile";

/**
 * Dormant staff-recovery primitive for a carrier-rejected campaign. It
 * preserves the rejected campaign's ID and details in rejected_campaigns,
 * deactivates it at Telnyx best-effort, and clears the local pointer so an
 * explicitly authorized workflow could create a replacement. Customer
 * launch/retry paths must never call this helper.
 * A typed safety-boundary denial is never treated as a provider failure: it
 * aborts recovery with every local provider pointer intact.
 *
 * Default cause 'campaign_rejected': no-op unless campaign_status is
 * 'rejected' with a campaign ID present. Cause 'brand_refile' archives the
 * campaign in ANY status (it only requires a campaign ID) — see
 * CampaignArchiveCause for why brand recovery cannot keep the old campaign.
 * Safe to re-run after a partial failure: the history row is reused and an
 * already-deactivated campaign is not re-deactivated.
 */
export async function archiveAndClearRejectedCampaign(
  businessId: string,
  options: { cause?: CampaignArchiveCause } = {}
): Promise<void> {
  const cause = options.cause ?? "campaign_rejected";
  const { data: business, error: readError } = await supabaseAdmin
    .from("businesses")
    .select("id, telnyx_campaign_id, campaign_status, campaign_rejection_reason")
    .eq("id", businessId)
    .single<{
      id: string;
      telnyx_campaign_id: string | null;
      campaign_status: string | null;
      campaign_rejection_reason: string | null;
    }>();

  if (readError || !business) {
    throw new Error(
      `[registration:campaign] Business ${businessId} not found for rejected-campaign recovery: ${readError?.message}`
    );
  }

  if (!business.telnyx_campaign_id) {
    return;
  }

  if (cause === "campaign_rejected" && business.campaign_status !== "rejected") {
    return;
  }

  const campaignId = business.telnyx_campaign_id;

  // 1. Preserve history before anything is repointed (reuse the row if a
  //    prior partial run already archived this campaign).
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("rejected_campaigns")
    .select("id, telnyx_deactivated, deactivation_error")
    .eq("business_id", businessId)
    .eq("telnyx_campaign_id", campaignId)
    .maybeSingle<RejectedCampaignDeactivationState>();

  if (existingError) {
    // Fail loudly rather than risk duplicating history or re-deactivating:
    // the thrown error keeps the attempt in a retryable state.
    throw new Error(
      `[registration:campaign] Failed to read rejected-campaign history for ${businessId}: ${existingError.message}`
    );
  }

  let historyState = existing ?? null;
  if (!historyState) {
    const { data: inserted, error: historyError } = await supabaseAdmin
      .from("rejected_campaigns")
      .insert({
        business_id: businessId,
        telnyx_campaign_id: campaignId,
        telnyx_deactivated: false,
        // Explicitly distinguish a new, never-attempted row from legacy
        // false/null rows whose old best-effort marker write may have failed
        // after Telnyx was already called.
        deactivation_error: CAMPAIGN_DEACTIVATION_READY,
        // A brand re-file can archive a campaign that was never itself
        // rejected (still pending under the dead brand) — record why the
        // row exists instead of leaving the reason blank.
        rejection_reason:
          business.campaign_rejection_reason ??
          (cause === "brand_refile"
            ? "Archived during brand re-file: parent brand rejected"
            : null),
      })
      .select("id, telnyx_deactivated, deactivation_error")
      .single<RejectedCampaignDeactivationState>();

    if (historyError || !inserted) {
      throw new Error(
        `[registration:campaign] Failed to archive rejected campaign ${campaignId} for ${businessId}: ${historyError?.message}`
      );
    }
    historyState = inserted;
  }

  const historyId = historyState.id;

  if (historyState.telnyx_deactivated === null) {
    throw new CampaignDeactivationStateError(
      "campaign_deactivation_reconciliation_required",
      `[registration:campaign] Campaign-deactivation state is invalid for ${businessId}; reconcile it before retrying`
    );
  }
  if (isCampaignDeactivationAttempt(historyState.deactivation_error)) {
    throw new CampaignDeactivationStateError(
      "campaign_deactivation_reconciliation_required",
      `[registration:campaign] Campaign deactivation for ${businessId} has an unresolved provider attempt; reconcile it before retrying`
    );
  }
  if (
    historyState.telnyx_deactivated === false &&
    historyState.deactivation_error === null
  ) {
    throw new CampaignDeactivationStateError(
      "campaign_deactivation_reconciliation_required",
      `[registration:campaign] Campaign ${campaignId} has legacy ambiguous deactivation state; reconcile it before retrying`
    );
  }

  // 2. Best-effort Telnyx deactivation — stops the rejected campaign's
  //    monthly billing. A durable compare-and-set fence is claimed inside the
  //    guarded adapter after preauthorization, then database authorization is
  //    checked once more before the SDK request. Once claimed, no Retry may
  //    issue another automatic request.
  //    Confirmed provider failures remain best-effort only after their
  //    terminal diagnostic is durably stored.
  if (
    historyState.telnyx_deactivated === false &&
    isCampaignDeactivationReady(historyState.deactivation_error)
  ) {
    let ownedAttemptToken: string | null = null;
    try {
      const result = await deactivateTelnyxCampaign(
        {
          businessId,
          context: "rejection_recovery",
          providerId: campaignId,
        },
        {
          beforeMutation: async () => {
            const claim = await claimCampaignDeactivationAttempt({
              historyId,
              businessId,
              campaignId,
            });
            if (claim.decision === "proceed") {
              ownedAttemptToken = claim.token;
            }
            return claim.decision;
          },
        }
      );

      if (result === "deactivated") {
        if (!ownedAttemptToken) {
          throw new CampaignDeactivationStateError(
            "campaign_deactivation_reconciliation_required",
            `[registration:campaign] Telnyx campaign deactivation for ${businessId} completed without confirmed fence ownership`
          );
        }

        try {
          await transitionOwnedCampaignDeactivationAttempt({
            historyId,
            businessId,
            campaignId,
            token: ownedAttemptToken,
            values: {
              telnyx_deactivated: true,
              deactivation_error: null,
            },
            errorCode: "campaign_deactivation_outcome_persist_failed",
            detail: "Could not persist confirmed Telnyx campaign deactivation",
          });
        } catch (confirmationError) {
          // Keep a terminal non-null outcome when the true/null marker cannot
          // be confirmed. Retry may finish local cleanup but may never issue a
          // second provider request.
          let terminalizationError: unknown = null;
          try {
            await transitionOwnedCampaignDeactivationAttempt({
              historyId,
              businessId,
              campaignId,
              token: ownedAttemptToken,
              values: {
                deactivation_error:
                  CAMPAIGN_DEACTIVATION_SUCCESS_UNCONFIRMED,
              },
              errorCode: "campaign_deactivation_outcome_persist_failed",
              detail:
                "Could not close the uncertain Telnyx campaign-deactivation outcome",
            });
          } catch (error) {
            terminalizationError = error;
          }

          throw new CampaignDeactivationStateError(
            "campaign_deactivation_outcome_persist_failed",
            `[registration:campaign] Telnyx campaign deactivation returned success for ${businessId}, but local confirmation failed; retry local cleanup without another provider call`,
            { cause: terminalizationError ?? confirmationError }
          );
        }
      }
    } catch (err) {
      if (err instanceof TelnyxRemoteMutationAuthorizationError) {
        if (ownedAttemptToken) {
          try {
            await releaseCampaignDeactivationAttempt({
              historyId,
              businessId,
              campaignId,
              token: ownedAttemptToken,
            });
          } catch (releaseError) {
            console.error(
              `[registration:campaign] Failed to release an unused campaign-deactivation fence for ${businessId}:`,
              releaseError
            );
          }
        }
        throw err;
      }
      if (err instanceof CampaignDeactivationStateError) throw err;
      if (!ownedAttemptToken) throw err;

      const message = err instanceof Error ? err.message : String(err);
      const terminalProviderError =
        `${CAMPAIGN_DEACTIVATION_PROVIDER_ERROR_PREFIX}${message}`.slice(
          0,
          2_000
        );
      console.error(
        `[registration:campaign] Best-effort deactivation of rejected campaign ${campaignId} failed for ${businessId} — needs manual cleanup:`,
        err
      );
      await transitionOwnedCampaignDeactivationAttempt({
        historyId,
        businessId,
        campaignId,
        token: ownedAttemptToken,
        values: {
          // Provider-controlled text is namespaced so it can never collide
          // with READY or an in-flight attempt control value.
          deactivation_error: terminalProviderError,
        },
        errorCode: "campaign_deactivation_outcome_persist_failed",
        detail: "Could not persist the Telnyx campaign-deactivation failure",
      });
    }
  }

  // 3. Reset the numbers' campaign-assignment state BEFORE clearing the
  //    campaign pointer: stale 'assigned'/failed rows referencing the old
  //    campaign would otherwise be skipped by the lazy-refresh gate and
  //    strand the number when the replacement campaign is approved. (Done
  //    before the pointer clear so a failure here leaves the helper
  //    re-runnable — the campaign pointer is still set, and under the
  //    default cause campaign_status is still 'rejected'.)
  const { error: assignmentResetError } = await supabaseAdmin
    .from("phone_numbers")
    .update({
      telnyx_campaign_assignment_status: "unassigned",
      telnyx_campaign_assignment_campaign_id: null,
      telnyx_campaign_assignment_task_id: null,
      telnyx_campaign_assignment_failure_reason: null,
      telnyx_campaign_assignment_updated_at: new Date().toISOString(),
    })
    .eq("business_id", businessId)
    .eq("is_active", true)
    // Never erase assignment state for a replacement campaign installed by
    // a concurrent recovery attempt.
    .eq("telnyx_campaign_assignment_campaign_id", campaignId);

  if (assignmentResetError) {
    throw new Error(
      `[registration:campaign] Failed to reset number assignment state for ${businessId}: ${assignmentResetError.message}`
    );
  }

  // 4. Clear the pointer so registerCampaign creates the replacement.
  const { data: cleared, error: clearError } = await supabaseAdmin
    .from("businesses")
    .update({
      telnyx_campaign_id: null,
      campaign_status: null,
      campaign_status_updated_at: new Date().toISOString(),
      campaign_rejection_reason: null,
    })
    .eq("id", businessId)
    .eq("telnyx_campaign_id", campaignId)
    .select("id")
    .maybeSingle<{ id: string }>();

  if (clearError) {
    throw new Error(
      `[registration:campaign] Failed to clear rejected campaign ${campaignId} for ${businessId}: ${clearError.message}`
    );
  }
  if (!cleared) {
    const { data: current, error: currentError } = await supabaseAdmin
      .from("businesses")
      .select("telnyx_campaign_id")
      .eq("id", businessId)
      .single<{ telnyx_campaign_id: string | null }>();

    if (currentError || !current) {
      throw new Error(
        `[registration:campaign] Could not verify concurrent campaign cleanup for ${businessId}: ${currentError?.message ?? "business not found"}`
      );
    }
    if (current.telnyx_campaign_id === campaignId) {
      throw new Error(
        `[registration:campaign] Rejected campaign ${campaignId} remained attached to ${businessId} after cleanup`
      );
    }
    // Null means another cleanup won; a different ID means a replacement was
    // already installed. In both cases this stale invocation must not write.
  }
}

export async function registerCampaign(businessId: string): Promise<void> {
  const { data: business, error: readError } = await supabaseAdmin
    .from("businesses")
    .select(
      "id, name, email, phone_number, telnyx_brand_id, telnyx_campaign_id, use_case_description, sample_messages, slug, privacy_terms_mode, privacy_url_override, terms_url_override, primary_goal, goal_url, brand_status, campaign_status, brand_rejection_reason, campaign_rejection_reason, ai_settings(language)"
    )
    .eq("id", businessId)
    .single<{
      id: string;
      name: string;
      email: string | null;
      phone_number: string | null;
      telnyx_brand_id: string | null;
      telnyx_campaign_id: string | null;
      use_case_description: string | null;
      sample_messages: string[] | null;
      slug: string;
      privacy_terms_mode: PrivacyTermsMode;
      privacy_url_override: string | null;
      terms_url_override: string | null;
      primary_goal: PrimaryGoal | null;
      goal_url: string | null;
      brand_status: string | null;
      campaign_status: string | null;
      brand_rejection_reason: string | null;
      campaign_rejection_reason: string | null;
      ai_settings: { language: "en" | "es" | "both" } | null;
    }>();

  if (readError || !business) {
    throw new Error(
      `[registration:campaign] Business ${businessId} not found: ${readError?.message}`
    );
  }

  // Existing IDs previously returned before the create-boundary refresh.
  // Check the same fresh row first so a rejection claimed as a retry cannot
  // be mistaken for a successfully reusable campaign.
  throwIfCarrierRejected({
    brandStatus: business.brand_status,
    campaignStatus: business.campaign_status,
    brandReason: business.brand_rejection_reason,
    campaignReason: business.campaign_rejection_reason,
  });

  if (business.telnyx_campaign_id) {
    return;
  }

  if (!business.telnyx_brand_id) {
    throw new Error(
      `[registration:campaign] Business ${businessId} has no telnyx_brand_id — register brand first`
    );
  }

  if (!business.use_case_description) {
    throw new Error(
      `[registration:campaign] Business ${businessId} is missing use_case_description`
    );
  }

  const samples = business.sample_messages ?? [];
  if (samples.length < 3) {
    throw new Error(
      `[registration:campaign] Business ${businessId} requires at least 3 sample messages (got ${samples.length})`
    );
  }

  // Submit is not atomic with our database write. If a prior attempt reached
  // Telnyx but failed while persisting the returned ID, recover that exact
  // referenceId before doing any preflight work or creating another campaign.
  if (
    await recoverCampaignBeforeCreate(businessId, business.telnyx_brand_id)
  ) {
    // Recovery may take a provider round trip. Preserve a concurrently landed
    // brand rejection even when the recovered campaign itself is pending or
    // approved.
    await assertNoCarrierRejectionBeforeCampaignSubmit(businessId);
    return;
  }

  const campaignFiling = buildGoalAwareCampaignFiling({
    businessName: business.name,
    primaryGoal: business.primary_goal,
    goalUrl: business.goal_url,
    samples,
  });
  const filingSamples = campaignFiling.samples;

  const webhookURL = `${appBaseUrl()}/api/messaging/registration/status`;

  // Phase 6: privacy + terms URLs submitted to Telnyx. Resolved BEFORE the
  // try/catch so a placeholder slug or missing override URL fails fast and
  // never reaches the Telnyx API (no wasted submission, no retry quota burn,
  // no half-submitted campaign in TCR). The pre-flight gate in
  // /api/onboarding/brand-verification is the primary safety net; this is
  // defense in depth.
  const { privacyUrl, termsUrl } = resolveLegalUrls(business);
  const smsEntryPoint = `${appBaseUrl()}/c/${business.slug}`;

  let campaignPreflightChecked = false;
  let submissionAuditSnapshot: Record<string, unknown> | null = null;

  try {
    const smsPhoneNumber = await getActiveSmsNumberForBusiness(businessId);
    if (!smsPhoneNumber) {
      throw new CampaignMessageFlowError({
        code: "campaign_sms_number_missing",
        kind: "transient",
        message:
          "Campaign submission requires an active SMS phone number in E.164 format.",
      });
    }

    // This is the final, mandatory-number generator. It validates E.164 and
    // enforces Telnyx's 2,048-character limit before any database rewrite,
    // provider preflight, or charged campaign submission can occur.
    const complianceCopy = buildCampaignMessageFlow({
      privacyUrl,
      smsPhoneNumber,
      smsEntryPoint,
      business,
      language: business.ai_settings?.language ?? "en",
    });
    const currentSubmissionAuditSnapshot = {
      privacyPolicyLink: privacyUrl,
      termsAndConditionsLink: termsUrl,
      messageFlow: complianceCopy.messageFlow,
      messageFlowCharacterCount: complianceCopy.messageFlowCharacterCount,
      smsPhoneNumber: complianceCopy.smsPhoneNumber,
      smsEntryPoint,
      confirmationSms: complianceCopy.confirmationSms,
      voicemailGreeting: complianceCopy.voicemailGreeting,
      optinMessage: complianceCopy.optinMessage,
      optoutMessage: complianceCopy.optoutMessage,
      helpMessage: complianceCopy.helpMessage,
    };
    submissionAuditSnapshot = currentSubmissionAuditSnapshot;

    // A paid Chat upgrade freezes customer-entered compliance details. Its
    // guarded RPC permits only this final generated filing copy while the
    // exact paid registration claim is still eligible to submit.
    const { data: upgradeCopySaved, error: upgradeCopyError } = await supabaseAdmin.rpc(
      "persist_chat_texting_upgrade_campaign_copy",
      {
        p_business_id: businessId,
        p_sample_messages: campaignFiling.persistSamples ? filingSamples : null,
        p_opt_in_description: complianceCopy.messageFlow,
      }
    );
    if (upgradeCopyError || typeof upgradeCopySaved !== "boolean") {
      throw new Error(
        `[registration:campaign] Failed to persist guarded campaign copy for business ${businessId}: ${upgradeCopyError?.message ?? "invalid result"}`
      );
    }

    if (!upgradeCopySaved && campaignFiling.persistSamples) {
      const { error: sampleMessagesUpdateError } = await supabaseAdmin
        .from("businesses")
        .update({ sample_messages: filingSamples })
        .eq("id", businessId);

      if (sampleMessagesUpdateError) {
        throw campaignRecoveryError(
          "campaign_signup_sample_persist_failed",
          "transient",
          "We couldn't save the required signup-link campaign sample. No campaign was submitted; please try again."
        );
      }
    }

    const { error: optInUpdateError } = upgradeCopySaved
      ? { error: null }
      : await supabaseAdmin
          .from("businesses")
          .update({ opt_in_description: complianceCopy.messageFlow })
          .eq("id", businessId);

    if (optInUpdateError) {
      throw new Error(
        `[registration:campaign] Failed to persist final opt-in description for business ${businessId}: ${optInUpdateError.message}`
      );
    }

    // The rewrite above changes a risk-hash input. For a business whose
    // screening decision stands (passed/admin_approved), restamp the stored
    // hash so this machine-induced drift can't invalidate the decision or
    // trigger a spurious re-screen on a later retry. Best-effort: a failed
    // restamp only costs one extra re-screen later.
    try {
      const { data: riskRow } = await supabaseAdmin
        .from("businesses")
        .select("a2p_risk_review_status")
        .eq("id", businessId)
        .single<{ a2p_risk_review_status: string | null }>();
      if (
        riskRow?.a2p_risk_review_status === "passed" ||
        riskRow?.a2p_risk_review_status === "admin_approved"
      ) {
        const { input } = await buildA2pRiskInputForBusiness(businessId);
        const { error: restampError } = await supabaseAdmin
          .from("businesses")
          .update({ a2p_risk_review_input_hash: hashA2pRiskInput(input) })
          .eq("id", businessId);
        if (restampError) {
          console.warn(
            `[registration:campaign] Risk-hash restamp write failed for ${businessId} (harmless; next retry re-screens once): ${restampError.message}`
          );
        }
      }
    } catch (err) {
      console.warn(
        `[registration:campaign] Risk-hash restamp after opt-in rewrite failed for ${businessId} (harmless; next retry re-screens once):`,
        err
      );
    }

    const [cost, qualification] = await Promise.all([
      telnyx.messaging10dlc.campaign.usecase.getCost({
        usecase: CAMPAIGN_USECASE,
      }),
      telnyx.messaging10dlc.campaignBuilder.brand.qualifyByUsecase(
        CAMPAIGN_USECASE,
        { brandId: business.telnyx_brand_id }
      ),
    ]);

    if (qualification.usecase && qualification.usecase !== CAMPAIGN_USECASE) {
      throw new Error(
        `[registration:campaign] Brand ${business.telnyx_brand_id} qualification returned unexpected usecase ${qualification.usecase}`
      );
    }

    console.log(
      `[registration:campaign] ${CAMPAIGN_USECASE} cost for business ${businessId}: monthly=${cost.monthlyCost} upfront=${cost.upFrontCost}`
    );

    await appendRegistrationEvent({
      businessId,
      eventType: "campaign_preflight_checked",
      resourceType: "campaign",
      status: "ok",
      rawPayload: {
        usecase: CAMPAIGN_USECASE,
        cost,
        qualification,
      },
    });
    campaignPreflightChecked = true;

    // This is the final database read before the charged Telnyx submission.
    // It closes the window where a brand or campaign rejection webhook lands
    // after paid launch began but before campaignBuilder.submit.
    await assertNoCarrierRejectionBeforeCampaignSubmit(businessId);

    const response = await telnyx.messaging10dlc.campaignBuilder.submit(
      {
        brandId: business.telnyx_brand_id,
        description: business.use_case_description,
        usecase: CAMPAIGN_USECASE,
        sample1: filingSamples[0],
        sample2: filingSamples[1],
        sample3: filingSamples[2],
        sample4: filingSamples[3],
        sample5: filingSamples[4],
        messageFlow: complianceCopy.messageFlow,
        subscriberOptin: true,
        optinKeywords: OPTIN_KEYWORDS,
        optinMessage: complianceCopy.optinMessage,
        subscriberOptout: true,
        optoutKeywords: OPTOUT_KEYWORDS,
        optoutMessage: complianceCopy.optoutMessage,
        subscriberHelp: true,
        helpKeywords: HELP_KEYWORDS,
        helpMessage: complianceCopy.helpMessage,
        // Boolean acceptance flag — REQUIRED by Telnyx, separate from the URL
        // fields below. Do not remove when refactoring URL handling.
        termsAndConditions: true,
        privacyPolicyLink: privacyUrl,
        termsAndConditionsLink: termsUrl,
        autoRenewal: true,
        embeddedLink: campaignFiling.embeddedLink,
        embeddedPhone: false,
        ageGated: false,
        numberPool: false,
        directLending: false,
        referenceId: businessId,
        webhookURL,
        webhookFailoverURL: webhookURL,
      },
      // This POST carries an upfront, non-refundable campaign charge. Do not
      // let the SDK replay an ambiguous success; Retry recovers by referenceId.
      { maxRetries: 0 }
    );

    const rawCampaignId = response.campaignId;
    if (!isValidCampaignId(rawCampaignId)) {
      throw campaignRecoveryError(
        "campaign_submit_malformed_response",
        "permanent",
        "Telnyx returned an invalid campaign identifier. Contact SimplAssist Support before retrying."
      );
    }
    const campaignId = rawCampaignId.trim();

    const { error: updateError } = await supabaseAdmin
      .from("businesses")
      .update({
        telnyx_campaign_id: campaignId,
        campaign_status: "pending",
        campaign_status_updated_at: new Date().toISOString(),
      })
      .eq("id", businessId);

    if (updateError) {
      throw new Error(
        `[registration:campaign] Failed to persist campaign id ${campaignId} for business ${businessId}: ${updateError.message}`
      );
    }

    await appendRegistrationEvent({
      businessId,
      eventType: "campaign_submitted",
      resourceType: "campaign",
      resourceId: campaignId,
      status: "pending",
      rawPayload: {
        ...(response as unknown as Record<string, unknown>),
        _submitted: currentSubmissionAuditSnapshot,
      },
    });
  } catch (err) {
    if (!campaignPreflightChecked) {
      await appendRegistrationEvent({
        businessId,
        eventType: "campaign_preflight_checked",
        resourceType: "campaign",
        status: "error",
        rawPayload: {
          usecase: CAMPAIGN_USECASE,
          error: serializeError(err),
        },
      });
    }

    await appendRegistrationEvent({
      businessId,
      eventType: "campaign_submitted",
      resourceType: "campaign",
      status: "error",
      rawPayload: {
        error: serializeError(err),
        ...(submissionAuditSnapshot
          ? { _submitted: submissionAuditSnapshot }
          : {}),
      },
    });
    throw err;
  }
}

async function assertNoCarrierRejectionBeforeCampaignSubmit(
  businessId: string
): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("businesses")
    .select(
      "brand_status, campaign_status, brand_rejection_reason, campaign_rejection_reason"
    )
    .eq("id", businessId)
    .single<{
      brand_status: string | null;
      campaign_status: string | null;
      brand_rejection_reason: string | null;
      campaign_rejection_reason: string | null;
    }>();

  if (error || !data) {
    throw new Error(
      `[registration:campaign] Failed to refresh carrier status before campaign submission for ${businessId}: ${error?.message ?? "business not found"}`
    );
  }

  throwIfCarrierRejected({
    brandStatus: data.brand_status,
    campaignStatus: data.campaign_status,
    brandReason: data.brand_rejection_reason,
    campaignReason: data.campaign_rejection_reason,
  });
}
