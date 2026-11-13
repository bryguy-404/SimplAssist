import Link from "next/link";
import { requireWorkspacePageAccess } from "@/lib/customer/workspaceRouteResponse.server";
import { ServiceAgreementSettings } from "@/components/agreements/ServiceAgreementSettings";
import { PRIVATE_ROUTE_METADATA } from "@/lib/seo/privateMetadata";
import { card, pageShell } from "@/lib/theme-v2/theme";

export const metadata = PRIVATE_ROUTE_METADATA;
export default async function ServiceAgreementsPage() {
  await requireWorkspacePageAccess();
  // Intentionally outside the paid-dashboard layout. No renewal is necessary
  // to retrieve records after cancellation or during unfinished onboarding.
  return <main className={`${pageShell} px-4 py-10`}>
    <div className={`mx-auto max-w-3xl p-6 sm:p-10 ${card}`}>
      <Link href="/billing" className="text-sm underline">Back to Billing</Link>
      <h1 className="mt-5 text-2xl font-bold">Service agreement</h1>
      <ServiceAgreementSettings />
    </div>
  </main>;
}
