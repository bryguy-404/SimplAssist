'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Phone, AlertTriangle } from 'lucide-react';
import StepProgress from '@/components/onboarding/StepProgress';
import BusinessInfoForm, { type ScrapedData } from '@/components/onboarding/BusinessInfoForm';
import BusinessHoursForm from '@/components/onboarding/BusinessHoursForm';
import AssistantKnowledgeStep from '@/components/onboarding/AssistantKnowledgeStep';
import AIPersonalityForm from '@/components/onboarding/AIPersonalityForm';
import DirectPlanSelection from '@/components/onboarding/DirectPlanSelection';
import BrandVerificationForm from '@/components/onboarding/BrandVerificationForm';
import SmsUseCaseForm from '@/components/onboarding/SmsUseCaseForm';
import ReviewAndLaunch from '@/components/onboarding/ReviewAndLaunch';
import { CarrierReviewStatus } from './CarrierReviewStatus';
import PhoneNumberSelector, {
  shouldDisablePhoneNumberNext,
} from '@/components/phone/PhoneNumberSelector';
import { useBrand } from '@/components/branding/BrandProvider';
import { PulsingDot } from '@/components/ui/pulsing-dot';
import { Button } from '@/components/ui/Button';
import {
  ONBOARDING_STEP_LABELS,
  onboardingStepNumber,
  type OnboardingState,
  type OnboardingStep,
} from '@/lib/onboarding/types';
import { statusWarning } from '@/lib/theme-v2/theme';
import { evaluateContentQuality } from '@/lib/contentQuality';
import { replaceDefaultBrandName } from '@/lib/branding/presentation';
import type { BusinessType } from '@/types/database';
import { completeGoalSaveNavigation } from '@/lib/goals/primaryGoal';
import {
  displayStepForState,
  isCompletedChatOnlyState,
} from '@/lib/onboarding/navigation';
import {
  CHECKOUT_FINALIZE_ERROR,
  checkoutFinalizeFailureAction,
} from '@/lib/onboarding/checkoutFinalize';
import {
  getCurrentWebsiteScan,
  isWebsiteScanReviewable,
} from '@/lib/website-scans/client';

type StateResponse = {
  state?: OnboardingState;
  error?: string;
};

