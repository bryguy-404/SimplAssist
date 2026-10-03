
import { SETUP_FEE_CENTS } from "@/lib/stripe/config";
import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Reveal, ThemeToggleV2 } from "@/lib/theme-v2/ui";
import { HeroDemo } from "@/lib/theme-v2/hero-demo";
import { GridFrame, GridSection, hairline, hairlineDivide } from "@/lib/theme-v2/grid";
import { isChatOnlyPublicLaunchEnabled } from "@/lib/billing/chatOnlyPublicLaunch.server";
import {
  accentText,
  body,
  btnPrimary,
  btnSecondary,
  darkAmbient,
  fontStack,
  ink,
  lightAmbient,
  navLink,
  navShell,
  pageShell,
} from "@/lib/theme-v2/theme";
import {
  features,
  heroStats,
  plansForPublicLaunch,
  splitColumns,
  steps,
} from "./content";
import { ShowcaseTabs } from "./showcase-tabs";

/**
 * /home-v2 — SHELVED preview homepage (kept on purpose, not deployed).
 * ElevenLabs-inspired "engineering blueprint" layout (hairline grid frame +
 * intersection dots) on the warm-matte theme-v2 system. The live homepage is
 * /home; this page 404s in production builds unless ENABLE_HOME_V2_PREVIEW=1
 * is set, and always works on the local dev server. Never indexed.
 *
 * Full design record (decisions, ElevenLabs decode, how to resume):
 * docs/home-v2-design.md
 *
 * SEO: this route must never be crawlable or appear in any future sitemap
 * or robots file — see docs/seo-notes.md before doing SEO work.
 */

// Gating in generateMetadata (as well as the component) makes the production
// 404 a true HTTP 404 — metadata resolves before streaming starts, so the
// status code can still be set (component-only gating yields a soft 404).
export const dynamic = "force-dynamic";
export const revalidate = 0;

export function generateMetadata(): Metadata {
  if (process.env.NODE_ENV === "production" && process.env.ENABLE_HOME_V2_PREVIEW !== "1") {
    notFound();
  }
  return {
    title: "SimplAssist — Home (v2 preview)",
    robots: { index: false, follow: false },
  };
}

/* ── Local pieces ── */

/** Small uppercase section label (the quiet ElevenLabs kicker). */
const kicker =
  "text-xs font-semibold tracking-[0.14em] uppercase text-stone-400 dark:text-[#8a8a8e]";

/**
 * Soft rounded content card — the ElevenLabs counterpart to the sharp
 * hairline structure: warm-gray, borderless-feeling objects floating inside
 * the grid. Radius is set per use (24px cards, 28px big panels).
 */
const softCard =
  "bg-[#f2eee5] border border-black/[0.03] dark:bg-white/[0.05] dark:border-white/[0.07]";

/** Small white circle chip for icons / step numbers inside soft cards. */
const chip =
  "grid place-items-center h-10 w-10 rounded-full bg-white dark:bg-white/[0.08]";

function Logo() {
  return (
    <>
      <Image src="/logo-dark.png" alt="SimplAssist" width={140} height={34} className="hidden dark:block h-8 w-auto object-contain" />
      <Image src="/logo-light.png" alt="SimplAssist" width={140} height={34} className="block dark:hidden h-8 w-auto object-contain" />
    </>
  );
}

function SectionIntro({
  label,
  title,
  subtitle,
  center = false,
}: {
  label: string;
  title: React.ReactNode;
  subtitle?: string;
  center?: boolean;
}) {
  return (
    <Reveal className={`mb-12 sm:mb-16 ${center ? "text-center" : ""}`}>
      <div className={`${kicker} mb-4`}>{label}</div>
      <h2 className={`text-[clamp(28px,3.6vw,44px)] leading-[1.06] tracking-[-0.035em] font-semibold ${ink} ${center ? "mx-auto max-w-[24ch]" : ""}`}>
        {title}
      </h2>
      {subtitle && (
        <p className={`${body} mt-4 max-w-[60ch] leading-[1.65] ${center ? "mx-auto" : ""}`}>
          {subtitle}
        </p>
      )}
    </Reveal>
  );
}

/**
 * Placeholder product panes for the platform panel — CSS skeletons of the
 * SimplAssist inbox and dashboard. Replace each with a real screenshot
 * (<Image fill className="object-cover object-left-top" />) when available.
 */
