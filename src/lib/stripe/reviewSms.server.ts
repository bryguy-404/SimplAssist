import "server-only";
import { createHash } from "node:crypto";
import type Stripe from "stripe";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  ReviewSmsError,
  type ReviewSmsAccount,
  type ReviewSmsOverview,
  type ReviewSmsQuote,
} from "@/lib/billing/reviewSms";
import { isReviewSmsEnabled } from "@/lib/billing/reviewSmsRollout.server";
import { resolveBusinessEntitlements } from "@/lib/billing/entitlements";
import { stripe } from "./client";
import {
  REVIEW_SMS_ACTIVATION_CENTS,
  REVIEW_SMS_ADDON_CENTS,
  REVIEW_SMS_INCLUDED_PARTS,
  SUBSCRIPTION_PLANS,
} from "./config";
import { classifySubscriptionItems } from "./subscriptionItems";
import { assertApprovedChatOnlyStripePrice } from "./chatOnlyPrice";
import {
  smsSubscriptionFingerprint,
  preserveSmsSchedulePhase,
  verifiedPaidInvoice,
} from "./smsBilling.server";

const id = (v: string | { id: string } | null | undefined) =>
  typeof v === "string" ? v : (v?.id ?? null);
const iso = (s: number) => new Date(s * 1000).toISOString();
const seconds = (s: string) => Math.floor(Date.parse(s) / 1000);
const fingerprint = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const opSchema = z.object({
  id: z.string().uuid(),
  account_id: z.string().uuid(),
  business_id: z.string().uuid(),
  owner_id: z.string().uuid(),
  kind: z.enum(["activation", "recurring", "cancel", "refund"]),
  state: z.enum(["prepared", "confirmed", "completed", "expired", "unknown"]),
  fingerprint: z.string(),
  payload: z.record(z.string(), z.unknown()),
  checkout_session_id: z.string().nullable(),
  invoice_id: z.string().nullable(),
  schedule_id: z.string().nullable(),
  created_at: z.string(),
  expires_at: z.string(),
});
type Operation = z.infer<typeof opSchema>;
async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabaseAdmin.rpc(name, args);
  if (error)
    throw new ReviewSmsError(
      /review_sms_[a-z_]+/.exec(error.message)?.[0] ??
        "review_sms_state_unavailable",
      503,
    );
  return data as T;
}
export async function readReviewSmsAccount(
  businessId: string,
): Promise<ReviewSmsAccount | null> {
  const { data, error } = await supabaseAdmin
    .from("review_sms_accounts")
    .select("*")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new ReviewSmsError("review_sms_state_unavailable", 503);
  return data as ReviewSmsAccount | null;
}
async function ownerAccount(businessId: string, ownerId: string) {
  const { data, error } = await supabaseAdmin
    .from("businesses")
    .select(
      "id,owner_id,deleted_at,operations_suspended_at,billing_mode,partner_id",
    )
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new ReviewSmsError("review_sms_state_unavailable", 503);
  if (
    !data ||
    data.owner_id !== ownerId ||
    data.deleted_at ||
    data.operations_suspended_at
  )
    throw new ReviewSmsError("review_sms_forbidden", 403);
  const account = await readReviewSmsAccount(businessId);
  if (!account || account.owner_id !== ownerId)
    throw new ReviewSmsError("review_sms_setup_required");
  return { business: data, account };
}
function requireRollout(businessId: string) {
  if (!isReviewSmsEnabled(businessId))
    throw new ReviewSmsError("review_sms_disabled", 404);
}
function assertMode(mode: boolean) {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  const expected = key.startsWith("sk_live_")
    ? true
    : key.startsWith("sk_test_")
      ? false
      : null;
  if (expected === null || mode !== expected)
    throw new ReviewSmsError("review_sms_mode_mismatch", 503);
}
function assertBound(sub: Stripe.Subscription, a: ReviewSmsAccount) {
  assertMode(sub.livemode);
  if (
    sub.id !== a.source_subscription_id ||
    id(sub.customer) !== a.source_customer_id ||
    sub.metadata.business_id !== a.business_id
  )
    throw new ReviewSmsError("review_sms_billing_source_changed");
  const items = classifySubscriptionItems(sub);
  assertApprovedChatOnlyStripePrice(items.base.price, {
    requireActive: false,
    quantity: items.base.quantity ?? null,
    subscriptionItemCount: 1,
  });
  return items;
}
function assertChangeable(sub: Stripe.Subscription) {
  if (
    sub.status !== "active" ||
    sub.cancel_at_period_end ||
    sub.pending_update ||
    sub.schedule ||
    sub.collection_method !== "charge_automatically" ||
    sub.discounts.length
  )
    throw new ReviewSmsError("review_sms_subscription_not_changeable");
}
function assertReplay(op: Operation) {
  if (Date.now() - Date.parse(op.created_at) >= 23 * 3600_000)
    throw new ReviewSmsError("review_sms_recovery_required");
}
async function readOperation(
  operationId: string,
  businessId: string,
  ownerId: string,
) {
  if (!z.string().uuid().safeParse(operationId).success)
    throw new ReviewSmsError("review_sms_operation_not_found", 404);
  const { data, error } = await supabaseAdmin
    .from("review_sms_billing_operations")
    .select("*")
    .eq("id", operationId)
    .eq("business_id", businessId)
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (error || !data)
    throw new ReviewSmsError("review_sms_operation_not_found", 404);
  return opSchema.parse(data);
}
async function saveOperation(op: Operation, patch: Record<string, unknown>) {
  const { error } = await supabaseAdmin
    .from("review_sms_billing_operations")
    .update(patch)
    .eq("id", op.id);
  if (error) throw new ReviewSmsError("review_sms_state_unavailable", 503);
}
async function pendingOperation(a: ReviewSmsAccount, kind: Operation["kind"]) {
  const { data, error } = await supabaseAdmin
    .from("review_sms_billing_operations")
    .select("*")
    .eq("account_id", a.id)
    .eq("kind", kind)
    .in("state", ["prepared", "confirmed", "unknown"])
    .maybeSingle();
  if (error) throw new ReviewSmsError("review_sms_state_unavailable", 503);
  if (!data) return null;
  const op = opSchema.parse(data);
  if (op.state === "prepared" && Date.parse(op.expires_at) <= Date.now()) {
    // A confirmation may have won after the read. Never turn that durable
    // provider operation into a fresh quote with a different idempotency key.
    const expired = await supabaseAdmin
      .from("review_sms_billing_operations")
      .update({ state: "expired" })
      .eq("id", op.id)
      .eq("state", "prepared")
      .select("id")
      .maybeSingle();
    if (expired.error)
      throw new ReviewSmsError("review_sms_state_unavailable", 503);
    return expired.data
      ? null
      : readOperation(op.id, op.business_id, op.owner_id);
  }
  return op;
}
async function acquire(
  a: ReviewSmsAccount,
  kind: Operation["kind"],
  payload: Record<string, unknown>,
) {
  return opSchema.parse(
    await rpc("review_sms_acquire_operation", {
      p_business: a.business_id,
      p_owner: a.owner_id,
      p_kind: kind,
      p_fingerprint: fingerprint(payload),
      p_payload: payload,
    }),
  );
}
async function confirm(op: Operation) {
  return opSchema.parse(
    await rpc("review_sms_confirm_operation", {
      p_operation: op.id,
      p_owner: op.owner_id,
      p_fingerprint: op.fingerprint,
    }),
  );
}
async function addonPrice() {
  const priceId = process.env.STRIPE_PRICE_REVIEW_SMS;
  if (!priceId?.startsWith("price_"))
    throw new ReviewSmsError("review_sms_price_unavailable", 503);
  const p = await stripe.prices.retrieve(priceId);
  if (
    !p.active ||
    p.currency !== "usd" ||
    p.unit_amount !== REVIEW_SMS_ADDON_CENTS ||
    p.type !== "recurring" ||
    p.recurring?.interval !== "month" ||
    p.recurring.interval_count !== 1 ||
    p.recurring.usage_type !== "licensed"
  )
    throw new ReviewSmsError("review_sms_price_unavailable", 503);
  return p;
}

