import { listServiceAgreements } from "@/lib/agreements/service.server";
import { ServiceAgreementHistory } from "./ServiceAgreementHistory";
import { card } from "@/lib/theme-v2/theme";

export async function AdminServiceAgreementCard({ businessId }: { businessId: string }) {
  try {
    const records = await listServiceAgreements(businessId);
    return <section className={`p-6 ${card}`}><h2 className="text-lg font-semibold">Service agreement</h2>
      <ServiceAgreementHistory records={records} adminBusinessId={businessId} />
    </section>;
  } catch {
    return <section className={`p-6 ${card}`}><h2 className="text-lg font-semibold">Service agreement</h2>
      <p className="mt-3 text-sm" role="status">Agreement history is temporarily unavailable. Refresh to try again.</p>
    </section>;
  }
}
