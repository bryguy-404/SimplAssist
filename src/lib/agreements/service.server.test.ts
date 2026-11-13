import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: mocks }));
import { currentServiceTerms } from "./current.server";
import { requireServiceAgreement, serviceAgreementStatus, linkServiceAgreementReference } from "./service.server";

let accepted: boolean;
let broken: string | null;
let document: ReturnType<typeof currentServiceTerms> | null;
let writes: { table: string; value: unknown }[];
beforeEach(() => {
  vi.clearAllMocks(); accepted = false; broken = null; document = null; writes = [];
  mocks.from.mockImplementation((table: string) => {
    const result = () => ({ data: table === "service_terms_versions" ? document : accepted ? { id: "agreement-1" } : null, error: broken === table ? { message: "unavailable" } : null });
    const q = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(result), single: vi.fn(result), order: vi.fn(), upsert: vi.fn() };
    q.select.mockReturnValue(q); q.eq.mockReturnValue(q);
    q.order.mockImplementation(() => ({ data: accepted ? [{ id: "agreement-1", subscriber_id: "owner", terms_version: currentServiceTerms().version }] : [], error: broken === table ? {} : null }));
    q.upsert.mockImplementation((value: ReturnType<typeof currentServiceTerms>) => {
      writes.push({ table, value });
      if (broken === table) return { error: {} };
      if (table === "service_terms_versions") document ??= value;
      return { error: null };
    });
    return q;
  });
  mocks.rpc.mockImplementation(() => { accepted = true; return { data: { id: "agreement-1" }, error: null }; });
});
describe("subscriber agreement evidence", () => {
  it.each([undefined, false, { accepted: false }, { accepted: "true" }])("blocks a purchase without an explicit submitted acceptance: %j", async (confirmation) => {
    await expect(requireServiceAgreement("business", "owner", confirmation, "onboarding")).rejects.toMatchObject({ code: "service_agreement_required" });
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(writes).toEqual([]);
  });
  it("rejects stale document versions without recording an acceptance", async () => {
    await expect(requireServiceAgreement("business", "owner", { accepted: true, termsVersion: "old" }, "onboarding")).rejects.toMatchObject({ code: "service_agreement_changed" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("archives the actual text and records authenticated IDs, never a client timestamp", async () => {
    const confirmation = { accepted: true, termsVersion: currentServiceTerms().version, acceptedAt: "1999-01-01", subscriberId: "foreign" };
    await expect(requireServiceAgreement("business", "owner", confirmation, "onboarding")).resolves.toBe("agreement-1");
    expect(document?.terms_html).toContain("ARAMBULA VENTURES LLC");
    expect(document?.checkbox_text).toBe("I agree to the Terms of Service and acknowledge the Privacy Policy.");
    expect(mocks.rpc).toHaveBeenCalledWith("record_service_agreement", {
      p_business_id: "business", p_subscriber_id: "owner", p_terms_version: currentServiceTerms().version, p_source: "onboarding",
    });
  });
  it.each(["service_agreements", "service_terms_versions"])("fails closed if %s cannot be read/saved", async (table) => {
    broken = table;
    await expect(requireServiceAgreement("business", "owner", { accepted: true, termsVersion: currentServiceTerms().version }, "billing_checkout")).rejects.toMatchObject({ code: "service_agreement_unavailable" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("reuses current acceptance on checkout retries without overwriting history", async () => {
    accepted = true;
    await expect(requireServiceAgreement("business", "owner", undefined, "plan_change")).resolves.toBe("agreement-1");
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(writes).toEqual([]);
  });
  it("does not treat a different subscriber's acceptance as the new owner's acceptance", async () => {
    accepted = true;
    expect((await serviceAgreementStatus("business", "another-owner")).accepted).toBe(false);
  });
  it("retains the original record when attaching a payment reference", async () => {
    await linkServiceAgreementReference("agreement-1", "stripe_checkout", "cs_test_saved");
    expect(writes).toEqual([{ table: "service_agreement_references", value: { agreement_id: "agreement-1", kind: "stripe_checkout", reference: "cs_test_saved" } }]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
