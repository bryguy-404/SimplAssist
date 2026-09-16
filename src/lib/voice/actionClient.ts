import type { ActionContext, ActionDecision, VoiceAnswer } from "./actions";
export function createVoiceActionClient(appUrl: string, token: string) {
  if (new URL(appUrl).protocol !== "https:" || token.length < 32)
    throw new Error("voice_action_client_configuration");
  async function call<T>(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetch(
      new URL("/api/internal/voice/actions", appUrl),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000),
      },
    );
    if (!response.ok) throw new Error("voice_action_request_failed");
    return response.json() as Promise<T>;
  }
  return {
    context: (sessionId: string, signal?: AbortSignal) =>
      call<ActionContext>({ operation: "context", sessionId }, signal),
    decision: (
      sessionId: string,
      decision: ActionDecision,
      signal?: AbortSignal,
    ) =>
      call<VoiceAnswer>({ operation: "decision", sessionId, decision }, signal),
    playback: (
      sessionId: string,
      actionId: string,
      eventId: string,
      callerEndMs: number,
    ) =>
      call({
        operation: "playback",
        sessionId,
        actionId,
        eventId,
        callerEndMs,
      }),
  };
}
export type VoiceActionClient = ReturnType<typeof createVoiceActionClient>;
