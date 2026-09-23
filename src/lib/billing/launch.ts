import "server-only";

import {
  resolveBusinessOperationalControls,
} from "@/lib/account/operationalControls.server";
import { resolveSmsProvisioningAccess } from "@/lib/billing/entitlements";
import { claimSmsLaunchPlanFamily } from "@/lib/billing/smsLaunchFamily.server";
import {
  assertTextingUpgradeProvisioningAllowed,
  reconcileTextingUpgradeActivationForBusiness,
  TextingUpgradeProvisioningStoppedError,
} from "@/lib/billing/textingUpgradeActivation.server";
import { planRequiresSmsProvisioning } from "@/lib/billing/features";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  attachOwnedNumberToCustomerProfile,
  findOwnedNumberId,
  normalizeTelnyxPhoneNumberResourceId,
  NUMBER_ORDER_CREATE_INTENT_SPEC,
  NumberTakenError,
  NumberUnavailableError,
  PurchasedNumberResolutionError,
  PurchasedNumberSaveError,
  purchaseNumber,
  TollFreeNumberUnsupportedError,
} from "@/lib/messaging/numbers";
import { getActiveSmsNumberForBusiness } from "@/lib/messaging/phoneNumberLookup";
import {
  createMessagingProfile,
  createVoiceApplication,
  registerBrand,
  registerCampaign,
} from "@/lib/messaging/registration";
import { CampaignRegistrationError } from "@/lib/messaging/registration/campaign";
import {
  ExistingBrandLinkError,
  prepareExistingTelnyxBrandLinkForLaunch,
} from "@/lib/messaging/registration/existingBrand";
import {
  A2P_RISK_BLOCKED_MESSAGE,
  A2P_RISK_CUSTOMER_REVIEW_MESSAGE,
} from "@/lib/messaging/registration/riskCategories";
import { ensureCampaignAssignmentForBusiness } from "@/lib/messaging/registration/phoneNumberAssignment";
import { buildProviderResourceName } from "@/lib/messaging/registration/providerResourceName";
import {
  readProviderCreateIntentForPayload,
  resolveProviderCreateIntent,
} from "@/lib/messaging/registration/providerCreateIntent";
import { verifyPublishedCompliancePage } from "@/lib/messaging/registration/publicCompliancePage";
import {
  getA2pRiskClearanceForBusiness,
  screenA2pRiskForBusiness,
} from "@/lib/messaging/registration/riskScreening";
import {
  claimRegistrationAttempt,
  markRegistrationFailed,
  markRegistrationSubmitted,
} from "@/lib/onboarding/registrationAttempt";
import {
  CarrierRejectionSupportRequiredError,
  hasCarrierRejection,
  REJECTION_SUPPORT_MESSAGE,
} from "@/lib/onboarding/rejectionGuidance";
import { assertNoCarrierRejectionForBusiness } from "@/lib/onboarding/rejectionGuard.server";
import { getBusinessContentQuality } from "@/lib/onboarding/contentQuality.server";
import { shouldEnforceInitialContentQuality } from "@/lib/onboarding/contentQualityGate";
import type {
  Language,
  OnboardingRegistrationStatus,
  SubscriptionPlan,
} from "@/types/database";
import { SUBSCRIPTION_PLAN_IDS } from "@/types/database";

const PAID_NUMBER_FAILED_MESSAGE =
  "That number was no longer available when we tried to activate it. Please choose another number; you will not be charged again.";

const NUMBER_SAVE_RETRY_MESSAGE =
  "Your number was reserved, but we couldn't finish saving it. Retry to complete setup — you will not be charged again.";

const BILLING_REQUIRED_MESSAGE =
  "Finish checkout before submitting SMS registration.";

const SUBMISSION_DISABLED_MESSAGE =
  "SMS registration is disabled for this account. Contact support if this looks wrong.";

const OPERATIONS_SUSPENDED_MESSAGE =
  "Account operations are suspended. Reactivate the account before SMS registration can continue.";

const NO_EIN_HELD_MESSAGE =
  "Add your EIN before SMS registration can continue.";

const EXISTING_BRAND_REVIEW_REQUIRED_MESSAGE =
  "Your existing Telnyx brand link needs review before SMS registration can continue. Contact support.";

const LINKED_BRAND_NEEDS_SUPPORT_MESSAGE =
  "Your linked Telnyx brand needs support before SMS registration can continue. Its existing Telnyx resources were not replaced.";

const EXISTING_BRAND_RETRY_MESSAGE =
  "We could not recheck your existing Telnyx brand right now. No new Telnyx resources were created; please try again shortly.";

export const SERVICES_FAQS_REQUIRED_MESSAGE =
  "Add at least 3 distinct services and 3 answered FAQs so your AI has enough accurate information to help customers.";

