import "server-only";

import { supabaseAdmin } from "@/lib/supabase/admin";
import { isSubscriptionPlan } from "./features";
import type { SubscriptionPlan } from "@/types/database";

export interface PendingPaidTextingUpgrade {
  id: string;
  business_id: string;
  source_subscription_id: string;
  source_customer_id: string;
  target_plan: Exclude<SubscriptionPlan, "chat_only">;
  state: "carrier_pending" | "support_required";
  billing_operation_id: string;
  paid_at: string;
  activated_at: null;
}

/** Service-owned payment proof; a saved draft can never authorize Telnyx. */
export async function readPendingPaidTextingUpgrade(
  businessId: string,
): Promise<PendingPaidTextingUpgrade | null> {
  const { data, error } = await supabaseAdmin
    .from("chat_texting_upgrades")
    .select("id,business_id,source_subscription_id,source_customer_id,target_plan,state,billing_operation_id,paid_at,activated_at")
    .eq("business_id", businessId)
    .in("state", ["carrier_pending", "support_required"])
    .maybeSingle<PendingPaidTextingUpgrade>();
  if (error) throw new Error("texting_upgrade_state_unavailable");
  if (!data) return null;
  if (
    data.business_id !== businessId || !data.id ||
    !data.source_subscription_id || !data.source_customer_id ||
    !data.billing_operation_id || !data.paid_at ||
    !Number.isFinite(Date.parse(data.paid_at)) || data.activated_at !== null ||
    !isSubscriptionPlan(data.target_plan) || (data.target_plan as string) === "chat_only" ||
    (data.state !== "carrier_pending" && data.state !== "support_required")
  ) throw new Error("texting_upgrade_state_invalid");
  return data;
}

/** A pending upgrade may retain Chat access, but cancellation stops provider work. */
export async function canContinueTextingUpgradeProvisioning(
  businessId: string,
): Promise<boolean> {
  const upgrade = await readPendingPaidTextingUpgrade(businessId);
  if (!upgrade) return true; // Established SMS provisioning keeps its existing gates.
  if (upgrade.state !== "carrier_pending") return false;
  const [billing, business] = await Promise.all([
    supabaseAdmin.from("subscriptions")
      .select("stripe_subscription_id,stripe_customer_id,plan,status,cancel_at_period_end,setup_fee_paid_at,current_period_start,current_period_end")
      .eq("business_id", businessId).maybeSingle(),
    supabaseAdmin.from("businesses")
      .select("id,deleted_at,operations_suspended_at,telnyx_submission_disabled,active_telnyx_release_run_id,telnyx_unique_claims_released_at,telnyx_resource_state")
      .eq("id", businessId).maybeSingle(),
  ]);
  if (billing.error || business.error) throw new Error("texting_upgrade_billing_unavailable");
  const data = billing.data;
  const account = business.data;
  const now = Date.now();
  return Boolean(
    account?.id === businessId && account.deleted_at === null &&
    account.operations_suspended_at === null && account.telnyx_submission_disabled === false &&
    account.active_telnyx_release_run_id === null && account.telnyx_unique_claims_released_at === null &&
    ["provisioning", "active"].includes(account.telnyx_resource_state) &&
    data && data.stripe_subscription_id === upgrade.source_subscription_id &&
    data.stripe_customer_id === upgrade.source_customer_id &&
    data.plan === upgrade.target_plan && data.status === "active" &&
    data.cancel_at_period_end === false && data.setup_fee_paid_at &&
    Date.parse(data.current_period_start) <= now && Date.parse(data.current_period_end) > now,
  );
}

export class TextingUpgradeProvisioningStoppedError extends Error {
  constructor() {
    super("Texting setup is paused. Review billing or contact support before continuing.");
    this.name = "TextingUpgradeProvisioningStoppedError";
  }
}

export async function assertTextingUpgradeProvisioningAllowed(businessId: string): Promise<void> {
  if (!(await canContinueTextingUpgradeProvisioning(businessId))) {
    throw new TextingUpgradeProvisioningStoppedError();
  }
}

/** The RPC checks payment, exact provider readiness and cancellation under a lock. */
export async function reconcileTextingUpgradeActivation(upgradeId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("activate_chat_texting_upgrade", {
    p_upgrade_id: upgradeId,
  });
  if (error) throw new Error("texting_upgrade_activation_unavailable");
  if (typeof data !== "boolean") throw new Error("texting_upgrade_activation_invalid");
  return data;
}

export async function reconcileTextingUpgradeActivationForBusiness(businessId: string): Promise<boolean> {
  const upgrade = await readPendingPaidTextingUpgrade(businessId);
  return upgrade ? reconcileTextingUpgradeActivation(upgrade.id) : false;
}
