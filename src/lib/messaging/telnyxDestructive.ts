import "server-only";

import { telnyx } from "@/lib/messaging/client";
import { supabaseAdmin } from "@/lib/supabase/admin";

export type TelnyxRemoteMutationContext =
  | "release_worker"
  | "review_sms_release"
  | "rejection_recovery";

export type TelnyxRemoteMutationOperation =
  | "release_phone_number"
  | "unassign_phone_number_campaign"
  | "deactivate_campaign"
  | "delete_brand"
  | "delete_messaging_profile"
  | "delete_voice_application";

export interface TelnyxRemoteMutationScope {
  businessId: string;
  context: TelnyxRemoteMutationContext;
  providerId: string | null;
  actionId?: string | null;
  leaseToken?: string | null;
}

export type TelnyxCampaignDeactivationDecision = "proceed" | "skip";
export type TelnyxCampaignDeactivationResult = "deactivated" | "skipped";

export interface TelnyxCampaignDeactivationOptions {
  /**
   * Durable caller-owned fence written after both database authorization
   * checks and the first runtime-gate check. Returning "skip" means another
   * invocation already owns or completed the provider attempt.
   */
  beforeMutation: () => Promise<TelnyxCampaignDeactivationDecision>;
}

interface AuthorizedTelnyxRemoteMutation {
  authorized: true;
  business_id: string;
  context: TelnyxRemoteMutationContext;
  operation: TelnyxRemoteMutationOperation;
  action_id: string | null;
  provider_id: string | null;
  canonical_e164: string | null;
  public_tcr_id: string | null;
  config_updated_at: string;
}

interface TelnyxRemoteMutationPermit {
  authorization: AuthorizedTelnyxRemoteMutation;
  protectedIds: {
    messagingProfileId: string;
    voiceApplicationId: string;
  };
}

export type TelnyxRemoteMutationDenialReason =
  | "kill_switch_disabled"
  | "protected_identifier_configuration_invalid"
  | "protected_identifier_configuration_changed"
  | "authorization_rpc_failed"
  | "authorization_response_invalid"
  | "authorization_response_mismatch"
  | "authorized_target_missing"
  | "deactivation_fence_missing"
  | "deactivation_fence_decision_invalid";

/**
 * A fail-closed refusal to perform a destructive Telnyx mutation.
 *
 * Callers must rethrow this error. In particular, recovery code must not
 * convert it into a best-effort provider failure and then clear local IDs.
 */
export class TelnyxRemoteMutationAuthorizationError extends Error {
  readonly code = "telnyx_remote_mutation_not_authorized" as const;
  readonly reason: TelnyxRemoteMutationDenialReason;

  constructor(reason: TelnyxRemoteMutationDenialReason, cause?: unknown) {
    super(`Destructive Telnyx mutation denied: ${reason}`, { cause });
    this.name = "TelnyxRemoteMutationAuthorizationError";
    this.reason = reason;
  }
}

function deny(
  reason: TelnyxRemoteMutationDenialReason,
  cause?: unknown
): never {
  throw new TelnyxRemoteMutationAuthorizationError(reason, cause);
}

function assertRemoteReleaseEnabled(): void {
  // Deliberately accept one value only. Values such as "true", "yes", and
  // "01" must fail closed so a loose deployment setting cannot release data.
  if (process.env.TELNYX_REMOTE_RELEASE_ENABLED !== "1") {
    deny("kill_switch_disabled");
  }
}

function protectedIdentifierConfiguration(): {
  messagingProfileId: string;
  voiceApplicationId: string;
} {
  const messagingProfileId =
    process.env.TELNYX_PROTECTED_MESSAGING_PROFILE_ID;
  const voiceApplicationId =
    process.env.TELNYX_PROTECTED_VOICE_APPLICATION_ID;

  if (
    typeof messagingProfileId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      messagingProfileId
    ) ||
    typeof voiceApplicationId !== "string" ||
    !/^[0-9]+$/.test(voiceApplicationId)
  ) {
    deny("protected_identifier_configuration_invalid");
  }

  return { messagingProfileId, voiceApplicationId };
}