export async function reviewSmsOverview(
  businessId: string,
  ownerId: string,
): Promise<ReviewSmsOverview> {
  const a = await readReviewSmsAccount(businessId);
  if (a && a.owner_id !== ownerId)
    throw new ReviewSmsError("review_sms_forbidden", 403);
  const canSend = await rpc<boolean>("has_review_sms_access", {
    p_business_id: businessId,
  });
  const entitlements = await resolveBusinessEntitlements(businessId);
  const eligibleSource =
    a?.billing_source ??
    (entitlements.plan !== "chat_only"
      ? "included"
      : entitlements.source === "subscription"
        ? "direct"
        : "grant");
  return {
    enabled: isReviewSmsEnabled(businessId),
    account: a,
    canSend,
    eligibleSource,
    price: {
      monthlyCents: eligibleSource === "direct" ? REVIEW_SMS_ADDON_CENTS : 0,
      activationCents:
        eligibleSource === "direct" ? REVIEW_SMS_ACTIVATION_CENTS : 0,
      includedParts:
        entitlements.plan === "chat_only"
          ? REVIEW_SMS_INCLUDED_PARTS
          : SUBSCRIPTION_PLANS[entitlements.plan].includedSmsParts,
    },
  };
}
export async function saveReviewSmsDraft(
  businessId: string,
  ownerId: string,
  draft: Record<string, unknown>,
) {
  requireRollout(businessId);
  return rpc<ReviewSmsAccount>("review_sms_acquire_account", {
    p_business: businessId,
    p_owner: ownerId,
    p_draft: draft,
  });
}

