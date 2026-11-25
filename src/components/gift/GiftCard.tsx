"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, Copy } from "lucide-react";
import { burstConfetti } from "@/components/marketing/consent-confetti";
import {
  describeGiftOffer,
  formatGiftExpiry,
  giftHeadline,
  type GiftOffer,
} from "@/lib/gift/code";
import { SUPPORT_EMAIL } from "@/lib/support/constants";
import {
  body,
  bodyFaint,
  btnPrimaryWide,
  btnSecondary,
  ink,
  inlineLink,
} from "@/lib/theme-v2/theme";
import styles from "./GiftCard.module.css";

/** Everything the coupon page is allowed to know about a code. */
export type GiftCardState =
  | { kind: "available"; code: string; offer: GiftOffer; expiresAt: string | null }
  | { kind: "unavailable" }
  | { kind: "error" };

type DotMood = "idle" | "happy" | "sleepy";

function prefersReducedMotion() {
  return typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The brand dot. Decoration only, so it is hidden from screen readers. */
function GiftDot({ mood }: { mood: DotMood }) {
  const dot = useRef<HTMLDivElement>(null);
  const eyes = useRef<HTMLSpanElement>(null);

  // The eyes follow the pointer a little while the dot is idle.
  useEffect(() => {
    if (eyes.current) eyes.current.style.transform = "";
    if (mood !== "idle" || prefersReducedMotion()) return;
    const look = (event: PointerEvent) => {
      const box = dot.current?.getBoundingClientRect();
      if (!box || !eyes.current) return;
      const dx = event.clientX - (box.left + box.width / 2);
      const dy = event.clientY - (box.top + box.height / 2);
      const distance = Math.hypot(dx, dy) || 1;
      const reach = Math.min(1, distance / 200) * 5;
      eyes.current.style.transform =
        `translate(${(dx / distance) * reach}px, ${(dy / distance) * reach}px)`;
    };
    window.addEventListener("pointermove", look, { passive: true });
    return () => window.removeEventListener("pointermove", look);
  }, [mood]);

  return (
    <div aria-hidden="true" className={styles.seat}>
      <div ref={dot} className={styles.dot} data-mood={mood} data-gift-dot="">
        <span ref={eyes} className={styles.eyes}><i /><i /></span>
      </div>
    </div>
  );
}

async function copyText(text: string, fallbackTarget: HTMLElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection-based copy below.
  }
  if (!fallbackTarget) return false;
  try {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(fallbackTarget);
    selection?.removeAllRanges();
    selection?.addRange(range);
    // Older browsers and locked-down webviews: the code is now selected either
    // way, so even a failed copy leaves it one keypress from the clipboard.
    return document.execCommand("copy");
  } catch {
    return false;
  }
}

