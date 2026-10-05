import "server-only";
import type Stripe from "stripe";
import { stripe } from "./client";
import { classifySubscriptionItems } from "./subscriptionItems";
import { assertApprovedChatOnlyStripePrice } from "./chatOnlyPrice";
import { REVIEW_SMS_ADDON_CENTS, SUBSCRIPTION_PLANS, stripePriceIdForPlan } from "./config";
import { assertSmsPrice, invoiceSubscriptionId, operation, operationSchema, record, smsSubscriptionFingerprint, type SmsBillingOperation } from "./smsBilling.server";
import { normalizeStripeSubscriptionStatus } from "./subscriptionStatus";
import { TextingUpgradeError, type TextingUpgradeRecord } from "@/lib/billing/textingUpgrade";
import { textingUpgradeRpc } from "@/lib/billing/textingUpgradeStore.server";

const id = (value: string | { id: string } | null | undefined) => typeof value === "string" ? value : value?.id ?? null;
const iso = (value: number) => new Date(value * 1000).toISOString();
const seconds = (value: string) => Math.floor(Date.parse(value) / 1000);
function assertMode(livemode: boolean) {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  const expected = key.startsWith("sk_test_") ? false : key.startsWith("sk_live_") ? true : null;
  if (expected === null || expected !== livemode) throw new TextingUpgradeError("texting_upgrade_mode_mismatch", 503);
}
function assertBinding(sub: Stripe.Subscription, u: TextingUpgradeRecord) {
  assertMode(sub.livemode);
  if (u.source_mode !== "review_sms" || u.target_plan !== "sms_and_chat" || !u.source_review_item_id || !u.source_review_account_id || !u.original_activation_operation_id ||
    sub.id !== u.source_subscription_id || id(sub.customer) !== u.source_customer_id || sub.metadata.business_id !== u.business_id || sub.items.has_more)
    throw new TextingUpgradeError("texting_upgrade_source_changed");
}
function sourceItems(sub: Stripe.Subscription, u: TextingUpgradeRecord) {
  assertBinding(sub, u);
  const { base, reviewSms } = classifySubscriptionItems(sub);
  if (!reviewSms || reviewSms.id !== u.source_review_item_id || base.id === u.source_review_item_id || base.quantity !== 1 ||
    base.price.currency !== "usd" || base.price.unit_amount !== 1500 || base.price.recurring?.usage_type !== "licensed" || reviewSms.price.unit_amount !== REVIEW_SMS_ADDON_CENTS)
    throw new TextingUpgradeError("texting_upgrade_source_changed");
  assertApprovedChatOnlyStripePrice(base.price, { requireActive: false, quantity: 1, subscriptionItemCount: 1 });
  return { base, reviewSms };
}
function assertChangeable(sub: Stripe.Subscription, u: TextingUpgradeRecord) {
  const result = sourceItems(sub, u);
  if (sub.status !== "active" || sub.cancel_at_period_end || sub.schedule || sub.pending_update || sub.collection_method !== "charge_automatically" || sub.discounts.length ||
    result.base.discounts?.length || result.reviewSms.discounts?.length || result.base.current_period_end <= Date.now() / 1000)
    throw new TextingUpgradeError("texting_upgrade_source_changed");
  return result;
}
async function requirePaidSource(sub: Stripe.Subscription, u: TextingUpgradeRecord) {
  const { base, reviewSms } = sourceItems(sub, u);
  // A canceled upgrade leaves latest_invoice void. The two current source items
  // remain paid: verify their current-period receipts rather than that pointer.
  const [paid, open] = await Promise.all([
    stripe.invoices.list({ subscription: sub.id, customer: u.source_customer_id, status: "paid", created: { gte: base.current_period_start - 60 }, limit: 100 }),
    stripe.invoices.list({ subscription: sub.id, customer: u.source_customer_id, status: "open", limit: 1 }),
  ]);
  if (paid.has_more || open.data.length || open.has_more || reviewSms.current_period_end !== base.current_period_end)
    throw new TextingUpgradeError("texting_upgrade_source_unpaid");
  let basePaid = false, reviewsPaid = false;
  for (const invoice of paid.data) {
    assertMode(invoice.livemode);
    if (invoice.status !== "paid" || id(invoice.customer) !== u.source_customer_id || invoiceSubscriptionId(invoice) !== u.source_subscription_id)
      throw new TextingUpgradeError("texting_upgrade_source_unpaid");
    for (const line of await linesFor(invoice)) {
      const detail = line.parent?.subscription_item_details;
      if (line.quantity !== 1 || line.amount < 0 || line.period.end !== base.current_period_end) continue;
      if (detail?.subscription_item === base.id && line.pricing?.price_details?.price === base.price.id &&
        !detail.proration && line.period.start === base.current_period_start) basePaid = true;
      if (detail?.subscription_item === reviewSms.id && line.pricing?.price_details?.price === reviewSms.price.id &&
        line.period.start >= base.current_period_start && line.period.start <= Date.now() / 1000) reviewsPaid = true;
    }
  }
  if (!basePaid || !reviewsPaid) throw new TextingUpgradeError("texting_upgrade_source_unpaid");
}
async function assertTarget(priceId: string) {
  if (stripePriceIdForPlan("sms_and_chat") !== priceId) throw new TextingUpgradeError("texting_upgrade_price_changed");
  const price = await stripe.prices.retrieve(priceId);
  assertSmsPrice(price, "sms_and_chat", priceId);
  if (price.unit_amount !== 4900) throw new TextingUpgradeError("texting_upgrade_price_changed");
}
async function preview(sub: Stripe.Subscription, u: TextingUpgradeRecord, priceId: string, prorationAt: number) {
  const { base, reviewSms } = sourceItems(sub, u);
  return stripe.invoices.createPreview({ customer: u.source_customer_id, subscription: sub.id,
    subscription_details: { items: [{ id: base.id, price: priceId, quantity: 1 }, { id: reviewSms.id, deleted: true }],
      proration_date: prorationAt, proration_behavior: "always_invoice", billing_cycle_anchor: "unchanged" },
  });
}

