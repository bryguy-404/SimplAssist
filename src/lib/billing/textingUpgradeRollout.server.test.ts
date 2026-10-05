import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { isReviewTextingUpgradeEnabled, isTextingUpgradeEnabled } from "./textingUpgradeRollout.server";
const businessId = "10000000-0000-4000-8000-000000000001";
describe("texting upgrade rollout", () => {
  it.each([undefined, "0", "true", "yes", "01", " 1"])('stays disabled for %s', value => {
    expect(isTextingUpgradeEnabled(businessId, { CHAT_TEXTING_UPGRADES_ENABLED: value })).toBe(false);
  });
  it("enables only an exact business canary or the explicit broad flag", () => {
    expect(isTextingUpgradeEnabled(businessId, { CHAT_TEXTING_UPGRADES_ENABLED: "1" })).toBe(true);
    expect(isTextingUpgradeEnabled(businessId, { CHAT_TEXTING_UPGRADE_CANARY_BUSINESS_ID: businessId })).toBe(true);
    expect(isTextingUpgradeEnabled(businessId, { CHAT_TEXTING_UPGRADE_CANARY_BUSINESS_ID: ` ${businessId}` })).toBe(false);
    expect(isTextingUpgradeEnabled("bad", { CHAT_TEXTING_UPGRADES_ENABLED: "1" })).toBe(false);
    expect(isTextingUpgradeEnabled(businessId, { CHAT_TEXTING_UPGRADE_CANARY_BUSINESS_ID: "20000000-0000-4000-8000-000000000002" })).toBe(false);
  });
});
describe("review conversion rollout", () => {
  it("requires both explicit enablement and an exact pilot scope", () => {
    expect(isReviewTextingUpgradeEnabled(businessId, {})).toBe(false);
    expect(isReviewTextingUpgradeEnabled(businessId, { REVIEW_SMS_UPGRADES_ENABLED: "1" })).toBe(false);
    expect(isReviewTextingUpgradeEnabled(businessId, { REVIEW_SMS_UPGRADES_PILOT_BUSINESS_IDS: "*" })).toBe(false);
    expect(isReviewTextingUpgradeEnabled(businessId, { REVIEW_SMS_UPGRADES_ENABLED: "1", REVIEW_SMS_UPGRADES_PILOT_BUSINESS_IDS: businessId })).toBe(true);
    expect(isReviewTextingUpgradeEnabled(businessId, { REVIEW_SMS_UPGRADES_ENABLED: "1", REVIEW_SMS_UPGRADES_PILOT_BUSINESS_IDS: "*" })).toBe(true);
    expect(isReviewTextingUpgradeEnabled("bad", { REVIEW_SMS_UPGRADES_ENABLED: "1", REVIEW_SMS_UPGRADES_PILOT_BUSINESS_IDS: "*" })).toBe(false);
  });
});
