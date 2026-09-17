# SEO feature pages — September 17, 2026

## Status

Implemented and verified locally. At the initial QA checkpoint these changes had
not been committed, pushed, or deployed. Commit and push to `main` were then
authorized after review of Google's guidance below. Git publication and production
deployment are separate steps; this document does not establish a live launch.

## Page strategy

| Page | Primary search topic | Offer and purpose |
| --- | --- | --- |
| `/` | Missed call text back | Explain automatic SMS follow-up from $25/month; show all available plans and retain the separate $10 webchat entry point. |
| `/ai-chatbot-for-small-business` | AI chatbot for small business | Explain website chat, lead capture, booking, reply allowance, and the existing live chat demo. |
| `/ai-receptionist-for-small-business` | AI receptionist for small business | Explain a natural phone conversation, setup, call review, Full Suite pricing and limits, and the existing live demo number. |

The shared Features menu, footer, and contextual links connect the three pages.
The two feature pages have unique titles, descriptions, production canonical URLs,
and matching WebPage/BreadcrumbList structured data. The curated sitemap now has
seven entries. Private and preview routes remain excluded.

The $10 offer retains the existing public-launch and Stripe price configuration
gates. With that offer disabled, the website chat page describes SMS + Web Chat
at $45/month instead. Full Suite availability also uses the existing plan gate.

## Shared design and duplicate-content review

Reviewed Google's current primary documentation before committing:

- [Canonicalization](https://developers.google.com/search/docs/crawling-indexing/canonicalization)
  explains that Google compares each page's primary content and can group pages
  whose main content is substantially the same. Some duplicate content is normal
  and does not itself violate the spam policies.
- [Doorway abuse](https://developers.google.com/search/docs/essentials/spam-policies#doorway-abuse)
  covers substantially similar, low-value pages created to capture related
  searches and funnel visitors elsewhere.
- [Helpful content](https://developers.google.com/search/docs/fundamentals/creating-helpful-content)
  emphasizes useful, substantial information that helps the intended audience.

Assessment: keeping the same branding, navigation, typography, cards, and FAQ
components is appropriate here. The webchat page explains embedding a website
widget, typed conversations, reply allowances, lead capture, and its live chat
demo. The Voice page explains phone handling, spoken conversations, recordings,
transcripts, voice-minute limits, and its live telephone demo. Each provides a
complete feature-specific explanation and is reachable through normal navigation.
These are distinct product destinations, not keyword-swapped copies. A cosmetic
redesign is therefore not warranted for this SEO concern. This assessment is not
a guarantee that Google will index or rank either page, and it does not diagnose
the user's previous site's performance.

## Verification

- Initial relevant test run: 33 files, 587 tests passed (including widget behavior).
- Final focused run after navigation, pricing, and schema changes: 17 files,
  123 tests passed.
- ESLint, TypeScript, `git diff --check`, and the final production build passed.
- Browser review covered desktop and narrow mobile layouts, feature navigation,
  menu dismissal with Escape, FAQ expansion, and the Voice demo anchor/link.
- Local production responses returned HTTP 200 for all three pages and the
  sitemap. Each page has one H1; the sitemap contains seven URLs.
- The local homepage inherits the local `NEXT_PUBLIC_APP_URL` metadata base;
  verify its production canonical on the live domain after deployment.

The live chat widget cannot fetch its production configuration from localhost.
Its integration reuses the existing homepage widget and was covered by the
widget tests, but the new page's live chat needs verification on the production
domain. No phone calls, chat messages, purchases, or signups were made during QA.

## Launch and measurement

1. Commit the intended source files and research notes, excluding unrelated
   `.claude/` and `.worktrees/` directories.
2. Publish through the project's Railway deployment workflow; a Git push alone
   does not deploy while its GitHub source is disconnected.
3. Verify live page content, pricing gates, canonical URLs, sitemap, internal
   links, and the new page's chat widget. Confirm the phone demo link still points
   to the existing connected number without making an unrequested test call.
4. Inspect the two new URLs in Search Console and request indexing after the
   live pages pass verification. The existing sitemap URL remains unchanged.
5. Compare non-brand queries, impressions, clicks, and landing pages with
   `search-console-baseline-2026-09-17.md`. Review early discovery after about
   30 days and trends at 90–120 days; those dates are checkpoints, not ranking
   guarantees. Search demand and difficulty estimates are documented in
   `keyword-research-2026-09-17.md` and are not traffic forecasts.
