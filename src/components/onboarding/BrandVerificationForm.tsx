'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useState } from 'react';
import type { BusinessEntityType } from '@/types/database';
import { PulsingDot } from '@/components/ui/pulsing-dot';
import { useBrand } from '@/components/branding/BrandProvider';
import { replaceDefaultBrandName } from '@/lib/branding/presentation';
import { normalizeUsStateCode, US_STATES } from '@/lib/usStates';
import { primaryCtaInlineClass, secondaryCtaClass } from '@/lib/glass';
import { statusSuccess, statusWarning } from '@/lib/theme-v2/theme';
import { cn } from '@/lib/utils';

const EIN_PATTERN = /^\d{2}-\d{7}$/;
const IRS_EIN_URL =
  'https://www.irs.gov/businesses/small-businesses-self-employed/get-an-employer-identification-number';

function hasFirstAndLastName(value: string): boolean {
  return value.trim().split(/\s+/).length >= 2;
}

const brandVerificationSchema = z
  .object({
    has_ein: z.enum(['yes', 'no'] as const, {
      message: 'Choose whether you have an EIN',
    }),
    legal_business_name: z.string(),
    business_entity_type: z
      .enum(['llc', 'c_corp', 's_corp', 'nonprofit', 'partnership'] as const)
      .or(z.literal(''))
      .optional(),
    business_registration_state: z.string(),
    ein: z.string(),
    authorized_rep_name: z.string(),
    authorized_rep_title: z.string(),
    authorized_rep_email: z.string(),
    authorized_rep_phone: z.string(),
  })
  .superRefine((data, ctx) => {
    if (data.has_ein !== 'yes') return;

    if (!data.legal_business_name.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['legal_business_name'],
        message: 'Legal business name is required',
      });
    }

    if (!data.business_entity_type) {
      ctx.addIssue({
        code: 'custom',
        path: ['business_entity_type'],
        message: 'Select an entity type',
      });
    }

    if (!normalizeUsStateCode(data.business_registration_state)) {
      ctx.addIssue({
        code: 'custom',
        path: ['business_registration_state'],
        message: 'Select a valid state',
      });
    }

    if (!EIN_PATTERN.test(data.ein)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ein'],
        message: 'EIN must be in the format XX-XXXXXXX',
      });
    }

    if (!hasFirstAndLastName(data.authorized_rep_name)) {
      ctx.addIssue({
        code: 'custom',
        path: ['authorized_rep_name'],
        message: 'Enter the authorized representative\'s first and last name',
      });
    }

    if (!data.authorized_rep_title.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['authorized_rep_title'],
        message: 'Representative title is required',
      });
    }

    if (!z.string().email().safeParse(data.authorized_rep_email).success) {
      ctx.addIssue({
        code: 'custom',
        path: ['authorized_rep_email'],
        message: 'Enter a valid email address',
      });
    }

    if (data.authorized_rep_phone.trim().length < 10) {
      ctx.addIssue({
        code: 'custom',
        path: ['authorized_rep_phone'],
        message: 'Enter a valid phone number',
      });
    }
  });

type BrandVerificationData = z.infer<typeof brandVerificationSchema>;

export interface BrandVerificationInitialData {
  has_ein?: boolean | null;
  no_ein_hold_status?: string;
  no_ein_waitlist_requested_at?: string | null;
  legal_business_name?: string;
  business_entity_type?: BusinessEntityType | null;
  business_registration_state?: string;
  ein?: string;
  authorized_rep_name?: string;
  authorized_rep_title?: string;
  authorized_rep_email?: string;
  authorized_rep_phone?: string;
  use_case_description?: string;
  estimated_monthly_volume?: string;
  sample_messages?: string[];
  opt_in_description?: string;
}

interface BrandVerificationFormProps {
  businessId: string;
  initialData?: BrandVerificationInitialData;
  onNext: (data: BrandVerificationData) => void;
  onBack: () => void;
  saveRequest?: typeof fetch;
}

