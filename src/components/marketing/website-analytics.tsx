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

export function WebsiteAnalytics({ measurementId }: { measurementId: string }) {
  const pathname = usePathname();
  const [consent, setConsent] = useState<AnalyticsConsent | null>(null);
  const [ready, setReady] = useState(false);
  const [showChoices, setShowChoices] = useState(false);
  const [loadTag, setLoadTag] = useState(false);
  const pricingViews = useRef(new Set<string>());

  useEffect(() => {
    setConsent(readAnalyticsConsent());
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
    saveAnalyticsConsent(choice);
    setConsent(choice === "denied" ? "denied" : readAnalyticsConsent() ?? "denied");
    setShowChoices(false);
  }

  if (!eligible) return null;

  return (
    <>
      {loadTag && consent === "granted" ? (
        <Script id="simplassist-google-analytics" strategy="afterInteractive"
          src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`} />
      ) : null}
      {consent === null || showChoices ? (
        <section aria-label="Website analytics preferences"
          className="fixed bottom-4 left-4 right-4 z-[80] max-w-md rounded-2xl border border-stone-200 bg-white p-5 text-stone-900 shadow-xl dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 sm:right-auto">
          <h2 className="text-sm font-semibold">Help us improve SimplAssist</h2>
          <p className="mt-2 text-sm leading-6 text-stone-600 dark:text-stone-300">
            Allow Google Analytics cookies to measure visits and demo interest? Your choice won’t affect the service. <Link href="/privacy#website-analytics" className="underline">Privacy details</Link>
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button type="button" onClick={() => choose("granted")}
              className="rounded-lg border border-stone-400 px-4 py-2 text-sm font-medium hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-600 dark:hover:bg-stone-800">Allow analytics</button>
            <button type="button" onClick={() => choose("denied")}
              className="rounded-lg border border-stone-400 px-4 py-2 text-sm font-medium hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-600 dark:hover:bg-stone-800">No thanks</button>
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
