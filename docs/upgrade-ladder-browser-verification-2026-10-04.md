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

## Remaining acceptance and rollout restriction

Native browser controls later returned `noWindowsAvailable`; Safari's local
login appeared blank, and the in-app browser was unavailable while the task was
hidden. Further retries were stopped. Automated/API checks do not replace the
following unfinished browser checks:

- Signed-in CTA clicks, browser snooze/reload and destination anchor scrolling.
- Mobile layout and all light/dark combinations.
- Pending, moving, ready and support-required wizard screens.
- Actual signup plan chooser and the deployed public fee display.

Keep `DASHBOARD_UPGRADE_PROMPTS_ENABLED=0` until these pass on a working browser
surface. Keep `REVIEW_SMS_UPGRADES_ENABLED=0` until the separate real carrier
pilot also passes. No carrier approval or live number transfer was tested.

## Cleanup

The local fixture owner, business and preference rows were deleted and verified
absent. Temporary credentials/session files, source copy and harness were
removed, and the server stopped. Browser control failure may have left local
test tabs open; their fixture sessions no longer exist. Unrelated tabs were
preserved. The dedicated stack received only additive migration 115; this UI
verification did not reset a database or change production.
