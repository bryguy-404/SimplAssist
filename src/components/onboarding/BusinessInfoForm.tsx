'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useCallback, useState } from 'react';
import type { BusinessType } from '@/types/database';
import { PulsingDot } from '@/components/ui/pulsing-dot';
import { normalizeUsStateCode, US_STATES } from '@/lib/usStates';
import { primaryCtaInlineClass, secondaryCtaClass } from '@/lib/glass';
import { WebsiteScanLauncher } from '@/components/website-scans/WebsiteScanLauncher';
import {
  isWebsiteScanReviewable,
  type WebsiteScan,
} from '@/lib/website-scans/client';
import {
  getBusinessInfoScanPrefill,
  type OnboardingScanData,
} from '@/lib/onboarding/scanPrefill';

const businessInfoSchema = z.object({
  name: z.string().min(1, 'Business name is required'),
  business_type: z.enum([
    'plumber', 'dentist', 'restaurant', 'car_wash', 'salon', 'hvac', 'auto_shop',
    'real_estate', 'legal', 'financial', 'insurance', 'retail', 'general', 'other',
  ] as const),
  business_type_other: z.string().optional(),
  website: z.string().url('Enter a valid URL').optional().or(z.literal('')),
  phone: z.string().min(10, 'Enter a valid phone number'),
  email: z.string().email('Enter a valid email address').min(1, 'Business email is required'),
  address: z.string().min(1, 'Address is required'),
  city: z.string().min(1, 'City is required'),
  state: z
    .string()
    .min(1, 'State is required')
    .refine((value) => Boolean(normalizeUsStateCode(value)), 'Select a valid state'),
  zip: z.string().min(5, 'Enter a valid zip code'),
}).refine((data) => {
  if (data.business_type === 'other') {
    return !!data.business_type_other?.trim();
  }
  return true;
}, {
  message: 'Please specify your business type',
  path: ['business_type_other'],
});

export type BusinessInfoData = z.infer<typeof businessInfoSchema>;

export type ScrapedData = OnboardingScanData;

interface BusinessInfoFormProps {
  businessId: string;
  initialData?: Partial<BusinessInfoData>;
  onNext: (data: BusinessInfoData, scrapedData: ScrapedData | null) => void;
  onBack?: () => void;
  richerScanEnabled?: boolean;
}

type SaveBusinessInfoFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

const BUSINESS_INFO_SAVE_FALLBACK =
  'Could not save your business information. Please try again.';

export class BusinessInfoSaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusinessInfoSaveError';
  }
}

export async function persistOnboardingBusinessInfo(
  data: BusinessInfoData,
  timezone: string,
  fetchBusinessInfo: SaveBusinessInfoFetch = fetch
): Promise<void> {
  const response = await fetchBusinessInfo('/api/onboarding/business-info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...data, timezone }),
  });

  if (response.ok) return;

  const payload = (await response.json().catch(() => ({}))) as {
    error?: unknown;
  };
  const message =
    typeof payload.error === 'string' && payload.error.trim()
      ? payload.error
      : BUSINESS_INFO_SAVE_FALLBACK;
  throw new BusinessInfoSaveError(message);
}

const BUSINESS_TYPE_OPTIONS: { value: BusinessType; label: string }[] = [
  { value: 'plumber', label: 'Plumber' },
  { value: 'dentist', label: 'Dentist' },
  { value: 'restaurant', label: 'Restaurant' },
  { value: 'car_wash', label: 'Car Wash' },
  { value: 'salon', label: 'Salon' },
  { value: 'hvac', label: 'HVAC' },
  { value: 'auto_shop', label: 'Auto Shop' },
  { value: 'real_estate', label: 'Real Estate' },
  { value: 'legal', label: 'Legal Services' },
  { value: 'financial', label: 'Financial Services' },
  { value: 'insurance', label: 'Insurance' },
  { value: 'retail', label: 'Retail' },
  { value: 'general', label: 'General' },
  { value: 'other', label: 'Other' },
];

