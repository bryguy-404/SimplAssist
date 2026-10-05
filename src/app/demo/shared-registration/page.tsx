import Link from "next/link";
import type { Metadata } from "next";
import { assertDemoPagesEnabled } from "../_lib/guard";
import type { ReviewSmsOverview } from "@/lib/billing/reviewSms";
import { ReviewSmsRegistrationFields, ReviewSmsRegistrationNotice } from "@/components/reviews/ReviewSmsRegistration";
import { PublicPageShell, publicHeaderLink } from "@/components/legal/LegalDocLayout";
import { LegalSection } from "@/components/legal/legal-section";
import { buildPrivacyContent, buildTermsContent } from "@/lib/legal/perBusinessCopy";
import { ThemeToggleV2 } from "@/lib/theme-v2/ui";
import { body, card, ink } from "@/lib/theme-v2/theme";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  assertDemoPagesEnabled();
  return { title: "Shared registration — synthetic preview", robots: { index: false, follow: false } };
}

/** Visual verification only. Uses the real presentation components with made-up
 * values and provides no form, provider action, authentication, or API request. */
export default function SharedRegistrationPreview({ searchParams }: {
  searchParams?: { state?: string; view?: string };
}) {
  assertDemoPagesEnabled();
  const status = searchParams?.state === "revoked" ? "revoked" : searchParams?.state === "active" ? "active" : "approved";
  const publicView = searchParams?.view === "public";
  const overview: ReviewSmsOverview = {
    enabled: true, account: null, canSend: false, eligibleSource: "direct",
    sharedRegistration: { status, legalBusinessName: "Example Operator LLC", identityVersion: 1 },
    price: { monthlyCents: 2000, activationCents: 2500, includedParts: 250 },
    setup: { missing: [], fields: {
      legalBusinessName: "Example Operator LLC", address: "100 Synthetic Private Street",
      city: "South Bend", state: "IN", zip: "46601", entityType: "llc", hasEin: true,
      identityLocked: true, representativeEditable: status === "approved", publicAddressVisibility: "city_state", authorizedRepName: status === "approved" ? "" : "Example Owner",
      authorizedRepEmail: status === "approved" ? "" : "owner@example.test", authorizedRepPhone: status === "approved" ? "" : "+15745550123",
    } },
  };
  const publicBusiness = {
    name: "Example Studio", legal_operator_name: "Example Operator LLC", public_address_visibility: "city_state" as const,
    phone_number: null, sms_phone_number: "+15745550124", email: "help@example.test",
    address: null, city: "South Bend", state: "IN", zip: null, opt_in_description: null,
    review_sms_only: true, review_consent_url: "https://example.test/review-texts",
  };
  return (
    <PublicPageShell headerLeft={<span className={`text-sm font-semibold ${ink}`}>Synthetic local preview</span>}
      headerRight={<ThemeToggleV2 />} footer={<p className={`mt-8 text-center text-xs ${body}`}>Synthetic fixture. No customer or carrier data.</p>}>
      <main className={`p-5 sm:p-8 ${card}`}>
        <h1 className={`text-2xl font-semibold ${ink}`}>Shared registration preview</h1>
        <p className={`mt-3 text-sm ${body}`}>Made-up account details for visual testing. This page cannot register a business, charge a card, or send messages.</p>
        <nav aria-label="Preview state" className="mt-4 flex flex-wrap gap-4">
          <Link className={publicHeaderLink} href="?state=approved">Staged setup</Link>
          <Link className={publicHeaderLink} href="?state=revoked">Revoked setup</Link>
          <Link className={publicHeaderLink} href="?view=public">Public policy copy</Link>
        </nav>
        {publicView ? <div className="mt-6 space-y-8">
          <p className={`text-sm ${body}`}>Public view: Example Studio is operated by Example Operator LLC. South Bend, IN.</p>
          {[{ title: "Privacy Policy", doc: buildPrivacyContent(publicBusiness) }, { title: "Terms of Service", doc: buildTermsContent(publicBusiness) }].map(({ title, doc }) => (
            <section key={title}>
              <h2 className={`text-xl font-semibold ${ink}`}>{title}</h2>
              {doc.sections.map((section) => <LegalSection key={section.title} title={section.title}>
                {section.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
              </LegalSection>)}
            </section>
          ))}
        </div> : <div className="mt-6 space-y-6">
          <ReviewSmsRegistrationNotice overview={overview} />
          <fieldset className="space-y-4">
            <legend className={`mb-4 font-semibold ${ink}`}>Private owner setup — synthetic details</legend>
            <ReviewSmsRegistrationFields overview={overview} id="synthetic-registration" />
          </fieldset>
        </div>}
      </main>
    </PublicPageShell>
  );
}
