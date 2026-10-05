import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { hasCarrierRejection } from "@/lib/onboarding/rejectionGuidance";
import {
  applyRegistrationStateSnapshot,
  isSettingsRegistrationLocked,
  registrationStateUnavailableResponse,
  SETTINGS_REGISTRATION_STATE_COLUMNS,
  settingsRegistrationLockedResponse,
  settingsStateChangedResponse,
  type SettingsRegistrationState,
} from "@/lib/settings/registrationLock.server";
import { BUSINESS_ADDRESS_LOCK_COPY } from "@/lib/settings/registrationLockCopy";
import {
  validateBusinessContactPhone,
  validateBusinessInfoSettings,
} from "@/lib/settings/businessInfo";
import { supabaseAdmin } from "@/lib/supabase/admin";

const PhoneOnlyUpdateSchema = z
  .object({
    phoneNumber: z.string(),
  })
  .strict();

const FullBusinessInfoUpdateSchema = z
  .object({
    phoneNumber: z.string(),
    address: z.string(),
    city: z.string(),
    state: z.string(),
    zip: z.string(),
  })
  .strict();

const BusinessInfoUpdateSchema = z.union([
  FullBusinessInfoUpdateSchema,
  PhoneOnlyUpdateSchema,
]);

const BUSINESS_CONTACT_PHONE_LOCK_COPY = {
  supportText: "Contact support to change your business contact phone",
  reasonText: " because it was filed with your carrier registration.",
  message:
    "Contact support to change your business contact phone because it was filed with your carrier registration.",
} as const;

type BusinessInfoRegistrationState = SettingsRegistrationState & {
  shared_registration_id: string | null;
};
const BUSINESS_INFO_STATE_COLUMNS = `${SETTINGS_REGISTRATION_STATE_COLUMNS}, shared_registration_id`;

function isAddressLocked(state: BusinessInfoRegistrationState): boolean {
  return Boolean(state.shared_registration_id) || isSettingsRegistrationLocked(state);
}

async function loadRegistrationState(businessId: string, ownerId: string) {
  return supabaseAdmin
    .from("businesses")
    .select(BUSINESS_INFO_STATE_COLUMNS)
    .eq("id", businessId)
    .eq("owner_id", ownerId)
    .is("deleted_at", null)
    .maybeSingle<BusinessInfoRegistrationState>();
}

function invalidInput(details: unknown) {
  return NextResponse.json(
    { error: "Invalid input", details },
    { status: 400 }
  );
}

function saveFailedResponse() {
  return NextResponse.json(
    { error: "Failed to save business information" },
    { status: 500 }
  );
}

