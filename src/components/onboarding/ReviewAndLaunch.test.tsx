import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { readFileSync } from "node:fs";
import type { RequestBrand } from "@/lib/branding/types";
import { PRIMARY_GOAL_COPY } from "@/lib/goals/primaryGoal";

vi.mock("@/components/onboarding/PlanSelectionOption", () => ({
  PlanSelectionOption: ({ plan }: { plan: { features: string[] } }) => (
    <div>Plan option: {plan.features.join(" | ")}</div>
  ),
}));

import { BrandProvider } from "@/components/branding/BrandProvider";
import ReviewAndLaunch, {
  buildOnboardingLaunchRequest,
  primaryLaunchButtonLabel,
  requestOnboardingLaunch,
} from "./ReviewAndLaunch";

const DEFAULT_REQUEST_BRAND: RequestBrand = {
  source: "default",
  isPreview: false,
  brand: {
    kind: "default",
    partnerId: null,
    slug: null,
    name: "SimplAssist",
    publicOrigin: "https://simplassist.com",
    logoLightUrl: "/logo-light.png",
    logoDarkUrl: "/logo-dark.png",
    faviconUrl: "/favicon-2.png",
    colors: {
      primary: "#ea580c",
      primaryHover: "#c2410c",
      primaryActive: "#9a3412",
      accent: "#c2410c",
      primaryDark: "#ff914d",
      primaryHoverDark: "#f57f33",
      primaryActiveDark: "#e8752c",
      accentDark: "#ff914d",
    },
  },
};

const PARTNER_REQUEST_BRAND: RequestBrand = {
  ...DEFAULT_REQUEST_BRAND,
  source: "partner_host",
  brand: {
    ...DEFAULT_REQUEST_BRAND.brand,
    kind: "partner",
    partnerId: "11111111-1111-4111-8111-111111111111",
    slug: "alpha-dog",
    name: "Alpha Dog Agency",
  },
};

type ReviewProps = ComponentProps<typeof ReviewAndLaunch>;

const registration: ReviewProps["registration"] = {
  status: "not_started",
  holdReason: null,
  startedAt: null,
  submittedAt: null,
  error: null,
  brandStatus: null,
  brandStatusUpdatedAt: null,
  brandRejectionReason: null,
  campaignStatus: null,
  campaignStatusUpdatedAt: null,
  campaignRejectionReason: null,
  assignmentStatus: null,
  assignmentFailureReason: null,
  smsReady: false,
  smsBlockReason: null,
  riskReview: {
    status: "not_started",
    storedStatus: null,
    inputHash: null,
    currentInputHash: null,
    message: null,
    reason: null,
    findings: [],
    checklistAnswer: null,
    checklistSelections: [],
    scannedAt: null,
    notifiedAt: null,
    reviewedAt: null,
    reviewedBy: null,
    overrideNote: null,
    registrationStarted: false,
  },
};

const baseProps: ReviewProps = {
  data: {
    businessInfo: {
      name: "Northstar Home Care",
      business_type: "general",
      phone: "+13175550199",
      address: "100 Main Street",
      city: "Indianapolis",
      state: "IN",
      zip: "46204",
    },
    businessHours: [],
    servicesCount: 1,
    faqsCount: 1,
    primaryGoal: null,
    goalUrl: null,
    aiSettings: {
      tone: "balanced",
      business_voice: "we",
      language: "en",
      response_delay_seconds: 0,
      web_greeting: "Hello",
      booking_enabled: false,
    },
    phoneNumber: null,
    brandVerification: null,
  },
  billing: {
    mode: "stripe",
    handledByName: null,
    plan: null,
    status: null,
    setupFeePaidAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
  },
  registration,
  pendingPhoneNumberFailureReason: null,
  onEditStep: vi.fn(),
  onBack: vi.fn(),
  onSubmitted: vi.fn(),
  onLaunchBlocked: vi.fn(),
};

