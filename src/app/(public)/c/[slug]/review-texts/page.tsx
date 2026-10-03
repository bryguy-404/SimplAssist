import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isPendingSlug } from "@/lib/util/slug.shared";
import { isReviewSmsEnabled } from "@/lib/billing/reviewSmsRollout.server";
import { getActiveSmsNumberForBusiness } from "@/lib/messaging/phoneNumberLookup";
import {
  PublicPageShell,
  publicHeaderLink,
} from "@/components/legal/LegalDocLayout";
import { body, card, ink, inlineLink } from "@/lib/theme-v2/theme";
import {
  REVIEW_TEXT_CONSENT_VERSION,
  reviewConsentConfirmation,
} from "@/lib/reviews/consentCopy";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Review text permission",
  robots: { index: false, follow: false },
};
type PageProps = { params: Promise<{ slug: string }> };

export default async function ReviewTextsConsentPage({ params }: PageProps) {
  const { slug } = await params;
  if (isPendingSlug(slug)) notFound();
  // Public-safe projection: no registration identity or business address.
  const { data: business, error } = await supabaseAdmin
    .from("businesses")
    .select(
      "id,slug,name,email,owner_id,deleted_at,operations_suspended_at,texting_paused_at,telnyx_submission_disabled,review_sms_signup_enabled",
    )
    .eq("slug", slug)
    .maybeSingle();
  if (
    error ||
    !business ||
    !business.owner_id ||
    business.deleted_at ||
    business.operations_suspended_at ||
    business.texting_paused_at ||
    business.telnyx_submission_disabled ||
    !isReviewSmsEnabled(business.id)
  )
    notFound();
  const account = await supabaseAdmin
    .from("review_sms_accounts")
    .select("state")
    .eq("business_id", business.id)
    .maybeSingle();
  if (account.error) throw new Error("Review text setup unavailable");
  if (!business.review_sms_signup_enabled && !account.data) notFound();
  if (
    account.data &&
    ["release_pending", "released"].includes(account.data.state)
  )
    notFound();
  const phone = await getActiveSmsNumberForBusiness(business.id);
  const ready =
    account.data && ["active", "cancel_pending"].includes(account.data.state);
  return (
    <PublicPageShell
      headerLeft={
        <span className={`text-sm font-semibold ${ink}`}>{business.name}</span>
      }
      headerRight={
        <>
          <Link className={publicHeaderLink} href={`/c/${slug}/privacy`}>
            Privacy
          </Link>
          <Link className={publicHeaderLink} href={`/c/${slug}/terms`}>
            Terms
          </Link>
        </>
      }
      footer={
        <p className={`mt-8 text-center text-xs ${body}`}>
          Messaging service powered by SimplAssist.
        </p>
      }
    >
      <article
        className={`p-8 sm:p-10 ${card}`}
        data-consent-version={REVIEW_TEXT_CONSENT_VERSION}
      >
        <h1 className={`text-3xl font-bold tracking-tight ${ink}`}>
          Review texts from {business.name}
        </h1>
        <p className={`mt-5 leading-relaxed ${body}`}>
          After a completed service, {business.name} can text you a link to
          leave an honest Google review. Your feedback is welcome, whatever your
          experience.
        </p>
        <p className={`mt-5 leading-relaxed ${body}`}>
          By texting <strong>REVIEWS</strong>
          {phone ? (
            <>
              {" "}
              to <strong>{phone}</strong>
            </>
          ) : null}
          , you agree to receive automated marketing text messages from{" "}
          {business.name} requesting Google reviews. You may receive up to 2
          review messages per completed service, plus an opt-in confirmation.
          Message and data rates may apply.
        </p>
        <p className={`mt-4 leading-relaxed ${body}`}>
          Your permission is voluntary and is not a condition of purchase.
          Buying a service, providing your phone number, contacting customer
          care, or texting START does not sign you up for review requests.
        </p>
        <p className={`mt-4 leading-relaxed ${body}`}>
          Reply <strong>STOP</strong> to opt out or <strong>HELP</strong> for
          help.
          {business.email ? (
            <>
              {" "}
              You can also contact{" "}
              <a href={`mailto:${business.email}`} className={inlineLink}>
                {business.email}
              </a>
              .
            </>
          ) : null}
        </p>
        <p className={`mt-4 leading-relaxed ${body}`}>
          If you previously sent STOP, first text START to restore messaging,
          then send REVIEWS to give separate permission for review texts.
        </p>
        <p className={`mt-4 leading-relaxed ${body}`}>
          Read the{" "}
          <Link href={`/c/${slug}/privacy`} className={inlineLink}>
            Privacy Policy
          </Link>{" "}
          and{" "}
          <Link href={`/c/${slug}/terms`} className={inlineLink}>
            Terms of Service
          </Link>
          . Mobile information and opt-in consent are not shared with third
          parties for their marketing.
        </p>
        <p className={`mt-5 text-sm font-semibold ${ink}`}>
          Opt-in confirmation
        </p>
        <blockquote
          className={`mt-2 border-l-2 border-[#ea580c] pl-4 text-sm leading-relaxed ${body}`}
        >
          {reviewConsentConfirmation(business.name)}
        </blockquote>
        {phone && ready ? (
          <>
            <a
              href={`sms:${phone}?body=REVIEWS`}
              className="mt-7 inline-flex rounded-full bg-[#c2410c] px-6 py-3 font-semibold text-white hover:bg-[#9a3412] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4"
            >
              Text REVIEWS to {phone}
            </a>
            <p className={`mt-3 text-sm ${body}`}>
              This opens your messaging app. Review the message and send it
              yourself to confirm permission. Opening this page or tapping the
              button does not sign you up.
            </p>
          </>
        ) : (
          <p className={`mt-7 font-semibold ${ink}`}>
            Review-text sign-up will be available here when messaging setup is
            ready. No permission is collected on this page.
          </p>
        )}
      </article>
    </PublicPageShell>
  );
}