export async function quoteReviewTextingConversion(businessId: string, ownerId: string, initial: TextingUpgradeRecord) {
  const observed = await textingUpgradeRpc("read_chat_texting_upgrade_setup", { p_upgrade_id: initial.id, p_owner_id: ownerId });
  if (!observed || typeof observed.setupFingerprint !== "string" || !/^[a-f0-9]{32}$/.test(observed.setupFingerprint))
    throw new TextingUpgradeError("texting_upgrade_provider_pending");
  const { requireTextingUpgradeReady, textingUpgradeQuote } = await import("@/lib/billing/textingUpgrade.server");
  const c = await requireTextingUpgradeReady(businessId, ownerId);
  const sub = await stripe.subscriptions.retrieve(c.upgrade.source_subscription_id);
  const { base, reviewSms } = assertChangeable(sub, c.upgrade);
  await requirePaidSource(sub, c.upgrade);
  const targetPrice = stripePriceIdForPlan("sms_and_chat");
  await assertTarget(targetPrice);
  const now = Math.floor(Date.now() / 1000);
  const quote = await preview(sub, c.upgrade, targetPrice, now);
  if (quote.currency !== "usd" || !Number.isSafeInteger(quote.amount_due) || quote.amount_due < 0) throw new TextingUpgradeError("texting_upgrade_quote_unavailable", 503);
  const op = operationSchema.parse(await textingUpgradeRpc("acquire_chat_texting_upgrade_quote", { p_upgrade_id: c.upgrade.id, p_owner_id: ownerId, p_request: {
    kind: "upgrade", target_plan: "sms_and_chat", target_price_id: targetPrice, setup_fee_price_id: null,
    expected_subscription_id: sub.id, expected_customer_id: c.upgrade.source_customer_id, stripe_item_id: base.id,
    expected_setup_fingerprint: observed.setupFingerprint, source_fingerprint: smsSubscriptionFingerprint(sub), proration_at: iso(now),
    quote: { amountDueCents: quote.amount_due, currency: "usd", monthlyPriceCents: SUBSCRIPTION_PLANS.sms_and_chat.price * 100,
      sourceMode: "review_sms", sourceBasePriceId: base.price.id, sourceReviewPriceId: reviewSms.price.id, sourceReviewItemId: reviewSms.id,
      setupFeeCents: 0, voiceSeconds: 0 },
  } }));
  return textingUpgradeQuote(op);
}
export function reviewConversionUpdateParameters(op: SmsBillingOperation, u: TextingUpgradeRecord): Stripe.SubscriptionUpdateParams {
  if (op.quote.sourceMode !== "review_sms" || op.quote.setupFeeCents !== 0 || op.setup_fee_price_id !== null ||
    op.quote.sourceReviewItemId !== u.source_review_item_id || !op.stripe_item_id || !u.source_review_item_id || op.stripe_item_id === u.source_review_item_id)
    throw new TextingUpgradeError("texting_upgrade_source_changed");
  return { items: [{ id: op.stripe_item_id, price: op.target_price_id, quantity: 1 }, { id: u.source_review_item_id, deleted: true }],
    payment_behavior: "pending_if_incomplete", proration_behavior: "always_invoice", proration_date: seconds(op.proration_at!), billing_cycle_anchor: "unchanged",
    metadata: { sms_billing_operation_id: op.id, chat_texting_upgrade_id: u.id },
  };
}

