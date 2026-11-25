import Link from "next/link";
import { BrandLogo } from "@/components/branding/BrandLogo";
import { ThemeToggleV2 } from "@/lib/theme-v2/ui";
import {
  body,
  card,
  darkAmbient,
  fontStack,
  lightAmbient,
  pageShell,
} from "@/lib/theme-v2/theme";

/** The warm page frame around the coupon card, shared with its demo page. */
export function GiftPageShell({
  children,
  embedded = false,
}: {
  children: React.ReactNode;
  /** Inside the demo page: no full-height shell, theme toggle or home link. */
  embedded?: boolean;
}) {
  const content = (
    <div className="relative z-[1] mx-auto w-full max-w-[460px]">
      {embedded ? null : (
        <div className="mb-6 flex items-center justify-between gap-4">
          <Link href="/" className="inline-flex rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)]">
            <BrandLogo
              width={150}
              height={40}
              className="h-8 w-auto object-contain"
              wordmarkClassName="text-xl"
              priority
            />
          </Link>
          <ThemeToggleV2 />
        </div>
      )}
      <div className={`p-7 sm:p-10 ${card}`}>{children}</div>
      {embedded ? null : (
        <p className={`mt-6 text-center text-xs ${body}`}>
          SimplAssist answers your customers by text and chat, so you don’t miss a lead.
        </p>
      )}
    </div>
  );

  if (embedded) return content;

  return (
    <div
      className={`${pageShell} isolate flex flex-col items-center justify-center p-4 sm:p-6`}
      style={{ fontFamily: fontStack }}
    >
      <div className="pointer-events-none fixed inset-0 -z-10 dark:hidden" style={{ background: lightAmbient }} />
      <div className="pointer-events-none fixed inset-0 -z-10 hidden dark:block" style={{ background: darkAmbient }} />
      {content}
    </div>
  );
}
