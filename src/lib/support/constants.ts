/**
 * Single source of truth for how users reach support.
 *
 * Every user-facing support mention (links, banners, legal pages, the email
 * module) imports from here — never hardcode the address or path elsewhere.
 * The support alias receives mail in the existing Workspace inbox.
 *
 * No "server-only" and no env access: this module is imported by client
 * components (onboarding page, dashboard cards) and server code alike.
 */

export const SUPPORT_EMAIL = "support@simplassist.com";

export const SUPPORT_PATH = "/support";

/** Public explainer for the one-time setup and SMS activation fee. */
export const SETUP_FEE_EXPLAINER_PATH = "/support/setup-fee";

export const SUPPORT_CATEGORIES = [
  { value: "billing", label: "Billing" },
  { value: "number_registration", label: "Phone number / SMS registration" },
  { value: "bug", label: "Bug or technical issue" },
  { value: "other", label: "Something else" },
] as const;

export const SUPPORT_CATEGORY_VALUES = [
  "billing",
  "number_registration",
  "bug",
  "other",
] as const;

export type SupportCategory = (typeof SUPPORT_CATEGORY_VALUES)[number];

export function supportCategoryLabel(category: SupportCategory): string {
  return (
    SUPPORT_CATEGORIES.find((entry) => entry.value === category)?.label ?? category
  );
}

/** Path to the support page, optionally preselecting a category. */
export function supportHref(category?: SupportCategory): string {
  return category ? `${SUPPORT_PATH}?category=${category}` : SUPPORT_PATH;
}
