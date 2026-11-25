import type { Metadata } from "next";
import { GiftCard } from "@/components/gift/GiftCard";
import { GiftPageShell } from "@/components/gift/GiftPageShell";
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
 * /demo/gift — an isolated review page for the gift code feature: the coupon
 * email and the coupon page in each of its states. Dev-only. Everything here
 * is made up: no Stripe lookup, no email, no database, no cookie. The Copy
 * button really copies; the start button goes nowhere.
 */

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  assertDemoPagesEnabled();
  return {
    title: "Gift code preview (dev only)",
    robots: { index: false, follow: false },
  };
}

const FREE_MONTH: GiftOffer = { kind: "percent", percentOff: 100, duration: "once", months: null };
const SAMPLE_CODE = "ROSA-FREEMONTH";
const SAMPLE_EXPIRY = "2027-01-31T23:59:59.000Z";

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="mx-auto w-full max-w-5xl">
      <h2 className={`text-lg font-bold ${ink}`}>{title}</h2>
      <p className={`mt-1 max-w-2xl text-sm ${body}`}>{note}</p>
      <div className="mt-5">{children}</div>
    </section>
  );
}

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
    giftUrl: `https://simplassist.com/gift/${SAMPLE_CODE}`,
  });

  return (
    <div className={`${pageShell} isolate p-6`} style={{ fontFamily: fontStack }}>
      <div className="pointer-events-none fixed inset-0 -z-10 dark:hidden" style={{ background: lightAmbient }} />
      <div className="pointer-events-none fixed inset-0 -z-10 hidden dark:block" style={{ background: darkAmbient }} />
      <div className="mx-auto mb-6 flex w-full max-w-5xl items-start justify-between gap-4">
        <div>
          <h1 className={`text-2xl font-bold tracking-tight ${ink}`}>Gift code preview</h1>
          <p className={`mt-1 max-w-2xl text-sm ${body}`}>
            Made-up data throughout. Nothing here talks to Stripe, sends email or saves anything.
          </p>
        </div>
        <ThemeToggleV2 />
      </div>

      <div className="space-y-14">
        <Section
          title="1. The coupon page"
          note="What someone sees at simplassist.com/gift/their-code. Try the Copy button: it really copies, and the dot celebrates."
        >
          <div className="grid gap-8 lg:grid-cols-2">
            <div>
              <Label>A code that works</Label>
              <GiftPageShell embedded>
                <GiftCard
                  state={{ kind: "available", code: SAMPLE_CODE, offer: FREE_MONTH, expiresAt: SAMPLE_EXPIRY }}
                  startHref="#demo-start"
                />
              </GiftPageShell>
            </div>
            <div className="space-y-8">
              <div>
                <Label>Unknown, expired or used-up code</Label>
                <GiftPageShell embedded>
                  <GiftCard state={{ kind: "unavailable" }} startHref="#demo-start" />
                </GiftPageShell>
              </div>
              <div>
                <Label>Stripe could not be reached</Label>
                <GiftPageShell embedded>
                  <GiftCard state={{ kind: "error" }} startHref="#demo-start" />
                </GiftPageShell>
              </div>
            </div>
          </div>
        </Section>

        <Section
          title="2. The email"
          note={`Subject line: “${email.subject}”. This is the exact HTML the admin page sends, shown at computer and phone widths. A real inbox may render it a little differently.`}
        >
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
          <div className="mt-6">
            <Label>Plain-text version (for mail programs that block HTML)</Label>
            <pre className={`whitespace-pre-wrap rounded-2xl border border-[#ece4d8] bg-white p-5 text-sm dark:border-white/[0.12] dark:bg-white/[0.04] ${body}`}>
              {email.text}
            </pre>
          </div>
        </Section>
      </div>
    </div>
  );
}
