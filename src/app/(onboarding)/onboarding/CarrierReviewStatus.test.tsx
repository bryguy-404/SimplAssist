import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { OnboardingState } from "@/lib/onboarding/types";
import { REJECTION_SUPPORT_MESSAGE } from "@/lib/onboarding/rejectionGuidance";

vi.mock("@/components/branding/BrandProvider", () => ({
  useBrand: () => ({ name: "SimplAssist" }),
}));

import { CarrierReviewStatus } from "./CarrierReviewStatus";

function stateWithRejection(args: {
  brandStatus: "pending" | "approved" | "rejected" | null;
  campaignStatus: "pending" | "approved" | "rejected" | null;
  brandReason?: string | null;
  campaignReason?: string | null;
  status?: "failed" | "submitted";
  smsReady?: boolean;
  error?: string | null;
  assignmentFailureReason?: string | null;
  holdReason?: "held_no_ein" | null;
}): OnboardingState {
  return {
    businessId: "business-1",
    billing: { plan: "full" },
    registration: {
      status: args.status ?? "failed",
      holdReason: args.holdReason ?? null,
      startedAt: null,
      submittedAt: null,
      error: args.error ?? null,
      brandStatus: args.brandStatus,
      brandStatusUpdatedAt: null,
      brandRejectionReason: args.brandReason ?? null,
      campaignStatus: args.campaignStatus,
      campaignStatusUpdatedAt: null,
      campaignRejectionReason: args.campaignReason ?? null,
      assignmentStatus: null,
      assignmentFailureReason: args.assignmentFailureReason ?? null,
      smsReady: args.smsReady ?? false,
      smsBlockReason: null,
      riskReview: {
        registrationStarted: true,
      },
    },
  } as unknown as OnboardingState;
}

function render(state: OnboardingState): string {
  return renderToStaticMarkup(
    <CarrierReviewStatus
      state={state}
      onStatusRefreshed={() => undefined}
      onRetry={() => undefined}
      onDashboard={() => undefined}
    />
  );
}

describe("CarrierReviewStatus rejection actions", () => {
  it("explains the business verification wait without a retry or failure alert", () => {
    const state = stateWithRejection({ brandStatus: "pending", campaignStatus: null, status: "submitted" });
    state.registration.awaitingCampaignSubmission = true;
    const html = render(state);
    expect(html).toContain("Business verification is in progress");
    expect(html).toContain("continue SMS registration automatically");
    expect(html).toContain("Voice answering stays off until you enable it");
    expect(html).not.toContain("Registration needs another try");
    expect(html).not.toContain("Retry registration");
  });
  it.each([
    [
      "brand-only",
      stateWithRejection({
        brandStatus: "rejected",
        campaignStatus: null,
        brandReason: "Carrier brand reason 808",
      }),
      ["Carrier brand reason 808"],
    ],
    [
      "campaign-only",
      stateWithRejection({
        brandStatus: "approved",
        campaignStatus: "rejected",
        campaignReason: "Carrier campaign reason 708",
      }),
      ["Carrier campaign reason 708"],
    ],
    [
      "dual",
      stateWithRejection({
        brandStatus: "rejected",
        campaignStatus: "rejected",
        brandReason: "Carrier brand reason 810",
        campaignReason: "Carrier campaign reason 861",
        status: "submitted",
      }),
      ["Carrier brand reason 810", "Carrier campaign reason 861"],
    ],
  ])(
    "shows only registration support for a %s rejection",
    (_label, state, reasons) => {
      const html = render(state);

      for (const reason of reasons) expect(html).toContain(reason);
      expect(html).toContain(
        'href="/support?category=number_registration"'
      );
      expect(html.match(/<a\b/g)).toHaveLength(1);
      expect(html).toContain("Contact support");
      expect(html).not.toContain("Refresh status");
      expect(html).not.toContain("Fix &amp; resubmit");
      expect(html).not.toContain("Retry registration");
    }
  );

  it("preserves refresh and retry for a non-rejection technical failure", () => {
    const html = render(
      stateWithRejection({
        brandStatus: "pending",
        campaignStatus: null,
      })
    );

    expect(html).toContain("Refresh status");
    expect(html).toContain("Retry registration");
    expect(html).not.toContain("Contact support");
  });

  it("uses one primary support action even for unclassified carrier wording", () => {
    const html = render(
      stateWithRejection({
        brandStatus: "approved",
        campaignStatus: "rejected",
        campaignReason: "Provider response QX-42",
      })
    );

    expect(html).toContain("Provider response QX-42");
    expect(html.match(/<a\b/g)).toHaveLength(1);
    expect(html).not.toContain("Refresh status");
    expect(html).not.toContain("Retry registration");
  });

  it("lets a carrier rejection outrank a legacy No-EIN hold", () => {
    const html = render(
      stateWithRejection({
        brandStatus: "rejected",
        campaignStatus: null,
        brandReason: "Carrier brand reason 808",
        holdReason: "held_no_ein",
      })
    );

    expect(html).toContain("Registration needs support");
    expect(html).toContain(REJECTION_SUPPORT_MESSAGE);
    expect(html).toContain("Contact support");
    expect(html).not.toContain("Add your EIN to continue");
    expect(html).not.toContain("SMS setup is paused until you add an EIN");
  });

  it("lets active SMS outrank obsolete rejection data", () => {
    const html = render(
      stateWithRejection({
        brandStatus: "approved",
        campaignStatus: "rejected",
        campaignReason: "Obsolete carrier rejection",
        status: "submitted",
        smsReady: true,
        error: "Obsolete registration error",
        assignmentFailureReason: "Obsolete assignment error",
      })
    );

    expect(html).toContain("SMS is active");
    expect(html).toContain("Go to dashboard");
    expect(html).not.toContain("Registration needs support");
    expect(html).not.toContain("Contact support");
    expect(html).not.toContain("Obsolete registration error");
    expect(html).not.toContain("Obsolete assignment error");
  });
});
