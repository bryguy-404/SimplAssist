import "server-only";
import { supabaseAdmin as db } from "@/lib/supabase/admin";
import { screeningVerdict } from "./domain";

function eventTime(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : new Date().toISOString();
}
export async function captureCallScreening(businessId: string, payload: Record<string, unknown>) {
  const raw = payload.call_screening_result ?? null;
  const encoded = JSON.stringify(raw);
  const { error } = await db.rpc("observe_inbound_call_screening", {
    p_business: businessId,
    p_control: payload.call_control_id,
    p_session: typeof payload.call_session_id === "string" ? payload.call_session_id : payload.call_control_id,
    p_caller: payload.from,
    p_called: payload.to,
    p_verdict: screeningVerdict(raw),
    p_evidence: encoded && Buffer.byteLength(encoded) <= 3000 ? raw : null,
    p_started: eventTime(payload.start_time),
  });
  if (error) throw new Error("screening_event_save_failed");
}

export async function finishCallScreening(payload: Record<string, unknown>, occurredAt?: string) {
  let control = typeof payload.call_control_id === "string" ? payload.call_control_id : null;
  if (!control && typeof payload.client_state === "string") {
    try {
      const state = JSON.parse(Buffer.from(payload.client_state, "base64").toString("utf8"));
      if (state.forwardingRole !== "forward_target" && typeof state.callControlId === "string") control = state.callControlId;
    } catch { /* A missing identity is recovered from provider status, never guessed from a shared session. */ }
  }
  if (!control) return;
  const timestamp = payload.end_time ?? occurredAt;
  const { error } = await db.rpc("finish_inbound_call_screening", {
    p_control: control, p_ended: eventTime(timestamp),
    p_exact_time: typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp)),
  });
  if (error) throw new Error("screening_call_end_save_failed");
}

export async function callFollowupAllowed(args: {
  businessId: string; identity: string; callerPhone: string; expected?: boolean;
}): Promise<boolean> {
  const { data, error } = await db.rpc("call_followup_screening", {
    p_business: args.businessId, p_identity: args.identity, p_caller: args.callerPhone, p_expected: args.expected === true,
  });
  if (error || data === "unavailable" || !["allowed", "legacy", "suppressed"].includes(data)) {
    throw new Error("screening_followup_unavailable");
  }
  return data !== "suppressed";
}
