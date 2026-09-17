"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import type {
  OwnerVoiceSettings as VoiceSettings,
  OwnerVoiceSettingsUpdate,
} from "@/lib/voice/ownerSettings";
import {
  bodyFaint,
  btnPrimaryInline,
  btnSecondaryInline,
  card,
  ink,
  statusDanger,
  statusWarning,
} from "@/lib/theme-v2/theme";

type Draft = Pick<VoiceSettings["preferences"], "mode" | "textFallbackEnabled">;
type Feedback = { kind: "success" | "error"; text: string } | null;

const STATUS_COPY: Record<VoiceSettings["status"], string> = {
  ready: "Voice answering is available.",
  rollout_closed: "Voice answering is not available for new calls on this account yet.",
  plan_required: "Your current plan does not include voice answering. Your previous call history remains available.",
  payment_required: "New voice calls are paused until your current subscription and payment can be verified.",
  exhausted: "New voice calls are paused because fewer than one minute is available.",
  temporarily_unavailable: "Voice answering is temporarily unavailable. Refresh to check its current status.",
};

export class VoiceSettingsRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "VoiceSettingsRequestError";
  }
}

function readSettings(body: unknown): VoiceSettings {
  const value = (body as { voice?: VoiceSettings } | null)?.voice;
  const usage = value?.usage;
  if (
    !value ||
    typeof value.visible !== "boolean" ||
    !["commercial", "pilot", null].includes(value.accessSource) ||
    typeof value.canEditPreferences !== "boolean" ||
    typeof value.canEnableVoice !== "boolean" ||
    !Object.hasOwn(STATUS_COPY, value.status) ||
    typeof value.timezone !== "string" ||
    !["text", "voice"].includes(value.preferences?.mode) ||
    typeof value.preferences?.textFallbackEnabled !== "boolean" ||
    !Number.isSafeInteger(value.preferences?.revision) ||
    value.preferences.revision < 0 ||
    (usage !== null && (
      !usage ||
      !["monthly", "pilot_lifetime"].includes(usage.kind) ||
      !["current", "ended"].includes(usage.periodState) ||
      ![usage.includedSeconds, usage.usedSeconds, usage.heldSeconds, usage.availableSeconds]
        .every((seconds) => Number.isFinite(seconds) && seconds >= 0) ||
      typeof usage.reconciling !== "boolean" ||
      (usage.resetsAt !== null && (
        typeof usage.resetsAt !== "string" || !Number.isFinite(Date.parse(usage.resetsAt))
      ))
    ))
  ) throw new VoiceSettingsRequestError("Voice settings could not be verified. Please refresh.", 0);
  return value;
}

async function requestSettings(
  init: RequestInit,
  fetcher: typeof fetch,
): Promise<VoiceSettings> {
  let response: Response;
  try {
    response = await fetcher("/api/settings/voice", { ...init, cache: "no-store" });
  } catch {
    throw new VoiceSettingsRequestError("Could not reach voice settings. Please try again.", 0);
  }
  if (!response.ok) {
    throw new VoiceSettingsRequestError(
      response.status === 409
        ? "Voice settings changed. Refresh and review the latest settings before saving again."
        : response.status === 403
          ? "Voice settings could not be changed with your current access."
          : init.method === "GET"
            ? "Could not refresh voice settings. Please try again."
            : "Could not update voice settings. Please try again.",
      response.status,
    );
  }
  return readSettings(await response.json().catch(() => null));
}

export function refreshOwnerVoiceSettings(fetcher: typeof fetch = fetch) {
  return requestSettings({ method: "GET" }, fetcher);
}

export function saveOwnerVoiceSettings(
  update: OwnerVoiceSettingsUpdate,
  fetcher: typeof fetch = fetch,
) {
  return requestSettings({
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: update.mode,
      textFallbackEnabled: update.textFallbackEnabled,
      expectedRevision: update.expectedRevision,
    }),
  }, fetcher);
}

