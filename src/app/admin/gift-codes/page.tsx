import { requireAdminUser } from "@/lib/admin/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  body,
  bodyFaint,
  card,
  ink,
  statusDanger,
  statusNeutral,
  statusSuccess,
  statusWarning,
} from "@/lib/theme-v2/theme";
import { AdminBackLink } from "../AdminBackLink";
import { GiftCodeSender } from "./GiftCodeSender";

export const dynamic = "force-dynamic";

type GiftCodeSendRow = {
  id: string;
  created_at: string;
  recipient_email: string;
  recipient_first_name: string | null;
  code: string;
  offer_summary: string;
  sent_by_email: string | null;
  status: "pending" | "sent" | "failed";
  sent_at: string | null;
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

const STATUS_LABEL: Record<GiftCodeSendRow["status"], string> = {
  sent: "Sent",
  failed: "Not sent",
  pending: "Unconfirmed",
};

const STATUS_STYLE: Record<GiftCodeSendRow["status"], string> = {
  sent: statusSuccess,
  failed: statusDanger,
  pending: statusWarning,
};

export default async function AdminGiftCodesPage() {
  // Every admin page authorizes itself: soft navigations skip the layout.
  await requireAdminUser();

  let rows: GiftCodeSendRow[] = [];
  let logAvailable = true;
  try {
    const result = await supabaseAdmin
      .from("gift_code_sends")
      .select(
        "id, created_at, recipient_email, recipient_first_name, code, offer_summary, sent_by_email, status, sent_at",
      )
      .order("created_at", { ascending: false })
      .limit(100)
      .returns<GiftCodeSendRow[]>();
    if (result.error) logAvailable = false;
    else rows = result.data ?? [];
  } catch {
    logAvailable = false;
  }

  return (
    <main className="space-y-6">
      <AdminBackLink />

      <section>
        <h1 className={`text-2xl font-bold ${ink}`}>Gift codes</h1>
        <p className={`mt-1 max-w-2xl text-sm ${bodyFaint}`}>
          Email someone a Stripe promotion code. They get the code in a big
          box, plus a button to a page where they can copy it and sign up with
          it already applied. Create the code in Stripe first, then enter it here.
        </p>
      </section>

      <section className={`p-5 sm:p-6 ${card}`}>
        <GiftCodeSender />
      </section>

      <section className={`overflow-hidden ${card}`}>
        <div className="border-b border-[#ece4d8] px-5 py-4 dark:border-white/[0.10]">
          <h2 className={`font-semibold ${ink}`}>Sent so far</h2>
          <p className={`mt-1 text-xs ${bodyFaint}`}>Newest first · last 100</p>
        </div>

        {!logAvailable ? (
          <p className={`m-5 rounded-2xl px-4 py-3 text-sm ${statusWarning}`}>
            The send log could not be loaded. If this is the first use, the
            gift_code_sends migration still needs to be run in Supabase.
            Sending is switched off until the log works.
          </p>
        ) : rows.length === 0 ? (
          <p className={`px-5 py-8 text-sm ${body}`}>No gift codes sent yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="bg-[#faf7f2] text-xs uppercase tracking-wide text-stone-500 dark:bg-white/[0.04] dark:text-[#bdbdbf]">
                <tr>
                  <th className="px-5 py-3 font-medium">Sent to</th>
                  <th className="px-5 py-3 font-medium">Code</th>
                  <th className="px-5 py-3 font-medium">Gives</th>
                  <th className="px-5 py-3 font-medium">When</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Sent by</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-t border-[#f0e9de] align-top first:border-t-0 dark:border-white/[0.08]"
                  >
                    <td className={`px-5 py-4 font-medium ${ink}`}>
                      <span className="select-all">{row.recipient_email}</span>
                      {row.recipient_first_name ? (
                        <span className={`block text-xs font-normal ${bodyFaint}`}>
                          {row.recipient_first_name}
                        </span>
                      ) : null}
                    </td>
                    <td className={`px-5 py-4 font-mono ${ink}`}>
                      <span className="select-all">{row.code}</span>
                    </td>
                    <td className={`px-5 py-4 ${body}`}>{row.offer_summary}</td>
                    <td className={`whitespace-nowrap px-5 py-4 ${body}`}>
                      {formatDate(row.sent_at ?? row.created_at)}
                    </td>
                    <td className="px-5 py-4">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
                          STATUS_STYLE[row.status] ?? statusNeutral
                        }`}
                      >
                        {STATUS_LABEL[row.status] ?? row.status}
                      </span>
                    </td>
                    <td className={`px-5 py-4 text-xs ${bodyFaint}`}>
                      {row.sent_by_email ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
