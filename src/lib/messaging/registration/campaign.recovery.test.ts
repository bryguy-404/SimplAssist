import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  submit: vi.fn(),
  getCost: vi.fn(),
  qualify: vi.fn(),
  deactivate: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  appendRegistrationEvent: vi.fn(),
  buildSmsComplianceCopy: vi.fn(),
  resolveLegalUrls: vi.fn(),
  buildRiskInput: vi.fn(),
  hashRiskInput: vi.fn(),
  getActiveSmsNumber: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/messaging/client", () => ({
  telnyx: {
    messaging10dlc: {
      campaign: {
        list: mocks.list,
        deactivate: mocks.deactivate,
        usecase: { getCost: mocks.getCost },
      },
      campaignBuilder: {
        brand: { qualifyByUsecase: mocks.qualify },
        submit: mocks.submit,
      },
    },
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("./audit", () => ({
  appendRegistrationEvent: mocks.appendRegistrationEvent,
  serializeError: (error: unknown) => ({
    message: error instanceof Error ? error.message : "unknown",
  }),
}));
vi.mock("@/lib/messaging/complianceCopy", () => ({
  buildSmsComplianceCopy: mocks.buildSmsComplianceCopy,
}));
vi.mock("@/lib/messaging/phoneNumberLookup", () => ({
  getActiveSmsNumberForBusiness: mocks.getActiveSmsNumber,
}));
vi.mock("./legalUrls", () => ({
  resolveLegalUrls: mocks.resolveLegalUrls,
}));
vi.mock("./riskScreening", () => ({
  buildA2pRiskInputForBusiness: mocks.buildRiskInput,
  hashA2pRiskInput: mocks.hashRiskInput,
}));

import { registerCampaign } from "./campaign";
import { CarrierRejectionSupportRequiredError } from "@/lib/onboarding/rejectionGuidance";

const BUSINESS_ID = "00000000-0000-4000-8000-000000000001";
const BRAND_ID = "4b20019d-e93e-4000-8000-000000000001";
const CAMPAIGN_ID = "CMN3FR1";
const NEW_CAMPAIGN_ID = "CMNNEW1";
const CAP_MESSAGE =
  "This Telnyx brand is at Telnyx's campaign cap: it already has 5 campaigns, the maximum allowed per brand. SimplAssist cannot create the additional campaign required for this account. Use a different eligible brand or contact Telnyx Support before approving this link.";
const SIGNUP_GOAL_URL_INVALID_MESSAGE =
  "Add a valid HTTPS signup link for your primary goal before retrying SMS registration.";
const SIGNUP_SAMPLE_TOO_LONG_MESSAGE =
  "The signup link is too long for a carrier campaign sample. Add a shorter direct HTTPS signup link before retrying SMS registration.";
const SIGNUP_SAMPLE_PERSIST_FAILED_MESSAGE =
  "We couldn't save the required signup-link campaign sample. No campaign was submitted; please try again.";

const baseBusiness = {
  id: BUSINESS_ID,
  name: "SimplAssist",
  email: "owner@example.com",
  phone_number: null,
  telnyx_brand_id: BRAND_ID,
  telnyx_campaign_id: null as string | null,
  use_case_description: "Respond to customer questions and missed calls.",
  sample_messages: ["Sample one", "Sample two", "Sample three"],
  slug: "simplassist",
  privacy_terms_mode: "hosted",
  privacy_url_override: null,
  terms_url_override: null,
  ai_settings: { language: "en" },
  primary_goal: "book" as
    | "book"
    | "signup"
    | "quote"
    | "callback"
    | null,
  goal_url: null as string | null,
  brand_status: null as string | null,
  campaign_status: null as string | null,
  brand_rejection_reason: null as string | null,
  campaign_rejection_reason: null as string | null,
};

let business = {
  ...baseBusiness,
  sample_messages: [...baseBusiness.sample_messages],
};

const complianceCopy = {
  messageFlow: "Customers opt in on the website.",
  confirmationSms: "You are subscribed.",
  voicemailGreeting: "Press 1 to agree to receive texts.",
  optinMessage: "You are subscribed.",
  optoutMessage: "You are unsubscribed.",
  helpMessage: "Reply STOP to opt out.",
};

type PersistenceResult = {
  data: { id: string } | null;
  error: { message: string } | null;
};

let persistenceResults: PersistenceResult[];
let updates: Array<Record<string, unknown>>;
let archivedCampaignIds: string[];
let campaignHistoryError: { message: string } | null;
let campaignHistoryDataOverride: unknown;
let selectedBusinessColumns: string[];
let riskReviewStatus: string | null;
let sampleMessagesUpdateError: { message: string } | null;
let operationTrace: string[];

function owns(payload: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key);
}