/** A rejected write may refresh access, but is never retried automatically. */
export async function submitOwnerVoiceSettings(
  update: OwnerVoiceSettingsUpdate,
  fetcher: typeof fetch = fetch,
): Promise<{ settings: VoiceSettings | null; saved: boolean; message: string; requiresRefresh: boolean }> {
  try {
    return {
      settings: await saveOwnerVoiceSettings(update, fetcher),
      saved: true, message: "Call settings saved. Changes apply to new calls.", requiresRefresh: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save voice settings.";
    const stale = error instanceof VoiceSettingsRequestError && [403, 409].includes(error.status);
    if (stale) {
      try {
        return { settings: await refreshOwnerVoiceSettings(fetcher), saved: false, message, requiresRefresh: false };
      } catch {
        return { settings: null, saved: false, message, requiresRefresh: true };
      }
    }
    return { settings: null, saved: false, message, requiresRefresh: false };
  }
}

export function formatVoiceMinutes(seconds: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(seconds / 60);
}

export function voiceUsageLevel(usage: NonNullable<VoiceSettings["usage"]>) {
  if (usage.periodState === "ended") return "normal";
  if (usage.availableSeconds < 60) return "exhausted";
  const ratio = usage.includedSeconds > 0
    ? (usage.usedSeconds + usage.heldSeconds) / usage.includedSeconds
    : 0;
  if (ratio >= 0.95) return "critical";
  if (ratio >= 0.8) return "warning";
  return "normal";
}

function resetDate(value: string, timezone: string) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium", timeStyle: "short", timeZone: timezone,
    }).format(new Date(value));
  } catch {
    return null;
  }
}

export function VoiceMinuteUsage({ settings }: { settings: VoiceSettings }) {
  const usage = settings.usage;
  if (!usage) return (
    <p className={clsx("mt-4 text-sm", bodyFaint)} role="status">
      A current voice allowance is not available. No usage estimate is shown.
    </p>
  );
  const lifetime = usage.kind === "pilot_lifetime";
  const ended = !lifetime && usage.periodState === "ended";
  const level = voiceUsageLevel(usage);
  const capacity = usage.usedSeconds + usage.heldSeconds;
  const percent = usage.includedSeconds > 0
    ? Math.min(100, capacity / usage.includedSeconds * 100) : 0;
  const reset = usage.resetsAt ? resetDate(usage.resetsAt, settings.timezone) : null;
  const warning = level === "exhausted"
    ? "Fewer than one minute is available, so new voice calls cannot start."
    : level === "critical"
      ? "At least 95% of your voice allowance is used or held. Very little capacity remains."
      : level === "warning"
        ? "At least 80% of your voice allowance is used or held."
        : null;
  return (
    <div className="mt-5">
      <p className={clsx("text-sm font-medium", ink)}>
        {lifetime ? "Private pilot · lifetime minutes" : ended
          ? "Voice minutes for the previous billing period" : "Voice minutes this billing period"}
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          [lifetime ? "Lifetime budget" : "Included", usage.includedSeconds],
          ["Used", usage.usedSeconds],
          ["Held", usage.heldSeconds],
          [ended ? "Unused" : "Available", usage.availableSeconds],
        ].map(([label, seconds]) => (
          <div key={label}>
            <dt className={clsx("text-sm", bodyFaint)}>{label}</dt>
            <dd className={clsx("mt-1 text-xl font-semibold tabular-nums", ink)}>
              {formatVoiceMinutes(Number(seconds))}<span className="ml-1 text-sm font-normal">min</span>
            </dd>
          </div>
        ))}
      </dl>
      <div
        role="progressbar"
        aria-label={lifetime ? "Lifetime voice minutes used or held" : "Voice minutes used or held"}
        aria-valuemin={0}
        aria-valuemax={usage.includedSeconds / 60}
        aria-valuenow={Math.min(capacity, usage.includedSeconds) / 60}
        aria-valuetext={formatVoiceMinutes(usage.usedSeconds) + " minutes used; " +
          formatVoiceMinutes(usage.heldSeconds) + " minutes held"}
        className="mt-4 h-3 overflow-hidden rounded-full bg-stone-200 dark:bg-white/[0.10]"
      >
        <div
          className={clsx("h-full rounded-full", level === "exhausted" ? "bg-red-500" :
            level === "normal" ? "bg-green-500" : "bg-amber-500")}
          style={{ width: percent + "%" }}
        />
      </div>
      <p className={clsx("mt-3 text-sm", bodyFaint)}>
        {lifetime ? "This lifetime pilot budget does not reset each month." : ended ? (
          <>This billing period has ended{reset ? <> on <time dateTime={usage.resetsAt!}>{reset}</time> ({settings.timezone})</> : null}.
            These are its retained usage totals. No new allowance is available yet.</>
        ) : reset ? (
          <>Resets <time dateTime={usage.resetsAt!}>{reset}</time> ({settings.timezone}). Unused minutes do not roll over.</>
        ) : "The next reset date is not available. No new allowance is assumed."}
      </p>
      {usage.heldSeconds > 0 ? (
        <p className={clsx("mt-2 text-sm", bodyFaint)}>
          Held minutes are reserved for current calls or calls awaiting a final duration.
          They are separate from used minutes and temporarily reduce what is available.
        </p>
      ) : null}
      {usage.reconciling ? (
        <p role="status" className={clsx("mt-3 rounded-xl p-3 text-sm", statusWarning)}>
          Some calls are still being checked. Their uncertain time remains held until their duration is resolved.
        </p>
      ) : null}
      {warning ? (
        <p role="status" className={clsx("mt-3 rounded-xl p-3 text-sm", level === "exhausted" ? statusDanger : statusWarning)}>
          {warning}
        </p>
      ) : null}
    </div>
  );
}

