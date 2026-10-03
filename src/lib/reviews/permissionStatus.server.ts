import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ReviewError, reviewRpc } from "./service.server";
import type { ReviewPermissionSummary } from "./types";
import { reviewConsentUrl } from "./consentCopy";
import { reviewOrigin } from "./domain";

export async function reviewPermissionStatus(
  businessId: string,
  ownerId: string,
  contactId: string | null,
) {
  if (!contactId || !/^[0-9a-f-]{36}$/i.test(contactId))
    throw new ReviewError("invalid_review_permission");
  await reviewRpc("review_assert_owner", {
    p_business: businessId,
    p_owner: ownerId,
  });
  const contact = await supabaseAdmin
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (contact.error) throw new ReviewError("review_storage_unavailable", 503);
  if (!contact.data) throw new ReviewError("review_customer_not_found", 404);
  const smsRequiresKeyword = await reviewRpc<boolean>(
    "review_sms_requires_keyword",
    { p_business: businessId },
  );
  let consentUrl: string | null = null;
  if (smsRequiresKeyword) {
    const business = await supabaseAdmin
      .from("businesses")
      .select("slug")
      .eq("id", businessId)
      .eq("owner_id", ownerId)
      .maybeSingle();
    if (business.error || !business.data)
      throw new ReviewError("review_storage_unavailable", 503);
    consentUrl = reviewConsentUrl(business.data.slug, reviewOrigin());
  }
  const permissions = await supabaseAdmin
    .from("review_permissions")
    .select(
      "destination,granted_at,revoked_at,evidence,actor_id,sms_consent_event_id",
    )
    .eq("business_id", businessId)
    .eq("contact_id", contactId)
    .order("granted_at", { ascending: false })
    .limit(20);
  if (permissions.error)
    throw new ReviewError("review_storage_unavailable", 503);
  const rows = permissions.data ?? [];
  if (!rows.length)
    return {
      permissions: [] as ReviewPermissionSummary[],
      smsRequiresKeyword: Boolean(smsRequiresKeyword),
      consentUrl,
    };
  const suppressed = await supabaseAdmin
    .from("review_suppressions")
    .select("identity")
    .eq("business_id", businessId)
    .in(
      "identity",
      rows.map(
        (p) =>
          `${p.destination.includes("@") ? "email" : "phone"}:${p.destination}`,
      ),
    );
  if (suppressed.error)
    throw new ReviewError("review_storage_unavailable", 503);
  const identities = new Set((suppressed.data ?? []).map((s) => s.identity));
  const keywordConsents = await Promise.all(
    rows.map((p) =>
      smsRequiresKeyword && !p.destination.includes("@")
        ? reviewRpc<boolean>("review_sms_has_keyword_consent", {
            p_business: businessId,
            p_contact: contactId,
            p_destination: p.destination,
          })
        : Promise.resolve(true),
    ),
  );
  return {
    smsRequiresKeyword: Boolean(smsRequiresKeyword),
    consentUrl,
    permissions: rows.map(
      (p, index) =>
        ({
          channel: p.destination.includes("@") ? "email" : "sms",
          destination: p.destination,
          status: identities.has(
            `${p.destination.includes("@") ? "email" : "phone"}:${p.destination}`,
          )
            ? "suppressed"
            : p.revoked_at
              ? "withdrawn"
              : !keywordConsents[index]
                ? "keyword_required"
                : "granted",
          grantedAt: p.granted_at,
          revokedAt: p.revoked_at,
          source:
            !p.actor_id && p.sms_consent_event_id
              ? "customer_keyword"
              : "owner",
          evidence:
            !p.actor_id && p.sms_consent_event_id
              ? "Customer sent REVIEWS from this phone after the review-text disclosures."
              : p.evidence,
        }) satisfies ReviewPermissionSummary,
    ),
  };
}
