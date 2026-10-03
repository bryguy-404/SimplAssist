import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Clock, Mail, MapPin, MessageSquareText, Phone } from "lucide-react";
import { ThemeToggleV2 } from "@/lib/theme-v2/ui";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { body, card, ink, inlineLink, tile } from "@/lib/theme-v2/theme";
import {
  PublicPageShell,
  publicHeaderLink,
} from "@/components/legal/LegalDocLayout";
import { buildSmsComplianceCopy } from "@/lib/messaging/complianceCopy";
import { getActiveSmsNumberForBusiness } from "@/lib/messaging/phoneNumberLookup";
import type { Language } from "@/types/database";
import { formatPhoneNumber } from "@/lib/utils";
import { isPendingSlug } from "@/lib/util/slug.shared";
import { loadReviewLegalProgram } from "@/lib/legal/reviewProgram.server";
import { reviewConsentDescription } from "@/lib/reviews/consentCopy";

/**
 * Per-business public landing page (Phase 6).
 *
 * Serves two purposes:
 *   1. The fallback URL submitted to Telnyx as `website` when the customer
 *      has no website_url of their own (see brand.ts).
 *   2. A reachable backstop from the per-business privacy/terms pages so
 *      a carrier reviewer who clicks "Back to {Business}" lands somewhere
 *      that confirms the brand identity.
 *
 * IMPORTANT — column projection: NEVER project ein, last_4_ssn,
 * registrant_mobile, authorized_rep_*, tax_id_type, or any other PII column.
 * The select() below is the canonical safe projection.
 */

type PageProps = { params: Promise<{ slug: string }> };

// The number is activated during launch. Never cache a pre-activation page
// that omits it; carrier reviewers must receive fresh server-rendered HTML.
export const dynamic = "force-dynamic";

const PUBLIC_PROJECTION =
  "id, slug, name, business_type, email, phone_number, address, city, state, zip, review_sms_signup_enabled, ai_settings(language)";

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

type PublicBusiness = {
  id: string;
  slug: string;
  name: string;
  business_type: string;
  email: string | null;
  phone_number: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  ai_settings: { language: Language } | null;
  review_sms_signup_enabled?: boolean;
};

type Hours = {
  day_of_week: number;
  open_time: string;
  close_time: string;
  is_closed: boolean;
};

async function loadBusiness(
  slug: string
): Promise<{
  business: PublicBusiness;
  hours: Hours[];
  smsPhoneNumber: string | null;
  reviewProgram: Awaited<ReturnType<typeof loadReviewLegalProgram>>;
} | null> {
  if (isPendingSlug(slug)) return null;

  const { data: business, error } = await supabaseAdmin
    .from("businesses")
    .select(PUBLIC_PROJECTION)
    .eq("slug", slug)
    .maybeSingle();

  if (error || !business) return null;

  const publicBusiness = business as unknown as PublicBusiness;
  const [smsPhoneNumber, reviewProgram, { data: hours }] = await Promise.all([
    getActiveSmsNumberForBusiness(publicBusiness.id),
    loadReviewLegalProgram(publicBusiness),
    supabaseAdmin.from("business_hours")
      .select("day_of_week, open_time, close_time, is_closed")
      .eq("business_id", publicBusiness.id).order("day_of_week"),
  ]);

  return {
    business: publicBusiness,
    reviewProgram,
    hours: (hours ?? []) as Hours[],
    smsPhoneNumber,
  };
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const loaded = await loadBusiness(slug);
  if (!loaded) return { title: "Business" };
  return {
    title: loaded.business.name,
    description: loaded.smsPhoneNumber
      ? `${loaded.business.name} — contact information, hours, and SMS messaging policies.`
      : `${loaded.business.name} — contact information and hours.`,
  };
}

function formatTime(t: string): string {
  // t is a Postgres "time" string like "09:00:00"
  const [hStr, mStr] = t.split(":");
  const h = parseInt(hStr ?? "0", 10);
  const m = parseInt(mStr ?? "0", 10);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  if (m === 0) return `${hour12} ${period}`;
  return `${hour12}:${m.toString().padStart(2, "0")} ${period}`;
}

function formatAddress(b: PublicBusiness): string | null {
  const cityState = [b.city, b.state].filter(Boolean).join(", ");
  const parts = [b.address, cityState, b.zip].filter(
    (p) => p && p.trim().length > 0
  );
  if (parts.length === 0) return null;
  return parts.join(", ");
}

