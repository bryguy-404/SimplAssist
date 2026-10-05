import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Called after durable inbound/control handling and before any SMS AI work. */
export async function isReviewTextingHandoffPaused(businessId: string) {
  const { data, error } = await supabaseAdmin.rpc("review_texting_upgrade_sms_paused", { p_business: businessId });
  if (error || typeof data !== "boolean") throw new Error("Texting handoff status unavailable");
  return data;
}

export async function reconcileReviewTextingCampaignEvent(campaignId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.from("review_texting_provider_upgrades")
    .select("upgrade_id,stage").eq("candidate_campaign_id", campaignId).maybeSingle();
  if (error) throw new Error("Review upgrade callback unavailable");
  if (!data || data.stage === "review_ready") return false;
  const { reconcileReviewTextingProvider } = await import("./reviewTextingProvider.server");
  await reconcileReviewTextingProvider(data.upgrade_id);
  return true;
}
