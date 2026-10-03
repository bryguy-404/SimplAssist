import "server-only";
import { randomUUID } from "node:crypto";
import { isReviewSmsEnabled } from "@/lib/billing/reviewSmsRollout.server";
import { SUBSCRIPTION_PLANS } from "@/lib/stripe/config";
import type { SubscriptionPlan } from "@/types/database";
import { countSmsParts } from "@/lib/billing/smsParts";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveBusinessEmailBrand } from "@/lib/email/businessEmailBrand.server";
import {
  isEmailReviewsEnabledForBusiness,
  isReviewEmailSendingEnabled,
  REVIEW_TEMPLATES,
} from "./config";
import {
  buildReviewEmail,
  escapeHtml,
  nextReviewSendTime,
  normalizeReviewEmail,
  normalizeReviewPhone,
  renderReviewTemplate,
  reviewOrigin,
  signReviewToken,
  validateGoogleReviewUrl,
  validateReviewTimezone,
  verifyReviewToken,
} from "./domain";

export class ReviewError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
import type { ReviewSettings } from "./types";
export type { ReviewSettings } from "./types";
type Recipient = {
  contactId: string;
  name: string;
  email: string;
  phone?: string;
  identities: string[];
  timezone: string;
  scheduledAt: string;
  enrollmentId: string;
};
type PreviewSnapshot = {
  channel?: "email" | "sms";
  smsSender?: string;
  smsMessagingProfileId?: string;
  subject: string;
  body: string;
  reminderEnabled: boolean;
  scheduledAt: string;
  googleReviewUrl: string;
  businessName: string;
  from: string;
  replyTo: string;
  recipients: Recipient[];
  summary: { selected: number; eligible: number; excluded: number };
  excluded: { contactId: string; reason: string }[];
};
export async function reviewRpc<T>(
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await supabaseAdmin.rpc(name, args);
  if (error) {
    const safe = /^review_|^verified_owner_|^invalid_review_/.test(
      error.message,
    )
      ? error.message.split(":")[0]
      : "review_storage_unavailable";
    throw new ReviewError(
      safe,
      error.code === "42501"
        ? 403
        : safe === "review_storage_unavailable"
          ? 503
          : 409,
    );
  }
  return data as T;
}
function checkStorage(error: unknown) {
  if (error) throw new ReviewError("review_storage_unavailable", 503);
}
export function requireReviewPilot(businessId: string) {
  if (!isEmailReviewsEnabledForBusiness(businessId))
    throw new ReviewError("reviews_not_available", 404);
}
export async function loadReviewSettings(
  businessId: string,
  ownerId: string,
): Promise<ReviewSettings> {
  return reviewRpc("review_initialize_settings", {
    p_business: businessId,
    p_owner: ownerId,
  });
}
export async function reviewOverview(businessId: string, ownerId: string) {
  const settings = await loadReviewSettings(businessId, ownerId);
  const [billing, control, usageResult] = await Promise.all([
    reviewRpc<
      {
        allowed: boolean;
        plan: string;
        period_start: string;
        period_end: string;
        allowance: number;
      }[]
    >("review_business_billing", { p_business: businessId }),
    reviewRpc<boolean>("review_program_enabled", { p_business: businessId }),
    supabaseAdmin
      .from("review_email_usage")
      .select("period_start,period_end,used")
      .eq("business_id", businessId)
      .order("period_start", { ascending: false })
      .limit(1),
  ]);
  checkStorage(usageResult.error);
  const period = billing[0];
  const used =
    usageResult.data?.find((u) => u.period_start === period?.period_start)
      ?.used ?? 0;
  return {
    settings,
    templates: REVIEW_TEMPLATES,
    eligibility: {
      enabled: control && isEmailReviewsEnabledForBusiness(businessId),
      paid: period?.allowed ?? false,
      paused: settings.paused,
      ready: !!settings.google_review_url && !!settings.reply_to_verified_at,
      sendingEnabled: isReviewEmailSendingEnabled(),
    },
    usage: {
      allowance: period?.allowance ?? 0,
      used,
      remaining: Math.max(0, (period?.allowance ?? 0) - used),
      periodStart: period?.period_start,
      periodEnd: period?.period_end,
    },
  };
}
function textInput(value: unknown, max: number, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw new ReviewError(`invalid_review_${field}`);
  return value.trim();
}
export async function updateReviewSettings(
  businessId: string,
  ownerId: string,
  input: Record<string, unknown>,
) {
  const settings = await loadReviewSettings(businessId, ownerId);
  const patch: Record<string, unknown> = {};
  if (input.googleReviewUrl !== undefined) {
    const url = validateGoogleReviewUrl(input.googleReviewUrl);
    if (!url) throw new ReviewError("invalid_review_google_url");
    patch.google_review_url = url;
  }
  if (input.timezone !== undefined)
    patch.timezone = validateReviewTimezone(input.timezone);
  for (const [camel, snake] of [
    ["paused", "paused"],
    ["reminderEnabled", "reminder_enabled"],
  ])
    if (input[camel] !== undefined) {
      if (typeof input[camel] !== "boolean")
        throw new ReviewError("invalid_review_setting");
      patch[snake] = input[camel];
    }
  if (input.subject !== undefined) {
    patch.subject = textInput(input.subject, 200, "subject");
    if (/[\r\n]/.test(patch.subject as string))
      throw new ReviewError("invalid_review_subject");
    renderReviewTemplate(patch.subject as string, "Business", "Customer");
  }
  if (input.body !== undefined) {
    patch.body = textInput(input.body, 4000, "body");
    renderReviewTemplate(patch.body as string, "Business", "Customer");
  }
  if (input.notificationEmail !== undefined) {
    const email = normalizeReviewEmail(input.notificationEmail);
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(ownerId);
    checkStorage(error);
    if (
      !email ||
      (email !== settings.reply_to &&
        email !== normalizeReviewEmail(data.user?.email))
    )
      throw new ReviewError("notification_email_must_be_verified");
    patch.notification_email = email;
  }
  if (Object.keys(patch).length)
    await reviewRpc("review_update_settings", {
      p_business: businessId,
      p_owner: ownerId,
      p_patch: patch,
    });
  if (
    input.automationEnabled !== undefined ||
    input.automationChannel !== undefined
  ) {
    const enabled =
      input.automationEnabled ?? settings.automation_enabled ?? false;
    const channel =
      input.automationChannel ?? settings.automation_channel ?? "email";
    if (
      typeof enabled !== "boolean" ||
      !["email", "sms"].includes(String(channel))
    )
      throw new ReviewError("invalid_review_automation");
    if (enabled && channel === "sms" && !isReviewSmsEnabled(businessId))
      throw new ReviewError("review_sms_not_available", 404);
    await reviewRpc("review_configure_automation", {
      p_business: businessId,
      p_owner: ownerId,
      p_enabled: enabled,
      p_channel: channel,
    });
  }
  if (input.replyTo !== undefined) {
    const email = normalizeReviewEmail(input.replyTo);
    if (!email) throw new ReviewError("invalid_review_reply_to");
    if (email !== settings.reply_to) {
      const id = randomUUID();
      const link = `${reviewOrigin()}/reviews/verify-reply-to/${signReviewToken(id, "reply_to")}`;
      const brand = await resolveBusinessEmailBrand(businessId);
      await reviewRpc("review_queue_owner_email", {
        p_business: businessId,
        p_owner: ownerId,
        p_id: id,
        p_kind: "verification",
        p_destination: email,
        p_payload: {
          from: brand.from,
          to: [email],
          subject: "Confirm your review-request Reply-To address",
          text: `Confirm this address for replies to your business's review requests: ${link}\nThis link expires in 24 hours. If you did not request this, you can ignore it.`,
          html: `<p>Confirm this address for replies to your business’s review requests.</p><p><a href="${link}">Confirm email address</a></p><p>This link expires in 24 hours. If you did not request this, you can ignore it.</p>`,
        },
      });
    }
  }
  return reviewOverview(businessId, ownerId);
}
export async function createReviewPreview(
  businessId: string,
  ownerId: string,
  input: Record<string, unknown>,
  options?: { previewId: string },
) {
  if (
    input.completedServiceConfirmed !== true ||
    input.permissionConfirmed !== true
  )
    throw new ReviewError("review_attestations_required");
  const channel = input.channel ?? "email";
  if (channel !== "email" && channel !== "sms")
    throw new ReviewError("invalid_review_channel");
  if (channel === "sms" && !isReviewSmsEnabled(businessId))
    throw new ReviewError("review_sms_not_available", 404);
  const ids = Array.isArray(input.contactIds)
    ? Array.from(new Set(input.contactIds))
    : [];
  if (
    !ids.length ||
    ids.length > 500 ||
    ids.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))
  )
    throw new ReviewError("invalid_review_audience");
  const overview = await reviewOverview(businessId, ownerId);
  const s = overview.settings;
  if (!overview.eligibility.enabled || !overview.eligibility.paid || s.paused)
    throw new ReviewError("review_sending_unavailable", 409);
  if (!s.google_review_url || (channel === "email" && !s.reply_to_verified_at))
    throw new ReviewError("review_setup_incomplete", 409);
  let smsSender: string | undefined, smsMessagingProfileId: string | undefined;
  if (channel === "sms") {
    if (
      !(await reviewRpc<boolean>("has_review_sms_access", {
        p_business_id: businessId,
      }))
    )
      throw new ReviewError("review_sms_setup_required", 409);
    const { data: account, error: accountError } = await supabaseAdmin
      .from("review_sms_accounts")
      .select("messaging_profile_id,phone_numbers(phone_number)")
      .eq("business_id", businessId)
      .single();
    checkStorage(accountError);
    const phoneRow = account?.phone_numbers as unknown as {
      phone_number?: string;
    } | null;
    smsSender = phoneRow?.phone_number;
    smsMessagingProfileId = account?.messaging_profile_id;
    if (!smsSender || !smsMessagingProfileId)
      throw new ReviewError("review_sms_setup_required", 409);
  }
  const subject =
    input.subject === undefined
      ? s.subject
      : textInput(input.subject, 200, "subject");
  if (/[\r\n]/.test(subject)) throw new ReviewError("invalid_review_subject");
  const body =
    input.body === undefined
      ? channel === "sms"
        ? "Thank you for choosing {{business_name}}. Would you share an honest Google review?"
        : s.body
      : textInput(input.body, channel === "sms" ? 600 : 4000, "body");
  const reminderEnabled =
    input.reminderEnabled === undefined
      ? s.reminder_enabled
      : input.reminderEnabled;
  if (typeof reminderEnabled !== "boolean")
    throw new ReviewError("invalid_review_reminder");
  const at =
    input.scheduledAt === undefined
      ? new Date()
      : new Date(String(input.scheduledAt));
  if (
    !Number.isFinite(at.getTime()) ||
    at.getTime() < Date.now() - (options ? 24 * 3600000 : 60000) ||
    at.getTime() > Date.now() + 90 * 86400000
  )
    throw new ReviewError("invalid_review_schedule");
  const [audience, businessResult, brand] = await Promise.all([
    reviewRpc<{
      contacts: {
        id: string;
        name: string | null;
        source_channel?: string;
        email: string | null;
        phone_number: string | null;
        provided_phone_number: string | null;
      }[];
      identities: { contact_id: string; identity: string }[];
      permissions: {
        contact_id: string;
        destination: string;
        timezone?: string | null;
      }[];
    }>("review_audience_snapshot", { p_business: businessId, p_contacts: ids }),
    supabaseAdmin
      .from("businesses")
      .select("name")
      .eq("id", businessId)
      .single(),
    resolveBusinessEmailBrand(businessId),
  ]);
  checkStorage(businessResult.error);
  const contacts = audience.contacts;
  const recipients: Recipient[] = [];
  const excluded: { contactId: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const id of ids as string[]) {
    const contact = contacts?.find((c) => c.id === id);
    const email = normalizeReviewEmail(contact?.email);
    const phone =
      (contact?.source_channel === "web_chat"
        ? [contact.provided_phone_number, contact.phone_number]
        : [contact?.phone_number, contact?.provided_phone_number]
      )
        .map(normalizeReviewPhone)
        .find(Boolean) ?? null;
    const destination = channel === "sms" ? phone : email;
    if (!contact || !destination) {
      excluded.push({
        contactId: id,
        reason: contact
          ? channel === "sms"
            ? "phone_missing"
            : "email_missing"
          : "customer_unavailable",
      });
      continue;
    }
    if (seen.has(destination)) {
      excluded.push({ contactId: id, reason: "duplicate_destination" });
      continue;
    }
    const permission = audience.permissions.find(
      (p) => p.contact_id === id && p.destination === destination,
    );
    const timezone = permission?.timezone ?? s.timezone;
    const known = audience.identities.filter((h) => h.contact_id === id);
    const identities = Array.from(
      new Set([
        ...(email ? [`email:${email}`] : []),
        ...(normalizeReviewPhone(contact.phone_number)
          ? [`phone:${normalizeReviewPhone(contact.phone_number)}`]
          : []),
        ...(normalizeReviewPhone(contact.provided_phone_number)
          ? [`phone:${normalizeReviewPhone(contact.provided_phone_number)}`]
          : []),
        ...(known ?? []).map((row) => row.identity),
      ]),
    );

    seen.add(destination);
    recipients.push({
      contactId: id,
      name: contact.name ?? "there",
      email: email ?? "",
      phone: phone ?? undefined,
      identities,
      timezone,
      scheduledAt: nextReviewSendTime(at, timezone).toISOString(),
      enrollmentId: randomUUID(),
    });
  }
  const blocks = await reviewRpc<
    { contactId: string; reason: string | null }[]
  >("review_preview_blocks", {
    p_business: businessId,
    p_recipients: recipients.map((r) => ({
      contactId: r.contactId,
      destination: channel === "sms" ? r.phone : r.email,
      identities: r.identities,
    })),
  });
  for (let i = recipients.length - 1; i >= 0; i--) {
    const reason = blocks.find(
      (b) => b.contactId === recipients[i].contactId,
    )?.reason;
    if (reason) {
      excluded.push({ contactId: recipients[i].contactId, reason });
      recipients.splice(i, 1);
    }
  }
  renderReviewTemplate(subject, businessResult.data!.name, "Customer");
  renderReviewTemplate(body, businessResult.data!.name, "Customer");
  const id = options?.previewId ?? randomUUID();
  const snapshot: PreviewSnapshot = {
    channel,
    smsSender,
    smsMessagingProfileId,
    subject,
    body,
    reminderEnabled,
    scheduledAt: at.toISOString(),
    googleReviewUrl: s.google_review_url,
    businessName: businessResult.data!.name,
    from: brand.from,
    replyTo: s.reply_to,
    recipients,
    summary: {
      selected: ids.length,
      eligible: recipients.length,
      excluded: excluded.length,
    },
    excluded,
  };
  const { error: saveError } = await supabaseAdmin
    .from("review_campaign_previews")
    .insert({
      id,
      business_id: businessId,
      owner_id: ownerId,
      settings_revision: s.revision,
      snapshot,
    });
  checkStorage(saveError);
  const first = recipients[0];
  const sample = first
    ? channel === "sms"
      ? {
          subject: "Review request text",
          text: buildReviewSms(
            body,
            snapshot.businessName,
            first.name,
            first.enrollmentId,
          ),
          html: "",
        }
      : buildReviewEmail({
          from: snapshot.from,
          to: first.email,
          replyTo: s.reply_to,
          subject,
          body,
          business: snapshot.businessName,
          customer: first.name,
          enrollmentId: first.enrollmentId,
          businessId,
        })
    : null;
  const usage =
    channel === "sms" ? await reviewSmsUsage(businessId) : overview.usage;
  return {
    sendingEnabled:
      channel === "sms"
        ? process.env.REVIEWS_SMS_SENDING_ENABLED === "1"
        : overview.eligibility.sendingEnabled,
    channel,
    estimatedSmsParts:
      channel === "sms"
        ? recipients.reduce(
            (sum, r) =>
              sum +
              countSmsParts(
                buildReviewSms(
                  body,
                  snapshot.businessName,
                  r.name,
                  r.enrollmentId,
                ),
              ) +
              (reminderEnabled
                ? countSmsParts(
                    buildReviewSms(
                      "A quick reminder: we would appreciate your honest feedback about {{business_name}}.",
                      snapshot.businessName,
                      r.name,
                      r.enrollmentId,
                    ),
                  )
                : 0),
            0,
          )
        : 0,
    previewToken: signReviewToken(id, "preview"),
    expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
    summary: snapshot.summary,
    recipients,
    excluded,
    sample,
    usage,
    reminderEnabled,
    estimatedEmails:
      channel === "email" ? recipients.length * (reminderEnabled ? 2 : 1) : 0,
  };
}
export async function confirmReviewCampaign(
  businessId: string,
  ownerId: string,
  token: unknown,
) {
  const id =
    typeof token === "string" ? verifyReviewToken(token, "preview") : null;
  if (!id) throw new ReviewError("invalid_review_preview");
  const { data, error } = await supabaseAdmin
    .from("review_campaign_previews")
    .select("snapshot,campaign_id")
    .eq("id", id)
    .eq("business_id", businessId)
    .eq("owner_id", ownerId)
    .maybeSingle();
  checkStorage(error);
  if (!data) throw new ReviewError("review_preview_missing", 404);
  const s = data.snapshot as PreviewSnapshot;
  if (s.channel === "sms") {
    if (!isReviewSmsEnabled(businessId))
      throw new ReviewError("review_sms_not_available", 404);
    const deliveries = s.recipients.map((r) => ({
      id: randomUUID(),
      enrollmentId: r.enrollmentId,
      body: buildReviewSms(s.body, s.businessName, r.name, r.enrollmentId),
      reminderBody: buildReviewSms(
        "A quick reminder: we would appreciate your honest feedback about {{business_name}}.",
        s.businessName,
        r.name,
        r.enrollmentId,
      ),
    }));
    const campaignId = await reviewRpc<string>("review_confirm_sms_campaign", {
      p_preview: id,
      p_business: businessId,
      p_owner: ownerId,
      p_deliveries: deliveries,
    });
    return { campaignId, summary: s.summary };
  }
  const deliveries = s.recipients.map((r) => {
    const common = {
      from: s.from,
      to: r.email,
      replyTo: s.replyTo,
      business: s.businessName,
      customer: r.name,
      enrollmentId: r.enrollmentId,
      businessId,
    };
    return {
      id: randomUUID(),
      enrollmentId: r.enrollmentId,
      payload: buildReviewEmail({
        ...common,
        subject: s.subject,
        body: s.body,
      }),
      reminderPayload: buildReviewEmail({
        ...common,
        subject: REVIEW_TEMPLATES.reminderSubject,
        body: REVIEW_TEMPLATES.reminderBody,
      }),
    };
  });
  const campaignId = await reviewRpc<string>("review_confirm_campaign", {
    p_preview: id,
    p_business: businessId,
    p_owner: ownerId,
    p_deliveries: deliveries,
  });
  return { campaignId, summary: s.summary };
}
export async function listReviewCampaigns(
  businessId: string,
  page = 1,
  pageSize = 10,
) {
  page = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
  pageSize = Number.isFinite(pageSize)
    ? Math.min(25, Math.max(1, Math.floor(pageSize)))
    : 10;
  const { data, error, count } = await supabaseAdmin
    .from("review_campaigns")
    .select(
      "*,review_enrollments(id,contact_id,destination,status,accepted_at,stop_reason,review_email_outbox(id,kind,status,scheduled_at,accepted_at,delivered_at,last_error),review_sms_outbox(id,kind,status,scheduled_at,accepted_at,delivered_at,last_error))",
      { count: "exact" },
    )
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .range((page - 1) * pageSize, page * pageSize - 1);
  checkStorage(error);
  const snapshots = data?.length
    ? await supabaseAdmin
        .from("review_campaign_previews")
        .select("id,snapshot")
        .eq("business_id", businessId)
        .in(
          "id",
          data.map((c) => c.id),
        )
    : { data: [], error: null };
  checkStorage(snapshots.error);
  const campaigns = (data ?? []).map((campaign) => {
    const snapshot = snapshots.data?.find((p) => p.id === campaign.id)
      ?.snapshot as PreviewSnapshot | undefined;
    return {
      ...campaign,
      displaySubject: snapshot
        ? renderReviewTemplate(
            snapshot.subject,
            snapshot.businessName,
            snapshot.recipients.length === 1
              ? snapshot.recipients[0].name
              : "Customer",
          )
        : campaign.channel === "sms"
          ? "Text review requests"
          : "Email review requests",
    };
  });
  return {
    campaigns,
    pagination: {
      page,
      pageSize,
      total: count ?? 0,
      totalPages: Math.ceil((count ?? 0) / pageSize),
    },
  };
}
export async function reviewEnrollmentAction(
  businessId: string,
  ownerId: string,
  id: string,
  input: Record<string, unknown>,
) {
  const { data, error } = await supabaseAdmin
    .from("review_enrollments")
    .select("id,timezone,channel")
    .eq("business_id", businessId)
    .eq("id", id)
    .maybeSingle();
  checkStorage(error);
  if (!data) throw new ReviewError("review_enrollment_missing", 404);
  if (input.action === "cancel" || input.action === "mark_reviewed") {
    await reviewRpc("review_assert_owner", {
      p_business: businessId,
      p_owner: ownerId,
    });
    return {
      updated: await reviewRpc("review_stop_enrollment", {
        p_id: id,
        p_reason: input.action === "cancel" ? "owner_cancelled" : "reviewed",
      }),
    };
  }
  if (input.action === "reschedule") {
    const at = new Date(String(input.scheduledAt));
    if (!Number.isFinite(at.getTime()))
      throw new ReviewError("invalid_review_schedule");
    return {
      updated: await reviewRpc(
        data.channel === "sms" ? "review_reschedule_sms" : "review_reschedule",
        {
          p_id: id,
          p_business: businessId,
          p_owner: ownerId,
          p_at: nextReviewSendTime(at, data.timezone).toISOString(),
        },
      ),
    };
  }
  throw new ReviewError("invalid_review_action");
}
export async function queueReviewTest(businessId: string, ownerId: string) {
  const s = await loadReviewSettings(businessId, ownerId);
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(ownerId);
  checkStorage(error);
  const email = normalizeReviewEmail(data.user?.email);
  if (!email || !data.user?.email_confirmed_at)
    throw new ReviewError("verified_owner_email_required");
  const { data: business, error: businessError } = await supabaseAdmin
    .from("businesses")
    .select("name")
    .eq("id", businessId)
    .single();
  checkStorage(businessError);
  const brand = await resolveBusinessEmailBrand(businessId);
  const id = randomUUID();
  const body = renderReviewTemplate(s.body, business!.name, "Sample customer");
  // Tests never create enrollment/tracking links and cannot reach a customer.
  await reviewRpc("review_queue_owner_email", {
    p_business: businessId,
    p_owner: ownerId,
    p_id: id,
    p_kind: "test",
    p_destination: email,
    p_payload: {
      from: brand.from,
      to: [email],
      replyTo: s.reply_to,
      subject: `[Test] ${renderReviewTemplate(s.subject, business!.name, "Sample customer")}`,
      text: `${body}\n\n[Your Google review link appears here]\n\n${business!.name}\nThis is a preview sent only to your verified account email.`,
      html: `<p>${escapeHtml(body)}</p><p>[Your Google review link appears here]</p><p>${escapeHtml(business!.name)}</p><p>This is a preview sent only to your verified account email.</p>`,
    },
  });
  return { queued: true, to: email };
}