export default function OnboardingPage() {
  const brand = useBrand();
  const router = useRouter();
  const searchParams = useSearchParams();
  const finalizedSessionRef = useRef<string | null>(null);
  const resumedWebsiteScanRef = useRef(false);
  const [state, setState] = useState<OnboardingState | null>(null);
  const [step, setStep] = useState<OnboardingStep>('business_info');
  const [loading, setLoading] = useState(true);
  const [finalizingCheckout, setFinalizingCheckout] = useState(false);
  const [finalizeRetryNonce, setFinalizeRetryNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Website-scan results carried from Business Info to the Hours and
  // Services & FAQs steps so they can pre-fill editable fields. Convenience
  // only — never saved or submitted on their own, and saved DB data always
  // wins.
  const [scrapedData, setScrapedData] = useState<ScrapedData | null>(null);

  const loadState = useCallback(async (options: { keepStep?: boolean } = {}) => {
    setLoadError(null);
    let response: Response;
    try {
      response = await fetch('/api/onboarding/state', { cache: 'no-store' });
    } catch {
      setLoadError('Could not load your setup progress.');
      return null;
    }

    const payload = (await response.json().catch(() => ({}))) as StateResponse;

    if (!response.ok || !payload.state) {
      setLoadError(payload.error ?? 'Could not load your setup progress.');
      return null;
    }

    setState(payload.state);
    if (isCompletedChatOnlyState(payload.state)) {
      router.replace('/dashboard');
      return payload.state;
    }
    if (!options.keepStep) {
      setStep(displayStepForState(payload.state));
    }
    return payload.state;
  }, [router]);

  const refreshState = useCallback(async (options: { keepStep?: boolean } = {}) => {
    setRefreshing(true);
    try {
      return await loadState(options);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [loadState]);

  useEffect(() => {
    refreshState();
  }, [refreshState]);

  useEffect(() => {
    if (
      !state?.capabilities?.richerWebsiteScanEnabled ||
      resumedWebsiteScanRef.current
    ) {
      return;
    }
    resumedWebsiteScanRef.current = true;
    getCurrentWebsiteScan()
      .then((scan) => {
        if (!isWebsiteScanReviewable(scan)) return;
        setScrapedData({
          ...scan.draft.businessInfo,
          services: scan.draft.services
            .filter((service) => service.selected)
            .map(({ name, description, price }) => ({ name, description, price })),
          faqs: scan.draft.faqs
            .filter((faq) => faq.selected)
            .map(({ question, answer }) => ({ question, answer })),
          business_hours: scan.draft.businessHours,
        });
      })
      .catch(() => {
        // Each onboarding form retains its normal manual fallback.
      });
  }, [state?.capabilities?.richerWebsiteScanEnabled]);

  useEffect(() => {
    const checkout = searchParams.get('checkout');
    const sessionId = searchParams.get('session_id');
    if (
      checkout !== 'success' ||
      !sessionId ||
      finalizingCheckout ||
      finalizedSessionRef.current === sessionId
    ) {
      return;
    }

    finalizedSessionRef.current = sessionId;
    setFinalizingCheckout(true);
    fetch('/api/billing/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
      .then(async (res) => {
        const payload = (await res.json().catch(() => ({}))) as StateResponse;
        const failureAction = checkoutFinalizeFailureAction({
          responseOk: res.ok,
          payloadError: payload.error,
          hasState: Boolean(payload.state),
        });
        if (failureAction?.kind === 'resume_onboarding' && payload.state) {
          setState(payload.state);
          if (isCompletedChatOnlyState(payload.state)) {
            setLoadError(null);
            router.replace('/dashboard');
            return;
          }
          setStep(displayStepForState(payload.state));
          setLoadError(null);
          router.replace('/onboarding');
          return;
        }
        if (failureAction?.kind === 'retry_finalization') {
          setLoadError(failureAction.message);
          return;
        }

        if (payload.state) {
          setState(payload.state);
          if (isCompletedChatOnlyState(payload.state)) {
            router.replace('/dashboard');
            return;
          }
          setStep(displayStepForState(payload.state));
        } else {
          const refreshedState = await refreshState();
          if (!refreshedState) {
            setLoadError(CHECKOUT_FINALIZE_ERROR);
            return;
          }
          if (isCompletedChatOnlyState(refreshedState)) return;
        }
        router.replace('/onboarding');
      })
      .catch(() => {
        setLoadError('Checkout succeeded, but we could not finish setup automatically. Please refresh to continue.');
      })
      .finally(() => {
        setFinalizingCheckout(false);
      });
  }, [finalizeRetryNonce, finalizingCheckout, refreshState, router, searchParams]);

  useEffect(() => {
    if (state?.dashboardReady && state.currentStep === 'complete') {
      router.prefetch('/dashboard');
    }
  }, [router, state]);

  const checkoutSessionId =
    searchParams.get('checkout') === 'success'
      ? searchParams.get('session_id')
      : null;

  function retryLoadOrFinalize() {
    if (checkoutSessionId) {
      finalizedSessionRef.current = null;
      setLoadError(null);
      setFinalizeRetryNonce((value) => value + 1);
      return;
    }
    void refreshState();
  }

  if (loading) {
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 py-12">
        <PulsingDot />
        <p className="text-sm text-stone-500 dark:text-[#bdbdbf]">Loading your setup...</p>
      </div>
    );
  }

  if (loadError || !state) {
    return (
      <div className="space-y-4 text-center">
        <AlertTriangle className="mx-auto h-8 w-8 text-red-500" />
        <p className="text-sm text-red-600 dark:text-red-400">
          {replaceDefaultBrandName(
            loadError ?? 'Could not load your setup progress.',
            brand.name
          )}
        </p>
        <Button type="button" onClick={retryLoadOrFinalize}>
          {checkoutSessionId ? 'Retry finalization' : 'Try again'}
        </Button>
      </div>
    );
  }

  const currentStepNumber = onboardingStepNumber(step, state.steps);
  const contentQuality = evaluateContentQuality(state.servicesAndFaqs);

  return (
    <div>
      {!(step === 'plan_selection' && state.planSelection.position === 'start') && (
        <StepProgress currentStep={currentStepNumber} steps={state.steps} />
      )}
      <ProgressNote state={state} refreshing={refreshing || finalizingCheckout} step={step} />

      <div className="transition-opacity duration-200">
        {step === 'business_info' && (
          <BusinessInfoForm
            businessId={state.businessId}
            initialData={state.businessInfo}
            richerScanEnabled={Boolean(state.capabilities?.richerWebsiteScanEnabled)}
            onBack={
              state.planSelection.position === 'start' &&
              state.planSelection.canChooseDirectPlan
                ? () => setStep('plan_selection')
                : undefined
            }
            onNext={(data, scraped) => {
              // Only a fresh scan updates the captured result. BusinessInfoForm
              // remounts with null scrapedData on back-navigation, so guarding
              // here keeps an earlier scan's prefill from being wiped when the
              // customer returns and continues without re-scanning.
              if (scraped) setScrapedData(scraped);
              setState((current) =>
                current
                  ? {
                      ...current,
                      businessInfo: { ...current.businessInfo, ...data },
                    }
                  : current
              );
              setStep(nextStepOf(step, state.steps));
              refreshState({ keepStep: true });
            }}
          />
        )}

        {step === 'business_hours' && (
          <BusinessHoursForm
            businessId={state.businessId}
            initialData={state.businessHours.length > 0 ? state.businessHours : undefined}
            scannedData={scrapedData?.business_hours}
            onNext={(hours) => {
              setState((current) =>
                current
                  ? {
                      ...current,
                      businessHours: hours.map((row) => ({ ...row })),
                    }
                  : current
              );
              setStep(nextStepOf(step, state.steps));
              refreshState({ keepStep: true });
            }}
            onBack={() => setStep('business_info')}
          />
        )}

        {step === 'services_faqs' && (
          <AssistantKnowledgeStep
            businessId={state.businessId}
            richerScanEnabled={Boolean(state.capabilities?.richerWebsiteScanEnabled)}
            businessType={(state.businessInfo.business_type || 'general') as BusinessType}
            initialData={
              state.servicesAndFaqs.services.length > 0 ||
              state.servicesAndFaqs.faqs.length > 0
                ? state.servicesAndFaqs
                : undefined
            }
            scrapedServices={scrapedData?.services?.map((service) => ({
              name: service.name,
              description: service.description ?? undefined,
              price: service.price ?? undefined,
            }))}
            scrapedFaqs={scrapedData?.faqs}
            onNext={(data) => {
              setState((current) =>
                current
                  ? {
                      ...current,
                      servicesAndFaqs: {
                        services: data.services.map((row) => ({ ...row })),
                        faqs: data.faqs.map((row) => ({ ...row })),
                      },
                    }
                  : current
              );
              setStep(nextStepOf(step, state.steps));
              refreshState({ keepStep: true });
            }}
            onBack={() => setStep('business_hours')}
          />
        )}

        {step === 'plan_selection' && (
          <DirectPlanSelection
            initialPlan={state.planSelection.directIntent}
            chatOnlyAvailable={
              state.planSelection.chatOnlyDirectSalesAvailable
            }
            onBack={
              state.planSelection.position === 'start'
                ? undefined
                : () => setStep(previousStepOf(step, state.steps))
            }
            onNext={async () => {
              const nextState = await refreshState({ keepStep: true });
              if (nextState) setStep(displayStepForState(nextState));
            }}
          />
        )}

        {step === 'ai_settings' && (
          <AIPersonalityForm
            businessId={state.businessId}
            businessName={state.businessInfo.name || 'Your Business'}
            initialPrimaryGoal={state.primaryGoal}
            initialGoalUrl={state.goalUrl}
            initialData={state.aiSettings || undefined}
            showSmsResponseDelay={
              state.planSelection.effectivePlan !== 'chat_only'
            }
            nextOnboardingStep={
              state.planSelection.effectivePlan === 'chat_only'
                ? 'review_submit'
                : 'legal_verification'
            }
            onNext={() =>
              completeGoalSaveNavigation({
                refreshState,
                replace: (href) => router.replace(href),
                setStep,
              })
            }
            onBack={() => setStep(previousStepOf(step, state.steps))}
          />
        )}

        {step === 'legal_verification' && (
          <BrandVerificationForm
            businessId={state.businessId}
            initialData={state.brandVerification || undefined}
            onNext={() => { setStep(nextStepOf(step, state.steps)); refreshState({ keepStep: true }); }}
            onBack={() => setStep('ai_settings')}
          />
        )}

        {step === 'sms_use_case' && (
          <div className="space-y-4">
            {state.registration.status === 'failed' && state.registration.error && (
              <div className={`rounded-[18px] px-4 py-3 text-sm ${statusWarning}`}>
                {replaceDefaultBrandName(
                  state.registration.error,
                  brand.name
                )}
              </div>
            )}
            <SmsUseCaseForm
              businessId={state.businessId}
              businessName={state.businessInfo.name || 'Your Business'}
              businessType={(state.businessInfo.business_type || 'general') as BusinessType}
              businessTypeOther={state.businessInfo.business_type_other}
              language={state.aiSettings?.language ?? 'en'}
              services={state.servicesAndFaqs.services}
              riskReview={state.registration.riskReview}
              initialData={state.brandVerification}
              onNext={() => { setStep(nextStepOf(step, state.steps)); refreshState({ keepStep: true }); }}
              onBack={() => setStep('legal_verification')}
            />
          </div>
        )}

        {step === 'phone_number' && (
          <PhoneNumberStep
            state={state}
            onBack={() => setStep('sms_use_case')}
            onPurchased={() => refreshState()}
            onNext={() => { setStep(nextStepOf(step, state.steps)); refreshState({ keepStep: true }); }}
          />
        )}

        {step === 'review_submit' && (
          <ReviewAndLaunch
            data={{
              businessInfo: state.businessInfo,
              businessHours: state.businessHours,
              servicesCount: contentQuality.validServiceCount,
              faqsCount: contentQuality.validFaqCount,
              primaryGoal: state.primaryGoal,
              goalUrl: state.goalUrl,
              aiSettings: state.aiSettings ?? {
                tone: 'balanced',
                business_voice: 'we',
                language: 'en',
                response_delay_seconds: 5,
                web_greeting: '',
                booking_enabled: false,
                booking_mode: 'collect_info',
              },
              phoneNumber: state.phoneNumber,
              brandVerification: state.brandVerification,
            }}
            billing={state.billing}
            registration={state.registration}
            effectivePlan={state.planSelection.effectivePlan}
            chatOnly={state.planSelection.effectivePlan === 'chat_only'}
            chatOnlyCheckoutPaused={
              state.planSelection.chatOnlyCheckoutPaused
            }
            canEditPlan={
              state.planSelection.canChooseDirectPlan &&
              state.billing.plan === null
            }
            familyChangeRequiresSupport={state.planSelection.familyChangeRequiresSupport}
            pendingPhoneNumberFailureReason={state.pendingPhoneNumberFailureReason}
            onEditStep={(targetStep) => setStep(numberToStep(targetStep))}
            onEditPlan={() => setStep('plan_selection')}
            onBack={() => setStep(previousStepOf(step, state.steps))}
            onSubmitted={(nextState) => {
              if (nextState) {
                setState(nextState);
                if (isCompletedChatOnlyState(nextState)) {
                  router.replace('/dashboard');
                  return;
                }
              }
              setStep('carrier_review');
              refreshState({ keepStep: true });
            }}
            onLaunchBlocked={(nextState) => {
              if (!nextState) return;
              setState(nextState);
              setStep(displayStepForState(nextState));
            }}
          />
        )}

        {step === 'carrier_review' && (
          <CarrierReviewStatus
            state={state}
            onStatusRefreshed={(nextState) => {
              setState(nextState);
              setStep('carrier_review');
            }}
            onRetry={(nextState) => {
              if (nextState) {
                setState(nextState);
                setStep(
                  nextState.currentStep === 'complete'
                    ? 'carrier_review'
                    : nextState.currentStep
                );
                return;
              }
              refreshState();
            }}
            onDashboard={() => router.push('/dashboard')}
          />
        )}
      </div>
    </div>
  );
}

function ProgressNote({
  state,
  refreshing,
  step,
}: {
  state: OnboardingState;
  refreshing: boolean;
  step: OnboardingStep;
}) {
  const savedAt = state.lastSavedAt
    ? new Date(state.lastSavedAt).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      })
    : null;

  return (
    <div className="mb-5 rounded-[18px] border border-[#ede5d9] bg-[#faf7f2] px-4 py-3 text-sm text-stone-600 dark:border-white/[0.10] dark:bg-white/[0.04] dark:text-[#bdbdbf]">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span>
          {savedAt
            ? `Your progress is saved. Last saved at ${savedAt}.`
            : 'This step saves when you continue.'}
        </span>
        <span className="inline-flex items-center gap-2 text-xs text-stone-500 dark:text-[#888]">
          {refreshing && <PulsingDot inline />}
          Continue setup: {ONBOARDING_STEP_LABELS[step]}
        </span>
      </div>
    </div>
  );
}

function PhoneNumberStep({
  state,
  onBack,
  onPurchased,
  onNext,
}: {
  state: OnboardingState;
  onBack: () => void;
  onPurchased: () => void;
  onNext: () => void;
}) {
  const [replacingNumber, setReplacingNumber] = useState(false);
  const pendingSelection = Boolean(
    state.pendingPhoneNumber &&
      !state.activePhoneNumber &&
      state.phoneNumber === state.pendingPhoneNumber
  );
  const nextDisabled = shouldDisablePhoneNumberNext({
    phoneNumber: state.phoneNumber,
    pendingSelection,
    pendingFailureReason: state.pendingPhoneNumberFailureReason,
    replacingNumber,
  });

  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-[var(--brand-accent-soft)] dark:bg-transparent dark:bg-[linear-gradient(135deg,rgb(var(--brand-primary-dark-rgb)/.22),rgba(255,255,255,.08))] border border-[var(--brand-accent-soft-border)] dark:border-white/[0.10] mb-4">
          <Phone className="w-6 h-6 text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)]" />
        </div>
        <h2 className="text-xl font-semibold text-stone-900 dark:text-[#f5f5f5]">Choose a phone number for your AI assistant</h2>
        <p className="mt-2 text-sm text-stone-500 dark:text-[#bdbdbf]">
          Customers can call or text this number. SMS activates after carrier approval.
        </p>
      </div>

      <PhoneNumberSelector
        initialPhoneNumber={state.phoneNumber}
        initialPhoneNumberPending={pendingSelection}
        initialConsentAgreed={state.smsConsentAgreed}
        initialFailureReason={state.pendingPhoneNumberFailureReason}
        onNumberPurchased={() => {
          setReplacingNumber(false);
          onPurchased();
        }}
        onReplacementModeChange={setReplacingNumber}
      />

      <div className="flex justify-between pt-4">
        <button
          type="button"
          onClick={onBack}
          className="py-2 px-6 border border-[#e7e0d4] dark:border-white/[0.12] text-stone-700 dark:text-[#bdbdbf] font-medium rounded-full hover:bg-[#faf6ef] dark:hover:bg-white/[0.06] transition-colors"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={nextDisabled}
          className="py-2 px-6 bg-[var(--brand-primary)] hover:bg-[var(--brand-primary-hover)] active:bg-[var(--brand-primary-active)] dark:bg-[var(--brand-primary-dark)] dark:text-[#16100b] dark:hover:bg-[var(--brand-primary-hover-dark)] text-white font-medium rounded-full disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Next
        </button>
      </div>
    </div>
  );
}

/**
 * Successor in the canonical wizard order, clamped at the final step.
 * Used by plain Next so the UI advances exactly one step; the server-derived
 * resume position applies only on load and after Stripe/purchase snaps
 * (docs/onboarding-resume-position-bug.md).
 */
function nextStepOf(
  step: OnboardingStep,
  steps: readonly OnboardingStep[],
): OnboardingStep {
  const idx = steps.indexOf(step);
  if (idx === -1) return step;
  return steps[Math.min(idx + 1, steps.length - 1)];
}

function previousStepOf(
  step: OnboardingStep,
  steps: readonly OnboardingStep[],
): OnboardingStep {
  const idx = steps.indexOf(step);
  if (idx <= 0) return step;
  return steps[idx - 1];
}

function numberToStep(step: number): OnboardingStep {
  switch (step) {
    case 1:
      return 'business_info';
    case 2:
      return 'business_hours';
    case 3:
      return 'services_faqs';
    case 4:
      return 'ai_settings';
    case 5:
      return 'legal_verification';
    case 6:
      return 'sms_use_case';
    case 7:
      return 'phone_number';
    case 8:
      return 'review_submit';
    default:
      return 'carrier_review';
  }
}
