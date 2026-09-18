'use client';

import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import Link from 'next/link';
import { Lock } from 'lucide-react';
import type { AISettings } from '@/types/database';
import { PulsingDot } from '@/components/ui/pulsing-dot';
import GoogleCalendarConnect from './GoogleCalendarConnect';
import { primaryCtaInlineClass } from '@/lib/glass';
import { tile } from '@/lib/theme-v2/theme';

const aiSettingsSchema = z.object({
  tone: z.enum(['friendly', 'professional', 'balanced'] as const),
  business_voice: z.enum(['we', 'business_name'] as const),
  language: z.enum(['en', 'es', 'both'] as const),
  sms_response_delay_seconds: z.number().min(0).max(60),
  guardrails_text: z.string(),
  booking_enabled: z.boolean(),
  booking_mode: z.enum(['collect_info', 'schedule_direct'] as const),
});

type AISettingsData = z.infer<typeof aiSettingsSchema>;

const TONE_OPTIONS = [
  { value: 'friendly' as const, label: 'Friendly & Casual', description: 'Warm, approachable, uses casual language' },
  { value: 'professional' as const, label: 'Professional & Polished', description: 'Formal, authoritative, business-like' },
  { value: 'balanced' as const, label: 'Balanced', description: 'A mix of friendly and professional' },
];

const LANGUAGE_OPTIONS = [
  { value: 'en' as const, label: 'English' },
  { value: 'es' as const, label: 'Spanish' },
  { value: 'both' as const, label: 'Both' },
];

interface AISettingsFormProps {
  settings: AISettings;
  businessName: string;
  calendarEmail?: string | null;
  calendarConnected?: boolean;
  businessId?: string;
  canCustomizeAi?: boolean;
  canUseCalendar?: boolean;
  calendarGoalAvailable?: boolean;
  canUseGuardrails?: boolean;
  planActive?: boolean;
  fullSuiteAvailable: boolean;
  showSmsResponseDelay?: boolean;
}
function UpgradeNotice({
  plan,
  planActive,
  children,
}: {
  plan: 'Growth' | 'Full Suite';
  planActive: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2.5 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
      <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <p>
        {planActive ? children : 'Your subscription is inactive. Reactivate it in'}{' '}
        <Link href="/billing" className="font-semibold underline">
          {planActive ? `${plan} plan` : 'Billing'}
        </Link>
      </p>
    </div>
  );
}

export function buildAISettingsUpdates(
  data: AISettingsData,
  {
    canCustomizeAi,
    canUseCalendar,
    calendarGoalAvailable = true,
    canUseGuardrails,
  }: {
    canCustomizeAi: boolean;
    canUseCalendar: boolean;
    calendarGoalAvailable?: boolean;
    canUseGuardrails: boolean;
  }
): Partial<AISettings> {
  const updates: Partial<AISettings> = {
    language: data.language,
  };
  if (canCustomizeAi) {
    Object.assign(updates, {
      tone: data.tone,
      business_voice: data.business_voice,
      sms_response_delay_seconds: data.sms_response_delay_seconds,
    });
  }
  if (canUseCalendar && calendarGoalAvailable) {
    Object.assign(updates, {
      booking_enabled: data.booking_enabled,
      booking_mode: data.booking_enabled ? data.booking_mode : 'collect_info',
    });
  }
  if (canUseGuardrails) {
    updates.guardrails = data.guardrails_text
      .split('\n')
      .map((rule) => rule.trim())
      .filter(Boolean);
  }
  return updates;
}

