import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  number: vi.fn(),
  enabled: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not_found");
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mocks.from },
}));
vi.mock("@/lib/messaging/phoneNumberLookup", () => ({
  getActiveSmsNumberForBusiness: mocks.number,
}));
vi.mock("@/lib/billing/reviewSmsRollout.server", () => ({
  isReviewSmsEnabled: mocks.enabled,
}));
vi.mock("@/components/legal/LegalDocLayout", () => ({
  PublicPageShell: ({ children }: { children: React.ReactNode }) => children,
  publicHeaderLink: "link",
}));
import Page, { dynamic } from "./page";
const business = {
  id: "business",
  slug: "example",
  name: "Example & Co",
  email: "help@example.test",
  owner_id: "owner",
  review_sms_signup_enabled: true,
};
let currentBusiness: Record<string, unknown>;
let account: { state: string } | null;
let selections: string[];
beforeEach(() => {
  vi.clearAllMocks();
  currentBusiness = { ...business };
  account = { state: "active" };
  selections = [];
  mocks.number.mockResolvedValue("+15745550106");
  mocks.enabled.mockReturnValue(true);
  mocks.from.mockImplementation((table: string) => {
    const q = {
      select: (columns: string) => {
        selections.push(columns);
        return q;
      },
      eq: () => q,
      maybeSingle: async () => ({
        data: table === "businesses" ? currentBusiness : account,
        error: null,
      }),
    };
    return q;
  });
});
const render = async () =>
  renderToStaticMarkup(
    await Page({ params: Promise.resolve({ slug: "example" }) }),
  );
describe("public review-text consent page", () => {
  it("explains sender, frequency, marketing purpose and voluntary permission without a phone form", async () => {
    const html = await render();
    expect(dynamic).toBe("force-dynamic");
    for (const value of [
      "Example &amp; Co",
      "+15745550106",
      "automated marketing",
      "2 review messages",
      "not a condition of purchase",
      "HELP",
      "STOP",
      "Privacy Policy",
      "Terms of Service",
      "review-texts-v1",
    ])
      expect(html).toContain(value);
    expect(html).toContain('href="sms:+15745550106?body=REVIEWS"');
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    expect(selections.join(",")).not.toMatch(
      /ein|last_4_ssn|address|registrant_mobile/,
    );
  });
  it("shows carrier-readable disclosures before approval without encouraging a premature text", async () => {
    account = null;
    const html = await render();
    expect(html).toContain("automated marketing");
    expect(html).toContain("when messaging setup is ready");
    expect(html).not.toContain('href="sms:');
  });
  it.each(["carrier_pending", "ready_unpaid"])(
    "does not advertise active opt-in while %s",
    async (state) => {
      account = { state };
      expect(await render()).not.toContain('href="sms:');
    },
  );
  it("does not fabricate a number", async () => {
    mocks.number.mockResolvedValue(null);
    expect(await render()).not.toContain('href="sms:');
  });
  it.each([
    { owner_id: null },
    { deleted_at: "date" },
    { operations_suspended_at: "date" },
    { texting_paused_at: "date" },
    { telnyx_submission_disabled: true },
  ])("rejects unavailable business: %j", async (patch) => {
    Object.assign(currentBusiness, patch);
    await expect(render()).rejects.toThrow("not_found");
  });
  it("preserves legacy exclusions", async () => {
    mocks.enabled.mockReturnValue(false);
    await expect(render()).rejects.toThrow("not_found");
  });
  it("does not publish review opt-in for a business without review texting setup", async () => {
    currentBusiness.review_sms_signup_enabled = false;
    account = null;
    await expect(render()).rejects.toThrow("not_found");
  });
});
