import "server-only";

import type Stripe from "stripe";
import { stripe } from "@/lib/stripe/client";
import { normalizeGiftCode, type GiftOffer } from "./code";

/**
 * The only facts about a promotion code that leave the server: what it gives
 * and when it stops working. Redemption counts, limits, the coupon's name and
 * every other Stripe detail stay here.
 */
export type GiftCodeLookup =
  | {
      status: "available";
      /** The code as Bryan wrote it in Stripe. */
      code: string;
      promotionCodeId: string;
      offer: GiftOffer;
      expiresAt: string | null;
    }
  /** Unknown, expired, used up or switched off. Deliberately one answer. */
  | { status: "unavailable" }
  /** Stripe could not be reached, so nothing is known about the code. */
  | { status: "error" };

const UNAVAILABLE: GiftCodeLookup = { status: "unavailable" };

function offerFromCoupon(coupon: Stripe.Coupon): GiftOffer | null {
  const duration = coupon.duration;
  if (duration !== "once" && duration !== "repeating" && duration !== "forever") {
    return null;
  }
  const months = duration === "repeating" ? coupon.duration_in_months : null;
  if (typeof coupon.percent_off === "number" && coupon.percent_off > 0) {
    return { kind: "percent", percentOff: coupon.percent_off, duration, months };
  }
  if (
    typeof coupon.amount_off === "number" &&
    coupon.amount_off > 0 &&
    typeof coupon.currency === "string"
  ) {
    return {
      kind: "amount",
      amountOff: coupon.amount_off,
      currency: coupon.currency,
      duration,
      months,
    };
  }
  return null;
}

function evaluate(
  promotionCode: Stripe.PromotionCode,
  nowSeconds: number,
): GiftCodeLookup {
  const coupon = promotionCode.promotion?.coupon;
  if (
    !promotionCode.active ||
    // A code tied to one Stripe customer is not something to hand around.
    promotionCode.customer ||
    promotionCode.customer_account ||
    (promotionCode.expires_at !== null && promotionCode.expires_at <= nowSeconds) ||
    (promotionCode.max_redemptions !== null &&
      promotionCode.times_redeemed >= promotionCode.max_redemptions) ||
    !/^promo_[A-Za-z0-9]+$/.test(promotionCode.id) ||
    !coupon ||
    typeof coupon === "string" ||
    !coupon.valid
  ) {
    return UNAVAILABLE;
  }
  const offer = offerFromCoupon(coupon);
  if (!offer) return UNAVAILABLE;
  return {
    status: "available",
    code: promotionCode.code,
    promotionCodeId: promotionCode.id,
    offer,
    expiresAt:
      promotionCode.expires_at === null
        ? null
        : new Date(promotionCode.expires_at * 1000).toISOString(),
  };
}

/** Asks Stripe whether a code can be used right now. Never throws. */
export async function lookupGiftCode(value: unknown): Promise<GiftCodeLookup> {
  const code = normalizeGiftCode(value);
  if (!code) return UNAVAILABLE;

  let found: Stripe.PromotionCode[];
  try {
    const list = await stripe.promotionCodes.list({
      code,
      active: true,
      limit: 10,
      expand: ["data.promotion.coupon"],
    });
    found = list.data;
  } catch {
    console.error("[gift] promotion code lookup failed");
    return { status: "error" };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  for (const promotionCode of found) {
    // Stripe matches the code without regard to case; keep that, but never
    // accept a different code that merely came back in the same list.
    if (promotionCode.code.toLowerCase() !== code.toLowerCase()) continue;
    const result = evaluate(promotionCode, nowSeconds);
    if (result.status === "available") return result;
  }
  return UNAVAILABLE;
}

/**
 * For Checkout: the Stripe id of the first carried code that still works, or
 * null. A stale, mistyped or unreachable code simply means "no discount
 * pre-applied"; it must never stop a customer from paying.
 */
export async function resolveCarriedPromotionCodeId(
  codes: readonly string[],
): Promise<string | null> {
  for (const code of codes.slice(0, 2)) {
    try {
      const result = await lookupGiftCode(code);
      if (result.status === "available") return result.promotionCodeId;
    } catch {
      // Treated the same as an unusable code.
    }
  }
  return null;
}
