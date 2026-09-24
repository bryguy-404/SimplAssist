import 'server-only';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { supabaseAdmin as db } from '@/lib/supabase/admin';
import { telnyx } from '@/lib/messaging/client';
import { canUseFeature, resolveBusinessEntitlements, EntitlementResolutionError } from '@/lib/billing/entitlements';
import { getOwnerAlertConfig, ownerAlertReady, type OwnerAlertControl } from './config.server';
import {
  bookingAlertMessage, signupLinkAlertMessage, normalizeOwnerAlertPhone, OWNER_ALERT_ENROLLMENT_MESSAGE,
  OWNER_BOOKING_ALERT_CONSENT_VERSION, OWNER_BOOKING_ALERT_DISCLOSURE,
  ownerAlertSmsUrl, ownerAlertVerificationMessage, ownerBookingAlertMutationSchema,
  type OwnerBookingAlertSettings,
} from './contracts';

export class OwnerBookingAlertError extends Error {
  constructor(public readonly code: 'invalid' | 'forbidden' | 'conflict' | 'unavailable' | 'phone_not_mobile' | 'phone_reserved' | 'rate_limited', public readonly status = code === 'forbidden' ? 403 : code === 'conflict' ? 409 : code === 'rate_limited' ? 429 : code === 'unavailable' ? 503 : 400) { super(`owner_booking_alert_${code}`); }
}
export const ownerAlertDigest = (value: string) => createHash('sha256').update(value).digest('hex');
export interface AlertOutboxRow {
  id: string; business_id: string; owner_id: string; booking_id: string | null; voice_action_id: string | null; kind: 'booking' | 'signup_link' | 'enrollment'; generation: string;
  recipient: string; sender: string; messaging_profile_id: string; status: string; content: string | null;
  link_token_digest: string | null;
  claim_token: string; attempt_id: string | null; provider_message_id: string | null; expires_at: string;
}
interface SettingsRow {
  revision: number; enabled: boolean; recipient: string | null; pending_recipient: string | null;
  verified_at: string | null; consent_version: string | null; nudge_dismissed_at: string | null; owner_id: string;
  pending_verification_id: string | null;
}
function checked<T>(result: { data: T; error: { code?: string } | null }): T {
  if (result.error) throw new OwnerBookingAlertError(result.error.code === '40001' ? 'conflict' : result.error.code === '42501' ? 'forbidden' : result.error.code === 'P0429' ? 'rate_limited' : 'unavailable');
  return result.data;
}
async function control(): Promise<OwnerAlertControl | null> {
  return checked(await db.from('owner_booking_alert_control').select('enabled,sender,messaging_profile_id,pilot_business_ids').eq('singleton', true).maybeSingle());
}
async function eligible(businessId: string, ownerId: string): Promise<boolean> {
  let entitlement;
  try { entitlement = await resolveBusinessEntitlements(businessId); }
  catch (error) {
    if (error instanceof EntitlementResolutionError && error.code === 'subscription_missing') return false;
    throw new OwnerBookingAlertError('unavailable');
  }
  if (!canUseFeature(entitlement, 'ai_customization')) return false;
  return checked(await db.rpc('owner_booking_alert_business_eligible', { p_business_id: businessId, p_owner_id: ownerId })) === true;
}
export async function getOwnerBookingAlertSettings(businessId: string): Promise<OwnerBookingAlertSettings> {
  const config = getOwnerAlertConfig();
  const [settingResult, businessResult, gateResult] = await Promise.all([
    db.from('owner_booking_alert_settings').select('revision,enabled,recipient,pending_recipient,pending_verification_id,verified_at,consent_version,nudge_dismissed_at,owner_id').eq('business_id', businessId).maybeSingle(),
    db.from('businesses').select('owner_id,deleted_at,operations_suspended_at,primary_goal').eq('id', businessId).maybeSingle(),
    db.from('owner_booking_alert_control').select('enabled,sender,messaging_profile_id,pilot_business_ids').eq('singleton', true).maybeSingle(),
  ]);
  const business = checked(businessResult);
  if (!business || !business.owner_id || business.deleted_at) throw new OwnerBookingAlertError('forbidden');
  // The real consent form can be previewed before the separately approved schema
  // release. Only tolerate both new tables being absent while activation is off;
  // never hide an existing enrollment, partial schema, or a storage/access failure.
  const activationDisabled = process.env.OWNER_BOOKING_ALERTS_ENABLED !== 'true'
    || process.env.OWNER_BOOKING_ALERTS_PROVIDER_REVIEWED !== 'true';
  const missingTable = (error: { code?: string } | null) => error?.code === 'PGRST205' || error?.code === '42P01';
  if (activationDisabled && missingTable(settingResult.error) && missingTable(gateResult.error)) {
    return {
      revision: 0, enabled: false, recipient: null, pendingRecipient: null,
      pendingRecipientSuppressed: false, verifiedAt: null, status: 'unavailable',
      available: false, eligible: false, sender: config.sender,
      consentVersion: OWNER_BOOKING_ALERT_CONSENT_VERSION, disclosure: OWNER_BOOKING_ALERT_DISCLOSURE,
      nudgeDismissedAt: null,
    };
  }
  const setting = checked(settingResult) as SettingsRow | null;
  const gate = checked(gateResult) as OwnerAlertControl | null;
  const isEligible = !business.operations_suspended_at && await eligible(businessId, business.owner_id);
  const available = ownerAlertReady(config, gate, businessId);
  const current = setting?.owner_id === business.owner_id ? setting : null;
  // Booking-only consent never silently expands when an account switches goals.
  const enabled = current?.enabled === true && (business.primary_goal !== 'signup' || current.consent_version === OWNER_BOOKING_ALERT_CONSENT_VERSION);
  let pendingRecipient = current?.pending_recipient ?? null;
  if (pendingRecipient && current?.pending_verification_id) {
    const pending = checked(await db.from('owner_booking_alert_verifications').select('expires_at,consumed_at,consent_version').eq('id', current.pending_verification_id).maybeSingle());
    if (!pending || pending.consumed_at || Date.parse(pending.expires_at) <= Date.now()
      || (business.primary_goal === 'signup' && pending.consent_version !== OWNER_BOOKING_ALERT_CONSENT_VERSION)) pendingRecipient = null;
  }
  let suppressed = false;
  let pendingRecipientSuppressed = false;
  if (current?.recipient) {
    const state = checked(await db.from('owner_booking_alert_recipients').select('suppressed').eq('recipient', current.recipient).maybeSingle());
    suppressed = state?.suppressed === true;
  }
  if (pendingRecipient) {
    if (pendingRecipient === current?.recipient) pendingRecipientSuppressed = suppressed;
    else {
      const pendingState = checked(await db.from('owner_booking_alert_recipients').select('suppressed').eq('recipient', pendingRecipient).maybeSingle());
      pendingRecipientSuppressed = pendingState?.suppressed === true;
    }
  }
  return {
    revision: setting?.revision ?? 0, enabled, recipient: current?.recipient ?? null,
    pendingRecipient, pendingRecipientSuppressed, verifiedAt: current?.verified_at ?? null,
    status: suppressed ? 'stopped' : pendingRecipient ? 'pending_verification' : !available ? 'unavailable' : !isEligible ? 'paused' : enabled ? 'active' : 'not_enabled',
    available, eligible: isEligible, sender: config.sender,
    consentVersion: OWNER_BOOKING_ALERT_CONSENT_VERSION, disclosure: OWNER_BOOKING_ALERT_DISCLOSURE,
    nudgeDismissedAt: current?.nudge_dismissed_at ?? null,
  };
}
export async function mutateOwnerBookingAlertSettings(businessId: string, ownerId: string, input: unknown): Promise<OwnerBookingAlertSettings> {
  const parsed = ownerBookingAlertMutationSchema.safeParse(input);
  if (!parsed.success) throw new OwnerBookingAlertError('invalid');
  const command = parsed.data;
  let phone: string | null = null;
  let token: string | null = null;
  let expiresAt: string | null = null;
  if (command.action === 'enroll') {
    const config = getOwnerAlertConfig();
    if (!ownerAlertReady(config, await control(), businessId)) throw new OwnerBookingAlertError('unavailable');
    if (!await eligible(businessId, ownerId)) throw new OwnerBookingAlertError('forbidden');
    phone = normalizeOwnerAlertPhone(command.phone);
    if (!phone) throw new OwnerBookingAlertError('invalid');
    if (phone === config.sender) throw new OwnerBookingAlertError('phone_reserved');
    const managed = checked(await db.from('phone_numbers').select('id').eq('phone_number', phone).limit(1));
    if (managed?.length) throw new OwnerBookingAlertError('phone_reserved');
    const permitted = checked(await db.rpc('reserve_owner_booking_alert_lookup', { p_business_id: businessId, p_owner_id: ownerId, p_recipient: phone }));
    if (permitted !== true) throw new OwnerBookingAlertError('rate_limited');
    let lookup;
    try { lookup = await telnyx.numberLookup.retrieve(phone, { type: 'carrier' }, { maxRetries: 0, timeout: 5000 }); }
    catch { throw new OwnerBookingAlertError('unavailable'); }
    if (lookup.data?.phone_number !== phone || lookup.data.country_code !== 'US' || lookup.data.carrier?.type !== 'mobile' || lookup.data.carrier.error_code) throw new OwnerBookingAlertError('phone_not_mobile');
    token = randomBytes(18).toString('base64url');
    expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  }
  checked(await db.rpc('configure_owner_booking_alert', {
    p_business_id: businessId, p_owner_id: ownerId, p_expected_revision: command.expectedRevision, p_action: command.action,
    p_recipient: phone, p_challenge_digest: token ? ownerAlertDigest(token) : null,
    p_consent_version: token ? OWNER_BOOKING_ALERT_CONSENT_VERSION : null, p_disclosure: token ? OWNER_BOOKING_ALERT_DISCLOSURE : null,
    p_verification_expires_at: expiresAt,
  }));
  const settings = await getOwnerBookingAlertSettings(businessId);
  if (token && expiresAt && settings.sender) {
    const message = ownerAlertVerificationMessage(token);
    settings.verification = { message, sender: settings.sender, expiresAt, smsUrl: ownerAlertSmsUrl(settings.sender, message) };
  }
  return settings;
}

