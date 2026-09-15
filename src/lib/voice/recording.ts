import type Telnyx from "telnyx";
import type { VoiceSession } from "./types";
import { VOICE_PROVIDER_OPTIONS } from "./provider";

export function trustedRecordingUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !(
      host.endsWith(".telnyx.com") ||
      host.endsWith(".amazonaws.com") ||
      host === "api.telnyx.com"
    )
  )
    throw new Error("untrusted_recording_host");
  return url;
}

export async function proxyVoiceRecording(
  telnyx: Telnyx,
  recordingId: string,
  session: Pick<VoiceSession, "call_control_id" | "call_session_id">,
  range: string | null,
): Promise<Response> {
  const recording = (
    await telnyx.recordings.retrieve(recordingId, VOICE_PROVIDER_OPTIONS)
  ).data;
  if (
    !recording ||
    recording.call_control_id !== session.call_control_id ||
    recording.call_session_id !== session.call_session_id
  )
    return new Response("Not found", { status: 404 });
  const rawUrl = recording.download_urls?.mp3;
  if (!rawUrl) return new Response("Recording unavailable", { status: 404 });
  const url = trustedRecordingUrl(rawUrl);
  if (range && !/^bytes=\d*-\d*$/.test(range))
    return new Response("Invalid range", { status: 416 });
  const upstream = await fetch(url, {
    headers: range ? { Range: range } : {},
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!upstream.ok && upstream.status !== 206)
    return new Response("Recording unavailable", { status: 502 });
  const headers = new Headers({
    "Content-Type": "audio/mpeg",
    "Cache-Control": "private, no-store, max-age=0",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
    Vary: "Cookie, Range",
  });
  for (const header of ["content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(header);
    if (value) headers.set(header, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
