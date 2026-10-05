"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Mail } from "lucide-react";
import { createBrowserClient } from "@/lib/supabase/client";
import {
  body,
  btnPrimaryWide,
  fieldLabel,
  ink,
  inlineLink,
  inputField,
  tile,
} from "@/lib/theme-v2/theme";
import { AuthPasswordFieldV2, LoadingDot } from "@/lib/theme-v2/ui";
import { SignupConfirmation } from "./SignupConfirmation";

const signupSchema = z
  .object({
    fullName: z.string().min(1, "Name is required"),
    email: z.string().email("Please enter a valid email"),
    password: z.string().min(6, "Password must be at least 6 characters"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

type SignupForm = z.infer<typeof signupSchema>;

export default function PublicSignupForm() {
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const supabase = createBrowserClient();

  useEffect(() => { setHydrated(true); }, []);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignupForm>({
    resolver: zodResolver(signupSchema),
  });

  async function onSubmit(data: SignupForm) {
    setError(null);
    const { error } = await supabase.auth.signUp({
      email: data.email,
      password: data.password,
      options: {
        data: {
          full_name: data.fullName,
        },
        emailRedirectTo: `${window.location.origin}/api/auth/callback`,
      },
    });

    if (error) {
      setError(error.message);
      return;
    }

    setSuccess(true);
  }

  if (success) {
    return (
      <SignupConfirmation
        onGoBack={() => setSuccess(false)}
        icon={
          <div
            className={`mx-auto mb-5 flex h-14 w-14 items-center justify-center ${tile}`}
          >
            <Mail
              className="h-7 w-7 text-[var(--brand-primary)] dark:text-[var(--brand-primary-dark)]"
              aria-hidden
            />
          </div>
        }
      />
    );
  }

  return (
    <div>
      <h1 className={`text-center text-2xl font-bold tracking-tight ${ink}`}>
        Create your account
      </h1>
      <p className={`mt-1 text-center text-sm ${body}`}>
        Create your account to get started.
      </p>

      <form method="post" onSubmit={handleSubmit(onSubmit)} className="mt-8 space-y-5">
        <div>
          <label htmlFor="fullName" className={fieldLabel}>
            Full name
          </label>
          <input
            id="fullName"
            type="text"
            autoComplete="name"
            {...register("fullName")}
            className={inputField}
            placeholder="Bryan Arambula"
          />
          {errors.fullName && (
            <p className="mt-1.5 text-sm text-red-600 dark:text-red-400">
              {errors.fullName.message}
            </p>
          )}
        </div>

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

        <AuthPasswordFieldV2
          id="password"
          label="Password"
          autoComplete="new-password"
          placeholder="At least 6 characters"
          registration={register("password")}
          error={errors.password?.message}
        />

        <AuthPasswordFieldV2
          id="confirmPassword"
          label="Confirm password"
          autoComplete="new-password"
          placeholder="••••••••"
          registration={register("confirmPassword")}
          error={errors.confirmPassword?.message}
        />

        {error && (
          <div
            className="
              rounded-2xl border border-red-200/80 bg-red-50/90 px-4 py-3
              dark:border-red-500/25 dark:bg-red-500/10
            "
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
              Creating account…
            </>
          ) : (
            "Create account"
          )}
        </button>
      </form>

      <p className={`mt-6 text-center text-xs ${body}`}>
        By signing up you agree to our{" "}
        <Link
          href="/terms"
          className={`${inlineLink} underline-offset-2 hover:underline`}
        >
          Terms
        </Link>{" "}
        and{" "}
        <Link
          href="/privacy"
          className={`${inlineLink} underline-offset-2 hover:underline`}
        >
          Privacy
        </Link>
        .
      </p>

      <p className={`mt-4 text-center text-sm ${body}`}>
        Already have an account?{" "}
        <Link href="/login" className={inlineLink}>
          Log in
        </Link>
      </p>
    </div>
  );
}
