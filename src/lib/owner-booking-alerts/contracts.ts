import { z } from 'zod';

export const OWNER_BOOKING_ALERT_CONSENT_VERSION = '2026-09-24-v2';
export const OWNER_BOOKING_ALERT_DISCLOSURE = 'I agree to receive automated SimplAssist business-alert texts about confirmed bookings and sign-up links sent to callers at the mobile number I provide for this business. A sign-up-link alert does not confirm completed registration. Message frequency varies. Message and data rates may apply. Reply STOP to stop alerts or HELP for help. Consent is optional and is not a condition of purchase. If this number receives SimplAssist business alerts for multiple businesses, STOP stops all of those alerts.';
export const OWNER_BOOKING_ALERT_PRIVACY_URL = 'https://simplassist.com/privacy';
export const OWNER_BOOKING_ALERT_TERMS_URL = 'https://simplassist.com/terms';
export const OWNER_BOOKING_ALERT_PROGRAM_URL = 'https://simplassist.com/booking-alerts';

export const ownerBookingAlertMutationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('enroll'), phone: z.string().min(1).max(32), consent: z.literal(true), consentVersion: z.literal(OWNER_BOOKING_ALERT_CONSENT_VERSION), expectedRevision: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.enum(['disable', 'dismiss']), expectedRevision: z.number().int().nonnegative() }).strict(),
]);
export type OwnerBookingAlertMutation = z.infer<typeof ownerBookingAlertMutationSchema>;

export const ownerBookingAlertSettingsSchema = z.object({
  revision: z.number().int().nonnegative(), enabled: z.boolean(), recipient: z.string().nullable(),
  pendingRecipient: z.string().nullable(), verifiedAt: z.string().nullable(),
  pendingRecipientSuppressed: z.boolean().optional(),
  status: z.enum(['unavailable', 'not_enabled', 'pending_verification', 'active', 'paused', 'stopped']),
  available: z.boolean(), eligible: z.boolean(), sender: z.string().nullable(),
  consentVersion: z.string(), disclosure: z.string(), nudgeDismissedAt: z.string().nullable(),
  verification: z.object({ message: z.string(), sender: z.string(), expiresAt: z.string(), smsUrl: z.string() }).optional(),
});
export type OwnerBookingAlertSettings = z.infer<typeof ownerBookingAlertSettingsSchema>;

/** NANP syntax alone does not establish US location or a mobile line; enrollment checks Telnyx carrier metadata too. */
export function normalizeOwnerAlertPhone(value: string): string | null {
  if (!/^[+\d\s().-]+$/.test(value.trim())) return null;
  const compact = value.trim().replace(/[\s().-]/g, '');
  const digits = compact.replace(/^\+/, '');
  const normalized = digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith('1') ? `+${digits}` : null;
  return normalized && /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(normalized) ? normalized : null;
}

export function ownerAlertVerificationMessage(token: string): string { return `ALERTS ${token}`; }
export function ownerAlertSmsUrl(sender: string, message: string): string { return `sms:${sender}?body=${encodeURIComponent(message)}`; }

function alertMessageContext(businessName: string, dashboardUrl: string): string {
  const parsed = new URL(dashboardUrl);
  if (parsed.origin !== 'https://simplassist.com' || !/^\/booking-alerts\/open\/[A-Za-z0-9_-]{43}$/.test(parsed.pathname) || parsed.search || parsed.hash) throw new Error('invalid_alert_link');
  return businessName.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Your business';
}

/** Never include customer information, line breaks from user input, or unbounded business names. */
export function bookingAlertMessage(input: { businessName: string; startsAt: string; timezone: string; dashboardUrl: string }): string {
  const date = new Date(input.startsAt);
  if (!Number.isFinite(date.getTime())) throw new Error('invalid_booking_time');
  const name = alertMessageContext(input.businessName, input.dashboardUrl);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: input.timezone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(date);
  return `SimplAssist: ${name} has a new appointment booked for ${time}. View details: ${input.dashboardUrl} Reply STOP to opt out; HELP for help.`;
}

/** Records a provider-accepted caller text, never a completed registration or delivery guarantee. */
export function signupLinkAlertMessage(input: { businessName: string; dashboardUrl: string }): string {
  const name = alertMessageContext(input.businessName, input.dashboardUrl);
  return `SimplAssist: ${name} sent a sign-up link to a caller. View details: ${input.dashboardUrl} Reply STOP to opt out; HELP for help.`;
}

export const OWNER_ALERT_ENROLLMENT_MESSAGE = 'SimplAssist business alerts are enabled for this business. Message frequency varies. Msg & data rates may apply. Reply STOP to stop alerts or HELP for help.';
