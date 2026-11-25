import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  adminMutationJson,
  authorizeAdminMutation,
  readAdminMutationJson,
} from "@/lib/admin/adminMutation.server";
import { getCanonicalAppOrigin } from "@/lib/branding/defaultBrand";
import { sendGiftCodeEmail } from "@/lib/email/giftCode";
import { cleanFirstName, renderGiftCodeEmail } from "@/lib/email/giftCodeTemplate";
import { describeGiftOffer, giftStartPath } from "@/lib/gift/code";
import { lookupGiftCode } from "@/lib/gift/lookup.server";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * POST /api/admin/gift-codes — preview or send the coupon email.
 *
 * Admin only (the isolated admin sign-in, canonical host, same-origin JSON).
 * Both actions check the code with Stripe first, so Bryan cannot send a code
 * that does not work. A send is written to gift_code_sends before the email
 * leaves: if the record cannot be written, nothing is sent.
 */

export const dynamic = "force-dynamic";

const payloadSchema = z
  .object({
    action: z.enum(["preview", "send"]),
    email: z.string().trim().toLowerCase().email().max(254),
    firstName: z.string().max(80).nullish(),
    code: z.string().trim().min(3).max(64),
    /** Send even though this person was already sent this code. */
    sendAgain: z.boolean().optional(),
  })
  .strict();

export async function POST(request: NextRequest) {
  const authorization = await authorizeAdminMutation(request);
  if ("response" in authorization) return authorization.response;
  const { admin } = authorization;

  const body = await readAdminMutationJson(request);
  if (!body.ok) return body.response;
  const parsed = payloadSchema.safeParse(body.value);
  if (!parsed.success) {
    return adminMutationJson(
      {
        error: "invalid_request",
        message: "Check the email address and the code, then try again.",
      },
      { status: 400 },
    );
  }
  const { action, email, sendAgain } = parsed.data;
  const firstName = cleanFirstName(parsed.data.firstName);

  const lookup = await lookupGiftCode(parsed.data.code);
  if (lookup.status === "error") {
    return adminMutationJson(
      {
        error: "stripe_unavailable",
        message: "Stripe could not be reached to check the code. Nothing was sent. Try again in a minute.",
      },
      { status: 502 },
    );
  }
  if (lookup.status === "unavailable") {
    return adminMutationJson(
      {
        error: "code_unavailable",
        message:
          "Stripe has no active promotion code with that name. It may be mistyped, expired, used up, or limited to one customer. Nothing was sent.",
      },
      { status: 422 },
    );
  }

  const startUrl = `${getCanonicalAppOrigin()}${giftStartPath(lookup.code)}`;
  const rendered = renderGiftCodeEmail({
    firstName,
    code: lookup.code,
    offer: lookup.offer,
    expiresAt: lookup.expiresAt,
    startUrl,
  });
  const offerSummary = describeGiftOffer(lookup.offer);

  if (action === "preview") {
    return adminMutationJson({
      ok: true,
      preview: {
        to: email,
        code: lookup.code,
        offer: offerSummary,
        expiresAt: lookup.expiresAt,
        subject: rendered.subject,
        html: rendered.html,
      },
    });
  }

  if (!sendAgain) {
    const earlier = await supabaseAdmin
      .from("gift_code_sends")
      .select("sent_at")
      .eq("recipient_email", email)
      .eq("code", lookup.code)
      .eq("status", "sent")
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ sent_at: string | null }>();
    if (earlier.error) return sendLogUnavailable();
    if (earlier.data) {
      return adminMutationJson(
        {
          error: "already_sent",
          message: "This person was already sent this code.",
          sentAt: earlier.data.sent_at,
        },
        { status: 409 },
      );
    }
  }

  const sendId = randomUUID();
  const recorded = await supabaseAdmin.from("gift_code_sends").insert({
    id: sendId,
    recipient_email: email,
    recipient_first_name: firstName,
    code: lookup.code,
    stripe_promotion_code_id: lookup.promotionCodeId,
    offer_summary: offerSummary,
    code_expires_at: lookup.expiresAt,
    sent_by: admin.id,
    sent_by_email: admin.email,
    status: "pending",
  });
  if (recorded.error) return sendLogUnavailable();

  try {
    const sent = await sendGiftCodeEmail({
      recipient: email,
      email: rendered,
      idempotencyKey: `gift-code-send-v1/${sendId}`,
    });
    const marked = await supabaseAdmin
      .from("gift_code_sends")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        resend_email_id: sent.id,
      })
      .eq("id", sendId);
    if (marked.error) {
      // The email went out; only its "sent" tick is missing from the log.
      console.error("[admin:gift-codes] sent, but the log row was not updated");
    }
  } catch {
    await supabaseAdmin
      .from("gift_code_sends")
      .update({ status: "failed" })
      .eq("id", sendId)
      .then(
        () => undefined,
        () => undefined,
      );
    return adminMutationJson(
      {
        error: "email_failed",
        message: "The email provider did not accept the message. Nothing was sent. Try again.",
      },
      { status: 502 },
    );
  }

  return adminMutationJson({ ok: true, sent: { to: email, code: lookup.code } });
}

function sendLogUnavailable() {
  return adminMutationJson(
    {
      error: "send_log_unavailable",
      message:
        "The send log is not available, so nothing was sent. If this is the first use, the gift_code_sends migration still needs to be run in Supabase.",
    },
    { status: 503 },
  );
}