export async function POST(request: NextRequest) {
  const workspaceGate = await requireWorkspaceRouteAccess();
  if (!workspaceGate.ok) return workspaceGate.response;

  if (!workspaceGate.access.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = BusinessInfoUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return invalidInput(parsed.error.flatten());
  }

  const isFullUpdate = "address" in parsed.data;
  const businessId = workspaceGate.access.business.id;
  const ownerId = workspaceGate.access.user.id;

  if (!isFullUpdate) {
    const phoneValidation = validateBusinessContactPhone(
      parsed.data.phoneNumber
    );
    if (!phoneValidation.success) {
      return invalidInput({ phoneNumber: phoneValidation.error });
    }

    let registrationResult: Awaited<ReturnType<typeof loadRegistrationState>>;
    try {
      registrationResult = await loadRegistrationState(businessId, ownerId);
    } catch {
      console.error(
        `[settings:business-info] Failed to load registration state for business ${businessId}`
      );
      return registrationStateUnavailableResponse();
    }

    const { data: registrationState, error: registrationStateError } =
      registrationResult;
    if (registrationStateError || !registrationState) {
      console.error(
        `[settings:business-info] Failed to load registration state for business ${businessId}`
      );
      return registrationStateUnavailableResponse();
    }
    if (
      hasCarrierRejection(
        registrationState.brand_status,
        registrationState.campaign_status
      )
    ) {
      return settingsRegistrationLockedResponse(
        BUSINESS_CONTACT_PHONE_LOCK_COPY
      );
    }

    let updateResult:
      | { data: { id: string } | null; error: unknown }
      | undefined;
    try {
      let updateQuery = supabaseAdmin
        .from("businesses")
        .update({ phone_number: phoneValidation.payload })
        .eq("id", businessId)
        .eq("owner_id", ownerId)
        .is("deleted_at", null);
      updateQuery = applyRegistrationStateSnapshot(
        updateQuery,
        registrationState
      );
      updateResult = await updateQuery.select("id").maybeSingle<{ id: string }>();
    } catch {
      console.error(
        `[settings:business-info] Failed to update contact phone for business ${businessId}`
      );
      return saveFailedResponse();
    }

    if (updateResult.error) {
      console.error(
        `[settings:business-info] Failed to update contact phone for business ${businessId}`
      );
      return saveFailedResponse();
    }
    if (updateResult.data) return NextResponse.json({ success: true });

    let currentResult: Awaited<ReturnType<typeof loadRegistrationState>>;
    try {
      currentResult = await loadRegistrationState(businessId, ownerId);
    } catch {
      console.error(
        `[settings:business-info] Failed to reload registration state for business ${businessId}`
      );
      return registrationStateUnavailableResponse();
    }

    if (currentResult.error || !currentResult.data) {
      console.error(
        `[settings:business-info] Failed to reload registration state for business ${businessId}`
      );
      return registrationStateUnavailableResponse();
    }
    if (
      hasCarrierRejection(
        currentResult.data.brand_status,
        currentResult.data.campaign_status
      )
    ) {
      return settingsRegistrationLockedResponse(
        BUSINESS_CONTACT_PHONE_LOCK_COPY
      );
    }

    return settingsStateChangedResponse();
  }

  const validation = validateBusinessInfoSettings(
    parsed.data as z.infer<typeof FullBusinessInfoUpdateSchema>
  );
  if (!validation.success) {
    return invalidInput(validation.errors);
  }

  let registrationResult: Awaited<ReturnType<typeof loadRegistrationState>>;
  try {
    registrationResult = await loadRegistrationState(businessId, ownerId);
  } catch {
    console.error(
      `[settings:business-info] Failed to load registration state for business ${businessId}`
    );
    return registrationStateUnavailableResponse();
  }

  const {
    data: registrationState,
    error: registrationStateError,
  } = registrationResult;
  if (registrationStateError || !registrationState) {
    console.error(
      `[settings:business-info] Failed to load registration state for business ${businessId}`
    );
    return registrationStateUnavailableResponse();
  }

  if (isAddressLocked(registrationState)) {
    return settingsRegistrationLockedResponse(BUSINESS_ADDRESS_LOCK_COPY);
  }

  let updateResult:
    | { data: { id: string } | null; error: unknown }
    | undefined;
  try {
    let updateQuery = supabaseAdmin
      .from("businesses")
      .update(validation.payload)
      .eq("id", businessId)
      .eq("owner_id", ownerId)
      .is("deleted_at", null);

    updateQuery = applyRegistrationStateSnapshot(
      updateQuery,
      registrationState
    );

    updateResult = await updateQuery.select("id").maybeSingle<{ id: string }>();
  } catch {
    console.error(
      `[settings:business-info] Failed to update business information for business ${businessId}`
    );
    return saveFailedResponse();
  }

  if (updateResult.error) {
    console.error(
      `[settings:business-info] Failed to update business information for business ${businessId}`
    );
    return saveFailedResponse();
  }

  if (updateResult.data) {
    return NextResponse.json({ success: true });
  }

  let currentRegistrationResult: Awaited<
    ReturnType<typeof loadRegistrationState>
  >;
  try {
    currentRegistrationResult = await loadRegistrationState(
      businessId,
      ownerId
    );
  } catch {
    console.error(
      `[settings:business-info] Failed to reload registration state for business ${businessId}`
    );
    return registrationStateUnavailableResponse();
  }

  const {
    data: currentRegistrationState,
    error: currentRegistrationStateError,
  } = currentRegistrationResult;
  if (currentRegistrationStateError || !currentRegistrationState) {
    console.error(
      `[settings:business-info] Failed to reload registration state for business ${businessId}`
    );
    return registrationStateUnavailableResponse();
  }

  if (isAddressLocked(currentRegistrationState)) {
    return settingsRegistrationLockedResponse(BUSINESS_ADDRESS_LOCK_COPY);
  }

  return settingsStateChangedResponse();
}
