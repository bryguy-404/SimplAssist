import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("@/lib/messaging/client", () => ({
  telnyx: {
    messagingProfiles: {
      autorespConfigs: {
        list: mocks.list,
        create: mocks.create,
        update: mocks.update,
      },
    },
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: () => ({
      insert: mocks.insert,
      update: () => {
        const query = {
          eq: () => query,
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve(mocks.resolve()).then(resolve),
        };
        return query;
      },
    }),
  },
}));
import {
  ensureReviewSmsKeywords,
  inspectReviewSmsKeywords,
  keywordProgramFromCampaign,
  reviewSmsKeywordProgram,
} from "./smsKeywords.server";
import { serializeReviewCampaignKeywords } from "./campaignKeywords";

const businessId = "10000000-0000-4000-8000-000000000001";
const profileId = "10000000-0000-4000-8000-000000000002";
const program = reviewSmsKeywordProgram(
  "Example Services",
  "owner@example.test",
);
type StoredRule = (typeof program)["start"] & { id: string };
let rules: StoredRule[];
let intents: Set<string>;
let sequence: number;
const ruleId = () =>
  `20000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
const listResponse = () => ({
  data: rules.map((r) => ({ ...r })),
  meta: {
    page_number: 1,
    page_size: 20,
    total_pages: 1,
    total_results: rules.length,
  },
});
beforeEach(() => {
  vi.clearAllMocks();
  rules = [];
  intents = new Set();
  sequence = 0;
  mocks.list.mockImplementation(async () => listResponse());
  mocks.insert.mockImplementation(async ({ id }: { id: string }) => {
    if (intents.has(id)) return { error: { code: "23505" } };
    intents.add(id);
    return { error: null };
  });
  mocks.resolve.mockReturnValue({ error: null });
  mocks.create.mockImplementation(
    async (_profile: string, rule: (typeof program)["start"]) => {
      const created = { ...rule, id: ruleId() };
      rules.push(created);
      return { data: created };
    },
  );
  mocks.update.mockImplementation(
    async (id: string, rule: (typeof program)["start"]) => {
      const updated = { ...rule, id };
      rules = rules.map((existing) =>
        existing.id === id ? updated : existing,
      );
      return { data: updated };
    },
  );
});

describe("review SMS runtime keywords", () => {
  it("keeps inbound aliases and existing profile readiness when carrier declarations omit spaces", async () => {
    const fromCampaign = keywordProgramFromCampaign({
      optinKeywords: "REVIEWS", optinMessage: "Consent received",
      optoutKeywords: serializeReviewCampaignKeywords(program.stop.keywords), optoutMessage: program.stop.resp_text,
      helpKeywords: serializeReviewCampaignKeywords(program.info.keywords), helpMessage: program.info.resp_text,
    }, "Example Services");
    expect(fromCampaign).toEqual(program);
    expect(fromCampaign.stop.keywords).toEqual(["STOP", "STOPALL", "STOP ALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPT OUT"]);
    rules = Object.values(program).map(rule => ({ ...rule, id: ruleId() }));
    expect(await inspectReviewSmsKeywords(profileId, fromCampaign)).toEqual({ ready: true, issues: [] });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("preserves existing customer-care keyword subsets and still rejects unknown additions", () => {
    const campaign = {
      optinKeywords: "START", optinMessage: "Messaging restored",
      optoutKeywords: "STOP", optoutMessage: "Unsubscribed",
      helpKeywords: "HELP", helpMessage: "Contact support",
    };
    expect(keywordProgramFromCampaign(campaign).stop.keywords).toEqual(["STOP", "STOPALL", "STOP ALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
    expect(() => keywordProgramFromCampaign({ ...campaign, optoutKeywords: `${serializeReviewCampaignKeywords(program.stop.keywords)},UNKNOWN` })).toThrow("review_sms_campaign_keywords_unsupported");
  });
  it("uses one program for carrier declarations and profile confirmations", () => {
    const fromCampaign = keywordProgramFromCampaign({
      optinKeywords: program.start.keywords.join(","),
      optinMessage: program.start.resp_text,
      optoutKeywords: program.stop.keywords.join(","),
      optoutMessage: program.stop.resp_text,
      helpKeywords: program.info.keywords.join(","),
      helpMessage: program.info.resp_text,
    });
    expect(fromCampaign).toEqual(program);
    expect(program.start.resp_text).toContain(
      "Text REVIEWS to subscribe",
    );
    expect(program.info.resp_text).toContain("owner@example.test");
  });
  it("keeps application-owned REVIEWS out of provider START and restores messaging without claiming review consent", () => {
    const campaign = {optinKeywords:"REVIEWS",optinMessage:"Example: Review consent received",optoutKeywords:"STOP",optoutMessage:program.stop.resp_text,helpKeywords:"HELP",helpMessage:program.info.resp_text};
    expect(() => keywordProgramFromCampaign(campaign)).toThrow("review_sms_keyword_copy_invalid");
    const actual = keywordProgramFromCampaign(campaign, "Example Services");
    expect(actual.start.keywords).toEqual(["START","UNSTOP"]);
    expect(actual.start.resp_text).toContain("Text REVIEWS to subscribe");
    expect(actual.start.resp_text).not.toContain("consent received");
  });
  it("refuses incomplete or unsupported approved keyword declarations", () => {
    expect(() => keywordProgramFromCampaign({})).toThrow(
      "review_sms_campaign_keywords_missing",
    );
    expect(() =>
      keywordProgramFromCampaign({
        optinKeywords: "START,SUBSCRIBE",
        optinMessage: "Subscribed",
        optoutKeywords: "STOP",
        optoutMessage: "Unsubscribed",
        helpKeywords: "HELP",
        helpMessage: "Contact support",
      }),
    ).toThrow("review_sms_campaign_keywords_unsupported");
  });
  it("reports existing-profile gaps without modifying provider rules", async () => {
    expect(await inspectReviewSmsKeywords(profileId, program)).toEqual({
      ready: false,
      issues: ["missing_stop", "missing_start", "missing_info"],
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("creates missing rules once, verifies readback, and replays without provider writes", async () => {
    const authorizeMutation = vi.fn().mockResolvedValue(undefined);
    await ensureReviewSmsKeywords({
      businessId,
      profileId,
      program,
      authorizeMutation,
    });
    expect(mocks.create).toHaveBeenCalledTimes(3);
    expect(authorizeMutation).toHaveBeenCalledTimes(6);
    expect(await inspectReviewSmsKeywords(profileId, program)).toEqual({
      ready: true,
      issues: [],
    });
    await ensureReviewSmsKeywords({
      businessId,
      profileId,
      program,
      authorizeMutation,
    });
    expect(mocks.create).toHaveBeenCalledTimes(3);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledWith(profileId, program.stop, {
      maxRetries: 0,
      timeout: 10000,
    });
  });
  it("refuses mutation before any POST if tenant authorization changes", async () => {
    const authorizeMutation = vi
      .fn()
      .mockRejectedValue(new Error("claim expired"));
    await expect(
      ensureReviewSmsKeywords({
        businessId,
        profileId,
        program,
        authorizeMutation,
      }),
    ).rejects.toThrow("claim expired");
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("requires authorization again after persisting a create intent", async () => {
    const authorizeMutation = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("scope changed"));
    await expect(
      ensureReviewSmsKeywords({
        businessId,
        profileId,
        program,
        authorizeMutation,
      }),
    ).rejects.toThrow("scope changed");
    expect(mocks.insert).toHaveBeenCalledOnce();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("never repeats an ambiguous POST when readback still shows no rule", async () => {
    const authorizeMutation = vi.fn().mockResolvedValue(undefined);
    mocks.create.mockRejectedValue(new Error("timeout"));
    await expect(
      ensureReviewSmsKeywords({
        businessId,
        profileId,
        program,
        authorizeMutation,
      }),
    ).rejects.toThrow("timeout");
    await expect(
      ensureReviewSmsKeywords({
        businessId,
        profileId,
        program,
        authorizeMutation,
      }),
    ).rejects.toThrow("review_sms_keywords_reconciliation_required");
    expect(mocks.create).toHaveBeenCalledOnce();
  });
  it("recovers an accepted POST after timeout without creating its rule twice", async () => {
    const authorizeMutation = vi.fn().mockResolvedValue(undefined);
    mocks.create.mockImplementationOnce(
      async (_profile: string, rule: (typeof program)["start"]) => {
        rules.push({ ...rule, id: ruleId() });
        throw new Error("timeout after acceptance");
      },
    );
    await expect(
      ensureReviewSmsKeywords({
        businessId,
        profileId,
        program,
        authorizeMutation,
      }),
    ).rejects.toThrow("timeout after acceptance");
    await ensureReviewSmsKeywords({
      businessId,
      profileId,
      program,
      authorizeMutation,
    });
    expect(mocks.create).toHaveBeenCalledTimes(3);
    expect(rules.filter((rule) => rule.op === "stop")).toHaveLength(1);
  });
  it("updates both global and US responses on an authorized review-owned profile", async () => {
    rules = Object.values(program).map((rule) => ({
      ...rule,
      id: ruleId(),
      resp_text: "Old response",
    }));
    rules.push({
      ...program.info,
      id: ruleId(),
      country_code: "US",
      resp_text: "Old US response",
    });
    rules.push({
      ...program.info,
      id: ruleId(),
      country_code: "CA",
      resp_text: "Other country unchanged",
    });
    const authorizeMutation = vi.fn().mockResolvedValue(undefined);
    await ensureReviewSmsKeywords({
      businessId,
      profileId,
      program,
      authorizeMutation,
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledTimes(4);
    expect(rules.find((rule) => rule.country_code === "CA")?.resp_text).toBe(
      "Other country unchanged",
    );
  });
  it("fails closed on duplicated or conflicting provider configurations", async () => {
    rules = [
      { ...program.stop, id: ruleId() },
      { ...program.stop, id: ruleId() },
    ];
    const authorizeMutation = vi.fn().mockResolvedValue(undefined);
    await expect(
      ensureReviewSmsKeywords({
        businessId,
        profileId,
        program,
        authorizeMutation,
      }),
    ).rejects.toThrow("review_sms_keywords_conflict");
    expect(authorizeMutation).not.toHaveBeenCalled();
    rules = [
      { ...program.stop, id: ruleId() },
      {
        ...program.start,
        id: ruleId(),
        country_code: "US",
        keywords: ["STOP"],
      },
    ];
    expect(
      (await inspectReviewSmsKeywords(profileId, program)).issues,
    ).toContain("conflicting_US_start");
  });
  it("cannot treat an incomplete provider list as permission to create", async () => {
    mocks.list.mockResolvedValue({
      data: [],
      meta: { page_number: 1, total_pages: 2, total_results: 30 },
    });
    await expect(
      ensureReviewSmsKeywords({
        businessId,
        profileId,
        program,
        authorizeMutation: vi.fn(),
      }),
    ).rejects.toThrow("review_sms_keywords_list_incomplete");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
