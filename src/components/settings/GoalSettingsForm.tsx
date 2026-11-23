"use client";

import { useEffect, useReducer, useState } from "react";
import { useRouter } from "next/navigation";

import { PrimaryGoalFields } from "@/components/goals/PrimaryGoalFields";
import { PulsingDot } from "@/components/ui/pulsing-dot";
import { primaryCtaInlineClass } from "@/lib/glass";
import {
  buildPrimaryGoalUpdate,
  isEditablePrimaryGoal,
  type EditablePrimaryGoal,
  type PrimaryGoalUpdate,
} from "@/lib/goals/primaryGoal";
import {
  GOAL_SIGNUP_LOCK_COPY,
  SETTINGS_REGISTRATION_LOCK_CODE,
} from "@/lib/settings/registrationLockCopy";
import { supportHref } from "@/lib/support/constants";
import type { PrimaryGoal } from "@/types/database";

export type GoalSettingsFormProps = {
  initialPrimaryGoal: PrimaryGoal | null;
  initialGoalUrl: string | null;
  registrationLocked: boolean;
};

type GoalSettingsDraft = {
  primaryGoal: EditablePrimaryGoal | null;
  goalUrl: string;
};

type GoalSettingsDraftAction =
  | { type: "primary_goal"; value: EditablePrimaryGoal }
  | { type: "goal_url"; value: string }
  | {
      type: "hydrate";
      initialPrimaryGoal: PrimaryGoal | null;
      initialGoalUrl: string | null;
    };

const LOCKED_GOAL_HELPER =
  "Pick the main one. Your AI still handles everything else customers ask — this just sets what it steers toward.";
const GOAL_OPTION_DETAILS = {
  book: "Your assistant works toward getting customers on your schedule. You get a Calendar page and can connect Google Calendar.",
  signup:
    "Your assistant sends customers the link you set below. Everyone it sends the link to shows up on your Leads page.",
} as const;
const GOAL_SWITCH_NOTICE = {
  book: "Switching to scheduling replaces your Leads page with a Calendar page, and your assistant starts working toward booking a time instead of sending your link. Nothing is deleted. Your link is kept in case you switch back.",
  signup:
    "Switching to a website link replaces your Calendar page and booking settings with a Leads page, and your assistant sends your link instead of offering appointments. Nothing is deleted. Your calendar comes back if you switch back.",
} as const;
const GOAL_SETTINGS_SAVE_FALLBACK =
  "Could not save your AI settings. Please try again.";

export function createGoalSettingsDraft(
  initialPrimaryGoal: PrimaryGoal | null,
  initialGoalUrl: string | null
): GoalSettingsDraft {
  return {
    primaryGoal: isEditablePrimaryGoal(initialPrimaryGoal)
      ? initialPrimaryGoal
      : null,
    goalUrl: initialGoalUrl ?? "",
  };
}

export function reduceGoalSettingsDraft(
  draft: GoalSettingsDraft,
  action: GoalSettingsDraftAction
): GoalSettingsDraft {
  if (action.type === "hydrate") {
    return createGoalSettingsDraft(
      action.initialPrimaryGoal,
      action.initialGoalUrl
    );
  }

  if (action.type === "primary_goal") {
    return { ...draft, primaryGoal: action.value };
  }

  return { ...draft, goalUrl: action.value };
}

export async function saveGoalSettings({
  payload,
  refresh,
  fetcher = fetch,
}: {
  payload: PrimaryGoalUpdate;
  refresh: () => void;
  fetcher?: typeof fetch;
}): Promise<void> {
  let response: Response;
  try {
    response = await fetcher("/api/settings/goal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new GoalSettingsSaveError(GOAL_SETTINGS_SAVE_FALLBACK, 0, null);
  }

  if (!response.ok) {
    const responseBody = (await response.json().catch(() => null)) as {
      code?: unknown;
      error?: unknown;
    } | null;
    const code =
      typeof responseBody?.code === "string" ? responseBody.code : null;

    if (
      response.status === 403 &&
      code === SETTINGS_REGISTRATION_LOCK_CODE
    ) {
      refresh();
    }

    throw new GoalSettingsSaveError(
      typeof responseBody?.error === "string"
        ? responseBody.error
        : GOAL_SETTINGS_SAVE_FALLBACK,
      response.status,
      code
    );
  }

  refresh();
}

export class GoalSettingsSaveError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null
  ) {
    super(message);
    this.name = "GoalSettingsSaveError";
  }
}

