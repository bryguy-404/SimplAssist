'use client';

import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useEffect, useState } from 'react';
import { BookingOfferingFields } from '@/components/settings/BookingSettingsForm';
import { bookingOfferingSchema } from '@/lib/booking/contracts';
import { createClient } from '@/lib/supabase/client';
import type {
  AITone,
  Language,
  OnboardingStep,
  PrimaryGoal,
} from '@/types/database';
import { PulsingDot } from '@/components/ui/pulsing-dot';
import { primaryCtaInlineClass, secondaryCtaClass } from '@/lib/glass';
import { PrimaryGoalFields } from '@/components/goals/PrimaryGoalFields';
import {
  buildPrimaryGoalUpdate,
  isEditablePrimaryGoal,
  normalizeHttpsGoalUrl,
} from '@/lib/goals/primaryGoal';

const aiPersonalitySchema = z
  .object({
    primary_goal: z.enum(['book', 'signup'] as const),
    goal_url: z.string(),
    tone: z.enum(['friendly', 'professional', 'balanced'] as const),
    business_voice: z.enum(['we', 'business_name'] as const),
    language: z.enum(['en', 'es', 'both'] as const),
    response_delay_seconds: z.number().min(0).max(60),
    web_greeting: z.string().min(1, 'Web chat greeting is required'),
    guardrails: z.string().optional(),
    booking_enabled: z.boolean(),
    booking_details: bookingOfferingSchema.optional(),
    booking_revision: z.number().int().nonnegative().optional(),
    booking_mode: z.enum(['collect_info', 'schedule_direct'] as const).optional(),
  })
  .superRefine((data, context) => {
    if (data.primary_goal === 'book' && data.booking_enabled && !data.booking_details) {
      context.addIssue({ code: 'custom', path: ['booking_details'], message: 'Choose the kind of appointment customers should book.' });
    }
    if (data.primary_goal === 'signup' && !normalizeHttpsGoalUrl(data.goal_url)) {
      context.addIssue({
        code: 'custom',
        path: ['goal_url'],
        message: 'invalid_goal_url',
      });
    }
  });

export type AIPersonalityData = z.infer<typeof aiPersonalitySchema>;

type SaveAIPersonalitySettingsArgs = {
  supabase: ReturnType<typeof createClient>;
  businessId: string;
  data: AIPersonalityData;
  onNext: (data: AIPersonalityData) => void | Promise<void>;
  now?: () => string;
  nextOnboardingStep?: OnboardingStep;
};

export async function saveAIPersonalitySettings({
  supabase,
  businessId,
  data,
  onNext,
  now = () => new Date().toISOString(),
  nextOnboardingStep = 'legal_verification',
}: SaveAIPersonalitySettingsArgs): Promise<void> {
  const primaryGoalUpdate = buildPrimaryGoalUpdate(data);
  if (!primaryGoalUpdate) {
    throw new Error('invalid_primary_goal');
  }

  if (data.primary_goal === 'book' && data.booking_enabled) {
    if (!data.booking_details || data.booking_revision === undefined) throw new Error('Choose and save booking details before continuing.');
    const currentResponse = await fetch('/api/settings/booking', { cache: 'no-store' });
    if (!currentResponse.ok) throw new Error('Booking details are unavailable.');
    const current = await currentResponse.json();
    const response = await fetch('/api/settings/booking', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: data.booking_revision, defaults: data.booking_details, services: current.booking.services }) });
    if (!response.ok) throw new Error('Booking details could not be saved. Refresh and try again.');
    const saved = await response.json();
    data.booking_revision = saved.booking.revision;
  }

  const guardrailLines = data.guardrails
    ? data.guardrails.split('\n').filter((line) => line.trim())
    : [];

  const { error } = await supabase.from('ai_settings').upsert({
    business_id: businessId,
    tone: data.tone,
    business_voice: data.business_voice,
    language: data.language,
    sms_response_delay_seconds: data.response_delay_seconds,
    guardrails: guardrailLines,
    booking_enabled: data.booking_enabled,
    booking_mode: data.booking_enabled ? data.booking_mode : 'collect_info',
  }, { onConflict: 'business_id' });
  if (error) throw error;

  if (data.web_greeting.trim()) {
    const { error: widgetError } = await supabase.from('widget_configs').upsert({
      business_id: businessId,
      welcome_message: data.web_greeting,
    }, { onConflict: 'business_id' });
    if (widgetError) {
      console.warn('Failed to save widget welcome message:', widgetError.message);
    }
  }

  const { error: businessError } = await supabase.from('businesses').update({
    ...primaryGoalUpdate,
    onboarding_step: nextOnboardingStep,
    onboarding_last_saved_at: now(),
  }).eq('id', businessId);
  if (businessError) throw businessError;

  await onNext(data);
}

