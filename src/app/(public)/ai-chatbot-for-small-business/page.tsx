import Link from "next/link";
import { CalendarCheck, Check, MessageCircle } from "lucide-react";
import { FeatureFaqs, FeaturePage, FeatureSteps, featureHeading, featureMetadata, sectionHeading } from "@/components/marketing/feature-page";
import { isChatOnlyPublicLaunchEnabled } from "@/lib/billing/chatOnlyPublicLaunch.server";
import { SUBSCRIPTION_PLANS } from "@/lib/stripe/config";
import { accentText, body, btnPrimary, btnSecondary, card, ink, inlineLink, tile } from "@/lib/theme-v2/theme";
import { HomepageChatWidget } from "../home/homepage-chat-widget";
import { OpenChatButton } from "../home/open-chat-button";

const path = "/ai-chatbot-for-small-business";
export const dynamic = "force-dynamic";

function content() {
  const chatOnly = isChatOnlyPublicLaunchEnabled();
  const plan = chatOnly ? SUBSCRIPTION_PLANS.chat_only : SUBSCRIPTION_PLANS.sms_and_chat;
  return {
    chatOnly, plan,
    title: `AI Chatbot for Small Business — $${plan.price}/mo | SimplAssist`,
    description: `An AI chatbot for your small business website. Answer questions, capture leads, and book with Google Calendar. ${chatOnly ? "$10/month with no setup fee." : "Included in SMS + Web Chat."}`,
  };
}

export function generateMetadata() {
  const { title, description } = content();
  return featureMetadata(path, title, description);
}