export async function createReviewSmsActivationCheckout(
  businessId: string,
  ownerId: string,
  origin: string,
) {
  requireRollout(businessId);
  const { business, account: a } = await ownerAccount(businessId, ownerId);
  if (
    a.billing_source !== "direct" ||
    business.billing_mode !== "stripe" ||
    business.partner_id
  )
    throw new ReviewSmsError("review_sms_partner_grant_required");
  const { validateReviewSmsSetup } =
    await import("@/lib/reviews/smsProvisioning.server");
  await validateReviewSmsSetup(businessId);
  if (a.activation_paid_at) return { paid: true };
  const feeId = process.env.STRIPE_PRICE_REVIEW_SMS_ACTIVATION;
  if (!feeId?.startsWith("price_"))
    throw new ReviewSmsError("review_sms_activation_price_unavailable", 503);
  const fee = await stripe.prices.retrieve(feeId);
  if (
    !fee.active ||
    fee.currency !== "usd" ||
    fee.unit_amount !== REVIEW_SMS_ACTIVATION_CENTS ||
    fee.type !== "one_time"
  )
    throw new ReviewSmsError("review_sms_activation_price_unavailable", 503);
  const sub = await stripe.subscriptions.retrieve(a.source_subscription_id!);
  const { reviewSms } = assertBound(sub, a);
  assertChangeable(sub);
  if (reviewSms) throw new ReviewSmsError("review_sms_already_active");
  await pendingOperation(a, "activation"); // Expire a prepared quote that never reached Checkout.
  let op = await acquire(a, "activation", {
    feeId,
    amountCents: REVIEW_SMS_ACTIVATION_CENTS,
    customerId: a.source_customer_id,
    subscriptionId: a.source_subscription_id,
    origin,
    draftFingerprint: fingerprint(a.draft),
  });
  if (op.checkout_session_id) {
    const session = await stripe.checkout.sessions.retrieve(
      op.checkout_session_id,
    );
    if (session.status === "complete") {
      await synchronizeReviewSmsCheckout(session);
      return { paid: session.payment_status === "paid" };
    }
    if (session.status === "expired") {
      await saveOperation(op, { state: "expired" });
      throw new ReviewSmsError("review_sms_checkout_expired");
    }
    return { url: checkedCheckoutUrl(session, op) };
  }
  assertReplay(op);
  op = await confirm(op);
  const metadata = {
    business_id: businessId,
    review_sms_account_id: a.id,
    review_sms_operation_id: op.id,
  };
  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      customer: a.source_customer_id!,
      client_reference_id: businessId,
      line_items: [{ price: feeId, quantity: 1 }],
      payment_method_types: ["card"],
      metadata,
      payment_intent_data: { metadata },
      expires_at: seconds(op.created_at) + 24 * 3600,
      success_url: `${origin}/reviews?sms=activation-paid`,
      cancel_url: `${origin}/reviews?sms=activation-cancelled`,
    },
    { idempotencyKey: `review-sms-activation:${op.id}` },
  );
  await saveOperation(op, { checkout_session_id: session.id });
  return { url: checkedCheckoutUrl(session, op) };
}
function checkedCheckoutUrl(session: Stripe.Checkout.Session, op: Operation) {
  assertMode(session.livemode);
  if (
    session.mode !== "payment" ||
    id(session.customer) !== op.payload.customerId ||
    session.client_reference_id !== op.business_id ||
    session.metadata?.review_sms_operation_id !== op.id ||
    session.status !== "open" ||
    !session.url?.startsWith("https://checkout.stripe.com/")
  )
    throw new ReviewSmsError("review_sms_checkout_invalid", 503);
  return session.url;
}

