import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ access: vi.fn(), get: vi.fn(), mutate: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/customer/workspaceRouteResponse.server', () => ({ requireFreshWorkspaceRouteAccess: mocks.access }));
vi.mock('@/lib/owner-booking-alerts/services.server', () => ({
  getOwnerBookingAlertSettings: mocks.get, mutateOwnerBookingAlertSettings: mocks.mutate,
  OwnerBookingAlertError: class extends Error { constructor(readonly code: string, readonly status = code === 'invalid' ? 400 : 503) { super(code); } },
}));
import { GET, PATCH } from './route';
import { OWNER_BOOKING_ALERT_CONSENT_VERSION } from '@/lib/owner-booking-alerts/contracts';
const body = { action: 'enroll', phone: '(574) 555-1234', consent: true, consentVersion: OWNER_BOOKING_ALERT_CONSENT_VERSION, expectedRevision: 0 };
const request = (value: unknown) => new NextRequest('https://simplassist.com/api/settings/booking-alerts', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
beforeEach(() => {
  vi.clearAllMocks(); mocks.access.mockResolvedValue({ ok: true, access: { business: { id: 'business' }, user: { id: 'owner' } } });
  mocks.get.mockResolvedValue({ status: 'unavailable' }); mocks.mutate.mockResolvedValue({ status: 'pending_verification' });
});
describe('booking alert settings API', () => {
  it.each([401, 403, 503])('honors fresh workspace access before all queries (%s)', async (status) => {
    mocks.access.mockResolvedValue({ ok: false, response: NextResponse.json({}, { status }) });
    expect((await GET()).status).toBe(status); expect((await PATCH(request(body))).status).toBe(status);
    expect(mocks.get).not.toHaveBeenCalled(); expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it('returns only current workspace settings without caching phone/verification data', async () => {
    const response = await GET(); expect(await response.json()).toEqual({ alerts: { status: 'unavailable' } });
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith('business'); expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('uses server owner/business identity for verification', async () => {
    expect((await PATCH(request(body))).status).toBe(200);
    expect(mocks.mutate).toHaveBeenCalledExactlyOnceWith('business', 'owner', body);
  });
  it.each([{ ...body, consent: false }, { ...body, consentVersion: 'old' }, { ...body, expectedRevision: -1 }, { ...body, businessId: 'other' }, { ...body, ownerId: 'other' }, { action: 'enable', expectedRevision: 0 }])('rejects forged or unconsented enrollment %#', async (value) => {
    expect((await PATCH(request(value))).status).toBe(400); expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it('rejects oversized/chunked payloads before service invocation', async () => {
    expect((await PATCH(request({ ...body, phone: '0'.repeat(5000) }))).status).toBe(400);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it('does not expose unexpected storage/provider errors', async () => {
    mocks.get.mockRejectedValue(new Error('private number')); const response = await GET();
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('private number');
  });
});
