'use client';

import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, ExternalLink, PhoneIncoming } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { useBrand } from '@/components/branding/BrandProvider';
import { formatPhoneForDisplay } from '@/lib/phone/display';
import { supportHref } from '@/lib/support/constants';
import {
  tile,
  tileRow,
  ink,
  body,
  bodyFaint,
  btnSecondaryCompact,
  inlineLink,
  statusWarning,
} from '@/lib/theme-v2/theme';

/**
 * Carrier steps were checked against each carrier's own support pages in
 * November 2026. Only carriers that publish clear dial codes get printed
 * steps; the rest link out, because a wrong code is worse than no code.
 */
const CARRIER_STEPS_CHECKED = 'November 2026';

type CarrierId = 'verizon' | 'tmobile' | 'att' | 'other';

const CARRIERS: ReadonlyArray<{ id: CarrierId; label: string }> = [
  { id: 'verizon', label: 'Verizon' },
  { id: 'tmobile', label: 'T-Mobile' },
  { id: 'att', label: 'AT&T' },
  { id: 'other', label: 'Other' },
];

const OTHER_CARRIERS: ReadonlyArray<{ name: string; note: string; href: string }> = [
  {
    name: 'Xfinity Mobile',
    note: 'Uses the same *71 and *73 codes as Verizon.',
    href: 'https://www.xfinity.com/support/articles/how-to-use-call-forwarding',
  },
  {
    name: 'Visible',
    note: 'Uses the same *71 and *73 codes as Verizon.',
    href: 'https://www.visible.com/m/help/about-visible/plan-features',
  },
  {
    name: 'Mint Mobile',
    note: 'Uses the same codes as T-Mobile.',
    href: 'https://www.mintmobile.com/help/how-to-turn-on-off-call-forwarding/',
  },
  {
    name: 'Spectrum Mobile',
    note: 'Set it up in your Spectrum account or the My Spectrum app.',
    href: 'https://www.spectrum.net/support/mobile/spectrum-mobile-call-forwarding',
  },
  {
    name: 'Spectrum Business',
    note: 'Dial *92 to forward missed calls, *93 to stop.',
    href: 'https://www.spectrumbusiness.net/support/voice/call-forwarding-features-and-access-codes',
  },
  {
    name: 'Comcast Business',
    note: 'My Account → Phone → Features → Call Forwarding → No Answer.',
    href: 'https://business.comcast.com/support/article/voice/manage-call-forwarding-voiceedge-select/',
  },
  {
    name: 'RingCentral',
    note: 'Set a call rule to forward when no one answers.',
    href: 'https://support.ringcentral.com/article-v2/Forwarding-calls-external-number.html?brand=RC_US&product=RingEX&language=en_US',
  },
  {
    name: 'Google Fi',
    note: 'Can only forward every call. It has no “only when I don’t answer” option.',
    href: 'https://support.google.com/fi/answer/6201380',
  },
];

function CopyableCode({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be blocked; the code stays selectable on screen.
    }
  };
  return (
    <div className={`${tileRow} flex items-center justify-between gap-3 px-3 py-2`}>
      <div className="min-w-0">
        <p className={`text-xs ${bodyFaint}`}>{label}</p>
        <p className={`select-all break-all font-mono text-base font-semibold ${ink}`}>{code}</p>
      </div>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={`Copy ${code}`}
        className={btnSecondaryCompact}
      >
        {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
        <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  );
}

function CarrierLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`${inlineLink} inline-flex items-center gap-1 underline`}
    >
      {children}
      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
    </a>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return (
    <ol className={`list-decimal space-y-2 pl-5 text-sm ${body}`}>{children}</ol>
  );
}

