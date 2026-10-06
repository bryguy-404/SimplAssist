import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock("@/lib/messaging/client", () => ({ telnyx: {} }));
vi.mock("@/lib/messaging/registration/riskScreening", () => ({ getA2pRiskClearanceForBusiness: vi.fn() }));
vi.mock("@/lib/reviews/consent.server", () => ({ processReviewTextConsent: vi.fn() }));
import { buildReviewUpgradeFiling, reviewUpgradeCandidateMatches } from "./reviewTextingProvider.server";
import type { Business } from "@/types/database";
import { keywordProgramFromCampaign, reviewSmsKeywordProgram } from "@/lib/reviews/smsKeywords.server";
const upgradeId = "10000000-0000-4000-a115-000000000099";
const business = { name: "Acme", business_type: "plumbing", email: "support@example.test", phone_number: "+15745550123", slug: "acme-test", privacy_terms_mode: "hosted", privacy_url_override: null, terms_url_override: null, authorized_rep_email: "help@example.test", telnyx_brand_id: "brand-approved" } as unknown as Business;
beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://simplassist.com"); });
afterEach(() => vi.unstubAllEnvs());
const filing = () => buildReviewUpgradeFiling(business, upgradeId, "+15745550123");
const proof = () => ({ filing: filing(), brand_id: "brand-approved", upgrade_id: upgradeId });
describe("review conversion mixed-campaign filing", () => {
  it("uses carrier-safe MIXED keywords while reconstructing the unchanged profile program", () => {
    const value = filing();
    for (const words of [value.optinKeywords, value.optoutKeywords, value.helpKeywords])
      expect(words).toMatch(/^[A-Za-z0-9]+(?:,[A-Za-z0-9]+)*$/);
    expect(value.optoutKeywords).toBe("STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT,REVOKE");
    expect(keywordProgramFromCampaign(value, business.name)).toEqual(reviewSmsKeywordProgram("Acme", "help@example.test"));
  });
  it("keeps the original approved brand and exact upgrade identity", () => {
    const value = filing();
    expect(value).toMatchObject({ brandId: "brand-approved", referenceId: `upgrade:${upgradeId}`, usecase: "MIXED", subUsecases: ["CUSTOMER_CARE", "MARKETING"], embeddedLink: true, subscriberOptin: true, subscriberOptout: true, subscriberHelp: true, optinKeywords: "REVIEWS" });
    expect(value.privacyPolicyLink).toBe("https://simplassist.com/c/acme-test/privacy");
    expect(value.termsAndConditionsLink).toBe("https://simplassist.com/c/acme-test/terms");
    expect(value.webhookURL).toBe("https://simplassist.com/api/messaging/registration/status");
  });
  it("describes distinct review and customer-care opt-in without treating START as permission", () => {
    const value = filing();
    expect(value.description).toContain("Customer-care permission does not authorize review texts");
    expect(value.messageFlow).toContain("https://simplassist.com/c/acme-test/review-texts");
    expect(value.messageFlow).toContain("+15745550123");
    expect(value.messageFlow).toContain("Customer-care permission and START do not authorize review requests");
    expect(value.messageFlow?.length).toBeLessThanOrEqual(2048);
    expect(value.optinMessage).toContain("STOP"); expect(value.optoutKeywords).toContain("STOP"); expect(value.helpKeywords).toContain("HELP");
    const samples = [value.sample1, value.sample2, value.sample3, value.sample4, value.sample5];
    expect(samples.every(sample => typeof sample === "string" && sample.length <= 255)).toBe(true);
    expect(value.sample4).toContain("honest Google review"); expect(value.sample5).toContain("reminder");
  });
  it("does not submit placeholder slugs or invalid sender numbers", () => {
    expect(() => buildReviewUpgradeFiling({ ...business, slug: "pending-acme" }, upgradeId, "+15745550123")).toThrow();
    expect(() => buildReviewUpgradeFiling(business, upgradeId, "not-a-number")).toThrow();
  });
});
describe("exact provider-campaign recovery proof", () => {
  it("keeps frozen historical spaced declarations intact during recovery", () => {
    const p = proof();
    p.filing = { ...p.filing, optoutKeywords: reviewSmsKeywordProgram("Acme", "help@example.test").stop.keywords.join(",") };
    expect(reviewUpgradeCandidateMatches({ ...p.filing }, p)).toBe(true);
    expect(reviewUpgradeCandidateMatches({ ...filing() }, p)).toBe(false);
    expect(p.filing.optoutKeywords).toContain("STOP ALL");
    expect(p.filing.optoutKeywords).toContain("OPT OUT");
  });
  it("matches the full filing independent of mixed-purpose order", () => {
    const p = proof();
    expect(reviewUpgradeCandidateMatches({ ...p.filing, subUsecases: ["MARKETING", "CUSTOMER_CARE"] }, p)).toBe(true);
  });
  it.each(["brandId", "referenceId", "usecase", "description", "messageFlow", "sample1", "sample2", "sample3", "sample4", "sample5", "embeddedLink", "optinKeywords", "optinMessage", "optoutKeywords", "optoutMessage", "helpKeywords", "helpMessage", "privacyPolicyLink", "termsAndConditionsLink"])("rejects changed %s instead of adopting a different campaign", field => {
    const p = proof(); expect(reviewUpgradeCandidateMatches({ ...p.filing, [field]: "different" }, p)).toBe(false);
  });
  it.each(["subscriberOptin", "subscriberOptout", "subscriberHelp", "termsAndConditions", "embeddedPhone", "numberPool", "directLending", "ageGated"])("rejects changed carrier declaration %s", field => {
    const p = proof(); const f = p.filing as unknown as Record<string, unknown>;
    expect(reviewUpgradeCandidateMatches({ ...p.filing, [field]: !f[field] }, p)).toBe(false);
  });
  it.each([null, undefined, {}, "MARKETING", ["MARKETING"], ["MARKETING", "CUSTOMER_CARE", "MARKETING"], ["CUSTOMER_CARE", "MARKETING", "OTHER"]])("fails closed for malformed or different mixed purposes", subUsecases => {
    const p = proof(); expect(reviewUpgradeCandidateMatches({ ...p.filing, subUsecases }, p)).toBe(false);
  });
  it("rejects a filing that does not bind the persisted source brand and upgrade", () => {
    const p = proof();
    expect(reviewUpgradeCandidateMatches({ ...p.filing }, { ...p, brand_id: "other-brand" })).toBe(false);
    expect(reviewUpgradeCandidateMatches({ ...p.filing }, { ...p, upgrade_id: "other-upgrade" })).toBe(false);
  });
});
