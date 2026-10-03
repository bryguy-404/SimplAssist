import "server-only";
import { z } from "zod";
import { adminUserIds } from "@/lib/admin/allowlist";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { telnyx } from "@/lib/messaging/client";
import { ReviewSmsError, type ReviewSmsAccount } from "@/lib/billing/reviewSms";
import { isReviewSmsEnabled } from "@/lib/billing/reviewSmsRollout.server";
import { readReviewSmsAccount } from "@/lib/stripe/reviewSms.server";
import {
  createMessagingProfile,
  createVoiceApplication,
  registerBrand,
} from "@/lib/messaging/registration";
import {
  purchaseNumber,
  findOwnedNumberId,
  attachOwnedNumberToCustomerProfile,
  isNanpTollFreeNumber,
} from "@/lib/messaging/numbers";
import { resolveProviderCreateIntents } from "@/lib/messaging/registration/providerCreateIntent";
import {
  getA2pRiskClearanceForBusiness,
  screenA2pRiskForBusiness,
} from "@/lib/messaging/registration/riskScreening";
import { assertNoCarrierRejectionForBusiness } from "@/lib/onboarding/rejectionGuard.server";
import { ensureCampaignAssignmentForBusiness } from "@/lib/messaging/registration/phoneNumberAssignment";
import { getSmsReadinessForBusiness } from "@/lib/messaging/lookup";
import {
  mapBrandStatus,
  mapCampaignStatus,
} from "@/lib/messaging/registration/statusMapper";
import { resolveLegalUrls } from "@/lib/messaging/registration/legalUrls";
import { reviewOrigin } from "./domain";
import { generateSlug } from "@/lib/util/slug.shared";
import { reviewConsentUrl, reviewConsentDescription, reviewConsentConfirmation } from "./consentCopy";
import {
  ensureReviewSmsKeywords,
  inspectReviewSmsKeywords,
  keywordProgramFromCampaign,
  reviewSmsKeywordProgram,
} from "./smsKeywords.server";

const e164 = z.string().regex(/^\+1[2-9]\d{9}$/);
const draftSchema = z
  .object({
    phoneNumber: e164,
    consentMode: z.enum(["hosted_keyword", "custom"]).default("custom"),
    consentDescription: z.string().trim().min(20).max(1500).optional(),
    consentEvidenceUrl: z
      .string()
      .url()
      .refine((v) => new URL(v).protocol === "https:").optional(),
    legalBusinessName: z.string().trim().min(1).max(120).optional(),
    entityType: z
      .enum([
        "llc",
        "c_corp",
        "s_corp",
        "nonprofit",
        "partnership",
        "sole_proprietor",
      ])
      .optional(),
    ein: z
      .string()
      .trim()
      .regex(/^\d{2}-?\d{7}$/)
      .optional(),
    address: z.string().trim().min(1).max(200).optional(),
    city: z.string().trim().min(1).max(100).optional(),
    state: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    zip: z
      .string()
      .regex(/^\d{5}(?:-\d{4})?$/)
      .optional(),
    authorizedRepName: z.string().trim().min(1).max(120).optional(),
    authorizedRepEmail: z.string().email().max(254).optional(),
    authorizedRepPhone: e164.optional(),
  })
  .strict();
