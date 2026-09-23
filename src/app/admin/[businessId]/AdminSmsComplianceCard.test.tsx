import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdminSmsComplianceCard,
  getAdminSmsComplianceBlocker,
  pendingAssignmentIsRetryable,
  type AdminSmsComplianceCardProps,
} from "./AdminSmsComplianceCard";

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));

const BUSINESS_ID = "10000000-0000-4000-a049-000000000001";
const CHECKED_AT = "2026-08-05T12:01:00.000Z";

function props(
  overrides: Partial<AdminSmsComplianceCardProps> = {},
): AdminSmsComplianceCardProps {
  return {
    businessId: BUSINESS_ID,
    checkedAt: CHECKED_AT,
    hasEin: true,
    operationsSuspended: false,
    submissionDisabled: false,
    riskReviewStatus: "passed",
    riskInputCurrent: true,
    onboardingRegistrationStatus: "submitted",
    registrationSubmissionStale: false,
    brandStatus: "approved",
    campaignStatus: "approved",
    healthActivePhoneCount: 1,
    phoneSnapshot: {
      directActiveCount: 1,
      assignmentStatus: "assigned",
      assignmentUpdatedAt: "2026-08-05T12:00:00.000Z",
      campaignMatch: "yes",
    },
    ...overrides,
  };
}

function render(value: AdminSmsComplianceCardProps = props()): string {
  return renderToStaticMarkup(<AdminSmsComplianceCard {...value} />);
}

function source(): string {
  return readFileSync(
    new URL("./AdminSmsComplianceCard.tsx", import.meta.url),
    "utf8",
  );
}

