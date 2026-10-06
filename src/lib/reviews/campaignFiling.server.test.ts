import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/messaging/client", () => ({ telnyx: {} }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));
import type { ReviewSmsAccount } from "@/lib/billing/reviewSms";
import { buildReviewCampaignFiling, reviewCampaignFilingHash, reviewSmsCampaignMatches } from "./campaignFiling.server";
import { keywordProgramFromCampaign, reviewSmsKeywordProgram } from "./smsKeywords.server";

const business = {
  name: "Example Services", telnyx_brand_id: "brand-existing", authorized_rep_email: "owner@example.test",
  slug: "example-services", privacy_terms_mode: "hosted" as const, privacy_url_override: null, terms_url_override: null,
};
const account = {
  id: "10000000-0000-4000-8000-000000000001",
  draft: { phoneNumber: "+15745550123", consentMode: "hosted_keyword", consentDescription: "Text REVIEWS to subscribe.", consentEvidenceUrl: "https://example.test/consent" },
} as unknown as ReviewSmsAccount;
beforeEach(() => vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://simplassist.com"));
afterEach(() => vi.unstubAllEnvs());

describe("review MARKETING campaign keyword filing", () => {
  it.each(["hosted_keyword", "existing_consent"])("uses carrier-safe declarations for %s and reconstructs the same profile", consentMode => {
    const filing = buildReviewCampaignFiling({ ...account, draft: { ...account.draft, consentMode } }, business, null);
    expect(filing.usecase).toBe("MARKETING");
    for (const value of [filing.optinKeywords, filing.optoutKeywords, filing.helpKeywords])
      expect(value).toMatch(/^[A-Za-z0-9]+(?:,[A-Za-z0-9]+)*$/);
    expect(filing.optoutKeywords).toBe("STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT,REVOKE");
    expect(keywordProgramFromCampaign(filing, business.name)).toEqual(reviewSmsKeywordProgram(business.name, business.authorized_rep_email));
  });
  it("reconciles a frozen historical filing exactly without rewriting its keyword evidence or hash", () => {
    const current = buildReviewCampaignFiling(account, business, null);
    const historical = Object.freeze({ ...current, optoutKeywords: reviewSmsKeywordProgram(business.name, business.authorized_rep_email).stop.keywords.join(",") });
    const hash = reviewCampaignFilingHash(historical);
    expect(reviewSmsCampaignMatches({ ...historical, campaignId: "historical-campaign" }, historical)).toBe(true);
    expect(reviewSmsCampaignMatches(current, historical)).toBe(false);
    expect(historical.optoutKeywords).toContain("STOP ALL");
    expect(historical.optoutKeywords).toContain("OPT OUT");
    expect(reviewCampaignFilingHash(historical)).toBe(hash);
  });
});
