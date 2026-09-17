import Image from "next/image";
import Link from "next/link";
import { ThemeToggleV2 } from "@/lib/theme-v2/ui";
import { btnPrimary, btnSecondary, card, navLink, navShell } from "@/lib/theme-v2/theme";
import { FeatureMenu } from "./feature-menu";

export function MarketingHeader() {
  return (
    <nav aria-label="Main navigation" className={`${navShell} flex items-center justify-between gap-2 px-3 py-2 sm:gap-4 sm:px-6 sm:py-3`}>
      <Link href="/" aria-label="SimplAssist home" className="shrink-0">
        <Image src="/logo-dark.png" alt="SimplAssist" width={1991} height={468} sizes="(min-width: 640px) 140px, 94px" priority className="hidden h-auto w-[94px] object-contain dark:block sm:w-[140px]" />
        <Image src="/logo-light.png" alt="SimplAssist" width={1996} height={460} sizes="(min-width: 640px) 140px, 94px" priority className="block h-auto w-[94px] object-contain dark:hidden sm:w-[140px]" />
      </Link>
      <div className="flex items-center gap-5">
        <FeatureMenu />
        <Link href="/#how-it-works" className={`${navLink} hidden lg:block`}>How It Works</Link>
        <Link href="/#pricing" className={`${navLink} hidden md:block`}>Pricing</Link>
      </div>
      <div className="flex items-center gap-2 sm:gap-3">
        <ThemeToggleV2 />
        <Link href="/login" className={`${btnSecondary} hidden lg:inline-flex`}>Log In</Link>
        <Link href="/signup" className={`${btnPrimary} !px-3 !py-2.5 max-[359px]:hidden sm:!px-6 sm:!py-3.5`}>
          <span className="sm:hidden">Start</span><span className="hidden sm:inline">Get Started</span>
        </Link>
      </div>
    </nav>
  );
}

export function MarketingFooter() {
  return (
    <footer className="pb-10 pt-10">
      <div className={`${card} flex flex-col gap-7 px-6 py-7 md:flex-row md:items-center md:justify-between`}>
        <div className="max-w-sm">
          <Link href="/" className="text-lg font-extrabold">SimplAssist</Link>
          <p className="mt-2 text-xs leading-5 text-stone-500 dark:text-stone-400">&copy; {new Date().getFullYear()} SimplAssist, a product of Arambula Ventures LLC.</p>
        </div>
        <nav aria-label="Footer navigation" className="flex flex-wrap gap-x-5 gap-y-3">
          <Link href="/#missed-call-text-back" className={navLink}>Missed-call text back</Link>
          <Link href="/ai-chatbot-for-small-business" className={navLink}>Website chat</Link>
          <Link href="/ai-receptionist-for-small-business" className={navLink}>SimplAssist Voice</Link>
          <Link href="/#pricing" className={navLink}>Pricing</Link>
          <Link href="/support" className={navLink}>Support</Link>
          <Link href="/privacy" className={navLink}>Privacy</Link>
          <Link href="/terms" className={navLink}>Terms</Link>
          <Link href="/login" className={navLink}>Log In</Link>
        </nav>
      </div>
    </footer>
  );
}
