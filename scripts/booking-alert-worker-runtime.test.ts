import { describe, expect, it, vi } from 'vitest';
import { maintainBookingAlerts, recoverBookingAlerts, workerConfiguration } from './booking-alert-worker-runtime';
const env = { NEXT_PUBLIC_APP_URL: 'https://simplassist.com', OWNER_BOOKING_ALERTS_INTERNAL_TOKEN: 'x'.repeat(32) };
describe('independent booking alert worker', () => {
  it.each(['http://simplassist.com', 'https://user:pass@simplassist.com', 'https://simplassist.com/path', 'https://simplassist.com?next=x'])('rejects noncanonical worker origins %s', (url) => {
    expect(() => workerConfiguration({ ...env, NEXT_PUBLIC_APP_URL: url })).toThrow();
  });
  it('rejects a missing/short private credential', () => {
    expect(() => workerConfiguration({ ...env, OWNER_BOOKING_ALERTS_INTERNAL_TOKEN: 'short' })).toThrow();
  });
  it('calls only the bounded maintenance endpoint without following credential-bearing redirects', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    expect(await maintainBookingAlerts(workerConfiguration(env), fetcher)).toBe(true);
    expect(fetcher).toHaveBeenCalledWith('https://simplassist.com/api/internal/booking-alerts/run', expect.objectContaining({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${env.OWNER_BOOKING_ALERTS_INTERNAL_TOKEN}` } }));
  });
  it.each([false, true])('reports failed maintenance without exposing response data', async (throws) => {
    const fetcher = throws ? vi.fn().mockRejectedValue(new Error('secret')) : vi.fn().mockResolvedValue({ ok: false });
    expect(await maintainBookingAlerts(workerConfiguration(env), fetcher)).toBe(false);
  });
  it('gives Google recovery a separate authenticated request and timeout', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    expect(await recoverBookingAlerts(workerConfiguration(env), fetcher)).toBe(true);
    expect(fetcher).toHaveBeenCalledWith('https://simplassist.com/api/internal/booking-alerts/reconcile', expect.objectContaining({ method: 'POST', redirect: 'error', signal: expect.any(AbortSignal) }));
  });
});
