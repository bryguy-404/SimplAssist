import "server-only";
import type Stripe from "stripe";
import { z } from "zod";
import { ReviewSmsError } from "@/lib/billing/reviewSms";
import { stripe } from "./client";

const id = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : value?.id ?? null;
const policySchema = z.object({
  businessId: z.string().uuid(), ownerId: z.string().uuid(),
  customerId: z.string().startsWith("cus_"), subscriptionId: z.string().startsWith("sub_"),
  couponId: z.string().min(1),
}).strict();
export const reviewSmsOwnerDiscountProofSchema = policySchema.extend({
  version: z.literal(1), discountId: z.string().min(1),
  chatProductId: z.string().startsWith("prod_"), addonProductId: z.string().startsWith("prod_"),
  excludedProductIds: z.array(z.string().startsWith("prod_")).min(1),
});
export type ReviewSmsOwnerDiscountProof = z.infer<typeof reviewSmsOwnerDiscountProofSchema>;
type Binding = { businessId: string; ownerId: string };

export function reviewSmsOwnerDiscountPolicy(binding: Binding) {
  try {
    const result = policySchema.safeParse(JSON.parse(process.env.REVIEW_SMS_OWNER_DISCOUNT_POLICY ?? "null"));
    return result.success && result.data.businessId === binding.businessId && result.data.ownerId === binding.ownerId
      ? result.data : null;
  } catch { return null; }
}
function unavailable(): never { throw new ReviewSmsError("review_sms_owner_discount_unverified", 409); }

/** Only an already-applied, exact owner subscription discount is supported.
 * Frozen proof permits recovery after new-start configuration is disabled. */
export async function verifyReviewSmsOwnerDiscount(
  sub: Stripe.Subscription, binding: Binding, addonPrice: Stripe.Price,
  frozen?: unknown,
): Promise<ReviewSmsOwnerDiscountProof | null> {
  const parsed = frozen === undefined ? null : reviewSmsOwnerDiscountProofSchema.safeParse(frozen);
  if (parsed && !parsed.success) return unavailable();
  const previous = parsed?.success ? parsed.data : null;
  const policy = previous ?? reviewSmsOwnerDiscountPolicy(binding);
  if (sub.items.data.some(item => item.discounts?.length)) return unavailable();
  if (!sub.discounts.length && !policy) return null;
  if (!policy || policy.businessId !== binding.businessId || policy.ownerId !== binding.ownerId ||
    policy.customerId !== id(sub.customer) || policy.subscriptionId !== sub.id ||
    sub.metadata.business_id !== binding.businessId || sub.discounts.length !== 1) return unavailable();
  const discount = sub.discounts[0];
  if (typeof discount === "string" || discount.deleted || id(discount.customer) !== policy.customerId ||
    discount.subscription !== sub.id || discount.subscription_item || discount.invoice || discount.invoice_item ||
    discount.checkout_session || discount.end !== null || discount.source.type !== "coupon" ||
    id(discount.source.coupon) !== policy.couponId || (previous && discount.id !== previous.discountId)) return unavailable();
  // `valid` concerns new redemption; an exhausted one-use coupon still applies
  // to its existing discount. Retrieve applies_to explicitly on Clover.
  const coupon = await stripe.coupons.retrieve(policy.couponId, { expand: ["applies_to"] });
  const base = sub.items.data.find(item => item.price.id !== addonPrice.id);
  const chatProductId = id(base?.price.product), addonProductId = id(addonPrice.product);
  if (coupon.id !== policy.couponId || coupon.livemode !== sub.livemode || coupon.percent_off !== 100 ||
    coupon.amount_off !== null || coupon.duration !== "forever" || !chatProductId || !addonProductId ||
    !coupon.applies_to?.products.includes(chatProductId) || !coupon.applies_to.products.includes(addonProductId)) return unavailable();
  let excludedProductIds = previous?.excludedProductIds;
  if (!excludedProductIds) {
    const priceIds = [process.env.STRIPE_PRICE_REVIEW_SMS_ACTIVATION, process.env.STRIPE_PRICE_SMS_OVERAGE_PART];
    if (priceIds.some(priceId => !priceId?.startsWith("price_"))) return unavailable();
    const excluded = await Promise.all(priceIds.map(priceId => stripe.prices.retrieve(priceId!)));
    excludedProductIds = Array.from(new Set(excluded.map(price => id(price.product)))).filter((value): value is string => Boolean(value)).sort();
    if (excluded.some(price => !id(price.product)) || !excludedProductIds.length) return unavailable();
  }
  if (excludedProductIds.some(productId => coupon.applies_to!.products.includes(productId)) ||
    (previous && (previous.chatProductId !== chatProductId || previous.addonProductId !== addonProductId))) return unavailable();
  return { version: 1, businessId: binding.businessId, ownerId: binding.ownerId,
    customerId: policy.customerId, subscriptionId: sub.id, couponId: coupon.id,
    discountId: discount.id, chatProductId, addonProductId, excludedProductIds };
}

/** Expansion changes must not invalidate an otherwise unchanged quote. */
export function normalizedReviewSmsSubscription(sub: Stripe.Subscription): Stripe.Subscription {
  return { ...sub, discounts: sub.discounts.map(discount => id(discount)!),
    items: { ...sub.items, data: sub.items.data.map(item => ({ ...item, discounts: item.discounts?.map(discount => id(discount)!) })) } };
}
