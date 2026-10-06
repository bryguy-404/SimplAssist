import "server-only";
import { telnyx } from "@/lib/messaging/client";
import { ReviewSmsError } from "@/lib/billing/reviewSms";

/** Explicit, bounded pages: never infer absence from an incomplete inventory. */
export async function readReviewCampaignInventory(brandId: string) {
  const records: Array<{ campaignId: string; referenceId?: string; brandId?: string }> = [];
  let total: number | undefined;
  const observedAt = new Date().toISOString();
  for (let page = 1; page <= 5; page++) {
    const response = await telnyx.messaging10dlc.campaign.list(
      { brandId, page, recordsPerPage: 100 }, { maxRetries: 0, timeout: 5000 },
    );
    if (response.page !== page || !Number.isInteger(response.totalRecords) || response.totalRecords < 0 ||
      !Array.isArray(response.records) || (total !== undefined && total !== response.totalRecords))
      throw new ReviewSmsError("review_sms_campaign_inventory_incomplete", 503);
    total = response.totalRecords;
    for (const item of response.records) {
      if (!item || typeof item !== "object" || item.brandId !== brandId ||
        typeof item.campaignId !== "string" || !item.campaignId.trim() || item.campaignId.length > 128 ||
        item.campaignId !== item.campaignId.trim() ||
        (item.referenceId != null && typeof item.referenceId !== "string") ||
        records.some(r => r.campaignId === item.campaignId))
        throw new ReviewSmsError("review_sms_campaign_inventory_incomplete", 503);
      records.push(item as typeof records[number]);
    }
    if (records.length === total) return { records, observedAt };
    if (!response.records.length || records.length > total) break;
  }
  throw new ReviewSmsError("review_sms_campaign_inventory_incomplete", 503);
}
