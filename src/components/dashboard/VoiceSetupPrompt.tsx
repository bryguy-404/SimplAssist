"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Phone } from "lucide-react";
import type { OwnerVoiceSettings } from "@/lib/voice/ownerSettings";
import { saveOwnerVoiceSettings } from "@/components/settings/OwnerVoiceSettings";
import { body, card, ink, inlineLink } from "@/lib/theme-v2/theme";

export function needsVoiceSetup(settings: OwnerVoiceSettings | null): settings is OwnerVoiceSettings {
  return Boolean(settings?.visible && settings.accessSource === "commercial" &&
    settings.canEnableVoice && settings.preferences.mode === "text" &&
    settings.preferences.revision === 1);
}

export default function VoiceSetupPrompt({ settings }: { settings: OwnerVoiceSettings | null }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!needsVoiceSetup(settings) || acknowledged) return null;

  async function keepTextFollowUp() {
    if (!settings || saving) return;
    setSaving(true);
    setError(null);
    try {
      await saveOwnerVoiceSettings({ mode: "text", textFallbackEnabled: settings.preferences.textFallbackEnabled,
        expectedRevision: settings.preferences.revision });
      setAcknowledged(true);
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save your choice. Please try again.");
      router.refresh();
    } finally { setSaving(false); }
  }

  return (
    <aside className={`p-4 sm:p-5 ${card}`} aria-labelledby="voice-setup-title" aria-busy={saving}>
      <div className="flex items-start gap-3">
        <Phone className="mt-0.5 h-5 w-5 shrink-0 text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 id="voice-setup-title" className={`text-sm font-semibold ${ink}`}>Turn on your AI receptionist</h2>
          <p className={`mt-1 text-sm ${body}`}>
            Your Full Suite plan includes AI voice answering, but it is not turned on yet.
            Open Call answering, select AI voice answering, and save your choice.
          </p>
          <p className={`mt-2 text-sm ${body}`}>
            Keeping your existing business number? After enabling voice, set up forward-when-unanswered with your phone carrier and test a call.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1">
            <Link href="/settings#call-answering" className={`inline-flex min-h-11 items-center rounded-md text-sm font-semibold ${inlineLink} focus-visible:outline focus-visible:outline-2`}>
              Set up voice answering
            </Link>
            <button type="button" onClick={keepTextFollowUp} disabled={saving}
              className={`min-h-11 rounded-md text-sm underline underline-offset-4 ${body} focus-visible:outline focus-visible:outline-2 disabled:opacity-50`}>
              {saving ? "Saving…" : "Keep text follow-up"}
            </button>
          </div>
          {error ? <p role="alert" className={`mt-2 text-sm ${body}`}>{error}</p> : null}
        </div>
      </div>
    </aside>
  );
}
