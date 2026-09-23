import "server-only";
import { normalizeStripeSubscriptionStatus } from "./subscriptionStatus";
import type Stripe from "stripe";
import { stripe } from "./client";
import { TextingUpgradeError, type TextingUpgradeRecord } from "@/lib/billing/textingUpgrade";
import { getTextingUpgrade, textingUpgradeRpc } from "@/lib/billing/textingUpgradeStore.server";
import { isTextingUpgradeEnabled } from "@/lib/billing/textingUpgradeRollout.server";
import { isPlanAvailable } from "@/lib/billing/planAvailability";
import { assertApprovedChatOnlyStripePrice } from "./chatOnlyPrice";
import { assertSmsPrice, invoiceSubscriptionId, operation, operationSchema, record, smsSubscriptionFingerprint, type SmsBillingOperation } from "./smsBilling.server";
import { SETUP_FEE_CENTS, SUBSCRIPTION_PLANS, stripePriceIdForPlan, stripeSetupFeePriceId } from "./config";

const id = (value: string | { id: string } | null | undefined) => typeof value === "string" ? value : value?.id ?? null;
const iso = (value: number) => new Date(value * 1000).toISOString();
const seconds = (value: string) => Math.floor(Date.parse(value) / 1000);
function assertMode(livemode: boolean) {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  const mode = key.startsWith("sk_test_") ? false : key.startsWith("sk_live_") ? true : null;
  if (mode === null || mode !== livemode) throw new TextingUpgradeError("texting_upgrade_mode_mismatch", 503);
}
function assertSubscription(sub: Stripe.Subscription, upgrade: TextingUpgradeRecord) {
  assertMode(sub.livemode);
  if (sub.id !== upgrade.source_subscription_id || id(sub.customer) !== upgrade.source_customer_id || sub.metadata.business_id !== upgrade.business_id)
    throw new TextingUpgradeError("texting_upgrade_source_changed");
  if (sub.items.has_more || sub.items.data.length !== 1 || sub.items.data[0].quantity !== 1 || sub.items.data[0].price.recurring?.usage_type !== "licensed")
    throw new TextingUpgradeError("texting_upgrade_subscription_unsupported");
}
function assertChangeable(sub: Stripe.Subscription) {
  if (sub.status !== "active" || sub.cancel_at_period_end || sub.schedule || sub.pending_update || sub.collection_method !== "charge_automatically" || sub.discounts.length || sub.items.data[0].current_period_end <= Date.now() / 1000)
    throw new TextingUpgradeError("texting_upgrade_source_changed");
  assertApprovedChatOnlyStripePrice(sub.items.data[0].price, { requireActive: false, quantity: 1, subscriptionItemCount: 1 });
}
async function assertPrices(op: Pick<SmsBillingOperation, "target_plan" | "target_price_id" | "setup_fee_price_id">) {
  if (!isPlanAvailable(op.target_plan) || stripePriceIdForPlan(op.target_plan) !== op.target_price_id || stripeSetupFeePriceId() !== op.setup_fee_price_id)
    throw new TextingUpgradeError("texting_upgrade_price_changed");
  const [price, fee] = await Promise.all([stripe.prices.retrieve(op.target_price_id), stripe.prices.retrieve(op.setup_fee_price_id!)]);
  assertSmsPrice(price, op.target_plan, op.target_price_id);
  if (!fee.active || fee.currency !== "usd" || fee.unit_amount !== SETUP_FEE_CENTS || fee.type !== "one_time")
    throw new TextingUpgradeError("texting_upgrade_price_unavailable", 503);
}
async function preview(sub: Stripe.Subscription, priceId: string, feeId: string, prorationAt: number) {
  return stripe.invoices.createPreview({ customer: id(sub.customer)!, subscription: sub.id,
    subscription_details: { items: [{ id: sub.items.data[0].id, price: priceId, quantity: 1 }], proration_date: prorationAt, proration_behavior: "always_invoice", billing_cycle_anchor: "unchanged" },
    invoice_items: [{ price: feeId, quantity: 1 }],
  });
}
export async function quoteTextingUpgrade(businessId: string, ownerId: string) {
  if (!isTextingUpgradeEnabled(businessId)) throw new TextingUpgradeError("texting_upgrade_disabled");
  const initial = await getTextingUpgrade(businessId);
  if (!initial) throw new TextingUpgradeError("texting_upgrade_not_found", 404);
  // Read before the multi-table requirement/risk loader. Acquisition compares
  // the same snapshot under the business lock, rejecting concurrent edits.
  const observed = await textingUpgradeRpc("read_chat_texting_upgrade_setup", { p_upgrade_id: initial.id, p_owner_id: ownerId });
  if (!observed || typeof observed.setupFingerprint !== "string" || !/^[a-f0-9]{32}$/.test(observed.setupFingerprint))
    throw new TextingUpgradeError("texting_upgrade_state_unavailable", 503);
  const { requireTextingUpgradeReady, textingUpgradeQuote } = await import("@/lib/billing/textingUpgrade.server");
  const c = await requireTextingUpgradeReady(businessId, ownerId);
  if (c.upgrade.id !== initial.id) throw new TextingUpgradeError("texting_upgrade_source_changed");
  if (c.upgrade.paid_at || (c.operation && !["prepared", "expired"].includes(c.operation.state))) throw new TextingUpgradeError("texting_upgrade_payment_in_progress");
  const sub = await stripe.subscriptions.retrieve(c.upgrade.source_subscription_id);
  assertSubscription(sub, c.upgrade); assertChangeable(sub);
  const targetPrice = stripePriceIdForPlan(c.upgrade.target_plan), setupPrice = stripeSetupFeePriceId();
  await assertPrices({ target_plan: c.upgrade.target_plan, target_price_id: targetPrice, setup_fee_price_id: setupPrice });
  const now = Math.floor(Date.now() / 1000), item = sub.items.data[0];
  const quote = await preview(sub, targetPrice, setupPrice, now);
  if (quote.currency !== "usd" || !Number.isSafeInteger(quote.amount_due) || quote.amount_due < 0) throw new TextingUpgradeError("texting_upgrade_quote_unavailable", 503);
  const op = operationSchema.parse(await textingUpgradeRpc("acquire_chat_texting_upgrade_quote", { p_upgrade_id: c.upgrade.id, p_owner_id: ownerId, p_request: {
    kind: "upgrade", target_plan: c.upgrade.target_plan, target_price_id: targetPrice, setup_fee_price_id: setupPrice,
    expected_subscription_id: sub.id, expected_customer_id: id(sub.customer), stripe_item_id: item.id,
    expected_setup_fingerprint: observed.setupFingerprint,
    source_fingerprint: smsSubscriptionFingerprint(sub), proration_at: iso(now),
    quote: { amountDueCents: quote.amount_due, currency: quote.currency, monthlyPriceCents: SUBSCRIPTION_PLANS[c.upgrade.target_plan].price * 100,
      setupFeeCents: SETUP_FEE_CENTS, voiceSeconds: c.upgrade.target_plan === "full" ? Math.max(0, Math.floor(6000 * (item.current_period_end - now) / (item.current_period_end - item.current_period_start))) : 0 },
  } }));
  return textingUpgradeQuote(op);
}

