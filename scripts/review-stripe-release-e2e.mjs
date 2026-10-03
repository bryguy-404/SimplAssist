#!/usr/bin/env node

/**
 * Real Stripe test-API contract checks for the review-texting launch.
 *
 * Required environment (never loads .env files):
 *   REVIEW_STRIPE_E2E=1
 *   STRIPE_SECRET_KEY=sk_test_...
 *   REVIEW_STRIPE_E2E_SUPABASE_URL=http://127.0.0.1:56321
 *   REVIEW_STRIPE_E2E_SERVICE_ROLE_KEY=<disposable local stack key>
 * Optional: REVIEW_STRIPE_E2E_REPORT=/private/tmp/review-stripe-report.json
 * Run: node scripts/review-stripe-release-e2e.mjs
 *
 * This verifies actual provider amounts, pending updates, invoice lines,
 * idempotency, renewal and schedules. It does NOT run application routes,
 * hosted Checkout completion, webhook processing, or database entitlement
 * synchronization. Local Supabase is a read-only isolation/schema preflight.
 * Activation Checkout creation/expiration and the refundable payment are
 * separate checks; a PaymentIntent is not claimed to complete Checkout.
 * No Telnyx or email API is imported. Every provider resource is disposable.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";

const API_VERSION = "2026-02-25.clover";
const BASE_CENTS = 1500;
const ADDON_CENTS = 2000;
const ACTIVATION_CENTS = 4900;
const POLL_TIMEOUT_MS = 180_000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const objectId = (value) => typeof value === "string" ? value : value?.id;

export function validateConfiguration(environment) {
  assert.equal(environment.REVIEW_STRIPE_E2E, "1", "Set REVIEW_STRIPE_E2E=1 to authorize disposable Stripe test resources");
  const key = environment.STRIPE_SECRET_KEY;
  assert(typeof key === "string" && /^sk_test_[A-Za-z0-9]+$/.test(key), "Only an unpadded sk_test_ Stripe key is accepted");
  const localUrl = new URL(environment.REVIEW_STRIPE_E2E_SUPABASE_URL ?? "");
  assert(["127.0.0.1", "localhost", "[::1]"].includes(localUrl.hostname), "Supabase must use a literal loopback host");
  assert.equal(localUrl.protocol, "http:", "Use the disposable local Supabase HTTP endpoint");
  assert(localUrl.port && localUrl.port !== "80", "Use an explicit local Supabase development port");
  assert(!localUrl.username && !localUrl.password && !localUrl.search && !localUrl.hash && localUrl.pathname === "/", "Supabase URL must contain only its loopback origin");
  const localKey = environment.REVIEW_STRIPE_E2E_SERVICE_ROLE_KEY;
  assert(typeof localKey === "string" && localKey.trim(), "A disposable local Supabase service-role key is required");
  return { key, localUrl: localUrl.origin, localKey };
}

export function assertTestObject(value, label = "Stripe response") {
  assert(value && typeof value === "object", `${label} is not an object`);
  assert.equal(value.livemode, false, `${label} did not prove test mode`);
  return value;
}

export function assertOwnedObject(value, runId) {
  assertTestObject(value);
  assert.equal(value.metadata?.review_stripe_e2e_run, runId, "Refusing to mutate a Stripe object not owned by this test run");
  return value;
}

async function poll(label, read, timeout = POLL_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await wait(2000);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function runHarness(environment = process.env) {
  const config = validateConfiguration(environment);
  const runId = randomUUID();
  const metadata = { review_stripe_e2e_run: runId, business_id: randomUUID() };
  const reportPath = environment.REVIEW_STRIPE_E2E_REPORT ?? path.join(os.tmpdir(), `review-stripe-release-${runId}.json`);
  const stripe = new Stripe(config.key, { apiVersion: API_VERSION, maxNetworkRetries: 2, timeout: 20_000 });
  const resources = { products: [], prices: [], customers: [], subscriptions: [], clocks: [], checkouts: [], paymentMethods: [], paymentIntents: [], refunds: [], schedules: [] };
  const report = {
    runId, apiVersion: API_VERSION, startedAt: new Date().toISOString(), status: "running", checks: [],
    coverage: "Stripe test-API contracts only; not application routes, hosted Checkout completion, webhooks, or DB entitlement sync",
    resources, cleanupErrors: [],
  };
  let verified = false;
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  const keyFor = (label) => `review-release-e2e:${runId}:${label}`;
  const logCheck = async (name, evidence = {}) => {
    report.checks.push({ name, passed: true, ...evidence });
    console.log(`PASS: ${name}`);
    await save();
  };
  const mutate = async (label, operation, collection, checkResult = assertTestObject) => {
    assert.equal(validateConfiguration(environment).key, config.key, "Test key changed during execution");
    assert(verified, "Read-only test-mode sentinel must pass before any mutation");
    report.currentOperation = label;
    const result = await operation({ idempotencyKey: keyFor(label) });
    if (collection && result?.id && !resources[collection].includes(result.id)) {
      resources[collection].push(result.id);
      await save();
    }
    return checkResult(result, label);
  };
  const retrieveSubscription = async (id) => assertOwnedObject(await stripe.subscriptions.retrieve(id), runId);
  const retrieveInvoice = async (id, customerId, subscriptionId) => {
    const invoice = assertTestObject(await stripe.invoices.retrieve(id), "invoice");
    assert.equal(objectId(invoice.customer), customerId);
    assert.equal(objectId(invoice.parent?.subscription_details?.subscription), subscriptionId);
    assert.equal(invoice.currency, "usd");
    assert.equal(invoice.lines.has_more, false, "Invoice line pagination was not expected for this small fixture");
    return invoice;
  };
  const advanceClock = async (clockId, frozenTime) => {
    const previous = assertTestObject(await stripe.testHelpers.testClocks.retrieve(clockId));
    assert.equal(previous.name, `Review release ${runId}`);
    assert.equal(previous.status, "ready");
    await mutate(`advance:${clockId}:${frozenTime}`, (options) => stripe.testHelpers.testClocks.advance(clockId, { frozen_time: frozenTime }, options));
    await poll("Stripe test clock readiness", async () => {
      const current = assertTestObject(await stripe.testHelpers.testClocks.retrieve(clockId));
      assert.notEqual(current.status, "internal_failure");
      return current.status === "ready" && current.frozen_time === frozenTime;
    });
  };
  const paymentMethod = async (customerId, label, token = "tok_visa") => {
    const method = await mutate(`payment-method:${label}`, (options) => stripe.paymentMethods.create({ type: "card", card: { token }, metadata }, options), "paymentMethods");
    await mutate(`attach:${label}`, (options) => stripe.paymentMethods.attach(method.id, { customer: customerId }, options));
    return method.id;
  };
  const makeCustomer = (label, clockId) => mutate(`customer:${label}`, (options) => stripe.customers.create({
    email: `review-stripe-e2e+${runId}-${label}@example.invalid`, metadata, ...(clockId ? { test_clock: clockId } : {}),
  }, options), "customers");
  const createBase = async (label, basePrice) => {
    const frozen = Math.floor(Date.now() / 1000);
    const clock = await mutate(`clock:${label}`, (options) => stripe.testHelpers.testClocks.create({ frozen_time: frozen, name: `Review release ${runId}` }, options), "clocks");
    const customer = await makeCustomer(label, clock.id);
    const visa = await paymentMethod(customer.id, label);
    const subscription = await mutate(`subscription:${label}`, (options) => stripe.subscriptions.create({
      customer: customer.id, default_payment_method: visa, items: [{ price: basePrice, quantity: 1 }],
      payment_behavior: "error_if_incomplete", metadata,
    }, options), "subscriptions");
    assert.equal(subscription.status, "active");
    const invoice = await retrieveInvoice(objectId(subscription.latest_invoice), customer.id, subscription.id);
    assert.equal(invoice.status, "paid");
    assert.equal(invoice.amount_paid, BASE_CENTS);
    return { clock, customer, visa, subscription };
  };
  const paidRenewal = async (fixture, periodEnd, previousInvoiceId) => {
    // Test clocks can first produce a draft invoice. Advance through its
    // separate finalization time; wall-clock polling cannot unfreeze it.
    await advanceClock(fixture.clock.id, periodEnd + 60);
    const boundary = await poll("renewal invoice creation", async () => {
      const subscription = await retrieveSubscription(fixture.subscription.id);
      if (objectId(subscription.latest_invoice) === previousInvoiceId) return null;
      const invoice = await retrieveInvoice(objectId(subscription.latest_invoice), fixture.customer.id, subscription.id);
      return { subscription, invoice };
    });
    if (boundary.invoice.status !== "paid") await advanceClock(fixture.clock.id, periodEnd + 2 * 3600);
    return poll("renewal invoice payment", async () => {
      const subscription = await retrieveSubscription(fixture.subscription.id);
      const invoice = await retrieveInvoice(objectId(subscription.latest_invoice), fixture.customer.id, subscription.id);
      return invoice.id !== previousInvoiceId && invoice.status === "paid" ? { subscription, invoice } : null;
    });
  };

  await save();
  try {
    console.log(`Review Stripe test-API run ${runId}`);
    for (const table of ["review_sms_accounts", "review_sms_billing_operations", "review_email_control"]) {
      const response = await fetch(`${config.localUrl}/rest/v1/${table}?select=*&limit=0`, {
        headers: { apikey: config.localKey, authorization: `Bearer ${config.localKey}` }, redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      assert.equal(response.status, 200, `Local review schema preflight failed for ${table}`);
    }
    assertTestObject(await stripe.balance.retrieve(), "Read-only Stripe balance sentinel");
    verified = true;
    await logCheck("Local schema isolation and Stripe test-mode guards");

    const product = await mutate("product", (options) => stripe.products.create({ name: `Review release E2E ${runId}`, metadata }, options), "products");
    const price = async (label, amount, recurring) => mutate(`price:${label}`, (options) => stripe.prices.create({
      product: product.id, currency: "usd", unit_amount: amount, metadata,
      ...(recurring ? { recurring: { interval: "month", usage_type: "licensed" } } : {}),
    }, options), "prices");
    const base = await price("chat", BASE_CENTS, true);
    const addon = await price("review-sms", ADDON_CENTS, true);
    const activation = await price("activation", ACTIVATION_CENTS, false);

    // Checkout cannot be completed by the server API. A separate test payment
    // exercises the refund contract without claiming a hosted Checkout E2E.
    const activationCustomer = await makeCustomer("activation");
    const activationCard = await paymentMethod(activationCustomer.id, "activation");
    const checkoutParameters = {
      mode: "payment", customer: activationCustomer.id, client_reference_id: metadata.business_id,
      line_items: [{ price: activation.id, quantity: 1 }], payment_method_types: ["card"],
      metadata: { ...metadata, review_sms_operation_id: randomUUID() },
      expires_at: Math.floor(Date.now() / 1000) + 23 * 3600,
      success_url: "http://127.0.0.1:56321/review-test-success", cancel_url: "http://127.0.0.1:56321/review-test-cancel",
    };
    const checkout = await mutate("activation-checkout", (options) => stripe.checkout.sessions.create(checkoutParameters, options), "checkouts");
    const replay = await mutate("activation-checkout", (options) => stripe.checkout.sessions.create(checkoutParameters, options), "checkouts");
    assert.equal(replay.id, checkout.id);
    assert.equal(checkout.amount_total, ACTIVATION_CENTS);
    assert.equal(checkout.currency, "usd");
    assert.equal(checkout.mode, "payment");
    assert.equal(checkout.client_reference_id, metadata.business_id);
    assert.equal(objectId(checkout.customer), activationCustomer.id);
    await mutate("expire-activation-checkout", (options) => stripe.checkout.sessions.expire(checkout.id, {}, options));
    await logCheck("$49 activation Checkout amount, binding, idempotency, and expiration");

    const payment = await mutate("activation-payment", (options) => stripe.paymentIntents.create({
      amount: ACTIVATION_CENTS, currency: "usd", customer: activationCustomer.id, payment_method: activationCard,
      payment_method_types: ["card"], confirm: true, off_session: true, metadata,
    }, options), "paymentIntents");
    assert.equal(payment.status, "succeeded");
    assert.equal(payment.amount_received, ACTIVATION_CENTS);
    const refundParams = { payment_intent: payment.id, amount: ACTIVATION_CENTS, metadata };
    // Refunds lack a livemode field; bind them to this run's verified test PI.
    const checkRefund = (value) => {
      assert.equal(value.object, "refund");
      assert.equal(objectId(value.payment_intent), payment.id);
      assert.equal(value.metadata?.review_stripe_e2e_run, runId);
      assert.equal(value.currency, "usd");
      return value;
    };
    const refund = await mutate("activation-refund", (options) => stripe.refunds.create(refundParams, options), "refunds", checkRefund);
    const refundReplay = await mutate("activation-refund", (options) => stripe.refunds.create(refundParams, options), "refunds", checkRefund);
    assert.equal(refundReplay.id, refund.id);
    assert.equal(refund.status, "succeeded");
    assert.equal(refund.amount, ACTIVATION_CENTS);
    await logCheck("$49 test activation payment and exactly-once full refund before provider work");

    const fixture = await createBase("renewal", base.id);
    await logCheck("$15 Chat base subscription paid without a setup charge");
    const originalItem = fixture.subscription.items.data[0];
    const midpoint = Math.floor((originalItem.current_period_start + originalItem.current_period_end) / 2);
    await advanceClock(fixture.clock.id, midpoint);
    const change = {
      items: [{ price: addon.id, quantity: 1 }], payment_behavior: "pending_if_incomplete",
      proration_behavior: "always_invoice", proration_date: midpoint, billing_cycle_anchor: "unchanged",
      metadata: { review_sms_operation_id: randomUUID() },
    };
    const preview = assertTestObject(await stripe.invoices.createPreview({
      customer: fixture.customer.id, subscription: fixture.subscription.id,
      subscription_details: { items: change.items, proration_date: midpoint, proration_behavior: "always_invoice", billing_cycle_anchor: "unchanged" },
    }), "Prorated invoice preview");
    assert(preview.amount_due > 0 && preview.amount_due < ADDON_CENTS, "Expected only a partial-period add-on charge");
    const updated = await mutate("prorated-addon", (options) => stripe.subscriptions.update(fixture.subscription.id, change, options));
    const duplicate = await mutate("prorated-addon", (options) => stripe.subscriptions.update(fixture.subscription.id, change, options));
    assert.equal(objectId(duplicate.latest_invoice), objectId(updated.latest_invoice));
    assert.equal(updated.pending_update, null);
    assert.equal(updated.items.data.length, 2);
    assert.equal(updated.billing_cycle_anchor, fixture.subscription.billing_cycle_anchor);
    const paid = await retrieveInvoice(objectId(updated.latest_invoice), fixture.customer.id, updated.id);
    assert.equal(paid.status, "paid");
    assert.equal(paid.amount_due, preview.amount_due);
    assert.equal(paid.amount_paid, preview.amount_due);
    const addonItem = updated.items.data.find((item) => item.price.id === addon.id);
    const addonLine = paid.lines.data.find((line) => line.parent?.subscription_item_details?.subscription_item === addonItem?.id);
    assert(addonLine, "Missing exact add-on subscription item invoice line");
    assert.equal(addonLine.pricing?.price_details?.price, addon.id);
    assert.equal(addonLine.parent.subscription_item_details.proration, true);
    assert.equal(addonLine.period.start, midpoint);
    assert.equal(addonLine.period.end, originalItem.current_period_end);
    const parts = Math.floor(250 * (originalItem.current_period_end - midpoint) / (originalItem.current_period_end - originalItem.current_period_start));
    assert.equal(parts, 125);
    await logCheck("Prorated $20 add-on quote matches paid invoice; base and anchor preserved; duplicate update charges once", { proratedCents: paid.amount_paid, expectedProratedParts: parts });

    const failure = await createBase("decline", base.id);
    // A generic decline token also fails attachment. This documented fixture
    // attaches successfully and declines only when billing attempts a charge.
    const declineCard = await paymentMethod(failure.customer.id, "decline-charge", "tok_chargeCustomerFail");
    await mutate("use-decline-card", (options) => stripe.subscriptions.update(failure.subscription.id, { default_payment_method: declineCard }, options));
    const pending = await mutate("declined-addon", (options) => stripe.subscriptions.update(failure.subscription.id, {
      items: [{ price: addon.id, quantity: 1 }], payment_behavior: "pending_if_incomplete", proration_behavior: "always_invoice",
      billing_cycle_anchor: "unchanged", metadata: { review_sms_operation_id: randomUUID() },
    }, options));
    assert(pending.pending_update, "Declined payment must leave a pending update");
    assert.equal(pending.items.data.length, 1, "Failed add-on payment must retain only the paid base item");
    const failedInvoice = await retrieveInvoice(objectId(pending.latest_invoice), failure.customer.id, pending.id);
    assert.equal(failedInvoice.status, "open");
    assert.equal(failedInvoice.amount_paid, 0);
    await mutate("restore-working-card", (options) => stripe.subscriptions.update(pending.id, { default_payment_method: failure.visa }, options));
    await mutate("pay-failed-addon", (options) => stripe.invoices.pay(failedInvoice.id, { payment_method: failure.visa }, options));
    const recovered = await retrieveSubscription(pending.id);
    assert.equal(recovered.pending_update, null);
    assert.equal(recovered.items.data.length, 2);
    assert.equal(recovered.status, "active");
    await logCheck("Declined add-on payment retains base only; paying exact failed invoice activates the second item");

    const renewed = await paidRenewal(fixture, originalItem.current_period_end, paid.id);
    assert.equal(renewed.invoice.amount_paid, BASE_CENTS + ADDON_CENTS);
    const renewalLine = renewed.invoice.lines.data.find((line) => line.pricing?.price_details?.price === addon.id);
    assert.equal(renewalLine?.amount, ADDON_CENTS);
    assert.equal(renewalLine?.parent?.subscription_item_details?.proration, false);
    assert.equal(renewed.subscription.items.data.length, 2);
    await logCheck("Renewal bills $35 total with a non-prorated $20 add-on line", { expectedFullPeriodParts: 250 });

    const schedule = await mutate("cancel-schedule", (options) => stripe.subscriptionSchedules.create({ from_subscription: fixture.subscription.id }, options), "schedules");
    const phase = schedule.phases[0];
    assert.equal(phase.items.length, 2);
    const phaseMetadata = { ...renewed.subscription.metadata, ...phase.metadata };
    const phaseItems = phase.items.map((item) => ({ price: objectId(item.price), quantity: 1 }));
    const cancelParameters = {
      end_behavior: "release", proration_behavior: "none", metadata,
      phases: [
        { items: phaseItems, start_date: phase.start_date, end_date: phase.end_date, proration_behavior: "none", metadata: phaseMetadata },
        { items: phaseItems.filter((item) => item.price === base.id), start_date: phase.end_date, duration: { interval: "month", interval_count: 1 }, proration_behavior: "none", metadata: phaseMetadata },
      ],
    };
    await mutate("cancel-schedule-phases", (options) => stripe.subscriptionSchedules.update(schedule.id, cancelParameters, options));
    const beforeEnd = await retrieveSubscription(fixture.subscription.id);
    assert.equal(beforeEnd.items.data.length, 2, "Cancellation must preserve paid add-on through the term");
    assert.equal(objectId(beforeEnd.latest_invoice), renewed.invoice.id, "Scheduling cancellation must not bill immediately");
    const cancelled = await paidRenewal(fixture, phase.end_date, renewed.invoice.id);
    assert.equal(cancelled.subscription.items.data.length, 1);
    assert.equal(cancelled.subscription.items.data[0].price.id, base.id);
    assert.equal(cancelled.subscription.status, "active");
    assert.equal(cancelled.invoice.amount_paid, BASE_CENTS);
    assert(!cancelled.invoice.lines.data.some((line) => line.pricing?.price_details?.price === addon.id));
    await logCheck("Period-end cancellation removes only review texting; next Chat renewal is $15");
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.failedOperation = report.currentOperation;
    // Do not persist SDK request/response objects or keys in release evidence.
    report.error = String(error?.message ?? error).replace(/(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+/g, "[redacted Stripe key]");
    console.error(`FAIL: ${report.error}`);
  } finally {
    if (verified) {
      const cleanup = async (label, operation) => {
        try { await operation(); } catch (error) { report.cleanupErrors.push({ label, code: error?.code ?? error?.type ?? "cleanup_failed" }); }
      };
      for (const id of resources.checkouts) await cleanup(`checkout:${id}`, async () => {
        const session = assertOwnedObject(await stripe.checkout.sessions.retrieve(id), runId);
        if (session.status === "open") await mutate(`cleanup-checkout:${id}`, (options) => stripe.checkout.sessions.expire(id, {}, options));
      });
      for (const id of resources.subscriptions) await cleanup(`subscription:${id}`, async () => {
        const subscription = await retrieveSubscription(id);
        if (subscription.status !== "canceled") await mutate(`cleanup-subscription:${id}`, (options) => stripe.subscriptions.cancel(id, { invoice_now: false, prorate: false }, options));
      });
      for (const id of resources.customers) await cleanup(`customer:${id}`, async () => {
        assertOwnedObject(await stripe.customers.retrieve(id), runId);
        assert.equal(validateConfiguration(environment).key, config.key);
        await stripe.customers.del(id);
      });
      for (const id of resources.clocks) await cleanup(`clock:${id}`, async () => {
        const clock = assertTestObject(await stripe.testHelpers.testClocks.retrieve(id));
        assert.equal(clock.name, `Review release ${runId}`);
        assert.equal(validateConfiguration(environment).key, config.key);
        await stripe.testHelpers.testClocks.del(id);
      });
      for (const id of resources.prices) await cleanup(`price:${id}`, async () => {
        assertOwnedObject(await stripe.prices.retrieve(id), runId);
        await mutate(`cleanup-price:${id}`, (options) => stripe.prices.update(id, { active: false }, options));
      });
      for (const id of resources.products) await cleanup(`product:${id}`, async () => {
        assertOwnedObject(await stripe.products.retrieve(id), runId);
        await mutate(`cleanup-product:${id}`, (options) => stripe.products.update(id, { active: false }, options));
      });
    }
    if (report.cleanupErrors.length) report.status = "failed";
    report.finishedAt = new Date().toISOString();
    await save();
    console.log(`Report: ${reportPath}`);
    console.log(`Result: ${report.status}; ${report.checks.length} checks; ${report.cleanupErrors.length} cleanup failures`);
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHarness().then((report) => { if (report.status !== "passed") process.exitCode = 1; }).catch((error) => {
    console.error(`Refusing to run: ${error.message}`);
    process.exitCode = 1;
  });
}
