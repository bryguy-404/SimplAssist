import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRequestBrand: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/font/local", () => ({
  default: () => ({ variable: "font-test-variable" }),
}));
vi.mock("next/script", () => ({ default: () => null }));
vi.mock("@/lib/branding/requestBrand.server", () => ({
  getRequestBrand: mocks.getRequestBrand,
}));

import RootLayout from "../../layout";
import {
  dynamic,
  generateMetadata,
  revalidate,
} from "../../page";
import CanonicalHomepage from "./page";
import { REVEAL_NO_SCRIPT_CSS } from "@/lib/theme-v2/reveal";
import {
  CHAT_ONLY_HOME_DESCRIPTION,
  CHAT_ONLY_HOME_FAQS,
  CHAT_ONLY_HOME_TITLE,
  getHomepageJsonLd,
  getHomepageMetadata,
  getHomepageSeoContent,
  HOME_DEFINITION,
  HOME_DESCRIPTION,
  HOME_FAQS,
  HOME_METADATA,
  HOME_TITLE,
} from "./seo";

const DEFAULT_REQUEST_BRAND = {
  source: "default" as const,
  isPreview: false,
  brand: {
    kind: "default" as const,
    partnerId: null,
    slug: null,
    name: "SimplAssist",
    publicOrigin: "https://simplassist.com",
    logoLightUrl: "/logo-light.png",
    logoDarkUrl: "/logo-dark.png",
    faviconUrl: "/favicon-2.png",
    colors: {
      primary: "#ea580c",
      primaryHover: "#c2410c",
      primaryActive: "#9a3412",
      accent: "#c2410c",
      primaryDark: "#ff914d",
      primaryHoverDark: "#f57f33",
      primaryActiveDark: "#e8752c",
      accentDark: "#ff914d",
    },
  },
};

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "0");
  vi.stubEnv("STRIPE_PRICE_CHAT_ONLY", "");
  mocks.getRequestBrand.mockReset();
  mocks.getRequestBrand.mockResolvedValue(DEFAULT_REQUEST_BRAND);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function visibleText(html: string): string {
  return html
    .replace(/<!--([\s\S]*?)-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:x27|39);/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function renderHomepage(chatOnlyPublicLaunchEnabled = false) {
  vi.stubEnv(
    "CHAT_ONLY_DIRECT_SALES_ENABLED",
    chatOnlyPublicLaunchEnabled ? "1" : "0",
  );
  vi.stubEnv(
    "STRIPE_PRICE_CHAT_ONLY",
    chatOnlyPublicLaunchEnabled ? "price_live_chat_only" : "",
  );
  return renderToStaticMarkup(<CanonicalHomepage />);
}

type JsonRecord = Record<string, unknown>;

describe("canonical homepage SEO metadata", () => {
  it("uses the approved title and description with canonical social parity", () => {
    const metadata = generateMetadata();

    expect(metadata).toBe(HOME_METADATA);
    expect(HOME_TITLE).toHaveLength(56);
    expect(HOME_DESCRIPTION).toHaveLength(155);
    expect(HOME_TITLE).toBe(
      "SimplAssist — Missed-Call Text Back for Small Businesses"
    );
    expect(HOME_METADATA.alternates?.canonical).toBe("/");

    expect(HOME_METADATA.openGraph).toMatchObject({
      title: HOME_TITLE,
      description: HOME_DESCRIPTION,
      url: "/",
      images: [
        {
          url: "/social-preview.png",
          width: 1200,
          height: 630,
          alt: "SimplAssist",
        },
      ],
    });
    expect(HOME_METADATA.twitter).toMatchObject({
      card: "summary_large_image",
      title: HOME_TITLE,
      description: HOME_DESCRIPTION,
      images: ["/social-preview.png"],
    });
  });

  it("is dynamic and cache-safe at the root marketing boundary", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(revalidate).toBe(0);
  });

  it("switches all canonical metadata only for the public launch policy", () => {
    vi.stubEnv("CHAT_ONLY_DIRECT_SALES_ENABLED", "1");
    vi.stubEnv("STRIPE_PRICE_CHAT_ONLY", "price_live_chat_only");

    const metadata = generateMetadata();

    expect(metadata).toEqual(getHomepageMetadata(true));
    expect(metadata).toMatchObject({
      title: CHAT_ONLY_HOME_TITLE,
      description: CHAT_ONLY_HOME_DESCRIPTION,
      openGraph: {
        title: CHAT_ONLY_HOME_TITLE,
        description: CHAT_ONLY_HOME_DESCRIPTION,
      },
      twitter: {
        title: CHAT_ONLY_HOME_TITLE,
        description: CHAT_ONLY_HOME_DESCRIPTION,
      },
    });
  });
});

