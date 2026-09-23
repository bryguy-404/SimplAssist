import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  isNanpTollFreeNumber,
  searchAvailableNumbers,
} from "@/lib/messaging/numbers";
import { resolveSmsProvisioningAccess } from "@/lib/billing/entitlements";
import { requireWorkspaceRouteAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { textingUpgradeFailure } from "@/lib/billing/textingUpgradeResponse.server";

export async function GET(request: NextRequest) {
  const workspaceGate = await requireWorkspaceRouteAccess();
  if (!workspaceGate.ok) return workspaceGate.response;

  const areaCode = request.nextUrl.searchParams.get("areaCode");

  if (!areaCode || !/^\d{3}$/.test(areaCode)) {
    return NextResponse.json(
      { error: "Area code must be 3 digits" },
      { status: 400 }
    );
  }

  // This picker provisions a local number for a 10DLC campaign. Reject
  // toll-free NPAs at the route boundary as well as filtering them from the
  // Telnyx inventory request so a stale or custom client cannot bypass the UI.
  if (isNanpTollFreeNumber(`+1${areaCode}0000000`)) {
    return NextResponse.json(
      {
        error:
          "Toll-free area codes are not supported for 10DLC registration. Enter a local area code.",
        code: "toll_free_not_supported",
      },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const upgradeId = request.nextUrl.searchParams.get("textingUpgradeId");
  if (upgradeId) {
    // Inventory lookup only. A saved upgrade grants neither purchase nor SMS access.
    try {
      const { getTextingUpgradeState } = await import("@/lib/billing/textingUpgrade.server");
      const state = await getTextingUpgradeState(workspaceGate.access.business.id, user.id);
      if (state.upgrade?.id !== upgradeId || !state.eligible ||
          !(state.actions.canReplacePhone || (state.actions.canSave && ["phone", "review"].includes(state.currentStep)))) {
        return NextResponse.json({ error: "texting_upgrade_number_selection_forbidden" }, { status: 403 });
      }
      return NextResponse.json({ numbers: await searchAvailableNumbers(areaCode) });
    } catch (error) { return textingUpgradeFailure(error); }
  }

  const smsAccess = await resolveSmsProvisioningAccess(
    workspaceGate.access.business.id,
    { allowDirectPrecheckout: true },
  );
  if (!smsAccess.allowed) {
    if (smsAccess.reason === "billing_state_unavailable") {
      return NextResponse.json(
        { error: "Unable to verify plan access", retryable: true },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: "SMS provisioning is not available on the current plan" },
      { status: 403 },
    );
  }

  try {
    const numbers = await searchAvailableNumbers(areaCode);
    return NextResponse.json({ numbers });
  } catch (error) {
    console.error("Error searching numbers:", error);
    return NextResponse.json(
      { error: "Failed to search numbers" },
      { status: 500 }
    );
  }
}
