import type { Metadata } from "next";
import { isPlanAvailable } from "@/lib/billing/planAvailability";
import { FULL_SUITE_PACKAGE_SUMMARY } from "@/lib/billing/fullSuitePresentation";

const fullSuitePricingCopy = `${FULL_SUITE_PACKAGE_SUMMARY} ${isPlanAvailable("full")
  ? "Choose Full Suite during signup, or upgrade from your billing page."
  : "Full Suite is coming soon and cannot be purchased yet."}`;

export const SITE_ORIGIN = "https://simplassist.com";

export const HOME_TITLE =
  "SimplAssist — Missed-Call Text Back for Small Businesses";

export const HOME_DESCRIPTION =
  "SimplAssist provides small businesses with missed call text back from $25/month, plus AI conversations, website chat, and appointment booking at $45/month.";

export const HOME_DEFINITION =
  "SimplAssist is a missed call text back service for small businesses, with plans starting at $25/month. Its $45/month plan adds an AI receptionist for SMS and web chat, a website chat widget, and Google Calendar appointment booking. Full Suite adds an AI voice receptionist that speaks with callers, collects their details, and helps book appointments when you can't answer.";

export const CHAT_ONLY_HOME_TITLE =
  "SimplAssist — $10 AI Website Chat for Small Businesses";

export const CHAT_ONLY_HOME_DESCRIPTION =
  "AI website chat for $10/month: answer questions, capture leads, and book appointments. No setup fee. Explore texting plans and Full Suite AI phone answering.";

export const CHAT_ONLY_HOME_DEFINITION =
  "SimplAssist helps small businesses answer customers and book appointments. Start with Chat Only at $10/month for 200 completed website-chat AI replies, lead capture, a conversation inbox, AI customization, and Google Calendar booking, with no phone, texting, or setup fee. SMS plans add missed-call texting, while Full Suite adds an AI voice receptionist that speaks with callers and helps book appointments by phone.";

export type HomepageFaq = {
  question: string;
  answer: string;
  answerLink?: {
    text: string;
    href: string;
  };
};

const VOICE_FAQS = [
  {
    question: "What is an AI voice receptionist, and which plan includes it?",
    answer:
      `An AI voice receptionist speaks with callers over the phone when you can't answer. It uses your business information to answer questions, collect contact details, and help book appointments. Webchat handles typed conversations on your website, while voice lets callers talk with the AI. ${fullSuitePricingCopy}`,
  },
  {
    question: "Can I try SimplAssist's AI voice receptionist?",
    answer:
      "Yes. Call (574) 263-8634 to speak with SimplAssist's AI receptionist live. Ask what SimplAssist does, ask about our plans, and try a follow-up question to hear how it responds. This demonstrates the phone answering available with Full Suite. You can also try our website chat to experience a typed conversation.",
    answerLink: {
      text: "(574) 263-8634",
      href: "tel:+15742638634",
    },
  },
] as const satisfies readonly HomepageFaq[];

