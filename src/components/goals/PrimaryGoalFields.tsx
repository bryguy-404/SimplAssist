"use client";

import {
  PRIMARY_GOAL_COPY,
  PRIMARY_GOAL_OPTIONS,
  type EditablePrimaryGoal,
} from "@/lib/goals/primaryGoal";
import type { ReactNode } from "react";

export interface PrimaryGoalFieldsProps {
  primaryGoal: EditablePrimaryGoal | null;
  goalUrl: string;
  onPrimaryGoalChange: (primaryGoal: EditablePrimaryGoal) => void;
  onGoalUrlChange: (goalUrl: string) => void;
  disabled?: boolean;
  disabledOptions?: readonly EditablePrimaryGoal[];
  helper?: ReactNode;
  /** Optional plain-language line under each option (used in Settings). */
  optionDetails?: Partial<Record<EditablePrimaryGoal, string>>;
  /** Optional visible label for the website-link field (used in Settings). */
  goalUrlLabel?: string;
}

export function PrimaryGoalFields({
  primaryGoal,
  goalUrl,
  onPrimaryGoalChange,
  onGoalUrlChange,
  disabled = false,
  disabledOptions = [],
  helper,
  optionDetails,
  goalUrlLabel,
}: PrimaryGoalFieldsProps) {
  return (
    <fieldset
      data-primary-goal-fields
      disabled={disabled}
      aria-describedby="primary-goal-helper"
      className="space-y-3"
    >
      <legend className="text-base font-semibold text-stone-900 dark:text-[#f5f5f5]">
        {PRIMARY_GOAL_COPY.question}
      </legend>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {PRIMARY_GOAL_OPTIONS.map((option) => {
          const selected = primaryGoal === option.value;
          const optionDisabled = disabledOptions.includes(option.value);
          return (
            <label
              key={option.value}
              className={`rounded-[18px] border p-4 text-sm transition-colors ${
                optionDisabled
                  ? "cursor-not-allowed opacity-60"
                  : "cursor-pointer"
              } ${
                selected
                  ? "border-[var(--brand-primary)] bg-[var(--brand-wash)] ring-2 ring-[rgb(var(--brand-primary-rgb)/.20)] dark:border-[var(--brand-primary-dark)] dark:bg-[rgb(var(--brand-primary-dark-rgb)/.11)] dark:ring-[rgb(var(--brand-primary-dark-rgb)/.20)]"
                  : `border-[#e9e0d4] bg-white/70 dark:border-white/[0.10] dark:bg-white/[0.035] ${
                      optionDisabled
                        ? ""
                        : "hover:border-[#d8ccbc] hover:bg-white dark:hover:border-white/[0.17] dark:hover:bg-white/[0.055]"
                    }`
              }`}
            >
              <input
                type="radio"
                name="primary_goal"
                value={option.value}
                checked={selected}
                onChange={() => onPrimaryGoalChange(option.value)}
                disabled={optionDisabled}
                className="sr-only"
              />
              <span className="font-medium text-stone-900 dark:text-[#f5f5f5]">
                {option.label}
              </span>
              {optionDetails?.[option.value] && (
                <span className="mt-1.5 block text-xs leading-relaxed text-stone-500 dark:text-[#bdbdbf]">
                  {optionDetails[option.value]}
                </span>
              )}
            </label>
          );
        })}
      </div>

      <p
        id="primary-goal-helper"
        className="text-xs leading-relaxed text-stone-500 dark:text-[#bdbdbf]"
      >
        {helper ?? PRIMARY_GOAL_COPY.helper}
      </p>

      {primaryGoal === "signup" && goalUrlLabel && (
        <label
          htmlFor="goal_url"
          className="block pt-1 text-sm font-medium text-stone-700 dark:text-[#d7d7d9]"
        >
          {goalUrlLabel}
        </label>
      )}
      {primaryGoal === "signup" && (
        <input
          type="url"
          id="goal_url"
          name="goal_url"
          aria-label="Website link"
          placeholder="https://"
          minLength={9}
          maxLength={2048}
          required
          value={goalUrl}
          onChange={(event) => onGoalUrlChange(event.target.value)}
          className="w-full rounded-lg border border-[#e3dacc] bg-white px-3 py-2 text-stone-900 placeholder:text-stone-400 focus:border-[var(--brand-primary)] focus:outline-none focus:ring-2 focus:ring-[rgb(var(--brand-primary-rgb)/.25)] dark:border-white/[0.12] dark:bg-white/[0.06] dark:text-[#f5f5f5] dark:placeholder:text-[#666] dark:focus:border-[var(--brand-primary-dark)] dark:focus:ring-[rgb(var(--brand-primary-dark-rgb)/.30)]"
        />
      )}
    </fieldset>
  );
}
