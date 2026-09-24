import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalDocLayout } from '@/components/legal/LegalDocLayout';
import { LegalSection } from '@/components/legal/legal-section';
import BookingAlertDisclosure from '@/components/owner-booking-alerts/BookingAlertDisclosure';
import { btnPrimaryInline, inlineLink } from '@/lib/theme-v2/theme';
import { SUPPORT_EMAIL } from '@/lib/support/constants';

export const metadata: Metadata = {
  title: 'SimplAssist Business Text Alerts',
  description: 'Learn how business account holders opt in to SimplAssist texts for confirmed bookings and sign-up links sent to callers.',
};

export default function BookingAlertsPage() {
  return <LegalDocLayout title="SimplAssist business text alerts" lastUpdated="September 24, 2026"
    siblingHref="/terms#owner-booking-alerts" siblingLabel="SMS terms">
    <LegalSection title="A text when SimplAssist helps your business">
      <p>SimplAssist offers optional automated SMS alerts to business account holders when it confirms a new appointment in their connected calendar or sends a sign-up link by text to a caller. The program also sends enrollment confirmations. It does not send marketing messages.</p>
      <p className="mt-4">A sign-up-link alert reports that SimplAssist sent the link text. It does not confirm that the caller received the text, opened the link, or completed registration. Unconfirmed booking requests and appointments created outside SimplAssist do not trigger alerts.</p>
      <p className="mt-4">These alerts go to the account holder’s verified mobile. Eligible Chat Only accounts can receive booking alerts without purchasing customer texting. Sign-up-link alerts apply to Full Suite accounts with the sign-up goal when SimplAssist sends a link text to a caller; these accounts do not need a connected calendar.</p>
    </LegalSection>
    <LegalSection title="How to sign up">
      <ol className="list-decimal space-y-3 pl-5">
        <li>Sign in to your SimplAssist account and open <strong>Settings → Business alerts</strong>.</li>
        <li>When setup is available, enter your own US mobile number and select the optional, unchecked box agreeing to SimplAssist business-alert texts.</li>
        <li>Choose <strong>Continue to verify my number</strong>. The form provides the SimplAssist sending number and a unique text beginning with <strong>ALERTS</strong>.</li>
        <li>Send that exact text from the mobile you entered. This verifies your control of the mobile and confirms your enrollment for the selected business. A code can be used only once and expires.</li>
        <li>Check Settings for confirmation that business texts are on. You will receive an enrollment confirmation; future alerts follow your account’s goal: confirmed bookings or sign-up links sent to callers.</li>
      </ol>
      <p className="mt-4">The phone field and consent checkbox are part of an optional feature. You can use your account without signing up. If Settings says the program is unavailable, enrollment and alert sending remain off.</p>
      <Link href="https://simplassist.com/settings#booking-alerts" className={`mt-5 ${btnPrimaryInline}`}>Open business alert settings</Link>
    </LegalSection>
    <LegalSection title="Your SMS consent">
      <p className="mb-4">The enrollment form asks: “I agree to receive automated texts from SimplAssist about confirmed bookings and sign-up links sent to callers at this mobile number.” The following disclosure and links are shown with that choice:</p>
      <BookingAlertDisclosure />
    </LegalSection>
    <LegalSection title="Manage or stop your texts">
      <p>Turn off business texts for one business in its Settings. Reply <strong>STOP</strong> to pause all SimplAssist business alerts to your mobile, including alerts for other businesses using the same mobile. You will receive one opt-out confirmation.</p>
      <p className="mt-4">To enroll again after STOP, send <strong>START</strong> to the same SimplAssist number, then return to the selected business’s Settings and complete verification. Restarting texts does not automatically enroll other businesses.</p>
      <p className="mt-4">Reply <strong>HELP</strong> for help, or email <a href={`mailto:${SUPPORT_EMAIL}`} className={inlineLink}>{SUPPORT_EMAIL}</a>. Message frequency varies with confirmed bookings and sign-up links sent. Message and data rates may apply. Carriers are not liable for delayed or undelivered messages.</p>
    </LegalSection>
    <LegalSection title="Privacy and delivery">
      <p>We record the mobile number, the business you enrolled, your consent and verification timestamps, the disclosure version, and notification delivery information. Mobile information and SMS opt-in data are not sold or shared for third-party marketing or promotional purposes. Service providers process this information only as needed to operate the program.</p>
      <p className="mt-4">Texts may be delayed or fail to arrive. Check your connected calendar for appointment details and your dashboard for call activity. An SMS delivery failure does not cancel an appointment, and a sign-up-link alert does not establish a completed registration.</p>
      <p className="mt-4">Read the <a href="https://simplassist.com/privacy#owner-booking-alerts" className={inlineLink}>Privacy Policy</a> and <a href="https://simplassist.com/terms#owner-booking-alerts" className={inlineLink}>SMS Terms</a>.</p>
    </LegalSection>
  </LegalDocLayout>;
}
