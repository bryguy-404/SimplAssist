import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), entitlements: vi.fn(), feature: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { from: mocks.from, rpc: mocks.rpc } }));
vi.mock('@/lib/billing/entitlements', () => ({ resolveBusinessEntitlements: mocks.entitlements, canUseFeature: mocks.feature }));
import { getBookingSettings, updateBookingSettings } from './settings.server';
const defaults = { format: 'phone_callback', label: 'Estimate', durationMinutes: 60, businessAddress: null };
let rows: Record<string, unknown>;
function query(table: string) {
  const value = { data: rows[table], error: null };
  const chain = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(), then: (resolve: (value: unknown) => unknown) => Promise.resolve(value).then(resolve) };
  chain.select.mockReturnValue(chain); chain.eq.mockReturnValue(chain); chain.maybeSingle.mockResolvedValue(value);
  return chain;
}
beforeEach(() => {
  vi.clearAllMocks();
  rows = { booking_settings: { revision: 1, defaults }, booking_service_settings: [], businesses: { owner_id: 'owner', onboarding_completed_at: '2026-01-01', deleted_at: null } };
  mocks.from.mockImplementation(query); mocks.feature.mockReturnValue(true); mocks.entitlements.mockResolvedValue({}); mocks.rpc.mockResolvedValue({ data: 1, error: null });
});
describe('booking settings service', () => {
  it('loads neutral defaults for legacy businesses', async () => {
    rows.booking_settings = null;
    expect(await getBookingSettings('business')).toEqual({ revision: 0, defaults: null, services: [] });
  });
  it('rechecks paid access and passes trusted identity and revision to the atomic save', async () => {
    await updateBookingSettings('business', 'owner', { expectedRevision: 0, defaults, services: [] });
    expect(mocks.entitlements).toHaveBeenCalledWith('business');
    expect(mocks.rpc).toHaveBeenCalledWith('configure_booking_settings', { p_business_id: 'business', p_owner_id: 'owner', p_expected_revision: 0, p_defaults: defaults, p_services: [] });
  });
  it.each(['removed', 'deleted', 'unpaid'])('rejects %s owner before writing', async condition => {
    rows.businesses = { owner_id: condition === 'removed' ? null : 'owner', onboarding_completed_at: '2026-01-01', deleted_at: condition === 'deleted' ? '2026-01-02' : null };
    mocks.feature.mockReturnValue(condition !== 'unpaid');
    await expect(updateBookingSettings('business', 'owner', { expectedRevision: 0, defaults, services: [] })).rejects.toThrow('forbidden');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('permits pre-checkout owner configuration without granting execution', async () => {
    rows.businesses = { owner_id: 'owner', onboarding_completed_at: null, deleted_at: null };
    await updateBookingSettings('business', 'owner', { expectedRevision: 0, defaults, services: [] });
    expect(mocks.entitlements).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it('surfaces concurrent revision conflict without retrying', async () => {
    mocks.rpc.mockResolvedValue({ error: { code: '40001' } });
    await expect(updateBookingSettings('business', 'owner', { expectedRevision: 0, defaults, services: [] })).rejects.toThrow('conflict');
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});
