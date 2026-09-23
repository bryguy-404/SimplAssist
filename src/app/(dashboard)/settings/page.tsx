import { redirect } from 'next/navigation';
import OwnerVoiceSettings from '@/components/settings/OwnerVoiceSettings';
import OwnerBookingAlerts from '@/components/owner-booking-alerts/OwnerBookingAlerts';
import { getOwnerVoiceSettings } from '@/lib/voice/access.server';
import BookingSettingsForm from '@/components/settings/BookingSettingsForm';
import AISettingsForm from '@/components/settings/AISettingsForm';
import GoalSettingsForm from '@/components/settings/GoalSettingsForm';
import ServicesManager from '@/components/settings/ServicesManager';
import FAQManager from '@/components/settings/FAQManager';
import BusinessHoursEditor from '@/components/settings/BusinessHoursEditor';
import BusinessInfoEditor from '@/components/settings/BusinessInfoEditor';
import PhoneNumberSection from '@/components/settings/PhoneNumberSection';
import BusinessEmailForm from '@/components/settings/BusinessEmailForm';
import TimezoneSelector from '@/components/settings/TimezoneSelector';
import CompliancePanel from '@/components/settings/CompliancePanel';
import { card } from '@/lib/theme-v2/theme';
import DangerZone from '@/components/settings/DangerZone';
import { LockedFeatureCard } from '@/components/entitlements/LockedFeatureCard';
import { canUseFeature } from '@/lib/billing/entitlements';
import { planRequiresSmsProvisioning } from '@/lib/billing/features';
import { isPlanAvailable } from '@/lib/billing/planAvailability';
import { getDashboardEntitledContext } from '@/lib/dashboard/context';
import { requireWorkspacePageAccess } from '@/lib/customer/workspaceRouteResponse.server';
import { isSettingsRegistrationLocked } from '@/lib/settings/registrationLock.server';
import Link from 'next/link';
import { BookOpen, ChevronRight } from 'lucide-react';
import { isRicherWebsiteScanEnabledForBusiness } from '@/lib/website-scans/rollout.server';

type SettingsPageProps = {
  searchParams?: {
    calendar?: string | string[];
  };
};