describe("AdminSmsComplianceCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the concierge compliance facts without provider identifiers", () => {
    const html = render();

    expect(html).toContain("SMS compliance");
    expect(html).toContain("EIN</dt><dd");
    expect(html).toContain(">Present</dd>");
    expect(html).toContain("Risk gate</dt><dd");
    expect(html).toContain(">Cleared</dd>");
    expect(html).toContain("Brand</dt><dd");
    expect(html).toContain(">Approved</dd>");
    expect(html).toContain("Campaign match</dt><dd");
    expect(html).toContain(">Yes</dd>");
    expect(html).toContain("No current blocker.");
    expect(html).not.toContain(BUSINESS_ID);
  });

  it.each([
    [
      "account suspension",
      {
        operationsSuspended: true,
        hasEin: false,
        submissionDisabled: true,
      },
      1,
      "Account operations are suspended.",
    ],
    [
      "missing EIN",
      { hasEin: false, submissionDisabled: true },
      2,
      "EIN is missing.",
    ],
    [
      "submission kill switch",
      { submissionDisabled: true, riskInputCurrent: false },
      3,
      "Telnyx submission is disabled.",
    ],
    [
      "stale risk input",
      {
        riskInputCurrent: false,
        onboardingRegistrationStatus: "failed" as const,
      },
      4,
      "Pre-submission risk screen input is stale.",
    ],
    [
      "registration failure",
      {
        onboardingRegistrationStatus: "failed" as const,
        brandStatus: "rejected" as const,
      },
      5,
      "Registration submission failed.",
    ],
    [
      "brand approval",
      {
        brandStatus: "pending" as const,
        campaignStatus: "rejected" as const,
      },
      6,
      "Brand registration is not approved.",
    ],
    [
      "campaign approval",
      {
        campaignStatus: "pending" as const,
        healthActivePhoneCount: 0,
        phoneSnapshot: {
          directActiveCount: 0,
          assignmentStatus: null,
          assignmentUpdatedAt: null,
          campaignMatch: "unavailable" as const,
        },
      },
      7,
      "Campaign registration is not approved.",
    ],
    [
      "phone count disagreement",
      {
        healthActivePhoneCount: 2,
        phoneSnapshot: {
          directActiveCount: 1,
          assignmentStatus: "failed" as const,
          assignmentUpdatedAt: null,
          campaignMatch: "yes" as const,
        },
      },
      8,
      "Active phone state is unavailable or inconsistent; assignment recheck is disabled.",
    ],
    [
      "assignment failure",
      {
        phoneSnapshot: {
          directActiveCount: 1,
          assignmentStatus: "failed" as const,
          assignmentUpdatedAt: null,
          campaignMatch: "yes" as const,
        },
      },
      9,
      "Campaign assignment failed.",
    ],
  ])(
    "uses fixed blocker priority for %s collisions",
    (_name, overrides, priority, message) => {
      const result = getAdminSmsComplianceBlocker(props(overrides));

      expect(result.priority).toBe(priority);
      expect(result.message).toBe(message);
    },
  );

  it("keeps risk hold ahead of registration, brand, and campaign failures", () => {
    const result = getAdminSmsComplianceBlocker(
      props({
        riskReviewStatus: "blocked",
        onboardingRegistrationStatus: "failed",
        brandStatus: "rejected",
        campaignStatus: "rejected",
      }),
    );

    expect(result).toMatchObject({
      priority: 4,
      message: "Pre-submission risk screen is not cleared.",
      retryable: false,
    });
  });

  it("labels a never-screened account as not started rather than stale", () => {
    const value = props({
      riskReviewStatus: "not_started",
      riskInputCurrent: false,
    });

    expect(getAdminSmsComplianceBlocker(value)).toMatchObject({
      priority: 4,
      message: "Pre-submission risk screen has not started.",
      retryable: false,
    });
    const html = render(value);
    expect(html).toContain("Risk gate</dt><dd");
    expect(html).toContain(">Not started</dd>");
    expect(html).not.toContain(">Stale</dd>");
  });

  it("treats only failed or stale/unknown pending assignments as retryable", () => {
    expect(pendingAssignmentIsRetryable(null, CHECKED_AT)).toBe(true);
    expect(pendingAssignmentIsRetryable("not-a-time", CHECKED_AT)).toBe(true);
    expect(
      pendingAssignmentIsRetryable(
        "2026-08-05T12:00:00.000Z",
        CHECKED_AT,
      ),
    ).toBe(true);
    expect(
      pendingAssignmentIsRetryable(
        "2026-08-05T12:00:00.001Z",
        CHECKED_AT,
      ),
    ).toBe(false);
    expect(
      getAdminSmsComplianceBlocker(
        props({
          phoneSnapshot: {
            directActiveCount: 1,
            assignmentStatus: "failed",
            assignmentUpdatedAt: CHECKED_AT,
            campaignMatch: "yes",
          },
        }),
      ).retryable,
    ).toBe(true);
    expect(
      getAdminSmsComplianceBlocker(
        props({
          phoneSnapshot: {
            directActiveCount: 1,
            assignmentStatus: "assigned",
            assignmentUpdatedAt: CHECKED_AT,
            campaignMatch: "no",
          },
        }),
      ).retryable,
    ).toBe(false);
  });

  it.each([
    ["failed", "failed" as const, CHECKED_AT],
    ["pending without a timestamp", "pending" as const, null],
    ["pending with an invalid timestamp", "pending" as const, "not-a-time"],
    [
      "pending at the sixty-second boundary",
      "pending" as const,
      "2026-08-05T12:00:00.000Z",
    ],
  ])("renders the action for %s", (_name, assignmentStatus, updatedAt) => {
    const html = render(
      props({
        phoneSnapshot: {
          directActiveCount: 1,
          assignmentStatus,
          assignmentUpdatedAt: updatedAt,
          campaignMatch: "yes",
        },
      }),
    );

    expect(html).toContain(">Recheck assignment</button>");
  });

  it.each([
    [
      "fresh pending",
      "pending" as const,
      "2026-08-05T12:00:00.001Z",
    ],
    ["assigned", "assigned" as const, CHECKED_AT],
    ["unassigned", "unassigned" as const, null],
  ])("omits the action for %s", (_name, assignmentStatus, updatedAt) => {
    const html = render(
      props({
        phoneSnapshot: {
          directActiveCount: 1,
          assignmentStatus,
          assignmentUpdatedAt: updatedAt,
          campaignMatch: "yes",
        },
      }),
    );

    expect(html).not.toContain("Recheck assignment</button>");
  });

  it("enables the exact action only when a retryable assignment is the current blocker", () => {
    const enabled = render(
      props({
        phoneSnapshot: {
          directActiveCount: 1,
          assignmentStatus: "failed",
          assignmentUpdatedAt: null,
          campaignMatch: "no",
        },
      }),
    );
    const suspended = render(
      props({
        operationsSuspended: true,
        phoneSnapshot: {
          directActiveCount: 1,
          assignmentStatus: "failed",
          assignmentUpdatedAt: null,
          campaignMatch: "yes",
        },
      }),
    );

    expect(enabled).toMatch(
      /<button(?![^>]*disabled="")[^>]*>Recheck assignment<\/button>/,
    );
    expect(suspended).toMatch(
      /<button(?=[^>]*disabled="")[^>]*>Recheck assignment<\/button>/,
    );
  });

  it.each(["assigned", "unassigned", "failed"] as const)(
    "allows audited paid-upgrade recovery for %s after carrier correction",
    (assignmentStatus) => {
      const value = props({
        paidTextingUpgradePending: true,
        onboardingRegistrationStatus: "failed",
        phoneSnapshot: {
          directActiveCount: 1,
          assignmentStatus,
          assignmentUpdatedAt: CHECKED_AT,
          campaignMatch: assignmentStatus === "unassigned" ? "unavailable" : "yes",
        },
      });
      expect(getAdminSmsComplianceBlocker(value).retryable).toBe(true);
      expect(render(value)).toMatch(
        /<button(?![^>]*disabled="")[^>]*>Recheck assignment<\/button>/,
      );
      expect(render(value)).toContain("It does not charge again.");
    },
  );

  it.each([
    { operationsSuspended: true },
    { submissionDisabled: true },
    { riskInputCurrent: false },
    { riskReviewStatus: "blocked" as const },
    { brandStatus: "pending" as const },
    { campaignStatus: "rejected" as const },
    { healthActivePhoneCount: 2 },
    { phoneSnapshot: null },
    { registrationSubmissionStale: true },
    {
      phoneSnapshot: {
        directActiveCount: 1,
        assignmentStatus: "assigned" as const,
        assignmentUpdatedAt: CHECKED_AT,
        campaignMatch: "no" as const,
      },
    },
  ])("does not bypass a current prerequisite for paid-upgrade recovery: %j", (overrides) => {
    const value = props({
      paidTextingUpgradePending: true,
      onboardingRegistrationStatus: "failed",
      ...overrides,
    });
    expect(getAdminSmsComplianceBlocker(value).retryable).toBe(false);
    expect(render(value)).not.toMatch(
      /<button(?![^>]*disabled="")[^>]*>Recheck assignment<\/button>/,
    );
  });

  it("fails closed without exposing partial phone detail when the query is unavailable", () => {
    const html = render(props({ phoneSnapshot: null }));

    expect(html).toContain("Phone assignment details are unavailable.");
    expect(html).toContain("Assignment</dt><dd");
    expect(html).toContain(">Unavailable</dd>");
    expect(html).not.toContain("Recheck assignment</button>");
  });

  it("renders campaign match as No or Unavailable without rendering either ID", () => {
    const mismatch = render(
      props({
        phoneSnapshot: {
          directActiveCount: 1,
          assignmentStatus: "assigned",
          assignmentUpdatedAt: CHECKED_AT,
          campaignMatch: "no",
        },
      }),
    );
    const unavailable = render(
      props({
        phoneSnapshot: {
          directActiveCount: 1,
          assignmentStatus: "assigned",
          assignmentUpdatedAt: CHECKED_AT,
          campaignMatch: "unavailable",
        },
      }),
    );

    expect(mismatch).toContain(">No</dd>");
    expect(unavailable).toContain(">Unavailable</dd>");
  });

  it("posts strict empty JSON and validates strict acceptance without claiming provider success", () => {
    const componentSource = source();

    expect(componentSource).toContain(
      "`/api/admin/businesses/${props.businessId}/assignment-recheck`",
    );
    expect(componentSource).toContain("body: JSON.stringify({})");
    expect(componentSource).toContain(
      "adminPhoneAssignmentRecheckResponseSchema.safeParse(payload)",
    );
    expect(componentSource).toContain("!response.ok || !parsed.success");
    expect(componentSource).toContain(
      "The request may have been recorded; refresh before retrying.",
    );
    expect(componentSource).not.toContain(
      "The assignment recheck was not accepted.",
    );
    expect(componentSource).toContain(
      "Assignment recheck request accepted.",
    );
    expect(componentSource).toContain(
      "Status may remain unchanged until reconciliation completes.",
    );
    expect(componentSource).toContain("router.refresh()");
    expect(componentSource).toContain(
      "may start an assignment only when Telnyx reports it missing",
    );
    expect(componentSource).toContain(
      "It does not\n        resubmit the brand or campaign.",
    );
    expect(componentSource).not.toContain("assignment succeeded");
  });

  it("keeps phone numbers, provider failures, EIN values, and campaign IDs out of the client boundary", () => {
    const componentSource = source();

    expect(componentSource).not.toContain("phone_number");
    expect(componentSource).not.toContain("failure_reason");
    expect(componentSource).not.toContain("telnyx_campaign_id");
    expect(componentSource).not.toContain("assignment_campaign_id");
    expect(componentSource).not.toMatch(/\bein\s*:/i);
  });
});
