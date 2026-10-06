import type Stripe from "stripe";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  sharedPilot: vi.fn(), sharedContext: vi.fn(), sharedNewStart: vi.fn(), sharedValidate: vi.fn(), sharedConsume: vi.fn(), sharedReserve: vi.fn(), sharedSettle: vi.fn(), sharedReservation: vi.fn(), sharedPaidProof: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  retrieve: vi.fn(),
  update: vi.fn(),
  preview: vi.fn(),
  price: vi.fn(),
  checkout: vi.fn(),
  checkoutGet: vi.fn(),
  checkoutExpire: vi.fn(),
  checkoutLines: vi.fn(),
  payment: vi.fn(),
  refund: vi.fn(),
  invoice: vi.fn(),
  invoiceList: vi.fn(),
  coupon: vi.fn(),
  setup: vi.fn(),
  entitlements: vi.fn(),
  scheduleCreate: vi.fn(),
  scheduleGet: vi.fn(),
  scheduleUpdate: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/messaging/sharedBusinessRegistrations.server", async importOriginal => ({
  ...await importOriginal<object>(),
  sharedRegistrationPilotEnabled: mocks.sharedPilot,
  readSharedRegistrationContext: mocks.sharedContext,
  assertSharedRegistrationForNewStart: mocks.sharedNewStart,
  validateSharedRegistrationProof: mocks.sharedValidate,
  consumeSharedReviewRegistration: mocks.sharedConsume,
  reserveSharedCampaignSubmission: mocks.sharedReserve,
  settleSharedCampaignSubmission: mocks.sharedSettle,
  readSharedCampaignReservation: mocks.sharedReservation,
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock("@/lib/billing/entitlements", () => ({
  resolveBusinessEntitlements: mocks.entitlements,
}));
vi.mock("@/lib/reviews/smsProvisioning.server", () => ({
  validateReviewSmsSetup: mocks.setup,
}));
vi.mock("./client", () => ({
  stripe: {
    subscriptions: { retrieve: mocks.retrieve, update: mocks.update },
    prices: { retrieve: mocks.price },
    invoices: { createPreview: mocks.preview, retrieve: mocks.invoice, list: mocks.invoiceList },
    coupons: { retrieve: mocks.coupon },
    checkout: { sessions: { create: mocks.checkout, retrieve: mocks.checkoutGet, expire: mocks.checkoutExpire, listLineItems: mocks.checkoutLines } },
    paymentIntents: { retrieve: mocks.payment },
    refunds: { create: mocks.refund },
    subscriptionSchedules: {
      create: mocks.scheduleCreate,
      retrieve: mocks.scheduleGet,
      update: mocks.scheduleUpdate,
    },
  },
}));
import {
  reviewSmsOverview,
  confirmReviewSmsRecurring,
  quoteReviewSmsRecurring,
  synchronizeReviewSmsCheckout,
  refundUnsubmittedReviewSmsActivation,
  createReviewSmsActivationCheckout,
  reconcileReviewSmsSubscription,
  cancelReviewSmsAtPeriodEnd,
} from "./reviewSms.server";
const bid = "10000000-0000-4000-8000-000000000098",
  owner = "20000000-0000-4000-8000-000000000098",
  aid = "30000000-0000-4000-8000-000000000098",
  oid = "40000000-0000-4000-8000-000000000098";
const now = Date.parse("2026-10-03T14:00:00Z"),
  start = Math.floor(now / 1000) - 15 * 86400,
  end = Math.floor(now / 1000) + 15 * 86400;
