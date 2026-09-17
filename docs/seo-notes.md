# SEO notes — read before changing sitemap, robots, or index policy

## Canonical and sitemap policy

- The canonical marketing homepage is `/`. The legacy `/home` URL permanently
  redirects to `/` and must not be used in canonical metadata or new public links.
- The curated corporate sitemap contains exactly `/`,
  `/ai-chatbot-for-small-business`, `/ai-receptionist-for-small-business`,
  `/support`, `/support/setup-fee`, `/privacy`, and `/terms`.
- Public customer pages at `/c/[slug]` and their privacy/terms children may be
  indexed, but are intentionally omitted from the corporate sitemap.
- Auth, onboarding, dashboard, admin, widget preview, API, and waitlist
  unsubscribe routes are private or non-indexable and must not enter the sitemap.

## Pages that must NEVER be crawlable or listed

| Route | What it is | How it's gated |
|---|---|---|
| `/demo/conversations`, `/demo/calendar` | Dev-only fixture pages (fictional "Manny's Plumbing" data) used to produce the homepage marketing screenshots | `assertDemoPagesEnabled()` in `src/app/demo/_lib/guard.ts` — 404 page + `noindex` in production unless built with `ENABLE_DEMO_PAGES=1` |
| `/demo/onboarding-plan` | Dev-only visual preview of the onboarding plan selector | `assertDemoPagesEnabled()` in `src/app/demo/_lib/guard.ts` — 404 page + `noindex` in production unless built with `ENABLE_DEMO_PAGES=1` |
| `/home-v2` | Shelved alternate homepage (design record: `docs/home-v2-design.md`) | Same pattern — 404 + `noindex` unless `ENABLE_HOME_V2_PREVIEW=1` |

Both gates throw in `generateMetadata` **and** the page component. Note: Next 14.2
serves these as *soft* 404s (404 body + `noindex` meta, HTTP status 200) — no page
content is ever served in production, and `noindex` is authoritative for Google.

## Rules for future SEO work

1. **Sitemap** (`src/app/sitemap.ts`): keep the explicit seven-entry corporate
   allowlist above. Never include `/c/*`, `/demo/*`, or `/home-v2`, and never
   generate the sitemap by crawling the route tree (gated and customer-owned
   routes exist in the tree and would leak into it).
2. **robots.txt / robots.ts**: do NOT add `Disallow: /demo` or `Disallow: /home-v2`
   entries. robots.txt is public — listing a path there *advertises* it. The
   404 + `noindex` gating already handles every crawler correctly; robots
   entries would only disclose the URLs.
3. **New example/dummy/preview pages**: follow the same pattern — gate with a
   `notFound()` guard in `generateMetadata` + the component (copy
   `src/app/demo/_lib/guard.ts`), set `robots: { index: false, follow: false }`
   metadata, never link to them from public pages, and add them to the table above.
4. Dashboard/auth pages (`(dashboard)`, onboarding, etc.) are behind auth redirects,
   carry metadata-level `noindex` protection, and are disallowed in `robots.ts`.
