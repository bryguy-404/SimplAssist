"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  MessageSquare,
  CircleHelp,
  Users,
  UserPlus,
  Calendar,
  Cog,
  AppWindow,
  CreditCard,
  LogOut,
  Lock,
  Star,
} from "lucide-react";
import { BrandLogo } from "@/components/branding/BrandLogo";
import { createBrowserClient } from "@/lib/supabase/client";
import { ThemeToggleV2 } from "@/lib/theme-v2/ui";
import { StaggeredMenuIcon } from "@/components/icons/staggered-menu-icon";
import type { PrimaryGoal } from "@/types/database";

const leadsNavItem = { href: "/leads", label: "Leads", icon: UserPlus };

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/conversations", label: "Conversations", icon: MessageSquare },
  { href: "/knowledge-gaps", label: "Knowledge Gaps", icon: CircleHelp },
  { href: "/contacts", label: "Customers", icon: Users },
  { href: "/calendar", label: "Calendar", icon: Calendar },
  { href: "/settings", label: "Settings", icon: Cog },
  { href: "/widget", label: "Widget", icon: AppWindow },
  { href: "/billing", label: "Billing", icon: CreditCard },
];

function formatWebsiteUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export default function Sidebar({
  userEmail,
  websiteUrl,
  activePath,
  primaryGoal = null,
  canUseCalendar = true,
  canUseWidget = true,
  isPartnerManagedBilling = false,
  canUseReviews = false,
}: {
  userEmail: string;
  websiteUrl: string | null;
  /** Override the active-nav match (used by the /demo routes, whose own
  *  pathname never equals a real nav href). Real callers omit it. */
  activePath?: string;
  primaryGoal?: PrimaryGoal | null;
  canUseCalendar?: boolean;
  canUseWidget?: boolean;
  isPartnerManagedBilling?: boolean;
  canUseReviews?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const supabase = createBrowserClient();
  const goalAwareNavItems =
    primaryGoal === "signup"
      ? navItems.map((item) =>
          item.href === "/calendar" ? leadsNavItem : item
        )
      : navItems;
  const reviewAwareNavItems = canUseReviews
    ? goalAwareNavItems.flatMap((item) => item.href === "/contacts" ? [item, { href: "/reviews", label: "Reviews", icon: Star }] : [item])
    : goalAwareNavItems;
  const visibleNavItems = isPartnerManagedBilling
    ? reviewAwareNavItems.filter((item) => item.href !== "/billing")
    : reviewAwareNavItems;

  async function handleSignOut() {
    // Global scope (the default) is deliberate: it is the customer's only
    // remote-revocation lever for sessions abandoned on other devices. It
    // only endangers the separate /admin channel when the SAME user is in
    // both — the dedicated admin identity must never sign in here, and its
    // recovery is a re-login at /admin.
    await supabase.auth.signOut();
    // Invalidate the Router Cache so the next session's layout re-fetches.
    // Without this, Next.js can serve the stale Sidebar (with the previous
    // user's email + website) when a different account signs back in.
    router.refresh();
    router.push("/");
  }

  const sidebarContent = (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-6 shrink-0">
        <Link href="/dashboard">
          <BrandLogo
            width={140}
            height={34}
            className="h-8 w-auto object-contain"
            wordmarkClassName="max-w-[11rem] text-lg"
          />
        </Link>
      </div>

      <nav className="flex-1 px-3 space-y-1 overflow-y-auto min-h-0">
        {visibleNavItems.map((item) => {
          const currentPath = activePath ?? pathname;
          const isActive =
            currentPath === item.href ||
            (item.href === '/settings' && currentPath.startsWith('/settings/'));
          const isLocked =
            (item.href === "/calendar" && !canUseCalendar) ||
            (item.href === "/widget" && !canUseWidget);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-full text-sm font-medium transition-colors ${
                isActive
                  ? "bg-[var(--brand-accent-soft)] dark:bg-[rgb(var(--brand-primary-dark-rgb)/.15)] text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)] border border-[var(--brand-accent-soft-border)] dark:border-[rgb(var(--brand-primary-dark-rgb)/.20)]"
                  : "text-stone-600 dark:text-[#bdbdbf] hover:bg-stone-100 dark:hover:bg-white/[0.06] hover:text-stone-900 dark:hover:text-white border border-transparent"
              }`}
            >
              <item.icon className="h-5 w-5" />
              <span className="flex-1">{item.label}</span>
              {isLocked && (
                <Lock
                  className="h-3.5 w-3.5 text-stone-400 dark:text-[#777]"
                  aria-label={`${item.label} is unavailable on the current subscription`}
                />
              )}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-[#ece4d8] dark:border-white/[0.10] shrink-0">
        <div className="grid grid-cols-[1fr_auto] gap-x-2 gap-y-1.5 items-start">
          <p className="text-xs leading-snug text-stone-500 dark:text-[#bdbdbf] truncate min-w-0 col-start-1 row-start-1">
            {userEmail}
          </p>
          {websiteUrl && (
            <a
              href={websiteUrl.startsWith("http") ? websiteUrl : `https://${websiteUrl}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs leading-snug text-[var(--brand-accent)] hover:text-[var(--brand-primary-active)] dark:text-[var(--brand-accent-dark)] dark:hover:text-[var(--brand-primary-soft-dark)] truncate block col-start-1 row-start-2 mb-2 transition-colors"
            >
              {formatWebsiteUrl(websiteUrl)}
            </a>
          )}
          <div
            className={`col-start-2 row-start-1 justify-self-end shrink-0 ${websiteUrl ? "row-span-2 self-start" : ""}`}
          >
            <ThemeToggleV2 />
          </div>
        </div>
        <button
          onClick={handleSignOut}
          className="flex items-center gap-2 text-sm text-stone-600 dark:text-[#bdbdbf] hover:text-stone-900 dark:hover:text-white transition-colors"
        >
          <LogOut className="h-4 w-4" />
          Log Out
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile header: logo left, menu right */}
      <header className="lg:hidden fixed top-0 left-0 right-0 z-50 flex items-center justify-between gap-3 px-4 py-3 bg-white/85 dark:bg-[rgba(18,18,20,0.92)] backdrop-blur-[14px] border-b border-[#ece4d8] dark:border-white/[0.10]">
        <Link href="/dashboard" className="flex items-center shrink-0 min-w-0" onClick={() => setMobileOpen(false)}>
          <BrandLogo
            width={160}
            height={40}
            className="h-9 w-auto max-w-[min(100%,9rem)] object-contain object-left"
            wordmarkClassName="max-w-36 text-lg"
            priority
          />
        </Link>
        <button
          type="button"
          onClick={() => setMobileOpen((o) => !o)}
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileOpen}
          className="shrink-0 flex items-center justify-center min-h-[44px] min-w-[44px] -mr-1 rounded-lg text-[var(--brand-primary)] dark:text-[var(--brand-primary-dark)] transition-transform duration-200 active:scale-90 hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--brand-primary-rgb)/.50)] dark:focus-visible:ring-[rgb(var(--brand-primary-dark-rgb)/.50)] focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[#121214]"
        >
          <StaggeredMenuIcon open={mobileOpen} />
        </button>
      </header>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 bg-black/50 z-40"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile sidebar — floating panel */}
      <aside
        className={`lg:hidden fixed z-50 w-[min(16rem,calc(100vw-1.5rem))] left-3 top-3 bottom-3 flex flex-col
          bg-white/95 dark:bg-[rgba(18,18,20,0.94)] backdrop-blur-[20px] backdrop-saturate-[1.4]
          border border-[#ece4d8] dark:border-white/[0.12]
          rounded-2xl shadow-[0_24px_64px_rgba(0,0,0,0.18)] dark:shadow-[0_24px_64px_rgba(0,0,0,0.55)]
          transform transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] overflow-hidden
          ${mobileOpen ? "translate-x-0" : "-translate-x-[calc(100%+14px)]"}`}
      >
        {sidebarContent}
      </aside>

      {/* Desktop sidebar — floating, rounded */}
      <aside
        className="hidden lg:flex flex-col flex-shrink-0 w-64 h-[calc(100dvh-2.5rem)] max-h-[calc(100dvh-2.5rem)]
          rounded-[28px] overflow-hidden
          bg-white/90 dark:bg-[rgba(20,20,24,0.92)] backdrop-blur-[20px] backdrop-saturate-[1.4]
          border border-[#ece4d8] dark:border-white/[0.12]
          shadow-[0_20px_60px_rgba(0,0,0,0.08)] dark:shadow-[0_28px_90px_rgba(0,0,0,0.55)]
          lg:sticky lg:top-5 lg:self-start"
      >
        {sidebarContent}
      </aside>
    </>
  );
}