describe("canonical homepage static HTML", () => {
  it("renders one H1, the approved definition, and all visible FAQs", () => {
    const html = renderHomepage();
    const text = visibleText(html);
    const definitionSection = html.match(
      /<section id="what-is-simplassist"[\s\S]*?<\/section>/
    )?.[0];
    const faqSection = html.match(/<section id="faq"[\s\S]*?<\/section>/)?.[0];

    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(definitionSection).toBeDefined();
    expect(visibleText(definitionSection ?? "")).toContain(HOME_DEFINITION);
    expect(text).toContain("missed call text back");
    expect(text).toContain("AI receptionist");
    expect(text).toContain("website chat widget");

    expect(faqSection).toBeDefined();
    expect(faqSection?.match(/<h3\b/g)).toHaveLength(HOME_FAQS.length);
    const faqText = visibleText(faqSection ?? "");
    for (const { question, answer } of HOME_FAQS) {
      expect(faqText).toContain(question);
      expect(faqText).toContain(answer);
    }
  });

  it("ships a no-JavaScript override for every initially hidden reveal", async () => {
    const page = <CanonicalHomepage />;
    const pageHtml = renderToStaticMarkup(page);
    const documentHtml = renderToStaticMarkup(
      await RootLayout({ children: page })
    );

    expect(pageHtml).toContain("sa-reveal");
    expect(pageHtml).toContain("opacity-0");
    expect(documentHtml).toContain(`<noscript><style>${REVEAL_NO_SCRIPT_CSS}</style></noscript>`);
    expect(REVEAL_NO_SCRIPT_CSS).toContain("opacity:1!important");
    expect(REVEAL_NO_SCRIPT_CSS).toContain("transform:none!important");
  });

  it("renders collapsed semantic FAQ disclosures with answers always in HTML", () => {
    const html = renderHomepage();
    const faqSection = html.match(/<section id="faq"[\s\S]*?<\/section>/)?.[0];

    expect(faqSection?.match(/<details\b/g)).toHaveLength(HOME_FAQS.length);
    expect(faqSection?.match(/<summary\b/g)).toHaveLength(HOME_FAQS.length);
    expect(faqSection?.match(/class="sa-faq-answer\b/g)).toHaveLength(
      HOME_FAQS.length
    );
    expect(faqSection).not.toMatch(/<details\b[^>]*\sopen(?:=|\s|>)/);

    for (const { answer } of HOME_FAQS) {
      expect(visibleText(faqSection ?? "")).toContain(answer);
    }
    expect(REVEAL_NO_SCRIPT_CSS).toContain(
      "details:not([open]) .sa-faq-answer{display:block!important}"
    );
  });

  it("server-renders the trusted technology strip before the footer", () => {
    const html = renderHomepage();
    const strip = html.match(
      /<section aria-labelledby="trusted-technology-heading"[\s\S]*?<\/section>/
    )?.[0];

    expect(strip).toBeDefined();
    expect(visibleText(strip ?? "")).toContain("Powered by");
    expect(strip?.match(/<img\b/g)).toHaveLength(4);
    for (const name of [
      "Stripe",
      "Google Calendar",
      "Anthropic",
      "Cloudflare",
    ]) {
      expect(strip).toContain(`alt="${name}"`);
    }
    expect(strip).toContain("grid-cols-2");
    expect(strip).toContain("sm:grid-cols-4");
    expect(strip).not.toContain("grayscale");
    expect(strip).not.toContain("group-hover");
    expect(html.indexOf('id="trusted-technology-heading"')).toBeLessThan(
      html.indexOf("<footer")
    );
  });

  it("renders three focused selling cards and a complete plan matrix when Chat Only is public", () => {
    const html = renderHomepage(true);
    const pricing = html.match(
      /<section id="pricing"[\s\S]*?<\/section>/,
    )?.[0];
    const text = visibleText(pricing ?? "");
    const topPlanKeys = Array.from(
      pricing?.matchAll(/data-plan-card="([^"]+)"/g) ?? [],
      (match) => match[1],
    );
    const comparisonPlanKeys = Array.from(
      pricing?.matchAll(/data-plan-details="([^"]+)"/g) ?? [],
      (match) => match[1],
    );
    const expectedComparisonFeatures = [
      "Includes everything in",
      "Completed AI replies/month",
      "Included SMS parts/month",
      "Setup / SMS activation fee",
      "One local SimplAssist number",
      "Manual SMS inbox and replies",
      "Automatic missed-call text",
      "Website chat widget",
      "Custom widget branding",
      "Web-chat lead capture",
      "Phone number / SMS carrier activation",
      "MMS availability",
      "Contact management",
      "Conversation inbox",
      "Full AI SMS conversations",
      "AI customization",
      "Google Calendar connection",
      "AI appointment scheduling",
      "Custom AI rules and guardrails",
      "AI voice answering in English",
      "Included voice minutes/billing month",
      "Voice contact capture and signup texts",
      "Voice calendar booking",
      "Voice transcripts and recordings",
    ];

    expect(pricing).toBeDefined();
    expect(topPlanKeys).toEqual(["chat_only", "sms_and_chat", "full"]);
    expect(pricing).not.toContain('data-plan-card="sms_only"');
    expect(text).toContain("Chat Only");
    expect(text).toMatch(/\$10\s*\/mo/);
    expect(text).toContain("200 completed AI replies/month");
    expect(text).toContain("Website AI chat widget");
    expect(text).toContain("Web-chat lead capture + conversation inbox");
    expect(text).toContain("AI customization + Google Calendar booking");
    expect(text).toContain("No phone, texting, or setup fee");
    expect(text).toContain("$25 one-time SMS activation fee");
    expect(text).toContain("2,500 included SMS parts/month");
    expect(text).toContain("100 voice minutes/billing month");
    expect(text).not.toContain("Priority support");
    expect(text).not.toContain("Advanced analytics dashboard");
    expect(text).toContain("Everything in SMS Only, plus");
    expect(text).toContain("Everything in SMS + Web Chat, plus");
    expect(text).toContain("Full AI SMS conversations + customization");
    expect(text).toContain("Website chat widget");
    expect(text).toContain("Web-chat lead capture");
    expect(text).toContain("Contact management");
    expect(text).toContain("Conversation inbox");
    expect(text).toContain("Custom widget branding");
    expect(text).toContain("Answers, tone, FAQs & services");
    expect(text).toContain("Google Calendar connection");
    expect(text).toContain("AI appointment scheduling");
    expect(text).toContain("Phone number / SMS carrier activation");
    expect(text).toContain("MMS availability");
    expect(text).toContain("Compare all plan features");
    expect(text).not.toContain("Compare complete plan details");
    expect(text).not.toContain("See every included feature before you choose.");
    expect(pricing).toMatch(
      /<details(?![^>]*\bopen\b)[^>]*>[\s\S]*?<summary/,
    );
    const comparisonToggle = pricing?.match(
      /<summary data-plan-comparison-toggle[^>]*>[\s\S]*?<\/summary>/,
    )?.[0];
    expect(comparisonToggle).toContain("mx-auto");
    expect(comparisonToggle).toContain("min-h-11");
    expect(comparisonToggle).toContain("w-fit");
    expect(comparisonToggle).toContain('aria-hidden="true"');
    expect(comparisonToggle).not.toContain("<button");
    expect(comparisonToggle).not.toContain("<a");
    expect(text).toContain(
      "Just need missed-call texting without web chat? SMS Only — $25/mo →",
    );
    expect(pricing).toMatch(
      /<p data-sms-only-footnote[^>]*>[\s\S]*?href="\/signup"[\s\S]*?SMS Only — \$25\/mo[\s\S]*?<\/p>/,
    );
    expect(text).toContain("SMS + Web Chat");
    expect(text).toContain("Full Suite");
    expect(text.match(/Most Popular/g)).toHaveLength(1);
    expect(text).not.toContain("Coming Soon");
    expect(pricing?.match(/href="\/signup"/g)).toHaveLength(4);
    expect(text).not.toContain("Notify Me When It Launches");
    expect(pricing).toContain('<table class="w-full min-w-[940px]');
    expect(pricing).toContain('role="region"');
    expect(pricing).toContain('aria-label="Complete plan feature comparison"');
    expect(pricing).toContain('tabindex="0"');
    expect(pricing).toContain("overflow-x-auto");
    expect(pricing).toContain("sticky left-0");
    expect(pricing?.match(/scope="col"/g)).toHaveLength(5);
    expect(pricing?.match(/scope="row"/g)).toHaveLength(
      expectedComparisonFeatures.length,
    );
    expect(pricing?.match(/scope="rowgroup"/g)).toHaveLength(5);
    expect(comparisonPlanKeys).toEqual([
      "chat_only",
      "sms_only",
      "sms_and_chat",
      "full",
    ]);
    expect(pricing?.match(/data-comparison-group=/g)).toHaveLength(5);
    expect(pricing?.match(/data-comparison-feature=/g)).toHaveLength(
      expectedComparisonFeatures.length,
    );
    expect(pricing?.match(/data-comparison-plan="sms_and_chat"/g)).toHaveLength(
      expectedComparisonFeatures.length,
    );
    expect(pricing?.match(/data-highlighted="true"/g)).toHaveLength(
      expectedComparisonFeatures.length + 1,
    );

    for (const feature of expectedComparisonFeatures) {
      expect(pricing).toContain(`data-comparison-feature="${feature}"`);
    }

    const completedAiRepliesRow = pricing?.match(
      /<tr data-comparison-feature="Completed AI replies\/month">[\s\S]*?<\/tr>/,
    )?.[0];
    expect(completedAiRepliesRow).toContain(
      'data-comparison-plan="chat_only" data-comparison-value="200"',
    );
    expect(completedAiRepliesRow).toContain(
      'data-comparison-plan="sms_only" data-comparison-value="Not included"',
    );
    expect(completedAiRepliesRow?.match(/data-comparison-value="No set cap"/g)).toHaveLength(2);

    const setupFeeRow = pricing?.match(
      /<tr data-comparison-feature="Setup \/ SMS activation fee">[\s\S]*?<\/tr>/,
    )?.[0];
    expect(setupFeeRow).toContain(
      'data-comparison-plan="chat_only" data-comparison-value="None"',
    );
    expect(setupFeeRow?.match(/data-comparison-value="\$25 one-time SMS activation fee"/g)).toHaveLength(3);

    const mmsRow = pricing?.match(
      /<tr data-comparison-feature="MMS availability">[\s\S]*?<\/tr>/,
    )?.[0];
    expect(mmsRow).toContain(
      'data-comparison-plan="chat_only" data-comparison-value="Not included"',
    );
    expect(mmsRow?.match(/data-comparison-value="Not defined"/g)).toHaveLength(3);

    for (const planKey of topPlanKeys) {
      const card = pricing?.match(
        new RegExp(
          `<article data-plan-card="${planKey}"[\\s\\S]*?<\\/article>`,
        ),
      )?.[0];
      const highlights = card?.match(
        new RegExp(
          `<ul data-plan-highlights="${planKey}"[\\s\\S]*?<\\/ul>`,
        ),
      )?.[0];

      expect(card).toBeDefined();
      expect(highlights?.match(/<li\b/g)).toHaveLength(5);
    }
  });

  it("preserves the exact prelaunch plan and SEO presentation when Chat Only is off", () => {
    const html = renderHomepage(false);
    const pricing = html.match(
      /<section id="pricing"[\s\S]*?<\/section>/,
    )?.[0];
    const content = getHomepageSeoContent(false);

    expect(visibleText(pricing ?? "")).not.toContain("Chat Only");
    expect(pricing).not.toContain('data-plan-card="chat_only"');
    expect(pricing).not.toContain('data-plan-details="chat_only"');
    expect(pricing).not.toContain("data-sms-only-footnote");
    expect(pricing?.match(/data-plan-card=/g)).toHaveLength(3);
    expect(pricing?.match(/data-plan-details=/g)).toHaveLength(3);
    expect(
      Array.from(
        pricing?.matchAll(/data-plan-card="([^"]+)"/g) ?? [],
        (match) => match[1],
      ),
    ).toEqual(["sms_only", "sms_and_chat", "full"]);
    expect(pricing).toContain("<table");
    expect(visibleText(html)).toContain(HOME_DEFINITION);
    expect(content.faqs).toBe(HOME_FAQS);
    expect(content.title).toBe(HOME_TITLE);
    expect(content.description).toBe(HOME_DESCRIPTION);
  });

  it("uses launch-specific visible definition and FAQ copy only when enabled", () => {
    const html = renderHomepage(true);
    const faqSection = html.match(/<section id="faq"[\s\S]*?<\/section>/)?.[0];
    const launched = getHomepageSeoContent(true);

    expect(html).toContain(launched.definition);
    expect(launched.faqs).toBe(CHAT_ONLY_HOME_FAQS);
    expect(faqSection?.match(/<h3\b/g)).toHaveLength(
      CHAT_ONLY_HOME_FAQS.length,
    );
    for (const { question, answer } of CHAT_ONLY_HOME_FAQS) {
      expect(visibleText(faqSection ?? "")).toContain(question);
      expect(visibleText(faqSection ?? "")).toContain(answer);
    }
  });
});

