/** Allowlisted diagnostics only: never attach speech, model output or caller data. */
export type VoiceEvidenceReason =
  | "invalid_segment_list"
  | "segment_not_visible"
  | "segment_not_caller"
  | "evidence_limit"
  | "duplicate_event"
  | "action_missing"
  | "action_not_pending"
  | "playback_not_acknowledged"
  | "invalid_playback_cutoff"
  | "playback_not_visible"
  | "reply_missing"
  | "reply_not_visible";

export class VoiceEvidenceError extends Error {
  constructor(readonly reason: VoiceEvidenceReason) {
    super("invalid_transcript_evidence");
  }
}