type LaunchSource = "stripe_finalize" | "stripe_webhook" | "onboarding_retry" | "texting_upgrade";

export type LaunchResult =
  | { status: "submitted" | "in_progress" | "already_submitted"; message?: string }
  | {
      status:
        | "billing_required"
        | "services_faqs_required"
        | "held_no_ein"
        | "risk_review_required"
        | "rejection_support_required"
        | "existing_brand_review_required"
        | "linked_brand_needs_support"
        | "operations_suspended"
        | "submission_disabled"
        | "missing_phone_number"
        | "number_unavailable"
        | "failed";
      message: string;
    };

interface BusinessLaunchRow {
  id: string;
  slug: string;
  name: string;
  legal_business_name: string | null;
  has_ein: boolean | null;
  pending_phone_number: string | null;
  telnyx_submission_disabled: boolean;
  telnyx_brand_id: string | null;
  telnyx_campaign_id: string | null;
  billing_pilot: boolean;
  billing_comped: boolean;
  billing_exempt: boolean;
  billing_mode: unknown;
  partner_plan: unknown;
  onboarding_completed_at: string | null;
  onboarding_registration_status: OnboardingRegistrationStatus | null;
  brand_status: string | null;
  campaign_status: string | null;
  ai_settings: { language: Language } | null;
}

interface ActiveNumberRow {
  id: string;
  phone_number: string;
  telnyx_phone_number_id: string;
}

interface SubscriptionRow {
  plan: unknown;
  status: string;
  setup_fee_paid_at: string | null;
}

