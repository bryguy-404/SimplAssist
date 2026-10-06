"use client";

import { useRef, useState } from "react";
import { z } from "zod";
import {
  btnPrimaryCompact,
  btnSecondaryCompact,
  statusDanger,
  statusWarning,
  tile,
} from "@/lib/theme-v2/theme";

const endpoint = "/api/admin/reviews/sms/campaign-retry";
const inspectionSchema = z.object({
  eligible: z.boolean(),
  reason: z.string().nullable(),
  businessId: z.string().uuid(),
  ownerId: z.string().uuid().nullable(),
  accountId: z.string().uuid().nullable(),
  originalReservationId: z.string().uuid().nullable(),
  originalPayloadHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  membershipRevision: z.number().int().positive().nullable(),
  state: z.string(),
  attempts: z.array(z.object({
    id: z.string().uuid(),
    referenceId: z.string(),
    state: z.string(),
    startedAt: z.string().nullable(),
    diagnostics: z.unknown().optional(),
  })),
  providerMatchCount: z.number().int().nonnegative(),
});
const authorizationSchema = z.object({
  attemptId: z.string().uuid(),
  token: z.string().min(1),
  expiresAt: z.string().datetime(),
});
type Inspection = z.infer<typeof inspectionSchema>;
type RetainedAuthorization = z.infer<typeof authorizationSchema> & Pick<Inspection,
  "businessId" | "ownerId" | "accountId" | "originalReservationId" | "originalPayloadHash" | "membershipRevision">;
