import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  auth: { admin: { getUserById: vi.fn() } },
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: mocks }));
vi.mock("@/lib/email/businessEmailBrand.server", () => ({
  resolveBusinessEmailBrand: async () => ({
    from: "Reviews <reviews@example.test>",
  }),
}));
vi.mock("@/lib/stripe/config", () => ({ SUBSCRIPTION_PLANS: {} }));

import {
  confirmReviewCampaign,
  createReviewPreview,
  listReviewCampaigns,
  queueReviewTest,
  reviewOverview,
  updateReviewSettings,
} from "./service.server";

const businessId = "10000000-0000-4000-a096-000000000001";
const ownerId = "00000000-0000-4000-a096-000000000001";
const contactId = "20000000-0000-4000-a096-000000000001";
const previewId = "50000000-0000-4000-a096-000000000001";
const secondPreviewId = "50000000-0000-4000-a096-000000000002";
type QueryResult = { data: unknown; error: null; count?: number };
type QueryCall = { table: string; method: string; args: unknown[] };
let calls: QueryCall[];
let rows: Record<string, QueryResult>;
let savedSettings: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-03T14:02:00.000Z"));
  vi.stubEnv("REVIEWS_EMAIL_ENABLED", "1");
  vi.stubEnv("REVIEWS_EMAIL_PILOT_BUSINESS_IDS", businessId);
  vi.stubEnv("REVIEWS_LINK_SECRET", "a".repeat(32));
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://simplassist.com");
  calls = [];
  rows = {
    review_email_usage: { data: [], error: null },
    businesses: { data: { name: "Renamed Business" }, error: null },
    review_campaign_previews: { data: [], error: null },
  };
  savedSettings = {
    revision: 4,
    paused: false,
    google_review_url: "https://g.page/r/example/review",
    postal_address: null,
    timezone: "America/New_York",
    reply_to: "owner@example.test",
    reply_to_verified_at: "2026-01-01T00:00:00Z",
    subject: "Thanks from {{business_name}}",
    body: "Hello {{customer_name}}",
    reminder_enabled: false,
  };
  mocks.auth.admin.getUserById.mockResolvedValue({
    data: {
      user: {
        email: "owner@example.test",
        email_confirmed_at: "2026-01-01T00:00:00Z",
      },
    },
    error: null,
  });
  mocks.from.mockImplementation((table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of [
      "select",
      "eq",
      "order",
      "limit",
      "range",
      "in",
      "insert",
      "single",
      "maybeSingle",
    ]) {
      query[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return query;
      };
    }
    query.then = (resolve: (value: QueryResult) => unknown) =>
      Promise.resolve(rows[table] ?? { data: [], error: null }).then(resolve);
    return query;
  });
  mocks.rpc.mockImplementation(async (name: string) => {
    const data: Record<string, unknown> = {
      review_initialize_settings: savedSettings,
      review_business_billing: [
        {
          allowed: true,
          plan: "chat_only",
          allowance: 500,
          period_start: "2026-10-01T00:00:00Z",
          period_end: "2026-11-01T00:00:00Z",
        },
      ],
      review_program_enabled: true,
      review_audience_snapshot: {
        contacts: [
          {
            id: contactId,
            name: "Ada",
            email: "ada@example.test",
            phone_number: null,
            provided_phone_number: null,
            source_channel: "manual",
          },
        ],
        identities: [],
        permissions: [],
      },
      review_preview_blocks: [],
    };
    return { data: data[name], error: null };
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("frozen review campaign history", () => {
  it("renders frozen business names with one tenant-scoped snapshot batch", async () => {
    const subject = "How was {{business_name}}, {{customer_name}}?";
    rows.review_campaigns = {
      data: [
        { id: previewId, channel: "email", subject },
        { id: secondPreviewId, channel: "email", subject },
      ],
      error: null,
      count: 2,
    };
    rows.review_campaign_previews = {
      data: [
        {
          id: previewId,
          snapshot: {
            subject,
            businessName: "Original Business",
            recipients: [{ name: "Ada" }],
          },
        },
        {
          id: secondPreviewId,
          snapshot: {
            subject,
            businessName: "Earlier Business",
            recipients: [{ name: "One" }, { name: "Two" }],
          },
        },
      ],
      error: null,
    };
    const result = await listReviewCampaigns(businessId);
    expect(result.campaigns.map((campaign) => campaign.displaySubject)).toEqual(
      [
        "How was Original Business, Ada?",
        "How was Earlier Business, Customer?",
      ],
    );
    expect(result.campaigns[0].subject).toBe(subject);
    expect(
      mocks.from.mock.calls.filter(
        ([table]) => table === "review_campaign_previews",
      ),
    ).toHaveLength(1);
    expect(calls).toContainEqual({
      table: "review_campaign_previews",
      method: "eq",
      args: ["business_id", businessId],
    });
    expect(calls).toContainEqual({
      table: "review_campaign_previews",
      method: "in",
      args: ["id", [previewId, secondPreviewId]],
    });
    expect(mocks.from).not.toHaveBeenCalledWith("businesses");
  });
  it("uses a safe heading if the frozen snapshot is absent", async () => {
    rows.review_campaigns = {
      data: [
        { id: previewId, channel: "email", subject: "Hi {{business_name}}" },
      ],
      error: null,
      count: 1,
    };
    expect(
      (await listReviewCampaigns(businessId)).campaigns[0].displaySubject,
    ).toBe("Email review requests");
  });
});

const previewInput = (scheduledAt: string) => ({
  contactIds: [contactId],
  scheduledAt,
  completedServiceConfirmed: true,
  permissionConfirmed: true,
});
describe("review emails without mailing-address collection", () => {
  it("allows settings and readiness without a mailing address and ignores old form fields", async () => {
    expect((await reviewOverview(businessId, ownerId)).eligibility.ready).toBe(
      true,
    );
    await updateReviewSettings(businessId, ownerId, {
      googleReviewUrl: "https://g.page/r/example/review",
      timezone: "America/New_York",
      postalAddress: "",
    });
    expect(mocks.rpc).toHaveBeenCalledWith("review_update_settings", {
      p_business: businessId,
      p_owner: ownerId,
      p_patch: {
        google_review_url: "https://g.page/r/example/review",
        timezone: "America/New_York",
      },
    });
    mocks.rpc.mockClear();
    await updateReviewSettings(businessId, ownerId, {
      subject: "Thanks for your recent service",
      postalAddress: "321 Private Home Road",
    });
    expect(mocks.rpc).toHaveBeenCalledWith("review_update_settings", {
      p_business: businessId,
      p_owner: ownerId,
      p_patch: { subject: "Thanks for your recent service" },
    });
  });

  it.each(["google_review_url", "reply_to_verified_at"])(
    "still requires %s before preparing a customer email",
    async (field) => {
      savedSettings[field] = null;
      expect(
        (await reviewOverview(businessId, ownerId)).eligibility.ready,
      ).toBe(false);
      await expect(
        createReviewPreview(
          businessId,
          ownerId,
          previewInput("2026-10-03T14:03:00Z"),
        ),
      ).rejects.toThrow("review_setup_incomplete");
    },
  );

  it.each([null, "321 Private Home Road"])(
    "keeps saved address %s out of new previews, initial emails and reminders",
    async (address) => {
      savedSettings.postal_address = address;
      const preview = await createReviewPreview(businessId, ownerId, {
        ...previewInput("2026-10-03T14:03:00Z"),
        reminderEnabled: true,
      });
      const inserted = calls.find(
        (call) =>
          call.table === "review_campaign_previews" && call.method === "insert",
      )!.args[0] as { snapshot: Record<string, unknown> };
      expect(inserted.snapshot).not.toHaveProperty("postalAddress");
      expect(preview.summary.eligible).toBe(1);
      expect(preview.sample?.text).not.toMatch(
        /Private Home Road|Postal address/,
      );
      expect(preview.sample?.html).not.toMatch(
        /Private Home Road|Postal address/,
      );
      rows.review_campaign_previews = {
        data: {
          // A preview created by the previous release may still have this field.
          snapshot: {
            ...inserted.snapshot,
            postalAddress: "321 Private Home Road",
          },
          campaign_id: null,
        },
        error: null,
      };
      await confirmReviewCampaign(businessId, ownerId, preview.previewToken);
      const [, args] = mocks.rpc.mock.calls.find(
        ([name]) => name === "review_confirm_campaign",
      )!;
      const delivery = args.p_deliveries[0];
      for (const payload of [delivery.payload, delivery.reminderPayload]) {
        expect(payload.to).toEqual(["ada@example.test"]);
        expect(payload.replyTo).toBe("owner@example.test");
        expect(payload.text).not.toContain("321 Private Home Road");
        expect(payload.html).not.toContain("321 Private Home Road");
        expect(payload.text).toContain("Renamed Business");
        expect(payload.headers["List-Unsubscribe-Post"]).toBe(
          "List-Unsubscribe=One-Click",
        );
      }
    },
  );

  it.each([null, "321 Private Home Road"])(
    "keeps saved address %s and missing-address prompts out of owner previews",
    async (address) => {
      savedSettings.postal_address = address;
      await queueReviewTest(businessId, ownerId);
      const [, args] = mocks.rpc.mock.calls.find(
        ([name]) => name === "review_queue_owner_email",
      )!;
      expect(args.p_kind).toBe("test");
      expect(args.p_destination).toBe("owner@example.test");
      expect(args.p_payload.to).toEqual(["owner@example.test"]);
      expect(args.p_payload.text).not.toMatch(
        /Private Home Road|Postal address/,
      );
      expect(args.p_payload.html).not.toMatch(
        /Private Home Road|Postal address/,
      );
    },
  );
});
describe("bounded delayed completion automation", () => {
  it("normalizes a captured widget callback and prefers it over the routing phone", async () => {
    const originalRpc = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name !== "review_audience_snapshot") return originalRpc(name);
      return {
        data: {
          contacts: [
            {
              id: contactId,
              name: "Ada",
              email: "ada@example.test",
              source_channel: "web_chat",
              phone_number: "+15745550101",
              provided_phone_number: "(574) 555-0102",
            },
          ],
          identities: [],
          permissions: [],
        },
        error: null,
      };
    });
    const result = await createReviewPreview(
      businessId,
      ownerId,
      previewInput("2026-10-03T14:03:00.000Z"),
    );
    expect(result.recipients[0].phone).toBe("+15745550102");
    expect(result.recipients[0].identities).toEqual(
      expect.arrayContaining(["phone:+15745550101", "phone:+15745550102"]),
    );
    expect(result.recipients[0].identities).not.toContain(
      "phone:(574) 555-0102",
    );
  });
  it("accepts a two-minute worker delay without moving the original schedule", async () => {
    const scheduledAt = "2026-10-03T14:00:00.000Z";
    const result = await createReviewPreview(
      businessId,
      ownerId,
      previewInput(scheduledAt),
      { previewId },
    );
    expect(result.summary.eligible).toBe(1);
    expect(result.recipients[0].scheduledAt).toBe(scheduledAt);
    expect(
      calls.find(
        (call) =>
          call.table === "review_campaign_previews" && call.method === "insert",
      )?.args[0],
    ).toMatchObject({
      id: previewId,
      snapshot: { scheduledAt, recipients: [{ scheduledAt }] },
    });
  });
  it("rejects automation older than its original 24-hour window", async () => {
    await expect(
      createReviewPreview(
        businessId,
        ownerId,
        previewInput("2026-10-02T14:01:59.000Z"),
        { previewId },
      ),
    ).rejects.toThrow("invalid_review_schedule");
    expect(calls.some((call) => call.method === "insert")).toBe(false);
  });
  it("does not grant the automation grace period to a manual campaign", async () => {
    await expect(
      createReviewPreview(
        businessId,
        ownerId,
        previewInput("2026-10-03T14:00:00.000Z"),
      ),
    ).rejects.toThrow("invalid_review_schedule");
    expect(calls.some((call) => call.method === "insert")).toBe(false);
  });
});
