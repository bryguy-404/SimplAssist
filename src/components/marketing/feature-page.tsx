import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { MarketingFooter, MarketingHeader } from "./navigation";
import { SITE_ORIGIN, serializeJsonLd } from "@/app/(public)/home/seo";
import { accentText, body, card, darkAmbient, fontStack, ink, lightAmbient, pageShell } from "@/lib/theme-v2/theme";

export function featureMetadata(path: string, title: string, description: string): Metadata {
  const url = `${SITE_ORIGIN}${path}`;
  return {
    title, description,
    alternates: { canonical: url },
    openGraph: { title, description, url, type: "website", images: [{ url: `${SITE_ORIGIN}/social-preview.png`, width: 1200, height: 630, alt: "SimplAssist" }] },
    twitter: { card: "summary_large_image", title, description, images: [`${SITE_ORIGIN}/social-preview.png`] },
  };
}

export function FeaturePage({ path, title, description, breadcrumb, children }: {
  path: string; title: string; description: string; breadcrumb: string; children: ReactNode;
}) {
  const url = `${SITE_ORIGIN}${path}`;
  return (
    <div className={`${pageShell} isolate`} style={{ fontFamily: fontStack }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "WebPage", "@id": `${url}#webpage`, url, name: title, description, breadcrumb: { "@id": `${url}#breadcrumb` } },
          { "@type": "BreadcrumbList", "@id": `${url}#breadcrumb`, itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: `${SITE_ORIGIN}/` },
            { "@type": "ListItem", position: 2, name: breadcrumb, item: url },
          ] },
        ],
      }) }} />
      <div className="pointer-events-none fixed inset-0 -z-10 dark:hidden" style={{ background: lightAmbient }} />
      <div className="pointer-events-none fixed inset-0 -z-10 hidden dark:block" style={{ background: darkAmbient }} />
      <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-2 focus:z-[60] focus:rounded-lg focus:bg-white focus:p-3 focus:text-stone-900">Skip to content</a>
      <MarketingHeader />
      <div className="relative mx-auto w-[min(calc(100%-32px),1200px)] pt-28 sm:pt-36">
        <nav aria-label="Breadcrumb" className={`mb-9 flex flex-wrap items-center gap-2 text-sm ${body}`}>
          <Link href="/" className="hover:underline">Home</Link><span aria-hidden="true">/</span><span aria-current="page">{breadcrumb}</span>
        </nav>
        <main id="main-content">{children}</main>
        <MarketingFooter />
      </div>
    </div>
  );
}

export const featureHeading = `text-[clamp(38px,5.4vw,66px)] font-extrabold leading-[1.04] tracking-[-0.045em] text-balance ${ink}`;
export const sectionHeading = `text-[clamp(28px,3.5vw,42px)] font-extrabold leading-[1.12] tracking-[-0.035em] ${ink}`;

export function FeatureSteps({ title, steps }: { title: string; steps: readonly { title: string; text: string }[] }) {
  return (
    <section className="py-14 sm:py-20">
      <h2 className={sectionHeading}>{title}</h2>
      <ol className="mt-8 grid gap-5 md:grid-cols-3">
        {steps.map((step, index) => (
          <li key={step.title} className={`${card} p-6 sm:p-8`}>
            <span aria-hidden="true" className={`text-sm font-extrabold ${accentText}`}>0{index + 1}</span>
            <h3 className={`mt-4 text-xl font-bold ${ink}`}>{step.title}</h3>
            <p className={`mt-3 leading-7 ${body}`}>{step.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function FeatureFaqs({ title, faqs }: { title: string; faqs: readonly { question: string; answer: string }[] }) {
  return (
    <section className="py-14 sm:py-20">
      <h2 className={sectionHeading}>{title}</h2>
      <div className="mt-8 grid gap-4">
        {faqs.map(({ question, answer }) => (
          <details key={question} className={`${card} group`}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-[28px] p-6 font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-600 [&::-webkit-details-marker]:hidden">
              {question}<ChevronDown aria-hidden="true" className="h-5 w-5 shrink-0 transition-transform group-open:rotate-180" />
            </summary>
            <p className={`${body} px-6 pb-6 leading-7`}>{answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
