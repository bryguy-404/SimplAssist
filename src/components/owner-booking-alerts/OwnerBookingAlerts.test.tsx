import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  OWNER_BOOKING_ALERT_CONSENT_VERSION, OWNER_BOOKING_ALERT_DISCLOSURE,
  type OwnerBookingAlertSettings,
} from '@/lib/owner-booking-alerts/contracts';
import { OwnerBookingAlertsContent } from './OwnerBookingAlerts';
import { BookingAlertNudgeContent } from './BookingAlertNudge';
import {
  BOOKING_ALERT_POLL_LIMIT, canPollVerification, loadBookingAlerts,
  shouldShowBookingAlertNudge, updateBookingAlerts,
} from './client';

function fixture(overrides: Partial<OwnerBookingAlertSettings> = {}): OwnerBookingAlertSettings {
  return {
    revision: 3, enabled: false, recipient: null, pendingRecipient: null, verifiedAt: null,
    status: 'not_enabled', available: true, eligible: true, sender: '+15742133931',
    consentVersion: OWNER_BOOKING_ALERT_CONSENT_VERSION, disclosure: OWNER_BOOKING_ALERT_DISCLOSURE,
    nudgeDismissedAt: null, ...overrides,
  };
}
const verification = {
  message: 'ALERTS single-use-code', sender: '+15742133931', expiresAt: '2026-09-23T21:15:00Z',
  smsUrl: 'sms:+15742133931?body=ALERTS%20single-use-code',
};