export default function AISettingsForm({
  settings,
  businessName,
  calendarEmail = null,
  calendarConnected = calendarEmail !== null,
  businessId,
  canCustomizeAi = true,
  canUseCalendar = true,
  calendarGoalAvailable = true,
  canUseGuardrails = true,
  planActive = true,
  fullSuiteAvailable,
  showSmsResponseDelay = true,
}: AISettingsFormProps) {
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const {
    register,
    control,
    handleSubmit,
    watch,
  } = useForm<AISettingsData>({
    resolver: zodResolver(aiSettingsSchema),
    defaultValues: {
      tone: settings.tone,
      business_voice: settings.business_voice,
      language: settings.language,
      sms_response_delay_seconds: settings.sms_response_delay_seconds,
      guardrails_text: (settings.guardrails || []).join('\n'),
      booking_enabled: settings.booking_enabled,
      booking_mode: settings.booking_mode,
    },
  });

  const bookingEnabled = watch('booking_enabled');
  const bookingMode = watch('booking_mode');
  const responseDelay = watch('sms_response_delay_seconds');
  const selectedTone = watch('tone');

  const getDelayLabel = (seconds: number) => {
    if (seconds === 0) return 'Instant';
    if (seconds < 60) return `${seconds} seconds`;
    return '1 minute';
  };

  const onSubmit = async (data: AISettingsData) => {
    setSaving(true);
    setSuccess(false);
    setSaveError(null);
    try {
      const supabase = createClient();
      const updates = buildAISettingsUpdates(data, {
        canCustomizeAi,
        canUseCalendar,
        calendarGoalAvailable,
        canUseGuardrails,
      });

      const { error } = await supabase
        .from('ai_settings')
        .update(updates)
        .eq('id', settings.id)
        .select('id')
        .single();
      if (error) throw error;
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch {
      setSaveError('Could not save settings. Your changes are still here. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} onChange={() => setSuccess(false)} className="space-y-8">
      {/* Section 1: Tone & Voice */}
      <section>
        <h3 className="text-lg font-semibold text-stone-900 dark:text-[#f5f5f5] mb-1">Tone & Voice</h3>
        <p className="text-sm text-stone-500 dark:text-[#bdbdbf] mb-4">How your AI assistant communicates with customers.</p>

        {!canCustomizeAi && (
          <UpgradeNotice plan="Growth" planActive={planActive}>Tone and voice customization requires the</UpgradeNotice>
        )}

        <div className="space-y-4">
          <div
            className={!canCustomizeAi ? 'pointer-events-none opacity-60' : undefined}
            aria-disabled={!canCustomizeAi}
          >
            <label className="block text-sm font-medium text-stone-700 dark:text-[#bdbdbf] mb-2">Tone</label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {TONE_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className={`cursor-pointer p-4 border-2 rounded-lg text-center transition-colors ${
                    selectedTone === opt.value
                      ? 'border-[var(--brand-primary)] ring-2 ring-[rgb(var(--brand-primary-rgb)/.25)] bg-[var(--brand-accent-soft)] dark:border-[var(--brand-primary-dark)] dark:bg-[rgb(var(--brand-primary-dark-rgb)/.10)]'
                      : 'border-[#ece4d8] bg-[#faf7f2] hover:border-[#e3dacc] dark:border-white/[0.10] dark:bg-white/[0.04] dark:hover:border-white/[0.20]'
                  }`}
                >
                  <input type="radio" value={opt.value} {...register('tone')} tabIndex={canCustomizeAi ? undefined : -1} className="sr-only" />
                  <p className="font-medium text-sm text-stone-900 dark:text-[#f5f5f5]">{opt.label}</p>
                  <p className="text-xs text-stone-500 dark:text-[#bdbdbf] mt-1">{opt.description}</p>
                </label>
              ))}
            </div>
          </div>

          <div
            className={!canCustomizeAi ? 'pointer-events-none opacity-60' : undefined}
            aria-disabled={!canCustomizeAi}
          >
            <label className="block text-sm font-medium text-stone-700 dark:text-[#bdbdbf] mb-2">Business Voice</label>
            <div className="flex gap-3">
              <label
                className={`flex-1 cursor-pointer p-3 border-2 rounded-lg text-center transition-colors ${
                  watch('business_voice') === 'we' ? 'border-[var(--brand-primary)] ring-2 ring-[rgb(var(--brand-primary-rgb)/.25)] bg-[var(--brand-accent-soft)] dark:border-[var(--brand-primary-dark)] dark:bg-[rgb(var(--brand-primary-dark-rgb)/.10)]' : 'border-[#ece4d8] bg-[#faf7f2] hover:border-[#e3dacc] dark:border-white/[0.10] dark:bg-white/[0.04] dark:hover:border-white/[0.20]'
                }`}
              >
                <input type="radio" value="we" {...register('business_voice')} tabIndex={canCustomizeAi ? undefined : -1} className="sr-only" />
                <p className="font-medium text-sm text-stone-900 dark:text-[#f5f5f5]">&ldquo;We&rdquo;</p>
                <p className="text-xs text-stone-500 dark:text-[#bdbdbf]">We can help you with...</p>
              </label>
              <label
                className={`flex-1 cursor-pointer p-3 border-2 rounded-lg text-center transition-colors ${
                  watch('business_voice') === 'business_name' ? 'border-[var(--brand-primary)] ring-2 ring-[rgb(var(--brand-primary-rgb)/.25)] bg-[var(--brand-accent-soft)] dark:border-[var(--brand-primary-dark)] dark:bg-[rgb(var(--brand-primary-dark-rgb)/.10)]' : 'border-[#ece4d8] bg-[#faf7f2] hover:border-[#e3dacc] dark:border-white/[0.10] dark:bg-white/[0.04] dark:hover:border-white/[0.20]'
                }`}
              >
                <input type="radio" value="business_name" {...register('business_voice')} tabIndex={canCustomizeAi ? undefined : -1} className="sr-only" />
                <p className="font-medium text-sm text-stone-900 dark:text-[#f5f5f5]">&ldquo;{businessName}&rdquo;</p>
                <p className="text-xs text-stone-500 dark:text-[#bdbdbf]">{businessName} can help...</p>
              </label>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-stone-700 dark:text-[#bdbdbf] mb-1">Language</label>
            <select
              {...register('language')}
              className="w-full px-3 py-2 rounded-lg bg-white text-stone-900 border border-[#e3dacc] focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] dark:bg-white/[0.06] dark:text-[#f5f5f5] dark:border-white/[0.12] dark:focus:border-[var(--brand-primary-dark)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)] focus:outline-none"
            >
              {LANGUAGE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {/* Section 2: Web Chat Greeting */}
      <section>
        <h3 className="text-lg font-semibold text-stone-900 dark:text-[#f5f5f5] mb-1">Web Chat Greeting</h3>
        {canCustomizeAi ? (
          <p className="text-sm text-stone-500 dark:text-[#bdbdbf]">
            Configure your web chat greeting in <a href="/widget" className="text-[var(--brand-accent)] hover:text-[var(--brand-primary-active)] dark:text-[var(--brand-accent-dark)] dark:hover:text-[var(--brand-primary-soft-dark)] underline">Widget Settings</a>.
          </p>
        ) : (
          <UpgradeNotice plan="Growth" planActive={planActive}>Web chat settings require the</UpgradeNotice>
        )}
      </section>

      {/* Section 3: Response Behavior */}
      {showSmsResponseDelay && <section>
        <h3 className="text-lg font-semibold text-stone-900 dark:text-[#f5f5f5] mb-1">Response Behavior</h3>
        <p className="text-sm text-stone-500 dark:text-[#bdbdbf] mb-4">Control how quickly your AI responds to SMS messages.</p>

        {!canCustomizeAi && (
          <UpgradeNotice plan="Growth" planActive={planActive}>AI response controls require the</UpgradeNotice>
        )}

        <div
          className={!canCustomizeAi ? 'pointer-events-none opacity-60' : undefined}
          aria-disabled={!canCustomizeAi}
        >
          <label className="block text-sm font-medium text-stone-700 dark:text-[#bdbdbf] mb-1">
            SMS Response Delay: <span className="text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)]">{getDelayLabel(responseDelay)}</span>
          </label>
          <Controller
            name="sms_response_delay_seconds"
            control={control}
            render={({ field }) => (
              <input
                type="range"
                min={0}
                max={60}
                step={5}
                value={field.value}
                onChange={(e) => field.onChange(Number(e.target.value))}
                tabIndex={canCustomizeAi ? undefined : -1}
                className="w-full h-2 bg-stone-200 dark:bg-white/[0.10] rounded-lg appearance-none cursor-pointer accent-[var(--brand-primary)] dark:accent-[var(--brand-primary-dark)]"
              />
            )}
          />
          <div className="flex justify-between text-xs text-stone-400 dark:text-[#666] mt-1">
            <span>Instant</span>
            <span>1 minute</span>
          </div>
        </div>
      </section>}

      {/* Section 4: Booking */}
      {calendarGoalAvailable && (
        <section className={`${tile} p-5 sm:p-6`} data-booking-card="true">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-[#ece4d8] bg-white dark:border-white/[0.12] dark:bg-white/[0.08]">
              <span
                role="img"
                aria-label="Google Calendar"
                className="h-7 w-7 bg-contain bg-center bg-no-repeat"
                style={{ backgroundImage: "url('/marketing/technology/google-calendar.svg')" }}
                data-google-calendar-icon="true"
              />
            </span>
            <div>
              <h3 className="mb-1 text-lg font-semibold text-stone-900 dark:text-[#f5f5f5]">Booking</h3>
              <p className="text-sm text-stone-500 dark:text-[#bdbdbf]">
                Let your AI handle appointment scheduling.
              </p>
            </div>
          </div>

          <div className={`flex items-center justify-between gap-3 sm:justify-end ${!canUseCalendar ? 'opacity-60' : ''}`}>
            <span className="text-sm font-medium text-stone-700 dark:text-[#bdbdbf]">
              Enable Appointment Booking
            </span>
            <Controller
              name="booking_enabled"
              control={control}
              render={({ field }) => (
                <button
                  type="button"
                  onClick={() => canUseCalendar && field.onChange(!field.value)}
                  disabled={!canUseCalendar}
                  aria-label="Enable Appointment Booking"
                  aria-pressed={field.value}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                    field.value ? 'bg-[var(--brand-primary)] dark:bg-[var(--brand-primary-dark)]' : 'bg-stone-200 dark:bg-white/[0.12]'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                      field.value ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              )}
            />
          </div>
        </div>

        {!canUseCalendar && (
          <div className="mt-4">
            <UpgradeNotice plan="Growth" planActive={planActive}>Google Calendar and AI booking require the</UpgradeNotice>
          </div>
        )}

        {bookingEnabled && (
          <>
            <div
              className={`mt-5 space-y-2 border-l-2 border-[rgb(var(--brand-primary-rgb)/.30)] pl-4 dark:border-[rgb(var(--brand-primary-dark-rgb)/.30)] ${!canUseCalendar ? 'pointer-events-none opacity-60' : ''}`}
              aria-disabled={!canUseCalendar}
            >
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" value="collect_info" {...register('booking_mode')} tabIndex={canUseCalendar ? undefined : -1} className="text-[var(--brand-accent)] accent-[var(--brand-primary)] dark:text-[var(--brand-accent-dark)] dark:accent-[var(--brand-primary-dark)]" />
                <div>
                  <p className="text-sm font-medium text-stone-700 dark:text-[#bdbdbf]">Collect customer info</p>
                  <p className="text-xs text-stone-500 dark:text-[#666]">AI gathers details, you confirm the booking</p>
                </div>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" value="schedule_direct" {...register('booking_mode')} tabIndex={canUseCalendar ? undefined : -1} className="text-[var(--brand-accent)] accent-[var(--brand-primary)] dark:text-[var(--brand-accent-dark)] dark:accent-[var(--brand-primary-dark)]" />
                <div>
                  <p className="text-sm font-medium text-stone-700 dark:text-[#bdbdbf]">Direct scheduling</p>
                  <p className="text-xs text-stone-500 dark:text-[#666]">AI books appointments directly on your calendar</p>
                </div>
              </label>
            </div>

            {/* Google Calendar Connection - inline whenever booking is enabled */}
            {businessId && (
              <div className="mt-5 border-t border-[#e3dacc] pt-5 dark:border-white/[0.12]">
                <p className="mb-2 text-sm font-medium text-stone-900 dark:text-[#f5f5f5]">Google Calendar</p>
                {bookingMode === 'collect_info' && (
                  <p className="mb-3 text-xs text-stone-500 dark:text-[#bdbdbf]">
                    optional — connect to enable direct scheduling
                  </p>
                )}
                <GoogleCalendarConnect
                  businessId={businessId}
                  connectedEmail={calendarEmail ?? null}
                  isConnected={calendarConnected}
                  canConnect={canUseCalendar}
                />
              </div>
            )}
          </>
        )}

        {!canUseCalendar && businessId && calendarConnected && !bookingEnabled && (
          <div className="mt-5 border-t border-[#e3dacc] pt-5 dark:border-white/[0.12]">
            <GoogleCalendarConnect
              businessId={businessId}
              connectedEmail={calendarEmail ?? null}
              isConnected={calendarConnected}
              canConnect={false}
            />
          </div>
        )}
        </section>
      )}

      {/* Section 5: Guardrails */}
      <section>
        <h3 className="text-lg font-semibold text-stone-900 dark:text-[#f5f5f5] mb-1">
          <label htmlFor="ai-settings-guardrails">Guardrails</label>
        </h3>
        <p className="text-sm text-stone-500 dark:text-[#bdbdbf] mb-4">Rules that guide what your AI can and can&apos;t say.</p>

        {!canUseGuardrails && (!planActive || fullSuiteAvailable) && (
          <UpgradeNotice plan="Full Suite" planActive={planActive}>Advanced guardrails require the</UpgradeNotice>
        )}

        <div className={!canUseGuardrails ? 'opacity-60' : undefined}>
        <Controller
          name="guardrails_text"
          control={control}
          render={({ field }) => (
            <textarea
              {...field}
              id="ai-settings-guardrails"
              aria-describedby="ai-settings-guardrails-help"
              rows={5}
              placeholder={"Don't give quotes over $500\nDon't promise same-day service\nAlways suggest calling for emergencies"}
              className="w-full px-3 py-2 rounded-lg bg-white text-stone-900 placeholder:text-stone-400 border border-[#e3dacc] focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] dark:bg-white/[0.06] dark:text-[#f5f5f5] dark:placeholder:text-[#666] dark:border-white/[0.12] dark:focus:border-[var(--brand-primary-dark)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)] focus:outline-none resize-y"
              disabled={!canUseGuardrails || saving}
            />
          )}
        />
        <p id="ai-settings-guardrails-help" className="text-xs text-stone-400 dark:text-[#666] mt-1">Write one rule per line, then click Save Settings. Edit or remove rules directly in this box.</p>
        </div>
      </section>

      {/* Save */}
      <div className="flex items-center gap-4 pt-4 border-t border-[#ece4d8] dark:border-white/[0.10]">
        <button
          type="submit"
          disabled={saving}
          className={primaryCtaInlineClass}
        >
          {saving ? (
            <>
              <PulsingDot inline />
              Saving…
            </>
          ) : (
            canCustomizeAi ? 'Save Settings' : 'Save Language'
          )}
        </button>
        {success && (
          <span role="status" className="text-sm text-green-600 dark:text-green-400 font-medium">Settings saved successfully!</span>
        )}
        {saveError && (
          <span role="alert" className="text-sm text-red-600 dark:text-red-400">{saveError}</span>
        )}
      </div>
    </form>
  );
}
