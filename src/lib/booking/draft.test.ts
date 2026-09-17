import { describe, it, expect } from 'vitest';
import { bookingDraftSummary, bookingDraftMissingFields, prepareBookingInput } from './draft';
import type { BookingSnapshot } from './contracts';
const snapshot: BookingSnapshot = { offering: { serviceId: 'id', serviceName: 'Estimate', settingsRevision: 1, format: 'phone_callback', label: 'Consultation', durationMinutes: 60, businessAddress: null, requiresCustomerAddress: false }, name: 'Sam', phone: '+15555550100', email: null, emailAsked: true, customerAddress: null, startTime: '2026-09-23T10:00:00', requestedTime: null, timezone: 'America/Indiana/Indianapolis', mode: 'schedule_direct' };
describe('booking review', () => {
  it('accepts declined email and includes format, duration, timezone and identity', () => {
    expect(bookingDraftMissingFields(snapshot)).toEqual([]);
    const review = bookingDraftSummary(snapshot);
    for (const fact of ['Consultation','Estimate','60 minutes','Sam','+15555550100','no email invitation','America/Indiana/Indianapolis','business will call']) expect(review).toContain(fact);
  });
  it('requires a customer address for direct site visits', () => {
    expect(bookingDraftMissingFields({ ...snapshot, offering: { ...snapshot.offering, format: 'customer_site', requiresCustomerAddress: true } })).toEqual(['customer address']);
  });
  it('collect-info requests retain missing fields without claiming confirmation', () => {
    const request = { ...snapshot, mode: 'collect_info' as const, name: '', phone: null, startTime: null, requestedTime: 'next week' };
    expect(bookingDraftMissingFields(request)).toEqual([]);
    expect(bookingDraftSummary(request)).toContain('not a confirmed appointment');
    expect(bookingDraftSummary(request)).toContain('next week');
  });
  it('does not accept duration or fixed business address from the model', () => {
    expect(prepareBookingInput.safeParse({ emailAsked: true, durationMinutes: 1 }).success).toBe(false);
    expect(prepareBookingInput.safeParse({ emailAsked: true, businessAddress: 'invented' }).success).toBe(false);
  });
});