export default function GoalSettingsForm({
  initialPrimaryGoal,
  initialGoalUrl,
  registrationLocked,
}: GoalSettingsFormProps) {
  const router = useRouter();
  const [draft, dispatch] = useReducer(
    reduceGoalSettingsDraft,
    createGoalSettingsDraft(initialPrimaryGoal, initialGoalUrl)
  );
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"success" | "error" | null>(null);
  const [errorMessage, setErrorMessage] = useState(
    GOAL_SETTINGS_SAVE_FALLBACK
  );

  useEffect(() => {
    // A registration-lock refresh invalidates any draft built from the stale
    // server props, even when the stored goal itself did not change.
    void registrationLocked;
    dispatch({ type: "hydrate", initialPrimaryGoal, initialGoalUrl });
    setStatus(null);
    setErrorMessage(GOAL_SETTINGS_SAVE_FALLBACK);
  }, [initialGoalUrl, initialPrimaryGoal, registrationLocked]);
  const signupLocked =
    registrationLocked && initialPrimaryGoal !== "signup";
  const switchingTo =
    isEditablePrimaryGoal(initialPrimaryGoal) &&
    draft.primaryGoal !== null &&
    draft.primaryGoal !== initialPrimaryGoal
      ? draft.primaryGoal
      : null;
  const payload = buildPrimaryGoalUpdate({
    primary_goal: draft.primaryGoal,
    goal_url: draft.goalUrl,
  });

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!payload) return;

    setSaving(true);
    setStatus(null);
    try {
      await saveGoalSettings({
        payload,
        refresh: () => router.refresh(),
      });
      setStatus("success");
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : GOAL_SETTINGS_SAVE_FALLBACK
      );
      setStatus("error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4"
    >
      <div>
        <h2 className="mb-1 text-lg font-semibold text-stone-900 dark:text-[#f5f5f5]">
          Main goal
        </h2>
        <p className="text-sm text-stone-500 dark:text-[#bdbdbf]">
          The one outcome your assistant steers conversations toward. It also
          decides whether your dashboard shows a Calendar or a Leads page.
        </p>
      </div>

      <PrimaryGoalFields
        primaryGoal={draft.primaryGoal}
        goalUrl={draft.goalUrl}
        onPrimaryGoalChange={(value) =>
          dispatch({ type: "primary_goal", value })
        }
        onGoalUrlChange={(value) => dispatch({ type: "goal_url", value })}
        disabled={saving}
        disabledOptions={signupLocked ? ["signup"] : undefined}
        helper={registrationLocked ? LOCKED_GOAL_HELPER : undefined}
        optionDetails={GOAL_OPTION_DETAILS}
        goalUrlLabel="Link your assistant sends"
      />

      {switchingTo && (
        <p
          role="status"
          className="rounded-[14px] border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-[rgba(245,158,11,0.25)] dark:bg-[rgba(245,158,11,0.12)] dark:text-[#fcd9a5]"
        >
          {GOAL_SWITCH_NOTICE[switchingTo]}
        </p>
      )}

      {signupLocked && (
        <p className="text-xs leading-relaxed text-stone-500 dark:text-[#bdbdbf]">
          <a
            href={supportHref("number_registration")}
            className="font-medium text-[var(--brand-accent)] underline hover:text-[var(--brand-primary-active)] dark:text-[var(--brand-accent-dark)] dark:hover:text-[var(--brand-primary-soft-dark)]"
          >
            {GOAL_SIGNUP_LOCK_COPY.supportText}
          </a>
          {GOAL_SIGNUP_LOCK_COPY.reasonText}
        </p>
      )}

      <div className="flex items-center gap-4 pt-2">
        <button
          type="submit"
          disabled={saving || !payload}
          className={primaryCtaInlineClass}
        >
          {saving ? (
            <>
              <PulsingDot inline />
              Saving…
            </>
          ) : (
            "Save Settings"
          )}
        </button>
        {status === "success" && (
          <span className="text-sm font-medium text-green-600 dark:text-green-400">
            Settings saved successfully!
          </span>
        )}
        {status === "error" && (
          <span className="text-sm font-medium text-red-600 dark:text-red-400">
            {errorMessage}
          </span>
        )}
      </div>
    </form>
  );
}
