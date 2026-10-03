import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  send: vi.fn(),
  enabled: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock("@/lib/billing/reviewSmsRollout.server", () => ({
  isReviewSmsEnabled: mocks.enabled,
}));
vi.mock("@/lib/messaging/tenantSmsSend.server", () => ({
  sendTenantSms: mocks.send,
  TenantSmsSendError: class extends Error {
    constructor(
      public reason: string,
      public outcome: string,
    ) {
      super(reason);
    }
  },
}));
import { TenantSmsSendError } from "@/lib/messaging/tenantSmsSend.server";
import { processReviewTextConsent } from "./consent.server";
import {
  isReviewConsentKeyword,
  reviewConsentDescription,
  reviewConsentUrl,
  reviewConsentConfirmation,
} from "./consentCopy";

const input = {
  businessId: "business",
  messagingProfileId: "profile",
  from: "+15745550101",
  to: "+15745550102",
  text: " REVIEWS ",
  conversationId: "conversation",
  sourceMessageId: "source",
  providerMessageId: "provider-message",
  occurredAt: "2026-10-03T13:00:00Z",
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("REVIEWS_SMS_SENDING_ENABLED", "1");
  mocks.enabled.mockReturnValue(true);
  mocks.rpc.mockResolvedValue({
    data: { granted: true, canConfirm: true, businessName: "Bryan Develops" },
    error: null,
  });
  mocks.send.mockResolvedValue({ replayed: false });
});
describe("explicit review-text permission", () => {
  it.each(["START", "HELP", "yes", "Please send reviews", "REVIEWS STOP", ""])(
    "never treats %s as review permission",
    async (text) => {
      expect(await processReviewTextConsent({ ...input, text })).toBe(false);
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );
  it("accepts only the standalone case-insensitive keyword", () => {
    expect(isReviewConsentKeyword("\nreviews\t")).toBe(true);
    expect(isReviewConsentKeyword("RE VIEWS")).toBe(false);
  });
  it("persists verified identity before sending one deduplicated confirmation", async () => {
    expect(await processReviewTextConsent(input)).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "review_record_sms_consent",
      expect.objectContaining({
        p_provider_message: "provider-message",
        p_source_message: "source",
        p_copy_version: "review-texts-v1",
      }),
    );
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "review_consent_confirmation",
        idempotencyKey: "review-consent/v1/provider-message",
        from: input.to,
        to: input.from,
      }),
    );
    expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.send.mock.invocationCallOrder[0],
    );
  });
  it.each([
    { providerMessageId: undefined },
    { occurredAt: undefined },
    { occurredAt: "invalid" },
  ])(
    "consumes incomplete provider evidence without granting or replying: %j",
    async (override) => {
      expect(await processReviewTextConsent({ ...input, ...override })).toBe(
        true,
      );
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );
  it("consumes disabled/legacy keywords without AI fallback or permission", async () => {
    mocks.enabled.mockReturnValue(false);
    expect(await processReviewTextConsent(input)).toBe(true);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each([
    { granted: false, canConfirm: false },
    { granted: true, canConfirm: false },
  ])("does not send when blocked or unpaid: %j", async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    expect(await processReviewTextConsent(input)).toBe(true);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("still records permission while the dispatch switch is off", async () => {
    vi.stubEnv("REVIEWS_SMS_SENDING_ENABLED", "0");
    expect(await processReviewTextConsent(input)).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("requests webhook retry when consent persistence fails", async () => {
    mocks.rpc.mockResolvedValue({
      error: { message: "unavailable" },
      data: null,
    });
    await expect(processReviewTextConsent(input)).rejects.toThrow(
      "persistence unavailable",
    );
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("does not resend an uncertain confirmation", async () => {
    mocks.send.mockRejectedValue(
      new TenantSmsSendError("sms_acceptance_unknown", "uncertain"),
    );
    expect(await processReviewTextConsent(input)).toBe(true);
    expect(mocks.send).toHaveBeenCalledOnce();
  });
  it("retries only pre-provider admission failures", async () => {
    mocks.send.mockRejectedValue(
      new TenantSmsSendError("sms_reservation_unavailable", "not_sent"),
    );
    await expect(processReviewTextConsent(input)).rejects.toThrow();
  });
  it("keeps disclosures and carrier instructions explicit", () => {
    const url = reviewConsentUrl("bryan-develops");
    expect(url).toBe("https://simplassist.com/c/bryan-develops/review-texts");
    const copy = reviewConsentDescription("Bryan Develops", input.to, url);
    for (const text of [
      "automated marketing",
      "text REVIEWS",
      "up to 2",
      "not a condition of purchase",
      "STOP",
      "HELP",
      "START",
    ])
      expect(copy).toContain(text);
    expect(reviewConsentConfirmation("Bryan\nDevelops")).not.toContain("\n");
  });
});
