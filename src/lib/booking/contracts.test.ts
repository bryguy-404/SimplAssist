import { describe, expect, it } from 'vitest';
import { bookingOfferingSchema, bookingSettingsUpdateSchema, resolveBookingOffering, type BookingSettings } from './contracts';
const service = { id: '00000000-0000-4000-8000-000000000001', name: 'Estimate', is_active: true };
const defaults = { format: 'phone_callback' as const, label: 'Estimate', durationMinutes: 60, businessAddress: null };
const settings: BookingSettings = { revision: 3, defaults, services: [] };
describe('booking offerings', () => {
  it('preserves neutral legacy appointments without inventing an address', () => {
    expect(resolveBookingOffering({ revision: 0, defaults: null, services: [] }, service)).toMatchObject({ format: 'unspecified', durationMinutes: 30, businessAddress: null });
  });
  it('uses business defaults and explicit service overrides', () => {
    expect(resolveBookingOffering(settings, service)).toMatchObject({ durationMinutes: 60, format: 'phone_callback', settingsRevision: 3 });
    expect(resolveBookingOffering({ ...settings, services: [{ serviceId: service.id, setting: { mode: 'override', offering: { ...defaults, format: 'customer_site', durationMinutes: 120 } } }] }, service)).toMatchObject({ durationMinutes: 120, requiresCustomerAddress: true });
  });
  it('rejects inactive and direct-unavailable services', () => {
    expect(resolveBookingOffering(settings, { ...service, is_active: false })).toBeNull();
    expect(resolveBookingOffering({ ...settings, services: [{ serviceId: service.id, setting: { mode: 'unavailable' } }] }, service)).toBeNull();
  });
  it.each([0, 15, 31, 45, 241, 300, NaN])('rejects unsupported duration %s', durationMinutes => {
    expect(bookingOfferingSchema.safeParse({ ...defaults, durationMinutes }).success).toBe(false);
  });
  it('requires an explicitly supplied business visit address', () => {
    expect(bookingOfferingSchema.safeParse({ ...defaults, format: 'business_visit' }).success).toBe(false);
    expect(bookingOfferingSchema.safeParse({ ...defaults, format: 'business_visit', businessAddress: '123 Main St' }).success).toBe(true);
    expect(bookingOfferingSchema.safeParse({ ...defaults, businessAddress: 'Private billing address' }).success).toBe(false);
  });
  it('rejects duplicate service entries and client authority fields', () => {
    const item = { serviceId: service.id, setting: { mode: 'inherit' } };
    expect(bookingSettingsUpdateSchema.safeParse({ expectedRevision: 3, defaults, services: [item, item] }).success).toBe(false);
    expect(bookingSettingsUpdateSchema.safeParse({ expectedRevision: 3, defaults, services: [], businessId: service.id }).success).toBe(false);
  });
});
