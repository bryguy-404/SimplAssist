import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminAccountHealth } from "@/lib/admin/accountHealth";

const mocks = vi.hoisted(() => ({
  requireAdminUser: vi.fn(),
  from: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  routerRefresh: vi.fn(),
  getPreview: vi.fn(),
  buildRisk: vi.fn(),
  hashRisk: vi.fn(),
  getExistingBrand: vi.fn(),
  loadHealth: vi.fn(),
  loadActivity: vi.fn(),
  results: new Map<
    string,
    { data: unknown; error: { message: string } | null }
  >(),
}));

vi.mock("@/lib/admin/auth", () => ({
  requireAdminUser: mocks.requireAdminUser,
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mocks.from },
}));
vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  useRouter: () => ({ refresh: mocks.routerRefresh }),
}));
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/account/deletion.server", () => ({
  getAdminAccountDeletionPreview: mocks.getPreview,
}));
vi.mock("@/lib/admin/accountHealth.server", () => ({
  loadAdminAccountHealth: mocks.loadHealth,
}));
vi.mock("@/lib/admin/accountActivity.server", () => ({
  loadAdminAccountActivity: mocks.loadActivity,
}));
vi.mock("@/lib/messaging/registration/riskScreening", () => ({
  buildA2pRiskInputForBusiness: mocks.buildRisk,
  hashA2pRiskInput: mocks.hashRisk,
}));
vi.mock("@/lib/messaging/registration/existingBrand", () => ({
  getExistingTelnyxBrandLinkState: mocks.getExistingBrand,
}));
vi.mock("../AdminFlagForm", () => ({
  AdminFlagForm: () => <div>ADMIN_FLAG_FORM</div>,
}));
vi.mock("../BusinessPartnerBillingForm", () => ({
  BusinessPartnerBillingForm: () => <div>PARTNER_BILLING_FORM</div>,
}));
vi.mock("../A2pApproveForm", () => ({
  A2pApproveForm: () => <div>A2P_APPROVE_FORM</div>,
}));
vi.mock("../ExistingTelnyxBrandForm", () => ({
  ExistingTelnyxBrandForm: () => <div>EXISTING_TELNYX_FORM</div>,
}));
vi.mock("./AdminAccountServiceControls", () => ({
  AdminAccountServiceControls: ({
    billingMode,
    initialControls,
  }: {
    billingMode: string;
    initialControls: { operationsSuspendedAt: string | null };
  }) => (
    <div
      data-billing-mode={billingMode}
      data-operations-state={
        initialControls.operationsSuspendedAt ? "suspended" : "active"
      }
    >
      ADMIN_SERVICE_CONTROLS
    </div>
  ),
}));
vi.mock("./AdminSmsComplianceCard", () => ({
  AdminSmsComplianceCard: ({
    hasEin,
    healthActivePhoneCount,
    phoneSnapshot,
    paidTextingUpgradePending,
  }: {
    hasEin: boolean;
    healthActivePhoneCount: number;
    phoneSnapshot: {
      directActiveCount: number;
      campaignMatch: string;
      assignmentStatus: string | null;
    } | null;
    paidTextingUpgradePending: boolean;
  }) => (
    <div
      data-has-ein={String(hasEin)}
      data-health-active-count={String(healthActivePhoneCount)}
      data-direct-active-count={
        phoneSnapshot ? String(phoneSnapshot.directActiveCount) : "unavailable"
      }
      data-assignment-status={
        phoneSnapshot?.assignmentStatus ?? "unavailable"
      }
      data-campaign-match={phoneSnapshot?.campaignMatch ?? "unavailable"}
      data-paid-upgrade-pending={String(paidTextingUpgradePending)}
    >
      SMS_COMPLIANCE_CARD
    </div>
  ),
}));

import AdminBusinessPage from "./page";

const BUSINESS_ID = "10000000-0000-4000-a045-000000000001";
const OWNER_ID = "00000000-0000-4000-a045-000000000001";