function recheckRuntimeGate(expectedProtectedIds: {
  messagingProfileId: string;
  voiceApplicationId: string;
}): void {
  assertRemoteReleaseEnabled();
  const currentProtectedIds = protectedIdentifierConfiguration();
  if (
    currentProtectedIds.messagingProfileId !==
      expectedProtectedIds.messagingProfileId ||
    currentProtectedIds.voiceApplicationId !==
      expectedProtectedIds.voiceApplicationId
  ) {
    deny("protected_identifier_configuration_changed");
  }
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseAuthorizationResponse(
  value: unknown
): AuthorizedTelnyxRemoteMutation {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    deny("authorization_response_invalid");
  }

  const response = value as Record<string, unknown>;
  const expectedKeys = [
    "action_id",
    "authorized",
    "business_id",
    "canonical_e164",
    "config_updated_at",
    "context",
    "operation",
    "provider_id",
    "public_tcr_id",
  ];
  const actualKeys = Object.keys(response).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    response.authorized !== true ||
    typeof response.business_id !== "string" ||
    typeof response.context !== "string" ||
    !["release_worker", "rejection_recovery", "review_sms_release"].includes(response.context) ||
    typeof response.operation !== "string" ||
    ![
      "release_phone_number",
      "unassign_phone_number_campaign",
      "deactivate_campaign",
      "delete_brand",
      "delete_messaging_profile",
      "delete_voice_application",
    ].includes(response.operation) ||
    !isNullableString(response.action_id) ||
    !isNullableString(response.provider_id) ||
    !isNullableString(response.canonical_e164) ||
    !isNullableString(response.public_tcr_id) ||
    typeof response.config_updated_at !== "string" ||
    response.config_updated_at.length === 0 ||
    !Number.isFinite(Date.parse(response.config_updated_at))
  ) {
    deny("authorization_response_invalid");
  }

  return response as unknown as AuthorizedTelnyxRemoteMutation;
}

async function authorizeTelnyxRemoteMutation(
  scope: TelnyxRemoteMutationScope,
  operation: TelnyxRemoteMutationOperation
): Promise<TelnyxRemoteMutationPermit> {
  assertRemoteReleaseEnabled();
  const protectedIds = protectedIdentifierConfiguration();
  const requestedActionId = scope.actionId ?? null;

  let data: unknown = null;
  let rpcError: unknown = null;
  try {
    const result = await supabaseAdmin.rpc(
      scope.context === "review_sms_release" ? "authorize_review_sms_remote_mutation" : "authorize_telnyx_remote_mutation",
      {
        p_business_id: scope.businessId,
        p_context: scope.context,
        p_operation: operation,
        p_provider_id: scope.providerId,
        p_action_id: requestedActionId,
        p_lease_token: scope.leaseToken ?? null,
        p_expected_shared_messaging_profile_id:
          protectedIds.messagingProfileId,
        p_expected_shared_voice_application_id:
          protectedIds.voiceApplicationId,
      }
    );
    data = result.data;
    rpcError = result.error;
  } catch (error) {
    deny("authorization_rpc_failed", error);
  }

  if (rpcError) {
    deny("authorization_rpc_failed", rpcError);
  }

  const authorization = parseAuthorizationResponse(data);
  if (
    authorization.business_id !== scope.businessId ||
    authorization.context !== scope.context ||
    authorization.operation !== operation ||
    authorization.action_id !== requestedActionId
  ) {
    deny("authorization_response_mismatch");
  }

  return { authorization, protectedIds };
}

function sameAuthoritativeMutation(
  first: AuthorizedTelnyxRemoteMutation,
  second: AuthorizedTelnyxRemoteMutation
): boolean {
  return (
    first.authorized === second.authorized &&
    first.business_id === second.business_id &&
    first.context === second.context &&
    first.operation === second.operation &&
    first.action_id === second.action_id &&
    first.provider_id === second.provider_id &&
    first.canonical_e164 === second.canonical_e164 &&
    first.public_tcr_id === second.public_tcr_id &&
    first.config_updated_at === second.config_updated_at
  );
}

async function reauthorizeImmediatelyBeforeMutation(
  scope: TelnyxRemoteMutationScope,
  operation: TelnyxRemoteMutationOperation,
  firstPermit: TelnyxRemoteMutationPermit
): Promise<AuthorizedTelnyxRemoteMutation> {
  // This second check revokes a lease if database configuration, protection,
  // lifecycle state, or authoritative resource identity changed after the
  // first check. Telnyx cannot participate in the database transaction, so a
  // cross-system race after this check is irreducible; the synchronous env
  // recheck immediately before each SDK call is the final local kill switch.
  const secondPermit = await authorizeTelnyxRemoteMutation(scope, operation);
  if (
    !sameAuthoritativeMutation(
      firstPermit.authorization,
      secondPermit.authorization
    )
  ) {
    deny("authorization_response_mismatch");
  }
  return secondPermit.authorization;
}

function requiredProviderId(
  authorization: AuthorizedTelnyxRemoteMutation
): string {
  if (!authorization.provider_id) {
    deny("authorized_target_missing");
  }
  return authorization.provider_id;
}

function requiredCanonicalE164(
  authorization: AuthorizedTelnyxRemoteMutation
): string {
  if (!authorization.canonical_e164) {
    deny("authorized_target_missing");
  }
  return authorization.canonical_e164;
}

