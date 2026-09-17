import Link from "next/link";
import { LegalDocLayout } from "@/components/legal/LegalDocLayout";
import { LegalSection } from "@/components/legal/legal-section";
import { inlineLink } from "@/lib/theme-v2/theme";
import { SUPPORT_EMAIL, SUPPORT_PATH } from "@/lib/support/constants";

const linkClass = `${inlineLink} underline-offset-2 hover:underline`;

export default function TermsPage() {
  return (
    <LegalDocLayout
      title="Terms of Service"
      siblingHref="/privacy"
      siblingLabel="Privacy Policy"
    >
      <LegalSection title="1. Acceptance of Terms">
        <p>
          These Terms of Service govern your use of SimplAssist, a service operated by
          ARAMBULA VENTURES LLC. By creating a SimplAssist account, you agree to these terms.
          If you do not agree, do not use the service.
        </p>
      </LegalSection>

      <LegalSection title="2. Description of Service">
        <p>
          SimplAssist provides AI-powered customer communication tools for small businesses, including
          SMS auto-response, web chat, AI voice answering, contact management, and appointment
          scheduling. Available features depend on the selected plan and completed account setup.
        </p>
      </LegalSection>

      <LegalSection title="3. Account Responsibilities">
        <p>
          You are responsible for maintaining the security of your account credentials. You are
          responsible for all activity under your account. You must provide accurate business
          information during registration.
        </p>
      </LegalSection>

      <LegalSection title="4. Acceptable Use">
        <p>
          You agree to use SimplAssist only for legitimate business communication. You may not use
          the service to send spam, harass customers, or violate any applicable laws. You must
          comply with TCPA, CAN-SPAM, and other applicable messaging regulations.
        </p>
      </LegalSection>

      <LegalSection title="5. SMS and Text Messaging Compliance">
        <p className="mb-4">
          SimplAssist sends automated text messages to end users on behalf of businesses using our
          platform. By using SimplAssist, you (the business owner) agree to the following:
        </p>
        <ul className="list-disc pl-6 mb-4 space-y-2">
          <li>
            You will only use SimplAssist to communicate with customers who have initiated
            contact by calling your business phone number, texting your business phone number,
            or using your website chat widget.
          </li>
          <li>
            You will not use SimplAssist to send unsolicited marketing messages, spam, or bulk
            promotional texts.
          </li>
          <li>
            You will comply with the Telephone Consumer Protection Act (TCPA), CAN-SPAM Act,
            and all other applicable federal and state regulations regarding text messaging.
          </li>
          <li>
            You acknowledge that SimplAssist automatically handles opt-out requests. When an
            end user replies <strong>STOP</strong>, they will be immediately unsubscribed from
            future messages. You must not attempt to contact opted-out users through other means
            via the platform.
          </li>
        </ul>

        <p className="mb-4 font-semibold">
          End User Consent Disclosure
        </p>
        <p className="mb-4">
          By calling, texting, or chatting with a business powered by SimplAssist, end users
          consent to receive automated text messages at the phone number provided. Message
          frequency varies. Message and data rates may apply. Reply <strong>STOP</strong> to
          opt out at any time. Reply <strong>HELP</strong> for assistance.
        </p>
        <p>
          For more information, see our{" "}
          <a href="https://simplassist.com/privacy" className={linkClass}>
            Privacy Policy
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection title="6. Subscription and Billing">
        <p className="mb-4">
          Services are billed monthly. You may cancel at any time. Refunds are not provided for
          partial months. SimplAssist reserves the right to change pricing with 30 days notice.
        </p>
        <p className="mb-4">
          Subscription and setup fees may include carrier registration costs required for SMS
          compliance. Those fees are passed through from carriers and TCR (The Campaign Registry)
          and are non-refundable once registration has been submitted on your behalf.
        </p>
        <p className="mb-4">
          The $25 setup fee is charged once per business. Upgrades show the amount due before
          confirmation and take effect after payment succeeds. Scheduled downgrades take effect
          at renewal. Previously used messages and voice minutes are not reset by a plan change.
        </p>
        <p>
          Full Suite includes 2,500 SMS parts and 100 voice minutes per billing month. Long texts
          can use multiple parts. A mid-period upgrade receives a proportional voice allowance
          until renewal. Voice minutes do not roll over, and there are no automatic paid voice
          overages. Ringing, preparation, and the recording notice do not count toward the voice
          allowance; conversation time includes listening, pauses, and response waits. When voice
          is unavailable or the allowance is exhausted, your selected eligible fallback applies.
        </p>
      </LegalSection>

      <LegalSection title="7. Limitation of Liability">
        <p>
          SimplAssist is provided &ldquo;as is.&rdquo; We are not liable for any indirect,
          incidental, or consequential damages arising from use of the service. Our total liability
          shall not exceed the amount paid in the last 3 months.
        </p>
      </LegalSection>

      <LegalSection title="8. Termination">
        <p>
          We may terminate accounts that violate these terms. You may cancel your account at any time
          from your dashboard settings.
        </p>
      </LegalSection>

      <LegalSection title="9. Contact">
        <p>
          For questions about these terms, reach us from our{" "}
          <Link href={SUPPORT_PATH} className={linkClass}>
            Support page
          </Link>{" "}
          or email <span className="select-all">{SUPPORT_EMAIL}</span>.
        </p>
      </LegalSection>
    </LegalDocLayout>
  );
}
