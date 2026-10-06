import { describe, expect, it } from "vitest";
import { serializeReviewCampaignKeywords } from "./campaignKeywords";

describe("review carrier keyword declarations", () => {
  it("omits only the known multiword inbound aliases without mutating the profile", () => {
    const words = Object.freeze(["STOP", "STOPALL", "STOP ALL", "REVOKE", "OPT OUT"]);
    expect(serializeReviewCampaignKeywords(words)).toBe("STOP,STOPALL,REVOKE");
    expect(words).toEqual(["STOP", "STOPALL", "STOP ALL", "REVOKE", "OPT OUT"]);
    expect(serializeReviewCampaignKeywords(["START", "UNSTOP"])).toBe("START,UNSTOP");
  });
  it.each([
    [], ["STOP ALL", "OPT OUT"], [""], ["STOP", "QUIT NOW"],
    [" STOP"], ["OPT  OUT"], ["opt out"], ["STOP\n"], ["STOP,END"],
    ["STOP-ALL"], ["STÖP"], [123 as unknown as string],
  ].map(words => ({ words })))("rejects empty or unsupported declarations rather than silently rewriting them: $words", ({ words }) => {
    expect(() => serializeReviewCampaignKeywords(words)).toThrow("review_sms_campaign_keywords_invalid");
  });
});