const ENTITY_TYPE_OPTIONS: { value: Exclude<BusinessEntityType, 'sole_proprietor'>; label: string }[] = [
  { value: 'llc', label: 'LLC' },
  { value: 'c_corp', label: 'C-Corporation' },
  { value: 's_corp', label: 'S-Corporation' },
  { value: 'partnership', label: 'Partnership' },
  { value: 'nonprofit', label: 'Nonprofit' },
];

const INPUT_CLASS =
  'w-full px-3 py-2 border border-[#e3dacc] dark:border-white/[0.12] rounded-[22px] bg-white dark:bg-white/[0.06] text-stone-900 dark:text-[#f5f5f5] placeholder:text-stone-400 dark:placeholder:text-[#666] focus:outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] dark:focus:border-[var(--brand-primary-dark)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)]';

const LABEL_CLASS = 'block text-sm font-medium text-stone-700 dark:text-[#d4d4d8] mb-1';

const SECTION_HEADER_CLASS = 'text-base font-semibold text-stone-900 dark:text-[#f5f5f5]';

function initialHasEin(initialData?: BrandVerificationInitialData): BrandVerificationData['has_ein'] | undefined {
  if (initialData?.has_ein === false) return 'no';
  if (initialData?.has_ein === true || initialData?.ein) return 'yes';
  return undefined;
}

