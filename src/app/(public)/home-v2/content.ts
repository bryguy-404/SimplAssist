/**
 * Content for the /home-v2 preview homepage.
 *
 * features/steps/plans/heroStats are copied from /home (page.tsx) on purpose —
 * the two pages are an A/B pair and their copy may diverge; if v2 wins, /home
 * gets replaced and the duplication evaporates. Do not import from /home.
 *
 * RSC note: several arrays hold lucide icon component references. They must
 * NOT be passed as props across the server→client boundary — the server page
 * renders them itself, and showcase-tabs.tsx (client) imports its own data
 * from this module directly.
 */

import {
  ArrowUpRight,
  Car,
  Dog,
  Hammer,
  Inbox,
  Leaf,
  MessageCircle,
  Phone,
  Sparkles,
  Star,
  Target,
  Wind,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { SUBSCRIPTION_PLANS } from "@/lib/stripe/config";
import { FULL_SUITE_DESCRIPTION } from "@/lib/billing/fullSuitePresentation";

/* ── Copied from /home ── */

export const features = [
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

export const steps = [
  {
    title: "Customer calls, you're busy",
    description:
      "You're with a client, driving, or closed for the day. The call goes unanswered, but the lead is still active.",
  },
  {
    title: "SimplAssist texts back instantly",
    description:
      "Within seconds, SimplAssist sends a branded message so customers know they've been heard.",
  },
  {
    title: "You follow up with context",
    description:
      "Every message and contact lives in your dashboard so you can respond faster and close more leads.",
  },
];

export const plans = [
  {
    name: "SMS Only",
    price: "$25",
    description: "Missed-call texting for small teams that want fast coverage.",
    features: [
      "One local SimplAssist number",
      "Manual SMS inbox and replies",
      "Automatic missed-call text",
      "500 included SMS parts/month",
    ],
    highlighted: false,
  },
  {
    name: "SMS + Web Chat",
    price: "$45",
    description: "Capture leads from calls and your website, then turn them into booked appointments.",
    features: [
      "Everything in SMS Only",
      "Website chat widget",
      "Web chat lead capture",
      "Full AI SMS conversations",
      "Customize your AI's answers and tone",
      "Google Calendar connection",
      "AI appointment scheduling",
      "1,500 included SMS parts/month",
    ],
    highlighted: true,
  },
  {
    name: "Full Suite",
    price: `$${SUBSCRIPTION_PLANS.full.price}`,
    description: FULL_SUITE_DESCRIPTION,
    features: SUBSCRIPTION_PLANS.full.features,
    highlighted: false,
  },
];

export const chatOnlyPlan = {
  name: "Chat Only",
  price: "$10",
  description:
    "An AI website receptionist for teams that want web chat without texting.",
  features: [
    "Website chat widget",
    "200 completed AI replies/month",
    "Web-chat lead capture",
    "Contact and conversation inbox",
    "AI answer, tone, FAQ, and service customization",
    "Google Calendar connection",
    "AI appointment scheduling",
    "No phone number, SMS, MMS, or Telnyx activation",
    "No setup or SMS activation fee",
  ],
  highlighted: false,
} as const;

/**
 * Presentation-only composition for the noncanonical preview. The caller must
 * supply the canonical server-side public-launch decision; this module never
 * reads rollout configuration or treats the exact-business canary as public
 * launch authority.
 */
export function plansForPublicLaunch(chatOnlyPublicLaunchEnabled: boolean) {
  return chatOnlyPublicLaunchEnabled ? [chatOnlyPlan, ...plans] : plans;
}

export const heroStats = [
  { stat: "24/7", label: "Lead response coverage for missed calls and website visitors" },
  { stat: "1 inbox", label: "SMS and web chat conversations in one place" },
  { stat: "Fast setup", label: "Built for small teams that want results without complexity" },
];

/** /home's "What you get" checklist — not rendered on v2 (the split intro and
 *  features cover it), kept here ready to re-add if the quiet CTA misses it. */
export const whatYouGet = [
  "Automatic missed-call texts, day or night",
  "Website chat widget — embed with one line of code",
  "Every lead and conversation in one dashboard",
  "Live the same week, once your number's approved to send",
];

/* ── New for v2 ── */

/** Logo-cloud analog — the trades SimplAssist serves (first three mirror the
 *  hero demo's rotating businesses). */
export const industries: { icon: LucideIcon; label: string }[] = [
  { icon: Wrench, label: "Plumbing" },
  { icon: Car, label: "Auto repair" },
  { icon: Leaf, label: "Lawn care" },
  { icon: Zap, label: "Electrical" },
  { icon: Wind, label: "HVAC" },
  { icon: Sparkles, label: "Cleaning" },
  { icon: Hammer, label: "Contractors" },
  { icon: Dog, label: "Pet grooming" },
];

/** "Two platforms" split-intro columns. */
export const splitColumns = [
  {
    index: "01",
    title: "Missed-Call SMS",
    description:
      "When a call goes unanswered, SimplAssist texts the caller back within seconds — answers their question, keeps the conversation going, and books the job.",
  },
  {
    index: "02",
    title: "Website Chat",
    description:
      "A widget that greets visitors, captures contact info, and turns after-hours browsing into booked appointments — embedded with one line of code.",
  },
];

/* ── Tabbed showcase ── */

export type ShowcaseCard = {
  size: "lg" | "md" | "sm";
  industry?: string;
  caption?: string;
  /** Placeholder art variant — swap for real photography later (CardArt in
   *  showcase-tabs.tsx is the single place to change). */
  art: "thread" | "chat" | "blank";
};

export type ShowcaseTab = { id: string; label: string; cards: ShowcaseCard[] };

/** Card order per tab is [sm, md, lg, md, sm] — the layout relies on it. */
export const showcaseTabs: ShowcaseTab[] = [
  {
    id: "missed-calls",
    label: "Missed Calls",
    cards: [
      { size: "sm", art: "blank" },
      {
        size: "md",
        industry: "Auto repair",
        caption: "Check-engine question answered, diagnostic booked for 8 AM.",
        art: "thread",
      },
      {
        size: "lg",
        industry: "Plumbing",
        caption: "Leak call answered while the owner was under a sink — booked Tuesday 9 AM.",
        art: "thread",
      },
      {
        size: "md",
        industry: "Lawn care",
        caption: "After-hours mowing inquiry became a Thursday quote visit.",
        art: "thread",
      },
      { size: "sm", art: "blank" },
    ],
  },
  {
    id: "web-chat",
    label: "Website Chat",
    cards: [
      { size: "sm", art: "blank" },
      {
        size: "md",
        industry: "Cleaning",
        caption: "Visitor asked about deep cleans at 9 PM — quote sent by morning.",
        art: "chat",
      },
      {
        size: "lg",
        industry: "Contractors",
        caption: "A visitor priced a remodel and left their number — no phone call needed.",
        art: "chat",
      },
      {
        size: "md",
        industry: "HVAC",
        caption: "AC-out emergency routed to the on-call tech from the chat widget.",
        art: "chat",
      },
      { size: "sm", art: "blank" },
    ],
  },
];
