"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import type { DashboardUpgradePrompt } from "@/lib/dashboard/upgradePrompt";
import { body, card, ink, inlineLink, statusDanger } from "@/lib/theme-v2/theme";

export default function UpgradePrompt({ prompt }: { prompt: DashboardUpgradePrompt }) {
  const [visible, setVisible] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  async function dismiss(action: "snooze" | "hide") {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/dashboard/upgrade-prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ offerKey: prompt.offerKey, action, expectedRevision: prompt.revision }) });
      if (!response.ok && response.status !== 409) throw new Error();
      setVisible(false);
      setNotice(response.status === 409 ? "This suggestion has changed. Refresh the dashboard to see the latest status." : action === "hide" ? "This suggestion is hidden. Upgrade options remain available in your account." : "Suggestion snoozed. Upgrade options remain available in your account.");
    } catch { setError("We couldn’t save your preference. Please try again."); }
    finally { setBusy(false); }
  }
  return <>
    <p role="status" aria-live="polite" className="sr-only">{notice}</p>
    {visible ? <aside className={`p-4 sm:p-5 ${card}`} aria-labelledby="upgrade-prompt-title">
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 id="upgrade-prompt-title" className={`text-sm font-semibold ${ink}`}>{prompt.title}</h2>
          <p className={`mt-1 text-sm ${body}`}>{prompt.description}</p>
          <Link href={prompt.href} className={`mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-md text-sm font-semibold ${inlineLink} focus-visible:outline focus-visible:outline-2`}>
            {prompt.actionLabel}<ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Link>
          {prompt.kind === "offer" ? <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            <button type="button" disabled={busy} onClick={() => void dismiss("snooze")} className={`min-h-11 rounded-md text-xs underline underline-offset-4 ${body} focus-visible:outline focus-visible:outline-2 disabled:opacity-50`}>Not now</button>
            <button type="button" disabled={busy} onClick={() => void dismiss("hide")} className={`min-h-11 rounded-md text-xs underline underline-offset-4 ${body} focus-visible:outline focus-visible:outline-2 disabled:opacity-50`}>Don’t show this suggestion again</button>
          </div> : null}
          {error ? <p role="alert" className={`mt-2 rounded-lg p-3 text-sm ${statusDanger}`}>{error}</p> : null}
        </div>
      </div>
    </aside> : null}
  </>;
}
