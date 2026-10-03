import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { reviewConsentUrl } from "@/lib/reviews/consentCopy";

/** Only public program scope is returned; payment and registration data never
 * enter the legal page's rendered business object. */
export async function loadReviewLegalProgram(business: {
  id: string;
  slug: string;
  review_sms_signup_enabled?: boolean;
}) {
  const { data, error } = await supabaseAdmin
    .from("review_sms_accounts")
    .select("billing_source, state, draft")
    .eq("business_id", business.id)
    .maybeSingle();
  if (error) throw new Error("Unable to load texting program disclosures");
  const reviewOnly = data?.billing_source === "direct" &&
    data.state !== "released" && data.draft?.consentMode === "hosted_keyword";
  return {
    review_sms_signup_enabled: business.review_sms_signup_enabled === true,
    review_sms_only: reviewOnly,
    review_consent_url: reviewConsentUrl(business.slug, process.env.NEXT_PUBLIC_APP_URL ?? "https://simplassist.com"),
  };
}
