import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getTextingUpgrade, getTextingUpgradeState, parseTextingUpgrade } from "./textingUpgrade.server";
import { canContinueTextingUpgradeProvisioning, reconcileTextingUpgradeActivation } from "./textingUpgradeActivation.server";
import { recoverTextingUpgradePayment, reconcileTextingUpgradePayment } from "@/lib/stripe/textingUpgrade.server";
import { refreshTextingUpgradeCarrierStatus } from "./textingUpgradeCarrierStatus.server";
import { attemptPaidLaunch } from "./launch";
import { ensureCampaignAssignmentForBusiness } from "@/lib/messaging/registration/phoneNumberAssignment";
import type { TextingUpgradeRecord } from "./textingUpgrade";

/** Explicit mutation boundary. The read-only state endpoint never calls this. */
export async function continueTextingUpgradeRegistration(businessId: string): Promise<void> {
  const u = await getTextingUpgrade(businessId);
  if (!u?.paid_at || u.activated_at || u.state !== "carrier_pending" || !(await canContinueTextingUpgradeProvisioning(businessId))) return;
  const launched = await attemptPaidLaunch(businessId, "texting_upgrade");
  if (launched.status === "rejection_support_required") { await reconcileTextingUpgradeActivation(u.id); return; }
  await refreshTextingUpgradeCarrierStatus(businessId);
  await ensureCampaignAssignmentForBusiness(businessId, { reason: "texting_upgrade_reconciliation" });
  await reconcileTextingUpgradeActivation(u.id);
}
export async function refreshTextingUpgrade(businessId: string, ownerId: string) {
  const paymentUrl = await recoverTextingUpgradePayment(businessId, ownerId);
  // Fresh provider synchronization preserves cancellations/renewals before any registration.
  const u = await getTextingUpgrade(businessId);
  if (u?.billing_operation_id) {
    const fresh = await reconcileTextingUpgradePayment(u);
    const { syncStripeSubscription } = await import("@/lib/stripe/subscriptionSync");
    await syncStripeSubscription(fresh, { deferTextingUpgradeRegistration: true });
  }
  await continueTextingUpgradeRegistration(businessId);
  const state = await getTextingUpgradeState(businessId, ownerId);
  if (paymentUrl && state.quote) state.quote.paymentUrl = paymentUrl;
  return state;
}

/** Claims lease work for fairness and overlap safety; individual failures remain recoverable. */
export async function reconcilePendingTextingUpgrades(args: { limit?: number; budgetMs?: number } = {}) {
  const limit = Math.min(5, Math.max(1, args.limit ?? 3));
  const budgetMs = Math.min(25_000, Math.max(1_000, args.budgetMs ?? 20_000));
  const { data, error } = await supabaseAdmin.rpc("claim_chat_texting_upgrade_reconciliation", { p_limit: limit, p_lease_seconds: 300 });
  if (error || !Array.isArray(data)) throw new Error("texting_upgrade_reconciliation_unavailable");
  const upgrades: TextingUpgradeRecord[] = data.map(parseTextingUpgrade);
  const started = Date.now();
  const result = { attempted: 0, failed: 0, deferred: 0 };
  for (const u of upgrades) {
    if (Date.now() - started >= budgetMs) { result.deferred++; continue; }
    result.attempted++;
    const work = refreshTextingUpgrade(u.business_id, u.owner_id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Leased, idempotent provider/DB operations may finish safely after caller timeout.
    const outcome = await Promise.race([
      work.then(() => "complete" as const, () => "failed" as const),
      new Promise<"deferred">((resolve) => { timer = setTimeout(() => resolve("deferred"), Math.max(1, budgetMs - (Date.now() - started))); }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome === "failed") result.failed++;
    if (outcome === "deferred") { result.deferred += upgrades.length - result.attempted + 1; break; }
  }
  return result;
}