function updateParameters(op: SmsBillingOperation, upgradeId: string): Stripe.SubscriptionUpdateParams {
  return { items: [{ id: op.stripe_item_id!, price: op.target_price_id, quantity: 1 }],
    payment_behavior: "pending_if_incomplete", proration_behavior: "always_invoice", proration_date: seconds(op.proration_at!), billing_cycle_anchor: "unchanged",
    metadata: { sms_billing_operation_id: op.id, chat_texting_upgrade_id: upgradeId },
    add_invoice_items: [{ price: op.setup_fee_price_id!, quantity: 1, metadata: { chat_texting_upgrade_id: upgradeId, sms_billing_operation_id: op.id } }],
  };
}
export async function confirmTextingUpgrade(businessId: string, ownerId: string, operationId: string, quoteFingerprint: string, starterAcknowledged: boolean) {
  const { loadTextingUpgradeContext } = await import("@/lib/billing/textingUpgrade.server");
  const c = await loadTextingUpgradeContext(businessId, ownerId);
  const u = c.upgrade;
  if (!u || u.billing_operation_id !== operationId || !c.operation || c.operation.owner_id !== ownerId) throw new TextingUpgradeError("texting_upgrade_operation_not_found", 404);
  let op = c.operation;
  if (op.source_fingerprint !== quoteFingerprint) throw new TextingUpgradeError("texting_upgrade_quote_changed");
  if (u.paid_at) return;
  if (op.state === "expired") throw new TextingUpgradeError("texting_upgrade_quote_expired");
  if (op.state === "prepared") {
    if (!isTextingUpgradeEnabled(businessId)) throw new TextingUpgradeError("texting_upgrade_disabled");
    const { requireTextingUpgradeReady } = await import("@/lib/billing/textingUpgrade.server");
    await requireTextingUpgradeReady(businessId, ownerId);
    if (u.target_plan === "sms_only" && (!starterAcknowledged || !u.starter_acknowledged_at)) throw new TextingUpgradeError("texting_upgrade_starter_acknowledgement_required");
    if (Date.parse(op.expires_at) <= Date.now()) throw new TextingUpgradeError("texting_upgrade_quote_expired");
    const sub = await stripe.subscriptions.retrieve(u.source_subscription_id);
    assertSubscription(sub, u); assertChangeable(sub);
    if (smsSubscriptionFingerprint(sub) !== op.source_fingerprint) throw new TextingUpgradeError("texting_upgrade_quote_changed");
    await assertPrices(op);
    const refreshed = await preview(sub, op.target_price_id, op.setup_fee_price_id!, seconds(op.proration_at!));
    if (refreshed.amount_due !== op.quote.amountDueCents || refreshed.currency !== op.quote.currency) throw new TextingUpgradeError("texting_upgrade_quote_changed");
    op = operationSchema.parse(await textingUpgradeRpc("confirm_chat_texting_upgrade", { p_upgrade_id: u.id, p_owner_id: ownerId, p_operation_id: op.id, p_source_fingerprint: quoteFingerprint }));
  }
  if (op.state === "confirming" && !op.invoice_id) {
    // Same parameters/key after lost responses. Never mint a replacement after key retention.
    if (Date.now() - Date.parse(op.confirmed_at ?? op.created_at) >= 23 * 3600_000) {
      await reconcileTextingUpgradePayment(u, op);
      return;
    }
    const updated = await stripe.subscriptions.update(u.source_subscription_id, updateParameters(op, u.id), { idempotencyKey: `chat-texting-upgrade:${op.id}` });
    assertSubscription(updated, u);
    if (!id(updated.latest_invoice)) throw new TextingUpgradeError("texting_upgrade_payment_unresolved");
    // Bind only the direct response of the idempotent change, never a later latest_invoice.
    op = await record(op, { stripe_subscription_id: updated.id, invoice_id: id(updated.latest_invoice), state: "pending" });
  }
  await reconcileTextingUpgradePayment(u, op);
}

