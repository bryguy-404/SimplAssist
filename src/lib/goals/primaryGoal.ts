import type { OnboardingStep, PrimaryGoal } from "@/types/database";

export type EditablePrimaryGoal = Extract<PrimaryGoal, "book" | "signup">;

export const PRIMARY_GOAL_COPY = {
  question: "When a new customer reaches out, what's the win for you?",
  options: {
    book: "I run on a schedule — jobs, visits, or appointments",
    signup: "Direct customers to a website",
  },
  helper:
    "Pick the main one. Your AI still handles everything else customers ask — this just sets what it steers toward. You can change it anytime in Settings.",
} as const;

export const PRIMARY_GOAL_OPTIONS: ReadonlyArray<{
  value: EditablePrimaryGoal;
  label: string;
}> = [
  { value: "book", label: PRIMARY_GOAL_COPY.options.book },
  { value: "signup", label: PRIMARY_GOAL_COPY.options.signup },
];

export type PrimaryGoalUpdate =
  | { primary_goal: "book" }
  | { primary_goal: "signup"; goal_url: string };

type PrimaryGoalUpdateInput = {
  primary_goal: EditablePrimaryGoal | null | undefined;
  goal_url: string | null | undefined;
};

type GoalSaveDestination =
  | { kind: "dashboard"; href: "/dashboard" }
  | { kind: "step"; step: OnboardingStep };

type GoalSaveState = {
  currentStep: OnboardingStep;
  dashboardReady: boolean;
};

type CompleteGoalSaveNavigationArgs = {
  refreshState: (options: {
    keepStep: true;
  }) => Promise<GoalSaveState | null>;
  replace: (href: "/dashboard") => void;
  setStep: (step: OnboardingStep) => void;
};

export function resolveGoalSaveDestination(
  state: GoalSaveState
): GoalSaveDestination {
  if (state.dashboardReady) {
    return { kind: "dashboard", href: "/dashboard" };
  }

  return {
    kind: "step",
    step: state.currentStep,
  };
}

export function applyGoalSaveDestination(
  state: GoalSaveState,
  actions: {
    replace: (href: "/dashboard") => void;
    setStep: (step: OnboardingStep) => void;
  }
): void {
  const destination = resolveGoalSaveDestination(state);
  if (destination.kind === "dashboard") {
    actions.replace(destination.href);
    return;
  }

  actions.setStep(destination.step);
}

export async function completeGoalSaveNavigation({
  refreshState,
  replace,
  setStep,
}: CompleteGoalSaveNavigationArgs): Promise<void> {
  const state = await refreshState({ keepStep: true });
  if (!state) return;

  applyGoalSaveDestination(state, { replace, setStep });
}

export function isEditablePrimaryGoal(
  value: unknown
): value is EditablePrimaryGoal {
  return value === "book" || value === "signup";
}

export function normalizeHttpsGoalUrl(
  value: string | null | undefined
): string | null {
  if (typeof value !== "string") return null;

  const normalized = value.trim();
  if (
    normalized.length < 9 ||
    normalized.length > 2048 ||
    /\s/.test(normalized) ||
    !/^https:\/\/[^/?#\\]+(?:[/?#]|$)/i.test(normalized)
  ) {
    return null;
  }

  const storedValue = `https://${normalized.slice("https://".length)}`;

  try {
    const parsed = new URL(storedValue);
    if (parsed.protocol !== "https:" || parsed.hostname.length === 0) {
      return null;
    }
  } catch {
    return null;
  }

  return storedValue;
}

export function buildPrimaryGoalUpdate({
  primary_goal,
  goal_url,
}: PrimaryGoalUpdateInput): PrimaryGoalUpdate | null {
  if (primary_goal === "book") {
    return { primary_goal: "book" };
  }

  if (primary_goal === "signup") {
    const normalizedGoalUrl = normalizeHttpsGoalUrl(goal_url);
    return normalizedGoalUrl === null
      ? null
      : { primary_goal: "signup", goal_url: normalizedGoalUrl };
  }

  return null;
}
