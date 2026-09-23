import "server-only";

import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { BusinessInfoSchema, brandVerificationServerSchema, smsUseCaseSchema } from "@/lib/onboarding/formValidation.server";
import { normalizeUsStateCode } from "@/lib/usStates";
import { hasCarrierRejection } from "@/lib/onboarding/rejectionGuidance";
import { isSettingsRegistrationLocked, SETTINGS_REGISTRATION_STATE_COLUMNS, type SettingsRegistrationState } from "@/lib/settings/registrationLock.server";
import { assessA2pRiskForBusiness } from "@/lib/messaging/registration/riskScreening";
import { isA2pRiskSelection } from "@/lib/messaging/registration/riskCategories";
import { validateCustomerCareCopy } from "@/lib/messaging/registration/customerCareTemplates";
import { buildBusinessLandingUrl, resolveLegalUrls, type PrivacyTermsMode } from "@/lib/messaging/registration/legalUrls";
import { ensureUniqueSlug } from "@/lib/util/slug.server";
import { generateSlug, isPendingSlug } from "@/lib/util/slug.shared";
import { isNanpTollFreeNumber } from "@/lib/messaging/numbers";
import { TextingUpgradeError, type TextingUpgradeRecord } from "./textingUpgrade";

export type TextingUpgradeFormStep = "business" | "verification" | "use_case" | "phone";

