import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  continueReviewSmsProvisioning,
  initializeIncludedReviewSmsSignup,
  refreshReviewSmsProviderReadiness,
} from "./smsProvisioning.server";
import {
  deactivateTelnyxCampaign,
  releaseTelnyxPhoneNumber,
  unassignTelnyxPhoneNumberCampaign,
  TelnyxRemoteMutationAuthorizationError,
} from "@/lib/messaging/telnyxDestructive";
import { ReviewSmsError } from "@/lib/billing/reviewSms";
import {
  readReviewSmsAccount,
  reconcileReviewSmsSubscription,
} from "@/lib/stripe/reviewSms.server";
import { stripe } from "@/lib/stripe/client";
import { classifySubscriptionItems } from "@/lib/stripe/subscriptionItems";
import {
  isReviewSmsEnabled,
  reviewSmsSignupScope,
} from "@/lib/billing/reviewSmsRollout.server";

async function initializeNewSignupAccounts() {
  const scope = reviewSmsSignupScope();
  if (!scope) return;
  const { data, error } = await supabaseAdmin.rpc("review_sms_signup_candidates", {
    p_allowed_businesses: scope.businessIds,
    p_excluded_businesses: scope.excludedBusinessIds,
    p_limit: 5,
  });
  if (error) throw new ReviewSmsError("review_sms_state_unavailable", 503);
  for (const candidate of (data ?? []) as {
    business_id: string;
    owner_id: string;
  }[]) {
    // Recheck the rollout at the mutation boundary; SQL rechecks ownership,
    // billing and the owner's explicit choice under the account lock.
    if (!isReviewSmsEnabled(candidate.business_id)) continue;
    try {
      await initializeIncludedReviewSmsSignup(
        candidate.business_id,
        candidate.owner_id,
      );
    } catch {
      // One raced ownership/payment change must not prevent later accounts
      // from being initialized, or block existing-account release cleanup.
    }
  }
}

async function refreshDirectBilling(account: {
  business_id: string;
  billing_source: string;
  source_subscription_id: string | null;
  source_customer_id: string | null;
}) {
  if (account.billing_source !== "direct") return true;
  if (!account.source_subscription_id || !account.source_customer_id)
    throw new ReviewSmsError("review_sms_billing_source_changed");
  const subscription = await stripe.subscriptions.retrieve(
    account.source_subscription_id,
  );
  const customer =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer?.id;
  if (
    subscription.id !== account.source_subscription_id ||
    customer !== account.source_customer_id ||
    subscription.metadata.business_id !== account.business_id
  )
    throw new ReviewSmsError("review_sms_billing_source_changed");
  await reconcileReviewSmsSubscription(subscription);
  const { reviewSms } = classifySubscriptionItems(subscription);
  // Invoice reconciliation can intentionally leave access unchanged. A live
  // provider item or pending payment still prevents abandonment cleanup;
  // retaining a resource does not grant sending permission.
  return (
    !subscription.pending_update &&
    !(reviewSms && reviewSms.current_period_end * 1000 > Date.now())
  );
}

/** Runs independently of the outbound-send switches, so cancellation cannot
 * leave a chargeable number/campaign behind just because sending is paused. */