export const HOME_FAQS = [
  {
    question: "What is missed call text back?",
    answer:
      "Missed call text back automatically sends a text message to anyone whose call your business couldn't answer — so instead of hitting voicemail and moving on, the caller gets an instant reply and can keep the conversation going by SMS.",
  },
  {
    question: "What is SimplAssist?",
    answer:
      "SimplAssist is a customer communication service built for small businesses. The $25/month SMS Only plan gives you missed call text back and a shared inbox, and the $45/month plan adds an AI receptionist for SMS and web chat, a website chat widget, and appointment booking synced with Google Calendar. Full Suite adds AI phone answering so callers can speak with your receptionist when you can't pick up.",
  },
  {
    question: "How does SimplAssist's missed call text back work?",
    answer:
      "When someone calls and you can't pick up, SimplAssist automatically sends them a branded text inviting them to reply. Their replies land in your shared inbox, and on the $45/month plan your AI receptionist can carry the conversation for you.",
  },
  {
    question: "How much does SimplAssist cost?",
    answer:
      `SMS Only is $25/month with 500 included SMS parts, and SMS + Web Chat is $45/month with 1,500 included SMS parts. There's a one-time $25 setup fee per business when you activate paid SMS, which covers your carrier registration. ${fullSuitePricingCopy}`,
  },
  {
    question: "What kinds of businesses is SimplAssist for?",
    answer:
      "SimplAssist is built for small businesses and small teams that get customer calls or website inquiries — the ones too busy serving customers to catch every call. It handles missed-call follow-up, web chat, a shared inbox, and appointment booking, so you get front-desk coverage without hiring a full-time front desk.",
  },
  {
    question: "Does the AI answer with my business's real information?",
    answer:
      "Yes — your AI only speaks from what you've given it. On the SMS + Web Chat plan, SimplAssist loads your business profile, active services, saved FAQs, business hours, and AI settings before every answer, and it's instructed never to invent facts about your business.",
  },
  {
    question: "How long does setup take?",
    answer:
      "Most SMS registrations are approved within a few business days of payment, though additional carrier review can sometimes stretch that to a few weeks — that timeline is set by the phone carriers, not by us. Texting goes live as soon as carrier approval and your phone-number assignment are complete. Learn more about what the one-time $25 setup fee covers.",
    answerLink: {
      text: "what the one-time $25 setup fee covers.",
      href: "/support/setup-fee",
    },
  },
  {
    question: "Can I cancel anytime?",
    answer:
      "Yes — you can cancel anytime, and there are no contracts. The one-time $25 setup fee is non-refundable once carrier registration begins, since it covers that registration process itself.",
  },
  ...VOICE_FAQS,
] as const satisfies readonly HomepageFaq[];

export const CHAT_ONLY_HOME_FAQS = [
  HOME_FAQS[0],
  {
    question: "What is SimplAssist?",
    answer:
      "SimplAssist is a customer communication service built for small businesses. Chat Only provides an AI website receptionist, lead capture, a conversation inbox, and Google Calendar booking without phone or SMS setup. SMS plans add missed-call text back and business texting. Full Suite adds an AI voice receptionist that speaks with callers, collects details, and helps book appointments by phone.",
  },
  {
    question: "What is included in Chat Only?",
    answer:
      "Chat Only is $10/month and includes a website chat widget, 200 completed AI replies per month, web-chat lead capture, a contact and conversation inbox, AI answer and tone customization, Google Calendar connection, and AI appointment booking. It has no phone number, SMS, MMS, Telnyx activation, or setup fee.",
  },
  HOME_FAQS[2],
  {
    question: "How much does SimplAssist cost?",
    answer:
      `Chat Only is $10/month with 200 completed website-chat AI replies and no setup fee. SMS Only is $25/month with 500 included SMS parts, and SMS + Web Chat is $45/month with 1,500 included SMS parts. Paid SMS activation has a one-time $25 setup fee per business for carrier registration. ${fullSuitePricingCopy}`,
  },
  HOME_FAQS[4],
  {
    question: "Does the AI answer with my business's real information?",
    answer:
      "Yes — on Chat Only and SMS + Web Chat, your AI loads your business profile, active services, saved FAQs, business hours, and AI settings before every answer, and it is instructed never to invent facts about your business.",
  },
  {
    ...HOME_FAQS[6],
    answer:
      "Chat Only can launch without phone or carrier registration after billing and core setup are complete. SMS registrations are usually approved within a few business days of payment, though additional carrier review can sometimes take a few weeks. Texting goes live after carrier approval and phone-number assignment. Learn more about what the one-time $25 SMS setup fee covers.",
    answerLink: {
      text: "what the one-time $25 SMS setup fee covers.",
      href: "/support/setup-fee",
    },
  },
  HOME_FAQS[7],
  ...VOICE_FAQS,
] as const satisfies readonly HomepageFaq[];

