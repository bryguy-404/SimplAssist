import Link from "next/link";
import { SERVICE_AGREEMENTS_PATH } from "@/lib/agreements/shared";
import { card } from "@/lib/theme-v2/theme";

export function ServiceAgreementLink() {
  return <section className={`mt-6 p-6 ${card}`} aria-labelledby="service-agreement-heading">
    <h2 id="service-agreement-heading" className="text-lg font-semibold text-stone-900 dark:text-[#f5f5f5]">Service agreement</h2>
    <p className="mt-1 text-sm text-stone-500 dark:text-[#bdbdbf]">Keep a copy of your accepted Terms and agreement history.</p>
    <Link href={SERVICE_AGREEMENTS_PATH} className="mt-3 inline-block text-sm font-medium text-stone-900 underline underline-offset-4 dark:text-[#f5f5f5]">View or download agreement</Link>
  </section>;
}