function submittedPayload() {
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  return mocks.submit.mock.calls[0][0] as Record<string, unknown>;
}

function expectedCampaignPayload(
  sampleMessages: string[],
  embeddedLink: boolean
): Record<string, unknown> {
  return {
    brandId: BRAND_ID,
    description: business.use_case_description,
    usecase: "CUSTOMER_CARE",
    sample1: sampleMessages[0],
    sample2: sampleMessages[1],
    sample3: sampleMessages[2],
    sample4: sampleMessages[3],
    sample5: sampleMessages[4],
    messageFlow: complianceCopy.messageFlow,
    subscriberOptin: true,
    optinKeywords: "START,SUBSCRIBE,YES",
    optinMessage: complianceCopy.optinMessage,
    subscriberOptout: true,
    optoutKeywords: "STOP,END,UNSUBSCRIBE,CANCEL,QUIT",
    optoutMessage: complianceCopy.optoutMessage,
    subscriberHelp: true,
    helpKeywords: "HELP,INFO",
    helpMessage: complianceCopy.helpMessage,
    termsAndConditions: true,
    privacyPolicyLink: "https://app.simplassist.com/c/simplassist/privacy",
    termsAndConditionsLink: "https://app.simplassist.com/c/simplassist/terms",
    autoRenewal: true,
    embeddedLink,
    embeddedPhone: false,
    ageGated: false,
    numberPool: false,
    directLending: false,
    referenceId: BUSINESS_ID,
    webhookURL:
      "https://app.simplassist.com/api/messaging/registration/status",
    webhookFailoverURL:
      "https://app.simplassist.com/api/messaging/registration/status",
  };
}

function asyncItems(items: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  };
}

function setCampaigns(items: unknown[]) {
  mocks.list.mockImplementation(() => asyncItems(items));
}

function campaignItem(overrides: Record<string, unknown> = {}) {
  return {
    brandId: BRAND_ID,
    campaignId: CAMPAIGN_ID,
    campaignStatus: "MNO_PENDING",
    failureReasons: null,
    referenceId: BUSINESS_ID,
    ...overrides,
  };
}

function unrelatedCampaign(index: number) {
  return campaignItem({
    campaignId: `OTHER${index}`,
    referenceId: `external-reference-${index}`,
  });
}

function augmentPromise<T>(
  value: T,
  additions: Record<string, unknown>
): Promise<T> & Record<string, unknown> {
  return Object.assign(Promise.resolve(value), additions);
}

