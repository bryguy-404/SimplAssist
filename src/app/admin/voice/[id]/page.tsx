import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminUser } from "@/lib/admin/auth";
import { loadVoiceCallDetails } from "@/lib/voice/admin.server";
import { VoiceCallFeedback } from "../VoicePilotControls";

export const dynamic = "force-dynamic";
export default async function VoiceCallPage({
  params,
}: {
  params: { id: string };
}) {
  await requireAdminUser();
  const details = await loadVoiceCallDetails(params.id);
  if (!details) notFound();
  const { session, usage, recordings, fragments, actions } = details;
  const cost = usage.reduce(
    (sum, row) => sum + Number(row.estimated_cost_usd || 0),
    0,
  );
  const backend = usage.filter((row) => row.provider === "anthropic");
  const latency = backend.filter((row) => row.latency_ms !== null);
  return (
    <main className="mx-auto max-w-5xl space-y-7">
      <header>
        <Link href="/admin/voice" className="text-sm underline">
          ← Voice pilot
        </Link>
        <h1 className="mt-4 text-3xl font-bold">Test call</h1>
        <p className="mt-2 text-stone-500">
          {session.caller_phone || "Deleted account"} ·{" "}
          {new Date(session.created_at).toLocaleString("en-US", {
            timeZone: "America/Indiana/Indianapolis",
          })}
        </p>
      </header>
      <section className="grid gap-4 sm:grid-cols-3">
        {[
          ["Result", session.outcome || session.status],
          ["AI voice minutes", (Number(session.used_seconds) / 60).toFixed(2)],
          ["Estimated provider cost", `$${cost.toFixed(4)}`],
        ].map(([label, value]) => (
          <div className="rounded-xl border p-4" key={label}>
            <p className="text-sm text-stone-500">{label}</p>
            <p className="mt-2 text-xl font-semibold">{value}</p>
          </div>
        ))}
      </section>
      <p className="text-sm text-stone-500">
        Usage {session.usage_confirmed ? "confirmed" : "unconfirmed"}. Cost is
        an estimate of received usage, excludes hosting, number rental and
        taxes, and can be incomplete when provider usage is missing. Audio
        output {session.first_audio_at ? "was sent" : "was not observed"}; phone
        playback{" "}
        {session.playback_acknowledged_at
          ? "was acknowledged"
          : "has no acknowledgment"}
        .
      </p>
      {session.error_code ? (
        <p role="status" className="rounded-lg bg-amber-50 p-4 text-amber-900">
          Call issue: {session.error_code}
        </p>
      ) : null}
      <section>
        <h2 className="text-xl font-semibold">Recording</h2>
        <p className="mt-2 text-sm text-stone-500">
          {session.prior_disclosure_acknowledged_at
            ? "This private tester previously acknowledged AI use, audio recording and transcript storage. The call opened directly with the live assistant."
            : session.notice_completed_at
              ? "The AI and recording notice played before recording began."
              : "No completed notice or prior tester acknowledgment is recorded for this call."}
        </p>
        {recordings.length === 0 ? (
          <p className="mt-3 text-sm text-stone-500">
            Recording is not yet available. Provider callbacks and recovery
            checks update this automatically.
          </p>
        ) : (
          recordings.map((recording) => (
            <div className="mt-3" key={recording.recording_id}>
              {recording.deleted_at ||
              Date.parse(recording.delete_after) <= Date.now() ? (
                <p className="text-sm text-stone-500">
                  Audio expired under the 30-day retention policy.
                </p>
              ) : (
                <>
                  <audio
                    controls
                    preload="none"
                    className="w-full"
                    src={`/api/voice/recordings/${encodeURIComponent(recording.recording_id)}`}
                  />
                  <p className="mt-2 text-xs text-stone-500">
                    Audio expires{" "}
                    {new Date(recording.delete_after).toLocaleDateString()}.
                  </p>
                </>
              )}
            </div>
          ))
        )}
      </section>
      <section>
        <h2 className="text-xl font-semibold">Actions and confirmed details</h2>
        <p className="mt-2 text-sm text-stone-500">
          A sent link is not a completed signup. Pending and uncertain actions
          must be reviewed before attempting them again.
        </p>
        {actions.length === 0 ? (
          <p className="mt-3 text-sm">No actions recorded for this call.</p>
        ) : (
          actions.map((action) => (
            <article key={action.id} className="mt-3 rounded-lg border p-4">
              <h3 className="font-semibold">
                {action.kind.replaceAll("_", " ")} ·{" "}
                {action.status.replaceAll("_", " ")}
              </h3>
              <dl className="mt-2 space-y-1 text-sm">
                {Object.entries(action.payload as Record<string, unknown>)
                  .filter(([key]) => key !== "kind")
                  .map(([key, value]) => (
                    <div key={key}>
                      <dt className="inline font-medium">{key}: </dt>
                      <dd className="inline break-all">{String(value)}</dd>
                    </div>
                  ))}
              </dl>
              {action.result?.summary && (
                <p className="mt-2 text-sm">{String(action.result.summary)}</p>
              )}
              {action.result?.deliveryStatus && (
                <p className="mt-2 text-sm">
                  Text delivery: {String(action.result.deliveryStatus)}
                </p>
              )}
              {Array.isArray(action.result?.conflicts) &&
                action.result.conflicts.length > 0 && (
                  <p className="mt-2 text-sm text-amber-700">
                    Contact review needed: existing{" "}
                    {action.result.conflicts.join(", ")} retained. Confirmed
                    call details are shown above.
                  </p>
                )}
              {action.error_code && (
                <p className="mt-2 text-sm text-amber-700">
                  Needs review: {action.error_code}
                </p>
              )}
              <p className="mt-2 text-xs text-stone-500">
                {action.confirmed_at
                  ? `Confirmed ${new Date(action.confirmed_at).toLocaleString()}`
                  : "No confirmed submission"}{" "}
                · updated {new Date(action.updated_at).toLocaleString()}
              </p>
            </article>
          ))
        )}
      </section>
      <section>
        <h2 className="text-xl font-semibold">Transcript</h2>
        <p className="mt-1 text-sm text-stone-500">
          These timestamped fragments are read-only. Assistant text does not
          prove the caller heard every word; use the recording to judge playback
          and interruptions.
        </p>
        <div className="mt-4 max-h-[36rem] space-y-3 overflow-y-auto rounded-xl border p-4">
          {fragments.length === 0 ? (
            <p className="text-sm text-stone-500">
              No transcript fragments received.
            </p>
          ) : (
            fragments.map((fragment) => (
              <div
                key={fragment.event_id}
                className={
                  fragment.role === "customer"
                    ? "rounded-lg bg-stone-100 p-3 dark:bg-white/5"
                    : "rounded-lg p-3"
                }
              >
                <p className="text-xs font-semibold text-stone-500">
                  {fragment.role === "customer" ? "Caller" : "AI voice"} ·{" "}
                  {(fragment.start_ms / 1000).toFixed(1)}–
                  {(fragment.end_ms / 1000).toFixed(1)}s
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm">
                  {fragment.content}
                </p>
              </div>
            ))
          )}
        </div>
      </section>
      <section>
        <h2 className="text-xl font-semibold">Provider usage</h2>
        <p className="mt-1 text-sm text-stone-500">
          {backend.length} answering requests
          {latency.length
            ? ` · average backend wait ${(latency.reduce((sum, row) => sum + Number(row.latency_ms), 0) / latency.length / 1000).toFixed(2)}s`
            : ""}
          . Backend time is separate from the caller’s experienced playback
          delay.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="p-2">Provider</th>
                <th>Status</th>
                <th>Seconds / tokens in + out</th>
                <th>Estimate</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((row) => (
                <tr
                  className="border-b"
                  key={`${row.provider}-${row.request_id}`}
                >
                  <td className="p-2">{row.provider}</td>
                  <td>{row.status}</td>
                  <td>
                    {row.provider === "anthropic"
                      ? `${row.input_tokens} + ${row.output_tokens}`
                      : Number(row.seconds).toFixed(1)}
                  </td>
                  <td>
                    {row.estimated_cost_usd === null
                      ? "Unknown"
                      : `$${Number(row.estimated_cost_usd).toFixed(4)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <VoiceCallFeedback
        sessionId={session.id}
        feedback={session.feedback}
        needsReconciliation={
          session.status === "closed" && !session.usage_confirmed
        }
        usedSeconds={Number(session.used_seconds)}
      />
    </main>
  );
}
