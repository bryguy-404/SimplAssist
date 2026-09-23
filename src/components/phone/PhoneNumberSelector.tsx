"use client";

import { useEffect, useState } from "react";
import { useBrand } from "@/components/branding/BrandProvider";
import { replaceDefaultBrandName } from "@/lib/branding/presentation";

const FALLBACK_CANONICAL_ORIGIN = "https://simplassist.com";

export function canonicalLegalUrl(
  path: "/terms" | "/privacy",
  configuredOrigin = process.env.NEXT_PUBLIC_APP_URL,
): string {
  try {
    const url = new URL(configuredOrigin || FALLBACK_CANONICAL_ORIGIN);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      throw new Error("Unsupported canonical URL protocol");
    }

    return new URL(path, url.origin).toString();
  } catch {
    return new URL(path, FALLBACK_CANONICAL_ORIGIN).toString();
  }
}

interface AvailableNumber {
  phoneNumber: string;
  friendlyName: string;
}

interface PurchasedNumber {
  phone_number: string;
  pending?: boolean;
}

interface PhoneNumberSelectorProps {
  initialPhoneNumber?: string | null;
  initialPhoneNumberPending?: boolean;
  initialConsentAgreed?: boolean;
  initialFailureReason?: string | null;
  request?: typeof fetch;
  pendingDescription?: string;
  onConsentChange?: (agreed: boolean) => void;
  onNumberPurchased?: (phoneNumber: string) => void;
  onReplacementModeChange?: (replacing: boolean) => void;
}

export function shouldDisablePhoneNumberNext(args: {
  phoneNumber: string | null;
  pendingSelection: boolean;
  pendingFailureReason: string | null;
  replacingNumber: boolean;
}): boolean {
  return Boolean(
    !args.phoneNumber ||
      args.replacingNumber ||
      (args.pendingSelection && args.pendingFailureReason)
  );
}

