"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import type { CallScreeningSettings as Settings, ScreeningMode } from "@/lib/call-screening/domain";
import { formatPhoneForDisplay } from "@/lib/phone/display";
import {
  bodyFaint,
  btnPrimaryInline,
  btnSecondaryInline,
  card,
  ink,
  statusDanger,
  statusNeutral,
  statusSuccess,
  statusWarning,
} from "@/lib/theme-v2/theme";

const MODE_COPY: Record<ScreeningMode, { title: string; detail: string }> = {
  disabled: {
    title: "Off",
    detail: "Every call is handled the same way, including likely spam.",
  },
  flag_calls: {
    title: "Flag suspected spam",
    detail:
      "Likely spam goes to Conversations → Spam and doesn’t get an automatic missed-call text.",
  },
};

function draftModeFor(settings: Settings): ScreeningMode {
  if (settings.syncStatus === "pending") return settings.requestedMode;
  return settings.confirmedMode === "flag_calls" ? "flag_calls" : "disabled";
}

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
      if (!res.ok) throw new Error(data.error || "Unable to load the spam call filter.");
      if (!signal?.aborted) { setSettings(data); setMode(draftModeFor(data)); }
      if (data.available && !refresh && data.confirmedMode === "unknown") {
        const verified = await fetch("/api/settings/call-screening?refresh=1", { signal, cache: "no-store" });
        const actual = await verified.json();
        if (!verified.ok) throw new Error(actual.error || "Unable to verify the spam call filter.");
        if (!signal?.aborted) { setSettings(actual); setMode(draftModeFor(actual)); }
      }
    } catch (e) { if (!signal?.aborted) setError(e instanceof Error ? e.message : "Unable to verify the spam call filter."); }
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
      if (!res.ok) throw new Error(data.error || "Unable to save the spam call filter.");
      setSettings(data);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save the spam call filter."); }
    finally { setBusy(false); }
  }
  if (settings && !settings.available) return null;
  if (!settings && !error) return null;

  const pending = settings?.syncStatus === "pending";
  const confirmedMode = settings?.confirmedMode ?? "unknown";
  const savedMode: ScreeningMode | null =
    confirmedMode === "flag_calls" ? "flag_calls" : confirmedMode === "disabled" ? "disabled" : null;
  const status =
    pending ? { label: "Saving…", tone: statusWarning }
      : confirmedMode === "flag_calls" ? { label: "On", tone: statusSuccess }
        : confirmedMode === "disabled" ? { label: "Off", tone: statusNeutral }
          : confirmedMode === "reject_calls" ? { label: "Blocking calls", tone: statusWarning }
            : { label: "Not checked yet", tone: statusNeutral };
  const number = formatPhoneForDisplay(settings?.phoneNumber);
  const controlsDisabled = busy || pending || !settings;
  const unchanged = savedMode !== null && mode === savedMode;

  return (
    <section id="spam-call-filter" className={clsx("scroll-mt-6 p-6", card)} aria-labelledby="call-screening-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="call-screening-heading" className={clsx("text-lg font-semibold", ink)}>Spam call filter</h2>
            <span className={clsx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", status.tone)}>{status.label}</span>
          </div>
          <p className={clsx("mt-1 max-w-2xl text-sm", bodyFaint)}>
            Catch likely spam and robocalls{number ? <> to {number}</> : null} so your assistant doesn&rsquo;t text them back.
            You can review anything that gets flagged in{" "}
            <Link href="/conversations?folder=spam" className="underline underline-offset-4">Conversations &rarr; Spam</Link>.
          </p>
        </div>
        <button type="button" onClick={() => load(true)} disabled={busy}
          className={clsx(btnSecondaryInline, "disabled:cursor-not-allowed disabled:opacity-50")}>
          {busy ? "Checking…" : "Refresh"}
        </button>
      </div>

      <fieldset disabled={controlsDisabled} className="mt-5">
        <legend className="sr-only">Spam call filter</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {(["disabled", "flag_calls"] as const).map((option) => {
            const unavailable = option === "flag_calls" && !settings?.canEnable;
            return (
              <label key={option} className={clsx(
                "flex items-start gap-3 rounded-[18px] border p-4 text-sm",
                mode === option ? "border-[var(--brand-primary)] bg-[var(--brand-accent-soft)] dark:bg-white/[0.06]"
                  : "border-[#ece4d8] dark:border-white/[0.12]",
                unavailable ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                ink,
              )}>
                <input type="radio" name="screening-mode" value={option} checked={mode === option}
                  disabled={unavailable} onChange={() => setMode(option)}
                  className="mt-0.5 accent-[var(--brand-primary)]" />
                <span>
                  <span className="block font-medium">{MODE_COPY[option].title}</span>
                  <span className={clsx("mt-1 block", bodyFaint)}>{MODE_COPY[option].detail}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={save}
          disabled={controlsDisabled || unchanged || (mode === "flag_calls" && !settings?.canEnable)}
          className={clsx(btnPrimaryInline, "disabled:cursor-not-allowed disabled:opacity-50")}>
          {busy ? "Checking…" : "Save"}
        </button>
        {settings?.verifiedAt && !pending ? (
          <span className={clsx("text-xs", bodyFaint)}>
            Last confirmed with your carrier {new Date(settings.verifiedAt).toLocaleString()}
          </span>
        ) : null}
      </div>

      {pending && settings ? (
        <p role="status" className={clsx("mt-4 rounded-[14px] p-3 text-sm", statusWarning)}>
          Saving &ldquo;{MODE_COPY[settings.requestedMode].title}&rdquo; and confirming it with your carrier. This can take a moment.
        </p>
      ) : null}
      {confirmedMode === "reject_calls" ? (
        <p className={clsx("mt-4 rounded-[14px] p-3 text-sm", statusWarning)}>
          Your carrier is currently blocking suspected spam calls completely, a setting made outside this dashboard.
          Choose Off or Flag suspected spam and save to let those calls through.
        </p>
      ) : null}
      {(error || settings?.error) ? (
        <p role="alert" className={clsx("mt-4 rounded-[14px] p-3 text-sm", statusDanger)}>{error || settings?.error}</p>
      ) : null}

      <details className="mt-4">
        <summary className={clsx("cursor-pointer text-sm font-medium underline-offset-4 hover:underline", ink)}>
          What the filter does and doesn&rsquo;t do
        </summary>
        <ul className={clsx("mt-2 list-disc space-y-1 pl-5 text-sm", bodyFaint)}>
          <li>Your phone carrier decides which calls look like spam. It can miss spam or flag a real customer, so check the Spam tab now and then.</li>
          <li>Flagged calls still follow your missed-call and forwarding settings. They only skip the automatic missed-call text.</li>
          <li>Texts a caller asks for and booking confirmations are still sent, and voice minutes still apply.</li>
          <li>Marking a call &ldquo;Not spam&rdquo; moves it back to your inbox. It doesn&rsquo;t change how future calls from that number are handled.</li>
          <li>Texts and web chats are not screened.</li>
        </ul>
      </details>
    </section>
  );
}
