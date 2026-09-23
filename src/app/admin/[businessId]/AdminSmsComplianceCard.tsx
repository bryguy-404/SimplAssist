"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { adminPhoneAssignmentRecheckResponseSchema } from "@/lib/admin/phoneAssignmentRecheck.shared";
import {
  bodyFaint,
  card,
  statusDanger,
  statusSuccess,
  statusWarning,
} from "@/lib/theme-v2/theme";
import type {
  A2pRiskReviewStatus,
  CampaignAssignmentStatus,
  OnboardingRegistrationStatus,
  RegistrationStatus,
} from "@/types/database";

export type CampaignMatchState = "yes" | "no" | "unavailable";

export type AdminSmsCompliancePhoneSnapshot = {
  directActiveCount: number;
  assignmentStatus: CampaignAssignmentStatus | null;
  assignmentUpdatedAt: string | null;
  campaignMatch: CampaignMatchState;
};

export type AdminSmsComplianceCardProps = {
  businessId: string;
  checkedAt: string;
  hasEin: boolean;
  operationsSuspended: boolean;
  submissionDisabled: boolean;
  riskReviewStatus: A2pRiskReviewStatus;
  riskInputCurrent: boolean;
  onboardingRegistrationStatus: OnboardingRegistrationStatus;
  registrationSubmissionStale: boolean;
  brandStatus: RegistrationStatus | null;
  campaignStatus: RegistrationStatus | null;
  healthActivePhoneCount: number;
  phoneSnapshot: AdminSmsCompliancePhoneSnapshot | null;
  paidTextingUpgradePending?: boolean;
};

type ComplianceBlocker = {
  priority: number;
  message: string;
  retryable: boolean;
};

