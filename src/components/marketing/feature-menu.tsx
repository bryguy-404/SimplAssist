"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";
import { navLink } from "@/lib/theme-v2/theme";

export function FeatureMenu() {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) {
        ref.current?.removeAttribute("open");
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && ref.current?.open) {
        ref.current.removeAttribute("open");
        ref.current.querySelector("summary")?.focus();
      }
    }
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return (
    <details ref={ref} className="group relative">
      <summary className={`${navLink} flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-lg px-1 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-600 [&::-webkit-details-marker]:hidden`}>
        Features <ChevronDown aria-hidden="true" className="h-4 w-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="absolute -left-24 top-full mt-3 w-64 rounded-2xl border border-stone-200 bg-[#faf8f4] p-2 shadow-xl dark:border-white/15 dark:bg-[#171719] sm:left-0">
        {[
          { href: "/#missed-call-text-back", label: "Missed-call text back", detail: "Keep missed callers in the conversation" },
          { href: "/ai-chatbot-for-small-business", label: "Website chat", detail: "Answer questions and book appointments" },
          { href: "/ai-receptionist-for-small-business", label: "SimplAssist Voice", detail: "Have a real conversation with callers" },
        ].map(({ href, label, detail }) => (
          <Link key={href} href={href} onClick={() => ref.current?.removeAttribute("open")} className="block rounded-xl px-4 py-3 hover:bg-stone-200/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-600 dark:hover:bg-white/10">
            <span className="block text-sm font-bold text-stone-900 dark:text-white">{label}</span>
            <span className="mt-1 block text-xs leading-5 text-stone-600 dark:text-stone-300">{detail}</span>
          </Link>
        ))}
        <Link href="/#pricing" onClick={() => ref.current?.removeAttribute("open")} className="block rounded-xl px-4 py-3 text-sm font-semibold text-stone-700 hover:bg-stone-200/60 dark:text-stone-200 dark:hover:bg-white/10">Compare all plans</Link>
      </div>
    </details>
  );
}
