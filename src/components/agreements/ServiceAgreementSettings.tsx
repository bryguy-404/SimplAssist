"use client";

import { useState } from "react";
import { primaryCtaInlineClass } from "@/lib/glass";
import { ServiceAgreementField, useServiceAgreement } from "./ServiceAgreementField";
import { ServiceAgreementHistory } from "./ServiceAgreementHistory";

export function ServiceAgreementSettings() {
  const agreement = useServiceAgreement();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function accept() {
    if (!agreement.ready || busy) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/service-agreements", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serviceAgreement: agreement.confirmation }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Couldn’t save your agreement. Please try again.");
      agreement.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn’t save your agreement. Please try again."); }
    finally { setBusy(false); }
  }
  return <>
    <p className="mt-2 text-sm text-stone-500">View or download the Terms you accepted and the saved acceptance details. Your copies remain available after subscription cancellation.</p>
    <ServiceAgreementField agreement={agreement} disabled={busy} />
    {agreement.status && !agreement.status.accepted && <button onClick={accept} disabled={!agreement.ready || busy} className={primaryCtaInlineClass}>{busy ? "Saving…" : "Save agreement"}</button>}
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    {agreement.status && <ServiceAgreementHistory records={agreement.status.records} />}
  </>;
}