/** Signed webhook routing calls this before the ordinary base-plan Checkout path. */
export async function synchronizeReviewSmsCheckout(
  session: Stripe.Checkout.Session,
): Promise<boolean> {
  const operationId = session.metadata?.review_sms_operation_id;
  if (!operationId) return false;
  assertMode(session.livemode);
  const { data, error } = await supabaseAdmin
    .from("review_sms_billing_operations")
    .select("*")
    .eq("id", operationId)
    .maybeSingle();
  if (error || !data)
    throw new ReviewSmsError("review_sms_checkout_unbound", 503);
  const op = opSchema.parse(data);
  const a = await readReviewSmsAccount(op.business_id);
  if (
    !a ||
    op.kind !== "activation" ||
    !["confirmed", "completed"].includes(op.state) ||
    op.account_id !== a.id ||
    session.metadata?.review_sms_account_id !== a.id ||
    session.client_reference_id !== a.business_id ||
    id(session.customer) !== a.source_customer_id ||
    session.mode !== "payment" ||
    session.currency !== "usd" ||
    session.amount_total !== REVIEW_SMS_ACTIVATION_CENTS ||
    (op.checkout_session_id && op.checkout_session_id !== session.id)
  )
    throw new ReviewSmsError("review_sms_checkout_unbound", 503);
  if (session.status === "expired") {
    await saveOperation(op, {
      state: "expired",
      checkout_session_id: session.id,
    });
    return true;
  }
  if (session.status !== "complete" || session.payment_status !== "paid")
    return true;
  if (!id(session.payment_intent))
    throw new ReviewSmsError("review_sms_payment_unverified", 503);
  const payment = await stripe.paymentIntents.retrieve(
    id(session.payment_intent)!,
  );
  assertMode(payment.livemode);
  if (
    payment.id !== id(session.payment_intent) ||
    payment.status !== "succeeded" ||
    payment.amount_received !== REVIEW_SMS_ACTIVATION_CENTS ||
    payment.currency !== "usd" ||
    id(payment.customer) !== a.source_customer_id ||
    payment.metadata.review_sms_operation_id !== op.id ||
    payment.metadata.review_sms_account_id !== a.id ||
    payment.metadata.business_id !== a.business_id
  )
    throw new ReviewSmsError("review_sms_payment_unverified", 503);
  const { error: saveError } = await supabaseAdmin
    .from("review_sms_accounts")
    .update({
      activation_paid_at: new Date().toISOString(),
      activation_payment_intent_id: payment.id,
      state: "carrier_pending",
      updated_at: new Date().toISOString(),
    })
    .eq("id", a.id)
    .is("activation_paid_at", null)
    .in("state", ["draft", "activation_pending"]);
  if (saveError)
    throw new ReviewSmsError("review_sms_payment_save_failed", 503);
  await saveOperation(op, {
    state: "completed",
    checkout_session_id: session.id,
    completed_at: new Date().toISOString(),
  });
  return true;
}