function price(id: string, amount: number) {
  return {
    id,
    active: true,
    type: "recurring",
    currency: "usd",
    unit_amount: amount,
    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
  };
}
function subscription(withAddon = false): Stripe.Subscription {
  return {
    id: "sub_review",
    customer: "cus_review",
    livemode: false,
    status: "active",
    cancel_at_period_end: false,
    schedule: null,
    pending_update: null,
    discounts: [],
    collection_method: "charge_automatically",
    metadata: { business_id: bid },
    latest_invoice: null,
    items: {
      has_more: false,
      data: [
        {
          id: "si_base",
          quantity: 1,
          price: price("price_chat", 1000),
          current_period_start: start,
          current_period_end: end,
        },
        ...(withAddon
          ? [
              {
                id: "si_addon",
                quantity: 1,
                price: price("price_addon", 2000),
                current_period_start: start,
                current_period_end: end,
              },
            ]
          : []),
      ],
    },
  } as unknown as Stripe.Subscription;
}
let account: Record<string, unknown>,
  operation: Record<string, unknown> | null,
  updates: { table: string; patch: Record<string, unknown> }[],
  refundRace: boolean;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.sharedPilot.mockReturnValue(false);
  mocks.sharedContext.mockResolvedValue(null);
  mocks.sharedNewStart.mockResolvedValue(null);
  mocks.sharedValidate.mockResolvedValue(null);
  mocks.sharedConsume.mockResolvedValue(undefined);
  mocks.sharedReserve.mockResolvedValue(null);
  mocks.sharedSettle.mockResolvedValue(undefined);
  mocks.sharedReservation.mockResolvedValue(null);
  mocks.sharedPaidProof.mockResolvedValue(null);

  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_reviews");
  vi.stubEnv("REVIEWS_SMS_ENABLED", "1");
  vi.stubEnv("REVIEWS_SMS_PILOT_BUSINESS_IDS", bid);
  vi.stubEnv("STRIPE_PRICE_CHAT_ONLY", "price_chat");
  vi.stubEnv("STRIPE_PRICE_REVIEW_SMS", "price_addon");
  vi.stubEnv("STRIPE_PRICE_REVIEW_SMS_ACTIVATION", "price_activation");
  vi.stubEnv("STRIPE_PRICE_SMS_ONLY", "price_starter");
  vi.stubEnv("STRIPE_PRICE_SMS_AND_CHAT", "price_growth");
  vi.stubEnv("STRIPE_PRICE_FULL", "price_full");
  account = {
    id: aid,
    business_id: bid,
    owner_id: owner,
    billing_source: "direct",
    state: "ready_unpaid",
    source_subscription_id: "sub_review",
    source_customer_id: "cus_review",
    draft: { phoneNumber: "+13175550100" },
    activation_paid_at: new Date(now - 86400_000).toISOString(),
    activation_payment_intent_id: "pi_activation",
    provider_started_at: null,
    activation_refunded_at: null,
    ready_expires_at: new Date(now + 6 * 86400_000).toISOString(),
    review_usecase_approved_at: new Date(now - 1000).toISOString(),
    stripe_item_id: null,
  };
  operation = null;
  updates = [];
  refundRace = false;
  mocks.from.mockImplementation((table: string) => {
    let patch: Record<string, unknown> | undefined;
    const q: Record<string, unknown> = {};
    const result = () => ({
      data:
        table === "businesses"
          ? {
              id: bid,
              owner_id: owner,
              billing_mode: "stripe",
              partner_id: null,
              deleted_at: null,
              operations_suspended_at: null,
            }
          : table === "review_sms_accounts"
            ? patch && refundRace
              ? null
              : { ...account, ...patch }
            : operation,
      error: null,
    });
    for (const method of ["select", "eq", "is", "in", "limit", "order"])
      q[method] = () => q;
    q.update = (value: Record<string, unknown>) => {
      patch = value;
      updates.push({ table, patch: value });
      if (table === "review_sms_billing_operations" && operation) operation = { ...operation, ...value };
      return q;
    };
    q.maybeSingle = async () => result();
    q.single = async () => result();
    q.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(result()).then(resolve);
    return q;
  });
  mocks.rpc.mockImplementation(
    async (name: string, args: Record<string, unknown>) => {
      if (name === "review_sms_acquire_operation") {
        operation = {
          id: oid,
          account_id: aid,
          business_id: bid,
          owner_id: owner,
          kind: args.p_kind,
          state: "prepared",
          fingerprint: args.p_fingerprint,
          payload: args.p_payload,
          checkout_session_id: null,
          invoice_id: null,
          schedule_id: null,
          created_at: new Date(now).toISOString(),
          expires_at: new Date(now + 30 * 60_000).toISOString(),
        };
        return { data: operation, error: null };
      }
      if (name === "review_sms_confirm_operation") {
        operation = { ...operation, state: "confirmed", confirmed_at: new Date(now).toISOString() };
        return { data: operation, error: null };
      }
      if (name === "review_sms_freeze_cancel") {
        operation = {
          ...operation,
          state: "confirmed",
          schedule_id: args.p_schedule,
          payload: {
            ...(operation?.payload as object),
            scheduleUpdate: args.p_parameters,
          },
        };
        return { data: operation, error: null };
      }
      if (name === "review_sms_begin_reconcile")
        return { data: 1, error: null };
      return { data: true, error: null };
    },
  );
  mocks.retrieve.mockResolvedValue(subscription());
  mocks.price.mockResolvedValue(price("price_addon", 2000));
  mocks.preview.mockResolvedValue({ currency: "usd", amount_due: 1000 });
  mocks.invoiceList.mockResolvedValue({ data: [], has_more: false });
  mocks.setup.mockResolvedValue({});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe("review SMS commercial boundaries", () => {
  it("quotes the actual provider charge and prorates the first shared allowance", async () => {
    const quote = await quoteReviewSmsRecurring(bid, owner);
    expect(quote.amountDueCents).toBe(1000);
    expect(quote.includedParts).toBe(125);
    expect(quote.monthlyPriceCents).toBe(2000);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(await quoteReviewSmsRecurring(bid, owner)).toEqual(quote);
    expect(mocks.preview).toHaveBeenCalledTimes(1);
  });
  it("does not add recurring charges until the provider is ready", async () => {
    account.state = "carrier_pending";
    await expect(quoteReviewSmsRecurring(bid, owner)).rejects.toThrow(
      "review_sms_not_ready",
    );
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("does not expire a quote that a concurrent confirmation already won", async () => {
    await quoteReviewSmsRecurring(bid, owner);
    operation!.expires_at = new Date(now - 1).toISOString();
    const prepared = { ...operation };
    const confirmed = { ...operation, state: "confirmed" };
    const original = mocks.from.getMockImplementation()!;
    let operationReads = 0;
    mocks.from.mockImplementation((table: string) => {
      if (table !== "review_sms_billing_operations") return original(table);
      const q: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "update"])
        q[method] = () => q;
      q.maybeSingle = async () => ({
        data: [prepared, null, confirmed][operationReads++],
        error: null,
      });
      return q;
    });
    await expect(quoteReviewSmsRecurring(bid, owner)).rejects.toThrow(
      "review_sms_payment_in_progress",
    );
    expect(operationReads).toBe(3);
    expect(mocks.preview).toHaveBeenCalledTimes(1);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("rejects a changed confirmation quote before any payable update", async () => {
    const quote = await quoteReviewSmsRecurring(bid, owner);
    await expect(
      confirmReviewSmsRecurring(bid, owner, quote.operationId, "wrong"),
    ).rejects.toThrow("review_sms_quote_changed");
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("confirmed retries keep the frozen provider parameters and idempotency key", async () => {
    const quote = await quoteReviewSmsRecurring(bid, owner);
    operation!.state = "confirmed";
    const updated = subscription(true);
    updated.pending_update = {} as never;
    updated.latest_invoice = "in_reviews";
    mocks.invoice.mockResolvedValue({ ...paidInvoice(updated, true), status: "open" });
    mocks.update.mockRejectedValueOnce(new Error("response lost")).mockImplementationOnce(async () => {
      mocks.retrieve.mockResolvedValue(updated); return updated;
    });
    await expect(confirmReviewSmsRecurring(
      bid,
      owner,
      quote.operationId,
      quote.fingerprint,
    )).rejects.toThrow("response lost");
    await confirmReviewSmsRecurring(
      bid,
      owner,
      quote.operationId,
      quote.fingerprint,
    );
    expect(mocks.update.mock.calls[0]).toEqual(mocks.update.mock.calls[1]);
    expect(mocks.update.mock.calls[0][2]).toEqual({
      idempotencyKey: `review-sms-recurring:${oid}`,
    });
    expect(
      mocks.rpc.mock.calls.some(
        ([name]) => name === "review_sms_record_paid_period",
      ),
    ).toBe(false);
  });
  it("does not grant review access for an unpaid pending update", async () => {
    const sub = subscription(true);
    sub.pending_update = {} as never;
    mocks.retrieve.mockResolvedValue(sub);
    await reconcileReviewSmsSubscription(sub);
    expect(
      mocks.rpc.mock.calls.some(
        ([name]) => name === "review_sms_record_paid_period",
      ),
    ).toBe(false);
  });
  it("never replays a payable update after the provider idempotency window", async () => {
    const quote = await quoteReviewSmsRecurring(bid, owner);
    operation!.state = "confirmed";
    operation!.created_at = new Date(now - 23 * 3600_000).toISOString();
    await expect(
      confirmReviewSmsRecurring(
        bid,
        owner,
        quote.operationId,
        quote.fingerprint,
      ),
    ).rejects.toThrow("review_sms_recovery_required");
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("does not sell a new activation at the superseded $49 price", async () => {
    account.activation_paid_at = null;
    account.state = "draft";
    mocks.price.mockResolvedValue({
      id: "price_activation",
      active: true,
      currency: "usd",
      unit_amount: 4900,
      type: "one_time",
    });
    await expect(
      createReviewSmsActivationCheckout(bid, owner, "https://simplassist.com"),
    ).rejects.toThrow("review_sms_activation_price_unavailable");
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it("validates exact activation customer, amount, and mode before persisting paid authority", async () => {
    operation = {
      id: oid,
      account_id: aid,
      business_id: bid,
      owner_id: owner,
      kind: "activation",
      state: "confirmed",
      fingerprint: "f",
      payload: activationPayload(4900),
      checkout_session_id: "cs_review",
      invoice_id: null,
      schedule_id: null,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + 1000).toISOString(),
    };
    const session = {
      id: "cs_review",
      livemode: false,
      metadata: { review_sms_operation_id: oid, review_sms_account_id: aid },
      client_reference_id: bid,
      customer: "cus_other",
      mode: "payment",
      currency: "usd",
      amount_total: 4900,
      status: "complete",
      payment_status: "paid",
      payment_intent: "pi_activation",
    } as unknown as Stripe.Checkout.Session;
    await expect(synchronizeReviewSmsCheckout(session)).rejects.toThrow(
      "review_sms_checkout_unbound",
    );
    expect(mocks.payment).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
  it("a provider-submission race blocks the refund before contacting Stripe", async () => {
    refundRace = true;
    paidActivation(4900);
    await expect(
      refundUnsubmittedReviewSmsActivation(bid, owner),
    ).rejects.toThrow("review_sms_refund_unavailable");
    expect(mocks.refund).not.toHaveBeenCalled();
  });
});

function cancellationSchedule() {
  return {
    id: "sub_sched_review",
    livemode: false,
    customer: "cus_review",
    subscription: "sub_review",
    phases: [
      {
        start_date: start,
        end_date: end,
        currency: "usd",
        collection_method: "charge_automatically",
        metadata: { phase_note: "preserve" },
        items: [
          { price: "price_chat", quantity: 1, tax_rates: [{ id: "txr_base" }] },
          {
            price: "price_addon",
            quantity: 1,
            tax_rates: [{ id: "txr_review" }],
          },
        ],
      },
    ],
  } as unknown as Stripe.SubscriptionSchedule;
}
function paidInvoice(sub: Stripe.Subscription, prorated = false) {
  const addon = sub.items.data.find((item) => item.id === "si_addon")!;
  return {
    id: "in_reviews",
    livemode: false,
    customer: "cus_review",
    parent: { subscription_details: { subscription: sub.id, metadata: { review_sms_operation_id: oid } } },
    billing_reason: prorated ? "subscription_update" : "subscription_cycle",
    created: Math.floor(now / 1000),
    status: "paid",
    status_transitions: { paid_at: Math.floor(now / 1000) },
    currency: "usd",
    amount_paid: prorated ? 1000 : 2000,
    amount_due: prorated ? 1000 : 2000,
    lines: {
      has_more: false,
      data: [
        {
          quantity: 1,
          amount: prorated ? 1000 : 2000,
          parent: {
            subscription_item_details: {
              subscription_item: addon.id,
              proration: prorated,
            },
          },
          pricing: { price_details: { price: addon.price.id } },
          period: { start: prorated ? Math.floor(now / 1000) : start, end },
        },
      ],
    },
  };
}
function ownerSubscription(withAddon = false) {
  const sub = subscription(withAddon);
  sub.items.data[0].price.product = "prod_chat";
  if (withAddon) sub.items.data[1].price.product = "prod_addon";
  sub.discounts = [{ id: "di_owner", source: { type: "coupon", coupon: "coupon_owner" }, customer: "cus_review", subscription: sub.id,
    end: null, subscription_item: null, invoice: null, invoice_item: null, checkout_session: null } as Stripe.Discount];
  vi.stubEnv("REVIEW_SMS_OWNER_DISCOUNT_POLICY", JSON.stringify({ businessId: bid, ownerId: owner, customerId: "cus_review", subscriptionId: "sub_review", couponId: "coupon_owner" }));
  vi.stubEnv("STRIPE_PRICE_SMS_OVERAGE_PART", "price_overage");
  mocks.coupon.mockResolvedValue({ id: "coupon_owner", livemode: false, percent_off: 100, amount_off: null, duration: "forever", valid: false,
    applies_to: { products: ["prod_chat", "prod_addon"] } });
  mocks.price.mockImplementation(async id => id === "price_activation" ? { id, product: "prod_setup", active: true, currency: "usd", unit_amount: 2500, type: "one_time" }
    : id === "price_overage" ? { id, product: "prod_overage" } : { ...price("price_addon", 2000), product: "prod_addon" });
  mocks.retrieve.mockResolvedValue(sub);
  mocks.preview.mockResolvedValue({ currency: "usd", amount_due: 0 });
  return sub;
}
describe("owner-discount review SMS lifecycle", () => {
  it("keeps the one-time Checkout at $25 and does not offer coupon entry", async () => {
    newActivation(); ownerSubscription();
    await createReviewSmsActivationCheckout(bid, owner, "https://simplassist.com");
    expect(operation?.payload).toMatchObject({ amountCents: 2500, ownerDiscount: { couponId: "coupon_owner" } });
    expect(mocks.checkout.mock.calls[0][0]).toMatchObject({ mode: "payment", line_items: [{ price: "price_activation", quantity: 1 }] });
    expect(mocks.checkout.mock.calls[0][0].allow_promotion_codes).toBeUndefined();
    expect(mocks.checkout.mock.calls[0][0].discounts).toBeUndefined();
  });
  it("quotes $0 and grants only the frozen prorated allowance from the exact paid $0 invoice", async () => {
    const original = ownerSubscription();
    const quote = await quoteReviewSmsRecurring(bid, owner);
    expect(quote).toMatchObject({ amountDueCents: 0, monthlyPriceCents: 0, ownerDiscountApplied: true, includedParts: 125 });
    // PostgreSQL JSONB changes object-key order; proof equality is structural.
    const payload = operation!.payload as Record<string, unknown>;
    payload.ownerDiscount = Object.fromEntries(Object.entries(payload.ownerDiscount as object).reverse());
    const updated = ownerSubscription(true);
    updated.items.data[1].current_period_start = Math.floor(now / 1000);
    updated.latest_invoice = "in_reviews";
    updated.metadata.review_sms_operation_id = oid;
    const invoice = paidInvoice(updated, true);
    invoice.amount_due = 0; invoice.amount_paid = 0; invoice.lines.data[0].amount = 0;
    mocks.retrieve.mockResolvedValueOnce(original).mockResolvedValue(updated);
    mocks.update.mockResolvedValue(updated); mocks.invoice.mockResolvedValue(invoice);
    await confirmReviewSmsRecurring(bid, owner, quote.operationId, quote.fingerprint);
    expect(mocks.update.mock.calls[0][0]).toBe("sub_review");
    expect(mocks.update.mock.calls[0][1]).toMatchObject({ items: [{ price: "price_addon", quantity: 1 }], billing_cycle_anchor: "unchanged", payment_behavior: "pending_if_incomplete" });
    expect(mocks.update.mock.calls[0][1].discounts).toBeUndefined();
    expect(mocks.rpc).toHaveBeenCalledWith("review_sms_record_paid_period", expect.objectContaining({ p_invoice: "in_reviews", p_allowance: 125 }));
  });
  it("refuses a nonzero owner quote before any subscription mutation", async () => {
    ownerSubscription(); mocks.preview.mockResolvedValue({ currency: "usd", amount_due: 5 });
    await expect(quoteReviewSmsRecurring(bid, owner)).rejects.toThrow("review_sms_quote_unavailable");
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("blocks confirmation if the owner discount was removed after the quote", async () => {
    const sub = ownerSubscription();
    const quote = await quoteReviewSmsRecurring(bid, owner);
    sub.discounts = [];
    await expect(confirmReviewSmsRecurring(bid, owner, quote.operationId, quote.fingerprint)).rejects.toThrow("review_sms_owner_discount_unverified");
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("does not charge after a confirmed-before-provider crash and removed owner discount", async () => {
    const sub = ownerSubscription();
    const quote = await quoteReviewSmsRecurring(bid, owner);
    operation!.state = "confirmed";
    sub.discounts = [];
    vi.stubEnv("REVIEW_SMS_OWNER_DISCOUNT_POLICY", "");
    await expect(confirmReviewSmsRecurring(bid, owner, quote.operationId, quote.fingerprint)).rejects.toThrow("review_sms_owner_discount_unverified");
    expect(mocks.invoiceList).toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("uses the frozen discount to recover an unsubmitted confirmed update after new starts are disabled", async () => {
    ownerSubscription(); const quote = await quoteReviewSmsRecurring(bid, owner); operation!.state = "confirmed";
    const updated = ownerSubscription(true); updated.items.data[1].current_period_start = Math.floor(now / 1000);
    updated.latest_invoice = "in_reviews";
    const invoice = paidInvoice(updated, true); invoice.amount_due = 0; invoice.amount_paid = 0; invoice.lines.data[0].amount = 0;
    mocks.retrieve.mockResolvedValue(ownerSubscription());
    vi.stubEnv("REVIEW_SMS_OWNER_DISCOUNT_POLICY", "");
    mocks.update.mockImplementationOnce(async () => { mocks.retrieve.mockResolvedValue(updated); return updated; });
    mocks.invoice.mockResolvedValue(invoice);
    await confirmReviewSmsRecurring(bid, owner, quote.operationId, quote.fingerprint);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("review_sms_record_paid_period", expect.objectContaining({ p_allowance: 125 }));
  });
  it("inspects an already-created invoice before attempting another provider update", async () => {
    ownerSubscription(); const quote = await quoteReviewSmsRecurring(bid, owner); operation!.state = "confirmed";
    const updated = ownerSubscription(true); updated.items.data[1].current_period_start = Math.floor(now / 1000);
    updated.latest_invoice = "in_unrelated";
    const invoice = paidInvoice(updated, true); invoice.amount_due = 0; invoice.amount_paid = 0; invoice.lines.data[0].amount = 0;
    mocks.invoiceList.mockResolvedValue({ data: [invoice, paidInvoice(updated)], has_more: false });
    mocks.invoice.mockResolvedValue(invoice);
    await confirmReviewSmsRecurring(bid, owner, quote.operationId, quote.fingerprint);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledWith("review_sms_record_paid_period", expect.objectContaining({ p_invoice: "in_reviews" }));
  });
  it("does not forget an owner's frozen discount after both live discount and new-start policy disappear", async () => {
    ownerSubscription(); await quoteReviewSmsRecurring(bid, owner); operation!.state = "completed";
    const sub = subscription(true); sub.latest_invoice = "in_reviews";
    vi.stubEnv("REVIEW_SMS_OWNER_DISCOUNT_POLICY", "");
    mocks.retrieve.mockResolvedValue(sub); mocks.invoice.mockResolvedValue(paidInvoice(sub));
    await expect(reconcileReviewSmsSubscription(sub)).rejects.toThrow("review_sms_owner_discount_unverified");
    expect(mocks.rpc.mock.calls.some(([name]) => name === "review_sms_record_paid_period")).toBe(false);
  });
  it("renews a paid zero-total owner invoice with gross item evidence", async () => {
    const sub = ownerSubscription(true); sub.latest_invoice = "in_reviews";
    const invoice = paidInvoice(sub); invoice.amount_due = 0; invoice.amount_paid = 0;
    mocks.invoice.mockResolvedValue(invoice);
    await reconcileReviewSmsSubscription(sub);
    expect(mocks.rpc).toHaveBeenCalledWith("review_sms_record_paid_period", expect.objectContaining({ p_allowance: 250, p_item: "si_addon" }));
  });
  it("retains the owner discount in both cancellation phases", async () => {
    account.state = "active"; ownerSubscription(true);
    mocks.scheduleCreate.mockResolvedValue(cancellationSchedule()); mocks.scheduleUpdate.mockResolvedValue(cancellationSchedule());
    await cancelReviewSmsAtPeriodEnd(bid, owner);
    const phases = mocks.scheduleUpdate.mock.calls[0][1].phases;
    expect(phases[0].discounts).toEqual([{ discount: "di_owner" }]);
    expect(phases[1].discounts).toEqual([{ discount: "di_owner" }]);
    expect(phases[1].items).toHaveLength(1);
  });
  it.each(["operation", "invoice", "amount", "customer", "reason", "created", "unpaid"])("cannot grant zero-dollar access from mismatched %s evidence", async kind => {
    ownerSubscription(); await quoteReviewSmsRecurring(bid, owner); operation!.state = "confirmed"; operation!.invoice_id = "in_reviews";
    const sub = ownerSubscription(true); sub.latest_invoice = "in_unrelated";
    sub.items.data[1].current_period_start = Math.floor(now / 1000);
    const invoice = paidInvoice(sub, true); invoice.amount_due = 0; invoice.amount_paid = 0; invoice.lines.data[0].amount = 0;
    if (kind === "operation") invoice.parent.subscription_details.metadata.review_sms_operation_id = "other";
    if (kind === "invoice") invoice.id = "in_other";
    if (kind === "amount") invoice.amount_due = 1;
    if (kind === "customer") invoice.customer = "cus_other";
    if (kind === "reason") invoice.billing_reason = "subscription_cycle";
    if (kind === "created") invoice.created -= 120;
    if (kind === "unpaid") invoice.status = "open";
    mocks.invoice.mockResolvedValue(invoice);
    if (kind === "unpaid") await reconcileReviewSmsSubscription(sub);
    else await expect(reconcileReviewSmsSubscription(sub)).rejects.toThrow("review_sms_payment_unverified");
    expect(mocks.invoice).toHaveBeenCalledWith("in_reviews");
    expect(mocks.rpc.mock.calls.some(([name]) => name === "review_sms_record_paid_period")).toBe(false);
  });
});
describe("review SMS payment and cancellation recovery", () => {
  it("uses the dedicated activation price with a provider-valid frozen expiry", async () => {
    account.state = "draft";
    account.activation_paid_at = null;
    mocks.price.mockResolvedValue({
      id: "price_activation",
      active: true,
      currency: "usd",
      unit_amount: 2500,
      type: "one_time",
    });
    mocks.checkout.mockResolvedValue({
      id: "cs_review",
      livemode: false,
      mode: "payment",
      customer: "cus_review",
      client_reference_id: bid,
      metadata: activationMetadata(),
      amount_total: 2500, currency: "usd",
      status: "open",
      url: "https://checkout.stripe.com/c/pay/test",
    });
    expect(
      (
        await createReviewSmsActivationCheckout(
          bid,
          owner,
          "https://simplassist.com",
        )
      ).url,
    ).toContain("checkout.stripe.com");
    expect(mocks.price).toHaveBeenCalledWith("price_activation");
    expect(mocks.checkout.mock.calls[0][0]).toMatchObject({
      expires_at: Math.floor(now / 1000) + 86400,
      line_items: [{ price: "price_activation", quantity: 1 }],
    });
  });
  it("requires the fresh canonical subscription binding before recording renewal authority", async () => {
    const incoming = subscription(true),
      fresh = subscription(true);
    fresh.customer = "cus_wrong";
    mocks.retrieve.mockResolvedValue(fresh);
    await expect(reconcileReviewSmsSubscription(incoming)).rejects.toThrow(
      "review_sms_billing_source_changed",
    );
    expect(
      mocks.rpc.mock.calls.some(
        ([name]) => name === "review_sms_record_paid_period",
      ),
    ).toBe(false);
  });
  it("only an exact paid addon invoice line grants full renewal allowance", async () => {
    const sub = subscription(true);
    sub.latest_invoice = "in_reviews";
    mocks.retrieve.mockResolvedValue(sub);
    mocks.invoice.mockResolvedValue(paidInvoice(sub));
    await reconcileReviewSmsSubscription(sub);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "review_sms_record_paid_period",
      expect.objectContaining({
        p_allowance: 250,
        p_item: "si_addon",
        p_invoice: "in_reviews",
        p_start: new Date(start * 1000).toISOString(),
      }),
    );
  });
  it.each([
    "wrong_item",
    "wrong_quantity",
    "short_period",
    "unpaid",
    "pagination",
  ])("does not grant quota from %s invoice evidence", async (bad) => {
    const sub = subscription(true);
    sub.latest_invoice = "in_reviews";
    const invoice = paidInvoice(sub);
    if (bad === "wrong_item")
      invoice.lines.data[0].parent.subscription_item_details.subscription_item =
        "si_other";
    if (bad === "wrong_quantity") invoice.lines.data[0].quantity = 2;
    if (bad === "short_period") invoice.lines.data[0].period.start++;
    if (bad === "unpaid") invoice.status = "open";
    if (bad === "pagination") invoice.lines.has_more = true;
    mocks.retrieve.mockResolvedValue(sub);
    mocks.invoice.mockResolvedValue(invoice);
    await reconcileReviewSmsSubscription(sub);
    expect(
      mocks.rpc.mock.calls.some(
        ([name]) => name === "review_sms_record_paid_period",
      ),
    ).toBe(false);
  });
  it("grants only frozen prorated parts after the exact confirmed invoice is paid", async () => {
    const quote = await quoteReviewSmsRecurring(bid, owner);
    operation!.state = "confirmed";
    const sub = subscription(true);
    sub.latest_invoice = "in_reviews";
    sub.metadata.review_sms_operation_id = oid;
    sub.items.data[1].current_period_start = Math.floor(now / 1000);
    mocks.retrieve.mockResolvedValue(sub);
    mocks.invoice.mockResolvedValue(paidInvoice(sub, true));
    mocks.invoiceList.mockResolvedValue({ data: [paidInvoice(sub, true)], has_more: false });
    await reconcileReviewSmsSubscription(sub);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "review_sms_record_paid_period",
      expect.objectContaining({
        p_allowance: quote.includedParts,
        p_start: new Date(now).toISOString(),
      }),
    );
  });
  it("recovers a lost schedule-create response through the same provider key", async () => {
    account.state = "active";
    const sub = subscription(true);
    mocks.retrieve.mockResolvedValue(sub);
    mocks.scheduleCreate
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValue(cancellationSchedule());
    await expect(cancelReviewSmsAtPeriodEnd(bid, owner)).rejects.toThrow(
      "response lost",
    );
    operation!.state = "confirmed";
    sub.schedule = "sub_sched_review";
    mocks.scheduleUpdate.mockResolvedValue(cancellationSchedule());
    expect((await cancelReviewSmsAtPeriodEnd(bid, owner)).cancelAt).toBe(
      new Date(end * 1000).toISOString(),
    );
    expect(mocks.scheduleCreate.mock.calls[0]).toEqual(
      mocks.scheduleCreate.mock.calls[1],
    );
    expect(mocks.scheduleCreate.mock.calls[0][1]).toEqual({
      idempotencyKey: `review-sms-cancel:${oid}`,
    });
  });
  it("replays frozen cancellation parameters and preserves base price, taxes and metadata", async () => {
    account.state = "active";
    const sub = subscription(true);
    mocks.retrieve.mockResolvedValue(sub);
    mocks.scheduleCreate.mockResolvedValue(cancellationSchedule());
    mocks.scheduleUpdate
      .mockRejectedValueOnce(new Error("update response lost"))
      .mockResolvedValue(cancellationSchedule());
    await expect(cancelReviewSmsAtPeriodEnd(bid, owner)).rejects.toThrow(
      "update response lost",
    );
    sub.schedule = "sub_sched_review";
    sub.metadata.changed_after_submission = "unrelated";
    await cancelReviewSmsAtPeriodEnd(bid, owner);
    expect(mocks.scheduleUpdate.mock.calls[0]).toEqual(
      mocks.scheduleUpdate.mock.calls[1],
    );
    expect(mocks.scheduleCreate).toHaveBeenCalledTimes(1);
    const phases = mocks.scheduleUpdate.mock.calls[0][1].phases;
    expect(phases[0].items).toEqual([
      { price: "price_chat", quantity: 1, tax_rates: ["txr_base"] },
      { price: "price_addon", quantity: 1, tax_rates: ["txr_review"] },
    ]);
    expect(phases[1].items).toEqual([
      { price: "price_chat", quantity: 1, tax_rates: ["txr_base"] },
    ]);
    expect(phases[0].metadata.phase_note).toBe("preserve");
  });
  it("does not cancel an unrelated existing schedule", async () => {
    account.state = "active";
    const sub = subscription(true);
    sub.schedule = "sub_sched_unrelated";
    mocks.retrieve.mockResolvedValue(sub);
    await expect(cancelReviewSmsAtPeriodEnd(bid, owner)).rejects.toThrow(
      "review_sms_subscription_not_changeable",
    );
    expect(mocks.scheduleCreate).not.toHaveBeenCalled();
    expect(mocks.scheduleUpdate).not.toHaveBeenCalled();
  });
});

function activationMetadata() {
  return { business_id: bid, review_sms_account_id: aid, review_sms_operation_id: oid };
}
function activationPayload(amount = 4900) {
  return { feeId: amount === 4900 ? "price_historical" : "price_activation", amountCents: amount,
    customerId: "cus_review", subscriptionId: "sub_review", origin: "https://simplassist.com" };
}
function paidActivation(amount = 4900) {
  operation = { id: oid, account_id: aid, business_id: bid, owner_id: owner, kind: "activation", state: "completed",
    fingerprint: "old", payload: activationPayload(amount), checkout_session_id: "cs_review", invoice_id: null,
    schedule_id: null, created_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 1000).toISOString() };
  const session = { id: "cs_review", livemode: false, mode: "payment", customer: "cus_review", client_reference_id: bid,
    metadata: activationMetadata(), currency: "usd", amount_total: amount, status: "complete", payment_status: "paid",
    payment_intent: "pi_activation" } as unknown as Stripe.Checkout.Session;
  mocks.checkoutGet.mockResolvedValue(session);
  mocks.payment.mockResolvedValue({ id: "pi_activation", livemode: false, status: "succeeded", currency: "usd",
    amount, amount_received: amount, customer: "cus_review", metadata: activationMetadata() });
  mocks.checkoutLines.mockResolvedValue({ has_more: false, data: [{ quantity: 1, amount_total: amount,
    price: { id: activationPayload(amount).feeId, unit_amount: amount, currency: "usd", type: "one_time" } }] });
  return session;
}
describe("activation price history and replacement", () => {
  it.each([2500,4900])("verifies and replays an original %i receipt after the current price changes", async amount => {
    const session = paidActivation(amount);
    expect(await synchronizeReviewSmsCheckout(session)).toBe(true);
    expect(await synchronizeReviewSmsCheckout(session)).toBe(true);
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect(updates.some(u => u.patch.state === "completed")).toBe(true);
  });
  it.each([2500,4900])("refunds the original %i payment in full", async amount => {
    paidActivation(amount);
    expect(await refundUnsubmittedReviewSmsActivation(bid,owner)).toEqual({ refunded: true });
    expect(mocks.refund).toHaveBeenCalledWith(expect.objectContaining({ payment_intent:"pi_activation",amount }),expect.anything());
  });
  it("rejects the wrong immutable Stripe Price even when the amount is the same", async () => {
    const session = paidActivation();
    mocks.checkoutLines.mockResolvedValue({ has_more:false,data:[{quantity:1,amount_total:4900,price:{id:"price_other",unit_amount:4900,currency:"usd",type:"one_time"}}] });
    await expect(synchronizeReviewSmsCheckout(session)).rejects.toThrow("review_sms_activation_receipt_unverified");
    expect(updates).toHaveLength(0);
  });
  it("reconciles a completed old checkout instead of creating a replacement charge", async () => {
    paidActivation(); operation!.state="confirmed"; account.activation_paid_at=null;
    mocks.price.mockResolvedValue({active:true,currency:"usd",unit_amount:2500,type:"one_time"});
    expect(await createReviewSmsActivationCheckout(bid,owner,"https://simplassist.com")).toEqual({paid:true});
    expect(mocks.checkout).not.toHaveBeenCalled();expect(mocks.checkoutExpire).not.toHaveBeenCalled();
  });
  it("completion racing expiration retains the old payment", async () => {
    const complete=paidActivation(); operation!.state="confirmed"; account.activation_paid_at=null;
    mocks.price.mockResolvedValue({active:true,currency:"usd",unit_amount:2500,type:"one_time"});
    mocks.checkoutGet.mockResolvedValueOnce({...complete,status:"open",payment_status:"unpaid"}).mockResolvedValue(complete);
    mocks.checkoutExpire.mockRejectedValue(new Error("already complete"));
    expect(await createReviewSmsActivationCheckout(bid,owner,"https://simplassist.com")).toEqual({paid:true});
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it("never replaces an old checkout whose expiration is unverified", async () => {
    const complete=paidActivation(); operation!.state="confirmed"; account.activation_paid_at=null;
    mocks.price.mockResolvedValue({active:true,currency:"usd",unit_amount:2500,type:"one_time"});
    mocks.checkoutGet.mockResolvedValue({...complete,status:"open",payment_status:"unpaid"});
    mocks.checkoutExpire.mockRejectedValue(new Error("network"));
    await expect(createReviewSmsActivationCheckout(bid,owner,"https://simplassist.com")).rejects.toThrow("review_sms_recovery_required");
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect(updates.some(u=>u.patch.state==="expired")).toBe(false);
  });
  it("does not replay an unknown historical operation after Stripe's idempotency window", async () => {
    paidActivation(); operation!.state="unknown"; operation!.checkout_session_id=null;
    operation!.created_at=new Date(now-24*3600_000).toISOString(); account.activation_paid_at=null;
    mocks.price.mockResolvedValue({active:true,currency:"usd",unit_amount:2500,type:"one_time"});
    await expect(createReviewSmsActivationCheckout(bid,owner,"https://simplassist.com")).rejects.toThrow("review_sms_recovery_required");
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
});

const sharedProof = { registrationId: "50000000-0000-4000-8000-000000000098", identityVersion: 1, membershipRevision: 2, brandId: "brand_shared" };
function newActivation() {
  account.state = "draft"; account.activation_paid_at = null;
  mocks.price.mockResolvedValue({ id: "price_activation", active: true, currency: "usd", unit_amount: 2500, type: "one_time" });
  mocks.checkout.mockResolvedValue({ id: "cs_review", livemode: false, mode: "payment", customer: "cus_review", client_reference_id: bid,
    metadata: activationMetadata(), amount_total: 2500, currency: "usd", status: "open", url: "https://checkout.stripe.com/c/pay/test" });
}
describe("shared registration activation authority", () => {
  it("freezes the approved identity and membership revision before authorizing the $25 Checkout", async () => {
    newActivation(); mocks.sharedNewStart.mockResolvedValue(sharedProof);
    await createReviewSmsActivationCheckout(bid, owner, "https://simplassist.com");
    expect(operation?.payload).toMatchObject({ amountCents: 2500, sharedRegistration: sharedProof });
    expect(mocks.sharedNewStart).toHaveBeenCalledWith({ businessId: bid, ownerId: owner });
    expect(mocks.sharedValidate).toHaveBeenCalledWith({ businessId: bid, ownerId: owner, proof: sharedProof });
    expect(mocks.sharedValidate.mock.invocationCallOrder[0]).toBeLessThan(mocks.checkout.mock.invocationCallOrder[0]);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("does not create a fee Checkout when staging or capacity approval is unavailable", async () => {
    newActivation();
    const { SharedRegistrationError } = await import("@/lib/messaging/sharedBusinessRegistrations.server");
    mocks.sharedNewStart.mockRejectedValue(new SharedRegistrationError("shared_campaign_capacity_exhausted"));
    await expect(createReviewSmsActivationCheckout(bid, owner, "https://simplassist.com")).rejects.toMatchObject({ name: "ReviewSmsError", code: "shared_campaign_capacity_exhausted" });
    expect(mocks.checkout).not.toHaveBeenCalled(); expect(mocks.price).not.toHaveBeenCalled(); expect(operation).toBeNull();
  });
  it("recovers an already-paid shared Checkout after its membership was revoked", async () => {
    const session = paidActivation(2500); operation!.state = "confirmed"; account.activation_paid_at = null;
    operation!.payload = { ...activationPayload(2500), sharedRegistration: sharedProof };
    mocks.sharedNewStart.mockRejectedValue(new Error("admissions stopped")); mocks.sharedValidate.mockRejectedValue(new Error("revoked"));
    expect(await createReviewSmsActivationCheckout(bid, owner, "https://simplassist.com")).toEqual({ paid: true });
    expect(mocks.checkoutGet).toHaveBeenCalledWith(session.id);
    expect(mocks.sharedNewStart).not.toHaveBeenCalled(); expect(mocks.sharedValidate).not.toHaveBeenCalled(); expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it("recovers the same pending shared Checkout while new paid starts are disabled", async () => {
    paidActivation(2500); operation!.state = "confirmed"; account.activation_paid_at = null;
    operation!.payload = { ...activationPayload(2500), sharedRegistration: sharedProof };
    mocks.checkoutGet.mockResolvedValue({ id: "cs_review", livemode: false, mode: "payment", customer: "cus_review", client_reference_id: bid,
      metadata: activationMetadata(), amount_total: 2500, currency: "usd", status: "open", url: "https://checkout.stripe.com/c/pay/test" });
    mocks.sharedNewStart.mockRejectedValue(new Error("admissions stopped"));
    expect(await createReviewSmsActivationCheckout(bid, owner, "https://simplassist.com")).toHaveProperty("url");
    expect(mocks.sharedValidate).toHaveBeenCalledWith({ businessId: bid, ownerId: owner, proof: sharedProof });
    expect(mocks.sharedNewStart).not.toHaveBeenCalled(); expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it("does not create a Checkout after its frozen membership revision stops matching", async () => {
    paidActivation(2500); operation!.state = "confirmed"; operation!.checkout_session_id = null; account.activation_paid_at = null;
    operation!.payload = { ...activationPayload(2500), sharedRegistration: sharedProof };
    mocks.sharedValidate.mockRejectedValue(new Error("revision changed"));
    await expect(createReviewSmsActivationCheckout(bid, owner, "https://simplassist.com")).rejects.toThrow("revision changed");
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it("still refunds the original shared activation before any actual paid provider work", async () => {
    paidActivation(2500); operation!.payload = { ...activationPayload(2500), sharedRegistration: sharedProof };
    mocks.sharedValidate.mockRejectedValue(new Error("revoked")); mocks.sharedNewStart.mockRejectedValue(new Error("stopped"));
    mocks.refund.mockResolvedValue({ status: "succeeded" });
    await refundUnsubmittedReviewSmsActivation(bid, owner);
    expect(mocks.refund).toHaveBeenCalledWith(expect.objectContaining({ amount: 2500 }), expect.anything());
    expect(mocks.sharedValidate).not.toHaveBeenCalled(); expect(mocks.sharedNewStart).not.toHaveBeenCalled();
  });
  it("blocks a new monthly payment after the original shared approval is revoked", async () => {
    const quote = await quoteReviewSmsRecurring(bid, owner);
    mocks.sharedContext.mockResolvedValue({ membership: { owner_id: owner } });
    // Simulate the service-only paid activation lookup separately from the quote.
    const original = mocks.from.getMockImplementation()!;
    mocks.from.mockImplementation((table: string) => {
      if (table !== "review_sms_billing_operations") return original(table);
      const q = original(table); const order = q.order;
      q.order = () => { q.maybeSingle = async () => ({ data: { ...operation, kind: "activation", state: "completed", payload: { ...activationPayload(2500), sharedRegistration: sharedProof } }, error: null }); return order(); };
      return q;
    });
    mocks.sharedValidate.mockRejectedValue(new Error("membership revoked"));
    await expect(confirmReviewSmsRecurring(bid, owner, quote.operationId, quote.fingerprint)).rejects.toThrow("membership revoked");
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("shared activation presentation authority", () => {
  function stagedOverview() {
    account.activation_paid_at = null; account.state = "activation_pending";
    mocks.entitlements.mockResolvedValue({ plan: "chat_only", source: "subscription" });
    mocks.sharedContext.mockResolvedValue({ registration: { legal_business_name: "Example LLC", identity_version: 1, status: "active", brand_status: "approved" }, membership: { owner_id: owner, status: "approved" } });
  }
  it.each(["confirmed", "unknown"])("keeps %s activation recovery visible after new paid starts are stopped", async state => {
    stagedOverview(); operation = { state }; mocks.sharedPilot.mockReturnValue(false);
    expect((await reviewSmsOverview(bid, owner)).sharedRegistration).toMatchObject({ newPaidStartsAllowed: false, activationRecoveryAvailable: true });
    expect(mocks.checkout).not.toHaveBeenCalled(); expect(updates).toHaveLength(0);
  });
  it.each(["prepared", "completed", "expired"])("does not offer %s as an existing payment recovery", async state => {
    stagedOverview(); operation = { state }; mocks.sharedPilot.mockReturnValue(false);
    expect((await reviewSmsOverview(bid, owner)).sharedRegistration).toMatchObject({ newPaidStartsAllowed: false, activationRecoveryAvailable: false });
  });
  it("advertises a new shared payment only when its paid-start pilot is enabled", async () => {
    stagedOverview(); operation = null; mocks.sharedPilot.mockReturnValue(true);
    expect((await reviewSmsOverview(bid, owner)).sharedRegistration).toMatchObject({ newPaidStartsAllowed: true, activationRecoveryAvailable: false });
    expect(mocks.sharedPilot).toHaveBeenCalledWith(bid, "paid_start");
    expect(mocks.sharedNewStart).not.toHaveBeenCalled(); expect(mocks.checkout).not.toHaveBeenCalled();
  });
});