export function AdminSmsComplianceCard(
  props: AdminSmsComplianceCardProps,
) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blocker = getAdminSmsComplianceBlocker(props);
  const countMatchesHealth =
    props.phoneSnapshot !== null &&
    props.phoneSnapshot.directActiveCount === props.healthActivePhoneCount;
  const retryCandidate =
    assignmentIsRetryCandidate(props.phoneSnapshot, props.checkedAt) ||
    canRecheckPaidTextingUpgrade(props);
  const actionEnabled =
    retryCandidate && blocker.retryable && countMatchesHealth;

  async function recheckAssignment() {
    if (!actionEnabled || submitting) return;

    setSubmitting(true);
    setNotice(null);
    setError(null);

    try {
      const response = await fetch(
        `/api/admin/businesses/${props.businessId}/assignment-recheck`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      const parsed = adminPhoneAssignmentRecheckResponseSchema.safeParse(payload);

      if (!response.ok || !parsed.success) {
        setError(
          response.ok
            ? "The server returned an invalid assignment-recheck result."
            : "The recheck did not complete. The request may have been recorded; refresh before retrying.",
        );
        return;
      }

      setNotice(
        "Assignment recheck request accepted. Status may remain unchanged until reconciliation completes.",
      );
      router.refresh();
    } catch {
      setError("Could not request an assignment recheck. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      className={`${card} p-4`}
      aria-labelledby="sms-compliance-heading"
    >
      <h2 id="sms-compliance-heading" className="text-lg font-semibold">
        SMS compliance
      </h2>
      <p className={`mt-1 text-sm ${bodyFaint}`}>
        Concierge view of the current registration and phone-assignment gates.
      </p>

      <dl className="mt-4 space-y-2 text-sm">
        <ComplianceRow label="EIN" value={props.hasEin ? "Present" : "Missing"} />
        <ComplianceRow
          label="Risk gate"
          value={riskGateLabel(
            props.riskReviewStatus,
            props.riskInputCurrent,
          )}
        />
        <ComplianceRow
          label="Brand"
          value={statusLabel(props.brandStatus, "Not submitted")}
        />
        <ComplianceRow
          label="Campaign"
          value={statusLabel(props.campaignStatus, "Not submitted")}
        />
        <ComplianceRow
          label="Assignment"
          value={assignmentLabel(props.phoneSnapshot)}
        />
        <ComplianceRow
          label="Campaign match"
          value={campaignMatchLabel(props.phoneSnapshot)}
        />
      </dl>

      <div
        className={`mt-4 rounded-2xl px-4 py-3 text-sm ${blockerTone(blocker)}`}
      >
        <p className="font-semibold">Current blocker</p>
        <p className="mt-1">{blocker.message}</p>
      </div>

      {notice ? (
        <p role="status" className={`mt-4 rounded-2xl px-4 py-3 text-sm ${statusSuccess}`}>
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={`mt-4 rounded-2xl px-4 py-3 text-sm ${statusDanger}`}>
          {error}
        </p>
      ) : null}

      <p className={`mt-4 text-xs ${bodyFaint}`}>
        Recheck assignment reconciles the current assignment against Telnyx. It
        may start an assignment only when Telnyx reports it missing. It does not
        resubmit the brand or campaign.
        {props.paidTextingUpgradePending
          ? " For a paid texting upgrade, an accepted recheck can also resume the existing upgrade after carrier corrections. It does not charge again."
          : null}
      </p>

      {retryCandidate ? (
        <Button
          type="button"
          variant="secondary"
          className="mt-4"
          loading={submitting}
          disabled={!actionEnabled}
          onClick={() => void recheckAssignment()}
        >
          Recheck assignment
        </Button>
      ) : null}
    </section>
  );
}

export function getAdminSmsComplianceBlocker(
  props: AdminSmsComplianceCardProps,
): ComplianceBlocker {
  if (props.operationsSuspended) {
    return blocker(1, "Account operations are suspended.");
  }
  if (!props.hasEin) {
    return blocker(2, "EIN is missing.");
  }
  if (props.submissionDisabled) {
    return blocker(3, "Telnyx submission is disabled.");
  }
  if (props.riskReviewStatus === "not_started") {
    return blocker(4, "Pre-submission risk screen has not started.");
  }
  if (!props.riskInputCurrent) {
    return blocker(4, "Pre-submission risk screen input is stale.");
  }
  if (!riskCleared(props.riskReviewStatus)) {
    return blocker(4, "Pre-submission risk screen is not cleared.");
  }
  const paidUpgradeRecovery = canRecheckPaidTextingUpgrade(props);
  if (
    props.onboardingRegistrationStatus === "failed" &&
    !paidUpgradeRecovery
  ) {
    return blocker(5, "Registration submission failed.");
  }
  if (props.registrationSubmissionStale) {
    return blocker(5, "Registration submission claim is stale.");
  }
  if (props.brandStatus !== "approved") {
    return blocker(
      6,
      props.brandStatus === "rejected"
        ? "Brand registration was rejected."
        : "Brand registration is not approved.",
    );
  }
  if (props.campaignStatus !== "approved") {
    return blocker(
      7,
      props.campaignStatus === "rejected"
        ? "Campaign registration was rejected."
        : "Campaign registration is not approved.",
    );
  }
  if (!props.phoneSnapshot) {
    return blocker(8, "Phone assignment details are unavailable.");
  }
  if (
    props.phoneSnapshot.directActiveCount !== props.healthActivePhoneCount
  ) {
    return blocker(
      8,
      "Active phone state is unavailable or inconsistent; assignment recheck is disabled.",
    );
  }
  if (props.phoneSnapshot.directActiveCount === 0) {
    return blocker(8, "No active phone is assigned.");
  }
  if (props.phoneSnapshot.directActiveCount !== 1) {
    return blocker(8, "Multiple active phones make assignment ambiguous.");
  }

  const assignmentStatus = props.phoneSnapshot.assignmentStatus;
  if (assignmentStatus === null || assignmentStatus === "unassigned") {
    return blocker(9, "Campaign assignment is missing.", paidUpgradeRecovery);
  }
  if (assignmentStatus === "failed") {
    return blocker(9, "Campaign assignment failed.", true);
  }
  if (assignmentStatus === "pending") {
    return pendingAssignmentIsRetryable(
      props.phoneSnapshot.assignmentUpdatedAt,
      props.checkedAt,
    )
      ? blocker(9, "Campaign assignment check is stale.", true)
      : blocker(9, "Campaign assignment is pending.");
  }
  if (props.phoneSnapshot.campaignMatch !== "yes") {
    return blocker(
      9,
      props.phoneSnapshot.campaignMatch === "no"
        ? "Campaign assignment does not match the approved campaign."
        : "Campaign assignment campaign is unavailable.",
    );
  }
  if (paidUpgradeRecovery) {
    return blocker(9, "Paid texting upgrade is waiting for a support recheck.", true);
  }
  return blocker(10, "No current blocker.");
}

function canRecheckPaidTextingUpgrade(
  props: AdminSmsComplianceCardProps,
): boolean {
  const phone = props.phoneSnapshot;
  if (
    !props.paidTextingUpgradePending ||
    props.brandStatus !== "approved" ||
    props.campaignStatus !== "approved" ||
    !phone ||
    phone.directActiveCount !== 1 ||
    props.healthActivePhoneCount !== 1
  ) return false;
  return (
    phone.assignmentStatus === "unassigned" ||
    (phone.assignmentStatus === "assigned" && phone.campaignMatch === "yes") ||
    assignmentIsRetryCandidate(phone, props.checkedAt)
  );
}

export function pendingAssignmentIsRetryable(
  assignmentUpdatedAt: string | null,
  checkedAt: string,
): boolean {
  if (assignmentUpdatedAt === null) return true;
  const assignmentTime = Date.parse(assignmentUpdatedAt);
  if (!Number.isFinite(assignmentTime)) return true;
  const checkedTime = Date.parse(checkedAt);
  if (!Number.isFinite(checkedTime)) return false;
  return checkedTime - assignmentTime >= 60_000;
}

export function assignmentIsRetryCandidate(
  snapshot: AdminSmsCompliancePhoneSnapshot | null,
  checkedAt: string,
): boolean {
  if (!snapshot || snapshot.directActiveCount !== 1) return false;
  if (snapshot.assignmentStatus === "failed") return true;
  return (
    snapshot.assignmentStatus === "pending" &&
    pendingAssignmentIsRetryable(snapshot.assignmentUpdatedAt, checkedAt)
  );
}

function blocker(
  priority: number,
  message: string,
  retryable = false,
): ComplianceBlocker {
  return { priority, message, retryable };
}

function riskCleared(status: A2pRiskReviewStatus): boolean {
  return status === "passed" || status === "admin_approved";
}

function riskGateLabel(
  status: A2pRiskReviewStatus,
  current: boolean,
): string {
  if (status === "not_started") return "Not started";
  if (!current) return "Stale";
  if (riskCleared(status)) return "Cleared";
  return statusLabel(status, "Not started");
}

function assignmentLabel(
  snapshot: AdminSmsCompliancePhoneSnapshot | null,
): string {
  if (!snapshot || snapshot.directActiveCount !== 1) return "Unavailable";
  return statusLabel(snapshot.assignmentStatus, "Missing");
}

function campaignMatchLabel(
  snapshot: AdminSmsCompliancePhoneSnapshot | null,
): "Yes" | "No" | "Unavailable" {
  if (!snapshot || snapshot.directActiveCount !== 1) return "Unavailable";
  if (snapshot.campaignMatch === "yes") return "Yes";
  if (snapshot.campaignMatch === "no") return "No";
  return "Unavailable";
}

function statusLabel(value: string | null, fallback: string): string {
  if (!value) return fallback;
  const words = value.replaceAll("_", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function blockerTone(value: ComplianceBlocker): string {
  if (value.priority === 10) return statusSuccess;
  if (value.retryable) return statusWarning;
  return statusDanger;
}

function ComplianceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className={bodyFaint}>{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}