/** Only these normalized values reach the guarded database operation. */
export async function saveTextingUpgradeForm(args: {
  upgrade: TextingUpgradeRecord; businessId: string; ownerId: string;
  step: TextingUpgradeFormStep; values: unknown;
}): Promise<void> {
  const { upgrade, businessId, ownerId, step } = args;
  if (upgrade.business_id !== businessId || upgrade.owner_id !== ownerId) {
    throw new TextingUpgradeError("texting_upgrade_forbidden", 403);
  }
  const replacingPaidPhone = step === "phone" && upgrade.paid_at !== null && upgrade.activated_at === null && ["carrier_pending", "support_required"].includes(upgrade.state);
  if (upgrade.state !== "draft" && !replacingPaidPhone) throw new TextingUpgradeError("texting_upgrade_locked");
  const { data: business, error } = await supabaseAdmin.from("businesses").select([
    "id", "owner_id", "deleted_at", "no_ein_hold_status", "slug", "privacy_terms_mode", "privacy_url_override", "terms_url_override", "website_url",
    "has_ein", "ein", "legal_business_name", "business_entity_type", "business_registration_state", "authorized_rep_name", "authorized_rep_title", "authorized_rep_email", "authorized_rep_phone",
    "compliance_info_completed_at", "timezone", "pending_phone_number_failure_reason", SETTINGS_REGISTRATION_STATE_COLUMNS,
  ].join(", ")).eq("id", businessId).maybeSingle();
  if (error) throw new TextingUpgradeError("registration_state_unavailable", 503);
  // Supabase's dynamic select cannot infer the row shape. The query is fixed above.
  const row = business as unknown as Record<string, unknown> | null;
  if (!row || row.owner_id !== ownerId || row.deleted_at !== null) throw new TextingUpgradeError("texting_upgrade_forbidden", 403);
  const registration: SettingsRegistrationState = {
    telnyx_brand_id: row.telnyx_brand_id as string | null,
    brand_status: row.brand_status as SettingsRegistrationState["brand_status"],
    campaign_status: row.campaign_status as SettingsRegistrationState["campaign_status"],
    onboarding_registration_status: row.onboarding_registration_status as Parameters<typeof isSettingsRegistrationLocked>[0]["onboarding_registration_status"],
  };
  if (hasCarrierRejection(registration.brand_status, registration.campaign_status)) throw new TextingUpgradeError("rejection_support_required");
  if (!replacingPaidPhone && isSettingsRegistrationLocked(registration)) throw new TextingUpgradeError("registration_locked");
  const values = typeof args.values === "object" && args.values !== null && !Array.isArray(args.values) ? args.values as Record<string, unknown> : {};
  const now = new Date().toISOString();
  let payload: Record<string, unknown>;
  if (step === "business") {
    const parsed = BusinessInfoSchema.safeParse(values);
    if (!parsed.success) throw new TextingUpgradeError("texting_upgrade_invalid_business", 400);
    const data = parsed.data;
    payload = { name: data.name, business_type: data.business_type, business_type_other: data.business_type === "other" ? data.business_type_other || null : null,
      website_url: data.website || null, phone_number: data.phone, email: data.email, address: data.address, city: data.city,
      state: normalizeUsStateCode(data.state), zip: data.zip, timezone: typeof row.timezone === "string" && row.timezone ? row.timezone : data.timezone };
  } else if (step === "verification") {
    const parsed = brandVerificationServerSchema.safeParse({ ...values, businessId });
    if (!parsed.success) throw new TextingUpgradeError("texting_upgrade_invalid_verification", 400);
    const data = parsed.data;
    if (!data.has_ein) {
      payload = { has_ein: false, a2p_brand_tier: null, no_ein_hold_status: data.join_waitlist ? "waitlisted" : "ein_encouraged", no_ein_waitlist_requested_at: data.join_waitlist ? now : null };
    } else {
      const { data: duplicate, error: lookupError } = await supabaseAdmin.from("businesses").select("id").eq("ein", data.ein).neq("id", businessId).limit(1).maybeSingle();
      if (lookupError) throw new TextingUpgradeError("texting_upgrade_ein_unavailable", 503);
      if (duplicate) throw new TextingUpgradeError("ein_already_connected");
      const { businessId: ignored, ...fields } = data;
      void ignored;
      payload = { ...fields, business_registration_state: normalizeUsStateCode(data.business_registration_state), tax_id_type: "ein", a2p_brand_tier: "low_volume_standard",
        no_ein_hold_status: ["waitlisted", "ein_encouraged"].includes(String(row.no_ein_hold_status)) ? "converted_to_ein" : "none" };
    }
  } else if (step === "use_case") {
    const parsed = smsUseCaseSchema.safeParse({ ...values, businessId });
    if (!parsed.success) throw new TextingUpgradeError("texting_upgrade_invalid_use_case", 400);
    const data = parsed.data;
    if (row.has_ein !== true || ["ein", "legal_business_name", "business_entity_type", "business_registration_state", "authorized_rep_name", "authorized_rep_title", "authorized_rep_email", "authorized_rep_phone"].some((key) => !row[key])) {
      throw new TextingUpgradeError("texting_upgrade_verification_required", 400);
    }
    if (validateCustomerCareCopy({ useCaseDescription: data.use_case_description, sampleMessages: data.sample_messages, optInDescription: data.opt_in_description }).length) {
      throw new TextingUpgradeError("texting_upgrade_invalid_use_case", 400);
    }
    const slug = isPendingSlug(String(row.slug)) ? await ensureUniqueSlug(generateSlug(String(row.legal_business_name))) : String(row.slug);
    try {
      resolveLegalUrls({ slug, privacy_terms_mode: (row.privacy_terms_mode ?? "hosted") as PrivacyTermsMode, privacy_url_override: row.privacy_url_override as string | null, terms_url_override: row.terms_url_override as string | null });
      if (!String(row.website_url ?? "").trim()) buildBusinessLandingUrl(slug);
    } catch { throw new TextingUpgradeError("texting_upgrade_legal_urls_required", 400); }
    const samples = data.sample_messages.map((sample) => sample.trim());
    const selections = data.a2p_risk_checklist_selections.filter(isA2pRiskSelection);
    const risk = await assessA2pRiskForBusiness(businessId, { useCaseDescription: data.use_case_description, sampleMessages: samples, optInDescription: data.opt_in_description,
      checklistAnswer: data.a2p_risk_checklist_answer, checklistSelections: selections });
    if (risk.registrationStarted) throw new TextingUpgradeError("registration_locked");
    payload = { slug, use_case_description: data.use_case_description, estimated_monthly_volume: data.estimated_monthly_volume, sample_messages: samples, opt_in_description: data.opt_in_description,
      compliance_info_completed_at: risk.status === "passed" || risk.status === "admin_approved" ? row.compliance_info_completed_at ?? now : null,
      a2p_risk_review_customer_answer: data.a2p_risk_checklist_answer, a2p_risk_review_customer_selections: selections,
      a2p_risk_review_status: risk.status, a2p_risk_review_input_hash: risk.inputHash };
    if (!risk.reusedExisting) Object.assign(payload, { a2p_risk_review_message: risk.message, a2p_risk_review_reason: risk.reason, a2p_risk_review_findings: risk.findings,
      a2p_risk_review_scanned_at: now, a2p_risk_review_updated_at: now, a2p_risk_review_notified_at: null });
  } else {
    if (replacingPaidPhone) {
      if (!row.pending_phone_number_failure_reason) throw new TextingUpgradeError("texting_upgrade_locked");
      const existing = await supabaseAdmin.from("phone_numbers").select("id").eq("business_id", businessId).eq("is_active", true).limit(1).maybeSingle();
      if (existing.error) throw new TextingUpgradeError("texting_upgrade_save_failed", 503);
      if (existing.data) throw new TextingUpgradeError("texting_upgrade_locked");
    }
    const parsed = z.object({ phoneNumber: z.string().regex(/^\+1\d{10}$/), smsConsentAgreed: z.literal(true) }).safeParse(values);
    if (!parsed.success || isNanpTollFreeNumber(parsed.data.phoneNumber)) throw new TextingUpgradeError("invalid_phone_number", 400);
    if (!row.compliance_info_completed_at) throw new TextingUpgradeError("texting_upgrade_use_case_required", 400);
    payload = { pending_phone_number: parsed.data.phoneNumber, pending_phone_number_selected_at: now, pending_phone_number_failure_reason: null };
  }
  const result = await supabaseAdmin.rpc("save_chat_texting_upgrade_details", {
    p_upgrade_id: upgrade.id, p_owner_id: ownerId, p_step: step, p_values: payload,
  });
  if (result.error) {
    if (result.error.code === "23505") throw new TextingUpgradeError("ein_already_connected");
    const code = result.error.message;
    if (/^texting_upgrade_(forbidden|locked|source_changed|incomplete)$/.test(code)) throw new TextingUpgradeError(code, code === "texting_upgrade_forbidden" ? 403 : 409);
    throw new TextingUpgradeError("texting_upgrade_save_failed", 503);
  }
  if (!result.data) throw new TextingUpgradeError("texting_upgrade_source_changed");
}