describe("homepage JSON-LD", () => {
  it("emits one valid graph with two purchasable offers and FAQ parity", () => {
    const html = renderHomepage();
    const jsonScript = html.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/
    );

    expect(jsonScript).not.toBeNull();
    expect(html.match(/type="application\/ld\+json"/g)).toHaveLength(1);

    const data = JSON.parse(jsonScript?.[1] ?? "{}") as {
      "@context": string;
      "@graph": JsonRecord[];
    };
    expect(data["@context"]).toBe("https://schema.org");
    expect(data["@graph"].map((node) => node["@type"])).toEqual([
      "Organization",
      "SoftwareApplication",
      "FAQPage",
    ]);

    const organization = data["@graph"].find(
      (node) => node["@type"] === "Organization"
    );
    expect(organization).toMatchObject({
      name: "SimplAssist",
      url: "https://simplassist.com/",
      logo: "https://simplassist.com/logo-light.png",
    });

    const application = data["@graph"].find(
      (node) => node["@type"] === "SoftwareApplication"
    );
    expect(application).toMatchObject({
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
    });

    const offers = application?.offers as JsonRecord[];
    expect(offers).toHaveLength(2);
    expect(offers.map(({ name, price, priceCurrency }) => ({
      name,
      price,
      priceCurrency,
    }))).toEqual([
      { name: "SMS Only", price: 25, priceCurrency: "USD" },
      { name: "SMS + Web Chat", price: 45, priceCurrency: "USD" },
    ]);
    expect(offers.map((offer) => offer.name)).not.toContain("Full Suite");

    for (const offer of offers) {
      const specifications = offer.priceSpecification as JsonRecord[];
      expect(specifications).toHaveLength(2);
      expect(specifications).toContainEqual(
        expect.objectContaining({
          "@type": "UnitPriceSpecification",
          name: "Monthly subscription",
          price: offer.price,
          priceCurrency: "USD",
          billingDuration: "P1M",
        })
      );
      expect(specifications).toContainEqual({
        "@type": "PriceSpecification",
        name: "One-time SMS activation fee",
        price: 25,
        priceCurrency: "USD",
      });
    }

    const faqPage = data["@graph"].find(
      (node) => node["@type"] === "FAQPage"
    );
    expect(faqPage?.mainEntity).toEqual(
      HOME_FAQS.map(({ question, answer }) => ({
        "@type": "Question",
        name: question,
        acceptedAnswer: {
          "@type": "Answer",
          text: answer,
        },
      }))
    );

    const structuredDataKeys: string[] = [];
    JSON.stringify(getHomepageJsonLd(), (key, value) => {
      structuredDataKeys.push(key.toLowerCase());
      return value;
    });
    expect(structuredDataKeys).not.toContain("review");
    expect(structuredDataKeys).not.toContain("reviews");
    expect(structuredDataKeys).not.toContain("rating");
    expect(structuredDataKeys).not.toContain("aggregaterating");
  });

  it("adds one no-setup-fee Chat Only offer with launch FAQ parity", () => {
    const data = getHomepageJsonLd(true) as {
      "@graph": JsonRecord[];
    };
    const application = data["@graph"].find(
      (node) => node["@type"] === "SoftwareApplication",
    );
    const offers = application?.offers as JsonRecord[];
    const chatOffer = offers.find((offer) => offer.name === "Chat Only");

    expect(offers.map(({ name, price }) => ({ name, price }))).toEqual([
      { name: "Chat Only", price: 10 },
      { name: "SMS Only", price: 25 },
      { name: "SMS + Web Chat", price: 45 },
    ]);
    expect(chatOffer).toMatchObject({
      price: 10,
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
    });
    expect(chatOffer?.priceSpecification).toEqual([
      expect.objectContaining({
        "@type": "UnitPriceSpecification",
        price: 10,
        billingDuration: "P1M",
      }),
    ]);
    expect(JSON.stringify(chatOffer)).not.toContain("activation fee");

    const faqPage = data["@graph"].find(
      (node) => node["@type"] === "FAQPage",
    );
    expect(faqPage?.mainEntity).toEqual(
      CHAT_ONLY_HOME_FAQS.map(({ question, answer }) => ({
        "@type": "Question",
        name: question,
        acceptedAnswer: {
          "@type": "Answer",
          text: answer,
        },
      })),
    );
  });
});