const identityFields = {
  legalBusinessName: "legal_business_name",
  entityType: "business_entity_type",
  ein: "ein",
  address: "address",
  city: "city",
  state: "state",
  zip: "zip",
  authorizedRepName: "authorized_rep_name",
  authorizedRepEmail: "authorized_rep_email",
  authorizedRepPhone: "authorized_rep_phone",
} as const;
function forbiddenProfiles(): string[] {
  const profiles = [
    process.env.TELNYX_PROTECTED_MESSAGING_PROFILE_ID,
    process.env.TELNYX_MESSAGING_PROFILE_ID,
  ].filter((value): value is string => !!value?.trim());
  if (!profiles.length)
    throw new ReviewSmsError(
      "review_sms_resource_protection_unconfigured",
      503,
    );
  return profiles;
}
async function assertTenantResourceScope(
  businessId: string,
  profile: string,
  sender: string,
  campaign: string | null,
) {
  const { data, error } = await supabaseAdmin.rpc(
    "review_sms_resource_scope_safe",
    {
      p_business: businessId,
      p_profile: profile,
      p_sender: sender,
      p_campaign: campaign,
      p_forbidden_profiles: forbiddenProfiles(),
    },
  );
  if (error || data !== true)
    throw new ReviewSmsError("review_sms_resource_scope_denied");
}
async function business(businessId: string) {
  const { data, error } = await supabaseAdmin
    .from("businesses")
    .select("*")
    .eq("id", businessId)
    .maybeSingle();
  if (error || !data)
    throw new ReviewSmsError("review_sms_setup_unavailable", 503);
  return data;
}
export async function reviewSmsSetupOverview(businessId: string) {
  const b = await business(businessId);
  const { data: phone, error } = await supabaseAdmin
    .from("phone_numbers")
    .select("phone_number")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new ReviewSmsError("review_sms_number_conflict");
  const fields: Record<string, string | boolean> = {
    hasEin: Boolean(b.ein && b.has_ein),
    identityLocked: Boolean(b.telnyx_brand_id),
    phoneNumber: phone?.phone_number ?? "",
    reviewSignupEnabled: b.review_sms_signup_enabled === true,
    consentUrl: b.slug ? reviewConsentUrl(b.slug, reviewOrigin()) : "",
  };
  const missing: string[] = [];
  for (const [key, column] of Object.entries(identityFields)) {
    if (!b[column]) missing.push(key);
    if (key !== "ein")
      fields[key] = typeof b[column] === "string" ? b[column] : "";
  }
  return { fields, missing };
}

/** The owner chose review texts in normal signup. This creates no provider
 * resource and charges nothing; the existing paid plan supplies the SMS pool. */
export async function initializeIncludedReviewSmsSignup(businessId: string, ownerId: string) {
  if (!isReviewSmsEnabled(businessId)) return;
  const b = await business(businessId);
  if (b.owner_id !== ownerId) throw new ReviewSmsError("review_sms_forbidden", 403);
  if (b.review_sms_signup_enabled !== true || !b.slug) return;
  const {data: phone, error} = await supabaseAdmin.from("phone_numbers").select("phone_number").eq("business_id", businessId).eq("is_active", true).maybeSingle();
  if (error) throw new ReviewSmsError("review_sms_number_conflict");
  if (!phone) return;
  const url = reviewConsentUrl(b.slug, reviewOrigin());
  const {error: initError} = await supabaseAdmin.rpc("review_sms_initialize_signup", {
    p_business: businessId, p_owner: ownerId,
    p_draft: {phoneNumber: phone.phone_number, consentMode: "hosted_keyword", consentEvidenceUrl: url, consentDescription: reviewConsentDescription(b.name, phone.phone_number, url)},
  });
  if (initError) throw new ReviewSmsError("review_sms_state_unavailable", 503);
}