export default function WebsiteChatPage() {
  const { chatOnly, plan, title, description } = content();
  const replies = SUBSCRIPTION_PLANS.chat_only.includedAiReplies;
  const faqs = [
    { question: "What does a chatbot do for a small business website?", answer: "It lets visitors ask questions in a chat window instead of waiting for an email or phone reply. SimplAssist uses your saved business information to explain services, capture contact details, and help visitors book an appointment when Google Calendar booking is connected and enabled." },
    { question: "How does SimplAssist learn about my business?", answer: "You provide your business profile, services, hours, FAQs, and instructions. You can customize the assistant's tone and answers. Keep that information current and test the chat with real customer questions before adding it to your website." },
    { question: "Can the chatbot book appointments in Google Calendar?", answer: "Yes. With Google Calendar connected and appointment booking enabled, SimplAssist can check availability and help a visitor book a suitable time during the conversation. Your calendar connection and booking settings control when appointments are available." },
    { question: "How much does the website chatbot cost?", answer: chatOnly ? `Chat Only costs $${plan.price}/month and includes ${replies} completed AI replies each month, lead capture, a conversation inbox, AI customization, and Google Calendar booking. There is no setup fee. Phone answering and text messages are separate plan features.` : `Website chat is included in SMS + Web Chat for $${plan.price}/month. That plan also includes AI text conversations and ${plan.includedSmsParts.toLocaleString("en-US")} SMS parts per month. Paid SMS activation has a one-time $25 fee.` },
    ...(chatOnly ? [{ question: "What counts toward the monthly AI reply allowance?", answer: `Each completed AI reply in website chat counts toward the ${replies} included monthly replies. A conversation can contain several replies, so the allowance is not the same as ${replies} visitors or conversations. You can review your usage in the dashboard.` }] : []),
    { question: "Is website chat the same as phone answering?", answer: "Website chat is a typed conversation in a widget on your site. SimplAssist Voice is a spoken conversation over the phone and is included with Full Suite. SMS plans also provide missed-call text back. Choose the channels your customers use." },
  ];

  return (
    <FeaturePage path={path} title={title} description={description} breadcrumb="Website chat">
      <HomepageChatWidget />
      <section className="grid items-center gap-10 pb-12 lg:grid-cols-[1.1fr_.9fr]">
        <div>
          <p className={`mb-4 text-sm font-bold ${accentText}`}>WEBSITE CHAT · {chatOnly ? "CHAT ONLY" : "SMS + WEB CHAT"}</p>
          <h1 className={featureHeading}>An AI chatbot for your <span className={accentText}>small business.</span></h1>
          <p className={`mt-6 max-w-xl text-lg leading-8 ${body}`}>Give website visitors a helpful answer while you&apos;re busy serving customers. SimplAssist answers questions about your business, captures leads, and helps book appointments through Google Calendar.</p>
          <p className={`mt-5 text-xl font-bold ${ink}`}>${plan.price}/month{chatOnly ? ". No setup fee." : " with SMS + Web Chat."}</p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link href="/signup" className={btnPrimary}>{chatOnly ? "Start with $10 Webchat" : "Get Started"}</Link>
            <a href="#try-webchat" className={btnSecondary}>Try the live chat</a>
          </div>
          <p className={`mt-4 text-sm leading-6 ${body}`}>{chatOnly ? `${replies} completed AI replies per month. No phone number or texting setup required.` : "One-time $25 SMS activation fee. Texting requires carrier approval."}</p>
        </div>
        <figure className={`${card} p-6 sm:p-8`}>
          <div className="mb-6 flex items-center gap-3 border-b border-stone-200 pb-5 dark:border-white/10">
            <MessageCircle aria-hidden="true" className={`h-6 w-6 ${accentText}`} />
            <div><p className="font-bold">Your website, ready to answer.</p><p className={`text-sm ${body}`}>An example conversation</p></div>
          </div>
          <div className="space-y-4 text-sm leading-6">
            <p className="ml-10 rounded-2xl bg-stone-100 p-4 dark:bg-white/10"><span className="mb-1 block font-bold">Visitor</span>Do you offer estimates for lawn care?</p>
            <p className={`${tile} mr-7 p-4`}><span className={`mb-1 block font-bold ${accentText}`}>SimplAssist</span>Yes, we offer lawn care estimates. What would you like help with?</p>
            <p className="ml-10 rounded-2xl bg-stone-100 p-4 dark:bg-white/10"><span className="mb-1 block font-bold">Visitor</span>Weekly mowing. Can I book a visit?</p>
            <p className={`${tile} mr-7 p-4`}><span className={`mb-1 block font-bold ${accentText}`}>SimplAssist</span>I can help with that. Let&apos;s find an available time.</p>
          </div>
          <figcaption className={`mt-5 text-xs leading-5 ${body}`}>Illustrative example. Your answers come from your saved business information; booking requires a connected calendar and enabled availability.</figcaption>
        </figure>
      </section>

      <FeatureSteps title="From a website question to a next step." steps={[
        { title: "Add your business information", text: "Save your services, hours, FAQs, and preferred tone. Give SimplAssist the details customers need before they decide to contact or book with you." },
        { title: "Add chat to your website", text: "Customize the widget and add its embed code to your site. Visitors can start a conversation from the page they are already reading." },
        { title: "Review leads and bookings", text: "Read conversations and captured contact details in your dashboard. Connect Google Calendar to let visitors check availability and book during chat." },
      ]} />

      <section className="grid gap-8 py-12 lg:grid-cols-2">
        <div className={`${card} p-6 sm:p-8`}>
          <CalendarCheck aria-hidden="true" className={`mb-5 h-8 w-8 ${accentText}`} />
          <h2 className={sectionHeading}>Help visitors take the next step.</h2>
          <p className={`mt-5 leading-7 ${body}`}>A visitor comparing your services may need one answer before reaching out. Explain what you offer, collect their details, and help them find a time to talk—all from the website conversation.</p>
          <p className={`mt-4 leading-7 ${body}`}>For a service business, that might be a quote visit, an appointment, or a request for a callback. Set up your actual services and calendar so the assistant can respond with information that fits your business.</p>
        </div>
        <div className={`${tile} p-6 sm:p-8`}>
          <h2 className="text-2xl font-bold">What&apos;s included in website chat?</h2>
          <ul className="mt-6 space-y-4">
            {[
              "A website chat widget with custom branding",
              "Answers based on your business profile, services, and FAQs",
              "Lead capture and a contact and conversation inbox",
              "AI answer and tone customization",
              "Google Calendar connection and appointment booking",
              ...(chatOnly ? [`${replies} completed AI replies per month on Chat Only`] : ["AI text conversations with SMS + Web Chat"]),
            ].map((item) => <li key={item} className="flex gap-3 text-sm leading-6"><Check aria-hidden="true" className={`mt-0.5 h-5 w-5 shrink-0 ${accentText}`} />{item}</li>)}
          </ul>
          <Link href="/#pricing" className={`${inlineLink} mt-7 inline-block underline underline-offset-4`}>Compare plan pricing and allowances</Link>
        </div>
      </section>

      <section id="try-webchat" className={`${card} my-10 scroll-mt-32 p-6 sm:p-10`}>
        <p className={`mb-3 text-sm font-bold ${accentText}`}>TRY SIMPLASSIST LIVE</p>
        <h2 className={sectionHeading}>Ask a question. Then ask a follow-up.</h2>
        <p className={`mt-5 max-w-2xl leading-7 ${body}`}>Open the chat and ask, &ldquo;What is included in website chat?&rdquo; Then try, &ldquo;Can it book appointments?&rdquo; This live assistant answers questions about SimplAssist. Your own widget uses your business&apos;s information.</p>
        <div className="mt-6 flex flex-wrap gap-3"><OpenChatButton className={btnPrimary} /><Link href="/signup" className={btnSecondary}>Set up your website chat</Link></div>
        <p className={`mt-4 text-sm ${body}`}>The chat button becomes available when the widget loads.</p>
      </section>

      <FeatureFaqs title="Website chatbot questions, answered." faqs={faqs} />
      <section className={`${tile} p-6 sm:p-8`}>
        <h2 className="text-2xl font-bold">Help customers who reach out by phone, too.</h2>
        <p className={`mt-4 max-w-3xl leading-7 ${body}`}>Explore <Link href="/#missed-call-text-back" className={`${inlineLink} underline`}>missed-call text back</Link> for automatic SMS follow-up, or <Link href="/ai-receptionist-for-small-business" className={`${inlineLink} underline`}>SimplAssist Voice</Link> for natural phone conversations with your callers. Those features are available on separate plans.</p>
      </section>
    </FeaturePage>
  );
}
