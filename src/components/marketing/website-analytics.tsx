"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Script from "next/script";
import { usePathname } from "next/navigation";
import {
  ANALYTICS_CONSENT_KEY, ANALYTICS_SETTINGS_EVENT,
  isMarketingLocation, isMeasurementId, pauseMarketingAnalytics,
  readAnalyticsConsent, saveAnalyticsConsent, startMarketingAnalytics,
  trackMarketingEvent, trackMarketingPageView, type AnalyticsConsent,
} from "@/lib/analytics/marketing";
import { burstConfetti } from "./consent-confetti";

// The consent card's mascot is the orange dot from the logo. It peeks over the
// card and watches the pointer. Allowing analytics sends it hopping along the
// card before it pops into confetti; declining gets a small nod as it ducks
// away. Both buttons carry the same weight on purpose: the show is a thank-you,
// not pressure.
//
// These timings mirror the `sa-consent-*` animations in globals.css: the card
// stays mounted just long enough for the send-off and its own exit to finish.
const DOT_SHOW_MS = 2300;
const DOT_BYE_MS = 420;
// When the dot pops, at the top of its last and biggest hop.
const DOT_BURST_MS = 1620;

type DotFarewell = "show" | "bye";

function prefersReducedMotion() {
  return typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const CONSENT_BUTTON_CLASS = "rounded-full border border-stone-300 px-3 py-2 text-sm font-medium transition-opacity hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-600 disabled:opacity-50 disabled:hover:bg-transparent dark:border-stone-600 dark:hover:bg-stone-800 dark:disabled:hover:bg-transparent";

function ConsentCard({ farewell, calm, onChoose }: {
  farewell: DotFarewell | null;
  calm: boolean;
  onChoose: (choice: AnalyticsConsent) => void;
}) {
  const [eager, setEager] = useState(false);
  const dot = useRef<HTMLDivElement>(null);
  const eyes = useRef<HTMLSpanElement>(null);

  // The eyes follow the pointer a little.
  useEffect(() => {
    if (farewell || calm) return;
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
  }, [farewell, calm]);

  // During the show the confetti bursts from wherever the dot has hopped to.
  useEffect(() => {
    if (!farewell) return;
    if (eyes.current) eyes.current.style.transform = "";
    if (farewell !== "show") return;
    const timer = window.setTimeout(() => {
      const box = dot.current?.getBoundingClientRect();
      if (box) burstConfetti(box.left + box.width / 2, box.top + box.height / 2);
    }, DOT_BURST_MS);
    return () => window.clearTimeout(timer);
  }, [farewell]);

  const busy = farewell !== null;

  return (
    <section aria-label="Website analytics preferences"
      data-mood={farewell ?? "idle"} data-eager={eager && !busy ? "" : undefined}
      className="sa-consent fixed bottom-4 left-4 right-4 z-[80] sm:right-auto sm:w-[25rem]">
      {/* The dot sits behind the card so it can peek over its top edge. */}
      <div aria-hidden="true" className="sa-consent-track">
        <div className="sa-consent-runner">
          <div className="sa-consent-hopper">
            <div ref={dot} className="sa-consent-dot">
              <span ref={eyes} className="sa-consent-eyes"><i /><i /></span>
            </div>
          </div>
        </div>
      </div>
      <div className="relative z-10 rounded-2xl border border-stone-200 bg-white p-5 text-stone-900 shadow-xl dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100">
        <h2 className="text-sm font-semibold">
          {farewell === "show" ? "Thank you! Enjoy the show." : "Help improve SimplAssist"}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-stone-600 dark:text-stone-300">
          {calm
            ? "Allow Google Analytics cookies to help us see what’s working on this site?"
            : "Want to see the orange dot peeking over this card do a trick? Allow Google Analytics cookies and it’ll put on a quick show."}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-stone-500 dark:text-stone-400">
          Analytics measures visits and demo interest. Your choice won’t affect the service. <Link href="/privacy#website-analytics" className="underline underline-offset-2">Privacy details</Link>
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <button type="button" disabled={busy} onClick={() => onChoose("denied")}
            className={CONSENT_BUTTON_CLASS}>No thanks</button>
          <button type="button" disabled={busy} onClick={() => onChoose("granted")}
            onPointerEnter={() => setEager(true)} onPointerLeave={() => setEager(false)}
            onFocus={() => setEager(true)} onBlur={() => setEager(false)}
            className={CONSENT_BUTTON_CLASS}>Allow analytics</button>
        </div>
      </div>
    </section>
  );
}

export function WebsiteAnalytics({ measurementId }: { measurementId: string }) {
  const pathname = usePathname();
  const [consent, setConsent] = useState<AnalyticsConsent | null>(null);
  const [ready, setReady] = useState(false);
  const [showChoices, setShowChoices] = useState(false);
  const [loadTag, setLoadTag] = useState(false);
  const [calm, setCalm] = useState(false);
  const [farewell, setFarewell] = useState<DotFarewell | null>(null);
  const farewellTimer = useRef<number>();
  const pricingViews = useRef(new Set<string>());

  useEffect(() => () => window.clearTimeout(farewellTimer.current), []);

  useEffect(() => {
    setConsent(readAnalyticsConsent());
    setCalm(prefersReducedMotion());
    setReady(true);
    const show = () => setShowChoices(true);
    const sync = (event: StorageEvent) => {
      if (event.key === ANALYTICS_CONSENT_KEY || event.key === null) {
        // Stop immediately when another tab revokes consent.
        if (readAnalyticsConsent() !== "granted") pauseMarketingAnalytics();
        setConsent(readAnalyticsConsent());
      }
    };
    window.addEventListener(ANALYTICS_SETTINGS_EVENT, show);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(ANALYTICS_SETTINGS_EVENT, show);
      window.removeEventListener("storage", sync);
      pauseMarketingAnalytics();
    };
  }, []);

  const eligible = ready && isMeasurementId(measurementId) &&
    isMarketingLocation(window.location.hostname, pathname);

  useEffect(() => {
    if (!eligible || consent !== "granted") {
      pauseMarketingAnalytics();
      return;
    }
    if (startMarketingAnalytics(measurementId)) {
      setLoadTag(true);
      trackMarketingPageView();
    }
  }, [eligible, consent, measurementId, pathname]);

  useEffect(() => {
    if (!eligible || consent !== "granted") return;
    const trackClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const control = event.target.closest("a, button");
      if (!control) return;
      if (control.matches(".sa-widget-btn") &&
        !document.querySelector(".sa-widget-panel.sa-visible")) {
        trackMarketingEvent("demo_chat_open");
      }
      if (!(control instanceof HTMLAnchorElement)) return;
      const href = control.getAttribute("href") || "";
      const contactProtocol = href.match(/^(tel|sms):/i)?.[1].toLowerCase();
      if (contactProtocol) {
        const linkLocation = control.closest("footer") ? "footer"
          : control.closest("header, nav") ? "header"
          : control.closest("section[id]")?.id || "body";
        trackMarketingEvent("contact_click", {
          link_type: contactProtocol === "tel" ? "call" : "text",
          link_location: linkLocation,
        });
      }
      if (href === "tel:+15742638634") {
        trackMarketingEvent("demo_voice_click");
      } else if (control.origin === window.location.origin && control.pathname === "/signup") {
        trackMarketingEvent("signup_click");
      }
    };
    document.addEventListener("click", trackClick, true);
    return () => document.removeEventListener("click", trackClick, true);
  }, [eligible, consent]);

  useEffect(() => {
    if (!eligible || consent !== "granted" || pricingViews.current.has(pathname) ||
      typeof IntersectionObserver === "undefined") return;
    const pricing = document.getElementById("pricing");
    if (!pricing) return;

    let active = true;
    const observer = new IntersectionObserver((entries) => {
      if (!active || window.location.pathname !== pathname || pricingViews.current.has(pathname)) return;
      if (!entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= 0.5)) return;
      if (trackMarketingEvent("pricing_view")) {
        // The root layout persists across navigation and consent changes.
        // Count each page only once until the next full page load.
        pricingViews.current.add(pathname);
        observer.disconnect();
      }
    }, { threshold: 0.5 });
    observer.observe(pricing);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [eligible, consent, pathname]);

  function choose(choice: AnalyticsConsent) {
    if (farewell) return;
    // Record the choice first. The dot's send-off is decoration that plays
    // afterwards, so no one's choice depends on an animation finishing.
    saveAnalyticsConsent(choice);
    const saved = choice === "denied" ? "denied" : readAnalyticsConsent() ?? "denied";
    setConsent(saved);
    setShowChoices(false);
    if (prefersReducedMotion()) return;
    // The show is only for consent that was actually stored.
    const next: DotFarewell = saved === "granted" ? "show" : "bye";
    setFarewell(next);
    window.clearTimeout(farewellTimer.current);
    farewellTimer.current = window.setTimeout(
      () => setFarewell(null), next === "show" ? DOT_SHOW_MS : DOT_BYE_MS);
  }

  if (!eligible) return null;

  return (
    <>
      {loadTag && consent === "granted" ? (
        <Script id="simplassist-google-analytics" strategy="afterInteractive"
          src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`} />
      ) : null}
      {consent === null || showChoices || farewell ? (
        <ConsentCard farewell={farewell} calm={calm} onChoose={choose} />
      ) : null}
    </>
  );
}

export function AnalyticsSettingsButton({ className }: { className?: string }) {
  return <button type="button" className={className}
    onClick={() => window.dispatchEvent(new Event(ANALYTICS_SETTINGS_EVENT))}>
    Analytics preferences
  </button>;
}
