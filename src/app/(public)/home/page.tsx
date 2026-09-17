import Link from "next/link";
import Image from "next/image";
import {
  Phone,
  MessageCircle,
  Inbox,
  Target,
  Star,
  ArrowUpRight,
  ChevronDown,
  Check,
} from "lucide-react";
import { Reveal, ThemeToggleV2 } from "@/lib/theme-v2/ui";
import { REVEAL_NO_SCRIPT_CSS } from "@/lib/theme-v2/reveal";
import { HeroDemo } from "@/lib/theme-v2/hero-demo";
import { CtaRace } from "@/lib/theme-v2/cta-race";
import { FullSuiteWaitlistButton } from "@/components/waitlist/FullSuiteWaitlistButton";
import { isChatOnlyPublicLaunchEnabled } from "@/lib/billing/chatOnlyPublicLaunch.server";
import { isPlanAvailable } from "@/lib/billing/planAvailability";
import { SETUP_FEE_CENTS, SUBSCRIPTION_PLANS } from "@/lib/stripe/config";
import { FULL_SUITE_DESCRIPTION, FULL_SUITE_HIGHLIGHTS, FULL_SUITE_USAGE_NOTE } from "@/lib/billing/fullSuitePresentation";
import { OpenChatButton } from "./open-chat-button";
import { HomepageChatWidget } from "./homepage-chat-widget";
import cardStyles from "./card-interactions.module.css";
import {
  getHomepageJsonLd,
  getHomepageSeoContent,
  type HomepageFaq,
  serializeJsonLd,
} from "./seo";
import {
  accentText,
  body,
  btnPrimary,
  btnPrimaryWide,
  btnSecondary,
  card,
  darkAmbient,
  fontStack,
  ink,
  inlineLink,
  lightAmbient,
  navLink,
  navShell,
  pageShell,
  tile,
} from "@/lib/theme-v2/theme";

/* ── Data ── */

const features = [
  {
    icon: Phone,
    title: "Automatic Missed-Call Texting",
    description:
      "Automatically reply when you can't answer the phone so potential customers never hear silence.",
  },
  {
    icon: MessageCircle,
    title: "Website Chat Widget",
    description:
      "Turn your site into a lead-capturing assistant that answers questions around the clock.",
  },
  {
    icon: Inbox,
    title: "Unified Inbox",
    description:
      "Keep SMS and website conversations together so you always know where each lead came from.",
  },
  {
    icon: Target,
    title: "Smart Contact Tracking",
    description:
      "Calls, chats, and follow-ups are organized automatically for a cleaner sales workflow.",
  },
  {
    icon: Star,
    title: "Custom AI Personality",
    description:
      "Set tone, greetings, and guardrails so your assistant sounds like your brand, not a generic bot.",
  },
  {
    icon: ArrowUpRight,
    title: "Lead Prioritization",
    description:
      "See your warmest prospects first so you know where to focus your time when you're back online.",
  },
];

const trustedTechnologies = [
  {
    name: "Stripe",
    logo: "/marketing/technology/stripe.svg",
  },
  {
    name: "Google Calendar",
    logo: "/marketing/technology/google-calendar.svg",
  },
  {
    name: "Anthropic",
    logo: "/marketing/technology/claude.svg",
  },
  {
    name: "Cloudflare",
    logo: "/marketing/technology/cloudflare.svg",
  },
] as const;

/** The two dashboard views shown in the "how it works" panel — real product
 *  screenshots (public/marketing/pane-*.png), cropped from the /demo pages.
 *  `aspect` matches each crop's ratio exactly so nothing gets clipped. */
const dashboardViews = [
  {
    title: "Messages & leads",
    description:
      "Every SMS and web-chat conversation lands in one inbox — with each lead tracked from first contact to booked.",
    base: "pane-messages",
    aspect: "aspect-video",
    alt: "SimplAssist conversations inbox — a missed call turned into a booked water heater repair",
  },
  {
    title: "Calendar & bookings",
    description:
      "Appointments your assistant books land straight on your calendar, synced with Google Calendar.",
    base: "pane-calendar",
    aspect: "aspect-[15/8]",
    alt: "SimplAssist calendar — a month full of AI-booked appointments",
  },
];

const smsActivationFeeLabel = `$${SETUP_FEE_CENTS / 100} one-time SMS activation fee`;
const formattedPlanPrice = (planKey: keyof typeof SUBSCRIPTION_PLANS) =>
  `$${SUBSCRIPTION_PLANS[planKey].price}`;
const formattedSmsParts = (planKey: keyof typeof SUBSCRIPTION_PLANS) =>
  SUBSCRIPTION_PLANS[planKey].includedSmsParts.toLocaleString("en-US");
const formattedChatOnlyAiReplies =
  SUBSCRIPTION_PLANS.chat_only.includedAiReplies?.toLocaleString("en-US") ??
  "Not defined";

const chatOnlyPlan = {
  planKey: "chat_only" as const,
  name: "Chat Only",
  price: formattedPlanPrice("chat_only"),
  category: "Website chat",
  billingNote: "No setup fee",
  description:
    "An AI website receptionist for teams that want web chat without texting.",
  highlights: [
    "Website AI chat widget",
    `${formattedChatOnlyAiReplies} completed AI replies/month`,
    "Web-chat lead capture + conversation inbox",
    "AI customization + Google Calendar booking",
    "No phone, texting, or setup fee",
  ],
  features: [
    "Website chat widget",
    `${formattedChatOnlyAiReplies} completed AI replies/month`,
    "Custom widget branding",
    "Web-chat lead capture",
    "Contact and conversation inbox",
    "AI answer, tone, FAQ, and service customization",
    "Google Calendar connection",
    "AI appointment scheduling",
    "No phone number, SMS, MMS, or carrier activation",
    "No setup or SMS activation fee",
  ],
  highlighted: false,
};

