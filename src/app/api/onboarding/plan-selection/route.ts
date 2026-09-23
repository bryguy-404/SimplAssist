import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { isChatOnlyDirectAcquisitionEnabledForBusiness } from "@/lib/billing/chatOnlyRollout.server";
import { isPlanAvailable } from "@/lib/billing/planAvailability";
import { requireWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { getOnboardingCheckoutContextForBusinessIdReadOnly } from "@/lib/onboarding/state";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { hasValidChatOnlyStripePrice } from "@/lib/stripe/config";
import type {
  BillingMode,
  SubscriptionPlan,
  SubscriptionStatus,
} from "@/types/database";

const PlanSelectionSchema = z
  .object({
    plan: z.enum(["chat_only", "sms_only", "sms_and_chat", "full"]),
  })
  .strict();

type BusinessPlanSelectionRow = {
  id: string;
  owner_id: string;
  partner_id: string | null;
  billing_mode: BillingMode;
  partner_plan: SubscriptionPlan | null;
  onboarding_selected_plan: SubscriptionPlan | null;
  deleted_at: string | null;
  operations_suspended_at: string | null;
  billing_pilot: boolean;
  billing_comped: boolean;
  billing_exempt: boolean;
};

type SubscriptionAuthorityRow = {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
};

function canStartDirectSale(
  businessId: string,
  plan: SubscriptionPlan,
): boolean {
  const selectionFlowEnabled =
    isChatOnlyDirectAcquisitionEnabledForBusiness(businessId) &&
    hasValidChatOnlyStripePrice();
  if (!selectionFlowEnabled) return false;
  return plan === "chat_only" || isPlanAvailable(plan);
}

export async function POST(request: NextRequest) {
  const workspaceGate = await requireWorkspaceRouteAccess();
  if (!workspaceGate.ok) return workspaceGate.response;

  const user = workspaceGate.access.user;
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = PlanSelectionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid plan selection" },
      { status: 400 },
    );
  }

  const businessId = workspaceGate.access.business.id;
  const [businessResult, subscriptionResult] = await Promise.all([
    supabaseAdmin
      .from("businesses")
      .select(
        "id, owner_id, partner_id, billing_mode, partner_plan, onboarding_selected_plan, deleted_at, operations_suspended_at, billing_pilot, billing_comped, billing_exempt",
      )
      .eq("id", businessId)
      .eq("owner_id", user.id)
      .is("deleted_at", null)
      .maybeSingle<BusinessPlanSelectionRow>(),
    supabaseAdmin
      .from("subscriptions")
      .select("plan, status")
      .eq("business_id", businessId)
      .maybeSingle<SubscriptionAuthorityRow>(),
  ]);

  if (
    businessResult.error ||
    subscriptionResult.error ||
    !businessResult.data
  ) {
    console.error(
      `[onboarding:plan-selection] Failed to load billing authority for business ${businessId}`,
    );
    return NextResponse.json(
      { error: "Could not verify plan selection right now" },
      { status: 503 },
    );
  }

  const business = businessResult.data;
  if (
    business.billing_mode !== "stripe" ||
    business.partner_id !== null ||
    business.partner_plan !== null
  ) {
    return NextResponse.json(
      { error: "Your plan is managed by your assigned partner" },
      { status: 403 },
    );
  }

  if (
    business.deleted_at !== null ||
    business.operations_suspended_at !== null ||
    business.billing_pilot !== false ||
    business.billing_comped !== false ||
    business.billing_exempt !== false
  ) {
    return NextResponse.json(
      { error: "That plan is not available for selection" },
      { status: 403 },
    );
  }

  if (subscriptionResult.data) {
    return NextResponse.json(
      {
        error: "Your subscription already determines your onboarding plan",
        plan: subscriptionResult.data.plan,
      },
      { status: 409 },
    );
  }

  const plan = parsed.data.plan as SubscriptionPlan;
  if (!canStartDirectSale(business.id, plan)) {
    return NextResponse.json(
      { error: "That plan is not available for selection" },
      { status: 403 },
    );
  }

  if (plan === "chat_only") {
    // Mirror the server-rendered options, including actual SMS provider
    // history. The atomic writer still protects against a concurrent family
    // claim; this read must never synchronize progress or provision resources.
    let context;
    try {
      context = await getOnboardingCheckoutContextForBusinessIdReadOnly(businessId);
    } catch {
      context = null;
    }
    if (!context) {
      return NextResponse.json(
        { error: "Could not verify plan selection right now" },
        { status: 503 },
      );
    }
    if (!context.state.planSelection.chatOnlyDirectSalesAvailable) {
      return NextResponse.json(
        {
          error: context.state.planSelection.familyChangeRequiresSupport
            ? "Switching between Chat Only and texting requires support for this account."
            : "That plan is not available for selection",
          ...(context.state.planSelection.familyChangeRequiresSupport
            ? { code: "plan_family_transition_not_supported" }
            : {}),
        },
        { status: context.state.planSelection.familyChangeRequiresSupport ? 409 : 403 },
      );
    }
  }

  const { data: updated, error: updateError } = await supabaseAdmin.rpc(
    "save_direct_onboarding_plan_intent",
    {
      p_business_id: businessId,
      p_owner_id: user.id,
      p_expected_plan: business.onboarding_selected_plan,
      p_requested_plan: plan,
    },
  );

  if (updateError) {
    if (
      updateError.code === "55000" &&
      updateError.message.includes("plan_family_transition_not_supported")
    ) {
      return NextResponse.json(
        {
          error:
            "That plan conflicts with billing setup already started for this account.",
          code: "plan_family_transition_not_supported",
        },
        { status: 409 },
      );
    }

    console.error(
      `[onboarding:plan-selection] Failed to save selection for business ${businessId}`,
    );
    return NextResponse.json(
      { error: "Could not save your plan choice" },
      { status: 500 },
    );
  }

  if (updated !== true) {
    return NextResponse.json(
      { error: "Your setup changed. Refresh and choose again." },
      { status: 409 },
    );
  }

  return NextResponse.json({ success: true, plan });
}
