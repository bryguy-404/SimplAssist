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
      siblingHref="/terms"
      siblingLabel="Terms of Service"
    >
      <p className={`-mt-8 text-sm ${body}`}>Effective date: September 17, 2026</p>

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
          conduct the conversation. We also store call transcripts, disclosed call recordings,
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

      <LegalSection title="6. Data Storage and Security">
        <p className="mb-4">
          All data is stored securely using Supabase (PostgreSQL). Conversations are encrypted in
          transit. We retain conversation data for as long as your account is active. You can
          request data deletion by contacting support.
        </p>
        <p className="mb-4">
          Public voice callers hear an AI and recording notice before we begin saving call audio
          or transcripts. If a caller interrupts that notice, the system may briefly process their
          reply to handle an objection or repeat the notice. That opening input is not saved in
          the call transcript. An approved private tester may have acknowledged recording in advance.
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
          (names, email addresses, phone numbers) is removed from all records. Conversation
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