function quoteFromOperation(op: Operation): ReviewSmsQuote {
  return {
    operationId: op.id,
    fingerprint: op.fingerprint,
    amountDueCents: Number(op.payload.amountDueCents),
    monthlyPriceCents: REVIEW_SMS_ADDON_CENTS,
    includedParts: Number(op.payload.includedParts),
    periodEnd: String(op.payload.periodEnd),
    expiresAt: op.expires_at,
  };
}
export async function quoteReviewSmsRecurring(
  businessId: string,
  ownerId: string,
): Promise<ReviewSmsQuote> {
  requireRollout(businessId);
  const { account: a } = await ownerAccount(businessId, ownerId);
  const pending = await pendingOperation(a, "recurring");
  if (pending) {
    if (pending.state !== "prepared")
      throw new ReviewSmsError("review_sms_payment_in_progress");
    return quoteFromOperation(pending);
  }
  if (
    a.billing_source !== "direct" ||
    a.state !== "ready_unpaid" ||
    !a.review_usecase_approved_at ||
    !a.ready_expires_at ||
    Date.parse(a.ready_expires_at) <= Date.now()
  )
    throw new ReviewSmsError("review_sms_not_ready");
  const sub = await stripe.subscriptions.retrieve(a.source_subscription_id!);
  const { base, reviewSms } = assertBound(sub, a);
  assertChangeable(sub);
  if (reviewSms) throw new ReviewSmsError("review_sms_already_active");
  const price = await addonPrice(),
    now = Math.floor(Date.now() / 1000);
  const preview = await stripe.invoices.createPreview({
    customer: a.source_customer_id!,
    subscription: sub.id,
    subscription_details: {
      items: [{ price: price.id, quantity: 1 }],
      proration_date: now,
      proration_behavior: "always_invoice",
      billing_cycle_anchor: "unchanged",
    },
  });
  if (
    preview.currency !== "usd" ||
    !Number.isSafeInteger(preview.amount_due) ||
    preview.amount_due < 0
  )
    throw new ReviewSmsError("review_sms_quote_unavailable", 503);
  const includedParts = Math.max(
    0,
    Math.min(
      250,
      Math.floor(
        (250 * (base.current_period_end - now)) /
          (base.current_period_end - base.current_period_start),
      ),
    ),
  );
  const op = await acquire(a, "recurring", {
    priceId: price.id,
    subscriptionId: sub.id,
    customerId: a.source_customer_id,
    sourceFingerprint: smsSubscriptionFingerprint(sub),
    prorationAt: now,
    amountDueCents: preview.amount_due,
    includedParts,
    periodStart: iso(now),
    periodEnd: iso(base.current_period_end),
  });
  return quoteFromOperation(op);
}
export async function confirmReviewSmsRecurring(
  businessId: string,
  ownerId: string,
  operationId: string,
  quoteFingerprint: string,
) {
  requireRollout(businessId);
  const { account: a } = await ownerAccount(businessId, ownerId);
  let op = await readOperation(operationId, businessId, ownerId);
  if (op.kind !== "recurring" || op.fingerprint !== quoteFingerprint)
    throw new ReviewSmsError("review_sms_quote_changed");
  if (op.state === "completed") return { active: true };
  assertReplay(op);
  if (op.state === "prepared") {
    if (
      a.state !== "ready_unpaid" ||
      !a.ready_expires_at ||
      Date.parse(a.ready_expires_at) <= Date.now()
    )
      throw new ReviewSmsError("review_sms_not_ready");
    const sub = await stripe.subscriptions.retrieve(a.source_subscription_id!);
    assertBound(sub, a);
    assertChangeable(sub);
    if (
      smsSubscriptionFingerprint(sub) !== op.payload.sourceFingerprint ||
      (await addonPrice()).id !== op.payload.priceId
    )
      throw new ReviewSmsError("review_sms_quote_changed");
    const quote = await stripe.invoices.createPreview({
      customer: a.source_customer_id!,
      subscription: sub.id,
      subscription_details: {
        items: [{ price: String(op.payload.priceId), quantity: 1 }],
        proration_date: Number(op.payload.prorationAt),
        proration_behavior: "always_invoice",
        billing_cycle_anchor: "unchanged",
      },
    });
    if (
      quote.amount_due !== op.payload.amountDueCents ||
      quote.currency !== "usd"
    )
      throw new ReviewSmsError("review_sms_quote_changed");
  }
  op = await confirm(op);
  const updated = await stripe.subscriptions.update(
    a.source_subscription_id!,
    {
      items: [{ price: String(op.payload.priceId), quantity: 1 }],
      payment_behavior: "pending_if_incomplete",
      proration_behavior: "always_invoice",
      proration_date: Number(op.payload.prorationAt),
      billing_cycle_anchor: "unchanged",
      metadata: { review_sms_operation_id: op.id },
    },
    { idempotencyKey: `review-sms-recurring:${op.id}` },
  );
  await saveOperation(op, { invoice_id: id(updated.latest_invoice) });
  await reconcileReviewSmsSubscription(updated);
  let paymentUrl: string | null = null;
  if (updated.pending_update && id(updated.latest_invoice)) {
    const invoice = await stripe.invoices.retrieve(id(updated.latest_invoice)!);
    if (invoice.hosted_invoice_url?.startsWith("https://invoice.stripe.com/"))
      paymentUrl = invoice.hosted_invoice_url;
  }
  return {
    active: (await readReviewSmsAccount(businessId))?.state === "active",
    paymentUrl,
  };
}