async function invoiceLines(invoice: Stripe.Invoice): Promise<Stripe.InvoiceLineItem[]> {
  if (!invoice.lines.has_more) return invoice.lines.data;
  const lines = await stripe.invoices.listLineItems(invoice.id, { limit: 100 });
  if (lines.has_more) throw new TextingUpgradeError("texting_upgrade_invoice_unsupported");
  return lines.data;
}
/** The fee line carries immutable operation identity across renewals and lost update responses. */
export function verifyTextingUpgradeInvoice(invoice: Stripe.Invoice, lines: Stripe.InvoiceLineItem[], op: SmsBillingOperation, u: TextingUpgradeRecord): void {
  assertMode(invoice.livemode);
  if (id(invoice.customer) !== u.source_customer_id || invoiceSubscriptionId(invoice) !== u.source_subscription_id ||
      (op.invoice_id && invoice.id !== op.invoice_id) || invoice.billing_reason !== "subscription_update" || invoice.currency !== "usd" ||
      !op.confirmed_at || invoice.created < seconds(op.confirmed_at) - 60 || invoice.amount_due !== op.quote.amountDueCents)
    throw new TextingUpgradeError("texting_upgrade_invoice_mismatch");
  const fees = lines.filter(l => l.pricing?.price_details?.price === op.setup_fee_price_id);
  if (fees.length !== 1 || fees[0].quantity !== 1 || fees[0].amount !== SETUP_FEE_CENTS ||
      fees[0].metadata.sms_billing_operation_id !== op.id || fees[0].metadata.chat_texting_upgrade_id !== u.id)
    throw new TextingUpgradeError("texting_upgrade_setup_fee_unverified");
  const target = lines.find(l => l.pricing?.price_details?.price === op.target_price_id && l.parent?.subscription_item_details?.proration &&
    l.parent.subscription_item_details.subscription_item === op.stripe_item_id && l.period.start === seconds(op.proration_at!) && l.period.end === seconds(op.source_period_end!));
  if (!target) throw new TextingUpgradeError("texting_upgrade_proration_unverified");
}
async function findInvoice(u: TextingUpgradeRecord, op: SmsBillingOperation) {
  if (op.invoice_id) {
    const invoice = await stripe.invoices.retrieve(op.invoice_id);
    verifyTextingUpgradeInvoice(invoice, await invoiceLines(invoice), op, u);
    return invoice;
  }
  if (!op.confirmed_at) return null;
  const invoices = await stripe.invoices.list({ subscription: u.source_subscription_id, customer: u.source_customer_id, created: { gte: seconds(op.confirmed_at) - 60 }, limit: 100 });
  if (invoices.has_more) throw new TextingUpgradeError("texting_upgrade_payment_unresolved");
  const matches: Stripe.Invoice[] = [];
  for (const invoice of invoices.data) {
    const lines = await invoiceLines(invoice);
    if (!lines.some(l => l.metadata.sms_billing_operation_id === op.id && l.metadata.chat_texting_upgrade_id === u.id)) continue;
    verifyTextingUpgradeInvoice(invoice, lines, op, u); matches.push(invoice);
  }
  if (matches.length !== 1) throw new TextingUpgradeError("texting_upgrade_payment_unresolved");
  return matches[0];
}
export async function reconcileTextingUpgradePayment(u: TextingUpgradeRecord, suppliedOperation?: SmsBillingOperation): Promise<Stripe.Subscription> {
  let op = suppliedOperation ?? (u.billing_operation_id ? await operation(u.billing_operation_id, u.business_id) : null);
  const sub = await stripe.subscriptions.retrieve(u.source_subscription_id);
  assertSubscription(sub, u);
  if (!op || ["prepared", "expired"].includes(op.state) || u.paid_at || op.state === "applied") return sub;
  const invoice = await findInvoice(u, op);
  if (!invoice) throw new TextingUpgradeError("texting_upgrade_payment_unresolved");
  if (!op.invoice_id) op = await record(op, { invoice_id: invoice.id, stripe_subscription_id: sub.id, state: "pending" });
  if (invoice.status === "void") {
    if (sub.pending_update || sub.items.data[0].price.id === op.target_price_id) throw new TextingUpgradeError("texting_upgrade_payment_unresolved");
    await record(op, { state: "expired" });
    return sub;
  }
  if (invoice.status !== "paid" || !invoice.status_transitions.paid_at) return sub;
  if (sub.pending_update || sub.items.data[0].price.id !== op.target_price_id) throw new TextingUpgradeError("texting_upgrade_payment_sync_required", 503);
  const item = sub.items.data[0];
  const applied = await textingUpgradeRpc("finalize_chat_texting_upgrade_payment", { p_operation_id: op.id, p_details: {
    subscription_id: sub.id, customer_id: id(sub.customer), plan: op.target_plan, price_id: item.price.id, status: normalizeStripeSubscriptionStatus(sub.status),
    current_period_start: iso(item.current_period_start), current_period_end: iso(item.current_period_end), cancel_at_period_end: sub.cancel_at_period_end,
    invoice_id: invoice.id, invoice_status: invoice.status, invoice_paid_at: iso(invoice.status_transitions.paid_at), invoice_created_at: iso(invoice.created),
    invoice_amount_due: invoice.amount_due, invoice_currency: invoice.currency, setup_fee_price_id: op.setup_fee_price_id, setup_fee_verified: true,
    payment_period_start: op.source_period_start, payment_period_end: op.source_period_end,
  } });
  if (applied !== true) throw new TextingUpgradeError("texting_upgrade_payment_sync_required", 503);
  return sub;
}
export async function recoverTextingUpgradePayment(businessId: string, ownerId: string): Promise<string | null> {
  const { loadTextingUpgradeContext } = await import("@/lib/billing/textingUpgrade.server");
  const c = await loadTextingUpgradeContext(businessId, ownerId);
  if (!c.upgrade || !c.operation) return null;
  await reconcileTextingUpgradePayment(c.upgrade, c.operation);
  const op = await operation(c.operation.id, businessId);
  if (op.state !== "pending" || !op.invoice_id) return null;
  const invoice = await stripe.invoices.retrieve(op.invoice_id);
  verifyTextingUpgradeInvoice(invoice, await invoiceLines(invoice), op, c.upgrade);
  return invoice.status === "open" && invoice.hosted_invoice_url?.startsWith("https://invoice.stripe.com/") ? invoice.hosted_invoice_url : null;
}
export async function cancelTextingUpgrade(businessId: string, ownerId: string) {
  const { loadTextingUpgradeContext } = await import("@/lib/billing/textingUpgrade.server");
  const c = await loadTextingUpgradeContext(businessId, ownerId);
  if (!c.upgrade || c.upgrade.state === "abandoned") return;
  if (c.upgrade.paid_at) throw new TextingUpgradeError("texting_upgrade_already_paid");
  let op = c.operation;
  if (op && !["prepared", "expired"].includes(op.state)) {
    await reconcileTextingUpgradePayment(c.upgrade, op);
    op = await operation(op.id, businessId);
    if (op.state === "applied") throw new TextingUpgradeError("texting_upgrade_already_paid");
    if (op.state !== "expired") {
      if (!op.invoice_id) throw new TextingUpgradeError("texting_upgrade_payment_unresolved");
      const invoice = await stripe.invoices.retrieve(op.invoice_id);
      verifyTextingUpgradeInvoice(invoice, await invoiceLines(invoice), op, c.upgrade);
      if (invoice.status !== "open") throw new TextingUpgradeError("texting_upgrade_payment_unresolved");
      await stripe.invoices.voidInvoice(invoice.id, {}, { idempotencyKey: `chat-texting-void:${op.id}` });
      await reconcileTextingUpgradePayment(c.upgrade, op);
    }
  }
  await textingUpgradeRpc("cancel_chat_texting_upgrade", { p_upgrade_id: c.upgrade.id, p_owner_id: ownerId });
}

