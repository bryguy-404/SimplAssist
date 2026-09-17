"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

const fieldClass =
  "mt-2 w-full rounded-lg border border-stone-300 bg-transparent px-3 py-2 dark:border-white/20";
export async function saveVoicePilot(input: unknown) {
  const response = await fetch("/api/admin/voice-pilot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not save.");
}
export function VoicePilotControls(props: {
  revision: number;
  enabled: boolean;
  budgetMinutes: number;
  testers: { phone_number: string; label: string }[];
  canEnable: boolean;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(props.enabled);
  const [budget, setBudget] = useState(props.budgetMinutes);
  const [testers, setTesters] = useState(
    props.testers
      .map((t) => `${t.phone_number}${t.label ? `, ${t.label}` : ""}`)
      .join("\n"),
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function submit(stop = false) {
    setBusy(true);
    setMessage(null);
    try {
      await saveVoicePilot(
        stop
          ? { action: "stop" }
          : {
              action: "settings",
              revision: props.revision,
              enabled,
              budgetMinutes: budget,
              testers: testers
                .split("\n")
                .filter((line) => line.trim())
                .map((line) => {
                  const [phone, ...label] = line.split(",");
                  return { phone: phone.trim(), label: label.join(",").trim() };
                }),
            },
      );
      if (stop) setEnabled(false);
      setMessage(
        stop
          ? "Pilot stopped. Active calls will close safely; new calls use the existing text flow."
          : "Pilot settings saved.",
      );
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rounded-xl border border-stone-200 p-6 dark:border-white/10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-xl font-semibold">Pilot controls</h2>
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit(true)}
          className="rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-600 disabled:opacity-50"
        >
          Stop pilot
        </button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="mt-5 space-y-5"
      >
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy || (!props.canEnable && !enabled)}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enable voice for approved testers only
        </label>
        {!props.canEnable ? (
          <p className="text-sm text-amber-700">
            Provider and deployment checks must pass before enablement.
          </p>
        ) : null}
        <div className="grid gap-5 sm:grid-cols-2">
          <label className="text-sm font-medium">
            Total pilot allowance, in minutes
            <input
              className={fieldClass}
              type="number"
              min={0}
              max={6000}
              step={1}
              required
              value={budget}
              disabled={busy}
              onChange={(event) => setBudget(Number(event.target.value))}
            />
            <span className="mt-2 block text-xs font-normal text-stone-500">
              Changing this value is an explicit admin budget change. No
              automatic extra usage.
            </span>
          </label>
          <p className="self-center text-sm text-stone-500">
            Up to 2 simultaneous calls. Maximum 10 minutes each, including
            shutdown time. Callers receive a warning before the time limit.
          </p>
        </div>
        <label className="block text-sm font-medium">
          Approved tester numbers
          <textarea
            className={fieldClass}
            rows={5}
            value={testers}
            disabled={busy}
            onChange={(event) => setTesters(event.target.value)}
            placeholder={"+15555550101, Bryan\n+15555550102, Second tester"}
          />
          <span className="mt-2 block text-xs font-normal text-stone-500">
            One international number per line, starting with +. An optional name
            follows a comma. Tester eligibility does not establish acknowledgment
            of AI use or recording. Prior acknowledgments and spoken notices are
            tracked separately for each call.
          </span>
        </label>
        <button
          disabled={busy}
          className="rounded-lg bg-stone-900 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save pilot settings"}
        </button>
        {message ? (
          <p role="status" className="text-sm">
            {message}
          </p>
        ) : null}
      </form>
    </section>
  );
}

export function VoiceCallFeedback({
  sessionId,
  feedback,
  needsReconciliation,
  usedSeconds,
}: {
  sessionId: string;
  feedback: string | null;
  needsReconciliation: boolean;
  usedSeconds: number;
}) {
  const router = useRouter();
  const [text, setText] = useState(feedback || "");
  const [seconds, setSeconds] = useState(usedSeconds);
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function save(reconcile: boolean) {
    setBusy(true);
    setMessage(null);
    try {
      await saveVoicePilot(
        reconcile
          ? { action: "reconcile", sessionId, seconds, reference }
          : { action: "feedback", sessionId, feedback: text },
      );
      setMessage("Saved.");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(false);
        }}
      >
        <label className="block font-semibold">
          Call feedback
          <textarea
            className={fieldClass}
            rows={4}
            maxLength={4000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Accuracy, naturalness, interruptions, and anything that needs fixing…"
          />
        </label>
        <button
          disabled={busy}
          className="mt-3 rounded-lg bg-stone-900 px-4 py-2 text-sm font-semibold text-white"
        >
          Save feedback
        </button>
      </form>
      {needsReconciliation ? (
        <details className="rounded-lg border border-amber-300 p-4">
          <summary className="cursor-pointer font-semibold">
            Reconcile missing final voice usage
          </summary>
          <p className="mt-3 text-sm">
            Use confirmed OpenAI usage from provider records or support. Keep
            the reservation held if the final duration cannot be verified.
            Recording length and transcript length do not establish billable
            voice time.
          </p>
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void save(true);
            }}
          >
            <label className="block text-sm">
              Confirmed voice seconds
              <input
                className={fieldClass}
                type="number"
                min={usedSeconds}
                max={86400}
                step="any"
                required
                value={seconds}
                onChange={(e) => setSeconds(Number(e.target.value))}
              />
            </label>
            <label className="block text-sm">
              Provider evidence reference
              <input
                className={fieldClass}
                required
                minLength={10}
                maxLength={1000}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Provider report or support reference confirming this session’s duration"
              />
            </label>
            <button
              disabled={busy}
              className="rounded-lg border px-4 py-2 text-sm font-semibold"
            >
              Record confirmed usage
            </button>
          </form>
        </details>
      ) : null}
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
    </section>
  );
}
