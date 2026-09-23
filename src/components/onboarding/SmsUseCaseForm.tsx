'use client';

import { useFieldArray, useForm, type UseFormRegister } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMemo, useState } from 'react';
import {
  A2P_RISK_SELECTION_LABELS,
  A2P_RISK_SELECTIONS,
  type A2pRiskSelection,
} from '@/lib/messaging/registration/riskCategories';
import {
  buildCustomerCareTemplateCopy,
  validateCustomerCareCopy,
} from '@/lib/messaging/registration/customerCareTemplates';
import { PulsingDot } from '@/components/ui/pulsing-dot';
import { useBrand } from '@/components/branding/BrandProvider';
import { replaceDefaultBrandName } from '@/lib/branding/presentation';
import type {
  A2pRiskChecklistAnswer,
  A2pRiskFinding,
  A2pRiskReviewStatus,
  BusinessType,
  Language,
} from '@/types/database';
import type { OnboardingRiskReviewSnapshot } from '@/lib/onboarding/types';
import { primaryCtaInlineClass, secondaryCtaClass } from '@/lib/glass';
import { statusDanger, statusWarning } from '@/lib/theme-v2/theme';
import { cn } from '@/lib/utils';

const PLACEHOLDER_PATTERN = /\[.+?\]/;
const STOP_PATTERN = /\bstop\b/i;

const smsUseCaseSchema = z
  .object({
    use_case_description: z
      .string()
      .min(40, 'Describe the use case in at least 40 characters'),
    estimated_monthly_volume: z.enum(['under_1k', '1k_10k', '10k_100k', 'over_100k'] as const, {
      message: 'Select an estimated volume',
    }),
    sample_messages: z
      .array(
        z.object({
          value: z
            .string()
            .min(1, 'Sample message cannot be empty')
            .refine((value) => value.trim().length > 0, 'Sample message cannot be empty')
            .refine(
              (value) => !PLACEHOLDER_PATTERN.test(value),
              'Sample messages cannot contain placeholders like [Business Name] -- carriers reject these'
            ),
        })
      )
      .min(3, 'Provide at least 3 sample messages')
      .max(5, 'Provide at most 5 sample messages')
      .refine(
        (messages) => messages.some((message) => STOP_PATTERN.test(message.value)),
        'At least one sample message must include STOP opt-out wording'
      ),
    opt_in_description: z
      .string()
      .min(40, 'Describe how customers opt in (at least 40 characters)'),
    a2p_risk_checklist_answer: z.enum(['none', 'restricted', 'not_sure'] as const, {
      message: 'Choose one eligibility answer',
    }),
    a2p_risk_checklist_selections: z.array(z.string()),
  })
  .refine(
    (data) => validateCustomerCareCopy({
      useCaseDescription: data.use_case_description,
      sampleMessages: data.sample_messages.map((message) => message.value),
      optInDescription: data.opt_in_description,
    }).length === 0,
    {
      message: 'Keep this limited to customer care. Remove marketing, blasts, coupons, cold outreach, or unsupported automation.',
      path: ['use_case_description'],
    }
  )
  .refine(
    (data) =>
      data.a2p_risk_checklist_answer !== 'restricted' ||
      data.a2p_risk_checklist_selections.length > 0,
    {
      message: 'Select at least one category',
      path: ['a2p_risk_checklist_selections'],
    }
  );

export type SmsUseCaseData = z.infer<typeof smsUseCaseSchema>;

interface SmsUseCaseInitialData {
  use_case_description?: string;
  estimated_monthly_volume?: string;
  sample_messages?: string[];
  opt_in_description?: string;
}

interface SmsUseCaseFormProps {
  businessId: string;
  businessName: string;
  businessType: BusinessType;
  businessTypeOther?: string | null;
  language: Language;
  services?: { name: string; description?: string | null }[];
  riskReview?: OnboardingRiskReviewSnapshot | null;
  initialData?: SmsUseCaseInitialData | null;
  onNext: (data: SmsUseCaseData) => void;
  onBack: () => void;
  saveRequest?: typeof fetch;
}

