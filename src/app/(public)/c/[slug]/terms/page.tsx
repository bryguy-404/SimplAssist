import { loadReviewLegalProgram } from "@/lib/legal/reviewProgram.server";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { LegalDocLayout } from "@/components/legal/LegalDocLayout";
import { LegalSection } from "@/components/legal/legal-section";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  buildTermsContent,
  type LegalTemplateBusiness,
} from "@/lib/legal/perBusinessCopy";
import { getActiveSmsNumberForBusiness } from "@/lib/messaging/phoneNumberLookup";
import { isPendingSlug } from "@/lib/util/slug.shared";

/**
 * Per-business terms of service (Phase 6).
 *
 * Public, unauthenticated. See the matching privacy/page.tsx for column-
 * projection rules — same PII boundary applies here.
 */

type PageProps = { params: Promise<{ slug: string }> };

export const dynamic = "force-dynamic";

const PUBLIC_PROJECTION =
  "id, slug, name, email, phone_number, address, city, state, zip, review_sms_signup_enabled, opt_in_description";

async function loadBusiness(
  slug: string
): Promise<(LegalTemplateBusiness & { slug: string }) | null> {
  if (isPendingSlug(slug)) return null;

  const { data, error } = await supabaseAdmin
    .from("businesses")
    .select(PUBLIC_PROJECTION)
    .eq("slug", slug)
    .maybeSingle();

  if (error || !data) return null;

  const business = data as unknown as LegalTemplateBusiness & {
    id: string;
    slug: string;
  };

  const [smsPhoneNumber, reviewProgram] = await Promise.all([
    getActiveSmsNumberForBusiness(business.id),
    loadReviewLegalProgram(business),
  ]);

  return {
    ...business,
    ...reviewProgram,
    sms_phone_number: smsPhoneNumber,
  };
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const business = await loadBusiness(slug);
  if (!business) return { title: "Terms of Service" };
  return {
    title: `${business.name} — Terms of Service`,
    description: `Terms of service for the SMS messaging program operated by ${business.name}.`,
  };
}

export default async function PerBusinessTermsPage({ params }: PageProps) {
  const { slug } = await params;
  const business = await loadBusiness(slug);
  if (!business) notFound();

  const doc = buildTermsContent(business);

  return (
    <LegalDocLayout
      title="Terms of Service"
      lastUpdated={doc.lastUpdated}
      backHref={`/c/${business.slug}`}
      backLabel={`Back to ${business.name}`}
      siblingHref={`/c/${business.slug}/privacy`}
      siblingLabel="Privacy Policy"
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
