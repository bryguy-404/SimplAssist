import { describe, expect, it } from "vitest";
import { chooseDashboardUpgradePrompt, type UpgradePromptSnapshot, type UpgradePromptPreference } from "./upgradePrompt";
const now = Date.parse("2026-10-10T12:00:00Z");
const weekAgo = new Date(now - 7 * 86400_000).toISOString();
export const baseSnapshot: UpgradePromptSnapshot = {
  plan: "chat_only", eligibleBusiness: true, featurePaused: false, pendingBilling: false, reviewPaymentPending: false,
  textingUpgrade: null, reviewAccount: null, reviewEnabled: true, reviewSettingsReady: true,
  hasAcceptedReviewEmail: true, reviewActivatedAt: weekAgo, growthActivatedAt: weekAgo,
  growthEligible: true, voiceEligible: true, preferences: [],
};
const choose = (patch: Partial<UpgradePromptSnapshot> = {}) => chooseDashboardUpgradePrompt({ ...baseSnapshot, ...patch }, now);
const pref = (patch: Partial<UpgradePromptPreference> = {}): UpgradePromptPreference => ({ offer_key: "review_texting", dismissal_count: 1, snoozed_until: null, hidden_at: null, revision: 1, ...patch });
describe("dashboard upgrade selection", () => {
  it("offers review texting only after real email use and complete setup", () => {
    expect(choose()).toMatchObject({ kind: "offer", offerKey: "review_texting", href: "/reviews?tab=settings#review-sms" });
    for (const patch of [{ hasAcceptedReviewEmail: false }, { reviewSettingsReady: false }, { reviewEnabled: false }, { eligibleBusiness: false }, { featurePaused: true }]) expect(choose(patch)).toBeNull();
  });
  it("waits seven days after paid review activation before Growth", () => {
    const reviewAccount = { state: "active", billing_source: "direct" };
    expect(choose({ reviewAccount })).toMatchObject({ offerKey: "growth" });
    expect(choose({ reviewAccount, reviewActivatedAt: new Date(now - 7 * 86400_000 + 1).toISOString() })).toBeNull();
    expect(choose({ reviewAccount, reviewActivatedAt: null })).toBeNull();
    expect(choose({ reviewAccount, growthEligible: false })).toBeNull();
    expect(choose({ reviewAccount: { ...reviewAccount, billing_source: "grant" } })).toBeNull();
  });
  it("offers voice only to mature eligible Growth; SMS Only and Full have no ladder prompt", () => {
    expect(choose({ plan: "sms_and_chat" })).toMatchObject({ offerKey: "voice", href: "/billing?upgrade=full#plan-change" });
    expect(choose({ plan: "sms_and_chat", voiceEligible: false })).toBeNull();
    expect(choose({ plan: "sms_and_chat", growthActivatedAt: new Date(now).toISOString() })).toBeNull();
    expect(choose({ plan: "sms_only" })).toBeNull(); expect(choose({ plan: "full" })).toBeNull();
  });
  it.each(["cancel_pending", "release_pending", "released"])("does not pitch another upgrade during %s", state => {
    expect(choose({ reviewAccount: { state, billing_source: "direct" } })).toBeNull();
  });
  it("prioritizes saved setup and pending operations over sales, independently of snoozes", () => {
    expect(choose({ textingUpgrade: { state: "carrier_pending" }, pendingBilling: true })).toMatchObject({ kind: "progress", offerKey: "growth" });
    expect(choose({ pendingBilling: true })).toMatchObject({ kind: "progress", href: "/billing#plan-change" });
    expect(choose({ reviewAccount: { state: "draft", billing_source: "direct" }, preferences: [pref({ hidden_at: weekAgo })] })).toMatchObject({ kind: "progress", offerKey: "review_texting" });
    expect(choose({ reviewPaymentPending: true })).toMatchObject({ kind: "progress", href: "/reviews?tab=settings#review-sms" });
  });
  it("honors exact snooze expiry, permanent hide, and independent offer preferences", () => {
    expect(choose({ preferences: [pref({ snoozed_until: new Date(now + 1).toISOString() })] })).toBeNull();
    expect(choose({ preferences: [pref({ snoozed_until: new Date(now).toISOString() })] })).toMatchObject({ revision: 1 });
    expect(choose({ preferences: [pref({ hidden_at: weekAgo })] })).toBeNull();
    expect(choose({ preferences: [pref({ offer_key: "voice", hidden_at: weekAgo })] })).toMatchObject({ offerKey: "review_texting", revision: 0 });
  });
});
