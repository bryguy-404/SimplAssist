import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewEnrollment, ReviewPreview } from "@/lib/reviews/types";
import ReviewHistory, {
  campaignHeading,
  enrollmentLabel,
} from "./ReviewHistory";
import { previewSendingEnabled, ReviewEmailPreview } from "./ReviewComposer";
import { reviewReason, reviewRequest, reviewSchedule } from "./reviewUi";

afterEach(() => vi.unstubAllGlobals());
describe("honest review status and safe preview", () => {
  it("explains revoked permission and uses channel-neutral suppression language", () => {
    expect(reviewReason("permission_revoked")).toContain(
      "Record renewed permission",
    );
    expect(reviewReason("suppressed")).not.toContain("Email");
  });
  const enrollment: ReviewEnrollment = {
    id: "request",
    contact_id: "customer",
    destination: "ada@example.com",
    status: "active",
    accepted_at: null,
    stop_reason: null,
    review_email_outbox: [],
  };
  it("shows the frozen campaign display subject while keeping templates out of headings", () => {
    const campaign = {
      id: "campaign",
      channel: "email" as const,
      subject: "How was your experience with {{business_name}}?",
      displaySubject: "How was your experience with Bryan Develops?",
      body: "Thanks",
      scheduled_at: "2026-10-03T14:00:00Z",
      reminder_enabled: false,
      audience_count: 1,
      created_at: "2026-10-03T14:00:00Z",
      summary: {},
      review_enrollments: [],
    };
    const html = renderToStaticMarkup(
      <ReviewHistory campaigns={[campaign]} onChanged={vi.fn()} />,
    );
    expect(html).toContain("How was your experience with Bryan Develops?");
    expect(html).not.toContain("{{business_name}}");
    expect(campaign.subject).toContain("{{business_name}}");
    expect(campaignHeading({ subject: campaign.subject })).toBe(
      "Email review request",
    );
  });
  it("never labels a click or delivery as a verified Google review", () => {
    expect(enrollmentLabel({ ...enrollment, status: "clicked" })).toBe(
      "Google link clicked",
    );
    expect(enrollmentLabel({ ...enrollment, status: "reviewed" })).toBe(
      "Marked reviewed by you",
    );
    expect(
      enrollmentLabel({
        ...enrollment,
        review_email_outbox: [
          {
            id: "email",
            kind: "initial",
            status: "delivered",
            scheduled_at: "2026-10-03T14:00:00Z",
            accepted_at: null,
            delivered_at: "2026-10-03T14:01:00Z",
            last_error: null,
          },
        ],
      }),
    ).toBe("Email delivered");
    expect(
      enrollmentLabel({
        ...enrollment,
        review_sms_outbox: [
          {
            id: "sms",
            kind: "initial",
            status: "delivered",
            scheduled_at: "2026-10-03T14:00:00Z",
            accepted_at: null,
            delivered_at: "2026-10-03T14:01:00Z",
            last_error: null,
          },
        ],
      }),
    ).toBe("Text delivered");
  });
  it("does not treat the email sending switch as SMS authorization", () => {
    expect(
      previewSendingEnabled(
        { channel: "sms", sendingEnabled: false } as ReviewPreview,
        true,
      ),
    ).toBe(false);
    expect(
      previewSendingEnabled({ channel: "sms" } as ReviewPreview, true),
    ).toBe(false);
    expect(
      previewSendingEnabled(
        { channel: "sms", sendingEnabled: true } as ReviewPreview,
        false,
      ),
    ).toBe(true);
    expect(
      previewSendingEnabled(
        { channel: "email", sendingEnabled: false } as ReviewPreview,
        true,
      ),
    ).toBe(false);
  });
  it("keeps Google and unsubscribe tracking URLs inert and escapes preview content", () => {
    const html = renderToStaticMarkup(
      <ReviewEmailPreview
        sample={{
          subject: "Thanks, Ada",
          text: "<script>alert(1)</script>\nhttps://app.example.com/r/signed-token",
          html: '<a href="https://app.example.com/r/signed-token">Review</a>',
        }}
      />,
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("https://app.example.com/r/signed-token");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<script>");
  });
  it("does not silently replace an invalid scheduled time with an immediate send", () => {
    expect(() => reviewSchedule("")).toThrow("valid send date");
    expect(() => reviewSchedule("invalid")).toThrow("valid send date");
    expect(reviewSchedule("2026-10-03T10:00:00-04:00")).toBe(
      "2026-10-03T14:00:00.000Z",
    );
  });
  it("reports a stale preview as an error instead of declaring a campaign scheduled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "review_preview_expired" }), {
          status: 409,
        }),
      ),
    );
    await expect(
      reviewRequest("/api/reviews/campaigns", {
        method: "POST",
        body: JSON.stringify({ previewToken: "old" }),
      }),
    ).rejects.toThrow("preview expired");
  });
});