function buildReviewSms(
  template: string,
  business: string,
  customer: string,
  enrollmentId: string,
): string {
  const body = `${business}: ${renderReviewTemplate(template, business, customer)} ${reviewOrigin()}/r/${signReviewToken(enrollmentId, "review")} Reply STOP to opt out.`;
  if (countSmsParts(body) > 6) throw new ReviewError("review_sms_too_long");
  return body;
}

async function reviewSmsUsage(businessId: string) {
  const billing = (
    await reviewRpc<
      { plan: SubscriptionPlan; period_start: string; period_end: string }[]
    >("review_business_billing", { p_business: businessId })
  )[0];
  const [{ data: period, error }, extra] = await Promise.all([
    supabaseAdmin
      .from("billing_usage_periods")
      .select("id,included_sms_parts,inbound_sms_parts,outbound_sms_parts")
      .eq("business_id", businessId)
      .eq("period_start", billing.period_start)
      .maybeSingle(),
    reviewRpc<number>("review_sms_allowance", { p_business_id: businessId }),
  ]);
  checkStorage(error);
  let reserved = 0;
  if (period) {
    const { data, error: reserveError } = await supabaseAdmin
      .from("tenant_sms_sends")
      .select("sms_parts")
      .eq("usage_period_id", period.id)
      .in("status", ["submitting", "uncertain"]);
    checkStorage(reserveError);
    reserved = (data ?? []).reduce((sum, row) => sum + row.sms_parts, 0);
  }
  const allowance =
    (period?.included_sms_parts ??
      SUBSCRIPTION_PLANS[billing.plan]?.includedSmsParts ??
      0) + extra;
  const used =
    (period?.inbound_sms_parts ?? 0) +
    (period?.outbound_sms_parts ?? 0) +
    reserved;
  return {
    allowance,
    used,
    remaining: Math.max(0, allowance - used),
    periodStart: billing.period_start,
    periodEnd: billing.period_end,
  };
}

export async function recordReviewPermission(
  businessId: string,
  ownerId: string,
  input: Record<string, unknown>,
) {
  if (
    typeof input.contactId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(input.contactId) ||
    !["email", "sms"].includes(String(input.channel)) ||
    typeof input.granted !== "boolean"
  )
    throw new ReviewError("invalid_review_permission");
  const evidence = textInput(input.evidence, 1000, "permission_evidence");
  if (evidence.length < 10)
    throw new ReviewError("invalid_review_permission_evidence");
  const timezone = input.timezone
    ? validateReviewTimezone(input.timezone)
    : null;
  await reviewRpc("review_record_permission", {
    p_business: businessId,
    p_owner: ownerId,
    p_contact: input.contactId,
    p_channel: input.channel,
    p_granted: input.granted,
    p_evidence: evidence,
    p_timezone: timezone,
  });
  return { saved: true };
}
