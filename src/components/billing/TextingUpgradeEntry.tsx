"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { TextingUpgradeState } from "@/lib/billing/textingUpgrade";
import { card } from "@/lib/theme-v2/theme";
import { primaryCtaInlineClass } from "@/lib/glass";

export function textingUpgradeEntryLabel(state: TextingUpgradeState): string | null {
  if (state.upgrade && !["activated", "abandoned"].includes(state.upgrade.state)) {
    return state.upgrade.state === "draft" ? "Resume texting setup" : "View texting status";
  }
  return state.enabled && state.eligible ? "Add texting" : null;
}

export default function TextingUpgradeEntry({ currentPlan }: { currentPlan?: string }) {
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<TextingUpgradeState | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    fetch("/api/billing/texting-upgrade", { cache: "no-store", signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error("unavailable"); setState((await response.json()).state); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [retry]);
  const label = state ? textingUpgradeEntryLabel(state) : null;
  const supportOnly = state && currentPlan === "chat_only" && state.enabled && !state.eligible;
  if (!label && !supportOnly && !(failed && currentPlan === "chat_only")) return null;
  return <section className={`mt-6 p-6 ${card}`} aria-labelledby="add-texting-heading">
    <h2 id="add-texting-heading" className="font-semibold">Texting for your business</h2>
    {failed ? <><p role="status" className="mt-2 text-sm">Texting upgrade options could not be loaded.</p><button className={`${primaryCtaInlineClass} mt-4`} onClick={() => setRetry((value) => value + 1)}>Try again</button></> : supportOnly ? <><p className="mt-2 text-sm">Contact support to add texting to this account.</p><Link className={`${primaryCtaInlineClass} mt-4`} href="/support">Contact support</Link></> : <><p className="mt-2 text-sm">Use your existing account. Complete texting setup and review the price before paying.</p><Link className={`${primaryCtaInlineClass} mt-4`} href="/billing/add-texting">{label}</Link></>}
  </section>;
}
