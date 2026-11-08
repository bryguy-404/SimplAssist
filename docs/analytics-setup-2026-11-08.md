# SimplAssist website analytics — November 8, 2026

## Google property

- Owner Google account: `bryandevelops574@gmail.com`.
- Dedicated Analytics account: **SimplAssist**, ID `415419405`.
- GA4 property: **SimplAssist**, ID `563189873`.
- Web stream: **SimplAssist Website**, ID `16296916482`, `https://simplassist.com`.
- Measurement ID (public, not a secret): `G-KBYVGK8SE9`.
- Reporting time zone: Indianapolis. Currency: USD.
- Business objectives: generate leads and understand website traffic.
- Google account sharing options were left off. Enhanced measurement is **off** to prevent automatic form, URL/history, and content collection.
- No advertising account links, Google signals, user IDs, or user-provided data collection were enabled.
- User explicitly authorized acceptance of Analytics Terms of Service and Data Processing Terms during setup.

## Website behavior

The Railway **SimplAssist web service**, production, uses the runtime variable `GOOGLE_ANALYTICS_MEASUREMENT_ID`. It is passed from the root server layout only for the default brand, excluding preview and partner branding. There is no fallback production ID in source; local and preview hostnames are excluded by the client as well.

`src/lib/analytics/marketing.ts` contains a strict route allowlist: homepage, the three feature/industry pages, support/setup-fee, privacy, terms, and public signup. Customer `/c/` pages, auth callbacks, dashboards, partner hosts, and other routes are excluded.

Analytics loads only after explicit visitor permission. The preference lasts up to 180 days and is editable in the marketing footer or the privacy policy. Denial/revocation disables collection and removes GA cookies from this browser. Browser storage failures fail closed. Reports consequently cover consenting visitors, not every visitor.

Page views are sent manually once per pathname transition; query strings and hashes are excluded. Only static page titles and a sanitized referring site are sent. UTM parameters are intentionally not collected in this initial setup; acquisition can still use referring websites. No form values, conversation content, audio, customer identifiers, or private dashboard information are passed to Analytics.

| Event | Actual meaning |
| --- | --- |
| `page_view` | A consenting visitor views an allowed page. |
| `demo_chat_open` | Visitor opens the homepage demo chat (including via Ask away). No message content is sent. |
| `demo_voice_click` | Visitor clicks the public demo telephone link. This does **not** prove that a call connected. |
| `signup_click` | Visitor clicks a link to the public signup page. |
| `signup_request_submitted` | Supabase accepts the public signup request without an error. Email confirmation may still be pending; existing-account protections may also return success. This is **not** a verified signup, subscription, or revenue event. |

`signup_request_submitted` is a GA4 key event, counted once per session, with no fabricated monetary value. Demo and CTA clicks remain regular events so they do not inflate the signup key-event metric. Standard Google default key-event names may also appear but are not emitted by this change.

## Validation

- Production build including TypeScript and lint checks passed.
- Analytics boundary tests plus existing homepage/signup page tests: 28 passing tests across 3 files.
- Tests cover no consent, denied/expired/unavailable consent, private and partner exclusion, safe URLs/referrers, page-view deduplication, and revocation.
- No real signup, payment, or telephone call is performed as a verification step.
- Live deployment and Google report verification are recorded after publishing.

## Review

First review: **December 8, 2026**. Compare Search Console clicks/impressions with Analytics acquisition sources, landing pages, demo interactions, and signup requests. Small samples and consent choices limit conclusions. Analytics starts collecting after installation; it cannot reconstruct historical visits. Use the application database and billing system for verified customers and revenue.

Official references: [GA4 setup](https://support.google.com/analytics/answer/14183469), [manual page views](https://developers.google.com/analytics/devguides/collection/ga4/views), [basic consent mode](https://developers.google.com/tag-platform/security/concepts/consent-mode), [consent implementation](https://developers.google.com/tag-platform/security/guides/consent).