export async function attemptPaidLaunch(
  businessId: string,
  source: LaunchSource
): Promise<LaunchResult> {
  const business = await readLaunchBusiness(businessId);
  if (!business) {
    return { status: "failed", message: "Business not found." };
  }

  // A carrier rejection is a support-only state. Stop at the shared launch
  // boundary so browser retries, direct API calls, Checkout finalization, and
  // Stripe webhooks can never archive a rejected resource and create another
  // charged Telnyx brand or campaign.
  if (hasCarrierRejection(business.brand_status, business.campaign_status)) {
    return {
      status: "rejection_support_required",
      message: REJECTION_SUPPORT_MESSAGE,
    };
  }

  // Operational suspension is independent of registration and billing state.
  // Read it uncached before any risk claim or Telnyx work; resolution failures
  // deliberately propagate so callers retry rather than provisioning from an
  // indeterminate state. Individual service pauses do not block provisioning.
  const operationalControls =
    await resolveBusinessOperationalControls(businessId);
  if (operationalControls.operationsSuspendedAt !== null) {
    return {
      status: "operations_suspended",
      message: OPERATIONS_SUSPENDED_MESSAGE,
    };
  }

  // Recheck the shared SMS/Telnyx authorization boundary before content,
  // risk, registration-state, or provider work. In particular, a canceled
  // Chat Checkout leaves a durable Chat family lock even without a
  // subscription row; legacy billing overrides or contradictory SMS rows
  // must never route around that lock into paid launch.
  const smsProvisioningAccess = await resolveSmsProvisioningAccess(
    businessId,
    { allowDirectPrecheckout: false },
  );
  if (!smsProvisioningAccess.allowed) {
    return { status: "billing_required", message: BILLING_REQUIRED_MESSAGE };
  }

  const billingReady = await isBillingReady(business);
  if (!billingReady.ready) {
    return { status: "billing_required", message: billingReady.message };
  }

  // The earlier access read rejects an existing Chat lock. This atomic claim
  // closes the remaining read-to-provider race: whichever of Chat Checkout or
  // SMS launch claims the business row first becomes the only allowed family.
  if (!(await claimSmsLaunchPlanFamily(businessId))) {
    return { status: "billing_required", message: BILLING_REQUIRED_MESSAGE };
  }

  if (shouldEnforceInitialContentQuality(business)) {
    const contentQuality = await getBusinessContentQuality(businessId);
    if (!contentQuality.ready) {
      return {
        status: "services_faqs_required",
        message: SERVICES_FAQS_REQUIRED_MESSAGE,
      };
    }
  }

  if (business.has_ein !== true) {
    return { status: "held_no_ein", message: NO_EIN_HELD_MESSAGE };
  }

  if (business.telnyx_submission_disabled) {
    await markRegistrationFailed(businessId, SUBMISSION_DISABLED_MESSAGE);
    return { status: "submission_disabled", message: SUBMISSION_DISABLED_MESSAGE };
  }

  const riskClearance = await getA2pRiskClearanceForBusiness(businessId);
  if (!riskClearance.cleared) {
    await persistRiskReviewRequired(businessId, riskClearance.message);
    return {
      status: "risk_review_required",
      message: riskClearance.message,
    };
  }

  const activeNumber = await readActiveNumber(businessId);
  if (!activeNumber && !business.pending_phone_number) {
    return {
      status: "missing_phone_number",
      message: "Choose your business number before submitting SMS registration.",
    };
  }

  const claim = await claimRegistrationAttempt(businessId);
  if (!claim.claimed) {
    if (claim.reason === "already_submitted") {
      await reconcileTextingUpgradeActivationForBusiness(businessId);
      return { status: "already_submitted" };
    }
    if (claim.reason === "already_submitting") {
      return { status: "in_progress" };
    }
    return {
      status: "failed",
      message: "SMS registration is already being processed. Please refresh in a moment.",
    };
  }

  let linkedExistingBrandConsumed = false;

  try {
    // The initial launch row predates the claim. A rejection webhook can land
    // between those operations and leave a freshly claimed `failed` row in
    // `submitting`; refresh now before any provider work.
    await assertNoCarrierRejectionForBusiness(businessId);
    await assertTextingUpgradeProvisioningAllowed(businessId);

    // Preflight the shared Telnyx name invariant before any carrier mutation.
    // The creators repeat this check against their fresh business reads.
    buildProviderResourceName(
      business.legal_business_name ?? business.name,
      businessId
    );

    // Paid-launch order after checkout success:
    // risk -> attempt gate -> existing-brand revalidate/consume -> brand ->
    // profile -> voice -> owned attach / purchase -> active number + deployed
    // compliance-page verification -> campaign.
    // The retry-only risk gate lives INSIDE the try so a transient failure
    // here funnels into the catch's markRegistrationFailed (immediately
    // retryable) instead of stranding the claimed row in 'submitting'.
    if (claim.claimedFrom === "failed" || claim.claimedFrom === "stale_submitting") {
      // Run AFTER the claim so it keys on the atomic claim origin rather
      // than a pre-claim snapshot (a rejection webhook landing mid-request
      // cannot slip an unscreened resubmission through). Origin
      // 'not_started' (first registration) never enters this branch.
      const retryClearance = await getA2pRiskClearanceForBusiness(businessId);
      let holdMessage: string | null = null;

      if (!retryClearance.hashMatches) {
        // Content changed since the stored decision, so re-run the Phase 8
        // screen before resubmission; flagged content routes to manual
        // review instead of auto-clearing. (registerCampaign restamps the
        // hash after its opt_in_description rewrite, so machine-induced
        // drift does not reach this branch — only real edits do.)
        const rescreen = await screenA2pRiskForBusiness(businessId, {}, { force: true });
        if (rescreen.status !== "passed" && rescreen.status !== "admin_approved") {
          holdMessage = rescreen.message;
        }
      } else if (
        retryClearance.status === "blocked" ||
        retryClearance.status === "pending_review"
      ) {
        // Identical content with a standing negative decision must keep
        // holding: a second Retry click is not a substitute for the manual
        // review (approveA2pRiskReview stamps admin_approved with the
        // current hash, which unlocks this gate).
        holdMessage =
          retryClearance.status === "blocked"
            ? A2P_RISK_BLOCKED_MESSAGE
            : A2P_RISK_CUSTOMER_REVIEW_MESSAGE;
      }

      if (holdMessage) {
        await releaseClaimToRiskReview(businessId, claim.startedAt, holdMessage);
        return { status: "risk_review_required", message: holdMessage };
      }
    }

    // This is the final existing-brand authorization boundary before any
    // Telnyx mutation.
    // It is a no-op for normal onboarding. For an existing-brand request it
    // captures one private request tuple, revalidates that exact brand and
    // local identity, then consumes the same tuple atomically. Pending or
    // blocked requests stop here, before any provider create.
    await assertNoCarrierRejectionForBusiness(businessId);
    const existingBrandPreparation =
      await prepareExistingTelnyxBrandLinkForLaunch(businessId);
    linkedExistingBrandConsumed =
      existingBrandPreparation.status === "consumed";

    await assertTextingUpgradeProvisioningAllowed(businessId);
    await registerBrand(businessId);

    // A number order needs both routing resources. Each helper recovers an
    // exact business-scoped provider resource before creating, closing the
    // provider-success/local-save retry gap.
    await assertNoCarrierRejectionForBusiness(businessId);
    await assertTextingUpgradeProvisioningAllowed(businessId);
    await createMessagingProfile(businessId);
    await assertNoCarrierRejectionForBusiness(businessId);
    await assertTextingUpgradeProvisioningAllowed(businessId);
    await createVoiceApplication(businessId);

    // Number attachment/purchase is another paid provider boundary. In
    // particular, registerBrand may have reused an existing ID and returned
    // without creating anything, so do not rely on its create-only check.
    await assertNoCarrierRejectionForBusiness(businessId);
    await assertTextingUpgradeProvisioningAllowed(businessId);

    const latestNumber = await readActiveNumber(businessId);
    if (latestNumber) {
      const providerCreateIntentId =
        await readProviderCreateIntentForPayload({
          businessId,
          spec: NUMBER_ORDER_CREATE_INTENT_SPEC,
          expectedPayload: {
            version: 1,
            phoneNumber: latestNumber.phone_number,
          },
        });
      const phoneNumberResourceId = await resolveActiveNumberResourceId(
        businessId,
        latestNumber
      );
      await attachOwnedNumberToCustomerProfile(
        businessId,
        phoneNumberResourceId
      );
      await clearPendingPhoneNumber(businessId);
      if (providerCreateIntentId) {
        await resolveProviderCreateIntent({
          businessId,
          spec: NUMBER_ORDER_CREATE_INTENT_SPEC,
          intentId: providerCreateIntentId,
        });
      }
    } else {
      await purchasePendingNumber(businessId, business.pending_phone_number);
    }

    // Use the same strict active-number source as /c/[slug] and campaign
    // generation (including duplicate-row and E.164 validation), then fetch
    // the deployed page's raw SSR HTML. No charged campaign submission is
    // reachable until the exact active number and disclosure markers render.
    const smsPhoneNumber = await getActiveSmsNumberForBusiness(businessId);
    if (!smsPhoneNumber) {
      throw new Error(
        `[billing:launch] Active SMS number disappeared before compliance-page verification for ${businessId}`
      );
    }
    await verifyPublishedCompliancePage({
      slug: business.slug,
      businessName: business.name,
      smsPhoneNumber,
      language: business.ai_settings?.language ?? "en",
    });

    await assertTextingUpgradeProvisioningAllowed(businessId);
    await registerCampaign(businessId);

    // Existing campaign IDs return without a charged submit. Refresh before
    // assignment so a rejection that landed during the pipeline cannot link
    // the number to a rejected campaign.
    await assertNoCarrierRejectionForBusiness(businessId);
    await ensureCampaignAssignmentForBusiness(businessId, {
      force: true,
      reason: `paid_launch_${source}`,
    });

    await assertNoCarrierRejectionForBusiness(businessId);
    const completion = await markRegistrationSubmitted(
      businessId,
      claim.startedAt,
    );
    if (!completion.completed) {
      // A webhook rejection atomically changes the attempt to `failed`, which
      // makes exact-claim completion miss. Re-read carrier state before
      // classifying any other lost-claim outcome.
      await assertNoCarrierRejectionForBusiness(businessId);

      if (
        completion.current?.onboarding_registration_status === "submitted"
      ) {
        return { status: "already_submitted" };
      }
      if (
        completion.current?.onboarding_registration_status === "submitting"
      ) {
        return { status: "in_progress" };
      }
      return {
        status: "failed",
        message:
          completion.current?.onboarding_registration_error ??
          "Registration state changed while setup was finishing. Refresh before retrying.",
      };
    }
    await reconcileTextingUpgradeActivationForBusiness(businessId);
    return { status: "submitted" };
  } catch (err) {
    if (err instanceof TextingUpgradeProvisioningStoppedError) {
      return { status: "billing_required", message: err.message };
    }
    if (err instanceof CarrierRejectionSupportRequiredError) {
      // A provider helper found a carrier rejection on its fresh, last-moment
      // status read. Release only OUR exact claim; if the rejection webhook
      // already moved the row to failed, the guarded update is a no-op and its
      // exact rejection fields remain untouched.
      await releaseClaimToCarrierRejection(
        businessId,
        claim.startedAt,
        err.carrierReason
      );
      return {
        status: "rejection_support_required",
        message: REJECTION_SUPPORT_MESSAGE,
      };
    }

    if (err instanceof ExistingBrandLinkError) {
      const status =
        err.launchDisposition === "review_required"
          ? "existing_brand_review_required"
          : err.launchDisposition === "support_required"
            ? "linked_brand_needs_support"
            : "failed";
      const message =
        status === "existing_brand_review_required"
          ? EXISTING_BRAND_REVIEW_REQUIRED_MESSAGE
          : status === "linked_brand_needs_support"
            ? LINKED_BRAND_NEEDS_SUPPORT_MESSAGE
            : EXISTING_BRAND_RETRY_MESSAGE;
      console.error(
        `[billing:launch] Existing-brand launch stopped for ${businessId} (${err.code}, ${err.kind})`
      );
      await markRegistrationFailed(businessId, message);
      return { status, message };
    }

    if (err instanceof CampaignRegistrationError) {
      const isLocallyCorrectableSignupGoalError =
        err.code === "campaign_signup_goal_url_invalid" ||
        err.code === "campaign_signup_sample_too_long";
      const needsLinkedBrandSupport =
        linkedExistingBrandConsumed &&
        err.kind === "permanent" &&
        !isLocallyCorrectableSignupGoalError;
      const message = needsLinkedBrandSupport
        ? LINKED_BRAND_NEEDS_SUPPORT_MESSAGE
        : err.message;
      console.error(
        `[billing:launch] Campaign launch stopped for ${businessId} (${err.code}, ${err.kind})`
      );
      await markRegistrationFailed(businessId, message);
      return {
        status: needsLinkedBrandSupport
          ? "linked_brand_needs_support"
          : "failed",
        message,
      };
    }

    if (
      err instanceof PurchasedNumberSaveError ||
      err instanceof PurchasedNumberResolutionError
    ) {
      // The number IS purchased and owned — never route to re-pick, never
      // claim "not charged" is a fresh start. pending_phone_number is
      // deliberately kept: Retry re-enters purchasePendingNumber, finds
      // the owned number via findOwnedNumberId, and completes the save
      // without a second charge. The copy is truthful for this path.
      console.error(
        `[billing:launch] Purchased-but-unsaved number for ${businessId}:`,
        err
      );
      await markRegistrationFailed(businessId, NUMBER_SAVE_RETRY_MESSAGE);
      return { status: "failed", message: NUMBER_SAVE_RETRY_MESSAGE };
    }

    if (
      err instanceof NumberTakenError ||
      err instanceof NumberUnavailableError ||
      err instanceof TollFreeNumberUnsupportedError
    ) {
      await persistNumberFailure(businessId, PAID_NUMBER_FAILED_MESSAGE);
      return {
        status: "number_unavailable",
        message: PAID_NUMBER_FAILED_MESSAGE,
      };
    }

    console.error(`[billing:launch] Paid launch failed for ${businessId}:`, err);
    await markRegistrationFailed(
      businessId,
      "Couldn't submit your SMS registration right now. Please try again or contact support from the Support page."
    );
    return {
      status: "failed",
      message:
        "Couldn't submit your SMS registration right now. Please try again or contact support from the Support page.",
    };
  }
}

