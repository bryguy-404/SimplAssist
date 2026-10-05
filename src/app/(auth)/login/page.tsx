"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRequestBrand } from "@/components/branding/BrandProvider";
import { createBrowserClient } from "@/lib/supabase/client";
import {
  body,
  btnPrimaryWide,
  fieldLabel,
  ink,
  inlineLink,
  inputField,
} from "@/lib/theme-v2/theme";
import { AuthPasswordFieldV2, LoadingDot } from "@/lib/theme-v2/ui";

const loginSchema = z.object({
  email: z.string().email("Please enter a valid email"),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

type LoginForm = z.infer<typeof loginSchema>;

export default function LoginPage() {
  const router = useRouter();
  const requestBrand = useRequestBrand();
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supabase = createBrowserClient();

  useEffect(() => { setHydrated(true); }, []);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
  });

  async function onSubmit(data: LoginForm) {
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({
      email: data.email,
      password: data.password,
    });

    if (error) {
      setError(error.message);
      return;
    }

    // Invalidate the Router Cache so the dashboard layout re-fetches with the
    // new user's auth cookie instead of serving a previous session's render.
    router.refresh();
    router.push("/dashboard");
  }

  return (
    <div>
      <h1 className={`text-center text-2xl font-bold tracking-tight ${ink}`}>
        Log in
      </h1>
      <p className={`mt-1 text-center text-sm ${body}`}>
        Welcome back — pick up where you left off.
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

        <AuthPasswordFieldV2
          id="password"
          label="Password"
          autoComplete="current-password"
          placeholder="••••••••"
          registration={register("password")}
          error={errors.password?.message}
        />

        <div className="text-right">
          <Link href="/forgot-password" className={`text-sm ${inlineLink}`}>
            Forgot password?
          </Link>
        </div>

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
              Signing in…
            </>
          ) : (
            "Sign in"
          )}
        </button>
      </form>

      {requestBrand.source !== "partner_host" && (
        <p className={`mt-8 text-center text-sm ${body}`}>
          Don&apos;t have an account?{" "}
          <Link href="/signup" className={inlineLink}>
            Create one
          </Link>
        </p>
      )}
    </div>
  );
}
