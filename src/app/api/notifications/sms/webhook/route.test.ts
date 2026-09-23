import { NextRequest } from 'next/server';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/owner-booking-alerts/webhook.server', () => ({ handleOwnerBookingAlertWebhook: mocks.handle }));
vi.mock('@/lib/owner-booking-alerts/services.server', () => ({ OwnerBookingAlertError: class extends Error { constructor(readonly status: number) { super('private'); } } }));
import { POST } from './route';
const attempt = '11111111-1111-4111-8111-111111111111';
const request = (body = '{ "data": {} }', query = '') => new NextRequest(`https://simplassist.com/api/notifications/sms/webhook${query}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'telnyx-signature-ed25519': 'signature' }, body });
beforeEach(() => { vi.clearAllMocks(); mocks.handle.mockResolvedValue({ ignored: true }); });
it('passes exact raw bytes to the signature verifier and scoped attempt reference', async () => {
  const raw = '{ "data": {} }'; expect((await POST(request(raw, `?attempt=${attempt}`))).status).toBe(200);
  expect(mocks.handle).toHaveBeenCalledExactlyOnceWith(raw, expect.objectContaining({ 'telnyx-signature-ed25519': 'signature' }), attempt);
});
it.each(['?attempt=evil', `?attempt=${attempt}&attempt=${attempt}`])('rejects malformed/ambiguous references before processing', async (query) => {
  expect((await POST(request('{}', query))).status).toBe(400); expect(mocks.handle).not.toHaveBeenCalled();
});
it('refuses oversized unsigned payloads', async () => {
  expect((await POST(request('a'.repeat(65537)))).status).toBe(400); expect(mocks.handle).not.toHaveBeenCalled();
});
it('requests provider retry when durable storage fails rather than acknowledging lost work', async () => {
  mocks.handle.mockRejectedValue(new Error('private payload')); const response = await POST(request());
  expect(response.status).toBe(503); expect(await response.text()).not.toContain('private payload');
});
