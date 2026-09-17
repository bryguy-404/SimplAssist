/** Owner-facing voice state. Access and balances are resolved by the server. */
export type OwnerVoiceSettings = {
  visible: boolean;
  accessSource: "commercial" | "pilot" | null;
  canEditPreferences: boolean;
  canEnableVoice: boolean;
  status:
    | "ready"
    | "rollout_closed"
    | "plan_required"
    | "payment_required"
    | "exhausted"
    | "temporarily_unavailable";
  timezone: string;
  preferences: {
    mode: "text" | "voice";
    textFallbackEnabled: boolean;
    revision: number;
  };
  usage: {
    kind: "monthly" | "pilot_lifetime";
    periodState: "current" | "ended";
    includedSeconds: number;
    usedSeconds: number;
    heldSeconds: number;
    availableSeconds: number;
    resetsAt: string | null;
    reconciling: boolean;
  } | null;
};

export type OwnerVoiceSettingsUpdate = {
  mode: OwnerVoiceSettings["preferences"]["mode"];
  textFallbackEnabled: boolean;
  expectedRevision: number;
};