export async function runReviewSmsLifecycle() {
  try {
    const { runReviewTextingProviderLifecycle } = await import("@/lib/billing/reviewTextingProvider.server");
    await runReviewTextingProviderLifecycle();
  } catch {
    console.warn("[review-sms] Texting upgrade reconciliation unavailable; will retry.");
  }
  try {
    await initializeNewSignupAccounts();
  } catch {
    // Initialization is retried next tick. Existing reconciliation and resource
    // cleanup remain independent of a failure in the new-signup scan.
    console.warn("[review-sms] Signup initialization unavailable; will retry.");
  }
  const { data: accounts, error } = await supabaseAdmin
    .from("review_sms_accounts")
    .select(
      "business_id,state,source_subscription_id,source_customer_id,billing_source,updated_at",
    )
    .in("state", [
      "carrier_pending",
      "ready_unpaid",
      "active",
      "cancel_pending",
      "release_pending",
    ])
    .order("updated_at")
    .limit(1);
  if (error) throw new ReviewSmsError("review_sms_state_unavailable", 503);
  let checked = 0;
  for (const account of accounts ?? []) {
    try {
      let canPrepareRelease = true;
      if (account.state === "carrier_pending")
        await continueReviewSmsProvisioning(account.business_id);
      if (["carrier_pending", "ready_unpaid"].includes(account.state))
        await refreshReviewSmsProviderReadiness(account.business_id);
      if (
        [
          "ready_unpaid",
          "active",
          "cancel_pending",
          "release_pending",
        ].includes(account.state)
      )
        canPrepareRelease = await refreshDirectBilling(account);
      if (canPrepareRelease) {
        const { error: prepareError } = await supabaseAdmin.rpc(
          "review_sms_prepare_release",
          { p_business: account.business_id },
        );
        if (prepareError) throw prepareError;
      }
      checked++;
    } catch {
      await supabaseAdmin
        .from("review_sms_accounts")
        .update({ last_error: "review_sms_reconciliation_needed" })
        .eq("business_id", account.business_id);
    }
    // Round-robin progress: one slow account never starves later accounts.
    await supabaseAdmin
      .from("review_sms_accounts")
      .update({ updated_at: new Date().toISOString() })
      .eq("business_id", account.business_id);
  }
  if (
    process.env.REVIEWS_SMS_RELEASE_ENABLED !== "1" ||
    process.env.TELNYX_REMOTE_RELEASE_ENABLED !== "1"
  )
    return { checked, released: 0 };
  const { data: actions, error: claimError } = await supabaseAdmin.rpc(
    "review_sms_claim_release",
  );
  if (claimError)
    throw new ReviewSmsError("review_sms_release_unavailable", 503);
  let released = 0;
  for (const action of (actions ?? []) as {
    id: string;
    business_id: string;
    operation: string;
    provider_id: string;
    claim_token: string;
  }[]) {
    const scope = {
      businessId: action.business_id,
      context: "review_sms_release" as const,
      providerId: action.provider_id,
      actionId: action.id,
      leaseToken: action.claim_token,
    };
    let started = false;
    const begin = async () => {
      if (
        process.env.REVIEWS_SMS_RELEASE_ENABLED !== "1" ||
        process.env.TELNYX_REMOTE_RELEASE_ENABLED !== "1"
      )
        return "skip" as const;
      const { data, error } = await supabaseAdmin
        .from("review_sms_release_actions")
        .update({ state: "submitting", started_at: new Date().toISOString() })
        .eq("id", action.id)
        .eq("state", "claimed")
        .eq("claim_token", action.claim_token)
        .select("id")
        .maybeSingle();
      if (error)
        throw new ReviewSmsError("review_sms_release_unavailable", 503);
      started = !!data;
      return data ? ("proceed" as const) : ("skip" as const);
    };
    try {
      // This action may belong to a different account than the one reconciled
      // above. A missed payment webhook must never make a paid resource look
      // abandoned at the destructive boundary.
      const account = await readReviewSmsAccount(action.business_id);
      if (!account || account.state !== "release_pending")
        throw new ReviewSmsError("review_sms_release_not_due");
      if (!(await refreshDirectBilling(account)))
        throw new ReviewSmsError("review_sms_release_not_due");
      if (action.operation === "deactivate_campaign") {
        const result = await deactivateTelnyxCampaign(scope, {
          beforeMutation: begin,
        });
        if (result === "skipped") continue;
      } else if ((await begin()) === "proceed") {
        if (action.operation === "unassign_phone_number_campaign")
          await unassignTelnyxPhoneNumberCampaign(scope);
        else if (action.operation === "release_phone_number")
          await releaseTelnyxPhoneNumber(scope);
        else throw new ReviewSmsError("review_sms_release_operation_invalid");
      }
      if (!started) continue;
      const { data: finished, error: finishError } = await supabaseAdmin.rpc(
        "review_sms_finish_release",
        {
          p_action: action.id,
          p_claim: action.claim_token,
          p_success: true,
          p_error: null,
        },
      );
      if (finishError) throw finishError;
      if (finished === true) released++;
    } catch (error) {
      if (!started || error instanceof TelnyxRemoteMutationAuthorizationError) {
        await supabaseAdmin
          .from("review_sms_release_actions")
          .update({ state: "pending", claim_token: null, lease_until: null })
          .eq("id", action.id)
          .eq("claim_token", action.claim_token);
      } else
        await supabaseAdmin.rpc("review_sms_finish_release", {
          p_action: action.id,
          p_claim: action.claim_token,
          p_success: false,
          p_error: "provider_release_outcome_unknown",
        });
    }
  }
  return { checked, released };
}
