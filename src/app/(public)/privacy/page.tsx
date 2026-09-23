import Link from "next/link";
import { LegalDocLayout } from "@/components/legal/LegalDocLayout";
import { LegalSection } from "@/components/legal/legal-section";
import { body, inlineLink } from "@/lib/theme-v2/theme";
import { SUPPORT_EMAIL, SUPPORT_PATH } from "@/lib/support/constants";

const linkClass = `${inlineLink} underline-offset-2 hover:underline`;

export default function PrivacyPage() {
  return (
    <LegalDocLayout
      title="Privacy Policy"
      lastUpdated="September 23, 2026"
      siblingHref="/terms"
      siblingLabel="Terms of Service"
    >
      <p className={`-mt-8 text-sm ${body}`}>Effective date: September 23, 2026</p>

      <LegalSection title="1. Introduction">
        <p>
          SimplAssist (&ldquo;we,&rdquo; &ldquo;our,&rdquo; or &ldquo;us&rdquo;), a product of
          ARAMBULA VENTURES LLC, is committed to protecting your privacy. This policy explains how
          we collect, use, and protect information when businesses use our platform and when their
          customers interact with our AI assistant.
        </p>
      </LegalSection>

      <LegalSection title="2. Information We Collect">
        <p>
          We collect business information provided during registration (business name, website,
          address, phone number, hours, services). We collect customer contact information when
          customers call, text, or chat with the AI (names, email addresses, phone numbers,
          conversation content, and confirmed appointment details). Voice audio is processed to
          conduct the conversation. We also store call transcripts, call recordings,
          action results, and usage data to operate and improve the service.
        </p>
      </LegalSection>

      <LegalSection title="3. How We Use Your Information">
        <p>
          To power the AI assistant responses. To maintain conversation history in your CRM. To send
          SMS messages and handle calls on behalf of your business via Telnyx. To capture details
          and carry out caller-confirmed signup-text and appointment requests. To show conversation
          results and usage in your dashboard. We do not sell your data to third parties.
        </p>
      </LegalSection>

      <LegalSection title="4. Google User Data">
        <p className="mb-4">
          SimplAssist&apos;s use and transfer to any other app of information received from Google APIs
          will adhere to the{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            className={linkClass}
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
        <p className="mb-4">
          Google Calendar data is accessed only with the user&apos;s explicit consent via Google sign-in
          and is used solely to check availability and to create and manage appointments requested
          through SimplAssist.
        </p>
        <p className="mb-4">
          Google user data is never sold, never used for advertising, and never transferred to third
          parties except as necessary to provide this feature, to comply with law, or as part of a
          merger or acquisition with equivalent protections.
        </p>
        <p>
          Users can revoke SimplAssist&apos;s access at any time via their{" "}
          <a href="https://myaccount.google.com/permissions" className={linkClass}>
            Google Account security settings
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection title="5. SMS and Text Messaging">
        <p className="mb-4">
          SimplAssist sends automated text messages on behalf of businesses using our platform.
          These messages are sent via Telnyx, a third-party messaging service. By using SimplAssist,
          your business agrees to Telnyx&apos;s messaging policies and applicable telecommunications
          regulations.
        </p>

        <p className="mb-4 font-semibold">
          Consent to Receive Text Messages
        </p>
        <p className="mb-4">
          By calling, texting, or chatting with a business powered by SimplAssist, you (the
          end user/customer) consent to receive automated text messages at the phone number you
          provided. These messages may include responses to your inquiry, appointment confirmations,
          follow-up communications, and other messages related to the business you contacted.
          Consent is not a condition of purchase.
        </p>
        <p className="mb-4">
          By providing your phone number to a business using SimplAssist, you give express written
          consent to receive automated SMS messages from that business and SimplAssist as described
          above. You may receive roughly 1 to 10 messages per inquiry depending on your
          conversation; overall message frequency varies.
        </p>

        <p className="mb-4 font-semibold">
          Opting Out
        </p>
        <p className="mb-4">
          You can opt out of receiving text messages at any time by replying <strong>STOP</strong> to
          any message. After opting out, you will receive one final confirmation message and no
          further texts will be sent. To resume messages, text <strong>START</strong> to the same
          number.
        </p>

        <p className="mb-4 font-semibold">
          Getting Help
        </p>
        <p className="mb-4">
          For assistance, reply <strong>HELP</strong> to any message, visit our{" "}
          <Link href={SUPPORT_PATH} className={linkClass}>
            Support page
          </Link>
          , or email SimplAssist support at <span className="select-all">{SUPPORT_EMAIL}</span>.
        </p>

        <p className="mb-4 font-semibold">
          Message Frequency and Rates
        </p>
        <p>
          Message frequency varies based on your interaction with the business. Message and data
          rates may apply depending on your mobile carrier and plan. SimplAssist is not responsible
          for any charges from your carrier.
        </p>
      </LegalSection>

      <div id="owner-booking-alerts" className="scroll-mt-6">
        <LegalSection title="5A. SimplAssist Owner Booking Alerts">
          <p className="mb-4">Business account holders may separately opt in to receive automated booking-alert texts from SimplAssist. Entering a phone number during account registration or call-forwarding setup does not enroll you in this program. In Settings → Booking alerts, you choose your mobile, agree to the SMS disclosure, and verify control of that mobile by sending the one-time verification text displayed in the form.</p>
          <p className="mb-4">We store the alert mobile, associated business and account, consent and verification timestamps, disclosure version, opt-out status, and notification delivery records to operate the program, honor your choices, and prevent duplicate or unauthorized alerts. We use Telnyx and our hosting and database service providers to deliver and support these messages.</p>
          <p className="mb-4">Expired verification records are removed after one day, processed notification webhook records after 30 days, and completed notification records after 90 days. Consent records remain with the business account until permanent cleanup. We retain a minimal mobile-number opt-out record to honor STOP requests, including after account deletion; it is not used for marketing. Deleting or transferring an account disables its booking-alert enrollment, and restoring the account does not automatically turn alerts back on.</p>
          <p className="mb-4">We do not sell or share mobile information, SMS opt-in data, or consent with third parties for marketing or promotional purposes. We share this information with service providers only as needed to operate and support the messaging program.</p>
          <p className="mb-4">Reply STOP to pause all SimplAssist booking alerts to your mobile. You can also disable alerts for an individual business in Settings. Reply HELP for assistance or email {SUPPORT_EMAIL}. Message frequency varies with bookings. Message and data rates may apply.</p>
          <p>See <Link href="/booking-alerts" className={linkClass}>how booking alerts work</Link> and the <Link href="/terms#owner-booking-alerts" className={linkClass}>owner booking-alert SMS terms</Link>.</p>
        </LegalSection>
      </div>

      <LegalSection title="6. Data Storage and Security">
        <p className="mb-4">
          All data is stored securely using Supabase (PostgreSQL). Conversations are encrypted in
          transit. We retain conversation data for as long as your account is active. You can
          request data deletion by contacting support.
        </p>
        <p className="mb-4">
          Our voice assistant identifies itself as AI at the beginning of a call. Voice calls
          are recorded and transcribed. A spoken recording announcement may be enabled or disabled
          by SimplAssist; recording and transcription continue when that announcement is disabled.
          When the announcement is enabled, recording and transcript storage begin after it plays.
          The system may briefly process an interruption to handle an objection or repeat the
          announcement; that opening input is not saved in the call transcript. An approved
          private tester may have acknowledged recording in advance.
        </p>
        <p>
          Call audio recordings are retained for 30 days and then deleted through our automated
          cleanup process. Call transcripts and confirmed contact or appointment records follow
          the normal conversation and account retention rules. Recordings are accessible through
          authenticated account controls; provider recording links are not made public.
        </p>
      </LegalSection>

      <LegalSection title="7. Account Deletion and Data Retention">
        <p className="mb-4">
          You may delete your account at any time from the Settings page. Upon deletion,
          your account enters a 60-day grace period during which you can log back in
          and reactivate your account with all data intact.
        </p>
        <p className="mb-4">
          After 60 days, your data is permanently processed as follows: personal information
          (names, email addresses, phone numbers) is removed from account records, except
          for the minimal SMS opt-out record described above. Processed notification
          webhooks expire on their separate 30-day schedule. Conversation
          content is erased. Anonymous, aggregated metadata (lead scores, message counts,
          timestamps) may be retained for service improvement and analytics.
        </p>
        <p>
          Business configuration data (services, FAQs, business hours, AI settings,
          phone numbers, calendar connections, and widget settings) is permanently deleted.
          Your authentication credentials are permanently removed.
        </p>
      </LegalSection>

      <LegalSection title="8. Third-Party Services">
        <p>
          SimplAssist integrates with Telnyx (phone calls, messaging, and recording storage),
          OpenAI (live AI voice processing), Anthropic (business answers and action interpretation),
          Google Calendar (availability, appointments, and invitations), Stripe (payments),
          Supabase (database), and Resend (transactional email delivery). Each service has its
          own privacy policy.
        </p>
      </LegalSection>

      <LegalSection title="9. Contact Us">
        <p>
          For privacy questions, reach us from our{" "}
          <Link href={SUPPORT_PATH} className={linkClass}>
            Support page
          </Link>{" "}
          or email <span className="select-all">{SUPPORT_EMAIL}</span>.
        </p>
      </LegalSection>
    </LegalDocLayout>
  );
}