function renderReview(
  requestBrand: RequestBrand,
  props: ReviewProps = baseProps
): string {
  return renderToStaticMarkup(
    <BrandProvider requestBrand={requestBrand}>
      <ReviewAndLaunch {...props} />
    </BrandProvider>
  );
}

function renderGoalReview(
  primaryGoal: ReviewProps["data"]["primaryGoal"],
  goalUrl: string | null
): string {
  return renderReview(DEFAULT_REQUEST_BRAND, {
    ...baseProps,
    data: {
      ...baseProps.data,
      primaryGoal,
      goalUrl,
    },
  });
}

const GOAL_ROW_PATTERN =
  /<div\b(?=[^>]*data-primary-goal-review-row="true")[^>]*>[\s\S]*?<\/div>/;

function goalRow(markup: string): string {
  const row = markup.match(GOAL_ROW_PATTERN)?.[0];
  if (!row) throw new Error("missing Goal review row");
  return row;
}

function withoutGoalRow(markup: string): string {
  return markup.replace(GOAL_ROW_PATTERN, "");
}

describe("ReviewAndLaunch visible brand copy", () => {
  it("preserves the default plan and number copy", () => {
    const html = renderReview(DEFAULT_REQUEST_BRAND);

    expect(html).toContain("Choose a SimplAssist plan");
    expect(html).toContain(
      "Choose a SimplAssist number before submitting SMS registration."
    );
    expect(html).toContain("One local SimplAssist number");
    expect(html.match(/Plan option:/g)).toHaveLength(3);
    expect(html).not.toContain("200 AI replies/month");
    expect(html).not.toContain("Chat Only");
  });

  it("uses the partner name in plan and number copy", () => {
    const html = renderReview(PARTNER_REQUEST_BRAND);

    expect(html).toContain("Choose an Alpha Dog Agency plan");
    expect(html).toContain(
      "Choose an Alpha Dog Agency number before submitting SMS registration."
    );
    expect(html).toContain("One local Alpha Dog Agency number");
    expect(html).not.toContain("SimplAssist");
  });

  it("uses the partner name in the paid setup support hold", () => {
    const html = renderReview(PARTNER_REQUEST_BRAND, {
      ...baseProps,
      billing: {
        ...baseProps.billing,
        plan: "sms_and_chat",
        status: "active",
      },
      registration: {
        ...registration,
        status: "failed",
        error: "SMS registration is disabled",
      },
    });

    expect(html).toContain(
      "SMS setup is paused. Contact Alpha Dog Agency support to continue."
    );
    expect(html).not.toContain("Contact SimplAssist support");
  });

  it("rebrands stored operational launch errors only for presentation", () => {
    const html = renderReview(PARTNER_REQUEST_BRAND, {
      ...baseProps,
      billing: {
        ...baseProps.billing,
        mode: "invoiced",
        plan: "sms_and_chat",
      },
      registration: {
        ...registration,
        status: "failed",
        error:
          "SimplAssist could not recheck your existing Telnyx brand right now.",
      },
    });

    expect(html).toContain(
      "Alpha Dog Agency could not recheck your existing Telnyx brand right now.",
    );
    expect(html).not.toContain(
      "SimplAssist could not recheck your existing Telnyx brand right now.",
    );
  });
});

