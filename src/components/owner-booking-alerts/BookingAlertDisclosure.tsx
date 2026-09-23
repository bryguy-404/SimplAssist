import { OWNER_BOOKING_ALERT_DISCLOSURE } from '@/lib/owner-booking-alerts/contracts';
import { SUPPORT_EMAIL } from '@/lib/support/constants';
import { bodyFaint, inlineLink } from '@/lib/theme-v2/theme';

/** The platform program keeps its SimplAssist identity on partner dashboards. */
export default function BookingAlertDisclosure({ disclosure = OWNER_BOOKING_ALERT_DISCLOSURE }: { disclosure?: string }) {
  return <div className={`space-y-2 text-sm ${bodyFaint}`}>
    <p>{disclosure}</p>
    <p>
      <a href="https://simplassist.com/privacy#owner-booking-alerts" className={inlineLink} target="_blank" rel="noopener noreferrer">Privacy Policy</a>
      {' · '}
      <a href="https://simplassist.com/terms#owner-booking-alerts" className={inlineLink} target="_blank" rel="noopener noreferrer">SMS Terms</a>
      {' · '}
      <a href="https://simplassist.com/booking-alerts" className={inlineLink} target="_blank" rel="noopener noreferrer">About booking alerts</a>
    </p>
    <p>For help, email <a href={`mailto:${SUPPORT_EMAIL}`} className={inlineLink}>{SUPPORT_EMAIL}</a>.</p>
  </div>;
}
