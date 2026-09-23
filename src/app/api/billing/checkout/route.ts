import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  attemptPaidLaunch,
  SERVICES_FAQS_REQUIRED_MESSAGE,
} from "@/lib/billing/launch";
import { finalizePaidCheckout } from "@/lib/billing/finalizePaidCheckout.server";
import {
  getOnboardingCheckoutContextForBusinessIdReadOnly,
  getOnboardingStateForBusinessId,
} from "@/lib/onboarding/state";
import {
  hasCarrierRejection,
  REJECTION_SUPPORT_MESSAGE,
} from "@/lib/onboarding/rejectionGuidance";
import { getBusinessContentQuality } from "@/lib/onboarding/contentQuality.server";
import { shouldEnforceInitialContentQuality } from "@/lib/onboarding/contentQualityGate";
import {
  ChatOnlyCheckoutAttemptConflictError,
  ChatOnlyCheckoutAttemptRecoveryRequiredError,
  ChatOnlyCheckoutAttemptUnavailableError,
  ChatOnlyCheckoutInProgressError,
  ChatOnlyCheckoutRecoveredCompletionError,
  ChatOnlyCheckoutSessionExpiredError,
  ChatOnlyStripePriceConfigurationError,
  createCheckoutSession,
} from "@/lib/stripe/checkout";
import {
  hasValidChatOnlyStripePrice,
  stripePriceIdForPlan,
  stripeSetupFeePriceId,
} from "@/lib/stripe/config";
import { getExistingTelnyxBrandLinkState } from "@/lib/messaging/registration/existingBrand";
import { publicAppOrigin } from "@/lib/billing/publicAppOrigin";
import { isChatOnlyDirectAcquisitionEnabledForBusiness } from "@/lib/billing/chatOnlyRollout.server";
import { isPlanAvailable } from "@/lib/billing/planAvailability";
import { subscriptionPlanSchema } from "@/lib/billing/planSchema";
import { SmsBillingError } from "@/lib/stripe/smsBilling";
import {
  DirectCheckoutPlanClaimUnavailableError,
  PlanFamilyTransitionNotSupportedError,
} from "@/lib/billing/planFamilyLock.server";
import {
  partnerManagedBillingMessage,
  resolveAssignedPartnerName,
} from "@/lib/billing/partnerManagedBilling.server";
import { requireWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import type {
  BillingMode,
  OnboardingRegistrationStatus,
  SubscriptionPlan,
} from "@/types/database";

const VALID_MODES = ["onboarding", "billing"] as const;
const NO_EIN_HELD_MESSAGE = "Add your EIN before choosing a paid SMS plan.";

type CheckoutBusinessRow = {
  id: string;
  partner_id: string | null;
  billing_mode: BillingMode;
  has_ein: boolean | null;
  billing_pilot: boolean;
  billing_comped: boolean;
  billing_exempt: boolean;
  operations_suspended_at: string | null;
  onboarding_completed_at: string | null;
  onboarding_selected_plan: string | null;
  onboarding_registration_status: OnboardingRegistrationStatus | null;
  telnyx_brand_id: string | null;
  brand_status: string | null;
  campaign_status: string | null;
};

type CheckoutSubscriptionRow = {
  plan: string;
  status: string;
  setup_fee_paid_at: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
};

export async function POST(request: NextRequest) {
  const workspace = await requireWorkspaceRouteAccess();
  if (!workspace.ok) return workspace.response;

  try {
    const { plan, mode: requestedMode } = await request.json();

    const parsedPlan = subscriptionPlanSchema.safeParse(plan);
    if (!parsedPlan.success) {
      return NextResponse.json({ error: "Invalid plan." }, { status: 400 });
    }
    const selectedPlan: SubscriptionPlan = parsedPlan.data;

    const mode = VALID_MODES.includes(requestedMode)
      ? requestedMode
      : "billing";

    const supabase = await createClient();
    const { data: business, error: bizError } = await supabase
      .from("businesses")
      .select(
        "id, partner_id, billing_mode, has_ein, billing_pilot, billing_comped, billing_exempt, operations_suspended_at, onboarding_completed_at, onboarding_selected_plan, onboarding_registration_status, telnyx_brand_id, brand_status, campaign_status",
      )
      .eq("id", workspace.access.business.id)
      .eq("owner_id", workspace.access.user.id)
      .single<CheckoutBusinessRow>();

    if (bizError || !business) {
      return NextResponse.json(
        { error: "Business not found" },
        { status: 404 },
      );
    }

    if (business.billing_mode !== "stripe") {
      const partnerName = await resolveAssignedPartnerName(business.partner_id);
      return NextResponse.json(
        {
          error: "billing_managed_by_partner",
          message: partnerManagedBillingMessage(partnerName),
        },
        { status: 409 },
      );
    }

    // A partner relationship is independent from billing_mode during repair
    // and migration windows. Never let a partner-owned business enter the
    // direct Chat Only acquisition path even if its mode is temporarily
    // `stripe`; partner Chat Only is assigned by an administrator instead.
    if (selectedPlan === "chat_only" && business.partner_id !== null) {
      const partnerName = await resolveAssignedPartnerName(business.partner_id);
      return NextResponse.json(
        {
          error: "billing_managed_by_partner",
          message: partnerManagedBillingMessage(partnerName),
        },
        { status: 409 },
      );
    }

    // Carrier rejection is an SMS-only support state. Stop before reading
    // acquisition state or creating another paid Stripe Checkout Session.
    // Chat Only has no Telnyx registration and remains independently usable.
    if (
      selectedPlan !== "chat_only" &&
      hasCarrierRejection(business.brand_status, business.campaign_status)
    ) {
      const state = await getOnboardingStateForBusinessId(business.id);
      return NextResponse.json(
        {
          error: REJECTION_SUPPORT_MESSAGE,
          code: "rejection_support_required",
          state,
        },
        { status: 409 },
      );
    }

    const subscription = await readCheckoutSubscription(supabase, business.id);
    const directSelectionFlowEnabled =
      isChatOnlyDirectAcquisitionEnabledForBusiness(business.id) &&
      hasValidChatOnlyStripePrice();
    if (hasCrossFamilyTransition(subscription, selectedPlan)) {
      return NextResponse.json(
        {
          error:
            "Switching between Chat Only and SMS plans is not supported yet.",
          code: "plan_family_transition_not_supported",
        },
        { status: 409 },
      );
    }

    // Only a first, unclaimed direct checkout gets the new setup gate. A
    // durable checkout/family claim must retain its existing retry identity,
    // even when the customer never returned from Stripe. Read-only state
    // checks neither synchronize progress nor provision Telnyx resources.
    if (
      !subscription &&
      business.partner_id === null &&
      !business.billing_pilot &&
      !business.billing_comped &&
      !business.billing_exempt &&
      shouldEnforceInitialContentQuality(business)
    ) {
      const context =
        await getOnboardingCheckoutContextForBusinessIdReadOnly(business.id);
      if (!context) {
        return NextResponse.json(
          {
            error: "Could not verify your setup. Please try again.",
            code: "onboarding_state_unavailable",
          },
          { status: 503 },
        );
      }

      if (context.freshInitialDirectAcquisition) {
        const { state } = context;
        // A caller-controlled mode must not bypass setup or the exact saved
        // intent claim that onboarding checkout performs atomically.
        if (mode !== "onboarding") {
          return NextResponse.json(
            {
              error: "Finish setup and continue to payment from onboarding.",
              code: "onboarding_checkout_required",
              state,
            },
            { status: 409 },
          );
        }
        if (state.currentStep !== "review_submit") {
          return NextResponse.json(
            {
              error: "Complete your setup before continuing to payment.",
              code: "onboarding_incomplete",
              state,
            },
            { status: 409 },
          );
        }
        if (
          state.planSelection.position === "start" &&
          state.planSelection.effectivePlan !== selectedPlan
        ) {
          return NextResponse.json(
            {
              error: "Your saved onboarding plan does not match this checkout.",
              code: "onboarding_plan_mismatch",
              state,
            },
            { status: 409 },
          );
        }
      }
    }

    // Phase 2 supports Chat Only through onboarding only. Existing paid
    // onboarding retries are still onboarding-mode requests and remain
    // independent of the acquisition rollout flag.
    if (selectedPlan === "chat_only" && mode !== "onboarding") {
      return NextResponse.json(
        {
          error: "Chat Only can currently be selected only during onboarding.",
          code: "chat_only_onboarding_only",
        },
        { status: 409 },
      );
    }

    if (
      selectedPlan === "chat_only" &&
      subscription?.plan === "chat_only" &&
      subscription.status === "past_due"
    ) {
      return NextResponse.json(
        {
          error:
            "Recover your existing Chat Only subscription before continuing.",
          code: "subscription_payment_recovery_required",
        },
        { status: 409 },
      );
    }

    const hasActiveChatAuthority =
      selectedPlan === "chat_only" &&
      subscription?.plan === "chat_only" &&
      (subscription.status === "active" || subscription.status === "trialing");

    if (
      selectedPlan === "chat_only" &&
      !hasActiveChatAuthority &&
      business.operations_suspended_at != null
    ) {
      return NextResponse.json(
        {
          error: "This workspace is temporarily unavailable.",
          code: "account_suspended",
        },
        { status: 409 },
      );
    }

    if (
      selectedPlan === "chat_only" &&
      subscription?.plan === "chat_only" &&
      subscription.status === "canceled"
    ) {
      return NextResponse.json(
        {
          error:
            "Chat Only subscription recovery needs support before a new Checkout can begin.",
          code: "chat_only_reacquisition_not_supported",
        },
        { status: 409 },
      );
    }

    if (
      selectedPlan === "chat_only" &&
      !hasActiveChatAuthority &&
      (business.billing_pilot ||
        business.billing_comped ||
        business.billing_exempt)
    ) {
      return NextResponse.json(
        {
          error: "Chat Only billing is not available for this workspace.",
          code: "chat_only_not_available",
        },
        { status: 409 },
      );
    }

    if (
      hasActiveChatAuthority &&
      (!subscription.stripe_customer_id || !subscription.stripe_subscription_id)
    ) {
      return NextResponse.json(
        {
          error:
            "Your Chat Only payment is still synchronizing. Try again shortly.",
          code: "subscription_payment_sync_required",
        },
        { status: 409 },
      );
    }

    if (
      selectedPlan === "chat_only" &&
      !hasActiveChatAuthority &&
      !directSelectionFlowEnabled
    ) {
      return NextResponse.json(
        {
          error: "Chat-only is not available yet.",
          code: "chat_only_not_available",
        },
        { status: 409 },
      );
    }

    // Advisory intent protects new early-flow acquisition only. Once a
    // subscription exists, its synchronized plan is authoritative; requiring
    // a migration-058 intent value would strand legacy paid retries.
    if (
      !subscription &&
      mode === "onboarding" &&
      !onboardingSelectionMatches(
        business,
        selectedPlan,
        directSelectionFlowEnabled,
      )
    ) {
      return NextResponse.json(
        {
          error: "Your saved onboarding plan does not match this checkout.",
          code: "onboarding_plan_mismatch",
        },
        { status: 409 },
      );
    }

    if (
      !hasActiveChatAuthority &&
      shouldEnforceInitialContentQuality(business)
    ) {
      const contentQuality = await getBusinessContentQuality(business.id);
      if (!contentQuality.ready) {
        const state = await getOnboardingStateForBusinessId(business.id);
        return NextResponse.json(
          {
            error: SERVICES_FAQS_REQUIRED_MESSAGE,
            code: "services_faqs_required",
            state,
          },
          { status: 400 },
        );
      }
    }

    if (selectedPlan !== "chat_only" && business.has_ein !== true) {
      const state = await getOnboardingStateForBusinessId(business.id);
      return NextResponse.json(
        {
          error: NO_EIN_HELD_MESSAGE,
          code: "held_no_ein",
          state,
        },
        { status: 400 },
      );
    }

    // An identity edit invalidates an approved manual-brand link in the
    // database. Stop before creating a Stripe Checkout Session until an
    // administrator has compared and approved the current identity again.
    // Normal customers have no link row and pass through unchanged.
    if (selectedPlan !== "chat_only") {
      const existingBrandLink = await getExistingTelnyxBrandLinkState(
        business.id,
      );
      if (
        existingBrandLink &&
        existingBrandLink.status !== "approved" &&
        existingBrandLink.status !== "consumed"
      ) {
        const state = await getOnboardingStateForBusinessId(business.id);
        return NextResponse.json(
          {
            error:
              "Your existing Telnyx brand link needs review before checkout can continue. Contact support.",
            code: "existing_brand_review_required",
            state,
          },
          { status: 409 },
        );
      }
    }

    if (
      mode === "onboarding" &&
      hasSatisfiedOnboardingBilling(business, subscription, selectedPlan)
    ) {
      const launch =
        selectedPlan === "chat_only" &&
        subscription?.stripe_customer_id &&
        subscription.stripe_subscription_id
          ? await finalizePaidCheckout(
              {
                businessId: business.id,
                customerId: subscription.stripe_customer_id,
                subscriptionId: subscription.stripe_subscription_id,
                plan: "chat_only",
              },
              "stripe_finalize",
            )
          : await attemptPaidLaunch(business.id, "onboarding_retry");
      if (
        selectedPlan === "chat_only" &&
        launch.status === "billing_required"
      ) {
        return NextResponse.json(
          {
            error:
              "Your Chat Only payment is still synchronizing. Try again shortly.",
            code: "subscription_payment_sync_required",
          },
          { status: 409 },
        );
      }
      if (launch.status !== "billing_required") {
        const state = await getOnboardingStateForBusinessId(business.id);
        if (
          launch.status === "completed" ||
          launch.status === "submitted" ||
          launch.status === "already_submitted"
        ) {
          return NextResponse.json({ success: true, state });
        }
        if (launch.status === "in_progress") {
          return NextResponse.json({ success: true, inProgress: true, state });
        }

        return NextResponse.json(
          {
            error: launch.message,
            code: launch.status,
            state,
          },
          { status: launchFailureHttpStatus(launch.status) },
        );
      }
    }

    if (selectedPlan !== "chat_only" && !isPlanAvailable(selectedPlan)) {
      return NextResponse.json(
        {
          error:
            "Full Suite is coming soon. Join the waitlist to be notified when it launches.",
          code: "full_suite_coming_soon",
        },
        { status: 409 },
      );
    }

    // Resolve only the selected plan after all acquisition gates. In
    // particular, unrelated SMS checkout and webhook paths never require the
    // Chat Only Price environment variable while rollout is disabled.
    const priceId = stripePriceIdForPlan(selectedPlan);
    const setupFeePriceId =
      selectedPlan === "chat_only" ? null : stripeSetupFeePriceId();
    const origin = publicAppOrigin(request.nextUrl.origin);
    const successPath =
      mode === "onboarding"
        ? "/onboarding?checkout=success&session_id={CHECKOUT_SESSION_ID}"
        : "/billing?success=true&session_id={CHECKOUT_SESSION_ID}";
    const cancelPath =
      mode === "onboarding"
        ? "/onboarding?checkout=canceled"
        : "/billing?canceled=true";

    const checkoutUrl = await createCheckoutSession(
      business.id,
      selectedPlan,
      priceId,
      setupFeePriceId,
      `${origin}${successPath}`,
      `${origin}${cancelPath}`,
      mode,
      !subscription && mode === "onboarding" && directSelectionFlowEnabled,
    );

    return NextResponse.json({ url: checkoutUrl });
  } catch (error) {
    if (error instanceof ChatOnlyCheckoutRecoveredCompletionError) {
      try {
        const launch = await finalizePaidCheckout(
          error.synced,
          "stripe_finalize",
        );
        const state = await getOnboardingStateForBusinessId(
          error.synced.businessId,
        );
        if (
          launch.status === "completed" ||
          launch.status === "submitted" ||
          launch.status === "already_submitted"
        ) {
          return NextResponse.json({ success: true, state });
        }
        if (launch.status === "in_progress") {
          return NextResponse.json({ success: true, inProgress: true, state });
        }
        return NextResponse.json(
          { error: launch.message, code: launch.status, state },
          { status: launchFailureHttpStatus(launch.status) },
        );
      } catch (completionError) {
        console.error("Recovered Chat Checkout finalization failed", {
          error: checkoutFailureSummary(completionError),
        });
        return NextResponse.json(
          {
            error: "Your payment is still synchronizing. Try again shortly.",
            code: "subscription_payment_sync_required",
          },
          { status: 503 },
        );
      }
    }
    if (error instanceof ChatOnlyCheckoutInProgressError) {
      return NextResponse.json(
        {
          error: "Checkout is being prepared. Try again shortly.",
          code: "chat_only_checkout_in_progress",
        },
        {
          status: 409,
          headers: { "Retry-After": String(error.retryAfterSeconds) },
        },
      );
    }
    if (error instanceof ChatOnlyCheckoutSessionExpiredError) {
      return NextResponse.json(
        {
          error: "Your previous Checkout expired. Try again to continue.",
          code: "chat_only_checkout_expired",
        },
        { status: 409 },
      );
    }
    if (error instanceof ChatOnlyCheckoutAttemptConflictError) {
      return NextResponse.json(
        {
          error:
            "An existing Chat Checkout uses different billing details. Contact support.",
          code: "chat_only_checkout_attempt_conflict",
        },
        { status: 409 },
      );
    }
    if (error instanceof ChatOnlyCheckoutAttemptRecoveryRequiredError) {
      return NextResponse.json(
        {
          error:
            "We could not safely recover the previous Chat Checkout. Contact support before trying again.",
          code: "chat_only_checkout_recovery_required",
        },
        { status: 409 },
      );
    }
    if (error instanceof ChatOnlyCheckoutAttemptUnavailableError) {
      return NextResponse.json(
        {
          error: "Your setup changed. Refresh before trying Checkout again.",
          code: "checkout_plan_state_changed",
        },
        { status: 409 },
      );
    }
    if (error instanceof DirectCheckoutPlanClaimUnavailableError) {
      return NextResponse.json(
        {
          error: "Your setup changed. Refresh and choose your plan again.",
          code: "checkout_plan_state_changed",
        },
        { status: 409 },
      );
    }
    if (error instanceof PlanFamilyTransitionNotSupportedError) {
      return NextResponse.json(
        {
          error:
            "Switching between Chat Only and SMS plans is not supported yet.",
          code: "plan_family_transition_not_supported",
        },
        { status: 409 },
      );
    }
    if (error instanceof ChatOnlyStripePriceConfigurationError) {
      return NextResponse.json(
        {
          error: "Chat Only billing is temporarily unavailable.",
          code: "chat_only_price_configuration_invalid",
        },
        { status: 503 },
      );
    }
    if (error instanceof SmsBillingError) return NextResponse.json({ error: error.code, code: error.code }, { status: error.httpStatus });
    console.error("Checkout failed", { error: checkoutFailureSummary(error) });
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 },
    );
  }
}

