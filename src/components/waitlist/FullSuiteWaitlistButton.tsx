"use client";
import { FULL_SUITE_PACKAGE_SUMMARY } from "@/lib/billing/fullSuitePresentation";

import {
  type FormEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, X } from "lucide-react";
import { primaryCtaInlineClass } from "@/lib/glass";

type SubmissionStatus = "idle" | "submitting" | "success";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WIDGET_HIDDEN_BODY_CLASS = "sa-full-suite-waitlist-open";

interface FullSuiteWaitlistButtonProps {
  className?: string;
  label?: string;
}

export function FullSuiteWaitlistButton({
  className = primaryCtaInlineClass,
  label = "Notify Me When It Launches",
}: FullSuiteWaitlistButtonProps) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<SubmissionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const successRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();

  const closeDialog = useCallback(() => {
    setOpen(false);
  }, []);

  function openDialog(event: MouseEvent<HTMLButtonElement>) {
    openerRef.current = event.currentTarget;
    setEmail("");
    setError(null);
    setStatus("idle");
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;

    const body = document.body;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    body.classList.add(WIDGET_HIDDEN_BODY_CLASS);

    const focusFrame = window.requestAnimationFrame(() => {
      emailRef.current?.focus();
    });

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDialog();
        return;
      }

      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((element) => element.getClientRects().length > 0);

      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      body.style.overflow = previousOverflow;
      body.classList.remove(WIDGET_HIDDEN_BODY_CLASS);
      openerRef.current?.focus();
    };
  }, [closeDialog, open]);

  useEffect(() => {
    if (open && status === "success") {
      successRef.current?.focus();
    }
  }, [open, status]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();
    const website = String(
      new FormData(event.currentTarget).get("website") ?? ""
    );

    if (
      normalizedEmail.length < 3 ||
      normalizedEmail.length > 320 ||
      !EMAIL_PATTERN.test(normalizedEmail)
    ) {
      setError("Enter a valid email address.");
      return;
    }

    setError(null);
    setStatus("submitting");

    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: normalizedEmail, website }),
      });

      if (!response.ok) {
        throw new Error("Waitlist request failed");
      }

      setStatus("success");
    } catch {
      setStatus("idle");
      setError("Something went wrong. Please try again.");
    }
  }

  const dialog = open
    ? createPortal(
        <div
          className="fixed inset-0 z-[2147483647] flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDialog();
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            tabIndex={-1}
            className="relative max-h-[90vh] w-full max-w-md overflow-y-auto rounded-[28px] border border-[#ece4d8] bg-white p-6 shadow-[0_24px_70px_-18px_rgba(28,25,23,0.45)] outline-none dark:border-white/[0.14] dark:bg-[#121214] dark:shadow-[0_30px_80px_rgba(0,0,0,0.75)] sm:p-7"
          >
            <button
              type="button"
              onClick={closeDialog}
              className="absolute right-4 top-4 inline-flex h-10 w-10 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#ea580c]/60 dark:text-[#bdbdbf] dark:hover:bg-white/[0.08] dark:hover:text-white dark:focus-visible:ring-[#ff914d]/60"
              aria-label="Close waitlist dialog"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>

            {status === "success" ? (
              <div className="px-1 py-8 text-center" aria-live="polite">
                <span className="mx-auto mb-5 inline-flex h-14 w-14 items-center justify-center rounded-full border border-[#f5dcc4] bg-[#fdf1e7] text-[#c2410c] dark:border-[#ff914d]/30 dark:bg-[#ff914d]/10 dark:text-[#ff914d]">
                  <CheckCircle2 className="h-7 w-7" aria-hidden="true" />
                </span>
                <h2
                  ref={successRef}
                  id={titleId}
                  tabIndex={-1}
                  className="text-2xl font-bold tracking-[-0.02em] text-stone-900 outline-none dark:text-[#f5f5f5]"
                >
                  You&apos;re on the list!
                </h2>
                <p
                  id={descriptionId}
                  className="mt-3 text-sm leading-6 text-stone-600 dark:text-[#bdbdbf]"
                >
                  We&apos;ll email you when Full Suite launches.
                </p>
                <button
                  type="button"
                  onClick={closeDialog}
                  className={`${primaryCtaInlineClass} mt-7`}
                >
                  Done
                </button>
              </div>
            ) : (
              <>
                <div className="pr-10">
                  <span className="mb-4 inline-flex rounded-full border border-[#f5dcc4] bg-[#fdf1e7] px-3 py-1 text-xs font-extrabold uppercase tracking-[0.08em] text-[#c2410c] dark:border-[#ff914d]/30 dark:bg-[#ff914d]/10 dark:text-[#ffd7bf]">
                    Coming Soon
                  </span>
                  <h2
                    id={titleId}
                    className="text-2xl font-bold tracking-[-0.025em] text-stone-900 dark:text-[#f5f5f5]"
                  >
                    Get notified when Full Suite launches
                  </h2>
                  <p
                    id={descriptionId}
                    className="mt-3 text-sm leading-6 text-stone-600 dark:text-[#bdbdbf]"
                  >
                    {FULL_SUITE_PACKAGE_SUMMARY}
                  </p>
                </div>

                <form className="mt-6" onSubmit={handleSubmit} noValidate>
                  <label
                    htmlFor={`${titleId}-email`}
                    className="mb-2 block text-sm font-medium text-stone-700 dark:text-[#d4d4d8]"
                  >
                    Email address
                  </label>
                  <input
                    ref={emailRef}
                    id={`${titleId}-email`}
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    required
                    maxLength={320}
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? errorId : undefined}
                    className="w-full rounded-2xl border border-[#e3dacc] bg-white px-4 py-3 text-base text-stone-900 outline-none transition-[border-color,box-shadow] placeholder:text-stone-400 focus:border-[#ea580c] focus:ring-2 focus:ring-[#ea580c]/25 dark:border-white/[0.12] dark:bg-white/[0.06] dark:text-[#f5f5f5] dark:placeholder:text-[#666] dark:focus:border-[#ff914d] dark:focus:ring-[#ff914d]/30"
                    placeholder="you@example.com"
                  />

                  <div
                    aria-hidden="true"
                    className="absolute -left-[10000px] top-auto h-px w-px overflow-hidden"
                  >
                    <label htmlFor={`${titleId}-website`}>Website</label>
                    <input
                      id={`${titleId}-website`}
                      name="website"
                      type="text"
                      tabIndex={-1}
                      autoComplete="off"
                    />
                  </div>

                  <div className="mt-2 min-h-5" aria-live="polite">
                    {error && (
                      <p id={errorId} className="text-sm text-red-700 dark:text-red-300">
                        {error}
                      </p>
                    )}
                  </div>

                  <button
                    type="submit"
                    disabled={status === "submitting"}
                    className="mt-3 inline-flex w-full items-center justify-center rounded-full bg-[#ea580c] px-6 py-3.5 text-sm font-bold text-white transition-colors hover:bg-[#c2410c] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#ea580c]/60 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-[#ff914d] dark:text-[#16100b] dark:hover:bg-[#f57f33] dark:focus-visible:ring-[#ff914d]/60 dark:focus-visible:ring-offset-[#121214]"
                  >
                    {status === "submitting" ? "Joining…" : "Join the Waitlist"}
                  </button>

                  <p className="mt-4 text-center text-xs leading-5 text-stone-500 dark:text-[#929292]">
                    We&apos;ll only email you about Full Suite updates.
                    Unsubscribe anytime.
                  </p>
                </form>
              </>
            )}
          </div>
        </div>,
        document.body
      )
    : null;

  return (
    <>
      <button type="button" onClick={openDialog} className={className}>
        {label}
      </button>
      {dialog}
      <style jsx global>{`
        body.sa-full-suite-waitlist-open .sa-widget-container {
          display: none !important;
        }
      `}</style>
    </>
  );
}
