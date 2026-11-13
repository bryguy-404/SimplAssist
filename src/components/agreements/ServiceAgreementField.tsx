"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { SERVICE_PRIVACY_URL, SERVICE_TERMS_URL, type ServiceAgreementConfirmation, type ServiceAgreementStatus } from "@/lib/agreements/shared";

export function useServiceAgreement(required = true) {
  const [status, setStatus] = useState<ServiceAgreementStatus | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!required) return;
    const controller = new AbortController();
    setStatus(null); setError(false); setChecked(false);
    fetch("/api/service-agreements", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("agreement_unavailable");
        const next: ServiceAgreementStatus = await response.json();
        if (typeof next.termsVersion !== "string" || typeof next.accepted !== "boolean") throw new Error("agreement_unavailable");
        if (!controller.signal.aborted) setStatus(next);
      }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [required, generation]);
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  const confirmation: ServiceAgreementConfirmation | undefined = status && checked && !status.accepted
    ? { accepted: true, termsVersion: status.termsVersion } : undefined;
  return { required, status, checked, setChecked, error, refresh, confirmation,
    ready: !required || Boolean(status && (status.accepted || checked)) };
}
export type ServiceAgreementControl = ReturnType<typeof useServiceAgreement>;

export function ServiceAgreementField({ agreement, disabled = false }: { agreement: ServiceAgreementControl; disabled?: boolean }) {
  const id = useId();
  if (!agreement.required || agreement.status?.accepted) return null;
  if (agreement.error) return <div role="alert" className="my-4 text-sm">
    We couldn’t load your agreement. <button type="button" className="underline" onClick={agreement.refresh} disabled={disabled}>Try again</button>.
  </div>;
  if (!agreement.status) return <p role="status" className="my-4 text-sm text-stone-500">Loading agreement…</p>;
  return <div className="my-4 text-sm text-stone-700 dark:text-stone-200">
    <div className="flex items-start gap-3">
      <input id={id} type="checkbox" checked={agreement.checked} disabled={disabled}
        onChange={(event) => agreement.setChecked(event.target.checked)}
        className="mt-1 h-4 w-4 shrink-0 accent-orange-600" />
      <label htmlFor={id}>I agree to the <a href={SERVICE_TERMS_URL} target="_blank" rel="noopener noreferrer" className="underline">Terms of Service</a> and acknowledge the <a href={SERVICE_PRIVACY_URL} target="_blank" rel="noopener noreferrer" className="underline">Privacy Policy</a>.</label>
    </div>
  </div>;
}
