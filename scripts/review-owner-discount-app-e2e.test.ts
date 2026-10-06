/** Opt-in actual owner-discount billing functions against Stripe TEST and the
 * empty disposable SimplAssistReviews local database (56321/56322). Carrier
 * readiness and activation receipt are explicit LOCAL fixtures, not evidence
 * of live approval or payment. No Telnyx, email, or SMS is sent.
 * Run REVIEW_OWNER_DISCOUNT_APP_E2E=1 with the standard REVIEW_STRIPE_E2E vars.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { describe, it, vi } from "vitest";
import { validateConfiguration, assertTestObject } from "./review-stripe-release-e2e.mjs";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/messaging/client", () => ({
  telnyx: new Proxy({}, { get() { throw Error("Provider operations are forbidden in owner billing integration tests"); } }),
  TELNYX_MESSAGING_PROFILE_ID: "forbidden", TELNYX_CONNECTION_ID: "forbidden",
}));
const objectId = (v: unknown) => typeof v === "string" ? v : (v as { id: string })?.id;
const iso = (s: number) => new Date(s * 1000).toISOString();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const q = (v: string) => `'${v.replaceAll("'", "''")}'`;

describe.skipIf(process.env.REVIEW_OWNER_DISCOUNT_APP_E2E !== "1")("real owner-discount application billing", () => {
  it("grants the exact $0 paid review period once and preserves the owner discount during cancellation", async () => {
    const config = validateConfiguration(process.env), run = randomUUID();
    const business = randomUUID(), owner = randomUUID(), account = randomUUID(), phone = randomUUID();
    assert.equal(new URL(config.localUrl).port, "56321");
    for (const name of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY"]) assert(!process.env[name]);
    const inspectedContext = spawnSync("docker", ["context", "inspect"], { encoding: "utf8" });
    assert.equal(inspectedContext.status, 0);
    const endpoint = JSON.parse(inspectedContext.stdout)[0].Endpoints.docker.Host;
    assert(endpoint.startsWith("unix:///"));
    const container = "supabase_db_SimplAssistReviews";
    const inspected = spawnSync("docker", ["--host", endpoint, "inspect", container], { encoding: "utf8" });
    assert.equal(inspected.status, 0);
    const info = JSON.parse(inspected.stdout)[0];
    assert.equal(info.Config.Labels["com.supabase.cli.project"], "SimplAssistReviews");
    assert.equal(info.HostConfig.PortBindings["5432/tcp"][0].HostPort, "56322");
    const sql = (query: string) => {
      const result = spawnSync("docker", ["--host", endpoint, "exec", "-i", container, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-At"], { input: query, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr); return result.stdout;
    };
    assert.equal(sql("SELECT count(*) FROM public.businesses").trim(), "0");
    const db = createClient(config.localUrl, config.localKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const check = <T>(r: { data: T; error: { message: string } | null }): T => { assert.equal(r.error, null, r.error?.message); return r.data; };
    const stripe = new Stripe(config.key, { apiVersion: "2026-02-25.clover", maxNetworkRetries: 2, timeout: 20_000 });
    assertTestObject(await stripe.balance.retrieve());
    const metadata = { review_owner_app_e2e_run: run, business_id: business };
    const owned = { products: [] as string[], prices: [] as string[], coupons: [] as string[], customers: [] as string[], subscriptions: [] as string[], clocks: [] as string[], events: [] as string[], checkouts: [] as string[] };
    const reportPath = process.env.REVIEW_STRIPE_E2E_REPORT ?? "/private/tmp/review-owner-discount-app-e2e.json";
    const report = { run, status: "running", checks: [] as string[], cleanupErrors: [] as string[], resources: owned,
      coverage: "Actual application quote, confirm, reconciliation, cancellation, test-signed replay of a real Stripe TEST event and local DB entitlements. Carrier readiness and activation receipt are LOCAL fixtures. No hosted Checkout, external webhook transport, live carrier changes or customer messages." };
    const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    const pass = async (name: string) => { report.checks.push(name); console.log(`PASS: ${name}`); await save(); };
    let localCreated = false, ownerCreated = false;
    try {
      await save();
      const product = async (label: string) => {
        const p = assertTestObject(await stripe.products.create({ name: `Owner app TEST ${label} ${run}`, metadata })); owned.products.push(p.id); await save(); return p.id;
      };
      const price = async (productId: string, cents: number, recurring = true) => {
        const p = assertTestObject(await stripe.prices.create({ product: productId, unit_amount: cents, currency: "usd", metadata, ...(recurring ? { recurring: { interval: "month" as const } } : {}) }));
        owned.prices.push(p.id); await save(); return p.id;
      };
      const chatProduct = await product("chat"), addonProduct = await product("reviews"), feeProduct = await product("activation"), usageProduct = await product("overage");
      const chatPrice = await price(chatProduct, 1500), addonPrice = await price(addonProduct, 2000), feePrice = await price(feeProduct, 2500, false), usagePrice = await price(usageProduct, 2, false);
      const starterPrice = await price(chatProduct, 2900), growthPrice = await price(chatProduct, 4900), fullPrice = await price(chatProduct, 7900);
      const coupon = assertTestObject(await stripe.coupons.create({ duration: "forever", percent_off: 100, max_redemptions: 1, applies_to: { products: [chatProduct, addonProduct] }, metadata }));
      owned.coupons.push(coupon.id);
      const now = Math.floor(Date.now() / 1000);
      const clock = assertTestObject(await stripe.testHelpers.testClocks.create({ frozen_time: now - 15 * 86400, name: `Owner app ${run}` })); owned.clocks.push(clock.id);
      const customer = assertTestObject(await stripe.customers.create({ test_clock: clock.id, email: `owner-app-${run}@example.invalid`, metadata })); owned.customers.push(customer.id);
      const pm = assertTestObject(await stripe.paymentMethods.create({ type: "card", card: { token: "tok_chargeCustomerFail" }, metadata }));
      await stripe.paymentMethods.attach(pm.id, { customer: customer.id });
      Object.assign(process.env, {
        NEXT_PUBLIC_SUPABASE_URL: config.localUrl, SUPABASE_SERVICE_ROLE_KEY: config.localKey,
        STRIPE_PRICE_CHAT_ONLY: chatPrice, STRIPE_PRICE_REVIEW_SMS: addonPrice,
        STRIPE_PRICE_SMS_ONLY: starterPrice, STRIPE_PRICE_SMS_AND_CHAT: growthPrice, STRIPE_PRICE_FULL: fullPrice,
        STRIPE_PRICE_SETUP_FEE: feePrice, STRIPE_PRICE_REVIEW_SMS_ACTIVATION: feePrice, STRIPE_PRICE_SMS_OVERAGE_PART: usagePrice,
        NEXT_PUBLIC_CUSTOMER_REVIEWS_PRICING_ENABLED: "1", REVIEWS_SMS_ENABLED: "1", REVIEWS_SMS_PILOT_BUSINESS_IDS: business,
        REVIEWS_SMS_PROVISIONING_ENABLED: "0", REVIEWS_SMS_SENDING_ENABLED: "0", REVIEWS_EMAIL_SENDING_ENABLED: "0",
        SHARED_REGISTRATION_ADMISSIONS_ENABLED: "false", SHARED_REGISTRATION_PAID_STARTS_ENABLED: "false",
        RESEND_API_KEY: "re_forbidden", ANTHROPIC_API_KEY: "forbidden", NEXT_PUBLIC_APP_URL: "http://127.0.0.1:56321",
      });
      const createdOwner = await db.auth.admin.createUser({ id: owner, email: `owner-app-${run}@example.invalid`, email_confirm: true });
      assert.equal(createdOwner.error, null); assert.equal(createdOwner.data.user?.id, owner);
      ownerCreated = true;
      check(await db.from("businesses").insert({ id: business, owner_id: owner, name: "Disposable owner-discount billing", business_type: "general", onboarding_selected_plan: "chat_only", slug: `owner-test-${run}`,
        legal_business_name: "LOCAL TEST Billing LLC", business_entity_type: "llc", ein: "12-3456789", has_ein: true,
        address: "123 Test Fixture Street", city: "Test City", state: "IN", zip: "46000", authorized_rep_name: "Local Test Owner",
        authorized_rep_email: `owner-app-${run}@example.invalid`, authorized_rep_phone: "+15555550996", compliance_info_completed_at: new Date().toISOString(),
        privacy_terms_mode: "existing", privacy_url_override: "https://example.invalid/privacy", terms_url_override: "https://example.invalid/terms",
      }));
      localCreated = true;
      const fingerprint = "d".repeat(64);
      const attempt = check(await db.rpc("acquire_chat_only_checkout_attempt", { p_business_id: business, p_stripe_price_id: chatPrice, p_request_fingerprint: fingerprint, p_claim_token: randomUUID() }));
      assert.equal(attempt.status, "create");
      const expiry = new Date(attempt.checkout_session_expires_at).toISOString();
      const sub = assertTestObject(await stripe.subscriptions.create({ customer: customer.id, items: [{ price: chatPrice }], discounts: [{ coupon: coupon.id }], default_payment_method: pm.id,
        payment_behavior: "error_if_incomplete", metadata: { ...metadata, plan: "chat_only", mode: "onboarding", checkout_attempt_id: attempt.attempt_id,
          checkout_request_fingerprint: fingerprint, checkout_session_expires_at: expiry } }));
      owned.subscriptions.push(sub.id);
      const policy = { businessId: business, ownerId: owner, customerId: customer.id, subscriptionId: sub.id, couponId: coupon.id };
      process.env.REVIEW_SMS_OWNER_DISCOUNT_POLICY = JSON.stringify(policy);
      await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: Math.floor(Date.now() / 1000) });
      const deadline = Date.now() + 60_000;
      while ((await stripe.testHelpers.testClocks.retrieve(clock.id)).status !== "ready") { assert(Date.now() < deadline); await sleep(1000); }
      const { syncStripeSubscription } = await import("../src/lib/stripe/subscriptionSync");
      await syncStripeSubscription(sub);
      const before = check(await db.from("subscriptions").select("*").eq("business_id", business).single());
      assert.equal(before.plan, "chat_only"); assert.equal(before.status, "active");
      const billing = await import("../src/lib/stripe/reviewSms.server");
      check(await db.from("review_sms_accounts").insert({ id: account, business_id: business, owner_id: owner, billing_source: "direct", source_subscription_id: sub.id, source_customer_id: customer.id,
        state: "draft", exclusive_resources: true, draft: { phoneNumber: "+15555550996", consentDescription: "LOCAL TEST review keyword program; not real customer consent.", consentEvidenceUrl: "https://example.invalid/review-consent" } }));
      const risk = await import("../src/lib/messaging/registration/riskScreening");
      const riskInput = await risk.buildA2pRiskInputForBusiness(business);
      check(await db.from("businesses").update({ a2p_risk_review_status: "passed", a2p_risk_review_input_hash: risk.hashA2pRiskInput(riskInput.input) }).eq("id", business));
      const activationCheckout = await billing.createReviewSmsActivationCheckout(business, owner, "https://example.invalid");
      assert("url" in activationCheckout && activationCheckout.url);
      const activationOperation = check(await db.from("review_sms_billing_operations").select("*").eq("account_id", account).eq("kind", "activation").single());
      assert(activationOperation.checkout_session_id); owned.checkouts.push(activationOperation.checkout_session_id);
      const activationSession = assertTestObject(await stripe.checkout.sessions.retrieve(activationOperation.checkout_session_id));
      assert.equal(activationSession.amount_total, 2500); assert.equal(activationSession.payment_status, "unpaid");
      assert.equal(activationOperation.payload.ownerDiscount.couponId, coupon.id);
      assert.equal((await stripe.subscriptions.retrieve(sub.id)).items.data.length, 1);
      await stripe.checkout.sessions.expire(activationSession.id);
      await billing.synchronizeReviewSmsCheckout(await stripe.checkout.sessions.retrieve(activationSession.id));
      assert.equal(check(await db.from("review_sms_billing_operations").select("state").eq("id", activationOperation.id).single())?.state, "expired");
      await pass("Actual activation function validates LOCAL setup and creates a separate $25 TEST Checkout; expiration closes it without adding recurring texting");
      const approval = new Date().toISOString();
      check(await db.from("businesses").update({ telnyx_campaign_id: "owner-app-local-campaign", telnyx_messaging_profile_id: "owner-app-local-profile", campaign_status: "approved" }).eq("id", business));
      check(await db.from("phone_numbers").insert({ id: phone, business_id: business, phone_number: "+15555550996", telnyx_phone_number_id: "owner-app-local-phone", is_active: true,
        resource_status: "active", telnyx_campaign_assignment_status: "assigned", telnyx_campaign_assignment_campaign_id: "owner-app-local-campaign" }));
      check(await db.from("review_sms_accounts").update({
        state: "ready_unpaid", exclusive_resources: true, activation_paid_at: approval, campaign_id: "owner-app-local-campaign", messaging_profile_id: "owner-app-local-profile", phone_number_id: phone,
        review_usecase_approved_at: approval, approval_evidence: "LOCAL TEST fixture only; no carrier approval", ready_at: approval, ready_expires_at: expiry, provider_started_at: approval }).eq("id", account));
      const state = async () => check(await db.from("review_sms_accounts").select("*").eq("id", account).single());
      const access = async () => check(await db.rpc("has_review_sms_access", { p_business_id: business }));
      assert.equal(await access(), false);
      const overview = await billing.reviewSmsOverview(business, owner);
      assert.equal(overview.price.ownerDiscountApplied, true);
      const quote = await billing.quoteReviewSmsRecurring(business, owner);
      assert.equal(quote.amountDueCents, 0);
      const quoted = check(await db.from("review_sms_billing_operations").select("*").eq("id", quote.operationId).single());
      assert.equal(quoted.payload.ownerDiscount.couponId, coupon.id);
      assert.equal(quoted.payload.ownerDiscount.businessId, business);
      await pass("Actual owner overview/quote verify the exact redeemed coupon and freeze a $0 add-on operation without granting access");
      const activated = await billing.confirmReviewSmsRecurring(business, owner, quote.operationId, quote.fingerprint);
      assert.equal(activated.active, true); assert.equal(activated.paymentUrl, null); assert.equal(await access(), true);
      const active = await state(), invoice = assertTestObject(await stripe.invoices.retrieve(active.paid_invoice_id));
      assert.equal(invoice.status, "paid"); assert.equal(invoice.amount_due, 0); assert.equal(invoice.amount_paid, 0);
      assert.equal(invoice.parent?.subscription_details?.metadata?.review_sms_operation_id, quote.operationId);
      assert.equal(active.period_allowance, quote.includedParts); assert.equal(Date.parse(active.paid_period_end), Date.parse(before.current_period_end));
      const completed = check(await db.from("review_sms_billing_operations").select("state").eq("id", quote.operationId).single());
      assert(completed); assert.equal(completed.state, "completed");
      await pass("Actual confirmation and DB reconciliation grant bounded review access only from the exact real $0 paid invoice and preserve renewal");
      let event: Stripe.Event | undefined;
      const eventDeadline = Date.now() + 45_000;
      while (!event && Date.now() < eventDeadline) {
        const events = await stripe.events.list({ types: ["invoice.payment_succeeded"], limit: 100 });
        event = events.data.find(value => value.type === "invoice.payment_succeeded" && value.data.object.id === invoice.id);
        if (!event) await sleep(1000);
      }
      assert(event); assert.equal(event.livemode, false);
      const secret = `whsec_owner_test_${randomUUID().replaceAll("-", "")}`;
      process.env.STRIPE_WEBHOOK_SECRET = secret;
      const body = JSON.stringify(event);
      const headers = { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload: body, secret }) };
      const handler = (await import("../src/app/api/stripe/webhook/route")).POST;
      owned.events.push(event.id);
      const delivered = await handler(new Request("http://127.0.0.1:56321/api/stripe/webhook", { method: "POST", body, headers }) as never);
      assert.equal(delivered.status, 200);
      const replayed = await handler(new Request("http://127.0.0.1:56321/api/stripe/webhook", { method: "POST", body, headers }) as never);
      assert.equal(replayed.status, 200); assert.equal((await replayed.json()).duplicate, true);
      assert.equal((await state()).paid_invoice_id, invoice.id); assert.equal(await access(), true);
      await pass("Actual webhook accepts a test-signed replay of Stripe's real $0 payment_succeeded event and deduplicates it without changing access");
      const duplicate = await billing.confirmReviewSmsRecurring(business, owner, quote.operationId, quote.fingerprint);
      assert.equal(duplicate.active, true);
      const paidSub = assertTestObject(await stripe.subscriptions.retrieve(sub.id));
      assert.equal(paidSub.items.data.length, 2); assert.equal(objectId(paidSub.latest_invoice), invoice.id);
      delete process.env.REVIEW_SMS_OWNER_DISCOUNT_POLICY;
      await billing.reconcileReviewSmsSubscription(sub);
      assert.equal((await state()).paid_invoice_id, invoice.id); assert.equal((await state()).period_allowance, active.period_allowance);
      await pass("Duplicate confirmation and stale input preserve exact access; frozen owner proof supports recovery after the new-start policy is disabled");
      const cancel = await billing.cancelReviewSmsAtPeriodEnd(business, owner);
      assert.equal(cancel.cancelAt, iso(sub.items.data[0].current_period_end)); assert.equal((await state()).state, "cancel_pending"); assert.equal(await access(), true);
      const canceled = await state();
      const schedule = assertTestObject(await stripe.subscriptionSchedules.retrieve(canceled.stripe_schedule_id));
      assert.equal(schedule.phases.length, 2);
      assert(schedule.phases.every((phase: Stripe.SubscriptionSchedule.Phase) => phase.discounts.length === 1 && objectId(phase.discounts[0].discount) === quoted.payload.ownerDiscount.discountId));
      assert.equal(schedule.phases[0].items.length, 2); assert.equal(schedule.phases[1].items.length, 1); assert.equal(objectId(schedule.phases[1].items[0].price), chatPrice);
      await pass("Actual cancellation freezes both schedule phases with the same owner discount and retains access until period end");
      report.status = "passed";
    } catch (error) { report.status = "failed"; await save(); throw error; }
    finally {
      const cleanup = async (label: string, operation: () => Promise<unknown>) => { try { await operation(); } catch { report.cleanupErrors.push(label); } };
      for (const value of owned.checkouts) await cleanup("Checkout", async () => { const obj = await stripe.checkout.sessions.retrieve(value); assert.equal(obj.metadata?.business_id, business); if (obj.status === "open") await stripe.checkout.sessions.expire(value); });
      for (const value of owned.subscriptions) await cleanup("subscription", async () => { const obj = await stripe.subscriptions.retrieve(value); assert.equal(obj.metadata.review_owner_app_e2e_run, run); if (obj.status !== "canceled") await stripe.subscriptions.cancel(value); });
      for (const value of owned.clocks) await cleanup("clock", async () => { const obj = await stripe.testHelpers.testClocks.retrieve(value); assert.equal(obj.name, `Owner app ${run}`); await stripe.testHelpers.testClocks.del(value); });
      for (const value of owned.coupons) await cleanup("coupon", async () => { const obj = await stripe.coupons.retrieve(value); assert.equal(obj.metadata?.review_owner_app_e2e_run, run); await stripe.coupons.del(value); });
      for (const value of owned.prices) await cleanup("price", async () => { const obj = await stripe.prices.retrieve(value); assert.equal(obj.metadata.review_owner_app_e2e_run, run); await stripe.prices.update(value, { active: false }); });
      for (const value of owned.products) await cleanup("product", async () => { const obj = await stripe.products.retrieve(value); assert.equal(obj.metadata.review_owner_app_e2e_run, run); await stripe.products.update(value, { active: false }); });
      if (localCreated) await cleanup("local fixture", async () => {
        sql(`BEGIN; DELETE FROM public.review_sms_billing_operations WHERE business_id=${q(business)} AND owner_id=${q(owner)}; DELETE FROM public.chat_only_checkout_attempts WHERE business_id=${q(business)}; DELETE FROM public.businesses WHERE id=${q(business)} AND owner_id=${q(owner)}; COMMIT;`);
      });
      if (ownerCreated) await cleanup("local owner", async () => { assert.equal((await db.auth.admin.deleteUser(owner)).error, null); });
      if (owned.events.length) await cleanup("local event receipts", async () => { check(await db.from("stripe_webhook_events").delete().in("id", owned.events)); });
      if (report.cleanupErrors.length) report.status = "failed";
      await save(); assert.equal(report.cleanupErrors.length, 0, `Cleanup failures in ${reportPath}`);
    }
  }, 240_000);
});