export async function confirmReviewTextingConversion(businessId: string, ownerId: string, operationId: string, quoteFingerprint: string) {
  const { loadTextingUpgradeContext, requireTextingUpgradeReady } = await import("@/lib/billing/textingUpgrade.server");
  const c = await loadTextingUpgradeContext(businessId, ownerId), u = c.upgrade;
  if (!u || u.source_mode !== "review_sms" || u.billing_operation_id !== operationId || !c.operation || c.operation.owner_id !== ownerId)
    throw new TextingUpgradeError("texting_upgrade_operation_not_found", 404);
  let op = c.operation;
  if (op.source_fingerprint !== quoteFingerprint) throw new TextingUpgradeError("texting_upgrade_quote_changed");
  if (u.paid_at) return;
  if (op.state === "expired") throw new TextingUpgradeError("texting_upgrade_quote_expired");
  if (op.state === "prepared") {
    await requireTextingUpgradeReady(businessId, ownerId);
    if (Date.parse(op.expires_at) <= Date.now()) throw new TextingUpgradeError("texting_upgrade_quote_expired");
    const sub = await stripe.subscriptions.retrieve(u.source_subscription_id);
    assertChangeable(sub, u);
    if (smsSubscriptionFingerprint(sub) !== op.source_fingerprint) throw new TextingUpgradeError("texting_upgrade_quote_changed");
    await requirePaidSource(sub, u); await assertTarget(op.target_price_id);
    const refreshed = await preview(sub, u, op.target_price_id, seconds(op.proration_at!));
    if (refreshed.amount_due !== op.quote.amountDueCents || refreshed.currency !== op.quote.currency) throw new TextingUpgradeError("texting_upgrade_quote_changed");
    op = operationSchema.parse(await textingUpgradeRpc("confirm_chat_texting_upgrade", {
      p_upgrade_id: u.id, p_owner_id: ownerId, p_operation_id: op.id, p_source_fingerprint: quoteFingerprint,
    }));
  }
  if (op.state === "confirming" && !op.invoice_id) {
    if (Date.now() - Date.parse(op.confirmed_at ?? op.created_at) >= 23 * 3600_000) {
      await reconcileReviewTextingConversion(u, op); return;
    }
    const updated = await stripe.subscriptions.update(u.source_subscription_id, reviewConversionUpdateParameters(op, u), { idempotencyKey: `chat-texting-upgrade:${op.id}` });
    assertBinding(updated, u);
    if (!id(updated.latest_invoice)) throw new TextingUpgradeError("texting_upgrade_payment_unresolved");
    // Only the original idempotent response may bind latest_invoice.
    const invoice = await stripe.invoices.retrieve(id(updated.latest_invoice)!);
    verifyReviewConversionInvoice(invoice, await linesFor(invoice), op, u);
    op = await record(op, { stripe_subscription_id: updated.id, invoice_id: invoice.id, state: "pending" });
  }
  await reconcileReviewTextingConversion(u, op);
}

