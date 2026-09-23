import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn(), recover: vi.fn() }));
vi.mock('@/lib/owner-booking-alerts/services.server', () => ({ runOwnerBookingAlerts: mocks.run }));
vi.mock('@/lib/google/bookingReconciler', () => ({ reconcilePendingCalendarBookings: mocks.recover }));
import { POST } from './route';
const token = 'x'.repeat(32);
const request = (value = token) => new NextRequest('https://simplassist.com/api/internal/booking-alerts/run', { method: 'POST', headers: { Authorization: `Bearer ${value}` } });
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('OWNER_BOOKING_ALERTS_INTERNAL_TOKEN', token); vi.stubEnv('OWNER_BOOKING_ALERTS_ENABLED', 'false'); vi.stubEnv('OWNER_BOOKING_ALERTS_PROVIDER_REVIEWED', 'false'); mocks.run.mockResolvedValue({ processed: 0, accepted: 0, failed: 0, uncertain: 0 }); });
afterEach(() => vi.unstubAllEnvs());
it('requires the dedicated worker secret before any work', async () => {
  expect((await POST(request('wrong'))).status).toBe(404); expect(mocks.run).not.toHaveBeenCalled();
});
it('does not run calendar/provider recovery while rollout is off', async () => {
  expect((await POST(request())).status).toBe(200); expect(mocks.recover).not.toHaveBeenCalled();
});
it('does not append Google recovery to the SMS request time budget even when enabled', async () => {
  vi.stubEnv('OWNER_BOOKING_ALERTS_ENABLED', 'true'); vi.stubEnv('OWNER_BOOKING_ALERTS_PROVIDER_REVIEWED', 'true');
  const response = await POST(request()); expect(response.status).toBe(200);
  expect(mocks.recover).not.toHaveBeenCalled();
  expect(response.headers.get('cache-control')).toBe('no-store');
});
it('reports a retryable maintenance failure without provider details', async () => {
  mocks.run.mockRejectedValue(new Error('secret')); const response = await POST(request());
  expect(response.status).toBe(503); expect(await response.text()).not.toContain('secret');
});
