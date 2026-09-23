import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), unwrap: vi.fn(), entitlement: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { rpc: mocks.rpc, from: mocks.from } }));
vi.mock('@/lib/messaging/client', () => ({ telnyx: { webhooks: { unwrap: mocks.unwrap } } }));
vi.mock('@/lib/billing/entitlements', () => ({ resolveBusinessEntitlements: mocks.entitlement, canUseFeature: () => true }));
vi.mock('./services.server', () => ({
  OwnerBookingAlertError: class extends Error { constructor(public code: string, public status = code === 'unavailable' ? 503 : 400) { super(code); } },
  ownerAlertDigest: (value: string) => createHash('sha256').update(value).digest('hex'),
}));
import { classifyOwnerAlertInbound, handleOwnerBookingAlertWebhook, reconcileOwnerBookingAlertWebhooks } from './webhook.server';

const sender = '+15742133931'; const recipient = '+15745551212'; const token = 'abcdefghABCDEFGH12345678';
const attempt = '76f83c0d-0f20-4a51-b533-9b944ecfa72f';
const callbackUrl = `https://simplassist.com/api/notifications/sms/webhook?attempt=${attempt}`;
let events: Map<string, { payload: unknown; processed_at: string | null }>;
let verificationRecipient: string;
function query(table: string) {
  let id: string | null = null;
  let operation = 'read'; let input: Record<string, unknown> | null = null;
  const q: Record<string, unknown> = {};
  q.eq = (field: string, value: string) => { if (field === 'id') id = value; return q; };
  for (const name of ['select', 'order', 'limit', 'is']) q[name] = () => q;
  q.upsert = (value: Record<string, unknown>) => { operation = 'insert'; input = value; return q; };
  q.update = (value: Record<string, unknown>) => { operation = 'update'; input = value; return q; };
  const result = () => {
    if (table === 'owner_booking_alert_webhook_events') {
      if (operation === 'insert' && input && !events.has(input.id as string)) events.set(input.id as string, { payload: input.payload, processed_at: null });
      if (operation === 'update' && id && input) { const e = events.get(id); if (e) e.processed_at = input.processed_at as string; }
      return { data: id ? events.get(id) : Array.from(events.entries()).filter(([, value]) => !value.processed_at).map(([key, value]) => ({ id: key, ...value })), error: null };
    }
    if (table === 'owner_booking_alert_control') return { data: { enabled: true, sender, messaging_profile_id: 'profile', pilot_business_ids: null }, error: null };
    if (table === 'owner_booking_alert_verifications') return { data: { business_id: 'business', owner_id: 'owner', recipient: verificationRecipient, consumed_at: null, expires_at: new Date(Date.now() + 60_000).toISOString() }, error: null };
    return { data: null, error: null };
  };
  q.single = q.maybeSingle = async () => result();
  q.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve);
  return q;
}
function inbound(text = `ALERTS ${token}`, extra: Record<string, unknown> = {}) {
  return { data: { id: 'event', event_type: 'message.received', occurred_at: new Date().toISOString(), payload: { from: { phone_number: recipient }, to: [{ phone_number: sender }], messaging_profile_id: 'profile', text, ...extra } } };
}
const headers = () => ({ 'telnyx-timestamp': String(Math.floor(Date.now() / 1000)), 'telnyx-signature-ed25519': 'test-verified-by-sdk' });
beforeEach(() => {
  vi.clearAllMocks(); events = new Map(); verificationRecipient = recipient;
  mocks.from.mockImplementation(query); mocks.rpc.mockResolvedValue({ data: true, error: null });
  mocks.unwrap.mockImplementation(async (raw: string) => JSON.parse(raw));
  mocks.entitlement.mockResolvedValue({ active: true, plan: 'chat_only' });
  for (const [key, value] of Object.entries({ OWNER_BOOKING_ALERTS_ENABLED: 'true', OWNER_BOOKING_ALERTS_PROVIDER_REVIEWED: 'true', OWNER_BOOKING_ALERTS_SENDER_E164: sender, OWNER_BOOKING_ALERTS_MESSAGING_PROFILE_ID: 'profile', OWNER_BOOKING_ALERTS_CAMPAIGN_ID: 'campaign', OWNER_BOOKING_ALERTS_PILOT_BUSINESS_IDS: '', TELNYX_API_KEY: 'test', TELNYX_PUBLIC_KEY: 'test' })) vi.stubEnv(key, value);
});
describe('signed owner-alert webhook boundary', () => {
  it('requires a valid signature before any storage or side effects', async () => {
    mocks.unwrap.mockRejectedValue(new Error('bad signature'));
    await expect(handleOwnerBookingAlertWebhook(JSON.stringify(inbound()), headers())).rejects.toMatchObject({ status: 401 });
    expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('rejects malformed timestamps and stale replay even if signature implementation accepts them', async () => {
    for (const timestamp of ['NaN', '123abc', String(Math.floor(Date.now() / 1000) - 600)]) {
      await expect(handleOwnerBookingAlertWebhook('{}', { ...headers(), 'telnyx-timestamp': timestamp })).rejects.toMatchObject({ status: 401 });
    }
    expect(mocks.unwrap).not.toHaveBeenCalled();
  });
  it('ignores another profile rather than routing it into owner enrollment', async () => {
    await expect(handleOwnerBookingAlertWebhook(JSON.stringify(inbound('STOP', { messaging_profile_id: 'customer' })), headers())).resolves.toEqual({ ignored: true });
    expect(events.size).toBe(0); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('stores only the challenge digest and consumes once after same-number verification', async () => {
    const raw = JSON.stringify(inbound());
    await handleOwnerBookingAlertWebhook(raw, headers()); await handleOwnerBookingAlertWebhook(raw, headers());
    expect(mocks.rpc.mock.calls.filter(([name]) => name === 'consume_owner_booking_alert_verification')).toHaveLength(1);
    expect(JSON.stringify(Array.from(events.values()))).not.toContain(token);
    expect(JSON.stringify(Array.from(events.values()))).not.toContain('ALERTS');
    expect(mocks.rpc).toHaveBeenCalledWith('consume_owner_booking_alert_verification', expect.objectContaining({ p_recipient: recipient, p_challenge_digest: createHash('sha256').update(token).digest('hex') }));
  });
  it('never consumes a challenge received from a different phone', async () => {
    verificationRecipient = '+15745559876'; await handleOwnerBookingAlertWebhook(JSON.stringify(inbound()), headers());
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('honors provider-detected STOP while outbound alerts are disabled', async () => {
    vi.stubEnv('OWNER_BOOKING_ALERTS_ENABLED', 'false');
    await handleOwnerBookingAlertWebhook(JSON.stringify(inbound('Please stop these', { autoresponse_type: 'STOP' })), headers());
    expect(mocks.rpc).toHaveBeenCalledWith('set_owner_booking_alert_suppression', expect.objectContaining({ p_recipient: recipient, p_suppressed: true }));
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'consume_owner_booking_alert_verification')).toBe(false);
  });
  it('accepts the provider nullable webhook_url on inbound STOP and verification messages', async () => {
    await handleOwnerBookingAlertWebhook(JSON.stringify(inbound('STOP', { webhook_url: null })), headers());
    expect(mocks.rpc).toHaveBeenCalledWith('set_owner_booking_alert_suppression', expect.objectContaining({ p_suppressed: true }));
  });
  it('START only clears suppression; HELP and arbitrary texts do not enroll or invoke another sender', async () => {
    await handleOwnerBookingAlertWebhook(JSON.stringify(inbound('START')), headers());
    expect(mocks.rpc).toHaveBeenCalledWith('set_owner_booking_alert_suppression', expect.objectContaining({ p_suppressed: false }));
    mocks.rpc.mockClear();
    for (const text of ['HELP', 'Can I reschedule?', 'YES']) await handleOwnerBookingAlertWebhook(JSON.stringify(inbound(text)), headers());
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('does not acknowledge a signed event when durable storage fails', async () => {
    mocks.from.mockReturnValue({ upsert: async () => ({ error: { code: 'down' } }) });
    await expect(handleOwnerBookingAlertWebhook(JSON.stringify(inbound('STOP')), headers())).rejects.toMatchObject({ status: 503 });
  });
  it('reconciles events persisted before a crashed HTTP handler', async () => {
    events.set('crashed', { payload: { type: 'inbound', action: 'stop', occurredAt: new Date().toISOString(), sender, recipient, profileId: 'profile' }, processed_at: null });
    await reconcileOwnerBookingAlertWebhooks();
    expect(mocks.rpc).toHaveBeenCalledWith('set_owner_booking_alert_suppression', expect.objectContaining({ p_event_id: 'crashed' }));
    expect(events.get('crashed')?.processed_at).not.toBeNull();
  });
  it('binds delivery correlation to the signed payload, then validates exact sender/recipient/profile in SQL', async () => {
    const delivery = { data: { id: 'delivery', event_type: 'message.finalized', occurred_at: new Date().toISOString(), payload: { id: 'message', from: { phone_number: sender }, to: [{ phone_number: recipient, status: 'delivered' }], messaging_profile_id: 'profile', webhook_url: callbackUrl } } };
    await handleOwnerBookingAlertWebhook(JSON.stringify(delivery), headers(), 'bf82e6bc-ac07-47da-97b1-3f5d80f8af54');
    expect(mocks.rpc).not.toHaveBeenCalled();
    await handleOwnerBookingAlertWebhook(JSON.stringify(delivery), headers(), attempt);
    expect(mocks.rpc).toHaveBeenCalledWith('apply_owner_booking_alert_delivery', expect.objectContaining({ p_attempt_id: attempt, p_status: 'delivered', p_sender: sender, p_recipient: recipient, p_profile_id: 'profile' }));
  });
});
describe('inbound program command parsing', () => {
  it('prioritizes the carrier-detected operation and never treats a bare YES as new consent', () => {
    expect(classifyOwnerAlertInbound(`ALERTS ${token}`, 'STOP')).toEqual({ action: 'stop' });
    expect(classifyOwnerAlertInbound('YES')).toEqual({ action: 'ignore' });
    expect(classifyOwnerAlertInbound(' stop all ')).toEqual({ action: 'stop' });
    expect(classifyOwnerAlertInbound('ALERTS too-short')).toEqual({ action: 'ignore' });
  });
});
