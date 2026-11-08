# SimplAssist SEO review and first industry page

The November 8, 2026 review supports improving the existing Voice page and adding
one substantive plumbing/HVAC page before expanding into other industries.
The site should serve businesses nationally while local outreach supplies
feedback and, eventually, permission-based customer examples.

## Search Console baseline

Read directly from the signed-in `simplassist.com` domain property. Web search,
all countries and devices, without a query or page filter:

| Period | Clicks | Impressions | CTR | Average position |
| --- | ---: | ---: | ---: | ---: |
| August 7–November 6, 2026 | 4 | 130 | 3.1% | 23.2 |
| October 10–November 6, 2026 | 0 | 73 | 0% | 25.4 |

The three-month country table attributed all four clicks and 94 impressions to
the United States. In the last 28 days, the US had 55 impressions and no clicks.
These are small samples; average position across the property is not the rank
of a chosen target keyword, and Search Console does not establish conversions.

Relevant visible queries in the three-month view:

| Query | Clicks | Impressions | Average position |
| --- | ---: | ---: | ---: |
| ai receptionist for small business | 0 | 10 | 71.9 |
| ai answering service for small business | 0 | 4 | 89.3 |
| ai receptionist small business | 0 | 1 | 58.0 |
| ai voice receptionist for small business | 0 | 1 | 71.0 |
| ai phone assistant for business | 0 | 1 | 73.0 |
| small business chatbot | 0 | 1 | 18.0 |

All 20 displayed query rows had zero clicks. The four property-level clicks
cannot be attributed to a specific visible query from this report.

The homepage had 4 clicks and 71 page impressions. The Voice page had 0 clicks,
41 page impressions, and average position 41.1. The chatbot page had 0 clicks,
1 page impression, and position 18. Page-level impression totals can differ
from the property total; do not add them to estimate visitors.

The Google generative AI features report (Beta) displayed **14 impressions**
for October 10–November 6. Its page table included the homepage, setup-fee page,
Voice page, and privacy page. This view did not provide click or query metrics.
It does not measure ChatGPT referrals or establish customer acquisition.

## Indexing and discovery findings

- The page-indexing summary, dated October 22, listed 7 indexed and 13 excluded
  URLs. Exclusions included redirects, robots exclusions, duplicates, two font
  files, and an older record for the chatbot page.
- The newer individual inspection of `/ai-chatbot-for-small-business` showed
  **URL is on Google / Page is indexed**, last crawled November 6 at 5:29:36 PM.
  Crawl and indexing were allowed, the fetch succeeded, and Google's canonical
  matched the declared URL. Do not treat the older exclusion as a current issue.
- The sitemap report showed **Success**, last read November 3, with 7 discovered
  URLs before this release's eighth entry.
- The Links report listed 2 external links, both from `bryandevelops.com`, and
  24 internal links. This report is not an exhaustive inventory of links.
- The live robots file allowed public pages under `User-Agent: *`. This alone
  does not verify every crawler's access through the hosting/CDN layer.

## First release scope

- Preserve the homepage's missed-call text-back focus and the existing website
  chatbot page.
- Improve `/ai-receptionist-for-small-business` with the answering-service
  description, practical use cases, forwarding requirements, and answers about
  retaining personal customer contact.
- Add `/ai-receptionist-for-plumbing-and-hvac` with distinct plumbing/HVAC
  examples, a labeled fictional conversation, setup instructions, actual plan
  pricing/limits, FAQs, and links to the existing live Voice demo.
- Explain the difference between Google Calendar appointments and dispatch.
  Do not claim field-service integrations, live transfers, emergency response,
  or guaranteed callbacks.
- Link the new page from the Voice content, Features menu, footer, and curated
  sitemap. Use the existing design, canonical metadata, and breadcrumb schema.
- Leave Analytics setup for a follow-up, as agreed with Bryan. No Google
  Analytics measurement ID exists yet; this release does not collect demo or
  signup conversion events.

Other industry pages, a dedicated pricing page, and customer case studies remain
later work. These keyword targets are hypotheses supported by business fit and
commercial search results, not verified low-competition or traffic forecasts.

## Local validation

The existing feature-page, homepage, pricing, and redirect checks passed
(4 test files, 19 tests). ESLint and the production build, including TypeScript
validation, passed. Both changed public pages returned HTTP 200 with one H1,
self-referencing production canonicals, matching WebPage/BreadcrumbList data,
and no noindex directive. The sitemap contained eight curated public URLs.

Browser review covered desktop and 390-pixel mobile layouts, the new Features
menu link, the industry FAQ, and the link to the existing Voice demo section.
No browser console errors were reported during those checks. Production pricing
is read from the existing plan configuration; no prices or billing settings
were changed by this release.

## Review checkpoints

**December 8, 2026:** review roughly one month after release. Inspect the new URL
and sitemap, then compare the latest complete 28-day Web period against
October 10–November 6. Record US and all-country impressions/clicks separately,
relevant non-brand queries, and landing pages. Review Google's AI report using
the same dates, without adding its totals to Web traffic. Once Analytics is
connected, record its activation date and report demo interactions and confirmed
signups separately; a demo click is not a completed call or a customer.

**Around February 8, 2027:** assess the broader three-month trend and customer
feedback before expanding industry coverage. These are review dates, not
ranking or traffic guarantees. Do not repeatedly change page targets because
of a few impressions. No automated review or reminder has been scheduled.

## Guidance used

- [Google AI features and your website](https://developers.google.com/search/docs/appearance/ai-features)
- [Google helpful content guidance](https://developers.google.com/search/docs/fundamentals/creating-helpful-content)
- [OpenAI search crawler documentation](https://developers.openai.com/api/docs/bots)
- [Search Console Web report](https://search.google.com/u/3/search-console/performance/search-analytics?resource_id=sc-domain%3Asimplassist.com)
