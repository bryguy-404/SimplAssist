import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: vi.fn() },
}));
vi.mock("@/lib/messaging/lookup", () => ({
  getSmsReadinessForBusiness: vi.fn(),
  getSmsReadinessForBusinessReadOnly: vi.fn(),
}));
vi.mock("@/lib/messaging/registration/riskScreening", () => ({
  hashA2pRiskInput: vi.fn(() => "risk-hash"),
  registrationHasStartedForRisk: (business: {
    telnyx_brand_id?: string | null;
    brand_status?: string | null;
    campaign_status?: string | null;
    onboarding_registration_status?: string | null;
  }) =>
    Boolean(
      business.telnyx_brand_id ||
        business.brand_status ||
        business.campaign_status ||
        business.onboarding_registration_status === "submitted"
    ),
}));

import { deriveOnboardingStep } from "./state";

function service(name: string) {
  return { name, description: "", price: "", source: "manual" as const };
}

function faq(question: string) {
  return { question, answer: "A useful answer.", source: "manual" as const };
}

function baseArgs() {
  return {
    business: {
      name: "Ready Business",
      business_type: "general",
      phone_number: "+15745550100",
      email: "owner@example.test",
      address: "1 Main St",
      city: "South Bend",
      state: "IN",
      zip: "46601",
      primary_goal: "book",
      goal_url: null,
      onboarding_completed_at: null,
      onboarding_registration_status: "not_started",
      pending_phone_number_failure_reason: null,
      telnyx_brand_id: null,
      brand_status: null,
      campaign_status: null,
      has_ein: true,
      legal_business_name: "Ready Business LLC",
      business_entity_type: "llc",
      business_registration_state: "IN",
      ein: "12-3456789",
      authorized_rep_name: "Test Owner",
      authorized_rep_title: "Owner",
      authorized_rep_email: "owner@example.test",
      authorized_rep_phone: "+15745550100",
      compliance_info_completed_at: "2026-07-24T00:00:00.000Z",
      use_case_description: "Customer care",
      estimated_monthly_volume: "under_1k",
      opt_in_description: "Website form",
      sample_messages: ["One", "Two", "Three"],
    },
    hours: Array.from({ length: 7 }, (_, day) => ({
      day: String(day),
      is_closed: false,
      open_time: "09:00",
      close_time: "17:00",
    })),
    services: [service("One"), service("Two"), service("Three")],
    faqs: [faq("One?"), faq("Two?"), faq("Three?")],
    aiSettings: {
      tone: "balanced",
      business_voice: "we",
      language: "en",
      response_delay_seconds: 5,
      web_greeting: "Hello",
      guardrails: "",
      booking_enabled: false,
      booking_mode: "collect_info",
    },
    phoneNumber: "+15745550101",
    activePhoneNumber: null,
    smsReady: false,
    riskCleared: true,
  } as unknown as Parameters<typeof deriveOnboardingStep>[0];
}

describe("deriveOnboardingStep 3+3 quality gate", () => {
  it("allows exactly three distinct services and FAQs to advance", () => {
    expect(deriveOnboardingStep(baseArgs())).toBe("review_submit");
  });

  it("returns an incomplete customer when services are below three", () => {
    const args = baseArgs();
    args.services = args.services.slice(0, 2);
    expect(deriveOnboardingStep(args)).toBe("services_faqs");
  });

  it("returns an incomplete customer when answered FAQs are below three", () => {
    const args = baseArgs();
    args.faqs = args.faqs.slice(0, 2);
    expect(deriveOnboardingStep(args)).toBe("services_faqs");
  });

  it("does not count normalized duplicates", () => {
    const args = baseArgs();
    args.services[2] = service("  ONE ");
    args.faqs[2] = faq(" one? ");
    expect(deriveOnboardingStep(args)).toBe("services_faqs");
  });

  it("returns deficient content ahead of an old phone-number failure", () => {
    const args = baseArgs();
    args.services = [];
    args.business.onboarding_registration_status = "failed";
    args.business.pending_phone_number_failure_reason = "Number unavailable";
    expect(deriveOnboardingStep(args)).toBe("services_faqs");
  });

  it("keeps genuine carrier-review customers ahead of the gate", () => {
    const args = baseArgs();
    args.services = [];
    args.faqs = [];
    args.business.telnyx_brand_id = "brand-1";
    expect(deriveOnboardingStep(args)).toBe("carrier_review");
  });

  it("keeps a submitted approved brand in carrier review without a number failure", () => {
    const args = baseArgs();
    args.business.telnyx_brand_id = "brand-1";
    args.business.brand_status = "approved";
    args.business.onboarding_registration_status = "submitted";

    expect(deriveOnboardingStep(args)).toBe("carrier_review");
  });

  it("keeps an approved-brand technical failure in carrier review without a number failure reason", () => {
    const args = baseArgs();
    args.business.telnyx_brand_id = "brand-1";
    args.business.brand_status = "approved";
    args.business.onboarding_registration_status = "failed";

    expect(deriveOnboardingStep(args)).toBe("carrier_review");
  });

  it("returns an approved-brand number failure to the phone-number picker", () => {
    const args = baseArgs();
    args.business.telnyx_brand_id = "brand-1";
    args.business.brand_status = "approved";
    args.business.onboarding_registration_status = "failed";
    args.business.pending_phone_number_failure_reason = "Number unavailable";

    expect(deriveOnboardingStep(args)).toBe("phone_number");
  });

  it("does not pull an active purchased number back into the picker", () => {
    const args = baseArgs();
    args.business.telnyx_brand_id = "brand-1";
    args.business.brand_status = "approved";
    args.business.onboarding_registration_status = "failed";
    args.business.pending_phone_number_failure_reason = "Stale number failure";
    args.activePhoneNumber = "+15745550101";

    expect(deriveOnboardingStep(args)).toBe("carrier_review");
  });

  it.each([
    {
      name: "SMS-ready",
      configure: (args: ReturnType<typeof baseArgs>) => {
        args.smsReady = true;
      },
    },
    {
      name: "completed",
      configure: (args: ReturnType<typeof baseArgs>) => {
        args.business.onboarding_completed_at = "2026-07-24T00:00:00.000Z";
      },
    },
  ])(
    "keeps a $name business complete despite a stale number failure",
    ({ configure }) => {
      const args = baseArgs();
      args.business.telnyx_brand_id = "brand-1";
      args.business.onboarding_registration_status = "failed";
      args.business.pending_phone_number_failure_reason = "Stale number failure";
      configure(args);

      expect(deriveOnboardingStep(args)).toBe("complete");
    }
  );

  it("keeps completed customers ahead of the gate", () => {
    const args = baseArgs();
    args.services = [];
    args.faqs = [];
    args.business.onboarding_completed_at = "2026-07-24T00:00:00.000Z";
    expect(deriveOnboardingStep(args)).toBe("complete");
  });
});