function businessQuery() {
  return {
    select: vi.fn((columns: string) => {
      selectedBusinessColumns.push(columns);
      return {
        eq: vi.fn(() => ({
          single: vi.fn(async () =>
            columns === "a2p_risk_review_status"
              ? { data: { a2p_risk_review_status: riskReviewStatus }, error: null }
              : { data: { ...business }, error: null }
          ),
        })),
      };
    }),
    update: vi.fn((payload: Record<string, unknown>) => {
      updates.push(payload);
      return {
        eq: vi.fn(() => {
          const operation = owns(payload, "sample_messages")
            ? "sample_messages"
            : owns(payload, "opt_in_description")
              ? "opt_in_description"
              : owns(payload, "a2p_risk_review_input_hash")
                ? "a2p_risk_review_input_hash"
                : owns(payload, "telnyx_campaign_id")
                  ? "telnyx_campaign_id"
                  : "business_update";
          operationTrace.push(operation);

          return augmentPromise(
            {
              data: null,
              error:
                operation === "sample_messages"
                  ? sampleMessagesUpdateError
                  : null,
            },
            {
              is: vi.fn(() => ({
                select: vi.fn(() => ({
                  maybeSingle: vi.fn(async () =>
                    persistenceResults.shift() ?? {
                      data: { id: BUSINESS_ID },
                      error: null,
                    }
                  ),
                })),
              })),
            }
          );
        }),
      };
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.simplassist.com/");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  business = {
    ...baseBusiness,
    sample_messages: [...baseBusiness.sample_messages],
  };
  persistenceResults = [];
  updates = [];
  archivedCampaignIds = [];
  campaignHistoryError = null;
  campaignHistoryDataOverride = undefined;
  selectedBusinessColumns = [];
  riskReviewStatus = "not_started";
  sampleMessagesUpdateError = null;
  operationTrace = [];
  setCampaigns([]);
  mocks.rpc.mockResolvedValue({ data: false, error: null });
  mocks.from.mockImplementation((table: string) => {
    if (table === "businesses") return businessQuery();
    if (table === "rejected_campaigns") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(async () => ({
            data:
              campaignHistoryDataOverride !== undefined
                ? campaignHistoryDataOverride
                : archivedCampaignIds.map((telnyx_campaign_id) => ({
                    telnyx_campaign_id,
                  })),
            error: campaignHistoryError,
          })),
        })),
      };
    }
    throw new Error(`Unexpected table ${table}`);
  });
  mocks.appendRegistrationEvent.mockResolvedValue(undefined);
  mocks.buildSmsComplianceCopy.mockReturnValue(complianceCopy);
  mocks.getActiveSmsNumber.mockResolvedValue("+15551234567");
  mocks.resolveLegalUrls.mockReturnValue({
    privacyUrl: "https://app.simplassist.com/c/simplassist/privacy",
    termsUrl: "https://app.simplassist.com/c/simplassist/terms",
  });
  mocks.getCost.mockResolvedValue({ monthlyCost: 1.5, upFrontCost: 15 });
  mocks.qualify.mockResolvedValue({ usecase: "CUSTOMER_CARE" });
  mocks.buildRiskInput.mockResolvedValue({ input: { businessId: BUSINESS_ID } });
  mocks.hashRiskInput.mockReturnValue("risk-input-hash");
  mocks.submit.mockImplementation(async () => {
    operationTrace.push("submit");
    return { campaignId: NEW_CAMPAIGN_ID };
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("goal-aware signup campaign filing", () => {
  const normalizedGoalUrl = "https://signup.example.com/enroll";
  const storedSamples = [
    "Sample one",
    "Sample two",
    "Sample three",
    "Sample four",
    "Sample five",
  ];
  const generatedSignupSample =
    "Thanks for contacting Acme Camps. To sign up, visit https://signup.example.com/enroll. Reply STOP to opt out.";

  it("persists paid-upgrade generated copy through the guarded registration RPC", async () => {
    business = { ...business, name: "Acme Camps", primary_goal: "signup", goal_url: normalizedGoalUrl, sample_messages: [...storedSamples] };
    mocks.rpc.mockResolvedValue({ data: true, error: null });

    await registerCampaign(BUSINESS_ID);

    expect(mocks.rpc).toHaveBeenCalledWith("persist_chat_texting_upgrade_campaign_copy", {
      p_business_id: BUSINESS_ID,
      p_sample_messages: [storedSamples[0], storedSamples[1], generatedSignupSample, storedSamples[3], storedSamples[4]],
      p_opt_in_description: expect.any(String),
    });
    expect(updates.some((update) => owns(update, "sample_messages") || owns(update, "opt_in_description"))).toBe(false);
    expect(mocks.submit).toHaveBeenCalledOnce();
  });

  it.each([
    { data: null, error: { message: "texting_upgrade_registration_stopped" } },
    { data: null, error: null },
  ])("never falls back or submits when the guarded copy write is denied", async (result) => {
    mocks.rpc.mockResolvedValue(result);

    await expect(registerCampaign(BUSINESS_ID)).rejects.toThrow("Failed to persist guarded campaign copy");

    expect(updates.some((update) => owns(update, "sample_messages") || owns(update, "opt_in_description"))).toBe(false);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.getCost).not.toHaveBeenCalled();
  });

  it("files and persists a clean signup-link sample before submission", async () => {
    business = {
      ...business,
      name: "  Acme Camps  ",
      primary_goal: "signup",
      goal_url: `  ${normalizedGoalUrl}  `,
      sample_messages: [...storedSamples],
    };
    riskReviewStatus = "passed";

    await registerCampaign(BUSINESS_ID);

    expect(
      selectedBusinessColumns.some(
        (columns) =>
          columns.includes("primary_goal") && columns.includes("goal_url")
      )
    ).toBe(true);
    expect(submittedPayload()).toEqual(
      expectedCampaignPayload(
        [
          storedSamples[0],
          storedSamples[1],
          generatedSignupSample,
          storedSamples[3],
          storedSamples[4],
        ],
        true
      )
    );
    expect(mocks.submit).toHaveBeenCalledWith(expect.any(Object), {
      maxRetries: 0,
    });
    expect(
      updates.filter((update) => owns(update, "sample_messages"))
    ).toEqual([
      {
        sample_messages: [
          storedSamples[0],
          storedSamples[1],
          generatedSignupSample,
          storedSamples[3],
          storedSamples[4],
        ],
      },
    ]);
    expect(operationTrace.slice(0, 4)).toEqual([
      "sample_messages",
      "opt_in_description",
      "a2p_risk_review_input_hash",
      "submit",
    ]);
  });

  it("reuses an exact signup-link sample without modifying stored samples", async () => {
    const linkedSamples = [
      storedSamples[0],
      storedSamples[1],
      storedSamples[2],
      `Continue here: ${normalizedGoalUrl}`,
      storedSamples[4],
    ];
    business = {
      ...business,
      primary_goal: "signup",
      goal_url: normalizedGoalUrl,
      sample_messages: [...linkedSamples],
    };

    await registerCampaign(BUSINESS_ID);

    expect(submittedPayload()).toEqual(
      expectedCampaignPayload(linkedSamples, true)
    );
    expect(updates.some((update) => owns(update, "sample_messages"))).toBe(
      false
    );
  });

  it.each([
    ["book", "book" as const],
    ["legacy null", null],
  ])(
    "keeps the %s campaign payload byte-for-byte compatible",
    async (_label, primaryGoal) => {
      business = {
        ...business,
        primary_goal: primaryGoal,
        goal_url: normalizedGoalUrl,
        sample_messages: [...storedSamples],
      };

      await registerCampaign(BUSINESS_ID);

      expect(mocks.submit).toHaveBeenCalledWith(
        expectedCampaignPayload(storedSamples, false),
        { maxRetries: 0 }
      );
      expect(updates.some((update) => owns(update, "sample_messages"))).toBe(
        false
      );
    }
  );

  it.each([
    ["missing", null],
    ["empty", ""],
    ["whitespace", "   "],
    ["http", "http://example.com/signup"],
    ["malformed", "not a URL"],
  ])("halts signup filing for a %s goal URL", async (_label, goalUrl) => {
    business = {
      ...business,
      primary_goal: "signup",
      goal_url: goalUrl,
      sample_messages: [...storedSamples],
    };

    await expect(registerCampaign(BUSINESS_ID)).rejects.toMatchObject({
      code: "campaign_signup_goal_url_invalid",
      kind: "permanent",
      message: SIGNUP_GOAL_URL_INVALID_MESSAGE,
    });

    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.resolveLegalUrls).not.toHaveBeenCalled();
    expect(mocks.getActiveSmsNumber).not.toHaveBeenCalled();
    expect(mocks.buildSmsComplianceCopy).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(mocks.getCost).not.toHaveBeenCalled();
    expect(mocks.qualify).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("halts when the generated signup sample exceeds the carrier limit", async () => {
    business = {
      ...business,
      primary_goal: "signup",
      goal_url: `https://example.com/${"a".repeat(220)}`,
      sample_messages: [...storedSamples],
    };

    await expect(registerCampaign(BUSINESS_ID)).rejects.toMatchObject({
      code: "campaign_signup_sample_too_long",
      kind: "permanent",
      message: SIGNUP_SAMPLE_TOO_LONG_MESSAGE,
    });

    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.resolveLegalUrls).not.toHaveBeenCalled();
    expect(mocks.getActiveSmsNumber).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(mocks.getCost).not.toHaveBeenCalled();
    expect(mocks.qualify).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("halts before provider preflight when signup sample persistence fails", async () => {
    business = {
      ...business,
      primary_goal: "signup",
      goal_url: normalizedGoalUrl,
      sample_messages: [...storedSamples],
    };
    sampleMessagesUpdateError = { message: "database unavailable" };

    await expect(registerCampaign(BUSINESS_ID)).rejects.toMatchObject({
      code: "campaign_signup_sample_persist_failed",
      kind: "transient",
      message: SIGNUP_SAMPLE_PERSIST_FAILED_MESSAGE,
    });

    expect(
      updates.filter((update) => owns(update, "sample_messages"))
    ).toHaveLength(1);
    expect(operationTrace).toEqual(["sample_messages"]);
    expect(mocks.getCost).not.toHaveBeenCalled();
    expect(mocks.qualify).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("recovers an existing campaign before validating the current signup URL", async () => {
    business = {
      ...business,
      primary_goal: "signup",
      goal_url: null,
      sample_messages: [...storedSamples],
    };
    setCampaigns([campaignItem()]);

    await expect(registerCampaign(BUSINESS_ID)).resolves.toBeUndefined();

    expect(updates).toContainEqual(
      expect.objectContaining({ telnyx_campaign_id: CAMPAIGN_ID })
    );
    expect(updates.some((update) => owns(update, "sample_messages"))).toBe(
      false
    );
    expect(mocks.resolveLegalUrls).not.toHaveBeenCalled();
    expect(mocks.getActiveSmsNumber).not.toHaveBeenCalled();
    expect(mocks.getCost).not.toHaveBeenCalled();
    expect(mocks.qualify).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});

describe("registerCampaign recover-before-create", () => {
  it.each([
    ["brand", "Existing brand was rejected"],
    ["campaign", "Existing campaign was rejected"],
  ] as const)(
    "does not reuse an existing campaign id after a %s rejection",
    async (resource, reason) => {
      business = {
        ...business,
        telnyx_campaign_id: CAMPAIGN_ID,
        brand_status: resource === "brand" ? "rejected" : "approved",
        campaign_status: resource === "campaign" ? "rejected" : null,
        brand_rejection_reason: resource === "brand" ? reason : null,
        campaign_rejection_reason: resource === "campaign" ? reason : null,
      };

      const error = await registerCampaign(BUSINESS_ID).catch(
        (caught) => caught,
      );

      expect(error).toBeInstanceOf(CarrierRejectionSupportRequiredError);
      expect(error).toMatchObject({
        code: "rejection_support_required",
        carrierReason: reason,
        rejectedResource: resource,
      });
      expect(mocks.list).not.toHaveBeenCalled();
      expect(mocks.submit).not.toHaveBeenCalled();
      expect(updates).toEqual([]);
    },
  );

  it("lists by brand before a normal submit when no referenceId matches", async () => {
    setCampaigns([unrelatedCampaign(1)]);

    await registerCampaign(BUSINESS_ID);

    expect(mocks.list).toHaveBeenCalledWith({
      brandId: BRAND_ID,
      recordsPerPage: 10,
    });
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({ referenceId: BUSINESS_ID, brandId: BRAND_ID }),
      { maxRetries: 0 }
    );
    expect(updates).toContainEqual(
      expect.objectContaining({ telnyx_campaign_id: NEW_CAMPAIGN_ID })
    );
  });

  it.each([
    ["brand", "brand_status", "brand_rejection_reason"],
    ["campaign", "campaign_status", "campaign_rejection_reason"],
  ] as const)(
    "fails closed when a %s rejection lands after preflight but before charged submit",
    async (_label, statusField, reasonField) => {
      const exactReason = `Exact ${_label} carrier reason`;
      mocks.qualify.mockImplementationOnce(async () => {
        business = {
          ...business,
          [statusField]: "rejected",
          [reasonField]: exactReason,
        };
        return { usecase: "CUSTOMER_CARE" };
      });

      const error = await registerCampaign(BUSINESS_ID).catch(
        (caught) => caught
      );

      expect(error).toBeInstanceOf(CarrierRejectionSupportRequiredError);
      expect(error).toMatchObject({
        code: "rejection_support_required",
        carrierReason: exactReason,
        rejectedResource: _label,
      });
      expect(mocks.getCost).toHaveBeenCalledTimes(1);
      expect(mocks.qualify).toHaveBeenCalledTimes(1);
      expect(mocks.submit).not.toHaveBeenCalled();
      expect(operationTrace).not.toContain("submit");
    },
  );

  it("fails before every campaign fee/preflight operation when the active SMS number is missing", async () => {
    mocks.getActiveSmsNumber.mockResolvedValue(null);

    await expect(registerCampaign(BUSINESS_ID)).rejects.toMatchObject({
      code: "campaign_sms_number_missing",
      kind: "transient",
    });

    expect(mocks.buildSmsComplianceCopy).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(mocks.getCost).not.toHaveBeenCalled();
    expect(mocks.qualify).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.appendRegistrationEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "campaign_submitted",
        status: "error",
        rawPayload: expect.not.objectContaining({ _submitted: expect.anything() }),
      })
    );
  });

  it("rejects an over-limit message flow before rewriting copy, running preflight, or submitting", async () => {
    mocks.buildSmsComplianceCopy.mockReturnValueOnce({
      ...complianceCopy,
      messageFlow: "x".repeat(2_049),
    });

    await expect(registerCampaign(BUSINESS_ID)).rejects.toMatchObject({
      code: "campaign_message_flow_too_long",
      kind: "permanent",
    });

    expect(updates).toEqual([]);
    expect(mocks.getCost).not.toHaveBeenCalled();
    expect(mocks.qualify).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.appendRegistrationEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "campaign_submitted",
        status: "error",
        rawPayload: expect.not.objectContaining({ _submitted: expect.anything() }),
      })
    );
  });

  it("audits the exact real number, message flow, and quoted scripts used for submit", async () => {
    await registerCampaign(BUSINESS_ID);

    expect(mocks.buildSmsComplianceCopy).toHaveBeenCalledWith(
      expect.objectContaining({
        smsPhoneNumber: "+15551234567",
        smsEntryPoint: "https://app.simplassist.com/c/simplassist",
        language: "en",
      })
    );
    expect(
      selectedBusinessColumns.some((columns) =>
        columns.includes("ai_settings(language)")
      )
    ).toBe(true);
    expect(mocks.appendRegistrationEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "campaign_submitted",
        resourceId: NEW_CAMPAIGN_ID,
        status: "pending",
        rawPayload: expect.objectContaining({
          _submitted: {
            privacyPolicyLink:
              "https://app.simplassist.com/c/simplassist/privacy",
            termsAndConditionsLink:
              "https://app.simplassist.com/c/simplassist/terms",
            messageFlow: complianceCopy.messageFlow,
            messageFlowCharacterCount: complianceCopy.messageFlow.length,
            smsPhoneNumber: "+15551234567",
            smsEntryPoint: "https://app.simplassist.com/c/simplassist",
            confirmationSms: complianceCopy.confirmationSms,
            voicemailGreeting: complianceCopy.voicemailGreeting,
            optinMessage: complianceCopy.optinMessage,
            optoutMessage: complianceCopy.optoutMessage,
            helpMessage: complianceCopy.helpMessage,
          },
        }),
      })
    );
  });

  it("recovers an ambiguously successful charged submit by referenceId without charging again", async () => {
    mocks.submit.mockRejectedValueOnce(
      new Error("connection closed after Telnyx accepted the campaign")
    );

    await expect(registerCampaign(BUSINESS_ID)).rejects.toThrow(
      "connection closed"
    );
    expect(mocks.submit).toHaveBeenCalledTimes(1);

    setCampaigns([campaignItem()]);
    await expect(registerCampaign(BUSINESS_ID)).resolves.toBeUndefined();

    expect(mocks.submit).toHaveBeenCalledTimes(1);
    expect(mocks.getCost).toHaveBeenCalledTimes(1);
    expect(mocks.qualify).toHaveBeenCalledTimes(1);
    expect(updates).toContainEqual(
      expect.objectContaining({ telnyx_campaign_id: CAMPAIGN_ID })
    );
  });

  it("recovers exactly one pending campaign and skips all create preflight", async () => {
    setCampaigns([campaignItem()]);

    await registerCampaign(BUSINESS_ID);

    expect(updates).toContainEqual({
      telnyx_campaign_id: CAMPAIGN_ID,
      campaign_status: "pending",
      campaign_status_updated_at: expect.any(String),
      campaign_rejection_reason: null,
    });
    expect(mocks.getCost).not.toHaveBeenCalled();
    expect(mocks.qualify).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.appendRegistrationEvent).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      eventType: "campaign_submitted",
      resourceType: "campaign",
      resourceId: CAMPAIGN_ID,
      status: "pending",
      rejectionReason: null,
      rawPayload: {
        _recovery: {
          source: "telnyx_campaign_list",
          referenceIdMatched: true,
        },
      },
    });
  });

  it("maps a recovered MNO-approved campaign to approved", async () => {
    setCampaigns([campaignItem({ campaignStatus: "MNO_PROVISIONED" })]);

    await registerCampaign(BUSINESS_ID);

    expect(updates).toContainEqual(
      expect.objectContaining({
        telnyx_campaign_id: CAMPAIGN_ID,
        campaign_status: "approved",
        campaign_rejection_reason: null,
      })
    );
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("persists a recovered rejection and its reason, audits it, then stops safely", async () => {
    const providerReason = "private upstream rejection detail";
    setCampaigns([
      campaignItem({
        campaignStatus: "MNO_REJECTED",
        failureReasons: providerReason,
      }),
    ]);

    let caught: unknown;
    try {
      await registerCampaign(BUSINESS_ID);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CarrierRejectionSupportRequiredError);
    expect(caught).toMatchObject({
      code: "rejection_support_required",
      carrierReason: providerReason,
      rejectedResource: "campaign",
    });
    expect((caught as Error).message).not.toContain(providerReason);
    expect(updates).toContainEqual(
      expect.objectContaining({
        telnyx_campaign_id: CAMPAIGN_ID,
        campaign_status: "rejected",
        campaign_rejection_reason: providerReason,
      })
    );
    expect(mocks.appendRegistrationEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "campaign_submitted",
        resourceId: CAMPAIGN_ID,
        status: "rejected",
        rejectionReason: providerReason,
        rawPayload: expect.objectContaining({ _recovery: expect.any(Object) }),
      })
    );
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("does not re-adopt a rejected campaign that the retry flow already archived", async () => {
    archivedCampaignIds = [CAMPAIGN_ID];
    setCampaigns([
      campaignItem({
        campaignStatus: "MNO_REJECTED",
        failureReasons: "the old archived rejection",
      }),
    ]);

    await expect(registerCampaign(BUSINESS_ID)).resolves.toBeUndefined();

    expect(mocks.submit).toHaveBeenCalledTimes(1);
    expect(updates).not.toContainEqual(
      expect.objectContaining({ telnyx_campaign_id: CAMPAIGN_ID })
    );
    expect(updates).toContainEqual(
      expect.objectContaining({ telnyx_campaign_id: NEW_CAMPAIGN_ID })
    );
  });

  it("uses a stable persisted rejection reason when Telnyx omits one", async () => {
    setCampaigns([
      campaignItem({ campaignStatus: "TELNYX_FAILED", failureReasons: " " }),
    ]);

    await expect(registerCampaign(BUSINESS_ID)).rejects.toMatchObject({
      code: "rejection_support_required",
      carrierReason:
        "Telnyx reported that the recovered campaign was rejected.",
      rejectedResource: "campaign",
    });
    expect(updates).toContainEqual(
      expect.objectContaining({
        campaign_rejection_reason:
          "Telnyx reported that the recovered campaign was rejected.",
      })
    );
  });

  it("fails closed when more than one campaign matches the business reference", async () => {
    setCampaigns([
      campaignItem(),
      campaignItem({ campaignId: "CMN3FR2" }),
    ]);

    await expect(registerCampaign(BUSINESS_ID)).rejects.toMatchObject({
      code: "campaign_recovery_multiple_matches",
      kind: "permanent",
    });
    expect(updates).toEqual([]);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it.each([
    ["missing campaign ID", { campaignId: undefined }],
    ["malformed campaign ID", { campaignId: "bad id" }],
    ["wrong brand", { brandId: "different-brand" }],
    ["missing status", { campaignStatus: undefined }],
    ["unknown status", { campaignStatus: "FUTURE_STATUS" }],
  ])("fails closed for a matching campaign with %s", async (_label, patch) => {
    setCampaigns([campaignItem(patch as Record<string, unknown>)]);

    await expect(registerCampaign(BUSINESS_ID)).rejects.toMatchObject({
      code: "campaign_recovery_malformed_response",
      kind: "permanent",
    });
    expect(updates).toEqual([]);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it.each([
    ["null list row", null],
    ["numeric campaign ID", campaignItem({ campaignId: 123 })],
    ["numeric reference ID", campaignItem({ referenceId: 123 })],
    ["numeric brand ID", campaignItem({ brandId: 123 })],
    ["numeric failure reasons", campaignItem({ failureReasons: 123 })],
  ])("fails closed for runtime-malformed provider data: %s", async (_label, row) => {
    setCampaigns([row]);

    await expect(registerCampaign(BUSINESS_ID)).rejects.toMatchObject({
      code: "campaign_recovery_malformed_response",
      kind: "permanent",
    });
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("throws on a failed recovery save and relists successfully on retry", async () => {
    setCampaigns([campaignItem()]);
    persistenceResults = [
      { data: null, error: { message: "database unavailable" } },
      { data: { id: BUSINESS_ID }, error: null },
    ];

    await expect(registerCampaign(BUSINESS_ID)).rejects.toMatchObject({
      code: "campaign_recovery_persist_failed",
      kind: "transient",
    });
    expect(mocks.submit).not.toHaveBeenCalled();

    await expect(registerCampaign(BUSINESS_ID)).resolves.toBeUndefined();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.appendRegistrationEvent).toHaveBeenCalledTimes(1);
  });

  it("blocks a new campaign when five unrelated campaigns consume the cap", async () => {
    setCampaigns(Array.from({ length: 5 }, (_, index) => unrelatedCampaign(index)));

    await expect(registerCampaign(BUSINESS_ID)).rejects.toMatchObject({
      code: "telnyx_brand_campaign_cap_reached",
      kind: "permanent",
      message: CAP_MESSAGE,
    });
    expect(mocks.getCost).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("permits recovery of our match when the brand is already at the cap", async () => {
    setCampaigns([
      campaignItem(),
      ...Array.from({ length: 4 }, (_, index) => unrelatedCampaign(index)),
    ]);

    await expect(registerCampaign(BUSINESS_ID)).resolves.toBeUndefined();
    expect(updates).toContainEqual(
      expect.objectContaining({ telnyx_campaign_id: CAMPAIGN_ID })
    );
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("does not count an archived Telnyx record against replacement capacity", async () => {
    archivedCampaignIds = [CAMPAIGN_ID];
    setCampaigns([
      campaignItem({ campaignStatus: "MNO_REJECTED" }),
      ...Array.from({ length: 4 }, (_, index) => unrelatedCampaign(index)),
    ]);

    await expect(registerCampaign(BUSINESS_ID)).resolves.toBeUndefined();
    expect(mocks.submit).toHaveBeenCalledTimes(1);
  });

  it("fails before listing or creating when campaign history is unavailable", async () => {
    campaignHistoryError = { message: "private database detail" };

    let caught: unknown;
    try {
      await registerCampaign(BUSINESS_ID);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "campaign_recovery_history_unavailable",
      kind: "transient",
    });
    expect((caught as Error).message).not.toContain("private database detail");
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("fails closed on malformed archived campaign history", async () => {
    archivedCampaignIds = ["bad campaign id"];

    await expect(registerCampaign(BUSINESS_ID)).rejects.toMatchObject({
      code: "campaign_recovery_history_invalid",
      kind: "permanent",
    });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("fails closed when the campaign-history collection is unexpectedly null", async () => {
    campaignHistoryDataOverride = null;

    await expect(registerCampaign(BUSINESS_ID)).rejects.toMatchObject({
      code: "campaign_recovery_history_invalid",
      kind: "permanent",
    });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("does not persist a runtime-malformed fresh campaign ID", async () => {
    mocks.submit.mockResolvedValue({ campaignId: 123 });

    await expect(registerCampaign(BUSINESS_ID)).rejects.toMatchObject({
      code: "campaign_submit_malformed_response",
      kind: "permanent",
    });
    expect(updates).not.toContainEqual(
      expect.objectContaining({ telnyx_campaign_id: expect.anything() })
    );
  });

  it("normalizes a valid fresh campaign ID before persistence", async () => {
    mocks.submit.mockResolvedValue({ campaignId: `  ${NEW_CAMPAIGN_ID}  ` });

    await expect(registerCampaign(BUSINESS_ID)).resolves.toBeUndefined();
    expect(updates).toContainEqual(
      expect.objectContaining({ telnyx_campaign_id: NEW_CAMPAIGN_ID })
    );
  });

  it("classifies list failure as transient without exposing provider details", async () => {
    const providerDetail = "raw provider account data";
    mocks.list.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        throw new Error(providerDetail);
      },
    }));

    let caught: unknown;
    try {
      await registerCampaign(BUSINESS_ID);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "campaign_recovery_provider_unavailable",
      kind: "transient",
    });
    expect((caught as Error).message).not.toContain(providerDetail);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});
