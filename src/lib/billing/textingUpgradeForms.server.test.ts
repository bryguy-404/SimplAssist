import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), assess: vi.fn(), legal: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: mocks.from, rpc: mocks.rpc } }));
vi.mock("@/lib/messaging/registration/riskScreening", () => ({
  assessA2pRiskForBusiness: mocks.assess,
  registrationHasStartedForRisk: (row: { telnyx_brand_id: string | null; onboarding_registration_status: string }) => Boolean(row.telnyx_brand_id || row.onboarding_registration_status === "submitted"),
}));
vi.mock("@/lib/messaging/registration/legalUrls", () => ({ resolveLegalUrls: mocks.legal, buildBusinessLandingUrl: vi.fn() }));
vi.mock("@/lib/util/slug.server", () => ({ ensureUniqueSlug: vi.fn(async () => "example") }));
vi.mock("@/lib/messaging/numbers", () => ({ isNanpTollFreeNumber: (value: string) => value.startsWith("+1800") }));
import { saveTextingUpgradeForm } from "./textingUpgradeForms.server";
import type { TextingUpgradeRecord } from "./textingUpgrade";
import { buildCustomerCareTemplateCopy } from "@/lib/messaging/registration/customerCareTemplates";
const businessId = "00000000-0000-4000-8000-000000000001";
const ownerId = "00000000-0000-4000-8000-000000000002";
const upgrade: TextingUpgradeRecord = { id: "upgrade", business_id: businessId, owner_id: ownerId, source_subscription_id: "sub", source_customer_id: "cus", target_plan: "sms_and_chat", state: "draft", billing_operation_id: null, business_confirmed_at: null, phone_confirmed_at: null, starter_acknowledged_at: null, paid_at: null, activated_at: null, created_at: "", updated_at: "" };
const pristine = { id: businessId, owner_id: ownerId, deleted_at: null, no_ein_hold_status: "none", telnyx_brand_id: null, brand_status: null, campaign_status: null, onboarding_registration_status: "not_started", slug: "example", privacy_terms_mode: "hosted", has_ein: true, ein: "12-3456789", legal_business_name: "Example LLC", business_entity_type: "llc", business_registration_state: "IN", authorized_rep_name: "Example Owner", authorized_rep_title: "Owner", authorized_rep_email: "owner@example.test", authorized_rep_phone: "+13175550100", compliance_info_completed_at: "2026-09-01" };
const businessValues = { name: "Example", business_type: "general", website: "", phone: "+13175550100", email: "owner@example.test", address: "123 Main", city: "Indianapolis", state: "Indiana", zip: "46204", timezone: "America/Indiana/Indianapolis" };
let rows: unknown[];
beforeEach(() => {
  vi.clearAllMocks(); rows = [pristine];
  mocks.from.mockImplementation(() => { const query = { select: vi.fn(() => query), eq: vi.fn(() => query), neq: vi.fn(() => query), limit: vi.fn(() => query), maybeSingle: vi.fn(async () => ({ data: rows.shift() ?? null, error: null })) }; return query; });
  mocks.rpc.mockResolvedValue({ data: upgrade, error: null });
  mocks.assess.mockResolvedValue({ status: "passed", inputHash: "hash", message: "Passed", reason: null, findings: [], registrationStarted: false, reusedExisting: false });
});
const save = (step: "business" | "verification" | "use_case" | "phone", values: unknown, record = upgrade) => saveTextingUpgradeForm({ upgrade: record, businessId, ownerId, step, values });
describe("atomic upgrade form saves", () => {
  it("normalizes common fields and never resets initial onboarding", async () => {
    await save("business", businessValues);
    expect(mocks.rpc).toHaveBeenCalledWith("save_chat_texting_upgrade_details", expect.objectContaining({ p_upgrade_id: upgrade.id, p_owner_id: ownerId, p_step: "business", p_values: expect.objectContaining({ state: "IN", website_url: null }) }));
    expect(Object.keys(mocks.rpc.mock.calls[0][1].p_values).some((key) => key.startsWith("onboarding_"))).toBe(false);
  });
  it("rejects unknown common fields instead of forwarding billing or completion writes", async () => {
    await expect(save("business", { ...businessValues, onboarding_completed_at: null })).rejects.toMatchObject({ code: "texting_upgrade_invalid_business" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not let another owner or submitted registration edit fields", async () => {
    await expect(save("business", businessValues, { ...upgrade, owner_id: "another" })).rejects.toMatchObject({ code: "texting_upgrade_forbidden" });
    rows = [{ ...pristine, telnyx_brand_id: "brand" }];
    await expect(save("business", businessValues)).rejects.toMatchObject({ code: "registration_locked" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("records no-EIN hold without progression or payment", async () => {
    await save("verification", { has_ein: false, join_waitlist: true });
    expect(mocks.rpc.mock.calls[0][1].p_values).toMatchObject({ has_ein: false, no_ein_hold_status: "waitlisted" });
  });
  it("rejects duplicate EIN without exposing its owner", async () => {
    rows = [pristine, { id: "existing" }];
    await expect(save("verification", pristine)).rejects.toMatchObject({ code: "ein_already_connected" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("requires fresh explicit phone consent and a local number", async () => {
    await expect(save("phone", { phoneNumber: "+13175550101" })).rejects.toMatchObject({ code: "invalid_phone_number" });
    rows = [pristine];
    await expect(save("phone", { phoneNumber: "+18005550101", smsConsentAgreed: true })).rejects.toMatchObject({ code: "invalid_phone_number" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("permits only a paid failed pending phone replacement even after brand submission", async () => {
    rows = [{ ...pristine, telnyx_brand_id: "brand", pending_phone_number_failure_reason: "number_unavailable" }, null];
    const paid = { ...upgrade, state: "carrier_pending" as const, paid_at: "2026-09-01" };
    await save("phone", { phoneNumber: "+13175550101", smsConsentAgreed: true }, paid);
    expect(mocks.rpc.mock.calls[0][1].p_values).toEqual({ pending_phone_number: "+13175550101", pending_phone_number_selected_at: expect.any(String), pending_phone_number_failure_reason: null });
    await expect(save("business", businessValues, paid)).rejects.toMatchObject({ code: "texting_upgrade_locked" });
  });
  it("blocks replacing an active number or a rejected registration", async () => {
    const paid = { ...upgrade, state: "support_required" as const, paid_at: "2026-09-01" };
    rows = [{ ...pristine, pending_phone_number_failure_reason: "unavailable" }, { id: "owned" }];
    await expect(save("phone", { phoneNumber: "+13175550101", smsConsentAgreed: true }, paid)).rejects.toMatchObject({ code: "texting_upgrade_locked" });
    rows = [{ ...pristine, brand_status: "rejected", pending_phone_number_failure_reason: "unavailable" }];
    await expect(save("phone", { phoneNumber: "+13175550101", smsConsentAgreed: true }, paid)).rejects.toMatchObject({ code: "rejection_support_required" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("saves risk-held drafts atomically without marking compliance complete", async () => {
    const copy = buildCustomerCareTemplateCopy({ businessName: "Example LLC", businessType: "general" });
    mocks.assess.mockResolvedValue({ status: "pending_review", inputHash: "draft-hash", message: "Review required", reason: "customer_not_sure", findings: [], registrationStarted: false, reusedExisting: false });
    await save("use_case", { use_case_description: copy.useCaseDescription, estimated_monthly_volume: "under_1k", sample_messages: copy.sampleMessages, opt_in_description: copy.optInDescription, a2p_risk_checklist_answer: "not_sure", a2p_risk_checklist_selections: [] });
    expect(mocks.rpc.mock.calls[0][1].p_values).toMatchObject({ compliance_info_completed_at: null, a2p_risk_review_status: "pending_review", a2p_risk_review_input_hash: "draft-hash" });
  });
  it("marks cleared compliance only with the scanner's current input hash", async () => {
    const copy = buildCustomerCareTemplateCopy({ businessName: "Example LLC", businessType: "general" });
    await save("use_case", { use_case_description: copy.useCaseDescription, estimated_monthly_volume: "under_1k", sample_messages: copy.sampleMessages, opt_in_description: copy.optInDescription, a2p_risk_checklist_answer: "none", a2p_risk_checklist_selections: [] });
    expect(mocks.rpc.mock.calls[0][1].p_values).toMatchObject({ compliance_info_completed_at: pristine.compliance_info_completed_at, a2p_risk_review_status: "passed", a2p_risk_review_input_hash: "hash" });
  });
  it("keeps the database race guard and sanitizes arbitrary errors", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "texting_upgrade_source_changed" } });
    await expect(save("business", businessValues)).rejects.toMatchObject({ code: "texting_upgrade_source_changed" });
    rows = [pristine]; mocks.rpc.mockResolvedValue({ data: null, error: { message: "sensitive detail" } });
    await expect(save("business", businessValues)).rejects.toMatchObject({ code: "texting_upgrade_save_failed" });
  });
});