function storedBusiness(overrides: Record<string, unknown> = {}) {
  return {
    id: BUSINESS_ID,
    owner_id: OWNER_ID,
    deleted_at: null,
    deletion_scheduled_for: null,
    partner_id: null,
    billing_mode: "stripe",
    partner_plan: null,
    name: "Lifecycle Dental",
    business_type: "dentist",
    business_type_other: null,
    website_url: "https://lifecycle.example",
    use_case_description: "Appointment reminders",
    sample_messages: ["Your appointment is tomorrow"],
    opt_in_description: "Web form",
    a2p_risk_review_status: "pending_review",
    a2p_risk_review_input_hash: "risk-hash",
    a2p_risk_review_message: null,
    a2p_risk_review_reason: null,
    a2p_risk_review_findings: [],
    a2p_risk_review_customer_answer: null,
    a2p_risk_review_customer_selections: [],
    a2p_risk_review_reviewed_at: null,
    a2p_risk_review_override_note: null,
    onboarding_registration_status: "pending",
    brand_status: "pending",
    campaign_status: "pending",
    has_ein: true,
    ein: "12-3456789",
    telnyx_campaign_id: "campaign-current",
    pending_phone_number: "+13175550049",
    billing_pilot: false,
    billing_comped: false,
    billing_exempt: false,
    telnyx_submission_disabled: false,
    sms_overage_opt_in: false,
    billing_admin_notes: null,
    ...overrides,
  };
}

function preview(overrides: Record<string, unknown> = {}) {
  return {
    businessId: BUSINESS_ID,
    businessName: "Lifecycle Dental",
    billingMode: "stripe",
    partnerId: null,
    partnerSlug: null,
    lifecycleStage: "onboarding",
    deletionScheduledFor: null,
    subscriptionStatus: null,
    campaignStatus: "pending",
    assignedPhoneCount: 0,
    hasPendingPhoneNumber: false,
    provisioningJobCount: 0,
    provisioningOperationState: "idle",
    requiresLiveAcknowledgement: true,
    ...overrides,
  };
}

function storedHealth(
  overrides: Partial<AdminAccountHealth> = {},
): AdminAccountHealth {
  return {
    businessId: BUSINESS_ID,
    operations: {
      state: "active",
      suspendedAt: null,
      services: {
        aiReplies: { state: "active", pausedAt: null },
        texting: { state: "active", pausedAt: null },
        bookings: { state: "active", pausedAt: null },
      },
    },
    lifecycle: {
      state: "live",
      onboardingCompleted: true,
      onboardingStep: "complete",
      onboardingStepLabel: "Complete",
      deletionScheduledFor: null,
    },
    billing: {
      mode: "stripe",
      subscriptionPresent: true,
      plan: "sms_and_chat",
      status: "active",
      source: "subscription",
      state: "active",
      pastDue: false,
      cancelAtPeriodEnd: false,
    },
    phone: {
      state: "ready",
      activeCount: 1,
      smsReady: true,
      blockReason: null,
      assignmentStatus: "assigned",
    },
    registration: {
      state: "approved",
      onboardingStatus: "submitted",
      riskReviewStatus: "passed",
      brandStatus: "approved",
      campaignStatus: "approved",
    },
    calendar: { connected: true },
    ai: {
      state: "active",
      configured: true,
      sms: "operational",
      webChat: "operational",
      operationalChannels: ["sms", "web_chat"],
      planLimitedChannels: [],
    },
    booking: { mode: "schedule_direct", state: "operational" },
    failedSetup: { failed: false, reasons: [] },
    lastActivityAt: "2026-08-04T11:45:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdminUser.mockResolvedValue({ id: "admin-1", email: null });
  mocks.results = new Map([
    ["businesses", { data: storedBusiness(), error: null }],
    ["billing_usage_periods", { data: null, error: null }],
    ["partners", { data: [], error: null }],
    ["chat_texting_upgrades", { data: null, error: null }],
    [
      "phone_numbers",
      {
        data: [
          {
            telnyx_campaign_assignment_status: "assigned",
            telnyx_campaign_assignment_campaign_id: "campaign-current",
            telnyx_campaign_assignment_updated_at:
              "2026-08-04T12:00:00.000Z",
            phone_number: "+13175550149",
            telnyx_campaign_assignment_failure_reason:
              "PRIVATE PROVIDER FAILURE",
          },
        ],
        error: null,
      },
    ],
  ]);
  mocks.getPreview.mockResolvedValue(preview());
  mocks.loadHealth.mockResolvedValue(storedHealth());
  mocks.loadActivity.mockResolvedValue([]);
  mocks.buildRisk.mockResolvedValue({ input: { businessName: "Lifecycle" } });
  mocks.hashRisk.mockReturnValue("risk-hash");
  mocks.getExistingBrand.mockResolvedValue(null);
  mocks.from.mockImplementation((table: string) => {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      in: vi.fn(),
      order: vi.fn(),
      limit: vi.fn(),
      maybeSingle: vi.fn(),
      returns: vi.fn(),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.in.mockReturnValue(query);
    query.order.mockReturnValue(query);
    query.limit.mockReturnValue(query);
    query.maybeSingle.mockImplementation(async () => mocks.results.get(table));
    query.returns.mockImplementation(async () => mocks.results.get(table));
    return query;
  });
});

