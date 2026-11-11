'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ExternalLink, Copy, Check, AlertCircle } from 'lucide-react';
import {
  buildPrivacyContent,
  buildTermsContent,
  toPlainText,
  type LegalTemplateBusiness,
} from '@/lib/legal/perBusinessCopy';
import { isPendingSlug } from '@/lib/util/slug.shared';
import {
  COMPLIANCE_LOCK_COPY,
  SETTINGS_REGISTRATION_LOCK_CODE,
} from '@/lib/settings/registrationLockCopy';
import { supportHref } from '@/lib/support/constants';
import { primaryCtaInlineClass } from '@/lib/glass';
import { inlineLink, statusWarning } from '@/lib/theme-v2/theme';
import { cn } from '@/lib/utils';

type Mode = 'hosted' | 'self_hosted' | 'existing';

const FALLBACK_CANONICAL_ORIGIN = 'https://simplassist.com';

export function canonicalComplianceUrl(
  path: `/c/${string}/${'privacy' | 'terms'}`,
  configuredOrigin = process.env.NEXT_PUBLIC_APP_URL,
): string {
  try {
    const url = new URL(configuredOrigin || FALLBACK_CANONICAL_ORIGIN);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password
    ) {
      throw new Error('Unsupported canonical URL');
    }

    return new URL(path, url.origin).toString();
  } catch {
    return new URL(path, FALLBACK_CANONICAL_ORIGIN).toString();
  }
}

interface CompliancePanelProps {
  slug: string;
  business: LegalTemplateBusiness;
  initialMode: Mode;
  initialPrivacyUrl: string | null;
  initialTermsUrl: string | null;
  registrationLocked: boolean;
}

type ComplianceSavePayload = {
  mode: Mode;
  privacyUrlOverride: string | null;
  termsUrlOverride: string | null;
};

export async function submitComplianceSettings({
  registrationLocked,
  payload,
  fetchImpl = fetch,
}: {
  registrationLocked: boolean;
  payload: ComplianceSavePayload;
  fetchImpl?: typeof fetch;
}): Promise<Response | null> {
  if (registrationLocked) return null;

  return fetchImpl('/api/settings/compliance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function refreshForStaleComplianceLock({
  status,
  code,
  refresh,
}: {
  status: number;
  code: string | undefined;
  refresh: () => void;
}): boolean {
  if (status !== 403 || code !== SETTINGS_REGISTRATION_LOCK_CODE) return false;
  refresh();
  return true;
}

const CHECKLIST_ITEMS = [
  'Explicit mention of SMS/text messaging (not just email/web)',
  '"Mobile information will not be shared with third parties for marketing"',
  'Instructions to opt out (e.g., "Reply STOP to unsubscribe")',
  'A statement that message frequency varies and msg & data rates may apply',
] as const;

