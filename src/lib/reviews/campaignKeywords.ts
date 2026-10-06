import { ReviewSmsError } from "@/lib/billing/reviewSms";

// Telnyx campaign declarations accept comma-separated alphanumeric words.
// These two aliases remain in inbound handling and messaging-profile rules.
export const reviewInboundOnlyAliases = ["STOP ALL", "OPT OUT"] as const;

export function serializeReviewCampaignKeywords(keywords: readonly string[]): string {
  const declared = keywords.filter(
    (word) => !reviewInboundOnlyAliases.some((alias) => alias === word),
  );
  if (!declared.length || declared.some((word) => typeof word !== "string" || !word.length || /[^A-Za-z0-9]/.test(word)))
    throw new ReviewSmsError("review_sms_campaign_keywords_invalid");
  return declared.join(",");
}
