import "server-only";
import type Stripe from "stripe";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { stripe } from "./client";

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
  return { subscription: fresh, revision, observedAt };
}