describe("ReviewAndLaunch partner-managed billing", () => {
  it.each(["invoiced", "comped"] as const)(
    "renders assigned-partner billing and no Stripe purchase UI in %s mode",
    (mode) => {
      const html = renderReview(PARTNER_REQUEST_BRAND, {
        ...baseProps,
        data: {
          ...baseProps.data,
          phoneNumber: "+13175550123",
        },
        billing: {
          ...baseProps.billing,
          mode,
          handledByName: "Alpha Dog Agency",
        },
      });

      expect(html).toContain("Review &amp; Submit");
      expect(html).toContain("Billing is handled by Alpha Dog Agency.");
      expect(html).toContain("Submit SMS registration");
      expect(html).not.toContain("Plan option");
      expect(html).not.toContain("Plan &amp; Setup Fee");
      expect(html).not.toContain("Review &amp; Pay");
      expect(html).not.toContain("Opening checkout");
      expect(html).not.toContain("Pay &amp; submit");
      expect(html).not.toContain("one-time setup");
      expect(html).not.toContain("charged");
      expect(html).not.toContain("Choose an Alpha Dog Agency plan");
    }
  );

  it("uses the exact external fallback for an orphaned assignment", () => {
    const html = renderReview(DEFAULT_REQUEST_BRAND, {
      ...baseProps,
      data: {
        ...baseProps.data,
        phoneNumber: "+13175550123",
      },
      billing: {
        ...baseProps.billing,
        mode: "invoiced",
        handledByName: null,
      },
    });

    expect(html).toContain("Billing is managed externally.");
    expect(html).not.toContain("Billing is handled by");
  });

  it("keeps launch holds authoritative without showing payment controls", () => {
    const html = renderReview(PARTNER_REQUEST_BRAND, {
      ...baseProps,
      data: {
        ...baseProps.data,
        phoneNumber: "+13175550123",
      },
      billing: {
        ...baseProps.billing,
        mode: "comped",
        handledByName: "Alpha Dog Agency",
      },
      registration: {
        ...registration,
        holdReason: "held_no_ein",
      },
    });

    expect(html).toContain("Add your EIN before SMS setup can continue.");
    expect(html).toContain("Add your EIN");
    expect(html).not.toContain("Submit SMS registration</button>");
    expect(html).not.toContain("checkout");
    expect(html).not.toContain("charged");
  });
});

describe("buildOnboardingLaunchRequest", () => {
  it.each(["invoiced", "comped"] as const)(
    "posts %s onboarding directly to submit-registration",
    (billingMode) => {
      const request = buildOnboardingLaunchRequest({
        billingMode,
        plan: "sms_and_chat",
      });

      expect(request).toEqual({
        url: "/api/onboarding/submit-registration",
        init: { method: "POST" },
      });
      expect(request.url).not.toContain("checkout");
    }
  );

  it("preserves the Stripe onboarding checkout request", () => {
    expect(
      buildOnboardingLaunchRequest({
        billingMode: "stripe",
        plan: "sms_only",
      })
    ).toEqual({
      url: "/api/billing/checkout",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "sms_only", mode: "onboarding" }),
      },
    });
  });

  it("builds Chat Only as direct Stripe onboarding with no SMS endpoint", () => {
    const request = buildOnboardingLaunchRequest({
      billingMode: "stripe",
      plan: "chat_only",
    });

    expect(request.url).toBe("/api/billing/checkout");
    expect(request.init.body).toBe(
      JSON.stringify({ plan: "chat_only", mode: "onboarding" }),
    );
  });

  it.each(["invoiced", "comped"] as const)(
    "fails closed before any SMS launch for partner Chat Only in %s mode",
    (billingMode) => {
      const fetcher = vi.fn();

      expect(() =>
        requestOnboardingLaunch(
          { billingMode, plan: "chat_only" },
          fetcher,
        ),
      ).toThrow("partner_chat_only_requires_no_sms_launch");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each(["invoiced", "comped"] as const)(
    "calls submit-registration instead of checkout for %s onboarding",
    async (billingMode) => {
      const fetcher = vi.fn(async () => new Response(null, { status: 200 }));

      await requestOnboardingLaunch(
        { billingMode, plan: "sms_and_chat" },
        fetcher
      );

      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledWith(
        "/api/onboarding/submit-registration",
        { method: "POST" }
      );
      expect(fetcher).not.toHaveBeenCalledWith(
        expect.stringContaining("checkout"),
        expect.anything()
      );
    }
  );

  it("shows billing recovery instead of a new checkout for incomplete past-due Chat Only", () => {
    const markup = renderReview(DEFAULT_REQUEST_BRAND, {
      ...baseProps,
      effectivePlan: "chat_only",
      chatOnly: true,
      chatOnlyCheckoutPaused: true,
      billing: {
        ...baseProps.billing,
        plan: "chat_only",
        status: "past_due",
      },
    });

    expect(markup).toContain("Payment needs attention");
    expect(markup).toContain("Manage billing");
    expect(markup).not.toContain("Pay $10");
    expect(markup).not.toContain("due today");
    expect(markup).not.toContain("launch web chat");
    expect(markup).not.toContain("Phone Number");
  });
});