async function linesFor(invoice: Stripe.Invoice) {
  if (!invoice.lines.has_more) return invoice.lines.data;
  const lines = await stripe.invoices.listLineItems(invoice.id, { limit: 100 });
  if (lines.has_more) throw new TextingUpgradeError("texting_upgrade_invoice_unsupported");
  return lines.data;
}
function invoiceOwned(invoice: Stripe.Invoice, op: SmsBillingOperation, u: TextingUpgradeRecord) {
  const snapshot = invoice.parent?.subscription_details?.metadata;
  return snapshot?.sms_billing_operation_id === op.id && snapshot?.chat_texting_upgrade_id === u.id;
}
/** Invoice-time metadata is immutable after finalization; current subscription metadata is not proof. */
export function verifyReviewConversionInvoice(invoice: Stripe.Invoice, lines: Stripe.InvoiceLineItem[], op: SmsBillingOperation, u: TextingUpgradeRecord) {
  assertMode(invoice.livemode);
  reviewConversionUpdateParameters(op, u);
  if (id(invoice.customer) !== u.source_customer_id || invoiceSubscriptionId(invoice) !== u.source_subscription_id ||
    (op.invoice_id && invoice.id !== op.invoice_id) || invoice.billing_reason !== "subscription_update" || invoice.currency !== "usd" ||
    !op.confirmed_at || invoice.created < seconds(op.confirmed_at) - 60 || invoice.amount_due !== op.quote.amountDueCents || !invoiceOwned(invoice, op, u))
    throw new TextingUpgradeError("texting_upgrade_invoice_mismatch");
  const expected = [
    { item: op.stripe_item_id, price: op.target_price_id, positive: true },
    { item: op.stripe_item_id, price: op.quote.sourceBasePriceId, positive: false },
    { item: u.source_review_item_id, price: op.quote.sourceReviewPriceId, positive: false },
  ];
  if (lines.length !== expected.length || expected.some(e => lines.filter(line =>
    line.pricing?.price_details?.price === e.price && line.parent?.subscription_item_details?.subscription_item === e.item &&
    line.parent?.subscription_item_details?.proration === true && line.quantity === 1 &&
    line.period.start === seconds(op.proration_at!) && line.period.end === seconds(op.source_period_end!) &&
    (e.positive ? line.amount >= 0 : line.amount <= 0)).length !== 1))
    throw new TextingUpgradeError("texting_upgrade_proration_unverified");
}
async function findInvoice(u: TextingUpgradeRecord, op: SmsBillingOperation) {
  if (op.invoice_id) {
    const invoice = await stripe.invoices.retrieve(op.invoice_id);
    verifyReviewConversionInvoice(invoice, await linesFor(invoice), op, u); return invoice;
  }
  if (!op.confirmed_at) return null;
  const invoices = await stripe.invoices.list({ subscription: u.source_subscription_id, customer: u.source_customer_id,
    created: { gte: seconds(op.confirmed_at) - 60 }, limit: 100 });
  if (invoices.has_more) throw new TextingUpgradeError("texting_upgrade_payment_unresolved");
  const matches = invoices.data.filter(invoice => invoiceOwned(invoice, op, u));
  if (matches.length !== 1) throw new TextingUpgradeError("texting_upgrade_payment_unresolved");
  verifyReviewConversionInvoice(matches[0], await linesFor(matches[0]), op, u); return matches[0];
}
export async function reconcileReviewTextingConversion(u: TextingUpgradeRecord, supplied?: SmsBillingOperation): Promise<Stripe.Subscription> {
  let op = supplied ?? (u.billing_operation_id ? await operation(u.billing_operation_id, u.business_id) : null);
  const sub = await stripe.subscriptions.retrieve(u.source_subscription_id);
  assertBinding(sub, u);
  if (!op || ["prepared", "expired"].includes(op.state) || u.paid_at || op.state === "applied") return sub;
  const invoice = await findInvoice(u, op);
  if (!invoice) throw new TextingUpgradeError("texting_upgrade_payment_unresolved");
  if (!op.invoice_id) op = await record(op, { invoice_id: invoice.id, stripe_subscription_id: sub.id, state: "pending" });
  if (invoice.status === "void") {
    sourceItems(sub, u);
    if (sub.pending_update) throw new TextingUpgradeError("texting_upgrade_payment_unresolved");
    await record(op, { state: "expired" });
    await textingUpgradeRpc("expire_review_texting_upgrade_payment", { p_upgrade_id: u.id, p_operation_id: op.id });
    return sub;
  }
  if (invoice.status !== "paid" || !invoice.status_transitions.paid_at) return sub;
  if (sub.pending_update || sub.items.data.length !== 1 || sub.items.data[0].id !== op.stripe_item_id ||
    sub.items.data[0].price.id !== op.target_price_id || sub.items.data[0].quantity !== 1)
    throw new TextingUpgradeError("texting_upgrade_payment_sync_required", 503);
  const item = sub.items.data[0];
  const applied = await textingUpgradeRpc("finalize_chat_texting_upgrade_payment", { p_operation_id: op.id, p_details: {
    subscription_id: sub.id, customer_id: u.source_customer_id, plan: "sms_and_chat", price_id: item.price.id, status: normalizeStripeSubscriptionStatus(sub.status),
    current_period_start: iso(item.current_period_start), current_period_end: iso(item.current_period_end), cancel_at_period_end: sub.cancel_at_period_end,
    invoice_id: invoice.id, invoice_status: invoice.status, invoice_paid_at: iso(invoice.status_transitions.paid_at), invoice_created_at: iso(invoice.created),
    invoice_amount_due: invoice.amount_due, invoice_currency: invoice.currency, review_conversion_invoice_verified: true, source_review_item_id: u.source_review_item_id,
    payment_period_start: op.source_period_start, payment_period_end: op.source_period_end,
  } });
  if (applied !== true) throw new TextingUpgradeError("texting_upgrade_payment_sync_required", 503);
  return sub;
}