/** Version before the fresh provider read; event arrival order cannot grant access. */
export async function reconcileReviewSmsSubscription(
  incoming: Stripe.Subscription,
) {
  const businessId = incoming.metadata?.business_id;
  if (!businessId || !id(incoming.customer)) return;
  const a = await readReviewSmsAccount(businessId);
  if (
    !a ||
    a.billing_source !== "direct" ||
    a.source_subscription_id !== incoming.id ||
    a.source_customer_id !== id(incoming.customer)
  )
    return;
  const revision = await rpc<number | null>("review_sms_begin_reconcile", {
    p_business: businessId,
    p_subscription: incoming.id,
    p_customer: id(incoming.customer),
  });
  if (revision === null) return;
  const sub = await stripe.subscriptions.retrieve(incoming.id);
  const { base, reviewSms } = assertBound(sub, a);
  if (!reviewSms || sub.status !== "active" || sub.pending_update) {
    const termExpired = Boolean(
      a.paid_period_end && Date.parse(a.paid_period_end) <= Date.now(),
    );
    if (
      a.stripe_item_id &&
      (!reviewSms ||
        ["canceled", "unpaid", "incomplete_expired"].includes(sub.status) ||
        (sub.status === "past_due" && termExpired))
    ) {
      const { error } = await supabaseAdmin
        .from("review_sms_accounts")
        .update({
          state: "release_pending",
          cancel_at: new Date().toISOString(),
          release_at: new Date().toISOString(),
          applied_revision: revision,
        })
        .eq("id", a.id)
        .eq("billing_revision", revision);
      if (error) throw new ReviewSmsError("review_sms_state_unavailable", 503);
    }
    return;
  }
  const invoice = await verifiedPaidInvoice(sub);
  if (!invoice) return;
  const line = invoice.lines.data.find(
    (l) =>
      l.parent?.subscription_item_details?.subscription_item === reviewSms.id &&
      l.pricing?.price_details?.price === reviewSms.price.id &&
      l.period.end === reviewSms.current_period_end,
  );
  if (
    !line ||
    invoice.lines.has_more ||
    line.quantity !== 1 ||
    invoice.currency !== "usd" ||
    line.amount < 0
  )
    return;
  let allowance = 250,
    start = base.current_period_start;
  if (
    !line.parent?.subscription_item_details?.proration &&
    (line.period.start !== reviewSms.current_period_start ||
      line.period.start !== base.current_period_start ||
      line.amount < REVIEW_SMS_ADDON_CENTS)
  )
    return;
  if (line.parent?.subscription_item_details?.proration) {
    const opId = sub.metadata.review_sms_operation_id;
    if (!opId) return;
    const op = await readOperation(opId, businessId, a.owner_id);
    if (
      op.kind !== "recurring" ||
      op.account_id !== a.id ||
      op.state !== "confirmed" ||
      op.payload.priceId !== reviewSms.price.id ||
      Number(op.payload.prorationAt) !== line.period.start ||
      String(op.payload.periodEnd) !== iso(line.period.end) ||
      invoice.amount_paid < Number(op.payload.amountDueCents)
    )
      return;
    allowance = Number(op.payload.includedParts);
    start = Number(op.payload.prorationAt);
  }
  await rpc("review_sms_record_paid_period", {
    p_business: businessId,
    p_revision: revision,
    p_item: reviewSms.id,
    p_price: reviewSms.price.id,
    p_invoice: invoice.id,
    p_start: iso(start),
    p_end: iso(reviewSms.current_period_end),
    p_allowance: allowance,
  });
}