async function refreshIncludedSignupReviewSms(businessId: string) {
  const a = await readReviewSmsAccount(businessId), b = await business(businessId);
  if (!a || a.billing_source !== "included" || b.review_sms_signup_enabled !== true || !["draft","carrier_pending"].includes(a.state) || !b.telnyx_campaign_id || !b.telnyx_messaging_profile_id) return;
  const c = await telnyx.messaging10dlc.campaign.retrieve(b.telnyx_campaign_id, {maxRetries: 0, timeout: 10000});
  if (c.brandId !== b.telnyx_brand_id || c.referenceId !== businessId || c.usecase !== "MIXED" || !c.subUsecases?.includes("MARKETING") || !c.subUsecases?.includes("CUSTOMER_CARE") || c.embeddedLink !== true || !c.optinKeywords?.split(",").map(x => x.trim().toUpperCase()).includes("REVIEWS"))
    throw new ReviewSmsError("review_sms_campaign_mismatch");
  const status = mapCampaignStatus(c).dbStatus;
  if (status === "rejected") { await updateAccount(a, {state:"support_required",last_error:"review_sms_carrier_rejected"}); return; }
  if (status !== "approved") return;
  if (!(await inspectReviewSmsKeywords(b.telnyx_messaging_profile_id, keywordProgramFromCampaign(c, b.name))).ready)
    throw new ReviewSmsError("review_sms_keywords_not_ready");
  const {error: statusError} = await supabaseAdmin.from("businesses")
    .update({campaign_status:"approved"}).eq("id",businessId)
    .eq("owner_id",b.owner_id).eq("telnyx_campaign_id",b.telnyx_campaign_id);
  if (statusError) throw new ReviewSmsError("review_sms_state_unavailable",503);
  await ensureCampaignAssignmentForBusiness(businessId, {force:true,reason:"review_sms_signup_ready"});
  if (!(await getSmsReadinessForBusiness(businessId)).smsReady) return;
  const {data: phone, error} = await supabaseAdmin.from("phone_numbers").select("id").eq("business_id",businessId).eq("is_active",true).single();
  if (error || !phone) throw new ReviewSmsError("review_sms_number_conflict");
  const {data: activated, error: activateError} = await supabaseAdmin.rpc("review_sms_activate_signup", {
    p_business:businessId,p_owner:b.owner_id,p_campaign:b.telnyx_campaign_id,p_profile:b.telnyx_messaging_profile_id,p_phone:phone.id,
    p_evidence:`provider:${b.telnyx_campaign_id}:MIXED:CUSTOMER_CARE,MARKETING:REVIEWS:${businessId}`,p_forbidden_profiles:forbiddenProfiles(),
  });
  if (activateError || activated !== true) throw new ReviewSmsError("review_sms_carrier_approval_required");
}
export async function saveReviewSmsSetup(
  businessId: string,
  ownerId: string,
  raw: Record<string, unknown>,
) {
  if (!isReviewSmsEnabled(businessId))
    throw new ReviewSmsError("review_sms_disabled", 404);
  const parsed = draftSchema.safeParse(raw);
  if (!parsed.success)
    throw new ReviewSmsError("review_sms_setup_invalid", 400);
  const draft = parsed.data;
  if (isNanpTollFreeNumber(draft.phoneNumber))
    throw new ReviewSmsError("review_sms_local_number_required", 400);
  const b = await business(businessId);
  if (b.owner_id !== ownerId || b.deleted_at || b.operations_suspended_at)
    throw new ReviewSmsError("review_sms_forbidden", 403);
  if (draft.consentMode === "custom" && (!draft.consentDescription || !draft.consentEvidenceUrl)) {
    throw new ReviewSmsError("review_sms_setup_invalid", 400);
  }
  const { data: activeNumber, error: numberError } = await supabaseAdmin
    .from("phone_numbers")
    .select("phone_number")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .maybeSingle();
  if (
    numberError ||
    (activeNumber && activeNumber.phone_number !== draft.phoneNumber)
  )
    throw new ReviewSmsError("review_sms_existing_number_must_match");
  const patch: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(identityFields)) {
    const value = draft[key as keyof typeof identityFields];
    if (value !== undefined) {
      if (b.telnyx_brand_id && String(b[column] ?? "") !== value)
        throw new ReviewSmsError("review_sms_existing_brand_identity_locked");
      patch[column] = value;
    }
  }
  if (draft.ein) patch.has_ein = true;
  const saved = { ...b, ...patch };
  for (const column of Object.values(identityFields))
    if (!saved[column])
      throw new ReviewSmsError(`review_sms_setup_missing_${column}`, 400);
  if (!saved.has_ein) throw new ReviewSmsError("review_sms_ein_required", 400);
  if (draft.consentMode === "hosted_keyword") {
    // Chat signup has no carrier-registration step to replace its placeholder
    // slug. Allocate once under the owner lock, including concurrent saves.
    const base = generateSlug(saved.legal_business_name || saved.name);
    const { data: slug, error: slugError } = await supabaseAdmin.rpc("review_sms_prepare_hosted_slug", {
      p_business: businessId, p_owner: ownerId,
      p_base: base.startsWith("pending-") ? `biz-${base}`.slice(0, 60) : base,
    });
    if (slugError || typeof slug !== "string" || !slug || slug.startsWith("pending-"))
      throw new ReviewSmsError("review_sms_setup_unavailable", 503);
    draft.consentEvidenceUrl = reviewConsentUrl(slug, reviewOrigin());
    draft.consentDescription = reviewConsentDescription(b.name, draft.phoneNumber, draft.consentEvidenceUrl);
  }
  patch.compliance_info_completed_at =
    b.compliance_info_completed_at ?? new Date().toISOString();
  // Persist the identity and non-secret draft under one owner/business lock.
  const { data, error } = await supabaseAdmin.rpc("review_sms_save_setup", {
    p_business: businessId,
    p_owner: ownerId,
    p_patch: patch,
    p_draft: {
      phoneNumber: draft.phoneNumber,
      consentMode: draft.consentMode,
      consentDescription: draft.consentDescription,
      consentEvidenceUrl: draft.consentEvidenceUrl,
    },
  });
  if (error)
    throw new ReviewSmsError(
      /review_sms_[a-z_]+/.exec(error.message)?.[0] ??
        "review_sms_setup_unavailable",
      409,
    );
  await screenA2pRiskForBusiness(businessId, {}, { force: true });
  return data;
}
export async function validateReviewSmsSetup(businessId: string) {
  const a = await readReviewSmsAccount(businessId),
    b = await business(businessId);
  if (
    !a ||
    !a.draft.phoneNumber ||
    !a.draft.consentDescription ||
    !a.draft.consentEvidenceUrl
  )
    throw new ReviewSmsError("review_sms_setup_required");
  for (const column of Object.values(identityFields))
    if (!b[column])
      throw new ReviewSmsError(`review_sms_setup_missing_${column}`, 400);
  if (
    !b.has_ein ||
    !b.compliance_info_completed_at ||
    b.deleted_at ||
    b.operations_suspended_at ||
    b.telnyx_submission_disabled ||
    a.owner_id !== b.owner_id
  )
    throw new ReviewSmsError("review_sms_setup_unavailable");
  const legal = resolveLegalUrls(b);
  for (const value of [
    legal.privacyUrl,
    legal.termsUrl,
    String(a.draft.consentEvidenceUrl),
  ]) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new ReviewSmsError("review_sms_legal_url_invalid");
  }
  await assertNoCarrierRejectionForBusiness(businessId);
  const risk = await getA2pRiskClearanceForBusiness(businessId);
  if (!risk.cleared)
    throw new ReviewSmsError("review_sms_risk_review_required");
  return { account: a, business: b };
}
async function updateAccount(
  a: ReviewSmsAccount,
  patch: Record<string, unknown>,
) {
  const { error } = await supabaseAdmin
    .from("review_sms_accounts")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", a.id);
  if (error) throw new ReviewSmsError("review_sms_state_unavailable", 503);
}
async function assertClaim(a: ReviewSmsAccount, claim: string) {
  if (
    !isReviewSmsEnabled(a.business_id) ||
    process.env.REVIEWS_SMS_PROVISIONING_ENABLED !== "1"
  )
    throw new ReviewSmsError("review_sms_provisioning_stopped");
  const { data, error } = await supabaseAdmin.rpc(
    "review_sms_provisioning_claim_valid",
    { p_business: a.business_id, p_claim: claim },
  );
  if (error || data !== true)
    throw new ReviewSmsError("review_sms_provisioning_stopped");
  await assertNoCarrierRejectionForBusiness(a.business_id);
}
async function beginPaidStep(
  a: ReviewSmsAccount,
  claim: string,
  step: "brand" | "number",
) {
  await assertClaim(a, claim);
  const { data, error } = await supabaseAdmin.rpc(
    "review_sms_begin_paid_provider_step",
    { p_business: a.business_id, p_claim: claim, p_step: step },
  );
  if (error || data !== true)
    throw new ReviewSmsError("review_sms_provider_recovery_required");
}

