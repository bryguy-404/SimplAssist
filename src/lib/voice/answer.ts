import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadVoiceKnowledge } from "./knowledge";
import { ANSWERING_MODEL, type VoiceSession } from "./types";

export function createVoiceAnswerer(db: SupabaseClient, apiKey: string) {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 8000 });
  return async (session: VoiceSession, delegationId: string, transcript: string, signal: AbortSignal): Promise<string> => {
    const started = Date.now();
    const { error: claimError } = await db.from("voice_provider_usage").insert({ session_id: session.id, business_id: session.business_id, provider: "anthropic", request_id: delegationId, model: ANSWERING_MODEL, status: "pending" });
    if (claimError) throw new Error("backend_usage_claim_failed");
    try {
      const system = await loadVoiceKnowledge(db, session.business_id);
      if (signal.aborted) throw new Error("backend_superseded");
      const response = await client.messages.create({
        model: ANSWERING_MODEL, max_tokens: 400, system,
        messages: [{ role: "user", content: `Current call transcript (partial spoken fragments; latest caller correction takes precedence):\n${transcript}\n\nPrepare the answer to the latest business question. No actions are available.` }],
      }, { signal });
      const { error } = await db.from("voice_provider_usage").update({
        status: "confirmed", input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens,
        // Haiku 4.5 standard, uncached pricing. This call deliberately uses no cache control.
        estimated_cost_usd: response.usage.input_tokens / 1_000_000 + response.usage.output_tokens * 5 / 1_000_000,
        latency_ms: Date.now() - started,
      }).eq("session_id", session.id).eq("provider", "anthropic").eq("request_id", delegationId);
      if (error) throw new Error("backend_usage_finalize_failed");
      const answer = response.content.filter(b => b.type === "text").map(b => b.text).join(" ").trim();
      if (!answer || response.stop_reason === "tool_use") throw new Error("invalid_backend_answer");
      return answer.slice(0, 2000);
    } catch (error) {
      // A timeout/abort may still have incurred provider charges; never mark it zero cost.
      await db.from("voice_provider_usage").update({ status: "unconfirmed", latency_ms: Date.now() - started })
        .eq("session_id", session.id).eq("provider", "anthropic").eq("request_id", delegationId).eq("status", "pending");
      throw error;
    }
  };
}
