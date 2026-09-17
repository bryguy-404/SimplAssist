import { z } from 'zod';
import type { BookingSnapshot } from './contracts';
import { businessWallTimeToInstant } from '@/lib/google/calendarTime';
const plain = z.string().trim().min(1).max(500).refine(v => !/[\u0000-\u001f\u007f]/.test(v), 'Use plain text');
export const prepareBookingInput = z.object({
  serviceId: z.string().uuid().optional(),
  requestedService: plain.optional(),
  name: plain.max(200).optional(),
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
  email: z.string().trim().email().max(254).optional(),
  emailAsked: z.boolean(),
  customerAddress: plain.optional(),
  startTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/).optional(),
  requestedTime: plain.optional(),
  newAppointment: z.boolean().optional(),
}).strict();
export type PrepareBookingInput = z.infer<typeof prepareBookingInput>;
export function bookingDraftSummary(snapshot: BookingSnapshot): string {
  const { offering } = snapshot;
  let when = snapshot.requestedTime ?? 'time not specified';
  if (snapshot.mode === 'schedule_direct' && snapshot.startTime) {
    const instant = businessWallTimeToInstant(snapshot.startTime.slice(0,10), snapshot.startTime.slice(11), snapshot.timezone);
    when = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: snapshot.timezone }).format(instant) + ` (${snapshot.timezone})`;
  }
  const location = offering.format === 'phone_callback' ? `The business will call ${snapshot.phone ?? 'phone not provided'}`
    : offering.format === 'business_visit' ? `At ${offering.businessAddress}`
    : offering.format === 'customer_site' ? `At the customer's address: ${snapshot.customerAddress ?? 'not provided'}` : 'Location not specified';
  const identity = `${snapshot.name || 'name not provided'}, phone ${snapshot.phone ?? 'not provided'}, ${snapshot.email ? `email ${snapshot.email}` : 'no email invitation'}`;
  return `${snapshot.mode === 'schedule_direct' ? 'May I book' : 'May I save a request for'} ${offering.label}: ${offering.serviceName}, ${when}, ${offering.durationMinutes} minutes? ${location}. Details: ${identity}.${snapshot.mode === 'collect_info' ? ' This is a request for the business to review, not a confirmed appointment.' : ''} Is all of that correct?`;
}
export function bookingDraftMissingFields(snapshot: BookingSnapshot): string[] {
  if (snapshot.mode === 'collect_info') return [];
  const missing: string[] = [];
  if (!snapshot.name) missing.push('name');
  if (!snapshot.startTime) missing.push('appointment time');
  if (!snapshot.emailAsked) missing.push('ask once whether the customer wants an email invitation (email is optional)');
  if (snapshot.offering.format === 'phone_callback' && !snapshot.phone) missing.push('callback phone number');
  if (snapshot.offering.requiresCustomerAddress && !snapshot.customerAddress) missing.push('customer address');
  return missing;
}
export function isBookingConfirmationEnabled() { return process.env.BOOKING_CONFIRMATION_V2_ENABLED === 'true'; }