async function assertReviewOwnedKeywordProfile(
  businessId: string,
  profileId: string,
  claim: string,
) {
  const a = await readReviewSmsAccount(businessId);
  if (
    !a ||
    !a.exclusive_resources ||
    a.billing_source !== "direct" ||
    a.state !== "carrier_pending" ||
    !a.created_at
  )
    throw new ReviewSmsError("review_sms_keyword_profile_not_owned");
  await assertClaim(a, claim);
  const b = await business(businessId);
  if (b.telnyx_messaging_profile_id !== profileId)
    throw new ReviewSmsError("review_sms_keyword_profile_not_owned");
  await assertTenantResourceScope(
    businessId,
    profileId,
    String(a.draft.phoneNumber),
    b.telnyx_campaign_id,
  );
  // A profile already used by another program before this activation is never
  // rewritten automatically, even when it belongs to the same business.
  const { data, error } = await supabaseAdmin
    .from("telnyx_registration_events")
    .select("id")
    .eq("business_id", businessId)
    .eq("event_type", "messaging_profile_created")
    .eq("telnyx_resource_id", profileId)
    .eq("status", "success")
    .gte("created_at", a.created_at)
    .limit(1)
    .maybeSingle();
  if (error || !data)
    throw new ReviewSmsError("review_sms_keyword_profile_not_owned");
  // A recovery audit event can be new even when the provider profile is old.
  // Inspect only ownership fields; never expose the full provider response.
  const { data: profile } = await telnyx.messagingProfiles.retrieve(profileId, {
    maxRetries: 0,
    timeout: 10000,
  });
  const profileCreated = Date.parse(profile?.created_at ?? "");
  const accountCreated = Date.parse(a.created_at);
  if (
    profile?.id !== profileId ||
    !profile.name?.trim().endsWith(`(${businessId})`) ||
    !Number.isFinite(profileCreated) ||
    !Number.isFinite(accountCreated) ||
    profileCreated < accountCreated
  )
    throw new ReviewSmsError("review_sms_keyword_profile_not_owned");
}

