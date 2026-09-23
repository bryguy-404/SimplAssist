import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ from: vi.fn(), upgrade: vi.fn(), onboarding: vi.fn(), enabled: vi.fn(), entitlements: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./entitlements", () => ({ resolveBusinessEntitlements: mocks.entitlements }));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock("./textingUpgradeStore.server", () => ({ getTextingUpgrade: mocks.upgrade, parseTextingUpgrade: vi.fn(), textingUpgradeRpc: vi.fn() }));
vi.mock("@/lib/onboarding/state", () => ({ getOnboardingCheckoutContextForBusinessIdReadOnly: mocks.onboarding }));
vi.mock("./textingUpgradeRollout.server", () => ({ isTextingUpgradeEnabled: mocks.enabled }));
vi.mock("@/lib/stripe/smsBilling.server", () => ({ operationSchema: { parse: (value: unknown) => value }, view: (value: unknown) => value }));
import { getTextingUpgradeState, loadTextingUpgradeContext, textingUpgradeResumeStep } from "./textingUpgrade.server";
import type { TextingUpgradeRecord } from "./textingUpgrade";
import type { OnboardingState } from "@/lib/onboarding/types";
const upgrade: TextingUpgradeRecord = { id: "upgrade", business_id: "business", owner_id: "owner", source_subscription_id: "sub", source_customer_id: "cus", target_plan: "sms_and_chat", state: "draft", billing_operation_id: null, business_confirmed_at: "2026-09-01", phone_confirmed_at: "2026-09-01", starter_acknowledged_at: null, paid_at: null, activated_at: null, created_at: "", updated_at: "" };
const onboarding = {
  businessId: "business", currentStep: "complete", completedAt: "2026-09-01", dashboardReady: true,
  businessInfo: { name: "Example", business_type: "general", phone: "+13175550100", email: "owner@example.test", address: "123 Main", city: "Indy", state: "IN", zip: "46204" },
  businessHours: Array.from({ length: 7 }, (_, i) => ({ day: String(i), is_closed: false, open_time: "09:00", close_time: "17:00" })),
  servicesAndFaqs: { services: ["Haircut", "Styling", "Color"].map((name) => ({ name, source: "manual" })), faqs: ["How do I book?", "Where are you?", "When are you open?"].map((question) => ({ question, answer: "Call our office for details.", source: "manual" })) },
  aiSettings: { tone: "balanced", business_voice: "we", language: "en", response_delay_seconds: 5, web_greeting: "Hello", booking_enabled: false },
  brandVerification: { has_ein: true, legal_business_name: "Example LLC", ein: "12-3456789", business_entity_type: "llc", business_registration_state: "IN", authorized_rep_name: "Example Owner", authorized_rep_title: "Owner", authorized_rep_email: "owner@example.test", authorized_rep_phone: "+13175550100", use_case_description: "Customer care", opt_in_description: "Customer contacts us", estimated_monthly_volume: "under_1k", sample_messages: ["One", "Two", "STOP"] },
  registration: { brandStatus: null, campaignStatus: null, riskReview: { status: "passed" } },
  phoneNumber: null, activePhoneNumber: null, pendingPhoneNumber: "+13175550101", pendingPhoneNumberFailureReason: null, smsConsentAgreed: true,
} as OnboardingState;
let results: Record<string, { data: unknown; error: unknown }>;
beforeEach(() => {
  vi.clearAllMocks(); mocks.entitlements.mockResolvedValue({ active: true, plan: "chat_only" }); mocks.upgrade.mockResolvedValue(upgrade); mocks.onboarding.mockResolvedValue({ state: onboarding }); mocks.enabled.mockReturnValue(true);
  results = {
    businesses: { data: { id: "business", owner_id: "owner", deleted_at: null, billing_mode: "stripe", partner_id: null, partner_plan: null, billing_pilot: false, billing_comped: false, billing_exempt: false, onboarding_completed_at: "2026-09-01", compliance_info_completed_at: "2026-09-01", onboarding_registration_status: "not_started", telnyx_resource_state: "provisioning" }, error: null },
    subscriptions: { data: { plan: "chat_only", status: "active", cancel_at_period_end: false, current_period_end: "2099-01-01", stripe_subscription_id: "sub", stripe_customer_id: "cus" }, error: null },
    phone_numbers: { data: [], error: null },
    chat_only_checkout_attempts: { data: [{ state: "completed", stripe_subscription_id: "sub", stripe_customer_id: "cus" }], error: null }, sms_billing_operations: { data: [], error: null },
    telnyx_managed_resources: { data: [], error: null }, billing_usage_periods: { data: [], error: null }, sms_billing_accounts: { data: { stripe_customer_id: "cus", setup_fee_paid_at: null }, error: null }, business_plan_family_locks: { data: { family: "chat_only" }, error: null },
  };
  mocks.from.mockImplementation((table: string) => { const query = { select: vi.fn(() => query), eq: vi.fn(() => query), neq: vi.fn(() => query), limit: vi.fn(() => query), maybeSingle: vi.fn(async () => results[table]), in: vi.fn(() => query), then: (resolve: (v: unknown) => unknown) => Promise.resolve(results[table]).then(resolve) }; return query; });
});
describe("upgrade resume and read model", () => {
  it("does not promise continued Chat when canonical service entitlement is inactive", async () => {
    mocks.entitlements.mockResolvedValue({ active: false, plan: "sms_only" });
    const state = await getTextingUpgradeState("business", "owner");
    expect(state.availableServicePlan).toBeNull();
  });
  it("restores the selected SMS number hidden by completed Chat onboarding", async () => {
    const state = await getTextingUpgradeState("business", "owner");
    expect(state.phoneNumber).toBe("+13175550101"); expect(state.activePhoneNumber).toBeNull(); expect(state.currentStep).toBe("review"); expect(state.actions.canQuote).toBe(true);
  });
  it.each(["provider", "usage", "setup_fee", "pending_plan", "inactive_number", "family", "checkout_customer"])("routes inconsistent %s history to support before setup", async (kind) => {
    if (kind === "provider") results.telnyx_managed_resources.data = [{ resource_type: "brand" }];
    if (kind === "usage") results.billing_usage_periods.data = [{ id: "old_sms_period" }];
    if (kind === "setup_fee") results.sms_billing_accounts.data = { stripe_customer_id: "cus", setup_fee_paid_at: "2026-09-01" };
    if (kind === "pending_plan") results.subscriptions.data = { ...(results.subscriptions.data as object), pending_plan: "sms_only" };
    if (kind === "inactive_number") results.phone_numbers.data = [{ phone_number: "+13175550102", is_active: false, telnyx_phone_number_id: "provider_number" }];
    if (kind === "family") results.business_plan_family_locks.data = { family: "sms" };
    if (kind === "checkout_customer") results.chat_only_checkout_attempts.data = [{ state: "completed", stripe_subscription_id: "sub", stripe_customer_id: "other" }];
    expect((await getTextingUpgradeState("business", "owner")).eligible).toBe(false);
  });
  it("never grants draft eligibility when Chat onboarding masks an owned SMS number", async () => {
    results.phone_numbers.data = [{ phone_number: "+13175550102", is_active: true }];
    const state = await getTextingUpgradeState("business", "owner"); expect(state.eligible).toBe(false); expect(state.activePhoneNumber).toBe("+13175550102"); expect(state.actions.canSave).toBe(false);
  });
  it("fails closed if number ownership cannot be read", async () => {
    results.phone_numbers.error = { message: "unavailable" };
    await expect(loadTextingUpgradeContext("business", "owner")).rejects.toMatchObject({ code: "texting_upgrade_unavailable" });
  });
  it("requires the upgrade's own business and phone confirmation despite completed signup", () => {
    const ready = { ...onboarding, phoneNumber: onboarding.pendingPhoneNumber };
    expect(textingUpgradeResumeStep(ready, { ...upgrade, business_confirmed_at: null }, true)).toBe("business");
    expect(textingUpgradeResumeStep(ready, { ...upgrade, phone_confirmed_at: null }, true)).toBe("phone");
    expect(textingUpgradeResumeStep(ready, upgrade, true)).toBe("review");
  });
  it("returns to every missing prerequisite without changing initial completion", () => {
    const ready = { ...onboarding, phoneNumber: onboarding.pendingPhoneNumber };
    expect(textingUpgradeResumeStep({ ...ready, brandVerification: null }, upgrade, true)).toBe("verification");
    expect(textingUpgradeResumeStep(ready, upgrade, false)).toBe("use_case");
    expect(textingUpgradeResumeStep({ ...ready, registration: { ...ready.registration, riskReview: { ...ready.registration.riskReview, status: "pending_review" } } }, upgrade, true)).toBe("use_case");
    expect(textingUpgradeResumeStep({ ...ready, pendingPhoneNumberFailureReason: "unavailable" }, upgrade, true)).toBe("phone");
    expect(ready.completedAt).toBe("2026-09-01");
  });
  it("keeps paid carrier review on status rather than reopening unpaid setup", () => {
    expect(textingUpgradeResumeStep(onboarding, { ...upgrade, paid_at: "2026-09-23", state: "carrier_pending" }, false)).toBe("status");
  });
});
