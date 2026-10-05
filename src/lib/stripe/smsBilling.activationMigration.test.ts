import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), retrieve: vi.fn(), price: vi.fn(), invoice: vi.fn(),
  customer: vi.fn(), create: vi.fn(), get: vi.fn(), expire: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: mocks.from, rpc: mocks.rpc } }));
vi.mock("@/lib/billing/planAvailability", () => ({ isPlanAvailable: () => true }));
vi.mock("./client", () => ({ stripe: { subscriptions: { retrieve: mocks.retrieve }, prices: { retrieve: mocks.price },
  invoices: { retrieve: mocks.invoice }, customers: { create: mocks.customer },
  checkout: { sessions: { create: mocks.create, retrieve: mocks.get, expire: mocks.expire } } } }));
import { synchronizeSmsBillingOperation, type SmsBillingOperation } from "./smsBilling.server";
import { SUBSCRIPTION_PLANS } from "./config";
const businessId = "10000000-0000-4000-8000-000000000001", ownerId = "20000000-0000-4000-8000-000000000002";
const oldId = "30000000-0000-4000-8000-000000000003", newId = "30000000-0000-4000-8000-000000000004";
const now = Date.parse("2026-10-04T12:00:00Z"), unix = now / 1000;
const args = { businessId, plan: "sms_and_chat" as const, priceId: "price_growth", setupFeePriceId: "price_setup25",
  successUrl: "https://simplassist.com/billing?session_id={CHECKOUT_SESSION_ID}", cancelUrl: "https://simplassist.com/billing", mode: "billing" };
let operations: Map<string, SmsBillingOperation>, sessions: Map<string, Stripe.Checkout.Session>, casRace: boolean, current: object | null;
const recurring = { id: "price_growth", active: true, type: "recurring", currency: "usd", unit_amount: SUBSCRIPTION_PLANS.sms_and_chat.price * 100,
  recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } };
function fixture(overrides: Partial<SmsBillingOperation> = {}): SmsBillingOperation {
  return { id: oldId, business_id: businessId, owner_id: ownerId, kind: "checkout", state: "pending", target_plan: "sms_and_chat", target_price_id: "price_growth",
    expected_subscription_id: null, expected_customer_id: null, stripe_customer_id: "cus_owner", stripe_subscription_id: null, stripe_item_id: null,
    checkout_session_id: "cs_old", invoice_id: null, schedule_id: null, source_fingerprint: "source", source_plan: null, source_period_start: null,
    source_period_end: null, proration_at: null, payment_effective_at: null, payment_verified_at: null, setup_fee_price_id: "price_setup49",
    quote: { ...args, setupFeeCents: 4900 }, created_at: new Date(now).toISOString(), expires_at: new Date(now + 1800_000).toISOString(),
    confirmed_at: new Date(now).toISOString(), applied_at: null, ...overrides };
}
function session(op: SmsBillingOperation, overrides = {}): Stripe.Checkout.Session {
  return { id: op.id === oldId ? "cs_old" : "cs_new", livemode: false, customer: "cus_owner", subscription: null,
    metadata: { business_id: businessId, sms_billing_operation_id: op.id, plan: "sms_and_chat" }, expires_at: unix + 1800,
    client_reference_id: businessId, mode: "subscription", status: "open", payment_status: "unpaid", url: "https://checkout.stripe.com/" + op.id,
    ...overrides } as unknown as Stripe.Checkout.Session;
}
function paidSubscription(op = operations.get(oldId)!): Stripe.Subscription {
  return { id: "sub_owner", customer: "cus_owner", livemode: false, metadata: { business_id: businessId, sms_billing_operation_id: op.id },
    status: "active", cancel_at_period_end: false, pending_update: null, latest_invoice: "in_paid",
    items: { has_more: false, data: [{ id: "si_owner", quantity: 1, price: recurring, current_period_start: unix, current_period_end: unix + 30 * 86400 }] } } as unknown as Stripe.Subscription;
}
function paidInvoice(amount = 4900) {
  return { id: "in_paid", created: unix, customer: "cus_owner", livemode: false, status: "paid", currency: "usd", billing_reason: "subscription_create",
    parent: { subscription_details: { subscription: "sub_owner" } }, status_transitions: { paid_at: unix }, total: amount + 4900, amount_due: amount + 4900,
    lines: { has_more: false, data: [{ quantity: 1, amount, subtotal: amount, pricing: { price_details: { price: amount === 4900 ? "price_setup49" : "price_setup25" } } }] } };
}
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fixture");
  vi.stubEnv("STRIPE_PRICE_SMS_AND_CHAT", "price_growth");
  const old = fixture(); operations = new Map([[old.id, old]]); sessions = new Map([["cs_old", session(old)]]); casRace = false; current = null;
  mocks.from.mockImplementation((table: string) => {
    const filters: Record<string, unknown> = {}; let patch: Partial<SmsBillingOperation> | undefined;
    const q = { select: vi.fn(), eq: vi.fn(), update: vi.fn(), maybeSingle: vi.fn() };
    q.select.mockReturnValue(q); q.eq.mockImplementation((field, value) => { filters[field] = value; return q; });
    q.update.mockImplementation(value => { patch = value; return q; });
    q.maybeSingle.mockImplementation(async () => {
      if (table === "businesses") return { data: { owner_id: ownerId, billing_mode: "stripe" }, error: null };
      if (table === "subscriptions") return { data: current, error: null };
      const old = operations.get(String(filters.id));
      if (patch && old) {
        if (casRace) { old.state = "confirming"; old.checkout_session_id = null; casRace = false; }
        if (filters.state !== old.state) return { data: null, error: null };
        Object.assign(old, patch);
      }
      return { data: old ? { ...old } : null, error: null };
    });
    return q;
  });
  mocks.rpc.mockImplementation(async (name: string, value: Record<string, unknown>) => {
    if (name === "acquire_sms_billing_operation") {
      const active = Array.from(operations.values()).find(op => !["expired", "applied"].includes(op.state));
      if (active) return { data: { ...active }, error: null };
      const created = fixture({ ...(value.p_request as Partial<SmsBillingOperation>), id: newId, state: "prepared", checkout_session_id: null, confirmed_at: null });
      operations.set(newId, created); return { data: { ...created }, error: null };
    }
    const op = operations.get(String(value.p_operation_id))!;
    if (name === "confirm_sms_billing_operation" && op.state === "prepared") Object.assign(op, { state: "confirming", confirmed_at: new Date(now).toISOString() });
    if (name === "record_sms_billing_operation" && !["expired", "applied"].includes(op.state)) Object.assign(op, value.p_details);
    if (name === "finalize_paid_sms_billing_operation") { op.state = "applied"; current = { stripe_subscription_id: "sub_owner", plan: "sms_and_chat", status: "active" }; return { data: true, error: null }; }
    return { data: { ...op }, error: null };
  });
  mocks.price.mockImplementation(async (id: string) => id === "price_growth" ? recurring : ({ id, active: id === "price_setup25", currency: "usd", type: "one_time", unit_amount: id === "price_setup49" ? 4900 : 2500 }));
  mocks.get.mockImplementation(async (id: string) => sessions.get(id));
  mocks.expire.mockImplementation(async (id: string) => { const expired = { ...sessions.get(id)!, status: "expired" as const }; sessions.set(id, expired); return expired; });
  mocks.create.mockImplementation(async (_params, options) => {
    const op = operations.get(options.idempotencyKey.replace("sms-checkout:", ""))!;
    const existing = sessions.get(op.id === oldId ? "cs_old" : "cs_new");
    if (existing) return existing;
    const created = session(op); sessions.set(created.id, created); return created;
  });
  mocks.retrieve.mockImplementation(async () => paidSubscription()); mocks.invoice.mockImplementation(async () => paidInvoice());
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe("setup price replacement and historical receipts", () => {
  it.each([2500, 4900])("accepts the exact original %i setup receipt, even when the old price was archived", async amount => {
    const op = operations.get(oldId)!; op.setup_fee_price_id = amount === 4900 ? "price_setup49" : "price_setup25"; op.quote.setupFeeCents = amount;
    sessions.set("cs_old", session(op, { status: "complete", payment_status: "paid", subscription: "sub_owner" })); mocks.invoice.mockResolvedValue(paidInvoice(amount));
    expect(await synchronizeSmsBillingOperation(paidSubscription())).toBe(true); expect(op.state).toBe("applied");
  });
  it("accepts a paid zero-due invoice with a legitimate discount and the exact original setup line", async () => {
    const paid = paidInvoice(); Object.assign(paid, { total: 0, amount_due: 0 });
    sessions.set("cs_old", session(operations.get(oldId)!, { status: "complete", payment_status: "no_payment_required", subscription: "sub_owner" })); mocks.invoice.mockResolvedValue(paid);
    expect(await synchronizeSmsBillingOperation(paidSubscription())).toBe(true); expect(operations.get(oldId)?.state).toBe("applied");
  });
  it.each(["missing", "wrong-price", "wrong-amount", "duplicate", "truncated"])("withholds activation for a %s historical receipt", async invalid => {
    const paid = paidInvoice();
    if (invalid === "missing") paid.lines.data = [];
    if (invalid === "wrong-price") paid.lines.data[0].pricing.price_details.price = "price_foreign";
    if (invalid === "wrong-amount") paid.lines.data[0].amount = 2500;
    if (invalid === "duplicate") paid.lines.data.push(paid.lines.data[0]);
    if (invalid === "truncated") paid.lines.has_more = true;
    sessions.set("cs_old", session(operations.get(oldId)!, { status: "complete", payment_status: "paid", subscription: "sub_owner" })); mocks.invoice.mockResolvedValue(paid);
    await expect(synchronizeSmsBillingOperation(paidSubscription())).rejects.toThrow("sms_billing_setup_fee_unverified");
    expect(operations.get(oldId)?.state).toBe("pending"); expect(mocks.rpc.mock.calls.some(([name]) => name === "finalize_paid_sms_billing_operation")).toBe(false);
  });
});
