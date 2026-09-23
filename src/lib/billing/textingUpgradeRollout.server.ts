import "server-only";

/** Disable acquisition/first confirmation without disabling already-confirmed recovery. */
export function isTextingUpgradeEnabled(businessId: string, environment: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(businessId)) return false;
  if (environment.CHAT_TEXTING_UPGRADES_ENABLED === "1") return true;
  const canary = environment.CHAT_TEXTING_UPGRADE_CANARY_BUSINESS_ID;
  return Boolean(canary && uuid.test(canary) && canary.toLowerCase() === businessId.toLowerCase());
}
