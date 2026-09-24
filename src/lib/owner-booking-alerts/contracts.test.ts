import { describe, expect, it } from 'vitest';
import { bookingAlertMessage, signupLinkAlertMessage, normalizeOwnerAlertPhone, OWNER_BOOKING_ALERT_CONSENT_VERSION, ownerBookingAlertMutationSchema } from './contracts';

describe('owner booking alert enrollment and privacy contract', () => {
  it('requires explicit current consent and a revision; never silently adopts old consent', () => {
    const enrollment = { action: 'enroll', phone: '(574) 555-1212', expectedRevision: 0, consent: true, consentVersion: OWNER_BOOKING_ALERT_CONSENT_VERSION };
    expect(ownerBookingAlertMutationSchema.safeParse(enrollment).success).toBe(true);
    for (const alteration of [{ consent: false }, { consentVersion: 'old' }, { expectedRevision: -1 }, { businessId: 'other' }]) {
      expect(ownerBookingAlertMutationSchema.safeParse({ ...enrollment, ...alteration }).success).toBe(false);
    }
  });
  it('normalizes domestic formatting but does not accept international/executable/extension input', () => {
    expect(normalizeOwnerAlertPhone('(574) 555-1212')).toBe('+15745551212');
    expect(normalizeOwnerAlertPhone('+1 574.555.1212')).toBe('+15745551212');
    for (const phone of ['+44 20 7946 0958', '5745551212 ext 2', '+15745551212;foo', '1574+5551212', '1234567890']) expect(normalizeOwnerAlertPhone(phone)).toBeNull();
  });
  it('formats the actual appointment timezone across DST and limits user-entered text', () => {
    const common = { businessName: 'Solar\nWorks', timezone: 'America/New_York', dashboardUrl: `https://simplassist.com/booking-alerts/open/${'a'.repeat(43)}` };
    expect(bookingAlertMessage({ ...common, startsAt: '2026-07-01T14:00:00Z' })).toContain('Jul 1, 2026, 10:00 AM EDT');
    expect(bookingAlertMessage({ ...common, startsAt: '2026-12-01T15:00:00Z' })).toContain('Dec 1, 2026, 10:00 AM EST');
    expect(bookingAlertMessage({ ...common, startsAt: '2026-12-01T15:00:00Z' })).toContain('Solar Works has a new appointment');
    expect(() => bookingAlertMessage({ ...common, startsAt: '2026-12-01', dashboardUrl: 'https://attacker.example/dashboard' })).toThrow();
  });
  it('describes a sign-up link sent to a caller without claiming registration or exposing caller details', () => {
    const dashboardUrl = `https://simplassist.com/booking-alerts/open/${'a'.repeat(43)}`;
    expect(signupLinkAlertMessage({ businessName: 'Solar\nWorks\u202e', dashboardUrl })).toBe(`SimplAssist: Solar Works sent a sign-up link to a caller. View details: ${dashboardUrl} Reply STOP to opt out; HELP for help.`);
    expect(() => signupLinkAlertMessage({ businessName: 'Solar Works', dashboardUrl: 'https://attacker.example/dashboard' })).toThrow();
    expect(() => signupLinkAlertMessage({ businessName: 'Solar Works', dashboardUrl: `${dashboardUrl}?next=https://attacker.example` })).toThrow();
  });
});
