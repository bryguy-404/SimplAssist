"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import Script from "next/script";
import { usePathname } from "next/navigation";
import {
  ANALYTICS_CONSENT_KEY, ANALYTICS_SETTINGS_EVENT,
  isMarketingLocation, isMeasurementId, pauseMarketingAnalytics,
  readAnalyticsConsent, saveAnalyticsConsent, startMarketingAnalytics,
  trackMarketingEvent, trackMarketingPageView, type AnalyticsConsent,
} from "@/lib/analytics/marketing";

// The consent card's mascot is the orange dot from the logo. These timings
// mirror the `sa-consent-*` animations in globals.css: the card stays mounted
// just long enough for the dot's send-off and the card's exit to finish.
const DOT_SHOW_MS = 2030;
const DOT_NOD_MS = 650;

const CONFETTI_COUNT = 40;
const CONFETTI_COLORS = ["#ea580c", "#ff914d", "#fbbf24", "#f43f5e", "#f472b6", "#a78bfa", "#38bdf8", "#34d399"];
// [width, height, corner radius]
const CONFETTI_SHAPES = [[6, 10, "1px"], [8, 8, "2px"], [7, 7, "50%"], [4, 12, "1px"]] as const;

// Repeatable 0–1 noise: the burst looks scattered but is the same every time.
function confettiNoise(index: number, salt: number) {
  const value = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

// Each piece flies out from where the dot bursts, arcs up, then flutters down.
const CONFETTI: ReadonlyArray<CSSProperties> = Array.from({ length: CONFETTI_COUNT }, (_, i) => {
  const [width, height, radius] = CONFETTI_SHAPES[i % CONFETTI_SHAPES.length];
  const side = ((i + 0.5) / CONFETTI_COUNT) * 2 - 1; // spread evenly, left to right
  return {
    "--sa-c": CONFETTI_COLORS[Math.floor(confettiNoise(i, 1) * CONFETTI_COLORS.length)],
    "--sa-w": `${width}px`,
    "--sa-h": `${height}px`,
    "--sa-br": radius,
    "--sa-dx": `${Math.round(side * 185 + (confettiNoise(i, 2) - 0.5) * 30)}px`,
    "--sa-up": `${-Math.round(45 + confettiNoise(i, 3) * 115)}px`,
    "--sa-fall": `${Math.round(110 + confettiNoise(i, 4) * 170)}px`,
    "--sa-r": `${Math.round((confettiNoise(i, 5) * 2 - 1) * 900)}deg`,
    "--sa-f": `${Math.round(360 + confettiNoise(i, 6) * 720)}deg`,
    "--sa-t": `${Math.round(900 + confettiNoise(i, 7) * 250)}ms`,
    "--sa-d": `${Math.round(confettiNoise(i, 8) * 70)}ms`,
  } as CSSProperties;
});

type DotFarewell = "show" | "nod";

function prefersReducedMotion() {
  return typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function WebsiteAnalytics({ measurementId }: { measurementId: string }) {
  const pathname = usePathname();
  const [consent, setConsent] = useState<AnalyticsConsent | null>(null);
  const [ready, setReady] = useState(false);
  const [showChoices, setShowChoices] = useState(false);
  const [loadTag, setLoadTag] = useState(false);
  const [calm, setCalm] = useState(false);
  const [perk, setPerk] = useState(false);
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
    setPerk(false);
    if (prefersReducedMotion()) return;
    // The show is only for consent that was actually stored.
    const next: DotFarewell = saved === "granted" ? "show" : "nod";
    setFarewell(next);
    window.clearTimeout(farewellTimer.current);
    farewellTimer.current = window.setTimeout(
      () => setFarewell(null), next === "show" ? DOT_SHOW_MS : DOT_NOD_MS);
  }

  if (!eligible) return null;

  const buttonClass = "rounded-lg border border-stone-400 px-4 py-2 text-sm font-medium hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-600 dark:hover:bg-stone-800";

  return (
    <>
      {loadTag && consent === "granted" ? (
        <Script id="simplassist-google-analytics" strategy="afterInteractive"
          src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`} />
      ) : null}
      {consent === null || showChoices || farewell ? (
        <section aria-label="Website analytics preferences"
          data-mood={farewell ?? (perk ? "perk" : "idle")}
          className="sa-consent fixed bottom-4 left-4 right-4 z-[80] max-w-md sm:right-auto">
          {/* The dot sits behind the card so it can pop up from behind its top edge. */}
          <span aria-hidden="true" className="sa-consent-track">
            <span className="sa-consent-runner">
              <span className="sa-consent-dot" />
            </span>
          </span>
          {/* Confetti sits above the card so it can rain down over it. */}
          <span aria-hidden="true" className="sa-consent-confetti">
            {CONFETTI.map((style, i) => (
              <span key={i} className="sa-consent-confetto" style={style} />
            ))}
          </span>
          <div className="relative z-10 rounded-2xl border border-stone-200 bg-white p-5 text-stone-900 shadow-xl dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100">
            <h2 className="text-sm font-semibold">Help improve SimplAssist</h2>
            <p className="mt-2 text-sm leading-6 text-stone-600 dark:text-stone-300">
              {calm
                ? "Allow Google Analytics cookies to measure visits and demo interest? Your choice won’t affect the service. "
                : "Want to see the orange dot on this card do a trick? Allow Google Analytics cookies and it’ll put on a quick show. "}
              <Link href="/privacy#website-analytics" className="underline">Privacy details</Link>
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <button type="button" onClick={() => choose("granted")}
                onMouseEnter={() => setPerk(true)} onMouseLeave={() => setPerk(false)}
                onFocus={() => setPerk(true)} onBlur={() => setPerk(false)}
                className={buttonClass}>Allow analytics</button>
              <button type="button" onClick={() => choose("denied")}
                className={buttonClass}>No thanks</button>
            </div>
          </div>
        </section>
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
