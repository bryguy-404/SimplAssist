"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Mail } from "lucide-react";
import {
  body,
  btnPrimaryWide,
  fieldLabel,
  ink,
  inlineLink,
  inputField,
  tile,
} from "@/lib/theme-v2/theme";
import { LoadingDot } from "@/lib/theme-v2/ui";

const NEUTRAL_SUCCESS_MESSAGE =
  "If an account exists for this email, a reset link is on its way.";

const forgotPasswordSchema = z.object({
  email: z.string().email("Please enter a valid email"),
});

type ForgotPasswordValues = z.infer<typeof forgotPasswordSchema>;

export default function ForgotPasswordPage() {
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => { setHydrated(true); }, []);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordValues>({
    resolver: zodResolver(forgotPasswordSchema),
  });

  async function onSubmit(values: ForgotPasswordValues) {
    setError(null);

    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: values.email }),
      });

      if (response.ok) {
        setSubmitted(true);
        return;
      }

      if (response.status === 429) {
        setError(
          "Too many reset requests. Please wait 15 minutes and try again.",
        );
        return;
      }

      if (response.status === 400) {
        setError("Please enter a valid email and try again.");
        return;
      }

      setError("We could not request a password reset. Please try again.");
    } catch {
      setError("We could not request a password reset. Please try again.");
    }
  }

  if (submitted) {
    return (
      <div className="text-center">
        <div
          className={`mx-auto mb-5 flex h-14 w-14 items-center justify-center ${tile}`}
        >
          <Mail
            className="h-7 w-7 text-[var(--brand-primary)] dark:text-[var(--brand-primary-dark)]"
            aria-hidden
          />
        </div>
        <h1 className={`text-2xl font-bold tracking-tight ${ink}`}>
          Check your email
        </h1>
        <p className={`mt-2 text-sm leading-relaxed ${body}`}>
          {NEUTRAL_SUCCESS_MESSAGE}
        </p>
        <p className={`mt-6 text-sm ${body}`}>
          <Link href="/login" className={inlineLink}>
            Back to log in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div>
      <h1 className={`text-center text-2xl font-bold tracking-tight ${ink}`}>
        Reset your password
      </h1>
      <p className={`mt-2 text-center text-sm leading-6 ${body}`}>
        Enter your email and we&apos;ll send you a password reset link.
      </p>

      <form method="post" onSubmit={handleSubmit(onSubmit)} className="mt-8 space-y-5">
        <div>
          <label htmlFor="email" className={fieldLabel}>
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            {...register("email")}
            className={inputField}
            placeholder="you@example.com"
          />
          {errors.email && (
            <p className="mt-1.5 text-sm text-red-600 dark:text-red-400">
              {errors.email.message}
            </p>
          )}
        </div>

        {error && (
          <div
            className="rounded-2xl border border-red-200/80 bg-red-50/90 px-4 py-3 dark:border-red-500/25 dark:bg-red-500/10"
            role="alert"
          >
            <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
          </div>
        )}

        <button
          type="submit"
          disabled={!hydrated || isSubmitting}
          className={btnPrimaryWide}
        >
          {isSubmitting ? (
            <>
              <LoadingDot />
              Sending reset link…
            </>
          ) : (
            "Send reset link"
          )}
        </button>
      </form>

      <p className={`mt-8 text-center text-sm ${body}`}>
        <Link href="/login" className={inlineLink}>
          Back to log in
        </Link>
      </p>
    </div>
  );
}
