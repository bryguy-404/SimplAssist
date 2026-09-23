import { smsUseCaseSchema } from "@/lib/onboarding/formValidation.server";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ensureUniqueSlug } from "@/lib/util/slug.server";
import { generateSlug, isPendingSlug } from "@/lib/util/slug.shared";
import {
  buildBusinessLandingUrl,
  resolveLegalUrls,
  type PrivacyTermsMode,
} from "@/lib/messaging/registration/legalUrls";
import {
  appendRegistrationEvent,
  serializeError,
} from "@/lib/messaging/registration/audit";
import {
  isA2pRiskSelection,
} from "@/lib/messaging/registration/riskCategories";
import {
  registrationHasStartedForRisk,
  screenA2pRiskForBusiness,
  type A2pRiskReviewResult,
} from "@/lib/messaging/registration/riskScreening";
import { validateCustomerCareCopy } from "@/lib/messaging/registration/customerCareTemplates";
import {
  hasCarrierRejection,
  REJECTION_SUPPORT_MESSAGE,
} from "@/lib/onboarding/rejectionGuidance";
import {
  applyRegistrationStateSnapshot,
  type SettingsRegistrationState,
} from "@/lib/settings/registrationLock.server";
import type { A2pRiskChecklistAnswer } from "@/types/database";
import { requireWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";

const PREFLIGHT_FAILURE_MESSAGE =
  "Couldn't validate your compliance settings. Check Settings > Compliance, then try again.";

const REGISTRATION_LOCKED_MESSAGE =
  "Your registration is in carrier review — these details are locked until review completes.";

const REGISTRATION_STATE_CHANGED_MESSAGE =
  "Registration state changed while saving. Refresh the page and try again.";


type SmsUseCaseBusinessRow = {
  id: string;
  compliance_info_completed_at: string | null;
  slug: string;
  privacy_terms_mode: PrivacyTermsMode | null;
  privacy_url_override: string | null;
  terms_url_override: string | null;
  website_url: string | null;
  legal_business_name: string | null;
  business_entity_type: string | null;
  business_registration_state: string | null;
  has_ein: boolean | null;
  ein: string | null;
  authorized_rep_name: string | null;
  authorized_rep_title: string | null;
  authorized_rep_email: string | null;
  authorized_rep_phone: string | null;
} & SettingsRegistrationState;

function rejectionSupportResponse() {
  return NextResponse.json(
    {
      error: REJECTION_SUPPORT_MESSAGE,
      code: "rejection_support_required",
    },
    { status: 409 }
  );
}

function registrationStateOf(
  business: SettingsRegistrationState
): SettingsRegistrationState {
  return {
    telnyx_brand_id: business.telnyx_brand_id,
    brand_status: business.brand_status,
    campaign_status: business.campaign_status,
    onboarding_registration_status: business.onboarding_registration_status,
  };
}

async function registrationSnapshotMissResponse(args: {
  businessId: string;
  ownerId: string;
}) {
  const { data: current, error } = await supabaseAdmin
    .from("businesses")
    .select(
      "id, telnyx_brand_id, brand_status, campaign_status, onboarding_registration_status"
    )
    .eq("id", args.businessId)
    .eq("owner_id", args.ownerId)
    .is("deleted_at", null)
    .maybeSingle<SettingsRegistrationState & { id: string }>();

  if (error || !current) {
    return NextResponse.json(
      { error: "Failed to save SMS use case details" },
      { status: 500 }
    );
  }
  if (hasCarrierRejection(current.brand_status, current.campaign_status)) {
    return rejectionSupportResponse();
  }
  if (
    registrationHasStartedForRisk(current) &&
    current.onboarding_registration_status !== "failed"
  ) {
    return NextResponse.json(
      { error: REGISTRATION_LOCKED_MESSAGE },
      { status: 409 }
    );
  }
  return NextResponse.json(
    {
      error: REGISTRATION_STATE_CHANGED_MESSAGE,
      code: "registration_state_changed",
    },
    { status: 409 }
  );
}

export async function POST(request: NextRequest) {
  const workspaceGate = await requireWorkspaceRouteAccess();
  if (!workspaceGate.ok) return workspaceGate.response;

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = smsUseCaseSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid form data", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const data = parsed.data;
  const customerCareErrors = validateCustomerCareCopy({
    useCaseDescription: data.use_case_description,
    sampleMessages: data.sample_messages,
    optInDescription: data.opt_in_description,
  });
  if (customerCareErrors.length > 0) {
    return NextResponse.json(
      {
        error: customerCareErrors[0],
        details: customerCareErrors,
      },
      { status: 400 }
    );
  }

  const { data: business, error: ownershipError } = await supabase
    .from("businesses")
    .select(
      [
        "id",
        "compliance_info_completed_at",
        "slug",
        "privacy_terms_mode",
        "privacy_url_override",
        "terms_url_override",
        "website_url",
        "legal_business_name",
        "business_entity_type",
        "business_registration_state",
        "has_ein",
        "ein",
        "authorized_rep_name",
        "authorized_rep_title",
        "authorized_rep_email",
        "authorized_rep_phone",
        "telnyx_brand_id",
        "brand_status",
        "campaign_status",
        "onboarding_registration_status",
      ].join(", ")
    )
    .eq("id", data.businessId)
    .eq("owner_id", user.id)
    .single<SmsUseCaseBusinessRow>();

  if (ownershipError || !business) {
    return NextResponse.json(
      { error: "Business not found or unauthorized" },
      { status: 403 }
    );
  }

  // Rejected registrations are support-only. Stop stale form submissions
  // before slug generation, risk screening, audit writes, or business writes.
  if (hasCarrierRejection(business.brand_status, business.campaign_status)) {
    return rejectionSupportResponse();
  }

  // Compliance content feeds the submitted Telnyx campaign, which can't be
  // updated mid-review — edits would only drift the DB from the filed
  // registration.
  if (
    registrationHasStartedForRisk(business) &&
    business.onboarding_registration_status !== "failed"
  ) {
    return NextResponse.json(
      { error: REGISTRATION_LOCKED_MESSAGE },
      { status: 409 }
    );
  }

  if (
    !business.legal_business_name ||
    !business.business_entity_type ||
    !business.business_registration_state ||
    business.has_ein !== true ||
    !business.ein ||
    !business.authorized_rep_name ||
    !business.authorized_rep_title ||
    !business.authorized_rep_email ||
    !business.authorized_rep_phone
  ) {
    return NextResponse.json(
      { error: "Finish business verification before SMS use case details" },
      { status: 400 }
    );
  }

  const isFirstSubmit = !business.compliance_info_completed_at;
  let slugForUpdate: string | undefined;

  if (isFirstSubmit && isPendingSlug(business.slug)) {
    const baseSlug = generateSlug(business.legal_business_name);
    try {
      slugForUpdate = await ensureUniqueSlug(baseSlug);
    } catch (err) {
      console.error(
        `[onboarding:sms-use-case] Slug generation failed for ${data.businessId}:`,
        err
      );
      return NextResponse.json(
        { error: "Failed to generate a unique URL slug for your business" },
        { status: 500 }
      );
    }
  }

  const resolvedSlug = slugForUpdate ?? business.slug;
  const preflightBusiness = {
    slug: resolvedSlug,
    privacy_terms_mode: (business.privacy_terms_mode ??
      "hosted") as PrivacyTermsMode,
    privacy_url_override: business.privacy_url_override,
    terms_url_override: business.terms_url_override,
  };

  try {
    resolveLegalUrls(preflightBusiness);
    const trimmedWebsite = business.website_url?.trim();
    if (!trimmedWebsite) {
      buildBusinessLandingUrl(resolvedSlug);
    }
  } catch (err) {
    console.error(
      `[onboarding:sms-use-case] Pre-flight failed for ${data.businessId}:`,
      err
    );
    await appendRegistrationEvent({
      businessId: data.businessId,
      eventType: "brand_submitted",
      resourceType: "brand",
      status: "error",
      rawPayload: { preflight_failure: serializeError(err) },
    });
    return NextResponse.json(
      { error: PREFLIGHT_FAILURE_MESSAGE },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();
  const trimmedSamples = data.sample_messages.map((sample) => sample.trim());
  const checklistSelections = data.a2p_risk_checklist_selections.filter(
    isA2pRiskSelection
  );
  const editablePayload = {
    use_case_description: data.use_case_description,
    estimated_monthly_volume: data.estimated_monthly_volume,
    sample_messages: trimmedSamples,
    opt_in_description: data.opt_in_description,
    a2p_risk_review_customer_answer:
      data.a2p_risk_checklist_answer as A2pRiskChecklistAnswer,
    a2p_risk_review_customer_selections: checklistSelections,
    onboarding_last_saved_at: now,
  };

  let riskResult: A2pRiskReviewResult;
  try {
    riskResult = await screenA2pRiskForBusiness(data.businessId, {
      useCaseDescription: data.use_case_description,
      sampleMessages: trimmedSamples,
      optInDescription: data.opt_in_description,
      checklistAnswer: data.a2p_risk_checklist_answer,
      checklistSelections,
    });
  } catch (err) {
    console.error(
      `[onboarding:sms-use-case] A2P risk scan failed for ${data.businessId}:`,
      err
    );
    return NextResponse.json(
      {
        error:
          "Couldn't complete SMS eligibility review right now. Please try again.",
      },
      { status: 500 }
    );
  }

  const riskCleared =
    riskResult.registrationStarted ||
    riskResult.status === "passed" ||
    riskResult.status === "admin_approved";
  const preSubmissionRecoveryPayload = !riskResult.registrationStarted
    ? {
        onboarding_registration_status: "not_started" as const,
        onboarding_registration_error: null,
        onboarding_registration_started_at: null,
        onboarding_registration_submitted_at: null,
      }
    : {};

  if (!riskCleared) {
    let draftQuery = supabaseAdmin
      .from("businesses")
      .update({
        ...editablePayload,
        ...(slugForUpdate ? { slug: slugForUpdate } : {}),
        compliance_info_completed_at: null,
        onboarding_step: "sms_use_case" as const,
      })
      .eq("id", data.businessId)
      .eq("owner_id", user.id)
      .is("deleted_at", null);
    draftQuery = applyRegistrationStateSnapshot(
      draftQuery,
      registrationStateOf(business)
    );
    const { data: updatedDraft, error: draftError } = await draftQuery
      .select("id")
      .maybeSingle();

    if (draftError) {
      console.error(
        `[onboarding:sms-use-case] Failed to persist held SMS fields for ${data.businessId}:`,
        draftError
      );
      return NextResponse.json(
        { error: "Failed to save SMS use case details" },
        { status: 500 }
      );
    }
    if (!updatedDraft) {
      return registrationSnapshotMissResponse({
        businessId: data.businessId,
        ownerId: user.id,
      });
    }

    return NextResponse.json({
      success: false,
      riskReview: riskResult,
    });
  }

  if (isFirstSubmit) {
    let updateQuery = supabaseAdmin
      .from("businesses")
      .update({
        ...editablePayload,
        ...(slugForUpdate ? { slug: slugForUpdate } : {}),
        ...preSubmissionRecoveryPayload,
        compliance_info_completed_at: now,
        onboarding_step: "phone_number" as const,
      })
      .eq("id", data.businessId)
      .eq("owner_id", user.id)
      .is("deleted_at", null)
      .is("compliance_info_completed_at", null);
    updateQuery = applyRegistrationStateSnapshot(
      updateQuery,
      registrationStateOf(business)
    );
    const { data: updated, error: updateError } = await updateQuery
      .select("id")
      .maybeSingle();

    if (updateError) {
      console.error(
        `[onboarding:sms-use-case] Failed to persist compliance fields for ${data.businessId}:`,
        updateError
      );
      return NextResponse.json(
        { error: "Failed to save SMS use case details" },
        { status: 500 }
      );
    }

    if (!updated) {
      return registrationSnapshotMissResponse({
        businessId: data.businessId,
        ownerId: user.id,
      });
    }
  } else {
    let updateQuery = supabaseAdmin
      .from("businesses")
      .update({
        ...editablePayload,
        ...preSubmissionRecoveryPayload,
        compliance_info_completed_at: business.compliance_info_completed_at ?? now,
        onboarding_step: "phone_number" as const,
      })
      .eq("id", data.businessId)
      .eq("owner_id", user.id)
      .is("deleted_at", null);
    updateQuery = applyRegistrationStateSnapshot(
      updateQuery,
      registrationStateOf(business)
    );
    const { data: updated, error: updateError } = await updateQuery
      .select("id")
      .maybeSingle();

    if (updateError) {
      console.error(
        `[onboarding:sms-use-case] Failed to update compliance fields for ${data.businessId}:`,
        updateError
      );
      return NextResponse.json(
        { error: "Failed to save SMS use case details" },
        { status: 500 }
      );
    }
    if (!updated) {
      return registrationSnapshotMissResponse({
        businessId: data.businessId,
        ownerId: user.id,
      });
    }
  }

  return NextResponse.json({ success: true, riskReview: riskResult });
}
