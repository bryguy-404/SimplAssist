import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { GiftCard, type GiftCardState } from "@/components/gift/GiftCard";
import { GiftPageShell } from "@/components/gift/GiftPageShell";
import { resolveStrictAuthCallbackOrigin } from "@/lib/auth/callbackOrigin.server";
import { giftPagePath, normalizeGiftCode } from "@/lib/gift/code";
import { lookupGiftCodeForPublicPage } from "@/lib/gift/lookup.server";

/**
 * /gift/<code> — the coupon page Bryan links a customer to. It shows what a
 * Stripe promotion code gives, lets them copy it, and starts signup with the
 * code remembered so it is already applied at checkout.
 *
 * Public and unlisted: no sign-in, kept out of search engines, and it only
 * ever reveals what the code gives and when it expires.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your SimplAssist gift",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function GiftPage({ params }: { params: { code: string } }) {
  // SimplAssist's own customers only: partner (white-label) domains have no
  // public signup, so the coupon page does not exist there.
  let direct = false;
  try {
    const host = await resolveStrictAuthCallbackOrigin(headers().get("host"));
    direct = host?.kind === "direct";
  } catch {
    direct = false;
  }
  if (!direct) notFound();

  const code = normalizeGiftCode(params.code);
  const result = code
    ? await lookupGiftCodeForPublicPage(code)
    : ({ status: "unavailable" } as const);

  const state: GiftCardState =
    result.status === "available"
      ? {
          kind: "available",
          code: result.code,
          offer: result.offer,
          expiresAt: result.expiresAt,
        }
      : { kind: result.status };

  return (
    <GiftPageShell>
      <GiftCard
        state={state}
        startHref={
          result.status === "available"
            ? `${giftPagePath(result.code)}/start`
            : "/signup"
        }
      />
    </GiftPageShell>
  );
}
