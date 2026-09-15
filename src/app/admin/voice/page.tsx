import Link from "next/link";
import { requireAdminUser } from "@/lib/admin/auth";
import { loadVoicePilotDashboard } from "@/lib/voice/admin.server";
import { VoicePilotControls } from "./VoicePilotControls";

export const dynamic = "force-dynamic";
export default async function VoicePilotPage({
  searchParams,
}: {
  searchParams?: { page?: string };
}) {
  await requireAdminUser();
  const page = Math.max(
    0,
    Math.min(10000, Number.parseInt(searchParams?.page || "0", 10) || 0),
  );
  let dashboard;
  try {
    dashboard = await loadVoicePilotDashboard(page);
  } catch {
    return (
      <main>
        <h1 className="text-2xl font-semibold">Voice pilot</h1>
        <p className="mt-4">
          The voice database is not ready. Apply and verify the prepared
          migrations before configuring the pilot.
        </p>
      </main>
    );
  }
  const { settings, totals, testers, calls, count, workerReady, rolloutReady } =
    dashboard;
  if (!settings)
    return (
      <main>
        <h1 className="text-2xl font-semibold">Voice pilot</h1>
        <p className="mt-4">
          The designated SimplAssist pilot account has not been configured.
        </p>
      </main>
    );
  const remaining =
    Math.max(
      0,
      settings.budget_seconds - Number(totals?.committed_seconds || 0),
    ) / 60;
  return (
    <main className="mx-auto max-w-6xl space-y-8">
      <header>
        <p className="text-sm font-semibold text-orange-600">INTERNAL TEST</p>
        <h1 className="mt-2 text-3xl font-bold">SimplAssist voice pilot</h1>
        <p className="mt-2 text-stone-500">
          (574) 263-8634 · Business questions · Marin · English
        </p>
      </header>
      <section className="grid gap-4 sm:grid-cols-4" aria-label="Pilot status">
        {[
          ["Pilot", settings.enabled ? "Enabled" : "Disabled"],
          ["Available minutes", remaining.toFixed(1)],
          ["Active calls", `${totals?.active_calls || 0} / 2`],
          ["Service", workerReady && rolloutReady ? "Ready" : "Setup needed"],
        ].map(([label, value]) => (
          <div
            key={label}
            className="rounded-xl border border-stone-200 p-5 dark:border-white/10"
          >
            <p className="text-sm text-stone-500">{label}</p>
            <p className="mt-2 text-2xl font-semibold">{value}</p>
          </div>
        ))}
      </section>
      {remaining < (settings.budget_seconds / 60) * 0.2 ? (
        <p role="status" className="rounded-lg bg-amber-50 p-4 text-amber-900">
          The pilot is approaching its minute limit. Calls that cannot reserve
          time use the existing text experience. There are no automatic
          overages.
        </p>
      ) : null}
      {Number(totals?.unconfirmed_calls) > 0 ? (
        <p className="rounded-lg bg-amber-50 p-4 text-amber-900">
          {totals?.unconfirmed_calls} call(s) need final usage reconciliation.
          Their remaining reservations stay held until usage is confirmed.
        </p>
      ) : null}
      <VoicePilotControls
        key={settings.revision}
        revision={settings.revision}
        enabled={settings.enabled}
        budgetMinutes={settings.budget_seconds / 60}
        testers={testers}
        canEnable={workerReady && rolloutReady}
      />
      <section>
        <h2 className="text-xl font-semibold">Test calls</h2>
        <p className="mt-1 text-sm text-stone-500">
          Open a call to review its transcript, recording, costs, and feedback.
          Audio expires after 30 days.
        </p>
        {calls.length === 0 ? (
          <p className="mt-6 rounded-xl border border-dashed p-8 text-center text-stone-500">
            No voice calls yet. Add approved testers and complete deployment
            checks to begin.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th className="p-3">Started</th>
                  <th>Caller</th>
                  <th>Result</th>
                  <th>Minutes</th>
                  <th>Usage</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((call) => (
                  <tr
                    key={call.id}
                    className="border-b border-stone-200 dark:border-white/10"
                  >
                    <td className="p-3">
                      <Link
                        className="font-medium underline"
                        href={`/admin/voice/${call.id}`}
                      >
                        {new Date(call.created_at).toLocaleString("en-US", {
                          timeZone: "America/Indiana/Indianapolis",
                        })}
                      </Link>
                    </td>
                    <td>{call.caller_phone || "Deleted account"}</td>
                    <td>{call.outcome || call.status}</td>
                    <td>{(Number(call.used_seconds) / 60).toFixed(2)}</td>
                    <td>{call.usage_confirmed ? "Confirmed" : "Pending"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 flex justify-between text-sm">
          {page > 0 ? (
            <Link href={`/admin/voice?page=${page - 1}`}>← Newer calls</Link>
          ) : (
            <span />
          )}
          {(page + 1) * 25 < count ? (
            <Link href={`/admin/voice?page=${page + 1}`}>Older calls →</Link>
          ) : null}
        </div>
      </section>
      <p className="text-sm text-stone-500">
        Pilot access is an internal exception for this account. Contact
        collection, booking, and top-tier customer availability come after this
        Q&A pilot passes.
      </p>
    </main>
  );
}
