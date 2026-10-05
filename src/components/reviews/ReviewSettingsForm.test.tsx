import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FormEvent, ReactElement } from "react";
import type { ReviewOverview } from "@/lib/reviews/types";

const harness = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0, refresh: vi.fn(), showToast: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: harness.refresh }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ showToast: harness.showToast }) }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useId: () => "review-settings",
  useState: <T,>(initial: T) => {
    const index = harness.cursor++;
    if (!(index in harness.states)) harness.states[index] = initial;
    return [
      harness.states[index],
      (next: T) => {
        harness.states[index] = next;
      },
    ];
  },
}));

import ReviewSettingsForm from "./ReviewSettingsForm";
import { reviewReason } from "./reviewUi";

const overview: ReviewOverview = {
  settings: {
    business_id: "business",
    owner_id: "owner",
    google_review_url: "https://g.page/r/example/review",
    reply_to: "owner@example.com",
    reply_to_verified_at: "2026-10-03T14:00:00Z",
    notification_email: "owner@example.com",
    pending_reply_to: null,
    postal_address: null,
    timezone: "America/Indiana/Indianapolis",
    paused: false,
    subject: "How was your experience with {{business_name}}?",
    body: "Thank you, {{customer_name}}. Please share your honest feedback.",
    reminder_enabled: false,
    revision: 1,
  },
  templates: {
    subject: "Thanks",
    body: "Your feedback matters",
    reminderSubject: "A reminder",
    reminderBody: "Please share your feedback",
  },
  eligibility: {
    enabled: true,
    paid: true,
    paused: false,
    ready: true,
    sendingEnabled: false,
  },
  usage: { allowance: 500, used: 0, remaining: 500 },
};

beforeEach(() => {
  vi.clearAllMocks();
  harness.states = [];
  harness.cursor = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe("review email settings without a mailing address", () => {
  it("does not collect, display, or promise to include a saved postal address", () => {
    const html = renderToStaticMarkup(
      <ReviewSettingsForm
        overview={{
          ...overview,
          settings: {
            ...overview.settings,
            postal_address: "123 Legacy Home Street, South Bend, IN 46601",
          },
        }}
        ownerEmail="owner@example.com"
        onSaved={vi.fn()}
      />,
    );
    expect(html).not.toContain("postalAddress");
    expect(html).not.toContain("Business postal address");
    expect(html).not.toContain("Legacy Home Street");
    expect(html).not.toContain("business address");
    expect(html).toContain("business name, and unsubscribe link");
    expect(reviewReason("review_setup_incomplete")).toBe(
      "Save your Google review link first.",
    );
  });

  it("saves review settings without a postal address and preserves review options", async () => {
    const fields: Record<string, string> = {
      googleReviewUrl: "  https://g.page/r/example/review  ",
      timezone: "America/Indiana/Indianapolis",
      replyTo: "owner@example.com",
      notificationEmail: "owner@example.com",
      subject: overview.settings.subject,
      body: overview.settings.body,
      reminderEnabled: "on",
      automationEnabled: "on",
      automationChannel: "email",
    };
    vi.stubGlobal(
      "FormData",
      class {
        get(key: string) {
          return fields[key] || null;
        }
      },
    );
    const fetch = vi.fn().mockResolvedValue(Response.json(overview));
    vi.stubGlobal("fetch", fetch);
    const onSaved = vi.fn();
    const props = { overview, ownerEmail: "owner@example.com", onSaved };
    const component = ReviewSettingsForm(props);
    const form = (component.props.children as ReactElement[]).find(
      (child) => child?.type === "form",
    )!;
    await form.props.onSubmit({
      preventDefault: vi.fn(),
      currentTarget: {},
    } as unknown as FormEvent<HTMLFormElement>);

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe("/api/reviews/settings");
    expect(fetch.mock.calls[0][1].method).toBe("PATCH");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      googleReviewUrl: "https://g.page/r/example/review",
      timezone: "America/Indiana/Indianapolis",
      replyTo: "owner@example.com",
      notificationEmail: "owner@example.com",
      subject: overview.settings.subject,
      body: overview.settings.body,
      reminderEnabled: true,
      automationEnabled: true,
      automationChannel: "email",
    });
    expect(onSaved).toHaveBeenCalledWith(overview);
    expect(harness.refresh).toHaveBeenCalledOnce();
    expect(harness.showToast).toHaveBeenCalledWith("Review settings saved.", "success");
    harness.cursor = 0;
    expect(renderToStaticMarkup(ReviewSettingsForm(props))).toContain(
      "Review settings saved.",
    );
  });
});