export async function cancelReviewSmsAtPeriodEnd(
  businessId: string,
  ownerId: string,
) {
  const { account: a } = await ownerAccount(businessId, ownerId);
  if (a.billing_source !== "direct")
    throw new ReviewSmsError("review_sms_managed_billing");
  if (a.state === "cancel_pending") return { cancelAt: a.cancel_at };
  const pending = await pendingOperation(a, "cancel");
  const sub = await stripe.subscriptions.retrieve(a.source_subscription_id!);
  const { base, reviewSms } = assertBound(sub, a);
  if (!reviewSms) throw new ReviewSmsError("review_sms_not_active");
  if (!pending) assertChangeable(sub);
  else if (
    pending.schedule_id &&
    sub.schedule &&
    id(sub.schedule) !== pending.schedule_id
  )
    throw new ReviewSmsError("review_sms_cancel_recovery_required");
  let op =
    pending ??
    (await acquire(a, "cancel", {
      subscriptionId: sub.id,
      customerId: a.source_customer_id,
      basePrice: base.price.id,
      addonPrice: reviewSms.price.id,
      periodEnd: iso(base.current_period_end),
    }));
  assertReplay(op);
  if (
    op.payload.subscriptionId !== sub.id ||
    op.payload.customerId !== id(sub.customer) ||
    op.payload.basePrice !== base.price.id ||
    op.payload.addonPrice !== reviewSms.price.id ||
    op.payload.periodEnd !== iso(base.current_period_end)
  )
    throw new ReviewSmsError("review_sms_cancel_recovery_required");
  op = await confirm(op);
  if (!op.payload.scheduleUpdate) {
    // If creation succeeded but its response/local save was lost, repeat the
    // original create key even though the fresh subscription now has a schedule.
    const schedule = op.schedule_id
      ? await stripe.subscriptionSchedules.retrieve(op.schedule_id)
      : await stripe.subscriptionSchedules.create(
          { from_subscription: String(op.payload.subscriptionId) },
          { idempotencyKey: `review-sms-cancel:${op.id}` },
        );
    assertMode(schedule.livemode);
    if (
      id(schedule.subscription) !== sub.id ||
      id(schedule.customer) !== a.source_customer_id ||
      (sub.schedule && id(sub.schedule) !== schedule.id)
    )
      throw new ReviewSmsError("review_sms_cancel_recovery_required");
    const phase = schedule.phases[0];
    if (
      !phase ||
      phase.end_date !== seconds(String(op.payload.periodEnd)) ||
      phase.items.length !== 2 ||
      !phase.items.some((item) => id(item.price) === base.price.id) ||
      !phase.items.some((item) => id(item.price) === reviewSms.price.id) ||
      phase.items.some((item) => item.quantity !== 1)
    )
      throw new ReviewSmsError("review_sms_cancel_recovery_required");
    const basePhase = {
      ...phase,
      items: phase.items.filter((item) => id(item.price) === base.price.id),
    };
    const preserved = preserveSmsSchedulePhase(basePhase, sub);
    const currentItems = phase.items.map(
      (item) =>
        preserveSmsSchedulePhase({ ...phase, items: [item] }, sub).items[0],
    );
    const metadata = { ...sub.metadata, ...phase.metadata };
    const parameters: Stripe.SubscriptionScheduleUpdateParams = {
      end_behavior: "release",
      proration_behavior: "none",
      metadata: { business_id: businessId, review_sms_operation_id: op.id },
      phases: [
        {
          ...preserved,
          items: currentItems,
          start_date: phase.start_date,
          end_date: phase.end_date,
          proration_behavior: "none",
          metadata,
        },
        {
          ...preserved,
          start_date: phase.end_date,
          duration: { interval: "month", interval_count: 1 },
          proration_behavior: "none",
          metadata,
        },
      ],
    };
    op = opSchema.parse(
      await rpc("review_sms_freeze_cancel", {
        p_operation: op.id,
        p_owner: ownerId,
        p_schedule: schedule.id,
        p_parameters: parameters,
      }),
    );
  }
  if (!op.schedule_id)
    throw new ReviewSmsError("review_sms_cancel_recovery_required");
  await stripe.subscriptionSchedules.update(
    op.schedule_id,
    op.payload.scheduleUpdate as Stripe.SubscriptionScheduleUpdateParams,
    { idempotencyKey: `review-sms-cancel-phases:${op.id}` },
  );
  const { error } = await supabaseAdmin
    .from("review_sms_accounts")
    .update({
      state: "cancel_pending",
      cancel_at: String(op.payload.periodEnd),
      release_at: String(op.payload.periodEnd),
      stripe_schedule_id: op.schedule_id,
    })
    .eq("id", a.id);
  if (error) throw new ReviewSmsError("review_sms_state_unavailable", 503);
  await saveOperation(op, {
    state: "completed",
    completed_at: new Date().toISOString(),
  });
  return { cancelAt: String(op.payload.periodEnd) };
}

