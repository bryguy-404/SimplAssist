export type ReviewWorkerState = {
  lastDeliverySuccess: number;
  lastLifecycleSuccess: number;
  lastLifecycleAttempt: number;
};
export function reviewWorkerHealthy(
  state: ReviewWorkerState,
  now = Date.now(),
): boolean {
  return (
    now - state.lastDeliverySuccess < 180000 &&
    now - state.lastLifecycleSuccess < 180000
  );
}
export async function runReviewWorkerCycle(args: {
  origin: URL;
  token: string;
  state: ReviewWorkerState;
  fetcher?: typeof fetch;
  now?: () => number;
}) {
  const fetcher = args.fetcher ?? fetch,
    now = args.now ?? Date.now,
    errors: string[] = [];
  async function request(path: string) {
    const result = await fetcher(new URL(path, args.origin), {
      method: "POST",
      headers: { authorization: `Bearer ${args.token}` },
      signal: AbortSignal.timeout(55000),
      redirect: "error",
    });
    if (!result.ok) throw new Error(`http_${result.status}`);
  }
  try {
    await request("/api/reviews/internal/run");
    args.state.lastDeliverySuccess = now();
  } catch {
    errors.push("review_delivery_cycle_failed");
  }
  // Lifecycle is independent: queue/storage failures must not strand chargeable
  // resources or prevent a paid application from progressing.
  if (now() - args.state.lastLifecycleAttempt >= 60000) {
    args.state.lastLifecycleAttempt = now();
    try {
      await request("/api/reviews/internal/lifecycle");
      args.state.lastLifecycleSuccess = now();
    } catch {
      errors.push("review_lifecycle_cycle_failed");
    }
  }
  return { errors };
}
