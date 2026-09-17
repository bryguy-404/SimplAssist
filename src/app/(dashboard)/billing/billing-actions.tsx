"use client";

import { useState } from "react";
import type { SubscriptionPlan } from "@/types/database";
import { PulsingDot } from "@/components/ui/pulsing-dot";
import { primaryCtaInlineClass } from "@/lib/glass";
import { BillingPortalButton } from "@/components/billing/BillingPortalButton";
import { billingChangeError } from "@/components/billing/BillingPlanChange";

export function BillingActions({
  mode,
  plan,
}: {
  mode: "checkout" | "portal";
  plan?: SubscriptionPlan;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCheckout() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(typeof data.code === "string" && data.code.startsWith("sms_billing_") ? billingChangeError(data.code) : data.error || "Checkout is temporarily unavailable.");
        return;
      }
      if (data.url) {
        window.location.href = data.url;
      }
    } catch {
      setError("Checkout is temporarily unavailable. Try again to resume the same request.");
    } finally {
      setLoading(false);
    }
  }

  if (mode === "portal") {
    return (
      <BillingPortalButton
        className={`${primaryCtaInlineClass} text-sm`}
        label="Manage Subscription"
        loadingLabel="Loading..."
      />
    );
  }

  return (
    <div><button
      onClick={handleCheckout}
      disabled={loading}
      className={`${primaryCtaInlineClass} w-full py-2.5 text-sm`}
    >
      {loading ? (
        <>
          <PulsingDot inline />
          Loading…
        </>
      ) : (
        "Subscribe"
      )}
    </button>{error && <p role="alert" className="mt-2 text-sm text-amber-700 dark:text-amber-300">{error}</p>}</div>
  );
}
