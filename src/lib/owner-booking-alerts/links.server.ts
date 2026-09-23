import 'server-only';

import { createHash } from 'node:crypto';
import { supabaseAdmin as db } from '@/lib/supabase/admin';
import { normalizeHostHeader } from '@/lib/branding/hostname';

const CANONICAL_ORIGIN = 'https://simplassist.com';

export class BookingAlertLinkError extends Error {
  constructor(readonly status: 404 | 503) {
    super('booking_alert_link_unavailable');
  }
}

/** Navigation only: the destination dashboard still requires its own session. */
export async function resolveBookingAlertLink(token: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new BookingAlertLinkError(404);
  const digest = createHash('sha256').update(token).digest('hex');
  const link = await db.rpc('resolve_owner_booking_alert_link', { p_token_hash: digest });
  if (link.error) throw new BookingAlertLinkError(503);
  const binding = link.data?.[0];
  if (!binding) throw new BookingAlertLinkError(404);
  const business = await db.from('businesses').select('owner_id,deleted_at,partner_id')
    .eq('id', binding.business_id).maybeSingle();
  if (business.error) throw new BookingAlertLinkError(503);
  if (!business.data || business.data.deleted_at !== null || !business.data.owner_id ||
      business.data.owner_id !== binding.owner_id) throw new BookingAlertLinkError(404);

  if (business.data.partner_id === null) return `${CANONICAL_ORIGIN}/dashboard`;
  const partner = await db.from('partners').select('id,status,domain_status,custom_domain')
    .eq('id', business.data.partner_id).maybeSingle();
  if (partner.error) throw new BookingAlertLinkError(503);
  const row = partner.data;
  if (!row || row.id !== business.data.partner_id || row.status !== 'active' || row.domain_status !== 'connected') {
    throw new BookingAlertLinkError(404);
  }
  const domain: unknown = row.custom_domain;
  if (typeof domain !== 'string' || !domain.includes('.') || normalizeHostHeader(domain) !== domain ||
      domain === new URL(CANONICAL_ORIGIN).hostname) throw new BookingAlertLinkError(404);
  return `https://${domain}/dashboard`;
}
