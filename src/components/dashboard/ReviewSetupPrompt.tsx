import Link from "next/link";
import { ArrowRight, Star } from "lucide-react";
import type { ReviewSetupStep } from "@/lib/dashboard/reviewSetup.server";
import { body, card, ink, inlineLink } from "@/lib/theme-v2/theme";

export default function ReviewSetupPrompt({ step }: { step: ReviewSetupStep }) {
  const needsLink = step === "add_link";
  return (
    <aside className={`p-4 sm:p-5 ${card}`} aria-labelledby="review-setup-title">
      <div className="flex items-start gap-3">
        <Star className="mt-0.5 h-5 w-5 shrink-0 text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 id="review-setup-title" className={`text-sm font-semibold ${ink}`}>
            Start collecting Google reviews
          </h2>
          <p className={`mt-1 text-sm ${body}`}>
            {needsLink
              ? "Add your Google review link to start asking customers for feedback by email. It’s included in your plan."
              : "Finish your review settings to start asking customers for feedback by email. It’s included in your plan."}
          </p>
          <Link href="/reviews?tab=settings" className={`mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-md text-sm font-semibold ${inlineLink} focus-visible:outline focus-visible:outline-2`}>
            {needsLink ? "Add your review link" : "Finish review setup"}
            <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </aside>
  );
}
