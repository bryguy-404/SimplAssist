import { describe, expect, it } from "vitest";
import { buildPrivacyContent, buildTermsContent, toPlainText } from "./perBusinessCopy";

const business = {
  name: "Northstar", phone_number: "+13175550100", sms_phone_number: "+13175550101",
  email: "help@example.test", address: null, city: null, state: null, zip: null,
  opt_in_description: "Old frozen snapshot", review_consent_url: "https://example.test/c/northstar/review-texts",
};
describe("public review texting program disclosures", () => {
  it.each([buildPrivacyContent, buildTermsContent])("adds separate review permission to MIXED programs", (build) => {
    const text = toPlainText(build({ ...business, review_sms_signup_enabled: true }));
    expect(text).toContain("missed-call follow-ups");
    expect(text).toContain("text REVIEWS to +13175550101");
    expect(text).toContain("automated marketing text messages");
    expect(text).toContain("START restores messaging availability but does not restore review-text permission");
    expect(text).not.toContain("Old frozen snapshot");
  });
  it.each([buildPrivacyContent, buildTermsContent])("describes review-only Chat without inventing customer care or voicemail", (build) => {
    const text = toPlainText(build({ ...business, review_sms_only: true }));
    expect(text).toContain("text REVIEWS to +13175550101");
    expect(text).toContain("at most one reminder");
    expect(text).not.toContain("missed-call follow-ups");
    expect(text).not.toContain("voicemail disclosure");
    expect(text).toContain("not a condition of purchase");
  });
  it("leaves customer-care-only account copy unchanged", () => {
    const text = toPlainText(buildPrivacyContent(business));
    expect(text).toContain("customer-care text messages");
    expect(text).not.toContain("text REVIEWS");
  });
});
