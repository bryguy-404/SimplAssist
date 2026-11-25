export const feedbackRatings = ["Great", "Okay", "Frustrating"] as const;
export type FeedbackRating = (typeof feedbackRatings)[number];

type Action =
  | { action: "activity" }
  | { action: "visit" | "dismiss"; id: string }
  | { action: "submit"; id: string; rating: FeedbackRating; comment: string };

export async function feedbackAction(action: Action): Promise<string> {
  const response = await fetch("/api/dashboard/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action),
    keepalive: true,
  });
  if (response.status === 429) throw new Error("Please wait a minute before sending more feedback.");
  if (!response.ok) throw new Error("Couldn’t save your feedback. Please try again.");
  return (await response.json()).result;
}

// Only a yes/no eligibility signal. No conversation IDs or customer content.
export function markFeedbackActivity() {
  void feedbackAction({ action: "activity" }).catch(() => {});
}
