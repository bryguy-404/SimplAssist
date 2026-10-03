import { NextResponse } from "next/server";
import { requireFreshWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { ReviewSmsError } from "@/lib/billing/reviewSms";
import { reviewOrigin } from "@/lib/reviews/domain";
import {
  reviewSmsOverview,
  createReviewSmsActivationCheckout,
  quoteReviewSmsRecurring,
  confirmReviewSmsRecurring,
  cancelReviewSmsAtPeriodEnd,
  refundUnsubmittedReviewSmsActivation,
  readReviewSmsAccount,
  synchronizeReviewSmsCheckout,
  reconcileReviewSmsSubscription,
} from "@/lib/stripe/reviewSms.server";
import {
  continueReviewSmsProvisioning,
  refreshReviewSmsProviderReadiness,
  reviewSmsSetupOverview,
  saveReviewSmsSetup,
  initializeIncludedReviewSmsSignup,
} from "@/lib/reviews/smsProvisioning.server";
import { stripe } from "@/lib/stripe/client";
import { supabaseAdmin } from "@/lib/supabase/admin";
export const dynamic = "force-dynamic";
async function route(
  action: (businessId: string, ownerId: string) => Promise<unknown>,
) {
  const access = await requireFreshWorkspaceRouteAccess();
  if (!access.ok) return access.response;
  try {
    return NextResponse.json(
      await action(access.access.business.id, access.access.user.id),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof ReviewSmsError
            ? error.code
            : "review_sms_request_failed",
      },
      { status: error instanceof ReviewSmsError ? error.status : 503 },
    );
  }
}
async function overview(businessId: string, ownerId: string) {
  await initializeIncludedReviewSmsSignup(businessId, ownerId);
  return {
    ...(await reviewSmsOverview(businessId, ownerId)),
    setup: await reviewSmsSetupOverview(businessId),
  };
}
export const GET = () => route(overview);
export const POST = (request: Request) =>
  route(async (businessId, ownerId) => {
    const text = await request.text();
    if (text.length > 10000)
      throw new ReviewSmsError("review_sms_request_too_large", 413);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error();
    } catch {
      throw new ReviewSmsError("review_sms_invalid_request", 400);
    }
    switch (body.action) {
      case "draft":
        if (
          !body.draft ||
          typeof body.draft !== "object" ||
          Array.isArray(body.draft)
        )
          throw new ReviewSmsError("review_sms_invalid_request", 400);
        return saveReviewSmsSetup(
          businessId,
          ownerId,
          body.draft as Record<string, unknown>,
        );
      case "checkout":
        return createReviewSmsActivationCheckout(
          businessId,
          ownerId,
          reviewOrigin(),
        );
      case "quote":
        return quoteReviewSmsRecurring(businessId, ownerId);
      case "activate":
        return confirmReviewSmsRecurring(
          businessId,
          ownerId,
          String(body.operationId ?? ""),
          String(body.fingerprint ?? ""),
        );
      case "cancel":
        return cancelReviewSmsAtPeriodEnd(businessId, ownerId);
      case "refund":
        return refundUnsubmittedReviewSmsActivation(businessId, ownerId);
      case "refresh": {
        const a = await readReviewSmsAccount(businessId);
        if (!a) return overview(businessId, ownerId);
        const { data, error } = await supabaseAdmin
          .from("review_sms_billing_operations")
          .select("checkout_session_id")
          .eq("account_id", a.id)
          .eq("kind", "activation")
          .eq("state", "confirmed")
          .maybeSingle();
        if (error)
          throw new ReviewSmsError("review_sms_state_unavailable", 503);
        if (data?.checkout_session_id)
          await synchronizeReviewSmsCheckout(
            await stripe.checkout.sessions.retrieve(data.checkout_session_id),
          );
        await continueReviewSmsProvisioning(businessId);
        await refreshReviewSmsProviderReadiness(businessId);
        if (a.billing_source === "direct" && a.source_subscription_id)
          await reconcileReviewSmsSubscription(
            await stripe.subscriptions.retrieve(a.source_subscription_id),
          );
        return overview(businessId, ownerId);
      }
      default:
        throw new ReviewSmsError("review_sms_invalid_action", 400);
    }
  });