describe("deriveOnboardingStep explicit goal gate", () => {
  it("preserves prerequisite order for a null goal", () => {
    const missingBusinessInfo = baseArgs();
    missingBusinessInfo.business.primary_goal = null;
    missingBusinessInfo.business.name = null;

    const missingHours = baseArgs();
    missingHours.business.primary_goal = null;
    missingHours.hours = [];

    const missingContent = baseArgs();
    missingContent.business.primary_goal = null;
    missingContent.services = [];

    expect(deriveOnboardingStep(missingBusinessInfo)).toBe("business_info");
    expect(deriveOnboardingStep(missingHours)).toBe("business_hours");
    expect(deriveOnboardingStep(missingContent)).toBe("services_faqs");
  });

  it.each([
    {
      name: "completed",
      configure: (args: ReturnType<typeof baseArgs>) => {
        args.business.onboarding_completed_at =
          "2026-07-24T00:00:00.000Z";
      },
    },
    {
      name: "SMS-ready",
      configure: (args: ReturnType<typeof baseArgs>) => {
        args.smsReady = true;
      },
    },
    {
      name: "carrier-review",
      configure: (args: ReturnType<typeof baseArgs>) => {
        args.business.telnyx_brand_id = "brand-1";
      },
    },
  ])("forces a ready $name business with a null goal to AI Settings", ({ configure }) => {
    const args = baseArgs();
    args.business.primary_goal = null;
    configure(args);

    expect(deriveOnboardingStep(args)).toBe("ai_settings");
  });

  it("moves a completed SMS-ready gap-window business straight from the goal question to complete", () => {
    const args = baseArgs();
    args.business.primary_goal = null;
    args.business.onboarding_completed_at = "2026-07-24T00:00:00.000Z";
    args.smsReady = true;

    expect(deriveOnboardingStep(args)).toBe("ai_settings");

    args.business.primary_goal = "book";

    expect(deriveOnboardingStep(args)).toBe("complete");
  });

  it("moves a mid-funnel business from the goal question to its normally derived next step", () => {
    const args = baseArgs();
    args.business.primary_goal = null;
    args.business.compliance_info_completed_at = null;

    expect(deriveOnboardingStep(args)).toBe("ai_settings");

    args.business.primary_goal = "book";

    expect(deriveOnboardingStep(args)).toBe("sms_use_case");
  });

  const legacyCases = [
    {
      name: "completed",
      expected: "complete",
      configure: (args: ReturnType<typeof baseArgs>) => {
        args.business.onboarding_completed_at =
          "2026-07-24T00:00:00.000Z";
      },
    },
    {
      name: "SMS-ready",
      expected: "complete",
      configure: (args: ReturnType<typeof baseArgs>) => {
        args.smsReady = true;
      },
    },
    {
      name: "carrier-review",
      expected: "carrier_review",
      configure: (args: ReturnType<typeof baseArgs>) => {
        args.business.telnyx_brand_id = "brand-1";
      },
    },
    {
      name: "business info",
      expected: "business_info",
      configure: (args: ReturnType<typeof baseArgs>) => {
        args.business.name = null;
      },
    },
    {
      name: "business hours",
      expected: "business_hours",
      configure: (args: ReturnType<typeof baseArgs>) => {
        args.hours = [];
      },
    },
    {
      name: "services and FAQs",
      expected: "services_faqs",
      configure: (args: ReturnType<typeof baseArgs>) => {
        args.services = [];
      },
    },
    {
      name: "failed phone number",
      expected: "phone_number",
      configure: (args: ReturnType<typeof baseArgs>) => {
        args.business.onboarding_registration_status = "failed";
        args.business.pending_phone_number_failure_reason =
          "Number unavailable";
      },
    },
    {
      name: "AI settings",
      expected: "ai_settings",
      configure: (args: ReturnType<typeof baseArgs>) => {
        args.aiSettings = null;
      },
    },
    {
      name: "legal verification",
      expected: "legal_verification",
      configure: (args: ReturnType<typeof baseArgs>) => {
        args.business.has_ein = false;
      },
    },
    {
      name: "SMS use case",
      expected: "sms_use_case",
      configure: (args: ReturnType<typeof baseArgs>) => {
        args.business.compliance_info_completed_at = null;
      },
    },
    {
      name: "phone number",
      expected: "phone_number",
      configure: (args: ReturnType<typeof baseArgs>) => {
        args.phoneNumber = null;
      },
    },
    {
      name: "review",
      expected: "review_submit",
      configure: () => undefined,
    },
  ] as const;

  it.each(legacyCases)(
    "keeps the legacy $name result for an explicit book goal",
    ({ expected, configure }) => {
      const args = baseArgs();
      configure(args);

      expect(deriveOnboardingStep(args)).toBe(expected);
    }
  );

  it.each(["quote", "callback"] as const)(
    "keeps all legacy results unchanged for an explicit %s goal",
    (primaryGoal) => {
      for (const { expected, configure } of legacyCases) {
        const args = baseArgs();
        args.business.primary_goal = primaryGoal;
        configure(args);

        expect(deriveOnboardingStep(args)).toBe(expected);
      }
    }
  );
});

