'use client';

import { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, RefreshCcw } from 'lucide-react';
import { useBrand } from '@/components/branding/BrandProvider';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import type { OnboardingState } from '@/lib/onboarding/types';
import {
  hasCarrierRejection,
  mapReasonToFriendly,
  REJECTION_SUPPORT_MESSAGE,
  type RejectionKind,
} from '@/lib/onboarding/rejectionGuidance';
import { replaceDefaultBrandName } from '@/lib/branding/presentation';
import { supportHref } from '@/lib/support/constants';
import { statusWarning, tile } from '@/lib/theme-v2/theme';

// A real anchor (to the /support hub) styled to match Button's
// primary/secondary variants — this is a navigation, not an action, so a
// link beats a scripted button.
const SUPPORT_LINK_BASE =
  'inline-flex items-center justify-center rounded-full px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[var(--brand-primary)] dark:focus:ring-[var(--brand-primary-dark)]';
const SUPPORT_LINK_PRIMARY =
  'bg-[var(--brand-primary)] text-white hover:bg-[var(--brand-primary-hover)] active:bg-[var(--brand-primary-active)] dark:bg-[var(--brand-primary-dark)] dark:text-[#16100b] dark:hover:bg-[var(--brand-primary-hover-dark)]';

export function CarrierReviewStatus({
  state,
  onStatusRefreshed,
  onRetry,
  onDashboard,
}: {
  state: OnboardingState;
  onStatusRefreshed: (state: OnboardingState) => void;
  onRetry: (state: OnboardingState | null) => void;
  onDashboard: () => void;
}) {
  const brand = useBrand();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const [statusRefreshError, setStatusRefreshError] = useState<string | null>(
    null
  );
  const [statusRefreshNotice, setStatusRefreshNotice] = useState<string | null>(
    null
  );
  const operationInFlightRef = useRef<'retry' | 'refresh' | null>(null);
  const registration = state.registration;

  const carrierRejected =
    !registration.smsReady &&
    hasCarrierRejection(
      registration.brandStatus,
      registration.campaignStatus
    );
  // Brand wins the main explanation when both resources are rejected; both
  // exact carrier reasons remain visible below.
  const rejectionKind: RejectionKind | null =
    carrierRejected && registration.brandStatus === 'rejected'
      ? 'brand'
      : carrierRejected && registration.campaignStatus === 'rejected'
        ? 'campaign'
        : null;
  // Only the carrier's own words feed classification and the friendly copy:
  // registration.error can hold newer internal messages (risk holds, submit
  // failures) that must never be diagnosed or labeled as carrier wording.
  const carrierReason = rejectionKind
    ? rejectionKind === 'brand'
      ? registration.brandRejectionReason
      : registration.campaignRejectionReason
    : null;
  // Mirrors the server's stale-submitting claim window
  // (registrationAttempt.ts): a pipeline that died mid-claim strands the row
  // in 'submitting' with no webhook coming, but it is claimable again — so
  // Retry must be offered here or the customer is stuck on Refresh forever.
  const staleSubmitting =
    registration.status === 'submitting' &&
    (!registration.startedAt ||
      Date.now() - new Date(registration.startedAt).getTime() > 15 * 60 * 1000);
  const friendlyReason = rejectionKind
    ? mapReasonToFriendly(rejectionKind, carrierReason)
    : null;
  const supportLink = supportHref('number_registration');
  // When both brand and campaign are rejected, brand wins the headline slot;
  // the campaign's own carrier verdict still has to stay visible.
  const secondaryCarrierReason =
    rejectionKind === 'brand' &&
    registration.campaignStatus === 'rejected' &&
    registration.campaignRejectionReason &&
    registration.campaignRejectionReason !== carrierReason
      ? registration.campaignRejectionReason
      : null;
  // The webhook usually copies the rejection reason into registration.error,
  // and a failed retry returns the same message it persists; render each
  // distinct string once.
  const extraError =
    !registration.smsReady &&
    !carrierRejected &&
    registration.error &&
    registration.error !== carrierReason &&
    registration.error !== retryError &&
    registration.error !== secondaryCarrierReason
      ? registration.error
      : null;
  const assignmentNote =
    !registration.smsReady &&
    !carrierRejected &&
    registration.assignmentFailureReason &&
    registration.assignmentFailureReason !== registration.error &&
    registration.assignmentFailureReason !== retryError
      ? registration.assignmentFailureReason
      : null;
  const title = registration.smsReady
    ? 'SMS is active'
    : carrierRejected
      ? 'Registration needs support'
      : registration.holdReason === 'held_no_ein'
        ? 'Add your EIN to continue'
        : registration.status === 'failed'
          ? 'Registration needs another try'
          : registration.awaitingCampaignSubmission
            ? registration.brandStatus === 'approved' ? 'Preparing your SMS registration' : 'Business verification is in progress'
          : 'Carrier review is underway';

  const copy = statusCopy(state);

  async function handleRetry() {
    if (operationInFlightRef.current) return;
    operationInFlightRef.current = 'retry';
    setRetrying(true);
    setRetryError(null);
    setStatusRefreshError(null);
    setStatusRefreshNotice(null);
    try {
      const response = await fetch('/api/onboarding/retry-registration', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId: state.businessId }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        state?: OnboardingState;
      };

      if (!response.ok) {
        setRetryError(payload.error ?? 'Could not retry registration right now.');
        onRetry(payload.state ?? null);
        return;
      }

      onRetry(payload.state ?? null);
    } catch {
      setRetryError('Could not retry registration right now.');
    } finally {
      operationInFlightRef.current = null;
      setRetrying(false);
    }
  }

  async function handleStatusRefresh() {
    if (operationInFlightRef.current) return;
    operationInFlightRef.current = 'refresh';
    setStatusRefreshing(true);
    setStatusRefreshError(null);
    setStatusRefreshNotice(null);
    setRetryError(null);

    try {
      const response = await fetch('/api/onboarding/refresh-status', {
        method: 'POST',
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        state?: OnboardingState;
      };

      if (payload.state) {
        onStatusRefreshed(payload.state);
      }

      if (!response.ok) {
        setStatusRefreshError(
          payload.error ?? 'Could not refresh carrier status right now.'
        );
        return;
      }

      setStatusRefreshNotice(
        payload.message ?? 'Carrier status is already up to date.'
      );
    } catch {
      setStatusRefreshError('Could not refresh carrier status right now.');
    } finally {
      operationInFlightRef.current = null;
      setStatusRefreshing(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl border border-[var(--brand-accent-soft-border)] bg-[var(--brand-accent-soft)] dark:border-white/[0.10] dark:bg-[linear-gradient(135deg,rgb(var(--brand-primary-dark-rgb)/.22),rgba(255,255,255,.08))]">
          {registration.smsReady ? (
            <CheckCircle2 className="h-6 w-6 text-green-600 dark:text-green-400" />
          ) : registration.status === 'failed' || registration.brandStatus === 'rejected' || registration.campaignStatus === 'rejected' ? (
            <AlertTriangle className="h-6 w-6 text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)]" />
          ) : (
            <Clock className="h-6 w-6 text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)]" />
          )}
        </div>
        <h2 className="text-xl font-semibold text-stone-900 dark:text-[#f5f5f5]">{title}</h2>
        <p className="mt-2 text-sm text-stone-500 dark:text-[#bdbdbf]">{copy}</p>
        {registration.riskReview.registrationStarted &&
          registration.status !== 'failed' &&
          !registration.smsReady &&
          !carrierRejected && (
            <p className="mt-2 text-sm text-stone-500 dark:text-[#bdbdbf]">
              Business and compliance details are locked until review completes.{' '}
              <a href={supportLink} className="font-medium underline">
                Contact support
              </a>{' '}
              if you need to change them.
            </p>
          )}
      </div>

      {state.billing.plan === 'full' && !carrierRejected && registration.status !== 'failed' && (
        <p className="text-sm text-stone-600 dark:text-[#bdbdbf]">
          Full Suite includes AI voice answering. Once setup is complete, go to Settings → Missed calls,
          choose AI voice answering, and save. Voice answering stays off until you enable it.
        </p>
      )}

      <div className={`space-y-3 p-4 ${tile}`}>
        <StatusLine label="Business verification" value={registration.brandStatus ?? 'not submitted'} />
        <StatusLine label="SMS campaign" value={registration.awaitingCampaignSubmission ? registration.brandStatus === 'approved' ? 'preparing submission' : 'waiting for business verification' : registration.campaignStatus ?? 'not submitted'} />
        <StatusLine label="Phone number link" value={registration.assignmentStatus ?? 'not assigned'} />
        <StatusLine label="SMS sending" value={registration.smsReady ? 'active' : 'paused'} />
      </div>

      {(retryError || (rejectionKind && carrierReason) || secondaryCarrierReason || extraError || assignmentNote) && (
        <div className={`space-y-2 rounded-[18px] px-4 py-3 text-sm ${statusWarning}`}>
          {retryError && (
            <p>{replaceDefaultBrandName(retryError, brand.name)}</p>
          )}
          {rejectionKind && carrierReason && (
            friendlyReason ? (
              <>
                <p>{friendlyReason}</p>
                <p className="text-xs">
                  Carrier&apos;s exact wording: {carrierReason}
                </p>
              </>
            ) : (
              <>
                <p>{carrierReason}</p>
                <p className="text-xs">{REJECTION_SUPPORT_MESSAGE}</p>
              </>
            )
          )}
          {secondaryCarrierReason && (
            // Self-contained label (no "also"): in some reachable states this
            // is the banner's only line. Small print only under a headline.
            <p className={rejectionKind && carrierReason ? 'text-xs' : undefined}>
              SMS campaign rejection: {secondaryCarrierReason}
            </p>
          )}
          {extraError && (
            <p>{replaceDefaultBrandName(extraError, brand.name)}</p>
          )}
          {assignmentNote && (
            <p>{replaceDefaultBrandName(assignmentNote, brand.name)}</p>
          )}
        </div>
      )}

      {statusRefreshError && (
        <div
          role="alert"
          className={`rounded-[18px] px-4 py-3 text-sm ${statusWarning}`}
        >
          {replaceDefaultBrandName(statusRefreshError, brand.name)}
        </div>
      )}

      {statusRefreshNotice && (
        <p
          role="status"
          className="text-sm text-stone-600 dark:text-[#bdbdbf]"
        >
          {replaceDefaultBrandName(statusRefreshNotice, brand.name)}
        </p>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
        {!carrierRejected && (
          <Button
            type="button"
            variant="secondary"
            onClick={handleStatusRefresh}
            loading={statusRefreshing}
            disabled={retrying}
            aria-busy={statusRefreshing}
          >
            <RefreshCcw className="mr-2 h-4 w-4" />
            Refresh status
          </Button>
        )}
        {registration.smsReady ? (
          <Button type="button" onClick={onDashboard}>
            Go to dashboard
          </Button>
        ) : carrierRejected ? (
          <a
            href={supportLink}
            className={`${SUPPORT_LINK_BASE} ${SUPPORT_LINK_PRIMARY}`}
          >
            Contact support
          </a>
        ) : registration.holdReason === 'held_no_ein' ? null : registration.status === 'failed' ||
          staleSubmitting ? (
          <div className="flex flex-col gap-3 sm:flex-row">
            {(registration.status === 'failed' || staleSubmitting) && (
              <Button
                type="button"
                onClick={handleRetry}
                loading={retrying}
                disabled={statusRefreshing}
                aria-busy={retrying}
              >
                Retry registration
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StatusLine({ label, value }: { label: string; value: string }) {
  const normalized = value.replace(/_/g, ' ');
  const variant: 'success' | 'warning' | 'error' | 'default' =
    value === 'approved' || value === 'assigned' || value === 'active'
      ? 'success'
      : value === 'rejected' || value === 'failed'
        ? 'error'
        : value === 'pending' || value === 'submitting'
          ? 'warning'
          : 'default';

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-stone-600 dark:text-[#bdbdbf]">{label}</span>
      <Badge variant={variant}>{normalized}</Badge>
    </div>
  );
}

function statusCopy(state: OnboardingState): string {
  const registration = state.registration;

  if (registration.smsReady) {
    return 'Your number is approved and linked. Your AI assistant can now send and reply to customer texts.';
  }

  // Rejection copy outranks the generic failed copy: carrier rejections also
  // set status to 'failed' (webhook mapping), and it also outranks a legacy
  // No-EIN hold so the only available support action matches the explanation.
  if (registration.brandStatus === 'rejected') {
    return REJECTION_SUPPORT_MESSAGE;
  }

  if (registration.campaignStatus === 'rejected') {
    return REJECTION_SUPPORT_MESSAGE;
  }

  if (registration.holdReason === 'held_no_ein') {
    return 'SMS setup is paused until you add an EIN in Business Verification.';
  }

  if (registration.status === 'failed') {
    return 'Something interrupted the registration submit. Any saved carrier IDs will be reused when you retry.';
  }

  if (registration.awaitingCampaignSubmission) {
    return registration.brandStatus === 'approved'
      ? 'Business verification is approved. We are preparing the next step automatically. You do not need to resubmit.'
      : 'Your business details were submitted successfully. We will continue SMS registration automatically after verification. You do not need to retry.';
  }

  if (registration.campaignStatus === 'approved' && registration.assignmentStatus !== 'assigned') {
    return 'Your campaign is approved. We are linking your business number before texting can go live.';
  }

  if (registration.brandStatus === 'approved') {
    return 'Business verification is approved. Your SMS campaign is now waiting on carrier review.';
  }

  return 'Business verification can take hours to a couple of days. We will keep this page updated as carriers respond.';
}
