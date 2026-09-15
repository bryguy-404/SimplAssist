import type { SupabaseClient } from "@supabase/supabase-js";
import type Telnyx from "telnyx";
import { VOICE_PROVIDER_OPTIONS } from "./provider";

async function batch<T>(items: T[], work: (item: T) => Promise<void>) {
  const results = await Promise.allSettled(items.map(work));
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

import {
  PILOT_BUSINESS_ID,
  RECORDING_NOTICE,
  type VoiceSession,
} from "./types";

/** Retries are driven by durable rows; process restarts cannot lose cleanup. */
export async function maintainVoicePilot(
  db: SupabaseClient,
  telnyx: Telnyx,
  fallback: (id: string) => Promise<void>,
) {
  const now = Date.now();
  const { data: stale, error: staleError } = await db
    .from("voice_sessions")
    .select("*")
    .eq("business_id", PILOT_BUSINESS_ID)
    .eq("response_mode", "voice")
    .neq("status", "closed")
    .lt("heartbeat_at", new Date(now - 45000).toISOString())
    .limit(4);
  if (staleError) throw new Error("voice_recovery_lookup_failed");
  for (const session of (stale ?? []) as VoiceSession[]) {
    // Recheck the stale predicate under the update so a recovered worker's
    // fresh heartbeat cannot be terminated from this earlier read snapshot.
    const { data: claimed, error } = await db
      .from("voice_sessions")
      .update({ status: "closing" })
      .eq("id", session.id)
      .neq("status", "closed")
      .lt("heartbeat_at", new Date(now - 45000).toISOString())
      .select("id");
    if (error) throw new Error("voice_recovery_claim_failed");
    if (!claimed?.length) continue;
    const { error: finalized } = await db.rpc("finalize_voice_session", {
      p_session_id: session.id,
      p_outcome: "worker_lost",
      p_error: "voice_heartbeat_expired",
      p_fallback: session.response_mode === "voice",
      p_no_provider_started: false,
    });
    if (finalized) throw new Error("voice_recovery_finalize_failed");
  }

  const { data: ended, error: endedError } = await db
    .from("voice_sessions")
    .select("*")
    .eq("business_id", PILOT_BUSINESS_ID)
    .eq("response_mode", "voice")
    .eq("status", "closed")
    .is("provider_hangup_confirmed_at", null)
    .limit(4);
  if (endedError) throw new Error("voice_hangup_recovery_lookup_failed");
  await batch(ended ?? [], async (session) => {
    try {
      await telnyx.calls.actions.hangup(
        session.call_control_id,
        {
          command_id: `voice-end-${session.id}`,
        },
        VOICE_PROVIDER_OPTIONS,
      );
    } catch (error) {
      const code = (error as { status?: number }).status;
      if (code !== 404 && code !== 422) return;
    }
    const { error } = await db
      .from("voice_sessions")
      .update({ provider_hangup_confirmed_at: new Date().toISOString() })
      .eq("id", session.id);
    if (error) throw new Error("voice_hangup_recovery_save_failed");
  });

  // Recording callbacks can be lost. Reconcile by the provider's exact call
  // identity, then retain the discovered recording only until the same expiry.
  const { data: unchecked, error: uncheckedError } = await db
    .from("voice_sessions")
    .select("*")
    .eq("business_id", PILOT_BUSINESS_ID)
    .eq("response_mode", "voice")
    .eq("status", "closed")
    .or(
      `and(notice_completed_at.not.is.null,or(recording_checked_at.is.null,recording_checked_at.lt.${new Date(now - 3600_000).toISOString()})),and(prior_disclosure_acknowledged_at.not.is.null,or(recording_checked_at.is.null,recording_checked_at.lt.${new Date(now - 3600_000).toISOString()}))`,
    )
    .lt("ended_at", new Date(now - 30000).toISOString())
    .limit(4);
  if (uncheckedError)
    throw new Error("voice_recording_reconciliation_lookup_failed");
  await batch(unchecked ?? [], async (session) => {
    try {
      const page = await telnyx.recordings.list(
        {
          filter: { call_control_id: session.call_control_id },
          "page[size]": 20,
        },
        VOICE_PROVIDER_OPTIONS,
      );
      for (const recording of page.data) {
        if (
          !recording.id ||
          recording.call_control_id !== session.call_control_id ||
          recording.call_session_id !== session.call_session_id
        )
          continue;
        const { error } = await db.from("voice_recordings").upsert(
          {
            recording_id: recording.id,
            session_id: session.id,
            business_id: session.business_id,
            delete_after: new Date(
              Date.parse(session.created_at) + 30 * 86400_000,
            ).toISOString(),
          },
          { onConflict: "recording_id", ignoreDuplicates: true },
        );
        if (error)
          throw new Error("voice_recording_reconciliation_save_failed");
      }
      await db
        .from("voice_sessions")
        .update({ recording_checked_at: new Date().toISOString() })
        .eq("id", session.id);
    } catch {
      /* The durable unchecked/old timestamp retries on the next sweep. */
    }
  });

  const { data: due, error: claimError } = await db.rpc(
    "claim_voice_recording_cleanup",
    { p_limit: 4 },
  );
  if (claimError) throw new Error("voice_audio_cleanup_claim_failed");
  await batch(
    due ?? [],
    async (recording: { recording_id: string; lease_token: string }) => {
      let success = false;
      try {
        await telnyx.recordings.delete(
          recording.recording_id,
          VOICE_PROVIDER_OPTIONS,
        );
        success = true;
      } catch (error) {
        success = (error as { status?: number }).status === 404;
      }
      const { error } = await db.rpc("finish_voice_recording_cleanup", {
        p_recording_id: recording.recording_id,
        p_lease: recording.lease_token,
        p_success: success,
        p_error: success ? null : "telnyx_delete_failed",
      });
      if (error) throw new Error("voice_audio_cleanup_finalize_failed");
    },
  );
  const { error: reconcileError } = await db.rpc(
    "reconcile_unstarted_voice_sessions",
  );
  if (reconcileError)
    throw new Error("voice_unused_reservation_reconciliation_failed");
  const { error: estimateError } = await db.rpc("estimate_voice_telnyx_usage", {
    p_notice_characters: RECORDING_NOTICE.length,
  });
  if (estimateError) throw new Error("voice_cost_estimate_failed");
  const { data: pending, error: pendingError } = await db
    .from("voice_sessions")
    .select("id")
    .eq("business_id", PILOT_BUSINESS_ID)
    .eq("fallback_pending", true)
    .limit(4);
  if (pendingError) throw new Error("voice_fallback_recovery_lookup_failed");
  await batch(pending ?? [], (session) => fallback(session.id));
}
