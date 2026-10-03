import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { telnyx } from "@/lib/messaging/client";
import { ReviewSmsError } from "@/lib/billing/reviewSms";
import { isReviewSmsEnabled } from "@/lib/billing/reviewSmsRollout.server";
import { ensureReviewSmsKeywords, keywordProgramFromCampaign } from "./smsKeywords.server";

type CampaignCopy = Parameters<typeof keywordProgramFromCampaign>[0];

/** Only an unused, provenance-checked new tenant profile may get responders.
 * Never rewrite a working customer-care campaign during review enrollment. */
export async function ensureSignupReviewSmsKeywords(businessId: string, copy: CampaignCopy) {
  const assertOwned = async () => {
    if (!isReviewSmsEnabled(businessId) || process.env.REVIEWS_SMS_PROVISIONING_ENABLED !== "1")
      throw new ReviewSmsError("review_sms_provisioning_stopped");
    const { data: b, error } = await supabaseAdmin.from("businesses").select("id,name,owner_id,created_at,review_sms_signup_enabled,telnyx_campaign_id,telnyx_messaging_profile_id,deleted_at,operations_suspended_at,telnyx_submission_disabled").eq("id", businessId).single();
    if (error || !b || !b.owner_id || !b.review_sms_signup_enabled || b.telnyx_campaign_id || !b.telnyx_messaging_profile_id || b.deleted_at || b.operations_suspended_at || b.telnyx_submission_disabled)
      throw new ReviewSmsError("review_sms_keyword_profile_not_owned");
    const { data: phone, error: phoneError } = await supabaseAdmin.from("phone_numbers").select("phone_number").eq("business_id", businessId).eq("is_active", true).single();
    const profiles = [process.env.TELNYX_PROTECTED_MESSAGING_PROFILE_ID, process.env.TELNYX_MESSAGING_PROFILE_ID].filter((v): v is string => !!v?.trim());
    const { data: safe, error: scopeError } = await supabaseAdmin.rpc("review_sms_resource_scope_safe", {p_business: businessId, p_profile: b.telnyx_messaging_profile_id, p_sender: phone?.phone_number, p_campaign: null, p_forbidden_profiles: profiles});
    if (phoneError || !phone || scopeError || safe !== true)
      throw new ReviewSmsError("review_sms_resource_scope_denied");
    const { data: event, error: eventError } = await supabaseAdmin.from("telnyx_registration_events").select("id").eq("business_id", businessId).eq("event_type", "messaging_profile_created").eq("telnyx_resource_id", b.telnyx_messaging_profile_id).eq("status", "success").gte("created_at", b.created_at).limit(1).maybeSingle();
    const {data: profile} = await telnyx.messagingProfiles.retrieve(b.telnyx_messaging_profile_id, {maxRetries:0, timeout:10000});
    if (eventError || !event || !profile || profile.id !== b.telnyx_messaging_profile_id || !profile.name?.trim().endsWith(`(${businessId})`) || !Number.isFinite(Date.parse(profile.created_at ?? "")) || !Number.isFinite(Date.parse(b.created_at)) || Date.parse(profile.created_at!) < Date.parse(b.created_at))
      throw new ReviewSmsError("review_sms_keyword_profile_not_owned");
    return b;
  };
  const b = await assertOwned();
  await ensureReviewSmsKeywords({businessId, profileId: b.telnyx_messaging_profile_id, program: keywordProgramFromCampaign(copy, b.name), authorizeMutation: async () => {
    const current = await assertOwned();
    if (current.telnyx_messaging_profile_id !== b.telnyx_messaging_profile_id || current.owner_id !== b.owner_id)
      throw new ReviewSmsError("review_sms_keyword_profile_not_owned");
  }});
}
