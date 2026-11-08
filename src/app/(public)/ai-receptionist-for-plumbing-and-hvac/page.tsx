import Link from "next/link";
import {
  FeatureFaqs,
  FeaturePage,
  FeatureSteps,
  featureHeading,
  featureMetadata,
  sectionHeading,
} from "@/components/marketing/feature-page";
import { FullSuiteWaitlistButton } from "@/components/waitlist/FullSuiteWaitlistButton";
import { isPlanAvailable } from "@/lib/billing/planAvailability";
import { FULL_SUITE_USAGE_NOTE } from "@/lib/billing/fullSuitePresentation";
import { SETUP_FEE_CENTS, SUBSCRIPTION_PLANS } from "@/lib/stripe/config";
import { accentText, body, btnPrimary, btnSecondary, card, ink, inlineLink, tile } from "@/lib/theme-v2/theme";

const path = "/ai-receptionist-for-plumbing-and-hvac";
const title = "AI Receptionist for Plumbing & HVAC | SimplAssist";
const plan = SUBSCRIPTION_PLANS.full;
const description = `An AI answering service for plumbing and HVAC businesses. Answer service questions and capture caller details while you're on a job. Voice from $${plan.price}/month.`;

export const metadata = featureMetadata(path, title, description);

export default function PlumbingHvacPage() {
  const available = isPlanAvailable("full");
  const faqs = [
    {
      question: "How does an AI receptionist help a plumbing or HVAC business?",
      answer: "When a call reaches your SimplAssist number, Voice can answer using the services, hours, service area, and FAQs you have saved. It can ask what the caller needs and collect their contact details. Your team can review the transcript and recording in the dashboard, then decide whether to call back, prepare an estimate, or arrange a visit.",
    },
    {
      question: "Can it answer only after hours or when I miss a call?",
      answer: "Voice answers calls that reach your assigned SimplAssist number while Voice mode is enabled and minutes are available. Forwarding an existing business line only when unanswered, busy, or after hours depends on your phone provider. Confirm and test those forwarding rules during setup. Saving business hours in SimplAssist does not schedule forwarding.",
    },
    {
      question: "Can it book estimates or service appointments?",
      answer: "With Google Calendar connected and booking enabled, SimplAssist can check available appointment times and confirm a booking with the caller. Use a calendar that reflects the appointments your team can offer. It does not read or update ServiceTitan, Housecall Pro, or other field-service dispatch schedules, and a calendar booking does not assign a technician.",
    },
    {
      question: "What happens with urgent plumbing or HVAC calls?",
      answer: "SimplAssist can collect a caller's request, but it does not dispatch technicians, transfer live calls, or guarantee an urgent response. Keep your established emergency contact route available and make your instructions clear in the business information you provide. Do not use AI call intake as an emergency response service.",
    },
    {
      question: "Will it quote a repair price or diagnose equipment?",
      answer: "It can explain the service information and prices you have supplied. Keep job-specific quotes, diagnosis, and decisions about whether a repair is safe with your team. If a price depends on an inspection, make that clear in your saved FAQs so the assistant can explain the next step instead of promising a price.",
    },
    {
      question: "How much does phone answering cost?",
      answer: `Full Suite is $${plan.price}/month with ${plan.includedVoiceMinutes} voice minutes per billing month, ${plan.includedSmsParts.toLocaleString("en-US")} SMS parts, AI text conversations, website chat, and Google Calendar booking. Paid SMS activation has a one-time $${SETUP_FEE_CENTS / 100} fee. Voice is in English and requires an active, approved account, an assigned number, and Voice mode enabled. There are no automatic paid voice overages. ${available ? "Full Suite is available during signup." : "Full Suite is currently coming soon."}`,
    },
  ];

  return (
    <FeaturePage path={path} title={title} description={description} breadcrumb="Plumbing & HVAC">
      <section className="grid items-start gap-10 pb-12 lg:grid-cols-[1.1fr_.9fr]">
        <div>
          <p className={`mb-4 text-sm font-bold ${accentText}`}>SIMPLASSIST FOR THE TRADES</p>
          <h1 className={featureHeading}>An AI receptionist for <span className={accentText}>plumbing and HVAC.</span></h1>
          <p className={`mt-6 text-2xl font-bold ${ink}`}>Help callers while you&apos;re on the job.</p>
          <p className={`mt-4 max-w-xl text-lg leading-8 ${body}`}>When you&apos;re under a sink, working on a furnace, or with a customer, a new caller still needs help. SimplAssist Voice answers service questions and collects their details using the information you provide.</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link href="/ai-receptionist-for-small-business#voice-demo" className={btnPrimary}>Hear the live voice demo</Link>
            <a href="#service-example" className={btnSecondary}>See a service inquiry</a>
          </div>
          <p className={`mt-4 text-sm leading-6 ${body}`}>Full Suite: ${plan.price}/month with {plan.includedVoiceMinutes} voice minutes. ${SETUP_FEE_CENTS / 100} one-time SMS activation fee. Phone conversations in English.</p>
        </div>
        <aside className={`${card} p-6 sm:p-8`}>
          <h2 className="text-2xl font-bold">A useful first conversation.</h2>
          <ul className={`mt-5 list-disc space-y-4 pl-5 leading-7 ${body}`}>
            <li>Explain the services and areas your business covers.</li>
            <li>Ask what the caller needs and collect callback details.</li>
            <li>Save a transcript and recording for your team to review.</li>
            <li>Help book an appointment when Google Calendar booking is enabled.</li>
          </ul>
        </aside>
      </section>

      <section className="py-14 sm:py-20">
        <h2 className={sectionHeading}>Built around the questions your customers ask.</h2>
        <div className="mt-8 grid gap-5 md:grid-cols-2">
          <article className={`${card} p-6 sm:p-8`}>
            <h3 className={`text-2xl font-bold ${ink}`}>Plumbing inquiries</h3>
            <p className={`mt-4 leading-7 ${body}`}>A homeowner wants to know whether you replace water heaters, handle drain cleaning, or serve their area. Give SimplAssist your service list and estimate process so it can explain what your team offers and collect the request.</p>
          </article>
          <article className={`${card} p-6 sm:p-8`}>
            <h3 className={`text-2xl font-bold ${ink}`}>Heating and cooling inquiries</h3>
            <p className={`mt-4 leading-7 ${body}`}>A caller asks about a furnace tune-up, AC maintenance, or a replacement estimate. Save the equipment and services you work with, your hours, and how appointments work so the assistant has useful information to share.</p>
          </article>
        </div>
      </section>

      <section id="service-example" className={`${card} scroll-mt-32 p-6 sm:p-10`}>
        <p className={`text-sm font-bold ${accentText}`}>ILLUSTRATIVE CONVERSATION</p>
        <h2 className={`${sectionHeading} mt-3`}>An estimate inquiry while your team is busy.</h2>
        <div className="mt-8 grid gap-8 lg:grid-cols-[1.1fr_.9fr]">
          <div className="space-y-4">
            <div className={`${tile} p-5`}>
              <p className={`text-sm font-bold ${ink}`}>Caller</p>
              <p className={`mt-2 leading-7 ${body}`}>&ldquo;Do you replace water heaters? I&apos;d like to get an estimate.&rdquo;</p>
            </div>
            <div className={`${tile} p-5`}>
              <p className={`text-sm font-bold ${accentText}`}>SimplAssist</p>
              <p className={`mt-2 leading-7 ${body}`}>&ldquo;Yes, water heater replacement is one of our services. What city is the property in, and what&apos;s the best number to reach you?&rdquo;</p>
            </div>
          </div>
          <div>
            <h3 className={`text-xl font-bold ${ink}`}>What your team can review</h3>
            <p className={`mt-4 leading-7 ${body}`}>The saved conversation gives your team context: what the caller asked for, the details they shared, and any next step discussed. You can follow up personally to assess the job and arrange an estimate.</p>
            <p className={`mt-4 text-sm leading-6 ${body}`}>This is a written example for a fictional business with water heater replacement in its saved services. It is not a customer recording, a confirmed appointment, or a promise of a callback.</p>
          </div>
        </div>
      </section>

      <FeatureSteps title="Set up the answers you want callers to hear." steps={[
        { title: "Add your business details", text: "Save your services, service area, hours, estimate process, and common questions. Explain when the assistant should leave a decision to your team." },
        { title: "Choose how calls reach you", text: "After account approval and number assignment, enable Voice. If you use forwarding from an existing line, confirm your phone provider's rules and test the routing." },
        { title: "Test, review, and follow up", text: "Try typical service inquiries before sending customers to the number. Review saved conversations and keep your answers current. Connect Google Calendar if you want appointment booking." },
      ]} />

      <section className="grid gap-8 py-14 sm:py-20 lg:grid-cols-2">
        <div>
          <h2 className={sectionHeading}>Keep your team in charge of the job.</h2>
          <p className={`mt-5 leading-7 ${body}`}>SimplAssist handles the first conversation. Your team handles diagnosis, job-specific pricing, dispatch, and the work itself. Keep your established emergency contact route available for urgent requests.</p>
          <p className={`mt-4 leading-7 ${body}`}>Calendar booking uses Google Calendar, so the available times need to reflect what your business can offer. SimplAssist does not connect to your field-service dispatch software or transfer live calls to a technician.</p>
          <p className={`mt-5 leading-7 ${body}`}>Prefer to follow up by text? <Link href="/#missed-call-text-back" className={`${inlineLink} underline underline-offset-4`}>Explore missed-call text back</Link> or <Link href="/ai-chatbot-for-small-business" className={`${inlineLink} underline underline-offset-4`}>website chat</Link>.</p>
        </div>
        <div className={`${tile} p-6 sm:p-8`}>
          <p className={`text-sm font-bold ${accentText}`}>FULL SUITE{available ? "" : " · COMING SOON"}</p>
          <p className={`mt-3 text-5xl font-extrabold tracking-tight ${ink}`}>${plan.price}<span className={`text-lg font-medium ${body}`}>/month</span></p>
          <p className={`mt-3 text-sm font-semibold ${accentText}`}>${SETUP_FEE_CENTS / 100} one-time SMS activation fee</p>
          <ul className={`my-6 space-y-3 leading-6 ${body}`}>
            <li>{plan.includedVoiceMinutes} voice minutes per billing month</li>
            <li>{plan.includedSmsParts.toLocaleString("en-US")} SMS parts per month</li>
            <li>AI text conversations and website chat</li>
            <li>Google Calendar booking, transcripts, and recordings</li>
          </ul>
          {available ? <Link href="/signup" className={btnPrimary}>Get started with Full Suite</Link> : <FullSuiteWaitlistButton className={btnPrimary} />}
          <p className={`mt-5 text-xs leading-5 ${body}`}>{FULL_SUITE_USAGE_NOTE}</p>
          <Link href="/#pricing" className={`${inlineLink} mt-5 inline-block underline underline-offset-4`}>Compare all plans</Link>
        </div>
      </section>

      <FeatureFaqs title="Questions about call answering for your trade." faqs={faqs} />
      <section className={`${tile} mb-4 p-6 sm:p-8`}>
        <h2 className="text-2xl font-bold">Hear SimplAssist before you choose.</h2>
        <p className={`mt-4 max-w-3xl leading-7 ${body}`}>Our live demo answers questions about SimplAssist. Ask about setup, phone answering, or pricing, then ask a follow-up. Your own assistant uses your business information.</p>
        <Link href="/ai-receptionist-for-small-business#voice-demo" className={`${btnPrimary} mt-6`}>Try the voice demo</Link>
      </section>
    </FeaturePage>
  );
}
