/** Opt-in, disposable Stripe TEST API contract; does not read or write any database. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import Stripe from "stripe";
import { describe, it, vi } from "vitest";
import { assertTestObject, validateConfiguration } from "./review-stripe-release-e2e.mjs";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: {} }));

describe.skipIf(process.env.REVIEW_CONVERSION_PREVIEW_E2E !== "1")("real conversion preview composition", () => {
  it("accepts only the three prorations before a payment update", async () => {
    const config = validateConfiguration(process.env), run = randomUUID();
    const stripe = new Stripe(config.key, { apiVersion: "2026-02-25.clover", maxNetworkRetries: 2, timeout: 20_000 });
    assertTestObject(await stripe.balance.retrieve());
    const { verifyReviewConversionPreview } = await import("../src/lib/stripe/reviewConversion.server");
    const metadata = { review_conversion_preview_run: run };
    const owned = { product: "", customer: "", subscription: "", prices: [] as string[] };
    const report = { status: "running", checks: [] as string[], cleanupErrors: [] as string[] };
    const save = () => writeFile("/private/tmp/review-conversion-preview-e2e.json", JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    try {
      const product = assertTestObject(await stripe.products.create({ name: `Conversion preview ${run}`, metadata }));
      owned.product = product.id;
      const price = async (amount: number) => {
        const result = assertTestObject(await stripe.prices.create({ product: product.id, currency: "usd", unit_amount: amount, recurring: { interval: "month" }, metadata }));
        owned.prices.push(result.id); return result.id;
      };
      const chat = await price(1500), reviews = await price(2000), growth = await price(4900);
      const customer = assertTestObject(await stripe.customers.create({ metadata })); owned.customer = customer.id;
      const card = await stripe.paymentMethods.create({ type: "card", card: { token: "tok_visa" }, metadata });
      await stripe.paymentMethods.attach(card.id, { customer: customer.id });
      const sub = assertTestObject(await stripe.subscriptions.create({ customer: customer.id, default_payment_method: card.id,
        payment_behavior: "error_if_incomplete", items: [{ price: chat }, { price: reviews }], metadata }));
      owned.subscription = sub.id;
      const base = sub.items.data.find((i: Stripe.SubscriptionItem) => i.price.id === chat)!, addon = sub.items.data.find((i: Stripe.SubscriptionItem) => i.price.id === reviews)!;
      const at = Math.floor(Date.now() / 1000);
      const binding = { baseItemId: base.id, reviewItemId: addon.id, basePriceId: chat, reviewPriceId: reviews,
        targetPriceId: growth, prorationAt: at, periodEnd: base.current_period_end };
      const preview = () => stripe.invoices.createPreview({ customer: customer.id, subscription: sub.id,
        subscription_details: { items: [{ id: base.id, price: growth, quantity: 1 }, { id: addon.id, deleted: true }],
          proration_date: at, proration_behavior: "always_invoice", billing_cycle_anchor: "unchanged" } });
      const clean = await preview(); assert.equal(clean.lines.data.length, 3);
      verifyReviewConversionPreview(clean, binding);
      report.checks.push("Actual clean Stripe preview has the exact three supported proration lines and no adjustments");

      const extra = assertTestObject(await stripe.invoiceItems.create({ customer: customer.id, subscription: sub.id,
        amount: 200, currency: "usd", description: "Unrelated disposable test charge", metadata }));
      try {
        const mixed = await preview(); assert.equal(mixed.lines.data.length, 4);
        assert.throws(() => verifyReviewConversionPreview(mixed, binding), /proration_unverified/);
        report.checks.push("Actual pending unrelated invoice item adds a fourth preview line and is rejected before any subscription update");
      } finally { await stripe.invoiceItems.del(extra.id); }

      await stripe.customers.update(customer.id, { balance: -100 });
      const credit = await preview(); assert.equal(credit.lines.data.length, 3);
      assert.notEqual(credit.amount_due, credit.lines.data.reduce((sum, line) => sum + line.amount, 0));
      assert.throws(() => verifyReviewConversionPreview(credit, binding), /proration_unverified/);
      report.checks.push("Actual customer credit changes the amount due without adding a line and is rejected as unsupported");
      const unchanged = await stripe.subscriptions.retrieve(sub.id);
      assert.equal(unchanged.items.data.length, 2); assert.equal(unchanged.pending_update, null);
      report.checks.push("All rejection checks leave the original two-item subscription unchanged");
      report.status = "passed";
    } catch (error) { report.status = "failed"; throw error; }
    finally {
      const cleanup = async (label: string, fn: () => Promise<unknown>) => { try { await fn(); } catch { report.cleanupErrors.push(label); } };
      if (owned.subscription) await cleanup("subscription", async () => { const s = await stripe.subscriptions.retrieve(owned.subscription); assert.equal(s.metadata.review_conversion_preview_run, run); await stripe.subscriptions.cancel(s.id); });
      if (owned.customer) await cleanup("customer", async () => { const c = await stripe.customers.retrieve(owned.customer); assert(!c.deleted); assert.equal(c.metadata.review_conversion_preview_run, run); await stripe.customers.del(c.id); });
      for (const price of owned.prices) await cleanup("price", async () => { const p = await stripe.prices.retrieve(price); assert.equal(p.metadata.review_conversion_preview_run, run); await stripe.prices.update(p.id, { active: false }); });
      if (owned.product) await cleanup("product", async () => { const p = await stripe.products.retrieve(owned.product); assert.equal(p.metadata.review_conversion_preview_run, run); await stripe.products.update(p.id, { active: false }); });
      await save(); assert.equal(report.cleanupErrors.length, 0, "Preview test resources must be cleaned up");
    }
  }, 120_000);
});