interface RiskReviewResponse {
  status: A2pRiskReviewStatus;
  message: string;
  reason: string | null;
  findings: A2pRiskFinding[];
}

const VOLUME_OPTIONS: { value: SmsUseCaseData['estimated_monthly_volume']; label: string }[] = [
  { value: 'under_1k', label: 'Under 1,000 messages / month' },
  { value: '1k_10k', label: '1,000 - 10,000 messages / month' },
  { value: '10k_100k', label: '10,000 - 100,000 messages / month' },
  { value: 'over_100k', label: 'Over 100,000 messages / month' },
];

const INPUT_CLASS =
  'w-full px-3 py-2 border border-[#e3dacc] dark:border-white/[0.12] rounded-[22px] bg-white dark:bg-white/[0.06] text-stone-900 dark:text-[#f5f5f5] placeholder:text-stone-400 dark:placeholder:text-[#666] focus:outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] dark:focus:border-[var(--brand-primary-dark)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)]';

const LABEL_CLASS = 'block text-sm font-medium text-stone-700 dark:text-[#d4d4d8] mb-1';
const SECTION_HEADER_CLASS = 'text-base font-semibold text-stone-900 dark:text-[#f5f5f5]';

export default function SmsUseCaseForm({
  businessId,
  businessName,
  businessType,
  businessTypeOther,
  language,
  services = [],
  riskReview,
  initialData,
  onNext,
  onBack,
  saveRequest = fetch,
}: SmsUseCaseFormProps) {
  const brand = useBrand();
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [heldRiskReview, setHeldRiskReview] = useState<RiskReviewResponse | null>(
    riskReview && (riskReview.status === 'blocked' || riskReview.status === 'pending_review')
      ? {
          status: riskReview.status,
          message: riskReview.message ?? '',
          reason: riskReview.reason,
          findings: riskReview.findings,
        }
      : null
  );
  const template = useMemo(
    () =>
      buildCustomerCareTemplateCopy({
        businessName,
        businessType,
        businessTypeOther,
        language,
        services,
      }),
    [businessName, businessType, businessTypeOther, language, services]
  );
  const initialSampleMessages =
    initialData?.sample_messages && initialData.sample_messages.length >= 3
      ? initialData.sample_messages.map((value) => ({ value }))
      : template.sampleMessages.map((value) => ({ value }));

  const {
    register,
    control,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<SmsUseCaseData>({
    resolver: zodResolver(smsUseCaseSchema),
    defaultValues: {
      use_case_description: initialData?.use_case_description || template.useCaseDescription,
      estimated_monthly_volume:
        (initialData?.estimated_monthly_volume as SmsUseCaseData['estimated_monthly_volume']) ||
        undefined,
      sample_messages: initialSampleMessages,
      opt_in_description: initialData?.opt_in_description || template.optInDescription,
      a2p_risk_checklist_answer: riskReview?.checklistAnswer || undefined,
      a2p_risk_checklist_selections: riskReview?.checklistSelections || [],
    },
  });

  const selectedChecklistAnswer = watch('a2p_risk_checklist_answer');
  const watchedUseCaseDescription = watch('use_case_description');
  const watchedOptInDescription = watch('opt_in_description');
  const watchedSampleMessages = watch('sample_messages');
  const textDiffersFromTemplate =
    normalizeDraftText(watchedUseCaseDescription) !== normalizeDraftText(template.useCaseDescription) ||
    normalizeDraftText(watchedOptInDescription) !== normalizeDraftText(template.optInDescription) ||
    normalizeSampleMessages(watchedSampleMessages) !== normalizeSampleMessages(
      template.sampleMessages.map((value) => ({ value }))
    );

  const {
    fields: sampleFields,
    append: appendSample,
    remove: removeSample,
    replace: replaceSamples,
  } = useFieldArray({ control, name: 'sample_messages' });

  function applyDraft() {
    setValue('use_case_description', template.useCaseDescription, { shouldValidate: true });
    setValue('opt_in_description', template.optInDescription, { shouldValidate: true });
    replaceSamples(template.sampleMessages.map((value) => ({ value })));
  }

  const onSubmit = async (data: SmsUseCaseData) => {
    setSaving(true);
    setSubmitError('');
    setHeldRiskReview(null);

    try {
      const response = await saveRequest('/api/onboarding/sms-use-case', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId,
          use_case_description: data.use_case_description,
          estimated_monthly_volume: data.estimated_monthly_volume,
          sample_messages: data.sample_messages.map((message) => message.value.trim()),
          opt_in_description: data.opt_in_description,
          a2p_risk_checklist_answer: data.a2p_risk_checklist_answer,
          a2p_risk_checklist_selections: data.a2p_risk_checklist_selections,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        riskReview?: RiskReviewResponse;
      };

      if (!response.ok) {
        setSubmitError(payload.error ?? 'Could not save SMS use case details. Please try again.');
        return;
      }

      if (payload.success === false && payload.riskReview) {
        setHeldRiskReview(payload.riskReview);
        return;
      }

      onNext(data);
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : 'Could not save SMS use case details. Please try again.'
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-stone-900 dark:text-[#f5f5f5]">How your business will use SMS</h2>
        <p className="mt-1 text-sm text-stone-500 dark:text-[#bdbdbf]">
          Carriers review these examples before activating texting. Keep them limited to customer care, missed-call follow-up, and service coordination.
        </p>
      </div>

      <div className="rounded-[18px] border border-[var(--brand-accent-soft-border)] bg-[var(--brand-accent-soft)] px-4 py-3 text-sm text-[var(--brand-accent)] dark:border-white/[0.10] dark:bg-[rgb(var(--brand-primary-dark-rgb)/.12)] dark:text-[var(--brand-accent-dark)]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <span>
            We prefilled this step with carrier-safe Customer Care wording to improve approval chances. Review it and edit anything that does not match {businessName || 'your business'}.
          </span>
          {textDiffersFromTemplate && (
            <button
              type="button"
              onClick={applyDraft}
              className="self-start shrink-0 rounded-full border border-[var(--brand-accent-soft-border)] px-3 py-1.5 text-xs font-semibold text-[var(--brand-accent)] hover:bg-[var(--brand-tint-strong)] dark:border-white/[0.14] dark:text-[var(--brand-accent-dark)] dark:hover:bg-[rgb(var(--brand-primary-dark-rgb)/.10)]"
            >
              Restore recommended draft
            </button>
          )}
        </div>
      </div>

      <div className="space-y-4">
        <h3 className={SECTION_HEADER_CLASS}>Use case</h3>

        <div>
          <label className={LABEL_CLASS}>Describe how you&apos;ll use SMS *</label>
          <textarea
            {...register('use_case_description')}
            rows={4}
            placeholder="Reply to customer inquiries, send missed-call follow-ups, and coordinate service requests."
            className={INPUT_CLASS}
          />
          {errors.use_case_description && (
            <p className="text-sm text-red-600 dark:text-red-400 mt-1">{errors.use_case_description.message}</p>
          )}
        </div>

        <div>
          <label className={LABEL_CLASS}>Estimated monthly message volume *</label>
          <select {...register('estimated_monthly_volume')} className={INPUT_CLASS} defaultValue="">
            <option value="" disabled>Select an estimate</option>
            {VOLUME_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          {errors.estimated_monthly_volume && (
            <p className="text-sm text-red-600 dark:text-red-400 mt-1">{errors.estimated_monthly_volume.message}</p>
          )}
        </div>
      </div>

      <div className="space-y-3">
        <h3 className={SECTION_HEADER_CLASS}>Sample messages (3-5)</h3>
        <p className="text-sm text-stone-500 dark:text-[#bdbdbf]">
          Use real examples with your actual business name. At least one sample must include STOP opt-out wording.
        </p>

        <div className="space-y-3">
          {sampleFields.map((field, index) => (
            <div key={field.id} className="p-3 border border-[#ece4d8] dark:border-white/[0.10] bg-[#faf7f2] dark:bg-white/[0.04] rounded-lg">
              <div className="flex gap-2">
                <textarea
                  {...register(`sample_messages.${index}.value`)}
                  rows={2}
                  placeholder={`Sample message ${index + 1}`}
                  className="flex-1 px-3 py-2 border border-[#e3dacc] dark:border-white/[0.12] rounded-lg bg-white dark:bg-white/[0.06] text-stone-900 dark:text-[#f5f5f5] placeholder:text-stone-400 dark:placeholder:text-[#666] focus:outline-none focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] focus:border-[var(--brand-primary)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)] dark:focus:border-[var(--brand-primary-dark)] text-sm resize-none"
                />
                {sampleFields.length > 3 && (
                  <button
                    type="button"
                    onClick={() => removeSample(index)}
                    className="text-red-400 dark:text-red-400/70 hover:text-red-600 dark:hover:text-red-400 px-2"
                    aria-label={`Remove sample message ${index + 1}`}
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                )}
              </div>
              {errors.sample_messages?.[index]?.value && (
                <p className="text-sm text-red-600 dark:text-red-400 mt-1">
                  {errors.sample_messages[index]?.value?.message}
                </p>
              )}
            </div>
          ))}
        </div>

        {errors.sample_messages && typeof errors.sample_messages.message === 'string' && (
          <p className="text-sm text-red-600 dark:text-red-400">{errors.sample_messages.message}</p>
        )}

        {sampleFields.length < 5 && (
          <button
            type="button"
            onClick={() => appendSample({ value: '' })}
            className="text-sm text-[var(--brand-accent)] hover:text-[var(--brand-primary-active)] dark:text-[var(--brand-accent-dark)] dark:hover:text-[var(--brand-primary-soft-dark)] font-medium"
          >
            + Add sample message
          </button>
        )}
      </div>

      <div className="space-y-3">
        <h3 className={SECTION_HEADER_CLASS}>Opt-in description</h3>
        <p className="text-sm text-stone-500 dark:text-[#bdbdbf]">
          Tell carriers how customers agree to receive customer-care texts from your business.
        </p>
        <textarea
          {...register('opt_in_description')}
          rows={4}
          className={INPUT_CLASS}
        />
        {errors.opt_in_description && (
          <p className="text-sm text-red-600 dark:text-red-400 mt-1">{errors.opt_in_description.message}</p>
        )}
      </div>

      <div className="space-y-4">
        <div>
          <h3 className={SECTION_HEADER_CLASS}>Restricted services check</h3>
          <p className="mt-1 text-sm text-stone-500 dark:text-[#bdbdbf]">
            Carriers block or manually review some business types and website content before SMS can be submitted.
          </p>
          <p className="mt-1 text-xs text-stone-500 dark:text-[#888]">
            Examples include lead generation, SEO services, affiliate marketing, cannabis/CBD, gambling, payday loans or debt relief, adult/dating, firearms, political messaging, and other regulated services.
          </p>
        </div>

        <div className="space-y-2">
          <ChecklistRadio
            register={register}
            value="none"
            title="None of these apply to my business or website"
            description="Use this when your business does not offer restricted services listed below."
          />
          <ChecklistRadio
            register={register}
            value="restricted"
            title="One or more restricted categories may apply"
            description={`Choose the category below so ${brand.name} can prevent a likely carrier rejection.`}
          />
          <ChecklistRadio
            register={register}
            value="not_sure"
            title="I'm not sure / please review this"
            description={`${brand.name} will review before submitting carrier registration.`}
          />
        </div>

        {selectedChecklistAnswer === 'restricted' && (
          <div className="grid gap-2 sm:grid-cols-2">
            {A2P_RISK_SELECTIONS.map((selection) => (
              <label
                key={selection}
                className="flex items-start gap-2 rounded-lg border border-[#ece4d8] bg-[#faf7f2] p-3 text-sm text-stone-700 dark:border-white/[0.10] dark:bg-white/[0.04] dark:text-[#d4d4d8]"
              >
                <input
                  type="checkbox"
                  value={selection}
                  {...register('a2p_risk_checklist_selections')}
                  className="mt-0.5 h-4 w-4 rounded accent-[var(--brand-primary)] dark:accent-[var(--brand-primary-dark)]"
                />
                <span>{A2P_RISK_SELECTION_LABELS[selection as A2pRiskSelection]}</span>
              </label>
            ))}
          </div>
        )}
        {errors.a2p_risk_checklist_answer && (
          <p className="text-sm text-red-600 dark:text-red-400">{errors.a2p_risk_checklist_answer.message}</p>
        )}
        {errors.a2p_risk_checklist_selections && (
          <p className="text-sm text-red-600 dark:text-red-400">{errors.a2p_risk_checklist_selections.message}</p>
        )}
      </div>

      {heldRiskReview && (
        <RiskReviewNotice review={heldRiskReview} brandName={brand.name} />
      )}

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
          disabled={saving}
          className={primaryCtaInlineClass}
        >
          {saving ? (
            <>
              <PulsingDot inline />
              Checking...
            </>
          ) : (
            'Next'
          )}
        </button>
      </div>
    </form>
  );
}

function normalizeDraftText(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ');
}

function normalizeSampleMessages(
  samples: { value: string }[] | null | undefined
): string {
  return (samples ?? [])
    .map((sample) => normalizeDraftText(sample.value))
    .join('\n');
}

function ChecklistRadio({
  register,
  value,
  title,
  description,
}: {
  register: UseFormRegister<SmsUseCaseData>;
  value: A2pRiskChecklistAnswer;
  title: string;
  description: string;
}) {
  return (
    <label className="flex items-start gap-3 rounded-lg border border-[#ece4d8] bg-[#faf7f2] p-3 dark:border-white/[0.10] dark:bg-white/[0.04]">
      <input
        type="radio"
        value={value}
        {...register('a2p_risk_checklist_answer')}
        className="mt-1 h-4 w-4 accent-[var(--brand-primary)] dark:accent-[var(--brand-primary-dark)]"
      />
      <span>
        <span className="block text-sm font-medium text-stone-900 dark:text-[#f5f5f5]">{title}</span>
        <span className="block text-xs text-stone-500 dark:text-[#bdbdbf]">{description}</span>
      </span>
    </label>
  );
}

function RiskReviewNotice({
  review,
  brandName,
}: {
  review: RiskReviewResponse;
  brandName: string;
}) {
  const isBlocked = review.status === 'blocked';
  const visibleFindings = dedupeRiskFindingsByCategory(review.findings).slice(0, 3);
  return (
    <div className={cn(
      'rounded-[18px] px-4 py-3 text-sm',
      isBlocked ? statusDanger : statusWarning
    )}>
      <p className="font-medium">
        {isBlocked ? 'SMS registration cannot be submitted yet.' : `${brandName} needs to review this before submitting.`}
      </p>
      <p className="mt-1">
        {replaceDefaultBrandName(review.message, brandName)}
      </p>
      {review.reason && (
        <p className="mt-1 text-xs opacity-90">
          {replaceDefaultBrandName(review.reason, brandName)}
        </p>
      )}
      {visibleFindings.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {visibleFindings.map((finding) => (
            <li key={finding.category || finding.ruleId}>
              {replaceDefaultBrandName(finding.label, brandName)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function dedupeRiskFindingsByCategory(
  findings: A2pRiskFinding[]
): A2pRiskFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = finding.category || finding.label || finding.ruleId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