async function readLaunchBusiness(
  businessId: string
): Promise<BusinessLaunchRow | null> {
  const { data, error } = await supabaseAdmin
    .from("businesses")
    .select(
      "id, slug, name, legal_business_name, has_ein, pending_phone_number, telnyx_submission_disabled, telnyx_brand_id, telnyx_campaign_id, billing_pilot, billing_comped, billing_exempt, billing_mode, partner_plan, onboarding_completed_at, onboarding_registration_status, brand_status, campaign_status, ai_settings(language)"
    )
    .eq("id", businessId)
    .maybeSingle<BusinessLaunchRow>();

  if (error) {
    throw new Error(
      `[billing:launch] Failed to read business ${businessId}: ${error.message}`
    );
  }
  return data ?? null;
}

async function readActiveNumber(
  businessId: string
): Promise<ActiveNumberRow | null> {
  const { data, error } = await supabaseAdmin
    .from("phone_numbers")
    .select("id, phone_number, telnyx_phone_number_id")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<ActiveNumberRow>();

  if (error) {
    throw new Error(
      `[billing:launch] Failed to read active number for ${businessId}: ${error.message}`
    );
  }
  return data ?? null;
}

async function resolveActiveNumberResourceId(
  businessId: string,
  row: ActiveNumberRow
): Promise<string> {
  let invalidStoredId: unknown;
  try {
    return normalizeTelnyxPhoneNumberResourceId(
      row.telnyx_phone_number_id,
      `stored for business ${businessId}`
    );
  } catch (error) {
    invalidStoredId = error;
    // Older launches stored the UUID of the number-order line item in this
    // column. That UUID belongs to /number_order_phone_numbers and must never
    // be sent to /phone_numbers/{id}. Resolve the exact owned resource under
    // this business's customer_reference, then repair the local row and its
    // cancellation ledger atomically before any provider mutation.
  }

  // Only the exact known legacy shape is eligible for automatic repair.
  // Arbitrary/corrupt identifiers remain fail-closed and do not even trigger
  // a provider ownership lookup.
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      row.telnyx_phone_number_id
    )
  ) {
    throw invalidStoredId;
  }

  const resolvedResourceId = await findOwnedNumberId(
    row.phone_number,
    businessId
  );
  if (!resolvedResourceId) {
    throw new Error(
      `[billing:launch] Could not resolve the owned Telnyx phone-number resource for ${row.phone_number} (${businessId})`
    );
  }

  const { data: repaired, error: repairError } = await supabaseAdmin.rpc(
    "repair_telnyx_phone_number_resource_id",
    {
      p_business_id: businessId,
      p_phone_number_id: row.id,
      p_phone_number: row.phone_number,
      p_expected_legacy_id: row.telnyx_phone_number_id,
      p_resolved_resource_id: resolvedResourceId,
    }
  );

  if (repairError || repaired !== true) {
    throw new Error(
      `[billing:launch] Failed to persist the owned Telnyx phone-number resource for ${row.phone_number} (${businessId}): ${repairError?.message ?? "guarded repair returned false"}`
    );
  }

  console.warn(
    `[billing:launch] Reconciled legacy Telnyx number-order id for ${businessId} (phone row=${row.id})`
  );
  return resolvedResourceId;
}