describe('owner booking alert enrollment', () => {
  it('requires an unchecked, separate consent choice before continuing', () => {
    const html = renderToStaticMarkup(<OwnerBookingAlertsContent settings={fixture()} phone="5745550123" />);
    expect(html).toContain('id="booking-alerts"');
    expect(html).toContain('eligible Chat Only accounts');
    const checkbox = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0];
    expect(checkbox).not.toContain('checked=""');
    expect(checkbox).not.toContain('required=""');
    expect(html.match(/<button[^>]*type="submit"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(html).toContain('https://simplassist.com/privacy#owner-booking-alerts');
    expect(html).toContain('https://simplassist.com/terms#owner-booking-alerts');
    expect(html).toContain('same mobile that receives forwarded calls');
  });

  it('renders the real consent form but does not permit enrollment before platform readiness', () => {
    const html = renderToStaticMarkup(<OwnerBookingAlertsContent settings={fixture({ available: false, eligible: false, status: 'unavailable' })}
      phone="5745550123" consent />);
    expect(html).toContain('Booking texts are not available yet');
    expect(html).toContain('Your mobile number');
    expect(html.match(/<button[^>]*type="submit"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(html).not.toContain('Booking texts are on');
    expect(html).not.toContain('An active plan with calendar booking');
  });

  it('shows one load error and keeps enrollment disabled when settings cannot load', () => {
    const message = 'Booking alerts are temporarily unavailable. Please try again.';
    const html = renderToStaticMarkup(<OwnerBookingAlertsContent settings={null}
      feedback={{ kind: 'error', text: message }} phone="5745550123" consent />);
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    expect(html.split(message)).toHaveLength(2);
    expect(html).not.toContain('Booking alert settings could not be loaded');
    expect(html.match(/<input[^>]*type="tel"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0]).toContain('disabled=""');
    expect(html.match(/<button[^>]*type="submit"[^>]*>/)?.[0]).toContain('disabled=""');
  });

  it('retains known status and actionable feedback after a refresh or mutation fails', () => {
    const message = 'Booking alert settings changed. Refresh and review them before trying again.';
    const html = renderToStaticMarkup(<OwnerBookingAlertsContent settings={fixture({
      enabled: true, status: 'active', recipient: '+15745550123',
    })} feedback={{ kind: 'error', text: message }} />);
    expect(html).toContain('Booking texts are on for new appointments');
    expect(html).toContain('Turn off booking texts');
    expect(html).toContain(message);
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    expect(html.match(/role="status"/g)).toHaveLength(1);
  });

  it('does not expose a verification send link when a gate closes on pending enrollment', () => {
    const html = renderToStaticMarkup(<OwnerBookingAlertsContent settings={fixture({ available: false,
      status: 'pending_verification', pendingRecipient: '+15745550123' })} verification={verification} />);
    expect(html).toContain('Booking texts are not available yet');
    expect(html).not.toContain('sms:');
    expect(html).not.toContain(verification.message);
  });

  it('keeps the current number distinct from the replacement awaiting verification', () => {
    const html = renderToStaticMarkup(<OwnerBookingAlertsContent settings={fixture({ enabled: true,
      status: 'pending_verification', recipient: '+15745550111', pendingRecipient: '+15745550222' })}
      verification={verification} />);
    expect(html).toContain('Saved alert number:');
    expect(html).toContain('+15745550111');
    expect(html).toContain('Verify +15745550222');
    expect(html).toContain('existing number stays saved until the replacement is verified');
    expect(html).not.toContain('Booking texts are on for new');
    expect(html).toContain('Open my texting app');
    expect(html).toContain('does not send it for you');
    expect(html).toContain('Turn off booking texts');
  });

  it('supports refreshing a pending verification after a reload without revealing a token', () => {
    const html = renderToStaticMarkup(<OwnerBookingAlertsContent settings={fixture({
      status: 'pending_verification', pendingRecipient: '+15745550123' })} />);
    expect(html).toContain('Check verification');
    expect(html).toContain('Create a new verification text');
    expect(html).not.toContain('sms:');
    expect(html).not.toContain('ALERTS ');
  });

  it('explains a stopped replacement without claiming the current number stopped', () => {
    const html = renderToStaticMarkup(<OwnerBookingAlertsContent settings={fixture({ enabled: true,
      status: 'pending_verification', recipient: '+15745550111', pendingRecipient: '+15745550222',
      pendingRecipientSuppressed: true })} verification={verification} />);
    expect(html).toContain('This mobile previously stopped SimplAssist alerts');
    expect(html).toContain('From +15745550222');
    expect(html).toContain('then send your verification text');
    expect(html).toContain('other saved alert number is unchanged');
    expect(html).not.toContain('You opted out by text');
  });

  it('explains shared STOP scope and requires a new verification for restarting', () => {
    const html = renderToStaticMarkup(<OwnerBookingAlertsContent settings={fixture({
      status: 'stopped', recipient: '+15745550123' })} />);
    expect(html).toContain('Send START');
    expect(html).toContain('verify your number again');
    expect(html).toContain('pause all SimplAssist booking texts');
    expect(html).toContain('affects this business only');
  });

  it('reports bounded checking without claiming the number was verified', () => {
    const html = renderToStaticMarkup(<OwnerBookingAlertsContent settings={fixture({
      status: 'pending_verification', pendingRecipient: '+15745550123' })} verification={verification} pollingStopped />);
    expect(html).toContain('Automatic checking has paused');
    expect(html).not.toContain('Booking texts are on');
    const now = Date.parse('2026-09-23T21:00:00Z');
    expect(canPollVerification(verification.expiresAt, 0, now)).toBe(true);
    expect(canPollVerification(verification.expiresAt, BOOKING_ALERT_POLL_LIMIT, now)).toBe(false);
    expect(canPollVerification(verification.expiresAt, 0, Date.parse(verification.expiresAt))).toBe(false);
    expect(canPollVerification('invalid', 0, now)).toBe(false);
  });
});

describe('owner booking alert API client', () => {
  it('sends explicit versioned consent and a revision without customer SMS or forwarding fields', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ alerts: fixture({ pendingRecipient: '+15745550123', status: 'pending_verification', verification }) }));
    await updateBookingAlerts({ action: 'enroll', phone: '5745550123', consent: true,
      consentVersion: OWNER_BOOKING_ALERT_CONSENT_VERSION, expectedRevision: 3 }, fetcher);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/settings/booking-alerts', {
      method: 'PATCH', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'enroll', phone: '5745550123', consent: true,
        consentVersion: OWNER_BOOKING_ALERT_CONSENT_VERSION, expectedRevision: 3 }),
    });
  });

  it('does not retry a rejected write or display a provider error verbatim', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ error: 'provider details and phone data' }, { status: 409 }));
    await expect(updateBookingAlerts({ action: 'disable', expectedRevision: 3 }, fetcher)).rejects.toThrow('Refresh and review');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed success payloads rather than claiming alerts are enabled', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ alerts: { status: 'active' } }));
    await expect(loadBookingAlerts(undefined, fetcher)).rejects.toThrow('could not be verified');
  });

  it('requires the same disclosure version the client can display and submit', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ alerts: fixture({ consentVersion: 'future-version' }) }));
    await expect(loadBookingAlerts(undefined, fetcher)).rejects.toThrow('could not be verified');
  });

  it.each([
    ['phone_not_mobile', 'US mobile number'],
    ['phone_reserved', 'not a SimplAssist assistant number'],
  ])('shows safe actionable guidance for %s', async (code, text) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ code, error: 'sensitive upstream detail' }, { status: 400 }));
    await expect(loadBookingAlerts(undefined, fetcher)).rejects.toThrow(text);
  });

  it('passes abort signals for bounded client requests', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockResolvedValue(Response.json({ alerts: fixture() }));
    await loadBookingAlerts(controller.signal, fetcher);
    expect(fetcher).toHaveBeenCalledWith('/api/settings/booking-alerts', { method: 'GET', signal: controller.signal, cache: 'no-store' });
  });
});

describe('booking alert dashboard invitation', () => {
  it('offers setup only for an available eligible account with no prior enrollment or dismissal', () => {
    expect(shouldShowBookingAlertNudge(fixture())).toBe(true);
    for (const override of [{ available: false }, { eligible: false }, { enabled: true },
      { recipient: '+15745550123' }, { pendingRecipient: '+15745550123' },
      { nudgeDismissedAt: '2026-09-23T21:00:00Z' }]) {
      expect(shouldShowBookingAlertNudge(fixture(override))).toBe(false);
    }
    expect(shouldShowBookingAlertNudge(null)).toBe(false);
  });

  it('identifies the SimplAssist program and links directly to the setting', () => {
    const html = renderToStaticMarkup(<BookingAlertNudgeContent />);
    expect(html).toContain('SimplAssist can text your mobile');
    expect(html).toContain('href="/settings#booking-alerts"');
    expect(html).toContain('aria-label="Dismiss booking alert setup"');
    expect(html).not.toContain('call forwarding');
  });
});
