import "server-only";
import type Stripe from "stripe";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { stripe } from "./client";
import { verifiedPaidInvoice } from "./smsBilling.server";

export interface VoiceSubscriptionSnapshot {
  subscription: Stripe.Subscription;
  revision: number | null;
  observedAt: string | null;
  ignored?: boolean;
}

/** Acquire a database version BEFORE reading Stripe. Unrelated billing keeps its existing path. */
export async function prepareVoiceSubscription(
  subscription: Stripe.Subscription,
  businessId: string | null | undefined,
): Promise<VoiceSubscriptionSnapshot> {
  const unchanged = { subscription, revision: null, observedAt: null };
  if (!businessId || typeof subscription.customer !== "string" || !subscription.id) return unchanged;
  const { data: revision, error } = await supabaseAdmin.rpc("begin_voice_billing_reconciliation", {
    p_business_id: businessId, p_subscription_id: subscription.id, p_customer_id: subscription.customer,
  });
  if (error) throw new Error("voice_billing_reconciliation_unavailable");
  if (revision === null) return unchanged;
  // A signed event for a different historical/orphan subscription is not
  // authority to replace the account's canonical billing source.
  if (revision === -1) return { ...unchanged, ignored: true };
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("voice_billing_revision_invalid");
  const observedAt = new Date().toISOString();
  const fresh = await stripe.subscriptions.retrieve(subscription.id);
  if (fresh.id !== subscription.id || fresh.customer !== subscription.customer || fresh.metadata?.business_id !== businessId) {
    throw new Error("voice_billing_source_mismatch");
  }
  const key = process.env.STRIPE_SECRET_KEY || "";
  const live = key.startsWith("sk_live_") ? true : key.startsWith("sk_test_") ? false : null;
  if (live === null || fresh.livemode !== live) throw new Error("voice_billing_mode_mismatch");
  if (fresh.status === "active") {
    const invoice = await verifiedPaidInvoice(fresh);
    const item = fresh.items.data[0];
    // Renewals require the actual recurring monthly invoice line. Proration
    // invoices receive their bounded allowance through the paid-operation hook.
    const coversPeriod = invoice && item && invoice.lines.data.some((line) =>
      line.period.start === item.current_period_start && line.period.end === item.current_period_end &&
      line.parent?.subscription_item_details?.subscription_item === item.id &&
      !line.parent.subscription_item_details.proration);
    if (coversPeriod) {
      const { data, error: paymentError } = await supabaseAdmin.rpc("record_voice_billing_payment", {
        p_business_id: businessId, p_revision: revision, p_subscription_id: fresh.id, p_customer_id: fresh.customer,
        p_invoice_id: invoice.id, p_period_start: new Date(item.current_period_start * 1000).toISOString(),
        p_period_end: new Date(item.current_period_end * 1000).toISOString(),
        p_paid_at: new Date(invoice.status_transitions.paid_at! * 1000).toISOString(),
      });
      if (paymentError || data !== true) throw new Error("voice_billing_payment_verification_unavailable");
    }
  }
  return { subscription: fresh, revision, observedAt };
}