function PaneInbox() {
  return (
    <div aria-hidden className="flex h-full">
      <div className="w-[30%] shrink-0 border-r border-black/[0.06] dark:border-white/[0.08] p-3 space-y-2">
        <div className="h-2.5 w-2/3 rounded bg-black/[0.08] dark:bg-white/[0.12]" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="rounded-lg p-2 space-y-1.5 bg-black/[0.03] dark:bg-white/[0.04]">
            <div className="h-2 w-3/4 rounded bg-black/[0.07] dark:bg-white/[0.10]" />
            <div className="h-2 w-1/2 rounded bg-black/[0.05] dark:bg-white/[0.07]" />
          </div>
        ))}
      </div>
      <div className="flex-1 p-4 flex flex-col gap-2">
        <div className="h-2.5 w-1/3 rounded bg-black/[0.08] dark:bg-white/[0.12] mb-2" />
        <div className="h-6 w-3/5 rounded-[10px] rounded-bl-[4px] bg-black/[0.05] dark:bg-white/[0.07]" />
        <div className="h-6 w-2/5 self-end rounded-[10px] rounded-br-[4px] bg-[#ea580c]/80 dark:bg-[#ff914d]/70" />
        <div className="h-6 w-1/2 rounded-[10px] rounded-bl-[4px] bg-black/[0.05] dark:bg-white/[0.07]" />
        <div className="h-6 w-2/5 self-end rounded-[10px] rounded-br-[4px] bg-[#ea580c]/80 dark:bg-[#ff914d]/70" />
      </div>
    </div>
  );
}

function PaneDashboard() {
  return (
    <div aria-hidden className="h-full p-4 sm:p-5">
      <div className="h-3 w-1/4 rounded bg-black/[0.10] dark:bg-white/[0.14] mb-4" />
      <div className="grid grid-cols-3 gap-3 mb-4">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="rounded-xl border border-black/[0.06] dark:border-white/[0.08] p-3 space-y-2"
          >
            <div className="h-2 w-2/3 rounded bg-black/[0.06] dark:bg-white/[0.08]" />
            <div className="h-4 w-1/2 rounded bg-black/[0.10] dark:bg-white/[0.14]" />
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-black/[0.06] dark:border-white/[0.08] p-3 h-[45%]">
        <svg viewBox="0 0 300 80" className="h-full w-full" preserveAspectRatio="none">
          <path
            d="M0 60 C30 55 45 30 70 34 C95 38 110 58 140 52 C170 46 185 20 215 26 C245 32 265 44 300 36"
            fill="none"
            stroke="#ea580c"
            strokeOpacity=".55"
            strokeWidth="2"
            className="dark:stroke-[#ff914d]"
          />
        </svg>
      </div>
    </div>
  );
}

/* ── Page ── */

