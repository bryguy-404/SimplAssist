import { SUBSCRIPTION_PLANS } from "@/lib/stripe/config";

const plan = SUBSCRIPTION_PLANS.full;
const smsParts = plan.includedSmsParts.toLocaleString("en-US");

export const FULL_SUITE_DESCRIPTION =
  "Answer unanswered calls with a natural AI receptionist, capture details, and help callers take the next step.";

export const FULL_SUITE_HIGHLIGHTS = [
  "Everything in SMS + Web Chat, plus",
  "AI voice answering in English",
  `${plan.includedVoiceMinutes} voice minutes/billing month`,
  "Contact capture, signup texts + calendar booking",
  `${smsParts} included SMS parts/month`,
];

export const FULL_SUITE_PACKAGE_SUMMARY =
  `Full Suite combines everything in SMS + Web Chat with AI voice answering in English, ${plan.includedVoiceMinutes} voice minutes per billing month, ${smsParts} SMS parts per month, and custom AI rules for $${plan.price}/month.`;

export const FULL_SUITE_USAGE_NOTE =
  "Long texts can use multiple SMS parts. Voice minutes reset each billing month and do not roll over. No automatic paid voice overages. Voice requires an active, approved account and an assigned phone number.";
