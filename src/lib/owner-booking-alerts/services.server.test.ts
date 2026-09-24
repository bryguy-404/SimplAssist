import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), send: vi.fn(), lookup: vi.fn(), entitlement: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { rpc: mocks.rpc, from: mocks.from } }));
vi.mock('@/lib/messaging/client', () => ({ telnyx: { messages: { send: mocks.send }, numberLookup: { retrieve: mocks.lookup } } }));
vi.mock('@/lib/billing/entitlements', () => ({ resolveBusinessEntitlements: mocks.entitlement, canUseFeature: (e: { active: boolean; plan: string }, feature: string) => e.active && feature === 'ai_customization' && e.plan !== 'sms_only', EntitlementResolutionError: class extends Error {} }));
vi.mock('./webhook.server', () => ({ reconcileOwnerBookingAlertWebhooks: vi.fn() }));
import { classifyOwnerAlertSendError, getOwnerBookingAlertSettings, mutateOwnerBookingAlertSettings, runOwnerBookingAlerts } from './services.server';
import { getOwnerAlertConfig, ownerAlertReady } from './config.server';
import { OWNER_BOOKING_ALERT_CONSENT_VERSION } from './contracts';

const owner = 'b3105c7d-d3b6-4f53-a5b0-28ad74df7c5b';
const business = '6774e30b-1d56-40d7-bd1c-4e2a1b8b93c7';
const control = { enabled: true, sender: '+15742133931', messaging_profile_id: 'profile', pilot_business_ids: null };
const row = { id: 'outbox', business_id: business, owner_id: owner, kind: 'booking', booking_id: 'booking', sender: control.sender, messaging_profile_id: 'profile', recipient: '+15745551212', content: null, link_token_digest: null, claim_token: 'claim', status: 'claimed', expires_at: new Date(Date.now() + 3600_000).toISOString() };
function builder(data: unknown, error: unknown = null) {
  const obj: Record<string, unknown> = {};
  for (const key of ['select', 'eq', 'is', 'limit', 'order']) obj[key] = vi.fn(() => obj);
  for (const key of ['single', 'maybeSingle']) obj[key] = vi.fn(async () => ({ data, error }));
  obj.then = (resolve: (r: unknown) => unknown) => Promise.resolve({ data, error }).then(resolve);
  return obj;
}
function enable() {
  vi.stubEnv('OWNER_BOOKING_ALERTS_ENABLED', 'true'); vi.stubEnv('OWNER_BOOKING_ALERTS_PROVIDER_REVIEWED', 'true');
  vi.stubEnv('OWNER_BOOKING_ALERTS_SENDER_E164', control.sender); vi.stubEnv('OWNER_BOOKING_ALERTS_MESSAGING_PROFILE_ID', 'profile');
  vi.stubEnv('OWNER_BOOKING_ALERTS_CAMPAIGN_ID', 'CYLIGTZ'); vi.stubEnv('TELNYX_API_KEY', 'test'); vi.stubEnv('TELNYX_PUBLIC_KEY', 'test');
}
beforeEach(() => {
  vi.unstubAllEnvs(); vi.clearAllMocks();
  for (const key of ['OWNER_BOOKING_ALERTS_ENABLED', 'OWNER_BOOKING_ALERTS_PROVIDER_REVIEWED', 'OWNER_BOOKING_ALERTS_SENDER_E164', 'OWNER_BOOKING_ALERTS_MESSAGING_PROFILE_ID', 'OWNER_BOOKING_ALERTS_CAMPAIGN_ID', 'OWNER_BOOKING_ALERTS_PILOT_BUSINESS_IDS']) vi.stubEnv(key, '');
  mocks.entitlement.mockResolvedValue({ active: true, plan: 'chat_only' });
  mocks.from.mockImplementation((table: string) => builder(table === 'owner_booking_alert_control' ? control : table === 'businesses' ? { name: 'Solar Works', timezone: 'America/New_York', owner_id: owner, deleted_at: null, operations_suspended_at: null } : table === 'calendar_bookings' ? { starts_at: new Date(Date.now() + 7200_000).toISOString(), status: 'confirmed' } : []));
  mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => ({ data: name === 'claim_owner_booking_alerts' ? [row] : name === 'begin_owner_booking_alert_send' ? { ...row, status: 'submitting', content: args.p_content } : true, error: null }));
  mocks.send.mockResolvedValue({ data: { id: 'message' } });
});
describe('owner alert settings before activation', () => {
  function missingSchema(code = 'PGRST205') {
    const base = mocks.from.getMockImplementation()!;
    mocks.from.mockImplementation((table: string) => table === 'owner_booking_alert_settings' || table === 'owner_booking_alert_control'
      ? builder(null, { code }) : base(table));
  }
  it.each(['PGRST205', '42P01'])('allows a disabled preview before the new tables exist (%s)', async (code) => {
    missingSchema(code);
    await expect(getOwnerBookingAlertSettings(business)).resolves.toMatchObject({
      status: 'unavailable', available: false, enabled: false, recipient: null, pendingRecipient: null,
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('does not disguise missing schema when activation is requested, even with incomplete provider config', async () => {
    missingSchema();
    vi.stubEnv('OWNER_BOOKING_ALERTS_ENABLED', 'true');
    vi.stubEnv('OWNER_BOOKING_ALERTS_PROVIDER_REVIEWED', 'true');
    await expect(getOwnerBookingAlertSettings(business)).rejects.toMatchObject({ code: 'unavailable' });
  });
  it.each(['42501', '08006', ''])('does not disguise access or connection failures as disabled preview (%s)', async (code) => {
    missingSchema(code);
    await expect(getOwnerBookingAlertSettings(business)).rejects.toBeInstanceOf(Error);
  });
  it('still validates the business before returning pre-activation settings', async () => {
    missingSchema();
    const base = mocks.from.getMockImplementation()!;
    mocks.from.mockImplementation((table: string) => table === 'businesses' ? builder(null, { code: '42501' }) : base(table));
    await expect(getOwnerBookingAlertSettings(business)).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('preserves a saved enrollment while activation is off', async () => {
    const base = mocks.from.getMockImplementation()!;
    mocks.from.mockImplementation((table: string) => table === 'owner_booking_alert_settings'
      ? builder({ owner_id: owner, revision: 7, enabled: true, recipient: row.recipient, verified_at: '2026-09-23T18:00:00Z' }) : base(table));
    await expect(getOwnerBookingAlertSettings(business)).resolves.toMatchObject({
      status: 'unavailable', available: false, enabled: true, recipient: row.recipient, revision: 7,
    });
  });
  it('does not discard a saved enrollment when only the control table is missing', async () => {
    const base = mocks.from.getMockImplementation()!;
    mocks.from.mockImplementation((table: string) => table === 'owner_booking_alert_control'
      ? builder(null, { code: 'PGRST205' }) : base(table));
    await expect(getOwnerBookingAlertSettings(business)).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('requires fresh consent when a booking-only enrollment belongs to a signup account', async () => {
    enable(); const base = mocks.from.getMockImplementation()!;
    mocks.from.mockImplementation((table: string) => table === 'businesses'
      ? builder({ owner_id: owner, primary_goal: 'signup', deleted_at: null, operations_suspended_at: null })
      : table === 'owner_booking_alert_settings'
        ? builder({ owner_id: owner, revision: 3, enabled: true, recipient: row.recipient, verified_at: '2026-09-23T18:00:00Z', consent_version: '2026-09-23-v1' }) : base(table));
    await expect(getOwnerBookingAlertSettings(business)).resolves.toMatchObject({ status: 'not_enabled', enabled: false, available: true, revision: 3 });
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('reopens signup enrollment when a pending token contains the old booking-only consent', async () => {
    enable(); const base = mocks.from.getMockImplementation()!;
    mocks.from.mockImplementation((table: string) => table === 'businesses'
      ? builder({ owner_id: owner, primary_goal: 'signup', deleted_at: null, operations_suspended_at: null })
      : table === 'owner_booking_alert_settings'
        ? builder({ owner_id: owner, revision: 4, enabled: false, recipient: null, pending_recipient: row.recipient, pending_verification_id: 'legacy' })
        : table === 'owner_booking_alert_verifications'
          ? builder({ consent_version: '2026-09-23-v1', consumed_at: null, expires_at: new Date(Date.now() + 600_000).toISOString() }) : base(table));
    await expect(getOwnerBookingAlertSettings(business)).resolves.toMatchObject({ status: 'not_enabled', enabled: false, pendingRecipient: null, revision: 4 });
  });
});
describe('owner alert gates and dispatch', () => {
  it('defaults off without touching the database or Telnyx', async () => {
    await expect(runOwnerBookingAlerts()).resolves.toEqual({ processed: 0, accepted: 0, failed: 0, uncertain: 0 });
    expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled();
  });
  it('requires both reviewed application config and matching database identity and pilot membership', () => {
    enable();
    const config = getOwnerAlertConfig();
    expect(ownerAlertReady(config, control, business)).toBe(true);
    expect(ownerAlertReady(config, { ...control, messaging_profile_id: 'tenant-profile' }, business)).toBe(false);
    expect(ownerAlertReady({ ...config, pilotBusinessIds: ['other'] }, control, business)).toBe(false);
    vi.stubEnv('OWNER_BOOKING_ALERTS_PROVIDER_REVIEWED', 'false'); expect(getOwnerAlertConfig().enabled).toBe(false);
  });
  it('fails closed for malformed explicit pilot lists instead of broadening rollout', () => {
    enable();
    for (const list of [',', '*', 'not-a-business', `${business},`, `,${business}`]) {
      vi.stubEnv('OWNER_BOOKING_ALERTS_PILOT_BUSINESS_IDS', list); expect(getOwnerAlertConfig().enabled).toBe(false);
    }
    vi.stubEnv('OWNER_BOOKING_ALERTS_PILOT_BUSINESS_IDS', business); expect(getOwnerAlertConfig().enabled).toBe(true);
  });
  it('sends for Chat Only from the platform profile without tenant SMS billing', async () => {
    enable(); await expect(runOwnerBookingAlerts()).resolves.toMatchObject({ accepted: 1 });
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ from: control.sender, to: row.recipient, messaging_profile_id: 'profile', text: expect.stringContaining('Solar Works') }), { maxRetries: 0, timeout: 5000 });
    expect(mocks.rpc).toHaveBeenCalledWith('begin_owner_booking_alert_send', expect.objectContaining({ p_link_token_digest: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  });
  it('never resends a potentially accepted request after a network timeout', async () => {
    enable(); mocks.send.mockRejectedValue(new Error('network timeout'));
    await expect(runOwnerBookingAlerts()).resolves.toMatchObject({ uncertain: 1 });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('finish_owner_booking_alert_send', expect.objectContaining({ p_status: 'uncertain', p_provider_message_id: null }));
  });
  it('paces successive submissions in a batch through the final database gate', async () => {
    enable(); vi.useFakeTimers();
    try {
      const base = mocks.rpc.getMockImplementation()!;
      mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => name === 'claim_owner_booking_alerts'
        ? { data: [row, { ...row, id: 'second-outbox', claim_token: 'second-claim' }], error: null }
        : base(name, args));
      const dispatch = runOwnerBookingAlerts();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(mocks.send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(dispatch).resolves.toMatchObject({ accepted: 2 });
      expect(mocks.send).toHaveBeenCalledTimes(2);
      expect(mocks.rpc.mock.calls.filter(([name]) => name === 'begin_owner_booking_alert_send')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('treats provider acceptance followed by failed bookkeeping as uncertain, never known rejection', async () => {
    enable(); const base = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => name === 'finish_owner_booking_alert_send' && args.p_status === 'accepted' ? { data: null, error: { code: 'database_failed' } } : base(name, args));
    await expect(runOwnerBookingAlerts()).resolves.toMatchObject({ uncertain: 1 });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it('respects the database cancellation/throttle result immediately before send', async () => {
    enable(); const base = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => name === 'begin_owner_booking_alert_send' ? { data: { ...row, status: 'cancelled' }, error: null } : base(name, args));
    await runOwnerBookingAlerts(); expect(mocks.send).not.toHaveBeenCalled();
  });
  it('preserves the exact frozen dashboard link on a known nonacceptance retry', async () => {
    enable(); const base = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => name === 'claim_owner_booking_alerts' ? { data: [{ ...row, content: 'frozen body', link_token_digest: 'a'.repeat(64) }], error: null } : base(name, args));
    await runOwnerBookingAlerts();
    expect(mocks.rpc).toHaveBeenCalledWith('begin_owner_booking_alert_send', expect.objectContaining({ p_content: 'frozen body', p_link_token_digest: 'a'.repeat(64) }));
  });
  it.each([[429, 'retry'], [400, 'failed'], [403, 'failed'], [408, 'uncertain'], [409, 'uncertain'], [500, 'uncertain']])('classifies provider HTTP %i conservatively', (status, result) => {
    expect(classifyOwnerAlertSendError({ status }).status).toBe(result);
  });
  it('mirrors a missed carrier STOP after explicit provider rejection without retrying the SMS', async () => {
    enable(); mocks.send.mockRejectedValue({ status: 403, error: { errors: [{ code: '40300' }] } });
    await expect(runOwnerBookingAlerts()).resolves.toMatchObject({ failed: 1 });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('set_owner_booking_alert_suppression', expect.objectContaining({ p_recipient: row.recipient, p_suppressed: true }));
  });
});
describe('owner signup-link alert dispatch', () => {
  const signupRow = { ...row, kind: 'signup_link', booking_id: null, voice_action_id: 'voice-signup' };
  const source = { kind: 'signup', status: 'succeeded', sms_provider_message_id: 'caller-text', sms_accepted_at: new Date().toISOString(), result: { providerMessageId: 'caller-text', deliveryStatus: 'accepted' } };
  function configureSignup(action: unknown = source) {
    enable(); mocks.entitlement.mockResolvedValue({ active: true, plan: 'full' });
    const from = mocks.from.getMockImplementation()!;
    mocks.from.mockImplementation((table: string) => table === 'voice_actions' ? builder(action) : from(table));
    const rpc = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => name === 'claim_owner_booking_alerts'
      ? { data: [signupRow], error: null }
      : name === 'begin_owner_booking_alert_send' ? { data: { ...signupRow, status: 'submitting', content: args.p_content }, error: null } : rpc(name, args));
  }
  it('uses the recorded caller send and platform sender without requiring a calendar', async () => {
    configureSignup();
    await expect(runOwnerBookingAlerts()).resolves.toMatchObject({ processed: 1, accepted: 1 });
    expect(mocks.from).not.toHaveBeenCalledWith('calendar_bookings');
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ from: control.sender, to: row.recipient, messaging_profile_id: control.messaging_profile_id,
      text: expect.stringMatching(/^SimplAssist: Solar Works sent a sign-up link to a caller\. View details: https:\/\/simplassist\.com\/booking-alerts\/open\/[A-Za-z0-9_-]{43} Reply STOP/) }), { maxRetries: 0, timeout: 5000 });
    expect(mocks.rpc).toHaveBeenCalledWith('begin_owner_booking_alert_send', expect.objectContaining({ p_link_token_digest: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  });
  it.each([null, { ...source, status: 'uncertain' }, { ...source, sms_provider_message_id: null }, { ...source, sms_accepted_at: null },
    { ...source, result: { providerMessageId: 'other' } }, ...['delivery_failed', 'sending_failed', 'expired', 'cancelled', 'failed', 'rejected'].map(deliveryStatus => ({ ...source, result: { ...source.result, deliveryStatus } }))])('does not notify from missing, mismatched or failed source evidence (%j)', async action => {
    configureSignup(action); await runOwnerBookingAlerts();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'begin_owner_booking_alert_send')).toBe(false);
  });
  it('rechecks the final SQL gate after composing the signup text', async () => {
    configureSignup(); const base = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => name === 'begin_owner_booking_alert_send'
      ? { data: { ...signupRow, status: 'cancelled' }, error: null } : base(name, args));
    await runOwnerBookingAlerts(); expect(mocks.send).not.toHaveBeenCalled();
  });
});
describe('owner alert mobile enrollment', () => {
  const command = { action: 'enroll', phone: row.recipient, consent: true, consentVersion: OWNER_BOOKING_ALERT_CONSENT_VERSION, expectedRevision: 0 };
  it('requires rate budget before paid lookup, preventing unbounded lookup abuse', async () => {
    enable(); const base = mocks.rpc.getMockImplementation()!;
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => name === 'reserve_owner_booking_alert_lookup' ? { data: false, error: null } : base(name, args));
    await expect(mutateOwnerBookingAlertSettings(business, owner, command)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
  it('does not equate a +1 Canadian mobile or US landline with a US mobile', async () => {
    enable();
    for (const metadata of [{ country_code: 'CA', carrier: { type: 'mobile' } }, { country_code: 'US', carrier: { type: 'fixed line' } }]) {
      mocks.lookup.mockResolvedValue({ data: { phone_number: row.recipient, ...metadata } });
      await expect(mutateOwnerBookingAlertSettings(business, owner, command)).rejects.toMatchObject({ code: 'phone_not_mobile' });
    }
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'configure_owner_booking_alert')).toBe(false);
  });
  it('enrolls an eligible signup owner using the same explicit consent and inbound verification', async () => {
    enable(); mocks.entitlement.mockResolvedValue({ active: true, plan: 'full' });
    mocks.lookup.mockResolvedValue({ data: { phone_number: row.recipient, country_code: 'US', carrier: { type: 'mobile' } } });
    const base = mocks.from.getMockImplementation()!;
    mocks.from.mockImplementation((table: string) => table === 'businesses' ? builder({ owner_id: owner, primary_goal: 'signup', deleted_at: null, operations_suspended_at: null }) : base(table));
    const result = await mutateOwnerBookingAlertSettings(business, owner, command);
    expect(result.verification?.message).toMatch(/^ALERTS [A-Za-z0-9_-]{24}$/);
    expect(mocks.rpc).toHaveBeenCalledWith('configure_owner_booking_alert', expect.objectContaining({ p_consent_version: '2026-09-24-v2', p_disclosure: expect.stringContaining('sign-up links sent to callers') }));
    expect(mocks.from).not.toHaveBeenCalledWith('calendar_bookings');
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