async function isBillingReady(
  business: BusinessLaunchRow
): Promise<{ ready: true } | { ready: false; message: string }> {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("plan, status, setup_fee_paid_at")
    .eq("business_id", business.id)
    .maybeSingle<SubscriptionRow>();

  if (error) {
    throw new Error(
      `[billing:launch] Failed to read subscription for ${business.id}: ${error.message}`
    );
  }

  // Any synchronized subscription row remains authoritative, including for
  // an impossible split-authority row. Native partner billing is considered
  // only when no subscription exists, and never requires Stripe's setup fee.
  if (data?.status === "past_due") {
    return {
      ready: false,
      message: "Your subscription payment needs attention before SMS registration can continue.",
    };
  }
  if (data?.status === "canceled") {
    return {
      ready: false,
      message: "Choose an active plan before SMS registration can continue.",
    };
  }
  if (data && data.status !== "active" && data.status !== "trialing") {
    throw new Error(
      `[billing:launch] Subscription for ${business.id} has unknown status ${data.status}`
    );
  }
  if (data && !data.setup_fee_paid_at) {
    return { ready: false, message: BILLING_REQUIRED_MESSAGE };
  }
  if (data) {
    if (!isSubscriptionPlan(data.plan)) {
      return { ready: false, message: BILLING_REQUIRED_MESSAGE };
    }
    if (!planRequiresSmsProvisioning(data.plan)) {
      return { ready: false, message: BILLING_REQUIRED_MESSAGE };
    }
  }
  if (data) {
    return { ready: true };
  }

  if (
    business.billing_mode === "invoiced" ||
    business.billing_mode === "comped"
  ) {
    return isSubscriptionPlan(business.partner_plan) &&
      planRequiresSmsProvisioning(business.partner_plan)
      ? { ready: true }
      : { ready: false, message: BILLING_REQUIRED_MESSAGE };
  }

  // Only the exact database modes are accepted at this trusted boundary.
  // Missing or malformed modes must not fall through to legacy overrides.
  if (business.billing_mode !== "stripe") {
    return { ready: false, message: BILLING_REQUIRED_MESSAGE };
  }
  if (business.partner_plan !== null) {
    return { ready: false, message: BILLING_REQUIRED_MESSAGE };
  }

  // Legacy overrides retain their existing Stripe-mode behavior only when no
  // subscription row exists. Native partner accounts never inherit access
  // from these flags.
  if (
    business.billing_exempt ||
    business.billing_comped ||
    business.billing_pilot
  ) {
    return { ready: true };
  }

  return { ready: false, message: BILLING_REQUIRED_MESSAGE };
}

