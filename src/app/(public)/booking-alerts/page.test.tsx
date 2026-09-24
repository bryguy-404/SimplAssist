import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OWNER_BOOKING_ALERT_DISCLOSURE } from '@/lib/owner-booking-alerts/contracts';

vi.mock('@/components/legal/LegalDocLayout', () => ({
  LegalDocLayout: ({ title, children }: { title: string; children: ReactNode }) => <main><h1>{title}</h1>{children}</main>,
}));

import BookingAlertsPage from './page';
import PrivacyPage from '../privacy/page';
import TermsPage from '../terms/page';

describe('public owner booking SMS program evidence', () => {
  it('describes the actual authenticated verification flow and uses the same consent disclosure', () => {
    const html = renderToStaticMarkup(<BookingAlertsPage />);
    expect(html).toContain('SimplAssist business text alerts');
    expect(html).toContain('https://simplassist.com/settings#booking-alerts');
    expect(html).toContain('ALERTS');
    expect(html).toContain(OWNER_BOOKING_ALERT_DISCLOSURE);
    expect(html).toContain('enrollment and alert sending remain off');
    expect(html).not.toMatch(/<form|<input/);
    expect(html).toContain('Message and data rates may apply');
    expect(html).toContain('about confirmed bookings and sign-up links sent to callers');
    expect(html).toContain('does not confirm that the caller received the text, opened the link, or completed registration');
    expect(html).toContain('Full Suite accounts with the sign-up goal');
    expect(html).toContain('do not need a connected calendar');
  });

  it('publishes a linked privacy section distinguishing voluntary owner enrollment', () => {
    const html = renderToStaticMarkup(<PrivacyPage />);
    expect(html).toContain('id="owner-booking-alerts"');
    expect(html).toContain('call-forwarding setup does not enroll you');
    expect(html).toContain('do not sell or share mobile information, SMS opt-in data, or consent');
    expect(html).toContain('href="/booking-alerts"');
    expect(html).toContain('Sign-up-link alerts do not confirm delivery to the caller or completed registration');
  });

  it('explains shared STOP scope, separate business preferences, and delivery limitations', () => {
    const html = renderToStaticMarkup(<TermsPage />);
    expect(html).toContain('id="owner-booking-alerts"');
    expect(html).toContain('pause all SimplAssist business-alert texts');
    expect(html).toContain('affects that business only');
    expect(html).toContain('delivery is not guaranteed');
    expect(html).toContain('Consent is not a condition of purchase');
    expect(html).toContain('A sign-up-link alert does not confirm delivery to the caller or completed registration');
    expect(html).toContain('Sign-up-link alerts do not require a connected calendar');
  });
});
