import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { canUseFeature, resolveBusinessEntitlements } from '@/lib/billing/entitlements';
import { bookingOfferingSchema, bookingSettingsUpdateSchema, serviceOverrideSchema, resolveBookingOffering, type BookingSettings } from './contracts';

export class BookingSettingsError extends Error {
  constructor(public readonly code: 'forbidden' | 'conflict' | 'unavailable') { super(`booking_settings_${code}`); }
}
export async function getBookingSettings(businessId: string): Promise<BookingSettings> {
  const [settings, overrides] = await Promise.all([
    supabaseAdmin.from('booking_settings').select('revision,defaults').eq('business_id', businessId).maybeSingle(),
    supabaseAdmin.from('booking_service_settings').select('service_id,setting').eq('business_id', businessId),
  ]);
  if (settings.error || overrides.error) throw new BookingSettingsError('unavailable');
  return {
    revision: settings.data?.revision ?? 0,
    defaults: settings.data?.defaults == null ? null : bookingOfferingSchema.parse(settings.data.defaults),
    services: (overrides.data ?? []).map(s => ({ serviceId: s.service_id, setting: serviceOverrideSchema.parse(s.setting) })),
  };
}
export async function updateBookingSettings(businessId: string, ownerId: string, input: unknown) {
  const parsed = bookingSettingsUpdateSchema.parse(input);
  const business = await supabaseAdmin.from('businesses').select('owner_id,onboarding_completed_at,deleted_at').eq('id', businessId).maybeSingle();
  if (business.error || !business.data) throw new BookingSettingsError('unavailable');
  if (business.data.owner_id !== ownerId || business.data.deleted_at !== null) throw new BookingSettingsError('forbidden');
  // Pre-checkout onboarding may save configuration but grants no booking execution rights.
  if (business.data.onboarding_completed_at !== null) {
    const entitlements = await resolveBusinessEntitlements(businessId);
    if (!canUseFeature(entitlements, 'direct_booking')) throw new BookingSettingsError('forbidden');
  }
  const result = await supabaseAdmin.rpc('configure_booking_settings', {
    p_business_id: businessId, p_owner_id: ownerId, p_expected_revision: parsed.expectedRevision,
    p_defaults: parsed.defaults, p_services: parsed.services,
  });
  if (result.error) throw new BookingSettingsError(result.error.code === '40001' ? 'conflict' : result.error.code === '42501' ? 'forbidden' : 'unavailable');
  return getBookingSettings(businessId);
}
export async function getEffectiveBookingOffering(businessId: string, serviceId: string) {
  const [settings, service] = await Promise.all([
    getBookingSettings(businessId),
    supabaseAdmin.from('services').select('id,name,is_active').eq('business_id', businessId).eq('id', serviceId).maybeSingle(),
  ]);
  if (service.error) throw new BookingSettingsError('unavailable');
  return service.data ? resolveBookingOffering(settings, service.data) : null;
}
