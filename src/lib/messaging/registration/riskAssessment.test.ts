import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ from: vi.fn(), mail: vi.fn(), update: vi.fn(), insert: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("@/lib/email/a2pRiskReview", () => ({ sendA2pRiskReviewEmail: mocks.mail }));
vi.mock("@/lib/firecrawl/crawl", () => ({ crawlSite: vi.fn(), CRAWL_RISK_OPTS: {} }));
import { assessA2pRiskForBusiness } from "./riskScreening";
let business: Record<string, unknown>;
beforeEach(() => {
  vi.clearAllMocks();
  business = { id: "business", name: "Example Services", business_type: "general", website_url: null, business_type_other: null, telnyx_brand_id: null, brand_status: null, campaign_status: null, onboarding_registration_status: "not_started", a2p_risk_review_status: null, a2p_risk_review_input_hash: null };
  mocks.from.mockImplementation((table: string) => {
    const query = { select: vi.fn(() => query), eq: vi.fn(() => query), order: vi.fn(() => query), single: vi.fn(async () => ({ data: business, error: null })), returns: vi.fn(async () => ({ data: [], error: null })), update: mocks.update, insert: mocks.insert };
    if (!["businesses", "services", "faqs"].includes(table)) throw Error("Unexpected write table");
    return query;
  });
});
describe("draft risk assessment", () => {
  it("uses the established risk rules without persisting or emailing before the atomic save", async () => {
    const result = await assessA2pRiskForBusiness("business", { useCaseDescription: "Respond to customer questions about appointments", sampleMessages: ["Reply STOP to opt out"], optInDescription: "People contact our business", checklistAnswer: "not_sure" });
    expect(result.status).toBe("pending_review"); expect(result.inputHash).toEqual(expect.any(String));
    expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.insert).not.toHaveBeenCalled(); expect(mocks.mail).not.toHaveBeenCalled();
  });
  it("still identifies prohibited content in a draft", async () => {
    const result = await assessA2pRiskForBusiness("business", { useCaseDescription: "Selling cannabis products", checklistAnswer: "none" });
    expect(result.status).toBe("blocked");
    expect(result.findings.length).toBeGreaterThan(0); expect(mocks.update).not.toHaveBeenCalled();
  });
});