export default async function SettingsPage({ searchParams }: SettingsPageProps) {
  await requireWorkspacePageAccess();
  const context = await getDashboardEntitledContext();
  if (context.status === 'unauthenticated') redirect('/login');
  if (context.status !== 'resolved') redirect('/onboarding');

  const { supabase, business, entitlements } = context;
  const signupMode = business.primary_goal === 'signup';
  const smsEnabled = planRequiresSmsProvisioning(entitlements.plan);
  const registrationLocked =
    smsEnabled && isSettingsRegistrationLocked(business);
  const showCalendarUnavailableStatus =
    signupMode && searchParams?.calendar === 'unavailable';
  const canCustomizeAi = canUseFeature(entitlements, 'ai_customization');
  const canUseCalendar = canUseFeature(entitlements, 'calendar');
  const canUseGuardrails = canUseFeature(entitlements, 'advanced_guardrails');
  const fullSuiteAvailable = isPlanAvailable('full');
  const richerScanEnabled = isRicherWebsiteScanEnabledForBusiness(business.id);

  const [
    { data: aiSettings },
    { data: services },
    { data: faqs },
    { data: businessHours },
    { data: phoneNumberRow },
    { data: calendarToken },
    voiceSettings,
  ] = await Promise.all([
    supabase.from('ai_settings').select('*').eq('business_id', business.id).single(),
    supabase.from('services').select('*').eq('business_id', business.id).order('name'),
    supabase.from('faqs').select('*').eq('business_id', business.id).order('question'),
    supabase.from('business_hours').select('*').eq('business_id', business.id).order('day_of_week'),
    smsEnabled
      ? supabase.from('phone_numbers').select('*').eq('business_id', business.id).eq('is_active', true).single()
      : Promise.resolve({ data: null }),
    supabase.from('google_calendar_tokens').select('*').eq('business_id', business.id).single(),
    getOwnerVoiceSettings(business.id).catch(() => null),
  ]);

  if (!aiSettings) redirect('/onboarding');

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-stone-900 dark:text-[#f5f5f5]">Settings</h1>
        <p className="mt-1 text-stone-500 dark:text-[#bdbdbf]">Configure how your AI assistant behaves and communicates.</p>
      </div>

      {showCalendarUnavailableStatus && (
        <div
          role="status"
          className="rounded-2xl border border-[#e3dacc] bg-[#faf7f2] px-4 py-3 text-sm text-stone-700 dark:border-white/[0.12] dark:bg-white/[0.06] dark:text-[#d7d7da]"
        >
          Google Calendar isn’t used for the signup-link goal. Your assistant
          can keep sending your configured link, and sent links appear in Leads.
        </div>
      )}

      {richerScanEnabled && <Link
        href="/settings/knowledge"
        className={`group flex items-center gap-4 p-6 transition-colors hover:border-[var(--brand-primary)] ${card}`}
      >
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--brand-accent-soft)] text-[var(--brand-accent)] dark:bg-[rgb(var(--brand-primary-dark-rgb)/.12)] dark:text-[var(--brand-accent-dark)]">
          <BookOpen className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-stone-900 dark:text-[#f5f5f5]">Assistant Knowledge</h2>
          <p className="mt-1 text-sm text-stone-500 dark:text-[#bdbdbf]">
            Review your assistant’s business briefing or rescan your website for updated services, FAQs, facts, and policies.
          </p>
        </div>
        <ChevronRight className="h-5 w-5 shrink-0 text-stone-400 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
      </Link>}

      {/* Phone Number */}
      {smsEnabled && <div className={`p-6 ${card}`}>
        <h2 className="text-lg font-semibold text-stone-900 dark:text-[#f5f5f5] mb-1">Phone Number</h2>
        <p className="text-sm text-stone-500 dark:text-[#bdbdbf] mb-4">
          The phone number customers use to text your AI assistant.
        </p>
        <PhoneNumberSection
          phoneNumber={phoneNumberRow?.phone_number || null}
          isActive={phoneNumberRow?.is_active || false}
          callForwardingEnabled={business.call_forwarding_enabled ?? false}
          forwardToNumber={business.forward_to_number ?? null}
        />
      </div>}

      <OwnerVoiceSettings initialSettings={voiceSettings} />

      <OwnerBookingAlerts key={business.id} />

      {/* Business Email */}
      <div className={`p-6 ${card}`}>
        <h2 className="text-lg font-semibold text-stone-900 dark:text-[#f5f5f5] mb-1">Business Email</h2>
        <p className="text-sm text-stone-500 dark:text-[#bdbdbf] mb-4">
          Contact email your AI can share with customers when it needs to escalate.
        </p>
        <BusinessEmailForm businessId={business.id} initialEmail={business.email} />
      </div>

      {/* Compliance (Phase 6) — privacy/terms URLs submitted to Telnyx */}
      {smsEnabled && <div className={`p-6 ${card}`}>
        <h2 className="text-lg font-semibold text-stone-900 dark:text-[#f5f5f5] mb-1">Compliance</h2>
        <p className="text-sm text-stone-500 dark:text-[#bdbdbf] mb-4">
          Where your privacy policy and terms of service live. Carriers (T-Mobile, AT&amp;T, Verizon) check these when reviewing your SMS campaign.
        </p>
        <CompliancePanel
          slug={business.slug}
          business={{
            name: business.name,
            phone_number: business.phone_number,
            sms_phone_number: phoneNumberRow?.phone_number ?? null,
            email: business.email,
            address: business.address,
            city: business.city,
            state: business.state,
            zip: business.zip,
            opt_in_description: business.opt_in_description,
            language: aiSettings.language,
          }}
          initialMode={business.privacy_terms_mode ?? 'hosted'}
          initialPrivacyUrl={business.privacy_url_override}
          initialTermsUrl={business.terms_url_override}
          registrationLocked={registrationLocked}
        />
      </div>}

      {/* AI Settings */}
      <div className={`p-6 ${card}`}>
        <GoalSettingsForm
          initialPrimaryGoal={business.primary_goal}
          initialGoalUrl={business.goal_url}
          registrationLocked={registrationLocked}
        />
        <AISettingsForm
          settings={aiSettings}
          businessName={business.name}
          calendarEmail={calendarToken?.google_email ?? null}
          calendarConnected={!!calendarToken}
          businessId={business.id}
          canCustomizeAi={canCustomizeAi}
          canUseCalendar={canUseCalendar}
          calendarGoalAvailable={!signupMode}
          canUseGuardrails={canUseGuardrails}
          planActive={entitlements.active}
          fullSuiteAvailable={fullSuiteAvailable}
          showSmsResponseDelay={smsEnabled}
        />
      </div>

      {!signupMode && canUseCalendar && <BookingSettingsForm services={services || []} />}

      {/* Services */}
      <div className={`p-6 ${card}`}>
        <h2 className="text-lg font-semibold text-stone-900 dark:text-[#f5f5f5] mb-1">Services</h2>
        <p className="text-sm text-stone-500 dark:text-[#bdbdbf] mb-4">Manage the services your business offers. Your AI will use this information when talking to customers.</p>
        {canCustomizeAi ? (
          <ServicesManager businessId={business.id} initialServices={services || []} />
        ) : (
          <LockedFeatureCard
            compact
            title="Service customization is paused"
            description={entitlements.active
              ? "Growth lets your AI use your service catalog when answering customers."
              : "Reactivate your subscription to use your saved service catalog in AI conversations."}
            requiredPlan={entitlements.active ? "Growth" : null}
            preservedDetail={`${services?.length ?? 0} saved service${services?.length === 1 ? '' : 's'} will remain available after upgrading.`}
          />
        )}
      </div>

      {/* FAQs */}
      <div className={`p-6 ${card}`}>
        <h2 className="text-lg font-semibold text-stone-900 dark:text-[#f5f5f5] mb-1">FAQs</h2>
        <p className="text-sm text-stone-500 dark:text-[#bdbdbf] mb-4">Common questions and answers your AI can use to help customers.</p>
        {canCustomizeAi ? (
          <FAQManager businessId={business.id} initialFaqs={faqs || []} />
        ) : (
          <LockedFeatureCard
            compact
            title="FAQ customization is paused"
            description={entitlements.active
              ? "Growth lets your AI answer from your saved business FAQs."
              : "Reactivate your subscription to use your saved FAQs in AI conversations."}
            requiredPlan={entitlements.active ? "Growth" : null}
            preservedDetail={`${faqs?.length ?? 0} saved FAQ${faqs?.length === 1 ? '' : 's'} will remain available after upgrading.`}
          />
        )}
      </div>

      {/* Business Info */}
      <div className={`p-6 ${card}`}>
        <h2 className="text-lg font-semibold text-stone-900 dark:text-[#f5f5f5] mb-1">Business Info</h2>
        <p className="text-sm text-stone-500 dark:text-[#bdbdbf] mb-4">
          Keep the contact details and hours your AI shares with customers up to date.
        </p>

        <BusinessInfoEditor
          initialPhoneNumber={business.phone_number}
          initialAddress={business.address}
          initialCity={business.city}
          initialState={business.state}
          initialZip={business.zip}
          registrationLocked={registrationLocked}
        />

        <div className="mt-8 border-t border-[#e3dacc] pt-8 dark:border-white/[0.12]">
          <h3 className="text-base font-semibold text-stone-900 dark:text-[#f5f5f5] mb-1">
            Timezone &amp; Hours
          </h3>
          <p className="text-sm text-stone-500 dark:text-[#bdbdbf] mb-4">
            Set when your business is open. Your AI will inform customers of your hours.
          </p>

          <div className="mb-6">
            <label className="block text-sm font-medium text-stone-700 dark:text-[#bdbdbf] mb-2">
              Timezone
            </label>
            <TimezoneSelector businessId={business.id} initialTimezone={business.timezone} />
          </div>

          <BusinessHoursEditor businessId={business.id} initialHours={businessHours || []} />
        </div>
      </div>

      {/* Danger Zone */}
      <DangerZone />
    </div>
  );
}