const existingPlans = [
  {
    planKey: "sms_only" as const,
    name: "SMS Only",
    price: formattedPlanPrice("sms_only"),
    category: "Texting",
    billingNote: smsActivationFeeLabel,
    description: "Missed-call texting for small teams that want fast coverage.",
    highlights: [
      "Local SimplAssist number",
      "Automatic missed-call text-back",
      "Manual SMS inbox + replies",
      "Contact + conversation management",
      `${formattedSmsParts("sms_only")} included SMS parts/month`,
    ],
    features: [
      "One local SimplAssist number",
      "Manual SMS inbox and replies",
      "Automatic missed-call text",
      `${formattedSmsParts("sms_only")} included SMS parts/month`,
      "Contact management",
      "Conversation inbox",
      smsActivationFeeLabel,
    ],
    highlighted: false,
  },
  {
    planKey: "sms_and_chat" as const,
    name: "SMS + Web Chat",
    price: formattedPlanPrice("sms_and_chat"),
    category: "Texting + web chat",
    billingNote: smsActivationFeeLabel,
    description: "Capture leads from calls and your website, then turn them into booked appointments.",
    highlights: [
      "Everything in SMS Only, plus",
      "Website chat widget + lead capture",
      "Full AI SMS conversations + customization",
      "Google Calendar booking",
      `${formattedSmsParts("sms_and_chat")} included SMS parts/month`,
    ],
    features: [
      "Everything in SMS Only",
      "Website chat widget",
      "Custom widget branding",
      "Web chat lead capture",
      "Full AI SMS conversations",
      "Customize your AI's answers and tone",
      "Google Calendar connection",
      "AI appointment scheduling",
      `${formattedSmsParts("sms_and_chat")} included SMS parts/month`,
    ],
    highlighted: true,
  },
  {
    planKey: "full" as const,
    name: "Full Suite",
    price: formattedPlanPrice("full"),
    category: "Text, chat + voice",
    billingNote: smsActivationFeeLabel,
    description: FULL_SUITE_DESCRIPTION,
    highlights: FULL_SUITE_HIGHLIGHTS,
    features: SUBSCRIPTION_PLANS.full.features,
    highlighted: false,
  },
];

type HomepagePlan = typeof chatOnlyPlan | (typeof existingPlans)[number];
type HomepagePlanKey = HomepagePlan["planKey"];
type PlanComparisonValue = boolean | string;

const comparisonGroups: ReadonlyArray<{
  title: string;
  rows: ReadonlyArray<{
    feature: string;
    values: Record<HomepagePlanKey, PlanComparisonValue>;
  }>;
}> = [
  {
    title: "Price & usage",
    rows: [
      {
        feature: "Includes everything in",
        values: {
          chat_only: false,
          sms_only: false,
          sms_and_chat: "SMS Only",
          full: "SMS + Web Chat",
        },
      },
      {
        feature: "Completed AI replies/month",
        values: {
          chat_only: formattedChatOnlyAiReplies,
          sms_only: "Not included",
          sms_and_chat: "No set cap",
          full: "No set cap",
        },
      },
      {
        feature: "Included SMS parts/month",
        values: {
          chat_only: formattedSmsParts("chat_only"),
          sms_only: formattedSmsParts("sms_only"),
          sms_and_chat: formattedSmsParts("sms_and_chat"),
          full: formattedSmsParts("full"),
        },
      },
      {
        feature: "Setup / SMS activation fee",
        values: {
          chat_only: "None",
          sms_only: smsActivationFeeLabel,
          sms_and_chat: smsActivationFeeLabel,
          full: smsActivationFeeLabel,
        },
      },
    ],
  },
  {
    title: "Channels",
    rows: [
      {
        feature: "One local SimplAssist number",
        values: {
          chat_only: false,
          sms_only: true,
          sms_and_chat: true,
          full: true,
        },
      },
      {
        feature: "Manual SMS inbox and replies",
        values: {
          chat_only: false,
          sms_only: true,
          sms_and_chat: true,
          full: true,
        },
      },
      {
        feature: "Automatic missed-call text",
        values: {
          chat_only: false,
          sms_only: true,
          sms_and_chat: true,
          full: true,
        },
      },
      {
        feature: "Website chat widget",
        values: {
          chat_only: true,
          sms_only: false,
          sms_and_chat: true,
          full: true,
        },
      },
      {
        feature: "Custom widget branding",
        values: {
          chat_only: true,
          sms_only: false,
          sms_and_chat: true,
          full: true,
        },
      },
      {
        feature: "Web-chat lead capture",
        values: {
          chat_only: true,
          sms_only: false,
          sms_and_chat: true,
          full: true,
        },
      },
      {
        feature: "Phone number / SMS carrier activation",
        values: {
          chat_only: "Not included",
          sms_only: true,
          sms_and_chat: true,
          full: true,
        },
      },
      {
        feature: "MMS availability",
        values: {
          chat_only: "Not included",
          sms_only: "Not defined",
          sms_and_chat: "Not defined",
          full: "Not defined",
        },
      },
    ],
  },
  {
    title: "AI, leads & inbox",
    rows: [
      {
        feature: "Contact management",
        values: {
          chat_only: true,
          sms_only: true,
          sms_and_chat: true,
          full: true,
        },
      },
      {
        feature: "Conversation inbox",
        values: {
          chat_only: true,
          sms_only: true,
          sms_and_chat: true,
          full: true,
        },
      },
      {
        feature: "Full AI SMS conversations",
        values: {
          chat_only: false,
          sms_only: false,
          sms_and_chat: true,
          full: true,
        },
      },
      {
        feature: "AI customization",
        values: {
          chat_only: "Answers, tone, FAQs & services",
          sms_only: false,
          sms_and_chat: "Answers, tone, FAQs & services",
          full: "Answers, tone, FAQs & services",
        },
      },
    ],
  },
  {
    title: "Calendar & booking",
    rows: [
      {
        feature: "Google Calendar connection",
        values: {
          chat_only: true,
          sms_only: false,
          sms_and_chat: true,
          full: true,
        },
      },
      {
        feature: "AI appointment scheduling",
        values: {
          chat_only: true,
          sms_only: false,
          sms_and_chat: true,
          full: true,
        },
      },
    ],
  },
  {
    title: "Full Suite voice & controls",
    rows: [
      {
        feature: "Custom AI rules and guardrails",
        values: {
          chat_only: false,
          sms_only: false,
          sms_and_chat: false,
          full: true,
        },
      },
      {
        feature: "AI voice answering in English",
        values: {
          chat_only: false,
          sms_only: false,
          sms_and_chat: false,
          full: true,
        },
      },
      {
        feature: "Included voice minutes/billing month",
        values: {
          chat_only: false,
          sms_only: false,
          sms_and_chat: false,
          full: String(SUBSCRIPTION_PLANS.full.includedVoiceMinutes),
        },
      },
      {
        feature: "Voice contact capture and signup texts",
        values: {
          chat_only: false,
          sms_only: false,
          sms_and_chat: false,
          full: true,
        },
      },
      {
        feature: "Voice calendar booking",
        values: {
          chat_only: false,
          sms_only: false,
          sms_and_chat: false,
          full: true,
        },
      },
      {
        feature: "Voice transcripts and recordings",
        values: {
          chat_only: false,
          sms_only: false,
          sms_and_chat: false,
          full: true,
        },
      },
    ],
  },
];