export function getHomepageSeoContent(
  chatOnlyPublicLaunchEnabled = false,
): {
  title: string;
  description: string;
  definition: string;
  faqs: readonly HomepageFaq[];
} {
  return chatOnlyPublicLaunchEnabled
    ? {
        title: CHAT_ONLY_HOME_TITLE,
        description: CHAT_ONLY_HOME_DESCRIPTION,
        definition: CHAT_ONLY_HOME_DEFINITION,
        faqs: CHAT_ONLY_HOME_FAQS,
      }
    : {
        title: HOME_TITLE,
        description: HOME_DESCRIPTION,
        definition: HOME_DEFINITION,
        faqs: HOME_FAQS,
      };
}

const socialPreview = {
  url: "/social-preview.png",
  width: 1200,
  height: 630,
  alt: "SimplAssist",
};

function buildHomepageMetadata(title: string, description: string): Metadata {
  return {
    title,
    description,
    alternates: {
      canonical: "/",
    },
    openGraph: {
      title,
      description,
      url: "/",
      type: "website",
      images: [socialPreview],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [socialPreview.url],
    },
  };
}

export const HOME_METADATA = buildHomepageMetadata(
  HOME_TITLE,
  HOME_DESCRIPTION,
);

export function getHomepageMetadata(
  chatOnlyPublicLaunchEnabled = false,
): Metadata {
  const { title, description } = getHomepageSeoContent(
    chatOnlyPublicLaunchEnabled,
  );
  return chatOnlyPublicLaunchEnabled
    ? buildHomepageMetadata(title, description)
    : HOME_METADATA;
}

const monthlyPriceSpecification = (price: number) => ({
  "@type": "UnitPriceSpecification",
  name: "Monthly subscription",
  price,
  priceCurrency: "USD",
  billingDuration: "P1M",
  unitText: "MONTH",
});

const activationPriceSpecification = {
  "@type": "PriceSpecification",
  name: "One-time SMS activation fee",
  price: 25,
  priceCurrency: "USD",
};

export function getHomepageJsonLd(chatOnlyPublicLaunchEnabled = false) {
  const organizationId = `${SITE_ORIGIN}/#organization`;
  const applicationId = `${SITE_ORIGIN}/#software-application`;
  const { description, faqs } = getHomepageSeoContent(
    chatOnlyPublicLaunchEnabled,
  );
  const offers = [
    ...(chatOnlyPublicLaunchEnabled
      ? [
          {
            "@type": "Offer",
            name: "Chat Only",
            url: `${SITE_ORIGIN}/#pricing`,
            price: 10,
            priceCurrency: "USD",
            availability: "https://schema.org/InStock",
            priceSpecification: [monthlyPriceSpecification(10)],
          },
        ]
      : []),
    {
      "@type": "Offer",
      name: "SMS Only",
      url: `${SITE_ORIGIN}/#pricing`,
      price: 25,
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
      priceSpecification: [
        monthlyPriceSpecification(25),
        activationPriceSpecification,
      ],
    },
    {
      "@type": "Offer",
      name: "SMS + Web Chat",
      url: `${SITE_ORIGIN}/#pricing`,
      price: 45,
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
      priceSpecification: [
        monthlyPriceSpecification(45),
        activationPriceSpecification,
      ],
    },
  ];

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": organizationId,
        name: "SimplAssist",
        url: `${SITE_ORIGIN}/`,
        logo: `${SITE_ORIGIN}/logo-light.png`,
      },
      {
        "@type": "SoftwareApplication",
        "@id": applicationId,
        name: "SimplAssist",
        description,
        url: `${SITE_ORIGIN}/`,
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        publisher: { "@id": organizationId },
        offers,
      },
      {
        "@type": "FAQPage",
        "@id": `${SITE_ORIGIN}/#faq`,
        mainEntity: faqs.map(({ question, answer }) => ({
          "@type": "Question",
          name: question,
          acceptedAnswer: {
            "@type": "Answer",
            text: answer,
          },
        })),
      },
    ],
  };
}

export function serializeJsonLd(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