/** Read-only diagnostics for existing tenant profiles. An operator must review
 * any mismatch; this function never changes customer-care or shared profiles. */
export async function inspectExistingReviewSmsKeywordReadiness(
  businessId: string,
) {
  const b = await business(businessId);
  if (!b.telnyx_campaign_id || !b.telnyx_messaging_profile_id)
    throw new ReviewSmsError("review_sms_existing_campaign_required");
  const campaign = await telnyx.messaging10dlc.campaign.retrieve(
    b.telnyx_campaign_id,
    { maxRetries: 0, timeout: 10000 },
  );
  if (campaign.brandId !== b.telnyx_brand_id)
    throw new ReviewSmsError("review_sms_campaign_mismatch");
  return inspectReviewSmsKeywords(
    b.telnyx_messaging_profile_id,
    keywordProgramFromCampaign(campaign, b.name),
  );
}

export async function continueReviewSmsProvisioning(businessId: string) {
  if (
    !isReviewSmsEnabled(businessId) ||
    process.env.REVIEWS_SMS_PROVISIONING_ENABLED !== "1"
  )
    return;
  // Included plans use their normal signup registration and never buy a
  // second brand, campaign or number through the Chat add-on provisioner.
  const current = await readReviewSmsAccount(businessId);
  if (!current || current.billing_source !== "direct") return;
  const { account: a } = await validateReviewSmsSetup(businessId);
  if (a.state !== "carrier_pending") return;
  const { data: claim, error } = await supabaseAdmin.rpc(
    "review_sms_claim_provisioning",
    { p_business: businessId },
  );
  if (error) throw new ReviewSmsError("review_sms_state_unavailable", 503);
  if (typeof claim !== "string") return;
  try {
    await assertClaim(a, claim);
    await registerBrand(businessId, {
      beforePaidSubmit: () => beginPaidStep(a, claim, "brand"),
    });
    // A brand may take time to verify. Never spend the sole campaign application
    // while brand identity is still pending or its provider response is unclear.
    const brandBusiness = await business(businessId);
    await updateAccount(a, {brand_id: brandBusiness.telnyx_brand_id});
    const brand = await telnyx.messaging10dlc.brand.retrieve(
      brandBusiness.telnyx_brand_id,
      { maxRetries: 0, timeout: 10000 },
    );
    const brandStatus = mapBrandStatus(brand).dbStatus;
    if (brandStatus === "rejected")
      throw new ReviewSmsError("review_sms_carrier_rejected");
    if (brandStatus !== "approved") return;
    await assertClaim(a, claim);
    await createMessagingProfile(businessId);
    await updateAccount(a, {messaging_profile_id: (await business(businessId)).telnyx_messaging_profile_id});
    // The routing application keeps unentitled voice calls on the existing
    // fail-closed path; creating it never grants AI voice answering.
    await assertClaim(a, claim);
    await createVoiceApplication(businessId);
    const resourceBusiness = await business(businessId);
    await updateAccount(a, {messaging_profile_id: resourceBusiness.telnyx_messaging_profile_id, voice_application_id: resourceBusiness.telnyx_voice_application_id});
    await assertTenantResourceScope(
      businessId,
      resourceBusiness.telnyx_messaging_profile_id,
      String(a.draft.phoneNumber),
      resourceBusiness.telnyx_campaign_id,
    );
    await assertReviewOwnedKeywordProfile(
      businessId,
      resourceBusiness.telnyx_messaging_profile_id,
      claim,
    );
    await ensureReviewSmsKeywords({
      businessId,
      profileId: resourceBusiness.telnyx_messaging_profile_id,
      program: reviewSmsKeywordProgram(
        resourceBusiness.name,
        resourceBusiness.authorized_rep_email,
      ),
      authorizeMutation: () =>
        assertReviewOwnedKeywordProfile(
          businessId,
          resourceBusiness.telnyx_messaging_profile_id,
          claim,
        ),
    });
    const { data: existing, error: phoneError } = await supabaseAdmin
      .from("phone_numbers")
      .select("*")
      .eq("business_id", businessId)
      .eq("is_active", true)
      .maybeSingle();
    if (phoneError) throw new ReviewSmsError("review_sms_number_conflict");
    if (!existing) {
      const phone = String(a.draft.phoneNumber);
      await assertClaim(a, claim);
      let providerId = await findOwnedNumberId(phone, businessId);
      if (!providerId) {
        const bought = await purchaseNumber(phone, businessId, {
          beforePaidSubmit: () => beginPaidStep(a, claim, "number"),
        });
        providerId = bought.phoneNumberId;
      }
      await assertClaim(a, claim);
      await attachOwnedNumberToCustomerProfile(businessId, providerId);
      const { error: insertError } = await supabaseAdmin
        .from("phone_numbers")
        .insert({
          business_id: businessId,
          phone_number: phone,
          telnyx_phone_number_id: providerId,
          is_active: true,
        });
      if (insertError)
        throw new ReviewSmsError(
          "review_sms_number_save_recovery_required",
          503,
        );
      await resolveProviderCreateIntents({
        businessId,
        spec: {
          eventType: "phone_number_order_create_intent",
          resourceType: "phone_number",
        },
      });
    }
    const {data: boundPhone, error: boundPhoneError} = await supabaseAdmin.from("phone_numbers").select("id,phone_number").eq("business_id",businessId).eq("is_active",true).single();
    if (boundPhoneError || !boundPhone || boundPhone.phone_number !== a.draft.phoneNumber)
      throw new ReviewSmsError("review_sms_number_conflict");
    await updateAccount(a, {phone_number_id: boundPhone.id});
    await assertClaim(a, claim);
    await submitReviewSmsCampaign(a, claim);
    await assertClaim(a, claim);
    await ensureCampaignAssignmentForBusiness(businessId, {
      force: true,
      reason: "review_sms_activation",
    });
    await refreshReviewSmsProviderReadiness(businessId);
  } catch (error) {
    // Provider ambiguity/rejection never consumes a second paid application.
    // A fresh owner retry may resume safe reads/steps; it cannot submit again.
    await updateAccount(a, {
      last_error:
        error instanceof ReviewSmsError
          ? error.code
          : "review_sms_setup_needs_attention",
    });
    throw error;
  } finally {
    const { error: releaseError } = await supabaseAdmin
      .from("review_sms_accounts")
      .update({ provisioning_claim: null, provisioning_lease_until: null })
      .eq("id", a.id)
      .eq("provisioning_claim", claim);
    if (releaseError)
      throw new ReviewSmsError("review_sms_state_unavailable", 503);
  }
}
async function submitReviewSmsCampaign(a: ReviewSmsAccount, claim: string) {
  const b = await business(a.business_id);
  if (b.telnyx_campaign_id) {
    if (a.campaign_id !== b.telnyx_campaign_id)
      throw new ReviewSmsError("review_sms_existing_campaign_needs_approval");
    return;
  }
  // Recover an exact prior reference before authorizing a charged submission.
  const matches = [];
  for await (const c of telnyx.messaging10dlc.campaign.list(
    { brandId: b.telnyx_brand_id },
    { maxRetries: 0, timeout: 10000 },
  )) {
    if (c.referenceId === `reviews:${a.id}`) matches.push(c);
  }
  if (matches.length > 1)
    throw new ReviewSmsError("review_sms_campaign_recovery_required");
  let campaignId = matches[0]?.campaignId;
  if (!campaignId) {
    await assertClaim(a, claim);
    await assertTenantResourceScope(
      a.business_id,
      b.telnyx_messaging_profile_id,
      String(a.draft.phoneNumber),
      null,
    );
    const links = resolveLegalUrls(b);
    const phone = String(a.draft.phoneNumber);
    const label = String(b.name).slice(0, 70);
    const keywords = reviewSmsKeywordProgram(label, b.authorized_rep_email);
    const payload = {
      brandId: b.telnyx_brand_id,
      usecase: "MARKETING",
      description: `${label} requests honest Google reviews after completed services. One invitation and at most one reminder are sent only with the customer's permission. Human staff handle replies.`,
      sample1: `${label}: Thank you for choosing us. Please share an honest review: ${reviewOrigin()}/r/example Reply STOP to opt out.`,
      sample2: `${label}: A quick reminder: you can share your experience at ${reviewOrigin()}/r/example Reply STOP to opt out.`,
      sample3: `${label}: Thank you for your feedback. Our team will help with your question. Reply STOP to opt out.`,
      messageFlow: `${a.draft.consentDescription} Evidence: ${a.draft.consentEvidenceUrl}. Customers consent to review requests from ${label} using ${phone}. Up to 2 messages per completed service; message and data rates may apply. Consent is not required to purchase. Reply STOP to opt out or HELP for help. Privacy: ${links.privacyUrl}. Terms: ${links.termsUrl}.`,
      subscriberOptin: true,
      optinKeywords: a.draft.consentMode === "hosted_keyword" ? "REVIEWS" : keywords.start.keywords.join(","),
      optinMessage: a.draft.consentMode === "hosted_keyword" ? reviewConsentConfirmation(label) : keywords.start.resp_text,
      subscriberOptout: true,
      optoutKeywords: keywords.stop.keywords.join(","),
      optoutMessage: keywords.stop.resp_text,
      subscriberHelp: true,
      helpKeywords: keywords.info.keywords.join(","),
      helpMessage: keywords.info.resp_text,
      termsAndConditions: true,
      privacyPolicyLink: links.privacyUrl,
      termsAndConditionsLink: links.termsUrl,
      autoRenewal: true,
      embeddedLink: true,
      embeddedPhone: false,
      numberPool: false,
      directLending: false,
      ageGated: false,
      referenceId: `reviews:${a.id}`,
      webhookURL: `${reviewOrigin()}/api/messaging/registration/status`,
      webhookFailoverURL: `${reviewOrigin()}/api/messaging/registration/status`,
    };
    const { data: reserved, error } = await supabaseAdmin.rpc(
      "review_sms_reserve_campaign_submission",
      { p_business: a.business_id, p_claim: claim },
    );
    if (error || reserved !== true)
      throw new ReviewSmsError("review_sms_submission_requires_support");
    const response = await telnyx.messaging10dlc.campaignBuilder.submit(
      payload,
      { maxRetries: 0, timeout: 10000 },
    );
    campaignId = response.campaignId;
  }
  if (typeof campaignId !== "string" || !campaignId)
    throw new ReviewSmsError("review_sms_campaign_recovery_required");
  const { data: saved, error } = await supabaseAdmin
    .from("businesses")
    .update({ telnyx_campaign_id: campaignId, campaign_status: "pending" })
    .eq("id", a.business_id)
    .is("telnyx_campaign_id", null)
    .select("id")
    .maybeSingle();
  if (error || !saved)
    throw new ReviewSmsError("review_sms_campaign_save_recovery_required", 503);
  await updateAccount(a, {
    campaign_id: campaignId,
    provider_submitted_at: new Date().toISOString(),
  });
}

