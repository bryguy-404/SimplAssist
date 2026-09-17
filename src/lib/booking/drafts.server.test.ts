import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), operational: vi.fn(), feature: vi.fn(), entitlements: vi.fn(), settings: vi.fn(), book: vi.fn(), request: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { from: mocks.from, rpc: mocks.rpc } }));
vi.mock('@/lib/billing/entitlements', () => ({ canUseFeature: mocks.feature, resolveBusinessEntitlements: mocks.entitlements }));
vi.mock('@/lib/google/bookingOperational.server', () => ({ assertBookingOperationallyAllowed: mocks.operational }));
vi.mock('./settings.server', () => ({ getBookingSettings: mocks.settings }));
vi.mock('@/lib/google/calendar', () => ({ createBooking: mocks.book, BookingSlotUnavailableError: class extends Error {} }));
vi.mock('@/lib/ai/bookingRequests', () => ({ recordBookingRequest: mocks.request }));
import { buildBookingDraft, confirmBookingDraft } from './drafts.server';
const serviceId = '00000000-0000-4000-a089-000000000001';
let rows: Record<string, unknown>; let updates: unknown[];
const input = { serviceId, name: 'Sam', phone: '+15555550100', emailAsked: true, startTime: '2026-09-23T10:00:00' };
const context = { businessId: 'business', conversationId: 'conversation', contactId: 'contact', sourceMessageId: 'source', input };
beforeEach(() => {
  vi.clearAllMocks(); updates = [];
  mocks.feature.mockReturnValue(true); mocks.operational.mockResolvedValue(undefined); mocks.entitlements.mockResolvedValue({});
  mocks.settings.mockResolvedValue({ revision: 1, defaults: { format: 'phone_callback', label: 'Estimate', durationMinutes: 60, businessAddress: null }, services: [] });
  rows = { businesses: { primary_goal: 'book', timezone: 'America/Indiana/Indianapolis' }, ai_settings: { booking_enabled: true, booking_mode: 'schedule_direct' }, services: { id: serviceId, name: 'Assessment', is_active: true } };
  mocks.from.mockImplementation((table: string) => {
    const value = { data: rows[table], error: null };
    const chain: Record<string, unknown> = { then: (resolve: (r: unknown) => unknown) => Promise.resolve(value).then(resolve) };
    for (const method of ['select','eq','single','maybeSingle']) chain[method] = () => chain;
    chain.update = (payload: unknown) => { updates.push(payload); return chain; };
    return chain;
  });
});
describe('shared booking draft execution', () => {
  it('resolves duration and label from saved business settings', async () => {
    const built = await buildBookingDraft(context);
    expect(built.snapshot.offering).toMatchObject({ durationMinutes: 60, label: 'Estimate', serviceName: 'Assessment' });
    expect(built.snapshot.email).toBeNull();
    expect(built.summary).toContain('no email invitation');
    expect(mocks.book).not.toHaveBeenCalled();
  });
  it('rejects missing site address and inactive services before any provider action', async () => {
    mocks.settings.mockResolvedValue({ revision: 1, defaults: { format: 'customer_site', label: 'Visit', durationMinutes: 60, businessAddress: null }, services: [] });
    await expect(buildBookingDraft(context)).rejects.toThrow('customer address');
    rows.services = { id: serviceId, name: 'Assessment', is_active: false };
    await expect(buildBookingDraft(context)).rejects.toThrow('service_unavailable');
    expect(mocks.book).not.toHaveBeenCalled();
  });
  it('rejects signup accounts and missing feature access', async () => {
    rows.businesses = { primary_goal: 'signup', timezone: 'UTC' };
    await expect(buildBookingDraft(context)).rejects.toThrow('booking_unavailable');
    mocks.feature.mockReturnValue(false);
    await expect(buildBookingDraft(context)).rejects.toThrow('not_entitled');
  });
  it('uses the claimed snapshot and confirmation identity instead of model execution parameters', async () => {
    const built = await buildBookingDraft(context);
    mocks.rpc.mockResolvedValue({ data: { execute: true, draft: { id: 'draft', revision: 2, contact_id: 'contact', conversation_id: 'conversation', snapshot: built.snapshot } }, error: null });
    mocks.book.mockResolvedValue({ eventId: 'event' });
    const result = await confirmBookingDraft({ businessId: 'business', draftId: 'draft', revision: 2, confirmationMessageId: 'confirmed-message' });
    expect(result.status).toBe('confirmed');
    expect(mocks.book).toHaveBeenCalledWith('business', { customerName: 'Sam', customerPhone: '+15555550100', customerEmail: undefined, serviceName: 'Assessment', startTime: input.startTime }, built.snapshot.timezone, { contactId: 'contact', conversationId: 'conversation', sourceMessageId: 'confirmed-message' }, undefined, { draftId: 'draft', revision: 2 });
  });
  it('returns prior results on duplicate confirmation without another event or request', async () => {
    mocks.rpc.mockResolvedValue({ data: { execute: false, draft: { status: 'confirmed', result: { status: 'confirmed', eventId: 'original' } } }, error: null });
    expect(await confirmBookingDraft({ businessId: 'business', draftId: 'draft', revision: 2, confirmationMessageId: 'message' })).toMatchObject({ eventId: 'original' });
    expect(mocks.book).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
  });
  it('preserves provider uncertainty rather than retrying a calendar mutation', async () => {
    const built = await buildBookingDraft(context);
    mocks.rpc.mockResolvedValue({ data: { execute: true, draft: { id: 'draft', revision: 2, contact_id: 'contact', conversation_id: 'conversation', snapshot: built.snapshot } }, error: null });
    mocks.book.mockRejectedValue(new Error('timeout after submission'));
    expect(await confirmBookingDraft({ businessId: 'business', draftId: 'draft', revision: 2, confirmationMessageId: 'message' })).toMatchObject({ status: 'uncertain' });
    expect(mocks.book).toHaveBeenCalledTimes(1); expect(updates).toContainEqual(expect.objectContaining({ status: 'uncertain' }));
  });
});
