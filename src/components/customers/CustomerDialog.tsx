"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { body, ink } from "@/lib/theme-v2/theme";

export default function CustomerDialog({
  title,
  description,
  children,
  onClose,
  busy = false,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={headingId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      className={`m-auto max-h-[90dvh] w-[calc(100%-2rem)] overflow-y-auto rounded-[28px] border border-[#ece4d8] bg-white p-0 shadow-2xl backdrop:bg-black/40 dark:border-white/10 dark:bg-[#141416] dark:backdrop:bg-black/65 ${wide ? "max-w-4xl" : "max-w-2xl"}`}
    >
      <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-[#ece4d8] bg-white px-5 py-5 dark:border-white/10 dark:bg-[#141416] sm:px-7">
        <div>
          <h2 id={headingId} className={`text-lg font-semibold ${ink}`}>
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className={`mt-1 text-sm ${body}`}>
              {description}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          disabled={busy}
          aria-label="Close dialog"
          onClick={onClose}
          className={`rounded-full p-2 hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 disabled:opacity-40 dark:hover:bg-white/10 ${body}`}
        >
          <X className="h-5 w-5" />
        </button>
      </header>
      <div className="p-5 sm:p-7">{children}</div>
    </dialog>
  );
}