export default function CompliancePanel({
  slug,
  business,
  initialMode,
  initialPrivacyUrl,
  initialTermsUrl,
  registrationLocked,
}: CompliancePanelProps) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [privacyUrl, setPrivacyUrl] = useState(initialPrivacyUrl ?? '');
  const [termsUrl, setTermsUrl] = useState(initialTermsUrl ?? '');
  const [checklist, setChecklist] = useState<boolean[]>([false, false, false, false]);
  const [showGenerated, setShowGenerated] = useState(false);
  const [copied, setCopied] = useState<'privacy' | 'terms' | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [errors, setErrors] = useState<{
    privacyUrlOverride?: string;
    termsUrlOverride?: string;
    general?: string;
  }>({});

  const pending = isPendingSlug(slug);

  // Generated plain-text bodies for self_hosted mode. Built lazily — same
  // template the public pages and Phase 3 submission use. NOT HTML; pasted
  // into the customer's own CMS.
  const generated = useMemo(() => {
    return {
      privacy: toPlainText(buildPrivacyContent(business)),
      terms: toPlainText(buildTermsContent(business)),
    };
  }, [business]);

  const allChecked = checklist.every(Boolean);
  // Save button disabled when:
  //   - already submitting
  //   - registration-backed settings are locked
  //   - slug is still 'pending-*' (brand verification not done — API would throw)
  //   - mode is 'existing' and not all 4 self-check boxes are ticked
  const saveDisabled =
    submitting ||
    registrationLocked ||
    pending ||
    (mode === 'existing' && !allChecked);

  const encodedSlug = encodeURIComponent(slug);
  const previewPrivacyHref = canonicalComplianceUrl(
    `/c/${encodedSlug}/privacy`,
  );
  const previewTermsHref = canonicalComplianceUrl(`/c/${encodedSlug}/terms`);

  const handleCopy = async (kind: 'privacy' | 'terms') => {
    try {
      await navigator.clipboard.writeText(generated[kind]);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // clipboard API blocked — surface a tiny inline note
      setCopied(null);
    }
  };

  const handleSave = async () => {
    if (registrationLocked) return;

    setSubmitting(true);
    setErrors({});
    setSaved(false);

    const payload =
      mode === 'hosted'
        ? { mode, privacyUrlOverride: null, termsUrlOverride: null }
        : {
            mode,
            privacyUrlOverride: privacyUrl.trim(),
            termsUrlOverride: termsUrl.trim(),
          };

    try {
      const res = await submitComplianceSettings({
        registrationLocked,
        payload,
      });
      if (!res) return;

      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        field?: 'privacyUrlOverride' | 'termsUrlOverride';
        code?: string;
      };

      if (!res.ok) {
        refreshForStaleComplianceLock({
          status: res.status,
          code: data.code,
          refresh: router.refresh,
        });
        if (data.field) {
          setErrors({ [data.field]: data.error ?? 'Invalid URL' });
        } else {
          setErrors({ general: data.error ?? 'Failed to save compliance settings' });
        }
        return;
      }

      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      setErrors({ general: 'Network error — please try again' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {registrationLocked && (
        <div className={cn("rounded-lg px-4 py-3 text-sm", statusWarning)}>
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
            <span>
              <a
                href={supportHref('number_registration')}
                className={cn(inlineLink, 'font-medium underline')}
              >
                {COMPLIANCE_LOCK_COPY.supportText}
              </a>
              {COMPLIANCE_LOCK_COPY.reasonText}
            </span>
          </div>
        </div>
      )}

      {pending && (
        <div className={cn("rounded-lg px-4 py-3 text-sm", statusWarning)}>
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
            <span>
              Complete brand verification first — your compliance options unlock
              once your business is registered with carriers.
            </span>
          </div>
        </div>
      )}

      <fieldset disabled={pending || registrationLocked} className="space-y-5">
        <legend className="sr-only">Privacy and Terms hosting mode</legend>

        {/* Mode: Hosted */}
        <ModeOption
          id="mode-hosted"
          name="compliance_mode"
          checked={mode === 'hosted'}
          onChange={() => setMode('hosted')}
          title="SimplAssist-hosted (default)"
          description="We generate and host your privacy policy and terms at SimplAssist URLs and automatically include these links in your carrier registration."
        >
          {mode === 'hosted' && (
            <div className="mt-3 grid gap-2 text-sm">
              <PreviewRow label="Privacy Policy" href={previewPrivacyHref} />
              <PreviewRow label="Terms of Service" href={previewTermsHref} />
            </div>
          )}
        </ModeOption>

        {/* Mode: Self-hosted */}
        <ModeOption
          id="mode-self-hosted"
          name="compliance_mode"
          checked={mode === 'self_hosted'}
          onChange={() => setMode('self_hosted')}
          title="Host on your own domain"
          description="We give you the formatted text — you paste it into your own website and tell us the resulting URLs."
        >
          {mode === 'self_hosted' && (
            <div className="mt-3 space-y-4">
              <button
                type="button"
                onClick={() => setShowGenerated((v) => !v)}
                className="text-sm font-medium text-[var(--brand-accent)] hover:text-[var(--brand-primary-active)] dark:text-[var(--brand-accent-dark)] dark:hover:text-[var(--brand-primary-soft-dark)]"
              >
                {showGenerated ? 'Hide generated copy' : 'View generated copy'}
              </button>
              {showGenerated && (
                <div className="space-y-4">
                  <GeneratedTextarea
                    label="Privacy Policy"
                    value={generated.privacy}
                    onCopy={() => handleCopy('privacy')}
                    copied={copied === 'privacy'}
                  />
                  <GeneratedTextarea
                    label="Terms of Service"
                    value={generated.terms}
                    onCopy={() => handleCopy('terms')}
                    copied={copied === 'terms'}
                  />
                </div>
              )}
              <UrlInput
                label="Your privacy policy URL"
                value={privacyUrl}
                onChange={setPrivacyUrl}
                placeholder="https://yourbusiness.com/privacy"
                error={errors.privacyUrlOverride}
              />
              <UrlInput
                label="Your terms of service URL"
                value={termsUrl}
                onChange={setTermsUrl}
                placeholder="https://yourbusiness.com/terms"
                error={errors.termsUrlOverride}
              />
            </div>
          )}
        </ModeOption>

        {/* Mode: Existing */}
        <ModeOption
          id="mode-existing"
          name="compliance_mode"
          checked={mode === 'existing'}
          onChange={() => setMode('existing')}
          title="I already have an SMS-compliant privacy policy"
          description="Your existing privacy policy must mention SMS, opt-in/opt-out, and the required carrier clauses. Not sure? Choose &quot;Host on your own domain&quot; to get the correct copy."
        >
          {mode === 'existing' && (
            <div className="mt-4 space-y-4">
              <div className={cn("rounded-lg px-4 py-3", statusWarning)}>
                <p className="text-sm font-medium text-stone-900 dark:text-[#f5f5f5]">
                  Before pasting your URL, confirm your existing privacy policy includes:
                </p>
                <ul className="mt-2 space-y-1.5">
                  {CHECKLIST_ITEMS.map((item, idx) => (
                    <li key={idx}>
                      <label className="flex items-start gap-2 text-sm text-stone-700 dark:text-[#bdbdbf]">
                        <input
                          type="checkbox"
                          checked={checklist[idx]}
                          onChange={(e) => {
                            const next = [...checklist];
                            next[idx] = e.target.checked;
                            setChecklist(next);
                          }}
                          className="mt-0.5 h-4 w-4 shrink-0 rounded border-[#e3dacc] text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)] focus:ring-[rgb(var(--brand-primary-rgb)/.40)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.40)]"
                        />
                        <span>{item}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs text-stone-600 dark:text-[#9a9a9c]">
                  If your policy is missing any of these, choose &quot;Host on your own domain&quot; instead to get compliant copy.
                </p>
              </div>
              <UrlInput
                label="Your privacy policy URL"
                value={privacyUrl}
                onChange={setPrivacyUrl}
                placeholder="https://yourbusiness.com/privacy"
                error={errors.privacyUrlOverride}
              />
              <UrlInput
                label="Your terms of service URL"
                value={termsUrl}
                onChange={setTermsUrl}
                placeholder="https://yourbusiness.com/terms"
                error={errors.termsUrlOverride}
              />
            </div>
          )}
        </ModeOption>
      </fieldset>

      {errors.general && (
        <p className="text-sm text-red-500">{errors.general}</p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saveDisabled}
          className={primaryCtaInlineClass}
        >
          {submitting
            ? mode === 'hosted'
              ? 'Saving…'
              : 'Checking URLs…'
            : saved
              ? 'Saved!'
              : 'Save'}
        </button>
        {mode !== 'hosted' && submitting && (
          <span className="text-xs text-stone-500 dark:text-[#bdbdbf]">
            Verifying your URLs are reachable — this can take up to 10 seconds.
          </span>
        )}
        {mode === 'existing' && !allChecked && (
          <span className="text-xs text-stone-500 dark:text-[#bdbdbf]">
            Tick all four checkboxes to enable save.
          </span>
        )}
      </div>
    </div>
  );
}

// ----- sub-components -----

function ModeOption({
  id,
  name,
  checked,
  onChange,
  title,
  description,
  children,
}: {
  id: string;
  name: string;
  checked: boolean;
  onChange: () => void;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <label
      htmlFor={id}
      className={`block cursor-pointer rounded-xl border p-4 transition-colors ${
        checked
          ? 'border-[var(--brand-primary)] ring-2 ring-[rgb(var(--brand-primary-rgb)/.25)] bg-[var(--brand-accent-soft)] dark:border-[var(--brand-primary-dark)] dark:bg-[rgb(var(--brand-primary-dark-rgb)/.10)]'
          : 'border-[#ece4d8] bg-[#faf7f2] hover:border-[#e3dacc] dark:border-white/[0.10] dark:bg-white/[0.04] dark:hover:border-white/20'
      }`}
    >
      <div className="flex items-start gap-3">
        <input
          id={id}
          name={name}
          type="radio"
          checked={checked}
          onChange={onChange}
          className="mt-1 h-4 w-4 shrink-0 text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)] focus:ring-[rgb(var(--brand-primary-rgb)/.40)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.40)]"
        />
        <div className="flex-1">
          <div className="text-sm font-semibold text-stone-900 dark:text-[#f5f5f5]">
            {title}
          </div>
          <p className="mt-0.5 text-sm text-stone-600 dark:text-[#bdbdbf]">
            {description}
          </p>
          {children}
        </div>
      </div>
    </label>
  );
}

function PreviewRow({ label, href }: { label: string; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center justify-between gap-2 rounded-full border border-[#ece4d8] bg-white px-3 py-2 text-sm text-stone-700 transition-colors hover:border-[var(--brand-primary)] hover:text-[var(--brand-accent)] dark:border-white/10 dark:bg-white/[0.03] dark:text-[#bdbdbf] dark:hover:border-[var(--brand-primary-dark)] dark:hover:text-[var(--brand-accent-dark)]"
    >
      <span>
        <span className="font-medium">{label}</span>
        <span className="ml-2 text-xs text-stone-500 dark:text-[#9a9a9c]">{href}</span>
      </span>
      <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
    </a>
  );
}

function GeneratedTextarea({
  label,
  value,
  onCopy,
  copied,
}: {
  label: string;
  value: string;
  onCopy: () => void;
  copied: boolean;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-sm font-medium text-stone-700 dark:text-[#bdbdbf]">
          {label}
        </span>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1.5 rounded-full border border-[#ece4d8] bg-white px-2.5 py-1 text-xs font-medium text-stone-700 transition-colors hover:border-[var(--brand-primary)] hover:text-[var(--brand-accent)] dark:border-white/10 dark:bg-white/[0.03] dark:text-[#bdbdbf] dark:hover:border-[var(--brand-primary-dark)] dark:hover:text-[var(--brand-accent-dark)]"
        >
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <textarea
        readOnly
        value={value}
        rows={10}
        className="w-full rounded-lg border border-[#e3dacc] bg-white px-3 py-2 font-mono text-xs leading-relaxed text-stone-900 focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] dark:border-white/[0.12] dark:bg-white/[0.06] dark:text-[#f5f5f5] dark:focus:border-[var(--brand-primary-dark)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)]"
      />
    </div>
  );
}

function UrlInput({
  label,
  value,
  onChange,
  placeholder,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  error?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-stone-700 dark:text-[#bdbdbf] mb-1.5">
        {label}
      </label>
      <input
        type="url"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full px-3 py-2 rounded-lg border bg-white text-stone-900 placeholder:text-stone-400 focus:outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] dark:bg-white/[0.06] dark:text-[#f5f5f5] dark:placeholder:text-[#666] dark:focus:border-[var(--brand-primary-dark)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)] ${
          error
            ? 'border-red-400 dark:border-red-500/50'
            : 'border-[#e3dacc] dark:border-white/[0.12]'
        }`}
      />
      {error && <p className="mt-1 text-sm text-red-500">{error}</p>}
    </div>
  );
}