/** Called before interpreting retained initial-Chat metadata or ordinary SMS operations. */
export async function synchronizeTextingUpgradeSubscription(input: Stripe.Subscription): Promise<{ owned: boolean; paid: boolean; subscription: Stripe.Subscription }> {
  const unchanged = { owned: false, paid: false, subscription: input };
  const businessId = input.metadata?.business_id;
  if (!businessId || (!input.metadata.chat_texting_upgrade_id && input.metadata.plan !== "chat_only" && !input.metadata.checkout_attempt_id)) return unchanged;
  const u = await getTextingUpgrade(businessId);
  if (!u || u.source_subscription_id !== input.id || !u.billing_operation_id) return unchanged;
  const op = await operation(u.billing_operation_id, businessId);
  if (["prepared", "expired"].includes(op.state) && !u.paid_at) return unchanged;
  let fresh = await reconcileTextingUpgradePayment(u, op);
  const current = await getTextingUpgrade(businessId);
  if (!current?.paid_at) return { owned: true, paid: false, subscription: fresh };
  // Retain historical provider metadata in Stripe. It is no longer plan authority.
  const metadata = { ...fresh.metadata };
  delete metadata.plan; delete metadata.checkout_attempt_id; delete metadata.checkout_request_fingerprint; delete metadata.checkout_session_expires_at;
  fresh = { ...fresh, metadata };
  return { owned: fresh.metadata.sms_billing_operation_id === op.id, paid: true, subscription: fresh };
}
