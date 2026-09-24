import 'server-only';
import { z } from 'zod';
import { telnyx } from '@/lib/messaging/client';
import { supabaseAdmin as db } from '@/lib/supabase/admin';
import { canUseFeature, resolveBusinessEntitlements } from '@/lib/billing/entitlements';
import { getOwnerAlertConfig, ownerAlertReady } from './config.server';
import { OwnerBookingAlertError, ownerAlertDigest } from './services.server';

const eventSchema = z.object({ data: z.object({
  id: z.string().min(1).max(100), event_type: z.string(), occurred_at: z.string().datetime({ offset: true }),
  payload: z.object({ id: z.string().max(100).optional(), messaging_profile_id: z.string().max(100),
    from: z.object({ phone_number: z.string().regex(/^\+[1-9]\d{7,14}$/) }), to: z.array(z.object({ phone_number: z.string().regex(/^\+[1-9]\d{7,14}$/), status: z.string().optional() })).length(1),
    text: z.string().max(10_000).optional(), autoresponse_type: z.string().nullable().optional(), webhook_url: z.string().nullable().optional(),
    cost: z.unknown().optional(), parts: z.unknown().optional(),
  }),
}) });
type InboundAction = 'stop' | 'start' | 'help' | 'verify' | 'ignore';
export function classifyOwnerAlertInbound(text: string, autoresponseType?: string | null): { action: InboundAction; token?: string } {
  const automatic = autoresponseType?.toLowerCase();
  if (automatic === 'stop' || automatic === 'start' || automatic === 'help') return { action: automatic };
  const keyword = text.trim().toUpperCase().replace(/\s+/g, ' ');
  if (['STOP', 'STOPALL', 'STOP ALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'].includes(keyword)) return { action: 'stop' };
  if (['START', 'UNSTOP'].includes(keyword)) return { action: 'start' };
  if (['HELP', 'INFO'].includes(keyword)) return { action: 'help' };
  const match = /^ALERTS\s+([A-Za-z0-9_-]{24})$/i.exec(text.trim());
  return match ? { action: 'verify', token: match[1] } : { action: 'ignore' };
}
interface StoredEvent {
  type: 'inbound' | 'delivery'; occurredAt: string; sender: string; recipient: string; profileId: string;
  action?: InboundAction; challengeDigest?: string; attemptId?: string; providerMessageId?: string;
  deliveryStatus?: 'accepted' | 'delivered' | 'failed';
  parts?: number; costAmount?: string; costCurrency?: string;
}
async function processStoredEvent(eventId: string, event: StoredEvent) {
  if (event.type === 'inbound') {
    if (event.action === 'stop' || event.action === 'start') {
      const update = await db.rpc('set_owner_booking_alert_suppression', { p_recipient: event.recipient, p_suppressed: event.action === 'stop', p_event_at: event.occurredAt, p_event_id: eventId });
      if (update.error) throw new OwnerBookingAlertError('unavailable');
    } else if (event.action === 'verify' && event.challengeDigest) {
      const config = getOwnerAlertConfig();
      const control = await db.from('owner_booking_alert_control').select('enabled,sender,messaging_profile_id,pilot_business_ids').eq('singleton', true).maybeSingle();
      if (control.error) throw new OwnerBookingAlertError('unavailable');
      const verification = await db.from('owner_booking_alert_verifications').select('business_id,owner_id,recipient,expires_at,consumed_at').eq('challenge_digest', event.challengeDigest).maybeSingle();
      if (verification.error) throw new OwnerBookingAlertError('unavailable');
      const v = verification.data;
      if (v && !v.consumed_at && Date.parse(v.expires_at) > Date.now() && v.recipient === event.recipient && ownerAlertReady(config, control.data, v.business_id)) {
        const entitlement = await resolveBusinessEntitlements(v.business_id);
        if (canUseFeature(entitlement, 'ai_customization')) {
          const consumed = await db.rpc('consume_owner_booking_alert_verification', { p_challenge_digest: event.challengeDigest, p_recipient: event.recipient, p_sender: event.sender, p_profile_id: event.profileId, p_event_id: eventId });
          if (consumed.error) throw new OwnerBookingAlertError('unavailable');
        }
      }
    }
    // HELP/STOP/START acknowledgments belong to the dedicated Telnyx profile's configured autoresponder.
    // Arbitrary replies never enter customer conversations or invoke the AI.
  } else if (event.attemptId && event.providerMessageId && event.deliveryStatus) {
    const applied = await db.rpc('apply_owner_booking_alert_delivery', {
      p_attempt_id: event.attemptId, p_provider_message_id: event.providerMessageId, p_status: event.deliveryStatus,
      p_sender: event.sender, p_recipient: event.recipient, p_profile_id: event.profileId, p_event_at: event.occurredAt,
      p_parts: event.parts ?? null, p_cost_amount: event.costAmount ?? null, p_cost_currency: event.costCurrency ?? null,
    });
    if (applied.error) throw new OwnerBookingAlertError('unavailable');
  }
  const updated = await db.from('owner_booking_alert_webhook_events').update({ processed_at: new Date().toISOString(), error_code: null }).eq('id', eventId).is('processed_at', null);
  if (updated.error) throw new OwnerBookingAlertError('unavailable');
}

