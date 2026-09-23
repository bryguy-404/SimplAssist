import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('@/lib/owner-booking-alerts/links.server', () => ({
  resolveBookingAlertLink: mock.resolve,
  BookingAlertLinkError: class extends Error { constructor(readonly status: number) { super('unavailable'); } },
}));
import { GET, HEAD } from './route';
beforeEach(() => { vi.clearAllMocks(); mock.resolve.mockResolvedValue('https://app.partner.example/dashboard'); });
it.each([GET, HEAD])('redirects navigation and previews without consuming a token or accepting next/host overrides', async (handler) => {
  const response = await handler(new NextRequest('https://evil.example/booking-alerts/open/token?next=https://evil.example'), { params: { token: 'token' } });
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe('https://app.partner.example/dashboard');
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(mock.resolve).toHaveBeenCalledExactlyOnceWith('token');
});
it('keeps internal failures and identity out of the response', async () => {
  mock.resolve.mockRejectedValue(new Error('private recipient'));
  const response = await GET(new NextRequest('https://simplassist.com/booking-alerts/open/token'), { params: { token: 'token' } });
  expect(response.status).toBe(503); expect(await response.text()).not.toContain('private');
});
