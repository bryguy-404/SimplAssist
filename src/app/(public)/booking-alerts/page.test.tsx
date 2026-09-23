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
    expect(html).toContain('SimplAssist booking text alerts');
    expect(html).toContain('https://simplassist.com/settings#booking-alerts');
    expect(html).toContain('ALERTS');
    expect(html).toContain(OWNER_BOOKING_ALERT_DISCLOSURE);
    expect(html).toContain('enrollment and alert sending remain off');
    expect(html).not.toMatch(/<form|<input/);
    expect(html).toContain('Message and data rates may apply');
  });

  it('publishes a linked privacy section distinguishing voluntary owner enrollment', () => {
    const html = renderToStaticMarkup(<PrivacyPage />);
    expect(html).toContain('id="owner-booking-alerts"');
    expect(html).toContain('call-forwarding setup does not enroll you');
    expect(html).toContain('do not sell or share mobile information, SMS opt-in data, or consent');
    expect(html).toContain('href="/booking-alerts"');
  });

  it('explains shared STOP scope, separate business preferences, and delivery limitations', () => {
    const html = renderToStaticMarkup(<TermsPage />);
    expect(html).toContain('id="owner-booking-alerts"');
    expect(html).toContain('pause all SimplAssist booking-alert texts');
    expect(html).toContain('affects that business only');
    expect(html).toContain('delivery is not guaranteed');
    expect(html).toContain('Consent is not a condition of purchase');
  });
});
