import type { Metadata } from "next";
import { renderGiftCodeEmail } from "@/lib/email/giftCodeTemplate";
import type { GiftOffer } from "@/lib/gift/code";
import { ThemeToggleV2 } from "@/lib/theme-v2/ui";
import {
  body,
  bodyFaint,
  darkAmbient,
  fontStack,
  ink,
  lightAmbient,
  pageShell,
} from "@/lib/theme-v2/theme";
import { assertDemoPagesEnabled } from "../_lib/guard";

/**
 * /demo/gift — an isolated review page for the coupon email that
 * /admin/gift-codes sends. Dev-only. Everything here is made up: no Stripe
 * lookup, no email, no database, no cookie. The email sits in a locked frame,
 * so its button does not go anywhere from this page.
 */

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  assertDemoPagesEnabled();
  return {
    title: "Gift code email preview (dev only)",
    robots: { index: false, follow: false },
  };
}

const FREE_MONTH: GiftOffer = { kind: "percent", percentOff: 100, duration: "once", months: null };
const SAMPLE_CODE = "ROSA-FREEMONTH";
const SAMPLE_EXPIRY = "2027-01-31T23:59:59.000Z";

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className={`mb-2 text-xs font-semibold uppercase tracking-[0.12em] ${bodyFaint}`}>{children}</p>
  );
}

export default function DemoGiftPage() {
  assertDemoPagesEnabled();

  const email = renderGiftCodeEmail({
    firstName: "Rosa",
    code: SAMPLE_CODE,
    offer: FREE_MONTH,
    expiresAt: SAMPLE_EXPIRY,
    startUrl: `https://simplassist.com/gift/${SAMPLE_CODE}/start`,
  });

  return (
    <div className={`${pageShell} isolate p-6`} style={{ fontFamily: fontStack }}>
      <div className="pointer-events-none fixed inset-0 -z-10 dark:hidden" style={{ background: lightAmbient }} />
      <div className="pointer-events-none fixed inset-0 -z-10 hidden dark:block" style={{ background: darkAmbient }} />
      <div className="mx-auto mb-8 flex w-full max-w-5xl items-start justify-between gap-4">
        <div>
          <h1 className={`text-2xl font-bold tracking-tight ${ink}`}>Gift code email preview</h1>
          <p className={`mt-1 max-w-2xl text-sm ${body}`}>
            Made-up data. Nothing here talks to Stripe, sends email or saves anything.
            Subject line: “{email.subject}”. The orange button goes straight to
            Create your account with the code remembered.
          </p>
        </div>
        <ThemeToggleV2 />
      </div>

      <div className="mx-auto w-full max-w-5xl">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_375px]">
          <div>
            <Label>On a computer</Label>
            <iframe
              title="Gift email, desktop" sandbox="" srcDoc={email.html}
              className="h-[820px] w-full rounded-2xl border border-[#ece4d8] bg-white dark:border-white/[0.12]"
            />
          </div>
          <div>
            <Label>On a phone</Label>
            <iframe
              title="Gift email, phone" sandbox="" srcDoc={email.html}
              className="h-[820px] w-full max-w-[375px] rounded-2xl border border-[#ece4d8] bg-white dark:border-white/[0.12]"
            />
          </div>
        </div>
        <div className="mt-8">
          <Label>Plain-text version (for mail programs that block HTML)</Label>
          <pre className={`whitespace-pre-wrap rounded-2xl border border-[#ece4d8] bg-white p-5 text-sm dark:border-white/[0.12] dark:bg-white/[0.04] ${body}`}>
            {email.text}
          </pre>
        </div>
      </div>
    </div>
  );
}
