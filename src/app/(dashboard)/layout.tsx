import { redirect } from "next/navigation";
import { getSmsReadinessForBusiness } from "@/lib/messaging/lookup";
import Sidebar from "./_components/sidebar";
import { pageShell, fontStack, lightAmbient, darkAmbient } from "@/lib/theme-v2/theme";
import { canUseFeature } from "@/lib/billing/entitlements";
import {
  getDashboardBusinessContext,
  getDashboardPageEntitlements,
} from "@/lib/dashboard/context";
import { PRIVATE_ROUTE_METADATA } from "@/lib/seo/privateMetadata";
import { getWorkspaceAccess } from "@/lib/customer/workspaceAccess.server";
import { workspacePageRedirectTarget } from "@/lib/customer/workspaceRouteResponse.server";
import { AccountServiceStatusBanner } from "@/components/account/AccountServiceStatusBanner";
import { getOnboardingStateForOwnerReadOnly } from "@/lib/onboarding/state";

export const metadata = PRIVATE_ROUTE_METADATA;

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const workspaceAccess = await getWorkspaceAccess();
  const workspaceRedirect = workspacePageRedirectTarget(workspaceAccess);
  if (workspaceRedirect) {
    redirect(workspaceRedirect);
  }

  const context = await getDashboardBusinessContext();
  if (context.status === "unauthenticated") {
    redirect("/login");
  }
  if (context.status !== "resolved") {
    redirect("/onboarding");
  }

  const { business, user } = context;
  if (business.deleted_at) {
    redirect("/account-deleted");
  }
  if (business.primary_goal === null) {
    redirect("/onboarding");
  }
  const isPartnerManagedBilling = business.partner_id !== null;

  // SMS plans still unlock only after carrier + number readiness. Chat Only
  // uses the authoritative onboarding read model so an owner-writable intent
  // or stale completion timestamp can never unlock the dashboard by itself.
  const entitlementResult = await getDashboardPageEntitlements(business.id);
  if (entitlementResult.status === "subscription_missing") {
    redirect("/onboarding");
  }
  const { entitlements } = entitlementResult;
  let dashboardReady: boolean;

  if (entitlements.textingUpgradePending === true) {
    // The trusted entitlement read verifies a paid upgrade from completed Chat.
    // Initial onboarding describes the billed SMS plan and cannot gate access
    // while its carrier setup is pending.
    dashboardReady = entitlements.active;
  } else if (entitlements.plan === "chat_only") {
    const onboardingState = await getOnboardingStateForOwnerReadOnly(user.id);
    dashboardReady = Boolean(
      onboardingState?.dashboardReady === true &&
        onboardingState.completedAt !== null &&
        onboardingState.planSelection.effectivePlan === "chat_only" &&
        (onboardingState.planSelection.source === "subscription" ||
          onboardingState.planSelection.source === "partner_plan"),
    );
  } else {
    const smsReadiness = await getSmsReadinessForBusiness(business.id);
    dashboardReady = smsReadiness.smsReady;
  }
  if (!dashboardReady) {
    redirect("/onboarding");
  }

  return (
    <div
      className={`${pageShell} isolate flex flex-col lg:flex-row lg:p-5 lg:gap-5`}
      style={{ fontFamily: fontStack }}
    >
      {/* Ambient backgrounds — light gets its own warm treatment */}
      <div
        className="fixed inset-0 -z-10 pointer-events-none dark:hidden"
        style={{ background: lightAmbient }}
      />
      <div
        className="hidden dark:block fixed inset-0 pointer-events-none -z-10"
        style={{ background: darkAmbient }}
      />

      {/* Decorative orbs */}
      <div
        className="fixed rounded-full pointer-events-none z-0 opacity-30 dark:opacity-45"
        style={{
          width: 640,
          height: 640,
          background: "rgb(var(--brand-primary-dark-rgb) / .20)",
          top: -70,
          right: -210,
          filter: "blur(60px)",
        }}
      />
      <div
        className="fixed rounded-full pointer-events-none z-0 opacity-20 dark:opacity-45"
        style={{
          width: 260,
          height: 260,
          background: "rgb(var(--brand-primary-dark-rgb) / .14)",
          left: -80,
          top: "40%",
          filter: "blur(60px)",
        }}
      />

      <Sidebar
        userEmail={user.email ?? ""}
        websiteUrl={business.website_url ?? null}
        primaryGoal={business.primary_goal}
        canUseCalendar={canUseFeature(entitlements, "calendar")}
        canUseWidget={canUseFeature(entitlements, "web_chat")}
        isPartnerManagedBilling={isPartnerManagedBilling}
      />
      <main className="flex-1 bg-transparent px-4 pt-[4.75rem] pb-6 lg:pt-5 lg:pr-6 lg:pb-6 lg:pl-0 relative z-[1] min-w-0 lg:min-h-0 lg:overflow-y-auto">
        <AccountServiceStatusBanner
          operationsSuspendedAt={business.operations_suspended_at}
          aiRepliesPausedAt={business.ai_replies_paused_at}
          textingPausedAt={business.texting_paused_at}
          bookingsPausedAt={business.bookings_paused_at}
        />
        {children}
      </main>
    </div>
  );
}
