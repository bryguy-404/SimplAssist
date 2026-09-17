import { z } from 'zod';

const displayText = z.string().trim().min(1).max(240).refine(v => !/[\u0000-\u001f\u007f]/.test(v), 'Use plain text');
export const bookingFormatSchema = z.enum(['phone_callback', 'business_visit', 'customer_site']);
export const bookingOfferingSchema = z.object({
  format: bookingFormatSchema,
  label: displayText,
  durationMinutes: z.number().int().min(30).max(240).multipleOf(30),
  businessAddress: z.string().trim().max(500).refine(v => !/[\u0000-\u001f\u007f]/.test(v), 'Use plain text').nullable(),
}).strict().superRefine((v, ctx) => {
  if (v.format === 'business_visit' && !v.businessAddress)
    ctx.addIssue({ code: 'custom', path: ['businessAddress'], message: 'Enter the address customers should visit.' });
  if (v.format !== 'business_visit' && v.businessAddress !== null)
    ctx.addIssue({ code: 'custom', path: ['businessAddress'], message: 'Only business visits have a fixed address.' });
});
export type BookingOffering = z.infer<typeof bookingOfferingSchema>;
export const serviceOverrideSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit') }).strict(),
  z.object({ mode: z.literal('unavailable') }).strict(),
  z.object({ mode: z.literal('override'), offering: bookingOfferingSchema }).strict(),
]);
export const bookingSettingsUpdateSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  defaults: bookingOfferingSchema,
  services: z.array(z.object({ serviceId: z.string().uuid(), ...{ setting: serviceOverrideSchema } }).strict()).max(500),
}).strict().refine(v => new Set(v.services.map(s => s.serviceId)).size === v.services.length, 'Duplicate service override');
export interface BookingSettings {
  revision: number;
  defaults: BookingOffering | null;
  services: Array<{ serviceId: string; setting: z.infer<typeof serviceOverrideSchema> }>;
}
export interface EffectiveBookingOffering {
  serviceId: string;
  serviceName: string;
  settingsRevision: number;
  format: BookingOffering['format'] | 'unspecified';
  label: string;
  durationMinutes: number;
  businessAddress: string | null;
  requiresCustomerAddress: boolean;
}
export function resolveBookingOffering(settings: BookingSettings, service: { id: string; name: string; is_active: boolean }): EffectiveBookingOffering | null {
  if (!service.is_active) return null;
  const override = settings.services.find(s => s.serviceId === service.id)?.setting;
  if (override?.mode === 'unavailable') return null;
  const offering = override?.mode === 'override' ? override.offering : settings.defaults;
  return {
    serviceId: service.id, serviceName: service.name, settingsRevision: settings.revision,
    format: offering?.format ?? 'unspecified', label: offering?.label ?? 'Appointment',
    durationMinutes: offering?.durationMinutes ?? 30, businessAddress: offering?.businessAddress ?? null,
    requiresCustomerAddress: offering?.format === 'customer_site',
  };
}

export interface BookingSnapshot {
  offering: EffectiveBookingOffering;
  name: string;
  phone: string | null;
  email: string | null;
  emailAsked: boolean;
  customerAddress: string | null;
  startTime: string | null;
  requestedTime: string | null;
  timezone: string;
  mode: 'schedule_direct' | 'collect_info';
}
export interface BookingDraft {
  id: string; business_id: string; conversation_id: string; revision: number;
  status: 'preparing' | 'awaiting_confirmation' | 'submitted' | 'confirmed' | 'requested' | 'uncertain' | 'failed' | 'abandoned' | 'superseded';
  snapshot: BookingSnapshot;
  summary_message_id: string | null;
  confirmation_message_id: string | null;
}
export interface BookingNotification {
  id: string; business_id: string; draft_id: string; draft_revision: number;
  purpose: 'review' | 'confirmation';
  status: 'authorized' | 'submitting' | 'accepted' | 'delivered' | 'failed' | 'uncertain' | 'cancelled';
  provider_message_id: string | null;
}