export function GiftCard({
  state,
  startHref,
}: {
  state: GiftCardState;
  /** Where "start" goes: the route that remembers the code, then signup. */
  startHref: string;
}) {
  const [copied, setCopied] = useState<"no" | "yes" | "manual">("no");
  const codeText = useRef<HTMLSpanElement>(null);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (copied === "no") return;
    const timer = window.setTimeout(() => setCopied("no"), copied === "yes" ? 2600 : 6000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  if (state.kind !== "available") {
    const unavailable = state.kind === "unavailable";
    return (
      <div className="text-center" data-gift-state={state.kind}>
        <GiftDot mood="sleepy" />
        <h1 className={`mt-6 text-2xl font-bold tracking-tight ${ink}`}>
          {unavailable ? "This code isn’t available" : "We couldn’t check this code"}
        </h1>
        <p className={`mx-auto mt-3 max-w-[340px] text-sm leading-relaxed ${body}`}>
          {unavailable
            ? "It may have expired or already been used. Reply to the email it came in and we’ll sort it out."
            : "Something went wrong on our side. Please try again in a minute."}
        </p>
        <div className="mt-7 flex flex-col items-center gap-3">
          {unavailable ? (
            <Link href="/signup" className={btnSecondary}>
              Sign up without a code
            </Link>
          ) : (
            // A plain link back to this same page: a full reload, no script needed.
            <a href="" className={btnSecondary}>
              Try again
            </a>
          )}
          <a href={`mailto:${SUPPORT_EMAIL}`} className={`text-sm ${inlineLink}`}>
            Email {SUPPORT_EMAIL}
          </a>
        </div>
      </div>
    );
  }

  const { code, offer } = state;
  const expiry = formatGiftExpiry(state.expiresAt);

  async function onCopy() {
    const ok = await copyText(code, codeText.current);
    setCopied(ok ? "yes" : "manual");
    if (!ok || prefersReducedMotion()) return;
    const box = card.current
      ?.querySelector<HTMLElement>("[data-gift-dot]")
      ?.getBoundingClientRect();
    if (box) {
      burstConfetti(box.left + box.width / 2, box.top + box.height / 2, {
        pieces: 70,
        power: 0.75,
      });
    }
  }

  return (
    <div ref={card} className="text-center" data-gift-state="available">
      <GiftDot mood={copied === "yes" ? "happy" : "idle"} />

      <p className="mt-6 text-xs font-bold uppercase tracking-[0.14em] text-[var(--brand-accent)] dark:text-[var(--brand-accent-dark)]">
        A gift from SimplAssist
      </p>
      <h1 className={`mt-2 text-[26px] font-bold leading-tight tracking-tight ${ink}`}>
        {giftHeadline(offer)}
      </h1>
      <p className={`mx-auto mt-3 max-w-[360px] text-sm leading-relaxed ${body}`}>
        This code gives you {describeGiftOffer(offer)}. Tap the button below and
        it’s applied for you at checkout. Nothing to type.
      </p>

      <div
        className="
          mt-7 rounded-[22px] border-2 border-dashed px-4 py-5
          border-[var(--brand-accent-soft-border)] bg-[var(--brand-accent-soft)]
          dark:border-white/[0.18] dark:bg-white/[0.05]
        "
      >
        <p className={`text-xs font-semibold uppercase tracking-[0.12em] ${bodyFaint}`}>
          Your code
        </p>
        <p className="mt-1.5">
          <span
            ref={codeText}
            data-gift-code=""
            className={`
              inline-block max-w-full select-all break-all font-mono
              text-[28px] font-bold leading-tight tracking-[0.06em] ${ink}
            `}
          >
            {code}
          </span>
        </p>
        <button
          type="button"
          onClick={onCopy}
          className={`${btnSecondary} mt-4 gap-2 !px-5 !py-2.5`}
        >
          {copied === "yes" ? (
            <Check className="h-4 w-4 text-green-600 dark:text-green-400" aria-hidden />
          ) : (
            <Copy className="h-4 w-4" aria-hidden />
          )}
          {copied === "yes" ? "Copied" : "Copy code"}
        </button>
        <p role="status" aria-live="polite" className={`mt-2 min-h-[1.25rem] text-xs ${body}`}>
          {copied === "yes"
            ? "Copied. It’s on your clipboard."
            : copied === "manual"
              ? "The code is selected. Press Ctrl+C (or ⌘C on a Mac) to copy it."
              : ""}
        </p>
      </div>

      {expiry ? (
        <p className={`mt-3 text-xs ${bodyFaint}`}>Good until {expiry}.</p>
      ) : null}

      {/* A plain link, not next/link: the route sets a cookie and must not be prefetched. */}
      <a href={startHref} className={`${btnPrimaryWide} mt-6`} data-gift-start="">
        {offer.kind === "percent" && offer.percentOff >= 100
          ? "Start free with this code"
          : "Start with this code"}
      </a>

      <p className={`mx-auto mt-5 max-w-[360px] text-xs leading-relaxed ${body}`}>
        Prefer to type it? At checkout, choose <strong>Add promotion code</strong> and
        paste it there. Already started signing up? The button above picks up
        where you left off.
      </p>
    </div>
  );
}