export default function BusinessInfoForm({
  initialData,
  onNext,
  onBack,
  richerScanEnabled = true,
}: BusinessInfoFormProps) {
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [scanBlocking, setScanBlocking] = useState(false);
  const [legacyScanning, setLegacyScanning] = useState(false);
  const [legacyScanError, setLegacyScanError] = useState('');
  const [scrapedData, setScrapedData] = useState<ScrapedData | null>(null);

  const {
    register,
    getValues,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<BusinessInfoData>({
    resolver: zodResolver(businessInfoSchema),
    defaultValues: {
      name: initialData?.name === 'My Business' ? '' : (initialData?.name || ''),
      business_type: initialData?.business_type || 'general',
      business_type_other: initialData?.business_type_other || '',
      website: initialData?.website || '',
      phone: initialData?.phone || '',
      email: initialData?.email || '',
      address: initialData?.address || '',
      city: initialData?.city || '',
      state: normalizeUsStateCode(initialData?.state) || '',
      zip: initialData?.zip || '',
    },
  });

  const businessTypeValue = watch('business_type');

  const websiteValue = watch('website');

  const handleScanChange = useCallback((scan: WebsiteScan | null) => {
    const currentWebsite = getValues().website;
    if (scan && !(currentWebsite ?? '').trim()) {
      setValue('website', scan.websiteUrl, { shouldDirty: true, shouldValidate: true });
    }
    if (isWebsiteScanReviewable(scan)) {
      const data: ScrapedData = {
        ...scan.draft.businessInfo,
        services: scan.draft.services
          .filter((service) => service.selected)
          .map(({ name, description, price }) => ({ name, description, price })),
        faqs: scan.draft.faqs
          .filter((faq) => faq.selected)
          .map(({ question, answer }) => ({ question, answer })),
        business_hours: scan.draft.businessHours,
      };
      const current = getValues();
      const prefill = getBusinessInfoScanPrefill(
        {
          name: current.name,
          phone: current.phone,
          address: current.address,
          city: current.city,
          state: current.state,
          zip: current.zip,
        },
        data
      );

      for (const [field, value] of Object.entries(prefill) as [
        keyof typeof prefill,
        string,
      ][]) {
        setValue(field, value, { shouldDirty: true, shouldValidate: true });
      }
      setScrapedData(data);
    }
  }, [getValues, setValue]);

  const applyScanPrefill = (data: ScrapedData) => {
    const current = getValues();
    const prefill = getBusinessInfoScanPrefill(current, data);
    for (const [field, value] of Object.entries(prefill) as [keyof typeof prefill, string][]) {
      setValue(field, value, { shouldDirty: true, shouldValidate: true });
    }
    setScrapedData(data);
  };

  const handleLegacyScan = async () => {
    setLegacyScanning(true);
    setLegacyScanError('');
    try {
      const response = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: websiteValue }),
      });
      if (!response.ok) throw new Error('scan failed');
      applyScanPrefill((await response.json()) as ScrapedData);
    } catch {
      setLegacyScanError('Could not scan website. You can continue by entering your information manually.');
    } finally {
      setLegacyScanning(false);
    }
  };

  const onSubmit = async (data: BusinessInfoData) => {
    setSaving(true);
    setSubmitError('');
    try {
      await persistOnboardingBusinessInfo(
        data,
        Intl.DateTimeFormat().resolvedOptions().timeZone
      );
      onNext(data, scrapedData);
    } catch (error) {
      setSubmitError(
        error instanceof BusinessInfoSaveError
          ? error.message
          : BUSINESS_INFO_SAVE_FALLBACK
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
      <h2 className="text-xl font-semibold text-stone-900 dark:text-[#f5f5f5]">Tell us about your business</h2>

      <div>
        <label className="block text-sm font-medium text-stone-700 dark:text-[#d4d4d8] mb-1">Business Name *</label>
        <input
          {...register('name')}
          placeholder="e.g. Joe's Barber Shop"
          className="w-full px-3 py-2 border border-[#e3dacc] dark:border-white/[0.12] rounded-[22px] bg-white dark:bg-white/[0.06] text-stone-900 dark:text-[#f5f5f5] placeholder:text-stone-400 dark:placeholder:text-[#666] focus:outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] dark:focus:border-[var(--brand-primary-dark)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)]"
        />
        {errors.name && <p className="text-sm text-red-600 dark:text-red-400 mt-1">{errors.name.message}</p>}
      </div>

      <div>
        <label className="block text-sm font-medium text-stone-700 dark:text-[#d4d4d8] mb-1">Business Type *</label>
        <select
          {...register('business_type')}
          className="w-full px-3 py-2 border border-[#e3dacc] dark:border-white/[0.12] rounded-[22px] bg-white dark:bg-white/[0.06] text-stone-900 dark:text-[#f5f5f5] placeholder:text-stone-400 dark:placeholder:text-[#666] focus:outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] dark:focus:border-[var(--brand-primary-dark)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)]"
        >
          {BUSINESS_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {businessTypeValue === 'other' && (
          <div className="mt-2">
            <input
              {...register('business_type_other')}
              placeholder="e.g. Marketing Agency"
              className="w-full px-3 py-2 border border-[#e3dacc] dark:border-white/[0.12] rounded-[22px] bg-white dark:bg-white/[0.06] text-stone-900 dark:text-[#f5f5f5] placeholder:text-stone-400 dark:placeholder:text-[#666] focus:outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] dark:focus:border-[var(--brand-primary-dark)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)]"
            />
            {errors.business_type_other && (
              <p className="text-sm text-red-600 dark:text-red-400 mt-1">{errors.business_type_other.message}</p>
            )}
          </div>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium text-stone-700 dark:text-[#d4d4d8] mb-1">Website URL (optional)</label>
        <input
          {...register('website')}
          disabled={scanBlocking || legacyScanning}
          placeholder="https://www.example.com"
          className="w-full px-3 py-2 border border-[#e3dacc] dark:border-white/[0.12] rounded-[22px] bg-white dark:bg-white/[0.06] text-stone-900 dark:text-[#f5f5f5] placeholder:text-stone-400 dark:placeholder:text-[#666] focus:outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] dark:focus:border-[var(--brand-primary-dark)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)] disabled:cursor-not-allowed disabled:opacity-60"
        />
        {richerScanEnabled && (
          <WebsiteScanLauncher
            url={websiteValue || ''}
            trigger="onboarding"
            onScanChange={handleScanChange}
            onBlockingChange={setScanBlocking}
            compact
          />
        )}
        {websiteValue && !richerScanEnabled && (
          <button
            type="button"
            onClick={handleLegacyScan}
            disabled={legacyScanning}
            className="mt-2 rounded-full border border-[var(--brand-accent-soft-border)] bg-[var(--brand-accent-soft)] px-4 py-2 text-sm font-medium text-[var(--brand-accent)] disabled:opacity-50 dark:border-white/[0.10] dark:bg-[rgb(var(--brand-primary-dark-rgb)/.12)] dark:text-[var(--brand-accent-dark)]"
          >
            {legacyScanning ? 'Scanning…' : 'Scan Website'}
          </button>
        )}
        {legacyScanError && <p className="mt-1 text-sm text-amber-600">{legacyScanError}</p>}
      </div>

      <div>
        <label className="block text-sm font-medium text-stone-700 dark:text-[#d4d4d8] mb-1">Phone Number *</label>
        <input
          {...register('phone')}
          placeholder="(555) 123-4567"
          className="w-full px-3 py-2 border border-[#e3dacc] dark:border-white/[0.12] rounded-[22px] bg-white dark:bg-white/[0.06] text-stone-900 dark:text-[#f5f5f5] placeholder:text-stone-400 dark:placeholder:text-[#666] focus:outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] dark:focus:border-[var(--brand-primary-dark)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)]"
        />
        {errors.phone && <p className="text-sm text-red-600 dark:text-red-400 mt-1">{errors.phone.message}</p>}
      </div>

      <div>
        <label className="block text-sm font-medium text-stone-700 dark:text-[#d4d4d8] mb-1">Business Email *</label>
        <input
          {...register('email')}
          type="email"
          placeholder="info@yourbusiness.com"
          className="w-full px-3 py-2 border border-[#e3dacc] dark:border-white/[0.12] rounded-[22px] bg-white dark:bg-white/[0.06] text-stone-900 dark:text-[#f5f5f5] placeholder:text-stone-400 dark:placeholder:text-[#666] focus:outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] dark:focus:border-[var(--brand-primary-dark)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)]"
        />
        {errors.email && <p className="text-sm text-red-600 dark:text-red-400 mt-1">{errors.email.message}</p>}
        <p className="text-xs text-stone-500 dark:text-[#bdbdbf] mt-1">The AI will suggest this email when it can&apos;t fully help a customer.</p>
      </div>

      <div>
        <label className="block text-sm font-medium text-stone-700 dark:text-[#d4d4d8] mb-1">Address *</label>
        <input
          {...register('address')}
          className="w-full px-3 py-2 border border-[#e3dacc] dark:border-white/[0.12] rounded-[22px] bg-white dark:bg-white/[0.06] text-stone-900 dark:text-[#f5f5f5] placeholder:text-stone-400 dark:placeholder:text-[#666] focus:outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] dark:focus:border-[var(--brand-primary-dark)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)]"
        />
        {errors.address && <p className="text-sm text-red-600 dark:text-red-400 mt-1">{errors.address.message}</p>}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="block text-sm font-medium text-stone-700 dark:text-[#d4d4d8] mb-1">City *</label>
          <input
            {...register('city')}
            className="w-full px-3 py-2 border border-[#e3dacc] dark:border-white/[0.12] rounded-[22px] bg-white dark:bg-white/[0.06] text-stone-900 dark:text-[#f5f5f5] placeholder:text-stone-400 dark:placeholder:text-[#666] focus:outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] dark:focus:border-[var(--brand-primary-dark)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)]"
          />
          {errors.city && <p className="text-sm text-red-600 dark:text-red-400 mt-1">{errors.city.message}</p>}
        </div>
        <div>
          <label className="block text-sm font-medium text-stone-700 dark:text-[#d4d4d8] mb-1">State *</label>
          <select
            {...register('state')}
            className="w-full px-3 py-2 border border-[#e3dacc] dark:border-white/[0.12] rounded-[22px] bg-white dark:bg-white/[0.06] text-stone-900 dark:text-[#f5f5f5] placeholder:text-stone-400 dark:placeholder:text-[#666] focus:outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] dark:focus:border-[var(--brand-primary-dark)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)]"
            defaultValue=""
          >
            <option value="" disabled>Select state</option>
            {US_STATES.map(([code, name]) => (
              <option key={code} value={code}>{name} ({code})</option>
            ))}
          </select>
          {errors.state && <p className="text-sm text-red-600 dark:text-red-400 mt-1">{errors.state.message}</p>}
        </div>
        <div>
          <label className="block text-sm font-medium text-stone-700 dark:text-[#d4d4d8] mb-1">Zip *</label>
          <input
            {...register('zip')}
            className="w-full px-3 py-2 border border-[#e3dacc] dark:border-white/[0.12] rounded-[22px] bg-white dark:bg-white/[0.06] text-stone-900 dark:text-[#f5f5f5] placeholder:text-stone-400 dark:placeholder:text-[#666] focus:outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] dark:focus:border-[var(--brand-primary-dark)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)]"
          />
          {errors.zip && <p className="text-sm text-red-600 dark:text-red-400 mt-1">{errors.zip.message}</p>}
        </div>
      </div>

      {submitError && (
        <p className="text-sm text-red-600 dark:text-red-400">{submitError}</p>
      )}

      <div className={`flex pt-4 ${onBack ? 'justify-between' : 'justify-end'}`}>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            disabled={saving || scanBlocking || legacyScanning}
            className={secondaryCtaClass}
          >
            Back
          </button>
        )}
        <button
          type="submit"
          disabled={saving || scanBlocking || legacyScanning}
          className={primaryCtaInlineClass}
        >
          {saving ? (
            <>
              <PulsingDot inline />
              Saving...
            </>
          ) : (
            scanBlocking ? 'Scanning website…' : 'Next'
          )}
        </button>
      </div>
    </form>
  );
}
