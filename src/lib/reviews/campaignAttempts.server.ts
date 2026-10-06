import "server-only";
import { supabaseAdmin as db } from "@/lib/supabase/admin";
import { ReviewSmsError } from "@/lib/billing/reviewSms";
import { serializeCampaignError, logCampaignError } from "./campaignDiagnostics.server";

export interface ReviewCampaignAttempt {
  id: string; business_id: string; account_id: string; owner_id: string;
  attempt_number: number; reference_id: string; payload_hash: string;
  filing: Record<string, unknown>; state: string; reservation_id: string | null;
  original_reservation_id: string | null; provider_campaign_id: string | null; response_campaign_id?: string | null;
  started_at: string | null; diagnostics: Record<string, unknown> | null;
}
export async function campaignAttemptRpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await db.rpc(name, args);
  if (result.error) throw new ReviewSmsError(
    /^review_sms_[a-z_]+$/.test(result.error.message) ? result.error.message : "review_sms_campaign_audit_unavailable", 503,
  );
  return result.data as T;
}
export async function readReviewCampaignAttempts(businessId: string): Promise<ReviewCampaignAttempt[]> {
  const { data, error } = await db.from("review_sms_campaign_attempts")
    .select("*").eq("business_id", businessId).order("attempt_number");
  if (error) throw new ReviewSmsError("review_sms_campaign_audit_unavailable", 503);
  return data ?? [];
}
export async function reviewCampaignReference(businessId: string, accountId: string, campaignId: string) {
  const { data, error } = await db.from("review_sms_campaign_attempts")
    .select("reference_id").eq("business_id", businessId).eq("account_id", accountId)
    .eq("provider_campaign_id", campaignId).eq("state", "accepted").maybeSingle();
  if (error) throw new ReviewSmsError("review_sms_campaign_audit_unavailable", 503);
  return data?.reference_id ?? `reviews:${accountId}`;
}
export async function captureReviewCampaignFailure(args: {
  businessId: string; attemptId: string; claim: string; error: unknown;
  phase: string; sensitiveValues?: string[]; responseCampaignId?: string | null;
}) {
  const diagnostics = serializeCampaignError(args.error, { sensitiveValues: args.sensitiveValues });
  logCampaignError({ businessId: args.businessId, attemptId: args.attemptId, phase: args.phase, error: diagnostics });
  try {
    await campaignAttemptRpc("review_sms_finish_campaign_attempt", {
      p_attempt: args.attemptId, p_claim: args.claim, p_outcome: "unknown",
      p_provider_campaign_id: args.responseCampaignId ?? null, p_diagnostics: { ...diagnostics, phase: args.phase },
    });
  } catch (auditError) {
    // Durable-write failure must not erase the original provider evidence in Railway.
    logCampaignError({ businessId: args.businessId, attemptId: args.attemptId, phase: "diagnostic_save", error: serializeCampaignError(auditError) });
  }
}
