import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isEmailReviewsEnabledForBusiness } from "./config";
import {
  confirmReviewCampaign,
  createReviewPreview,
  ReviewError,
  reviewRpc,
} from "./service.server";
import { signReviewToken } from "./domain";
type Event = {
  id: string;
  business_id: string;
  owner_id: string;
  contact_id: string;
  channel: "email" | "sms";
  scheduled_at: string;
  claim_token: string;
};
export async function runReviewAutomationWorker() {
  const events = await reviewRpc<Event[]>("review_claim_automations", {
    p_limit: 3,
  });
  let enrolled = 0;
  for (const event of events) {
    if (!isEmailReviewsEnabledForBusiness(event.business_id)) continue;
    try {
      const existing = await supabaseAdmin
        .from("review_campaign_previews")
        .select("id,expires_at,campaign_id,settings_revision")
        .eq("id", event.id)
        .maybeSingle();
      if (existing.error) throw new Error("review_storage_unavailable");
      if (existing.data && !existing.data.campaign_id) {
        const current = await supabaseAdmin
          .from("review_settings")
          .select("revision")
          .eq("business_id", event.business_id)
          .single();
        if (current.error) throw new Error("review_storage_unavailable");
        if (
          Date.parse(existing.data.expires_at) <= Date.now() ||
          existing.data.settings_revision !== current.data.revision
        ) {
          const cleared = await supabaseAdmin
            .from("review_campaign_previews")
            .delete()
            .eq("id", event.id)
            .is("campaign_id", null);
          if (cleared.error) throw new Error("review_storage_unavailable");
          existing.data = null;
        }
      }
      if (!existing.data) {
        const preview = await createReviewPreview(
          event.business_id,
          event.owner_id,
          {
            contactIds: [event.contact_id],
            channel: event.channel,
            scheduledAt: event.scheduled_at,
            completedServiceConfirmed: true,
            permissionConfirmed: true,
          },
          { previewId: event.id },
        );
        if (!preview.summary.eligible)
          throw new ReviewError("review_automation_recipient_ineligible");
      }
      await confirmReviewCampaign(
        event.business_id,
        event.owner_id,
        signReviewToken(event.id, "preview"),
      );
      enrolled++;
    } catch (error) {
      // Definitive state changes need an explicit new manual request; transient
      // storage failures can reclaim the same source/preview without duplicates.
      if (
        error instanceof ReviewError &&
        error.status !== 503 &&
        ![
          "review_sending_unavailable",
          "review_sms_setup_required",
          "review_settings_or_eligibility_changed",
        ].includes(error.message)
      )
        await supabaseAdmin
          .from("review_automation_events")
          .update({
            status: "blocked",
            last_error: error.message,
            claim_token: null,
            lease_until: null,
          })
          .eq("id", event.id)
          .eq("claim_token", event.claim_token)
          .eq("status", "claimed");
    }
  }
  return { enrolled };
}
