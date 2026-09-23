import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getOnboardingStateForOwner } from '@/lib/onboarding/state';
import { card, pageShell, fontStack, lightAmbient, darkAmbient } from '@/lib/theme-v2/theme';
import { ThemeToggleV2 } from '@/lib/theme-v2/ui';
import OnboardingDeleteAccount from '@/components/onboarding/OnboardingDeleteAccount';
import OnboardingSignOut from '@/components/onboarding/OnboardingSignOut';
import { PRIVATE_ROUTE_METADATA } from '@/lib/seo/privateMetadata';
import { getWorkspaceAccess } from '@/lib/customer/workspaceAccess.server';
import { workspacePageRedirectTarget } from '@/lib/customer/workspaceRouteResponse.server';
import { AccountServiceStatusBanner } from '@/components/account/AccountServiceStatusBanner';
import { resolveBusinessEntitlements } from '@/lib/billing/entitlements';

export const metadata = PRIVATE_ROUTE_METADATA;

export default async function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const workspaceAccess = await getWorkspaceAccess();
  const workspaceRedirect = workspacePageRedirectTarget(workspaceAccess);
  if (workspaceRedirect) {
    redirect(workspaceRedirect);
  }

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const { data: business } = await supabase
    .from('businesses')
    .select(
      'id, deleted_at, onboarding_completed_at, operations_suspended_at, ai_replies_paused_at, texting_paused_at, bookings_paused_at'
    )
    .eq('owner_id', user.id)
    .single();

  if (business?.deleted_at) {
    redirect('/account-deleted');
  }

  if (business?.onboarding_completed_at) {
    const entitlements = await resolveBusinessEntitlements(business.id);
    if (entitlements.textingUpgradePending && entitlements.active) {
      redirect('/billing/add-texting');
    }
  }

  const onboardingState = await getOnboardingStateForOwner(user.id);
  if (onboardingState?.dashboardReady) {
    redirect('/dashboard');
  }

  return (
    <div
      className={`${pageShell} isolate overflow-x-hidden flex flex-col items-center justify-center p-4 sm:p-6`}
      style={{ fontFamily: fontStack }}
    >
      {/* Light-mode ambient gradient */}
      <div
        className="pointer-events-none fixed inset-0 -z-10 dark:hidden"
        style={{ background: lightAmbient }}
      />
      {/* Dark-mode ambient gradient */}
      <div
        className="pointer-events-none fixed inset-0 -z-10 hidden dark:block"
        style={{ background: darkAmbient }}
      />

      {/* Orange orbs */}
      <div
        className="pointer-events-none fixed z-0 rounded-full opacity-25 dark:opacity-40"
        style={{
          width: 520,
          height: 520,
          background: "rgb(var(--brand-primary-dark-rgb) / .22)",
          top: -120,
          right: -160,
          filter: "blur(64px)",
        }}
      />
      <div
        className="pointer-events-none fixed z-0 rounded-full opacity-18 dark:opacity-35"
        style={{
          width: 280,
          height: 280,
          background: "rgb(var(--brand-primary-dark-rgb) / .16)",
          left: -100,
          bottom: "12%",
          filter: "blur(56px)",
        }}
      />

      <div className="relative z-[1] w-full max-w-[720px]">
        <div className="mb-4 flex items-center justify-end gap-2">
          <OnboardingDeleteAccount />
          <OnboardingSignOut />
          <ThemeToggleV2 />
        </div>
        <AccountServiceStatusBanner
          operationsSuspendedAt={business?.operations_suspended_at ?? null}
          aiRepliesPausedAt={business?.ai_replies_paused_at ?? null}
          textingPausedAt={business?.texting_paused_at ?? null}
          bookingsPausedAt={business?.bookings_paused_at ?? null}
        />
        <div className={`p-6 sm:p-8 ${card}`}>{children}</div>
      </div>
    </div>
  );
}