function isSubscriptionPlan(value: unknown): value is SubscriptionPlan {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_PLAN_IDS as readonly string[]).includes(value)
  );
}

// Three-step resolver for the purchase-save two-phase-commit gap. Telnyx
// ownership is the durable "purchase completed" marker the local schema
// lacks, so a retry after a failed save recovers the already-paid number
// instead of charging again or telling the customer to re-pick.
async function purchasePendingNumber(
  businessId: string,
  pendingPhoneNumber: string | null
): Promise<void> {
  if (!pendingPhoneNumber) {
    throw new Error(`[billing:launch] Missing pending_phone_number for ${businessId}`);
  }

  // Step 1: local row check — a prior attempt may have fully completed
  // (idempotent completion: re-assert routing too, since a crash between
  // insert and attach leaves a saved-but-unrouted number), or another
  // business may hold the number (typed → the re-pick path). limit(1)
  // guards the multi-row case: phone_numbers has NO unique constraint on
  // phone_number (verified against migrations — §5 backlog), so duplicates
  // are structurally possible and must not wedge this read.
  const { data: existingRow, error: rowError } = await supabaseAdmin
    .from("phone_numbers")
    .select("id, business_id, phone_number, telnyx_phone_number_id")
    .eq("phone_number", pendingPhoneNumber)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle<ActiveNumberRow & { business_id: string }>();

  if (rowError) {
    throw new Error(
      `[billing:launch] Failed to check existing row for ${pendingPhoneNumber}: ${rowError.message}`
    );
  }
  if (existingRow) {
    if (existingRow.business_id === businessId) {
      const providerCreateIntentId =
        await readProviderCreateIntentForPayload({
          businessId,
          spec: NUMBER_ORDER_CREATE_INTENT_SPEC,
          expectedPayload: {
            version: 1,
            phoneNumber: existingRow.phone_number,
          },
        });
      const phoneNumberResourceId = await resolveActiveNumberResourceId(
        businessId,
        existingRow
      );
      await attachOwnedNumberToCustomerProfile(
        businessId,
        phoneNumberResourceId
      );
      await clearPendingPhoneNumber(businessId);
      if (providerCreateIntentId) {
        await resolveProviderCreateIntent({
          businessId,
          spec: NUMBER_ORDER_CREATE_INTENT_SPEC,
          intentId: providerCreateIntentId,
        });
      }
      return;
    }
    throw new NumberTakenError(pendingPhoneNumber);
  }

  // Step 2: ownership recovery — a prior attempt by THIS business purchased
  // this number but the save failed (PurchasedNumberSaveError path); the
  // lookup is customer_reference-scoped so another business's purchase can
  // never be seized. Complete the save and re-assert routing; no second
  // charge. A complete zero-match result authorizes the first order below.
  // After that charged POST, purchaseNumber must resolve the owned numeric
  // resource ID or return typed order provenance, which is persisted as a
  // no-second-order fence before the launch fails closed.
  const ownedId = await findOwnedNumberId(pendingPhoneNumber, businessId);
  if (ownedId) {
    console.warn(
      `[billing:launch] Recovering purchased-but-unsaved number for ${businessId} (telnyx id=${ownedId})`
    );
    const providerCreateIntentId =
      await readProviderCreateIntentForPayload({
        businessId,
        spec: NUMBER_ORDER_CREATE_INTENT_SPEC,
        expectedPayload: { version: 1, phoneNumber: pendingPhoneNumber },
      });
    await savePurchasedNumber(businessId, pendingPhoneNumber, ownedId);
    await attachOwnedNumberToCustomerProfile(businessId, ownedId);
    if (providerCreateIntentId) {
      await resolveProviderCreateIntent({
        businessId,
        spec: NUMBER_ORDER_CREATE_INTENT_SPEC,
        intentId: providerCreateIntentId,
      });
    }
    return;
  }

  // Step 3: fresh purchase.
  let purchased: Awaited<ReturnType<typeof purchaseNumber>>;
  try {
    purchased = await purchaseNumber(pendingPhoneNumber, businessId);
  } catch (error) {
    if (error instanceof PurchasedNumberResolutionError) {
      await savePurchasedNumberResolutionFence(businessId, error);
      throw error;
    }
    throw error;
  }
  await savePurchasedNumber(
    businessId,
    purchased.phoneNumber,
    purchased.phoneNumberId,
    purchased.numberOrderPhoneNumberId,
    purchased.numberOrderId
  );
  await resolveProviderCreateIntent({
    businessId,
    spec: NUMBER_ORDER_CREATE_INTENT_SPEC,
    intentId: purchased.providerCreateIntentId,
  });
}

