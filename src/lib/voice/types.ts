export const PILOT_BUSINESS_ID = "ea848911-ef72-44a6-8cf3-c47b3959be26";
export const PILOT_PHONE = "+15742638634";
export const VOICE_MODEL = "gpt-live-1";
export const ANSWERING_MODEL = "claude-haiku-4-5-20251001";
export const RECORDING_NOTICE =
  "You’re speaking with SimplAssist’s AI assistant. This test call will be recorded to help us improve the service. If you don’t want to be recorded, please hang up now. Otherwise, please stay on the line.";

export interface VoiceSession {
  id: string;
  /** Missing on legacy fixtures; persisted legacy calls default to pilot. */
  access_source?: "pilot" | "commercial";
  allowance_period_id?: string | null;
  commercial_deadline_at?: string | null;
  text_fallback_enabled?: boolean;
  admission_reason?: string | null;
  business_id: string;
  action_business_id?: string | null;
  action_conversation_id?: string | null;
  demo_mode?: boolean;
  preparation_started_at?: string | null;
  prepared_openai_id?: string | null;
  conversation_id: string | null;
  call_control_id: string;
  call_session_id: string;
  caller_phone: string;
  called_phone: string;
  response_mode: "text" | "voice";
  status: "ringing" | "notice" | "starting" | "active" | "closing" | "closed";
  outcome: string | null;
  reserved_seconds: number;
  used_seconds: number;
  usage_confirmed: boolean;
  openai_session_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  notice_completed_at: string | null;
  prior_disclosure_acknowledged_at: string | null;
  media_start_requested_at: string | null;
  heartbeat_at: string;
  created_at: string;
  fallback_pending: boolean;
  fallback_completed_at: string | null;
  fallback_claimed_at?: string | null;
  fallback_error_code?: string | null;
  error_code: string | null;
}

export interface TranscriptFragment {
  eventId: string;
  role: "customer" | "assistant";
  text: string;
  startMs: number;
  endMs: number;
}

export interface VoicePilotSettings {
  business_id: string;
  enabled: boolean;
  budget_seconds: number;
  max_concurrent_calls: number;
  max_call_seconds: number;
  revision: number;
}
