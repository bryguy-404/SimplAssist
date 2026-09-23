import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), rows: [] as unknown[] }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { rpc: mocks.rpc, from: mocks.from } }));
import { resolveBookingAlertLink } from './links.server';
const token = 'a'.repeat(43);
beforeEach(() => {
  vi.clearAllMocks(); mocks.rows = [];
  mocks.rpc.mockResolvedValue({ data: [{ business_id: 'business', owner_id: 'owner' }], error: null });
  mocks.from.mockImplementation(() => {
    const result = { select: vi.fn(() => result), eq: vi.fn(() => result), maybeSingle: vi.fn(async () => mocks.rows.shift()) };
    return result;
  });
});
describe('booking alert navigation', () => {
  it('hashes an opaque token and redirects direct owners to the fixed authenticated dashboard', async () => {
    mocks.rows.push({ data: { owner_id: 'owner', deleted_at: null, partner_id: null } });
    expect(await resolveBookingAlertLink(token)).toBe('https://simplassist.com/dashboard');
    expect(mocks.rpc).toHaveBeenCalledWith('resolve_owner_booking_alert_link', { p_token_hash: createHash('sha256').update(token).digest('hex') });
  });
  it('resolves the current verified partner domain without trusting request-host state', async () => {
    mocks.rows.push({ data: { owner_id: 'owner', deleted_at: null, partner_id: 'partner' } }, { data: { id: 'partner', status: 'active', domain_status: 'connected', custom_domain: 'app.partner.example' } });
    expect(await resolveBookingAlertLink(token)).toBe('https://app.partner.example/dashboard');
  });
  it.each(['https://evil.example', 'partner.example/path', 'partner.example:443', 'evil.example@partner.example', 'simplassist.com', 'Partner.Example', 'partner.example.'])('rejects invalid or colliding assigned host %s', async (domain) => {
    mocks.rows.push({ data: { owner_id: 'owner', deleted_at: null, partner_id: 'partner' } }, { data: { id: 'partner', status: 'active', domain_status: 'connected', custom_domain: domain } });
    await expect(resolveBookingAlertLink(token)).rejects.toMatchObject({ status: 404 });
  });
  it.each([{ owner_id: 'new-owner', deleted_at: null }, { owner_id: 'owner', deleted_at: '2026-09-23' }, { owner_id: null, deleted_at: null }])('revokes navigation on lost ownership/deletion', async (business) => {
    mocks.rows.push({ data: { ...business, partner_id: null } });
    await expect(resolveBookingAlertLink(token)).rejects.toMatchObject({ status: 404 });
  });
  it('does not fall back to the wrong workspace when a partner is unavailable', async () => {
    mocks.rows.push({ data: { owner_id: 'owner', deleted_at: null, partner_id: 'partner' } }, { data: { id: 'partner', status: 'inactive', domain_status: 'connected', custom_domain: 'app.partner.example' } });
    await expect(resolveBookingAlertLink(token)).rejects.toMatchObject({ status: 404 });
  });
  it('rejects expired or revoked bindings without a business lookup', async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    await expect(resolveBookingAlertLink(token)).rejects.toMatchObject({ status: 404 });
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('distinguishes unavailable storage without leaking its error', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'private' } });
    await expect(resolveBookingAlertLink(token)).rejects.toMatchObject({ status: 503, message: 'booking_alert_link_unavailable' });
  });
  it.each(['short', 'a'.repeat(44), 'a'.repeat(42) + '/'])('rejects malformed tokens before storage', async (value) => {
    await expect(resolveBookingAlertLink(value)).rejects.toMatchObject({ status: 404 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
