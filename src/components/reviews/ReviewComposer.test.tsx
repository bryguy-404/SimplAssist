import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { ReviewOverview, ReviewPreview } from "@/lib/reviews/types";
const harness = vi.hoisted(() => ({ states: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useId: () => "review-composer",
  useEffect: () => {},
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
import ReviewComposer from "./ReviewComposer";
const overview = {
  settings: {
    subject: "Thanks",
    body: "Your feedback matters",
    reminder_enabled: true,
    timezone: "America/New_York",
  },
  eligibility: { sendingEnabled: true },
} as ReviewOverview;
const preview: ReviewPreview = {
  previewToken: "frozen-review-preview",
  expiresAt: "2026-10-03T14:15:00Z",
  channel: "email",
  sendingEnabled: true,
  summary: { selected: 1, eligible: 1, excluded: 0 },
  recipients: [],
  excluded: [],
  sample: { subject: "Thanks", text: "Exact frozen message", html: "" },
  usage: { allowance: 500, used: 0, remaining: 500 },
  reminderEnabled: true,
  estimatedEmails: 2,
};
const props = { overview, onClose: vi.fn(), onCreated: vi.fn() };
function render() {
  harness.cursor = 0;
  return ReviewComposer(props);
}
function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement;
  return [element, ...elements(element.props.children)];
}
function label(node: ReactNode): string {
  return Array.isArray(node)
    ? node.map(label).join("")
    : typeof node === "string"
      ? node
      : node && typeof node === "object" && "props" in node
        ? label((node as ReactElement).props.children)
        : "";
}
function confirmButton() {
  return elements(render()).find(
    (element) =>
      element.type === "button" && label(element).startsWith("Schedule "),
  )!;
}
beforeEach(() => {
  vi.clearAllMocks();
  harness.states = [];
  harness.states[15] = preview;
  harness.cursor = 0;
});
afterEach(() => vi.unstubAllGlobals());
describe("review confirmation safety", () => {
  it("keeps an interrupted confirmation open and retries only its frozen preview token", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("Connection interrupted"))
      .mockResolvedValueOnce(Response.json({ campaignId: "campaign-id" }));
    vi.stubGlobal("fetch", fetch);
    await confirmButton().props.onClick();
    expect(props.onCreated).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(label(render())).toContain("Connection interrupted");
    await confirmButton().props.onClick();
    expect(
      fetch.mock.calls.map(([url, init]) => [url, JSON.parse(init.body)]),
    ).toEqual([
      ["/api/reviews/campaigns", { previewToken: "frozen-review-preview" }],
      ["/api/reviews/campaigns", { previewToken: "frozen-review-preview" }],
    ]);
    expect(props.onCreated).toHaveBeenCalledOnce();
  });
  it("does not confirm an SMS campaign when its sending flag is off, even if email is active", async () => {
    harness.states[15] = {
      ...preview,
      channel: "sms",
      sendingEnabled: false,
      estimatedSmsParts: 4,
      estimatedEmails: 0,
    };
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(confirmButton().props.disabled).toBe(true);
    await confirmButton().props.onClick();
    expect(fetch).not.toHaveBeenCalled();
    expect(props.onCreated).not.toHaveBeenCalled();
    expect(label(render())).toContain("SMS parts including reminders");
  });
  it("requires a new preview after an expired one without reporting success", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: "review_preview_expired" }, { status: 409 }),
        ),
    );
    await confirmButton().props.onClick();
    expect(props.onCreated).not.toHaveBeenCalled();
    const back = elements(render()).find(
      (element) =>
        element.type === "button" && label(element) === "Back to edit",
    )!;
    back.props.onClick();
    expect(harness.states[15]).toBeNull();
  });
});
