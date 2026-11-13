import type { ServiceAgreementSummary } from "@/lib/agreements/shared";

export function ServiceAgreementHistory({ records, adminBusinessId }: { records: ServiceAgreementSummary[]; adminBusinessId?: string }) {
  if (!records.length) return <p className="mt-3 text-sm text-stone-500">No saved service agreement yet. Earlier SMS acknowledgments are separate from this record.</p>;
  return <ul className="mt-4 divide-y divide-stone-200 dark:divide-white/10">
    {records.map((record) => {
      const url = adminBusinessId
        ? `/api/admin/businesses/${encodeURIComponent(adminBusinessId)}/service-agreements/${record.id}`
        : `/api/service-agreements/${record.id}`;
      return <li key={record.id} className="py-4 first:pt-0">
        <p className="font-medium">{new Date(record.accepted_at).toLocaleString("en-US", { timeZone: "UTC" })} UTC</p>
        <p className="mt-1 break-words text-sm text-stone-500">{record.subscriber_email} · Terms {record.terms_version}</p>
        <div className="mt-2 flex flex-wrap gap-4 text-sm">
          <a href={url} target="_blank" rel="noopener noreferrer" className="underline">View agreement</a>
          <a href={`${url}?download=1`} className="underline">Download agreement</a>
        </div>
      </li>;
    })}
  </ul>;
}
