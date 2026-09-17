import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VoiceCallReviewContent, VoiceCallReviewPanel } from "./VoiceCallReview";
import type { VoiceCallReview } from "@/lib/voice/callReview";
const fixture = (): VoiceCallReview => ({
  conversationId: "call", receivedAt: "2026-09-17T12:00:00Z", startedAt: "2026-09-17T12:00:11Z", endedAt: "2026-09-17T12:01:11Z", durationSeconds: 60,
  call: { label: "Call ended", detail: "Action results show what was completed.", tone: "neutral" },
  contact: { id: "contact", name: "Stored name", phone: "+15555550101", email: "stored@example.test" },
  confirmedContact: { name: "Call name", phone: "+15555550101", email: "call@example.test", conflicts: ["name", "email"] },
  actions: [{ id: "action", title: "Signup link", label: "Signup text delivered", detail: "This does not confirm a completed signup.", tone: "success", confirmedAt: null, smsConversationId: "sms", leadId: "lead" }],
  recordings: [{ id: "recording", state: "available", url: "/api/voice/recordings/recording", expiresAt: "2026-10-17T12:00:00Z" }],
});
describe("owner call review", () => {
  it("shows recorded outcomes, confirmed and canonical details, and linked destinations", () => {
    const html = renderToStaticMarkup(<VoiceCallReviewContent call={fixture()} />);
    expect(html).toContain("Call name"); expect(html).toContain("Stored name");
    expect(html).toContain("Stored contact differs"); expect(html).toContain("call@example.test");
    expect(html).toContain("Existing contact details were kept.");
    expect(html).toContain("Signup text delivered"); expect(html).toContain("does not confirm a completed signup");
    expect(html).toContain('href="/contacts?contact=contact"');
    expect(html).toContain('href="/conversations?conversation=sms"');
    expect(html).toContain('href="/leads?lead=lead#lead-lead"');
    expect(html).not.toMatch(/Take Over|Let AI Handle|<textarea|Delete|Resend/);
  });
  it("uses only the protected audio route without autoplay or preload", () => {
    const html = renderToStaticMarkup(<VoiceCallReviewContent call={fixture()} />);
    expect(html).toContain('preload="none"');
    expect(html).toContain('src="/api/voice/recordings/recording"');
    expect(html).not.toContain("autoPlay");
  });
  it("explains missing actions, identity and expired audio without controls", () => {
    const call = fixture(); call.confirmedContact = null; call.actions = [];
    call.recordings[0] = { ...call.recordings[0], state: "expired", url: null };
    const html = renderToStaticMarkup(<VoiceCallReviewContent call={call} />);
    expect(html).toContain("No confirmed contact details were saved");
    expect(html).toContain("No actions recorded");
    expect(html).toContain("30-day retention"); expect(html).not.toContain("<audio");
  });
  it("has an accessible loading state", () => {
    expect(renderToStaticMarkup(<VoiceCallReviewPanel conversationId="call" />)).toContain('role="status"');
  });
});
