import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), retrieve: vi.fn(), update: vi.fn(), price: vi.fn(),
  invoice: vi.fn(), preview: vi.fn(), customer: vi.fn(), createCheckout: vi.fn(), retrieveCheckout: vi.fn(),
  createSchedule: vi.fn(), retrieveSchedule: vi.fn(), updateSchedule: vi.fn(), releaseSchedule: vi.fn(), sync: vi.fn(), available: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: mocks.from, rpc: mocks.rpc } }));
vi.mock("@/lib/billing/planAvailability", () => ({ isPlanAvailable: mocks.available }));
vi.mock("./subscriptionSync", () => ({ syncStripeSubscription: mocks.sync }));
vi.mock("./client", () => ({ stripe: { subscriptions: { retrieve: mocks.retrieve, update: mocks.update },
  prices: { retrieve: mocks.price }, invoices: { retrieve: mocks.invoice, createPreview: mocks.preview },
  customers: { create: mocks.customer }, checkout: { sessions: { create: mocks.createCheckout, retrieve: mocks.retrieveCheckout } },
  subscriptionSchedules: { create: mocks.createSchedule, retrieve: mocks.retrieveSchedule, update: mocks.updateSchedule, release: mocks.releaseSchedule } } }));
import { confirmSmsPlanChange, createSmsCheckout, previewSmsPlanChange, smsSubscriptionFingerprint, synchronizeSmsBillingOperation,
  preserveSmsSchedulePhase, readSmsBillingChange, bindSmsCheckoutSession, cancelSmsBillingOperation,
  type SmsBillingOperation } from "./smsBilling.server";
const business = "10000000-0000-4000-8000-000000000001", ownerId = "20000000-0000-4000-8000-000000000002", operationId = "30000000-0000-4000-8000-000000000003";
const now = Date.parse("2026-09-17T12:00:00.000Z") / 1000, start = now - 15 * 86400, end = now + 15 * 86400;
let sub: Stripe.Subscription, current: Record<string, unknown> | null, op: SmsBillingOperation | null;
let businessRow: Record<string, unknown>;
const approvedPrice = (plan = "full") => ({ id: `price_${plan}`, active: true, type: "recurring", currency: "usd", unit_amount: plan === "full" ? 6500 : plan === "sms_and_chat" ? 4500 : 2500,
  recurring: { interval: "month", interval_count: 1, usage_type: "licensed" } });
function invoice(overrides = {}) { return { id: "in_upgrade", created: now, customer: "cus_owner", livemode: false, status: "paid", currency: "usd",
  billing_reason: "subscription_update", parent: { subscription_details: { subscription: "sub_owner" } },
  status_transitions: { paid_at: now }, amount_due: 1000, total: 1000, lines: { data: [] }, ...overrides }; }
