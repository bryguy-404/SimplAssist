import { brandVerificationServerSchema } from "@/lib/onboarding/formValidation.server";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { registrationHasStartedForRisk } from "@/lib/messaging/registration/riskScreening";
import { normalizeUsStateCode } from "@/lib/usStates";
import {
  hasCarrierRejection,
  REJECTION_SUPPORT_MESSAGE,
} from "@/lib/onboarding/rejectionGuidance";
import {
  applyRegistrationStateSnapshot,
  type SettingsRegistrationState,
} from "@/lib/settings/registrationLock.server";
import { requireWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";

const REGISTRATION_LOCKED_MESSAGE =
  "Your registration is in carrier review — these details are locked until review completes.";

const EIN_ALREADY_CONNECTED_MESSAGE =
  "This EIN is already connected to a SimplAssist account. Sign in to the original account or contact SimplAssist Support for help.";

const REGISTRATION_STATE_CHANGED_MESSAGE =
  "Registration state changed while saving. Refresh the page and try again.";

function canonicalizeEin(value: string): string {
  const digits = value.replace(/\D/g, "");
  return `${digits.slice(0, 2)}-${digits.slice(2)}`;
}

function einAlreadyConnectedResponse() {
  return NextResponse.json(
    {
      error: EIN_ALREADY_CONNECTED_MESSAGE,
      code: "ein_already_connected",
    },
    { status: 409 }
  );
}

function rejectionSupportResponse() {
  return NextResponse.json(
    {
      error: REJECTION_SUPPORT_MESSAGE,
      code: "rejection_support_required",
    },
    { status: 409 },
  );
}

function registrationStateOf(
  business: SettingsRegistrationState,
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
  fallbackError: string;
}) {
  const { data: current, error } = await supabaseAdmin
    .from("businesses")
    .select(
      "id, telnyx_brand_id, brand_status, campaign_status, onboarding_registration_status",
    )
    .eq("id", args.businessId)
    .eq("owner_id", args.ownerId)
    .is("deleted_at", null)
    .maybeSingle<SettingsRegistrationState & { id: string }>();

  if (error || !current) {
    return NextResponse.json({ error: args.fallbackError }, { status: 500 });
  }
  if (hasCarrierRejection(current.brand_status, current.campaign_status)) {
    return rejectionSupportResponse();
  }
  if (
    registrationHasStartedForRisk(current) &&
    current.onboarding_registration_status !== "failed"
  ) {
    return NextResponse.json({ error: REGISTRATION_LOCKED_MESSAGE }, { status: 409 });
  }
  return NextResponse.json(
    {
      error: REGISTRATION_STATE_CHANGED_MESSAGE,
      code: "registration_state_changed",
    },
    { status: 409 },
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

  const parsed = brandVerificationServerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid form data", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const data = parsed.data;

  const { data: business, error: ownershipError } = await supabase
    .from("businesses")
    .select(
      "id, owner_id, deleted_at, no_ein_hold_status, telnyx_brand_id, brand_status, campaign_status, onboarding_registration_status"
    )
    .eq("id", data.businessId)
    .eq("owner_id", user.id)
    .single();

  if (
    ownershipError ||
    !business ||
    business.owner_id !== user.id ||
    business.deleted_at
  ) {
    return NextResponse.json(
      { error: "Business not found or unauthorized" },
      { status: 403 }
    );
  }

  // Rejected registrations are support-only. This fresh read closes stale-tab
  // edits before any service-role lookup or write can drift the saved identity
  // from the carrier submission staff must review.
  if (hasCarrierRejection(business.brand_status, business.campaign_status)) {
    return rejectionSupportResponse();
  }

  // Legal identity is frozen while a submitted registration awaits carrier
  // review — the Telnyx brand can't be updated, so edits would only drift the
  // DB from the filed brand.
  if (
    registrationHasStartedForRisk(business) &&
    business.onboarding_registration_status !== "failed"
  ) {
    return NextResponse.json(
      { error: REGISTRATION_LOCKED_MESSAGE },
      { status: 409 }
    );
  }

  const now = new Date().toISOString();
  if (data.has_ein === false) {
    let updateQuery = supabaseAdmin
      .from("businesses")
      .update({
        has_ein: false,
        a2p_brand_tier: null,
        no_ein_hold_status: data.join_waitlist ? "waitlisted" : "ein_encouraged",
        no_ein_waitlist_requested_at: data.join_waitlist ? now : null,
        onboarding_step: "legal_verification",
        onboarding_last_saved_at: now,
      })
      .eq("id", data.businessId)
      .eq("owner_id", user.id)
      .is("deleted_at", null);
    updateQuery = applyRegistrationStateSnapshot(
      updateQuery,
      registrationStateOf(business),
    );
    const { data: updatedBusiness, error: updateError } = await updateQuery
      .select("id")
      .maybeSingle();

    if (updateError || !updatedBusiness) {
      // The conditional write also protects against ownership/deletion races.
      // Never attach the DB error because it can contain legal-account data.
      console.error(
        "[onboarding:brand-verification] Failed to save No-EIN hold"
      );
      if (!updateError) {
        return registrationSnapshotMissResponse({
          businessId: data.businessId,
          ownerId: user.id,
          fallbackError: "Failed to save EIN status",
        });
      }
      return NextResponse.json({ error: "Failed to save EIN status" }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      held: true,
      code: "held_no_ein",
    });
  }

  const registrationStateCode = normalizeUsStateCode(data.business_registration_state);

  if (!registrationStateCode) {
    return NextResponse.json(
      { error: "Invalid state of registration" },
      { status: 400 }
    );
  }

  const convertedFromNoEin =
    business.no_ein_hold_status === "ein_encouraged" ||
    business.no_ein_hold_status === "waitlisted";

  // Check with the service-role client so RLS cannot hide an EIN held by a
  // different account. Deliberately do not filter on deleted_at: retained
  // accounts still own their legal identity until final cleanup removes it.
  // The database uniqueness constraint remains the race-safe final guard.
  const canonicalEin = canonicalizeEin(data.ein);
  const {
    data: businessWithEin,
    error: einAvailabilityError,
  } = await supabaseAdmin
    .from("businesses")
    .select("id")
    .eq("ein", canonicalEin)
    .neq("id", data.businessId)
    .limit(1)
    .maybeSingle();

  if (einAvailabilityError) {
    // Do not attach the query error here: Postgres duplicate errors can embed
    // the EIN or details about the conflicting row.
    console.error(
      "[onboarding:brand-verification] EIN availability check failed"
    );
    return NextResponse.json(
      { error: "Failed to verify EIN availability" },
      { status: 500 }
    );
  }

  if (businessWithEin) {
    return einAlreadyConnectedResponse();
  }

  let updateQuery = supabaseAdmin
    .from("businesses")
    .update({
      has_ein: true,
      a2p_brand_tier: "low_volume_standard",
      no_ein_hold_status: convertedFromNoEin ? "converted_to_ein" : "none",
      legal_business_name: data.legal_business_name,
      business_entity_type: data.business_entity_type,
      business_registration_state: registrationStateCode,
      tax_id_type: "ein" as const,
      ein: canonicalEin,
      authorized_rep_name: data.authorized_rep_name,
      authorized_rep_title: data.authorized_rep_title,
      authorized_rep_email: data.authorized_rep_email,
      authorized_rep_phone: data.authorized_rep_phone,
      onboarding_step: "sms_use_case",
      onboarding_last_saved_at: now,
    })
    .eq("id", data.businessId)
    .eq("owner_id", user.id)
    .is("deleted_at", null);
  updateQuery = applyRegistrationStateSnapshot(
    updateQuery,
    registrationStateOf(business),
  );
  const { data: updatedBusiness, error: updateError } = await updateQuery
    .select("id")
    .maybeSingle();

  if (updateError) {
    if (updateError.code === "23505") {
      return einAlreadyConnectedResponse();
    }

    // Keep provider/database details out of logs because an error can echo
    // legal identity fields from this write.
    console.error(
      "[onboarding:brand-verification] Failed to save legal fields"
    );
    return NextResponse.json(
      { error: "Failed to save business verification info" },
      { status: 500 }
    );
  }

  if (!updatedBusiness) {
    // Ownership, deletion, or registration state changed after the initial
    // read. Re-read so a carrier rejection gets its stable support response.
    console.error(
      "[onboarding:brand-verification] Legal-field write missed its state snapshot"
    );
    return registrationSnapshotMissResponse({
      businessId: data.businessId,
      ownerId: user.id,
      fallbackError: "Failed to save business verification info",
    });
  }

  return NextResponse.json({ success: true });
}