interface AIPersonalityFormProps {
  businessId: string;
  businessName: string;
  initialPrimaryGoal: PrimaryGoal | null;
  initialGoalUrl: string | null;
  initialData?: Partial<AIPersonalityData>;
  onNext: (data: AIPersonalityData) => void | Promise<void>;
  onBack: () => void;
  showSmsResponseDelay?: boolean;
  nextOnboardingStep?: OnboardingStep;
}

const TONE_OPTIONS: { value: AITone; label: string; description: string }[] = [
  { value: 'friendly', label: 'Friendly & Casual', description: 'Warm, approachable, uses casual language' },
  { value: 'professional', label: 'Professional & Polished', description: 'Formal, authoritative, business-like' },
  { value: 'balanced', label: 'Balanced', description: 'A mix of friendly and professional' },
];

const LANGUAGE_OPTIONS: { value: Language; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'both', label: 'Both' },
];

export default function AIPersonalityForm({
  businessId,
  businessName,
  initialPrimaryGoal,
  initialGoalUrl,
  initialData,
  onNext,
  onBack,
  showSmsResponseDelay = true,
  nextOnboardingStep = 'legal_verification',
}: AIPersonalityFormProps) {
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
  } = useForm<AIPersonalityData>({
    resolver: zodResolver(aiPersonalitySchema),
    defaultValues: {
      primary_goal: isEditablePrimaryGoal(initialPrimaryGoal)
        ? initialPrimaryGoal
        : undefined,
      goal_url: initialGoalUrl ?? '',
      tone: initialData?.tone || 'balanced',
      business_voice: initialData?.business_voice || 'we',
      language: initialData?.language || 'en',
      response_delay_seconds: initialData?.response_delay_seconds ?? 5,
      web_greeting: initialData?.web_greeting || `Hi! I'm ${businessName}'s assistant. Ask me anything about our services.`,
      guardrails: initialData?.guardrails || '',
      booking_enabled: initialData?.booking_enabled ?? false,
      booking_mode: initialData?.booking_mode || 'collect_info',
    },
  });

  const [bookingLoadError, setBookingLoadError] = useState('');
  useEffect(() => {
    let active = true;
    fetch('/api/settings/booking', { cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error('Booking details could not be loaded.');
      const data = await response.json();
      if (!active) return;
      setValue('booking_revision', data.booking.revision);
      if (data.booking.defaults) setValue('booking_details', data.booking.defaults);
    }).catch(() => { if (active) setBookingLoadError('Booking details could not be loaded. Refresh before continuing with booking.'); });
    return () => { active = false; };
  }, [setValue]);
  const bookingDetails = watch('booking_details');
  const bookingRevision = watch('booking_revision');
  const bookingEnabled = watch('booking_enabled');
  const responseDelay = watch('response_delay_seconds');
  const selectedTone = watch('tone');
  const primaryGoal = watch('primary_goal') ?? null;
  const goalUrl = watch('goal_url') ?? '';
  const goalUpdate = buildPrimaryGoalUpdate({
    primary_goal: primaryGoal,
    goal_url: goalUrl,
  });

  const onSubmit = async (data: AIPersonalityData) => {
    setSaving(true);
    setSubmitError('');
    try {
      await saveAIPersonalitySettings({
        supabase: createClient(),
        businessId,
        data,
        onNext,
        nextOnboardingStep,
      });
    } catch {
      setSubmitError('Could not save your AI settings. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const getDelayLabel = (seconds: number) => {
    if (seconds === 0) return 'Instant';
    if (seconds < 60) return `${seconds} seconds`;
    return '1 minute';
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <PrimaryGoalFields
        primaryGoal={primaryGoal}
        goalUrl={goalUrl}
        onPrimaryGoalChange={(goal) =>
          setValue('primary_goal', goal, {
            shouldDirty: true,
            shouldValidate: true,
          })
        }
        onGoalUrlChange={(value) =>
          setValue('goal_url', value, {
            shouldDirty: true,
            shouldValidate: true,
          })
        }
        disabled={saving}
      />

      <h2 className="text-xl font-semibold text-stone-900 dark:text-[#f5f5f5]">Customize your AI assistant</h2>

      {/* Tone Selector */}
      <div>
        <label className="block text-sm font-medium text-stone-700 dark:text-[#d4d4d8] mb-2">Tone</label>
        <div className="grid grid-cols-3 gap-3">
          {TONE_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={`cursor-pointer p-4 border-2 rounded-lg text-center transition-colors ${
                selectedTone === opt.value
                  ? 'border-[var(--brand-primary)] ring-2 ring-[rgb(var(--brand-primary-rgb)/.25)] bg-[var(--brand-accent-soft)] dark:border-[var(--brand-primary-dark)] dark:bg-[rgb(var(--brand-primary-dark-rgb)/.10)]'
                  : 'border-[#ece4d8] bg-[#faf7f2] hover:border-[#e3dacc] dark:border-white/[0.10] dark:bg-white/[0.04] dark:hover:border-white/[0.20]'
              }`}
            >
              <input
                type="radio"
                value={opt.value}
                {...register('tone')}
                className="sr-only"
              />
              <p className="font-medium text-sm text-stone-900 dark:text-[#f5f5f5]">{opt.label}</p>
              <p className="text-xs text-stone-500 dark:text-[#bdbdbf] mt-1">{opt.description}</p>
            </label>
          ))}
        </div>
      </div>

      {/* Business Voice */}
      <div>
        <label className="block text-sm font-medium text-stone-700 dark:text-[#d4d4d8] mb-2">Business Voice</label>
        <div className="flex gap-3">
          <label className={`flex-1 cursor-pointer p-3 border-2 rounded-lg text-center transition-colors ${
            watch('business_voice') === 'we' ? 'border-[var(--brand-primary)] ring-2 ring-[rgb(var(--brand-primary-rgb)/.25)] bg-[var(--brand-accent-soft)] dark:border-[var(--brand-primary-dark)] dark:bg-[rgb(var(--brand-primary-dark-rgb)/.10)]' : 'border-[#ece4d8] bg-[#faf7f2] hover:border-[#e3dacc] dark:border-white/[0.10] dark:bg-white/[0.04] dark:hover:border-white/[0.20]'
          }`}>
            <input type="radio" value="we" {...register('business_voice')} className="sr-only" />
            <p className="font-medium text-sm text-stone-900 dark:text-[#f5f5f5]">&ldquo;We&rdquo;</p>
            <p className="text-xs text-stone-500 dark:text-[#bdbdbf]">We can help you with...</p>
          </label>
          <label className={`flex-1 cursor-pointer p-3 border-2 rounded-lg text-center transition-colors ${
            watch('business_voice') === 'business_name' ? 'border-[var(--brand-primary)] ring-2 ring-[rgb(var(--brand-primary-rgb)/.25)] bg-[var(--brand-accent-soft)] dark:border-[var(--brand-primary-dark)] dark:bg-[rgb(var(--brand-primary-dark-rgb)/.10)]' : 'border-[#ece4d8] bg-[#faf7f2] hover:border-[#e3dacc] dark:border-white/[0.10] dark:bg-white/[0.04] dark:hover:border-white/[0.20]'
          }`}>
            <input type="radio" value="business_name" {...register('business_voice')} className="sr-only" />
            <p className="font-medium text-sm text-stone-900 dark:text-[#f5f5f5]">&ldquo;{businessName}&rdquo;</p>
            <p className="text-xs text-stone-500 dark:text-[#bdbdbf]">{businessName} can help...</p>
          </label>
        </div>
      </div>

      {/* Language */}
      <div>
        <label className="block text-sm font-medium text-stone-700 dark:text-[#d4d4d8] mb-1">Language</label>
        <select
          {...register('language')}
          className="w-full px-3 py-2 rounded-lg bg-white text-stone-900 border border-[#e3dacc] focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] dark:bg-white/[0.06] dark:text-[#f5f5f5] dark:border-white/[0.12] dark:focus:border-[var(--brand-primary-dark)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)] focus:outline-none"
        >
          {LANGUAGE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Response Delay */}
      {showSmsResponseDelay && <div>
        <label className="block text-sm font-medium text-stone-700 dark:text-[#d4d4d8] mb-1">
          SMS Response Delay: <span className="text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)]">{getDelayLabel(responseDelay)}</span>
        </label>
        <Controller
          name="response_delay_seconds"
          control={control}
          render={({ field }) => (
            <input
              type="range"
              min={0}
              max={60}
              step={5}
              value={field.value}
              onChange={(e) => field.onChange(Number(e.target.value))}
              className="w-full h-2 bg-stone-200 dark:bg-white/[0.10] rounded-lg appearance-none cursor-pointer accent-[var(--brand-primary)] dark:accent-[var(--brand-primary-dark)]"
            />
          )}
        />
        <div className="flex justify-between text-xs text-stone-400 dark:text-[#666] mt-1">
          <span>Instant</span>
          <span>1 minute</span>
        </div>
      </div>}

      {/* Widget Welcome Message */}
      <div>
        <label className="block text-sm font-medium text-stone-700 dark:text-[#d4d4d8] mb-1">Widget Welcome Message</label>
        <textarea
          {...register('web_greeting')}
          rows={2}
          placeholder="Welcome to our business! How can we help you today?"
          className="w-full px-3 py-2 rounded-lg bg-white text-stone-900 placeholder:text-stone-400 border border-[#e3dacc] focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] dark:bg-white/[0.06] dark:text-[#f5f5f5] dark:placeholder:text-[#666] dark:border-white/[0.12] dark:focus:border-[var(--brand-primary-dark)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)] focus:outline-none resize-none"
        />
        <p className="text-xs text-stone-400 dark:text-[#666] mt-1">The first message visitors see when they open your chat widget.</p>
      </div>

      {/* Guardrails */}
      <div>
        <label className="block text-sm font-medium text-stone-700 dark:text-[#d4d4d8] mb-1">Guardrails</label>
        <textarea
          {...register('guardrails')}
          rows={3}
          placeholder={"Don't give quotes over $500\nDon't promise same-day service\nAlways suggest calling for emergencies"}
          className="w-full px-3 py-2 rounded-lg bg-white text-stone-900 placeholder:text-stone-400 border border-[#e3dacc] focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] dark:bg-white/[0.06] dark:text-[#f5f5f5] dark:placeholder:text-[#666] dark:border-white/[0.12] dark:focus:border-[var(--brand-primary-dark)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)] focus:outline-none resize-none"
        />
        <p className="text-xs text-stone-400 dark:text-[#666] mt-1">One rule per line. These rules guide what your AI can and can&apos;t say.</p>
      </div>

      {/* Booking Toggle */}
      <div>
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-stone-700 dark:text-[#d4d4d8]">Enable Appointment Booking</label>
          <Controller
            name="booking_enabled"
            control={control}
            render={({ field }) => (
              <button
                type="button"
                onClick={() => field.onChange(!field.value)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
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

        {bookingEnabled && (
          <div className="mt-3 pl-4 border-l-2 border-[rgb(var(--brand-primary-rgb)/.30)] dark:border-[rgb(var(--brand-primary-dark-rgb)/.30)] space-y-2">
            {bookingLoadError && <p role="alert">{bookingLoadError}</p>}
            {!bookingDetails && <label>What kind of appointment should customers book?
              <select className="w-full rounded-xl border bg-transparent p-2" value="" onChange={e => setValue('booking_details', { format: e.target.value as 'phone_callback' | 'business_visit' | 'customer_site', label: 'Appointment', durationMinutes: 30, businessAddress: e.target.value === 'business_visit' ? '' : null })}>
                <option value="" disabled>Choose a format</option><option value="phone_callback">Phone callback</option><option value="business_visit">Visit your business</option><option value="customer_site">Visit the customer</option>
              </select>
            </label>}
            {bookingDetails && <BookingOfferingFields prefix="onboarding-booking" value={bookingDetails} onChange={value => setValue('booking_details', value)} />}
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" value="collect_info" {...register('booking_mode')} className="accent-[var(--brand-primary)] dark:accent-[var(--brand-primary-dark)]" />
              <div>
                <p className="text-sm font-medium text-stone-700 dark:text-[#d4d4d8]">Collect customer info</p>
                <p className="text-xs text-stone-500 dark:text-[#bdbdbf]">AI gathers details, you confirm the booking</p>
              </div>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" value="schedule_direct" {...register('booking_mode')} className="accent-[var(--brand-primary)] dark:accent-[var(--brand-primary-dark)]" />
              <div>
                <p className="text-sm font-medium text-stone-700 dark:text-[#d4d4d8]">Direct scheduling</p>
                <p className="text-xs text-stone-500 dark:text-[#bdbdbf]">AI books appointments directly on your calendar</p>
                <p className="text-xs text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)] mt-1">After setup, connect your Google Calendar in Settings to enable direct booking.</p>
              </div>
            </label>
          </div>
        )}
      </div>

      {submitError && (
        <p className="text-sm text-red-600 dark:text-red-400">{submitError}</p>
      )}

      <div className="flex justify-between pt-4">
        <button
          type="button"
          onClick={onBack}
          className={secondaryCtaClass}
        >
          Back
        </button>
        <button
          type="submit"
          disabled={saving || !goalUpdate || (primaryGoal === 'book' && bookingEnabled && (bookingRevision === undefined || !bookingOfferingSchema.safeParse(bookingDetails).success))}
          className={primaryCtaInlineClass}
        >
          {saving ? (
            <>
              <PulsingDot inline />
              Saving...
            </>
          ) : (
            'Next'
          )}
        </button>
      </div>
    </form>
  );
}
