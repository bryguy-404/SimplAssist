# Upgrade ladder UI verification — October 4, 2026

Verification used an isolated source copy at `127.0.0.1:56420` and the dedicated
local `SimplAssistReviews` Supabase stack on ports 56321/56322. External provider
credentials were deliberately invalid and sending/provisioning disabled. No
production account was used. Wizard provider and pricing state was explicitly
synthetic; its mutation routes returned 409 instead of contacting providers.

## Observed browser checks

- Native Chrome showed the three public pricing cards and comparison columns:
  Chat $15, SMS + Web Chat $49, Full Suite $79. Chat had no activation fee;
  texting activation was $25. SMS Only was absent. Desktop dark mode was viewed.
- The real conversion wizard rendered a synthetic approved campaign in desktop
  light mode. It explained $49/month, 1,500 shared SMS parts, no new activation,
  continued $35 service during approval, the $14 difference and retained renewal.
- The number-move acknowledgement initially disabled “Move my number.” Checking
  it enabled the button; keyboard Tab reached it with a visible focus outline.
  No move or payment was submitted. No runtime console errors were observed.

## Authenticated application and database checks

A disposable local owner signed in through normal Supabase password auth and an
SSR session cookie. Dashboard and preference endpoints were not mocked. The
fixture had an explicitly synthetic accepted initial review email; none was sent.

- Dashboard GET returned 200 and the correct review-texting offer.
- Snooze POST returned 200, and the next dashboard GET omitted the offer. The
  database recorded dismissal count/revision 1 and a seven-day delay.
- A stale revision returned 409 without another increment; unauthenticated
  access returned 401.
- After advancing only the fixture's snooze deadline, the second dismissal
  persisted seven days and the third persisted 30 days.
- Permanent hide persisted the hidden timestamp at revision 4; subsequent GETs
  returned no offer. Billing/provider operation counts remained zero.
- The destination was `/reviews?tab=settings#review-sms`; its authenticated GET
  returned 200 and initialized the real Reviews workspace in its settings tab.
  Client-side anchor scrolling was not verified.

## Initial browser interruption

Native browser controls later returned `noWindowsAvailable`; Safari's local
login appeared blank, and the in-app browser was unavailable while the task was
hidden. Further retries were stopped. Automated/API checks do not replace the
following unfinished browser checks:

- Signed-in CTA clicks, browser snooze/reload and destination anchor scrolling.
- Mobile layout and all light/dark combinations.
- Pending, moving, ready and support-required wizard screens.
- Actual signup plan chooser and the deployed public fee display.

At that point, both dashboard promotions and review conversions stayed disabled.
The restored-browser follow-up below resolves the dashboard restriction. The
separate real carrier pilot is still required; no live number transfer was tested.

## Cleanup

The local fixture owner, business and preference rows were deleted and verified
absent. Temporary credentials/session files, source copy and harness were
removed, and the server stopped. Browser control failure may have left local
test tabs open; their fixture sessions no longer exist. Unrelated tabs were
preserved. The dedicated stack received only additive migration 115; this UI
verification did not reset a database or change production.

## Restored-browser follow-up — October 5 UTC

The in-app browser became available again. Acceptance used the actual dashboard,
Reviews workspace, billing page and signup plan selector with five disposable
local accounts. Production pricing was also inspected in the live browser.

- Live pricing showed Chat $15, Growth $49 and Full $79, with $25 texting
  activation and no activation for Chat. The real signup selector contained only
  these three options, with initial totals of $15, $74 and $104.
- Chat A's first and second browser dismissals persisted seven days. After
  advancing only the fixture's snooze deadline between actions, its third
  dismissal persisted exactly 30 days at revision 3. Reload and another tab
  retained the preference.
- Chat B still received its own offer, proving dismissal isolation. Permanent
  hide persisted after reload at revision 1, without a snooze deadline.
- Desktop (1280px) and mobile (390px) layouts, light/dark themes and visible
  keyboard focus were checked. The mobile page had no horizontal overflow;
  closed navigation no longer exposed offscreen keyboard controls.
- The Reviews CTA opened Settings and focused/scrolled the fully loaded texting
  section. On mobile its top was 96px, below the fixed header, with $20/month,
  $35 total, $25 activation, 250 shared parts and approval/payment timing visible.
- The Growth CTA opened the Full billing section with $79/month, 2,500 shared
  parts, 100 voice minutes and no new activation. No quote/payment was requested.
- Labeled synthetic carrier screens covered initial application, pending,
  approved, moving, support-required and ready states. The move button required
  acknowledgement and cancellation was disabled during handoff. This is visual
  evidence only, not a live carrier pilot or payment test.

The checks found and fixed asynchronous Reviews anchor scrolling, query-tab
synchronization and closed mobile-menu focus exposure. Progress copy now names
website chat and email availability instead of implying SMS continues during a
handoff. A pre-hydration local sign-in also exposed native GET form submission;
auth forms now use POST and keep submit disabled until hydrated. Only disposable
local credentials were involved. Normal hydrated login was verified in-browser.

The final regression run passed 8,078 tests across 494 files; three provider
harnesses remained opt-in. TypeScript, focused ESLint and production build passed.
All provider/payment/send counts matched the fixture baseline. The five fixture
businesses and auth accounts were deleted, credentials removed and server stopped.
The browser viewport was reset and local test tabs closed.

A test-only attempt to change an immutable Growth activation record was rejected
and rolled back; no trigger was disabled. Activation-age rules remain covered by
unit tests. Local homepage widget configuration requests failed against the
isolated test origin; no dashboard or upgrade runtime failure was observed.

Screenshot evidence is retained at `/private/tmp/simplassist-dashboard-suggestion-desktop.jpg`,
`/private/tmp/simplassist-dashboard-suggestion-mobile-light.jpg`,
`/private/tmp/simplassist-dashboard-suggestion-mobile-dark.jpg`, and
`/private/tmp/simplassist-review-upgrade-mobile-verified.jpg`.
