'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, BellRing, X } from 'lucide-react';
import type { OwnerBookingAlertSettings } from '@/lib/owner-booking-alerts/contracts';
import { bodyFaint, card, ink, inlineLink, statusDanger } from '@/lib/theme-v2/theme';
import { loadBookingAlerts, shouldShowBookingAlertNudge, updateBookingAlerts } from './client';

export function BookingAlertNudgeContent({ busy = false, error = null, onDismiss }: {
  busy?: boolean; error?: string | null; onDismiss?: () => void;
}) {
  return <section aria-label="Set up booking alerts" className={`relative p-6 ${card}`}>
    <div className="flex gap-4 pr-8">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--brand-accent-soft)] text-[var(--brand-accent)] dark:bg-white/[0.06] dark:text-[var(--brand-accent-dark)]">
        <BellRing className="h-5 w-5" aria-hidden="true" />
      </div>
      <div>
        <h2 className={`font-semibold ${ink}`}>Want a text when an appointment is booked?</h2>
        <p className={`mt-1 text-sm ${bodyFaint}`}>SimplAssist can text your mobile after it confirms a booking in your connected calendar.</p>
        <Link href="/settings#booking-alerts" className={`mt-3 inline-flex items-center gap-2 text-sm ${inlineLink}`}>
          Set up booking alerts <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>
    </div>
    <button type="button" disabled={busy} aria-label="Dismiss booking alert setup" onClick={onDismiss}
      className="absolute right-4 top-4 rounded-lg p-2 text-stone-400 hover:text-stone-700 focus-visible:outline focus-visible:outline-2 dark:hover:text-white disabled:opacity-50">
      <X className="h-4 w-4" aria-hidden="true" />
    </button>
    {error ? <p role="alert" className={`mt-3 rounded-xl p-3 text-sm ${statusDanger}`}>{error}</p> : null}
  </section>;
}

export default function BookingAlertNudge() {
  const [settings, setSettings] = useState<OwnerBookingAlertSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void loadBookingAlerts(controller.signal).then((next) => {
      if (!controller.signal.aborted) setSettings(next);
    }).catch(() => { /* An optional invitation stays hidden if availability cannot be verified. */ });
    return () => controller.abort();
  }, []);
  if (!shouldShowBookingAlertNudge(settings)) return null;
  const dismiss = async () => {
    if (busy || !settings) return;
    setBusy(true);
    setError(null);
    try { setSettings(await updateBookingAlerts({ action: 'dismiss', expectedRevision: settings.revision })); }
    catch { setError('Could not dismiss this reminder. Please try again.'); }
    finally { setBusy(false); }
  };
  return <BookingAlertNudgeContent busy={busy} error={error} onDismiss={() => void dismiss()} />;
}