async function savePurchasedNumber(
  businessId: string,
  phoneNumber: string,
  telnyxPhoneNumberId: string,
  telnyxNumberOrderPhoneNumberId: string | null = null,
  telnyxNumberOrderId: string | null = null
): Promise<void> {
  const { error: insertError } = await supabaseAdmin.from("phone_numbers").insert({
    business_id: businessId,
    phone_number: phoneNumber,
    telnyx_phone_number_id: telnyxPhoneNumberId,
    telnyx_number_order_phone_number_id: telnyxNumberOrderPhoneNumberId,
    telnyx_number_order_id: telnyxNumberOrderId,
    is_active: true,
  });

  if (insertError) {
    // Typed: the number is paid for and owned. Classification by
    // construction — the old message-sniffing regex matched the
    // phone_numbers relation name inside this very error and misrouted it
    // to "unavailable / you will not be charged again" (false).
    throw new PurchasedNumberSaveError({
      phoneNumber,
      telnyxPhoneNumberId,
      cause: insertError,
    });
  }

  await clearPendingPhoneNumber(businessId);
}

async function savePurchasedNumberResolutionFence(
  businessId: string,
  error: PurchasedNumberResolutionError
): Promise<void> {
  const durableOrderId =
    error.numberOrderPhoneNumberId ?? error.numberOrderId;
  if (!durableOrderId) {
    // The pre-POST provider-create intent is the authoritative no-second-order
    // fence even when Telnyx's response omitted both order UUIDs. With no
    // endpoint-provenance ID, do not invent a local phone resource pointer.
    return;
  }

  const { error: insertError } = await supabaseAdmin.from("phone_numbers").insert({
    business_id: businessId,
    phone_number: error.phoneNumber,
    // Transitional no-second-order fence for an already-paid order. This is
    // deliberately never sent to Telnyx: every active-row path validates a
    // numeric owned resource ID and reconciles this UUID first.
    telnyx_phone_number_id: durableOrderId,
    telnyx_number_order_phone_number_id:
      error.numberOrderPhoneNumberId ?? null,
    telnyx_number_order_id: error.numberOrderId ?? null,
    is_active: true,
  });

  if (insertError) {
    throw new PurchasedNumberSaveError({
      phoneNumber: error.phoneNumber,
      telnyxPhoneNumberId: durableOrderId,
      cause: insertError,
    });
  }
}