describe("ReviewAndLaunch Chat Only review", () => {
  it("explains a locked family choice without suggesting that checkout charged the customer", () => {
    const markup = renderReview(DEFAULT_REQUEST_BRAND, {
      ...baseProps,
      effectivePlan: "chat_only",
      chatOnly: true,
      familyChangeRequiresSupport: true,
    });

    expect(markup).toContain("Switching between Chat Only and texting requires support for this account.");
    expect(markup).toContain('href="/support?category=billing"');
    expect(markup).not.toContain("Payment is complete");
    expect(markup).toContain("Pay $10");
  });

  it("omits every SMS/setup surface even when stale carrier data exists", () => {
    const markup = renderReview(DEFAULT_REQUEST_BRAND, {
      ...baseProps,
      effectivePlan: "chat_only",
      chatOnly: true,
      canEditPlan: true,
      onEditPlan: vi.fn(),
      data: {
        ...baseProps.data,
        phoneNumber: "+13175550123",
        brandVerification: {
          legal_business_name: "Stale Carrier LLC",
          business_entity_type: "llc",
          ein: "12-3456789",
          use_case_description: "Stale SMS campaign",
          estimated_monthly_volume: "under_1k",
          sample_messages: ["One", "Two", "Three"],
        },
      },
    });

    expect(markup).toContain("Chat Only Plan");
    expect(markup).toContain("$10/month · 200 AI replies/month");
    expect(markup).toContain("$10 due today");
    expect(markup).toContain("Pay $10 &amp; launch web chat");
    expect(markup).not.toContain("SMS");
    expect(markup).not.toContain("carrier");
    expect(markup).not.toContain("Phone Number");
    expect(markup).not.toContain("Business Verification");
    expect(markup).not.toContain("EIN");
    expect(markup).not.toContain("Response Delay");
    expect(markup).not.toContain("$25");
    expect(markup.toLowerCase()).not.toContain("setup");
  });

  it.each([
    ["unpaid family lock", null],
    ["canceled subscription", "canceled"],
  ] as const)(
    "shows a neutral support hold with no payment action for %s",
    (_label, status) => {
      const markup = renderReview(DEFAULT_REQUEST_BRAND, {
        ...baseProps,
        effectivePlan: "chat_only",
        chatOnly: true,
        chatOnlyCheckoutPaused: true,
        billing: {
          ...baseProps.billing,
          plan: status ? "chat_only" : null,
          status,
        },
      });

      expect(markup).toContain("Chat Only checkout paused");
      expect(markup).toContain("Your Chat Only selection is safely saved");
      expect(markup).toContain("no phone or texting setup will start");
      expect(markup).toContain("Checkout is temporarily paused");
      expect(markup).toContain('href="/support?category=billing"');
      expect(markup).not.toContain("Pay $10");
      expect(markup).not.toContain("$10 due today");
      expect(markup).not.toContain("launch web chat");
      const planSection = markup.slice(
        markup.indexOf("Chat Only Plan"),
        markup.indexOf("Business Info"),
      );
      expect(planSection).not.toContain(">Edit<");
    },
  );

  it.each(["active", "trialing"] as const)(
    "finishes already-paid %s Chat Only without purchase copy",
    (status) => {
      const markup = renderReview(DEFAULT_REQUEST_BRAND, {
        ...baseProps,
        effectivePlan: "chat_only",
        chatOnly: true,
        chatOnlyCheckoutPaused: true,
        billing: {
          ...baseProps.billing,
          plan: "chat_only",
          status,
        },
      });

      expect(markup).toContain("Finish Chat Only setup");
      expect(markup).toContain("Payment is complete");
      expect(markup).toContain("without another charge");
      expect(markup).not.toContain("Pay $10");
      expect(markup).not.toContain("due today");
      expect(markup).not.toContain("Review &amp; Pay");
    },
  );

  it("uses finalization—not checkout—loading language for paid Chat Only", () => {
    expect(
      primaryLaunchButtonLabel({
        data: baseProps.data,
        isPaidSubscription: true,
        isPartnerManaged: false,
        launchHold: null,
        launching: true,
        isChatOnly: true,
      }),
    ).toBe("Finishing Chat Only setup...");
  });

  it.each(["invoiced", "comped"] as const)(
    "holds partner Chat Only for external activation with no pay or SMS action in %s mode",
    (mode) => {
      const markup = renderReview(PARTNER_REQUEST_BRAND, {
        ...baseProps,
        effectivePlan: "chat_only",
        chatOnly: true,
        billing: {
          ...baseProps.billing,
          mode,
          handledByName: "Alpha Dog Agency",
        },
      });

      expect(markup).toContain("Chat setup pending");
      expect(markup).toContain("Billing is handled by Alpha Dog Agency.");
      expect(markup).toContain("Waiting for partner activation");
      expect(markup).not.toContain("Pay $10");
      expect(markup).not.toContain("Stripe checkout");
      expect(markup).not.toContain("Submit SMS registration");
      expect(markup).not.toContain("Phone Number");
    },
  );
});