const diagnosticsSchema = z.object({
  status: z.number().int().min(100).max(599).nullable().optional(),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).nullable().optional(),
  message: z.string().optional(),
  providerErrors: z.array(z.object({
    code: z.string().optional(),
    title: z.string().optional(),
    detail: z.string().optional(),
  })).optional(),
});
const boundedText = (value: string | undefined, limit: number) => {
  const text = value?.trim() ?? "";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

/** The server sanitizes these allowlisted fields; raw provider data is never rendered. */
function AttemptDiagnostics({ value }: { value: unknown }) {
  const parsed = diagnosticsSchema.safeParse(value);
  if (!parsed.success) return null;
  const diagnostic = parsed.data;
  const errors = (diagnostic.providerErrors ?? []).slice(0, 3).map(error => ({
    code: boundedText(error.code, 80), title: boundedText(error.title, 120), detail: boundedText(error.detail, 350),
  })).filter(error => error.code || error.title || error.detail);
  const message = boundedText(diagnostic.message, 400);
  if (!diagnostic.status && !diagnostic.requestId && !errors.length && !message) return null;
  return <div className="mt-1 space-y-2 break-words text-xs text-stone-600 dark:text-[#bdbdbf]">
    <dl className="space-y-1">
      {diagnostic.status ? <div><dt className="inline font-medium">HTTP status: </dt><dd className="inline">{diagnostic.status}</dd></div> : null}
      {diagnostic.requestId ? <div><dt className="inline font-medium">Provider request ID: </dt><dd className="inline break-all">{diagnostic.requestId}</dd></div> : null}
    </dl>
    {errors.length ? <ul className="space-y-1" aria-label="Provider error details">
      {errors.map((error, index) => <li key={index}>
        {error.code ? <span className="font-medium">{error.code}: </span> : null}
        {error.title ? <span>{error.title}{error.detail ? ". " : ""}</span> : null}
        {error.detail}
      </li>)}
    </ul> : message ? <p>{message}</p> : null}
  </div>;
}

async function readInspection(response: Response, businessId: string): Promise<Inspection> {
  const data = await response.json().catch(() => null);
  const parsed = inspectionSchema.safeParse(data?.inspection);
  if (!response.ok || !parsed.success || parsed.data.businessId !== businessId) {
    throw new Error("The campaign status could not be confirmed. Inspect again before continuing.");
  }
  return parsed.data;
}

function supportsRetry(inspection: Inspection | null): boolean {
  return Boolean(inspection?.eligible && inspection.ownerId && inspection.accountId &&
    inspection.originalReservationId && inspection.originalPayloadHash &&
    inspection.membershipRevision && inspection.providerMatchCount === 0);
}

function matchesPreparedAuthorization(inspection: Inspection | null, authorization: RetainedAuthorization | null): boolean {
  return Boolean(inspection && authorization && Date.parse(authorization.expiresAt) > Date.now() &&
    inspection.businessId === authorization.businessId && inspection.ownerId === authorization.ownerId &&
    inspection.accountId === authorization.accountId && inspection.originalReservationId === authorization.originalReservationId &&
    inspection.originalPayloadHash === authorization.originalPayloadHash && inspection.membershipRevision === authorization.membershipRevision &&
    inspection.providerMatchCount === 0 && inspection.attempts.some(attempt => attempt.id === authorization.attemptId && attempt.state === "prepared"));
}

/** Rendering and inspecting never authorize or submit a carrier application. */
export function ReviewCampaignRetryPanel({ businessId }: { businessId: string }) {
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState<"inspect" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retryStarted, setRetryStarted] = useState(false);
  const [resumeInspected, setResumeInspected] = useState(false);
  const pending = useRef(false);
  // The capability lives only in this mounted panel's memory. It is never
  // rendered, logged, placed in a URL, or persisted to browser storage.
  const retainedAuthorization = useRef<RetainedAuthorization | null>(null);
  const canRetry = supportsRetry(inspection) && accepted && !retryStarted;
  const canResume = resumeInspected && matchesPreparedAuthorization(inspection, retainedAuthorization.current);

  async function inspect() {
    if (pending.current) return;
    pending.current = true;
    setBusy("inspect");
    setError(null);
    setAccepted(false);
    setResumeInspected(false);
    try {
      const result = await readInspection(await fetch(`${endpoint}?${new URLSearchParams({ businessId })}`, {
        cache: "no-store",
      }), businessId);
      setInspection(result);
      const resumable = matchesPreparedAuthorization(result, retainedAuthorization.current);
      setResumeInspected(resumable);
      if (!resumable) retainedAuthorization.current = null;
    } catch (cause) {
      setInspection(null);
      setError(cause instanceof Error ? cause.message : "Campaign status unavailable.");
    } finally {
      pending.current = false;
      setBusy(null);
    }
  }

  async function retryOnce(resume = false) {
    if (pending.current || !(resume ? canResume : canRetry) || !inspection) return;
    pending.current = true;
    setBusy("retry");
    setError(null);
    setNotice(null);
    setAccepted(false);
    setRetryStarted(true);
    setResumeInspected(false);
    const before = inspection;
    try {
      if (!resume) {
        const prepared = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "prepare", businessId, ownerId: before.ownerId, accountId: before.accountId,
            originalReservationId: before.originalReservationId, originalPayloadHash: before.originalPayloadHash,
            membershipRevision: before.membershipRevision, acceptAdditionalFee: true,
          }),
        });
        const data = await prepared.json().catch(() => null);
        const authorization = authorizationSchema.safeParse(data?.authorization);
        if (!prepared.ok || !authorization.success || Date.parse(authorization.data.expiresAt) <= Date.now()) {
          throw new Error("The retry authorization could not be confirmed.");
        }
        retainedAuthorization.current = { ...authorization.data, businessId, ownerId: before.ownerId,
          accountId: before.accountId, originalReservationId: before.originalReservationId,
          originalPayloadHash: before.originalPayloadHash, membershipRevision: before.membershipRevision };
      }
      const authorization = retainedAuthorization.current;
      if (!authorization || Date.parse(authorization.expiresAt) <= Date.now()) {
        throw new Error("The retry authorization could not be confirmed.");
      }
      const result = await readInspection(await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "execute", businessId,
          attemptId: authorization.attemptId, token: authorization.token }),
      }), businessId);
      if (result.ownerId !== before.ownerId || result.accountId !== before.accountId ||
        result.originalReservationId !== before.originalReservationId) {
        throw new Error("The retry outcome could not be confirmed for this account.");
      }
      setInspection(result);
      if (!matchesPreparedAuthorization(result, authorization)) retainedAuthorization.current = null;
      setNotice("The retry check finished. Review the status below; carrier approval is still required before review texts can be sent.");
    } catch {
      // A lost response never causes a repeated POST. The same capability can
      // be resumed only after a separate explicit inspection and button click.
      setInspection(null);
      setError("The retry outcome is not confirmed. Only the status was refreshed; the submission was not repeated.");
      try {
        const result = await readInspection(await fetch(`${endpoint}?${new URLSearchParams({ businessId })}`, {
          cache: "no-store",
        }), businessId);
        setInspection(result);
        if (!matchesPreparedAuthorization(result, retainedAuthorization.current)) retainedAuthorization.current = null;
      } catch {
        // Keep the unresolved result visible and let the administrator inspect.
      }
    } finally {
      pending.current = false;
      setBusy(null);
    }
  }

  return <section aria-label="Review texting campaign retry" className="space-y-4 text-sm">
    <p className="text-stone-600 dark:text-[#bdbdbf]">
      Inspect this account before authorizing one additional campaign application. The original submission has an unknown outcome and will remain recorded.
    </p>
    <p className={`rounded-xl p-3 ${statusWarning}`}>
      Retrying can create a duplicate campaign and an additional Telnyx fee. This does not charge another Stripe activation fee or create another subscription. The existing number and account stay in place.
    </p>
    <button type="button" disabled={busy !== null} onClick={() => void inspect()}
      className={`${btnSecondaryCompact} disabled:opacity-50`}>
      {busy === "inspect" ? "Inspecting…" : "Inspect campaign status"}
    </button>
    {inspection ? <div className={`${tile} space-y-3 p-4`}>
      <dl className="space-y-2">
        <div><dt className="font-medium">Setup status</dt><dd className="break-words">{inspection.state.replaceAll("_", " ")}</dd></div>
        <div><dt className="font-medium">Matching campaigns found</dt><dd>{inspection.providerMatchCount}</dd></div>
      </dl>
      {inspection.attempts.length ? <ul className="space-y-2" aria-label="Recorded campaign attempts">
        {inspection.attempts.map((attempt, index) => <li key={attempt.id}>
          Attempt {index + 1}: {attempt.state.replaceAll("_", " ")}
          <AttemptDiagnostics value={attempt.diagnostics} />
        </li>)}
      </ul> : null}
      {!supportsRetry(inspection) ? <p role="status">
        A new submission is unavailable. {inspection.reason ? inspection.reason.replaceAll("_", " ") : "Review the existing attempt before continuing."}
      </p> : null}
    </div> : null}
    {supportsRetry(inspection) && !retryStarted ? <div className="space-y-3">
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={accepted} disabled={busy !== null}
          onChange={event => setAccepted(event.target.checked)}
          className="mt-0.5 h-4 w-4 accent-[#ea580c] dark:accent-[#ff914d]" />
        <span>I authorize one retry for this account and accept the possible additional Telnyx fee and duplicate campaign.</span>
      </label>
      <button type="button" disabled={busy !== null || !canRetry} onClick={() => void retryOnce()}
        className={`${btnPrimaryCompact} disabled:opacity-50`}>Retry campaign once</button>
    </div> : null}
    {canResume ? <div className="space-y-3">
      <p>The inspected retry is still prepared and has not started. Resume the same authorization; this does not prepare another attempt.</p>
      <button type="button" disabled={busy !== null} onClick={() => void retryOnce(true)}
        className={`${btnPrimaryCompact} disabled:opacity-50`}>Resume prepared retry</button>
    </div> : null}
    {busy === "retry" ? <p role="status">Checking and submitting the authorized retry…</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {error ? <p role="alert" className={`rounded-xl p-3 ${statusDanger}`}>{error}</p> : null}
  </section>;
}
