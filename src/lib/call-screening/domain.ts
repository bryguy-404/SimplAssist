export type ScreeningMode = "disabled" | "flag_calls";
export type ProviderScreeningMode = ScreeningMode | "reject_calls" | "unknown";
export type SpamState = "inbox" | "suspected" | "spam";
export type ScreeningVerdict = "unknown" | "not_flagged" | "spam_likely";

/** A configured action is not a verdict. Unknown provider shapes stay visible. */
export function screeningVerdict(value: unknown): ScreeningVerdict {
  return value === "spam_likely" || value === "not_flagged" ? value : "unknown";
}
export function providerScreeningMode(value: unknown): ProviderScreeningMode {
  return value === "disabled" || value === "flag_calls" || value === "reject_calls" ? value : "unknown";
}
export function spamLabel(state?: SpamState) {
  return state === "suspected" ? "Suspected spam" : state === "spam" ? "Marked as spam" : null;
}
export interface CallScreeningSettings {
  available: boolean;
  canEnable: boolean;
  phoneNumber: string | null;
  confirmedMode: ProviderScreeningMode;
  requestedMode: ScreeningMode;
  revision: number;
  syncStatus: "idle" | "pending" | "error";
  verifiedAt: string | null;
  error: string | null;
}
