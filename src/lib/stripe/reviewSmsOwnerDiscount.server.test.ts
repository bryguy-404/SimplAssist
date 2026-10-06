import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ coupon: vi.fn(), price: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./client", () => ({ stripe: { coupons: { retrieve: mocks.coupon }, prices: { retrieve: mocks.price } } }));
import { normalizedReviewSmsSubscription, verifyReviewSmsOwnerDiscount } from "./reviewSmsOwnerDiscount.server";
const policy = { businessId: "10000000-0000-4000-8000-000000000099", ownerId: "20000000-0000-4000-8000-000000000099", customerId: "cus_owner", subscriptionId: "sub_owner", couponId: "owner_coupon" };
const addon = { id: "price_addon", product: "prod_addon" } as Stripe.Price;
let sub: Stripe.Subscription;
let coupon: Stripe.Coupon;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("REVIEW_SMS_OWNER_DISCOUNT_POLICY", JSON.stringify(policy));
  vi.stubEnv("STRIPE_PRICE_REVIEW_SMS_ACTIVATION", "price_setup");
  vi.stubEnv("STRIPE_PRICE_SMS_OVERAGE_PART", "price_overage");
  sub = { id: policy.subscriptionId, customer: policy.customerId, livemode: false, metadata: { business_id: policy.businessId },
    discounts: [{ id: "di_owner", source: { type: "coupon", coupon: policy.couponId }, customer: policy.customerId, subscription: policy.subscriptionId,
      end: null, subscription_item: null, invoice: null, invoice_item: null, checkout_session: null }],
    items: { data: [{ id: "si_chat", price: { id: "price_chat", product: "prod_chat" }, discounts: [] }] },
  } as unknown as Stripe.Subscription;
  coupon = { id: policy.couponId, livemode: false, percent_off: 100, amount_off: null, duration: "forever", valid: false,
    applies_to: { products: ["prod_chat", "prod_addon", "prod_growth"] } } as Stripe.Coupon;
  mocks.coupon.mockImplementation(async () => coupon);
  mocks.price.mockImplementation(async price => ({ id: price, product: price === "price_setup" ? "prod_setup" : "prod_overage" }));
});
afterEach(() => vi.unstubAllEnvs());
describe("private review SMS owner discount", () => {
  it("accepts an already redeemed, max-one coupon without treating it as a new redemption", async () => {
    const proof = await verifyReviewSmsOwnerDiscount(sub, policy, addon);
    expect(proof).toMatchObject({ ...policy, version: 1, discountId: "di_owner", chatProductId: "prod_chat", addonProductId: "prod_addon", excludedProductIds: ["prod_overage", "prod_setup"] });
    expect(mocks.coupon).toHaveBeenCalledWith(policy.couponId, { expand: ["applies_to"] });
  });
  it.each(["businessId", "ownerId", "customerId", "subscriptionId", "couponId"])("rejects the wrong %s", async field => {
    vi.stubEnv("REVIEW_SMS_OWNER_DISCOUNT_POLICY", JSON.stringify({ ...policy, [field]: field.endsWith("Id") && ["businessId", "ownerId"].includes(field) ? "30000000-0000-4000-8000-000000000099" : "other" }));
    await expect(verifyReviewSmsOwnerDiscount(sub, policy, addon)).rejects.toThrow("review_sms_owner_discount_unverified");
  });
  it.each(["", "{bad", "{}"])("fails closed for a discounted subscription without valid configuration (%s)", async value => {
    vi.stubEnv("REVIEW_SMS_OWNER_DISCOUNT_POLICY", value);
    await expect(verifyReviewSmsOwnerDiscount(sub, policy, addon)).rejects.toThrow("review_sms_owner_discount_unverified");
  });
  it.each(["partial", "once", "missing_addon", "setup", "usage", "unrestricted", "mode", "stacked", "item", "customer", "expired", "unexpanded", "removed"])("rejects %s discount changes", async kind => {
    const discount = sub.discounts[0] as Stripe.Discount;
    if (kind === "partial") coupon.percent_off = 50;
    if (kind === "once") coupon.duration = "once";
    if (kind === "missing_addon") coupon.applies_to!.products = ["prod_chat"];
    if (kind === "setup") coupon.applies_to!.products.push("prod_setup");
    if (kind === "usage") coupon.applies_to!.products.push("prod_overage");
    if (kind === "unrestricted") delete coupon.applies_to;
    if (kind === "mode") coupon.livemode = true;
    if (kind === "stacked") sub.discounts.push({ ...discount, id: "di_second" });
    if (kind === "item") sub.items.data[0].discounts = [discount];
    if (kind === "customer") discount.subscription = null;
    if (kind === "expired") discount.end = 123;
    if (kind === "unexpanded") sub.discounts = ["di_owner"];
    if (kind === "removed") sub.discounts = [];
    await expect(verifyReviewSmsOwnerDiscount(sub, policy, addon)).rejects.toThrow("review_sms_owner_discount_unverified");
  });
  it("keeps recovery possible after new starts are disabled, with the frozen exact discount", async () => {
    const proof = await verifyReviewSmsOwnerDiscount(sub, policy, addon);
    vi.stubEnv("REVIEW_SMS_OWNER_DISCOUNT_POLICY", "");
    expect(await verifyReviewSmsOwnerDiscount(sub, policy, addon, proof)).toEqual(proof);
    (sub.discounts[0] as Stripe.Discount).id = "di_replaced";
    await expect(verifyReviewSmsOwnerDiscount(sub, policy, addon, proof)).rejects.toThrow("review_sms_owner_discount_unverified");
  });
  it("leaves ordinary subscriptions unchanged when the private policy is absent", async () => {
    sub.discounts = [];
    vi.stubEnv("REVIEW_SMS_OWNER_DISCOUNT_POLICY", "");
    expect(await verifyReviewSmsOwnerDiscount(sub, policy, addon)).toBeNull();
    expect(mocks.coupon).not.toHaveBeenCalled();
  });
  it("normalizes expanded discounts to stable identifiers", () => {
    expect(normalizedReviewSmsSubscription(sub).discounts).toEqual(["di_owner"]);
    sub.discounts = ["di_owner"];
    expect(normalizedReviewSmsSubscription(sub).discounts).toEqual(["di_owner"]);
  });
});
