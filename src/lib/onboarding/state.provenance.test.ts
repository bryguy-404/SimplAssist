import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  update: vi.fn(),
  getSmsReadinessForBusiness: vi.fn(),
  getSmsReadinessForBusinessReadOnly: vi.fn(),
  directAcquisition: vi.fn(),
  validChatPrice: vi.fn(),
  selectedColumns: new Map<string, string>(),
  rowsByTable: {} as Record<string, unknown>,
  errorsByTable: {} as Record<string, unknown>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mocks.from },
}));
vi.mock("@/lib/messaging/lookup", () => ({
  getSmsReadinessForBusiness: mocks.getSmsReadinessForBusiness,
  getSmsReadinessForBusinessReadOnly:
    mocks.getSmsReadinessForBusinessReadOnly,
}));
vi.mock("@/lib/messaging/registration/riskScreening", () => ({
  hashA2pRiskInput: vi.fn(() => "risk-hash"),
  registrationHasStartedForRisk: vi.fn(() => false),
}));
vi.mock("@/lib/billing/chatOnlyRollout.server", () => ({
  isChatOnlyDirectAcquisitionEnabledForBusiness: mocks.directAcquisition,
}));
vi.mock("@/lib/stripe/config", () => ({
  hasValidChatOnlyStripePrice: mocks.validChatPrice,
}));

import {
  getOnboardingCheckoutContextForBusinessIdReadOnly,
  getOnboardingStateForBusinessId,
  getOnboardingStateForOwnerReadOnly,
} from "./state";

function makeQuery(table: string, data: unknown, error: unknown) {
  const result = { data, error };
  const query = {
    select: vi.fn((columns: string) => {
      mocks.selectedColumns.set(table, columns);
      return query;
    }),
    update: vi.fn((values) => {
      mocks.update(values);
      return query;
    }),
    eq: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    single: vi.fn(async () => result),
    maybeSingle: vi.fn(async () => result),
    returns: vi.fn(async () => result),
  };
  return query;
}

