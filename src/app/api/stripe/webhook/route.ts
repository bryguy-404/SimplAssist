import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe/client";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  syncCheckoutSession,
  syncExpiredCheckoutSession,
  syncStripeSubscription,
} from "@/lib/stripe/subscriptionSync";
import {
  finalizePaidCheckout,
  type PaidCheckoutFinalizeResult,
} from "@/lib/billing/finalizePaidCheckout.server";

export async function POST(request: NextRequest) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json(
      { error: "Missing stripe-signature header" },
      { status: 400 },
    );
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const provenanceFailure = stripeEventProvenanceFailure(event);
  if (provenanceFailure) {
    // This endpoint owns one direct Stripe account in one fixed mode. A
    // correctly signed event from a connected account, organization context,
    // or the opposite Stripe mode still has no authority here. Reject it
    // before writing an event claim or touching subscription state.
    console.error(
      `[stripe:webhook] Rejected event provenance (${provenanceFailure})`,
    );
    return NextResponse.json(
      { error: "Invalid event provenance" },
      { status: 400 },
    );
  }

  const claimed = await claimStripeEvent(event);
  if (!claimed) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  try {
    const launch = await processStripeEvent(event);
    await markStripeEventProcessed(event.id);
    return NextResponse.json({
      received: true,
      ...(launch?.status === "services_faqs_required" ||
      launch?.status === "rejection_support_required"
        ? { code: launch.status }
        : {}),
    });
  } catch (error) {
    console.error("Webhook handler error:", error);
    await markStripeEventFailed(event.id, errorMessage(error));
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 },
    );
  }
}

function stripeEventProvenanceFailure(event: Stripe.Event): string | null {
  if (event.account !== undefined || event.context !== undefined) {
    return "non-direct account context";
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const expectedLivemode = secretKey?.startsWith("sk_live_")
    ? true
    : secretKey?.startsWith("sk_test_")
      ? false
      : null;

  if (expectedLivemode === null) {
    return "unrecognized key mode";
  }
  if (event.livemode !== expectedLivemode) {
    return "livemode mismatch";
  }
  return null;
}

async function processStripeEvent(
  event: Stripe.Event,
): Promise<PaidCheckoutFinalizeResult | null> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const synced = await syncCheckoutSession(session);
      if (synced) {
        return finalizePaidCheckout(synced, "stripe_webhook");
      }
      return null;
    }

    case "checkout.session.expired": {
      await syncExpiredCheckoutSession(
        event.data.object as Stripe.Checkout.Session,
      );
      return null;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated": {
      await syncStripeSubscription(event.data.object as Stripe.Subscription);
      return null;
    }

    case "customer.subscription.deleted": {
      await syncStripeSubscription(event.data.object as Stripe.Subscription);
      return null;
    }

    case "invoice.payment_succeeded": {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId = resolveInvoiceSubscriptionId(invoice);
      if (!subscriptionId) return null;
      // The invoice payload carries no subscription status, so recovery reads
      // the real status from Stripe and passes it through unchanged. The
      // fail-closed normalizer inside the sync throws on an absent or
      // unrecognized status — never a guessed write — and a failed event
      // stays retryable via the claimStripeEvent re-claim.
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      await syncStripeSubscription(subscription);
      return null;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId =
        typeof invoice.customer === "string" ? invoice.customer : null;
      if (!customerId) return null;

      // Freshness check: a redelivered (possibly re-claimed) failure event
      // can be days stale, and the past_due RPC has no status guard — a
      // blind mark would re-gate a payer who has since recovered. When the
      // invoice resolves to a subscription, read the live status and only
      // mark past_due while Stripe still reports exactly past_due; every
      // other live state (including unpaid) syncs through the normalizer so
      // status classification has a single source. A failed retrieve throws
      // (500 → recorded → retryable) — never guess either way.
      const failedSubscriptionId = resolveInvoiceSubscriptionId(invoice);
      if (failedSubscriptionId) {
        const liveSubscription =
          await stripe.subscriptions.retrieve(failedSubscriptionId);
        // The synchronizer also versions commercial voice billing. Always use
        // it for a linked subscription, including past_due, rather than an
        // unversioned status write racing a successful payment webhook.
        await syncStripeSubscription(liveSubscription);
        return null;
      }

      const { data: updated, error } = await supabaseAdmin.rpc(
        "mark_stripe_subscription_past_due_if_business_active",
        {
          p_stripe_customer_id: customerId,
          p_updated_at: new Date().toISOString(),
        },
      );

      if (error) {
        throw new Error(
          `[stripe:webhook] Failed to mark customer ${customerId} past_due: ${error.message}`,
        );
      }

      if (updated === false) {
        return null;
      }
      if (updated !== true) {
        throw new Error(
          `[stripe:webhook] Guarded past-due update returned an invalid response for customer ${customerId}`,
        );
      }

      return null;
    }

    default:
      return null;
  }
}

