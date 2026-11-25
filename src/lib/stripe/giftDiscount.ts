/**
 * Pre-applying a carried gift code (a Stripe promotion code) to Checkout.
 *
 * Stripe refuses `allow_promotion_codes` together with `discounts` on one
 * Session, so a Session is created one of two ways: with the gift already
 * applied, or (as always before) with Stripe's own "Add promotion code" field.
 */

const PROMOTION_CODE_ID_PATTERN = /^promo_[A-Za-z0-9]+$/;

/** A Stripe promotion code id, or null for anything else. */
export function promotionCodeIdOrNull(value: unknown): string | null {
  return typeof value === "string" && PROMOTION_CODE_ID_PATTERN.test(value)
    ? value
    : null;
}

/**
 * True when Stripe understood the request and said no, which for a Session
 * that differs from the usual one only by its discount means the code stopped
 * being usable. The caller then creates the usual Session instead, so a stale
 * code never blocks payment. Network failures, rate limits and a replay that
 * is still in flight are not rejections and keep their existing handling.
 */
export function isRejectedDiscountRequest(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "StripeInvalidRequestError" &&
    !("code" in error && error.code === "idempotency_key_in_use")
  );
}
