'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  OWNER_BOOKING_ALERT_CONSENT_VERSION,
  OWNER_BOOKING_ALERT_DISCLOSURE,
  type OwnerBookingAlertSettings,
} from '@/lib/owner-booking-alerts/contracts';
import {
  bodyFaint, btnPrimaryInline, btnSecondaryInline, card, fieldLabel,
  ink, inputField, statusDanger, statusSuccess, statusWarning,
} from '@/lib/theme-v2/theme';
import BookingAlertDisclosure from './BookingAlertDisclosure';
import {
  BOOKING_ALERT_POLL_INTERVAL_MS, canPollVerification, loadBookingAlerts,
  updateBookingAlerts, type BookingAlertUpdate,
} from './client';

type Verification = NonNullable<OwnerBookingAlertSettings['verification']>;
type Feedback = { kind: 'error' | 'success'; text: string } | null;

export const BOOKING_ALERT_STATUS_COPY: Record<OwnerBookingAlertSettings['status'], string> = {
  unavailable: 'Booking texts are not available yet. You can review the signup details below; alerts will remain off until setup is ready.',
  not_enabled: 'Booking texts are off. Add your mobile number and complete verification to turn them on.',
  pending_verification: 'One more step: send the verification text from your mobile to confirm this number.',
  active: 'Booking texts are on for new appointments confirmed by SimplAssist.',
  paused: 'Booking texts are paused. Your account needs active calendar booking before alerts can resume.',
  stopped: 'You opted out by text. Send START to the SimplAssist number below, then verify your number again to enable alerts for this business.',
};