function fixtureOperation(overrides: Partial<SmsBillingOperation> = {}): SmsBillingOperation {
  return { id: operationId, business_id: business, owner_id: ownerId, kind: "upgrade", state: "prepared", target_plan: "full", target_price_id: "price_full",
    expected_subscription_id: "sub_owner", expected_customer_id: "cus_owner", stripe_customer_id: "cus_owner", stripe_subscription_id: null,
    stripe_item_id: "si_owner", checkout_session_id: null, invoice_id: null, schedule_id: null, source_fingerprint: smsSubscriptionFingerprint(sub),
    source_plan: "sms_and_chat", source_period_start: new Date(start * 1000).toISOString(), source_period_end: new Date(end * 1000).toISOString(),
    proration_at: new Date(now * 1000).toISOString(), payment_effective_at: null, payment_verified_at: null, setup_fee_price_id: null,
    quote: { amountDueCents: 1000, currency: "usd", monthlyPriceCents: 6500, voiceSeconds: 3000 }, created_at: new Date(now * 1000).toISOString(),
    expires_at: new Date((now + 600) * 1000).toISOString(), confirmed_at: null, applied_at: null, ...overrides };
}
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now * 1000);
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fixture"); vi.stubEnv("STRIPE_PRICE_FULL", "price_full");
  vi.stubEnv("STRIPE_PRICE_SMS_AND_CHAT", "price_sms_and_chat"); vi.stubEnv("STRIPE_PRICE_SMS_ONLY", "price_sms_only");
  sub = { id: "sub_owner", customer: "cus_owner", metadata: { business_id: business }, livemode: false, status: "active", cancel_at_period_end: false,
    schedule: null, pending_update: null, collection_method: "charge_automatically", discounts: [], latest_invoice: "in_upgrade",
    items: { has_more: false, data: [{ id: "si_owner", quantity: 1, price: approvedPrice("sms_and_chat"), current_period_start: start, current_period_end: end }] } } as unknown as Stripe.Subscription;
  current = { business_id: business, stripe_subscription_id: sub.id, stripe_customer_id: "cus_owner", plan: "sms_and_chat", status: "active" };
  op = null;
  businessRow = { owner_id: ownerId, billing_mode: "stripe", partner_id: null, partner_plan: null, deleted_at: null, operations_suspended_at: null };
  mocks.available.mockReturnValue(true); mocks.retrieve.mockImplementation(async () => sub);
  mocks.price.mockImplementation(async (price: string) => approvedPrice(price.replace("price_", "")));
  mocks.preview.mockResolvedValue({ amount_due: 1000, currency: "usd" }); mocks.invoice.mockImplementation(async () => invoice());
  mocks.from.mockImplementation((table: string) => {
    const chain = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(), order: vi.fn(), limit: vi.fn() };
    for (const name of ["select", "eq", "order", "limit"] as const) chain[name].mockReturnValue(chain);
    chain.maybeSingle.mockImplementation(async () => ({ error: null, data: table === "businesses" ? businessRow : table === "subscriptions" ? current : op }));
    return chain;
  });
  mocks.rpc.mockImplementation(async (name: string, args: { p_request?: Partial<SmsBillingOperation>; p_details?: Partial<SmsBillingOperation>;
    p_snapshot?: { subscription_id: string; plan: string }; p_payment?: { paid_at: string } }) => {
    if (name === "acquire_sms_billing_operation") op ??= fixtureOperation({ ...args.p_request });
    else if (name === "confirm_sms_billing_operation") op = { ...op!, state: "confirming", confirmed_at: new Date().toISOString() };
    else if (name === "record_sms_billing_operation") op = { ...op!, ...args.p_details };
    else if (name === "finalize_paid_sms_billing_operation") {
      op = { ...op!, state: "applied", payment_effective_at: args.p_payment!.paid_at, applied_at: new Date().toISOString() };
      current = { ...current, stripe_subscription_id: args.p_snapshot!.subscription_id, plan: args.p_snapshot!.plan, status: "active" };
      return { data: true, error: null };
    }
    return { data: op, error: null };
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe("paid SMS plan changes", () => {
  it("previews the existing item and stores the exact proration time without updating it", async () => {
    const result = await previewSmsPlanChange(business, ownerId, "full");
    expect(result).toMatchObject({ amountDueCents: 1000, voiceSeconds: 3000, state: "prepared" });
    expect(mocks.preview).toHaveBeenCalledWith(expect.objectContaining({ subscription: "sub_owner", subscription_details: {
      items: [{ id: "si_owner", price: "price_full", quantity: 1 }], proration_date: now, proration_behavior: "always_invoice", billing_cycle_anchor: "unchanged" } }));
    expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.createCheckout).not.toHaveBeenCalled();
  });
  it("holds the old plan on failed payment, with a hosted payment recovery link", async () => {
    op = fixtureOperation();
    mocks.update.mockImplementation(async () => sub = { ...sub, metadata: { ...sub.metadata, sms_billing_operation_id: operationId }, pending_update: { expires_at: now + 3600 } } as unknown as Stripe.Subscription);
    mocks.invoice.mockResolvedValue(invoice({ status: "open", status_transitions: { paid_at: null }, hosted_invoice_url: "https://invoice.stripe.com/test" }));
    const result = await confirmSmsPlanChange(business, ownerId, operationId);
    expect(result).toMatchObject({ state: "pending", paymentUrl: "https://invoice.stripe.com/test" });
    expect(mocks.update).toHaveBeenCalledWith("sub_owner", expect.objectContaining({ payment_behavior: "pending_if_incomplete", proration_behavior: "always_invoice", proration_date: now }), { idempotencyKey: `sms-upgrade:${operationId}` });
    expect(mocks.rpc.mock.calls.some(([name]) => name === "finalize_paid_sms_billing_operation")).toBe(false);
  });
  it.each([1000, 0])("applies only a paid invoice, including legitimate zero due (%i)", async (total) => {
    op = fixtureOperation();
    mocks.invoice.mockResolvedValue(invoice({ total, amount_due: total }));
    mocks.update.mockImplementation(async () => sub = { ...sub, metadata: { ...sub.metadata, sms_billing_operation_id: operationId },
      items: { ...sub.items, data: [{ ...sub.items.data[0], price: approvedPrice() as Stripe.Price }] } });
    expect(await confirmSmsPlanChange(business, ownerId, operationId)).toMatchObject({ state: "applied" });
    expect(mocks.rpc).toHaveBeenCalledWith("finalize_paid_sms_billing_operation", expect.objectContaining({ p_payment: expect.objectContaining({ status: "paid", paid_at: new Date(now * 1000).toISOString() }) }));
  });
  it("rejects another customer before any update or finalization", async () => {
    op = fixtureOperation(); sub.customer = "cus_foreign";
    await expect(confirmSmsPlanChange(business, ownerId, operationId)).rejects.toThrow("sms_billing_source_changed");
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("requires a fresh quote after the price, period or cancellation state changes", async () => {
    op = fixtureOperation(); sub.items.data[0].current_period_end += 86400;
    await expect(confirmSmsPlanChange(business, ownerId, operationId)).rejects.toThrow("sms_billing_source_changed");
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("does not start a prepared purchase after its sales gate closes", async () => {
    op = fixtureOperation(); mocks.available.mockReturnValue(false);
    await expect(confirmSmsPlanChange(business, ownerId, operationId)).rejects.toThrow("sms_billing_plan_unavailable");
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("requires new confirmation if the invoice preview amount changes", async () => {
    op = fixtureOperation(); mocks.preview.mockResolvedValue({ amount_due: 1100, currency: "usd" });
    await expect(confirmSmsPlanChange(business, ownerId, operationId)).rejects.toThrow("sms_billing_source_changed");
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("preserves discount identities, payment method, tax settings and invoice issuer in both schedule phases", () => {
    sub.discounts = ["di_existing"];
    const preserved = preserveSmsSchedulePhase({ items: [{ price: "price_full", quantity: 1, tax_rates: [{ id: "txr_item" }] }],
      add_invoice_items: [], billing_thresholds: null, trial_end: null, currency: "usd", collection_method: "charge_automatically",
      default_payment_method: { id: "pm_saved" }, default_tax_rates: [{ id: "txr_default" }], automatic_tax: { enabled: true, liability: { type: "self" } },
      invoice_settings: { account_tax_ids: ["txi_saved"], days_until_due: null, issuer: { type: "self" } },
    } as unknown as Stripe.SubscriptionSchedule.Phase, sub);
    expect(preserved).toMatchObject({ discounts: [{ discount: "di_existing" }], default_payment_method: "pm_saved",
      default_tax_rates: ["txr_default"], automatic_tax: { enabled: true, liability: { type: "self" } },
      invoice_settings: { account_tax_ids: ["txi_saved"], issuer: { type: "self" } }, items: [{ tax_rates: ["txr_item"] }] });
  });
  it("replays the same provider idempotency key after an uncertain update", async () => {
    op = fixtureOperation();
    mocks.update.mockRejectedValueOnce(new Error("response lost")).mockImplementationOnce(async () => {
      sub = { ...sub, metadata: { ...sub.metadata, sms_billing_operation_id: operationId }, items: { ...sub.items, data: [{ ...sub.items.data[0], price: approvedPrice() as Stripe.Price }] } };
      return sub;
    });
    await expect(confirmSmsPlanChange(business, ownerId, operationId)).rejects.toThrow("response lost");
    await confirmSmsPlanChange(business, ownerId, operationId);
    expect(mocks.update.mock.calls[0]).toEqual(mocks.update.mock.calls[1]);
    expect(mocks.createCheckout).not.toHaveBeenCalled();
  });
  it("read-only refresh recovers a paid upgrade after its response and local invoice record were lost", async () => {
    op = fixtureOperation({ state: "confirming", confirmed_at: new Date(now * 1000).toISOString() });
    sub.metadata.sms_billing_operation_id = operationId; sub.items.data[0].price = approvedPrice() as Stripe.Price;
    expect(await readSmsBillingChange(business, ownerId, operationId)).toMatchObject({ state: "applied" });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.filter(([name]) => name === "finalize_paid_sms_billing_operation")).toHaveLength(1);
  });
  it("never expires a downgrade that crosses renewal while its schedule is being released", async () => {
    sub.items.data[0].price = approvedPrice() as Stripe.Price;
    op = fixtureOperation({ kind: "downgrade", state: "scheduled", target_plan: "sms_and_chat", target_price_id: "price_sms_and_chat", source_plan: "full", schedule_id: "sub_sched_future" });
    mocks.releaseSchedule.mockImplementation(async () => { sub.items.data[0].price = approvedPrice("sms_and_chat") as Stripe.Price; sub.metadata.sms_billing_operation_id = operationId; return {}; });
    await expect(cancelSmsBillingOperation(business, ownerId, operationId)).rejects.toThrow("sms_billing_already_applied");
    expect(mocks.sync).toHaveBeenCalledWith(sub);
    expect(mocks.rpc.mock.calls.some(([name, args]) => name === "record_sms_billing_operation" && args.p_details?.state === "expired")).toBe(false);
  });
  it("acknowledges a purged operation only for its scrubbed tombstone without resurrecting billing", async () => {
    current = null; op = null;
    businessRow = { ...businessRow, owner_id: null, deleted_at: "2026-08-01", cleanup_pii_scrubbed_at: "2026-09-01" };
    sub.metadata.sms_billing_operation_id = operationId;
    expect(await synchronizeSmsBillingOperation(sub)).toBe(true);
    expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.retrieve).not.toHaveBeenCalled();
  });
  it("does not acknowledge missing operation authority for a live account", async () => {
    sub.metadata.sms_billing_operation_id = operationId;
    await expect(synchronizeSmsBillingOperation(sub)).rejects.toThrow("sms_billing_not_found");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not blindly replay uncertain requests past provider idempotency retention", async () => {
    op = fixtureOperation({ state: "confirming", created_at: new Date((now - 24 * 3600) * 1000).toISOString() });
    await expect(confirmSmsPlanChange(business, ownerId, operationId)).rejects.toThrow("sms_billing_recovery_required");
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("rejects a paid invoice for another subscription", async () => {
    op = fixtureOperation({ state: "pending", confirmed_at: new Date(now * 1000).toISOString() });
    sub.metadata.sms_billing_operation_id = operationId; sub.items.data[0].price = approvedPrice() as Stripe.Price;
    mocks.invoice.mockResolvedValue(invoice({ parent: { subscription_details: { subscription: "sub_foreign" } } }));
    await expect(synchronizeSmsBillingOperation(sub)).rejects.toThrow("sms_billing_invoice_source_mismatch");
    expect(mocks.rpc.mock.calls.some(([name]) => name === "finalize_paid_sms_billing_operation")).toBe(false);
  });
  it("schedules a downgrade at renewal without updating or charging the current plan", async () => {
    sub.items.data[0].price = approvedPrice() as Stripe.Price; current!.plan = "full";
    op = fixtureOperation({ kind: "downgrade", target_plan: "sms_and_chat", target_price_id: "price_sms_and_chat", source_plan: "full" });
    mocks.createSchedule.mockResolvedValue({ id: "sub_sched_1", phases: [{ start_date: start, end_date: end, items: [{ price: "price_full", quantity: 1 }], discounts: [] }] });
    mocks.updateSchedule.mockResolvedValue({});
    const result = await confirmSmsPlanChange(business, ownerId, operationId);
    expect(result).toMatchObject({ state: "scheduled", effectiveAt: new Date(end * 1000).toISOString() });
    expect(mocks.updateSchedule).toHaveBeenCalledWith("sub_sched_1", expect.objectContaining({ phases: expect.arrayContaining([expect.objectContaining({ start_date: end, items: [{ price: "price_sms_and_chat", quantity: 1 }] })]) }), expect.anything());
    expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.createCheckout).not.toHaveBeenCalled();
  });
});
describe("SMS Checkout authority", () => {
  const args = { businessId: business, plan: "full" as const, priceId: "price_full", setupFeePriceId: "price_setup", successUrl: "https://simplassist.com/billing?session_id={CHECKOUT_SESSION_ID}", cancelUrl: "https://simplassist.com/billing", mode: "billing" };
  it("refuses to create a second subscription for an active account", async () => {
    await expect(createSmsCheckout(args)).rejects.toThrow("sms_billing_existing_subscription");
    expect(mocks.createCheckout).not.toHaveBeenCalled(); expect(mocks.customer).not.toHaveBeenCalled();
  });
  it("resumes the recorded session without creating another customer or Checkout", async () => {
    current = null;
    op = fixtureOperation({ kind: "checkout", state: "pending", expected_subscription_id: null, expected_customer_id: null, checkout_session_id: "cs_saved" });
    mocks.retrieveCheckout.mockResolvedValue({ id: "cs_saved", livemode: false, customer: "cus_owner", metadata: { sms_billing_operation_id: operationId }, client_reference_id: business,
      mode: "subscription", status: "open", url: "https://checkout.stripe.com/saved" });
    expect(await createSmsCheckout(args)).toBe("https://checkout.stripe.com/saved");
    expect(mocks.createCheckout).not.toHaveBeenCalled(); expect(mocks.customer).not.toHaveBeenCalled();
  });
  it("omits a previously fulfilled setup fee on rejoin and uses the stored customer", async () => {
    current!.status = "canceled"; sub.status = "canceled";
    op = fixtureOperation({ kind: "checkout", setup_fee_price_id: null, stripe_customer_id: "cus_owner", proration_at: null, source_plan: "sms_and_chat" });
    mocks.createCheckout.mockResolvedValue({ id: "cs_new", livemode: false, customer: "cus_owner", metadata: { sms_billing_operation_id: operationId }, client_reference_id: business,
      mode: "subscription", status: "open", url: "https://checkout.stripe.com/new" });
    await createSmsCheckout(args);
    expect(mocks.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_owner", line_items: [{ price: "price_full", quantity: 1 }] }), { idempotencyKey: `sms-checkout:${operationId}` });
    expect(mocks.customer).not.toHaveBeenCalled();
  });
  it("recovers the same Checkout operation after the provider response was lost, even when sales close", async () => {
    current = null;
    op = fixtureOperation({ kind: "checkout", state: "confirming", expected_subscription_id: null, expected_customer_id: null,
      confirmed_at: new Date(now * 1000).toISOString(), quote: { successUrl: args.successUrl, cancelUrl: args.cancelUrl, mode: args.mode } });
    const session = { id: "cs_recovered", livemode: false, customer: "cus_owner", metadata: { sms_billing_operation_id: operationId }, client_reference_id: business,
      mode: "subscription", status: "open", url: "https://checkout.stripe.com/recovered" };
    mocks.available.mockReturnValue(false); mocks.createCheckout.mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce(session);
    mocks.retrieveCheckout.mockResolvedValue(session);
    await expect(confirmSmsPlanChange(business, ownerId, operationId)).rejects.toThrow("response lost");
    expect(await confirmSmsPlanChange(business, ownerId, operationId)).toMatchObject({ state: "pending", paymentUrl: session.url });
    expect(mocks.createCheckout.mock.calls[0]).toEqual(mocks.createCheckout.mock.calls[1]);
    expect(mocks.customer).not.toHaveBeenCalled();
  });
  it("binds a verified Checkout webhook across the response-before-record crash window", async () => {
    op = fixtureOperation({ kind: "checkout", state: "confirming", expected_subscription_id: null, expected_customer_id: null });
    const session = { id: "cs_event", customer: "cus_owner", subscription: "sub_new", livemode: false, expires_at: now + 600,
      mode: "subscription", status: "complete", client_reference_id: business,
      metadata: { sms_billing_operation_id: operationId, business_id: business, plan: "full" } } as unknown as Stripe.Checkout.Session;
    expect(await bindSmsCheckoutSession(session)).toMatchObject({ checkout_session_id: "cs_event", stripe_subscription_id: "sub_new", state: "pending" });
    expect(mocks.createCheckout).not.toHaveBeenCalled();
  });
});
