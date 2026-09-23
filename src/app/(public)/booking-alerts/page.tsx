import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalDocLayout } from '@/components/legal/LegalDocLayout';
import { LegalSection } from '@/components/legal/legal-section';
import BookingAlertDisclosure from '@/components/owner-booking-alerts/BookingAlertDisclosure';
import { btnPrimaryInline, inlineLink } from '@/lib/theme-v2/theme';
import { SUPPORT_EMAIL } from '@/lib/support/constants';

export const metadata: Metadata = {
  title: 'SimplAssist Booking Text Alerts',
  description: 'Learn how business account holders opt in to SimplAssist texts for confirmed calendar appointments.',
};

export default function BookingAlertsPage() {
  return <LegalDocLayout title="SimplAssist booking text alerts" lastUpdated="September 23, 2026"
    siblingHref="/terms#owner-booking-alerts" siblingLabel="SMS terms">
    <LegalSection title="A text when your appointment is booked">
      <p>SimplAssist offers optional automated SMS alerts to business account holders when SimplAssist confirms a new appointment in their connected calendar. The program sends booking notifications and enrollment confirmations. It does not send marketing messages.</p>
      <p className="mt-4">These alerts are sent by SimplAssist to the account holder’s verified mobile. Eligible Chat Only accounts can receive them without purchasing customer texting. Unconfirmed booking requests and appointments created outside SimplAssist do not trigger alerts.</p>
    </LegalSection>
    <LegalSection title="How to sign up">
      <ol className="list-decimal space-y-3 pl-5">
        <li>Sign in to your SimplAssist account and open <strong>Settings → Booking alerts</strong>.</li>
        <li>When setup is available, enter your own US mobile number and select the optional, unchecked box agreeing to SimplAssist booking-alert texts.</li>
        <li>Choose <strong>Continue to verify my number</strong>. The form provides the SimplAssist sending number and a unique text beginning with <strong>ALERTS</strong>.</li>
        <li>Send that exact text from the mobile you entered. This verifies your control of the mobile and confirms your enrollment for the selected business. A code can be used only once and expires.</li>
        <li>Check Settings for confirmation that booking texts are on. You will receive an enrollment confirmation; future alerts are sent after new confirmed appointments.</li>
      </ol>
      <p className="mt-4">The phone field and consent checkbox are part of an optional feature. You can use your account without signing up. If Settings says the program is unavailable, enrollment and alert sending remain off.</p>
      <Link href="https://simplassist.com/settings#booking-alerts" className={`mt-5 ${btnPrimaryInline}`}>Open booking alert settings</Link>
    </LegalSection>
    <LegalSection title="Your SMS consent">
      <p className="mb-4">The signup form asks: “I agree to receive automated booking-alert texts from SimplAssist at this mobile number.” The following disclosure and links are shown with that choice:</p>
      <BookingAlertDisclosure />
    </LegalSection>
    <LegalSection title="Manage or stop your texts">
      <p>Turn off booking texts for one business in its Settings. Reply <strong>STOP</strong> to pause all SimplAssist booking alerts to your mobile, including alerts for other businesses using the same mobile. You will receive one opt-out confirmation.</p>
      <p className="mt-4">To enroll again after STOP, send <strong>START</strong> to the same SimplAssist number, then return to the selected business’s Settings and complete verification. Restarting texts does not automatically enroll other businesses.</p>
      <p className="mt-4">Reply <strong>HELP</strong> for help, or email <a href={`mailto:${SUPPORT_EMAIL}`} className={inlineLink}>{SUPPORT_EMAIL}</a>. Message frequency varies with bookings. Message and data rates may apply. Carriers are not liable for delayed or undelivered messages.</p>
    </LegalSection>
    <LegalSection title="Privacy and delivery">
      <p>We record the mobile number, the business you enrolled, your consent and verification timestamps, the disclosure version, and notification delivery information. Mobile information and SMS opt-in data are not sold or shared for third-party marketing or promotional purposes. Service providers process this information only as needed to operate the program.</p>
      <p className="mt-4">Texts may be delayed or fail to arrive. Your connected calendar and dashboard remain the places to check appointment details. An SMS delivery failure does not cancel the appointment.</p>
      <p className="mt-4">Read the <a href="https://simplassist.com/privacy#owner-booking-alerts" className={inlineLink}>Privacy Policy</a> and <a href="https://simplassist.com/terms#owner-booking-alerts" className={inlineLink}>SMS Terms</a>.</p>
    </LegalSection>
  </LegalDocLayout>;
}