/** Preflight used by brand re-file before it mutates the child campaign. */
export async function preauthorizeTelnyxBrandDeletion(
  scope: TelnyxRemoteMutationScope
): Promise<void> {
  const { authorization } = await authorizeTelnyxRemoteMutation(
    scope,
    "delete_brand"
  );
  requiredProviderId(authorization);
}

export async function releaseTelnyxPhoneNumber(
  scope: TelnyxRemoteMutationScope
): Promise<void> {
  const firstPermit = await authorizeTelnyxRemoteMutation(
    scope,
    "release_phone_number"
  );
  const authorization = await reauthorizeImmediatelyBeforeMutation(
    scope,
    "release_phone_number",
    firstPermit
  );
  const providerId = requiredProviderId(authorization);
  recheckRuntimeGate(firstPermit.protectedIds);
  await telnyx.phoneNumbers.delete(providerId);
}

export async function unassignTelnyxPhoneNumberCampaign(
  scope: TelnyxRemoteMutationScope
): Promise<void> {
  const firstPermit = await authorizeTelnyxRemoteMutation(
    scope,
    "unassign_phone_number_campaign"
  );
  const authorization = await reauthorizeImmediatelyBeforeMutation(
    scope,
    "unassign_phone_number_campaign",
    firstPermit
  );
  const canonicalE164 = requiredCanonicalE164(authorization);
  recheckRuntimeGate(firstPermit.protectedIds);
  await telnyx.messaging10dlc.phoneNumberCampaigns.delete(canonicalE164);
}

export async function deactivateTelnyxCampaign(
  scope: TelnyxRemoteMutationScope,
  options: TelnyxCampaignDeactivationOptions
): Promise<TelnyxCampaignDeactivationResult> {
  if (typeof options?.beforeMutation !== "function") {
    deny("deactivation_fence_missing");
  }

  const firstPermit = await authorizeTelnyxRemoteMutation(
    scope,
    "deactivate_campaign"
  );
  const authorization = await reauthorizeImmediatelyBeforeMutation(
    scope,
    "deactivate_campaign",
    firstPermit
  );
  requiredProviderId(authorization);
  recheckRuntimeGate(firstPermit.protectedIds);

  const decision = await options.beforeMutation();
  if (decision !== "proceed" && decision !== "skip") {
    deny("deactivation_fence_decision_invalid");
  }

  // The durable fence above is asynchronous and can outlive a database state
  // change. Reauthorize once more after it so campaign status, ownership, and
  // the authoritative provider ID are still valid immediately before the
  // irreversible request. Callers release an unused fence on a typed denial.
  const finalAuthorization = await reauthorizeImmediatelyBeforeMutation(
    scope,
    "deactivate_campaign",
    firstPermit
  );
  const finalProviderId = requiredProviderId(finalAuthorization);

  if (decision === "skip") return "skipped";

  // Recheck the synchronous kill switch and protected identifiers after the
  // final database round trip as the last local authorization boundary.
  recheckRuntimeGate(firstPermit.protectedIds);
  await telnyx.messaging10dlc.campaign.deactivate(finalProviderId, {
    // A deactivation is not safely replayable after an ambiguous transport
    // result. The durable caller fence owns all subsequent retry decisions.
    maxRetries: 0,
  });
  return "deactivated";
}

export async function deleteTelnyxBrand(
  scope: TelnyxRemoteMutationScope
): Promise<void> {
  const firstPermit = await authorizeTelnyxRemoteMutation(
    scope,
    "delete_brand"
  );
  const authorization = await reauthorizeImmediatelyBeforeMutation(
    scope,
    "delete_brand",
    firstPermit
  );
  const providerId = requiredProviderId(authorization);
  recheckRuntimeGate(firstPermit.protectedIds);
  await telnyx.messaging10dlc.brand.delete(providerId);
}

export async function deleteTelnyxMessagingProfile(
  scope: TelnyxRemoteMutationScope
): Promise<void> {
  const firstPermit = await authorizeTelnyxRemoteMutation(
    scope,
    "delete_messaging_profile"
  );
  const authorization = await reauthorizeImmediatelyBeforeMutation(
    scope,
    "delete_messaging_profile",
    firstPermit
  );
  const providerId = requiredProviderId(authorization);
  recheckRuntimeGate(firstPermit.protectedIds);
  await telnyx.messagingProfiles.delete(providerId);
}

export async function deleteTelnyxVoiceApplication(
  scope: TelnyxRemoteMutationScope
): Promise<void> {
  const firstPermit = await authorizeTelnyxRemoteMutation(
    scope,
    "delete_voice_application"
  );
  const authorization = await reauthorizeImmediatelyBeforeMutation(
    scope,
    "delete_voice_application",
    firstPermit
  );
  const providerId = requiredProviderId(authorization);
  recheckRuntimeGate(firstPermit.protectedIds);
  await telnyx.callControlApplications.delete(providerId);
}
