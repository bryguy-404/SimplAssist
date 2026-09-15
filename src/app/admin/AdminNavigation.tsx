"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";

import AdminSignOutButton from "./AdminSignOutButton";

const ADMIN_SECTIONS = [
  { href: "/admin/clients", label: "Clients" },
  { href: "/admin/metrics", label: "Metrics" },
  { href: "/admin/voice", label: "Voice pilot" },
  { href: "/admin/partners", label: "Partners" },
  { href: "/admin/tickets", label: "Tickets" },
  { href: "/admin/waitlist", label: "Waitlist" },
] as const;

type AdminSectionHref = (typeof ADMIN_SECTIONS)[number]["href"];

export function getActiveAdminSection(
  pathname: string,
): AdminSectionHref | null {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";

  for (const { href } of ADMIN_SECTIONS) {
    if (normalizedPath === href || normalizedPath.startsWith(`${href}/`)) {
      return href;
    }
  }

  return null;
}

export function nextAdminMenuOpen(currentOpen: boolean): boolean {
  return !currentOpen;
}

export function AdminNavigation() {
  const pathname = usePathname();
  const activeSection = getActiveAdminSection(pathname);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-label={mobileMenuOpen ? "Close admin menu" : "Open admin menu"}
        aria-expanded={mobileMenuOpen}
        aria-controls="admin-navigation-menu"
        onClick={() =>
          setMobileMenuOpen((currentOpen) => nextAdminMenuOpen(currentOpen))
        }
        className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-[#e8dfd3] text-stone-700 transition-colors hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary-active)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)] md:hidden dark:border-white/[0.14] dark:text-stone-200 dark:hover:text-[var(--brand-primary-dark)]"
      >
        {mobileMenuOpen ? (
          <X className="h-5 w-5" aria-hidden />
        ) : (
          <Menu className="h-5 w-5" aria-hidden />
        )}
      </button>

      <nav
        id="admin-navigation-menu"
        aria-label="Admin sections"
        className={`absolute right-0 top-full z-30 mt-3 w-56 flex-col items-stretch gap-1 rounded-xl border border-[#e8dfd3] bg-[#fffaf6] p-3 shadow-[0_14px_36px_-22px_rgba(67,46,28,0.55)] md:static md:mt-0 md:flex md:w-auto md:flex-row md:items-center md:gap-x-5 md:border-0 md:bg-transparent md:p-0 md:shadow-none dark:border-white/[0.14] dark:bg-[#1c1917] md:dark:bg-transparent ${
          mobileMenuOpen ? "flex" : "hidden"
        }`}
      >
        {ADMIN_SECTIONS.map(({ href, label }) => {
          const active = activeSection === href;

          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              onClick={() => setMobileMenuOpen(false)}
              className={`inline-flex w-full justify-start border-b-2 px-0.5 py-2 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)] md:w-auto ${
                active
                  ? "border-[var(--brand-primary)] text-[var(--brand-primary-active)] dark:text-[var(--brand-primary-dark)]"
                  : "border-transparent text-stone-600 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary-active)] dark:text-stone-300 dark:hover:text-[var(--brand-primary-dark)]"
              }`}
            >
              {label}
            </Link>
          );
        })}
        <AdminSignOutButton />
      </nav>
    </div>
  );
}
