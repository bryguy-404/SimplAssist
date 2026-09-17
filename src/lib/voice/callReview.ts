/** Customer call history. Provider identifiers, usage and action evidence stay server-side. */
export interface VoiceCallReview {
  conversationId: string;
  receivedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  call: ReviewStatus;
  contact: CallContact | null;
  confirmedContact: ConfirmedCallContact | null;
  actions: CallActionReview[];
  recordings: {
    id: string;
    state: "available" | "expired" | "unavailable";
    url: string | null;
    expiresAt: string;
  }[];
}

export interface ReviewStatus {
  label: string;
  detail: string;
  tone: "neutral" | "success" | "warning";
}

export interface CallContact {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
}

export interface ConfirmedCallContact {
  name: string;
  phone: string;
  email: string | null;
  conflicts: ("name" | "email")[];
}

export interface CallActionReview extends ReviewStatus {
  id: string;
  title: string;
  confirmedAt: string | null;
  smsConversationId: string | null;
  leadId: string | null;
}

export interface ReviewActionRow {
  id: string;
  business_id: string;
  session_id: string;
  kind: string;
  status: string;
  payload: unknown;
  result: unknown;
  confirmed_at: string | null;
  created_at: string;
  revision: number;
  source_message_id?: string | null;
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function reviewText(value: unknown, max = 254): string | null {
  return typeof value === "string" && value.trim() && value.length <= max
    ? value.trim()
    : null;
}

/** Only completed, confirmed actions are a source of confirmed caller identity. */
export function confirmedCallContact(
  actions: ReviewActionRow[],
  businessId: string,
  sessionId: string,
  callerPhone: string,
  contact: CallContact | null,
  beforeRevision = Number.POSITIVE_INFINITY,
): ConfirmedCallContact | null {
  const action = actions.filter((row) =>
    row.business_id === businessId && row.session_id === sessionId &&
    ["contact", "booking", "booking_request"].includes(row.kind) &&
    row.status === "succeeded" && row.confirmed_at &&
    Number.isFinite(Date.parse(row.confirmed_at)) && row.revision < beforeRevision &&
    record(row.payload).phone === callerPhone && reviewText(record(row.payload).name, 200),
  ).sort((a, b) => b.revision - a.revision)[0];
  if (!action) return null;
  const payload = record(action.payload);
  const name = reviewText(payload.name, 200)!;
  const email = reviewText(payload.email);
  const conflicts: ConfirmedCallContact["conflicts"] = [];
  if (contact?.name && contact.name.toLowerCase() !== name.toLowerCase()) conflicts.push("name");
  if (email && contact?.email && contact.email.toLowerCase() !== email.toLowerCase()) conflicts.push("email");
  return { name, phone: callerPhone, email, conflicts };
}

export function callReviewStatus(status: string, outcome: string | null): ReviewStatus {
  if (status !== "closed") return {
    label: status === "closing" ? "Call ending" : "Call in progress",
    detail: "The call record may still be updating.", tone: "neutral",
  };
  if (outcome === "caller_abandoned") return {
    label: "Caller left before the conversation", detail: "No completed conversation is recorded.", tone: "neutral",
  };
  if (outcome && !["caller_hangup", "completed", "normal"].includes(outcome)) return {
    label: "Call ended with an issue", detail: "Review the actions and transcript for what was completed.", tone: "warning",
  };
  return { label: "Call ended", detail: "Action results below show what was completed.", tone: "neutral" };
}

export function actionReviewStatus(action: Pick<ReviewActionRow, "kind" | "status" | "result">, callClosed: boolean, bookingStatus?: string): ReviewStatus {
  switch (action.status) {
    case "awaiting_confirmation": return { label: callClosed ? "Not confirmed" : "Awaiting confirmation", detail: "No action was submitted from this proposal.", tone: "neutral" };
    case "superseded": return { label: "Replaced", detail: "The caller's updated request replaced this proposal.", tone: "neutral" };
    case "executing": return { label: "Processing", detail: "The final result is not yet available. Do not repeat the request.", tone: "neutral" };
    case "uncertain": return { label: "Result needs review", detail: "Completion could not be verified. Do not repeat the request.", tone: "warning" };
    case "failed": return { label: "Could not complete", detail: "This action did not complete.", tone: "warning" };
    case "succeeded": break;
    default: return { label: "Result unavailable", detail: "The final result could not be verified.", tone: "warning" };
  }
  if (action.kind === "signup") {
    if (!reviewText(record(action.result).providerMessageId, 200)) return { label: "Signup text result needs review", detail: "Provider acceptance could not be verified. Do not repeat the request.", tone: "warning" };
    const delivery = record(action.result).deliveryStatus;
    if (delivery === "delivered") return { label: "Signup text delivered", detail: "The link was delivered. This does not confirm a completed signup.", tone: "success" };
    if (["delivery_failed", "sending_failed", "expired", "cancelled"].includes(String(delivery))) return { label: "Signup text delivery failed", detail: "The text was accepted for sending but was not delivered. Signup is not confirmed.", tone: "warning" };
    return { label: "Signup text sent", detail: "Accepted for sending; delivery is not yet confirmed. Signup is not confirmed.", tone: "neutral" };
  }
  if (action.kind === "contact") return { label: "Contact details captured", detail: "Confirmed details were saved with this call. Existing contact details are kept when they differ.", tone: "success" };
  if (action.kind === "booking_request") return { label: "Appointment request saved", detail: "Saved for owner review; this request alone is not an appointment confirmation.", tone: "neutral" };
  if (action.kind === "booking") {
    if (bookingStatus === "confirmed") return { label: "Appointment confirmed", detail: "The appointment was confirmed in the calendar.", tone: "success" };
    if (bookingStatus === "cancelled") return { label: "Appointment cancelled", detail: "The calendar appointment is cancelled.", tone: "neutral" };
    if (bookingStatus === "failed") return { label: "Appointment not confirmed", detail: "The calendar booking did not complete.", tone: "warning" };
    return { label: "Booking result needs review", detail: "A confirmed calendar appointment could not be verified. Do not repeat the request.", tone: "warning" };
  }
  return { label: "Result unavailable", detail: "The action type could not be verified.", tone: "warning" };
}

export function actionReviewTitle(kind: string): string {
  return ({ contact: "Contact details", signup: "Signup link", booking: "Appointment", booking_request: "Appointment request" } as Record<string, string>)[kind] || "Call action";
}