export default function HomeV2Page() {
  // Shelved preview: hard 404 in production builds (dev server always shows
  // it). Set ENABLE_HOME_V2_PREVIEW=1 at build time to expose it deliberately.
  if (process.env.NODE_ENV === "production" && process.env.ENABLE_HOME_V2_PREVIEW !== "1") {
    notFound();
  }

  const chatOnlyPublicLaunchEnabled = isChatOnlyPublicLaunchEnabled();
  const publicPlans = plansForPublicLaunch(chatOnlyPublicLaunchEnabled);

  return (
    <div className={`${pageShell} isolate`} style={{ fontFamily: fontStack }}>
      {/* Ambient backgrounds — no orbs here: blurred glows band against the
          1px hairlines, and the grid wants a calm field */}
      <div
        className="fixed inset-0 -z-10 pointer-events-none dark:hidden"
        style={{ background: lightAmbient }}
      />
      <div
        className="fixed inset-0 -z-10 pointer-events-none hidden dark:block"
        style={{ background: darkAmbient }}
      />

      {/* ── Navigation — same frosted pill as /home; must NOT sit inside a
          transformed parent or fixed breaks ── */}
      <nav className={`${navShell} flex items-center justify-between gap-3 sm:gap-4 px-3 py-2 sm:px-6 sm:py-3`}>
        <div className="flex items-center gap-3.5 min-w-0">
          <Link href="/home-v2">
            <Logo />
          </Link>
        </div>

        <div className="hidden md:flex items-center gap-6">
          <a href="#features" className={navLink}>
            Features
          </a>
          <a href="#how-it-works" className={navLink}>
            How It Works
          </a>
          <a href="#pricing" className={navLink}>
            Pricing
          </a>
        </div>

        <div className="flex items-center gap-3">
          <ThemeToggleV2 />
          <Link href="/login" className={`${btnSecondary} max-sm:hidden`}>
            Log In
          </Link>
          <Link href="/signup" className={btnPrimary}>
            Get Started
          </Link>
        </div>
      </nav>

      <main className="relative z-[1] px-0 sm:px-4 pt-[5.25rem] sm:pt-24 pb-16">
        <GridFrame>
          {/* ── 1. Hero — headline left, live demo right (like /home) ── */}
          <GridSection rule={false} dots={false} className="px-5 sm:px-10 lg:px-14 pt-10 sm:pt-14 pb-12 sm:pb-16">
            <div className="grid lg:grid-cols-[1.12fr_.88fr] gap-10 lg:gap-12 items-center">
              <Reveal priority>
                <h1 className={`text-[clamp(40px,5.5vw,70px)] font-semibold leading-[0.98] tracking-[-0.04em] mb-5 ${ink}`}>
                  Never miss a <span className={accentText}>customer</span> again.
                </h1>
                <p className={`${body} text-[clamp(16px,2vw,18px)] leading-[1.7] max-w-[560px] mb-7`}>
                  SimplAssist texts customers back when you miss a call, chats with
                  website visitors 24/7, and keeps every lead organized in one clean
                  dashboard.
                </p>
                <div className="flex gap-3 flex-wrap">
                  <Link href="/signup" className={btnPrimary}>
                    Get Started
                  </Link>
                  <a href="#how-it-works" className={btnSecondary}>
                    See How It Works
                  </a>
                </div>
              </Reveal>
              <Reveal priority delayMs={140}>
                <div className={`relative overflow-hidden p-5 rounded-[24px] ${softCard}`}>
                  {/* Ambient corner tint (dark only) */}
                  <div
                    className="absolute pointer-events-none hidden dark:block"
                    style={{
                      bottom: "-30%",
                      right: "-15%",
                      width: 240,
                      height: 240,
                      borderRadius: "50%",
                      background: "radial-gradient(circle, rgba(255,145,77,.32), transparent 65%)",
                      filter: "blur(18px)",
                    }}
                  />
                  <HeroDemo />
                </div>
              </Reveal>
            </div>
          </GridSection>

          {/* ── 2. Stat band — hairline cells running rail to rail ── */}
          <GridSection className="px-0 py-0">
            <div className={`grid sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x ${hairlineDivide}`}>
              {heroStats.map((item) => (
                <div key={item.stat} className="px-5 sm:px-8 py-5">
                  <strong className={`block text-[22px] font-semibold ${ink}`}>{item.stat}</strong>
                  <span className={`text-sm ${body}`}>{item.label}</span>
                </div>
              ))}
            </div>
          </GridSection>

          {/* ── 3. Platform — two products in one panel (ElevenLabs "two
              platforms" pattern): headline, two labeled columns, then a big
              soft panel with two overlapping product panes. Hovering a pane
              brings it forward; the other dims behind it. ── */}
          <GridSection id="platform">
            <Reveal>
              <div className={`${kicker} mb-4`}>The platform</div>
              <h2 className={`text-[clamp(28px,3.6vw,44px)] leading-[1.06] tracking-[-0.035em] font-semibold ${ink} max-w-[22ch]`}>
                One assistant, two front doors.
              </h2>
              <div className="mt-8 grid sm:grid-cols-2 gap-6 max-w-[680px]">
                {splitColumns.map((col) => (
                  <div key={col.title}>
                    <h3 className={`text-[15px] font-semibold ${ink} mb-1.5`}>{col.title}</h3>
                    <p className={`${body} text-sm leading-[1.65]`}>{col.description}</p>
                  </div>
                ))}
              </div>
            </Reveal>

            <Reveal delayMs={120}>
              <div className={`mt-10 sm:mt-12 rounded-[28px] ${softCard} overflow-hidden px-4 sm:px-10 pt-4 sm:pt-10`}>
                {/* ≥ sm: overlapping panes, bottoms flush with the panel edge.
                    Swap each pane's skeleton for a real dashboard screenshot
                    (<Image fill className="object-cover object-left-top" />)
                    when screenshots exist. */}
                <div className="group hidden sm:flex items-end">
                  <div
                    className={`relative z-0 hover:z-20 w-[52%] h-[300px] lg:h-[400px] shrink-0 rounded-t-2xl overflow-hidden border border-b-0 ${hairline} bg-white dark:bg-[#101010] shadow-[0_12px_40px_-12px_rgba(28,25,23,0.18)] transition-[opacity,transform] duration-300 group-hover:opacity-60 hover:!opacity-100 hover:-translate-y-1.5`}
                  >
                    <PaneInbox />
                  </div>
                  <div
                    className={`relative z-10 w-[59%] -ml-[11%] h-[340px] lg:h-[450px] shrink-0 rounded-t-2xl overflow-hidden border border-b-0 ${hairline} bg-white dark:bg-[#101010] shadow-[0_12px_40px_-12px_rgba(28,25,23,0.22)] transition-[opacity,transform] duration-300 group-hover:opacity-60 hover:!opacity-100 hover:-translate-y-1.5`}
                  >
                    <PaneDashboard />
                  </div>
                </div>

                {/* < sm: stacked, second pane bleeds into the panel edge */}
                <div className="sm:hidden flex flex-col gap-4">
                  <div className={`h-[220px] rounded-2xl overflow-hidden border ${hairline} bg-white dark:bg-[#101010]`}>
                    <PaneInbox />
                  </div>
                  <div className={`h-[220px] rounded-t-2xl overflow-hidden border border-b-0 ${hairline} bg-white dark:bg-[#101010]`}>
                    <PaneDashboard />
                  </div>
                </div>
              </div>
            </Reveal>
          </GridSection>

          {/* ── 5. Tabbed showcase ── */}
          <GridSection id="showcase">
            <SectionIntro
              center
              label="In the field"
              title={
                <>
                  Watch a missed call become a <span className={accentText}>booked job</span>.
                </>
              }
              subtitle="Real workflows from the trades SimplAssist serves every day."
            />
            <ShowcaseTabs />
          </GridSection>

          {/* ── 6. Features — bordered cells, structure from lines not shadows ── */}
          <GridSection id="features">
            <SectionIntro
              label="Features"
              title={
                <>
                  Built for small businesses that want a{" "}
                  <span className={accentText}>bigger presence</span>.
                </>
              }
              subtitle="Give customers a fast, professional experience without hiring a full-time front desk team."
            />
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {features.map((feature, i) => (
                <Reveal key={feature.title} delayMs={i * 60} className="h-full">
                  <div
                    className={`h-full p-7 sm:p-8 rounded-[24px] ${softCard} hover:bg-[#eee8dc] dark:hover:bg-white/[0.07] transition-colors`}
                  >
                    <div className={`${chip} mb-5`}>
                      <feature.icon className="h-[18px] w-[18px] text-[#ea580c] dark:text-[#ff914d]" />
                    </div>
                    <h3 className={`text-lg font-semibold ${ink} mb-2`}>{feature.title}</h3>
                    <p className={`${body} text-[15px] leading-[1.7]`}>{feature.description}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </GridSection>

          {/* ── 7. How it works ── */}
          <GridSection id="how-it-works">
            <SectionIntro
              label="How it works"
              title={
                <>
                  Three simple steps to keep every <span className={accentText}>lead</span>.
                </>
              }
              subtitle="Go from sign-up to live AI assistant in just a few guided steps."
            />
            <div className="grid md:grid-cols-3 gap-4">
              {steps.map((step, i) => (
                <Reveal key={step.title} delayMs={i * 90} className="h-full">
                  <div className={`h-full p-7 sm:p-8 rounded-[24px] ${softCard}`}>
                    <div className={`${chip} mb-5 text-lg font-bold text-[#ea580c] dark:text-[#ff914d]`}>
                      {i + 1}
                    </div>
                    <h3 className={`text-lg font-semibold ${ink} mb-2`}>{step.title}</h3>
                    <p className={`${body} text-[15px] leading-[1.7]`}>{step.description}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </GridSection>

          {/* ── 8. Pricing — flat hairline columns ── */}
          <GridSection id="pricing">
            <SectionIntro
              label="Pricing"
              title={
                <>
                  Simple plans that grow with your <span className={accentText}>business</span>.
                </>
              }
              subtitle={
                chatOnlyPublicLaunchEnabled
                  ? `No contracts. Chat Only has no setup fee; paid SMS activation includes a one-time $${SETUP_FEE_CENTS / 100} setup fee.`
                  : `No contracts. Paid SMS activation includes a one-time $${SETUP_FEE_CENTS / 100} setup fee.`
              }
            />
            <div
              className={`grid border-t ${hairline} divide-y ${
                chatOnlyPublicLaunchEnabled
                  ? "lg:grid-cols-4 lg:divide-y-0 lg:divide-x"
                  : "md:grid-cols-3 md:divide-y-0 md:divide-x"
              } ${hairlineDivide}`}
            >
              {publicPlans.map((plan) => (
                <div
                  key={plan.name}
                  className={`relative p-7 sm:p-9 flex flex-col ${
                    plan.highlighted
                      ? "-mt-px border-t-2 border-t-[#ea580c] dark:border-t-[#ff914d] bg-[#fdf6ee] dark:bg-white/[0.03]"
                      : ""
                  }`}
                >
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className={`text-xl font-semibold ${ink}`}>{plan.name}</h3>
                    {plan.highlighted && (
                      <span className="px-3 py-1 rounded-full text-[11px] font-extrabold bg-[#ea580c] text-white dark:bg-[#ff914d] dark:text-[#16100b]">
                        Most Popular
                      </span>
                    )}
                  </div>
                  <p className={`${body} text-[15px] leading-[1.65] mb-6`}>{plan.description}</p>
                  <div className={`text-[44px] font-semibold tracking-[-0.04em] mb-5 ${ink}`}>
                    {plan.price}
                    <small className="text-base font-normal text-stone-400 dark:text-[#bdbdbf]">/mo</small>
                  </div>
                  <ul className="space-y-3 mb-7 flex-1">
                    {plan.features.map((feature) => (
                      <li
                        key={feature}
                        className="flex items-start gap-2.5 text-[15px] text-stone-700 dark:text-[#efefef] leading-relaxed"
                      >
                        <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#ea580c] dark:bg-[#ff914d]" />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                  <Link
                    href="/signup"
                    className={plan.highlighted ? `${btnPrimary} w-full` : `${btnSecondary} w-full`}
                  >
                    Get Started
                  </Link>
                </div>
              ))}
            </div>
          </GridSection>

          {/* ── 9. CTA — one message inside a big soft panel ── */}
          <GridSection className="px-5 sm:px-10 lg:px-14 py-16 sm:py-24">
            <Reveal>
              <div className={`rounded-[28px] ${softCard} px-6 sm:px-10 py-16 sm:py-24 text-center`}>
                <h2 className={`text-balance text-[clamp(32px,4.5vw,56px)] font-semibold leading-[1.04] tracking-[-0.04em] mb-4 mx-auto max-w-[720px] ${ink}`}>
                  Your voicemail isn&apos;t closing deals.
                </h2>
                <p className={`${body} text-[17px] leading-[1.7] mb-8 mx-auto max-w-[560px]`}>
                  SimplAssist texts customers back before they&apos;ve dialed your competitor.
                </p>
                <div className="flex gap-3 justify-center flex-wrap">
                  <Link href="/signup" className={btnPrimary}>
                    Get Started
                  </Link>
                  <a href="#pricing" className={btnSecondary}>
                    See Pricing
                  </a>
                </div>
              </div>
            </Reveal>
          </GridSection>

          {/* ── 10. Footer ── */}
          <GridSection className="px-5 sm:px-10 lg:px-14 py-10">
            <footer className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3.5">
                <Image
                  src="/logo-dark.png"
                  alt="SimplAssist"
                  width={88}
                  height={22}
                  className="hidden dark:block h-[22px] w-auto object-contain"
                />
                <Image
                  src="/logo-light.png"
                  alt="SimplAssist"
                  width={88}
                  height={22}
                  className="block dark:hidden h-[22px] w-auto object-contain"
                />
                <small className="text-stone-500 dark:text-[#bdbdbf] block mt-1">
                  &copy; {new Date().getFullYear()} SimplAssist, a product of Arambula Ventures LLC.
                </small>
              </div>
              <div className="flex gap-5 flex-wrap text-sm">
                <a href="#features" className={navLink}>Features</a>
                <a href="#pricing" className={navLink}>Pricing</a>
                <Link href="/support" className={navLink}>Support</Link>
                <Link href="/privacy" className={navLink}>Privacy</Link>
                <Link href="/terms" className={navLink}>Terms</Link>
                <Link href="/login" className={navLink}>Log In</Link>
              </div>
            </footer>
          </GridSection>
        </GridFrame>
      </main>
    </div>
  );
}
