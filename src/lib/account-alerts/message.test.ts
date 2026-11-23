import { describe, expect, it } from "vitest";
import { ACCOUNT_ALERT_RECIPIENT, renderAccountAlert } from "./message";

export const payload = {
  version: 1, businessId: "10000000-0000-4000-a000-000000000001", name: "Alex Customer",
  email: "alex@example.test", businessName: null, plan: null,
  signedUpAt: "2026-11-22T15:00:00+00:00", occurredAt: "2026-11-22T15:01:00+00:00",
  kind: "verified_signup", brandStatus: null, campaignStatus: null,
};
const render = (changes = {}) => renderAccountAlert({ ...payload, ...changes }, "SimplAssist <notifications@simplassist.com>", "https://simplassist.com");
describe("account alert email", () => {
  it("identifies an incomplete signup without claiming payment or inventing a plan", () => {
    const message = render();
    expect(message.to).toBe(ACCOUNT_ALERT_RECIPIENT);
    expect(message.replyTo).toBe(payload.email);
    expect(message.text).toContain("Plan not selected yet");
    expect(message.text).toContain("not a payment confirmation");
    expect(message.text).toContain(`https://simplassist.com/admin/${payload.businessId}`);
    expect(message.text).toContain("10:01 AM (Indianapolis time)");
  });
  it.each(["chat_only", "sms_only", "sms_and_chat", "full"])("renders the %s plan", (plan) => {
    expect(render({ plan }).text).not.toContain("Plan not selected yet");
  });
  it("distinguishes ready Chat Only and pending texting", () => {
    expect(render({ kind: "chat_ready", plan: "chat_only" }).text).toContain("no carrier approval is needed");
    expect(render({ kind: "texting_submitted", plan: "sms_only" }).text).toContain("may be waiting for approval");
    expect(render({ kind: "texting_submitted", plan: "full", campaignStatus: "approved" }).text).toContain("approval has already been recorded");
  });
  it("escapes customer-controlled HTML and strips header control characters", () => {
    const message = render({ name: "<script>bad()</script>\r\nBcc: someone", businessName: "A & B" });
    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&lt;script&gt;");
    expect(message.html).toContain("A &amp; B");
    expect(message.subject).not.toMatch(/[\r\n]/);
  });
  it("rejects malformed payloads and unsafe admin origins", () => {
    expect(() => render({ email: "alex@example.test\r\nBcc: victim@example.test" })).toThrow();
    expect(() => renderAccountAlert(payload, "sender@example.test", "javascript:alert(1)")).toThrow();
  });
});