const heroStats = [
  { stat: "24/7", label: "Lead response coverage for missed calls and website visitors" },
  { stat: "1 inbox", label: "SMS and web chat conversations in one place" },
  { stat: "Fast setup", label: "Built for small teams that want results without complexity" },
];

/* ── Local pieces ── */

function HeroStatCards() {
  return (
    <>
      {heroStats.map((item) => (
        <div key={item.stat} className={`p-5 ${card} ${cardStyles.card}`}>
          <strong className={`block text-[22px] mb-2 ${ink}`}>{item.stat}</strong>
          <span className={`text-sm ${body}`}>{item.label}</span>
        </div>
      ))}
    </>
  );
}

function Logo() {
  return (
    <>
      <Image src="/logo-dark.png" alt="SimplAssist" width={140} height={34} className="hidden dark:block h-8 w-auto object-contain" />
      <Image src="/logo-light.png" alt="SimplAssist" width={140} height={34} className="block dark:hidden h-8 w-auto object-contain" />
    </>
  );
}

function SectionHeader({
  id,
  title,
  subtitle,
  subtitleClassName = "",
}: {
  id?: string;
  title: React.ReactNode;
  subtitle: string;
  subtitleClassName?: string;
}) {
  return (
    <Reveal className="mb-12 sm:mb-16">
      <h2 id={id} className={`text-[clamp(28px,4vw,46px)] leading-[1.04] tracking-[-0.04em] font-extrabold ${ink}`}>
        {title}
      </h2>
      <p className={`${body} mt-4 max-w-[60ch] leading-[1.65] ${subtitleClassName}`}>
        {subtitle}
      </p>
    </Reveal>
  );
}

/**
 * Paired light/dark product screenshot filling its pane (the homepage swaps
 * them with the same hidden/dark:block pattern the logo uses). Parent must be
 * `relative`. Screenshots are 16:9 crops taken from the /demo pages.
 */
function PaneShot({ base, alt, sizes }: { base: string; alt: string; sizes: string }) {
  return (
    <>
      <Image
        src={`/marketing/${base}-light.png`}
        alt={alt}
        fill
        sizes={sizes}
        className="object-cover object-left-top block dark:hidden"
      />
      <Image
        src={`/marketing/${base}-dark.png`}
        alt={alt}
        fill
        sizes={sizes}
        className="object-cover object-left-top hidden dark:block"
      />
    </>
  );
}

/** Frame shared by both dashboard panes. */
const paneFrame =
  "rounded-t-2xl overflow-hidden border border-b-0 border-[#ece4d8] dark:border-white/[0.10] bg-white dark:bg-[#101010]";

function FaqAnswerText({
  faq,
}: {
  faq: HomepageFaq;
}) {
  if (!faq.answerLink) return faq.answer;

  const linkStart = faq.answer.indexOf(faq.answerLink.text);
  if (linkStart < 0) return faq.answer;

  return (
    <>
      {faq.answer.slice(0, linkStart)}
      <Link
        href={faq.answerLink.href}
        className={`${inlineLink} underline-offset-2 hover:underline`}
      >
        {faq.answerLink.text}
      </Link>
      {faq.answer.slice(linkStart + faq.answerLink.text.length)}
    </>
  );
}

function PlanComparisonCell({ value }: { value: PlanComparisonValue }) {
  if (value === true) {
    return (
      <span className="inline-flex items-center justify-center text-[#c2410c] dark:text-[#ff914d]">
        <Check aria-hidden="true" className="h-5 w-5" strokeWidth={2.5} />
        <span className="sr-only">Included</span>
      </span>
    );
  }

  if (value === false) {
    return (
      <span className="text-stone-400 dark:text-[#77777d]">
        <span aria-hidden="true">&mdash;</span>
        <span className="sr-only">Not included</span>
      </span>
    );
  }

  if (value === "—") {
    return (
      <span className="text-stone-400 dark:text-[#77777d]">
        <span aria-hidden="true">&mdash;</span>
        <span className="sr-only">Not specified</span>
      </span>
    );
  }

  return <span>{value}</span>;
}

/* ── Page ── */

