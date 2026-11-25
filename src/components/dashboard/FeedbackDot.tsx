"use client";

import { useEffect, useRef, type RefObject } from "react";
import { burstConfetti } from "@/components/marketing/consent-confetti";
import type { FeedbackRating } from "@/lib/feedback/client";

// The feedback card's mascot: the brand dot, sitting where the card's icon
// used to be. It watches the pointer, pulls a face to match the rating being
// picked, listens while a note is typed, and once feedback is sent it hops to
// the middle of the card for a short show. It is decoration only: everything
// it says is hidden from assistive technology and repeats nothing the card's
// own text does not already say.
//
// The looks and motion are the `sa-pet-*` rules in globals.css. DOT_BURST_MS
// is the top of the spinning jump in the `sa-pet-cheer` animation there.
const DOT_BURST_MS = 1020;

export type DotMood = FeedbackRating | "idle";
/** "cheer" and "bow" are the two send-offs: a party, or a quiet thank-you. */
export type DotScene = "form" | "cheer" | "bow";

function prefersReducedMotion() {
  return typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function FeedbackDot({ mood, scene, eager, listening, quip, nod, confetti }: {
  mood: DotMood;
  scene: DotScene;
  /** Leans in, for when the pointer is on the send button. */
  eager: boolean;
  /** Looks down at the note being typed. */
  listening: boolean;
  /** What the dot's speech bubble says. */
  quip: string;
  /** Change this number to make the dot nod once. */
  nod: number;
  /** Where the cheer's confetti is drawn: a canvas covering the card. */
  confetti: RefObject<HTMLCanvasElement>;
}) {
  const dot = useRef<HTMLDivElement>(null);
  const eyes = useRef<HTMLSpanElement>(null);

  // The eyes follow the pointer a little, unless the dot is busy elsewhere.
  useEffect(() => {
    if (eyes.current) eyes.current.style.transform = "";
    if (scene !== "form" || listening || prefersReducedMotion()) return;
    const look = (event: PointerEvent) => {
      const box = dot.current?.getBoundingClientRect();
      if (!box || !eyes.current) return;
      const dx = event.clientX - (box.left + box.width / 2);
      const dy = event.clientY - (box.top + box.height / 2);
      const distance = Math.hypot(dx, dy) || 1;
      const reach = Math.min(1, distance / 160) * 2.6;
      eyes.current.style.transform =
        `translate(${(dx / distance) * reach}px, ${(dy / distance) * reach}px)`;
    };
    window.addEventListener("pointermove", look, { passive: true });
    return () => window.removeEventListener("pointermove", look);
  }, [scene, listening]);

  // A small nod for each keystroke in the note.
  useEffect(() => {
    const element = dot.current;
    if (!nod || !element || typeof element.animate !== "function" || prefersReducedMotion()) return;
    element.animate([
      { transform: "none" },
      { transform: "translateY(2.5px) scale(1.05, 0.94)" },
      { transform: "none" },
    ], { duration: 190, easing: "ease-out" });
  }, [nod]);

  // The cheer ends in confetti that stays inside the card.
  useEffect(() => {
    if (scene !== "cheer" || prefersReducedMotion()) return;
    let stop = () => {};
    const timer = window.setTimeout(() => {
      const canvas = confetti.current;
      const element = dot.current;
      if (!canvas || !element) return;
      const box = element.getBoundingClientRect();
      const frame = canvas.getBoundingClientRect();
      const own = window.getComputedStyle(element).backgroundColor;
      stop = burstConfetti(
        box.left + box.width / 2 - frame.left,
        box.top + box.height / 2 - frame.top,
        { canvas, pieces: 80, power: 0.5, gravity: 0.5, colors: [own, own] },
      );
    }, DOT_BURST_MS);
    return () => { window.clearTimeout(timer); stop(); };
  }, [scene, confetti]);

  return (
    <div aria-hidden="true" className="sa-pet" data-mood={mood} data-scene={scene}
      data-eager={eager ? "" : undefined} data-listening={listening ? "" : undefined}>
      <div className="sa-pet-runner">
        <div className="sa-pet-hopper">
          <div ref={dot} className="sa-pet-dot">
            <span ref={eyes} className="sa-pet-eyes"><i /><i /></span>
          </div>
        </div>
      </div>
      {scene === "form" && quip ? <span key={quip} className="sa-pet-quip">{quip}</span> : null}
    </div>
  );
}
