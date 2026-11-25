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
- Google's unified tag container is `GTM-5M78HTDM`. Its destination settings must disable `send_page_view`, `allow_google_signals`, and `allow_ad_personalization_signals`; legacy on-page `config` is insufficient for this new container's initialization. In-page global defaults are queued before initialization as well.
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
| `contact_click` | Visitor clicks any `tel:` or `sms:` link on an allowed marketing page. Sends `link_type` (`call` or `text`), `link_location`, and `page_path`. |
| `pricing_view` | At least 50% of the homepage's `#pricing` section is visible. Sends `page_path` once per page load. |
| `signup_click` | Visitor clicks a link to the public signup page. |
| `signup_request_submitted` | Supabase accepts the public signup request without an error. Email confirmation may still be pending; existing-account protections may also return success. This is **not** a verified signup, subscription, or revenue event. |

`signup_request_submitted` is a GA4 key event, counted once per session, with no fabricated monetary value. Demo and CTA clicks remain regular events so they do not inflate the signup key-event metric. Standard Google default key-event names may also appear but are not emitted by this change.

The contact and pricing events were added locally on November 25, 2026. Contact tracking uses the existing delegated click listener, so dynamically inserted links and clicks on nested icons/text are covered without altering navigation. Locations are `footer`, `header` (including navigation), the enclosing section ID (such as `hero`, `try-it-live`, or `voice-demo`), or `body` when no named region exists. Phone numbers, SMS message bodies, and link URLs are not sent. The demo phone link still also sends `demo_voice_click`.

Pricing uses `IntersectionObserver` with a `0.5` threshold on the entire section and disconnects after a successful event. Scrolling away and back, changing consent, and navigating away and back within the same loaded document do not duplicate it. A full reload permits a new event. On viewports shorter than half the pricing section, the requested 50% threshold cannot be reached. No layout change or alternative visibility threshold is applied.

## Verify contact and pricing in DebugView

After deploying these changes, connect `https://simplassist.com` through [Google Tag Assistant](https://tagassistant.google.com/) to enable debug mode for your test browser, then choose **Allow analytics** on the site. In the SimplAssist GA4 property, open **Admin → Data display → DebugView** and select your debug device. See [Google's DebugView instructions](https://support.google.com/analytics/answer/7201382?hl=en).

1. Click a phone link and, wherever present, an SMS link. Check `contact_click` for `link_type=call` or `text`, the matching region in `link_location`, and the pathname in `page_path` (without query strings or fragments). You can cancel the phone/message application prompt.
2. On a sufficiently tall desktop viewport, scroll until at least half the pricing section is visible. Check one `pricing_view` with `page_path=/`. Scroll away and back: no second event should appear. Reload and repeat to get one new event.
3. Click a signup link and open the demo chat. Confirm `signup_click` and `demo_chat_open` still appear; the demo phone link should also retain `demo_voice_click`.

No new GA4 event definition is needed to receive these events in DebugView. Existing consent, host, and route restrictions still apply; localhost and preview hosts do not send analytics.

## Validation

November 25 contact/pricing change: all 28 targeted tests across the analytics, root layout, homepage, and homepage-widget suites passed. TypeScript (`tsc --noEmit --incremental false`) and lint for the changed source/test files passed. An isolated Chrome run of the actual analytics component verified delegated phone/SMS clicks (including newly inserted links and nested SVG/text), each location, unchanged link defaults, the exact 50% threshold, deduplication through scrolling/consent/client navigation, reset on reload, consent/private-route exclusions, and the existing signup/demo events. Browser requests were intercepted, so this check sent no live analytics. Deployment and GA4 receipt remain unverified for this change.

Original installation validation:

- Production build including TypeScript and lint checks passed.
- Analytics boundary tests plus existing homepage/signup page tests: 28 passing tests across 3 files.
- Tests cover no consent, denied/expired/unavailable consent, private and partner exclusion, safe URLs/referrers, page-view deduplication, and revocation.
- No real signup, payment, or telephone call is performed as a verification step.
- Live deployment and Google report verification are recorded after publishing.
- The first live check received demo and signup-click events, and identified extra automatic page views from Google's new container defaults. Those initial test views are setup traffic, not customer activity. Follow-up verification checks one view per navigation with automatic destination page views disabled.

## Review

First review: **December 8, 2026**. Compare Search Console clicks/impressions with Analytics acquisition sources, landing pages, demo interactions, and signup requests. Small samples and consent choices limit conclusions. Analytics starts collecting after installation; it cannot reconstruct historical visits. Use the application database and billing system for verified customers and revenue.

Official references: [GA4 setup](https://support.google.com/analytics/answer/14183469), [manual page views](https://developers.google.com/analytics/devguides/collection/ga4/views), [basic consent mode](https://developers.google.com/tag-platform/security/concepts/consent-mode), [consent implementation](https://developers.google.com/tag-platform/security/guides/consent).

Google's current [unified tag initialization behavior](https://support.google.com/analytics/answer/18411054) and [privacy settings](https://developers.google.com/tag-platform/security/guides/privacy) explain the destination-level settings above.
