import { z } from "zod";
import { actionDecision, type VoiceAnswer } from "./actions";
import type { VoiceActionClient } from "./actionClient";
import { VOICE_ACTION_INSTRUCTIONS } from "./actionInstructions";
import Anthropic from "@anthropic-ai/sdk";
import { APIConnectionTimeoutError } from "@anthropic-ai/sdk/core/error";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadVoiceKnowledge } from "./knowledge";
import { ANSWERING_MODEL, type VoiceSession } from "./types";

export function createVoiceAnswerer(
  db: SupabaseClient,
  apiKey: string,
  actions?: VoiceActionClient,
) {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 8000 });
  return async (
    session: VoiceSession,
    delegationId: string,
    transcript: string,
    signal: AbortSignal,
  ): Promise<string | VoiceAnswer> => {
    const started = Date.now();
    const { error: claimError } = await db.from("voice_provider_usage").insert({
      session_id: session.id,
      business_id: session.business_id,
      provider: "anthropic",
      request_id: delegationId,
      model: ANSWERING_MODEL,
      status: "pending",
    });
    if (claimError) throw new Error("backend_usage_claim_failed");
    let stage = "context";
    try {
      const context = actions
        ? await actions.context(session.id, signal)
        : null;
      const enabled =
        context && Object.values(context.capabilities).some(Boolean);
      stage = "knowledge";
      const system = await loadVoiceKnowledge(
        db,
        session.action_business_id || session.business_id,
        Boolean(enabled),
      );
      if (signal.aborted) throw new Error("backend_superseded");
      stage = "model";
      const response = await client.messages.create(
        {
          model: ANSWERING_MODEL,
          max_tokens: enabled ? 900 : 400,
          system: enabled
            ? `${system}\n${VOICE_ACTION_INSTRUCTIONS}\nVerified application state: ${JSON.stringify(context)}`
            : system,
          ...(enabled
            ? {
                tools: [
                  {
                    name: "voice_decision",
                    description:
                      "Prepare one safe voice decision. Confirm only a complete readback followed by clear caller assent.",
                    input_schema: {
                      type: "object" as const,
                      properties: { decision: z.toJSONSchema(actionDecision) },
                      required: ["decision"],
                      additionalProperties: false,
                    },
                  },
                ],
                tool_choice: { type: "tool" as const, name: "voice_decision" },
              }
            : {}),
          messages: [
            {
              role: "user",
              content: `Current call transcript (partial spoken fragments; latest caller correction takes precedence):\n${transcript}\n\n${enabled ? "Choose the next safe decision for the latest caller response and current action state. If a pending action exists, interpret the full response to its current permission question; do not propose a duplicate merely because the caller agreed." : "Prepare the answer to the latest business question. No actions are available."}`,
            },
          ],
        },
        { signal, timeout: enabled ? 12000 : 8000 },
      );
      stage = "usage";
      const { error } = await db
        .from("voice_provider_usage")
        .update({
          status: "confirmed",
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          provider_request_id: response.id,
          // Haiku 4.5 standard, uncached pricing. This call deliberately uses no cache control.
          estimated_cost_usd:
            response.usage.input_tokens / 1_000_000 +
            (response.usage.output_tokens * 5) / 1_000_000,
          latency_ms: Date.now() - started,
        })
        .eq("session_id", session.id)
        .eq("provider", "anthropic")
        .eq("request_id", delegationId);
      if (error) throw new Error("backend_usage_finalize_failed");
      if (enabled && actions) {
        stage = "decision_validation";
        if (response.stop_reason === "max_tokens")
          throw new Error("backend_output_incomplete");
        const blocks = response.content.filter((b) => b.type === "tool_use");
        if (blocks.length !== 1 || signal.aborted)
          throw new Error("invalid_voice_decision");
        const decision = actionDecision.parse(
          (blocks[0].input as { decision: unknown }).decision,
        );
        stage = "decision_execution";
        return await actions.decision(session.id, decision, signal);
      }
      const answer = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
      if (!answer || response.stop_reason === "tool_use")
        throw new Error("invalid_backend_answer");
      return answer.slice(0, 2000);
    } catch (error) {
      if (!signal.aborted)
        console.warn("[voice-answer] request_failed", {
          sessionId: session.id,
          delegationId,
          stage,
          category:
            error instanceof z.ZodError
              ? "invalid_decision_schema"
              : error instanceof Error &&
                  error.message === "backend_output_incomplete"
                ? "incomplete_model_output"
                : error instanceof APIConnectionTimeoutError
                  ? "model_timeout"
                  : "backend_request_failed",
        });
      // A timeout/abort may still have incurred provider charges; never mark it zero cost.
      await db
        .from("voice_provider_usage")
        .update({ status: "unconfirmed", latency_ms: Date.now() - started })
        .eq("session_id", session.id)
        .eq("provider", "anthropic")
        .eq("request_id", delegationId)
        .eq("status", "pending");
      throw error;
    }
  };
}
