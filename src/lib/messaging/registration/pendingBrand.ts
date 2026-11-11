/** A normal provider prerequisite wait, not a rejected or failed registration. */
export class BrandVerificationPendingError extends Error {
  constructor() {
    super("Business verification is in progress. Registration will continue automatically after approval.");
    this.name = "BrandVerificationPendingError";
  }
}

/** Only recognize the documented error observed during campaign preflight. */
export function isBrandVerificationPendingResponse(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: unknown; error?: unknown };
  if (value.status !== 400) return false;
  const body = value.error;
  const errors = Array.isArray(body) ? body
    : body && typeof body === "object" && "errors" in body ? body.errors : null;
  return Array.isArray(errors) && errors.length > 0 && errors.every((entry) =>
    entry && typeof entry === "object" && String(entry.code) === "527",
  );
}