export async function refundUnsubmittedReviewSmsActivation(
  businessId: string,
  ownerId: string,
) {
  const { account: a } = await ownerAccount(businessId, ownerId);
  if (a.activation_refunded_at) return { refunded: true };
  if (!a.activation_payment_intent_id || a.provider_started_at)
    throw new ReviewSmsError("review_sms_refund_unavailable");
  let op = await acquire(a, "refund", {
    paymentIntent: a.activation_payment_intent_id,
    amount: REVIEW_SMS_ACTIVATION_CENTS,
  });
  assertReplay(op);
  op = await confirm(op);
  // Lock out provisioning before refunding; retry keeps the same refund key.
  const { data, error } = await supabaseAdmin
    .from("review_sms_accounts")
    .update({ state: "release_pending" })
    .eq("id", a.id)
    .is("provider_started_at", null)
    .select("id")
    .maybeSingle();
  if (error || !data) throw new ReviewSmsError("review_sms_refund_unavailable");
  await stripe.refunds.create(
    {
      payment_intent: a.activation_payment_intent_id,
      amount: REVIEW_SMS_ACTIVATION_CENTS,
      metadata: { review_sms_operation_id: op.id },
    },
    { idempotencyKey: `review-sms-refund:${op.id}` },
  );
  const { error: saveError } = await supabaseAdmin
    .from("review_sms_accounts")
    .update({
      state: "released",
      activation_refunded_at: new Date().toISOString(),
      released_at: new Date().toISOString(),
    })
    .eq("id", a.id);
  if (saveError) throw new ReviewSmsError("review_sms_state_unavailable", 503);
  await saveOperation(op, {
    state: "completed",
    completed_at: new Date().toISOString(),
  });
  return { refunded: true };
}