export async function handleOwnerBookingAlertWebhook(rawBody: string, headers: Record<string, string>, attemptToken?: string): Promise<{ ignored?: boolean }> {
  const timestamp = Object.entries(headers).find(([key]) => key.toLowerCase() === 'telnyx-timestamp')?.[1];
  if (!timestamp || !/^\d{10,}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new OwnerBookingAlertError('forbidden', 401);
  let unwrapped: unknown;
  try { unwrapped = await telnyx.webhooks.unwrap(rawBody, { headers }); }
  catch { throw new OwnerBookingAlertError('forbidden', 401); }
  const parsed = eventSchema.safeParse(unwrapped);
  if (!parsed.success) throw new OwnerBookingAlertError('invalid');
  const { id, event_type: type, occurred_at: occurredAt, payload } = parsed.data.data;
  let event: StoredEvent;
  if (type === 'message.received') {
    const config = getOwnerAlertConfig();
    if (!config.sender || !config.profileId || payload.to[0].phone_number !== config.sender || payload.messaging_profile_id !== config.profileId) return { ignored: true };
    const classified = classifyOwnerAlertInbound(payload.text ?? '', payload.autoresponse_type);
    if (classified.action === 'ignore' || classified.action === 'help') return { ignored: true };
    event = { type: 'inbound', action: classified.action, occurredAt, sender: config.sender, recipient: payload.from.phone_number, profileId: config.profileId, ...(classified.token ? { challengeDigest: ownerAlertDigest(classified.token) } : {}) };
  } else if (type === 'message.sent' || type === 'message.finalized') {
    if (!attemptToken || !z.uuid().safeParse(attemptToken).success || !payload.id) return { ignored: true };
    // The signed payload must bind the otherwise unsigned query token to this provider submission.
    if (payload.webhook_url !== `https://simplassist.com/api/notifications/sms/webhook?attempt=${attemptToken}`) return { ignored: true };
    const delivery = payload.to[0].status;
    const status = delivery === 'delivered' ? 'delivered' : ['sending_failed', 'delivery_failed', 'expired', 'cancelled'].includes(delivery ?? '') ? 'failed' : 'accepted';
    event = { type: 'delivery', occurredAt, sender: payload.from.phone_number, recipient: payload.to[0].phone_number, profileId: payload.messaging_profile_id, attemptId: attemptToken, providerMessageId: payload.id, deliveryStatus: status };
    const cost = z.object({ amount: z.string().regex(/^\d{1,10}(\.\d{1,8})?$/), currency: z.string().regex(/^[A-Z]{3}$/) }).safeParse(payload.cost);
    if (cost.success) { event.costAmount = cost.data.amount; event.costCurrency = cost.data.currency; }
    if (Number.isInteger(payload.parts) && Number(payload.parts) > 0 && Number(payload.parts) <= 100) event.parts = Number(payload.parts);
  } else return { ignored: true };
  // Save only the validated processing facts. Never retain arbitrary replies, customer data, or raw verification codes.
  const inserted = await db.from('owner_booking_alert_webhook_events').upsert({ id, payload: event }, { onConflict: 'id', ignoreDuplicates: true });
  if (inserted.error) throw new OwnerBookingAlertError('unavailable');
  const stored = await db.from('owner_booking_alert_webhook_events').select('payload,processed_at').eq('id', id).single();
  if (stored.error || !stored.data) throw new OwnerBookingAlertError('unavailable');
  if (!stored.data.processed_at) await processStoredEvent(id, stored.data.payload as StoredEvent);
  return {};
}

/** A persisted event survives a crashed HTTP handler; every side effect is an idempotent SQL transaction. */
export async function reconcileOwnerBookingAlertWebhooks(): Promise<void> {
  const pending = await db.from('owner_booking_alert_webhook_events').select('id,payload').is('processed_at', null).order('created_at').limit(10);
  if (pending.error) throw new OwnerBookingAlertError('unavailable');
  for (const row of pending.data ?? []) {
    try { await processStoredEvent(row.id, row.payload as StoredEvent); }
    catch { /* Leave pending for the next worker pass, without logging recipients or message contents. */ }
  }
}
