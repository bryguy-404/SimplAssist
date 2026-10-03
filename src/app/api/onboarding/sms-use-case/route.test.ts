import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  adminFrom: vi.fn(),
  ensureUniqueSlug: vi.fn(),
  appendRegistrationEvent: vi.fn(),
  registrationHasStartedForRisk: vi.fn(),
  screenA2pRiskForBusiness: vi.fn(),
  requireWorkspaceRouteAccess: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: mocks.createClient,
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mocks.adminFrom },
}));
vi.mock("@/lib/util/slug.server", () => ({
  ensureUniqueSlug: mocks.ensureUniqueSlug,
}));
vi.mock("@/lib/messaging/registration/audit", () => ({
  appendRegistrationEvent: mocks.appendRegistrationEvent,
  serializeError: (error: unknown) => String(error),
}));
vi.mock("@/lib/messaging/registration/riskScreening", () => ({
  registrationHasStartedForRisk: mocks.registrationHasStartedForRisk,
  screenA2pRiskForBusiness: mocks.screenA2pRiskForBusiness,
}));
vi.mock("@/lib/customer/workspaceRouteResponse.server", () => ({
  requireWorkspaceRouteAccess: mocks.requireWorkspaceRouteAccess,
}));

import { POST } from "./route";
import { REJECTION_SUPPORT_MESSAGE } from "@/lib/onboarding/rejectionGuidance";

const USER_ID = "00000000-0000-4000-8000-000000000010";
const BUSINESS_ID = "00000000-0000-4000-8000-000000000020";

type QueryResult = {
  data: unknown;
  error: unknown;
};

type QueryChain = Record<"select" | "update" | "eq" | "is" | "maybeSingle", ReturnType<typeof vi.fn>>;

const adminChains: QueryChain[] = [];
let updateResults: QueryResult[] = [];
let readResults: QueryResult[] = [];

function makeAdminChain(): QueryChain {
  let operation: "select" | "update" | null = null;
  const chain = {} as QueryChain;
  chain.select = vi.fn(() => {
    if (operation === null) operation = "select";
    return chain;
  });
  chain.update = vi.fn(() => {
    operation = "update";
    return chain;
  });
  chain.eq = vi.fn(() => chain);
  chain.is = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => {
    if (operation === "update") {
      return updateResults.shift() ?? {
        data: { id: BUSINESS_ID },
        error: null,
      };
    }
    return readResults.shift() ?? { data: null, error: null };
  });
  adminChains.push(chain);
  return chain;
}

function business(overrides: Record<string, unknown> = {}) {
  return {
    id: BUSINESS_ID,
    compliance_info_completed_at: "2026-07-01T00:00:00.000Z",
    slug: "example-service",
    privacy_terms_mode: "hosted",
    privacy_url_override: null,
    terms_url_override: null,
    website_url: "https://example.test",
    legal_business_name: "Example Service LLC",
    business_entity_type: "llc",
    business_registration_state: "IN",
    has_ein: true,
    ein: "12-3456789",
    authorized_rep_name: "Taylor Example",
    authorized_rep_title: "Owner",
    authorized_rep_email: "taylor@example.test",
    authorized_rep_phone: "+13175550100",
    telnyx_brand_id: "brand-1",
    brand_status: null,
    campaign_status: null,
    onboarding_registration_status: "failed",
    ...overrides,
  };
}

