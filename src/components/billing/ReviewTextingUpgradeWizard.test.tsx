import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));
import Wizard, { type ReviewUpgradeProviderState } from "./ReviewTextingUpgradeWizard";
import type { TextingUpgradeState } from "@/lib/billing/textingUpgrade";
const state = {
  sourceMode: "review_sms", upgrade: { id: "upgrade", state: "draft" }, message: null, paymentStatus: "not_started", quote: null,
  actions: { canSelect: true, canQuote: false, canConfirm: false, canCancel: true },
} as unknown as TextingUpgradeState;
const provider: ReviewUpgradeProviderState = { stage: "not_started", canPrepare: true, canMove: false, paused: false, error: null,
  submissionPreview: { description: "Care and review requests", samples: ["An example"], messageFlow: "Customers choose the purpose.", privacyUrl: "/privacy", termsUrl: "/terms" } };
function render(s = state, p = provider) { return renderToStaticMarkup(<Wizard state={s} onState={vi.fn()} initialProvider={p} />); }
describe("Review texting to Growth journey", () => {
  it("explains total price, allowance, payment timing, and no repeated activation before selecting", () => {
    const html = render({ ...state, upgrade: null });
    for (const text of ["$49/month", "1,500 SMS parts", "No additional activation fee", "$14/month difference", "Your renewal date stays the same", "Review upgrade setup"]) expect(html).toContain(text);
    expect(html).not.toContain("Submit expanded application");
  });
  it("requires a new disclosure acknowledgement before submission", () => {
    const html = render();
    expect(html).toContain("Customers choose the purpose.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Submit expanded application<\/button>/);
    expect(html).not.toContain("Confirm upgrade and pay");
  });
  it("routes incomplete saved details to settings without offering an empty application", () => {
    const html = render(state, { ...provider, canPrepare: false, error: "review_upgrade_business_details_required" });
    expect(html).toContain('href="/settings"');
    expect(html).toContain("Your current review service stays available");
    expect(html).not.toContain("Submit expanded application");
  });
  it("requires explicit acknowledgement for the guided move after approval", () => {
    const html = render(state, { ...provider, stage: "approved", canMove: true });
    expect(html).toContain("minutes to days");
    expect(html).toContain("website chat and email");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Move my number<\/button>/);
  });
  it("shows the handoff pause and prevents abandonment while paused", () => {
    const html = render(state, { ...provider, stage: "moving", paused: true });
    expect(html).toContain("SMS sending and SMS AI are paused");
    expect(html).toContain("Incoming messages and opt-outs are retained");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Keep my current package and cancel this upgrade<\/button>/);
    expect(html).not.toContain("Confirm upgrade and pay");
  });
  it("makes a failed carrier assignment actionable while retaining its sending fence", () => {
    const html = render(state, { ...provider, stage: "moving", paused: true, error: "review_upgrade_assignment_failed" });
    expect(html).toContain("Your number transition needs support");
    expect(html).toContain("SMS stays paused until the assignment is verified");
    expect(html).not.toContain("Confirm upgrade and pay");
  });
  it("offers a bound payment only after verified handoff and shows the actual quote", () => {
    const s = { ...state, actions: { ...state.actions, canQuote: true, canConfirm: true }, quote: { operationId: "op", quoteFingerprint: "fingerprint", state: "prepared", amountDueCents: 700, monthlyPriceCents: 4900, setupFeeCents: 0, renewalAt: "2099-11-01", expiresAt: "2099-10-05" } } as TextingUpgradeState;
    const html = render(s, { ...provider, stage: "review_ready" });
    expect(html).toContain("$7.00 due now"); expect(html).toContain("Confirm upgrade and pay $7.00");
    expect(html).toContain("Your $35 package continues until the Growth payment succeeds");
    expect(html).not.toContain("one-time $25");
  });
  it("paid completion removes payment and abandonment controls", () => {
    const html = render({ ...state, paymentStatus: "paid", availableServicePlan: "sms_and_chat", eligible: true });
    expect(html).toContain("Your Growth plan is active");
    expect(html).not.toContain("Confirm upgrade and pay"); expect(html).not.toContain("cancel this upgrade");
  });
});