describe("onboarding knowledge provenance resume loading", () => {
  beforeEach(() => {
    mocks.from.mockReset();
    mocks.update.mockReset();
    mocks.getSmsReadinessForBusiness.mockReset();
    mocks.getSmsReadinessForBusinessReadOnly.mockReset();
    mocks.directAcquisition.mockReset();
    mocks.validChatPrice.mockReset();
    mocks.selectedColumns.clear();
    mocks.errorsByTable = {};
    mocks.directAcquisition.mockReturnValue(false);
    mocks.validChatPrice.mockReturnValue(false);

    mocks.rowsByTable = {
      businesses: {
        id: "business-1",
        owner_id: "owner-1",
        partner_id: null,
        billing_mode: "stripe",
        partner_plan: null,
        onboarding_selected_plan: null,
        deleted_at: null,
        operations_suspended_at: null,
        billing_pilot: false,
        billing_comped: false,
        billing_exempt: false,
        primary_goal: "signup",
        goal_url: "https://example.test/signup?source=ai#form",
        name: "Provenance Test",
        business_type: "general",
        onboarding_step: "services_faqs",
        onboarding_completed_at: null,
        onboarding_last_saved_at: null,
        onboarding_registration_status: "not_started",
        has_ein: null,
      },
      business_hours: [],
      services: [
        {
          name: "Scanned service",
          description: null,
          price: null,
          source: "scraped",
        },
      ],
      faqs: [
        {
          question: "Suggested question?",
          answer: "Suggested answer.",
          source: "suggested",
        },
        {
          question: "Legacy question?",
          answer: "Legacy answer.",
          source: null,
        },
      ],
      ai_settings: null,
      widget_configs: null,
      phone_numbers: null,
      subscriptions: null,
      business_plan_family_locks: null,
    };

    mocks.from.mockImplementation((table: string) =>
      makeQuery(
        table,
        mocks.rowsByTable[table] ?? null,
        mocks.errorsByTable[table] ?? null,
      )
    );
    mocks.getSmsReadinessForBusinessReadOnly.mockResolvedValue({
      phoneNumber: null,
      smsReady: false,
      blockReason: null,
      assignmentStatus: null,
      assignmentFailureReason: null,
    });
    mocks.getSmsReadinessForBusiness.mockResolvedValue({
      phoneNumber: null,
      smsReady: false,
      blockReason: null,
      assignmentStatus: null,
      assignmentFailureReason: null,
    });
  });

  function configureCoreReadyBusiness(
    overrides: Record<string, unknown> = {},
  ) {
    mocks.rowsByTable.businesses = {
      ...(mocks.rowsByTable.businesses as Record<string, unknown>),
      name: "Ready Business",
      business_type: "general",
      phone_number: "+15745550100",
      email: "owner@example.test",
      address: "1 Main St",
      city: "South Bend",
      state: "IN",
      zip: "46601",
      primary_goal: "book",
      ...overrides,
    };
    mocks.rowsByTable.business_hours = Array.from({ length: 7 }, (_, day) => ({
      day_of_week: day,
      is_closed: false,
      open_time: "09:00:00",
      close_time: "17:00:00",
    }));
    mocks.rowsByTable.services = ["One", "Two", "Three"].map((name) => ({
      name,
      description: null,
      price: null,
      source: "manual",
    }));
    mocks.rowsByTable.faqs = ["One?", "Two?", "Three?"].map((question) => ({
      question,
      answer: "A useful answer.",
      source: "manual",
    }));
    mocks.rowsByTable.ai_settings = {
      tone: "balanced",
      business_voice: "we",
      language: "en",
      sms_response_delay_seconds: 5,
      guardrails: [],
      booking_enabled: false,
      booking_mode: "collect_info",
    };
  }

  it("selects and retains stored sources while defaulting a legacy null FAQ", async () => {
    const state = await getOnboardingStateForOwnerReadOnly("owner-1");

    expect(mocks.selectedColumns.get("services")).toContain("source");
    expect(mocks.selectedColumns.get("faqs")).toContain("source");
    expect(mocks.selectedColumns.get("businesses")).toContain("partner_id");
    expect(mocks.selectedColumns.get("businesses")).toContain("billing_mode");
    expect(mocks.selectedColumns.get("businesses")).toContain("primary_goal");
    expect(mocks.selectedColumns.get("businesses")).toContain("goal_url");
    expect(state?.primaryGoal).toBe("signup");
    expect(state?.goalUrl).toBe(
      "https://example.test/signup?source=ai#form"
    );
    expect(state?.servicesAndFaqs).toEqual({
      services: [
        {
          name: "Scanned service",
          description: "",
          price: "",
          source: "scraped",
        },
      ],
      faqs: [
        {
          question: "Suggested question?",
          answer: "Suggested answer.",
          source: "suggested",
        },
        {
          question: "Legacy question?",
          answer: "Legacy answer.",
          source: "manual",
        },
      ],
    });
    expect(state?.billing).toMatchObject({
      mode: "stripe",
      handledByName: null,
    });
    expect(mocks.from).not.toHaveBeenCalledWith("partners");
  });

  it("returns a fresh checkout context without synchronizing progress or provider state", async () => {
    mocks.directAcquisition.mockReturnValue(true);
    mocks.validChatPrice.mockReturnValue(true);

    const context = await getOnboardingCheckoutContextForBusinessIdReadOnly("business-1");

    expect(context).toMatchObject({
      freshInitialDirectAcquisition: true,
      state: {
        currentStep: "plan_selection",
        steps: ["plan_selection"],
        planSelection: {
          position: "start",
          familyChangeRequiresSupport: false,
          canChooseDirectPlan: true,
          chatOnlyDirectSalesAvailable: true,
        },
      },
    });
    expect(mocks.from.mock.calls.filter(([table]) => table === "businesses")).toHaveLength(1);
    expect(mocks.getSmsReadinessForBusinessReadOnly).toHaveBeenCalledOnce();
    expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("classifies initial direct checkout independently of the acquisition rollout", async () => {
    configureCoreReadyBusiness();
    const context = await getOnboardingCheckoutContextForBusinessIdReadOnly("business-1");
    expect(context?.freshInitialDirectAcquisition).toBe(true);
    expect(context?.state.planSelection.position).toBeNull();
  });

  it.each([
    { missing: "business info", step: "business_info", business: { name: "My Business" } },
    { missing: "hours", step: "business_hours", table: "business_hours", rows: [] },
    { missing: "knowledge", step: "services_faqs", table: "services", rows: [] },
    { missing: "AI settings", step: "ai_settings", table: "ai_settings", rows: null },
    { missing: "primary goal", step: "ai_settings", business: { primary_goal: null } },
  ])("read-only checkout context identifies missing $missing from saved facts", async ({ step, business, table, rows }) => {
    configureCoreReadyBusiness({ onboarding_selected_plan: "chat_only", ...business });
    if (table) mocks.rowsByTable[table] = rows;
    mocks.directAcquisition.mockReturnValue(true);
    mocks.validChatPrice.mockReturnValue(true);

    const context = await getOnboardingCheckoutContextForBusinessIdReadOnly("business-1");
    expect(context?.freshInitialDirectAcquisition).toBe(true);
    expect(context?.state.currentStep).toBe(step);
    expect(context?.state.dashboardReady).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
    expect(mocks.getSmsReadinessForBusinessReadOnly).not.toHaveBeenCalled();
  });

  it("read-only checkout context requires SMS-specific setup after shared setup", async () => {
    configureCoreReadyBusiness({ onboarding_selected_plan: "sms_only", primary_goal: "book" });
    mocks.directAcquisition.mockReturnValue(true);
    mocks.validChatPrice.mockReturnValue(true);
    const legal = await getOnboardingCheckoutContextForBusinessIdReadOnly("business-1");
    expect(legal?.state.currentStep).toBe("legal_verification");

    configureCoreReadyBusiness({
      onboarding_selected_plan: "sms_only",
      has_ein: true,
      legal_business_name: "Ready Business LLC",
      business_entity_type: "llc",
      business_registration_state: "IN",
      ein: "12-3456789",
      authorized_rep_name: "Test Owner",
      authorized_rep_title: "Owner",
      authorized_rep_email: "owner@example.test",
      authorized_rep_phone: "+13175550124",
    });
    const compliance = await getOnboardingCheckoutContextForBusinessIdReadOnly("business-1");
    expect(compliance?.state.currentStep).toBe("sms_use_case");
    expect(compliance?.freshInitialDirectAcquisition).toBe(true);

    configureCoreReadyBusiness({
      a2p_risk_review_status: "passed",
      a2p_risk_review_input_hash: "risk-hash",
      compliance_info_completed_at: "2026-09-23T00:00:00Z",
      use_case_description: "Customer care",
      estimated_monthly_volume: "under_1k",
      opt_in_description: "Website form",
      sample_messages: ["One", "Two", "Three"],
    });
    const phone = await getOnboardingCheckoutContextForBusinessIdReadOnly("business-1");
    expect(phone?.state.currentStep).toBe("phone_number");

    configureCoreReadyBusiness({ pending_phone_number: "+13175550124" });
    const ready = await getOnboardingCheckoutContextForBusinessIdReadOnly("business-1");
    expect(ready?.state.currentStep).toBe("review_submit");
    expect(ready?.freshInitialDirectAcquisition).toBe(true);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("keeps acquisition rollback separate from a support-required family lock", async () => {
    configureCoreReadyBusiness({ onboarding_selected_plan: "chat_only" });
    const unlocked = await getOnboardingCheckoutContextForBusinessIdReadOnly("business-1");
    expect(unlocked?.state.planSelection).toMatchObject({
      position: null,
      chatOnlyCheckoutPaused: true,
      familyChangeRequiresSupport: false,
    });
    expect(unlocked?.freshInitialDirectAcquisition).toBe(true);

    mocks.rowsByTable.business_plan_family_locks = { family: "chat_only", claimed_by: "direct_checkout" };
    const locked = await getOnboardingCheckoutContextForBusinessIdReadOnly("business-1");
    expect(locked?.freshInitialDirectAcquisition).toBe(false);
    expect(locked?.state.planSelection.familyChangeRequiresSupport).toBe(true);
    expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
    expect(mocks.getSmsReadinessForBusinessReadOnly).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("excludes subscription authority from first acquisition", async () => {
    configureCoreReadyBusiness();
    mocks.rowsByTable.subscriptions = { plan: "sms_only", status: "active" };
    const context = await getOnboardingCheckoutContextForBusinessIdReadOnly("business-1");
    expect(context?.freshInitialDirectAcquisition).toBe(false);
    expect(context?.state.planSelection.position).toBeNull();
  });

  it("returns no checkout context for an unreadable or deleted business", async () => {
    mocks.errorsByTable.businesses = { message: "business unavailable" };
    expect(await getOnboardingCheckoutContextForBusinessIdReadOnly("business-1")).toBeNull();
    mocks.errorsByTable = {};
    configureCoreReadyBusiness({ deleted_at: "2026-09-23T00:00:00Z" });
    expect(await getOnboardingCheckoutContextForBusinessIdReadOnly("business-1")).toBeNull();
  });

  it("preserves a purchased SMS family's late selector when no intent has been saved", async () => {
    configureCoreReadyBusiness({ onboarding_selected_plan: null });
    mocks.directAcquisition.mockReturnValue(true);
    mocks.validChatPrice.mockReturnValue(true);
    mocks.rowsByTable.business_plan_family_locks = { family: "sms", claimed_by: "direct_checkout" };

    const context = await getOnboardingCheckoutContextForBusinessIdReadOnly("business-1");
    expect(context).toMatchObject({
      freshInitialDirectAcquisition: false,
      state: {
        currentStep: "plan_selection",
        planSelection: {
          position: "after_knowledge",
          familyChangeRequiresSupport: true,
          canChooseDirectPlan: true,
          chatOnlyDirectSalesAvailable: false,
        },
      },
    });
    expect(context?.state.steps.slice(0, 5)).toEqual([
      "business_info", "business_hours", "services_faqs", "plan_selection", "ai_settings",
    ]);

    configureCoreReadyBusiness({ onboarding_selected_plan: "sms_only" });
    const saved = await getOnboardingCheckoutContextForBusinessIdReadOnly("business-1");
    expect(saved?.state.planSelection).toMatchObject({
      effectivePlan: "sms_only",
      position: "after_knowledge",
      canChooseDirectPlan: true,
    });
    expect(saved?.state.currentStep).toBe("legal_verification");
  });

  it.each([
    { telnyx_brand_id: "brand-1" },
    { telnyx_campaign_id: "campaign-1" },
    { telnyx_messaging_profile_id: "profile-1" },
    { telnyx_voice_application_id: "voice-1" },
    { telnyx_resource_state: "parked" },
    { onboarding_registration_status: "submitting" },
  ])("keeps provider-owned accounts out of initial acquisition: %j", async (overrides) => {
    configureCoreReadyBusiness(overrides);
    mocks.directAcquisition.mockReturnValue(true);
    mocks.validChatPrice.mockReturnValue(true);
    const context = await getOnboardingCheckoutContextForBusinessIdReadOnly("business-1");
    expect(context?.freshInitialDirectAcquisition).toBe(false);
    expect(context?.state.planSelection).toMatchObject({
      position: "after_knowledge",
      familyChangeRequiresSupport: true,
      chatOnlyDirectSalesAvailable: false,
    });
  });

  it("distinguishes an unpurchased number choice from provider-owned phone numbers", async () => {
    configureCoreReadyBusiness({ pending_phone_number: "+13175550124" });
    mocks.directAcquisition.mockReturnValue(true);
    mocks.validChatPrice.mockReturnValue(true);
    expect((await getOnboardingCheckoutContextForBusinessIdReadOnly("business-1"))?.freshInitialDirectAcquisition).toBe(true);

    mocks.rowsByTable.phone_numbers = { phone_number: "+13175550124" };
    const owned = await getOnboardingCheckoutContextForBusinessIdReadOnly("business-1");
    expect(owned?.freshInitialDirectAcquisition).toBe(false);
    expect(owned?.state.planSelection.chatOnlyDirectSalesAvailable).toBe(false);
  });

  it.each([
    { onboarding_completed_at: "2026-09-23T00:00:00Z" },
    { billing_pilot: true },
    { billing_comped: true },
    { billing_exempt: true },
    { operations_suspended_at: "2026-09-23T00:00:00Z" },
    { partner_id: "partner-1" },
    { billing_mode: "invoiced" },
  ])("does not classify protected or established context as fresh: %j", async (overrides) => {
    configureCoreReadyBusiness(overrides);
    const context = await getOnboardingCheckoutContextForBusinessIdReadOnly("business-1");
    expect(context?.freshInitialDirectAcquisition).toBe(false);
  });

  it("rejects unreadable phone ownership before declaring fresh acquisition", async () => {
    mocks.errorsByTable.phone_numbers = { message: "ownership unavailable" };
    await expect(getOnboardingCheckoutContextForBusinessIdReadOnly("business-1"))
      .rejects.toThrow("phone-number ownership");
    expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
    expect(mocks.getSmsReadinessForBusinessReadOnly).not.toHaveBeenCalled();
  });

  it("selects and returns goal values in the business-id state projection", async () => {
    const state = await getOnboardingStateForBusinessId("business-1");

    expect(mocks.selectedColumns.get("businesses")).toContain("primary_goal");
    expect(mocks.selectedColumns.get("businesses")).toContain("goal_url");
    expect(state?.primaryGoal).toBe("signup");
    expect(state?.goalUrl).toBe(
      "https://example.test/signup?source=ai#form"
    );
  });

  it("preserves every direct subscription billing field in onboarding state", async () => {
    mocks.rowsByTable.subscriptions = {
      plan: "full",
      status: "past_due",
      setup_fee_paid_at: "2026-07-01T12:00:00.000Z",
      current_period_start: "2026-07-01T00:00:00.000Z",
      current_period_end: "2026-08-01T00:00:00.000Z",
    };

    const state = await getOnboardingStateForOwnerReadOnly("owner-1");

    expect(mocks.selectedColumns.get("subscriptions")).toBe(
      "plan, status, setup_fee_paid_at, current_period_start, current_period_end"
    );
    expect(state?.billing).toEqual({
      mode: "stripe",
      handledByName: null,
      plan: "full",
      status: "past_due",
      setupFeePaidAt: "2026-07-01T12:00:00.000Z",
      currentPeriodStart: "2026-07-01T00:00:00.000Z",
      currentPeriodEnd: "2026-08-01T00:00:00.000Z",
    });
  });

  it("keeps an SMS-ready null-goal business out of the dashboard", async () => {
    mocks.rowsByTable.businesses = {
      ...(mocks.rowsByTable.businesses as Record<string, unknown>),
      primary_goal: null,
      goal_url: null,
      name: "Ready Business",
      business_type: "general",
      phone_number: "+15745550100",
      email: "owner@example.test",
      address: "1 Main St",
      city: "South Bend",
      state: "IN",
      zip: "46601",
      onboarding_completed_at: "2026-07-24T00:00:00.000Z",
    };
    mocks.rowsByTable.business_hours = Array.from({ length: 7 }, (_, day) => ({
      day_of_week: day,
      is_closed: false,
      open_time: "09:00:00",
      close_time: "17:00:00",
    }));
    mocks.rowsByTable.services = ["One", "Two", "Three"].map((name) => ({
      name,
      description: null,
      price: null,
      source: "manual",
    }));
    mocks.rowsByTable.faqs = ["One?", "Two?", "Three?"].map(
      (question) => ({
        question,
        answer: "A useful answer.",
        source: "manual",
      })
    );
    mocks.getSmsReadinessForBusinessReadOnly.mockResolvedValue({
      phoneNumber: "+15745550101",
      smsReady: true,
      blockReason: null,
      assignmentStatus: "assigned",
      assignmentFailureReason: null,
    });

    const state = await getOnboardingStateForOwnerReadOnly("owner-1");

    expect(state).toMatchObject({
      primaryGoal: null,
      goalUrl: null,
      currentStep: "ai_settings",
      dashboardReady: false,
    });
  });

  it("loads the assigned partner name through the service-role state query", async () => {
    mocks.rowsByTable.businesses = {
      ...(mocks.rowsByTable.businesses as Record<string, unknown>),
      partner_id: "11111111-1111-4111-8111-111111111111",
      billing_mode: "invoiced",
    };
    mocks.rowsByTable.partners = { name: "Alpha Dog Agency" };

    const state = await getOnboardingStateForOwnerReadOnly("owner-1");

    expect(mocks.from).toHaveBeenCalledWith("partners");
    expect(mocks.selectedColumns.get("partners")).toBe("name");
    expect(state?.billing).toMatchObject({
      mode: "invoiced",
      handledByName: "Alpha Dog Agency",
    });
  });

  it("returns a null handled-by name when the assignment is orphaned", async () => {
    mocks.rowsByTable.businesses = {
      ...(mocks.rowsByTable.businesses as Record<string, unknown>),
      partner_id: "11111111-1111-4111-8111-111111111111",
      billing_mode: "comped",
    };
    mocks.rowsByTable.partners = null;

    const state = await getOnboardingStateForOwnerReadOnly("owner-1");

    expect(state?.billing).toMatchObject({
      mode: "comped",
      handledByName: null,
    });
  });

  it("resolves subscription over partner plan over direct intent", async () => {
    configureCoreReadyBusiness({
      partner_plan: "chat_only",
      onboarding_selected_plan: "chat_only",
    });
    mocks.rowsByTable.subscriptions = {
      plan: "sms_only",
      status: "active",
      setup_fee_paid_at: "2026-07-01T00:00:00.000Z",
      current_period_start: "2026-07-01T00:00:00.000Z",
      current_period_end: "2026-08-01T00:00:00.000Z",
    };

    const state = await getOnboardingStateForOwnerReadOnly("owner-1");

    expect(state?.planSelection).toMatchObject({
      effectivePlan: "sms_only",
      source: "subscription",
    });
    expect(state?.steps).toEqual([
      "business_info",
      "business_hours",
      "services_faqs",
      "ai_settings",
      "legal_verification",
      "sms_use_case",
      "phone_number",
      "review_submit",
      "carrier_review",
    ]);
  });

  it("keeps the direct plan picker hidden until scoped acquisition and Price are valid", async () => {
    configureCoreReadyBusiness({
      primary_goal: null,
      onboarding_selected_plan: null,
    });

    const hiddenState = await getOnboardingStateForOwnerReadOnly("owner-1");

    expect(hiddenState?.planSelection).toMatchObject({
      effectivePlan: null,
      directIntent: null,
      canChooseDirectPlan: false,
      chatOnlyDirectSalesAvailable: false,
    });
    expect(hiddenState?.currentStep).toBe("ai_settings");
    expect(hiddenState?.steps).toHaveLength(9);

    mocks.directAcquisition.mockReturnValue(true);
    const missingPriceState = await getOnboardingStateForOwnerReadOnly("owner-1");
    expect(missingPriceState?.planSelection.effectivePlan).toBeNull();
    expect(missingPriceState?.planSelection.canChooseDirectPlan).toBe(false);
    expect(missingPriceState?.currentStep).toBe("ai_settings");

    mocks.validChatPrice.mockReturnValue(true);
    const enabledState = await getOnboardingStateForOwnerReadOnly("owner-1");
    expect(enabledState?.planSelection).toMatchObject({
      effectivePlan: null,
      directIntent: null,
      canChooseDirectPlan: true,
      chatOnlyDirectSalesAvailable: true,
      chatOnlyCheckoutAvailable: false,
      chatOnlyCheckoutPaused: false,
    });
    expect(enabledState?.steps).toContain("plan_selection");
    expect(mocks.directAcquisition).toHaveBeenCalledWith("business-1");
  });

  it.each([
    ["acquisition rollback", false, true],
    ["missing Chat Price", true, false],
  ] as const)(
    "keeps an unlocked Chat intent paused through %s without SMS readiness",
    async (_label, acquisitionEnabled, validPrice) => {
      configureCoreReadyBusiness({
        onboarding_selected_plan: "chat_only",
        onboarding_completed_at: null,
        pending_phone_number: "+13175550124",
      });
      mocks.directAcquisition.mockReturnValue(acquisitionEnabled);
      mocks.validChatPrice.mockReturnValue(validPrice);

      const state = await getOnboardingStateForOwnerReadOnly("owner-1");

      expect(state).toMatchObject({
        currentStep: "review_submit",
        dashboardReady: false,
        phoneNumber: null,
        activePhoneNumber: null,
        planSelection: {
          effectivePlan: "chat_only",
          source: "direct_intent",
          directIntent: "chat_only",
          canChooseDirectPlan: false,
          chatOnlyDirectSalesAvailable: false,
          chatOnlyCheckoutAvailable: false,
          chatOnlyCheckoutPaused: true,
        },
        registration: {
          smsReady: false,
          assignmentStatus: null,
        },
      });
      expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
      expect(mocks.getSmsReadinessForBusinessReadOnly).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "operations-suspended",
      { operations_suspended_at: "2026-08-19T12:00:00.000Z" },
    ],
    ["billing-pilot", { billing_pilot: true }],
    ["billing-comped", { billing_comped: true }],
    ["billing-exempt", { billing_exempt: true }],
    ["partner-linked", { partner_id: "partner-1" }],
    ["non-Stripe", { billing_mode: "invoiced" }],
  ] as const)(
    "does not expose direct acquisition for a %s business",
    async (_label, overrides) => {
      configureCoreReadyBusiness({
        primary_goal: null,
        onboarding_selected_plan: null,
        ...overrides,
      });
      mocks.directAcquisition.mockReturnValue(true);
      mocks.validChatPrice.mockReturnValue(true);

      const state = await getOnboardingStateForOwnerReadOnly("owner-1");

      expect(state?.planSelection).toMatchObject({
        effectivePlan: null,
        directIntent: null,
        canChooseDirectPlan: false,
        chatOnlyDirectSalesAvailable: false,
        chatOnlyCheckoutAvailable: false,
        chatOnlyCheckoutPaused: false,
      });
      expect(mocks.directAcquisition).not.toHaveBeenCalled();
    },
  );

  it("keeps a suspended saved Chat intent paused instead of entering SMS readiness", async () => {
    configureCoreReadyBusiness({
      onboarding_selected_plan: "chat_only",
      operations_suspended_at: "2026-08-19T12:00:00.000Z",
    });
    mocks.directAcquisition.mockReturnValue(true);
    mocks.validChatPrice.mockReturnValue(true);

    const state = await getOnboardingStateForBusinessId("business-1");

    expect(state?.planSelection).toMatchObject({
      effectivePlan: "chat_only",
      source: "direct_intent",
      directIntent: "chat_only",
      canChooseDirectPlan: false,
      chatOnlyCheckoutAvailable: false,
      chatOnlyCheckoutPaused: true,
    });
    expect(mocks.directAcquisition).not.toHaveBeenCalled();
    expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
    expect(mocks.getSmsReadinessForBusinessReadOnly).not.toHaveBeenCalled();
  });

  it("returns no onboarding state for a deleted business", async () => {
    configureCoreReadyBusiness({
      deleted_at: "2026-08-19T12:00:00.000Z",
      onboarding_selected_plan: "chat_only",
    });

    await expect(
      getOnboardingStateForBusinessId("business-1"),
    ).resolves.toBeNull();
    expect(mocks.directAcquisition).not.toHaveBeenCalled();
    expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
    expect(mocks.getSmsReadinessForBusinessReadOnly).not.toHaveBeenCalled();
  });

  it.each([
    ["acquisition rollback", false, true],
    ["missing Chat Price", true, false],
  ] as const)(
    "projects a durable Chat family lock through %s without SMS readiness",
    async (_label, acquisitionEnabled, validPrice) => {
      configureCoreReadyBusiness({
        onboarding_selected_plan: "chat_only",
        onboarding_completed_at: null,
        pending_phone_number: "+13175550124",
      });
      mocks.rowsByTable.business_plan_family_locks = {
        family: "chat_only",
        claimed_by: "direct_checkout",
      };
      mocks.directAcquisition.mockReturnValue(acquisitionEnabled);
      mocks.validChatPrice.mockReturnValue(validPrice);

      const state = await getOnboardingStateForOwnerReadOnly("owner-1");

      expect(state).toMatchObject({
        currentStep: "review_submit",
        dashboardReady: false,
        phoneNumber: null,
        activePhoneNumber: null,
        planSelection: {
          effectivePlan: "chat_only",
          source: "family_lock",
          directIntent: "chat_only",
          canChooseDirectPlan: false,
          chatOnlyDirectSalesAvailable: false,
          chatOnlyCheckoutAvailable: false,
          chatOnlyCheckoutPaused: true,
        },
        registration: {
          smsReady: false,
          assignmentStatus: null,
        },
      });
      expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
      expect(mocks.getSmsReadinessForBusinessReadOnly).not.toHaveBeenCalled();
    },
  );

  it("keeps same-family Chat checkout available after the durable lock is claimed", async () => {
    configureCoreReadyBusiness({
      onboarding_selected_plan: "chat_only",
      onboarding_completed_at: null,
    });
    mocks.rowsByTable.business_plan_family_locks = {
      family: "chat_only",
      claimed_by: "direct_checkout",
    };
    mocks.directAcquisition.mockReturnValue(true);
    mocks.validChatPrice.mockReturnValue(true);

    const state = await getOnboardingStateForOwnerReadOnly("owner-1");

    expect(state?.planSelection).toMatchObject({
      effectivePlan: "chat_only",
      source: "family_lock",
      directIntent: "chat_only",
      canChooseDirectPlan: false,
      chatOnlyDirectSalesAvailable: false,
      chatOnlyCheckoutAvailable: true,
      chatOnlyCheckoutPaused: false,
    });
    expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
    expect(mocks.getSmsReadinessForBusinessReadOnly).not.toHaveBeenCalled();
  });

  it("keeps a durable SMS family lock on the legacy onboarding path", async () => {
    configureCoreReadyBusiness({ onboarding_selected_plan: null });
    mocks.rowsByTable.business_plan_family_locks = {
      family: "sms",
      claimed_by: "direct_checkout",
    };

    const state = await getOnboardingStateForOwnerReadOnly("owner-1");

    expect(state?.planSelection).toMatchObject({
      effectivePlan: null,
      source: null,
      chatOnlyCheckoutAvailable: false,
      chatOnlyCheckoutPaused: false,
    });
    expect(mocks.getSmsReadinessForBusinessReadOnly).toHaveBeenCalledWith(
      "business-1",
    );
  });

  it("fails closed on a plan-family lock lookup error before SMS readiness", async () => {
    configureCoreReadyBusiness();
    mocks.errorsByTable.business_plan_family_locks = {
      message: "family lock unavailable",
    };

    await expect(
      getOnboardingStateForBusinessId("business-1"),
    ).rejects.toThrow(
      "Failed to read plan-family lock for business-1: family lock unavailable",
    );
    expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
    expect(mocks.getSmsReadinessForBusinessReadOnly).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed plan-family lock before SMS readiness", async () => {
    configureCoreReadyBusiness();
    mocks.rowsByTable.business_plan_family_locks = {
      family: "voice",
      claimed_by: "direct_checkout",
    };

    await expect(
      getOnboardingStateForBusinessId("business-1"),
    ).rejects.toThrow("Malformed plan-family lock for business-1");
    expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
    expect(mocks.getSmsReadinessForBusinessReadOnly).not.toHaveBeenCalled();
  });

  it.each(["active", "trialing"] as const)(
    "unlocks completed direct Chat Only for synchronized %s authority",
    async (status) => {
      configureCoreReadyBusiness({
        onboarding_completed_at: "2026-08-18T12:00:00.000Z",
        onboarding_selected_plan: "sms_only",
        operations_suspended_at:
          status === "active" ? "2026-08-19T12:00:00.000Z" : null,
        billing_pilot: status === "trialing",
      });
      mocks.rowsByTable.subscriptions = {
        plan: "chat_only",
        status,
        setup_fee_paid_at: null,
        current_period_start: "2026-08-18T12:00:00.000Z",
        current_period_end: "2026-09-18T12:00:00.000Z",
      };

      const state = await getOnboardingStateForOwnerReadOnly("owner-1");

      expect(state?.planSelection).toMatchObject({
        effectivePlan: "chat_only",
        source: "subscription",
        chatOnlyCheckoutAvailable: true,
        chatOnlyCheckoutPaused: false,
      });
      expect(state).toMatchObject({
        currentStep: "complete",
        dashboardReady: true,
        completedAt: "2026-08-18T12:00:00.000Z",
      });
      expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
      expect(mocks.getSmsReadinessForBusinessReadOnly).not.toHaveBeenCalled();
      expect(mocks.directAcquisition).not.toHaveBeenCalled();
    },
  );

  it("fails closed on a direct subscription read error before SMS readiness", async () => {
    configureCoreReadyBusiness({
      onboarding_completed_at: "2026-08-18T12:00:00.000Z",
      onboarding_selected_plan: null,
    });
    mocks.rowsByTable.subscriptions = {
      plan: "chat_only",
      status: "active",
      setup_fee_paid_at: null,
      current_period_start: "2026-08-18T12:00:00.000Z",
      current_period_end: "2026-09-18T12:00:00.000Z",
    };
    mocks.errorsByTable.subscriptions = { message: "database unavailable" };

    await expect(
      getOnboardingStateForBusinessId("business-1"),
    ).rejects.toThrow(
      "Failed to read subscription for business-1: database unavailable",
    );
    expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
    expect(mocks.getSmsReadinessForBusinessReadOnly).not.toHaveBeenCalled();
  });

  it("keeps owner intent unready and inert even with retained SMS-ready rows", async () => {
    configureCoreReadyBusiness({
      onboarding_selected_plan: "chat_only",
      onboarding_completed_at: "2026-08-18T12:00:00.000Z",
      pending_phone_number: "+13175550124",
    });
    mocks.rowsByTable.phone_numbers = {
      phone_number: "+13175550123",
      telnyx_campaign_assignment_status: "assigned",
      telnyx_campaign_assignment_failure_reason: null,
    };
    mocks.directAcquisition.mockReturnValue(true);
    mocks.validChatPrice.mockReturnValue(true);
    mocks.getSmsReadinessForBusiness.mockResolvedValue({
      phoneNumber: "+13175550123",
      smsReady: true,
      blockReason: null,
      assignmentStatus: "assigned",
      assignmentFailureReason: null,
    });
    mocks.getSmsReadinessForBusinessReadOnly.mockResolvedValue({
      phoneNumber: "+13175550123",
      smsReady: true,
      blockReason: null,
      assignmentStatus: "assigned",
      assignmentFailureReason: null,
    });

    const state = await getOnboardingStateForBusinessId("business-1");

    expect(state).toMatchObject({
      currentStep: "review_submit",
      dashboardReady: false,
      phoneNumber: null,
      activePhoneNumber: null,
      pendingPhoneNumber: "+13175550124",
      registration: {
        smsReady: false,
        assignmentStatus: null,
      },
      planSelection: {
        effectivePlan: "chat_only",
        source: "direct_intent",
      },
    });
    expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
    expect(mocks.getSmsReadinessForBusinessReadOnly).not.toHaveBeenCalled();
  });

  it("keeps a previously completed Chat Only account available while past due", async () => {
    configureCoreReadyBusiness({
      onboarding_completed_at: "2026-08-18T12:00:00.000Z",
    });
    mocks.rowsByTable.subscriptions = {
      plan: "chat_only",
      status: "past_due",
      setup_fee_paid_at: null,
      current_period_start: "2026-08-18T12:00:00.000Z",
      current_period_end: "2026-09-18T12:00:00.000Z",
    };

    const state = await getOnboardingStateForOwnerReadOnly("owner-1");

    expect(state).toMatchObject({
      currentStep: "complete",
      dashboardReady: true,
      completedAt: "2026-08-18T12:00:00.000Z",
      planSelection: {
        chatOnlyCheckoutAvailable: false,
        chatOnlyCheckoutPaused: false,
      },
    });
  });

  it("pauses canceled Chat checkout after acquisition rollback", async () => {
    configureCoreReadyBusiness({ onboarding_completed_at: null });
    mocks.rowsByTable.subscriptions = {
      plan: "chat_only",
      status: "canceled",
      setup_fee_paid_at: null,
      current_period_start: null,
      current_period_end: null,
    };
    mocks.rowsByTable.business_plan_family_locks = {
      family: "chat_only",
      claimed_by: "stripe_sync",
    };
    mocks.directAcquisition.mockReturnValue(false);
    mocks.validChatPrice.mockReturnValue(true);

    const state = await getOnboardingStateForBusinessId("business-1");

    expect(state).toMatchObject({
      currentStep: "review_submit",
      dashboardReady: false,
      planSelection: {
        effectivePlan: "chat_only",
        source: "subscription",
        canChooseDirectPlan: false,
        chatOnlyCheckoutAvailable: false,
        chatOnlyCheckoutPaused: true,
      },
    });
    expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
    expect(mocks.getSmsReadinessForBusinessReadOnly).not.toHaveBeenCalled();
  });

  it("does not let past-due Chat Only create initial completion", async () => {
    configureCoreReadyBusiness({ onboarding_completed_at: null });
    mocks.rowsByTable.subscriptions = {
      plan: "chat_only",
      status: "past_due",
      setup_fee_paid_at: null,
      current_period_start: "2026-08-18T12:00:00.000Z",
      current_period_end: "2026-09-18T12:00:00.000Z",
    };

    const state = await getOnboardingStateForBusinessId("business-1");

    expect(state).toMatchObject({
      currentStep: "review_submit",
      dashboardReady: false,
      completedAt: null,
    });
    expect(mocks.getSmsReadinessForBusiness).not.toHaveBeenCalled();
    expect(mocks.getSmsReadinessForBusinessReadOnly).not.toHaveBeenCalled();
  });

  it("accepts Chat Only partner authority only in a real partner billing mode", async () => {
    configureCoreReadyBusiness({
      partner_id: "11111111-1111-4111-8111-111111111111",
      billing_mode: "comped",
      partner_plan: "chat_only",
      onboarding_completed_at: "2026-08-18T12:00:00.000Z",
    });
    mocks.rowsByTable.partners = { name: "Alpha Dog Agency" };

    const partnerState = await getOnboardingStateForOwnerReadOnly("owner-1");

    expect(partnerState?.planSelection).toMatchObject({
      effectivePlan: "chat_only",
      source: "partner_plan",
    });
    expect(partnerState?.dashboardReady).toBe(true);

    configureCoreReadyBusiness({
      partner_id: null,
      billing_mode: "stripe",
      partner_plan: "chat_only",
      onboarding_completed_at: "2026-08-18T12:00:00.000Z",
    });
    const malformedState = await getOnboardingStateForOwnerReadOnly("owner-1");

    expect(malformedState?.planSelection).toMatchObject({
      effectivePlan: null,
      source: null,
      canChooseDirectPlan: false,
    });
    expect(malformedState?.dashboardReady).toBe(false);
  });
});
