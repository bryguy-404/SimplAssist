import Link from "next/link";
import { SERVICE_AGREEMENTS_PATH } from "@/lib/agreements/shared";
import { card } from "@/lib/theme-v2/theme";

export function ServiceAgreementLink() {
  return <section className={`mt-6 p-6 ${card}`} aria-labelledby="service-agreement-heading">
    <h2 id="service-agreement-heading" className="text-lg font-semibold">Service agreement</h2>
    <p className="mt-2 text-sm text-stone-500">Keep a copy of your accepted Terms and agreement history.</p>
    <Link href={SERVICE_AGREEMENTS_PATH} className="mt-3 inline-block text-sm underline">View or download agreement</Link>
  </section>;
}