export default function PhoneNumberSelector({
  initialPhoneNumber,
  initialPhoneNumberPending = false,
  initialConsentAgreed = false,
  initialFailureReason = null,
  request = fetch,
  pendingDescription = "We will activate this number after checkout. If it becomes unavailable, you can choose another number without paying again.",
  onConsentChange,
  onNumberPurchased,
  onReplacementModeChange,
}: PhoneNumberSelectorProps) {
  const brand = useBrand();
  const [areaCode, setAreaCode] = useState("");
  const [numbers, setNumbers] = useState<AvailableNumber[]>([]);
  const [searching, setSearching] = useState(false);
  const [purchasing, setPurchasing] = useState<string | null>(null);
  const [purchased, setPurchased] = useState<PurchasedNumber | null>(() =>
    initialPhoneNumber
      ? {
          phone_number: initialPhoneNumber,
          pending: initialPhoneNumberPending,
        }
      : null
  );
  const [error, setError] = useState<string | null>(initialFailureReason);
  const [consented, setConsented] = useState(initialConsentAgreed);

  useEffect(() => {
    if (initialPhoneNumber) {
      setPurchased({
        phone_number: initialPhoneNumber,
        pending: initialPhoneNumberPending,
      });
    } else {
      setPurchased(null);
    }

    setConsented(initialConsentAgreed);
    setError(initialFailureReason);
    onConsentChange?.(initialConsentAgreed);
  }, [
    initialPhoneNumber,
    initialPhoneNumberPending,
    initialConsentAgreed,
    initialFailureReason,
    onConsentChange,
  ]);

  function handleConsentToggle(checked: boolean) {
    setConsented(checked);
    onConsentChange?.(checked);
  }

  async function handleSearch() {
    if (!/^\d{3}$/.test(areaCode)) {
      setError("Please enter a valid 3-digit area code");
      return;
    }

    setError(null);
    setSearching(true);
    setNumbers([]);
    setPurchased(null);

    try {
      const res = await request(
        `/api/messaging/numbers/search?areaCode=${areaCode}`
      );
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to search numbers");
        return;
      }

      setNumbers(data.numbers);
      if (data.numbers.length === 0) {
        setError("No numbers available for this area code");
      }
    } catch {
      setError("Failed to search numbers");
    } finally {
      setSearching(false);
    }
  }

  async function handlePurchase(phoneNumber: string) {
    setPurchasing(phoneNumber);
    setError(null);

    try {
      const res = await request("/api/messaging/numbers/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to select number");
        return;
      }

      setPurchased(data.number);
      onReplacementModeChange?.(false);
      onNumberPurchased?.(data.number.phone_number);
      setNumbers([]);
    } catch {
      setError("Failed to select number");
    } finally {
      setPurchasing(null);
    }
  }

  function handleChangeNumber() {
    // This is intentionally local-only. The old pending preference remains in
    // the database until a replacement selection succeeds, so abandoning this
    // search cannot erase the customer's last saved choice.
    setPurchased(null);
    setNumbers([]);
    setError(null);
    onReplacementModeChange?.(true);
  }

  if (purchased) {
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 p-6 text-center">
        <h3 className="text-lg font-semibold text-green-800">
          Number Selected
        </h3>
        <p className="mt-2 text-2xl font-bold text-green-900">
          {purchased.phone_number}
        </p>
        <p className="mt-1 text-sm text-green-600">
          {purchased.pending === true
            ? pendingDescription
            : "This number is already active."}
        </p>
        {error && (
          <p className="mt-3 text-sm text-red-600">
            {replaceDefaultBrandName(error, brand.name)}
          </p>
        )}
        {purchased.pending === true && (
          <button
            type="button"
            onClick={handleChangeNumber}
            className="mt-4 rounded-md border border-green-300 bg-white px-4 py-2 text-sm font-medium text-green-800 hover:bg-green-100"
          >
            Change number
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* SMS Consent Checkbox — must agree before searching */}
      <label className="flex items-start gap-3 p-4 rounded-xl border border-slate-200 dark:border-white/[0.10] bg-slate-50 dark:bg-white/[0.04] cursor-pointer">
        <input
          type="checkbox"
          checked={consented}
          onChange={(e) => handleConsentToggle(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded accent-[var(--brand-primary-dark)] flex-shrink-0"
        />
        <span className="text-sm text-slate-600 dark:text-[#bdbdbf] leading-relaxed">
          By selecting a phone number, I agree that this number will be registered to my business
          for carrier compliance, and that SimplAssist will send automated text messages on my
          business&apos;s behalf to customers who contact me. I will not use this number for spam or
          unsolicited marketing. Customers can opt out at any time by replying STOP. I agree to
          SimplAssist&apos;s{" "}
          <a
            href={canonicalLegalUrl("/terms")}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--brand-primary-dark)] underline hover:text-[var(--brand-primary-soft-dark)]"
          >
            Terms of Service
          </a>{" "}
          and{" "}
          <a
            href={canonicalLegalUrl("/privacy")}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--brand-primary-dark)] underline hover:text-[var(--brand-primary-soft-dark)]"
          >
            Privacy Policy
          </a>.
        </span>
      </label>

      {/* Search area — disabled until consented */}
      <div className={`flex gap-3 transition-opacity ${!consented ? "opacity-50 pointer-events-none" : ""}`}>
        <input
          type="text"
          value={areaCode}
          onChange={(e) =>
            setAreaCode(e.target.value.replace(/\D/g, "").slice(0, 3))
          }
          placeholder="Area code (e.g. 415)"
          disabled={!consented}
          className="w-40 rounded-md border border-gray-300 dark:border-white/[0.12] px-3 py-2 text-sm dark:bg-white/[0.06] dark:text-[#f5f5f5] dark:placeholder:text-[#666] focus:border-[var(--brand-primary-dark)] focus:outline-none focus:ring-1 focus:ring-[var(--brand-primary-dark)] disabled:cursor-not-allowed"
          maxLength={3}
        />
        <button
          onClick={handleSearch}
          disabled={!consented || searching || areaCode.length !== 3}
          className="rounded-md bg-[var(--brand-primary-alt)] dark:bg-transparent dark:bg-[linear-gradient(135deg,var(--brand-primary-dark),var(--brand-primary-soft-dark))] px-4 py-2 text-sm font-medium text-white dark:text-[#111] shadow-[0_14px_34px_rgb(var(--brand-primary-dark-rgb)/.26)] hover:bg-[var(--brand-primary)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {searching ? "Searching..." : "Search"}
        </button>
      </div>

      {error && (
        <p className="text-sm text-red-600">
          {replaceDefaultBrandName(error, brand.name)}
        </p>
      )}

      {numbers.length > 0 && (
        <ul className="divide-y divide-gray-200 dark:divide-white/[0.10] rounded-md border border-gray-200 dark:border-white/[0.10]">
          {numbers.map((n) => (
            <li
              key={n.phoneNumber}
              className="flex items-center justify-between px-4 py-3 dark:hover:bg-white/[0.04]"
            >
              <div>
                <p className="font-medium text-slate-900 dark:text-[#f5f5f5]">{n.phoneNumber}</p>
                <p className="text-sm text-slate-500 dark:text-[#bdbdbf]">{n.friendlyName}</p>
              </div>
              <button
                onClick={() => handlePurchase(n.phoneNumber)}
                disabled={purchasing !== null}
                className="rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {purchasing === n.phoneNumber ? "Purchasing..." : "Select"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
