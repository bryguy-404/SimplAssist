import "server-only";
import { resend } from "@/lib/email/client";
import { accountAlertMessageSchema, type AccountAlertMessage } from "./message";

export type AccountAlertSendResult =
  | { kind: "accepted"; providerId: string }
  | { kind: "retry" | "needs_review"; code: string };
export const ACCOUNT_ALERT_SEND_TIMEOUT_MS = 8000;

export async function sendAccountAlert(id: string, message: AccountAlertMessage): Promise<AccountAlertSendResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const parsed = accountAlertMessageSchema.parse(message);
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("invalid_alert_id");
    const result = await Promise.race([
      resend.emails.send(parsed, {
        idempotencyKey: `account-signup-alert-v1/${id}`,
        signal: controller.signal,
      } as Parameters<typeof resend.emails.send>[1] & { signal: AbortSignal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, ACCOUNT_ALERT_SEND_TIMEOUT_MS);
      }),
    ]);
    if (!result.error && typeof result.data?.id === "string" && result.data.id.trim()) {
      return { kind: "accepted", providerId: result.data.id.trim() };
    }
    // Never record provider bodies (which can contain customer data or credentials).
    if (["validation_error", "invalid_parameter", "invalid_from_address", "invalid_idempotency_key", "invalid_idempotent_request"].includes(result.error?.name ?? "")) {
      return { kind: "needs_review", code: "provider_invalid_request" };
    }
    return { kind: "retry", code: "provider_not_confirmed" };
  } catch {
    // Exact frozen content + the same key makes ambiguous retries safe within 23h.
    return { kind: "retry", code: "provider_not_confirmed" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