function userClient(businessRow: Record<string, unknown>) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.single = vi.fn().mockResolvedValue({ data: businessRow, error: null });
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: USER_ID } },
      }),
    },
    from: vi.fn(() => chain),
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/onboarding/sms-use-case", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      businessId: BUSINESS_ID,
      use_case_description:
        "We respond to existing customer questions about requested services.",
      estimated_monthly_volume: "under_1k",
      sample_messages: [
        "Example Service LLC: We received your service question. Reply STOP to unsubscribe.",
        "Example Service LLC: What day works best for a quick call?",
        "Example Service LLC: Thanks, our team will follow up shortly.",
      ],
      opt_in_description:
        "Customers opt in by contacting the business for help through its website or phone number.",
      a2p_risk_checklist_answer: "none",
      a2p_risk_checklist_selections: [],
      ...overrides,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test");
  adminChains.length = 0;
  updateResults = [];
  readResults = [];
  mocks.requireWorkspaceRouteAccess.mockResolvedValue({ ok: true, access: {} });
  mocks.createClient.mockResolvedValue(userClient(business()));
  mocks.adminFrom.mockImplementation(makeAdminChain);
  mocks.registrationHasStartedForRisk.mockReturnValue(false);
  mocks.screenA2pRiskForBusiness.mockResolvedValue({
    registrationStarted: false,
    status: "passed",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/onboarding/sms-use-case rejection lock", () => {
  it.each([
    ["campaign-only", { brand_status: "approved", campaign_status: "rejected" }],
    ["brand-only", { brand_status: "rejected", campaign_status: null }],
    ["dual", { brand_status: "rejected", campaign_status: "rejected" }],
  ])(
    "locks a stale %s form before risk checks, audit events, or writes",
    async (_label, statuses) => {
      const client = userClient(business(statuses));
      mocks.createClient.mockResolvedValue(client);

      const response = await POST(request());

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: REJECTION_SUPPORT_MESSAGE,
        code: "rejection_support_required",
      });
      expect(mocks.registrationHasStartedForRisk).not.toHaveBeenCalled();
      expect(mocks.ensureUniqueSlug).not.toHaveBeenCalled();
      expect(mocks.screenA2pRiskForBusiness).not.toHaveBeenCalled();
      expect(mocks.appendRegistrationEvent).not.toHaveBeenCalled();
      expect(mocks.adminFrom).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "held risk draft",
      { compliance_info_completed_at: "2026-07-01T00:00:00.000Z" },
      { registrationStarted: false, status: "pending_review" },
      false,
    ],
    [
      "first submission",
      { compliance_info_completed_at: null },
      { registrationStarted: false, status: "passed" },
      true,
    ],
    [
      "existing submission",
      { compliance_info_completed_at: "2026-07-01T00:00:00.000Z" },
      { registrationStarted: false, status: "passed" },
      true,
    ],
  ] as const)(
    "keeps technical failures editable on the %s write path",
    async (_label, overrides, riskResult, expectedSuccess) => {
      mocks.createClient.mockResolvedValue(userClient(business(overrides)));
      mocks.screenA2pRiskForBusiness.mockResolvedValue(riskResult);

      const response = await POST(request());

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        success: expectedSuccess,
      });
      expect(adminChains).toHaveLength(1);
      expect(adminChains[0].eq).toHaveBeenCalledWith("id", BUSINESS_ID);
      expect(adminChains[0].eq).toHaveBeenCalledWith("owner_id", USER_ID);
      expect(adminChains[0].eq).toHaveBeenCalledWith(
        "telnyx_brand_id",
        "brand-1",
      );
      expect(adminChains[0].eq).toHaveBeenCalledWith(
        "onboarding_registration_status",
        "failed",
      );
      expect(adminChains[0].is).toHaveBeenCalledWith("deleted_at", null);
      expect(adminChains[0].is).toHaveBeenCalledWith("brand_status", null);
      expect(adminChains[0].is).toHaveBeenCalledWith("campaign_status", null);
      expect(adminChains[0].select).toHaveBeenCalledWith("id");
    },
  );

  it.each([
    [
      "held risk draft",
      { compliance_info_completed_at: "2026-07-01T00:00:00.000Z" },
      { registrationStarted: false, status: "pending_review" },
    ],
    [
      "first submission",
      { compliance_info_completed_at: null },
      { registrationStarted: false, status: "passed" },
    ],
    [
      "existing submission",
      { compliance_info_completed_at: "2026-07-01T00:00:00.000Z" },
      { registrationStarted: false, status: "passed" },
    ],
  ] as const)(
    "maps a rejection between read and the %s write to support-only",
    async (_label, overrides, riskResult) => {
      mocks.createClient.mockResolvedValue(userClient(business(overrides)));
      mocks.screenA2pRiskForBusiness.mockResolvedValue(riskResult);
      updateResults = [{ data: null, error: null }];
      readResults = [
        {
          data: business({
            brand_status: "approved",
            campaign_status: "rejected",
            onboarding_registration_status: "failed",
          }),
          error: null,
        },
      ];

      const response = await POST(request());

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: REJECTION_SUPPORT_MESSAGE,
        code: "rejection_support_required",
      });
      expect(adminChains).toHaveLength(2);
      expect(adminChains[0].eq).toHaveBeenCalledWith("id", BUSINESS_ID);
      expect(adminChains[0].eq).toHaveBeenCalledWith("owner_id", USER_ID);
      expect(adminChains[0].eq).toHaveBeenCalledWith(
        "telnyx_brand_id",
        "brand-1",
      );
      expect(adminChains[0].eq).toHaveBeenCalledWith(
        "onboarding_registration_status",
        "failed",
      );
      expect(adminChains[0].is).toHaveBeenCalledWith("deleted_at", null);
      expect(adminChains[0].is).toHaveBeenCalledWith("brand_status", null);
      expect(adminChains[0].is).toHaveBeenCalledWith("campaign_status", null);
      expect(adminChains[1].eq).toHaveBeenCalledWith("owner_id", USER_ID);
      expect(adminChains[1].is).toHaveBeenCalledWith("deleted_at", null);
    },
  );
});

describe("new review-text signup scope", () => {
  it("rejects opting in while the review texting rollout is off", async () => {
    const response = await POST(request({ review_sms_signup_enabled: true }));
    expect(response.status).toBe(409);
    expect(mocks.screenA2pRiskForBusiness).not.toHaveBeenCalled();
    expect(adminChains).toHaveLength(0);
  });

  it("saves the explicit owner choice when the rollout permits the business", async () => {
    vi.stubEnv("REVIEWS_SMS_ENABLED", "1");
    vi.stubEnv("REVIEWS_SMS_PILOT_BUSINESS_IDS", "*");
    const response = await POST(request({ review_sms_signup_enabled: true }));
    expect(response.status).toBe(200);
    expect(adminChains.some((chain) => chain.update.mock.calls.some(([value]) => value.review_sms_signup_enabled === true))).toBe(true);
  });

  it.each([{ telnyx_campaign_id: "existing-campaign" }, { onboarding_completed_at: "2026-01-01T00:00:00Z" }])(
    "does not migrate an existing account through signup: %j", async (state) => {
      vi.stubEnv("REVIEWS_SMS_ENABLED", "1");
      vi.stubEnv("REVIEWS_SMS_PILOT_BUSINESS_IDS", "*");
      mocks.createClient.mockResolvedValue(userClient(business(state)));
      expect((await POST(request({ review_sms_signup_enabled: true }))).status).toBe(409);
      expect(mocks.screenA2pRiskForBusiness).not.toHaveBeenCalled();
    },
  );
});