export default function ExistingNumberGuide({
  assistantNumber,
  ringMyPhoneFirstOn,
}: {
  /** The assistant's number in E.164. */
  assistantNumber: string;
  /** True while "Ring my phone first" is on, which conflicts with this setup. */
  ringMyPhoneFirstOn: boolean;
}) {
  const brand = useBrand();
  const [open, setOpen] = useState(false);
  const [carrier, setCarrier] = useState<CarrierId>('verizon');

  const displayNumber = formatPhoneForDisplay(assistantNumber);
  const digits = assistantNumber.replace(/\D/g, '');
  // Dial codes below are US formats; only fill them in for a US number.
  const tenDigits =
    digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : null;

  return (
    <div className={`${tile} p-5`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-3">
          <div className="mt-0.5 h-fit rounded-[14px] bg-[var(--brand-primary-alt-wash)] p-2.5 dark:bg-[rgb(var(--brand-primary-alt-rgb)/.10)]">
            <PhoneIncoming className="h-5 w-5 text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)]" aria-hidden />
          </div>
          <div>
            <h3 className={`font-semibold ${ink}`}>Already have a business number?</h3>
            <p className={`mt-1 max-w-2xl text-sm ${body}`}>
              Keep it. Ask your phone company to send the calls you don&rsquo;t
              answer to your {brand.name} number, and your assistant takes it
              from there. This is set up with your phone company, not here.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`${btnSecondaryCompact} self-start sm:self-center`}
        >
          Show me how
        </button>
      </div>

      {/* Portaled to <body>: the dark-mode card uses backdrop-filter, which
          would otherwise trap a fixed-position modal inside the card. */}
      {open && createPortal(
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Keep your existing number"
        description={`Send the calls you miss on your own number to ${displayNumber}.`}
      >
        <div className="space-y-5">
          <ol aria-label="How it works" className={`space-y-1.5 text-sm ${body}`}>
            <li><span className={`font-medium ${ink}`}>1.</span> A customer calls the number they already know.</li>
            <li><span className={`font-medium ${ink}`}>2.</span> Your phone rings like normal.</li>
            <li><span className={`font-medium ${ink}`}>3.</span> If you don&rsquo;t pick up, your phone company passes the call to {displayNumber}.</li>
            <li><span className={`font-medium ${ink}`}>4.</span> Your assistant follows up using your Missed calls setting.</li>
          </ol>

          {ringMyPhoneFirstOn && (
            <p role="status" className={`rounded-[14px] p-3 text-sm ${statusWarning}`}>
              Turn off &ldquo;Ring my phone first&rdquo; before you set this up.
              With both on, a missed call gets sent back to your phone and can
              bounce between the two numbers.
            </p>
          )}

          <div>
            <p className={`mb-2 text-sm font-medium ${ink}`}>Who is your phone company?</p>
            <div role="tablist" aria-label="Phone company" className="flex flex-wrap gap-2">
              {CARRIERS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="tab"
                  aria-selected={carrier === option.id}
                  onClick={() => setCarrier(option.id)}
                  className={`rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
                    carrier === option.id
                      ? 'border-[var(--brand-primary)] bg-[var(--brand-accent-soft)] text-stone-900 dark:border-[var(--brand-primary-dark)] dark:bg-[rgb(var(--brand-primary-dark-rgb)/.12)] dark:text-[#f5f5f5]'
                      : 'border-[#e7e0d4] bg-white text-stone-700 hover:bg-[#faf6ef] dark:border-white/[0.12] dark:bg-white/[0.07] dark:text-[#d7d7d9] dark:hover:bg-white/[0.11]'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div role="tabpanel" className="space-y-3">
            {carrier === 'verizon' && (
              <>
                <Steps>
                  <li>On the phone that has your business number, open the keypad.</li>
                  <li>Dial the code below and press call.</li>
                  <li>Wait for the confirmation beeps. The call ends by itself.</li>
                </Steps>
                {tenDigits ? (
                  <CopyableCode code={`*71${tenDigits}`} label="Turn on (forwards calls you miss or can’t take)" />
                ) : (
                  <p className={`text-sm ${body}`}>Dial *71 followed by the 10-digit number.</p>
                )}
                <CopyableCode code="*73" label="Turn off" />
                <p className={`text-xs ${bodyFaint}`}>
                  It has to be done from that phone, inside Verizon coverage.
                  The confirmation can sound like a busy signal.{' '}
                  <CarrierLink href="https://www.verizon.com/support/call-forwarding-faqs/">Verizon&rsquo;s instructions</CarrierLink>
                </p>
              </>
            )}

            {carrier === 'tmobile' && (
              <>
                <Steps>
                  <li>On the phone that has your business number, open the keypad.</li>
                  <li>Dial each of the three codes below, pressing call after each one.</li>
                  <li>Your phone shows a confirmation after each code.</li>
                </Steps>
                {tenDigits ? (
                  <>
                    <CopyableCode code={`**61*1${tenDigits}#`} label="When you don’t answer" />
                    <CopyableCode code={`**67*1${tenDigits}#`} label="When you’re on another call" />
                    <CopyableCode code={`**62*1${tenDigits}#`} label="When your phone is off or has no signal" />
                  </>
                ) : (
                  <p className={`text-sm ${body}`}>
                    Dial **61*, **67*, and **62*, each followed by 1, the 10-digit number, and #.
                  </p>
                )}
                <CopyableCode code="##004#" label="Turn all three off" />
                <p className={`text-xs ${bodyFaint}`}>
                  Some prepaid and older plans don&rsquo;t support these codes, so make a test call.{' '}
                  <CarrierLink href="https://www.t-mobile.com/support/plans-features/self-service-short-codes">T-Mobile&rsquo;s instructions</CarrierLink>
                </p>
              </>
            )}

            {carrier === 'att' && (
              <>
                <p className={`text-sm ${body}`}>
                  AT&amp;T doesn&rsquo;t publish dial codes for this. It&rsquo;s set in your phone&rsquo;s own settings.
                </p>
                <Steps>
                  <li>
                    <span className={`font-medium ${ink}`}>Android:</span> open the Phone app, then
                    Settings &rarr; Calling accounts (or Supplementary services) &rarr; Call forwarding.
                  </li>
                  <li>
                    Set <span className={`font-medium ${ink}`}>When unanswered</span>,{' '}
                    <span className={`font-medium ${ink}`}>When busy</span>, and{' '}
                    <span className={`font-medium ${ink}`}>When unreachable</span> to {displayNumber}.
                  </li>
                  <li>
                    <span className={`font-medium ${ink}`}>iPhone:</span> the built-in setting only forwards
                    every call, so ask AT&amp;T to turn on forwarding for unanswered calls.
                  </li>
                </Steps>
                <p className={`text-xs ${bodyFaint}`}>
                  It can&rsquo;t be managed from your AT&amp;T online account, and it may not work on AT&amp;T Prepaid.{' '}
                  <CarrierLink href="https://www.att.com/support/article/wireless/KM1011513/">AT&amp;T&rsquo;s instructions</CarrierLink>
                </p>
              </>
            )}

            {carrier === 'other' && (
              <>
                <p className={`text-sm ${body}`}>
                  Ask your phone company for &ldquo;conditional call forwarding&rdquo; (forward when
                  unanswered) to {displayNumber}. A few common ones:
                </p>
                <ul className="space-y-2">
                  {OTHER_CARRIERS.map((item) => (
                    <li key={item.name} className={`${tileRow} px-3 py-2 text-sm`}>
                      <CarrierLink href={item.href}>{item.name}</CarrierLink>
                      <p className={`mt-0.5 text-xs ${bodyFaint}`}>{item.note}</p>
                    </li>
                  ))}
                </ul>
                <p className={`text-xs ${bodyFaint}`}>
                  Cricket, Metro, US Cellular, and most landlines don&rsquo;t publish steps. Call their
                  support line and ask them to set it up. Google Voice numbers can&rsquo;t forward to an
                  assistant line.
                </p>
              </>
            )}
          </div>

          <div className={`${tile} space-y-1.5 p-4 text-xs ${body}`}>
            <p className={`text-sm font-medium ${ink}`}>Good to know</p>
            <p>Call your number from another phone and let it ring to confirm it works.</p>
            <p>While this is on, missed calls go to your assistant instead of your phone company&rsquo;s voicemail.</p>
            <p>Texts from your assistant come from {displayNumber}, not your existing number.</p>
            <p>If the same phone is also your personal line, unanswered personal calls are forwarded too.</p>
          </div>

          <p className={`text-xs ${bodyFaint}`}>
            Phone companies change these steps from time to time. Last checked {CARRIER_STEPS_CHECKED}.
            Stuck?{' '}
            <a href={supportHref('number_registration')} className={`${inlineLink} underline`}>
              We can help you set it up
            </a>
            .
          </p>
        </div>
      </Modal>,
        document.body
      )}
    </div>
  );
}
