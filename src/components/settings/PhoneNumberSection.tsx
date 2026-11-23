'use client';

import { useState } from 'react';
import { Check, Copy, Phone } from 'lucide-react';
import PhoneNumberSelector from '@/components/phone/PhoneNumberSelector';
import CallForwardingForm from '@/components/settings/CallForwardingForm';
import ExistingNumberGuide from '@/components/settings/ExistingNumberGuide';
import { useBrand } from '@/components/branding/BrandProvider';
import { formatPhoneForDisplay } from '@/lib/phone/display';
import { cn } from '@/lib/utils';
import {
  statusSuccess,
  ink,
  body,
  bodyFaint,
  btnSecondaryCompact,
  inlineLink,
} from '@/lib/theme-v2/theme';
import { supportHref } from '@/lib/support/constants';

interface PhoneNumberSectionProps {
  phoneNumber: string | null;
  isActive: boolean;
  callForwardingEnabled: boolean;
  forwardToNumber: string | null;
}

export default function PhoneNumberSection({
  phoneNumber,
  isActive,
  callForwardingEnabled,
  forwardToNumber,
}: PhoneNumberSectionProps) {
  const brand = useBrand();
  const [copied, setCopied] = useState(false);
  // The server is the source of truth; this mirrors the forwarding switch so
  // the "keep your existing number" guide can warn about ringing twice.
  const [forwardingOn, setForwardingOn] = useState(callForwardingEnabled);

  const heading = (
    <>
      <h2 className={cn('mb-1 text-lg font-semibold', ink)}>
        Your {brand.name} number
      </h2>
      <p className={cn('mb-4 text-sm', bodyFaint)}>
        This is the number your customers call or text to reach your assistant.
      </p>
    </>
  );

  if (!phoneNumber || !isActive) {
    return (
      <>
        {heading}
        <PhoneNumberSelector />
      </>
    );
  }

  const displayNumber = formatPhoneForDisplay(phoneNumber);

  const copyNumber = async () => {
    try {
      await navigator.clipboard.writeText(displayNumber);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be blocked; the number stays selectable on screen.
    }
  };

  return (
    <>
      {heading}
      <div className="space-y-4">
        <div>
          <div className={cn('flex flex-wrap items-center gap-4 rounded-[22px] p-4', statusSuccess)}>
            <div className="rounded-[14px] bg-green-100 p-2.5 dark:bg-green-500/20">
              <Phone className="h-5 w-5 text-green-600 dark:text-green-400" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <p className={cn('text-xl font-bold tabular-nums', ink)}>{displayNumber}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', statusSuccess)}>
                  Active
                </span>
                <span className={cn('text-xs', body)}>Taking calls and texts 24/7</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void copyNumber()}
              className={btnSecondaryCompact}
            >
              {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
              <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
          <p className={cn('mt-2 px-1 text-xs', bodyFaint)}>
            Need a different number?{' '}
            <a href={supportHref('number_registration')} className={cn(inlineLink, 'underline')}>
              Contact support
            </a>
          </p>
        </div>

        <CallForwardingForm
          initialEnabled={callForwardingEnabled}
          initialForwardToNumber={forwardToNumber}
          smsPhoneNumber={phoneNumber}
          onEnabledChange={setForwardingOn}
        />

        <ExistingNumberGuide
          assistantNumber={phoneNumber}
          ringMyPhoneFirstOn={forwardingOn}
        />
      </div>
    </>
  );
}
