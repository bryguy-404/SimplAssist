"use client";

import { useEffect, useRef } from "react";

/** Browser/Next hash scrolling may run before an asynchronous panel exists. */
export function useHashTarget<T extends HTMLElement>(id: string, enabled = true) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!enabled) return;
    let frame: number | undefined;
    const reveal = () => {
      if (window.location.hash !== `#${id}`) return;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const target = ref.current;
        if (window.location.hash !== `#${id}` || !target || !target.getClientRects().length) return;
        target.scrollIntoView({ block: "start", behavior: "auto" });
        target.focus({ preventScroll: true });
      });
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", reveal);
    };
  }, [id, enabled]);
  return ref;
}
