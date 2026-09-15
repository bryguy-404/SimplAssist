import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import Telnyx from "telnyx";
import { WebSocketServer } from "ws";
import { consumeStreamToken, createVoiceStore } from "../src/lib/voice/store";
import { createVoiceAnswerer } from "../src/lib/voice/answer";
import { LiveCall } from "../src/lib/voice/liveSession";
import { VOICE_MODEL } from "../src/lib/voice/types";
import type { AudioProfileName } from "../src/lib/voice/audio";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
const openaiKey = required("OPENAI_API_KEY");
const internalToken = required("VOICE_INTERNAL_TOKEN");
const appUrl = new URL(required("NEXT_PUBLIC_APP_URL"));
if (appUrl.protocol !== "https:")
  throw new Error("Voice maintenance requires an HTTPS application URL");
if (internalToken.length < 32)
  throw new Error("VOICE_INTERNAL_TOKEN must have at least 32 characters");
const profile = (process.env.VOICE_AUDIO_PROFILE ||
  "pcm16") as AudioProfileName;
if (!["pcm16", "pcmu8"].includes(profile))
  throw new Error("Invalid VOICE_AUDIO_PROFILE");
const db = createClient(
  required("NEXT_PUBLIC_SUPABASE_URL"),
  required("SUPABASE_SERVICE_ROLE_KEY"),
  {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(5000) }),
    },
  },
);
const telnyx = new Telnyx({
  apiKey: required("TELNYX_API_KEY"),
  maxRetries: 0,
  timeout: 5000,
});
const answer = createVoiceAnswerer(db, required("ANTHROPIC_API_KEY"));
const calls = new Set<LiveCall>();
let draining = false;
let readyAt = 0;
let probing = false;
let pendingUpgrades = 0;
let maintenanceBusy = false;
let maintenanceHealthyAt = 0;

async function maintenance() {
  if (maintenanceBusy || draining) return;
  maintenanceBusy = true;
  try {
    const result = await fetch(
      new URL("/api/internal/voice/maintenance", appUrl),
      {
        method: "POST",
        headers: { Authorization: `Bearer ${internalToken}` },
        signal: AbortSignal.timeout(30000),
      },
    );
    if (result.ok) maintenanceHealthyAt = Date.now();
    else
      console.warn("[voice] maintenance requires retry", {
        status: result.status,
      });
  } catch {
    console.warn("[voice] maintenance connection failed");
  } finally {
    maintenanceBusy = false;
  }
}

function authorized(value: string | undefined) {
  const expected = Buffer.from(`Bearer ${internalToken}`);
  const provided = Buffer.from(value ?? "");
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

async function probe() {
  if (probing || draining) return;
  probing = true;
  try {
    const [{ error }, provider] = await Promise.all([
      db.from("voice_sessions").select("id").limit(1),
      fetch(`https://api.openai.com/v1/models/${VOICE_MODEL}`, {
        headers: { Authorization: `Bearer ${openaiKey}` },
        signal: AbortSignal.timeout(5000),
      }),
    ]);
    if (error || !provider.ok) {
      readyAt = 0;
      return;
    }
    readyAt = Date.now();
  } catch {
    readyAt = 0;
  } finally {
    probing = false;
  }
}

const server = createServer((req, res) => {
  const path = req.url?.split("?", 1)[0];
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  if (path !== "/health" && path !== "/ready") {
    res.writeHead(404).end();
    return;
  }
  if (path === "/ready" && !authorized(req.headers.authorization)) {
    res.writeHead(404).end();
    return;
  }
  const ready =
    !draining &&
    Date.now() - readyAt < 45000 &&
    Date.now() - maintenanceHealthyAt < 90000;
  res.writeHead(ready ? 200 : 503).end(
    JSON.stringify({
      ready,
      profile,
      model: VOICE_MODEL,
      activeCalls: calls.size,
    }),
  );
});
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 256_000,
  perMessageDeflate: false,
});
server.on("upgrade", (req, socket, head) => {
  socket.on("error", () => {});
  if (
    draining ||
    Date.now() - readyAt > 45000 ||
    Date.now() - maintenanceHealthyAt > 90000 ||
    calls.size + pendingUpgrades >= 2
  ) {
    socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    return;
  }
  let token: string | null;
  try {
    const url = new URL(req.url ?? "/", "http://voice.local");
    if (url.pathname !== "/media") throw new Error("invalid_path");
    token = url.searchParams.get("token");
    if (!token) throw new Error("missing_token");
  } catch {
    socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return;
  }
  pendingUpgrades++;
  void consumeStreamToken(db, token)
    .then(async (session) => {
      if (!session || draining || socket.destroyed) {
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      const { data: business, error: businessError } = await db
        .from("businesses")
        .select("name")
        .eq("id", session.business_id)
        .single();
      if (
        businessError ||
        !business?.name?.trim() ||
        draining ||
        socket.destroyed
      )
        throw new Error("voice_business_identity_unavailable");
      wss.handleUpgrade(req, socket, head, (phone) => {
        const call = new LiveCall({
          session,
          businessName: business.name.trim(),
          phone,
          openaiKey,
          profile,
          store: createVoiceStore(db, session),
          answer,
          hangup: async () => {
            await telnyx.calls.actions.hangup(session.call_control_id, {
              command_id: `voice-end-${session.id}`,
            });
          },
          onClosed: () => calls.delete(call),
        });
        calls.add(call);
      });
    })
    .catch(() => socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n"))
    .finally(() => {
      pendingUpgrades--;
    });
});

const probeTimer = setInterval(() => void probe(), 15000);
const maintenanceTimer = setInterval(() => void maintenance(), 15000);
void maintenance();
void probe();
server.listen(Number(process.env.PORT || 3002), "0.0.0.0", () =>
  console.log("[voice] service listening"),
);

async function shutdown() {
  if (draining) return;
  draining = true;
  clearInterval(probeTimer);
  clearInterval(maintenanceTimer);
  server.close();
  const deadline = setTimeout(() => process.exit(1), 25000);
  await Promise.allSettled(
    Array.from(calls).map((call) => call.close("worker_shutdown", true)),
  );
  wss.close();
  clearTimeout(deadline);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
