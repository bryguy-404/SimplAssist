import Link from "next/link";
import { Check, PhoneCall } from "lucide-react";
import { FeatureFaqs, FeaturePage, FeatureSteps, featureHeading, featureMetadata, sectionHeading } from "@/components/marketing/feature-page";
import { FullSuiteWaitlistButton } from "@/components/waitlist/FullSuiteWaitlistButton";
import { isPlanAvailable } from "@/lib/billing/planAvailability";
import { FULL_SUITE_USAGE_NOTE } from "@/lib/billing/fullSuitePresentation";
import { SETUP_FEE_CENTS, SUBSCRIPTION_PLANS } from "@/lib/stripe/config";
import { accentText, body, btnPrimary, btnSecondary, card, ink, inlineLink, tile } from "@/lib/theme-v2/theme";

const path = "/ai-receptionist-for-small-business";
const title = "AI Receptionist for Small Business | SimplAssist Voice";
const plan = SUBSCRIPTION_PLANS.full;
const description = `An AI answering service for small businesses. Handle service questions, collect caller details, and book with Google Calendar. Hear the demo. Full Suite: $${plan.price}/month.`;
export const metadata = featureMetadata(path, title, description);

export default function VoicePage() {
  const available = isPlanAvailable("full");
  const faqs = [
    { question: "Can I use SimplAssist for after-hours or unanswered calls?", answer: "Voice answers calls that reach your assigned SimplAssist number while Voice mode is enabled and your account has available minutes. If you want calls from an existing business number to reach it only after hours, when busy, or when unanswered, that routing depends on your phone provider's forwarding options. Confirm and test those rules before using it with customers. Your saved business hours tell the AI about your business; they do not configure your phone provider's forwarding." },
    { question: "Will I still be able to talk to customers myself?", answer: "Yes. You can keep handling customer conversations personally and use SimplAssist for calls you choose to route to it. Review saved transcripts, recordings, and contact details in your dashboard, then follow up yourself. SimplAssist does not currently transfer a live call to a person or guarantee that your team will call back." },
    { question: "How does an AI receptionist work during a call?", answer: "With Full Suite active and Voice mode enabled, SimplAssist greets callers as your business's AI assistant and explains the call recording. It listens to what the caller needs, answers using your saved business information, and can ask follow-up questions or collect contact details. If calendar booking is connected and enabled, it can help book an appointment after confirming the details." },
    { question: "What can SimplAssist answer about my business?", answer: "You provide your services, hours, FAQs, and other business information. SimplAssist uses those saved details and your AI instructions during the conversation. Test your setup with common customer questions and keep the information up to date. The assistant should not invent an answer when the information is missing." },
    { question: "Can SimplAssist book appointments over the phone?", answer: "Yes. When Google Calendar is connected and booking is enabled, SimplAssist can check availability and help the caller book a time. It confirms the appointment details with the caller before completing the booking." },
    { question: "Which plan includes voice, and what does it cost?", answer: `Voice is included in Full Suite at $${plan.price}/month, with ${plan.includedVoiceMinutes} voice minutes per billing month and ${plan.includedSmsParts.toLocaleString("en-US")} SMS parts per month. Full Suite also includes AI text conversations, website chat, and calendar booking. There is a one-time $${SETUP_FEE_CENTS / 100} SMS activation fee. ${available ? "Choose Full Suite during signup or upgrade from your billing page." : "Full Suite is currently coming soon."}` },
    { question: "What happens when the included voice minutes run out?", answer: "There are no automatic paid voice overages. Voice availability depends on your remaining allowance and account status. Minutes reset each billing month and do not roll over. Review usage in your dashboard and choose the call handling mode that suits your business." },
    { question: "Can I review what happened on a call?", answer: "Yes. Saved call transcripts and recordings are available in your dashboard so you can review the conversation and follow up. SimplAssist provides the caller with an AI and recording disclosure during the call." },
    { question: "How is voice different from missed-call texting or webchat?", answer: "Voice lets a caller speak and hear answers over the phone. Missed-call text back sends an SMS after an unanswered call; AI SMS conversations are included in SMS + Web Chat and Full Suite. Website chat handles typed questions in a widget on your site." },
  ];

  return (
    <FeaturePage path={path} title={title} description={description} breadcrumb="SimplAssist Voice">
      <section className="grid items-center gap-10 pb-12 lg:grid-cols-[1.1fr_.9fr]">
        <div>
          <p className={`mb-4 text-sm font-bold ${accentText}`}>SIMPLASSIST VOICE · FULL SUITE</p>
          <h1 className={featureHeading}>An AI receptionist for your <span className={accentText}>small business.</span></h1>
          <p className={`mt-6 text-2xl font-bold ${ink}`}>SimplAssist can talk. Your callers can just ask.</p>
          <p className={`mt-4 max-w-xl text-lg leading-8 ${body}`}>On a job, helping a customer, or finished for the day? SimplAssist is an AI answering service that handles service questions, collects caller details, and helps book appointments with a connected Google Calendar.</p>
          <div className="mt-7 flex flex-wrap gap-3"><a href="#voice-demo" className={btnPrimary}>Hear SimplAssist for yourself</a><a href="#voice-plan" className={btnSecondary}>See Full Suite</a></div>
          <p className={`mt-4 text-sm leading-6 ${body}`}>Phone conversations in English. Full Suite is ${plan.price}/month with {plan.includedVoiceMinutes} included voice minutes per billing month.</p>
        </div>
        <div className={`${card} p-6 sm:p-8`}>
          <div className={`mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-orange-100 dark:bg-orange-400/10 ${accentText}`}><PhoneCall aria-hidden="true" className="h-8 w-8" /></div>
          <h2 className="text-2xl font-bold">A conversation, with a next step.</h2>
          <p className={`mt-4 leading-7 ${body}`}>A caller might ask about your opening hours, explain what they need, or ask to book a visit. SimplAssist can respond and keep the conversation going.</p>
          <ul className="mt-6 space-y-4">
            {["Answers using your services, hours, and FAQs", "Collects names and contact details", "Helps book with a connected Google Calendar", "Saves call transcripts and recordings for review"].map((item) => <li key={item} className="flex gap-3 text-sm leading-6"><Check aria-hidden="true" className={`mt-0.5 h-5 w-5 shrink-0 ${accentText}`} />{item}</li>)}
          </ul>
          <p className={`mt-6 border-t border-stone-200 pt-5 text-sm leading-6 dark:border-white/10 ${body}`}>Set up your business information and enable Voice mode before using it with your callers.</p>
        </div>
      </section>

      <section className="py-14 sm:py-20">
        <h2 className={sectionHeading}>Help with the calls you can&apos;t get to.</h2>
        <p className={`mt-5 max-w-3xl leading-7 ${body}`}>Use your business information to give callers a useful first response. You decide which calls reach your SimplAssist number, and your team decides how to follow up.</p>
        <div className="mt-8 grid gap-5 md:grid-cols-3">
          {[
            { title: "While you're serving a customer", text: "Let a new caller explain what they need and leave their contact details. You can review the saved conversation when you're free." },
            { title: "After the workday", text: "Answer questions about your hours, services, and other saved details. Collect a request for your team to review when they return." },
            { title: "When someone wants to book", text: "With Google Calendar connected and booking enabled, help callers choose an available appointment. Your calendar needs to reflect the times you can actually offer." },
          ].map(({ title: heading, text }) => (
            <article key={heading} className={`${card} p-6 sm:p-8`}>
              <h3 className={`text-xl font-bold ${ink}`}>{heading}</h3>
              <p className={`mt-3 leading-7 ${body}`}>{text}</p>
            </article>
          ))}
        </div>
        <p className={`mt-5 text-sm leading-6 ${body}`}>After-hours or unanswered-call forwarding from your existing line depends on your phone provider. Confirm the routing during setup; business hours saved in SimplAssist do not switch forwarding on or off.</p>
        <Link href="/ai-receptionist-for-plumbing-and-hvac" className={`${inlineLink} mt-5 inline-block underline underline-offset-4`}>See how a plumbing or HVAC business could use SimplAssist</Link>
      </section>

      <FeatureSteps title="What happens when someone calls?" steps={[
        { title: "SimplAssist greets the caller", text: "With your account approved, number assigned, and Voice mode enabled, SimplAssist introduces itself as your business's AI assistant and gives a recording disclosure." },
        { title: "The caller has a conversation", text: "SimplAssist answers from your saved business information, asks follow-up questions, and collects details. Connected calendar booking lets it check availability and confirm an appointment." },
        { title: "You can review and follow up", text: "Open the dashboard to review saved call transcripts, recordings, and captured details. See what the customer needed and decide what to do next." },
      ]} />

      <section id="voice-demo" className={`${card} my-8 grid scroll-mt-32 gap-8 p-6 sm:p-10 lg:grid-cols-[1fr_.85fr]`}>
        <div>
          <p className={`mb-3 text-sm font-bold ${accentText}`}>LIVE PHONE DEMO</p>
          <h2 className={sectionHeading}>Call SimplAssist. Ask a real question.</h2>
          <p className={`mt-5 leading-7 ${body}`}>This number is connected to SimplAssist&apos;s live AI assistant. It will answer your call and talk with you about SimplAssist. Ask a question, listen to the answer, then ask a follow-up.</p>
          <a href="tel:+15742638634" aria-label="Call SimplAssist's live AI assistant at (574) 263-8634" className={`mt-7 inline-block rounded-lg text-[clamp(25px,4vw,42px)] font-extrabold tracking-tight hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-600 ${accentText}`}>(574) 263-8634</a>
          <p className={`mt-3 text-sm leading-6 ${body}`}>The live demo explains SimplAssist. On your own account, it answers using your business details. Voice is included with Full Suite.</p>
        </div>
        <div className={`${tile} p-6 sm:p-8`}>
          <h3 className="text-xl font-bold">Try this short conversation</h3>
          <ol className={`mt-5 list-decimal space-y-4 pl-5 leading-7 ${body}`}>
            <li>&ldquo;What does SimplAssist do?&rdquo;</li>
            <li>&ldquo;Which plan includes phone answering?&rdquo;</li>
            <li>&ldquo;Can it book appointments for my business?&rdquo;</li>
          </ol>
          <p className={`mt-6 text-sm leading-6 ${body}`}>You can interrupt with a follow-up question or ask the assistant to explain something another way.</p>
        </div>
      </section>

      <section id="voice-plan" className="grid scroll-mt-32 gap-8 py-14 sm:py-20 lg:grid-cols-2">
        <div>
          <h2 className={sectionHeading}>Voice, text, and website chat in Full Suite.</h2>
          <p className={`mt-5 leading-7 ${body}`}>Some customers prefer to type. Others want to call and explain what they need. Full Suite gives your business both options, with conversations and follow-up managed from the same dashboard.</p>
          <p className={`mt-4 leading-7 ${body}`}>Start with your business profile, services, FAQs, and AI settings. Connect Google Calendar if you want appointment booking. Voice requires an active, approved account, an assigned number, and Voice mode enabled.</p>
          <Link href="/#pricing" className={`${inlineLink} mt-6 inline-block underline underline-offset-4`}>Compare Full Suite with all other plans</Link>
        </div>
        <div className={`${tile} p-6 sm:p-8`}>
          <p className={`text-sm font-bold ${accentText}`}>FULL SUITE{available ? "" : " · COMING SOON"}</p>
          <p className={`mt-3 text-5xl font-extrabold tracking-tight ${ink}`}>${plan.price}<span className={`text-lg font-medium ${body}`}>/month</span></p>
          <p className={`mt-3 text-sm font-semibold ${accentText}`}>${SETUP_FEE_CENTS / 100} one-time SMS activation fee</p>
          <ul className={`my-6 space-y-3 leading-6 ${body}`}>
            <li>{plan.includedVoiceMinutes} voice minutes per billing month</li>
            <li>{plan.includedSmsParts.toLocaleString("en-US")} SMS parts per month</li>
            <li>Everything in SMS + Web Chat, plus phone answering in English</li>
            <li>Voice contact capture, calendar booking, transcripts, and recordings</li>
          </ul>
          {available ? <Link href="/signup" className={btnPrimary}>Get started with Full Suite</Link> : <FullSuiteWaitlistButton className={btnPrimary} />}
          <p className={`mt-5 text-xs leading-5 ${body}`}>{FULL_SUITE_USAGE_NOTE}</p>
        </div>
      </section>

      <FeatureFaqs title="How SimplAssist Voice works." faqs={faqs} />
      <section className={`${tile} p-6 sm:p-8`}>
        <h2 className="text-2xl font-bold">Choose the way your customers reach you.</h2>
        <p className={`mt-4 max-w-3xl leading-7 ${body}`}>Explore <Link href="/#missed-call-text-back" className={`${inlineLink} underline`}>missed-call text back</Link> for SMS follow-up, or learn how our <Link href="/ai-chatbot-for-small-business" className={`${inlineLink} underline`}>website chatbot for small businesses</Link> answers visitors who prefer to type.</p>
      </section>
    </FeaturePage>
  );
}
