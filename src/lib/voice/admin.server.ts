import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { PILOT_BUSINESS_ID } from "./types";
import { pilotRoutingDependencies } from "./routing.server";

export async function loadVoicePilotDashboard(page = 0) {
  const results = await Promise.all([
    supabaseAdmin
      .from("voice_pilot_settings")
      .select("*")
      .eq("business_id", PILOT_BUSINESS_ID)
      .maybeSingle(),
    supabaseAdmin
      .from("voice_pilot_totals")
      .select("*")
      .eq("business_id", PILOT_BUSINESS_ID)
      .maybeSingle(),
    supabaseAdmin
      .from("voice_pilot_testers")
      .select("phone_number,label")
      .eq("business_id", PILOT_BUSINESS_ID)
      .order("created_at"),
    supabaseAdmin
      .from("voice_sessions")
      .select(
        "id,caller_phone,response_mode,status,outcome,used_seconds,reserved_seconds,usage_confirmed,created_at,ended_at,error_code,first_audio_at,playback_acknowledged_at,feedback",
        { count: "exact" },
      )
      .eq("business_id", PILOT_BUSINESS_ID)
      .eq("response_mode", "voice")
      .order("created_at", { ascending: false })
      .range(page * 25, page * 25 + 24),
  ]);
  if (results.some((r) => r.error))
    throw new Error("voice_dashboard_unavailable");
  const [settings, totals, testers, calls] = results;
  return {
    settings: settings.data,
    totals: totals.data,
    testers: testers.data ?? [],
    calls: calls.data ?? [],
    count: calls.count ?? 0,
    workerReady: await pilotRoutingDependencies().workerReady(),
    rolloutReady: process.env.VOICE_PILOT_ROLLOUT === "true",
  };
}

export async function loadVoiceCallDetails(id: string) {
  const { data: session, error } = await supabaseAdmin
    .from("voice_sessions")
    .select("*")
    .eq("id", id)
    .eq("business_id", PILOT_BUSINESS_ID)
    .maybeSingle();
  if (error) throw new Error("voice_call_lookup_failed");
  if (!session) return null;
  const [usage, recordings] = await Promise.all([
    supabaseAdmin
      .from("voice_provider_usage")
      .select(
        "provider,request_id,provider_request_id,model,status,seconds,input_tokens,output_tokens,estimated_cost_usd,latency_ms,created_at",
      )
      .eq("session_id", id)
      .order("created_at"),
    supabaseAdmin
      .from("voice_recordings")
      .select("recording_id,delete_after,deleted_at,last_error_code")
      .eq("session_id", id),
  ]);
  if (usage.error || recordings.error)
    throw new Error("voice_call_details_unavailable");
  const fragments: {
    event_id: string;
    role: string;
    content: string;
    start_ms: number;
    end_ms: number;
    received_at: string;
  }[] = [];
  for (let start = 0; start < 5000; start += 500) {
    const { data, error: fragmentError } = await supabaseAdmin
      .from("voice_transcript_fragments")
      .select("event_id,role,content,start_ms,end_ms,received_at")
      .eq("session_id", id)
      .order("start_ms")
      .order("event_id")
      .range(start, start + 499);
    if (fragmentError) throw new Error("voice_transcript_unavailable");
    fragments.push(...(data ?? []));
    if (!data || data.length < 500) break;
  }
  return {
    session,
    usage: usage.data ?? [],
    recordings: recordings.data ?? [],
    fragments,
  };
}
