import { BusinessInfoSchema } from "@/lib/onboarding/formValidation.server";
import "server-only";

import { NextRequest, NextResponse } from "next/server";

import { requireWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import {
  hasCarrierRejection,
  REJECTION_SUPPORT_MESSAGE,
} from "@/lib/onboarding/rejectionGuidance";
import {
  applyRegistrationStateSnapshot,
  isSettingsRegistrationLocked,
  SETTINGS_REGISTRATION_STATE_COLUMNS,
  type SettingsRegistrationState,
} from "@/lib/settings/registrationLock.server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { normalizeUsStateCode } from "@/lib/usStates";

type RegistrationStateRow = SettingsRegistrationState & {
  id: string;
  owner_id: string;
  deleted_at: string | null;
};

const REGISTRATION_STATE_COLUMNS = [
  "id",
  "owner_id",
  "deleted_at",
  SETTINGS_REGISTRATION_STATE_COLUMNS,
].join(", ");

const REGISTRATION_LOCKED_MESSAGE =
  "Your registration is in carrier review — these details are locked until review completes.";
const REGISTRATION_STATE_UNAVAILABLE_MESSAGE =
  "We could not verify your registration status. Refresh the page and try again, or contact support.";
const REGISTRATION_STATE_CHANGED_MESSAGE =
  "Your registration status changed while you were saving. Refresh the page and try again.";

function rejectionSupportResponse() {
  return NextResponse.json(
    {
      error: REJECTION_SUPPORT_MESSAGE,
      code: "rejection_support_required",
    },
    { status: 409 },
  );
}

function registrationLockedResponse() {
  return NextResponse.json(
    { error: REGISTRATION_LOCKED_MESSAGE, code: "registration_locked" },
    { status: 409 },
  );
}

function registrationStateUnavailableResponse() {
  return NextResponse.json(
    {
      error: REGISTRATION_STATE_UNAVAILABLE_MESSAGE,
      code: "registration_state_unavailable",
    },
    { status: 503 },
  );
}

function registrationStateChangedResponse() {
  return NextResponse.json(
    {
      error: REGISTRATION_STATE_CHANGED_MESSAGE,
      code: "registration_state_changed",
    },
    { status: 409 },
  );
}

function unauthorizedBusinessResponse() {
  return NextResponse.json(
    { error: "Business not found or unauthorized" },
    { status: 403 },
  );
}

function saveFailedResponse() {
  return NextResponse.json(
    { error: "Could not save your business information. Please try again." },
    { status: 500 },
  );
}

function registrationSnapshot(
  row: RegistrationStateRow,
): SettingsRegistrationState {
  return {
    telnyx_brand_id: row.telnyx_brand_id,
    brand_status: row.brand_status,
    campaign_status: row.campaign_status,
    onboarding_registration_status: row.onboarding_registration_status,
  };
}

function registrationGuardResponse(state: SettingsRegistrationState) {
  if (hasCarrierRejection(state.brand_status, state.campaign_status)) {
    return rejectionSupportResponse();
  }

  if (isSettingsRegistrationLocked(state)) {
    return registrationLockedResponse();
  }

  return null;
}

async function loadRegistrationState(businessId: string) {
  return supabaseAdmin
    .from("businesses")
    .select(REGISTRATION_STATE_COLUMNS)
    .eq("id", businessId)
    .maybeSingle<RegistrationStateRow>();
}

export async function POST(request: NextRequest) {
  const workspaceGate = await requireWorkspaceRouteAccess();
  if (!workspaceGate.ok) return workspaceGate.response;

  const user = workspaceGate.access.user;
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = BusinessInfoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const businessId = workspaceGate.access.business.id;
  let initialResult: Awaited<ReturnType<typeof loadRegistrationState>>;
  try {
    initialResult = await loadRegistrationState(businessId);
  } catch {
    console.error(
      `[onboarding:business-info] Failed to load registration state for business ${businessId}`,
    );
    return registrationStateUnavailableResponse();
  }

  if (initialResult.error) {
    console.error(
      `[onboarding:business-info] Failed to load registration state for business ${businessId}`,
    );
    return registrationStateUnavailableResponse();
  }

  const initialRow = initialResult.data;
  if (
    !initialRow ||
    initialRow.owner_id !== user.id ||
    initialRow.deleted_at !== null
  ) {
    return unauthorizedBusinessResponse();
  }

  const initialSnapshot = registrationSnapshot(initialRow);
  const initialGuard = registrationGuardResponse(initialSnapshot);
  if (initialGuard) return initialGuard;

  const data = parsed.data;
  const normalizedState = normalizeUsStateCode(data.state);
  if (!normalizedState) {
    return NextResponse.json(
      { error: "Invalid input", details: { state: "Select a valid state" } },
      { status: 400 },
    );
  }

  let updateResult:
    | { data: { id: string } | null; error: unknown }
    | undefined;
  try {
    let updateQuery = supabaseAdmin
      .from("businesses")
      .update({
        name: data.name,
        business_type: data.business_type,
        business_type_other:
          data.business_type === "other"
            ? data.business_type_other || null
            : null,
        website_url: data.website || null,
        phone_number: data.phone,
        email: data.email,
        address: data.address,
        city: data.city,
        state: normalizedState,
        zip: data.zip,
        timezone: data.timezone,
        onboarding_step: "business_hours",
        onboarding_last_saved_at: new Date().toISOString(),
      })
      .eq("id", businessId)
      .eq("owner_id", user.id)
      .is("deleted_at", null);

    updateQuery = applyRegistrationStateSnapshot(
      updateQuery,
      initialSnapshot,
    );
    updateResult = await updateQuery.select("id").maybeSingle<{ id: string }>();
  } catch {
    console.error(
      `[onboarding:business-info] Failed to save business information for business ${businessId}`,
    );
    return saveFailedResponse();
  }

  if (updateResult.error) {
    console.error(
      `[onboarding:business-info] Failed to save business information for business ${businessId}`,
    );
    return saveFailedResponse();
  }

  if (updateResult.data) {
    return NextResponse.json({ success: true });
  }

  // A zero-row CAS means registration, ownership, or deletion state changed
  // after the fresh read. Re-read before choosing the customer-safe response;
  // never retry the write against the new state automatically.
  let currentResult: Awaited<ReturnType<typeof loadRegistrationState>>;
  try {
    currentResult = await loadRegistrationState(businessId);
  } catch {
    console.error(
      `[onboarding:business-info] Failed to reload registration state for business ${businessId}`,
    );
    return registrationStateUnavailableResponse();
  }

  if (currentResult.error) {
    console.error(
      `[onboarding:business-info] Failed to reload registration state for business ${businessId}`,
    );
    return registrationStateUnavailableResponse();
  }

  const currentRow = currentResult.data;
  if (
    !currentRow ||
    currentRow.owner_id !== user.id ||
    currentRow.deleted_at !== null
  ) {
    return unauthorizedBusinessResponse();
  }

  const currentGuard = registrationGuardResponse(
    registrationSnapshot(currentRow),
  );
  return currentGuard ?? registrationStateChangedResponse();
}
