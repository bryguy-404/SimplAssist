import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));
vi.mock("@/components/branding/BrandProvider", () => ({ useBrand: () => ({ name: "SimplAssist" }) }));
import Wizard, { TextingUpgradePrice, CommonSetupRepair, textingUpgradeErrorMessage } from "./TextingUpgradeWizard";
import { textingUpgradeEntryLabel } from "./TextingUpgradeEntry";
import type { TextingUpgradeState } from "@/lib/billing/textingUpgrade";
const state = {
  businessId: "business", businessInfo: { name: "Example", address: "123 Main", city: "Indy", state: "IN", zip: "46204" }, businessHours: [], servicesAndFaqs: { services: [], faqs: [] }, aiSettings: null,
  registration: { riskReview: { status: "passed" } }, brandVerification: { legal_business_name: "Example LLC", ein: "12-3456789", authorized_rep_name: "Example Owner" },
  phoneNumber: null, activePhoneNumber: null, pendingPhoneNumber: "+13175550100", pendingPhoneNumberFailureReason: null, smsConsentAgreed: true,
  upgrade: { id: "upgrade", targetPlan: "sms_only", state: "draft", starterAcknowledged: true, paidAt: null, activatedAt: null },
  eligible: true, enabled: true, message: null, currentStep: "review", steps: ["plan", "business", "verification", "use_case", "phone", "review", "status"], availablePlans: ["sms_only", "sms_and_chat", "full"], selectedPlan: "sms_only", paidPlan: "chat_only", availableServicePlan: "chat_only", paymentStatus: "prepared",
  quote: { operationId: "op", quoteFingerprint: "fingerprint", kind: "upgrade", state: "prepared", targetPlan: "sms_only", amountDueCents: 3250, monthlyPriceCents: 2500, setupFeeCents: 2500, currency: "usd", effectiveAt: "2026-09-23", renewalAt: "2026-10-01", voiceSeconds: 0, expiresAt: "2099-10-01" },
  actions: { canSelect: true, canSave: true, canQuote: true, canConfirm: true, canCancel: true, canRefresh: true, canReplacePhone: false },
} as unknown as TextingUpgradeState;
describe("Add texting customer review", () => {
  it("offers specific existing-settings repairs for missing common prerequisites", () => {
    const html = renderToStaticMarkup(<CommonSetupRepair state={state} busy={false} onRefresh={vi.fn()} />);
    expect(html).toContain("all seven days of business hours");
    expect(html).toContain("at least three services and three answered FAQs");
    expect(html).toContain('href="/settings/knowledge"');
    expect(html).toContain('href="/settings"');
    expect(html).toContain("Refresh saved setup");
  });
  it("requires a new Starter loss acknowledgement even after earlier acknowledgement was saved", () => {
    const html = renderToStaticMarkup(<Wizard initialState={state} />);
    expect(html).toContain('disabled="">Confirm upgrade and pay $32.50');
    expect(html).toContain("These features stop when texting activates");
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain("same 200 AI replies per month");
    expect(html).toContain("before carrier approval");
    expect(html).not.toContain("12-3456789");
    expect(html).toContain("EIN ending 6789");
    for (const label of ["plan", "business", "business verification", "texting details", "phone number"]) expect(html).toContain(`aria-label="Edit ${label}"`);
  });
  it("shows exact proration plus setup and ongoing monthly price", () => {
    const html = renderToStaticMarkup(<TextingUpgradePrice quote={state.quote!} />);
    expect(html).toContain("$32.50 due now"); expect(html).toContain("one-time $25.00 setup fee"); expect(html).toContain("$25.00/month"); expect(html).toContain("renewal date stays the same");
  });
  it("offers all three target plans without charging at selection", () => {
    const html = renderToStaticMarkup(<Wizard initialState={{ ...state, currentStep: "plan", selectedPlan: null, quote: null }} />);
    expect((html.match(/type="radio"/g) ?? []).length).toBe(3);
    expect(html).toContain('disabled="">Continue setup'); expect(html).not.toContain("Confirm upgrade and pay");
    expect(html).toContain("Website chat ends when texting activates");
  });
  it("keeps paid status recovery and support available without a second charge button", () => {
    const paid = { ...state, currentStep: "status" as const, paymentStatus: "paid" as const, upgrade: { ...state.upgrade!, state: "support_required" as const }, actions: { ...state.actions, canConfirm: false, canCancel: false, canReplacePhone: true } };
    const html = renderToStaticMarkup(<Wizard initialState={paid} />);
    expect(html).toContain("Registration needs support"); expect(html).toContain("Choose another number"); expect(html).toContain("Your existing chat service remains available");
    expect(html).not.toContain("Confirm upgrade and pay"); expect(html).not.toContain("Cancel this upgrade request");
  });
  it("labels resumed drafts and paid carrier review separately", () => {
    expect(textingUpgradeEntryLabel(state)).toBe("Resume texting setup");
    expect(textingUpgradeEntryLabel({ ...state, upgrade: { ...state.upgrade!, state: "carrier_pending" } })).toBe("View texting status");
    expect(textingUpgradeEntryLabel({ ...state, upgrade: null })).toBe("Add texting");
    expect(textingUpgradeEntryLabel({ ...state, upgrade: null, enabled: false })).toBeNull();
  });
  it("does not expose arbitrary server details in error copy", () => {
    expect(textingUpgradeErrorMessage("sensitive SQL error")).not.toContain("SQL");
    expect(textingUpgradeErrorMessage("sms_billing_quote_expired")).toContain("updated amount");
  });
});