describe("ReviewAndLaunch goal row", () => {
  it("shows the exact book label without the retained URL", () => {
    const retainedUrl = "https://example.com/Retained?Camp=Summer#Form";
    const markup = renderGoalReview("book", retainedUrl);
    const row = goalRow(markup);

    expect(row).toContain(">Goal</span>");
    expect(row).toContain(PRIMARY_GOAL_COPY.options.book);
    expect(row).not.toContain(retainedUrl);
    expect(markup).not.toContain(retainedUrl);
  });

  it("shows the exact signup label with the raw saved URL directly beneath it", () => {
    const savedUrl = "https://example.com/Path?Camp=Summer#SignUp";
    const row = goalRow(renderGoalReview("signup", savedUrl));

    expect(row).toContain(PRIMARY_GOAL_COPY.options.signup);
    expect(row).toContain(savedUrl);
    expect(row.indexOf(PRIMARY_GOAL_COPY.options.signup)).toBeLessThan(
      row.indexOf(savedUrl)
    );
  });

  it("places Goal before Tone and keeps the AI Personality edit target at step 4", () => {
    const markup = renderGoalReview("book", null);
    const row = goalRow(markup);
    const source = readFileSync(
      new URL("./ReviewAndLaunch.tsx", import.meta.url),
      "utf8"
    );

    expect(markup.indexOf(row)).toBeLessThan(markup.indexOf(">Tone</span>"));
    expect(source).toContain(
      '<Section title="AI Personality" onEdit={() => onEditStep(4)}>'
    );
  });

  it.each([
    ["book", "https://example.com/retained"],
    ["signup", "https://example.com/signup"],
  ] as const)(
    "changes only the new Goal row for %s review markup",
    (primaryGoal, goalUrl) => {
      const nullMarkup = renderGoalReview(null, null);
      const goalMarkup = renderGoalReview(primaryGoal, goalUrl);

      expect(withoutGoalRow(goalMarkup)).toBe(nullMarkup);
    }
  );

  it.each(["quote", "callback"] as const)(
    "keeps legacy %s review markup byte-identical to NULL",
    (primaryGoal) => {
      const nullMarkup = renderGoalReview(null, null);
      const legacyMarkup = renderGoalReview(
        primaryGoal,
        "https://example.com/legacy"
      );

      expect(legacyMarkup).toBe(nullMarkup);
      expect(legacyMarkup).not.toContain(
        'data-primary-goal-review-row="true"'
      );
    }
  );
});
