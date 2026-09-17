import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { telnyx } from "@/lib/messaging/client";
import { sendMissedCallSMS } from "@/lib/messaging/missed-call";
import {
  checkVoiceWorkerReady,
  type PilotRoutingDependencies,
} from "./routing";

export function pilotRoutingDependencies(): PilotRoutingDependencies {
  const workerUrl = process.env.VOICE_SERVICE_URL || "";
  const token = process.env.VOICE_INTERNAL_TOKEN || "";
  return {
    db: supabaseAdmin,
    telnyx,
    appUrl: process.env.NEXT_PUBLIC_APP_URL || "",
    workerUrl,
    streamSecret: process.env.VOICE_STREAM_SECRET || "",
    profile: process.env.VOICE_AUDIO_PROFILE === "pcmu8" ? "pcmu8" : "pcm16",
    workerReady: () => checkVoiceWorkerReady(workerUrl, token),
    commercialWorkerReady: () => checkVoiceWorkerReady(workerUrl, token, true),
    prepareWorker:
      process.env.VOICE_ACTIONS_ROLLOUT === "true"
        ? async (sessionId) => {
            const url = new URL("/prepare", workerUrl);
            if (url.protocol !== "https:" || token.length < 32)
              throw new Error("voice_preparation_configuration");
            await fetch(url, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ sessionId }),
              signal: AbortSignal.timeout(1500),
            });
          }
        : undefined,
    sendFallback: async (session, claim) => {
      await sendMissedCallSMS(
        session.caller_phone,
        session.business_id,
        session.call_session_id,
        { claim },
      );
    },
  };
}