export default async function BusinessLandingPage({ params }: PageProps) {
  const { slug } = await params;
  const loaded = await loadBusiness(slug);
  if (!loaded) notFound();
  const { business, hours, smsPhoneNumber, reviewProgram } = loaded;
  const address = formatAddress(business);
  const privacyHref = `/c/${business.slug}/privacy`;
  const smsCopy = smsPhoneNumber && !reviewProgram.review_sms_only
    ? buildSmsComplianceCopy({
        business,
        smsPhoneNumber,
        smsEntryPoint: `this page (/c/${business.slug})`,
        privacyUrl: privacyHref,
        language: business.ai_settings?.language,
      })
    : null;

  return (
    <PublicPageShell
      headerLeft={
        <span className={`text-sm font-semibold tracking-tight ${ink}`}>
          {business.name}
        </span>
      }
      headerRight={
        <>
          <Link href={`/c/${business.slug}/privacy`} className={publicHeaderLink}>
            Privacy
          </Link>
          <Link href={`/c/${business.slug}/terms`} className={publicHeaderLink}>
            Terms
          </Link>
          <ThemeToggleV2 />
        </>
      }
      footer={
        <p className={`mt-8 text-center text-xs ${body}`}>
          &copy; {new Date().getFullYear()} {business.name}. Messaging service powered by SimplAssist.
        </p>
      }
    >
      <article className={`p-8 sm:p-10 lg:p-12 ${card}`}>
        <h1
          className={`text-[clamp(1.75rem,4vw,2.25rem)] font-bold tracking-tight ${ink}`}
        >
          {business.name}
        </h1>

        {(reviewProgram.review_sms_only || reviewProgram.review_sms_signup_enabled) && (
          <section className={`mt-8 p-5 ${tile}`} aria-labelledby="review-texts-heading">
            <h2 id="review-texts-heading" className={`text-lg font-semibold ${ink}`}>Review requests by text</h2>
            <p className={`mt-3 text-sm ${body}`}>
              {reviewConsentDescription(business.name, smsPhoneNumber ?? 'your assigned business number once approved', reviewProgram.review_consent_url)}
            </p>
            <Link href={`/c/${business.slug}/review-texts`} className={`${inlineLink} mt-3 inline-block`}>Read the review-text disclosure and subscribe</Link>
          </section>
        )}

        {smsPhoneNumber && smsCopy && (
          <section
            aria-labelledby="sms-contact-heading"
            className="mt-8 rounded-[24px] border border-[#f2c9a5] bg-[#fdf1e7] p-5 sm:p-6 dark:border-[rgba(255,145,77,0.28)] dark:bg-[rgba(255,145,77,0.10)]"
          >
            <h2
              id="sms-contact-heading"
              className="text-sm font-bold uppercase tracking-[0.14em] text-[#9a3412] dark:text-[#ffd7bf]"
            >
              SMS customer care
            </h2>
            <a
              href={`sms:${smsPhoneNumber}`}
              aria-label={`Text ${business.name} at ${smsPhoneNumber}`}
              className="mt-3 inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-full bg-[#c2410c] px-5 py-3 text-base font-bold text-white transition-colors hover:bg-[#9a3412] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#c2410c]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#fdf1e7] dark:bg-[#ff914d] dark:text-[#16100b] dark:hover:bg-[#f57f33] dark:focus-visible:ring-[#ff914d]/60 dark:focus-visible:ring-offset-[#17110d]"
            >
              <MessageSquareText className="h-5 w-5 shrink-0" aria-hidden />
              <span>Text us at</span>
              <span dir="ltr" className="font-mono tracking-tight">
                {smsPhoneNumber}
              </span>
            </a>
            <p className={`mt-4 text-[15px] leading-relaxed ${body}`}>
              {smsCopy.disclosures.purpose}
            </p>
          </section>
        )}

        <div className={`mt-8 grid gap-4 ${body}`}>
          {business.phone_number && (
            <a
              href={`tel:${business.phone_number}`}
              className="inline-flex items-center gap-3 text-base transition-colors hover:text-[#c2410c] dark:hover:text-[#ff914d]"
            >
              <Phone className="h-4 w-4 shrink-0" aria-hidden />
              <span>
                <span className="font-semibold text-stone-700 dark:text-[#d4d4d8]">
                  Call us at
                </span>{" "}
                {formatPhoneNumber(business.phone_number)}
              </span>
            </a>
          )}
          {business.email && (
            <a
              href={`mailto:${business.email}`}
              className="inline-flex items-center gap-3 text-base transition-colors hover:text-[#c2410c] dark:hover:text-[#ff914d]"
            >
              <Mail className="h-4 w-4 shrink-0" aria-hidden />
              <span>{business.email}</span>
            </a>
          )}
          {address && (
            <div className="inline-flex items-start gap-3 text-base">
              <MapPin className="h-4 w-4 shrink-0 mt-1" aria-hidden />
              <span>{address}</span>
            </div>
          )}
        </div>

        {hours.length > 0 && (
          <section className="mt-10">
            <h2
              className={`mb-3 inline-flex items-center gap-2 text-lg font-semibold tracking-tight sm:text-xl ${ink}`}
            >
              <Clock className="h-5 w-5 shrink-0" aria-hidden />
              Hours
            </h2>
            <ul className={`space-y-1.5 text-[15px] sm:text-base ${body}`}>
              {hours.map((h) => (
                <li key={h.day_of_week} className="flex justify-between gap-6">
                  <span>{DAY_NAMES[h.day_of_week]}</span>
                  <span>
                    {h.is_closed
                      ? "Closed"
                      : `${formatTime(h.open_time)} – ${formatTime(h.close_time)}`}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {smsPhoneNumber && smsCopy && (
          <section className="mt-12" aria-labelledby="sms-compliance-heading">
            <h2
              id="sms-compliance-heading"
              className={`text-xl font-semibold tracking-tight sm:text-2xl ${ink}`}
            >
              SMS opt-in and program details
            </h2>
            <p className={`mt-3 text-[15px] leading-relaxed sm:text-base ${body}`}>
              {smsCopy.optInPaths.introduction}
            </p>

            <div className="mt-6 grid gap-5">
              <section className={`p-5 sm:p-6 ${tile}`}>
                <h3 className={`text-base font-semibold sm:text-lg ${ink}`}>
                  Text-message opt-in
                </h3>
                <p className={`mt-2 text-[15px] leading-relaxed ${body}`}>
                  {smsCopy.optInPaths.inboundSms}
                </p>
                <p className={`mt-4 text-sm font-semibold ${ink}`}>
                  Confirmation SMS
                </p>
                <blockquote
                  className={`mt-2 whitespace-pre-line border-l-2 border-[#ea580c] pl-4 text-[15px] italic leading-relaxed dark:border-[#ff914d] ${body}`}
                >
                  “{smsCopy.confirmationSms}”
                </blockquote>
              </section>

              <section className={`p-5 sm:p-6 ${tile}`}>
                <h3 className={`text-base font-semibold sm:text-lg ${ink}`}>
                  Voicemail opt-in
                </h3>
                <p className={`mt-2 text-[15px] leading-relaxed ${body}`}>
                  {smsCopy.optInPaths.voicemail}
                </p>
                <p className={`mt-3 text-[15px] leading-relaxed ${body}`}>
                  {smsCopy.optInPaths.callForwarding}
                </p>
                <p className={`mt-4 text-sm font-semibold ${ink}`}>
                  What callers hear before leaving a message
                </p>
                <blockquote
                  className={`mt-2 border-l-2 border-[#ea580c] pl-4 text-[15px] italic leading-relaxed dark:border-[#ff914d] ${body}`}
                >
                  “{smsCopy.voicemailGreeting}”
                </blockquote>
              </section>
            </div>

            <h3 className={`mt-8 text-base font-semibold sm:text-lg ${ink}`}>
              Program disclosures
            </h3>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className={`p-4 ${tile}`}>
                <dt className={`text-sm font-semibold ${ink}`}>
                  Message frequency
                </dt>
                <dd className={`mt-1 text-sm leading-relaxed ${body}`}>
                  {smsCopy.disclosures.frequency}
                </dd>
              </div>
              <div className={`p-4 ${tile}`}>
                <dt className={`text-sm font-semibold ${ink}`}>
                  Message and data rates
                </dt>
                <dd className={`mt-1 text-sm leading-relaxed ${body}`}>
                  {smsCopy.disclosures.rates}
                </dd>
              </div>
              <div className={`p-4 ${tile}`}>
                <dt className={`text-sm font-semibold ${ink}`}>HELP</dt>
                <dd className={`mt-1 text-sm leading-relaxed ${body}`}>
                  {smsCopy.disclosures.help}
                </dd>
              </div>
              <div className={`p-4 ${tile}`}>
                <dt className={`text-sm font-semibold ${ink}`}>STOP</dt>
                <dd className={`mt-1 text-sm leading-relaxed ${body}`}>
                  {smsCopy.disclosures.stop}
                </dd>
              </div>
              <div className={`p-4 sm:col-span-2 ${tile}`}>
                <dt className={`text-sm font-semibold ${ink}`}>
                  Mobile information sharing
                </dt>
                <dd className={`mt-1 text-sm leading-relaxed ${body}`}>
                  {smsCopy.disclosures.mobileInformationSharing}
                </dd>
              </div>
              <div className={`p-4 sm:col-span-2 ${tile}`}>
                <dt className={`text-sm font-semibold ${ink}`}>
                  Privacy Policy
                </dt>
                <dd className={`mt-1 text-sm leading-relaxed ${body}`}>
                  <Link
                    href={privacyHref}
                    className={`${inlineLink} underline-offset-2 hover:underline`}
                  >
                    {smsCopy.disclosures.privacyPolicy}
                  </Link>
                </dd>
              </div>
            </dl>

            <p className={`mt-5 text-sm ${body}`}>
              See also our{" "}
              <Link
                href={`/c/${business.slug}/terms`}
                className={`${inlineLink} underline-offset-2 hover:underline`}
              >
                Terms of Service
              </Link>
              .
            </p>
          </section>
        )}
      </article>
    </PublicPageShell>
  );
}