export function OwnerVoiceSettingsContent({
  settings, variant = "settings", draft = settings.preferences,
  busy = null, feedback = null, onDraft, onSave, onRefresh,
}: {
  settings: VoiceSettings;
  variant?: "settings" | "usage";
  draft?: Draft;
  busy?: "saving" | "refreshing" | null;
  feedback?: Feedback;
  onDraft?: (value: Draft) => void;
  onSave?: () => void;
  onRefresh?: () => void;
}) {
  const headingId = useId();
  if (!settings.visible) return null;
  const pilot = settings.accessSource === "pilot";
  const editable = settings.canEditPreferences && !pilot;
  const changed = draft.mode !== settings.preferences.mode ||
    draft.textFallbackEnabled !== settings.preferences.textFallbackEnabled;
  const blockedVoiceChoice = draft.mode === "voice" && settings.preferences.mode !== "voice" && !settings.canEnableVoice;
  return (
    <section aria-labelledby={headingId} aria-busy={Boolean(busy)} className={clsx("p-6", card)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id={headingId} className={clsx("text-lg font-semibold", ink)}>
            {variant === "usage" ? "Voice usage" : "Call answering"}
          </h2>
          <p className={clsx("mt-1 text-sm", bodyFaint)}>
            {pilot ? "Your private pilot keeps its existing routing and approved caller list."
              : variant === "usage"
                ? "Track voice minutes separately from text messages and web-chat replies."
                : "Choose how your assistant responds when you miss a call."}
          </p>
        </div>
        <button type="button" disabled={Boolean(busy)} onClick={onRefresh}
          className={clsx(btnSecondaryInline, "disabled:cursor-not-allowed disabled:opacity-50")}>
          {busy === "refreshing" ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {busy ? <span role="status" className="sr-only">{busy === "saving" ? "Saving call settings" : "Refreshing voice settings"}</span> : null}
      {settings.status !== "ready" ? (
        <p role="status" className={clsx("mt-4 rounded-xl p-3 text-sm", statusWarning)}>
          {STATUS_COPY[settings.status]}
        </p>
      ) : null}
      {variant === "settings" && !pilot ? (
        <form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); onSave?.(); }}>
          <fieldset disabled={!editable || Boolean(busy)}>
            <legend className={clsx("mb-2 text-sm font-medium", ink)}>When you miss a call</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {(["text", "voice"] as const).map((mode) => (
                <label key={mode} className={clsx(
                  "flex items-start gap-3 rounded-xl border p-4 text-sm",
                  draft.mode === mode ? "border-[var(--brand-primary)] bg-[var(--brand-accent-soft)] dark:bg-white/[0.06]"
                    : "border-[#ece4d8] dark:border-white/[0.12]",
                  ink,
                )}>
                  <input type="radio" name={headingId + "-mode"} value={mode} checked={draft.mode === mode}
                    disabled={mode === "voice" && !settings.canEnableVoice}
                    onChange={() => onDraft?.({ ...draft, mode })} className="mt-0.5 accent-[var(--brand-primary)]" />
                  <span>
                    <span className="block font-medium">{mode === "text" ? "Text follow-up" : "AI voice answering"}</span>
                    <span className={clsx("mt-1 block", bodyFaint)}>
                      {mode === "text" ? "Send an eligible missed-call text." : "Let your AI speak with the caller."}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className={clsx("flex items-start gap-3 text-sm", ink)}>
            <input type="checkbox" checked={draft.textFallbackEnabled}
              disabled={!editable || Boolean(busy)}
              onChange={(event) => onDraft?.({ ...draft, textFallbackEnabled: event.target.checked })}
              className="mt-1 accent-[var(--brand-primary)]" />
            <span>
              Send an eligible text if voice cannot start or has a technical problem.
              <span className={clsx("mt-1 block", bodyFaint)}>Your ordinary SMS allowance and rates still apply.</span>
            </span>
          </label>
          {editable ? (
            <button type="submit" disabled={Boolean(busy) || !changed || blockedVoiceChoice}
              className={clsx(btnPrimaryInline, "disabled:cursor-not-allowed disabled:opacity-50")}>
              {busy === "saving" ? "Saving…" : "Save call settings"}
            </button>
          ) : null}
          <p className={clsx("text-sm", bodyFaint)}>Changes apply to new calls. A call already in progress can finish within its reserved time.</p>
        </form>
      ) : null}
      {feedback ? (
        <p role={feedback.kind === "error" ? "alert" : "status"}
          className={clsx("mt-4 rounded-xl p-3 text-sm", feedback.kind === "error" ? statusDanger : "bg-green-50 text-green-800 dark:bg-green-500/10 dark:text-green-300")}>
          {feedback.text}
        </p>
      ) : null}
      <VoiceMinuteUsage settings={settings} />
      <p className={clsx("mt-4 text-sm", bodyFaint)}>
        {pilot ? "Pilot minutes include time the voice session spends listening and waiting."
          : "Voice minutes count after the opening notice, including conversation, listening, pauses, and checking answers until the caller hangs up. Ringing, connection setup, and the opening notice do not count."}
      </p>
      <p className={clsx("mt-2 text-sm", bodyFaint)}>
        Extra voice minutes are not purchased or charged automatically.
        {!pilot ? settings.preferences.textFallbackEnabled
          ? " At the limit, eligible text follow-up is used."
          : " At the limit, callers follow your existing voicemail path without a generic text."
          : ""}
      </p>
      <p className={clsx("mt-3 text-sm", bodyFaint)}>
        <Link href="/conversations" className="underline underline-offset-4">Past conversations and retained recordings</Link> remain available when voice answering is off.
        {variant === "usage" && !pilot ? <> <Link href="/settings" className="underline underline-offset-4">Manage call settings</Link>.</> : null}
      </p>
    </section>
  );
}

export default function OwnerVoiceSettings({
  initialSettings, variant = "settings",
}: {
  initialSettings: VoiceSettings | null;
  variant?: "settings" | "usage";
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [draft, setDraft] = useState<Draft | null>(initialSettings?.preferences ?? null);
  const [busy, setBusy] = useState<"saving" | "refreshing" | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [requiresRefresh, setRequiresRefresh] = useState(false);
  useEffect(() => {
    setSettings(initialSettings);
    setDraft(initialSettings?.preferences ?? null);
    setFeedback(null);
    setRequiresRefresh(false);
  }, [initialSettings]);
  const accept = (next: VoiceSettings) => {
    setSettings(next);
    setDraft(next.preferences);
  };
  const refresh = async () => {
    if (busy) return;
    setBusy("refreshing");
    setFeedback(null);
    try {
      accept(await refreshOwnerVoiceSettings());
      setRequiresRefresh(false);
    } catch (error) {
      setFeedback({ kind: "error", text: error instanceof Error ? error.message : "Could not refresh voice settings." });
    } finally { setBusy(null); }
  };
  const save = async () => {
    if (!settings || !draft || busy || requiresRefresh || !settings.canEditPreferences || settings.accessSource === "pilot" ||
      (draft.mode === "voice" && settings.preferences.mode !== "voice" && !settings.canEnableVoice)) return;
    setBusy("saving");
    setFeedback(null);
    try {
      const result = await submitOwnerVoiceSettings({ ...draft, expectedRevision: settings.preferences.revision });
      if (result.settings) accept(result.settings);
      setRequiresRefresh(result.requiresRefresh);
      setFeedback({ kind: result.saved ? "success" : "error", text: result.message });
    } finally { setBusy(null); }
  };
  if (!settings || !draft) return null;
  return <OwnerVoiceSettingsContent settings={requiresRefresh ? { ...settings, canEditPreferences: false, canEnableVoice: false } : settings} variant={variant} draft={draft}
    busy={busy} feedback={feedback} onDraft={setDraft} onSave={() => void save()} onRefresh={() => void refresh()} />;
}
