import { loadReviewLegalProgram } from "@/lib/legal/reviewProgram.server";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { LegalDocLayout } from "@/components/legal/LegalDocLayout";
import { LegalSection } from "@/components/legal/legal-section";
import {
  buildPrivacyContent,
  type LegalTemplateBusiness,
} from "@/lib/legal/perBusinessCopy";
import { getActiveSmsNumberForBusiness } from "@/lib/messaging/phoneNumberLookup";
import { loadPublicBusiness } from "@/lib/legal/publicBusiness.server";

/**
 * Per-business privacy policy (Phase 6).
 *
 * Public, unauthenticated. Carrier reviewers (T-Mobile/AT&T/Verizon, TCR) hit
 * this URL when reviewing the campaign registered for this business.
 *
 * IMPORTANT — column projection: this page MUST only read public-safe
 * fields. NEVER project ein, last_4_ssn, registrant_mobile, authorized_rep_*,
 * tax_id_type, or any other PII column on `businesses`. loadPublicBusiness
 * includes id only so the server can read the active SimplAssist number; id
 * is not rendered into the public page.
 */

type PageProps = { params: Promise<{ slug: string }> };

export const dynamic = "force-dynamic";

async function loadBusiness(
  slug: string
): Promise<(LegalTemplateBusiness & { slug: string }) | null> {
  const business = await loadPublicBusiness(slug);
  if (!business) return null;

  const [smsPhoneNumber, reviewProgram] = await Promise.all([
    getActiveSmsNumberForBusiness(business.id),
    loadReviewLegalProgram(business),
  ]);

  return {
    ...business,
    ...reviewProgram,
    opt_in_description: null,
    language: business.ai_settings?.language,
    sms_phone_number: smsPhoneNumber,
  };
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const business = await loadBusiness(slug);
  if (!business) return { title: "Privacy Policy" };
  return {
    title: `${business.name} — Privacy Policy`,
    description: `Privacy policy and SMS messaging disclosures for ${business.name}.`,
  };
}

export default async function PerBusinessPrivacyPage({ params }: PageProps) {
  const { slug } = await params;
  const business = await loadBusiness(slug);
  if (!business) notFound();

  const doc = buildPrivacyContent(business);

  return (
    <LegalDocLayout
      title="Privacy Policy"
      lastUpdated={doc.lastUpdated}
      backHref={`/c/${business.slug}`}
      backLabel={`Back to ${business.name}`}
      siblingHref={`/c/${business.slug}/terms`}
      siblingLabel="Terms of Service"
      businessName={business.name}
    >
      {doc.sections.map((section) => (
        <LegalSection key={section.title} title={section.title}>
          {section.paragraphs.map((p, idx) => (
            <p key={idx}>{p}</p>
          ))}
        </LegalSection>
      ))}
    </LegalDocLayout>
  );
}
