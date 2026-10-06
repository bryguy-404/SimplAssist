"use client";

import { useRef, useState } from "react";
import { z } from "zod";
import {
  btnPrimaryCompact,
  btnSecondaryCompact,
  statusDanger,
  statusSuccess,
  statusWarning,
  tile,
} from "@/lib/theme-v2/theme";

export type SharedRegistrationAccounts = {
  sourceBusinessId: string;
  targetBusinessId: string;
  sourceOwnerId: string;
  targetOwnerId: string;
};

const inspectionSchema = z.object({
  sourceBusinessId: z.string().uuid(),
  targetBusinessId: z.string().uuid(),
  targetBusinessName: z.string(),
  legalBusinessName: z.string(),
  tcrBrandId: z.string().min(1),
  campaignCount: z.number().int().nonnegative(),
  verifiedAt: z.string().datetime(),
  membershipRevision: z.number().int().nonnegative(),
  canApprove: z.boolean(),
});
type Inspection = z.infer<typeof inspectionSchema>;
type Action = { action: "inspect" } | { action: "approve"; expectedRevision: number };

/** Uses the admin session; the server derives the actor and revalidates owners. */
export async function requestSharedRegistration(
  accounts: SharedRegistrationAccounts,
  action: Action,
  fetcher: typeof fetch = fetch,
): Promise<Inspection> {
  // Explicit fields prevent an accidental actor, identity, or provider payload
  // from being forwarded by a caller.
  const identifiers = {
    sourceBusinessId: accounts.sourceBusinessId,
    targetBusinessId: accounts.targetBusinessId,
    sourceOwnerId: accounts.sourceOwnerId,
    targetOwnerId: accounts.targetOwnerId,
  };
  const endpoint = "/api/admin/shared-business-registrations";
  const response = action.action === "inspect"
    ? await fetcher(`${endpoint}?${new URLSearchParams(identifiers)}`, { cache: "no-store" })
    : await fetcher(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...identifiers, action: "approve", expectedRevision: action.expectedRevision }),
    });
  const payload = await response.json().catch(() => null);
  const parsed = inspectionSchema.safeParse(payload?.inspection);
  if (!response.ok || !parsed.success ||
    parsed.data.sourceBusinessId !== accounts.sourceBusinessId ||
    parsed.data.targetBusinessId !== accounts.targetBusinessId ||
    (action.action === "approve" && parsed.data.membershipRevision <= action.expectedRevision)) {
    throw new Error("The registration could not be confirmed. Inspect again before making another change.");
  }
  return parsed.data;
}

export function SharedRegistrationForm({
  accounts,
  targetBusinessName,
  membershipStatus,
}: {
  accounts: SharedRegistrationAccounts;
  targetBusinessName: string;
  membershipStatus: "approved" | "active" | "revoked" | null;
}) {
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [approved, setApproved] = useState(membershipStatus === "approved" || membershipStatus === "active");
  const [busy, setBusy] = useState<Action["action"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const canApprove = Boolean(inspection?.canApprove && inspection.membershipRevision === 0 && confirmed && !approved);

  async function run(action: Action["action"]) {
    if (pending.current || (action === "approve" && !canApprove)) return;
    pending.current = true;
    setBusy(action);
    setError(null);
    setConfirmed(false);
    try {
      const result = await requestSharedRegistration(accounts, action === "inspect"
        ? { action }
        : { action, expectedRevision: inspection!.membershipRevision });
      setInspection(result);
      if (action === "approve") setApproved(true);
    } catch (cause) {
      // An unknown approval outcome must be inspected, never retried from an
      // earlier preview. The server revision fence independently protects it.
      setInspection(null);
      setError(cause instanceof Error ? cause.message : "Registration unavailable. Inspect again before continuing.");
    } finally {
      pending.current = false;
      setBusy(null);
    }
  }

  return <section aria-label="Private shared registration" className="space-y-4 text-sm">
    <p className="text-stone-600 dark:text-[#bdbdbf]">
      Approve {targetBusinessName} to use SimplAssist&apos;s existing legal registration.
      Each business keeps its own campaign, number, customers, and billing.
      Inspection changes nothing. Approval keeps the full address private and does not charge or submit a campaign.
    </p>
    <button type="button" disabled={busy !== null} onClick={() => void run("inspect")}
      className={`${btnSecondaryCompact} disabled:opacity-50`}>
      {busy === "inspect" ? "Inspecting…" : "Inspect shared registration"}
    </button>
    {inspection ? <div className={`${tile} space-y-2 p-4`}>
      <p className="font-semibold">{inspection.targetBusinessName}</p>
      <dl className="grid gap-2 sm:grid-cols-2">
        <div><dt className="text-stone-500 dark:text-[#bdbdbf]">Legal operator</dt><dd>{inspection.legalBusinessName}</dd></div>
        <div><dt className="text-stone-500 dark:text-[#bdbdbf]">Existing brand</dt><dd>{inspection.tcrBrandId}</dd></div>
        <div><dt className="text-stone-500 dark:text-[#bdbdbf]">Campaigns on brand</dt><dd>{inspection.campaignCount} of 5</dd></div>
      </dl>
      <p className="text-xs text-stone-500 dark:text-[#bdbdbf]">Carrier identity checked. Account eligibility is checked again when approving.</p>
      {!inspection.canApprove && !approved ? <p className={`rounded-xl p-3 ${statusWarning}`}>
        Admission is disabled or campaign capacity is unavailable. Approval remains blocked.
      </p> : null}
    </div> : null}
    {approved ? <p role="status" className={`rounded-xl p-3 ${statusSuccess}`}>
      Shared registration approved. Continue in this business&apos;s Reviews settings to choose its number and complete texting setup. Carrier approval is still required.
    </p> : inspection?.membershipRevision ? <p role="status" className={`rounded-xl p-3 ${statusWarning}`}>
      A membership already exists. Refresh this account and review its status before making another change.
    </p> : inspection ? <div className="space-y-3">
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={confirmed} disabled={busy !== null || !inspection.canApprove}
          onChange={event => setConfirmed(event.target.checked)}
          className="mt-0.5 h-4 w-4 accent-[#ea580c] dark:accent-[#ff914d]" />
        <span>I confirm these businesses operate under the same legal company and approve this account&apos;s use of the inspected registration.</span>
      </label>
      <button type="button" disabled={busy !== null || !canApprove} onClick={() => void run("approve")}
        className={`${btnPrimaryCompact} disabled:opacity-50`}>
        {busy === "approve" ? "Approving…" : "Approve shared registration"}
      </button>
    </div> : null}
    {error ? <p role="alert" className={`rounded-xl p-3 ${statusDanger}`}>{error}</p> : null}
  </section>;
}