export default function HomePage() {
  const publicChatOnlyAvailable = isChatOnlyPublicLaunchEnabled();
  const seoContent = getHomepageSeoContent(publicChatOnlyAvailable);
  const comparisonPlans = publicChatOnlyAvailable
    ? [chatOnlyPlan, ...existingPlans]
    : existingPlans;
  const pricingCardPlans = publicChatOnlyAvailable
    ? [chatOnlyPlan, existingPlans[1], existingPlans[2]]
    : existingPlans;

  return (
    <div className={`${pageShell} isolate`} style={{ fontFamily: fontStack }}>
      <noscript>
        <style>{REVEAL_NO_SCRIPT_CSS}</style>
      </noscript>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: serializeJsonLd(
            getHomepageJsonLd(publicChatOnlyAvailable),
          ),
        }}
      />
      <HomepageChatWidget />

      {/* Ambient backgrounds — light gets its own warm treatment */}
      <div
        className="fixed inset-0 -z-10 pointer-events-none dark:hidden"
        style={{ background: lightAmbient }}
      />
      <div
        className="fixed inset-0 -z-10 pointer-events-none hidden dark:block"
        style={{ background: darkAmbient }}
      />

      {/* Orbs */}
      <div
        className="fixed rounded-full pointer-events-none z-0 opacity-20 dark:opacity-45"
        style={{
          width: 640,
          height: 640,
          background: "rgba(255,145,77,.18)",
          top: -70,
          right: -210,
          filter: "blur(64px)",
        }}
      />
      <div
        className="fixed rounded-full pointer-events-none z-0 opacity-15 dark:opacity-45"
        style={{
          width: 260,
          height: 260,
          background: "rgba(255,145,77,.14)",
          left: -80,
          top: "40%",
          filter: "blur(64px)",
        }}
      />

      {/* ── Navigation — frosted pill; must NOT be inside a transformed parent or fixed breaks ── */}
      <nav className={`${navShell} flex items-center justify-between gap-3 sm:gap-4 px-3 py-2 sm:px-6 sm:py-3`}>
        <div className="flex items-center gap-3.5 min-w-0">
          <Link href="/">
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

      {/* ── Container ── */}
      <div className="relative z-[1] w-[min(calc(100%-32px),1200px)] mx-auto pt-[5.25rem] sm:pt-24">
        {/* ── Hero ── */}
        <section className="grid lg:grid-cols-[1.12fr_.88fr] gap-7 items-center pt-4 pb-10">
          <Reveal priority>
            <div className="flex flex-col items-start">
              <h1 className={`text-[clamp(40px,7vw,76px)] font-extrabold leading-[0.96] tracking-[-0.05em] mb-5 mt-12 sm:mt-0 ${ink}`}>
                Never miss a{" "}
                <br className="hidden sm:block" />
                <span className={accentText}>customer</span> again.
              </h1>

              <p className={`text-[clamp(17px,2.3vw,20px)] leading-[1.7] ${body} max-w-[680px] mb-7`}>
                SimplAssist texts customers back when you miss a call, chats with website
                visitors 24/7, and keeps every lead organized in one clean dashboard.
              </p>

              {/* CTA buttons — flat, matte, no glow */}
              <div className="flex gap-3.5 flex-wrap mb-7">
                <Link href="/signup" className={btnPrimary}>
                  Get Started
                </Link>
                <a href="#how-it-works" className={btnSecondary}>
                  See How It Works
                </a>
              </div>

              {/* Mini stat cards — desktop: in-column under the CTAs */}
              <div className="hidden lg:grid lg:grid-cols-3 gap-3.5 mt-7 w-full">
                <HeroStatCards />
              </div>
            </div>
          </Reveal>

          {/* Sculpted device — animated conversation demo (all widths) */}
          <Reveal priority delayMs={140}>
            <HeroDemo />
          </Reveal>

          {/* Mini stat cards — mobile/tablet: after the demo */}
          <Reveal className="lg:hidden">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 w-full">
              <HeroStatCards />
            </div>
          </Reveal>
        </section>

        {/* ── Definition ── */}
        <section
          id="what-is-simplassist"
          aria-labelledby="what-is-simplassist-heading"
          className="py-10 sm:py-14"
        >
          <Reveal>
            <div className={`p-6 sm:p-8 ${card} ${cardStyles.card} ${cardStyles.wide}`}>
              <h2
                id="what-is-simplassist-heading"
                className={`text-[clamp(26px,3.5vw,40px)] leading-[1.08] tracking-[-0.035em] font-extrabold ${ink}`}
              >
                What is SimplAssist?
              </h2>
              <p className={`${body} mt-4 max-w-[78ch] leading-[1.75]`}>
                {seoContent.definition}
              </p>
            </div>
          </Reveal>
        </section>

        {/* ── Features ── */}
        <section id="features" className="py-16 sm:py-24">
          <SectionHeader
            title={
              <>
                Built for small businesses that want a{" "}
                <span className={accentText}>bigger presence</span>.
              </>
            }
            subtitle="Give customers a fast, professional experience without hiring a full-time front desk team."
          />

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {features.map((feature, i) => (
              <Reveal key={feature.title} delayMs={i * 75} className="h-full">
                <div className={`p-6 sm:p-8 relative overflow-hidden h-full ${card} ${cardStyles.card}`}>
                  <div
                    className={`
                      w-14 h-14 rounded-[22px] grid place-items-center mb-4
                      bg-[#fdf1e7] border border-[#f5dcc4]
                      dark:bg-transparent dark:bg-[linear-gradient(135deg,rgba(255,145,77,.22),rgba(255,255,255,.08))]
                      dark:border-white/[0.10]
                      ${cardStyles.art}
                    `}
                  >
                    <feature.icon className="w-6 h-6 text-[#ea580c] dark:text-[#ff914d]" />
                  </div>
                  <h3 className={`text-xl sm:text-[22px] font-bold ${ink} mb-2.5`}>
                    {feature.title}
                  </h3>
                  <p className={`${body} leading-[1.7]`}>{feature.description}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ── How It Works — the dashboard, two views. Desktop: two labeled
            columns over one soft panel with overlapping panes (inbox front by
            default; hover the calendar to bring it forward). Below lg: the
            ElevenLabs mobile pattern — each label + description is followed
            by its own image. ── */}
        <section id="how-it-works" className="py-16 sm:py-24">
          <SectionHeader
            title={
              <>
                One dashboard for every <span className={accentText}>conversation</span>.
              </>
            }
            subtitle="Messages, leads, and bookings — everything your assistant handles, in one place."
          />

          {/* Labeled columns (lg+) */}
          <Reveal>
            <div className="hidden lg:grid grid-cols-2 gap-10 max-w-[720px] mb-8">
              {dashboardViews.map((view) => (
                <div key={view.title}>
                  <h3 className={`text-base font-bold ${ink} mb-1.5`}>{view.title}</h3>
                  <p className={`${body} text-[15px] leading-[1.65]`}>{view.description}</p>
                </div>
              ))}
            </div>
          </Reveal>

          {/* lg+: one soft panel, two overlapping dashboard views */}
          <Reveal delayMs={100}>
            <div className="hidden lg:block rounded-[28px] overflow-hidden px-10 pt-10 bg-[#f2eee5] border border-black/[0.03] dark:bg-white/[0.05] dark:border-white/[0.07]">
              <div className="flex items-end">
                <div
                  className={`relative z-10 w-[59%] shrink-0 aspect-video ${paneFrame} shadow-[0_12px_40px_-12px_rgba(28,25,23,0.22)] ${cardStyles.preview}`}
                >
                  <PaneShot
                    base="pane-messages"
                    alt="SimplAssist conversations inbox — a missed call turned into a booked water heater repair"
                    sizes="(min-width: 1024px) 42rem, 90vw"
                  />
                </div>
                <div
                  className={`relative z-0 w-[52%] -ml-[11%] shrink-0 aspect-[15/8] ${paneFrame} shadow-[0_12px_40px_-12px_rgba(28,25,23,0.18)] ${cardStyles.preview}`}
                >
                  <PaneShot
                    base="pane-calendar"
                    alt="SimplAssist calendar — a month full of AI-booked appointments"
                    sizes="(min-width: 1024px) 37rem, 90vw"
                  />
                </div>
              </div>
            </div>
          </Reveal>

          {/* < lg: label, description, then its image — stacked per view */}
          <div className="lg:hidden space-y-10">
            {dashboardViews.map((view, i) => (
              <Reveal key={view.title} delayMs={i * 90}>
                <h3 className={`text-base font-bold ${ink} mb-1.5`}>{view.title}</h3>
                <p className={`${body} text-[15px] leading-[1.65]`}>{view.description}</p>
                <div className="mt-4 rounded-2xl overflow-hidden p-3 pb-0 bg-[#f2eee5] border border-black/[0.03] dark:bg-white/[0.05] dark:border-white/[0.07]">
                  <div className={`relative ${view.aspect} ${paneFrame} rounded-t-xl ${cardStyles.preview}`}>
                    <PaneShot base={view.base} alt={view.alt} sizes="90vw" />
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ── Quick Demo ── */}
        <section id="try-it-live" className="py-16 sm:py-24">
          <SectionHeader
            title={
              <>
                Quick <span className={accentText}>Demo</span>.
              </>
            }
            subtitle={"Call or chat with SimplAssist and see what the experience feels like from the other\u00a0side."}
            subtitleClassName="sm:max-w-none"
          />

          <div className="grid gap-5 sm:grid-cols-2">
            <Reveal className="h-full">
              <article className={`flex h-full flex-col p-6 sm:p-8 ${card} ${cardStyles.card}`}>
                <h3 className={`text-xl font-bold sm:text-[22px] ${ink}`}>
                  Make the call. We won’t answer.
                  <br />
                  <span className="inline-block">SimplAssist will.</span>
                </h3>
                <p className={`${body} mt-3 leading-[1.7]`}>
                  Call this number. We’ll let it ring.
                </p>
                <a
                  href="tel:+15742638634"
                  className={`my-5 block w-fit whitespace-nowrap rounded-lg text-[clamp(27px,4vw,42px)] font-extrabold leading-none tracking-[-0.04em] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[#ea580c]/60 focus-visible:ring-offset-4 dark:focus-visible:ring-[#ff914d]/60 dark:focus-visible:ring-offset-[#050505] ${accentText}`}
                >
                  (574) 263-8634
                </a>
                <p className={`${body} leading-[1.7]`}>
                  SimplAssist will text you back in seconds and carry the
                  conversation from there.
                </p>
                <p className={`${body} mt-5 border-t border-[#ece4d8] pt-5 text-sm leading-[1.65] dark:border-white/[0.10]`}>
                  Try a reply—ask about pricing, features, or how it works.
                </p>
              </article>
            </Reveal>

            <Reveal delayMs={90} className="h-full">
              <article className={`flex h-full flex-col p-6 sm:p-8 ${card} ${cardStyles.card}`}>
                <h3 className={`text-xl font-bold sm:text-[22px] ${ink}`}>
                  Ask away. SimplAssist can take it.
                </h3>
                <p className={`${body} mt-3 leading-[1.7]`}>
                  Ask about pricing, features, setup, or how it works. Then ask a
                  follow-up and see if it keeps up.
                </p>
                <div className="mt-auto pt-7">
                  <OpenChatButton className={btnPrimary} />
                  <p className={`${body} mt-3 text-sm leading-[1.55]`}>
                    Go off script. That’s the point.
                  </p>
                </div>
              </article>
            </Reveal>
          </div>
        </section>

        {/* ── Pricing ── */}
        <section
          id="pricing"
          aria-labelledby="pricing-heading"
          className="py-16 sm:py-24"
        >
          <SectionHeader
            id="pricing-heading"
            title={
              <>
                Simple plans that grow with your{" "}
                <span className={accentText}>business</span>.
              </>
            }
            subtitle={
              publicChatOnlyAvailable
                ? "No contracts. Chat Only has no setup fee; paid SMS activation includes a one-time $25 setup fee."
                : "No contracts. Paid SMS activation includes a one-time $25 setup fee."
            }
          />

          <div className="mx-auto grid max-w-[1160px] items-stretch gap-5 lg:grid-cols-3">
            {pricingCardPlans.map((plan, i) => {
              const available =
                plan.planKey === "chat_only"
                  ? publicChatOnlyAvailable
                  : isPlanAvailable(plan.planKey);
              const cardHeadingId = `pricing-card-${plan.planKey}`;

              return (
                <Reveal key={plan.name} delayMs={i * 100} className="h-full">
                  <article
                    data-plan-card={plan.planKey}
                    aria-labelledby={cardHeadingId}
                    className={
                      plan.highlighted
                        ? `
                        rounded-[28px] p-7 flex h-full flex-col relative lg:-translate-y-1 z-10
                        bg-white border border-transparent
                        outline outline-2 outline-[rgba(194,65,12,.30)]
                        shadow-[0_2px_4px_rgba(28,25,23,0.05),0_28px_56px_-16px_rgba(154,52,18,0.18)]
                        dark:bg-transparent dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.11),rgba(255,255,255,0.05))]
                        dark:outline-[rgba(255,145,77,.42)]
                        dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_24px_56px_-16px_rgba(0,0,0,0.7)]
                        dark:backdrop-blur-[18px]
                        ${cardStyles.card}
                      `
                        : `p-7 flex h-full flex-col relative ${card} ${cardStyles.card} ${
                            available
                              ? ""
                              : "bg-stone-50/90 dark:bg-white/[0.035]"
                          }`
                    }
                  >
                    <div className="mb-4 flex min-h-7 flex-wrap items-center justify-between gap-2 lg:min-h-16 lg:flex-col lg:flex-nowrap lg:items-start lg:justify-start">
                      <span className="text-xs font-extrabold uppercase tracking-[0.09em] text-stone-500 dark:text-[#bdbdbf]">
                        {plan.category}
                      </span>
                      {plan.highlighted && (
                        <span className="px-3 py-1.5 rounded-full text-[12px] font-extrabold bg-[#ea580c] text-white dark:bg-[#ff914d] dark:text-[#16100b]">
                          Most Popular
                        </span>
                      )}
                      {!available && (
                        <span className="inline-flex rounded-full border border-[#f5dcc4] bg-[#fdf1e7] px-3 py-1.5 text-[12px] font-extrabold text-[#c2410c] dark:border-[#ff914d]/30 dark:bg-[#ff914d]/10 dark:text-[#ffd7bf]">
                          Coming Soon
                        </span>
                      )}
                    </div>
                    <h3 id={cardHeadingId} className={`text-2xl font-bold lg:min-h-16 ${ink}`}>
                      {plan.name}
                    </h3>
                    <p className={`${body} mt-2 leading-[1.65] mb-6 lg:min-h-24`}>
                      {plan.description}
                    </p>
                    <div className={`mb-1 text-[50px] font-extrabold tracking-[-0.05em] ${ink}`}>
                      <span aria-hidden="true">
                        {plan.price}
                        <small className="text-lg text-stone-500 dark:text-[#bdbdbf]">/mo</small>
                      </span>
                      <span className="sr-only">{plan.price} per month</span>
                    </div>
                    <p className="mb-6 min-h-6 text-sm font-bold text-[#c2410c] dark:text-[#ffb080]">
                      {plan.billingNote}
                    </p>
                    <ul
                      data-plan-highlights={plan.planKey}
                      className="mb-7 flex-1 space-y-3"
                    >
                      {plan.highlights.map((feature) => (
                        <li key={feature} className="flex items-start gap-2.5 text-stone-700 dark:text-[#efefef] leading-relaxed">
                          <span aria-hidden="true" className="text-[#ea580c] dark:text-[#ff914d] font-black text-2xl leading-none -mt-px">&bull;</span>
                          <span>{feature}</span>
                        </li>
                      ))}
                    </ul>
                    {available ? (
                      <Link
                        href="/signup"
                        aria-label={`Get started with ${plan.name}`}
                        className={plan.highlighted ? `${btnPrimary} w-full` : `${btnSecondary} w-full`}
                      >
                        Get Started
                      </Link>
                    ) : (
                      <FullSuiteWaitlistButton className={`${btnSecondary} w-full`} />
                    )}
                  </article>
                </Reveal>
              );
            })}
          </div>

          <p className={`mt-5 text-center text-sm leading-6 ${body}`}>
            {FULL_SUITE_USAGE_NOTE}
          </p>

          {publicChatOnlyAvailable && (
            <p
              data-sms-only-footnote
              className={`mt-5 text-center text-sm leading-6 ${body}`}
            >
              Just need missed-call texting without web chat?{" "}
              <Link
                href="/signup"
                className={`${inlineLink} font-semibold underline-offset-4 hover:underline`}
              >
                SMS Only — $25/mo <span aria-hidden="true">&rarr;</span>
              </Link>
            </p>
          )}

          <Reveal className="mt-7">
            <details className="sa-pricing-comparison group">
              <summary
                data-plan-comparison-toggle
                className={`mx-auto flex min-h-11 w-fit cursor-pointer list-none items-center justify-center gap-1.5 px-3 py-2 text-center text-sm font-bold outline-none transition-colors hover:text-[#c2410c] focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-[#ea580c]/60 dark:hover:text-[#ff914d] dark:focus-visible:ring-[#ff914d]/60 [&::-webkit-details-marker]:hidden ${ink}`}
              >
                <span>Compare all plan features</span>
                <span
                  aria-hidden="true"
                  className="text-base leading-none text-[#c2410c] transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none dark:text-[#ff914d]"
                >
                  &#8964;
                </span>
              </summary>

              <div className="mt-4">
                <p className={`mb-3 text-sm sm:hidden ${body}`}>
                  Swipe sideways to compare every plan.
                </p>
                <div
                  role="region"
                  aria-label="Complete plan feature comparison"
                  tabIndex={0}
                  className="overflow-x-auto rounded-[20px] border border-[#ece4d8] outline-none focus-visible:ring-2 focus-visible:ring-[#ea580c]/60 dark:border-white/[0.10] dark:focus-visible:ring-[#ff914d]/60"
                >
                  <table className="w-full min-w-[940px] border-separate border-spacing-0 text-left text-sm">
                    <caption className="sr-only">
                      Complete feature comparison for SimplAssist plans
                    </caption>
                    <thead>
                      <tr>
                        <th
                          scope="col"
                          className="sticky left-0 z-30 w-[170px] min-w-[170px] border-b border-r border-[#e7ddd0] bg-[#faf6ef] px-4 py-5 font-extrabold text-stone-700 shadow-[5px_0_10px_-8px_rgba(28,25,23,0.45)] dark:border-white/[0.12] dark:bg-[#151515] dark:text-[#efefef] sm:w-[260px] sm:min-w-[260px] sm:px-5"
                        >
                          Feature
                        </th>
                        {comparisonPlans.map((plan) => {
                          const available =
                            plan.planKey === "chat_only"
                              ? publicChatOnlyAvailable
                              : isPlanAvailable(plan.planKey);
                          const highlighted = plan.planKey === "sms_and_chat";

                          return (
                            <th
                              key={plan.planKey}
                              scope="col"
                              data-plan-details={plan.planKey}
                              data-highlighted={highlighted || undefined}
                              className={`min-w-[170px] border-b border-[#e7ddd0] px-4 py-4 align-top dark:border-white/[0.12] ${
                                highlighted
                                  ? "bg-[#fff1e6] dark:bg-[#ff914d]/[0.12]"
                                  : "bg-white/90 dark:bg-[#111111]"
                              }`}
                            >
                              <span className="block text-xs font-extrabold uppercase tracking-[0.08em] text-stone-500 dark:text-[#bdbdbf]">
                                {available ? plan.category : "Coming Soon"}
                              </span>
                              <span className={`mt-1.5 block text-base font-extrabold ${ink}`}>
                                {plan.name}
                              </span>
                              <span className={`mt-1 block text-sm font-semibold ${body}`}>
                                {plan.price}/month
                              </span>
                              <span className="mt-1 block text-xs font-semibold leading-5 text-[#c2410c] dark:text-[#ffb080]">
                                {plan.billingNote}
                              </span>
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    {comparisonGroups.map((group) => (
                      <tbody key={group.title} data-comparison-group={group.title}>
                        <tr>
                          <th
                            scope="rowgroup"
                            colSpan={comparisonPlans.length + 1}
                            className="border-b border-[#e7ddd0] bg-[#f4ede3] px-4 py-2.5 text-xs font-extrabold uppercase tracking-[0.09em] text-stone-600 dark:border-white/[0.12] dark:bg-white/[0.07] dark:text-[#d6d6d8] sm:px-5"
                          >
                            {group.title}
                          </th>
                        </tr>
                        {group.rows.map((row) => (
                          <tr key={row.feature} data-comparison-feature={row.feature}>
                            <th
                              scope="row"
                              className="sticky left-0 z-20 border-b border-r border-[#e7ddd0] bg-white px-4 py-3.5 font-semibold leading-5 text-stone-700 shadow-[5px_0_10px_-8px_rgba(28,25,23,0.45)] dark:border-white/[0.12] dark:bg-[#111111] dark:text-[#efefef] sm:px-5"
                            >
                              {row.feature}
                            </th>
                            {comparisonPlans.map((plan) => {
                              const highlighted = plan.planKey === "sms_and_chat";
                              const value = row.values[plan.planKey];

                              return (
                                <td
                                  key={plan.planKey}
                                  data-comparison-plan={plan.planKey}
                                  data-comparison-value={
                                    typeof value === "boolean"
                                      ? value
                                        ? "Included"
                                        : "Not included"
                                      : value
                                  }
                                  data-highlighted={highlighted || undefined}
                                  className={`border-b border-[#e7ddd0] px-4 py-3.5 text-center font-medium text-stone-700 dark:border-white/[0.12] dark:text-[#efefef] ${
                                    highlighted
                                      ? "bg-[#fff8f2] dark:bg-[#ff914d]/[0.07]"
                                      : "bg-white/70 dark:bg-[#0d0d0d]"
                                  }`}
                                >
                                  <PlanComparisonCell value={value} />
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    ))}
                  </table>
                </div>
              </div>
            </details>
          </Reveal>
        </section>

        {/* ── FAQ ── */}
        <section
          id="faq"
          aria-labelledby="faq-heading"
          className="py-16 sm:py-24"
        >
          <Reveal className="mb-12 sm:mb-16">
            <h2
              id="faq-heading"
              className={`text-[clamp(28px,4vw,46px)] leading-[1.04] tracking-[-0.04em] font-extrabold ${ink}`}
            >
              Frequently asked <span className={accentText}>questions</span>.
            </h2>
            <p className={`${body} mt-4 max-w-[60ch] leading-[1.65]`}>
              Straight answers about plans, missed-call texting, AI, and setup.
            </p>
          </Reveal>

          <div className="grid gap-4">
            {seoContent.faqs.map((faq, i) => (
              <Reveal key={faq.question} delayMs={Math.min(i * 45, 180)}>
                <details className={`sa-faq-disclosure group overflow-hidden ${card} ${cardStyles.card} ${cardStyles.wide}`}>
                  <summary className="min-h-[76px] cursor-pointer list-none p-6 outline-none transition-colors hover:bg-[#faf6ef] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ea580c]/60 dark:hover:bg-white/[0.04] dark:focus-visible:ring-[#ff914d]/60 sm:px-7 [&::-webkit-details-marker]:hidden">
                    <h3 className={`flex items-center justify-between gap-5 text-lg sm:text-xl font-bold leading-snug ${ink}`}>
                      <span>{faq.question}</span>
                      <ChevronDown
                        className="h-5 w-5 shrink-0 text-[#c2410c] transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none dark:text-[#ff914d]"
                        aria-hidden="true"
                      />
                    </h3>
                  </summary>
                  <div className={`sa-faq-answer border-t border-[#ece4d8] px-6 pb-6 pt-4 dark:border-white/[0.10] sm:px-7 sm:pb-7 ${body}`}>
                    <p className="leading-[1.7]">
                      <FaqAnswerText faq={faq} />
                    </p>
                  </div>
                </details>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ── CTA — headline + the "two Tuesdays" race vignette; both columns
            stretch so neither side leaves dead space ── */}
        <Reveal>
          <section className={`my-6 p-6 sm:p-8 grid lg:grid-cols-[1.1fr_.9fr] gap-6 lg:gap-10 ${card} ${cardStyles.card} ${cardStyles.wide}`}>
            <div className="lg:pt-1.5 flex flex-col">
              <h2 className={`text-balance text-[clamp(28px,4vw,48px)] font-extrabold leading-[1.05] tracking-[-0.04em] mb-3 ${ink}`}>
                Your voicemail isn&apos;t closing deals.
              </h2>
              <p className={`${body} leading-[1.7] max-w-[560px]`}>
                SimplAssist texts customers back before they&apos;ve dialed your competitor.
              </p>
              <div className="mt-7 flex-1">
                <CtaRace />
              </div>
            </div>
            <div className={`${tile} p-6 h-full flex flex-col`}>
              <strong className={`block text-base mb-2.5 ${ink}`}>
                What you get:
              </strong>
              <ul className="flex-1 flex flex-col justify-center gap-3 mb-5">
                {[
                  "Automatic missed-call texts, day or night",
                  "Website chat widget — embed with one line of code",
                  "Every lead and conversation in one dashboard",
                  "Live the same week, once your number's approved to send",
                ].map((item) => (
                  <li key={item} className="flex items-center gap-2.5 text-stone-700 dark:text-[#ececec]">
                    <span className="w-2 h-2 rounded-full bg-[#ea580c] dark:bg-[#ff914d] shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
              <Link href="/signup" className={btnPrimaryWide}>
                Get Started
              </Link>
              <p className="mt-3 flex items-center justify-center gap-2 text-[12px] text-stone-500 dark:text-[#bdbdbf]">
                <span className="relative flex h-1.5 w-1.5" aria-hidden>
                  <span className="motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500/70 dark:bg-green-400/70" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500 dark:bg-green-400" />
                </span>
                Your AI assistant is standing by — no contracts, cancel anytime.
              </p>
            </div>
          </section>
        </Reveal>

        <section
          aria-labelledby="trusted-technology-heading"
          className="my-6 rounded-[28px] border border-black/[0.03] bg-[#f2eee5] px-6 py-7 sm:px-8 sm:py-8 dark:border-white/[0.07] dark:bg-white/[0.05]"
        >
          <h2
            id="trusted-technology-heading"
            className={`text-center text-[clamp(26px,3.5vw,38px)] font-extrabold leading-none tracking-[-0.035em] ${ink}`}
          >
            Powered <span className={accentText}>by</span>
          </h2>
          <ul className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {trustedTechnologies.map(({ name, logo }) => (
              <li
                key={name}
                className={`flex min-h-[76px] items-center justify-center gap-3 rounded-[22px] border border-[#e8e0d5] bg-white px-3 py-4 shadow-[0_1px_2px_rgba(28,25,23,0.03)] dark:border-white/[0.10] dark:bg-white/[0.08] dark:shadow-none ${cardStyles.card}`}
              >
                <Image
                  src={logo}
                  alt={name}
                  width={40}
                  height={32}
                  className={`h-8 w-10 shrink-0 object-contain ${cardStyles.art}`}
                />
                <span className={`text-sm font-semibold leading-tight ${ink}`}>
                  {name}
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* ── Footer ── */}
        <footer className="pb-10 pt-2">
          <Reveal>
            {/* Mobile: stacked and centered (logo / copyright / links);
                sm+: single row, logo+copyright left, links right */}
            <div className={`px-6 py-7 sm:py-6 flex flex-col items-center gap-4 text-center sm:flex-row sm:justify-between sm:text-left ${card}`}>
              <div className="flex flex-col items-center gap-2 sm:flex-row sm:gap-3.5">
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
                <small className="text-stone-500 dark:text-[#bdbdbf] block sm:mt-1">
                  &copy; {new Date().getFullYear()} SimplAssist, a product of Arambula Ventures LLC.
                </small>
              </div>
              <div className="flex gap-x-5 gap-y-2 flex-wrap justify-center text-sm">
                <a href="#features" className={navLink}>Features</a>
                <a href="#pricing" className={navLink}>Pricing</a>
                <Link href="/support" className={navLink}>Support</Link>
                <Link href="/privacy" className={navLink}>Privacy</Link>
                <Link href="/terms" className={navLink}>Terms</Link>
                <Link href="/login" className={navLink}>Log In</Link>
              </div>
            </div>
          </Reveal>
        </footer>
      </div>
    </div>
  );
}