describe("deriveOnboardingStep Chat Only branch", () => {
  it.each([null, "book"] as const)(
    "requires an initial plan before any common setup with goal %s",
    (primaryGoal) => {
      const args = baseArgs();
      args.business.primary_goal = primaryGoal;
      args.business.name = null;
      args.hours = [];
      args.services = [];
      args.aiSettings = null;
      args.requiresDirectPlanSelection = true;
      args.planSelectionPosition = "start";

      expect(deriveOnboardingStep(args)).toBe("plan_selection");
    },
  );

  it("resumes saved content after changing from Chat to SMS", () => {
    const args = baseArgs();
    args.requiresDirectPlanSelection = true;
    args.planSelectionPosition = "start";
    args.effectivePlan = "sms_only";
    args.business.has_ein = null;

    expect(deriveOnboardingStep(args)).toBe("legal_verification");

    args.effectivePlan = "chat_only";
    expect(deriveOnboardingStep(args)).toBe("review_submit");
  });

  it("keeps common setup ahead of a legacy late plan choice", () => {
    const args = baseArgs();
    args.requiresDirectPlanSelection = true;
    args.planSelectionPosition = "after_knowledge";
    args.business.name = null;
    expect(deriveOnboardingStep(args)).toBe("business_info");

    args.business.name = "Ready Business";
    expect(deriveOnboardingStep(args)).toBe("plan_selection");
  });

  it("asks a new direct customer to choose a plan before AI settings", () => {
    const args = baseArgs();
    args.business.primary_goal = null;
    args.effectivePlan = null;
    args.requiresDirectPlanSelection = true;

    expect(deriveOnboardingStep(args)).toBe("plan_selection");
  });

  it("routes selected Chat Only directly from core setup to review", () => {
    const args = baseArgs();
    args.effectivePlan = "chat_only";
    args.chatOnlyAuthorityActive = false;
    args.phoneNumber = null;
    args.business.has_ein = null;
    args.business.legal_business_name = null;
    args.business.compliance_info_completed_at = null;

    expect(deriveOnboardingStep(args)).toBe("review_submit");
  });

  it("requires authoritative Chat Only activation before completion", () => {
    const args = baseArgs();
    args.effectivePlan = "chat_only";
    args.chatOnlyAuthorityActive = false;
    args.smsReady = true;
    args.business.onboarding_completed_at =
      "2026-07-24T00:00:00.000Z";

    expect(deriveOnboardingStep(args)).toBe("review_submit");

    args.chatOnlyAuthorityActive = true;
    expect(deriveOnboardingStep(args)).toBe("complete");
  });

  it("keeps core setup ahead of Chat Only activation", () => {
    const args = baseArgs();
    args.effectivePlan = "chat_only";
    args.chatOnlyAuthorityActive = true;
    args.services = [];

    expect(deriveOnboardingStep(args)).toBe("services_faqs");
  });
});
