export const SETTINGS_REGISTRATION_LOCK_CODE =
  "settings_registration_locked";
export const REGISTRATION_STATE_UNAVAILABLE_CODE =
  "registration_state_unavailable";
export const SETTINGS_STATE_CHANGED_CODE = "settings_state_changed";

function registrationLockCopy(supportText: string, reasonText: string) {
  return {
    supportText,
    reasonText,
    message: `${supportText}${reasonText}`,
  } as const;
}

export const BUSINESS_ADDRESS_LOCK_COPY = registrationLockCopy(
  "Contact support to change your business address",
  " because it was filed with your carrier registration."
);

export const COMPLIANCE_LOCK_COPY = registrationLockCopy(
  "Contact support to change your privacy and terms settings",
  " because they were filed with your carrier registration."
);

export const GOAL_SIGNUP_LOCK_COPY = registrationLockCopy(
  "Contact support to change your goal to directing customers to a website",
  " because your current goal was filed with your carrier registration."
);

export const REGISTRATION_STATE_UNAVAILABLE_MESSAGE =
  "We couldn't verify your carrier registration status. Please try again.";
export const SETTINGS_STATE_CHANGED_MESSAGE =
  "These settings changed while you were saving. Reload and try again.";

export type SettingsRegistrationLockCopy = Readonly<{
  supportText: string;
  reasonText: string;
  message: string;
}>;
