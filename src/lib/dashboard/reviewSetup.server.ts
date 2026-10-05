import "server-only";

import { supabaseAdmin } from "@/lib/supabase/admin";
import { isEmailReviewsEnabledForBusiness } from "@/lib/reviews/config";
import type { BusinessEntitlements } from "@/lib/billing/entitlements";
import type { DashboardBusinessContext } from "./context";

export type ReviewSetupStep = "add_link" | "finish_setup";

/** Read only, using the business resolved for the authenticated dashboard owner. */
export async function getDashboardReviewSetup(
  context: Extract<DashboardBusinessContext, { status: "resolved" }>,
  entitlements: BusinessEntitlements,
): Promise<ReviewSetupStep | null> {
  const { business, user } = context;
  if (
    !isEmailReviewsEnabledForBusiness(business.id) ||
    business.deleted_at || business.operations_suspended_at || business.partner_id ||
    !entitlements.active || entitlements.status !== "active" || entitlements.cancelAtPeriodEnd ||
    entitlements.businessId !== business.id
  ) return null;

  try {
    // Opening the dashboard must not initialize settings or send anything.
    const { data, error } = await supabaseAdmin
      .from("review_settings")
      .select("google_review_url,reply_to_verified_at,paused")
      .eq("business_id", business.id)
      .eq("owner_id", user.id)
      .maybeSingle();
    if (error || data?.paused) return null;
    if (!data?.google_review_url) return "add_link";
    return data.reply_to_verified_at ? null : "finish_setup";
  } catch {
    // An optional invitation must never prevent the dashboard from loading.
    return null;
  }
}
