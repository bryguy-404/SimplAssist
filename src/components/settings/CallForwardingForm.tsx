'use client';

import { useMemo, useState } from 'react';
import { AlertCircle, ArrowRight, Check, PhoneForwarded } from 'lucide-react';
import { useBrand } from '@/components/branding/BrandProvider';
import { replaceDefaultBrandName } from '@/lib/branding/presentation';
import { isE164PhoneNumber, normalizeE164Input } from '@/lib/phone/e164';
import { formatPhoneForDisplay, parsePhoneInputToE164 } from '@/lib/phone/display';
import { primaryCtaInlineClass } from '@/lib/glass';
import { tile, tileRow, ink, body, bodyFaint } from '@/lib/theme-v2/theme';

interface CallForwardingFormProps {
  initialEnabled: boolean;
  initialForwardToNumber: string | null;
  smsPhoneNumber: string;
  /** Reports the saved on/off state so sibling help can stay accurate. */
  onEnabledChange?: (enabled: boolean) => void;
}

type ApiResponse = {
  error?: string;
  field?: 'forwardToNumber';
  callForwardingEnabled?: boolean;
  forwardToNumber?: string | null;
};

type PendingAction = 'toggle' | 'number' | null;

export function presentCallForwardingError(
  message: string,
  brandName: string
): string {
  return replaceDefaultBrandName(message, brandName);
}

function forwardingFailureMessage(
  requestError: unknown,
  remainsEnabled: boolean,
  fallback: string
): string {
  const detail =
    requestError instanceof Error && requestError.message
      ? requestError.message
      : fallback;
  if (detail.includes('Call forwarding remains')) return detail;
  return `${detail.replace(/[.\s]+$/, '')}. Call forwarding remains ${
    remainsEnabled ? 'on' : 'off'
  }.`;
}

