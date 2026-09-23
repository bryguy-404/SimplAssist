import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ recover: vi.fn() }));
vi.mock('@/lib/google/bookingReconciler', () => ({ reconcilePendingCalendarBookings: mocks.recover }));
import { POST } from './route';
const token = 'x'.repeat(32);
const request = (value = token) => new NextRequest('https://simplassist.com/api/internal/booking-alerts/reconcile', { method: 'POST', headers: { Authorization: `Bearer ${value}` } });
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('OWNER_BOOKING_ALERTS_INTERNAL_TOKEN', token); vi.stubEnv('OWNER_BOOKING_ALERTS_ENABLED', 'true'); vi.stubEnv('OWNER_BOOKING_ALERTS_PROVIDER_REVIEWED', 'true'); });
afterEach(() => vi.unstubAllEnvs());
it('requires the dedicated secret before accessing calendar recovery', async () => {
  expect((await POST(request('wrong'))).status).toBe(404); expect(mocks.recover).not.toHaveBeenCalled();
});
it('does no provider work before review and activation', async () => {
  vi.stubEnv('OWNER_BOOKING_ALERTS_PROVIDER_REVIEWED', 'false');
  expect((await POST(request())).status).toBe(200); expect(mocks.recover).not.toHaveBeenCalled();
});
it('admits bounded recovery independently of SMS dispatch and voice', async () => {
  const response = await POST(request()); expect(response.status).toBe(200);
  expect(mocks.recover).toHaveBeenCalledExactlyOnceWith({ deadlineAt: expect.any(Number) });
});
it('makes a recovery failure retryable without exposing provider details', async () => {
  mocks.recover.mockRejectedValue(new Error('private'));
  const response = await POST(request()); expect(response.status).toBe(503); expect(await response.text()).not.toContain('private');
});
