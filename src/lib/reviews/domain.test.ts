import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
vi.mock("server-only", () => ({}));
import {
  buildReviewEmail,
  nextReviewSendTime,
  normalizeReviewEmail,
  normalizeReviewPhone,
  renderReviewTemplate,
  reviewOrigin,
  signReviewToken,
  validateGoogleReviewUrl,
  verifyResendWebhook,
  verifyReviewToken,
} from "./domain";
import {
  isEmailReviewsEnabledForBusiness,
  isReviewEmailSendingEnabled,
} from "./config";
const id = "10000000-0000-4000-a096-000000000001";
beforeEach(() => {
  vi.stubEnv("REVIEWS_LINK_SECRET", "a".repeat(32));
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://simplassist.com");
});
afterEach(() => vi.unstubAllEnvs());
describe("review links and sender safety", () => {
  it("normalizes legacy customer phone formats without accepting chat session identities", () => {
    expect(normalizeReviewPhone("(574) 555-0123")).toBe("+15745550123");
    expect(normalizeReviewPhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizeReviewPhone("session_15745550123")).toBeNull();
    expect(normalizeReviewPhone("123")).toBeNull();
  });
  it("treats customer and business names as literal text, not replacement syntax or templates", () => {
    expect(
      renderReviewTemplate(
        "{{business_name}} thanks {{customer_name}}",
        "$& {{customer_name}}",
        "$' Alex",
      ),
    ).toBe("$& {{customer_name}} thanks $' Alex");
  });
  it("binds opaque tokens to one action and resists tampering", () => {
    const token = signReviewToken(id, "review");
    expect(token).not.toContain("@");
    expect(verifyReviewToken(token, "review")).toBe(id);
    expect(verifyReviewToken(token, "unsubscribe")).toBeNull();
    expect(verifyReviewToken(token.slice(0, -1) + "X", "review")).toBeNull();
  });
  it("does not rewrite dot or plus email identities", () => {
    expect(normalizeReviewEmail(" A.B+Test@Example.com ")).toBe(
      "a.b+test@example.com",
    );
    expect(normalizeReviewEmail("a\nb@example.com")).toBeNull();
  });
  it("allows Google review destinations but no generic Google redirector", () => {
    expect(
      validateGoogleReviewUrl("https://g.page/r/business/review"),
    ).toBeTruthy();
    expect(
      validateGoogleReviewUrl(
        "https://search.google.com/local/writereview?placeid=abc",
      ),
    ).toBeTruthy();
    expect(
      validateGoogleReviewUrl(
        "https://www.google.com/url?url=https://evil.test",
      ),
    ).toBeNull();
    expect(
      validateGoogleReviewUrl("https://g.page.evil.test/review"),
    ).toBeNull();
    expect(
      validateGoogleReviewUrl("https://user:pass@g.page/review"),
    ).toBeNull();
  });
  it("renders escaped business/customer text and keeps the review and one-click opt-out links", () => {
    const mail = buildReviewEmail({
      from: "SimplAssist <reviews@example.com>",
      to: "a@example.com",
      replyTo: "owner@example.com",
      subject: "Thanks {{customer_name}}",
      body: "Hi {{customer_name}} from {{business_name}}",
      business: "<Business>",
      customer: "<img>",
      enrollmentId: id,
      businessId: id,
    });
    expect(mail.html).toContain("&lt;img&gt;");
    expect(mail.html).not.toContain("<img>");
    expect(mail.html).toContain("<p>&lt;Business&gt;</p>");
    expect(mail.text).toContain(
      "\n\n<Business>\nUnsubscribe from review requests:",
    );
    expect(mail.text).toContain("https://simplassist.com/r/");
    expect(mail.headers["List-Unsubscribe"]).toContain(
      "https://simplassist.com/reviews/unsubscribe/",
    );
    expect(mail.headers["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click",
    );
  });
  it("uses canonical default and only permits insecure loopback in development", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(reviewOrigin()).toBe("https://simplassist.com");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3100");
    vi.stubEnv("NODE_ENV", "development");
    expect(reviewOrigin()).toBe("http://localhost:3100");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => reviewOrigin()).toThrow();
  });
});
describe("local send windows", () => {
  it("moves evening to next local9am across spring DST", () => {
    expect(
      nextReviewSendTime(
        new Date("2026-03-08T01:00:00Z"),
        "America/New_York",
      ).toISOString(),
    ).toBe("2026-03-08T13:00:00.000Z");
  });
  it("moves early morning to9am and keeps an allowed time unchanged", () => {
    expect(
      nextReviewSendTime(
        new Date("2026-10-03T12:00:00Z"),
        "America/New_York",
      ).toISOString(),
    ).toBe("2026-10-03T13:00:00.000Z");
    expect(
      nextReviewSendTime(
        new Date("2026-10-03T14:32:00Z"),
        "America/New_York",
      ).toISOString(),
    ).toBe("2026-10-03T14:32:00.000Z");
  });
});
describe("rollout and signed webhooks", () => {
  it("requires explicit feature and pilot with an independent send switch", () => {
    expect(isEmailReviewsEnabledForBusiness(id)).toBe(false);
    vi.stubEnv("REVIEWS_EMAIL_ENABLED", "1");
    expect(isEmailReviewsEnabledForBusiness(id)).toBe(false);
    vi.stubEnv("REVIEWS_EMAIL_PILOT_BUSINESS_IDS", id);
    expect(isEmailReviewsEnabledForBusiness(id)).toBe(true);
    expect(isReviewEmailSendingEnabled()).toBe(false);
    vi.stubEnv("REVIEWS_EMAIL_SENDING_ENABLED", "1");
    expect(isReviewEmailSendingEnabled()).toBe(true);
  });
  it("verifies original raw body, timestamp and rotated signatures", () => {
    const key = Buffer.alloc(32, 7),
      timestamp = "1791028800",
      raw = '{"type":"email.delivered"}';
    vi.stubEnv(
      "REVIEWS_RESEND_WEBHOOK_SECRET",
      `whsec_${key.toString("base64")}`,
    );
    const signature = createHmac("sha256", key)
      .update(`evt_1.${timestamp}.${raw}`)
      .digest("base64");
    const headers = new Headers({
      "svix-id": "evt_1",
      "svix-timestamp": timestamp,
      "svix-signature": `v1,bad v1,${signature}`,
    });
    expect(verifyResendWebhook(raw, headers, Number(timestamp) * 1000)).toBe(
      true,
    );
    expect(
      verifyResendWebhook(raw + " ", headers, Number(timestamp) * 1000),
    ).toBe(false);
    expect(
      verifyResendWebhook(raw, headers, Number(timestamp) * 1000 + 301000),
    ).toBe(false);
    vi.stubEnv("REVIEWS_RESEND_WEBHOOK_SECRET", "whsec_");
    expect(verifyResendWebhook(raw, headers, Number(timestamp) * 1000)).toBe(
      false,
    );
  });
});