export function OwnerBookingAlertsContent({
  settings, loading = false, busy = false, phone = '', consent = false,
  editing = false, verification = null, pollingStopped = false, feedback = null,
  onPhone, onConsent, onEnroll, onDisable, onEdit, onRefresh, onCopy,
}: {
  settings: OwnerBookingAlertSettings | null;
  loading?: boolean; busy?: boolean; phone?: string; consent?: boolean; editing?: boolean;
  verification?: Verification | null; pollingStopped?: boolean; feedback?: Feedback;
  onPhone?: (phone: string) => void; onConsent?: (consent: boolean) => void;
  onEnroll?: () => void; onDisable?: () => void; onEdit?: () => void;
  onRefresh?: () => void; onCopy?: () => void;
}) {
  const formId = useId();
  const canEnroll = Boolean(settings?.available && settings.eligible);
  const showForm = !settings || !settings.available || editing || (!settings.enabled && !settings.pendingRecipient);
  const status = settings && !settings.available ? 'unavailable' : settings?.status;
  const ready = status === 'active' && settings?.eligible;
  const loadError = !settings && feedback?.kind === 'error' ? feedback.text : null;
  return <section id="booking-alerts" aria-labelledby={`${formId}-heading`} aria-busy={busy || loading}
    className={`scroll-mt-6 p-6 ${card}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id={`${formId}-heading`} className={`text-lg font-semibold ${ink}`}>Booking alerts</h2>
        <p className={`mt-1 max-w-2xl text-sm ${bodyFaint}`}>
          Get a text from SimplAssist when it confirms a new appointment in your connected calendar.
          This is available with eligible Chat Only accounts too.
        </p>
      </div>
      <button type="button" disabled={busy || loading} onClick={onRefresh} className={`${btnSecondaryInline} disabled:opacity-50`}>
        {loading ? 'Checking…' : 'Refresh'}
      </button>
    </div>

    <p role={loadError ? 'alert' : 'status'} className={`mt-4 rounded-xl p-3 text-sm ${loadError ? statusDanger : ready ? statusSuccess : statusWarning}`}>
      {loadError ?? (loading && !settings ? 'Checking booking alert availability…' : settings
        ? BOOKING_ALERT_STATUS_COPY[status!]
        : 'Booking alert settings could not be loaded. Refresh to try again.')}
    </p>
    {settings?.available && !settings.eligible && settings.status !== 'paused' ? <p className={`mt-3 text-sm ${bodyFaint}`}>
      An active plan with calendar booking, a connected calendar, and direct booking enabled are needed to receive alerts.
    </p> : null}
    {settings?.recipient ? <p className={`mt-4 text-sm ${ink}`}>
      {ready ? 'Texts go to ' : 'Saved alert number: '}<span className="font-semibold">{settings.recipient}</span>.
      {settings.pendingRecipient && settings.enabled ? ' Your existing number stays saved until the replacement is verified.' : null}
    </p> : null}
    {settings?.status === 'stopped' && settings.sender ? <p className={`mt-3 text-sm ${ink}`}>
      Text <strong>START</strong> to <span className="font-semibold">{settings.sender}</span> from your mobile.
      Restarting texts does not automatically enable other businesses on this mobile number.
    </p> : null}

    {settings?.pendingRecipient && canEnroll && !editing ? <div className="mt-5 space-y-3 rounded-2xl border border-[#e3dacc] p-4 dark:border-white/[0.12]">
      <h3 className={`font-semibold ${ink}`}>Verify {settings.pendingRecipient}</h3>
      {settings.pendingRecipientSuppressed && settings.sender ? <p className={`rounded-xl p-3 text-sm ${statusWarning}`}>
        This mobile previously stopped SimplAssist alerts. From {settings.pendingRecipient}, send <strong>START</strong> to {settings.sender},
        then send your verification text.
        {settings.recipient && settings.recipient !== settings.pendingRecipient ? ' Your other saved alert number is unchanged.' : null}
      </p> : null}
      {verification ? <>
        <p className={`text-sm ${bodyFaint}`}>From this mobile, send the exact text below to {verification.sender}. Your phone’s normal text-message rates may apply.</p>
        <p className={`select-all break-all rounded-xl bg-stone-100 p-3 font-mono text-base dark:bg-white/[0.06] ${ink}`}>{verification.message}</p>
        <div className="flex flex-wrap gap-3">
          <a href={verification.smsUrl} className={btnPrimaryInline}>Open my texting app</a>
          <button type="button" onClick={onCopy} className={btnSecondaryInline}>Copy text</button>
        </div>
        <p className={`text-sm ${bodyFaint}`}>On a computer? Open Messages on your phone and type this text to {verification.sender}. Opening the texting app does not send it for you.</p>
        <p role="status" className={`text-sm ${bodyFaint}`}>
          {pollingStopped ? 'Automatic checking has paused. If you sent the text, choose Check verification. If it expired, create a new verification text.' : 'Waiting for your text. This page will check for verification for a short time.'}
        </p>
      </> : <p className={`text-sm ${bodyFaint}`}>If you already sent your verification text, check its status. Otherwise, create a new verification text to finish setup.</p>}
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={busy || loading} onClick={onRefresh} className={`${btnSecondaryInline} disabled:opacity-50`}>Check verification</button>
        <button type="button" disabled={busy} onClick={onEdit} className={`${btnSecondaryInline} disabled:opacity-50`}>Create a new verification text</button>
      </div>
    </div> : null}

    {showForm ? <form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); onEnroll?.(); }}>
      <div className="max-w-md">
        <label htmlFor={`${formId}-phone`} className={fieldLabel}>Your mobile number</label>
        <input id={`${formId}-phone`} type="tel" autoComplete="tel" inputMode="tel" value={phone}
          maxLength={32} placeholder="(574) 555-0123" disabled={busy || loading || !canEnroll}
          aria-describedby={`${formId}-phone-help`} onChange={(event) => onPhone?.(event.target.value)}
          className={`${inputField} disabled:opacity-60`} />
        <p id={`${formId}-phone-help`} className={`mt-2 text-sm ${bodyFaint}`}>
          Use a US mobile you control. You may use the same mobile that receives forwarded calls.
        </p>
      </div>
      <label className={`flex items-start gap-3 text-sm ${ink}`}>
        <input type="checkbox" checked={consent} disabled={busy || loading || !canEnroll}
          onChange={(event) => onConsent?.(event.target.checked)}
          className="mt-1 h-4 w-4 shrink-0 accent-[var(--brand-primary)]" />
        <span>I agree to receive automated booking-alert texts from SimplAssist at this mobile number.</span>
      </label>
      <BookingAlertDisclosure disclosure={settings?.disclosure ?? OWNER_BOOKING_ALERT_DISCLOSURE} />
      <button type="submit" disabled={busy || loading || !canEnroll || !consent || !phone.trim()}
        className={`${btnPrimaryInline} disabled:cursor-not-allowed disabled:opacity-50`}>
        {busy ? 'Preparing…' : 'Continue to verify my number'}
      </button>
      <p className={`text-sm ${bodyFaint}`}>Setup is optional. We’ll enable alerts only after you send the verification text from your mobile.</p>
    </form> : null}

    {settings?.recipient && !editing && !settings.pendingRecipient ? <button type="button" disabled={busy || !canEnroll}
      onClick={onEdit} className={`mt-4 ${btnSecondaryInline} disabled:opacity-50`}>
      {settings.enabled ? 'Change alert number' : 'Set up booking texts'}
    </button> : null}
    {settings && (settings.enabled || settings.pendingRecipient) ? <button type="button" disabled={busy}
      onClick={onDisable} className={`mt-4 ${btnSecondaryInline} disabled:opacity-50`}>
      {settings.enabled ? 'Turn off booking texts' : 'Cancel verification'}
    </button> : null}
    {feedback && !loadError ? <p role={feedback.kind === 'error' ? 'alert' : 'status'} className={`mt-4 rounded-xl p-3 text-sm ${feedback.kind === 'error' ? statusDanger : statusSuccess}`}>{feedback.text}</p> : null}
    <p className={`mt-5 text-sm ${bodyFaint}`}>
      Reply STOP to pause all SimplAssist booking texts to this mobile. Turning off alerts here affects this business only.
      Unconfirmed requests and appointments made outside SimplAssist do not trigger these alerts.
    </p>
  </section>;
}

export default function OwnerBookingAlerts() {
  const [settings, setSettings] = useState<OwnerBookingAlertSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [editing, setEditing] = useState(false);
  const [verification, setVerification] = useState<{ recipient: string; challenge: Verification } | null>(null);
  const [pollingStopped, setPollingStopped] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const mutationGeneration = useRef(0);
  const mutationBusy = useRef(false);
  const latestRevision = useRef(-1);

  const accept = useCallback((next: OwnerBookingAlertSettings) => {
    if (next.revision < latestRevision.current) return;
    latestRevision.current = next.revision;
    setSettings(next);
    setVerification((current) => {
      if (!next.pendingRecipient) return null;
      if (next.verification) return { recipient: next.pendingRecipient, challenge: next.verification };
      return current?.recipient === next.pendingRecipient ? current : null;
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadBookingAlerts(controller.signal).then((next) => {
      if (!controller.signal.aborted) accept(next);
    }).catch(() => {
      if (!controller.signal.aborted) setFeedback({ kind: 'error', text: 'Could not load booking alerts. Please refresh.' });
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [accept]);

  const pendingRecipient = settings?.pendingRecipient ?? null;
  const canVerify = Boolean(settings?.available && settings.eligible);
  const expiresAt = verification?.challenge.expiresAt ?? null;
  useEffect(() => {
    if (!pendingRecipient || !expiresAt || busy || !canVerify) return;
    const controller = new AbortController();
    const generation = mutationGeneration.current;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setPollingStopped(false);
    const poll = async () => {
      if (controller.signal.aborted || generation !== mutationGeneration.current) return;
      if (!canPollVerification(expiresAt, attempts)) { setPollingStopped(true); return; }
      attempts += 1;
      try {
        const next = await loadBookingAlerts(controller.signal);
        if (controller.signal.aborted || generation !== mutationGeneration.current) return;
        accept(next);
        if (!next.pendingRecipient) {
          setEditing(false);
          setConsent(false);
          if (next.status === 'active') setFeedback({ kind: 'success', text: 'Your mobile is verified. Booking texts are now on.' });
          return;
        }
        timer = setTimeout(() => void poll(), BOOKING_ALERT_POLL_INTERVAL_MS);
      } catch {
        if (!controller.signal.aborted) setPollingStopped(true);
      }
    };
    timer = setTimeout(() => void poll(), BOOKING_ALERT_POLL_INTERVAL_MS);
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [accept, busy, canVerify, expiresAt, pendingRecipient]);

  const refresh = async () => {
    if (loading || mutationBusy.current) return;
    setLoading(true);
    setFeedback(null);
    const generation = mutationGeneration.current;
    try {
      const next = await loadBookingAlerts();
      if (generation === mutationGeneration.current) accept(next);
    } catch (error) { setFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Could not refresh booking alerts.' }); }
    finally { setLoading(false); }
  };
  const mutate = async (update: BookingAlertUpdate) => {
    if (mutationBusy.current) return;
    mutationBusy.current = true;
    mutationGeneration.current += 1;
    setBusy(true);
    setFeedback(null);
    try {
      const next = await updateBookingAlerts(update);
      accept(next);
      setEditing(false);
      setConsent(false);
      setPollingStopped(false);
      if (update.action === 'disable') setFeedback({ kind: 'success', text: 'Booking texts are off for this business.' });
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Could not update booking alerts.' });
    } finally { mutationBusy.current = false; setBusy(false); }
  };
  const enroll = () => {
    if (!settings?.available || !settings.eligible || !consent || !phone.trim()) return;
    void mutate({ action: 'enroll', phone: phone.trim(), consent: true,
      consentVersion: OWNER_BOOKING_ALERT_CONSENT_VERSION, expectedRevision: settings.revision });
  };
  const copy = async () => {
    if (!verification) return;
    try {
      await navigator.clipboard.writeText(verification.challenge.message);
      setFeedback({ kind: 'success', text: 'Verification text copied. Send it from your mobile to the SimplAssist number shown above.' });
    } catch { setFeedback({ kind: 'error', text: 'Copy was unavailable. Select the verification text and copy it manually.' }); }
  };
  return <OwnerBookingAlertsContent settings={settings} loading={loading} busy={busy} phone={phone} consent={consent}
    editing={editing} verification={verification?.challenge} pollingStopped={pollingStopped} feedback={feedback}
    onPhone={setPhone} onConsent={setConsent} onEnroll={enroll}
    onDisable={() => { if (settings) void mutate({ action: 'disable', expectedRevision: settings.revision }); }}
    onEdit={() => { setPhone(settings?.pendingRecipient ?? settings?.recipient ?? ''); setConsent(false); setEditing(true); setFeedback(null); }}
    onRefresh={() => void refresh()} onCopy={() => void copy()} />;
}
