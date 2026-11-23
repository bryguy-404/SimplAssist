"use client";
import { useCallback, useEffect, useState } from "react";
import type { CallScreeningSettings as Settings, ScreeningMode } from "@/lib/call-screening/domain";

export default function CallScreeningSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [mode, setMode] = useState<ScreeningMode>("disabled");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (refresh: boolean, signal?: AbortSignal) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/settings/call-screening${refresh ? "?refresh=1" : ""}`, { signal, cache: "no-store" });
      const data: Settings & { error: string | null } = await res.json();
      if (!res.ok) throw new Error(data.error || "Unable to load call screening.");
      if (!signal?.aborted) { setSettings(data); setMode(data.syncStatus === "pending" ? data.requestedMode : data.confirmedMode === "flag_calls" ? "flag_calls" : "disabled"); }
      if (data.available && !refresh && data.confirmedMode === "unknown") {
        const verified = await fetch("/api/settings/call-screening?refresh=1", { signal, cache: "no-store" });
        const actual = await verified.json();
        if (!verified.ok) throw new Error(actual.error || "Unable to verify call screening.");
        if (!signal?.aborted) { setSettings(actual); setMode(actual.syncStatus === "pending" ? actual.requestedMode : actual.confirmedMode === "flag_calls" ? "flag_calls" : "disabled"); }
      }
    } catch (e) { if (!signal?.aborted) setError(e instanceof Error ? e.message : "Unable to verify call screening."); }
    finally { if (!signal?.aborted) setBusy(false); }
  }, []);
  useEffect(() => { const controller = new AbortController(); void load(false, controller.signal); return () => controller.abort(); }, [load]);
  useEffect(() => {
    if (settings?.syncStatus !== "pending") return;
    const controller = new AbortController();
    const timer = setInterval(() => { void load(false, controller.signal); }, 10_000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [settings?.syncStatus, load]);
  async function save() {
    if (!settings || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/settings/call-screening", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, revision: settings.revision }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Unable to save call screening.");
      setSettings(data);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save call screening."); }
    finally { setBusy(false); }
  }
  if (settings && !settings.available) return null;
  if (!settings && !error) return null;
  const confirmed = settings?.confirmedMode === "flag_calls" ? "Flag suspected spam" : settings?.confirmedMode === "disabled" ? "Off" : settings?.confirmedMode === "reject_calls" ? "Reject calls (set outside SimplAssist)" : "Not yet verified";
  return <section className="space-y-4 rounded-2xl border border-[#e7e0d4] bg-white p-6 dark:border-white/10 dark:bg-white/[0.03]" aria-labelledby="call-screening-heading">
    <div><h2 id="call-screening-heading" className="text-lg font-semibold">Call screening</h2>
      <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">Let the carrier flag suspected spam calls for {settings?.phoneNumber ?? "your business number"}. Review them in Conversations → Spam.</p></div>
    <p className="text-sm text-stone-600 dark:text-stone-300">Calls still follow your normal answering and forwarding settings. Flagged calls skip automatic missed-call texts. Requested texts and booking confirmations continue normally. Voice usage still applies.</p>
    <p className="text-sm">Last verified setting: <strong>{confirmed}</strong>{settings?.verifiedAt && <span className="block text-xs text-stone-500">{new Date(settings.verifiedAt).toLocaleString()}</span>}</p>
    {settings?.syncStatus === "pending" && <p role="status" className="text-sm text-amber-700 dark:text-amber-400">Saving and verifying {settings.requestedMode === "flag_calls" ? "Flag suspected spam" : "Off"}. This change is not confirmed yet.</p>}
    {settings?.confirmedMode === "reject_calls" && <p className="text-sm text-amber-700 dark:text-amber-400">Your carrier is currently rejecting suspected spam. Choose Off or Flag suspected spam to allow those calls through.</p>}
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-sm" htmlFor="screening-mode">Screening
        <select id="screening-mode" value={mode} onChange={e => setMode(e.target.value as ScreeningMode)} disabled={busy || settings?.syncStatus === "pending" || !settings} className="rounded-lg border border-[#e3dacc] bg-white px-3 py-2 dark:border-white/10 dark:bg-stone-900">
          <option value="disabled">Off</option><option value="flag_calls" disabled={!settings?.canEnable}>Flag suspected spam</option>
        </select>
      </label>
      <button type="button" onClick={save} disabled={busy || !settings || settings.syncStatus === "pending" || (mode === "flag_calls" && !settings.canEnable)} className="rounded-full bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{busy ? "Checking…" : "Save"}</button>
      <button type="button" onClick={() => load(true)} disabled={busy} className="rounded-full border border-[#e3dacc] px-4 py-2 text-sm disabled:opacity-40 dark:border-white/10">Refresh</button>
    </div>
    {(error || settings?.error) && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error || settings?.error}</p>}
    <p className="text-xs text-stone-500 dark:text-stone-400">Flags can miss spam or flag a legitimate call. Not spam restores a call without changing how future calls from that number are handled. Texts and chats are not automatically screened.</p>
  </section>;
}
