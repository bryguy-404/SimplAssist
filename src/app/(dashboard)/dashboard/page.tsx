import { redirect } from 'next/navigation';
import Link from 'next/link';
import DashboardOverview from '@/components/dashboard/DashboardOverview';
import BookingAlertNudge from '@/components/owner-booking-alerts/BookingAlertNudge';
import { card } from '@/lib/theme-v2/theme';
import { getFirstNameFromAuthMetadata } from '@/lib/utils';
import { getSmsReadinessForBusiness } from '@/lib/messaging/lookup';
import { canUseFeature } from '@/lib/billing/entitlements';
import { planRequiresSmsProvisioning } from '@/lib/billing/features';
import { isPlanAvailable } from '@/lib/billing/planAvailability';
import { FeatureStatusBanners } from '@/components/entitlements/FeatureStatusBanners';
import { shouldShowCallForwardingNudge } from '@/components/dashboard/callForwardingNudgeEligibility';
import {
  getDashboardBusinessContext,
  getDashboardPageEntitlements,
} from '@/lib/dashboard/context';
import { requireWorkspacePageAccess } from '@/lib/customer/workspaceRouteResponse.server';

export default async function DashboardPage() {
  await requireWorkspacePageAccess();
  const context = await getDashboardBusinessContext();
  if (context.status === 'unauthenticated') redirect('/login');
  if (context.status !== 'resolved') redirect('/onboarding');

  const { supabase, user, business } = context;
  const isPartnerManagedBilling = business.partner_id !== null;
  const signupMode = business.primary_goal === 'signup';

  // Calculate date for "this week" queries
  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoISO = weekAgo.toISOString();

  const entitlementResult = await getDashboardPageEntitlements(business.id);
  if (entitlementResult.status === 'subscription_missing') redirect('/onboarding');
  const { entitlements } = entitlementResult;
  const smsEnabled = planRequiresSmsProvisioning(entitlements.plan);
  const [dashboardData, smsReadiness] = await Promise.all([
    Promise.all([
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('business_id', business.id),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('business_id', business.id).eq('status', 'active'),
      supabase.from('contacts').select('*', { count: 'exact', head: true }).eq('business_id', business.id),
      supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('business_id', business.id)
        .in('role', ['assistant', 'human_agent'])
        .in('channel', ['sms', 'web_chat'])
        .gte('created_at', weekAgoISO),
      supabase
        .from('conversations')
        .select('*, contact:contacts(name, phone_number)')
        .eq('business_id', business.id)
        .order('last_message_at', { ascending: false })
        .limit(5),
      supabase
        .from('contacts')
        .select('*')
        .eq('business_id', business.id)
        .eq('lead_status', 'hot')
        .order('lead_status_updated_at', { ascending: false })
        .limit(10),
      smsEnabled
        ? supabase
            .from('phone_numbers')
            .select('phone_number, is_active')
            .eq('business_id', business.id)
            .eq('is_active', true)
            .single()
        : Promise.resolve({ data: null }),
      supabase.from('ai_settings').select('booking_enabled, booking_mode, guardrails').eq('business_id', business.id).single(),
      supabase.from('google_calendar_tokens').select('id').eq('business_id', business.id).single(),
      supabase.from('widget_configs').select('is_active').eq('business_id', business.id).maybeSingle(),
    ]),
    smsEnabled
      ? getSmsReadinessForBusiness(business.id)
      : Promise.resolve({
          smsReady: false,
          blockReason: null,
          campaignStatus: null,
          assignmentStatus: null,
          assignmentFailureReason: null,
          phoneNumber: null,
          messagingProfileId: null,
        }),
  ]);

  const [
    { count: totalConversations },
    { count: activeConversations },
    { count: totalContacts },
    { count: messagesThisWeek },
    { data: recentConversationsRaw },
    { data: hotLeads },
    { data: phoneNumberRow },
    { data: aiSettings },
    { data: calendarToken },
    { data: widgetConfig },
  ] = dashboardData;

  // Voice fragments are not standalone messages suitable for a list preview.
  const recentConversations = await Promise.all(
    (recentConversationsRaw || []).map(async (conv) => {
      if (conv.channel === 'voice') return { ...conv, lastMessage: 'View call transcript' };
      const { data: messages } = await supabase
        .from('messages')
        .select('content')
        .eq('conversation_id', conv.id)
        .order('created_at', { ascending: false })
        .limit(1);
      return {
        ...conv,
        lastMessage: messages?.[0]?.content || undefined,
      };
    })
  );

  const firstName = getFirstNameFromAuthMetadata(user);
  const welcomeLine = firstName ? `Welcome ${firstName}!` : 'Welcome back!';
  const canUseCalendar = canUseFeature(entitlements, 'calendar');
  const fullSuiteAvailable = isPlanAvailable('full');
  const activePhoneNumber = smsReadiness.phoneNumber || phoneNumberRow?.phone_number || null;
  const showCallForwardingNudge = shouldShowCallForwardingNudge({
    hasActivePhoneNumber: Boolean(activePhoneNumber),
    canUseMissedCallSms: canUseFeature(entitlements, 'missed_call_sms'),
    callForwardingEnabled: business.call_forwarding_enabled ?? false,
    resolvedAt: business.call_forwarding_nudge_resolved_at ?? null,
  });
  const pausedFeatures = [
    !canUseFeature(entitlements, 'ai_sms_conversations') &&
      (entitlements.plan === 'sms_only' || !entitlements.active)
      ? 'AI SMS conversations'
      : null,
    widgetConfig?.is_active && !canUseFeature(entitlements, 'web_chat')
      ? 'Website chat widget'
      : null,
    !signupMode &&
      (calendarToken || aiSettings?.booking_enabled) &&
      !canUseCalendar
      ? 'Google Calendar and AI booking'
      : null,
    fullSuiteAvailable &&
      Array.isArray(aiSettings?.guardrails) && aiSettings.guardrails.length > 0 &&
      !canUseFeature(entitlements, 'advanced_guardrails')
      ? 'Advanced AI guardrails'
      : null,
  ].filter((feature): feature is string => Boolean(feature));

  return (
    <div className="space-y-6">
      <div>
        <p className="text-3xl sm:text-4xl font-bold tracking-tight text-stone-900 dark:text-[#f5f5f5]">
          {welcomeLine}
        </p>
        <h1 className="mt-2 text-2xl font-bold text-stone-900 dark:text-[#f5f5f5]">Dashboard</h1>
        <p className="mt-1 text-stone-500 dark:text-[#bdbdbf]">Overview of your business activity.</p>
      </div>

      <FeatureStatusBanners
        businessId={business.id}
        plan={entitlements.plan}
        status={entitlements.status}
        pausedFeatures={pausedFeatures}
      />

      {/* Calendar connection warning */}
      {!signupMode && canUseCalendar && !calendarToken && (
        <div className={`p-4 ${card} border-amber-200 dark:border-amber-500/30`}>
          <div className="flex items-center gap-3">
            <div className="w-2.5 h-2.5 rounded-full bg-amber-400 flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-stone-900 dark:text-[#f5f5f5]">
                Google Calendar not connected
              </p>
              <p className="text-xs text-stone-500 dark:text-[#bdbdbf] mt-0.5">
                Connect your Google Calendar to let your AI check availability and book appointments for customers automatically.
              </p>
            </div>
            <Link
              href="/settings"
              className="px-4 py-2 text-sm font-medium rounded-full bg-[var(--brand-primary)] text-white hover:bg-[var(--brand-primary-hover)] active:bg-[var(--brand-primary-active)] dark:bg-[var(--brand-primary-dark)] dark:text-[#16100b] dark:hover:bg-[var(--brand-primary-hover-dark)] transition-colors whitespace-nowrap"
            >
              Connect Now
            </Link>
          </div>
        </div>
      )}

      {/* The invitation checks alert eligibility, enrollment, and dismissal for either goal. */}
      {signupMode || (canUseCalendar && calendarToken && aiSettings?.booking_enabled && aiSettings.booking_mode === 'schedule_direct') ? <BookingAlertNudge key={business.id} /> : null}

      <DashboardOverview
        stats={{
          totalConversations: totalConversations || 0,
          activeConversations: activeConversations || 0,
          totalContacts: totalContacts || 0,
          messagesThisWeek: messagesThisWeek || 0,
        }}
        recentConversations={recentConversations}
        hotLeads={hotLeads || []}
        phoneNumber={activePhoneNumber}
        showCallForwardingNudge={showCallForwardingNudge}
        billingMode={business.billing_mode}
        isPartnerManagedBilling={isPartnerManagedBilling}
        smsEnabled={smsEnabled}
        a2pStatus={{
          brandStatus: business.brand_status ?? null,
          brandStatusUpdatedAt: business.brand_status_updated_at ?? null,
          brandRejectionReason: business.brand_rejection_reason ?? null,
          campaignStatus: business.campaign_status ?? null,
          campaignStatusUpdatedAt: business.campaign_status_updated_at ?? null,
          campaignRejectionReason: business.campaign_rejection_reason ?? null,
          assignmentStatus: smsReadiness.assignmentStatus,
          assignmentFailureReason: smsReadiness.assignmentFailureReason,
          smsReady: smsReadiness.smsReady,
          smsBlockReason: smsReadiness.blockReason,
        }}
      />
    </div>
  );
}
