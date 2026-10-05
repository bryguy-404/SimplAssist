"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { AuthPasswordFieldV2, LoadingDot } from "@/lib/theme-v2/ui";
import { body, btnPrimaryWide, ink } from "@/lib/theme-v2/theme";

const setPasswordSchema = z
  .object({
    password: z.string().min(6, "Password must be at least 6 characters"),
    confirmPassword: z.string().min(1, "Please confirm your password"),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type SetPasswordValues = z.infer<typeof setPasswordSchema>;

export default function SetPasswordForm({
  mode,
}: {
  mode: "setup" | "reset";
}) {
  const router = useRouter();
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setHydrated(true); }, []);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SetPasswordValues>({
    resolver: zodResolver(setPasswordSchema),
  });

  async function onSubmit(values: SetPasswordValues) {
    setError(null);

    try {
      const response = await fetch("/api/auth/set-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "reset"
            ? { password: values.password, mode: "reset" }
            : { password: values.password },
        ),
      });
      const payload = (await response.json().catch(() => null)) as {
        message?: string;
      } | null;

      if (!response.ok) {
        setError(
          payload?.message ??
            (mode === "reset"
              ? "We could not reset your password. Request a new link and try again."
              : "We could not set your password. Request a new setup link and try again."),
        );
        return;
      }

      router.refresh();
      router.replace("/onboarding");
    } catch {
      setError(
        mode === "reset"
          ? "We could not reset your password. Please try again."
          : "We could not set your password. Please try again.",
      );
    }
  }

  return (
    <div>
      <h1 className={`text-center text-2xl font-bold tracking-tight ${ink}`}>
        {mode === "reset" ? "Reset your password" : "Create your password"}
      </h1>
      <p className={`mt-2 text-center text-sm leading-6 ${body}`}>
        {mode === "reset"
          ? "Choose a new password for this account."
          : "Choose the password you'll use to sign in to this workspace."}
      </p>

      <form method="post" onSubmit={handleSubmit(onSubmit)} className="mt-8 space-y-5">
        <AuthPasswordFieldV2
          id="password"
          label="Password"
          autoComplete="new-password"
          registration={register("password")}
          error={errors.password?.message}
        />
        <AuthPasswordFieldV2
          id="confirm-password"
          label="Confirm password"
          autoComplete="new-password"
          registration={register("confirmPassword")}
          error={errors.confirmPassword?.message}
        />

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
              {mode === "reset" ? "Resetting password…" : "Saving password…"}
            </>
          ) : (
            mode === "reset" ? "Reset password" : "Set password"
          )}
        </button>
      </form>
    </div>
  );
}