export default function BrandVerificationForm({
  businessId,
  initialData,
  onNext,
  onBack,
  saveRequest = fetch,
}: BrandVerificationFormProps) {
  const brand = useBrand();
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [waitlistSaved, setWaitlistSaved] = useState(
    initialData?.no_ein_hold_status === 'waitlisted'
  );

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<BrandVerificationData>({
    resolver: zodResolver(brandVerificationSchema),
    defaultValues: {
      has_ein: initialHasEin(initialData),
      legal_business_name: initialData?.legal_business_name || '',
      business_entity_type:
        initialData?.business_entity_type && initialData.business_entity_type !== 'sole_proprietor'
          ? initialData.business_entity_type
          : undefined,
      business_registration_state: normalizeUsStateCode(initialData?.business_registration_state) || '',
      ein: initialData?.ein || '',
      authorized_rep_name: initialData?.authorized_rep_name || '',
      authorized_rep_title: initialData?.authorized_rep_title || '',
      authorized_rep_email: initialData?.authorized_rep_email || '',
      authorized_rep_phone: initialData?.authorized_rep_phone || '',
    },
  });
  const hasEinAnswer = watch('has_ein');

  const onSubmit = async (data: BrandVerificationData) => {
    setSaving(true);
    setSubmitError('');
    try {
      if (data.has_ein === 'no') {
        const response = await saveRequest('/api/onboarding/brand-verification', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            businessId,
            has_ein: false,
            join_waitlist: true,
          }),
        });

        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
          success?: boolean;
        };

        if (!response.ok) {
          setSubmitError(
            replaceDefaultBrandName(
              payload.error ?? 'Could not save EIN status. Please try again.',
              brand.name,
            ),
          );
          return;
        }

        setWaitlistSaved(true);
        return;
      }

      const response = await saveRequest('/api/onboarding/brand-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId,
          has_ein: true,
          legal_business_name: data.legal_business_name,
          business_entity_type: data.business_entity_type,
          business_registration_state: normalizeUsStateCode(data.business_registration_state),
          ein: data.ein,
          authorized_rep_name: data.authorized_rep_name,
          authorized_rep_title: data.authorized_rep_title,
          authorized_rep_email: data.authorized_rep_email,
          authorized_rep_phone: data.authorized_rep_phone,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        success?: boolean;
      };

      if (!response.ok) {
        setSubmitError(
          replaceDefaultBrandName(
            payload.error ?? 'Could not save brand verification info. Please try again.',
            brand.name,
          ),
        );
        return;
      }

      onNext(data);
    } catch (err) {
      setSubmitError(
        replaceDefaultBrandName(
          err instanceof Error
            ? err.message
            : 'Could not save brand verification info. Please try again.',
          brand.name,
        ),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-stone-900 dark:text-[#f5f5f5]">Brand verification info</h2>
        <p className="mt-1 text-sm text-stone-500 dark:text-[#bdbdbf]">
          Carriers require this exact business identity before we can activate SMS for your account.
        </p>
      </div>

      <div className="space-y-3">
        <h3 className={SECTION_HEADER_CLASS}>Do you have an EIN?</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label
            className={`cursor-pointer rounded-[18px] border p-4 text-sm transition-colors ${
              hasEinAnswer === 'yes'
                ? 'border-[var(--brand-primary)] ring-2 ring-[rgb(var(--brand-primary-rgb)/.25)] bg-[var(--brand-accent-soft)] dark:border-[var(--brand-primary-dark)] dark:bg-[rgb(var(--brand-primary-dark-rgb)/.10)]'
                : 'border-[#ece4d8] bg-[#faf7f2] dark:border-white/[0.10] dark:bg-white/[0.04]'
            }`}
          >
            <input
              {...register('has_ein')}
              type="radio"
              value="yes"
              className="sr-only"
            />
            <span className="block font-medium text-stone-900 dark:text-[#f5f5f5]">
              Yes, I have an EIN
            </span>
            <span className="mt-1 block text-xs text-stone-500 dark:text-[#bdbdbf]">
              Use your legal business identity for Standard Brand registration.
            </span>
          </label>

          <label
            className={`cursor-pointer rounded-[18px] border p-4 text-sm transition-colors ${
              hasEinAnswer === 'no'
                ? 'border-[var(--brand-primary)] ring-2 ring-[rgb(var(--brand-primary-rgb)/.25)] bg-[var(--brand-accent-soft)] dark:border-[var(--brand-primary-dark)] dark:bg-[rgb(var(--brand-primary-dark-rgb)/.10)]'
                : 'border-[#ece4d8] bg-[#faf7f2] dark:border-white/[0.10] dark:bg-white/[0.04]'
            }`}
          >
            <input
              {...register('has_ein')}
              type="radio"
              value="no"
              className="sr-only"
            />
            <span className="block font-medium text-stone-900 dark:text-[#f5f5f5]">
              No, I need one
            </span>
            <span className="mt-1 block text-xs text-stone-500 dark:text-[#bdbdbf]">
              We will hold setup here and show the free IRS EIN link.
            </span>
          </label>
        </div>
        {errors.has_ein && (
          <p className="text-sm text-red-600 dark:text-red-400">{errors.has_ein.message}</p>
        )}
      </div>

      {hasEinAnswer === 'no' && (
        <div className={cn('space-y-3 rounded-[18px] p-4 text-sm', statusWarning)}>
          <p className="font-medium">Get an EIN before SMS launch</p>
          <p>
            Don&apos;t have an EIN? You can get one free from the IRS in about 15 minutes —{' '}
            <a
              href={IRS_EIN_URL}
              target="_blank"
              rel="noreferrer"
              className="font-medium underline"
            >
              Get an EIN
            </a>
            . This unlocks higher message limits and faster approval.
          </p>
          <p className="text-xs">
            Sole Proprietor registration is not open yet. Use the Join waitlist button below,
            then come back and choose &quot;Yes&quot; after you have your EIN.
          </p>
          {waitlistSaved && (
            <p className={cn('rounded-[14px] px-3 py-2 text-xs font-medium', statusSuccess)}>
              You&apos;re on the no-EIN waitlist. No email will be sent in this phase.
            </p>
          )}
        </div>
      )}

      {hasEinAnswer === 'yes' && (
        <>
      {/* Legal entity */}
      <div className="space-y-4">
        <h3 className={SECTION_HEADER_CLASS}>Legal entity</h3>

        <div>
          <label className={LABEL_CLASS}>Legal business name *</label>
          <input
            {...register('legal_business_name')}
            placeholder="As registered with the IRS (e.g. Joe's Plumbing LLC)"
            className={INPUT_CLASS}
          />
          {errors.legal_business_name && (
            <p className="text-sm text-red-600 dark:text-red-400 mt-1">{errors.legal_business_name.message}</p>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={LABEL_CLASS}>Entity type *</label>
            <select {...register('business_entity_type')} className={INPUT_CLASS} defaultValue="">
              <option value="" disabled>Select an entity type</option>
              {ENTITY_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            {errors.business_entity_type && (
              <p className="text-sm text-red-600 dark:text-red-400 mt-1">{errors.business_entity_type.message}</p>
            )}
          </div>

          <div>
            <label className={LABEL_CLASS}>State of registration *</label>
            <select {...register('business_registration_state')} className={INPUT_CLASS} defaultValue="">
              <option value="" disabled>Select a state</option>
              {US_STATES.map(([code, name]) => (
                <option key={code} value={code}>{name} ({code})</option>
              ))}
            </select>
            {errors.business_registration_state && (
              <p className="text-sm text-red-600 dark:text-red-400 mt-1">{errors.business_registration_state.message}</p>
            )}
          </div>
        </div>

        <div>
          <label className={LABEL_CLASS}>EIN (federal Tax ID) *</label>
          <input
            {...register('ein')}
            placeholder="XX-XXXXXXX"
            inputMode="numeric"
            autoComplete="off"
            className={INPUT_CLASS}
          />
          {errors.ein && <p className="text-sm text-red-600 dark:text-red-400 mt-1">{errors.ein.message}</p>}
          <p className="text-xs text-stone-500 dark:text-[#bdbdbf] mt-1">
            Use the EIN that matches your legal business records.
          </p>
        </div>
      </div>

      {/* Authorized representative */}
      <div className="space-y-4">
        <h3 className={SECTION_HEADER_CLASS}>Authorized representative</h3>
        <p className="text-sm text-stone-500 dark:text-[#bdbdbf]">
          The person at your business authorized to register with messaging carriers.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={LABEL_CLASS}>Full name *</label>
            <input {...register('authorized_rep_name')} className={INPUT_CLASS} />
            {errors.authorized_rep_name && (
              <p className="text-sm text-red-600 dark:text-red-400 mt-1">{errors.authorized_rep_name.message}</p>
            )}
            <p className="text-xs text-stone-500 dark:text-[#bdbdbf] mt-1">
              Full legal name of the authorized representative.
            </p>
          </div>
          <div>
            <label className={LABEL_CLASS}>Title *</label>
            <input
              {...register('authorized_rep_title')}
              placeholder="e.g. Owner, CEO, Manager"
              className={INPUT_CLASS}
            />
            {errors.authorized_rep_title && (
              <p className="text-sm text-red-600 dark:text-red-400 mt-1">{errors.authorized_rep_title.message}</p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={LABEL_CLASS}>Email *</label>
            <input {...register('authorized_rep_email')} type="email" className={INPUT_CLASS} />
            {errors.authorized_rep_email && (
              <p className="text-sm text-red-600 dark:text-red-400 mt-1">{errors.authorized_rep_email.message}</p>
            )}
          </div>
          <div>
            <label className={LABEL_CLASS}>Phone *</label>
            <input
              {...register('authorized_rep_phone')}
              placeholder="(555) 123-4567"
              className={INPUT_CLASS}
            />
            {errors.authorized_rep_phone && (
              <p className="text-sm text-red-600 dark:text-red-400 mt-1">{errors.authorized_rep_phone.message}</p>
            )}
          </div>
        </div>
      </div>
        </>
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
          disabled={saving || (hasEinAnswer === 'no' && waitlistSaved)}
          className={primaryCtaInlineClass}
        >
          {saving ? (
            <>
              <PulsingDot inline />
              Saving...
            </>
          ) : hasEinAnswer === 'no' && waitlistSaved ? (
            'Waitlist saved'
          ) : hasEinAnswer === 'no' ? (
            'Join waitlist'
          ) : (
            'Next'
          )}
        </button>
      </div>
    </form>
  );
}
