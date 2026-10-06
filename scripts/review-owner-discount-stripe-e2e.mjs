#!/usr/bin/env node
/** Opt-in owner-discount Stripe TEST contracts. No .env files, live API,
 * Telnyx, messages, or production databases. Local Supabase is read-only here.
 * Uses the existing REVIEW_STRIPE_E2E configuration; records exact provider
 * evidence and cleans up only this run's own disposable TEST resources.
 * This suite does not claim hosted payment completion or application access. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";
import { validateConfiguration, assertTestObject } from "./review-stripe-release-e2e.mjs";

const id = (value) => typeof value === "string" ? value : value?.id;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runOwnerDiscountContracts(environment = process.env) {
  const config = validateConfiguration(environment);
  const run = randomUUID(), metadata = { review_owner_discount_e2e_run: run };
  const stripe = new Stripe(config.key, { apiVersion: "2026-02-25.clover", maxNetworkRetries: 2, timeout: 20_000 });
  const reportPath = environment.REVIEW_STRIPE_E2E_REPORT ?? "/private/tmp/review-owner-discount-stripe-e2e.json";
  const owned = { products: [], prices: [], coupons: [], customers: [], clocks: [], subscriptions: [], schedules: [], checkouts: [] };
  const report = { run, status: "running", checks: [], cleanupErrors: [], resources: owned,
    coverage: "Real Stripe TEST provider contracts only; no hosted Checkout completion, application reconciliation, real carrier approval or customer messages." };
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  const pass = async (name, evidence = {}) => { report.checks.push({ name, ...evidence }); console.log(`PASS: ${name}`); await save(); };
  const opts = (label) => ({ idempotencyKey: `review-owner-discount:${run}:${label}` });
  const own = async (collection, operation) => { const obj = assertTestObject(await operation); owned[collection].push(obj.id); await save(); return obj; };
  const checkOwned = (obj) => { assertTestObject(obj); assert.equal(obj.metadata?.review_owner_discount_e2e_run, run); return obj; };
  const poll = async (label, fn) => { const end = Date.now() + 120_000; while (Date.now() < end) { const result = await fn(); if (result) return result; await sleep(1000); } throw Error(`Timed out: ${label}`); };
  const advance = async (clockId, time) => {
    const clock = assertTestObject(await stripe.testHelpers.testClocks.retrieve(clockId));
    assert.equal(clock.name, `Owner discount ${run}`); assert.equal(clock.status, "ready");
    await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: time }, opts(`advance:${time}`));
    await poll("clock readiness", async () => (await stripe.testHelpers.testClocks.retrieve(clockId)).status === "ready");
  };
  let verified = false;
  try {
    await save();
    assertTestObject(await stripe.balance.retrieve());
    const local = await fetch(`${config.localUrl}/rest/v1/businesses?select=id&limit=1`, {
      headers: { apikey: config.localKey, authorization: `Bearer ${config.localKey}` }, redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    assert.equal(local.status, 200); assert.deepEqual(await local.json(), [], "Disposable review DB must be empty");
    verified = true;
    await pass("TEST-only Stripe sentinel and empty local database preflight");
    const product = async (name) => own("products", stripe.products.create({ name: `Owner discount ${name} ${run}`, metadata }, opts(`product:${name}`)));
    const chatProduct = await product("chat"), addonProduct = await product("reviews"), activationProduct = await product("activation"), usageProduct = await product("usage");
    const price = (name, productId, cents, recurring = true) => own("prices", stripe.prices.create({ product: productId, unit_amount: cents, currency: "usd", metadata,
      ...(recurring ? { recurring: { interval: "month" } } : {}) }, opts(`price:${name}`)));
    const chat = await price("chat", chatProduct.id, 1500), addon = await price("reviews", addonProduct.id, 2000), activation = await price("activation", activationProduct.id, 2500, false);
    await price("usage", usageProduct.id, 2, false);
    const coupon = await own("coupons", stripe.coupons.create({ duration: "forever", percent_off: 100, max_redemptions: 1,
      applies_to: { products: [chatProduct.id, addonProduct.id] }, name: `Owner test ${run.slice(0, 8)}`, metadata }, opts("coupon")));
    const now = Math.floor(Date.now() / 1000), clock = await own("clocks", stripe.testHelpers.testClocks.create({ name: `Owner discount ${run}`, frozen_time: now - 15 * 86400 }, opts("clock")));
    const customer = await own("customers", stripe.customers.create({ email: `owner-review-${run}@example.invalid`, test_clock: clock.id, metadata }, opts("customer")));
    const paymentMethod = assertTestObject(await stripe.paymentMethods.create({ type: "card", card: { token: "tok_chargeCustomerFail" }, metadata }, opts("payment-method")));
    await stripe.paymentMethods.attach(paymentMethod.id, { customer: customer.id }, opts("attach"));
    const sub = await own("subscriptions", stripe.subscriptions.create({ customer: customer.id, items: [{ price: chat.id }], default_payment_method: paymentMethod.id,
      discounts: [{ coupon: coupon.id }], payment_behavior: "error_if_incomplete", metadata }, opts("subscription")));
    assert.equal(sub.status, "active");
    const initialInvoice = assertTestObject(await stripe.invoices.retrieve(id(sub.latest_invoice)));
    assert.equal(initialInvoice.status, "paid"); assert.equal(initialInvoice.amount_due, 0); assert.equal(initialInvoice.amount_paid, 0);
    const originalEnd = sub.items.data[0].current_period_end;
    const expanded = assertTestObject(await stripe.subscriptions.retrieve(sub.id, { expand: ["discounts.source.coupon"] }));
    assert.equal(expanded.discounts.length, 1);
    const discount = expanded.discounts[0];
    assert.equal(typeof discount, "object"); assert.equal(discount.subscription, sub.id); assert.equal(id(discount.customer), customer.id);
    assert.equal(discount.end, null); assert.equal(discount.source.type, "coupon"); assert.equal(id(discount.source.coupon), coupon.id);
    const redeemed = assertTestObject(await stripe.coupons.retrieve(coupon.id, { expand: ["applies_to"] }));
    assert.equal(redeemed.valid, false); assert.equal(redeemed.times_redeemed, 1);
    assert.deepEqual([...redeemed.applies_to.products].sort(), [chatProduct.id, addonProduct.id].sort());
    assert.equal(redeemed.percent_off, 100); assert.equal(redeemed.duration, "forever");
    await pass("Exhausted max-one coupon remains attached forever; expanded product scope excludes activation and usage", {
      couponValidForNewRedemption: redeemed.valid, discountCheckoutSession: discount.checkout_session,
    });
    const checkoutArgs = { mode: "payment", customer: customer.id, client_reference_id: run, line_items: [{ price: activation.id, quantity: 1 }],
      metadata, success_url: "http://127.0.0.1:56321/owner-test-success", cancel_url: "http://127.0.0.1:56321/owner-test-cancel" };
    const checkout = await own("checkouts", stripe.checkout.sessions.create(checkoutArgs, opts("activation-checkout")));
    const retry = await stripe.checkout.sessions.create(checkoutArgs, opts("activation-checkout"));
    assert.equal(retry.id, checkout.id); assert.equal(checkout.amount_total, 2500); assert.equal(checkout.payment_status, "unpaid");
    await stripe.checkout.sessions.expire(checkout.id, {}, opts("expire-checkout"));
    await pass("Separate activation Checkout remains exactly $25 and idempotent despite the subscription discount");
    await advance(clock.id, now);
    const operation = randomUUID();
    const preview = assertTestObject(await stripe.invoices.createPreview({ customer: customer.id, subscription: sub.id,
      subscription_details: { items: [{ price: addon.id, quantity: 1 }], proration_behavior: "always_invoice", proration_date: now, billing_cycle_anchor: "unchanged" } }));
    assert.equal(preview.amount_due, 0);
    const change = { items: [{ price: addon.id, quantity: 1 }], payment_behavior: "pending_if_incomplete", proration_behavior: "always_invoice", proration_date: now,
      billing_cycle_anchor: "unchanged", metadata: { review_sms_operation_id: operation } };
    const updated = assertTestObject(await stripe.subscriptions.update(sub.id, change, opts("add-review-item")));
    const retried = await stripe.subscriptions.update(sub.id, change, opts("add-review-item"));
    assert.equal(id(retried.latest_invoice), id(updated.latest_invoice)); assert.equal(updated.pending_update, null); assert.equal(updated.items.data.length, 2);
    assert(updated.items.data.every(item => item.current_period_end === originalEnd));
    assert.notEqual(id(updated.latest_invoice), initialInvoice.id);
    const invoice = assertTestObject(await stripe.invoices.retrieve(id(updated.latest_invoice)));
    assert.equal(invoice.status, "paid"); assert.equal(invoice.amount_due, 0); assert.equal(invoice.amount_paid, 0); assert(invoice.status_transitions.paid_at);
    assert.equal(id(invoice.parent?.subscription_details?.subscription), sub.id); assert.equal(id(invoice.customer), customer.id);
    assert.equal(invoice.parent.subscription_details.metadata.review_sms_operation_id, operation);
    const reviewItem = updated.items.data.find(item => item.price.id === addon.id);
    const line = invoice.lines.data.find(line => line.parent?.subscription_item_details?.subscription_item === reviewItem.id);
    assert(line); assert.equal(line.pricing.price_details.price, addon.id); assert.equal(line.period.start, now); assert.equal(line.period.end, originalEnd);
    assert.equal(line.parent.subscription_item_details.proration, true); assert.equal(line.quantity, 1); assert.equal(line.amount, 0);
    const payments = await stripe.invoicePayments.list({ invoice: invoice.id });
    await pass("100% discounted pending update completes at $0 with one exact new paid invoice, proration line and operation metadata; retries create no second item", {
      invoiceId: invoice.id, operation, invoiceAmountDue: invoice.amount_due, invoiceAmountPaid: invoice.amount_paid,
      lineAmount: line.amount, discountAmounts: line.discount_amounts, paidAtPresent: Boolean(invoice.status_transitions.paid_at), paymentRecords: payments.data.length,
    });
    const paidEvent = await poll("real zero-dollar paid event", async () => {
      const events = await stripe.events.list({ types: ["invoice.payment_succeeded"], limit: 100 });
      return events.data.find(event => event.data.object.id === invoice.id) ?? null;
    });
    assertTestObject(paidEvent); assert.equal(paidEvent.type, "invoice.payment_succeeded");
    await pass("Stripe emits the actual invoice.payment_succeeded event for the exact zero-dollar invoice");
    await advance(clock.id, originalEnd + 2 * 3600);
    const renewed = await poll("paid renewal", async () => {
      const current = await stripe.subscriptions.retrieve(sub.id);
      const inv = await stripe.invoices.retrieve(id(current.latest_invoice));
      return inv.id !== invoice.id && inv.status === "paid" ? { current, inv } : null;
    });
    assert.equal(renewed.inv.amount_due, 0); assert.equal(renewed.inv.amount_paid, 0);
    const renewalLine = renewed.inv.lines.data.find(line => line.pricing?.price_details?.price === addon.id);
    assert(renewalLine); assert.equal(renewalLine.amount, 2000); assert.equal(renewalLine.parent.subscription_item_details.proration, false);
    assert.equal(renewalLine.discount_amounts.reduce((total, discount) => total + discount.amount, 0), 2000);
    await pass("Renewal remains $0 while the undiscounted review line is $20 with a matching $20 discount", { renewalAmountDue: renewed.inv.amount_due, reviewLineAmount: renewalLine.amount, reviewDiscountAmounts: renewalLine.discount_amounts });
    const schedule = await own("schedules", stripe.subscriptionSchedules.create({ from_subscription: sub.id }, opts("schedule")));
    const phase = schedule.phases[0]; assert.equal(phase.discounts.length, 1); assert.equal(id(phase.discounts[0].coupon), coupon.id);
    const phaseDiscounts = [{ discount: discount.id }];
    const newSchedule = await stripe.subscriptionSchedules.update(schedule.id, { end_behavior: "release", proration_behavior: "none", metadata,
      phases: [{ start_date: phase.start_date, end_date: phase.end_date, items: [{ price: chat.id, quantity: 1 }, { price: addon.id, quantity: 1 }], discounts: phaseDiscounts, proration_behavior: "none" },
        { start_date: phase.end_date, duration: { interval: "month", interval_count: 1 }, items: [{ price: chat.id, quantity: 1 }], discounts: phaseDiscounts, proration_behavior: "none" }] }, opts("cancel-addon-phases"));
    assert(newSchedule.phases.every(p => p.discounts.length === 1 && id(p.discounts[0].discount) === discount.id));
    await advance(clock.id, phase.end_date + 2 * 3600);
    const canceledAddon = await poll("scheduled removal", async () => {
      const current = await stripe.subscriptions.retrieve(sub.id);
      if (current.items.data.length !== 1) return null;
      const inv = await stripe.invoices.retrieve(id(current.latest_invoice));
      return inv.id !== renewed.inv.id && inv.status === "paid" ? { current, inv } : null;
    });
    assert.equal(canceledAddon.current.items.data[0].price.id, chat.id); assert.equal(canceledAddon.inv.amount_due, 0); assert.equal(canceledAddon.inv.amount_paid, 0);
    assert.equal(canceledAddon.inv.lines.data.length, 1); assert.equal(canceledAddon.inv.lines.data[0].amount, 1500);
    assert.equal(canceledAddon.inv.lines.data[0].discount_amounts.reduce((total, discount) => total + discount.amount, 0), 1500);
    await pass("Both cancellation schedule phases preserve the applied discount ID; removing review texting keeps Chat at $0");
    report.status = "passed";
  } catch (error) {
    report.status = "failed"; report.error = error instanceof Error ? error.message : "Unknown contract failure"; await save(); throw error;
  } finally {
    const cleanup = async (label, operation) => { try { await operation(); } catch (error) { report.cleanupErrors.push(`${label}: ${error instanceof Error ? error.message : "failed"}`); } };
    if (verified) {
      for (const value of owned.checkouts) await cleanup("Checkout", async () => { const obj = checkOwned(await stripe.checkout.sessions.retrieve(value)); if (obj.status === "open") await stripe.checkout.sessions.expire(value); });
      for (const value of owned.subscriptions) await cleanup("subscription", async () => { const obj = checkOwned(await stripe.subscriptions.retrieve(value)); if (obj.status !== "canceled") await stripe.subscriptions.cancel(value); });
      for (const value of owned.clocks) await cleanup("clock", async () => { const obj = assertTestObject(await stripe.testHelpers.testClocks.retrieve(value)); assert.equal(obj.name, `Owner discount ${run}`); await stripe.testHelpers.testClocks.del(value); });
      for (const value of owned.coupons) await cleanup("coupon", async () => { checkOwned(await stripe.coupons.retrieve(value)); await stripe.coupons.del(value); });
      for (const value of owned.prices) await cleanup("price", async () => { checkOwned(await stripe.prices.retrieve(value)); await stripe.prices.update(value, { active: false }); });
      for (const value of owned.products) await cleanup("product", async () => { checkOwned(await stripe.products.retrieve(value)); await stripe.products.update(value, { active: false }); });
    }
    if (report.cleanupErrors.length) report.status = "failed";
    await save(); console.log(`Owner discount contracts: ${report.status}; ${report.checks.length} checks; ${report.cleanupErrors.length} cleanup failures. Report: ${reportPath}`);
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runOwnerDiscountContracts().then(report => { if (report.status !== "passed") process.exitCode = 1; }).catch(error => { console.error(`Owner discount TEST failure: ${error.message}`); process.exitCode = 1; });
}