async function claimStripeEvent(event: Stripe.Event): Promise<boolean> {
  const { error } = await supabaseAdmin.from("stripe_webhook_events").insert({
    id: event.id,
    event_type: event.type,
  });

  if (!error) return true;
  if (error.code === "23505") {
    return reclaimFailedStripeEvent(event.id);
  }
  throw new Error(
    `[stripe:webhook] Failed to claim event ${event.id}: ${error.message}`,
  );
}

/**
 * A duplicate delivery is claimable only when the prior attempt FINISHED and
 * FAILED (processed_at NULL + processing_error set). Clearing the error IS
 * taking the claim: the single-statement UPDATE serializes concurrent
 * retries on the row lock, so exactly one wins. In-flight rows
 * (processing_error NULL) and processed rows are never re-claimed, which
 * preserves the duplicate suppression this table exists for.
 */
async function reclaimFailedStripeEvent(eventId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("stripe_webhook_events")
    .update({ processing_error: null })
    .eq("id", eventId)
    .is("processed_at", null)
    .not("processing_error", "is", null)
    .select("id");

  if (error) {
    // Unknown claim state fails closed: a 500 here means Stripe retries
    // later, rather than us processing without holding the claim.
    throw new Error(
      `[stripe:webhook] Failed to evaluate re-claim for event ${eventId}: ${error.message}`,
    );
  }
  return (data?.length ?? 0) > 0;
}

async function markStripeEventProcessed(eventId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("stripe_webhook_events")
    .update({ processed_at: new Date().toISOString(), processing_error: null })
    .eq("id", eventId);

  if (error) {
    // Throw so the catch records the failure and returns 500: a swallowed
    // marker failure would ack 200 with the row still in-flight-shaped —
    // Stripe stops retrying and the event becomes a phantom. Reprocessing
    // after an already-successful run is safe: every handler is idempotent
    // (guarded upsert RPCs; claimRegistrationAttempt short-circuits a
    // completed launch before any Telnyx side effect).
    throw new Error(
      `[stripe:webhook] Failed to mark event ${eventId} processed: ${error.message}`,
    );
  }
}

async function markStripeEventFailed(
  eventId: string,
  message: string,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("stripe_webhook_events")
    .update({ processing_error: message })
    .eq("id", eventId)
    // Never stamp a failure onto a row a re-claimed retry has already
    // completed — that would read as processed-and-failed simultaneously.
    .is("processed_at", null);

  if (error) {
    // Deliberately swallowed: with no ownership token, any fallback write
    // or delete can race a concurrent re-claimer into double processing
    // (verified interleaving). Consequence: this row is stranded in-flight
    // (unclaimable) until the claimed_at staleness reaper follow-up ships.
    console.error(
      `[stripe:webhook] FAILED TO RECORD FAILURE for event ${eventId} — row stranded in-flight until the reaper follow-up:`,
      error,
    );
  }
}

function resolveInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const legacySubscription = (
    invoice as Stripe.Invoice & { subscription?: unknown }
  ).subscription;
  const id =
    typeof legacySubscription === "string"
      ? legacySubscription
      : typeof invoice.parent?.subscription_details?.subscription === "string"
        ? invoice.parent.subscription_details.subscription
        : null;
  return id;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