/** Only explicit HTTP rejections establish non-acceptance. Network errors and provider 5xx remain uncertain. */
export function classifyOwnerAlertSendError(error: unknown): { status: 'retry' | 'failed' | 'uncertain'; code: string } {
  const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : NaN;
  if (status >= 400 && status < 500 && typeof error === 'object' && error !== null && 'error' in error) {
    const body = error.error as { errors?: Array<{ code?: string }> } | null;
    if (Array.isArray(body?.errors) && body.errors.some(e => e?.code === '40300')) return { status: 'failed', code: 'provider_opted_out' };
  }
  if (status === 429) return { status: 'retry', code: 'provider_rate_limited' };
  if (status >= 400 && status < 500 && status !== 408 && status !== 409) return { status: 'failed', code: 'provider_rejected' };
  return { status: 'uncertain', code: 'provider_acceptance_unknown' };
}
async function finish(row: AlertOutboxRow, attempt: string, status: 'accepted' | 'retry' | 'failed' | 'uncertain', providerId: string | null, code: string | null) {
  const ok = checked(await db.rpc('finish_owner_booking_alert_send', { p_id: row.id, p_claim_token: row.claim_token, p_attempt_id: attempt, p_status: status, p_provider_message_id: providerId, p_error_code: code }));
  if (ok !== true) throw new OwnerBookingAlertError('unavailable');
}
export async function runOwnerBookingAlerts(): Promise<{ processed: number; accepted: number; failed: number; uncertain: number }> {
  const result = { processed: 0, accepted: 0, failed: 0, uncertain: 0 };
  const config = getOwnerAlertConfig();
  // Fresh installations remain healthy while awaiting provider review and database activation.
  if (!config.sender || !config.profileId) return result;
  const { reconcileOwnerBookingAlertWebhooks } = await import('./webhook.server');
  await reconcileOwnerBookingAlertWebhooks();
  checked(await db.rpc('purge_owner_booking_alert_operational_data'));
  if (!config.enabled) return result;
  const gate = await control();
  if (!ownerAlertReady(config, gate)) return result;
  const deadline = Date.now() + 35_000;
  let nextSubmissionAt = 0;
  // Bounded sequential sends keep provider traffic modest; database leases make overlapping workers safe.
  const rows = checked(await db.rpc('claim_owner_booking_alerts', { p_limit: 5 })) as AlertOutboxRow[] | null;
  for (const row of rows ?? []) {
    if (Date.now() >= deadline) break;
    if (!ownerAlertReady(config, gate, row.business_id)) continue;
    let submitting = false;
    let submissionStartedAt: string | null = null;
    const attempt = randomUUID();
    try {
      if (!await eligible(row.business_id, row.owner_id)) continue;
      const business = checked(await db.from('businesses').select('name,timezone,owner_id,deleted_at,operations_suspended_at').eq('id', row.business_id).maybeSingle());
      if (!business || business.owner_id !== row.owner_id || business.deleted_at || business.operations_suspended_at) continue;
      let content = row.content;
      let linkDigest: string | null = row.link_token_digest;
      if (!content) {
        if (row.kind === 'enrollment') content = OWNER_ALERT_ENROLLMENT_MESSAGE;
        else if (row.kind === 'booking') {
          const booking = checked(await db.from('calendar_bookings').select('starts_at,status').eq('id', row.booking_id!).eq('business_id', row.business_id).maybeSingle());
          if (!booking || booking.status !== 'confirmed') continue;
          const linkToken = randomBytes(32).toString('base64url');
          linkDigest = ownerAlertDigest(linkToken);
          content = bookingAlertMessage({ businessName: business.name, startsAt: booking.starts_at, timezone: business.timezone, dashboardUrl: `https://simplassist.com/booking-alerts/open/${linkToken}` });
        } else if (row.kind === 'signup_link') {
          const action = checked(await db.from('voice_actions').select('kind,status,sms_provider_message_id,sms_accepted_at,result').eq('id', row.voice_action_id!).eq('business_id', row.business_id).maybeSingle());
          if (!action || action.kind !== 'signup' || action.status !== 'succeeded' || !action.sms_accepted_at || !action.sms_provider_message_id || action.result?.providerMessageId !== action.sms_provider_message_id || ['delivery_failed', 'sending_failed', 'expired', 'cancelled', 'failed', 'rejected'].includes(action.result?.deliveryStatus)) continue;
          const linkToken = randomBytes(32).toString('base64url');
          linkDigest = ownerAlertDigest(linkToken);
          content = signupLinkAlertMessage({ businessName: business.name, dashboardUrl: `https://simplassist.com/booking-alerts/open/${linkToken}` });
        } else {
          continue;
        }
      }
      // Pace a batch to the shared database limit. Without this, a fast first
      // response would defer the other four rows until the next worker poll.
      const delay = nextSubmissionAt - Date.now();
      if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, delay));
      if (Date.now() >= deadline) break;
      // The transaction rechecks ownership, consent generation, suppression, expiry, booking, and provider gate.
      const begun = checked(await db.rpc('begin_owner_booking_alert_send', { p_id: row.id, p_claim_token: row.claim_token, p_attempt_id: attempt, p_content: content, p_link_token_digest: linkDigest })) as AlertOutboxRow | null;
      if (!begun || begun.status !== 'submitting') continue;
      nextSubmissionAt = Date.now() + 1000;
      submitting = true;
      submissionStartedAt = new Date().toISOString();
      result.processed += 1;
      const response = await telnyx.messages.send({
        from: begun.sender, to: begun.recipient, text: begun.content!, messaging_profile_id: begun.messaging_profile_id, type: 'SMS',
        webhook_url: `https://simplassist.com/api/notifications/sms/webhook?attempt=${attempt}`,
      }, { maxRetries: 0, timeout: 5_000 });
      if (!response.data?.id) throw new Error('provider_acceptance_unknown');
      // If this write fails, signed per-attempt callbacks still reconcile this exact submission.
      await finish(row, attempt, 'accepted', response.data.id, null);
      result.accepted += 1;
    } catch (error) {
      if (!submitting) continue; // Claim expires; no provider attempt was made.
      const classified = classifyOwnerAlertSendError(error);
      try { await finish(row, attempt, classified.status, null, classified.code); } catch { /* durable lease recovery marks submitting uncertain */ }
      if (classified.code === 'provider_opted_out' && submissionStartedAt) {
        // Repairs a historical or missed carrier STOP. A newer signed START wins by event time.
        const mirrored = await db.rpc('set_owner_booking_alert_suppression', { p_recipient: row.recipient, p_suppressed: true, p_event_at: submissionStartedAt, p_event_id: `provider-rejection:${attempt}` });
        if (mirrored.error) throw new OwnerBookingAlertError('unavailable');
      }
      if (classified.status === 'uncertain') result.uncertain += 1;
      else if (classified.status === 'failed') result.failed += 1;
    }
  }
  return result;
}
