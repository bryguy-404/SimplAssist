import "server-only";
import { createHash } from "node:crypto";
import type Stripe from "stripe";
import { z } from "zod";
import { stripe } from "./client";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isPlanAvailable } from "@/lib/billing/planAvailability";
import { SUBSCRIPTION_PLANS, planFromStripePriceId, stripePriceIdForPlan } from "./config";
import type { BillingChangeView, SmsPlan } from "./smsBilling";
import { SmsBillingError } from "./smsBilling";
export { SmsBillingError } from "./smsBilling";

export const operationSchema = z.object({
  id: z.string().uuid(), business_id: z.string().uuid(), owner_id: z.string().uuid(),
  kind: z.enum(["checkout", "upgrade", "downgrade"]),
  state: z.enum(["prepared", "confirming", "pending", "scheduled", "applied", "expired"]),
  target_plan: z.enum(["sms_only", "sms_and_chat", "full"]), target_price_id: z.string(),
  expected_subscription_id: z.string().nullable(), expected_customer_id: z.string().nullable(),
  stripe_customer_id: z.string().nullable(), stripe_subscription_id: z.string().nullable(), stripe_item_id: z.string().nullable(),
  checkout_session_id: z.string().nullable(), invoice_id: z.string().nullable(), schedule_id: z.string().nullable(),
  source_fingerprint: z.string(), source_plan: z.string().nullable(), source_period_start: z.string().nullable(), source_period_end: z.string().nullable(),
  proration_at: z.string().nullable(), payment_effective_at: z.string().nullable(), payment_verified_at: z.string().nullable(),
  setup_fee_price_id: z.string().nullable(), quote: z.record(z.string(), z.unknown()), created_at: z.string(), expires_at: z.string(),
  confirmed_at: z.string().nullable(), applied_at: z.string().nullable(),
});
export type SmsBillingOperation = z.infer<typeof operationSchema>;
const uuid = z.string().uuid();
const terminal = new Set(["canceled", "incomplete_expired"]);
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const seconds = (value: string) => Math.floor(Date.parse(value) / 1000);
const id = (value: string | { id: string } | null | undefined) => typeof value === "string" ? value : value?.id ?? null;
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function rpcOperation(name: string, args: Record<string, unknown>): Promise<SmsBillingOperation> {
  const { data, error } = await supabaseAdmin.rpc(name, args);
  if (error) {
    const code = /sms_billing_[a-z_]+/.exec(error.message)?.[0] ?? "sms_billing_unavailable";
    throw new SmsBillingError(code, code === "sms_billing_forbidden" ? 403 : code === "sms_billing_unavailable" ? 503 : 409);
  }
  const result = operationSchema.safeParse(data);
  if (!result.success) throw new SmsBillingError("sms_billing_invalid_state", 503);
  return result.data;
}
export async function operation(operationId: string, businessId?: string): Promise<SmsBillingOperation> {
  if (!uuid.safeParse(operationId).success) throw new SmsBillingError("sms_billing_not_found", 404);
  let query = supabaseAdmin.from("sms_billing_operations").select("*").eq("id", operationId);
  if (businessId) query = query.eq("business_id", businessId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new SmsBillingError("sms_billing_unavailable", 503);
  if (!data) throw new SmsBillingError("sms_billing_not_found", 404);
  return operationSchema.parse(data);
}
async function operationForProvider(operationId: string, businessId: string | undefined): Promise<SmsBillingOperation | null> {
  try { return await operation(operationId); }
  catch (error) {
    if (!(error instanceof SmsBillingError) || error.code !== "sms_billing_not_found" || !businessId || !uuid.safeParse(businessId).success) throw error;
    const { data, error: lookupError } = await supabaseAdmin.from("businesses").select("owner_id,deleted_at,cleanup_pii_scrubbed_at").eq("id", businessId).maybeSingle();
    if (!lookupError && data?.deleted_at && data.cleanup_pii_scrubbed_at && data.owner_id === null && !(await localSubscription(businessId))) return null;
    throw error;
  }
}
export async function record(op: SmsBillingOperation, details: Record<string, unknown>) {
  return rpcOperation("record_sms_billing_operation", { p_operation_id: op.id, p_details: details });
}
async function localSubscription(businessId: string) {
  const { data, error } = await supabaseAdmin.from("subscriptions").select("*").eq("business_id", businessId).maybeSingle();
  if (error) throw new SmsBillingError("sms_billing_unavailable", 503);
  return data;
}
async function owner(businessId: string, ownerId?: string): Promise<string> {
  const { data, error } = await supabaseAdmin.from("businesses").select("owner_id,billing_mode,partner_id,partner_plan,deleted_at,operations_suspended_at")
    .eq("id", businessId).maybeSingle();
  if (error) throw new SmsBillingError("sms_billing_unavailable", 503);
  if (!data?.owner_id || (ownerId && data.owner_id !== ownerId) || data.deleted_at || data.operations_suspended_at ||
    data.billing_mode !== "stripe" || data.partner_id || data.partner_plan) throw new SmsBillingError("sms_billing_forbidden", 403);
  return data.owner_id;
}
export function assertSmsPrice(price: Stripe.Price, plan: SmsPlan, expectedId: string) {
  if (price.id !== expectedId || !price.active || price.currency !== "usd" || price.unit_amount !== SUBSCRIPTION_PLANS[plan].price * 100 ||
    price.type !== "recurring" || price.recurring?.interval !== "month" || price.recurring.interval_count !== 1 || price.recurring.usage_type !== "licensed")
    throw new SmsBillingError("sms_billing_price_unavailable", 503);
}
function assertMode(livemode: boolean) {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  const expected = key.startsWith("sk_live_") ? true : key.startsWith("sk_test_") ? false : null;
  if (expected === null || expected !== livemode) throw new SmsBillingError("sms_billing_mode_mismatch", 503);
}
export function smsSubscriptionFingerprint(sub: Stripe.Subscription): string {
  return fingerprint({ id: sub.id, customer: id(sub.customer), status: sub.status, cancel: sub.cancel_at_period_end,
    schedule: id(sub.schedule), pending: sub.pending_update, discounts: sub.discounts,
    items: sub.items.data.map((item) => ({ id: item.id, price: item.price.id, quantity: item.quantity,
      start: item.current_period_start, end: item.current_period_end })), more: sub.items.has_more });
}
function assertSource(sub: Stripe.Subscription, businessId: string, customerId: string, subscriptionId: string) {
  assertMode(sub.livemode);
  if (sub.id !== subscriptionId || id(sub.customer) !== customerId || sub.metadata.business_id !== businessId)
    throw new SmsBillingError("sms_billing_source_changed");
  if (sub.items.has_more || sub.items.data.length !== 1 || sub.items.data[0].quantity !== 1 ||
    sub.items.data[0].price.recurring?.usage_type !== "licensed") throw new SmsBillingError("sms_billing_subscription_shape_unsupported");
}
function assertChangeable(sub: Stripe.Subscription) {
  if (sub.status !== "active" || sub.cancel_at_period_end || sub.schedule || sub.pending_update || sub.collection_method !== "charge_automatically")
    throw new SmsBillingError("sms_billing_existing_subscription");
  if (sub.items.data[0].current_period_end <= Math.floor(Date.now() / 1000)) throw new SmsBillingError("sms_billing_source_changed");
}
function assertRetryWindow(op: SmsBillingOperation) {
  // Stripe may prune idempotency keys after 24 hours. Never blindly recreate
  // ambiguous payable work after that retention window.
  if (Date.now() - Date.parse(op.created_at) >= 23 * 3600_000) throw new SmsBillingError("sms_billing_recovery_required");
}

export async function createSmsCheckout(args: { businessId: string; plan: SmsPlan; priceId: string; setupFeePriceId: string | null; successUrl: string; cancelUrl: string; mode: string }): Promise<string> {
  const ownerId = await owner(args.businessId);
  const current = await localSubscription(args.businessId);
  let previousTerminalProof: Record<string, string> = {};
  if (current && (!terminal.has(current.status) || current.plan === "chat_only")) throw new SmsBillingError("sms_billing_existing_subscription");
  if (current?.stripe_subscription_id) {
    const previous = await stripe.subscriptions.retrieve(current.stripe_subscription_id);
    assertSource(previous, args.businessId, current.stripe_customer_id, current.stripe_subscription_id);
    if (!terminal.has(previous.status)) throw new SmsBillingError("sms_billing_existing_subscription");
    previousTerminalProof = { previous_source_terminal_status: previous.status, previous_source_terminal_verified_at: new Date().toISOString() };
  }
  let op = await rpcOperation("acquire_sms_billing_operation", { p_business_id: args.businessId, p_owner_id: ownerId, p_request: {
    kind: "checkout", target_plan: args.plan, target_price_id: args.priceId,
    expected_subscription_id: current?.stripe_subscription_id ?? null, expected_customer_id: current?.stripe_customer_id ?? null,
    source_fingerprint: fingerprint({ subscription: current?.stripe_subscription_id ?? null, customer: current?.stripe_customer_id ?? null,
      plan: args.plan, price: args.priceId, successUrl: args.successUrl, cancelUrl: args.cancelUrl, mode: args.mode }),
    setup_fee_price_id: args.setupFeePriceId,
    ...previousTerminalProof,
    quote: { successUrl: args.successUrl, cancelUrl: args.cancelUrl, mode: args.mode },
  } });
  if (op.checkout_session_id) return recoverCheckout(op);
  assertRetryWindow(op);
  if (op.state === "prepared") {
    if (!isPlanAvailable(op.target_plan)) throw new SmsBillingError("sms_billing_plan_unavailable");
    assertSmsPrice(await stripe.prices.retrieve(args.priceId), args.plan, args.priceId);
    if (op.setup_fee_price_id) {
      const fee = await stripe.prices.retrieve(op.setup_fee_price_id);
      if (!fee.active || fee.currency !== "usd" || fee.unit_amount !== 2500 || fee.type !== "one_time") throw new SmsBillingError("sms_billing_price_unavailable", 503);
    }
  }
  op = await rpcOperation("confirm_sms_billing_operation", { p_operation_id: op.id, p_owner_id: ownerId, p_source_fingerprint: op.source_fingerprint });
  if (!op.stripe_customer_id) {
    const customer = await stripe.customers.create({ metadata: { business_id: args.businessId } }, { idempotencyKey: `sms-customer:${op.id}` });
    op = await record(op, { stripe_customer_id: customer.id });
  }
  const metadata = { business_id: args.businessId, plan: op.target_plan, mode: args.mode,
    sms_billing_operation_id: op.id, ...(op.setup_fee_price_id ? { setup_fee_price_id: op.setup_fee_price_id } : {}) };
  const session = await stripe.checkout.sessions.create({ customer: op.stripe_customer_id!, client_reference_id: args.businessId,
    mode: "subscription", payment_method_types: ["card"], allow_promotion_codes: true, expires_at: seconds(op.expires_at),
    line_items: [{ price: op.target_price_id, quantity: 1 }, ...(op.setup_fee_price_id ? [{ price: op.setup_fee_price_id, quantity: 1 }] : [])],
    success_url: args.successUrl, cancel_url: args.cancelUrl, metadata, subscription_data: { metadata },
  }, { idempotencyKey: `sms-checkout:${op.id}` });
  op = await record(op, { checkout_session_id: session.id, stripe_customer_id: id(session.customer), state: "pending" });
  return checkoutUrl(session, op);
}
function checkoutUrl(session: Stripe.Checkout.Session, op: SmsBillingOperation): string {
  assertMode(session.livemode);
  if (session.metadata?.sms_billing_operation_id !== op.id || session.client_reference_id !== op.business_id ||
    id(session.customer) !== op.stripe_customer_id || session.mode !== "subscription") throw new SmsBillingError("sms_billing_source_changed");
  if (session.status !== "open" || !session.url?.startsWith("https://checkout.stripe.com/")) throw new SmsBillingError("sms_billing_payment_sync_required");
  return session.url;
}
async function recoverCheckout(op: SmsBillingOperation): Promise<string> {
  const session = await stripe.checkout.sessions.retrieve(op.checkout_session_id!);
  if (session.status === "expired") { await record(op, { state: "expired" }); throw new SmsBillingError("sms_billing_checkout_expired"); }
  if (session.status === "complete") {
    if (typeof session.subscription !== "string") throw new SmsBillingError("sms_billing_payment_sync_required");
    await synchronizeSmsBillingOperation(await stripe.subscriptions.retrieve(session.subscription));
    return String(op.quote.successUrl).replace("{CHECKOUT_SESSION_ID}", session.id);
  }
  return checkoutUrl(session, op);
}

export async function previewSmsPlanChange(businessId: string, ownerId: string, target: SmsPlan): Promise<BillingChangeView> {
  await owner(businessId, ownerId);
  if (!isPlanAvailable(target)) throw new SmsBillingError("sms_billing_plan_unavailable");
  const current = await localSubscription(businessId);
  if (!current?.stripe_subscription_id || current.plan === "chat_only") throw new SmsBillingError("sms_billing_existing_subscription");
  const sub = await stripe.subscriptions.retrieve(current.stripe_subscription_id);
  assertSource(sub, businessId, current.stripe_customer_id, current.stripe_subscription_id);
  assertChangeable(sub);
  const item = sub.items.data[0];
  const sourcePlan = planFromStripePriceId(item.price.id);
  if (sourcePlan !== current.plan || !sourcePlan || sourcePlan === "chat_only") throw new SmsBillingError("sms_billing_source_changed");
  const upgrade = SUBSCRIPTION_PLANS[target].price > SUBSCRIPTION_PLANS[sourcePlan].price;
  if (target === sourcePlan) throw new SmsBillingError("sms_billing_invalid_transition");
  const priceId = stripePriceIdForPlan(target);
  assertSmsPrice(await stripe.prices.retrieve(priceId), target, priceId);
  const proration = Math.floor(Date.now() / 1000);
  const preview = upgrade ? await stripe.invoices.createPreview({ customer: current.stripe_customer_id, subscription: sub.id,
    subscription_details: { items: [{ id: item.id, price: priceId, quantity: 1 }], proration_date: proration, proration_behavior: "always_invoice", billing_cycle_anchor: "unchanged" },
  }) : null;
  const op = await rpcOperation("acquire_sms_billing_operation", { p_business_id: businessId, p_owner_id: ownerId, p_request: {
    kind: upgrade ? "upgrade" : "downgrade", target_plan: target, target_price_id: priceId,
    expected_subscription_id: sub.id, expected_customer_id: current.stripe_customer_id, stripe_item_id: item.id,
    source_fingerprint: smsSubscriptionFingerprint(sub), proration_at: iso(proration),
    quote: { amountDueCents: preview?.amount_due ?? 0, currency: preview?.currency ?? "usd", monthlyPriceCents: SUBSCRIPTION_PLANS[target].price * 100,
      voiceSeconds: upgrade && target === "full" ? Math.max(0, Math.floor(6000 * (item.current_period_end - proration) / (item.current_period_end - item.current_period_start))) : 0 },
  } });
  return view(op);
}

export async function confirmSmsPlanChange(businessId: string, ownerId: string, operationId: string): Promise<BillingChangeView> {
  await owner(businessId, ownerId);
  let op = await operation(operationId, businessId);
  if (op.owner_id !== ownerId) throw new SmsBillingError("sms_billing_forbidden", 403);
  if (op.source_plan === "chat_only") throw new SmsBillingError("texting_upgrade_required");
  if (op.kind === "checkout") {
    if (op.state === "applied" || op.state === "expired") return view(op);
    const url = await createSmsCheckout({ businessId, plan: op.target_plan, priceId: op.target_price_id,
      setupFeePriceId: op.setup_fee_price_id, successUrl: String(op.quote.successUrl), cancelUrl: String(op.quote.cancelUrl), mode: String(op.quote.mode) });
    const result = (await readSmsBillingChange(businessId, ownerId, op.id))!;
    return { ...result, ...(result.state !== "applied" && url.startsWith("https://checkout.stripe.com/") ? { paymentUrl: url } : {}) };
  }
  if (op.state === "applied" || op.state === "scheduled" || op.state === "pending") return (await readSmsBillingChange(businessId, ownerId, operationId))!;
  if (op.state === "expired") throw new SmsBillingError("sms_billing_quote_expired");
  const sub = await stripe.subscriptions.retrieve(op.expected_subscription_id!);
  assertSource(sub, businessId, op.expected_customer_id!, op.expected_subscription_id!);
  if (op.state === "prepared") {
    if (!isPlanAvailable(op.target_plan)) throw new SmsBillingError("sms_billing_plan_unavailable");
    assertChangeable(sub);
    if (smsSubscriptionFingerprint(sub) !== op.source_fingerprint) throw new SmsBillingError("sms_billing_source_changed");
    if (stripePriceIdForPlan(op.target_plan) !== op.target_price_id) throw new SmsBillingError("sms_billing_source_changed");
    assertSmsPrice(await stripe.prices.retrieve(op.target_price_id), op.target_plan, op.target_price_id);
    if (op.kind === "upgrade") {
      const refreshed = await stripe.invoices.createPreview({ customer: op.stripe_customer_id!, subscription: sub.id,
        subscription_details: { items: [{ id: op.stripe_item_id!, price: op.target_price_id, quantity: 1 }],
          proration_date: seconds(op.proration_at!), proration_behavior: "always_invoice", billing_cycle_anchor: "unchanged" } });
      if (refreshed.amount_due !== op.quote.amountDueCents || refreshed.currency !== op.quote.currency)
        throw new SmsBillingError("sms_billing_source_changed");
    }
  }
  assertRetryWindow(op);
  op = await rpcOperation("confirm_sms_billing_operation", { p_operation_id: op.id, p_owner_id: ownerId, p_source_fingerprint: op.source_fingerprint });
  // Replays use identical parameters and key, even after the provider has
  // already changed the subscription but the response was lost.
  if (op.kind === "upgrade") {
    const updated = await stripe.subscriptions.update(op.expected_subscription_id!, {
      items: [{ id: op.stripe_item_id!, price: op.target_price_id, quantity: 1 }],
      payment_behavior: "pending_if_incomplete", proration_behavior: "always_invoice", proration_date: seconds(op.proration_at!),
      billing_cycle_anchor: "unchanged", metadata: { sms_billing_operation_id: op.id },
    }, { idempotencyKey: `sms-upgrade:${op.id}` });
    op = await record(op, { stripe_subscription_id: updated.id, invoice_id: id(updated.latest_invoice), state: "pending" });
    await synchronizeSmsBillingOperation(updated);
  } else {
    let schedule: Stripe.SubscriptionSchedule;
    if (op.schedule_id) schedule = await stripe.subscriptionSchedules.retrieve(op.schedule_id);
    else {
      schedule = await stripe.subscriptionSchedules.create({ from_subscription: sub.id }, { idempotencyKey: `sms-schedule:${op.id}` });
      op = await record(op, { schedule_id: schedule.id, stripe_subscription_id: sub.id });
    }
    const currentPhase = schedule.phases[0];
    if (!currentPhase || currentPhase.end_date !== seconds(op.source_period_end!)) throw new SmsBillingError("sms_billing_source_changed");
    const preserved = preserveSmsSchedulePhase(currentPhase, sub);
    await stripe.subscriptionSchedules.update(schedule.id, {
      end_behavior: "release", proration_behavior: "none", metadata: { business_id: businessId, sms_billing_operation_id: op.id },
      phases: [
        { ...preserved, start_date: currentPhase.start_date, end_date: currentPhase.end_date,
          proration_behavior: "none", metadata: { ...sub.metadata, ...currentPhase.metadata } },
        { ...preserved, start_date: currentPhase.end_date, items: [{ ...preserved.items[0], price: op.target_price_id, quantity: 1 }],
          duration: { interval: "month", interval_count: 1 }, proration_behavior: "none",
          metadata: { ...sub.metadata, ...currentPhase.metadata, sms_billing_operation_id: op.id } },
      ],
    }, { idempotencyKey: `sms-schedule-phases:${op.id}` });
    op = await record(op, { state: "scheduled" });
  }
  return (await readSmsBillingChange(businessId, ownerId, op.id))!;
}

export function preserveSmsSchedulePhase(phase: Stripe.SubscriptionSchedule.Phase, sub: Stripe.Subscription): Stripe.SubscriptionScheduleUpdateParams.Phase {
  // These configurations require an explicit separate billing flow; never drop
  // them silently while replacing the two phases of an ordinary SMS plan.
  if (phase.items.length !== 1 || phase.add_invoice_items?.length || phase.billing_thresholds || phase.trial_end ||
    phase.items.some((item) => item.billing_thresholds)) throw new SmsBillingError("sms_billing_subscription_shape_unsupported");
  const tax = phase.automatic_tax;
  const settings = phase.invoice_settings;
  const result: Stripe.SubscriptionScheduleUpdateParams.Phase = {
    items: phase.items.map((item) => ({ price: id(item.price)!, quantity: item.quantity ?? 1,
      ...(item.tax_rates?.length ? { tax_rates: item.tax_rates.map((rate) => id(rate)!) } : {}) })),
    discounts: sub.discounts?.map((discount) => ({ discount: id(discount)! })) ?? [],
    ...(phase.currency ? { currency: phase.currency } : {}),
    ...(phase.collection_method ? { collection_method: phase.collection_method } : {}),
    ...(phase.default_payment_method ? { default_payment_method: id(phase.default_payment_method)! } : {}),
    ...(phase.default_tax_rates ? { default_tax_rates: phase.default_tax_rates.map((rate) => id(rate)!) } : {}),
    ...(phase.billing_cycle_anchor ? { billing_cycle_anchor: phase.billing_cycle_anchor } : {}),
    ...(phase.description !== null && phase.description !== undefined ? { description: phase.description } : {}),
    ...(phase.application_fee_percent !== null && phase.application_fee_percent !== undefined ? { application_fee_percent: phase.application_fee_percent } : {}),
    ...(phase.on_behalf_of ? { on_behalf_of: id(phase.on_behalf_of)! } : {}),
    ...(phase.transfer_data ? { transfer_data: { destination: id(phase.transfer_data.destination)!, ...(phase.transfer_data.amount_percent !== null ? { amount_percent: phase.transfer_data.amount_percent } : {}) } } : {}),
    ...(tax ? { automatic_tax: { enabled: tax.enabled, ...(tax.liability ? { liability: { type: tax.liability.type, ...(tax.liability.account ? { account: id(tax.liability.account)! } : {}) } } : {}) } } : {}),
    ...(settings ? { invoice_settings: { ...(settings.account_tax_ids ? { account_tax_ids: settings.account_tax_ids.map((value) => id(value)!) } : {}),
      ...(settings.days_until_due !== null ? { days_until_due: settings.days_until_due } : {}),
      ...(settings.issuer ? { issuer: { type: settings.issuer.type, ...(settings.issuer.account ? { account: id(settings.issuer.account)! } : {}) } } : {}) } } : {}),
  };
  return result;
}

export async function readSmsBillingChange(businessId: string, ownerId: string, operationId?: string): Promise<BillingChangeView | null> {
  await owner(businessId, ownerId);
  let op: SmsBillingOperation;
  if (operationId) op = await operation(operationId, businessId);
  else {
    const { data, error } = await supabaseAdmin.from("sms_billing_operations").select("*").eq("business_id", businessId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new SmsBillingError("sms_billing_unavailable", 503);
    if (!data) return null;
    op = operationSchema.parse(data);
  }
  if (op.owner_id !== ownerId) throw new SmsBillingError("sms_billing_forbidden", 403);
  if (op.source_plan === "chat_only") throw new SmsBillingError("texting_upgrade_required");
  if (op.kind === "checkout") {
    let paymentUrl: string | undefined;
    if (op.checkout_session_id && op.state !== "expired" && op.state !== "applied") {
      const session = await stripe.checkout.sessions.retrieve(op.checkout_session_id);
      if (session.status === "expired") op = await record(op, { state: "expired" });
      else if (session.status === "complete" && typeof session.subscription === "string") {
        await synchronizeSmsBillingOperation(await stripe.subscriptions.retrieve(session.subscription));
        op = await operation(op.id, businessId);
      } else paymentUrl = checkoutUrl(session, op);
    }
    return { ...view(op), ...(paymentUrl ? { paymentUrl } : {}) };
  }
  if (op.state === "confirming" || op.state === "pending" || op.state === "scheduled") {
    const sub = await stripe.subscriptions.retrieve(op.expected_subscription_id!);
    if (op.kind === "downgrade" && terminal.has(sub.status)) {
      assertSource(sub, businessId, op.expected_customer_id!, op.expected_subscription_id!);
      await record(op, { state: "expired" });
      const { syncStripeSubscription } = await import("./subscriptionSync");
      await syncStripeSubscription(sub);
      return view(await operation(op.id, businessId));
    }
    const handled = await synchronizeSmsBillingOperation(sub);
    // Downgrades must use the usual versioned source synchronization first.
    if (!handled && op.kind === "downgrade" && planFromStripePriceId(sub.items.data[0]?.price.id) === op.target_plan) {
      const { syncStripeSubscription } = await import("./subscriptionSync");
      await syncStripeSubscription(sub);
    }
    op = await operation(op.id, businessId);
  }
  let paymentUrl: string | undefined;
  if (op.state === "pending" && op.invoice_id) {
    const invoice = await stripe.invoices.retrieve(op.invoice_id);
    if (invoice.status === "void" || invoice.status === "uncollectible") op = await record(op, { state: "expired" });
    else if (invoice.status === "open" && invoice.hosted_invoice_url?.startsWith("https://invoice.stripe.com/")) paymentUrl = invoice.hosted_invoice_url;
  }
  return { ...view(op), ...(paymentUrl ? { paymentUrl } : {}) };
}
export function view(op: SmsBillingOperation): BillingChangeView {
  return { operationId: op.id, kind: op.kind, state: op.state, targetPlan: op.target_plan,
    amountDueCents: Number(op.quote.amountDueCents ?? 0), currency: String(op.quote.currency ?? "usd"), monthlyPriceCents: Number(op.quote.monthlyPriceCents ?? SUBSCRIPTION_PLANS[op.target_plan].price * 100),
    effectiveAt: op.kind === "downgrade" ? op.source_period_end! : op.payment_effective_at ?? op.proration_at ?? op.created_at,
    renewalAt: op.source_period_end, voiceSeconds: Number(op.quote.voiceSeconds ?? 0), expiresAt: op.expires_at };
}

export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  return id(invoice.parent?.subscription_details?.subscription);
}
export async function verifiedPaidInvoice(sub: Stripe.Subscription): Promise<Stripe.Invoice | null> {
  const invoiceId = id(sub.latest_invoice);
  if (!invoiceId) return null;
  const invoice = await stripe.invoices.retrieve(invoiceId);
  assertMode(invoice.livemode);
  if (invoice.id !== invoiceId || id(invoice.customer) !== id(sub.customer) || invoiceSubscriptionId(invoice) !== sub.id)
    throw new SmsBillingError("sms_billing_invoice_source_mismatch");
  return invoice.status === "paid" && invoice.status_transitions.paid_at ? invoice : null;
}

/** Returns true when an operation owns (or deliberately withholds) this sync. */
export async function synchronizeSmsBillingOperation(input: Stripe.Subscription): Promise<boolean> {
  const operationId = input.metadata?.sms_billing_operation_id;
  if (!operationId) return false;
  const op = await operationForProvider(operationId, input.metadata.business_id);
  if (!op) return true;
  const sub = await stripe.subscriptions.retrieve(input.id);
  assertSource(sub, op.business_id, op.stripe_customer_id!, input.id);
  if (sub.metadata.sms_billing_operation_id !== op.id) return synchronizeSmsBillingOperation(sub);
  const canonical = await localSubscription(op.business_id);
  if (op.state === "applied") return canonical?.stripe_subscription_id !== sub.id;
  if (op.state === "expired") return canonical?.stripe_subscription_id !== sub.id || planFromStripePriceId(sub.items.data[0]?.price.id) !== op.source_plan;
  const item = sub.items.data[0];
  if (op.kind === "downgrade") return false;
  if (item.price.id !== op.target_price_id || sub.pending_update || sub.status !== "active") {
    // A pending upgrade keeps the old paid plan. Initial Checkout cannot write
    // an incomplete source over the existing canceled source.
    return op.kind === "checkout";
  }
  if (op.kind === "checkout") {
    if (!op.checkout_session_id) throw new SmsBillingError("sms_billing_payment_sync_required", 503);
    const session = await stripe.checkout.sessions.retrieve(op.checkout_session_id);
    if (session.status !== "complete" || !["paid", "no_payment_required"].includes(session.payment_status) || session.metadata?.sms_billing_operation_id !== op.id ||
      id(session.subscription) !== sub.id || id(session.customer) !== op.stripe_customer_id || session.client_reference_id !== op.business_id)
      throw new SmsBillingError("sms_billing_payment_sync_required", 503);
  }
  const invoice = await verifiedPaidInvoice(sub);
  if (!invoice) return true;
  if (!op.confirmed_at || invoice.created < seconds(op.confirmed_at) - 60 ||
    (op.invoice_id && op.invoice_id !== invoice.id) || invoice.currency !== "usd" ||
    !["subscription_create", "subscription_update"].includes(invoice.billing_reason ?? "")) throw new SmsBillingError("sms_billing_payment_unverified");
  const { data, error } = await supabaseAdmin.rpc("finalize_paid_sms_billing_operation", { p_operation_id: op.id,
    p_snapshot: { subscription_id: sub.id, customer_id: id(sub.customer), plan: op.target_plan, price_id: item.price.id, status: sub.status,
      period_start: iso(item.current_period_start), period_end: iso(item.current_period_end), cancel_at_period_end: sub.cancel_at_period_end },
    p_payment: { invoice_id: invoice.id, customer_id: id(invoice.customer), subscription_id: invoiceSubscriptionId(invoice),
      status: invoice.status, paid_at: iso(invoice.status_transitions.paid_at!) },
  });
  if (error) throw new SmsBillingError("sms_billing_payment_sync_required", 503);
  if (data !== true) return true;
  return true;
}

export async function finishSmsDowngrade(sub: Stripe.Subscription): Promise<void> {
  const marker = sub.metadata.sms_billing_operation_id;
  if (!marker) return;
  const op = await operation(marker);
  if (op.kind !== "downgrade" || op.state !== "scheduled" || sub.items.data[0]?.price.id !== op.target_price_id) return;
  const { error } = await supabaseAdmin.rpc("complete_sms_billing_downgrade", { p_operation_id: op.id,
    p_subscription_id: sub.id, p_period_start: iso(sub.items.data[0].current_period_start) });
  if (error) throw new SmsBillingError("sms_billing_payment_sync_required", 503);
}

export async function expireSmsCheckout(session: Stripe.Checkout.Session): Promise<boolean> {
  const marker = session.metadata?.sms_billing_operation_id;
  if (!marker) return false;
  const op = await bindSmsCheckoutSession(session);
  if (!op) return true;
  assertMode(session.livemode);
  if (op.kind !== "checkout" || session.id !== op.checkout_session_id || session.status !== "expired" ||
    session.client_reference_id !== op.business_id || id(session.customer) !== op.stripe_customer_id) throw new SmsBillingError("sms_billing_source_changed");
  await record(op, { state: "expired" });
  return true;
}

/** Signed/retrieved Checkout evidence repairs the response-before-record crash window. */
export async function bindSmsCheckoutSession(session: Stripe.Checkout.Session): Promise<SmsBillingOperation | null> {
  const marker = session.metadata?.sms_billing_operation_id;
  if (!marker) throw new SmsBillingError("sms_billing_source_changed");
  const op = await operationForProvider(marker, session.metadata?.business_id);
  if (!op) return null;
  assertMode(session.livemode);
  if (op.kind !== "checkout" || op.state === "prepared" || session.mode !== "subscription" || session.metadata?.business_id !== op.business_id ||
    session.metadata.plan !== op.target_plan || session.client_reference_id !== op.business_id || id(session.customer) !== op.stripe_customer_id ||
    (op.checkout_session_id && op.checkout_session_id !== session.id) || session.expires_at !== seconds(op.expires_at))
    throw new SmsBillingError("sms_billing_source_changed");
  return record(op, { checkout_session_id: session.id,
    ...(typeof session.subscription === "string" ? { stripe_subscription_id: session.subscription } : {}),
    ...(op.state === "confirming" ? { state: "pending" } : {}) });
}

export async function cancelSmsBillingOperation(businessId: string, ownerId: string, operationId: string): Promise<void> {
  await owner(businessId, ownerId);
  const op = await operation(operationId, businessId);
  if (op.owner_id !== ownerId) throw new SmsBillingError("sms_billing_forbidden", 403);
  if (op.source_plan === "chat_only") throw new SmsBillingError("texting_upgrade_required");
  if (op.state === "expired") return;
  if (op.state === "applied") throw new SmsBillingError("sms_billing_already_applied");
  if (op.state === "prepared") { await record(op, { state: "expired" }); return; }
  if (op.kind === "checkout" && op.checkout_session_id) {
    const session = await stripe.checkout.sessions.retrieve(op.checkout_session_id);
    if (session.status === "complete") throw new SmsBillingError("sms_billing_payment_sync_required");
    if (session.status === "open") await stripe.checkout.sessions.expire(session.id, {}, { idempotencyKey: `sms-expire:${op.id}` });
    await expireSmsCheckout(await stripe.checkout.sessions.retrieve(session.id));
    return;
  }
  const sub = await stripe.subscriptions.retrieve(op.expected_subscription_id!);
  assertSource(sub, businessId, op.expected_customer_id!, op.expected_subscription_id!);
  if (planFromStripePriceId(sub.items.data[0].price.id) !== op.source_plan) throw new SmsBillingError("sms_billing_already_applied");
  if (op.kind === "downgrade" && op.schedule_id) {
    await stripe.subscriptionSchedules.release(op.schedule_id, {}, { idempotencyKey: `sms-release:${op.id}` });
    const fresh = await stripe.subscriptions.retrieve(sub.id);
    assertSource(fresh, businessId, op.expected_customer_id!, op.expected_subscription_id!);
    if (fresh.schedule) throw new SmsBillingError("sms_billing_recovery_required");
    if (planFromStripePriceId(fresh.items.data[0].price.id) !== op.source_plan) {
      const { syncStripeSubscription } = await import("./subscriptionSync");
      await syncStripeSubscription(fresh);
      throw new SmsBillingError("sms_billing_already_applied");
    }
  } else if (op.kind === "upgrade" && op.invoice_id) {
    const invoice = await stripe.invoices.retrieve(op.invoice_id);
    if (invoice.status === "paid") throw new SmsBillingError("sms_billing_already_applied");
    if (invoice.status !== "void") await stripe.invoices.voidInvoice(invoice.id, {}, { idempotencyKey: `sms-void:${op.id}` });
    const fresh = await stripe.subscriptions.retrieve(sub.id);
    if (fresh.pending_update || planFromStripePriceId(fresh.items.data[0].price.id) !== op.source_plan) throw new SmsBillingError("sms_billing_recovery_required");
  } else throw new SmsBillingError("sms_billing_recovery_required");
  await record(op, { state: "expired" });
}
