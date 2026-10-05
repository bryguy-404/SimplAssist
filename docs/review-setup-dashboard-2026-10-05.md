# Google review setup invitation

The dashboard now shows **Start collecting Google reviews** with **Add your review link** for eligible accounts whose review setup is incomplete. The link opens `/reviews?tab=settings`. The invitation disappears after the Google review URL and verified Reply-To are saved. A saved URL with an unverified Reply-To instead offers **Finish review setup**.

The resolver only reads settings for the authenticated owner's business. It does not initialize settings, enqueue email, or touch billing or provider resources. Existing review rollout exclusions, suspended/deleted businesses, partner-managed accounts, inactive subscriptions, and cancellation decisions are respected. Paused reviews do not receive the invitation. Database errors hide the optional card without blocking the dashboard.

Successful saves refresh the navigation cache and show confirmation. Signup remains unchanged. No migrations, new environment variables, pricing changes, or worker deployment are required.

Validation: 8,097 application tests passed (three external-provider tests skipped); focused tests passed again after the save-confirmation adjustment. TypeScript, ESLint, and production build passed. Browser checks used one disposable account in the isolated local database: desktop light theme, mobile dark theme, keyboard focus and Enter navigation, correct Settings destination, successful save, and disappearance on dashboard navigation and reload. No emails, payments, or provider operations were created.