export async function refreshReviewSmsProviderReadiness(businessId: string) {
  if (
    !isReviewSmsEnabled(businessId) ||
    process.env.REVIEWS_SMS_PROVISIONING_ENABLED !== "1"
  )
    return;
  const a = await readReviewSmsAccount(businessId);
  if (a?.billing_source === "included") {
    await refreshIncludedSignupReviewSms(businessId);
    return;
  }
  if (
    !a ||
    !a.campaign_id ||
    !a.provider_submitted_at ||
    !["carrier_pending", "ready_unpaid"].includes(a.state)
  )
    return;
  const b = await business(businessId);
  if (b.telnyx_campaign_id !== a.campaign_id) return;
  const campaign = await telnyx.messaging10dlc.campaign.retrieve(
    a.campaign_id,
    { maxRetries: 0, timeout: 10000 },
  );
  if (
    campaign.brandId !== b.telnyx_brand_id ||
    campaign.referenceId !== `reviews:${a.id}` ||
    campaign.usecase !== "MARKETING" ||
    campaign.embeddedLink !== true
  )
    throw new ReviewSmsError("review_sms_campaign_mismatch");
  const status = mapCampaignStatus(campaign).dbStatus;
  if (status === "rejected") {
    await updateAccount(a, {
      state: "support_required",
      last_error: "review_sms_carrier_rejected",
    });
    return;
  }
  if (status !== "approved") return;
  if (
    !(
      await inspectReviewSmsKeywords(
        b.telnyx_messaging_profile_id,
        keywordProgramFromCampaign(campaign, b.name),
      )
    ).ready
  )
    throw new ReviewSmsError("review_sms_keywords_not_ready");
  const { error } = await supabaseAdmin
    .from("businesses")
    .update({ campaign_status: "approved" })
    .eq("id", businessId)
    .eq("telnyx_campaign_id", a.campaign_id);
  if (error) throw new ReviewSmsError("review_sms_state_unavailable", 503);
  await ensureCampaignAssignmentForBusiness(businessId, {
    force: true,
    reason: "review_sms_ready",
  });
  if (!(await getSmsReadinessForBusiness(businessId)).smsReady) return;
  const { data: phone, error: phoneError } = await supabaseAdmin
    .from("phone_numbers")
    .select("id")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .single();
  if (phoneError || !phone)
    throw new ReviewSmsError("review_sms_number_conflict");
  const { error: readyError } = await supabaseAdmin.rpc(
    "review_sms_record_provider_ready",
    {
      p_business: businessId,
      p_campaign: a.campaign_id,
      p_profile: b.telnyx_messaging_profile_id,
      p_phone: phone.id,
      p_forbidden_profiles: forbiddenProfiles(),
    },
  );
  if (readyError) throw new ReviewSmsError("review_sms_state_unavailable", 503);
}