describe("AdminBusinessPage account lifecycle rendering", () => {
  it.each(["support_required", "carrier_pending"])(
    "provides a paid-upgrade recovery hint for %s",
    async (state) => {
      mocks.results.set("chat_texting_upgrades", {
        data: { state, paid_at: "2026-08-04T12:00:00Z", activated_at: null, owner_id: OWNER_ID },
        error: null,
      });
      const html = renderToStaticMarkup(
        await AdminBusinessPage({ params: { businessId: BUSINESS_ID } }),
      );
      expect(html).toContain('data-paid-upgrade-pending="true"');
    },
  );

  it.each([
    { paid_at: null },
    { activated_at: "2026-08-04T12:05:00Z" },
    { state: "draft" },
    { owner_id: "another-owner" },
  ])("withholds paid-upgrade recovery for an invalid ledger hint: %j", async (overrides) => {
    mocks.results.set("chat_texting_upgrades", {
      data: { state: "support_required", paid_at: "2026-08-04T12:00:00Z", activated_at: null, owner_id: OWNER_ID, ...overrides },
      error: null,
    });
    const html = renderToStaticMarkup(
      await AdminBusinessPage({ params: { businessId: BUSINESS_ID } }),
    );
    expect(html).toContain('data-paid-upgrade-pending="false"');
  });

  it("withholds paid-upgrade recovery when the ledger read fails", async () => {
    mocks.results.set("chat_texting_upgrades", { data: null, error: { message: "unavailable" } });
    const html = renderToStaticMarkup(
      await AdminBusinessPage({ params: { businessId: BUSINESS_ID } }),
    );
    expect(html).toContain('data-paid-upgrade-pending="false"');
  });

  it("renders a compact arrow Back control to the admin account list", async () => {
    const html = renderToStaticMarkup(
      await AdminBusinessPage({ params: { businessId: BUSINESS_ID } }),
    );
    const backLink = html.match(/<a href="\/admin"[^>]*>[\s\S]*?<\/a>/)?.[0];

    expect(backLink).toBeDefined();
    expect(backLink).toContain('aria-label="Back to admin"');
    expect(backLink).toContain("lucide-arrow-left");
    expect(backLink).toContain("rounded-full");
    expect(backLink).toContain("px-3");
    expect(backLink).toContain("py-1.5");
    expect(backLink).toContain("Back</a>");
    expect(backLink).not.toContain("Back to admin</a>");
  });

  it("completes admin authentication before starting any service-role read", async () => {
    mocks.requireAdminUser.mockRejectedValue(new Error("NOT_FOUND"));

    await expect(
      AdminBusinessPage({ params: { businessId: BUSINESS_ID } }),
    ).rejects.toThrow("NOT_FOUND");

    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.loadActivity).not.toHaveBeenCalled();
    expect(mocks.loadHealth).not.toHaveBeenCalled();
    expect(mocks.getPreview).not.toHaveBeenCalled();
  });

  it("loads an active preview and renders the operational forms plus Danger Zone", async () => {
    const html = renderToStaticMarkup(
      await AdminBusinessPage({ params: { businessId: BUSINESS_ID } }),
    );

    expect(mocks.requireAdminUser).toHaveBeenCalledOnce();
    expect(mocks.requireAdminUser.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.from.mock.invocationCallOrder[0],
    );
    expect(mocks.requireAdminUser.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.loadHealth.mock.invocationCallOrder[0],
    );
    expect(mocks.requireAdminUser.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.loadActivity.mock.invocationCallOrder[0],
    );
    const businessQuery = mocks.from.mock.results[0]?.value;
    expect(businessQuery.select).toHaveBeenCalledWith(
      expect.stringContaining("owner_id, deleted_at, deletion_scheduled_for"),
    );
    const businessSelect = businessQuery.select.mock.calls[0]?.[0] as string;
    expect(businessSelect).toContain("has_ein");
    expect(businessSelect).toContain("telnyx_campaign_id");
    expect(businessSelect).not.toMatch(/(?:^|,\s*)ein(?:\s*,|$)/);
    expect(businessSelect).not.toContain("pending_phone_number");
    const phoneQueryIndex = mocks.from.mock.calls.findIndex(
      ([table]) => table === "phone_numbers",
    );
    const phoneQuery = mocks.from.mock.results[phoneQueryIndex]?.value;
    expect(phoneQuery.select).toHaveBeenCalledWith(
      "telnyx_campaign_assignment_status, telnyx_campaign_assignment_campaign_id, telnyx_campaign_assignment_updated_at",
    );
    expect(phoneQuery.select.mock.calls[0]?.[0]).not.toContain("phone_number");
    expect(phoneQuery.select.mock.calls[0]?.[0]).not.toContain(
      "failure_reason",
    );
    expect(phoneQuery.eq).toHaveBeenCalledWith("business_id", BUSINESS_ID);
    expect(phoneQuery.eq).toHaveBeenCalledWith("is_active", true);
    expect(phoneQuery.eq).toHaveBeenCalledWith("resource_status", "active");
    expect(mocks.getPreview).toHaveBeenCalledWith(BUSINESS_ID);
    expect(mocks.loadHealth).toHaveBeenCalledOnce();
    expect(mocks.loadHealth).toHaveBeenCalledWith(BUSINESS_ID);
    expect(mocks.loadActivity).toHaveBeenCalledWith(BUSINESS_ID);
    expect(mocks.loadHealth.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getPreview.mock.invocationCallOrder[0],
    );
    expect(mocks.buildRisk).toHaveBeenCalledWith(BUSINESS_ID);
    expect(mocks.getExistingBrand).toHaveBeenCalledWith(BUSINESS_ID);
    expect(html).toContain("Danger Zone");
    expect(html).toContain("Schedule account deletion");
    expect(html).toContain("ADMIN_FLAG_FORM");
    expect(html).toContain("PARTNER_BILLING_FORM");
    expect(html).toContain("A2P_APPROVE_FORM");
    expect(html).toContain("EXISTING_TELNYX_FORM");
    expect(html).toContain("SMS_COMPLIANCE_CARD");
    expect(html).toContain('data-has-ein="true"');
    expect(html).toContain('data-health-active-count="1"');
    expect(html).toContain('data-direct-active-count="1"');
    expect(html).toContain('data-assignment-status="assigned"');
    expect(html).toContain('data-campaign-match="yes"');
    expect(html).not.toContain("campaign-current");
    expect(html).not.toContain("12-3456789");
    expect(html).not.toContain("+13175550049");
    expect(html).not.toContain("+13175550149");
    expect(html).not.toContain("PRIVATE PROVIDER FAILURE");
    expect(html).toContain("Account health");
    expect(html).toContain("ADMIN_SERVICE_CONTROLS");
    expect(html).toContain('data-billing-mode="stripe"');
    expect(html).toContain('data-operations-state="active"');
    expect(html).toContain("Account activity");
    expect(html).toContain("Recorded activity only.");
    expect(html).toContain("Lifecycle");
    expect(html).toContain("Onboarding");
    expect(html.indexOf("Account health")).toBeLessThan(
      html.indexOf("ADMIN_SERVICE_CONTROLS"),
    );
    expect(html.indexOf("ADMIN_SERVICE_CONTROLS")).toBeLessThan(
      html.indexOf("Account activity"),
    );
    expect(html).toContain("Pre-submission risk screen");
    expect(html).not.toContain("A2P Review");
    expect(html).not.toContain(">Registration</h2>");
    expect(html).toMatch(
      /<details(?![^>]*open="")[^>]*><summary[^>]*>Carrier-safe submitted copy<\/summary>/,
    );
    expect(html).toMatch(
      /<details(?![^>]*open="")[^>]*><summary[^>]*>Risk findings<\/summary>/,
    );
    expect(html).toMatch(
      /<details(?![^>]*open="")[^>]*><summary[^>]*>Existing Telnyx brand recovery<\/summary>/,
    );
  });

  it("keeps an existing-brand recovery closed unless durable recovery state exists", async () => {
    mocks.getExistingBrand.mockResolvedValue({
      status: "pending_admin",
      tcrBrandId: "PUBLIC-TCR-ID",
      inspectedAt: "2026-08-04T12:00:00.000Z",
      approvedAt: null,
      consumedAt: null,
      lastErrorCode: null,
    });

    const html = renderToStaticMarkup(
      await AdminBusinessPage({ params: { businessId: BUSINESS_ID } }),
    );

    expect(html).toMatch(
      /<details[^>]*open=""[^>]*><summary[^>]*>Existing Telnyx brand recovery<\/summary>/,
    );
    expect(html).not.toContain("PUBLIC-TCR-ID");
  });

  it("fails the SMS card phone snapshot closed when the minimal query errors", async () => {
    mocks.results.set("phone_numbers", {
      data: [
        {
          telnyx_campaign_assignment_status: "failed",
          telnyx_campaign_assignment_campaign_id: "PRIVATE-CAMPAIGN-ID",
          telnyx_campaign_assignment_updated_at: null,
        },
      ],
      error: { message: "phone lookup failed" },
    });

    const html = renderToStaticMarkup(
      await AdminBusinessPage({ params: { businessId: BUSINESS_ID } }),
    );

    expect(html).toContain("SMS_COMPLIANCE_CARD");
    expect(html).toContain('data-direct-active-count="unavailable"');
    expect(html).toContain('data-assignment-status="unavailable"');
    expect(html).toContain('data-campaign-match="unavailable"');
    expect(html).not.toContain("PRIVATE-CAMPAIGN-ID");
  });

  it("passes only a derived mismatch and direct count when active phone rows disagree", async () => {
    mocks.results.set("businesses", {
      data: storedBusiness({
        has_ein: false,
        telnyx_campaign_id: "CURRENT-CAMPAIGN-ID",
      }),
      error: null,
    });
    mocks.results.set("phone_numbers", {
      data: [
        {
          telnyx_campaign_assignment_status: "failed",
          telnyx_campaign_assignment_campaign_id: "OLD-CAMPAIGN-ID",
          telnyx_campaign_assignment_updated_at: null,
        },
        {
          telnyx_campaign_assignment_status: "pending",
          telnyx_campaign_assignment_campaign_id: "CURRENT-CAMPAIGN-ID",
          telnyx_campaign_assignment_updated_at: null,
        },
      ],
      error: null,
    });

    const html = renderToStaticMarkup(
      await AdminBusinessPage({ params: { businessId: BUSINESS_ID } }),
    );

    expect(html).toContain('data-has-ein="false"');
    expect(html).toContain('data-health-active-count="1"');
    expect(html).toContain('data-direct-active-count="2"');
    expect(html).toContain('data-assignment-status="unavailable"');
    expect(html).toContain('data-campaign-match="unavailable"');
    expect(html).not.toContain("CURRENT-CAMPAIGN-ID");
    expect(html).not.toContain("OLD-CAMPAIGN-ID");
  });

  it("derives a one-row campaign mismatch on the server without passing either ID", async () => {
    mocks.results.set("businesses", {
      data: storedBusiness({ telnyx_campaign_id: "CURRENT-CAMPAIGN-ID" }),
      error: null,
    });
    mocks.results.set("phone_numbers", {
      data: [
        {
          telnyx_campaign_assignment_status: "assigned",
          telnyx_campaign_assignment_campaign_id: "OLD-CAMPAIGN-ID",
          telnyx_campaign_assignment_updated_at:
            "2026-08-04T12:00:00.000Z",
        },
      ],
      error: null,
    });

    const html = renderToStaticMarkup(
      await AdminBusinessPage({ params: { businessId: BUSINESS_ID } }),
    );

    expect(html).toContain('data-direct-active-count="1"');
    expect(html).toContain('data-assignment-status="assigned"');
    expect(html).toContain('data-campaign-match="no"');
    expect(html).not.toContain("CURRENT-CAMPAIGN-ID");
    expect(html).not.toContain("OLD-CAMPAIGN-ID");
    expect(html).not.toContain("12-3456789");
  });

  it("renders a scheduled account read-only without operational queries or mutation forms", async () => {
    mocks.results.set("businesses", {
      data: storedBusiness({
        deleted_at: "2026-08-04T12:00:00.000Z",
        deletion_scheduled_for: "2026-10-03T12:00:00.000Z",
      }),
      error: null,
    });
    mocks.getPreview.mockResolvedValue(
      preview({
        lifecycleStage: "suspended",
        deletionScheduledFor: "2026-10-03T12:00:00.000Z",
      }),
    );

    const html = renderToStaticMarkup(
      await AdminBusinessPage({ params: { businessId: BUSINESS_ID } }),
    );

    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.getPreview).toHaveBeenCalledWith(BUSINESS_ID);
    expect(mocks.loadHealth).toHaveBeenCalledWith(BUSINESS_ID);
    expect(mocks.loadActivity).toHaveBeenCalledWith(BUSINESS_ID);
    expect(mocks.buildRisk).not.toHaveBeenCalled();
    expect(mocks.getExistingBrand).not.toHaveBeenCalled();
    expect(html).toContain("Deletion scheduled");
    expect(html).toContain("Account health");
    expect(html).toContain("Account activity");
    expect(html).toContain("Pending deletion");
    expect(html).toContain(
      "customer may reactivate during the 60-day grace period",
    );
    expect(html).not.toContain("Schedule account deletion");
    expect(html).not.toContain("ADMIN_FLAG_FORM");
    expect(html).not.toContain("PARTNER_BILLING_FORM");
    expect(html).not.toContain("A2P_APPROVE_FORM");
    expect(html).not.toContain("EXISTING_TELNYX_FORM");
    expect(html).not.toContain("ADMIN_SERVICE_CONTROLS");
    expect(html).not.toContain("SMS_COMPLIANCE_CARD");
  });

  it("fails closed to the fresh suspended preview when the first row read was active", async () => {
    mocks.getPreview.mockResolvedValue(
      preview({
        lifecycleStage: "suspended",
        deletionScheduledFor: "2026-10-03T12:00:00.000Z",
      }),
    );

    const html = renderToStaticMarkup(
      await AdminBusinessPage({ params: { businessId: BUSINESS_ID } }),
    );

    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.loadHealth).toHaveBeenCalledWith(BUSINESS_ID);
    expect(mocks.loadActivity).toHaveBeenCalledWith(BUSINESS_ID);
    expect(html).toContain("Deletion scheduled");
    expect(html).toContain("Pending deletion");
    expect(html).toContain("Oct 3, 2026");
    expect(mocks.buildRisk).not.toHaveBeenCalled();
    expect(mocks.getExistingBrand).not.toHaveBeenCalled();
    expect(html).not.toContain("ADMIN_FLAG_FORM");
    expect(html).not.toContain("PARTNER_BILLING_FORM");
    expect(html).not.toContain("ADMIN_SERVICE_CONTROLS");
    expect(html).not.toContain("SMS_COMPLIANCE_CARD");
  });

  it("uses the fresh active preview when the first row read was scheduled", async () => {
    mocks.results.set("businesses", {
      data: storedBusiness({
        deleted_at: "2026-08-04T12:00:00.000Z",
        deletion_scheduled_for: "2026-10-03T12:00:00.000Z",
      }),
      error: null,
    });

    const html = renderToStaticMarkup(
      await AdminBusinessPage({ params: { businessId: BUSINESS_ID } }),
    );

    expect(mocks.buildRisk).toHaveBeenCalledWith(BUSINESS_ID);
    expect(mocks.loadHealth).toHaveBeenCalledWith(BUSINESS_ID);
    expect(mocks.loadActivity).toHaveBeenCalledWith(BUSINESS_ID);
    expect(mocks.getExistingBrand).toHaveBeenCalledWith(BUSINESS_ID);
    expect(html).not.toContain("Deletion scheduled");
    expect(html).toContain("ADMIN_FLAG_FORM");
    expect(html).toContain("PARTNER_BILLING_FORM");
    expect(html).toContain("ADMIN_SERVICE_CONTROLS");
    expect(html).toContain("Account health");
    expect(html).toContain("Onboarding");
  });

  it("renders a terminal tombstone without preview, risk, provider, or mutation work", async () => {
    mocks.results.set("businesses", {
      data: storedBusiness({
        owner_id: null,
        deleted_at: "2026-05-01T12:00:00.000Z",
        deletion_scheduled_for: null,
        name: "[deleted]",
        website_url: null,
      }),
      error: null,
    });
    mocks.loadActivity.mockResolvedValue([
      {
        id: "lifecycle:deletion:scheduled",
        category: "lifecycle",
        facets: ["lifecycle", "admin"],
        registrationEventType: null,
        occurredAt: "2026-04-01T12:00:00.000Z",
        title: "Account deletion scheduled",
        detail: null,
        actor: null,
      },
    ]);

    const html = renderToStaticMarkup(
      await AdminBusinessPage({ params: { businessId: BUSINESS_ID } }),
    );

    expect(mocks.from).toHaveBeenCalledTimes(1);
    expect(mocks.getPreview).not.toHaveBeenCalled();
    expect(mocks.loadHealth).not.toHaveBeenCalled();
    expect(mocks.loadActivity).toHaveBeenCalledWith(BUSINESS_ID);
    expect(mocks.buildRisk).not.toHaveBeenCalled();
    expect(mocks.hashRisk).not.toHaveBeenCalled();
    expect(mocks.getExistingBrand).not.toHaveBeenCalled();
    expect(html).toContain("Terminally cleaned account");
    expect(html).toContain("This retained tombstone is read-only");
    expect(html).not.toContain("Danger Zone");
    expect(html).not.toContain("A2P Review");
    expect(html).not.toContain("ADMIN_FLAG_FORM");
    expect(html).not.toContain("PARTNER_BILLING_FORM");
    expect(html).not.toContain("A2P_APPROVE_FORM");
    expect(html).not.toContain("EXISTING_TELNYX_FORM");
    expect(html).not.toContain("ADMIN_SERVICE_CONTROLS");
    expect(html).not.toContain("Account health");
    expect(html).toContain("Account activity");
    expect(html).toContain("Account deletion scheduled");
  });

  it("shows an explicit unavailable state instead of partial activity", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.loadActivity.mockRejectedValue(new Error("activity source failed"));

    const html = renderToStaticMarkup(
      await AdminBusinessPage({ params: { businessId: BUSINESS_ID } }),
    );

    expect(html).toContain("Timeline unavailable");
    expect(html).toContain("No partial timeline is shown.");
    expect(html).toContain("Account health");
    expect(html).toContain("ADMIN_SERVICE_CONTROLS");
    expect(html).toContain("ADMIN_FLAG_FORM");
    expect(log).toHaveBeenCalledWith(
      "[admin-account-activity] Timeline unavailable",
      expect.any(Error),
    );
    log.mockRestore();
  });

  it("keeps controls available for operationally suspended accounts and passes the stored billing mode", async () => {
    mocks.results.set("businesses", {
      data: storedBusiness({
        billing_mode: "comped",
        partner_id: "20000000-0000-4000-a045-000000000001",
        partner_plan: "sms_and_chat",
      }),
      error: null,
    });
    mocks.loadHealth.mockResolvedValue(
      storedHealth({
        operations: {
          state: "suspended",
          suspendedAt: "2026-08-04T12:00:00.000Z",
          services: {
            aiReplies: { state: "paused", pausedAt: null },
            texting: { state: "paused", pausedAt: null },
            bookings: { state: "paused", pausedAt: null },
          },
        },
        billing: {
          mode: "comped",
          subscriptionPresent: false,
          plan: "sms_and_chat",
          status: "partner_billing",
          source: "partner_billing",
          state: "active",
          pastDue: false,
          cancelAtPeriodEnd: false,
        },
      }),
    );

    const html = renderToStaticMarkup(
      await AdminBusinessPage({ params: { businessId: BUSINESS_ID } }),
    );

    expect(html).toContain("ADMIN_SERVICE_CONTROLS");
    expect(html).toContain('data-operations-state="suspended"');
    expect(html).toContain('data-billing-mode="comped"');
  });

  it("fails closed when the initial business read fails", async () => {
    mocks.results.set("businesses", {
      data: null,
      error: { message: "database unavailable" },
    });

    await expect(
      AdminBusinessPage({ params: { businessId: BUSINESS_ID } }),
    ).rejects.toThrow("Failed to load admin account.");
    expect(mocks.loadHealth).not.toHaveBeenCalled();
    expect(mocks.loadActivity).not.toHaveBeenCalled();
    expect(mocks.getPreview).not.toHaveBeenCalled();
  });
});
