"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveVoicePilot } from "./VoicePilotControls";
export function VoiceActionControls({
  revision,
  contacts,
  signup,
  preparation,
  ready,
}: {
  revision: number;
  contacts: boolean;
  signup: boolean;
  preparation: boolean;
  ready: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = useState({ contacts, signup, preparation });
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  return (
    <section className="rounded-xl border p-6">
      <h2 className="text-xl font-semibold">Voice actions</h2>
      <p className="mt-2 text-sm text-stone-500">
        Private signup testing on the existing SimplAssist account. Texts
        require caller permission and go only to the approved calling number.
        Booking stays disabled for this test round.
      </p>
      <form
        className="mt-4 space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMessage("");
          try {
            await saveVoicePilot({
              action: "capabilities",
              revision,
              ...values,
            });
            setMessage(
              "Voice capabilities saved. Changes apply to action checks immediately.",
            );
            router.refresh();
          } catch (err) {
            setMessage(err instanceof Error ? err.message : "Could not save.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {(
          [
            ["contacts", "Save confirmed contact details"],
            ["signup", "Offer and send the approved signup link"],
            ["preparation", "Prepare the voice connection during ringing"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={values[key]}
              disabled={busy || !ready}
              onChange={(e) =>
                setValues({ ...values, [key]: e.target.checked })
              }
            />
            {label}
          </label>
        ))}
        {!ready && (
          <p className="text-sm text-amber-700">
            Deploy and verify the action service before enabling these controls.
          </p>
        )}
        <button
          disabled={busy || !ready}
          className="rounded-lg bg-stone-900 px-4 py-2 text-white disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save voice capabilities"}
        </button>
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
      </form>
    </section>
  );
}