/** Existing plans keep their number and pool; an administrator records actual
 * provider approval for this exact campaign before review sending is enabled. */
export async function approveExistingReviewSmsUsecase(
  businessId: string,
  adminId: string,
  evidence: string,
  grantExpiresAt?: string,
) {
  if (!adminUserIds().has(adminId))
    throw new ReviewSmsError("review_sms_approval_forbidden", 403);
  if (!isReviewSmsEnabled(businessId))
    throw new ReviewSmsError("review_sms_disabled", 404);
  if (evidence.trim().length < 20)
    throw new ReviewSmsError("review_sms_approval_evidence_required", 400);
  const a = await readReviewSmsAccount(businessId),
    b = await business(businessId);
  if (!a || !b.telnyx_campaign_id)
    throw new ReviewSmsError("review_sms_existing_campaign_required");
  if (
    grantExpiresAt &&
    a.billing_source !== "grant" &&
    (a.stripe_item_id || ["active", "cancel_pending"].includes(a.state))
  )
    throw new ReviewSmsError("review_sms_paid_account_cannot_be_granted");
  const c = await telnyx.messaging10dlc.campaign.retrieve(
    b.telnyx_campaign_id,
    { maxRetries: 0, timeout: 10000 },
  );
  // Telnyx MIXED registration explicitly declares its approved sub-usecases.
  // A generic customer-care campaign or an unspecified mixed campaign does
  // not authorize review marketing. Administrative evidence remains required.
  const marketingApproved =
    c.usecase === "MARKETING" ||
    (c.usecase === "MIXED" &&
      Array.isArray(c.subUsecases) &&
      c.subUsecases.includes("MARKETING"));
  if (
    c.brandId !== b.telnyx_brand_id ||
    !marketingApproved ||
    c.embeddedLink !== true ||
    mapCampaignStatus(c).dbStatus !== "approved"
  )
    throw new ReviewSmsError("review_sms_carrier_approval_required");
  if (!(await getSmsReadinessForBusiness(businessId)).smsReady)
    throw new ReviewSmsError("review_sms_carrier_approval_required");
  if (
    !(
      await inspectReviewSmsKeywords(
        b.telnyx_messaging_profile_id,
        keywordProgramFromCampaign(c, b.name),
      )
    ).ready
  )
    throw new ReviewSmsError("review_sms_keywords_not_ready");
  const { data: phone, error } = await supabaseAdmin
    .from("phone_numbers")
    .select("id")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .single();
  if (error || !phone) throw new ReviewSmsError("review_sms_number_conflict");
  const grant = grantExpiresAt
    ? z.string().datetime().parse(grantExpiresAt)
    : null;
  if (grant && Date.parse(grant) <= Date.now())
    throw new ReviewSmsError("review_sms_grant_expired");
  const { error: approvalError } = await supabaseAdmin.rpc(
    "review_sms_record_existing_approval",
    {
      p_business: businessId,
      p_admin: adminId,
      p_campaign: b.telnyx_campaign_id,
      p_profile: b.telnyx_messaging_profile_id,
      p_phone: phone.id,
      p_evidence: evidence.trim(),
      p_grant_expires: grant,
      p_forbidden_profiles: forbiddenProfiles(),
    },
  );
  if (approvalError)
    throw new ReviewSmsError(
      /review_sms_[a-z_]+/.exec(approvalError.message)?.[0] ??
        "review_sms_state_unavailable",
      409,
    );
}