async function clearPendingPhoneNumber(businessId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("businesses")
    .update({
      pending_phone_number: null,
      pending_phone_number_area_code: null,
      pending_phone_number_selected_at: null,
      pending_phone_number_failure_reason: null,
    })
    .eq("id", businessId);

  if (error) {
    throw new Error(
      `[billing:launch] Failed to clear pending phone number for ${businessId}: ${error.message}`
    );
  }
}

async function persistNumberFailure(
  businessId: string,
  message: string
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("businesses")
    .update({
      onboarding_registration_status: "failed",
      onboarding_registration_error: message,
      onboarding_registration_submitted_at: null,
      pending_phone_number_failure_reason: message,
      onboarding_step: "phone_number",
      onboarding_last_saved_at: new Date().toISOString(),
    })
    .eq("id", businessId);

  if (error) {
    throw new Error(
      `[billing:launch] Failed to persist number failure for ${businessId}: ${error.message}`
    );
  }
}

async function persistRiskReviewRequired(
  businessId: string,
  message: string
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("businesses")
    .update({
      onboarding_registration_status: "failed",
      onboarding_registration_error: message,
      onboarding_step: "sms_use_case",
      onboarding_last_saved_at: new Date().toISOString(),
    })
    .eq("id", businessId)
    // Never demote a concurrently claimed/completed attempt: only
    // pre-registration (not_started/null) and already-failed rows may be
    // moved into the risk-review hold by this pre-claim path.
    .or(
      "onboarding_registration_status.is.null,onboarding_registration_status.in.(not_started,failed)"
    );

  if (error) {
    console.error(
      `[billing:launch] Failed to persist risk review hold for ${businessId}:`,
      error
    );
  }
}

/**
 * Release OUR claimed attempt into the risk-review hold. Guarded on both
 * status='submitting' and the exact startedAt we wrote at claim time, so a
 * concurrent attempt's claim (or a completed submission) is never clobbered.
 */
async function releaseClaimToRiskReview(
  businessId: string,
  startedAt: string,
  message: string
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("businesses")
    .update({
      onboarding_registration_status: "failed",
      onboarding_registration_error: message,
      onboarding_step: "sms_use_case",
      onboarding_last_saved_at: new Date().toISOString(),
    })
    .eq("id", businessId)
    .eq("onboarding_registration_status", "submitting")
    .eq("onboarding_registration_started_at", startedAt);

  if (error) {
    // Throw so the caller's catch runs markRegistrationFailed — a swallowed
    // failure here would strand our claimed row in 'submitting' for the
    // stale window while the caller reports risk_review_required.
    throw new Error(
      `[billing:launch] Failed to release claim to risk review for ${businessId}: ${error.message}`
    );
  }
}

/**
 * Release OUR claimed launch after a provider-boundary carrier-status check.
 * The carrier's dedicated rejection columns are deliberately not updated;
 * onboarding error mirrors the exact stored reason only when our claim is
 * still the active submitting attempt.
 */
async function releaseClaimToCarrierRejection(
  businessId: string,
  startedAt: string,
  carrierReason: string | null
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("businesses")
    .update({
      onboarding_registration_status: "failed",
      onboarding_registration_error:
        carrierReason ?? REJECTION_SUPPORT_MESSAGE,
      onboarding_registration_submitted_at: null,
      onboarding_step: "carrier_review",
      onboarding_last_saved_at: new Date().toISOString(),
    })
    .eq("id", businessId)
    .eq("onboarding_registration_status", "submitting")
    .eq("onboarding_registration_started_at", startedAt)
    .or("brand_status.eq.rejected,campaign_status.eq.rejected");

  if (error) {
    throw new Error(
      `[billing:launch] Failed to release carrier-rejected claim for ${businessId}: ${error.message}`
    );
  }
}