export default function CallForwardingForm({
  initialEnabled,
  initialForwardToNumber,
  smsPhoneNumber,
  onEnabledChange,
}: CallForwardingFormProps) {
  const brand = useBrand();
  const initialNumber = normalizeE164Input(initialForwardToNumber);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [persistedEnabled, setPersistedEnabledState] = useState(initialEnabled);
  const [persistedForwardToNumber, setPersistedForwardToNumber] = useState(initialNumber);
  // The field shows a friendly "(317) 555-1234"; the saved value stays E.164.
  const [forwardToNumber, setForwardToNumber] = useState(
    formatPhoneForDisplay(initialNumber)
  );
  const setPersistedEnabled = (next: boolean) => {
    setPersistedEnabledState(next);
    onEnabledChange?.(next);
  };
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');

  const typedDraft = normalizeE164Input(forwardToNumber);
  // Unreadable input is kept as typed so it still counts as an unsaved change
  // and fails validation below instead of being silently dropped.
  const normalizedDraft = typedDraft
    ? parsePhoneInputToE164(typedDraft) ?? typedDraft
    : '';
  const numberIsDirty = normalizedDraft !== persistedForwardToNumber;

  const validationError = useMemo(() => {
    if (normalizedDraft && !isE164PhoneNumber(normalizedDraft)) {
      return 'Enter a 10-digit phone number, like (317) 555-1234';
    }
    if (normalizedDraft && normalizedDraft === smsPhoneNumber) {
      return `Forward-to number cannot be your ${brand.name} number`;
    }
    if (persistedEnabled && !normalizedDraft) {
      return 'Turn off call forwarding before clearing the forwarding number';
    }
    return '';
  }, [brand.name, normalizedDraft, persistedEnabled, smsPhoneNumber]);

  const canTurnOn = Boolean(
    persistedForwardToNumber &&
      isE164PhoneNumber(persistedForwardToNumber) &&
      persistedForwardToNumber !== smsPhoneNumber &&
      !numberIsDirty
  );
  const enableHelpVisible = !persistedEnabled && !canTurnOn;
  const busy = pendingAction !== null;

  const handleToggle = async (nextEnabled: boolean) => {
    if (busy || nextEnabled === persistedEnabled) return;
    if (nextEnabled && !canTurnOn) {
      setError('Save your phone number below before turning this on.');
      return;
    }

    const previousEnabled = persistedEnabled;
    setPendingAction('toggle');
    setEnabled(nextEnabled);
    setFeedback('');
    setError('');

    try {
      const res = await fetch('/api/settings/call-forwarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      const data = (await res.json().catch(() => ({}))) as ApiResponse;

      if (!res.ok || typeof data.callForwardingEnabled !== 'boolean') {
        const reason = data.error ? `${data.error}. ` : '';
        throw new Error(
          `${reason}Call forwarding remains ${previousEnabled ? 'on' : 'off'}.`
        );
      }

      const canonicalNumber = normalizeE164Input(data.forwardToNumber);
      setEnabled(data.callForwardingEnabled);
      setPersistedEnabled(data.callForwardingEnabled);
      setPersistedForwardToNumber(canonicalNumber);
      if (!numberIsDirty) setForwardToNumber(formatPhoneForDisplay(canonicalNumber));

      setFeedback(
        data.callForwardingEnabled
          ? `Call forwarding is on. New calls will ring ${formatPhoneForDisplay(canonicalNumber)} first. Make a quick test call to confirm it works.`
          : 'Call forwarding is off. New calls go straight to your assistant\u2019s missed-call follow-up.'
      );
    } catch (requestError) {
      setEnabled(previousEnabled);
      setError(
        forwardingFailureMessage(
          requestError,
          previousEnabled,
          'Could not update call forwarding'
        )
      );
    } finally {
      setPendingAction(null);
    }
  };

  const handleSaveNumber = async () => {
    if (busy || !numberIsDirty) return;
    setFeedback('');
    setError('');

    if (validationError) {
      setError(validationError);
      return;
    }

    setPendingAction('number');
    try {
      const res = await fetch('/api/settings/call-forwarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forwardToNumber: normalizedDraft || null }),
      });
      const data = (await res.json().catch(() => ({}))) as ApiResponse;

      if (!res.ok || typeof data.callForwardingEnabled !== 'boolean') {
        const reason = data.error ? `${data.error}. ` : '';
        throw new Error(
          `${reason}Call forwarding remains ${persistedEnabled ? 'on' : 'off'}.`
        );
      }

      const canonicalNumber = normalizeE164Input(data.forwardToNumber);
      setEnabled(data.callForwardingEnabled);
      setPersistedEnabled(data.callForwardingEnabled);
      setPersistedForwardToNumber(canonicalNumber);
      setForwardToNumber(formatPhoneForDisplay(canonicalNumber));

      if (data.callForwardingEnabled) {
        setFeedback(
          `Forwarding number updated to ${formatPhoneForDisplay(canonicalNumber)}. Make a quick test call to confirm it works.`
        );
      } else if (canonicalNumber) {
        setFeedback('Number saved. Turn the switch on when you want calls to ring your phone first.');
      } else {
        setFeedback('Forwarding number removed. Call forwarding is still off.');
      }
    } catch (requestError) {
      setError(
        forwardingFailureMessage(
          requestError,
          persistedEnabled,
          'Could not save the forwarding number'
        )
      );
    } finally {
      setPendingAction(null);
    }
  };

  const visibleError = presentCallForwardingError(
    error || validationError,
    brand.name
  );

  const toggleDisabled = busy || (!persistedEnabled && !canTurnOn);
  const savedDisplayNumber = formatPhoneForDisplay(persistedForwardToNumber);
  const flowSteps = [
    {
      label: 'A customer calls',
      detail: formatPhoneForDisplay(smsPhoneNumber),
    },
    {
      label: 'Your phone rings first',
      detail: savedDisplayNumber || 'the number you add below',
    },
    {
      label: 'No answer?',
      detail: 'Your assistant follows up',
    },
  ];

  return (
    <div id="call-forwarding" className={`${tile} scroll-mt-24 p-5`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex gap-3">
          <div className="mt-0.5 h-fit rounded-[14px] bg-[var(--brand-primary-alt-wash)] p-2.5 dark:bg-[rgb(var(--brand-primary-alt-rgb)/.10)]">
            <PhoneForwarded className="h-5 w-5 text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)]" aria-hidden />
          </div>
          <div>
            <h3 className={`font-semibold ${ink}`}>
              Ring my phone first
              <span className={`ml-2 text-xs font-normal ${bodyFaint}`}>Call forwarding</span>
            </h3>
            <p className={`mt-1 max-w-2xl text-sm ${body}`}>
              When a customer calls your {brand.name} number, we ring your own
              phone so you can pick up. If you don&rsquo;t answer, your assistant
              follows up just like any other missed call.
            </p>
          </div>
        </div>

        <div
          className={`inline-flex items-center gap-2 self-start ${
            toggleDisabled ? 'opacity-60' : ''
          }`}
        >
          <span className="text-sm font-medium text-stone-700 dark:text-[#d7d7d9]">
            {pendingAction === 'toggle' ? `Turning ${enabled ? 'on' : 'off'}...` : enabled ? 'On' : 'Off'}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Ring my phone first"
            aria-describedby={enableHelpVisible ? 'call-forwarding-enable-help' : undefined}
            aria-busy={pendingAction === 'toggle'}
            disabled={toggleDisabled}
            onClick={() => void handleToggle(!enabled)}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--brand-primary-rgb)/.40)] disabled:cursor-not-allowed dark:focus-visible:ring-[rgb(var(--brand-primary-dark-rgb)/.40)] ${
              enabled
                ? 'bg-[var(--brand-primary)] dark:bg-[var(--brand-primary-dark)]'
                : 'bg-stone-300 dark:bg-white/[0.12]'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
      </div>

      <ol
        aria-label="How a call is handled"
        className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-stretch"
      >
        {flowSteps.map((step, index) => (
          <li key={step.label} className="flex flex-1 items-center gap-2">
            <div className={`${tileRow} flex-1 px-3 py-2.5`}>
              <p className={`text-xs ${bodyFaint}`}>{step.label}</p>
              <p className={`text-sm font-medium tabular-nums ${ink}`}>{step.detail}</p>
            </div>
            {index < flowSteps.length - 1 && (
              <ArrowRight className="hidden h-4 w-4 shrink-0 text-stone-400 sm:block dark:text-[#8a8a8d]" aria-hidden />
            )}
          </li>
        ))}
      </ol>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <div className="flex-1">
          <div className="mb-1 flex items-center justify-between gap-3">
            <label
              htmlFor="forward-to-number"
              className="block text-sm font-medium text-stone-700 dark:text-[#d7d7d9]"
            >
              Phone to ring
            </label>
            {numberIsDirty && (
              <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
                Not saved yet
              </span>
            )}
          </div>
          <input
            id="forward-to-number"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={forwardToNumber}
            onChange={(event) => {
              setForwardToNumber(event.target.value);
              setFeedback('');
              setError('');
            }}
            onBlur={() => {
              const parsed = parsePhoneInputToE164(forwardToNumber);
              if (parsed) setForwardToNumber(formatPhoneForDisplay(parsed));
            }}
            disabled={busy}
            aria-invalid={Boolean(visibleError)}
            aria-describedby={visibleError ? 'call-forwarding-error' : 'call-forwarding-number-help'}
            placeholder="(317) 555-1234"
            className="w-full rounded-[14px] px-3 py-2 focus:outline-none bg-white text-stone-900 placeholder:text-stone-400 border border-[#e3dacc] focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white/[0.06] dark:text-[#f5f5f5] dark:placeholder:text-[#666] dark:border-white/[0.12] dark:focus:border-[var(--brand-primary-dark)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)]"
          />
        </div>
        <button
          type="button"
          onClick={() => void handleSaveNumber()}
          disabled={busy || !numberIsDirty || Boolean(validationError)}
          className={`${primaryCtaInlineClass} self-end`}
        >
          {pendingAction === 'number' ? 'Saving...' : 'Save number'}
        </button>
      </div>

      {!visibleError && (
        <p id="call-forwarding-number-help" className={`mt-2 text-xs ${bodyFaint}`}>
          Usually your cell or the phone at your front desk.
          {enableHelpVisible && (
            <span id="call-forwarding-enable-help">
              {' '}Save it here first, then flip the switch on.
            </span>
          )}
        </p>
      )}
      {visibleError && (
        <p
          id="call-forwarding-error"
          role="alert"
          className="mt-2 flex items-center gap-1.5 text-sm text-red-500"
        >
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
          {visibleError}
        </p>
      )}
      {feedback && !visibleError && (
        <p
          aria-live="polite"
          className="mt-2 flex items-start gap-1.5 text-sm text-green-600 dark:text-green-400"
        >
          <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {feedback}
        </p>
      )}
    </div>
  );
}
