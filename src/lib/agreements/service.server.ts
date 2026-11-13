import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { currentServiceTerms, type ServiceTermsDocument } from "./current.server";
import { type ServiceAgreementStatus, type ServiceAgreementSummary } from "./shared";

export type AgreementSource = "onboarding" | "billing_checkout" | "plan_change" | "texting_upgrade" | "review_texting" | "billing_settings";
export type AgreementRecord = ServiceAgreementSummary & { business_id: string; subscriber_id: string };
export type AgreementReference = { kind: string; reference: string; recorded_at: string };
import { ServiceAgreementError } from "./errors";
export { ServiceAgreementError } from "./errors";
const unavailable = () => new ServiceAgreementError("service_agreement_unavailable");

export async function listServiceAgreements(businessId: string): Promise<AgreementRecord[]> {
  const { data, error } = await supabaseAdmin.from("service_agreements").select("*")
    .eq("business_id", businessId).order("accepted_at", { ascending: false });
  if (error || !data) throw unavailable();
  return data;
}
export async function serviceAgreementStatus(businessId: string, subscriberId: string): Promise<ServiceAgreementStatus> {
  const records = await listServiceAgreements(businessId);
  const termsVersion = currentServiceTerms().version;
  return { termsVersion, accepted: records.some((r) => r.subscriber_id === subscriberId && r.terms_version === termsVersion), records };
}

/** Called only from an authenticated, owner-authorized submitted confirmation. */
export async function requireServiceAgreement(
  businessId: string, subscriberId: string, confirmation: unknown, source: AgreementSource,
): Promise<string> {
  const document = currentServiceTerms();
  const { data: existing, error } = await supabaseAdmin.from("service_agreements").select("id")
    .eq("business_id", businessId).eq("subscriber_id", subscriberId).eq("terms_version", document.version).maybeSingle();
  if (error) throw unavailable();
  if (existing) return existing.id;
  if (!confirmation || typeof confirmation !== "object" || !("accepted" in confirmation) || confirmation.accepted !== true)
    throw new ServiceAgreementError("service_agreement_required", 400);
  if (!("termsVersion" in confirmation) || confirmation.termsVersion !== document.version)
    throw new ServiceAgreementError("service_agreement_changed", 409);

  // Archive the full document before recording acceptance. Never overwrite an
  // existing version or infer acceptance from an SMS flag / payment timestamp.
  const archived = await supabaseAdmin.from("service_terms_versions").upsert(document, { onConflict: "version", ignoreDuplicates: true });
  if (archived.error) throw unavailable();
  const saved = await supabaseAdmin.from("service_terms_versions").select("*").eq("version", document.version).single();
  if (saved.error || !saved.data || Object.entries(document).some(([key, value]) => saved.data[key] !== value)) throw unavailable();
  const result = await supabaseAdmin.rpc("record_service_agreement", {
    p_business_id: businessId, p_subscriber_id: subscriberId, p_terms_version: document.version, p_source: source,
  });
  const recorded = Array.isArray(result.data) ? result.data[0] : result.data;
  if (result.error || !recorded?.id) throw unavailable();
  return recorded.id;
}

export async function linkServiceAgreementReference(
  agreementId: string | undefined, kind: "stripe_checkout" | "stripe_subscription" | "billing_operation" | "review_sms_operation", reference: string | null | undefined,
) {
  if (!agreementId || !reference) return;
  const { error } = await supabaseAdmin.from("service_agreement_references").upsert(
    { agreement_id: agreementId, kind, reference },
    { onConflict: "agreement_id,kind,reference", ignoreDuplicates: true },
  );
  if (error) throw unavailable();
}

export async function readServiceAgreement(businessId: string, agreementId: string): Promise<{
  agreement: AgreementRecord; document: ServiceTermsDocument; references: AgreementReference[];
} | null> {
  const { data: agreement, error } = await supabaseAdmin.from("service_agreements").select("*")
    .eq("business_id", businessId).eq("id", agreementId).maybeSingle();
  if (error) throw unavailable();
  if (!agreement) return null;
  const [document, references] = await Promise.all([
    supabaseAdmin.from("service_terms_versions").select("*").eq("version", agreement.terms_version).single(),
    supabaseAdmin.from("service_agreement_references").select("kind,reference,recorded_at").eq("agreement_id", agreement.id).order("recorded_at"),
  ]);
  if (document.error || !document.data || references.error || !references.data) throw unavailable();
  return { agreement, document: document.data, references: references.data };
}