function launchFailureHttpStatus(status: string): number {
  if (status === "billing_required") return 402;
  if (status === "rejection_support_required") return 409;
  return 400;
}

function checkoutFailureSummary(error: unknown): {
  name: string;
  status: number | null;
} {
  const rawName = error instanceof Error ? error.name : "UnknownError";
  const name = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(rawName)
    ? rawName
    : "Error";
  const statusValue =
    typeof error === "object" && error !== null && "statusCode" in error
      ? error.statusCode
      : null;
  const status =
    Number.isInteger(statusValue) &&
    (statusValue as number) >= 400 &&
    (statusValue as number) <= 599
      ? (statusValue as number)
      : null;
  return { name, status };
}

async function readCheckoutSubscription(
  supabase: Awaited<ReturnType<typeof createClient>>,
  businessId: string,
): Promise<CheckoutSubscriptionRow | null> {
  const { data, error } = await supabase
    .from("subscriptions")
    .select(
      "plan, status, setup_fee_paid_at, stripe_customer_id, stripe_subscription_id",
    )
    .eq("business_id", businessId)
    .maybeSingle<CheckoutSubscriptionRow>();

  if (error) {
    throw error;
  }

  return data;
}

function hasSatisfiedOnboardingBilling(
  business: CheckoutBusinessRow,
  subscription: CheckoutSubscriptionRow | null,
  selectedPlan: SubscriptionPlan,
): boolean {
  // Keep provisioning aligned with runtime entitlements: a synchronized
  // subscription takes precedence, and protected overrides apply only when
  // there is no subscription row at all.
  if (!subscription) {
    if (selectedPlan === "chat_only") return false;
    return (
      business.billing_pilot ||
      business.billing_comped ||
      business.billing_exempt
    );
  }

  if (selectedPlan === "chat_only" && subscription.plan === "chat_only") {
    return (
      (subscription.status === "active" ||
        subscription.status === "trialing") &&
      Boolean(subscription.stripe_customer_id) &&
      Boolean(subscription.stripe_subscription_id)
    );
  }

  return (
    !!subscription.setup_fee_paid_at &&
    (subscription.status === "active" || subscription.status === "trialing")
  );
}

function hasCrossFamilyTransition(
  subscription: CheckoutSubscriptionRow | null,
  selectedPlan: SubscriptionPlan,
): boolean {
  if (!subscription) return false;

  const parsedCurrentPlan = subscriptionPlanSchema.safeParse(subscription.plan);
  if (!parsedCurrentPlan.success) {
    throw new Error(
      `Existing subscription has an invalid plan: ${String(subscription.plan)}`,
    );
  }

  return (
    (parsedCurrentPlan.data === "chat_only") !== (selectedPlan === "chat_only")
  );
}

function onboardingSelectionMatches(
  business: CheckoutBusinessRow,
  selectedPlan: SubscriptionPlan,
  directSelectionFlowEnabled: boolean,
): boolean {
  // A persisted Chat choice must survive an acquisition rollback. Otherwise a
  // crafted SMS Checkout can claim the opposite family while the UI correctly
  // presents the account as paused Chat onboarding. Legacy null/SMS intent
  // keeps the pre-Chat rollback behavior until direct selection is available.
  if (business.onboarding_selected_plan === "chat_only") {
    return selectedPlan === "chat_only";
  }
  if (!directSelectionFlowEnabled) {
    return selectedPlan !== "chat_only";
  }
  return business.onboarding_selected_plan === selectedPlan;
}
